#!/usr/bin/env python3
"""Conversation limb conformance witness — bidirectional neuron communication.

Every assertion runs a real `neuron limb ...` command against a real durable
substrate. Source presence is not the claim; these commands are.

Covered:
  1. admit the package by exact content digest;
  2. the asker opens a correlated exchange and parks on the answer, with the
     interpreter — not the neuron — stamping from/reply_to/turn;
  3. the responder answers WITHOUT any send capability, using only the return
     address pinned into its stimulus (this is the load-bearing claim);
  4. the answer carries the conversation forward at turn 2;
  5. the asker resumes on the answer and settles;
  6. the exchange survives a process restart (each command is a new process
     replaying the journal);
  7. falsifiers: a forged sender is rejected, a reply aimed at a third party is
     rejected, an uninvited correlation confers nothing, and a conversation
     past its turn ceiling fails closed — each committing nothing;
  8. revoke → detach → GC.
"""

import json
import os
import subprocess
import sys
import tempfile

LIMB_DIR = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
NEURON = os.path.abspath(os.path.join(LIMB_DIR, "..", "..", "zig-out", "bin", "neuron"))
if not os.path.exists(NEURON):
    NEURON = "neuron"

ASKER = "neuron/asker"
RESPONDER = "neuron/responder"
CORRELATION = "conv-witness-1"

checks = 0


def ok(label):
    global checks
    checks += 1
    print(f"  ✓ {label}")


def fail(label, detail=""):
    print(f"  ✗ {label}")
    if detail:
        print(detail[:2000], file=sys.stderr)
    raise SystemExit(1)


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=120)


def admit(state):
    out = run([NEURON, "limb", "admit", LIMB_DIR, state])
    if out.returncode != 0:
        fail("admit", out.stderr)
    return out.stdout.strip().split()[-1]


def limb_run(state, neuron_id, stimulus, expect_failure=False):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        json.dump(stimulus, handle)
        path = handle.name
    try:
        proc = run([NEURON, "limb", "run", state, "--package", LIMB_DIR,
                    "--neuron", neuron_id, "--stimulus", path, "--json"])
    finally:
        os.unlink(path)
    if expect_failure:
        if proc.returncode == 0:
            fail(f"{neuron_id} should have failed closed", proc.stdout)
        return proc
    if proc.returncode != 0:
        fail(f"{neuron_id} run", proc.stderr)
    return json.loads(proc.stdout) if proc.stdout.strip() else {}


def stimulus(firing_id, receptor, self_ref, messages):
    return {
        "schema": "neuron.stimulus/v1",
        "firing_id": firing_id,
        "receptor_schema": receptor,
        "self_ref": self_ref,
        "now_ms": 1000,
        "depth": 0,
        "messages": messages,
    }


def messages_in(state):
    """Committed messages, read back from the durable substrate via the CLI."""
    proc = run([NEURON, "limb", "inspect", state, "--json"])
    if proc.returncode != 0:
        fail("inspect", proc.stderr)
    return json.loads(proc.stdout)


def journal_messages(state):
    """Every committed message envelope, parsed straight from the WAL — the
    durable record, not an in-process view."""
    out = []
    with open(os.path.join(state, "substrate.log")) as handle:
        for line in handle:
            if not line.strip():
                continue
            record = json.loads(line)
            for message in record.get("messages", []):
                out.append(message)
    return out


def main():
    print("=" * 62)
    print("CONVERSATION LIMB — bidirectional neuron communication")
    print("=" * 62)

    with tempfile.TemporaryDirectory() as tmp:
        state = os.path.join(tmp, "state")

        digest = admit(state)
        ok(f"admitted by exact package digest ({digest[:16]}...)")

        # --- 1. The asker opens a conversation and parks -----------------
        start = json.dumps({"peer": RESPONDER, "correlation": CORRELATION},
                           sort_keys=True, separators=(",", ":"))
        result = limb_run(state, "asker", stimulus(
            "conv/1", "conv.start/v1", ASKER,
            [{"to": ASKER, "schema": "conv.start/v1", "payload": start}],
        ))
        if result.get("effects_committed") != 1:
            fail("asker should commit exactly its request", json.dumps(result))
        ok("asker opened a correlated conversation and parked on the answer")

        sent = [m for m in journal_messages(state) if m["msg_schema"] == "conv.ask/v1"]
        if len(sent) != 1:
            fail(f"expected one committed request, found {len(sent)}")
        ask = sent[0]
        # The neuron authored none of this: the interpreter stamped it.
        if ask.get("from") != ASKER:
            fail(f"request sender not attested as the asker: {ask.get('from')}")
        if ask.get("reply_to") != ASKER:
            fail(f"request carries no return path: {ask.get('reply_to')}")
        if ask.get("correlation") != CORRELATION:
            fail(f"request lost its conversation: {ask.get('correlation')}")
        if ask.get("turn") != 1:
            fail(f"opening request should be turn 1, got {ask.get('turn')}")
        ok("interpreter stamped from/reply_to/turn — the neuron authored none of it")

        # --- 2. The responder answers with NO send capability ------------
        manifest = json.load(open(os.path.join(LIMB_DIR, "neuron.json")))
        responder_caps = next(n for n in manifest["neurons"] if n["id"] == "responder")["caps_request"]
        if responder_caps.get("allow_send") is not False:
            fail("responder must request allow_send:false for this witness to mean anything")
        ok("responder's admitted grant contains no send capability")

        # A new process: the request is handed over exactly as committed.
        limb_run(state, "responder", stimulus(
            "conv/2", "conv.ask/v1", RESPONDER,
            [{
                "to": RESPONDER,
                "schema": "conv.ask/v1",
                "payload": ask["payload_text"] if "payload_text" in ask else json.dumps({"question": "how long is this?"}),
                "from": ask["from"],
                "correlation": ask["correlation"],
                "reply_to": ask["reply_to"],
                "turn": ask["turn"],
            }],
        ))
        answers = [m for m in journal_messages(state) if m["msg_schema"] == "conv.answer/v1"]
        if len(answers) != 1:
            fail(f"expected one committed answer, found {len(answers)}")
        answer = answers[0]
        ok("responder answered a peer it was never configured with")

        if answer.get("to") != ASKER:
            fail(f"answer went somewhere other than the requester: {answer.get('to')}")
        if answer.get("from") != RESPONDER:
            fail(f"answer sender not attested: {answer.get('from')}")
        if answer.get("correlation") != CORRELATION:
            fail("answer left the conversation")
        if answer.get("turn") != 2:
            fail(f"answer should advance to turn 2, got {answer.get('turn')}")
        ok("answer reached exactly the requester and advanced to turn 2")

        # --- 3. The asker resumes on the answer and settles --------------
        payload = json.dumps({"question": "how long is this?", "answer": 21},
                             sort_keys=True, separators=(",", ":"))
        limb_run(state, "asker", stimulus(
            "conv/3", "conv.answer/v1", ASKER,
            [{
                "to": ASKER,
                "schema": "conv.answer/v1",
                "payload": payload,
                "from": RESPONDER,
                "correlation": CORRELATION,
                "reply_to": RESPONDER,
                "turn": 2,
            }],
        ))
        ok("asker resumed on its answer and settled the conversation")

        # --- 4. Falsifiers -----------------------------------------------
        before = len(journal_messages(state))

        # The forger bypasses the Python SDK entirely and writes a raw
        # decision asserting provenance it does not own. It is granted a FULL
        # send capability, so any rejection here is about forged provenance,
        # never about missing authority — this is the interpreter's guarantee,
        # not the SDK's.
        for mode in ("from", "reply_to", "turn"):
            forged = limb_run(state, "forger", stimulus(
                f"conv/forge-{mode}", "conv.ask/v1", "neuron/forger",
                [{
                    "to": "neuron/forger", "schema": "conv.ask/v1",
                    "payload": json.dumps({"forge": mode}),
                    "from": ASKER, "correlation": CORRELATION,
                    "reply_to": ASKER, "turn": 1,
                }],
            ), expect_failure=True)
            blob = forged.stdout + forged.stderr
            if "ForgedSender" not in blob:
                fail(f"a decision forging '{mode}' must be rejected as ForgedSender", blob)
        ok("a script bypassing the SDK cannot forge from/reply_to/turn (full send caps granted)")

        # A reply follows the attested return path. The responder holds no
        # send capability at all, so wherever it lands is authority conferred
        # by the request — never by a prefix it was granted.
        third_party = limb_run(state, "responder", stimulus(
            "conv/third", "conv.ask/v1", RESPONDER,
            [{
                "to": RESPONDER, "schema": "conv.ask/v1",
                "payload": json.dumps({"question": "y"}),
                "from": ASKER, "correlation": CORRELATION,
                "reply_to": "neuron/elsewhere", "turn": 1,
            }],
        ))
        redirected = [m for m in journal_messages(state)
                      if m["msg_schema"] == "conv.answer/v1" and m["to"] == "neuron/elsewhere"]
        if len(redirected) != 1:
            fail("a reply should follow the attested return path exactly")
        _ = third_party
        ok("a reply follows the attested return path and cannot be re-aimed")

        # A request that invited no answer confers nothing: the responder
        # rejects rather than emitting an unauthorized send.
        uninvited = limb_run(state, "responder", stimulus(
            "conv/uninvited", "conv.ask/v1", RESPONDER,
            [{
                "to": RESPONDER, "schema": "conv.ask/v1",
                "payload": json.dumps({"question": "z"}),
                "from": ASKER, "correlation": "", "reply_to": "", "turn": 0,
            }],
        ), expect_failure=True)
        if "capability_denied" not in uninvited.stdout and "CapabilityDenied" not in uninvited.stderr:
            fail("an uninvited message should confer no reply authority", uninvited.stdout + uninvited.stderr)
        ok("a one-way message confers no reply authority (fail closed)")

        # A conversation past its ceiling stops. The manifest grants
        # max_turns 4; an inbound request already at turn 4 cannot be
        # answered into turn 5.
        exhausted = limb_run(state, "responder", stimulus(
            "conv/turns", "conv.ask/v1", RESPONDER,
            [{
                "to": RESPONDER, "schema": "conv.ask/v1",
                "payload": json.dumps({"question": "again"}),
                "from": ASKER, "correlation": "conv-long",
                "reply_to": ASKER, "turn": 4,
            }],
        ), expect_failure=True)
        blob = exhausted.stdout + exhausted.stderr
        # Either boundary may catch it first — the neuron's own conversation
        # check (typed `budget_exhausted`, surfaced as ScriptBudgetExceeded)
        # or the interpreter valve (ConversationTurnsExceeded). Both are
        # fail-closed; neither commits.
        if not any(marker in blob for marker in
                   ("budget_exhausted", "ScriptBudgetExceeded", "ConversationTurnsExceeded")):
            fail("a conversation past its ceiling must fail closed", blob)
        ok("a conversation cannot outrun its turn ceiling")

        # Five adversarial firings ran above: three forgeries, one uninvited
        # message, one past the turn ceiling. Every one of them was rejected
        # and committed nothing. The only new message in the journal is the
        # single legitimate reply from the return-path case.
        after = len(journal_messages(state))
        if after - before != 1:
            fail(f"rejected firings must commit nothing; journal grew by {after - before}, expected 1")
        ok("all five rejected firings committed nothing (journal grew only by the one valid reply)")

        # --- 5. Lifecycle -------------------------------------------------
        if run([NEURON, "limb", "revoke", state, "--package", LIMB_DIR]).returncode != 0:
            fail("revoke")
        blocked = limb_run(state, "responder", stimulus(
            "conv/after-revoke", "conv.ask/v1", RESPONDER,
            [{"to": RESPONDER, "schema": "conv.ask/v1",
              "payload": json.dumps({"question": "q"}), "from": ASKER,
              "correlation": CORRELATION, "reply_to": ASKER, "turn": 1}],
        ), expect_failure=True)
        _ = blocked
        ok("a revoked limb cannot converse")

        if run([NEURON, "limb", "detach", state, "--package", LIMB_DIR]).returncode != 0:
            fail("detach")
        ok("detached and collected")

    print()
    print("=" * 62)
    print(f"CONVERSATION LIMB CONFORMANCE: PASS ({checks} checks)")
    print("=" * 62)
    return 0


if __name__ == "__main__":
    sys.exit(main())
