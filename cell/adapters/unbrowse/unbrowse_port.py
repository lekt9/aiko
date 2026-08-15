#!/usr/bin/env python3
"""Fail-closed Unbrowse boundary learner for Aiko.

A capture is evidence, not admission.  ``observe`` records only a sealed digest
and structural schema.  A later ``replay`` performs a fresh origin request and
promotes only when that independent result agrees.  ``execute`` checks the
promoted structural contract and atomically demotes it when the origin drifts.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

SCHEMA = "aiko.unbrowse-boundary/v1"
class Refusal(Exception):
    pass

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()

def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()

def shape(value):
    if value is None: return {"type": "null"}
    if isinstance(value, bool): return {"type": "boolean"}
    if isinstance(value, int) and not isinstance(value, bool): return {"type": "integer"}
    if isinstance(value, float): return {"type": "number"}
    if isinstance(value, str): return {"type": "string"}
    if isinstance(value, list):
        variants = {json.dumps(shape(v), sort_keys=True, separators=(",", ":")) for v in value}
        return {"type": "array", "items": [json.loads(v) for v in sorted(variants)]}
    if isinstance(value, dict):
        return {"type": "object", "fields": {str(k): shape(value[k]) for k in sorted(value)}}
    raise Refusal("response is not JSON-shaped")

def route_shape(raw_url, sealed_values=()):
    parsed = urllib.parse.urlsplit(raw_url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise Refusal("only credential-free http(s) origin URLs are admissible")
    # Values are invocation data, not route declarations.  This prevents query
    # tokens and tenant identifiers from becoming learned artifacts.
    query_names = sorted({k for k, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)})
    sealed = {v for v in sealed_values if v}
    segments = []
    for segment in (parsed.path or "/").split("/"):
        decoded = urllib.parse.unquote(segment)
        segments.append("{credential}" if decoded in sealed else segment)
    safe_path = "/".join(segments) or "/"
    port = parsed.port
    authority = parsed.hostname if port is None else f"{parsed.hostname}:{port}"
    return {"scheme": parsed.scheme, "authority": authority, "path": safe_path, "query_holes": query_names}

def cred_handle(env_name):
    if not env_name: return None
    return "cred:" + hashlib.sha256(("unbrowse-env:" + env_name).encode()).hexdigest()[:32]

def fetch(raw_url, credential_env):
    headers = {"Accept": "application/json"}
    if credential_env:
        secret = os.environ.get(credential_env)
        if not secret:
            raise Refusal("credential environment pointer is unresolved")
        headers["Authorization"] = "Bearer " + secret
    request = urllib.request.Request(raw_url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            if response.status < 200 or response.status >= 300:
                raise Refusal(f"origin status {response.status}")
            raw = response.read(4 * 1024 * 1024 + 1)
    except urllib.error.HTTPError as exc:
        raise Refusal(f"origin status {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise Refusal("origin unavailable") from exc
    if len(raw) > 4 * 1024 * 1024:
        raise Refusal("response exceeds sealed observation limit")
    try:
        return json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise Refusal("origin response is not JSON") from exc

def state_path(directory):
    return Path(directory) / "declared-boundary.json"

def load(directory):
    path = state_path(directory)
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise Refusal("no valid observed boundary") from exc
    if value.get("schema") != SCHEMA:
        raise Refusal("boundary schema mismatch")
    return value

def write(directory, value):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    path = state_path(directory)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)

def ensure_route(boundary, raw_url, credential_env):
    sealed = (os.environ.get(credential_env, ""),) if credential_env else ()
    if route_shape(raw_url, sealed) != boundary["route"]:
        raise Refusal("invocation does not match observed route shape")
    if cred_handle(credential_env) != boundary["auth"]["credential_handle"]:
        raise Refusal("credential scope does not match observed opaque handle")

def observation(product):
    return {
        "id": str(uuid.uuid4()),
        "source": "origin_http_fetch",
        "response_digest": digest(product),
        "response_schema": shape(product),
    }

def cmd_observe(args):
    product = fetch(args.url, args.credential_env)
    first = observation(product)
    boundary = {
        "schema": SCHEMA,
        "status": "observed",
        "route": route_shape(args.url, (os.environ.get(args.credential_env, ""),) if args.credential_env else ()),
        "method": "GET",
        "auth": {"kind": "opaque_handle", "credential_handle": cred_handle(args.credential_env)},
        "observation": first,
        "replay": None,
        "promotion": None,
        "demotion": None,
        "sealing": {"raw_request_retained": False, "raw_response_retained": False, "secret_values_retained": False},
    }
    write(args.state_dir, boundary)
    print(json.dumps({"status": "observed", "observation_id": first["id"]}))

def cmd_replay(args):
    boundary = load(args.state_dir)
    if boundary["status"] != "observed":
        raise Refusal("promotion requires exactly one unpromoted observation")
    ensure_route(boundary, args.url, args.credential_env)
    product = fetch(args.url, args.credential_env)  # separate origin read
    second = observation(product)
    first = boundary["observation"]
    agrees = (second["response_digest"] == first["response_digest"] and
              second["response_schema"] == first["response_schema"] and
              second["id"] != first["id"])
    boundary["replay"] = second
    if not agrees:
        boundary["status"] = "demoted"
        boundary["demotion"] = {"reason": "independent_replay_disagreed", "at_unix_ms": int(time.time()*1000)}
        write(args.state_dir, boundary)
        raise Refusal("independent replay disagreed; route demoted")
    boundary["status"] = "promoted"
    boundary["promotion"] = {
        "basis": "observation_and_independent_replay_agreement",
        "observation_id": first["id"], "replay_id": second["id"],
        "independent": True,
    }
    write(args.state_dir, boundary)
    print(json.dumps({"status": "promoted", "independent_replay": True}))

def cmd_execute(args):
    boundary = load(args.state_dir)
    if boundary["status"] != "promoted":
        raise Refusal("route is not promoted")
    ensure_route(boundary, args.url, args.credential_env)
    product = fetch(args.url, args.credential_env)
    actual = shape(product)
    expected = boundary["observation"]["response_schema"]
    if actual != expected:
        boundary["status"] = "demoted"
        boundary["demotion"] = {
            "reason": "response_schema_drift", "expected_schema_digest": digest(expected),
            "actual_schema_digest": digest(actual), "at_unix_ms": int(time.time()*1000),
        }
        write(args.state_dir, boundary)
        raise Refusal("origin response schema drifted; route demoted")
    # Response bytes are returned to the caller but never written into route state.
    sys.stdout.buffer.write(canonical(product) + b"\n")

def cmd_inspect(args):
    print(json.dumps(load(args.state_dir), sort_keys=True, indent=2))

def parser():
    p = argparse.ArgumentParser(description="observe, independently replay, and guard one read-only web boundary")
    sub = p.add_subparsers(dest="command", required=True)
    for name, function in (("observe", cmd_observe), ("replay", cmd_replay), ("execute", cmd_execute)):
        q = sub.add_parser(name)
        q.add_argument("state_dir")
        q.add_argument("url")
        q.add_argument("--credential-env", help="environment variable resolved only at invocation")
        q.set_defaults(function=function)
    q = sub.add_parser("inspect"); q.add_argument("state_dir"); q.set_defaults(function=cmd_inspect)
    return p

def main():
    args = parser().parse_args()
    try:
        args.function(args)
    except Refusal as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
