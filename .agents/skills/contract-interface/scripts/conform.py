#!/usr/bin/env python3
import json, sys
from pathlib import Path
p=Path(sys.argv[1]); m=json.loads((p/"contract-skill.json").read_text()); c=json.loads((p/"assets"/"capabilities.json").read_text())
nodes={n["key"]:n for n in m["nodes"]}
assert tuple(nodes)[:4]==("observe","normalize","authorize","prepare")
assert tuple(nodes)[-3:]==("sense","evaluate","settle")
execute=[n for n in m["nodes"] if n["key"].startswith("execute-")]
assert len(execute)==len(c["effects"])
assert all(n["depends_on"]==["authorize","prepare"] for n in execute)
assert nodes["sense"]["depends_on"]==[n["key"] for n in execute]
assert [n["effect"] for n in execute]==[e["effect"] for e in c["effects"]]
assert [n["requires_authority"] for n in execute]==[e.get("requires_authority", e["effect"] not in {"read_only","local_reversible"}) for e in c["effects"]]
assert all(e["variants"] for e in c["effects"])
assert all(not e.get("ephemeral") or e.get("ttl_ms",0)>0 for e in c["effects"])
assert not any(n["effect"]!="read_only" and not (n["requires_authority"] or n["reversible"]) for n in m["nodes"])
print(f"conformant contract interface: {m['id']}")
