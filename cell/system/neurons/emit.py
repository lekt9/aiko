#!/usr/bin/env python3
import json, hashlib, pathlib
try:
    import yaml
except ImportError:
    yaml = None
def load_cell(p: pathlib.Path):
    text = p.read_text(encoding="utf-8")
    if p.suffix in (".yaml",".yml") or ".cell.yaml" in p.name:
        return yaml.safe_load(text) if yaml else json.loads(text)
    return json.loads(text)
def resolve_organelles(root_path: pathlib.Path, data: dict, seen=None):
    if seen is None:
        seen=set()
    key=str(root_path.resolve()) if root_path.exists() else str(root_path)
    if key in seen:
        raise ValueError(f"cycle detected at {root_path}")
    seen.add(key)
    out={"path": str(root_path), "data": data, "children":{}}
    for org in data.get("spec",{}).get("organelles",[]) or []:
        name=org.get("name","?")
        if "cell" in org:
            child_path=(root_path.parent / org["cell"]).resolve()
            child_data=load_cell(child_path)
            out["children"][name]=resolve_organelles(child_path, child_data, set(seen))
        elif "cellInline" in org:
            out["children"][name]=resolve_organelles(pathlib.Path(f"<inline:{name}>"), org["cellInline"], set(seen))
    return out
def topo_check(tree):
    data=tree["data"]
    orgs=data.get("spec",{}).get("organelles",[]) or []
    wiring=data.get("spec",{}).get("wiring",[]) or []
    if not orgs:
        return tree
    names=[o["name"] for o in orgs]
    indeg={n:0 for n in names}
    adj={n:[] for n in names}
    for w in wiring:
        s=w["from"]; d=w["to"]
        if s.startswith("membrane.") or d.startswith("membrane."):
            continue
        s_org=s.split(".")[0]; d_org=d.split(".")[0]
        if s_org in names and d_org in names:
            adj[s_org].append(d_org)
            indeg[d_org]+=1
    queue=[n for n,d in indeg.items() if d==0]
    order=[]
    while queue:
        n=queue.pop(0)
        order.append(n)
        for nb in adj.get(n,[]):
            indeg[nb]-=1
            if indeg[nb]==0:
                queue.append(nb)
    if len(order)!=len(orgs):
        raise ValueError(f"cycle detected in wiring (order {order} vs {names})")
    for child in tree["children"].values():
        topo_check(child)
    return tree
def run(inputs, ctx):
    data = inputs.get("data")
    if data is None:
        raise ValueError("emit: missing inputs.data")
    source_path = data.pop("_source_path", None)
    root_p = pathlib.Path(source_path) if source_path else pathlib.Path("<root>")
    tree = resolve_organelles(root_p, data)
    topo_check(tree)
    canonical = json.dumps(data, sort_keys=True, ensure_ascii=False, indent=2)
    # Build identity pins descendant declarations and executable bytes, not their paths.
    import importlib.util
    runtime_path = pathlib.Path(__file__).resolve().parents[2] / "run.py"
    module_spec = importlib.util.spec_from_file_location("cell_runtime_emit", runtime_path)
    runtime = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(runtime)
    digest = runtime._cell_definition_digest(root_p, data)
    return {"canonical": canonical, "digest": digest, "organelle_count": len(tree["children"])}
