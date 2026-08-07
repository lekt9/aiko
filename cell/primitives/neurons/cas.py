#!/usr/bin/env python3
# cas — data -> key (sha256), dedup via .cell-cas dir
import pathlib, json, hashlib
def run(inputs, ctx):
    data = inputs.get("data")
    raw = json.dumps(data, sort_keys=True, ensure_ascii=False).encode()
    key = hashlib.sha256(raw).hexdigest()
    # .cell-cas is sibling to cell dir or under out_dir parent
    cas_root = pathlib.Path(ctx.get("out_dir","out")).parent / ".cell-cas"
    # also allow explicit via ctx
    alt = pathlib.Path(ctx.get("tmp_dir",".")) / ".cell-cas"
    chosen = cas_root if len(str(cas_root)) < 200 else alt
    chosen.mkdir(parents=True, exist_ok=True)
    p = chosen / key[:2] / key[2:4] / key
    p.parent.mkdir(parents=True, exist_ok=True)
    deduped = p.exists()
    if not deduped:
        p.write_bytes(raw)
    return {"key": key, "deduped": deduped}
