#!/usr/bin/env python3
"""client-emitter Neuron — emits a typed frontend client from a published
manifest's accepts/emits/errors.

Pure policy neuron (§2): text generation only, no network, no filesystem,
no clock beyond `now_ms`. It reads a `neuron.published-manifest/v1` artifact
(a digest-pinned read — never a live capability grant; see AGENTS.md §20 step
3) and a `neuron.client-emit-request/v1` request, and writes a
`neuron.emitted-client/v1` artifact.

What this neuron is not: it does not admit, attach, or execute anything it
produces. The generated source is data, written inert, exactly like every
other limbs/introspection generator (limb_designer.py is the precedent this
follows). "So a frontend consumes the same pinned contract the server
serves" means the manifest_digest of the source manifest is copied verbatim
into the generated text -- a caller who diffs that constant against a later
server manifest detects drift without making a request.
"""

import hashlib
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "shared"))
from _neuron import (
    Reject,
    artifact_ref,
    decision,
    run,
)

PUBLISHED_MANIFEST_SCHEMA = "neuron.published-manifest/v1"
CLIENT_EMIT_REQUEST_SCHEMA = "neuron.client-emit-request/v1"
EMITTED_CLIENT_SCHEMA = "neuron.emitted-client/v1"

DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def raw_digest(text):
    return hashlib.sha256(text.encode() if isinstance(text, str) else text).hexdigest()


def safe_ident(name):
    """Sanitize an id/name into a JS-safe identifier fragment."""
    cleaned = re.sub(r"[^A-Za-z0-9_]", "_", name or "client")
    if not cleaned or cleaned[0].isdigit():
        cleaned = "_" + cleaned
    return cleaned


def validate_manifest(manifest):
    """Fail-closed structural check mirroring the schema's `required` list.
    This neuron never treats a missing required field as a defaultable gap
    (§27): an incomplete manifest is not a smaller contract, it is a
    different, unverifiable one.
    """
    if not isinstance(manifest, dict):
        raise Reject("validation", "published manifest is not an object")
    for field in ("id", "version", "accepts", "emits", "errors", "manifest_digest", "transport", "bind"):
        if field not in manifest:
            raise Reject("validation", f"published manifest missing '{field}'")
    for field in ("accepts", "emits", "errors"):
        value = manifest[field]
        if not isinstance(value, list) or not value or not all(isinstance(s, str) and s for s in value):
            raise Reject("validation", f"published manifest '{field}' must be a non-empty list of non-empty strings")
    digest = manifest["manifest_digest"]
    if not isinstance(digest, str) or not DIGEST_RE.match(digest):
        raise Reject("validation", "published manifest 'manifest_digest' must be a 64-hex digest")
    if manifest["transport"] not in ("neuron_wire", "http", "mcp"):
        raise Reject("validation", "published manifest 'transport' must be neuron_wire, http, or mcp")
    bind = manifest["bind"]
    if not isinstance(bind, dict) or not bind.get("path"):
        raise Reject("validation", "published manifest 'bind.path' is required")
    if "{" in bind["path"] or "}" in bind["path"]:
        # Mirrors the kernel design's own refusal: a placeholder in bind.path
        # would be an un-schema'd input channel outside `accepts`. The
        # emitter must not paper over an inadmissible source document by
        # generating a client that "just works" against it.
        raise Reject("poisoned_input", "published manifest 'bind.path' contains a placeholder; refusing to emit a client for an inadmissible manifest")


def build_url(manifest):
    base = (manifest.get("node_address") or "").rstrip("/")
    path = manifest["bind"]["path"]
    if not path.startswith("/"):
        path = "/" + path
    return (base + path) if base else path


def emit_json(manifest, client_name):
    """A plain data document: the pinned contract with nothing executable.
    For callers who generate their own bindings from a typed schema rather
    than consuming JS/TS directly.
    """
    doc = {
        "client_name": client_name,
        "source_manifest_id": manifest["id"],
        "source_manifest_version": manifest["version"],
        "source_manifest_digest": manifest["manifest_digest"],
        "accepts": list(manifest["accepts"]),
        "emits": list(manifest["emits"]),
        "errors": list(manifest["errors"]),
        "transport": manifest["transport"],
        "method": manifest["bind"].get("method", "POST"),
        "url": build_url(manifest),
    }
    return json.dumps(doc, sort_keys=True, indent=2) + "\n"


def emit_js_like(manifest, client_name, typed):
    """Shared body for the `js` and `ts` formats. `typed` adds TS type
    aliases (string unions over accepts/emits/errors) that give a frontend
    compile-time drift detection to match the runtime digest check.
    """
    ident = safe_ident(client_name)
    url = build_url(manifest)
    method = manifest["bind"].get("method", "POST")
    accepts = manifest["accepts"]
    emits = manifest["emits"]
    errors = manifest["errors"]

    lines = []
    lines.append(f"// GENERATED by typed-neuron/client-emitter. Do not hand-edit.")
    lines.append(f"// Source manifest: {manifest['id']}@{manifest['version']}")
    lines.append(f"// Source manifest digest (drift marker): {manifest['manifest_digest']}")
    lines.append("")
    if typed:
        def union(values):
            return " | ".join(json.dumps(v) for v in values)
        lines.append(f"export type {ident}Accepts = {union(accepts)};")
        lines.append(f"export type {ident}Emits = {union(emits)};")
        lines.append(f"export type {ident}Error = {union(errors)};")
        lines.append("")
    lines.append(f"export const {ident.upper()}_MANIFEST_DIGEST = {json.dumps(manifest['manifest_digest'])};")
    lines.append(f"export const {ident.upper()}_CONTRACT = Object.freeze({{")
    lines.append(f"  id: {json.dumps(manifest['id'])},")
    lines.append(f"  version: {json.dumps(manifest['version'])},")
    lines.append(f"  manifestDigest: {json.dumps(manifest['manifest_digest'])},")
    lines.append(f"  accepts: {json.dumps(accepts)},")
    lines.append(f"  emits: {json.dumps(emits)},")
    lines.append(f"  errors: {json.dumps(errors)},")
    lines.append("});")
    lines.append("")
    sig = f"export async function {ident}(payload{': unknown' if typed else ''})" if typed else f"export async function {ident}(payload)"
    ret = ": Promise<unknown>" if typed else ""
    lines.append(f"{sig}{ret} {{")
    lines.append(f"  const response = await fetch({json.dumps(url)}, {{")
    lines.append(f"    method: {json.dumps(method)},")
    lines.append(f"    headers: {{ 'content-type': 'application/json', 'x-manifest-digest': {ident.upper()}_MANIFEST_DIGEST }},")
    lines.append(f"    body: JSON.stringify(payload),")
    lines.append(f"  }});")
    lines.append(f"  if (!response.ok) {{")
    lines.append(f"    throw new Error(`{ident} request failed: ${{response.status}}`);")
    lines.append(f"  }}")
    lines.append(f"  return response.json();")
    lines.append(f"}}")
    lines.append("")
    return "\n".join(lines)


EMITTERS = {
    "json": lambda manifest, name: emit_json(manifest, name),
    "js": lambda manifest, name: emit_js_like(manifest, name, typed=False),
    "ts": lambda manifest, name: emit_js_like(manifest, name, typed=True),
}


def fire(stim):
    stim.setdefault("reads", [])
    stim.setdefault("messages", [])

    # The request: staged as a read, or (mirroring gap_analyzer's pattern)
    # inline in a message payload.
    _, req = artifact_ref(stim, CLIENT_EMIT_REQUEST_SCHEMA, required=False)
    if req is None:
        for msg in stim.get("messages", []):
            try:
                if msg.get("schema") == CLIENT_EMIT_REQUEST_SCHEMA:
                    req = json.loads(msg.get("payload", "{}"))
                    break
            except Exception:
                continue
    if req is None:
        raise Reject("dependency", "no client-emit-request found in reads or messages")

    fmt = req.get("format")
    if fmt not in EMITTERS:
        raise Reject("validation", f"unsupported format: {fmt!r}")

    manifest_ref_id = req.get("manifest_ref_id")
    if not manifest_ref_id:
        raise Reject("validation", "client-emit-request missing 'manifest_ref_id'")

    manifest = None
    for ref in stim["reads"]:
        if ref.get("id") == manifest_ref_id and ref.get("schema") == PUBLISHED_MANIFEST_SCHEMA:
            try:
                manifest = json.loads(ref["bytes"])
            except Exception as exc:
                raise Reject("poisoned_input", f"published manifest {manifest_ref_id} is not valid JSON: {exc}")
            break
    if manifest is None:
        raise Reject("dependency", f"published manifest '{manifest_ref_id}' not present in reads")

    validate_manifest(manifest)

    client_name = req.get("client_name") or manifest["id"]
    source = EMITTERS[fmt](manifest, client_name)
    assert manifest["manifest_digest"] in source, "internal: drift marker missing from generated source"

    out = {
        "format": fmt,
        "source": source,
        "source_manifest_id": manifest["id"],
        "source_manifest_version": manifest["version"],
        "source_manifest_digest": manifest["manifest_digest"],
        "generated_digest": raw_digest(source),
    }
    out_bytes = canonical(out)

    evidence = [{
        "claim": f"emitted {fmt} client for {manifest['id']}@{manifest['version']} pinned to manifest digest {manifest['manifest_digest'][:16]}...",
        "sources": ["stimulus"],
        "method": "template rendering of accepts/emits/errors from a digest-pinned published-manifest read",
        "confidence_milli": 1000,
    }]

    safe_name = safe_ident(client_name)
    effects = [{
        "kind": "write",
        "artifact": {
            "id": f"client-emitter/{safe_name}/{fmt}",
            "schema": EMITTED_CLIENT_SCHEMA,
            "bytes": out_bytes,
        },
    }]

    return decision({"kind": "terminate", "result": "client-emitted"}, effects, evidence, stim)


if __name__ == "__main__":
    sys.exit(run(fire))
