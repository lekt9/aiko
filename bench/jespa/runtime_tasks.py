#!/usr/bin/env python3
"""Black-box claimed-conformance benchmark against an executable sequential baseline.

The runtime's score is the number of AGENTS.md section-31 conformance
properties witnessed by named, executable Zig tests. A property counts only
when every mapped `test "..."` exists in src/ AND the whole `zig build test`
run exits zero — a missing name or a single behavioral failure fails the
property, so the count cannot be inflated by prose alone.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# AGENTS.md section-31 conformance profile -> the executable test names that
# witness each property. Every listed name must appear as test "<name>" in
# the Zig sources and pass under `zig build test`.
CONFORMANCE: dict[str, list[str]] = {
    "schema_invalid_rejected": [
        "schema-invalid stimuli and decisions are rejected before effects",
    ],
    "atomic_multi_effect": [
        "one firing atomically combines write send and spawn",
    ],
    "redelivery_idempotent": [
        "duplicate delivery does not duplicate effects",
    ],
    "cas_rejects_stale_and_retries": [
        "compare and swap rejects stale writes without mutation",
        "compare and swap conflict retries from a fresh snapshot",
    ],
    "unauthorized_effects_fail_closed": [
        "validation is atomic and capability denial commits nothing",
        "unauthorized reads are rejected at admission",
        "spawn delegation may only narrow the parent grant",
    ],
    "grounding_required": [
        "evidence must be grounded in stimulus or permitted reads",
        "artifact evidence requires a recorded matching digest",
    ],
    "limits_settle_predictably": [
        "effect and byte budgets fail closed",
        "spawn depth budget fails closed",
        "deadline and cancellation settle without effects",
        "message delivery acknowledges success and dead letters bounded retries",
    ],
    "cache_keys_and_safe_hits": [
        "cache key changes for code stimulus reads caps adapter clock and randomness",
        "cache hits never duplicate external effects",
    ],
    "reconciliation_preserves_audit": [
        "uncertain external effects reconcile without losing the audit trail",
    ],
    "topology_policies": [
        "joins wait for quorum and fire on evidence",
        "cycles require new evidence to proceed",
        "rewiring replaces neuron behavior by identity",
        "garbage collection preserves retention roots and cache reads",
    ],
    "skills_no_authority_before_admission": [
        "skill registry fails closed and grants no ambient authority",
    ],
    "generative_limb_lifecycle": [
        "generative limb passes the full lifecycle without kernel authority",
    ],
    "deterministic_replay": [
        "metrics and replay witness reflect immutable firing records",
    ],
}


@dataclass
class Naive:
    artifacts: dict[str, str] = field(default_factory=dict)
    messages: list[str] = field(default_factory=list)
    neurons: set[str] = field(default_factory=set)

    def execute(self, firing: str, effects: list[tuple], allow: set[str]) -> bool:
        # Representative simple executor: validate and apply each effect in order.
        # It has no transaction, evidence/read-set, CAS, dedupe, or aggregate budget.
        for effect in effects:
            kind = effect[0]
            if kind not in allow:
                return False
            if kind == "write":
                self.artifacts[effect[1]] = effect[2]
            elif kind == "send":
                self.messages.append(effect[1])
            elif kind == "spawn":
                self.neurons.add(effect[1])
        return True


def baseline_results() -> dict[str, bool]:
    results: dict[str, bool] = {}

    naive = Naive()
    results["atomic_multi_effect"] = naive.execute("a", [
        ("write", "artifact/a", "ok"), ("send", "channel/review"), ("spawn", "worker/v"),
    ], {"write", "send", "spawn"}) and len(naive.artifacts) == len(naive.messages) == len(naive.neurons) == 1

    naive = Naive()
    accepted = naive.execute("b", [
        ("write", "artifact/a", "leaked"), ("send", "forbidden/review"),
    ], {"write"})
    results["deny_is_atomic"] = not accepted and not naive.artifacts and not naive.messages

    naive = Naive()
    effects = [("send", "channel/review")]
    naive.execute("same", effects, {"send"})
    naive.execute("same", effects, {"send"})
    results["redelivery_idempotent"] = len(naive.messages) == 1

    naive = Naive(artifacts={"artifact/a": "current"})
    naive.execute("cas", [("write", "artifact/a", "stale")], {"write"})
    results["cas_rejects_stale"] = naive.artifacts["artifact/a"] == "current"

    naive = Naive()
    # There is no evidence input at all, so an unsupported claim is accepted.
    results["grounding_required"] = False

    naive = Naive()
    naive.execute("budget", [("write", "artifact/a", "too large")], {"write"})
    results["aggregate_budget"] = not naive.artifacts
    return results


def zig_test_names() -> str:
    return "\n".join(path.read_text() for path in sorted((ROOT / "src").glob("*.zig")))


def conformance_results() -> dict[str, bool]:
    sources = zig_test_names()
    return {
        prop: all(f'test "{name}"' in sources for name in names)
        for prop, names in CONFORMANCE.items()
    }


def run_runtime() -> None:
    # Any behavioral failure in the 79-test suite aborts before scoring.
    subprocess.run(["zig", "build", "test"], cwd=ROOT, check=True)
    subprocess.run(["zig", "build"], cwd=ROOT, check=True)
    proc = subprocess.run(
        [str(ROOT / "zig-out/bin/neuron"), "check", "--json"],
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=True,
    )
    payload = json.loads(proc.stdout)
    if payload != {
        "status": "ok", "committed": 3, "artifacts": 1,
        "messages": 1, "neurons": 1, "digest": payload["digest"],
    }:
        raise RuntimeError(f"unexpected CLI self-check payload: {payload}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--assert-win", action="store_true")
    args = parser.parse_args()
    run_runtime()
    baseline = baseline_results()
    witnessed = conformance_results()
    runtime_passed = sum(witnessed.values())
    baseline_passed = sum(baseline.values())
    result = {
        "metric": "AGENTS.md section-31 conformance properties witnessed by executable tests",
        "tasks": list(CONFORMANCE),
        "neuron": runtime_passed,
        "neuron_total": len(CONFORMANCE),
        "neuron_results": witnessed,
        "baseline": baseline_passed,
        "baseline_total": len(baseline),
        "baseline_results": baseline,
    }
    print(json.dumps(result, sort_keys=True))
    won = runtime_passed == len(CONFORMANCE) and runtime_passed > baseline_passed
    if args.assert_win and not won:
        missing = [prop for prop, ok in witnessed.items() if not ok]
        print(f"[runtime-bench] FAIL: unwitnessed conformance properties: {missing}", file=sys.stderr)
        return 1
    print(
        f"[runtime-bench] {'WIN' if won else 'HONEST NEGATIVE'}: "
        f"{runtime_passed}/{len(CONFORMANCE)} vs {baseline_passed}/{len(baseline)}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
