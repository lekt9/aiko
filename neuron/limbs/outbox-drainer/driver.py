#!/usr/bin/env python3
"""outbox-drainer driver — the dumb plumbing around the drainer/reconciler neurons.

The neurons are pure policy; this driver is the only moving part. It:

  ingest    folds queued sends from a `neuron run --dump` projection into the
            append-only state root (deduplicated by idempotency key, §21)
  drain     loops: fire drainer -> execute each committed adapter send via the
            manifest's adapter registry -> stage the ack as a read -> fire the
            reconciler -> append every committed artifact to the state root,
            until the drainer settles terminate "drained" (§26)
  reconcile gathers FRESH provider evidence through the adapter's verify argv
            and fires the reconciler in reconcile mode for a parked delivery
  status    prints the folded per-key projection

The state root is the durable audit trail (§28): outbox.jsonl + records.jsonl
hold the exact committed artifacts; every firing is replayable from them.
Adapters own their secrets (§24): the driver passes only the declared envelope
on stdin and never reads a credential.
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time

LIMB_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DEF = os.path.join(LIMB_DIR, "neuron.json")
DEFAULT_NEURON_BIN = os.path.join(LIMB_DIR, "..", "..", "zig-out", "bin", "neuron")

ATTEMPT_SCHEMA = "outbox.delivery-attempt/v1"
DELIVERY_SCHEMA = "outbox.delivery-record/v1"
ACK_SCHEMA = "outbox.ack/v1"
PROJECTION_SCHEMA = "outbox.queued-messages/v1"


# ---------- canonical identity helpers (mirror limbs/shared/_neuron.py) ----------

def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()


def digest_str(text):
    return hashlib.sha256(text.encode()).hexdigest()


def message_key(msg):
    basis = "|".join((msg["firing_id"], msg["to"], msg["schema"], msg["payload"]))
    return hashlib.sha256(basis.encode()).hexdigest()


def read_of(read_id, schema, obj):
    body = canonical(obj).decode()
    return {"id": read_id, "schema": schema, "bytes": body, "digest": digest_str(body)}


# ---------- state root ----------

def append_jsonl(path, obj):
    with open(path, "a") as fh:
        fh.write(json.dumps(obj, sort_keys=True, separators=(",", ":")) + "\n")


def load_jsonl(path):
    if not os.path.exists(path):
        return []
    with open(path) as fh:
        return [json.loads(line) for line in fh if line.strip()]


def outbox_path(state):
    return os.path.join(state, "outbox.jsonl")


def records_path(state):
    return os.path.join(state, "records.jsonl")


def fold_state(state):
    """Per-key view: {key: {status, attempts, message}} from the state root."""
    view = {}
    for msg in load_jsonl(outbox_path(state)):
        view.setdefault(msg["key"], {"status": "queued", "attempts": 0, "message": msg})
    for rec in load_jsonl(records_path(state)):
        body = json.loads(rec["bytes"])
        key = body.get("key")
        if key not in view:
            continue
        entry = view[key]
        if rec["schema"] == ATTEMPT_SCHEMA:
            entry["attempts"] = max(entry["attempts"], int(body.get("attempt", 0)))
            if entry["status"] not in ("acknowledged", "dead_letter"):
                entry["status"] = "attempting"
        elif rec["schema"] == DELIVERY_SCHEMA:
            entry["attempts"] = max(entry["attempts"], int(body.get("attempts", 0)))
            if entry["status"] not in ("acknowledged", "dead_letter"):
                entry["status"] = body["status"]
    return view


def record_reads(state):
    """Every committed record as a digest-pinned read for the next firing."""
    return [{"id": rec["id"], "schema": rec["schema"], "bytes": rec["bytes"],
             "digest": rec["digest"]} for rec in load_jsonl(records_path(state))]


# ---------- firing through the real binding ----------

def fire(neuron_bin, manifest, neuron_id, firing_id, receptor_schema, reads, now_ms):
    """One `neuron run --json --dump`. Returns (exit_code, summary_or_none, stderr)."""
    stimulus = {
        "schema": "neuron.stimulus/v1",
        "firing_id": firing_id,
        "receptor_schema": receptor_schema,
        "now_ms": now_ms,
        "reads": reads,
        "permitted_reads": [r["id"] for r in reads],
        "messages": [],
    }
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(stimulus, fh)
        stim_path = fh.name
    try:
        proc = subprocess.run(
            [neuron_bin, "run", "--def", manifest, "--neuron", neuron_id,
             "--stimulus", stim_path, "--json", "--dump"],
            capture_output=True, text=True, timeout=120,
        )
    finally:
        os.unlink(stim_path)
    summary = None
    if proc.stdout.strip():
        try:
            summary = json.loads(proc.stdout)
        except json.JSONDecodeError:
            pass
    return proc.returncode, summary, proc.stderr


def commit_artifacts(state, summary):
    """Append newly committed artifacts from a firing dump to the state root."""
    if not summary or "dump" not in summary:
        return
    known = {rec["id"] for rec in load_jsonl(records_path(state))}
    for artifact in summary["dump"].get("artifacts", []):
        if artifact["id"].startswith("artifact/outbox/") and artifact["id"] not in known:
            append_jsonl(records_path(state), artifact)
            known.add(artifact["id"])


# ---------- adapter registry ----------

def load_registry(manifest_path, overrides):
    with open(manifest_path) as fh:
        manifest = json.load(fh)
    registry = dict(manifest.get("adapters", {}).get("registry", {}))
    base = os.path.dirname(os.path.abspath(manifest_path))
    for prefix, entry in registry.items():
        entry["argv"] = [
            part if part.startswith("/") or "/" not in part else os.path.join(base, part)
            for part in entry.get("argv", [])
        ]
        if "verify_argv" in entry:
            entry["verify_argv"] = [
                part if part.startswith("/") or "/" not in part else os.path.join(base, part)
                for part in entry["verify_argv"]
            ]
    for override in overrides or []:
        prefix, _, argv = override.partition("=")
        if not argv:
            raise SystemExit(f"--adapter-override must be prefix=argv..., got {override}")
        registry[prefix] = {"argv": argv.split()}
    return registry


def adapter_for(registry, channel):
    """Longest-prefix match of a channel to a registry entry."""
    best = None
    for prefix, entry in registry.items():
        if channel.startswith(prefix) and (best is None or len(prefix) > len(best[0])):
            best = (prefix, entry)
    return best[1] if best else None


def exec_adapter(entry, envelope, timeout=60):
    """Run the adapter with the declared envelope on stdin. Adapter owns secrets."""
    proc = subprocess.run(
        entry["argv"], input=json.dumps(envelope), capture_output=True, text=True,
        timeout=timeout,
    )
    outcome = {0: "ack", 1: "permanent", 2: "retryable", 75: "uncertain"}.get(
        proc.returncode, "uncertain")  # unknown exits fail closed: never assume delivery
    provider_ref = None
    if proc.returncode == 0 and proc.stdout.strip():
        try:
            provider_ref = json.loads(proc.stdout).get("provider_ref")
        except json.JSONDecodeError:
            provider_ref = proc.stdout.strip()[:128]
    detail = (proc.stderr or proc.stdout).strip()[:256]
    return outcome, provider_ref, detail


# ---------- subcommands ----------

def cmd_ingest(args):
    with open(args.dump) as fh:
        dump = json.load(fh)
    if "dump" in dump:
        dump = dump["dump"]
    known = {msg["key"] for msg in load_jsonl(outbox_path(args.state))}
    ingested = 0
    for message in dump.get("messages", []):
        if not message["to"].startswith(args.partition):
            continue
        if message.get("status", "queued") != "queued":
            continue
        keyed = dict(message)
        keyed["key"] = message_key(message)
        if keyed["key"] in known:
            continue
        append_jsonl(outbox_path(args.state), keyed)
        known.add(keyed["key"])
        ingested += 1
    print(json.dumps({"ingested": ingested, "partition": args.partition}))


def drain_pass(args, registry, seq):
    """One drainer firing + adapter executions + settle firings. Returns summary."""
    view = fold_state(args.state)
    partition = args.partition
    messages = [entry["message"] for entry in view.values()
                if entry["message"]["to"].startswith(partition)]
    messages.sort(key=lambda m: m["key"])
    now_ms = int(time.time() * 1000)
    projection = {"schema": PROJECTION_SCHEMA, "partition": partition,
                  "messages": messages, "projected_at": now_ms}
    request = {"schema": "outbox.drain-request/v1", "partition": partition,
               "max_batch": args.max_batch, "max_attempts": args.max_attempts,
               "seq": seq, "requested_at": now_ms}
    reads = [read_of(f"request/outbox/drain/{seq}", "outbox.drain-request/v1", request),
             read_of("projection/outbox/queued", PROJECTION_SCHEMA, projection)]
    reads.extend(record_reads(args.state))
    slug = partition.strip("/").replace("/", "-")
    code, summary, stderr = fire(args.neuron_bin, args.def_, "drainer",
                                 f"drain/{slug}/{seq}", "outbox.drain-request/v1",
                                 reads, now_ms)
    if code != 0:
        raise SystemExit(f"drainer firing failed closed: {stderr.strip()}")
    commit_artifacts(args.state, summary)
    result = {"seq": seq, "sends": 0, "settles": [], "control": "continue"}

    dump = summary.get("dump", {})
    for message in dump.get("messages", []):
        if not message["to"].startswith(partition):
            continue
        envelope = json.loads(message["payload"])
        key = envelope["idempotency_key"]
        entry = adapter_for(registry, message["to"])
        if entry is None:
            raise SystemExit(f"no adapter registered for channel {message['to']}")
        outcome, provider_ref, detail = exec_adapter(entry, envelope)
        result["sends"] += 1
        attempts = fold_state(args.state)[key]["attempts"]
        ack = {"schema": ACK_SCHEMA, "key": key, "outcome": outcome,
               "provider_ref": provider_ref, "detail": detail,
               "observed_at": int(time.time() * 1000)}
        ack_read = read_of(f"ack/outbox/{key}/{attempts}", ACK_SCHEMA, ack)
        attempt_id = f"artifact/outbox/attempts/{key}/{attempts}"
        attempt_rec = [r for r in record_reads(args.state) if r["id"] == attempt_id]
        settle_req = {"schema": "outbox.settle-request/v1", "mode": "settle",
                      "key": key, "max_attempts": args.max_attempts,
                      "requested_at": int(time.time() * 1000)}
        settle_reads = [read_of(f"request/outbox/settle/{key}/{attempts}",
                                "outbox.settle-request/v1", settle_req),
                        *attempt_rec, ack_read]
        code, ssummary, sstderr = fire(args.neuron_bin, args.def_, "reconciler",
                                       f"settle/{key}/{attempts}",
                                       "outbox.settle-request/v1", settle_reads,
                                       int(time.time() * 1000))
        if code != 0:
            raise SystemExit(f"reconciler firing failed closed: {sstderr.strip()}")
        commit_artifacts(args.state, ssummary)
        result["settles"].append({"key": key, "outcome": outcome})
    return result


def cmd_drain(args):
    registry = load_registry(args.def_, args.adapter_override)
    seq = 0
    passes = []
    while True:
        result = drain_pass(args, registry, seq)
        passes.append(result)
        seq += 1
        if result["sends"] == 0:
            break  # drainer settled terminate "drained": a valid settlement (§26)
        if seq > 64:
            raise SystemExit("drain made no settlement progress in 64 passes")
    view = fold_state(args.state)
    summary = {"passes": len(passes), "drained": True}
    for status in ("acknowledged", "retryable", "dead_letter", "reconciliation_required",
                   "queued", "attempting"):
        keys = sorted(k for k, v in view.items() if v["status"] == status)
        if keys:
            summary[status] = keys
    print(json.dumps(summary, sort_keys=True))


def cmd_reconcile(args):
    registry = load_registry(args.def_, args.adapter_override)
    view = fold_state(args.state)
    entry = view.get(args.key)
    if entry is None or entry["status"] != "reconciliation_required":
        raise SystemExit(f"key {args.key} is not parked at reconciliation_required")
    adapter = adapter_for(registry, entry["message"]["to"])
    if adapter is None or "verify_argv" not in adapter:
        raise SystemExit("no adapter verify_argv registered for this channel")
    proc = subprocess.run([*adapter["verify_argv"], args.key],
                          capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        raise SystemExit(f"adapter verify failed: {proc.stderr.strip()}")
    observation = json.loads(proc.stdout)
    now_ms = int(time.time() * 1000)
    ack = {"schema": ACK_SCHEMA, "key": args.key,
           "outcome": observation.get("outcome", "uncertain"),
           "provider_ref": observation.get("provider_ref"),
           "detail": observation.get("detail", ""), "observed_at": now_ms}
    seq = int(time.time())
    ack_read = read_of(f"verify/outbox/{args.key}/{seq}", ACK_SCHEMA, ack)
    parked = [r for r in record_reads(args.state)
              if r["schema"] == DELIVERY_SCHEMA and json.loads(r["bytes"])["key"] == args.key]
    request = {"schema": "outbox.settle-request/v1", "mode": "reconcile",
               "key": args.key, "max_attempts": args.max_attempts,
               "requested_at": now_ms}
    reads = [read_of(f"request/outbox/reconcile/{args.key}/{seq}",
                     "outbox.settle-request/v1", request), *parked, ack_read]
    code, summary, stderr = fire(args.neuron_bin, args.def_, "reconciler",
                                 f"reconcile/{args.key}/{seq}",
                                 "outbox.settle-request/v1", reads, now_ms)
    if code != 0:
        raise SystemExit(f"reconciler firing failed closed: {stderr.strip()}")
    commit_artifacts(args.state, summary)
    print(json.dumps({"key": args.key, "status": fold_state(args.state)[args.key]["status"]}))


def cmd_status(args):
    view = fold_state(args.state)
    print(json.dumps({k: {"status": v["status"], "attempts": v["attempts"]}
                      for k, v in sorted(view.items())}, sort_keys=True, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--state", required=True, help="state root directory")
    parser.add_argument("--def", dest="def_", default=DEFAULT_DEF, help="limb manifest")
    parser.add_argument("--neuron-bin", default=os.path.abspath(DEFAULT_NEURON_BIN))
    parser.add_argument("--adapter-override", action="append",
                        help="prefix=argv... registry override (repeatable)")
    parser.add_argument("--max-batch", type=int, default=8)
    parser.add_argument("--max-attempts", type=int, default=3)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("ingest")
    p.add_argument("--dump", required=True)
    p.add_argument("--partition", required=True)
    p.set_defaults(fn=cmd_ingest)

    p = sub.add_parser("drain")
    p.add_argument("--partition", required=True)
    p.set_defaults(fn=cmd_drain)

    p = sub.add_parser("reconcile")
    p.add_argument("--key", required=True)
    p.set_defaults(fn=cmd_reconcile)

    p = sub.add_parser("status")
    p.set_defaults(fn=cmd_status)

    args = parser.parse_args()
    os.makedirs(args.state, exist_ok=True)
    args.fn(args)


if __name__ == "__main__":
    main()
