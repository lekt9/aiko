#!/usr/bin/env python3
import pathlib, json
try:
    import yaml
except ImportError:
    yaml = None
def run(inputs, ctx):
    root = inputs.get("root")
    if not root:
        raise ValueError("parse: missing inputs.root (path to .cell.yaml)")
    p = pathlib.Path(root)
    if not p.is_absolute():
        for base in [pathlib.Path.cwd(), pathlib.Path(ctx.get("tmp_dir",".")), pathlib.Path(__file__).parent.parent]:
            cand = base / p
            if cand.exists():
                p = cand
                break
            cand2 = (base / p).resolve()
            if cand2.exists():
                p = cand2
                break
    if not p.exists():
        raise FileNotFoundError(f"parse: root not found: {p} (root={root!r})")
    text = p.read_text(encoding="utf-8")
    if p.suffix in (".yaml",".yml") or ".cell.yaml" in p.name:
        if yaml is None:
            raise SystemExit("pyyaml required")
        data = yaml.safe_load(text)
    else:
        data = json.loads(text)
    data["_source_path"] = str(p)
    return {"data": data}
