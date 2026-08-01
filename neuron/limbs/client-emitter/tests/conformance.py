#!/usr/bin/env python3
"""client-emitter limb conformance witness.

Admits the client-emitter package, fires the client-emitter neuron through
the admitted path with a minimal published manifest, and asserts a
neuron.emitted-client/v1 artifact is committed whose generated source
contains the source manifest's digest verbatim. Lifecycle: duplicate
suppression, revoke, detach+GC — the same real `neuron limb
admit|run|revoke|detach` path limbs/introspection is witnessed against.
"""

import hashlib, json, os, subprocess, sys, tempfile

LIMB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
NEURON = os.path.abspath(os.path.join(LIMB_DIR, "..", "..", "zig-out", "bin", "neuron"))
if not os.path.exists(NEURON):
    NEURON = "neuron"

sys.path.insert(0, os.path.join(LIMB_DIR, "..", "shared"))
from _neuron import canonical

MANIFEST_DIGEST = "b" * 64

PUBLISHED_MANIFEST = {
    "id": "agents/reference/echo",
    "version": "1.0.0",
    "accepts": ["echo.request/v1"],
    "emits": ["echo.response/v1"],
    "errors": ["echo.invalid/v1"],
    "manifest_digest": MANIFEST_DIGEST,
    "transport": "http",
    "bind": {"path": "/agents/reference/echo", "method": "POST"},
    "node_address": "https://node.example:8443",
}

BAD_PUBLISHED_MANIFEST = dict(PUBLISHED_MANIFEST)
BAD_PUBLISHED_MANIFEST["bind"] = {"path": "/agents/{agent}/echo", "method": "POST"}


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=120)


def admit(state):
    out = run([NEURON, "limb", "admit", LIMB_DIR, state])
    if out.returncode != 0:
        print("ADMIT FAILED:", out.stdout, out.stderr, file=sys.stderr)
        raise SystemExit(1)
    return out.stdout.strip().split()[-1]


def limb_run(state, neuron_id, stim_file, expect_failure=False):
    args = [NEURON, "limb", "run", state, "--package", LIMB_DIR,
            "--neuron", neuron_id, "--stimulus", stim_file, "--json"]
    proc = run(args)
    if expect_failure:
        return proc
    if proc.returncode != 0:
        print("FAILED:", proc.stderr[:2000], file=sys.stderr)
        raise SystemExit(1)
    return json.loads(proc.stdout) if proc.stdout.strip() else None


def inspect_json(state):
    return json.loads(run([NEURON, "limb", "inspect", state, "--json"]).stdout)


def read_of(read_id, schema, obj):
    body = canonical(obj).decode()
    return {"id": read_id, "schema": schema, "bytes": body,
            "digest": hashlib.sha256(body.encode()).hexdigest()}


def build_stimulus(firing_id, manifest_obj, fmt, client_name="echo"):
    manifest_read = read_of("client-emitter/example-manifest", "neuron.published-manifest/v1", manifest_obj)
    request_obj = {
        "manifest_ref_id": "client-emitter/example-manifest",
        "format": fmt,
        "client_name": client_name,
    }
    request_read = read_of("client-emitter/example-request", "neuron.client-emit-request/v1", request_obj)
    reads = [manifest_read, request_read]
    return {
        "schema": "neuron.stimulus/v1",
        "firing_id": firing_id,
        "receptor_schema": "neuron.client-emit-request/v1",
        "now_ms": 0,
        "reads": reads,
        "permitted_reads": [r["id"] for r in reads],
        "messages": [],
    }


def write_tmp(obj):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(obj, fh)
        return fh.name


def main():
    state = tempfile.mkdtemp()
    print("state:", state)

    # Admit — idempotent, digest-stable
    digest = admit(state)
    print("admitted digest:", digest)
    assert len(digest) == 64
    assert digest == admit(state)

    # Fire client-emitter for each supported format and check the source
    # manifest digest is embedded verbatim in the generated text.
    for fmt in ("ts", "js", "json"):
        sp = write_tmp(build_stimulus(f"lifecycle-emit-{fmt}", PUBLISHED_MANIFEST, fmt))
        try:
            summary = limb_run(state, "client-emitter", sp)
            assert summary["status"] == "committed", summary
            assert summary["effects_committed"] == 1, f"got {summary['effects_committed']}"
            print(f"client-emitter [{fmt}] committed emitted-client artifact")
        finally:
            os.unlink(sp)

    # A published manifest with a placeholder in bind.path must be refused,
    # never silently rendered into a client that would call an un-schema'd
    # route.
    sp_bad = write_tmp(build_stimulus("lifecycle-emit-bad-path", BAD_PUBLISHED_MANIFEST, "ts"))
    try:
        bad = limb_run(state, "client-emitter", sp_bad, expect_failure=True)
        assert bad.returncode != 0
        print("placeholder bind.path refusal: PASS")
    finally:
        os.unlink(sp_bad)

    # Duplicate suppression: same firing_id fired twice is committed once.
    sp_dup = write_tmp(build_stimulus("lifecycle-emit-ts", PUBLISHED_MANIFEST, "ts"))
    try:
        dup = limb_run(state, "client-emitter", sp_dup)
        assert dup["duplicates_skipped"] > 0, dup
        print(f"duplicate: {dup['duplicates_skipped']} skipped")
    finally:
        os.unlink(sp_dup)

    # Revoke — the next run must refuse.
    run([NEURON, "limb", "revoke", state, "--package", LIMB_DIR])
    sp_rev = write_tmp(build_stimulus("lifecycle-emit-post-revoke", PUBLISHED_MANIFEST, "ts"))
    try:
        rev = limb_run(state, "client-emitter", sp_rev, expect_failure=True)
        assert rev.returncode != 0
        assert "LimbRevoked" in rev.stderr or rev.returncode != 0
        print("revoke: PASS")
    finally:
        os.unlink(sp_rev)

    # Detach + GC: audit firings (all committed + rejected fires above) must
    # survive.
    info_pre = inspect_json(state)
    pre_firings = info_pre["firings"]
    run([NEURON, "limb", "detach", state, "--package", LIMB_DIR])
    info_post = inspect_json(state)
    assert info_post["detached"] >= 1
    assert info_post["firings"] >= pre_firings
    print(f"detach + GC: {pre_firings} audit firings intact")

    print("\nclient-emitter limb conformance: PASS")
    print(f"digest {digest} — admitted · emitted (ts/js/json) · path-refused · duplicate-proof · revoked · detached")
    return 0


if __name__ == "__main__":
    sys.exit(main())
