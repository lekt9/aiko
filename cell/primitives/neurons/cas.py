#!/usr/bin/env python3
# cas — data -> key (sha256), dedup via .cell-cas dir
import pathlib, json, hashlib
def run(inputs, ctx):
    data = inputs.get("data")
    raw = json.dumps(data, sort_keys=True, ensure_ascii=False).encode()
    key = hashlib.sha256(raw).hexdigest()
    # CAS is global at cell/.cell-cas so repeated puts dedup across tmp outs (same key -> same file)
    # Find cell root by walking up from out_dir to locate .cell marker, fallback to tmp
    raw_out = pathlib.Path(ctx.get("out_dir","out"))
    # Search for cell dir marker: a directory containing primitives/cas.cell.yaml
    chosen = None
    for parent in [raw_out.parent, raw_out.parent.parent, pathlib.Path.cwd(), pathlib.Path("/tmp/.cell-cas")]:
        try:
            if (parent / ".cell-cas").exists() or (parent / "primitives" / "cas.cell.yaml").exists():
                chosen = parent / ".cell-cas"
                break
        except Exception:
            continue
    if chosen is None:
        # Fallback: global dir keyed by hex so gate sees dedup
        chosen = pathlib.Path("/tmp/.cell-cas")
    chosen.mkdir(parents=True, exist_ok=True)
    p = chosen / key[:2] / key[2:4] / key
    p.parent.mkdir(parents=True, exist_ok=True)
    deduped = p.exists()
    if not deduped:
        p.write_bytes(raw)
    return {"key": key, "deduped": deduped}
