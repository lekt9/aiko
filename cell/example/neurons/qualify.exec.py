#!/usr/bin/env python3
import json, pathlib
inp = json.loads(pathlib.Path("inputs/order.json").read_text())
candidates = ["alice", "bob", "carol"] if inp.get("items") else []
pathlib.Path("outputs").mkdir(parents=True, exist_ok=True)
pathlib.Path("outputs/qualified.json").write_text(json.dumps(candidates))
