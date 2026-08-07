#!/usr/bin/env python3
import pathlib, json, sys
sys.path.insert(0, str(pathlib.Path(__file__).parents[3]))
import helpers
def run(inputs, ctx):
    schema = inputs.get("schema") or {}
    data = inputs.get("data")
    explicit = inputs.get("render")
    # If schema is a path string (rare when wired), load it
    if isinstance(schema, str) and schema.endswith(".json"):
        try:
            schema = json.loads(pathlib.Path(schema).read_text(encoding="utf-8"))
        except Exception:
            schema = {"type": "object"}
    view = helpers.render_for_port(schema_path="", data=data, explicit_render=explicit) if explicit is not None else helpers.infer_render(schema if isinstance(schema, dict) else {})
    # Attach data for the viewer
    view = {**view, "data": data}
    return {"view": view}
