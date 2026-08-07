#!/usr/bin/env python3
import re
SPEC_VERSION = "cell/v0"
def validate_cell(data, path="<root>"):
    errs = []
    if data.get("apiVersion") != SPEC_VERSION:
        errs.append(f"{path}: apiVersion must be {SPEC_VERSION!r}")
    if data.get("kind") != "Cell":
        errs.append(f"{path}: kind must be 'Cell'")
    meta = data.get("metadata") or {}
    name = meta.get("name","")
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
            kind = run.get("kind","exec")
            if kind not in ("exec","python","http"):
                errs.append(f"{path}: run.kind must be exec|python|http, got {kind!r}")
            if kind=="exec" and "command" not in run:
                errs.append(f"{path}: run.kind=exec requires command")
            if kind=="python" and "entry" not in run and "code" not in run:
                errs.append(f"{path}: run.kind=python requires entry or code")
            if kind=="http" and "http" not in run:
                errs.append(f"{path}: run.kind=http requires http")
    if has_orgs:
        orgs = spec["organelles"]
        wiring = spec.get("wiring", [])
        if not isinstance(orgs, list) or not orgs:
            errs.append(f"{path}: organelles must be non-empty list")
        else:
            names=[o.get("name","") for o in orgs if isinstance(o,dict)]
            if len(names)!=len(set(names)):
                errs.append(f"{path}: organelle names must be unique")
        if not isinstance(wiring, list) or not wiring:
            errs.append(f"{path}: wiring required for composite")
        else:
            for i,wm in enumerate(wiring):
                if not isinstance(wm,dict) or "from" not in wm or "to" not in wm:
                    errs.append(f"{path}: wiring[{i}] requires from/to")
    return errs
def run(inputs, ctx):
    data = inputs.get("data")
    if data is None:
        raise ValueError("validate: missing inputs.data")
    path = data.get("_source_path","<root>")
    errs = validate_cell(data, path)
    if errs:
        raise ValueError("\n".join(errs))
    return {"data": data}
