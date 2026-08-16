#!/usr/bin/env python3
"""Sealed request boundary for the admitted Unbrowse limb.

This module owns no credential store.  Aiko passes an opaque handle and a
resolver; the resolver is called only after the promoted projection and the
exact destination have been checked, immediately before the origin call.
Raw request/response bytes are invocation data and are never written here.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from urllib.parse import parse_qsl, urlsplit

EVENT_SCHEMA = "neuron.unbrowse-boundary-event/v1"
PROJECTION_SCHEMA = "contract.unbrowse-route-projection/v1"

class Refusal(Exception):
    pass

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()

def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()

def response_shape(value):
    if value is None: return {"type": "null"}
    if isinstance(value, bool): return {"type": "boolean"}
    if isinstance(value, int) and not isinstance(value, bool): return {"type": "integer"}
    if isinstance(value, float): return {"type": "number"}
    if isinstance(value, str): return {"type": "string"}
    if isinstance(value, list):
        variants = {canonical(response_shape(v)).decode() for v in value}
        return {"type": "array", "items": [json.loads(v) for v in sorted(variants)]}
    if isinstance(value, dict):
        return {"type": "object", "fields": {str(k): response_shape(value[k]) for k in sorted(value)}}
    raise Refusal("origin response is not JSON-shaped")

def route_shape(raw_url):
    parsed = urlsplit(raw_url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise Refusal("only http(s) origin routes are admissible")
    if parsed.username or parsed.password or parsed.fragment:
        raise Refusal("credentials and fragments are forbidden in route URLs")
    authority = parsed.hostname.lower()
    if parsed.port is not None:
        authority += ":" + str(parsed.port)
    # Values are invocation data.  The learned route retains names only.
    holes = sorted({name for name, _ in parse_qsl(parsed.query, keep_blank_values=True)})
    return {"scheme": parsed.scheme, "authority": authority,
            "path": parsed.path or "/", "query_holes": holes}

def route_id(route):
    return hashlib.sha256(canonical(route)).hexdigest()

def validate_handle(handle):
    if not isinstance(handle, str) or not handle.startswith("cred:") or len(handle) < 13:
        raise Refusal("an opaque scoped credential handle is required")

@dataclass(frozen=True)
class BoundaryResult:
    event: dict
    product: object | None = None

def _read(url, handle, resolver, transport):
    route = route_shape(url)
    validate_handle(handle)
    scope = {"scheme": route["scheme"], "authority": route["authority"],
             "method": "GET", "path": route["path"]}
    # Load-bearing ordering: no credential value exists before all request
    # scope checks above have succeeded.  The resolver result is passed
    # directly to the transport and is neither returned nor retained.
    secret = resolver(handle, scope)
    if not isinstance(secret, str) or not secret:
        raise Refusal("credential handle did not resolve at request boundary")
    try:
        status, body = transport(url, {"Accept": "application/json", "Authorization": "Bearer " + secret})
    finally:
        secret = None
    if not isinstance(status, int) or status < 200 or status >= 300:
        raise Refusal("origin did not return a successful response")
    if not isinstance(body, (bytes, bytearray)) or len(body) > 4 * 1024 * 1024:
        raise Refusal("origin response exceeds sealed JSON boundary")
    try:
        product = json.loads(bytes(body))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise Refusal("origin response is not JSON") from exc
    return route, product

def observe(url, credential_handle, source_firing_id, resolver, transport):
    route, product = _read(url, credential_handle, resolver, transport)
    event = {"schema": EVENT_SCHEMA, "kind": "observation", "route_id": route_id(route),
             "route": route, "method": "GET", "credential_handle": credential_handle,
             "source_firing_id": source_firing_id, "response_digest": digest(product),
             "response_schema": response_shape(product),
             "sealing": {"raw_request_retained": False, "raw_response_retained": False,
                         "secret_values_retained": False}}
    # The observation path returns evidence only.  Browsing already owns its
    # page result; returning it here would invite callers to persist a capture.
    return BoundaryResult(event=event)

def replay(url, credential_handle, source_firing_id, resolver, transport):
    route, product = _read(url, credential_handle, resolver, transport)
    event = {"schema": EVENT_SCHEMA, "kind": "replay", "route_id": route_id(route),
             "route": route, "method": "GET", "credential_handle": credential_handle,
             "source_firing_id": source_firing_id, "response_digest": digest(product),
             "response_schema": response_shape(product),
             "sealing": {"raw_request_retained": False, "raw_response_retained": False,
                         "secret_values_retained": False}}
    return BoundaryResult(event=event)

def execute(projection, url, credential_handle, source_firing_id, resolver, transport):
    if not isinstance(projection, dict) or projection.get("schema") != PROJECTION_SCHEMA:
        raise Refusal("valid Contract route projection required")
    if projection.get("status") != "promoted":
        raise Refusal("Contract projection does not permit serving this route")
    route = route_shape(url)
    if route_id(route) != projection.get("route_id") or route != projection.get("route"):
        raise Refusal("request differs from promoted route")
    if credential_handle != projection.get("credential_handle"):
        raise Refusal("credential handle differs from promoted scope")
    _, product = _read(url, credential_handle, resolver, transport)
    actual = response_shape(product)
    if actual != projection.get("response_schema"):
        event = {"schema": EVENT_SCHEMA, "kind": "drift", "route_id": route_id(route),
                 "route": route, "method": "GET", "credential_handle": credential_handle,
                 "source_firing_id": source_firing_id,
                 "expected_schema_digest": digest(projection.get("response_schema")),
                 "actual_schema_digest": digest(actual),
                 "sealing": {"raw_request_retained": False, "raw_response_retained": False,
                             "secret_values_retained": False}}
        # Never serve the bytes that proved the route stale.  The event must be
        # projected durably before a later call may reconsider the route.
        return BoundaryResult(event=event)
    return BoundaryResult(event=None, product=product)
