#!/usr/bin/env python3
"""reuse-searcher Neuron — refusal 1, inbound: reuse is searched before generation.

`src/morphogenesis.zig` searches the admitted *outbound* interfaces before it
derives an adapter, because generating a boundary for a capability the node
already holds is a defect rather than an optimization. The inbound direction has
the same defect available to it and it is worse: a second published interface
over the same contract is a second live route, a second grant, and a second
thing an operator must remember to revoke. So the search runs first here too.

This neuron never publishes and never attaches — both are kernel verbs
(`neuron port publish|attach`). It writes one inert `neuron.publication-plan/v1`
artifact saying *which* of the two routes the operator's next kernel call is
allowed to take, and `port-drafter` refuses to draft unless that artifact says
`generate`. The refusal is therefore structural: the only way to reach a draft
is through a search that failed to find a reusable port.

Candidates are ranked by accumulated *verified* successes, read from
`neuron.publication-pattern/v1` records. Only `publication-judge` writes those,
and only after a real over-the-listener probe, so the ranking here cannot be
trained by a port that never served anything (refusal 3, consumed).
"""

import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "shared"))
from _neuron import Reject, artifact_ref, artifact_refs, cas_write, decision, run

GAP_SCHEMA = "neuron.publication-gap/v1"
PORT_CENSUS_SCHEMA = "neuron.port-census/v1"
PLAN_SCHEMA = "neuron.publication-plan/v1"
PATTERN_SCHEMA = "neuron.publication-pattern/v1"

PLAN_PREFIX = "publication-morphogenesis/plans/"


def slug(gap_id):
    """Stable, path-safe identity for a gap's durable records.

    Mirrors morphogenesis.zig CapabilityGap.slug: the gap id is hashed rather
    than embedded, so a gap id containing a `/` cannot escape the write prefix
    the grant pins this neuron to.
    """
    return hashlib.sha256(gap_id.encode()).hexdigest()[:32]


def require_contract(gap):
    """A gap with no declared typed surface is not searchable and not
    publishable — the same refusal `UntypedPublishedInterface` makes in the
    kernel, made one step earlier so nothing is drafted from it."""
    for field in ("id", "need", "route"):
        if not isinstance(gap.get(field), str) or not gap[field]:
            raise Reject("validation", f"publication gap missing {field}")
    for field in ("accepts", "emits", "errors"):
        values = gap.get(field)
        if not isinstance(values, list) or not values or not all(
            isinstance(v, str) and v for v in values
        ):
            raise Reject("validation", f"publication gap has no {field} schemas")
    # An acceptance-free gap is unfalsifiable: any port returning bytes would
    # "serve" it. Refuse it rather than resolve it meaninglessly.
    if not isinstance(gap.get("expect_contains"), str) or not gap["expect_contains"]:
        raise Reject("validation", "publication gap declares no expect_contains acceptance")


def serves(gap, port):
    """Does this live port already serve the gap's contract?

    Compatibility is decided on the port's own declared typed surface, never on
    its id or its path — a gap asks for a capability, not for a URL. Requiring
    the paths to match would make the refusal vacuous, because a second port at
    a second path is exactly the duplicate this search exists to prevent.
    """
    if port.get("revoked"):
        return False, "revoked"
    # A published record is not an edge. An admitted-but-unattached port serves
    # nothing, so reusing it would leave the gap open.
    if not port.get("live"):
        return False, "published but not attached"
    if port.get("mode", "read") != gap.get("mode", "read"):
        return False, "invocation mode differs"
    for schema in gap["accepts"]:
        if schema not in port.get("accepts", []):
            return False, f"does not accept {schema}"
    for schema in gap["emits"]:
        if schema not in port.get("emits", []):
            return False, f"does not emit {schema}"
    return True, ""


def verified_successes(patterns, gap_id, published):
    """Accumulated verified successes for exactly this (gap, interface) pair.

    A pattern belongs to one interface. A different port starts its own record
    rather than inheriting a ranking it never earned — the same guard
    morphogenesis.zig patternSuccesses makes.
    """
    best = 0
    for _, record in patterns:
        if record.get("gap") != gap_id:
            continue
        if record.get("interface") != published:
            continue
        count = record.get("verified_successes")
        if isinstance(count, int) and count > best:
            best = count
    return best


def fire(stim):
    _, gap = artifact_ref(stim, GAP_SCHEMA)
    require_contract(gap)
    _, census = artifact_ref(stim, PORT_CENSUS_SCHEMA)
    patterns = artifact_refs(stim, PATTERN_SCHEMA)

    ports = census.get("ports")
    if not isinstance(ports, list):
        raise Reject("validation", "port census carries no ports list")

    chosen = None
    chosen_rank = -1
    rejected = []
    for port in ports:
        published = port.get("published", "")
        if not isinstance(published, str) or len(published) != 64:
            rejected.append({"published": str(published)[:64], "reason": "not a published digest"})
            continue
        ok, reason = serves(gap, port)
        if not ok:
            rejected.append({"published": published, "reason": reason})
            continue
        rank = verified_successes(patterns, gap["id"], published)
        if rank > chosen_rank:
            chosen, chosen_rank = port, rank

    if chosen is not None:
        route = "reuse"
        detail = (
            f"port {chosen['published'][:16]} at {chosen.get('path', '?')} already serves this "
            f"contract with {chosen_rank} verified success(es); a second port would be a second "
            "live route over the same capability"
        )
    else:
        route = "generate"
        detail = (
            f"no live admitted port serves this contract ({len(ports)} considered); "
            "generation is authorized"
        )

    plan = {
        "schema": PLAN_SCHEMA,
        "gap": gap["id"],
        "need": gap["need"],
        "route": route,
        "reuse_published": chosen["published"] if chosen else "",
        "reuse_route": chosen.get("path", "") if chosen else "",
        "reuse_verified_successes": chosen_rank if chosen else 0,
        "candidates_considered": len(ports),
        "rejected": rejected,
        "detail": detail,
    }

    evidence = [{
        "claim": f"reuse search over {len(ports)} admitted port(s) for gap {gap['id']} resolved to {route}",
        "sources": ["stimulus"],
        "method": "typed-surface compatibility against the node's own port census, "
                  "ranked by verified-success patterns",
        "confidence_milli": 1000,
    }]
    effects = [cas_write(
        stim,
        PLAN_PREFIX + slug(gap["id"]),
        PLAN_SCHEMA,
        json.dumps(plan, sort_keys=True, separators=(",", ":")),
    )]
    return decision({"kind": "terminate", "result": route}, effects, evidence, stim)


if __name__ == "__main__":
    sys.exit(run(fire))
