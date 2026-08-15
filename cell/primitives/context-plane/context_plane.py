#!/usr/bin/env python3
"""Tenant-scoped, cited context lineage stored without an Aiko runtime."""

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path

SCHEMA = "aiko.cited-context-lineage/v1"
KINDS = {"stimulus", "message", "pinned_read"}
SAFE_TENANT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

class Refusal(Exception):
    pass

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()

def digest_text(text):
    return hashlib.sha256(text.encode()).hexdigest()

def claim_digest(claim):
    signed = {"id": claim["id"], "text": claim["text"], "citations": claim["citations"]}
    return hashlib.sha256(canonical(signed)).hexdigest()

def state_path(state):
    return Path(state) / "cited-context-lineage.json"

def refuse(condition, message):
    if condition:
        raise Refusal(message)

def validate_tenant(tenant):
    refuse(not SAFE_TENANT.fullmatch(tenant or ""), "invalid tenant identity")

def load(state, tenant):
    validate_tenant(tenant)
    path = state_path(state)
    refuse(not path.is_file(), "context plane is not initialized")
    try:
        doc = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise Refusal("context lineage is unreadable") from exc
    refuse(doc.get("schema") != SCHEMA, "unknown context lineage schema")
    refuse(doc.get("tenant") != tenant, "tenant boundary refused")
    verify_doc(doc)
    return doc

def atomic_write(state, doc):
    directory = Path(state)
    directory.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".context.", dir=directory)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(canonical(doc) + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, state_path(state))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def verify_doc(doc):
    refuse(not isinstance(doc.get("sources"), dict), "sources are malformed")
    refuse(not isinstance(doc.get("claims"), dict), "claims are malformed")
    for source_id, source in doc["sources"].items():
        refuse(source.get("id") != source_id, "source identity mismatch")
        refuse(source.get("kind") not in KINDS, "unrecognized evidence kind")
        versions = source.get("versions")
        refuse(not isinstance(versions, list) or not versions, "source has no version")
        refuse(source.get("current") != len(versions) - 1, "source head is malformed")
        for index, version in enumerate(versions):
            refuse(version.get("version") != index, "source versions are not append-only")
            content = version.get("content")
            refuse(not isinstance(content, str), "source content is malformed")
            refuse(version.get("digest") != digest_text(content), "source digest mismatch")
            if source["kind"] == "pinned_read":
                refuse(version.get("pin") != version["digest"], "pinned read is not pinned to its bytes")
    for claim_id, claim in doc["claims"].items():
        refuse(claim.get("id") != claim_id, "claim identity mismatch")
        citations = claim.get("citations")
        refuse(not isinstance(citations, list) or not citations, "uncited claim refused")
        refuse(claim.get("digest") != claim_digest(claim), "claim digest mismatch")
        for citation in citations:
            source = doc["sources"].get(citation.get("source"))
            refuse(source is None, "claim cites an unknown source")
            refuse(citation.get("kind") != source["kind"], "citation kind mismatch")
            version = citation.get("version")
            refuse(not isinstance(version, int) or version < 0 or version >= len(source["versions"]), "citation version missing")
            refuse(citation.get("digest") != source["versions"][version]["digest"], "citation digest mismatch")

def invalidations(doc, claim):
    moved = []
    for citation in claim["citations"]:
        source = doc["sources"][citation["source"]]
        current = source["versions"][source["current"]]
        if current["digest"] != citation["digest"]:
            moved.append({
                "source": citation["source"],
                "cited_digest": citation["digest"],
                "current_digest": current["digest"],
            })
    return moved

def output(value):
    print(json.dumps(value, sort_keys=True, separators=(",", ":")))

def command_init(args):
    validate_tenant(args.tenant)
    path = state_path(args.state)
    refuse(path.exists(), "context plane already initialized")
    doc = {"schema": SCHEMA, "tenant": args.tenant, "sources": {}, "claims": {}}
    atomic_write(args.state, doc)
    output({"schema": SCHEMA, "tenant": args.tenant})

def source_version(kind, content, pin):
    digest = digest_text(content)
    if kind == "pinned_read":
        refuse(not pin, "pinned read requires --pin")
        refuse(pin != digest, "pinned read pin does not match bytes")
    else:
        refuse(pin is not None, "only pinned reads accept --pin")
    row = {"content": content, "digest": digest}
    if pin is not None:
        row["pin"] = pin
    return row

def command_source_add(args):
    doc = load(args.state, args.tenant)
    refuse(args.id in doc["sources"], "source already exists")
    version = source_version(args.kind, args.content, args.pin)
    version["version"] = 0
    doc["sources"][args.id] = {"id": args.id, "kind": args.kind, "current": 0, "versions": [version]}
    atomic_write(args.state, doc)
    output({"source": args.id, "digest": version["digest"], "version": 0})

def command_source_move(args):
    doc = load(args.state, args.tenant)
    source = doc["sources"].get(args.id)
    refuse(source is None, "unknown source")
    version = source_version(source["kind"], args.content, args.pin)
    head = source["versions"][source["current"]]
    refuse(version["digest"] == head["digest"], "source did not move")
    version["version"] = len(source["versions"])
    source["versions"].append(version)
    source["current"] = version["version"]
    atomic_write(args.state, doc)
    affected = sorted(cid for cid, claim in doc["claims"].items() if invalidations(doc, claim))
    output({"source": args.id, "digest": version["digest"], "version": version["version"], "invalidated": affected})

def command_claim_add(args):
    doc = load(args.state, args.tenant)
    refuse(args.id in doc["claims"], "claim already exists")
    refuse(not args.source, "uncited claim refused")
    refuse(len(set(args.source)) != len(args.source), "duplicate citation refused")
    citations = []
    for source_id in args.source:
        source = doc["sources"].get(source_id)
        refuse(source is None, "claim cites an unknown source")
        version = source["versions"][source["current"]]
        citations.append({"source": source_id, "kind": source["kind"], "version": source["current"], "digest": version["digest"]})
    claim = {"id": args.id, "text": args.text, "citations": citations}
    claim["digest"] = claim_digest(claim)
    doc["claims"][args.id] = claim
    atomic_write(args.state, doc)
    output({"claim": args.id, "digest": claim["digest"], "valid": True})

def command_status(args):
    doc = load(args.state, args.tenant)
    claims = []
    for claim_id in sorted(doc["claims"]):
        claim = doc["claims"][claim_id]
        moved = invalidations(doc, claim)
        claims.append({"id": claim_id, "digest": claim["digest"], "valid": not moved, "invalidated_by": moved})
    output({"schema": "aiko.context-status/v1", "tenant": args.tenant, "claims": claims})

def command_verify(args):
    doc = load(args.state, args.tenant)
    stale = sorted(cid for cid, claim in doc["claims"].items() if invalidations(doc, claim))
    output({"schema": "aiko.context-verification/v1", "tenant": args.tenant, "integrity": "verified", "invalid_claims": stale})

def parser():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)
    def common(sp):
        sp.add_argument("--state", required=True)
        sp.add_argument("--tenant", required=True)
    init = sub.add_parser("init"); common(init); init.set_defaults(run=command_init)
    add = sub.add_parser("source-add"); common(add)
    add.add_argument("--kind", choices=sorted(KINDS), required=True); add.add_argument("--id", required=True)
    add.add_argument("--content", required=True); add.add_argument("--pin"); add.set_defaults(run=command_source_add)
    move = sub.add_parser("source-move"); common(move)
    move.add_argument("--id", required=True); move.add_argument("--content", required=True); move.add_argument("--pin")
    move.set_defaults(run=command_source_move)
    claim = sub.add_parser("claim-add"); common(claim)
    claim.add_argument("--id", required=True); claim.add_argument("--text", required=True)
    claim.add_argument("--source", action="append", default=[]); claim.set_defaults(run=command_claim_add)
    status = sub.add_parser("status"); common(status); status.set_defaults(run=command_status)
    verify = sub.add_parser("verify"); common(verify); verify.set_defaults(run=command_verify)
    return p

def main():
    args = parser().parse_args()
    try:
        args.run(args)
    except Refusal as exc:
        print("REFUSED: " + str(exc), file=sys.stderr)
        return 2
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
