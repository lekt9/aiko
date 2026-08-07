#!/usr/bin/env python3
import pathlib, json
def run(inputs, ctx):
    key = inputs.get("key","")
    # Read from .cell-cas global store written by primitives/cas
    for base in [pathlib.Path("/tmp/.cell-cas"), pathlib.Path.cwd() / ".cell-cas", pathlib.Path(ctx.get("out_dir","out")).parent / ".cell-cas"]:
        p = base / key[:2] / key[2:4] / key
        if p.exists():
            raw = p.read_bytes()
            try:
                return {"data": json.loads(raw.decode())}
            except Exception:
                return {"data": {"raw": raw.decode()[:500]}}
    raise FileNotFoundError(f"cas key not found: {key}")
