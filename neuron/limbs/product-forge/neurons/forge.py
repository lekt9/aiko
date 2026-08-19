#!/usr/bin/env python3
"""product-forge Neuron — business requirements -> PRD + IA + tokens + CRUD.

Bounded, gap-blind, deterministic. The classifier never reads expect_contains;
it folds the brief only. Same brief bytes -> same four artifacts, byte-for-byte.
On the recompute path: determinism is the termination proof.

Archetypes are lexical keyword subscriptions over the brief, not an LLM.
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "shared"))
from _neuron import Reject, artifact_ref, decision, run

REQUEST_SCHEMA = "product-forge.request/v1"
PRD_SCHEMA = "product-forge.prd/v1"
IA_SCHEMA = "product-forge.ia/v1"
TOKENS_SCHEMA = "product-forge.design-tokens/v1"
CRUD_SCHEMA = "product-forge.crud-spec/v1"

# Bounded catalogue — none of these reads any gap or probe acceptance.
# Keywords are lower-cased; brief is lower-cased before matching.
ARCHETYPES = {
    "booking": {
        "keywords": ["book", "booking", "appointment", "schedule", "slot", "calendar", "reservation", "repair", "service"],
        "entities": ["Booking", "Customer", "Resource"],
        "routes": ["/bookings", "/customers", "/resources"],
        "palette": {"primary": "#0F4C5C", "accent": "#E36414", "bg": "#FBF8F3", "surface": "#FFFFFF", "muted": "#5F6368", "success": "#2A7F62"},
        "type_display": "Instrument Sans",
        "type_body": "Inter",
    },
    "crm": {
        "keywords": ["customer", "client", "lead", "pipeline", "deal", "contact", "crm", "history", "roster"],
        "entities": ["Contact", "Deal", "Activity"],
        "routes": ["/contacts", "/deals", "/activities"],
        "palette": {"primary": "#1A1A2E", "accent": "#4361EE", "bg": "#F8F9FA", "surface": "#FFFFFF", "muted": "#6C757D", "success": "#06D6A0"},
        "type_display": "Space Grotesk",
        "type_body": "IBM Plex Sans",
    },
    "inventory": {
        "keywords": ["inventory", "stock", "warehouse", "sku", "parts", "catalog", "catalogue", "bikes", "product"],
        "entities": ["Item", "Category", "Movement"],
        "routes": ["/items", "/categories", "/movements"],
        "palette": {"primary": "#2B2D42", "accent": "#D90429", "bg": "#EDF2F4", "surface": "#FFFFFF", "muted": "#8D99AE", "success": "#06D6A0"},
        "type_display": "General Sans",
        "type_body": "Inter",
    },
}

DEFAULT = {
    "archetype": "booking",
    "entities": ["Record", "Owner", "Event"],
    "routes": ["/records", "/owners", "/events"],
    "palette": {"primary": "#0F4C5C", "accent": "#E36414", "bg": "#FBF8F3", "surface": "#FFFFFF", "muted": "#5F6368", "success": "#2A7F62"},
    "type_display": "Instrument Sans",
    "type_body": "Inter",
}

SAFE_SLUG_RE = re.compile(r"[^a-z0-9-]+")

def classify(brief_lower: str) -> str:
    scores = {}
    for name, arch in ARCHETYPES.items():
        scores[name] = sum(1 for kw in arch["keywords"] if kw in brief_lower)
    best = max(scores, key=lambda k: scores[k])
    if scores[best] == 0:
        return DEFAULT["archetype"]
    return best

def slugify(project: str) -> str:
    s = project.strip().lower().replace(" ", "-")
    s = SAFE_SLUG_RE.sub("", s)
    s = re.sub(r"-{2,}", "-", s).strip("-")
    return s or "project"

def forge_body(brief: str, project: str, archetype_name: str):
    arch = ARCHETYPES.get(archetype_name, DEFAULT)
    entities = arch.get("entities", DEFAULT["entities"])
    routes = arch.get("routes", DEFAULT["routes"])
    palette = arch.get("palette", DEFAULT["palette"])
    type_display = arch.get("type_display", DEFAULT["type_display"])
    type_body = arch.get("type_body", DEFAULT["type_body"])

    prd = {
        "schema": PRD_SCHEMA,
        "project": project,
        "archetype": archetype_name,
        "problem": brief.strip(),
        "goals": [
            "Turn business requirements into a usable product without a product or UX spec.",
            f"Archetype {archetype_name}: " + ", ".join(entities) + ".",
        ],
        "functional": [
            {"id": "F1", "title": f"Create/list {entities[0]}", "route": routes[0]},
            {"id": "F2", "title": f"Create/list {entities[1]}", "route": routes[1]},
            {"id": "F3", "title": f"Track {entities[2]}", "route": routes[2]},
        ],
        "acceptance": [
            f"CRUD for {entities[0]} is browser-clickable and gated.",
            f"Design tokens render the {archetype_name} palette without AI defaults.",
        ],
    }
    ia = {
        "schema": IA_SCHEMA,
        "project": project,
        "archetype": archetype_name,
        "nav": [{"label": e, "route": r} for e, r in zip(entities, routes)],
        "primary_surface": routes[0],
        "auth": {"route": "/login", "required": True},
    }
    tokens = {
        "schema": TOKENS_SCHEMA,
        "project": project,
        "archetype": archetype_name,
        "palette": palette,
        "type": {"display": type_display, "body": type_body},
        "radii": {"card": 16, "control": 10},
        "signature": f"{archetype_name} — {type_display} + {palette['accent']}",
    }
    crud = {
        "schema": CRUD_SCHEMA,
        "project": project,
        "archetype": archetype_name,
        "entities": [
            {"name": e, "route": r, "fields": ["id", "name", "status", "created_at"]}
            for e, r in zip(entities, routes)
        ],
    }
    return prd, ia, tokens, crud

def fire(stim):
    if stim.get("receptor_schema") != REQUEST_SCHEMA:
        raise Reject("validation", f"forge expects {REQUEST_SCHEMA}, got {stim.get('receptor_schema')}")
    ref, req = artifact_ref(stim, REQUEST_SCHEMA)
    brief = req.get("brief")
    project_raw = req.get("project", "project")
    if not isinstance(brief, str) or len(brief.strip()) < 10:
        raise Reject("validation", "brief must be a string of at least 10 characters")
    if not isinstance(project_raw, str) or not project_raw.strip():
        raise Reject("validation", "project must be a non-empty string")
    project = slugify(project_raw)
    archetype_name = classify(brief.lower())
    prd, ia, tokens, crud = forge_body(brief, project, archetype_name)

    base = f"artifact/product-forge/{project}"
    effects = [
        {"kind": "write", "artifact": {"id": f"{base}/prd", "schema": PRD_SCHEMA, "bytes": json.dumps(prd, sort_keys=True)}},
        {"kind": "write", "artifact": {"id": f"{base}/ia", "schema": IA_SCHEMA, "bytes": json.dumps(ia, sort_keys=True)}},
        {"kind": "write", "artifact": {"id": f"{base}/tokens", "schema": TOKENS_SCHEMA, "bytes": json.dumps(tokens, sort_keys=True)}},
        {"kind": "write", "artifact": {"id": f"{base}/crud", "schema": CRUD_SCHEMA, "bytes": json.dumps(crud, sort_keys=True)}},
    ]
    return decision(
        control={"kind": "terminate", "result": f"forged:{project}:{archetype_name}:4"},
        effects=effects,
        evidence=[{"claim": f"forged {project} as {archetype_name}: prd, ia, tokens, crud from brief", "sources": [ref["id"]], "method": "product-forge-classify"}],
        stim=stim,
    )

if __name__ == "__main__":
    sys.exit(run(fire))
