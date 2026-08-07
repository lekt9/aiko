"""helpers.py — thin wrappers for cell leaves.

Keep this file small and agent-editable.

If a helper is missing, the agent should:
  1. grep this file,
  2. add the one function that is needed,
  3. rerun.

Do NOT pre-add abstractions the agent has not asked for.
"""

import json
import pathlib
import re

def read_input(name: str, inputs_dir: str = "inputs") -> object:
    p = pathlib.Path(inputs_dir) / f"{name}.json"
    return json.loads(p.read_text(encoding="utf-8"))

def read_inputs(inputs_dir: str = "inputs") -> dict:
    d = pathlib.Path(inputs_dir)
    if not d.exists():
        return {}
    out = {}
    for p in d.glob("*.json"):
        out[p.stem] = json.loads(p.read_text(encoding="utf-8"))
    return out

def write_output(name: str, value: object, outputs_dir: str = "outputs") -> None:
    p = pathlib.Path(outputs_dir) / f"{name}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")

def write_outputs(mapping: dict, outputs_dir: str = "outputs") -> None:
    for k, v in mapping.items():
        write_output(k, v, outputs_dir)

def validate(value: object, schema_path: str) -> None:
    if schema_path == "string":
        if not isinstance(value, str):
            raise TypeError(f"expected string, got {type(value).__name__}")
        return
    p = pathlib.Path(schema_path)
    if not p.exists():
        return
    try:
        import jsonschema  # type: ignore
    except ImportError:
        schema = json.loads(p.read_text(encoding="utf-8"))
        _minimal_validate(value, schema, schema_path)
        return
    schema = json.loads(p.read_text(encoding="utf-8"))
    jsonschema.validate(value, schema)

def _minimal_validate(value, schema, ctx="value"):
    t = schema.get("type")
    if t == "string" and not isinstance(value, str):
        raise TypeError(f"{ctx}: expected string")
    if t == "object" and not isinstance(value, dict):
        raise TypeError(f"{ctx}: expected object")
    if t == "array" and not isinstance(value, list):
        raise TypeError(f"{ctx}: expected array")
    if t == "integer" and not isinstance(value, int):
        raise TypeError(f"{ctx}: expected integer")
    for k in schema.get("required", []):
        if k not in value:
            raise ValueError(f"{ctx}: missing required '{k}'")

_env_re = re.compile(r"\{\{\s*env\.([A-Z0-9_]+)\s*\}\}")
_inputs_re = re.compile(r"\{\{\s*inputs\.([a-zA-Z0-9_\.\[\]]+)\s*\}\}")

def render_template(obj, inputs: dict, env=None):
    import os as _os
    env = env or dict(_os.environ)
    if isinstance(obj, str):
        stripped = obj.strip()
        if stripped.startswith("{{") and stripped.endswith("}}") and stripped.count("{{") == 1:
            inner = stripped[2:-2].strip()
            if inner.startswith("inputs."):
                return _get_path(inputs, inner[7:])
        def repl_env(mm):
            return env.get(mm.group(1), "")
        def repl_inputs(mm):
            v = _get_path(inputs, mm.group(1))
            return json.dumps(v) if not isinstance(v, str) else v
        s = _env_re.sub(repl_env, obj)
        s = _inputs_re.sub(repl_inputs, s)
        return s
    if isinstance(obj, dict):
        return {k: render_template(v, inputs, env) for k, v in obj.items()}
    if isinstance(obj, list):
        return [render_template(v, inputs, env) for v in obj]
    return obj

def infer_render(schema: dict) -> dict:
    """One schema -> one default json-render view. Override via port.render when present."""
    if not isinstance(schema, dict):
        return {"type": "raw", "schema": schema}
    t = schema.get("type")
    if t == "array":
        item = schema.get("items", {})
        # array of objects -> table, else list
        if isinstance(item, dict) and item.get("type") == "object":
            cols = list((item.get("properties") or {}).keys())[:8]
            return {"type": "table", "columns": [{"key": c} for c in cols] or [{"key": "value"}]}
        return {"type": "list", "item": item}
    if t == "object":
        req = schema.get("required") or list((schema.get("properties") or {}).keys())[:4]
        return {"type": "form", "fields": [{"key": k, "required": k in (schema.get("required") or [])} for k in (schema.get("properties") or {}).keys()]}
    if t in ("string","integer","number","boolean"):
        return {"type": "field", "fieldType": t}
    # fallback: form over properties if present
    if "properties" in schema:
        return {"type": "form", "fields": [{"key": k} for k in schema["properties"].keys()]}
    return {"type": "raw", "schema": schema}

def render_for_port(schema_path: str, data=None, explicit_render=None):
    """Resolve port.render: explicit > inferred from schema. Returns json-render spec."""
    if explicit_render is not None:
        # explicit_render can be path (json file) or inline object
        if isinstance(explicit_render, str) and explicit_render.endswith(".json"):
            try:
                return json.loads(pathlib.Path(explicit_render).read_text(encoding="utf-8"))
            except Exception:
                pass
        if isinstance(explicit_render, dict):
            return explicit_render
        if isinstance(explicit_render, str):
            try:
                return json.loads(explicit_render)
            except Exception:
                return {"type": "raw", "value": explicit_render}
    # infer
    if schema_path and schema_path != "string":
        p = pathlib.Path(schema_path)
        if p.exists():
            try:
                return infer_render(json.loads(p.read_text(encoding="utf-8")))
            except Exception:
                pass
    return {"type": "raw"}

def _get_path(root: dict, dotted: str):
    cur: object = root
    for part in dotted.split("."):
        if "[" in part:
            name, rest = part.split("[", 1)
            if isinstance(cur, dict):
                cur = cur[name]
            idx = int(rest.rstrip("]"))
            cur = cur[idx]  # type: ignore
        else:
            if not isinstance(cur, dict):
                raise KeyError(part)
            cur = cur[part]
    return cur

def write_cas(data, cas_root=".cell-cas"):
    import hashlib
    raw = json.dumps(data, sort_keys=True, ensure_ascii=False).encode() if not isinstance(data, (bytes, bytearray)) else bytes(data)
    key = hashlib.sha256(raw).hexdigest()
    p = pathlib.Path(cas_root) / key[:2] / key[2:4] / key
    p.parent.mkdir(parents=True, exist_ok=True)
    if not p.exists():
        p.write_bytes(raw)
        return key, False
    return key, True

def http_request(method: str, url: str, headers=None, body=None, timeout_ms: int = 10000):
    import urllib.request, urllib.error
    headers = headers or {}
    data = None
    if body is not None:
        if isinstance(body, (dict, list)):
            data = json.dumps(body).encode()
            headers.setdefault("Content-Type", "application/json")
        elif isinstance(body, str):
            data = body.encode()
        else:
            data = body
    req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=timeout_ms / 1000) as resp:
            raw = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            if "json" in ctype:
                return json.loads(raw.decode())
            try:
                return json.loads(raw.decode())
            except Exception:
                return raw.decode()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"http {method} {url} -> {e.code} {e.reason}: {e.read().decode()[:500]}") from e
