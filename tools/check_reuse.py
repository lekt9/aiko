#!/usr/bin/env python3
import json, sys, pathlib
p = pathlib.Path(sys.argv[sys.argv.index("--walk")+1]) if "--walk" in sys.argv else pathlib.Path("docs/graph-engineering/aiko-drop-in.walk.json")
d = json.loads(p.read_text())
bad = []
for c in d["children"]:
    reads = c.get("reads", [])
    if not any(any(k in r for k in ["cell/primitives","cell/patterns","neuron/limbs","contract/libcontract"]) for r in reads):
        bad.append(c["id"])
if bad:
    print(f"reuse check FAIL: {bad}", file=sys.stderr); sys.exit(1)
print("reuse check PASS")
