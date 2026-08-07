#!/usr/bin/env python3
"""run.py — canonical cell runtime (python-native, composable).
Builder is a cell: system/builder.cell.yaml (parse | validate | emit) — no second code path.

Usage:
  python run.py build  <root.cell.yaml>
  python run.py run    <root.cell.yaml> --inputs inputs.json --out out/
  python run.py check  <root.cell.yaml> --inputs inputs.json
"""
from __future__ import annotations
import argparse, hashlib, json, os, pathlib, re, shutil, subprocess, sys, tempfile
try:
    import yaml  # type: ignore
except ImportError:
    yaml = None  # type: ignore
SPEC_VERSION = "cell/v0"

def _cas_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def _write_cas(cas_dir: pathlib.Path, data: bytes) -> str:
    h = _cas_hash(data)
    cas_dir.mkdir(parents=True, exist_ok=True)
    p = cas_dir / h[:2] / h[2:4] / h
    p.parent.mkdir(parents=True, exist_ok=True)
    if not p.exists():
        p.write_bytes(data)
    return h

def _manifest_entry(cell_path: pathlib.Path, inputs: dict, outputs: dict, wiring: list) -> dict:
    # thin merkle: hash of canonical cell + input digests + output digests
    def _h(v): return _cas_hash(json.dumps(v, sort_keys=True, ensure_ascii=False).encode())[:16]
    return {
        "cell": _h({"path": str(cell_path), "wiring": wiring}),
        "cell_path": str(cell_path),
        "inputs": {k: _h(v) for k,v in inputs.items()},
        "outputs": {k: _h(v) for k,v in outputs.items()},
        "evidence": [{"port": k, "digest": _h(v)} for k,v in inputs.items()],
        "produced_by": _h({"inputs": inputs, "wiring": wiring}),
    }
def load_cell(path: pathlib.Path) -> dict:
    text = path.read_text(encoding="utf-8")
    if path.suffix in (".yaml", ".yml") or ".cell.yaml" in path.name or "{{" in text[:200]:
        if yaml is None:
            raise SystemExit("pyyaml required: pip install pyyaml  (or use .cell.json)")
        data = yaml.safe_load(text)
    else:
        data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: top-level must be mapping")
    return data
def cell_digest(data: dict) -> str:
    j = json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(j.encode()).hexdigest()[:16]
def validate_cell(data: dict, path: str = "<root>") -> list[str]:
    errs: list[str] = []
    if data.get("apiVersion") != SPEC_VERSION:
        errs.append(f"{path}: apiVersion must be {SPEC_VERSION!r}")
    if data.get("kind") != "Cell":
        errs.append(f"{path}: kind must be 'Cell'")
    meta = data.get("metadata") or {}
    name = meta.get("name", "")
    if not re.fullmatch(r"[a-z0-9-]{1,32}", str(name or "")):
        errs.append(f"{path}: metadata.name must be kebab-lower 1-32 chars, got {name!r}")
    if not meta.get("description"):
        errs.append(f"{path}: metadata.description is required")
    spec = data.get("spec")
    if not isinstance(spec, dict):
        errs.append(f"{path}: spec is required")
        return errs
    membrane = spec.get("membrane")
    if not isinstance(membrane, dict):
        errs.append(f"{path}: spec.membrane is required")
    has_run = "run" in spec
    has_orgs = "organelles" in spec
    if has_run == has_orgs:
        errs.append(f"{path}: spec must have exactly one of run | organelles")
    if has_run:
        run = spec["run"]
        if not isinstance(run, dict):
            errs.append(f"{path}: spec.run must be mapping")
        else:
            kind = run.get("kind", "exec")
            if kind not in ("exec", "python", "http"):
                errs.append(f"{path}: run.kind must be exec|python|http, got {kind!r}")
            if kind == "exec" and "command" not in run:
                errs.append(f"{path}: run.kind=exec requires command")
            if kind == "python" and "entry" not in run and "code" not in run:
                errs.append(f"{path}: run.kind=python requires entry or code")
            if kind == "http" and "http" not in run:
                errs.append(f"{path}: run.kind=http requires http: {{method, url}}")
    if has_orgs:
        orgs = spec["organelles"]
        wiring = spec.get("wiring", [])
        if not isinstance(orgs, list) or not orgs:
            errs.append(f"{path}: organelles must be non-empty list")
        else:
            names = [o.get("name", "") for o in orgs if isinstance(o, dict)]
            if len(names) != len(set(names)):
                errs.append(f"{path}: organelle names must be unique")
        if not isinstance(wiring, list) or not wiring:
            errs.append(f"{path}: wiring is required for composite")
        else:
            for i, w_ in enumerate(wiring):
                if not isinstance(w_, dict) or "from" not in w_ or "to" not in w_:
                    errs.append(f"{path}: wiring[{i}] requires from/to")
    return errs
def resolve_organelles(root_path: pathlib.Path, data: dict, depth: int = 0, seen: set[str] | None = None) -> dict:
    if seen is None:
        seen = set()
    key = str(root_path.resolve()) if root_path.exists() else str(root_path)
    if key in seen:
        raise ValueError(f"cycle detected at {root_path}")
    seen.add(key)
    spec = data.get("spec", {})
    out = {"path": str(root_path), "data": data, "children": {}}
    for org in spec.get("organelles", []) or []:
        name = org.get("name", "?")
        child_path: pathlib.Path | None = None
        child_data: dict | None = None
        if "cell" in org:
            child_path = (root_path.parent / org["cell"]).resolve()
            child_data = load_cell(child_path)
        elif "cellInline" in org:
            child_data = org["cellInline"]
            child_path = pathlib.Path(f"<inline:{name}>")
        else:
            raise ValueError(f"{root_path}: organelle {name!r} needs cell or cellInline")
        errs = validate_cell(child_data, str(child_path))
        if errs:
            raise ValueError("\n".join(errs))
        out["children"][name] = resolve_organelles(child_path if child_path.exists() else root_path, child_data, depth + 1, set(seen))
    return out
def fire_leaf(data: dict, inputs: dict, workdir: pathlib.Path, cell_file: pathlib.Path) -> dict:
    spec = data["spec"]
    run = spec["run"]
    kind = run.get("kind", "exec")
    membrane = spec.get("membrane", {})
    outputs_spec = (membrane.get("outputs") or {})
    inputs_dir = workdir / "inputs"
    outputs_dir = workdir / "outputs"
    out_dir = workdir / "out"
    inputs_dir.mkdir(parents=True, exist_ok=True)
    outputs_dir.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    for k, v in inputs.items():
        (inputs_dir / f"{k}.json").write_text(json.dumps(v, ensure_ascii=False, indent=2), encoding="utf-8")
    caps = membrane.get("caps", {}) or {}
    allow_net = caps.get("allow_net", [])
    if kind == "exec":
        cmd = run["command"]
        if not isinstance(cmd, list) or not cmd:
            raise ValueError("run.command must be non-empty list")
        env = os.environ.copy()
        for k, v in (run.get("env") or {}).items():
            env[str(k)] = str(v)
        cf = pathlib.Path(cell_file).resolve()
        resolved = []
        for arg in cmd:
            p = pathlib.Path(arg)
            if not p.is_absolute() and (cf.parent / p).exists():
                resolved.append(str((cf.parent / p).resolve()))
            else:
                resolved.append(arg)
        cmd = resolved
        result = subprocess.run(cmd, cwd=str(workdir), env=env, capture_output=True, text=True, timeout=(run.get("timeout_ms", 30000) / 1000))
        if result.returncode != 0:
            raise RuntimeError(f"exec failed ({result.returncode}):\n{result.stderr[:2000]}\n{result.stdout[:2000]}")
        out: dict = {}
        for port in outputs_spec:
            p = outputs_dir / f"{port}.json"
            if p.exists():
                out[port] = json.loads(p.read_text(encoding="utf-8"))
            else:
                q = out_dir / f"{port}.json"
                if q.exists():
                    out[port] = json.loads(q.read_text(encoding="utf-8"))
        return out
    elif kind == "python":
        entry = run.get("entry")
        code = run.get("code")
        if code and not entry:
            tmp = workdir / "_inline.py"
            tmp.write_text(code, encoding="utf-8")
            entry = str(tmp)
        if entry:
            entry_path = pathlib.Path(entry)
            if not entry_path.is_absolute():
                entry_path = (pathlib.Path(cell_file).resolve().parent / entry_path).resolve()
            ns: dict = {"__file__": str(entry_path)}
            exec(compile(entry_path.read_text(encoding="utf-8"), str(entry_path), "exec"), ns)
            fn = ns.get("run")
            if not callable(fn):
                raise ValueError(f"{entry_path}: must define def run(inputs, ctx)")
            ctx = {"caps": caps, "out_dir": str(out_dir), "tmp_dir": str(workdir), "cell_file": str(cell_file)}
            result = fn(dict(inputs), ctx)
            if not isinstance(result, dict):
                raise TypeError(f"{entry_path}: run() must return dict, got {type(result)}")
            for port, val in result.items():
                (outputs_dir / f"{port}.json").write_text(json.dumps(val, ensure_ascii=False, indent=2), encoding="utf-8")
            return result
        raise ValueError("python leaf needs entry or code")
    elif kind == "http":
        http_spec = run["http"]
        method = http_spec.get("method", "GET")
        url_tmpl = http_spec["url"]
        headers_tmpl = http_spec.get("headers", {})
        body_tmpl = http_spec.get("body")
        sys.path.insert(0, str(pathlib.Path(__file__).parent))
        import helpers  # type: ignore
        render = helpers.render_template  # type: ignore
        url = render(url_tmpl, inputs)
        headers = render(headers_tmpl, inputs) if isinstance(headers_tmpl, dict) else {}
        body = render(body_tmpl, inputs) if body_tmpl is not None else None
        if allow_net is not None and allow_net != []:
            from urllib.parse import urlparse
            host = urlparse(str(url)).hostname or ""
            allowed = any(host == h or host.endswith("." + h) for h in allow_net)
            if not allowed:
                raise PermissionError(f"net denied: {host!r} not in allow_net {allow_net}")
        resp = helpers.http_request(str(method), str(url), headers=dict(headers) if isinstance(headers, dict) else {}, body=body, timeout_ms=http_spec.get("timeout_ms", 10000))
        if len(outputs_spec) == 1:
            port = next(iter(outputs_spec))
            val = resp
            mapping = outputs_spec[port]
            if isinstance(mapping, dict) and "from" in mapping:
                expr = mapping["from"]
                if expr.startswith("$."):
                    cur = resp
                    for part in expr[2:].split("."):
                        if isinstance(cur, dict):
                            cur = cur.get(part)
                        else:
                            cur = None
                            break
                    val = cur
            (outputs_dir / f"{port}.json").write_text(json.dumps(val, ensure_ascii=False, indent=2), encoding="utf-8")
            return {port: val}
        else:
            out = {}
            if isinstance(resp, dict):
                for port in outputs_spec:
                    if port in resp:
                        out[port] = resp[port]
                        (outputs_dir / f"{port}.json").write_text(json.dumps(resp[port], ensure_ascii=False, indent=2), encoding="utf-8")
            else:
                raise ValueError(f"http leaf with {len(outputs_spec)} outputs expected object response, got {type(resp)}")
            return out
    else:
        raise ValueError(f"unknown run.kind {kind!r}")
def run_composite(root_path: pathlib.Path, inputs: dict, out_base: pathlib.Path) -> dict:
    data = load_cell(root_path)
    spec = data["spec"]
    orgs: list[dict] = spec.get("organelles", []) or []
    wiring: list[dict] = spec.get("wiring", []) or []
    org_map: dict[str, tuple[pathlib.Path, dict]] = {}
    for o in orgs:
        name = o["name"]
        if "cell" in o:
            p = (root_path.parent / o["cell"]).resolve()
            org_map[name] = (p, load_cell(p))
        else:
            inline_name = f"<inline:{name}>"
            org_map[name] = (pathlib.Path(inline_name), o["cellInline"])
    indeg: dict[str, int] = {o["name"]: 0 for o in orgs}
    adj: dict[str, list[str]] = {o["name"]: [] for o in orgs}
    membrane_out_source: dict[str, str] = {}
    for w_ in wiring:
        src = w_["from"]
        dst = w_["to"]
        if src.startswith("membrane.") and dst.startswith("membrane."):
            continue
        if src.startswith("membrane."):
            continue
        if dst.startswith("membrane."):
            port = dst.split(".", 1)[1]
            org_name = src.split(".")[0]
            membrane_out_source[port] = org_name
            continue
        s_org = src.split(".")[0]
        d_org = dst.split(".")[0]
        if s_org in adj and d_org in indeg:
            adj[s_org].append(d_org)
            indeg[d_org] += 1
    queue = [n for n, d in indeg.items() if d == 0]
    order: list[str] = []
    while queue:
        n = queue.pop(0)
        order.append(n)
        for nb in adj.get(n, []):
            indeg[nb] -= 1
            if indeg[nb] == 0:
                queue.append(nb)
    if len(order) != len(orgs):
        raise ValueError("cycle detected in wiring (or missing edge)")
    produced: dict[str, dict] = {}
    available: dict[str, object] = dict(inputs)
    def resolve_input(dst: str) -> object:
        for w_ in wiring:
            if w_["to"] == dst:
                src = w_["from"]
                if src.startswith("membrane."):
                    port = src.split(".", 1)[1]
                    if port not in available:
                        raise KeyError(f"membrane input {port!r} not provided")
                    return available[port]
                else:
                    s_org, s_port = src.split(".", 1)
                    if s_org not in produced or s_port not in produced[s_org]:
                        raise KeyError(f"unavailable {src!r} for {dst!r} (order {order})")
                    return produced[s_org][s_port]
        raise KeyError(f"no wiring for {dst!r}")
    for name in order:
        cell_path, cell_data = org_map[name]
        membrane_in = (cell_data.get("spec", {}).get("membrane", {}).get("inputs") or {})
        leaf_inputs: dict = {}
        for port, spec_ in membrane_in.items():
            is_required = True
            if isinstance(spec_, dict):
                is_required = spec_.get("required", True) is not False
            try:
                leaf_inputs[port] = resolve_input(f"{name}.{port}")
            except KeyError as e:
                if not is_required:
                    continue
                raise
        is_leaf = "run" in cell_data.get("spec", {})
        if is_leaf:
            workdir = out_base / f"_work_{name}"
            if workdir.exists():
                shutil.rmtree(workdir)
            workdir.mkdir(parents=True, exist_ok=True)
            out = fire_leaf(cell_data, leaf_inputs, workdir, cell_path)
            produced[name] = out
        else:
            sub_out = out_base / f"_work_{name}"
            if sub_out.exists():
                shutil.rmtree(sub_out)
            sub_out.mkdir(parents=True, exist_ok=True)
            out = run_composite(cell_path, leaf_inputs, sub_out)
            produced[name] = out
    membrane_out = (data["spec"].get("membrane", {}).get("outputs") or {})
    final: dict = {}
    for port in membrane_out:
        src_org = membrane_out_source.get(port)
        if src_org is None:
            for w_ in wiring:
                if w_["to"] == f"membrane.{port}":
                    src = w_["from"]
                    if src.startswith("membrane."):
                        final[port] = available[src.split(".", 1)[1]]
                    else:
                        s_org, s_port = src.split(".", 1)
                        final[port] = produced[s_org][s_port]
                    break
            continue
        for w_ in wiring:
            if w_["to"] == f"membrane.{port}" and w_["from"].startswith(src_org + "."):
                s_port = w_["from"].split(".", 1)[1]
                final[port] = produced[src_org][s_port]
                break
    # Merkle DAG: emit manifest for this composite (1)
    try:
        manifest = _manifest_entry(root_path, inputs, final, wiring)
        (out_base / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        # also write leaf manifests already emitted per workdir; this one covers the composite
    except Exception:
        pass
    return final
def cmd_build(root: str) -> int:
    builder = pathlib.Path(__file__).parent / "system" / "builder.cell.yaml"
    if builder.exists():
        out_dir = pathlib.Path(tempfile.mkdtemp(prefix="cell_build_out_"))
        try:
            try:
                result = run_composite(builder.resolve(), {"root": str(pathlib.Path(root).resolve())}, out_dir)
            except Exception as e:
                print(f"error: {e}", file=sys.stderr)
                return 1
            print(result.get("canonical", ""))
            print(f"\n# digest:{result.get('digest','')}  organelles:{result.get('organelle_count','')}", file=sys.stderr)
            return 0
        finally:
            shutil.rmtree(out_dir, ignore_errors=True)
    path = pathlib.Path(root).resolve()
    data = load_cell(path)
    errs = validate_cell(data, str(path))
    if errs:
        for e in errs:
            print(f"error: {e}", file=sys.stderr)
        return 1
    try:
        tree = resolve_organelles(path, data)
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    canon = json.dumps(data, sort_keys=True, ensure_ascii=False, indent=2)
    print(canon)
    print(f"\n# digest:{cell_digest(data)}  organelles:{len(tree['children'])}", file=sys.stderr)
    return 0
def cmd_run(root: str, inputs_path: str | None, out: str | None) -> int:
    path = pathlib.Path(root).resolve()
    data = load_cell(path)
    errs = validate_cell(data, str(path))
    if errs:
        for e in errs:
            print(f"error: {e}", file=sys.stderr)
        return 1
    inputs: dict = {}
    if inputs_path:
        raw = json.loads(pathlib.Path(inputs_path).read_text(encoding="utf-8"))
        if isinstance(raw, dict) and set(raw.keys()) & set((data.get("spec", {}).get("membrane", {}).get("inputs", {}) or {}).keys()):
            inputs = raw
        else:
            if isinstance(raw, dict) and "inputs" in raw and len(raw) == 1:
                inputs = raw["inputs"]
            else:
                inputs = raw if isinstance(raw, dict) else {"value": raw}
    out_base = pathlib.Path(out) if out else pathlib.Path("out")
    out_base.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(pathlib.Path(__file__).parent))
    try:
        import helpers  # type: ignore
        for port, schema in (data.get("spec", {}).get("membrane", {}).get("inputs", {}) or {}).items():
            s = schema.get("schema") if isinstance(schema, dict) else schema
            if port in inputs and s:
                sp = s
                if isinstance(s, str) and s not in ("string",) and not pathlib.Path(s).is_absolute():
                    sp = str((path.parent / s).resolve())
                try:
                    helpers.validate(inputs[port], sp)
                except Exception as e:
                    print(f"input {port!r} failed schema {s!r}: {e}", file=sys.stderr)
                    return 1
    except ImportError:
        pass
    try:
        is_leaf = "run" in data.get("spec", {})
        if is_leaf:
            tmp = pathlib.Path(tempfile.mkdtemp(prefix="cell_leaf_"))
            result = fire_leaf(data, inputs, tmp, path)
            for port, schema in (data.get("spec", {}).get("membrane", {}).get("outputs", {}) or {}).items():
                if port not in result:
                    print(f"error: leaf missing output {port!r}", file=sys.stderr)
                    return 1
            for k, v in result.items():
                (out_base / f"{k}.json").write_text(json.dumps(v, ensure_ascii=False, indent=2), encoding="utf-8")
            try:
                (out_base / "manifest.json").write_text(json.dumps(_manifest_entry(path, inputs, result, []), indent=2), encoding="utf-8")
            except Exception:
                pass
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            result = run_composite(path, inputs, out_base)
            for k, v in result.items():
                (out_base / f"{k}.json").write_text(json.dumps(v, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0
def cmd_check(root: str, inputs_path: str | None) -> int:
    rc = cmd_run(root, inputs_path, out=None)
    if rc != 0:
        return rc
    print("check: ok", file=sys.stderr)
    return 0
def main() -> None:
    ap = argparse.ArgumentParser(prog="cell")
    sub = ap.add_subparsers(dest="cmd")
    p_build = sub.add_parser("build")
    p_build.add_argument("root")
    p_run = sub.add_parser("run")
    p_run.add_argument("root")
    p_run.add_argument("--inputs", default=None)
    p_run.add_argument("--out", default="out")
    p_check = sub.add_parser("check")
    p_check.add_argument("root")
    p_check.add_argument("--inputs", default=None)
    args = ap.parse_args()
    if args.cmd == "build":
        raise SystemExit(cmd_build(args.root))
    elif args.cmd == "run":
        raise SystemExit(cmd_run(args.root, args.inputs, args.out))
    elif args.cmd == "check":
        raise SystemExit(cmd_check(args.root, args.inputs))
    else:
        ap.print_help()
        raise SystemExit(1)
if __name__ == "__main__":
    main()
