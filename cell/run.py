#!/usr/bin/env python3
"""run.py — canonical cell runtime (python-native, composable).
Builder is a cell: system/builder.cell.yaml (parse | validate | emit) — no second code path.

Usage:
  python run.py build  <root.cell.yaml>
  python run.py run    <root.cell.yaml> --inputs inputs.json --out out/
  python run.py check  <root.cell.yaml> --inputs inputs.json
  python run.py draft  "<goal>" --kind python|exec|http [--name slug] [--write dir/]
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

def _canonical_bytes(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

def _digest(value: object) -> str:
    return _cas_hash(_canonical_bytes(value))

def _atomic_json(path: pathlib.Path, value: object) -> None:
    """A firing without its provenance is a failed firing, never a success."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, sort_keys=True, ensure_ascii=False, indent=2) + "\n"
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(payload, encoding="utf-8")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)

def _code_sources(cell_path: pathlib.Path, data: dict) -> dict[str, str]:
    run = (data.get("spec") or {}).get("run") or {}
    refs: list[str] = []
    if run.get("kind") == "python" and isinstance(run.get("entry"), str):
        refs.append(run["entry"])
    if run.get("kind", "exec") == "exec" and isinstance(run.get("command"), list):
        refs.extend(x for x in run["command"] if isinstance(x, str))
    sources: dict[str, str] = {}
    for ref in refs:
        p = pathlib.Path(ref)
        if not p.is_absolute():
            p = cell_path.resolve().parent / p
        if p.is_file():
            sources[ref] = _cas_hash(p.read_bytes())
    return sources

def _cell_definition_digest(cell_path: pathlib.Path, data: dict, stack: set[str] | None = None) -> str:
    """Pin declaration, executable bytes, and all descendant definitions."""
    stack = set() if stack is None else set(stack)
    key = str(cell_path.resolve()) if cell_path.exists() else f"inline:{id(data)}"
    if key in stack:
        raise ValueError(f"recursive cell inclusion at {cell_path}")
    stack.add(key)
    clean = {k: v for k, v in data.items() if k != "_source_path"}
    children: list[dict] = []
    for org in ((clean.get("spec") or {}).get("organelles") or []):
        name = org["name"]
        if "cell" in org:
            child_path = (cell_path.parent / org["cell"]).resolve()
            child_data = load_cell(child_path)
        else:
            child_path = cell_path
            child_data = org["cellInline"]
        children.append({"name": name, "digest": _cell_definition_digest(child_path, child_data, stack)})
    return _digest({"definition": clean, "code": _code_sources(cell_path, clean), "children": children})

def _manifest_entry(cell_path: pathlib.Path, data: dict, inputs: dict, outputs: dict,
                    wiring: list, children: dict[str, dict] | None = None) -> dict:
    child_refs = {
        name: {k: manifest[k] for k in ("cell", "digest", "produced_by") if k in manifest}
        for name, manifest in sorted((children or {}).items())
    }
    cell = _cell_definition_digest(cell_path, data)
    inputs_h = {k: _digest(v) for k, v in sorted(inputs.items())}
    outputs_h = {k: _digest(v) for k, v in sorted(outputs.items())}
    base = {
        "cell": cell,
        "cell_path": str(cell_path),
        "inputs": inputs_h,
        "outputs": outputs_h,
        "evidence": [{"port": k, "digest": inputs_h[k]} for k in sorted(inputs_h)],
        "children": child_refs,
        "produced_by": _digest({"cell": cell, "inputs": inputs_h, "wiring": wiring, "children": child_refs}),
    }
    return {**base, "digest": _digest(base)}
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
    else:
        for direction in ("inputs", "outputs"):
            ports = membrane.get(direction, {})
            if not isinstance(ports, dict):
                errs.append(f"{path}: membrane.{direction} must be a mapping")
                continue
            for port, declaration in ports.items():
                if not re.fullmatch(r"[A-Za-z0-9_-]+", str(port)):
                    errs.append(f"{path}: invalid {direction} port name {port!r}")
                if not isinstance(declaration, dict) or "schema" not in declaration:
                    errs.append(f"{path}: membrane.{direction}.{port} requires schema")
        if "caps" in membrane and not isinstance(membrane.get("caps"), dict):
            errs.append(f"{path}: membrane.caps must be a mapping")
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
def _port_map(data: dict, direction: str) -> dict:
    value = (((data.get("spec") or {}).get("membrane") or {}).get(direction) or {})
    return value if isinstance(value, dict) else {}

def validate_graph(root_path: pathlib.Path, data: dict, stack: set[str] | None = None) -> list[str]:
    """Validate the complete typed graph. Runtime never guesses a port or edge."""
    errs = validate_cell(data, str(root_path))
    if errs or "organelles" not in (data.get("spec") or {}):
        return errs
    stack = set() if stack is None else set(stack)
    key = str(root_path.resolve()) if root_path.exists() else f"inline:{id(data)}"
    if key in stack:
        return errs + [f"{root_path}: recursive cell inclusion"]
    stack.add(key)
    spec = data["spec"]
    org_data: dict[str, tuple[pathlib.Path, dict]] = {}
    for i, org in enumerate(spec.get("organelles") or []):
        if not isinstance(org, dict) or not isinstance(org.get("name"), str) or not org["name"]:
            errs.append(f"{root_path}: organelles[{i}] requires a non-empty name")
            continue
        name = org["name"]
        if ("cell" in org) == ("cellInline" in org):
            errs.append(f"{root_path}: organelle {name!r} requires exactly one of cell|cellInline")
            continue
        try:
            if "cell" in org:
                if not isinstance(org["cell"], str):
                    raise TypeError("cell must be a path string")
                child_path = (root_path.parent / org["cell"]).resolve()
                child_data = load_cell(child_path)
            else:
                child_path = root_path
                child_data = org["cellInline"]
                if not isinstance(child_data, dict):
                    raise TypeError("cellInline must be a mapping")
            org_data[name] = (child_path, child_data)
            errs.extend(validate_graph(child_path, child_data, stack))
        except Exception as exc:
            errs.append(f"{root_path}: organelle {name!r}: {exc}")
    root_in, root_out = _port_map(data, "inputs"), _port_map(data, "outputs")
    incoming: dict[str, int] = {}
    root_uses: dict[str, int] = {}
    for i, edge in enumerate(spec.get("wiring") or []):
        if not isinstance(edge, dict) or not isinstance(edge.get("from"), str) or not isinstance(edge.get("to"), str):
            continue  # shape error already reported by validate_cell
        src, dst = edge["from"], edge["to"]
        if src.count(".") != 1 or dst.count(".") != 1:
            errs.append(f"{root_path}: wiring[{i}] endpoints must be <node>.<port>: {src!r} -> {dst!r}")
            continue
        sn, sp = src.split(".", 1); dn, dp = dst.split(".", 1)
        if sn == "membrane":
            if sp not in root_in:
                errs.append(f"{root_path}: wiring[{i}] unknown membrane input {sp!r}")
            else:
                root_uses[sp] = root_uses.get(sp, 0) + 1
        elif sn not in org_data:
            errs.append(f"{root_path}: wiring[{i}] unknown source organelle {sn!r}")
        elif sp not in _port_map(org_data[sn][1], "outputs"):
            errs.append(f"{root_path}: wiring[{i}] unknown output port {src!r}")
        if dn == "membrane":
            if dp not in root_out:
                errs.append(f"{root_path}: wiring[{i}] unknown membrane output {dp!r}")
        elif dn not in org_data:
            errs.append(f"{root_path}: wiring[{i}] unknown target organelle {dn!r}")
        elif dp not in _port_map(org_data[dn][1], "inputs"):
            errs.append(f"{root_path}: wiring[{i}] unknown input port {dst!r}")
        incoming[dst] = incoming.get(dst, 0) + 1
    for port, decl in root_in.items():
        required = not isinstance(decl, dict) or decl.get("required", True) is not False
        unused = isinstance(decl, dict) and decl.get("unused") is True
        if required and not unused and root_uses.get(port, 0) == 0:
            errs.append(f"{root_path}: required membrane input {port!r} is not wired")
    for port in root_out:
        n = incoming.get(f"membrane.{port}", 0)
        if n != 1:
            errs.append(f"{root_path}: membrane output {port!r} requires exactly one producer, got {n}")
    for name, (_, child) in org_data.items():
        for port, decl in _port_map(child, "inputs").items():
            n = incoming.get(f"{name}.{port}", 0)
            required = not isinstance(decl, dict) or decl.get("required", True) is not False
            if required and n != 1:
                errs.append(f"{root_path}: required input {name}.{port} requires exactly one source, got {n}")
            elif not required and n > 1:
                errs.append(f"{root_path}: optional input {name}.{port} has fan-in {n}; use an explicit reducer")
    # Kahn validation is based only on valid child-to-child data edges.
    indeg = {n: 0 for n in org_data}; adj = {n: [] for n in org_data}
    for edge in spec.get("wiring") or []:
        if not isinstance(edge, dict): continue
        src, dst = edge.get("from", ""), edge.get("to", "")
        if isinstance(src, str) and isinstance(dst, str) and "." in src and "." in dst:
            sn, dn = src.split(".", 1)[0], dst.split(".", 1)[0]
            if sn in org_data and dn in org_data:
                adj[sn].append(dn); indeg[dn] += 1
    frontier = sorted(n for n, degree in indeg.items() if degree == 0); seen_count = 0
    while frontier:
        current, frontier = frontier, []
        seen_count += len(current)
        for name in current:
            for nxt in sorted(adj[name]):
                indeg[nxt] -= 1
                if indeg[nxt] == 0: frontier.append(nxt)
        frontier.sort()
    if seen_count != len(org_data):
        errs.append(f"{root_path}: cycle detected in wiring")
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
def _declared_inputs(data: dict, inputs: dict, where: str) -> None:
    ports = _port_map(data, "inputs")
    extra = sorted(set(inputs) - set(ports))
    if extra:
        raise ValueError(f"{where}: undeclared input ports: {', '.join(extra)}")
    missing = []
    for port, decl in ports.items():
        required = not isinstance(decl, dict) or decl.get("required", True) is not False
        if required and port not in inputs:
            missing.append(port)
    if missing:
        raise ValueError(f"{where}: missing required input ports: {', '.join(missing)}")

def _declared_outputs(data: dict, outputs: dict, where: str) -> None:
    ports = _port_map(data, "outputs")
    missing, extra = sorted(set(ports) - set(outputs)), sorted(set(outputs) - set(ports))
    if missing or extra:
        raise ValueError(f"{where}: output port mismatch; missing={missing}, undeclared={extra}")

def _validate_port_values(data: dict, values: dict, direction: str, cell_path: pathlib.Path) -> None:
    import helpers  # type: ignore
    primitive_types = {
        "string": str, "object": dict, "array": list, "integer": int,
        "number": (int, float), "boolean": bool, "null": type(None),
    }
    for port, value in values.items():
        declaration = _port_map(data, direction).get(port) or {}
        schema = declaration.get("schema") if isinstance(declaration, dict) else declaration
        if schema in primitive_types:
            expected = primitive_types[schema]
            # bool is an int in Python but is not a JSON integer/number here.
            valid = isinstance(value, expected) and not (schema in ("integer", "number") and isinstance(value, bool))
            if not valid:
                raise TypeError(f"{cell_path}: {direction} port {port!r} expected {schema}, got {type(value).__name__}")
        elif schema:
            resolved = schema
            if isinstance(schema, str) and not pathlib.Path(schema).is_absolute():
                resolved = str((cell_path.resolve().parent / schema).resolve())
            helpers.validate(value, resolved)

def run_composite(root_path: pathlib.Path, inputs: dict, out_base: pathlib.Path) -> dict:
    data = load_cell(root_path)
    errs = validate_graph(root_path, data)
    if errs:
        raise ValueError("\n".join(errs))
    _declared_inputs(data, inputs, str(root_path))
    spec = data["spec"]
    orgs: list[dict] = spec.get("organelles", []) or []
    wiring: list[dict] = spec.get("wiring", []) or []
    org_map: dict[str, tuple[pathlib.Path, dict]] = {}
    for org in orgs:
        name = org["name"]
        if "cell" in org:
            path = (root_path.parent / org["cell"]).resolve()
            org_map[name] = (path, load_cell(path))
        else:
            # Inline code resolves relative to its containing cell.
            org_map[name] = (root_path, org["cellInline"])
    indeg = {name: 0 for name in org_map}; adj = {name: [] for name in org_map}
    for edge in wiring:
        sn, dn = edge["from"].split(".", 1)[0], edge["to"].split(".", 1)[0]
        if sn in org_map and dn in org_map:
            adj[sn].append(dn); indeg[dn] += 1
    frontiers: list[list[str]] = []
    frontier = sorted(name for name, degree in indeg.items() if degree == 0)
    while frontier:
        frontiers.append(frontier)
        nxt: list[str] = []
        for name in frontier:
            for target in sorted(adj[name]):
                indeg[target] -= 1
                if indeg[target] == 0: nxt.append(target)
        frontier = sorted(nxt)
    if sum(map(len, frontiers)) != len(org_map):
        raise ValueError(f"{root_path}: cycle detected in wiring")
    produced: dict[str, dict] = {}
    child_manifests: dict[str, dict] = {}
    def inputs_for(name: str) -> dict:
        child = org_map[name][1]; values: dict = {}
        for port, decl in _port_map(child, "inputs").items():
            matches = [edge["from"] for edge in wiring if edge["to"] == f"{name}.{port}"]
            if not matches:
                continue
            src = matches[0]
            if src.startswith("membrane."):
                values[port] = inputs[src.split(".", 1)[1]]
            else:
                source_name, source_port = src.split(".", 1)
                values[port] = produced[source_name][source_port]
        _declared_inputs(child, values, name)
        return values
    def fire_one(name: str, leaf_inputs: dict) -> tuple[str, dict, dict]:
        cell_path, child = org_map[name]
        _validate_port_values(child, leaf_inputs, "inputs", cell_path)
        workdir = out_base / f"_work_{name}"
        if workdir.exists(): shutil.rmtree(workdir)
        workdir.mkdir(parents=True, exist_ok=True)
        if "run" in (child.get("spec") or {}):
            result = fire_leaf(child, leaf_inputs, workdir, cell_path)
            _declared_outputs(child, result, name)
            _validate_port_values(child, result, "outputs", cell_path)
            manifest = _manifest_entry(cell_path, child, leaf_inputs, result, [])
            _atomic_json(workdir / "manifest.json", manifest)
        else:
            result = run_composite(cell_path, leaf_inputs, workdir)
            manifest = json.loads((workdir / "manifest.json").read_text(encoding="utf-8"))
        return name, result, manifest
    for current in frontiers:
        prepared = {name: inputs_for(name) for name in current}
        # Python and exec leaves run with ambient host authority. A caps declaration is
        # audit metadata, not confinement, so no leaf is mechanically effect-free.
        # Keep each Kahn frontier lexical and serial until an executor sandbox proves it safe.
        for name in sorted(current):
            _, result, manifest = fire_one(name, prepared[name])
            produced[name] = result; child_manifests[name] = manifest
    final: dict = {}
    for port in _port_map(data, "outputs"):
        src = next(edge["from"] for edge in wiring if edge["to"] == f"membrane.{port}")
        if src.startswith("membrane."):
            final[port] = inputs[src.split(".", 1)[1]]
        else:
            source_name, source_port = src.split(".", 1)
            final[port] = produced[source_name][source_port]
    _declared_outputs(data, final, str(root_path))
    _validate_port_values(data, final, "outputs", root_path)
    manifest = _manifest_entry(root_path, data, inputs, final, wiring, child_manifests)
    _atomic_json(out_base / "manifest.json", manifest)
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
def cmd_run(root: str, inputs_path: str | None, out: str | None, open_ui: bool = False) -> int:
    path = pathlib.Path(root).resolve()
    data = load_cell(path)
    errs = validate_graph(path, data)
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
    try:
        _declared_inputs(data, inputs, str(path))
        _validate_port_values(data, inputs, "inputs", path)
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
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
            _declared_outputs(data, result, str(path))
            _validate_port_values(data, result, "outputs", path)
            for k, v in result.items():
                _atomic_json(out_base / f"{k}.json", v)
            manifest = _manifest_entry(path, data, inputs, result, [])
            _atomic_json(out_base / "manifest.json", manifest)
            _journal_firing(manifest, path)
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            result = run_composite(path, inputs, out_base)
            for k, v in result.items():
                _atomic_json(out_base / f"{k}.json", v)
            _journal_firing(json.loads((out_base / "manifest.json").read_text(encoding="utf-8")), path)
            print(json.dumps(result, ensure_ascii=False, indent=2))
        # The daemon opens the canvas when it is watching; this covers the plain
        # CLI so a deploy surfaces its workflow even with no daemon running.
        if open_ui or _is_deploy_cell(str(path)):
            _open_ui(str(path), "requested" if open_ui else "deploy fired")
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0
def cmd_check(root: str, inputs_path: str | None) -> int:
    path = pathlib.Path(root).resolve()
    data = load_cell(path)
    policy = (data.get("spec") or {}).get("policy") or {}
    required = policy.get("determinism") == "required" or "organelles" in (data.get("spec") or {})
    first = pathlib.Path(tempfile.mkdtemp(prefix="cell_check_a_"))
    second = pathlib.Path(tempfile.mkdtemp(prefix="cell_check_b_"))
    try:
        rc = cmd_run(root, inputs_path, str(first))
        if rc != 0 or not required:
            return rc
        rc = cmd_run(root, inputs_path, str(second))
        if rc != 0:
            return rc
        outputs = _port_map(data, "outputs")
        mismatched = [port for port in outputs if (first / f"{port}.json").read_bytes() != (second / f"{port}.json").read_bytes()]
        if mismatched:
            print(f"error: determinism required but outputs changed: {mismatched}", file=sys.stderr)
            return 1
        if (first / "manifest.json").read_bytes() != (second / "manifest.json").read_bytes():
            print("error: determinism required but provenance manifest changed", file=sys.stderr)
            return 1
        print("check: ok", file=sys.stderr)
        return 0
    finally:
        shutil.rmtree(first, ignore_errors=True)
        shutil.rmtree(second, ignore_errors=True)
def _cell_root() -> pathlib.Path:
    return pathlib.Path(__file__).resolve().parent

ENGINE_SCHEMA = """
CREATE TABLE IF NOT EXISTS firings (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  id               TEXT NOT NULL UNIQUE,
  cell             TEXT NOT NULL,
  ports            TEXT NOT NULL,
  manifest_digest  TEXT,
  committed_at_ms  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS node_runs (
  firing_id   TEXT NOT NULL,
  node        TEXT NOT NULL,
  cell_digest TEXT,
  produced_by TEXT,
  PRIMARY KEY (firing_id, node)
);
CREATE TABLE IF NOT EXISTS occurrences (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  firing_id      TEXT NOT NULL,
  cell           TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS firings_cell ON firings(cell);
CREATE INDEX IF NOT EXISTS occurrences_firing ON occurrences(firing_id);
"""

def _engine_db():
    """The engine's own store: one sqlite file, append-only by discipline —
    INSERT OR IGNORE keyed on the deterministic firing identity, never UPDATE
    or DELETE. A row is evidence that a firing happened; nothing may rewrite
    it. Replaces the earlier firings.jsonl (migrated on first open) so every
    caller — CLI, UI, daemon, agent — reads one indexed store instead of
    re-parsing a growing text file."""
    import sqlite3
    override = os.environ.get("CELL_ENGINE_DB")
    if override:
        # A witness must be able to exercise the store without writing into the
        # one a live daemon is following.
        path = pathlib.Path(override)
        path.parent.mkdir(parents=True, exist_ok=True)
        out = path.parent
    else:
        out = _cell_root() / "out"
        out.mkdir(parents=True, exist_ok=True)
        path = out / "engine.db"
    db = sqlite3.connect(path, timeout=10)
    db.row_factory = sqlite3.Row
    db.executescript(ENGINE_SCHEMA)
    legacy = out / "firings.jsonl"
    # Migration belongs to the real store only; a witness store starts empty.
    if not override and legacy.exists():
        for line in legacy.read_text(encoding="utf-8").splitlines():
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("id"):
                db.execute(
                    "INSERT OR IGNORE INTO firings (id, cell, ports, manifest_digest, committed_at_ms)"
                    " VALUES (?,?,?,?,?)",
                    (rec["id"], rec.get("cell", ""), json.dumps(rec.get("ports") or []),
                     rec.get("manifest_digest"), int(rec.get("committed_at_ms") or 0)),
                )
        db.commit()
        legacy.rename(out / "firings.jsonl.migrated")
    return db

def _journal_firing(manifest: dict, cell_path: pathlib.Path) -> None:
    """Index the firing in the engine store. Identity (produced_by) stays
    deterministic; timing lives on the row, outside identity. Per-node rows
    come from the manifest's own children, so the UI can show which node
    produced what without a second execution model. No swallow: a firing the
    engine cannot index is a failed firing, matching the manifest-write
    doctrine above."""
    import time
    fid = manifest.get("produced_by")
    if not fid:
        raise ValueError("firing has no produced_by identity to index")
    db = _engine_db()
    try:
        db.execute(
            "INSERT OR IGNORE INTO firings (id, cell, ports, manifest_digest, committed_at_ms)"
            " VALUES (?,?,?,?,?)",
            (fid, str(cell_path), json.dumps(sorted((manifest.get("outputs") or {}).keys())),
             manifest.get("digest"), int(time.time() * 1000)),
        )
        # The identity dedupes: the same pinned inputs are the same firing. But
        # each RUN is a real occurrence — the substrate's own word for "this
        # happened again" — so it gets its own append-only row. Without this a
        # re-fire is invisible to anything following the store, which is both a
        # lie by omission in the UI and a watcher that waits forever.
        db.execute(
            "INSERT INTO occurrences (firing_id, cell, observed_at_ms) VALUES (?,?,?)",
            (fid, str(cell_path), int(time.time() * 1000)),
        )
        for node, child in sorted((manifest.get("children") or {}).items()):
            db.execute(
                "INSERT OR IGNORE INTO node_runs (firing_id, node, cell_digest, produced_by)"
                " VALUES (?,?,?,?)",
                (fid, node, child.get("digest"), child.get("produced_by")),
            )
        db.commit()
    finally:
        db.close()

def cmd_firings(limit: int) -> int:
    """Project the engine store. Identity is the primary key, so dedupe is the
    schema's job rather than a re-scan; per-node rows travel with each firing so
    a caller can show which node produced what."""
    import datetime
    db = _engine_db()
    try:
        rows = []
        for r in db.execute(
            "SELECT * FROM firings ORDER BY committed_at_ms DESC, seq DESC LIMIT ?", (limit,)
        ).fetchall():
            nodes = [
                {"node": n["node"], "cell_digest": n["cell_digest"], "produced_by": n["produced_by"]}
                for n in db.execute(
                    "SELECT node, cell_digest, produced_by FROM node_runs WHERE firing_id = ? ORDER BY node",
                    (r["id"],),
                ).fetchall()
            ]
            occ = db.execute(
                "SELECT COUNT(*) n, MAX(observed_at_ms) last FROM occurrences WHERE firing_id = ?",
                (r["id"],),
            ).fetchone()
            rows.append({
                "occurrences": occ["n"],
                "last_observed_ms": occ["last"],
                "id": r["id"],
                "cell": r["cell"],
                "ports": json.loads(r["ports"]),
                "manifest_digest": r["manifest_digest"],
                "committed_at_ms": r["committed_at_ms"],
                "created_at": datetime.datetime.fromtimestamp(
                    r["committed_at_ms"] / 1000, datetime.timezone.utc
                ).isoformat(),
                "nodes": nodes,
            })
    finally:
        db.close()
    print(json.dumps({"firings": rows}, sort_keys=True, ensure_ascii=False, indent=2))
    return 0

# A deploy is what the drop-in protocol calls seating Aiko: the fde/self-wire
# composition (account-handle -> deploy-workflow -> deploy-aiko) and its limbs.
DEPLOY_CELL_MARKERS = ("self-wire", "deploy-workflow", "deploy-aiko")

def _is_deploy_cell(cell: str) -> bool:
    name = pathlib.Path(cell).name
    return any(marker in name for marker in DEPLOY_CELL_MARKERS)

def _ui_url(cell: str | None = None) -> str:
    base = os.environ.get("CELL_UI_URL", "http://127.0.0.1:3100").rstrip("/")
    return f"{base}/?cell={cell}" if cell else base + "/"

def _open_ui(cell: str | None, reason: str) -> None:
    """Open the canvas on the workflow that just fired. Best-effort by design:
    a deploy that succeeded must not be reported as failed because no browser
    or no UI was there to look at it."""
    url = _ui_url(cell)
    opener = "open" if sys.platform == "darwin" else "xdg-open"
    try:
        done = subprocess.run([opener, url], check=False, capture_output=True, timeout=5)
        if done.returncode == 0:
            print(f"ui: opened {url} ({reason})", file=sys.stderr)
        else:
            # Say what happened. Reporting "opened" on a non-zero opener is the
            # same false claim the substrate refuses everywhere else.
            print(f"ui: {url} not opened ({reason}); {opener} exit {done.returncode}", file=sys.stderr)
    except Exception as exc:
        print(f"ui: could not open {url} ({reason}): {exc}", file=sys.stderr)

def _resolve_in_root(rel: str) -> pathlib.Path:
    root = _cell_root()
    p = pathlib.Path(rel)
    p = (p if p.is_absolute() else root / p).resolve()
    if p != root and root not in p.parents:
        raise ValueError(f"path {rel!r} escapes the cell root")
    return p

def cmd_save(rel: str) -> int:
    """Validator-bound write: the engine refuses to persist a cell it would
    refuse to fire. Content arrives on stdin; the write is atomic."""
    try:
        target = _resolve_in_root(rel)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if not target.name.endswith(".cell.yaml"):
        print("error: save target must end with .cell.yaml", file=sys.stderr)
        return 1
    content = sys.stdin.read()
    if not content.strip():
        print("error: refusing to save empty content", file=sys.stderr)
        return 1
    if yaml is None:
        print("error: pyyaml required: pip install pyyaml", file=sys.stderr)
        return 1
    try:
        data = yaml.safe_load(content)
    except Exception as exc:
        print(f"error: yaml parse failed: {exc}", file=sys.stderr)
        return 1
    if not isinstance(data, dict):
        print("error: top-level must be a mapping", file=sys.stderr)
        return 1
    errs = validate_cell(data, str(target))
    if not errs and "organelles" in (data.get("spec") or {}):
        errs = validate_graph(target, data)
    if errs:
        for e in errs:
            print(f"error: {e}", file=sys.stderr)
        return 1
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(content, encoding="utf-8")
        os.replace(tmp, target)
    finally:
        tmp.unlink(missing_ok=True)
    print(json.dumps({"path": str(target.relative_to(_cell_root())), "digest": cell_digest(data)}, sort_keys=True))
    return 0

def cmd_remove(rel: str) -> int:
    """A cell referenced by another cell's organelles may not be removed —
    deleting an organelle out from under a composite is the composability
    break this verb exists to refuse."""
    try:
        target = _resolve_in_root(rel)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if not target.name.endswith(".cell.yaml"):
        print("error: remove target must end with .cell.yaml", file=sys.stderr)
        return 1
    if not target.exists():
        print(f"error: no such cell: {rel}", file=sys.stderr)
        return 1
    root = _cell_root()
    skip = {"node_modules", ".git", "out", ".cell-cas", "web", "zig-out"}
    referrers: list[str] = []
    for p in root.rglob("*.cell.yaml"):
        if any(part in skip for part in p.parts) or p.resolve() == target:
            continue
        try:
            data = load_cell(p)
        except Exception:
            continue
        for org in ((data.get("spec") or {}).get("organelles") or []):
            ref = org.get("cell") if isinstance(org, dict) else None
            if isinstance(ref, str) and (p.parent / ref).resolve() == target:
                referrers.append(str(p.relative_to(root)))
    if referrers:
        print(f"error: refusing to remove {rel!r} — referenced by: {', '.join(sorted(set(referrers)))}", file=sys.stderr)
        return 1
    target.unlink()
    print(json.dumps({"removed": str(target.relative_to(root))}, sort_keys=True))
    return 0

def cmd_daemon(sock_arg: str | None) -> int:
    """THE one daemon: a single long-running listener for the whole substrate.
    - tails out/firings.jsonl and broadcasts every firing to subscribers
    - powers agent turns by spawning the aiko CLI over stdio (--prompt-file,
      single-turn, prints, exits) — the daemon holds no model state itself
    Protocol: unix socket, one JSON line in, JSON line(s) out.
    Ops: ping | status | agent {prompt, timeout_s?} | subscribe (streams)."""
    import queue
    import shlex
    import socket
    import socketserver
    import threading
    import time
    root = _cell_root()
    sock_path = pathlib.Path(sock_arg or os.environ.get("CELL_DAEMON_SOCK") or (root / "out" / "daemon.sock"))
    sock_path.parent.mkdir(parents=True, exist_ok=True)
    if sock_path.exists():
        probe = socket.socket(socket.AF_UNIX)
        probe.settimeout(1.0)
        try:
            probe.connect(str(sock_path))
            probe.close()
            print(f"error: daemon already listening on {sock_path}", file=sys.stderr)
            return 1
        except OSError:
            sock_path.unlink()  # stale socket from a dead daemon
    aiko_bin = os.environ.get("AIKO_BIN", "aiko")
    extra_args = shlex.split(os.environ.get("AIKO_EXTRA_ARGS", ""))
    subscribers: set = set()
    sub_lock = threading.Lock()
    started_ms = int(time.time() * 1000)

    auto_open = os.environ.get("CELL_UI_AUTO_OPEN", "1") not in ("0", "false", "no")

    def watch_journal() -> None:
        """Follow the engine store by monotonic seq — the schema gives a cursor,
        so there is no byte offset to lose across truncation or concurrent
        writers. A deploy firing also opens the canvas on that workflow."""
        seq = 0
        try:
            db = _engine_db()
            row = db.execute("SELECT COALESCE(MAX(seq), 0) AS s FROM occurrences").fetchone()
            seq = row["s"]
            db.close()
        except Exception:
            pass
        while True:
            try:
                db = _engine_db()
                try:
                    rows = db.execute(
                        "SELECT o.seq, o.firing_id AS id, o.cell, o.observed_at_ms AS committed_at_ms,"
                        "       f.ports, f.manifest_digest"
                        "  FROM occurrences o LEFT JOIN firings f ON f.id = o.firing_id"
                        " WHERE o.seq > ? ORDER BY o.seq",
                        (seq,),
                    ).fetchall()
                finally:
                    db.close()
                for r in rows:
                    seq = r["seq"]
                    event = {
                        "event": "firing", "id": r["id"], "cell": r["cell"],
                        "ports": json.loads(r["ports"] or "[]"),
                        "manifest_digest": r["manifest_digest"],
                        "committed_at_ms": r["committed_at_ms"],
                        "deploy": _is_deploy_cell(r["cell"]),
                    }
                    with sub_lock:
                        for q in list(subscribers):
                            q.put(event)
                    if auto_open and event["deploy"]:
                        _open_ui(r["cell"], "deploy fired")
            except Exception:
                pass  # the watcher must outlive any single bad read
            time.sleep(0.3)

    def agent_turn(prompt: str, timeout_s: int) -> dict:
        # Prompt travels by file, response by stdout — never argv (ps leaks).
        pf = root / "out" / f".agent_prompt_{os.getpid()}_{threading.get_ident()}"
        pf.write_text(prompt, encoding="utf-8")
        try:
            proc = subprocess.run(
                [aiko_bin, "--prompt-file", str(pf), "--output-format", "plain", *extra_args],
                capture_output=True, text=True, timeout=timeout_s, cwd=str(root),
            )
            ok = proc.returncode == 0
            return {"ok": ok, "code": proc.returncode,
                    "output": proc.stdout[-16000:],
                    **({} if ok else {"error": proc.stderr[-4000:] or f"agent exit {proc.returncode}"})}
        except FileNotFoundError:
            return {"ok": False, "error": f"agent binary not found: {aiko_bin!r} — set AIKO_BIN"}
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": f"agent turn timed out after {timeout_s}s"}
        finally:
            pf.unlink(missing_ok=True)

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):  # noqa: ANN001 — socketserver signature
            line = self.rfile.readline(1 << 20)
            if not line:
                return
            try:
                req = json.loads(line)
            except json.JSONDecodeError:
                self.wfile.write(b'{"ok": false, "error": "bad json"}\n')
                return
            op = req.get("op")
            if op == "ping":
                self.wfile.write(b'{"ok": true, "pong": true}\n')
            elif op == "status":
                with sub_lock:
                    n = len(subscribers)
                self.wfile.write(json.dumps({
                    "ok": True, "agent_bin": aiko_bin, "subscribers": n,
                    "started_ms": started_ms, "socket": str(sock_path),
                }).encode() + b"\n")
            elif op == "agent":
                prompt = str(req.get("prompt") or "").strip()
                if not prompt:
                    self.wfile.write(b'{"ok": false, "error": "empty prompt"}\n')
                    return
                res = agent_turn(prompt, int(req.get("timeout_s") or 120))
                self.wfile.write(json.dumps(res, ensure_ascii=False).encode() + b"\n")
            elif op == "subscribe":
                q: queue.Queue = queue.Queue()
                with sub_lock:
                    subscribers.add(q)
                idle = 0
                try:
                    self.wfile.write(b'{"ok": true, "subscribed": true}\n')
                    self.wfile.flush()
                    while True:
                        try:
                            event = q.get(timeout=1.0)
                            idle = 0
                        except queue.Empty:
                            idle += 1
                            if idle < 15:
                                continue
                            event = {"event": "heartbeat"}  # detects dead clients
                            idle = 0
                        self.wfile.write(json.dumps(event, ensure_ascii=False).encode() + b"\n")
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                finally:
                    with sub_lock:
                        subscribers.discard(q)
            else:
                self.wfile.write(json.dumps({"ok": False, "error": f"unknown op {op!r}"}).encode() + b"\n")

    class Server(socketserver.ThreadingUnixStreamServer):
        daemon_threads = True

    threading.Thread(target=watch_journal, daemon=True).start()
    srv = Server(str(sock_path), Handler)
    print(f"cell daemon · socket {sock_path} · agent {aiko_bin} · journal out/firings.jsonl", file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        sock_path.unlink(missing_ok=True)
    return 0

def cmd_inspect(root: str) -> int:
    """Project one cell as a typed visual membrane — the shared contract both
    UIs read. Ports carry the render spec AND how it was decided (`renderVia`:
    explicit when the cell declared `port.render`, inferred when the engine
    derived it), adopted from @smthrs/cell-ui so a consumer never has to guess
    whether a view was authored or inferred.

    A cell with no ports fails closed rather than rendering an empty membrane."""
    sys.path.insert(0, str(_cell_root()))
    import helpers  # type: ignore
    path = pathlib.Path(root).resolve()
    data = load_cell(path)
    errs = validate_cell(data, str(path))
    if errs:
        for e in errs:
            print(f"error: {e}", file=sys.stderr)
        return 1
    meta = data.get("metadata") or {}
    spec = data.get("spec") or {}
    ports = []
    for direction in ("input", "output"):
        for name, declaration in (_port_map(data, f"{direction}s") or {}).items():
            decl = declaration if isinstance(declaration, dict) else {"schema": declaration}
            raw = decl.get("schema")
            # A port's schema is a primitive name, an inline object, or a path to
            # a schema file. Resolve the file: leaving it unresolved rendered
            # every real cell as "raw", which is a view that tells you nothing.
            primitives = {"string", "object", "array", "integer", "number", "boolean", "null"}
            if isinstance(raw, str) and raw in primitives:
                schema = {"type": raw}
            elif isinstance(raw, str):
                ref = pathlib.Path(raw)
                ref = ref if ref.is_absolute() else (path.parent / ref)
                try:
                    schema = json.loads(ref.read_text(encoding="utf-8"))
                except Exception:
                    schema = {"$ref": raw}
            else:
                schema = raw if isinstance(raw, dict) else {}
            explicit = decl.get("render")
            ports.append({
                "name": name,
                "direction": direction,
                "schema": schema,
                "render": explicit if explicit is not None else helpers.infer_render(schema),
                "renderVia": "explicit" if explicit is not None else "inferred",
                "required": decl.get("required", True) is not False,
            })
    if not ports:
        print("error: cell has no input or output ports", file=sys.stderr)
        return 1
    organelles = [{"name": o.get("name"), "cell": o.get("cell")}
                  for o in (spec.get("organelles") or []) if isinstance(o, dict)]
    wiring = [{"from": w.get("from"), "to": w.get("to")}
              for w in (spec.get("wiring") or []) if isinstance(w, dict)]
    print(json.dumps({
        "name": meta.get("name") or "Cell",
        "description": meta.get("description"),
        "cell": str(path),
        "isLeaf": "run" in spec,
        "ports": ports,
        "organelles": organelles,
        "wiring": wiring,
    }, sort_keys=True, ensure_ascii=False, indent=2))
    return 0

DRAFT_KINDS = ("python", "exec", "http")

def _draft_slug(goal: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", goal.lower()).strip("-")[:32].strip("-")
    return slug

def _draft_files(name: str, kind: str, goal: str) -> dict[str, str]:
    """Bounded catalog written ahead of time. The goal is identity (name,
    description) only — it never selects behavior, exactly the authored-gap
    bound: prose as input identity, never as decision procedure."""
    desc = goal.replace("'", "''")
    head = (
        "apiVersion: cell/v0\n"
        "kind: Cell\n"
        "metadata:\n"
        f"  name: {name}\n"
        f"  description: '{desc}'\n"
        "spec:\n"
        "  membrane:\n"
        "    inputs:\n"
        "      data: { schema: object }\n"
        "    outputs:\n"
        "      result: { schema: object }\n"
        "    caps: {}\n"
    )
    files: dict[str, str] = {}
    if kind == "python":
        files[f"{name}.cell.yaml"] = head + (
            "  policy:\n"
            "    determinism: required\n"
            "  run:\n"
            "    kind: python\n"
            f"    entry: neurons/{name}.py\n"
        )
        files[f"neurons/{name}.py"] = (
            "def run(inputs, ctx):\n"
            "    # Drafted stub — inert by design. An echo here would let a do-nothing\n"
            "    # handler pass admission; refusing keeps this un-admittable until implemented.\n"
            f"    raise NotImplementedError('implement before admission: {desc}')\n"
        )
    elif kind == "exec":
        files[f"{name}.cell.yaml"] = head + (
            "  policy:\n"
            "    determinism: required\n"
            "  run:\n"
            "    kind: exec\n"
            f"    command: [\"python3\", \"neurons/{name}.py\"]\n"
        )
        files[f"neurons/{name}.py"] = (
            "import sys\n"
            "# Drafted stub — refuses so nothing is retained on compilation alone.\n"
            f"sys.stderr.write('implement before admission: {desc}\\n')\n"
            "sys.exit(1)\n"
        )
    elif kind == "http":
        # allow_net stays empty: the boundary is denied until the author grants a host.
        files[f"{name}.cell.yaml"] = head.replace("    caps: {}\n", "    caps: { allow_net: [] }\n") + (
            "  run:\n"
            "    kind: http\n"
            "    http:\n"
            "      method: GET\n"
            "      url: https://api.example.com/v1/data\n"
        )
    else:
        raise ValueError(f"unknown draft kind {kind!r}; expected one of {DRAFT_KINDS}")
    return files

def cmd_draft(goal: str, kind: str, name: str | None, write: str | None) -> int:
    goal = (goal or "").strip()
    if not goal:
        print("error: draft requires a non-empty goal", file=sys.stderr)
        return 1
    if kind not in DRAFT_KINDS:
        print(f"error: draft kind must be one of {'|'.join(DRAFT_KINDS)}, got {kind!r}", file=sys.stderr)
        return 1
    slug = name or _draft_slug(goal)
    if not re.fullmatch(r"[a-z0-9-]{1,32}", slug or ""):
        print(f"error: derived name {slug!r} is not kebab-lower 1-32 chars; pass --name", file=sys.stderr)
        return 1
    if yaml is None:
        print("error: pyyaml required for draft self-check: pip install pyyaml", file=sys.stderr)
        return 1
    try:
        files = _draft_files(slug, kind, goal)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    # The engine refuses to propose what its own validator would reject.
    cell_yaml = files[f"{slug}.cell.yaml"]
    errs = validate_cell(yaml.safe_load(cell_yaml), f"<draft:{slug}>")
    if errs:
        for e in errs:
            print(f"error: draft failed self-validation: {e}", file=sys.stderr)
        return 1
    proposal = {
        "name": slug,
        "kind": kind,
        "goal": goal,
        "files": files,
        "proposal_digest": _digest({"files": files, "kind": kind, "name": slug}),
        "admission": (
            f"inert — admit via: python3 run.py build {slug}.cell.yaml"
            f" && python3 run.py check {slug}.cell.yaml --inputs <inputs.json>"
        ),
    }
    if write:
        base = pathlib.Path(write)
        target = base / f"{slug}.cell.yaml"
        if target.exists():
            print(f"error: refusing to clobber existing {target}", file=sys.stderr)
            return 1
        for rel, content in sorted(files.items()):
            p = base / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content, encoding="utf-8")
    print(json.dumps(proposal, sort_keys=True, ensure_ascii=False, indent=2))
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
    p_run.add_argument("--open", action="store_true", help="open the canvas on this workflow after it fires")
    p_check = sub.add_parser("check")
    p_check.add_argument("root")
    p_check.add_argument("--inputs", default=None)
    p_draft = sub.add_parser("draft")
    p_draft.add_argument("goal")
    p_draft.add_argument("--kind", default="python")
    p_draft.add_argument("--name", default=None)
    p_draft.add_argument("--write", default=None)
    p_inspect = sub.add_parser("inspect")
    p_inspect.add_argument("root")
    p_firings = sub.add_parser("firings")
    p_firings.add_argument("--limit", type=int, default=50)
    p_save = sub.add_parser("save")
    p_save.add_argument("path")
    p_remove = sub.add_parser("remove")
    p_remove.add_argument("path")
    p_daemon = sub.add_parser("daemon")
    p_daemon.add_argument("--sock", default=None)
    args = ap.parse_args()
    if args.cmd == "build":
        raise SystemExit(cmd_build(args.root))
    elif args.cmd == "run":
        raise SystemExit(cmd_run(args.root, args.inputs, args.out, args.open))
    elif args.cmd == "check":
        raise SystemExit(cmd_check(args.root, args.inputs))
    elif args.cmd == "draft":
        raise SystemExit(cmd_draft(args.goal, args.kind, args.name, args.write))
    elif args.cmd == "inspect":
        raise SystemExit(cmd_inspect(args.root))
    elif args.cmd == "firings":
        raise SystemExit(cmd_firings(args.limit))
    elif args.cmd == "save":
        raise SystemExit(cmd_save(args.path))
    elif args.cmd == "remove":
        raise SystemExit(cmd_remove(args.path))
    elif args.cmd == "daemon":
        raise SystemExit(cmd_daemon(args.sock))
    else:
        ap.print_help()
        raise SystemExit(1)
if __name__ == "__main__":
    main()
