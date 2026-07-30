"""Shared Neuron runtime helpers for in-repo generative limbs (§30).

Implements the hard-typed Neuron contract from neuron/AGENTS.md (v2.0) as
stdin/stdout pure functions:

    Stimulus (JSON, stdin)  ->  Decision | Rejection (JSON, stdout)

A Neuron is pure and stateless (§2): no network, no secrets, no clock beyond
`now_ms` supplied in the stimulus, no filesystem. It returns exactly one
control decision plus zero or more *declarative* effects and grounded evidence
(§19, types.zig). Returning a `send` does not send; the harness/adapter commit
boundary is the sole linearization point (§20).

Failure is typed (§27) and fail-closed: a rejection carries no effects, ever.
"""

import hashlib
import json
import sys

SCHEMA_STIMULUS = "neuron.stimulus/v1"
SCHEMA_DECISION = "neuron.decision/v1"
SCHEMA_REJECTION = "neuron.rejection/v1"

# Typed failure classes, mirroring AGENTS.md §27.
FAILURES = (
    "validation",
    "capability_denied",
    "budget_exhausted",
    "dependency",
    "timeout",
    "conflict",
    "poisoned_input",
    "invariant_violation",
    "insufficient_evidence",
    "internal",
)

DEFAULT_BUDGET = {
    "max_effects": 32,
    "max_writes": 8,
    "max_messages": 16,
    "max_spawns": 8,
    "max_bytes": 1024 * 1024,
    "max_depth": 8,
    "max_turns": 8,
}

# Predicate namespace for `continue`-parking on a reply (pump.zig
# REPLY_PREDICATE_PREFIX). Waiting here is waiting for an answer, not an
# artifact.
REPLY_PREDICATE_PREFIX = "reply/"


class Reject(Exception):
    """Typed rejection. Raised anywhere; the neuron exits fail-closed."""

    def __init__(self, failure, detail):
        assert failure in FAILURES, f"unknown failure class {failure}"
        super().__init__(detail)
        self.failure = failure
        self.detail = detail


def canonical(obj):
    """Named canonical serialization (§19): sorted keys, compact separators."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()


def digest(obj):
    """SHA-256 over canonical serialization; hex string form of types.zig Digest."""
    return hashlib.sha256(canonical(obj)).hexdigest()


def load_stimulus():
    """Read and minimally validate a stimulus from stdin (§20 step 1)."""
    try:
        raw = sys.stdin.read()
        stim = json.loads(raw)
    except Exception as exc:  # malformed JSON is a validation failure
        raise Reject("validation", f"stimulus is not JSON: {exc}")
    if not isinstance(stim, dict) or stim.get("schema") != SCHEMA_STIMULUS:
        raise Reject("validation", "stimulus schema must be neuron.stimulus/v1")
    for field in ("firing_id", "receptor_schema"):
        if not isinstance(stim.get(field), str) or not stim[field]:
            raise Reject("validation", f"stimulus missing {field}")
    stim.setdefault("reads", [])
    stim.setdefault("messages", [])
    stim.setdefault("depth", 0)
    stim.setdefault("budget", dict(DEFAULT_BUDGET))
    return stim


def provenance_set(stim):
    """The firing's provenance set (§23), kernel model: the literal "stimulus"
    plus every permitted read id. This matches runtime.zig groundedRead — an
    evidence source is valid only when it is "stimulus" or a digest-pinned
    read id, so decisions produced here verify under the Zig harness too."""
    prov = {"stimulus"}
    for ref in stim["reads"]:
        prov.add(ref.get("id"))
    return prov


def artifact_ref(stim, schema, required=True):
    """Find a read artifact by schema. Reads are digest-pinned (§20 step 3)."""
    for ref in stim["reads"]:
        if ref.get("schema") == schema:
            if "bytes" not in ref or "digest" not in ref:
                raise Reject("validation", f"read {schema} missing bytes/digest")
            try:
                body = json.loads(ref["bytes"])
            except Exception as exc:
                raise Reject("poisoned_input", f"read {schema} bytes not JSON: {exc}")
            return ref, body
    if required:
        raise Reject("dependency", f"required read absent: {schema}")
    return None, None


def artifact_refs(stim, schema):
    """All reads of a schema, in stimulus order (e.g. a record history)."""
    out = []
    for ref in stim["reads"]:
        if ref.get("schema") != schema:
            continue
        if "bytes" not in ref or "digest" not in ref:
            raise Reject("validation", f"read {schema} missing bytes/digest")
        try:
            body = json.loads(ref["bytes"])
        except Exception as exc:
            raise Reject("poisoned_input", f"read {schema} bytes not JSON: {exc}")
        out.append((ref, body))
    return out


def inbound(stim, schema=None, correlation=None):
    """Inbound messages, optionally filtered by schema or conversation.

    A message carries its own attested envelope (`from`, `correlation`,
    `reply_to`, `turn`), stamped by the interpreter at the sender's commit
    boundary. A neuron therefore answers a peer it was never configured with:
    the return address arrives with the request.
    """
    out = []
    for msg in stim.get("messages", []):
        if schema is not None and msg.get("schema") != schema:
            continue
        if correlation is not None and msg.get("correlation") != correlation:
            continue
        out.append(msg)
    return out


def request(to, schema, payload, correlation):
    """A send effect that opens a conversation and invites an answer.

    `correlation` names the exchange; the interpreter stamps this neuron's own
    address as the return path, so the recipient can reply without the sender
    granting it anything in advance. Reaching `to` still requires an ordinary
    send capability (§24).
    """
    if not correlation:
        raise Reject("validation", "a request must carry a non-empty correlation")
    return {
        "kind": "send",
        "message": {
            "to": to,
            "schema": schema,
            "payload": payload,
            "correlation": correlation,
        },
    }


def reply(message, schema, payload):
    """A send effect answering `message` on its own return path.

    Authority comes from possessing the request: the effect targets exactly
    the attested `reply_to` on exactly that correlation, so it cannot be
    redirected to a third party and needs no send prefix (runtime.zig
    answeredRequest). Passing a message that invited no reply is a typed
    rejection rather than a silent one-way send.
    """
    reply_to = message.get("reply_to") or ""
    correlation = message.get("correlation") or ""
    if not reply_to or not correlation:
        raise Reject("capability_denied", "message carries no return path to reply on")
    return {
        "kind": "send",
        "message": {
            "to": reply_to,
            "schema": schema,
            "payload": payload,
            "correlation": correlation,
        },
    }


def await_reply(correlation):
    """A `continue` control that parks this neuron until its answer arrives.

    The pump holds unrelated traffic for a parked neuron, so one conversation
    is not interrupted by another; an answer that never comes surfaces as
    pending rather than spinning (§26).
    """
    if not correlation:
        raise Reject("validation", "cannot await a reply without a correlation")
    return {"kind": "continue", "wait_for": f"{REPLY_PREDICATE_PREFIX}{correlation}"}


def check_budget(stim, n_effects, n_writes=0, n_messages=0, n_spawns=0, n_bytes=0):
    """Budget enforcement (§16, caps.zig Budget) before any effect is declared."""
    budget = stim["budget"]
    if stim.get("depth", 0) > budget.get("max_depth", DEFAULT_BUDGET["max_depth"]):
        raise Reject("budget_exhausted", "spawn depth exceeds max_depth")
    checks = (
        ("max_effects", n_effects),
        ("max_writes", n_writes),
        ("max_messages", n_messages),
        ("max_spawns", n_spawns),
        ("max_bytes", n_bytes),
    )
    for key, used in checks:
        if used > budget.get(key, DEFAULT_BUDGET[key]):
            raise Reject("budget_exhausted", f"{key}: need {used}, have {budget.get(key)}")


def check_conversation(stim, effects):
    """Mirror the interpreter's conversation valve (runtime.zig) locally, so a
    neuron fails typed at its own boundary instead of being rejected at commit.

    Three rules: provenance is never self-asserted, one firing answers a given
    conversation once, and an exchange cannot outrun its turn ceiling.
    """
    budget = stim["budget"]
    max_turns = budget.get("max_turns", DEFAULT_BUDGET["max_turns"])
    answered = set()
    for effect in effects:
        if effect.get("kind") != "send":
            continue
        msg = effect.get("message", {})
        for owned in ("from", "reply_to", "turn"):
            if msg.get(owned):
                raise Reject(
                    "invariant_violation",
                    f"'{owned}' is stamped by the interpreter and must not be self-asserted",
                )
        correlation = msg.get("correlation") or ""
        if not correlation:
            continue
        key = (correlation, msg.get("to"))
        if key in answered:
            raise Reject("invariant_violation", f"conversation {correlation} answered twice in one firing")
        answered.add(key)
        for request_msg in inbound(stim, correlation=correlation):
            if request_msg.get("reply_to") != msg.get("to"):
                continue
            if request_msg.get("turn", 0) >= max_turns:
                raise Reject(
                    "budget_exhausted",
                    f"conversation {correlation} exceeded max_turns ({max_turns})",
                )


def allows_delegation(parent, child):
    """Port of caps.zig allowsDelegation (§24): a child grant may narrow, never widen."""
    for verb in ("write", "send", "spawn"):
        if child.get(f"allow_{verb}"):
            if not parent.get(f"allow_{verb}"):
                return False
            parent_prefix = parent.get(f"{verb}_prefix", "")
            child_prefix = child.get(f"{verb}_prefix", "")
            if not child_prefix.startswith(parent_prefix):
                return False
    for key, default in DEFAULT_BUDGET.items():
        if child.get("budget", {}).get(key, default) > parent.get("budget", {}).get(key, default):
            return False
    return True


def decision(control, effects, evidence, stim):
    """Validate and emit a Decision (§20 steps 6-7). Fail-closed on any defect."""
    if control.get("kind") not in ("continue", "terminate", "branch"):
        raise Reject("invariant_violation", "decision must carry exactly one typed control")
    if not evidence:
        raise Reject("invariant_violation", "grounding: evidence must be non-empty (§23)")
    prov = provenance_set(stim)
    for ev in evidence:
        for src in ev.get("sources", []):
            if src not in prov:
                raise Reject(
                    "invariant_violation",
                    f"grounding: evidence source not in provenance set: {src}",
                )
    n_writes = sum(1 for e in effects if e.get("kind") == "write")
    n_messages = sum(1 for e in effects if e.get("kind") == "send")
    n_spawns = sum(1 for e in effects if e.get("kind") == "spawn")
    n_bytes = sum(len(e.get("artifact", {}).get("bytes", "")) for e in effects if e.get("kind") == "write")
    check_budget(stim, len(effects), n_writes, n_messages, n_spawns, n_bytes)
    check_conversation(stim, effects)
    out = {"schema": SCHEMA_DECISION, "control": control, "effects": effects, "evidence": evidence}
    json.dump(out, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


def emit_rejection(rej):
    """A typed rejection carries no effects and exits non-zero (§27 fail-closed)."""
    out = {"schema": SCHEMA_REJECTION, "failure": rej.failure, "detail": rej.detail, "effects": []}
    json.dump(out, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")
    return 1


def run(fire):
    """Neuron entrypoint: Stimulus -> Decision, or typed Rejection. Never throws."""
    try:
        stim = load_stimulus()
        return fire(stim)
    except Reject as rej:
        return emit_rejection(rej)
    except Exception as exc:  # invariant: no untyped failure escapes the neuron
        return emit_rejection(Reject("internal", f"{type(exc).__name__}: {exc}"))
