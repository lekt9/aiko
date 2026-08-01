#!/usr/bin/env python3
"""port-drafter Neuron — derives an inert `neuron.published-interface/v1`
document for a publication gap the reuse search failed to close.

This is the inbound counterpart to `src/morphogenesis.zig` step 3, "derive an
explicit interface schema as an inert artifact". "Generate" means the same
thing in both directions: assemble a complete, typed contract out of state the
node already holds — never synthesize code, and never invent a schema from a
name. The handler is *resolved out of the admitted-limb census*, not named by
the gap, so a port cannot be drafted for an implementation the node has not
already admitted by digest.

Nothing here holds authority. The write is an ordinary artifact under this
limb's grant; publishing it is `neuron port publish`, attaching it is `neuron
port attach`, and both remain kernel verbs. A drafted document that is never
published serves nothing, which is the property that makes drafting safe to do
from an admitted limb at all.

Two refusals are structural rather than advisory:

  1. **Reuse before generation.** The plan artifact is a required read and must
     say `generate`. There is no branch that drafts without one, so a caller
     cannot skip the search by simply not running it.
  2. **A contract never names its own authority.** `requested_caps` is derived
     from the invocation mode alone and carries no prefixes. The kernel refuses
     a published manifest that names its own write target; refusing it here too
     means the gap author never gets to believe they chose it.
"""

import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "shared"))
from _neuron import Reject, artifact_ref, cas_write, decision, run

GAP_SCHEMA = "neuron.publication-gap/v1"
PLAN_SCHEMA = "neuron.publication-plan/v1"
LIMB_CENSUS_SCHEMA = "neuron.limb-census/v1"
PUBLISHED_SCHEMA = "neuron.published-interface/v1"
DRAFT_RECORD_SCHEMA = "neuron.publication-draft-record/v1"

DRAFT_PREFIX = "publication-morphogenesis/drafts/"
RECORD_PREFIX = "publication-morphogenesis/draft-records/"

# Fields that only mean something for an *outbound* boundary. Kept byte-identical
# to serve.zig FORBIDDEN_FIELDS: a gap that smuggles one in is refused here
# rather than silently dropped, because an operator who believes an
# `implementation_digest` is pinned when nothing checks it has been lied to.
FORBIDDEN_FIELDS = (
    "locator", "implementation_digest", "argv_template", "target_template",
    "input_channel", "url_template", "response_encoding", "response_field",
    "non_mutating", "reconcile_url_template", "reconcile_encoding",
    "reconcile_field", "idempotency_header", "tool", "provider", "model_name",
    "protocol", "cost_micros", "device_role", "device_state_template",
    "human_interaction", "approval_interface", "payment_adapter",
    "payment_approval_interface", "payment_response_field",
)

# A safe method must never carry consequence: a command reachable by GET or HEAD
# is a mutation any prefetcher or link preview can trigger without a caller ever
# deciding to (serve.zig makes the same refusal).
SAFE_METHODS = ("GET", "HEAD")
KNOWN_METHODS = ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE")

# Local ceilings. The kernel has its own (PORT_CAPS_CEILING) and will refuse
# anything above it; drafting below it means a gap author cannot author a
# document that only fails at `port publish`.
MAX_REQUEST_BYTES = 262144
MAX_OUTPUT_BYTES = 262144
MAX_TIMEOUT_MS = 60000
MAX_CONCURRENT = 64


def slug(gap_id):
    """Same hash as reuse_searcher.slug — a gap id containing a `/` must not be
    able to escape the write prefix this neuron's grant pins it to."""
    return hashlib.sha256(gap_id.encode()).hexdigest()[:32]


def validate_route(path):
    """A served path is a literal route. Everything a caller may vary travels in
    the body, where a schema governs it — a `{param}` segment would be an input
    channel with no schema at all. Mirrors serve.zig validateServedPath."""
    if not isinstance(path, str) or not path or len(path) > 512:
        raise Reject("validation", "publication gap route is empty or oversized")
    if not path.startswith("/"):
        raise Reject("validation", f"route must be absolute: {path}")
    if len(path) > 1 and path.endswith("/"):
        raise Reject("validation", f"route must not end in a slash: {path}")
    if "//" in path or ".." in path:
        raise Reject("validation", f"route traverses: {path}")
    if "{" in path or "}" in path:
        raise Reject("validation", f"route carries an un-schema'd parameter: {path}")
    if "?" in path or "#" in path:
        raise Reject("validation", f"route carries a query or fragment: {path}")
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in path):
        raise Reject("validation", "route carries control bytes")
    # `/agents/<agent>` is the namespace the harness owns; a published path
    # starting with it could shadow another agent's mount point.
    if path.startswith("/agents/"):
        raise Reject("validation", f"route would shadow the harness mount point: {path}")


def resolve_handler(census, gap):
    """Find the admitted limb whose declared neuron surface covers the gap.

    The gap does not get to name a handler digest. A digest supplied by the gap
    author would be an unchecked claim; resolving it out of the node's own
    admitted-limb records means the draft can only ever point at bytes this node
    already admitted. Ambiguity is not broken by preference — the lowest digest
    wins deterministically, and every candidate is recorded.
    """
    limbs = census.get("limbs")
    if not isinstance(limbs, list):
        raise Reject("validation", "limb census carries no limbs list")

    candidates = []
    for limb in limbs:
        digest = limb.get("digest", "")
        if not isinstance(digest, str) or len(digest) != 64:
            continue
        if limb.get("revoked"):
            continue
        for neuron in limb.get("neurons", []):
            accepts = neuron.get("accepts", [])
            emits = neuron.get("emits", [])
            if not isinstance(accepts, list) or not isinstance(emits, list):
                continue
            if any(s not in accepts for s in gap["accepts"]):
                continue
            if any(s not in emits for s in gap["emits"]):
                continue
            neuron_id = neuron.get("id", "")
            if not isinstance(neuron_id, str) or not neuron_id:
                continue
            candidates.append((digest, neuron_id, limb.get("package", "")))

    if not candidates:
        raise Reject(
            "dependency",
            f"no admitted limb declares {gap['accepts']} -> {gap['emits']}; "
            "a port must not be drafted for a handler this node has not admitted",
        )
    candidates.sort()
    return candidates[0], candidates


def bounded_int(value, default, ceiling, label):
    if value is None:
        return default
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise Reject("validation", f"{label} must be a positive integer")
    if value > ceiling:
        raise Reject("validation", f"{label} exceeds the drafting ceiling ({ceiling})")
    return value


def fire(stim):
    _, gap = artifact_ref(stim, GAP_SCHEMA)
    _, plan = artifact_ref(stim, PLAN_SCHEMA)
    _, census = artifact_ref(stim, LIMB_CENSUS_SCHEMA)

    for field in ("id", "version", "need", "route", "expect_contains"):
        if not isinstance(gap.get(field), str) or not gap[field]:
            raise Reject("validation", f"publication gap missing {field}")
    for field in ("accepts", "emits", "errors"):
        values = gap.get(field)
        if not isinstance(values, list) or not values or not all(
            isinstance(v, str) and v for v in values
        ):
            raise Reject("validation", f"publication gap has no {field} schemas")

    # Refusal 1, enforced at this neuron's own boundary: the search must have
    # run and must have failed. A plan for some *other* gap does not authorize
    # this one, so the binding is checked rather than assumed.
    if plan.get("gap") != gap["id"]:
        raise Reject(
            "invariant_violation",
            f"plan is for gap {plan.get('gap')!r}, not {gap['id']!r}",
        )
    if plan.get("route") != "generate":
        raise Reject(
            "invariant_violation",
            f"reuse search resolved to {plan.get('route')!r}: port "
            f"{plan.get('reuse_published', '')[:16]} already serves this contract, so "
            "generating a second one is refused",
        )

    for field in FORBIDDEN_FIELDS:
        if field in gap:
            raise Reject(
                "validation",
                f"'{field}' describes an outbound boundary and means nothing on a "
                "published interface; refused rather than dropped",
            )
    if "requested_caps" in gap or "handler_digest" in gap:
        raise Reject(
            "capability_denied",
            "a publication gap may not name its own authority or its own handler "
            "digest: both are derived, from the invocation mode and from the "
            "node's admitted-limb census",
        )

    validate_route(gap["route"])

    mode = gap.get("mode", "read")
    if mode not in ("read", "command"):
        raise Reject("validation", f"unknown invocation mode {mode!r}")

    method = gap.get("method", "POST")
    if method not in KNOWN_METHODS:
        raise Reject("validation", f"unknown method {method!r}")
    if mode == "command" and method in SAFE_METHODS:
        raise Reject(
            "invariant_violation",
            f"a command bound to the safe method {method} would be a mutation any "
            "prefetcher could trigger",
        )

    receptor = gap.get("receptor_schema", gap["accepts"][0])
    # The schema a request is admitted as must be one this port declared it
    # accepts, or the port is an execute-anything capability wearing a contract.
    if receptor not in gap["accepts"]:
        raise Reject("validation", f"receptor schema {receptor!r} is outside accepts")

    idempotency = gap.get("idempotency", "keyed")
    if idempotency not in ("none", "keyed", "natural"):
        raise Reject("validation", f"unknown idempotency {idempotency!r}")
    firing_id_source = gap.get("firing_id_source", "content")
    if firing_id_source not in ("content", "caller_supplied"):
        raise Reject("validation", f"unknown firing_id_source {firing_id_source!r}")
    # A caller key may only take part in a firing identity where an idempotency
    # discipline gives it meaning; without one a peer would be choosing
    # identities in this node's WAL namespace for free.
    if firing_id_source == "caller_supplied" and idempotency == "none":
        raise Reject(
            "invariant_violation",
            "caller_supplied firing identity requires an idempotency discipline",
        )

    callers = gap.get("callers")
    if not isinstance(callers, list) or not callers or not all(
        isinstance(p, str) and p for p in callers
    ):
        raise Reject(
            "capability_denied",
            "a publication gap must list the peers admitted to call the port; an "
            "unlisted inbound surface is deny-all and would serve nothing anyway",
        )

    (handler_digest, handler_neuron, handler_package), candidates = resolve_handler(census, gap)

    max_request_bytes = bounded_int(
        gap.get("max_request_bytes"), 65536, MAX_REQUEST_BYTES, "max_request_bytes")
    max_output_bytes = bounded_int(
        gap.get("max_output_bytes"), 65536, MAX_OUTPUT_BYTES, "max_output_bytes")
    timeout_ms = bounded_int(gap.get("timeout_ms"), 10000, MAX_TIMEOUT_MS, "timeout_ms")
    max_concurrent = bounded_int(gap.get("max_concurrent"), 1, MAX_CONCURRENT, "max_concurrent")

    bind = {"path": gap["route"], "method": method}
    if mode == "command":
        # A command must expose an independent read-back, or it cannot be
        # consumed as a command at all: without a sensor there is nothing that
        # could ever settle it.
        reconcile = gap.get("reconcile_route")
        if not isinstance(reconcile, str) or not reconcile:
            raise Reject(
                "invariant_violation",
                "a served command must publish a reconcile route; a consequence "
                "with no read-back can never be settled",
            )
        validate_route(reconcile)
        bind["reconcile_path"] = reconcile

    # Authority derived from the contract and nothing else. No write_prefix and
    # no send_prefix appear: the kernel computes both from (agent, published
    # digest) at attach time, and a document that named them would be claiming
    # a namespace it is not entitled to choose.
    requested_caps = {
        "allow_write": True,
        # Sending is the whole consequence of a served command, and a read must
        # not be able to send at all.
        "allow_send": mode == "command",
        "allow_spawn": False,
        "budget": {
            "max_effects": 4,
            "max_writes": 2,
            "max_messages": 2 if mode == "command" else 0,
            "max_spawns": 0,
            "max_bytes": max_request_bytes,
            "max_depth": 1,
            "max_turns": 1,
        },
    }

    document = {
        "schema": PUBLISHED_SCHEMA,
        "id": gap["id"],
        "version": gap["version"],
        "transport": "http",
        "bind": bind,
        "handler_digest": handler_digest,
        "handler_neuron": handler_neuron,
        "receptor_schema": receptor,
        "firing_id_source": firing_id_source,
        "max_request_bytes": max_request_bytes,
        "max_concurrent": max_concurrent,
        "callers": {"mode": "listed", "peers": callers},
        "accepts": gap["accepts"],
        "emits": gap["emits"],
        "errors": gap["errors"],
        "invocation": {
            "mode": mode,
            "deterministic": bool(gap.get("deterministic", mode == "read")),
            "idempotency": idempotency,
            "timeout_ms": timeout_ms,
            "max_output_bytes": max_output_bytes,
        },
        "data_flow": {
            "input_classes": gap.get("input_classes", ["public"]),
            "output_classes": gap.get("output_classes", ["public"]),
        },
        "requested_caps": requested_caps,
        "evidence_claim": gap["need"],
        "evidence_method": (
            f"handler limb {handler_digest[:16]} neuron {handler_neuron} fired under a "
            "grant derived from this contract alone"
        ),
        "settlement": (
            "settled by the outbox dispatcher, not by this response"
            if mode == "command"
            else "response returned once the firing committed"
        ),
    }
    document_bytes = json.dumps(document, sort_keys=True, separators=(",", ":"))

    record = {
        "schema": DRAFT_RECORD_SCHEMA,
        "gap": gap["id"],
        "plan_route": "generate",
        "draft_artifact": DRAFT_PREFIX + slug(gap["id"]),
        "handler_digest": handler_digest,
        "handler_neuron": handler_neuron,
        "handler_package": handler_package,
        "handler_candidates": [
            {"digest": d, "neuron": n, "package": p} for d, n, p in candidates
        ],
        "mode": mode,
        "route": gap["route"],
        "expect_contains": gap["expect_contains"],
        # Said plainly so nothing downstream can mistake this for a live edge.
        "authority": "none: this document is inert until `neuron port publish` "
                     "admits it and `neuron port attach` binds it",
    }

    evidence = [{
        "claim": (
            f"drafted a published interface for gap {gap['id']} bound to admitted handler "
            f"{handler_digest[:16]}/{handler_neuron}"
        ),
        "sources": ["stimulus"],
        "method": "handler resolved from the node's admitted-limb census; caps derived "
                  "from the invocation mode; nothing published or attached",
        "confidence_milli": 1000,
    }]
    effects = [
        cas_write(stim, DRAFT_PREFIX + slug(gap["id"]), PUBLISHED_SCHEMA, document_bytes),
        cas_write(stim, RECORD_PREFIX + slug(gap["id"]), DRAFT_RECORD_SCHEMA,
                  json.dumps(record, sort_keys=True, separators=(",", ":"))),
    ]
    return decision({"kind": "terminate", "result": "drafted"}, effects, evidence, stim)


if __name__ == "__main__":
    sys.exit(run(fire))
