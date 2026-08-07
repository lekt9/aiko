#!/usr/bin/env python3
import pathlib, json, glob
def run(inputs, ctx):
    root = pathlib.Path(inputs.get("root","out") or "out")
    if not root.is_absolute():
        # resolve relative to cwd
        root = pathlib.Path.cwd() / root
        if not root.exists():
            root = pathlib.Path(ctx.get("tmp_dir",".")) / "out"
            if not root.exists():
                # fall back to cell root's out
                cand = pathlib.Path(__file__).parents[2] / "out"
                if cand.exists():
                    root = cand
                else:
                    return {"index": {"cells": [], "manifests": []}, "count": 0}
    manifests = []
    for m in root.rglob("manifest.json"):
        try:
            j = json.loads(m.read_text(encoding="utf-8"))
            j["_path"] = str(m)
            manifests.append(j)
        except Exception:
            continue
    index = {"root": str(root), "cells": sorted(set(x.get("cell_path","") for x in manifests)), "manifests": manifests}
    return {"index": index, "count": len(manifests)}
