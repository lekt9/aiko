#!/usr/bin/env python3
"""publication-judge Neuron — refusals 2 and 3, inbound.

`src/morphogenesis.zig` retires a generated adapter that admits and attaches but
does not satisfy the gap on the real path, and records a PatternRecord only
*after* the real-path retry succeeded. Both refusals invert cleanly:

  2. **Nothing is retained on compilation alone.** A published interface that
     publishes and attaches but does not actually serve the gap is judged
     `retire`, and the verdict carries the exact kernel calls (`port detach`,
     `port revoke`) that withdraw it. Publishing is not success; attaching is
     not success; a 200 with the wrong answer is not success.
  3. **Rankings are learned only from verified results.** A
     `neuron.publication-pattern/v1` record is written on the verified branch
     and nowhere else, so `reuse-searcher`'s ranking cannot be trained by a port
     that never served anything.

And one refusal this direction needs that the outbound one does not:

  **The probe must have crossed the listener.** Outbound, "the real path" is
  `membrane.invokeRead`, which is the same call the agent would make. Inbound,
  the real path is a TCP socket, an HTTP request line, a route table, a caller
  check, a body decode, and a firing — and *none* of that runs when a probe
  fires the handler limb directly. An in-process probe proves the limb works. It
  says nothing about whether the port works, which is the entire claim being
  judged. So a probe that does not attest an off-process listener is refused
  outright, with no artifact written at all: a verdict grounded in the wrong
  observation is worse than no verdict, because it would be retained.
"""

import hashlib
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "shared"))
from _neuron import Reject, artifact_ref, artifact_refs, cas_write, decision, run

GAP_SCHEMA = "neuron.publication-gap/v1"
PROBE_SCHEMA = "neuron.publication-probe/v1"
VERDICT_SCHEMA = "neuron.publication-verdict/v1"
PATTERN_SCHEMA = "neuron.publication-pattern/v1"

VERDICT_PREFIX = "publication-morphogenesis/verdicts/"
PATTERN_PREFIX = "publication-morphogenesis/patterns/"

# The one transport that constitutes evidence about a *port*. Named as a literal
# rather than inferred, so widening it is a visible edit to this line.
LISTENER_TRANSPORT = "http-listener"

# host:port, where host is a dotted quad or a bracketed v6 literal. A probe that
# cannot name the socket it crossed did not cross one.
LISTENER_RE = re.compile(r"^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9A-Fa-f:]+\]):\d{1,5}$")

# The statuses the served read path sets on a firing that actually ran or was
# replayed. Anything else is the port declining, not the port serving.
SERVED_STATUSES = ("served", "replayed")


def slug(gap_id):
    """Same hash as the other two neurons: a gap id containing a `/` must not
    escape the write prefix this neuron's grant pins it to."""
    return hashlib.sha256(gap_id.encode()).hexdigest()[:32]


def require_listener(gap, probe):
    """Refuse anything that is not an attested off-process HTTP observation.

    Every check here is about *provenance of the observation*, not about whether
    the answer was right. Getting this wrong is the failure mode that would make
    the whole loop ceremonial, so it fails closed before any artifact exists.
    """
    transport = probe.get("transport")
    if transport != LISTENER_TRANSPORT:
        raise Reject(
            "insufficient_evidence",
            f"probe transport {transport!r} is not {LISTENER_TRANSPORT!r}: firing the "
            "handler in process proves the limb works, not that the port works",
        )

    listener = probe.get("listener")
    if not isinstance(listener, str) or not LISTENER_RE.match(listener):
        raise Reject(
            "insufficient_evidence",
            f"probe names no listener socket ({listener!r}); a request that crossed a "
            "listener knows which one",
        )

    url = probe.get("url")
    if not isinstance(url, str) or not url.startswith("http://"):
        raise Reject("insufficient_evidence", f"probe url is not an http request: {url!r}")
    authority, _, path = url[len("http://"):].partition("/")
    if authority != listener:
        raise Reject(
            "insufficient_evidence",
            f"probe url authority {authority!r} is not the attested listener {listener!r}",
        )
    path = "/" + path

    agent = probe.get("agent")
    if not isinstance(agent, str) or not agent:
        raise Reject("insufficient_evidence", "probe names no serving agent")
    # The kernel mounts every published path under `/agents/<agent>`. A probe
    # whose path is not that mount point reached some other surface.
    expected = f"/agents/{agent}{gap['route']}"
    if path != expected:
        raise Reject(
            "insufficient_evidence",
            f"probe path {path!r} is not this gap's served route {expected!r}",
        )

    method = probe.get("method")
    if method != gap.get("method", "POST"):
        raise Reject(
            "insufficient_evidence",
            f"probe used {method!r}, not the route's declared method",
        )

    published = probe.get("published")
    if not isinstance(published, str) or len(published) != 64:
        raise Reject("insufficient_evidence", "probe names no published interface digest")
    try:
        int(published, 16)
    except ValueError:
        raise Reject("insufficient_evidence", "probe published digest is not hex")
    return published


def judge(gap, probe):
    """Did the port serve the gap? Returns (verified, reason).

    Four independent conditions, all required. Any one of them alone is the kind
    of near-miss that reads like success: a 200 carrying the wrong answer, the
    right answer under a schema the contract never promised, or a firing the port
    declined without running.
    """
    status = probe.get("status")
    if status != 200:
        return False, f"the served route answered {status}, not 200"

    neuron_status = probe.get("neuron_status")
    if neuron_status not in SERVED_STATUSES:
        return False, f"the port did not report a served firing (status {neuron_status!r})"

    product_schema = probe.get("product_schema")
    if product_schema not in gap["emits"]:
        return False, (
            f"the answer arrived under {product_schema!r}, which the contract's emits "
            f"{gap['emits']} never promised"
        )

    body = probe.get("response_body")
    if not isinstance(body, str) or gap["expect_contains"] not in body:
        return False, (
            f"the response does not satisfy the gap's own acceptance "
            f"({gap['expect_contains']!r})"
        )
    return True, "the published route answered the gap's probe with the contract's own product"


def prior_successes(patterns, gap_id, published):
    """Accumulated verified successes for exactly this (gap, interface) pair.

    A pattern belongs to one interface: a different port starts its own record
    rather than inheriting a ranking it never earned (morphogenesis.zig
    patternSuccesses makes the same check).
    """
    best = 0
    for _, record in patterns:
        if record.get("gap") != gap_id or record.get("interface") != published:
            continue
        count = record.get("verified_successes")
        if isinstance(count, int) and count > best:
            best = count
    return best


def fire(stim):
    _, gap = artifact_ref(stim, GAP_SCHEMA)
    _, probe = artifact_ref(stim, PROBE_SCHEMA)
    patterns = artifact_refs(stim, PATTERN_SCHEMA)

    for field in ("id", "route", "expect_contains"):
        if not isinstance(gap.get(field), str) or not gap[field]:
            raise Reject("validation", f"publication gap missing {field}")
    if not isinstance(gap.get("emits"), list) or not gap["emits"]:
        raise Reject("validation", "publication gap declares no emits")
    if probe.get("gap") != gap["id"]:
        raise Reject(
            "invariant_violation",
            f"probe is for gap {probe.get('gap')!r}, not {gap['id']!r}",
        )

    published = require_listener(gap, probe)
    verified, reason = judge(gap, probe)

    verdict = {
        "schema": VERDICT_SCHEMA,
        "gap": gap["id"],
        "interface": published,
        "agent": probe["agent"],
        "verified": verified,
        # The kernel verbs that carry the verdict out. Naming them is all this
        # limb may do; running them is the operator's, through the public CLI.
        "action": "retain" if verified else "retire",
        "retire_calls": [] if verified else [
            f"neuron port detach <node> {probe['agent']} --published {published}",
            f"neuron port revoke <node> --published {published}",
        ],
        "reason": reason,
        "probe": {
            "transport": LISTENER_TRANSPORT,
            "listener": probe["listener"],
            "url": probe["url"],
            "method": probe["method"],
            "status": probe.get("status"),
            "product_schema": probe.get("product_schema"),
            "neuron_status": probe.get("neuron_status"),
        },
    }
    effects = [cas_write(
        stim,
        VERDICT_PREFIX + slug(gap["id"]),
        VERDICT_SCHEMA,
        json.dumps(verdict, sort_keys=True, separators=(",", ":")),
    )]

    # Refusal 3: the pattern record exists on this branch and nowhere else. A
    # retired port leaves the ranking exactly as it found it, so a boundary that
    # never worked can never become the one reuse prefers.
    successes = 0
    if verified:
        successes = prior_successes(patterns, gap["id"], published) + 1
        pattern = {
            "schema": PATTERN_SCHEMA,
            "gap": gap["id"],
            "need": gap.get("need", ""),
            "interface": published,
            "route": f"/agents/{probe['agent']}{gap['route']}",
            "verified_successes": successes,
            "last_listener": probe["listener"],
            "last_product_schema": probe.get("product_schema"),
        }
        effects.append(cas_write(
            stim,
            PATTERN_PREFIX + slug(gap["id"]),
            PATTERN_SCHEMA,
            json.dumps(pattern, sort_keys=True, separators=(",", ":")),
        ))

    evidence = [{
        "claim": (
            f"port {published[:16]} {'satisfied' if verified else 'did not satisfy'} gap "
            f"{gap['id']} on the real path: {reason}"
        ),
        "sources": ["stimulus"],
        "method": (
            f"HTTP {probe['method']} across the {LISTENER_TRANSPORT} at {probe['listener']}, "
            "judged against the gap's own declared acceptance"
        ),
        "confidence_milli": 1000,
    }]
    result = f"retained/{successes}" if verified else "retired"
    return decision({"kind": "terminate", "result": result}, effects, evidence, stim)


if __name__ == "__main__":
    sys.exit(run(fire))
