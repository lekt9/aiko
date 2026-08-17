#!/usr/bin/env python3
"""Conformance witness for typed-neuron/product-forge."""
import hashlib, json, os, subprocess, sys, tempfile, pathlib

REPO = pathlib.Path(__file__).resolve().parents[4]
BIN = REPO / "neuron" / "zig-out" / "bin" / "neuron"
LIMB = REPO / "neuron" / "limbs" / "product-forge"

def run(*args, cwd=None, env=None):
    return subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True)

def fail(msg):
    print(f"FAIL: {msg}", file=sys.stderr); sys.exit(1)

def pin(pid, val):
    return {"id": pid, "schema": "product-forge.request/v1", "digest": hashlib.sha256(val.encode()).hexdigest(), "bytes": val}

def stimulus(firing_id, brief, project):
    body = json.dumps({"brief": brief, "project": project}, sort_keys=True)
    r = pin("forge-req", body)
    return json.dumps({"schema":"neuron.stimulus/v1","firing_id":firing_id,"receptor_schema":"product-forge.request/v1","reads":[r],"permitted_reads":[r["id"]],"messages":[],"now_ms":0})

def artifact_bytes(log_path, aid):
    for line in open(log_path):
        rec=json.loads(line)
        if rec.get("op")!="commit": continue
        for a in rec.get("artifacts",[]):
            if a["id"]==aid:
                return bytes.fromhex(a["bytes"]).decode()
    return None

def main():
    if not BIN.exists(): fail("build first (zig build)")
    tmp = tempfile.mkdtemp(prefix="aiko-forge-conf.")
    state = os.path.join(tmp, "state")
    env = {**os.environ, "HOME": tmp}
    try:
        r = run(str(BIN), "agent", "init", os.path.join(tmp, "node"), "a1", env=env)
        if r.returncode!=0: fail(f"agent init failed: {r.stderr[:500]}")
        r = run(str(BIN), "limb", "admit", str(LIMB), state, env=env)
        if r.returncode!=0: fail(f"admit failed: {r.stderr[:800]}")
        log = os.path.join(state, "substrate.log")
        brief = "run a neighbourhood bike shop \u2014 bookings for repairs, inventory of bikes and parts, roster of mechanics, customer history"
        s = stimulus("probe-forge", brief, "bike-shop")
        sp = os.path.join(tmp, "stim.json")
        open(sp,"w").write(s)
        r = run(str(BIN), "limb", "run", state, "--package", str(LIMB), "--neuron", "forge", "--stimulus", sp, "--json", env=env)
        if r.returncode!=0: fail(f"forge firing failed: {r.stderr[:800]} {r.stdout[:500]}")
        j = json.loads(r.stdout)
        if j.get("effects_committed",0)!=4: fail(f"expected 4 effects, got {j}")
        for aid in ["artifact/product-forge/bike-shop/prd","artifact/product-forge/bike-shop/ia","artifact/product-forge/bike-shop/tokens","artifact/product-forge/bike-shop/crud"]:
            if artifact_bytes(log, aid) is None: fail(f"missing artifact {aid}")
        prd = json.loads(artifact_bytes(log, "artifact/product-forge/bike-shop/prd"))
        if prd.get("archetype")!="booking": fail(f"expected booking, got {prd.get('archetype')}")
        # determinism via direct invocation
        import subprocess as _sp
        p1 = _sp.run([sys.executable, str(LIMB/"neurons"/"forge.py")], input=s.encode(), capture_output=True)
        p2 = _sp.run([sys.executable, str(LIMB/"neurons"/"forge.py")], input=stimulus("probe-forge-2", brief, "bike-shop").encode(), capture_output=True)
        if p1.stdout != p2.stdout: fail("NON-DETERMINISTIC: identical brief produced different decisions")
        # inventory archetype
        inv_brief = "warehouse stock and sku catalogue for a hardware wholesaler \u2014 track inventory movements and categories"
        s3 = stimulus("probe-inv", inv_brief, "warehouse")
        sp3=os.path.join(tmp,"stim3.json"); open(sp3,"w").write(s3)
        r = run(str(BIN), "limb", "run", state, "--package", str(LIMB), "--neuron", "forge", "--stimulus", sp3, "--json", env=env)
        if r.returncode!=0: fail(f"inventory firing failed: {r.stderr[:500]}")
        prd3=json.loads(artifact_bytes(log,"artifact/product-forge/warehouse/prd"))
        if prd3.get("archetype")!="inventory": fail(f"expected inventory, got {prd3.get('archetype')}")
        # fail-closed
        bad = stimulus("probe-bad", "hi", "bad")
        spb=os.path.join(tmp,"stimbad.json"); open(spb,"w").write(bad)
        r = run(str(BIN), "limb", "run", state, "--package", str(LIMB), "--neuron", "forge", "--stimulus", spb, "--json", env=env)
        if r.returncode==0: fail("short brief should have been refused")
        print("product-forge conformance: PASS")
    finally:
        import shutil; shutil.rmtree(tmp, ignore_errors=True)

if __name__=="__main__": main()
