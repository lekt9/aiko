#!/usr/bin/env python3
"""Reproducible conformance benchmark: structural energy vs keyword baseline."""
from __future__ import annotations

import argparse
import importlib.util
import json
import random
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOC = ROOT / "AGENTS.md"
CHECK = ROOT / "tests" / "check_agents.py"

spec = importlib.util.spec_from_file_location("check_agents", CHECK)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def corpus(source: str) -> list[tuple[str, bool, str]]:
    cases = [
        ("faithful", True, source),
        ("format-only", True, source.replace("**MUST**", "**MUST** ")),
        ("drops-atomicity", False, source.replace("atomically, or commit none", "in implementation-defined groups")),
        ("claims-exactly-once", False, source + "\nExactly-once external effects are guaranteed.\n"),
        ("ambient-skill-authority", False, source + "\nSkills inherit ambient authority.\n"),
        ("fake-independent-witness", False, source + "\nThe same model twice is independent corroboration.\n"),
        ("drops-deny-default", False, source.replace("deny by default", "allow by default")),
        ("drops-idempotency", False, source.replace(
            "Every firing and effect therefore MUST\nbe idempotent",
            "Firings need not\nbe repeat-safe")),
        ("drops-cas", False, source.replace("compare-and-swap", "last-writer-wins")),
        ("drops-reconciliation", False, source.replace("reconciliation_required", "automatically_retried")),
        ("conflates-doc-runtime", False, source.replace(
            "a document-only pass MUST NOT be represented as runtime correctness",
            "a document-only pass proves runtime correctness")),
        ("old-exclusive-union", False, source + (
            "\nThe return value is an explicit typed control decision: continue, terminate, "
            "branch, spawn new Neurons, write artifacts, or send a message.\n")),
    ]
    for name, truth, text in cases:
        if name not in {"faithful", "format-only"} and text == source:
            raise RuntimeError(f"benchmark harness mutation was a no-op: {name}")
    return cases


KEYWORDS = (
    "Neuron", "Caps", "stimulus", "spawn", "write", "send", "evidence", "cache",
    "substrate", "capability", "artifact", "message", "typed", "stateless",
)


def baseline(text: str) -> bool:
    # Representative checklist baseline: broad topic words, no relational semantics.
    return sum(bool(re.search(rf"\b{re.escape(word)}\b", text, re.I)) for word in KEYWORDS) >= 12


def jespa_energy(text: str) -> tuple[bool, float]:
    # Encode intended contract features, predict the valid-document latent (all zero
    # violations), then rank by weighted violation energy. Contradictions cost more.
    violations = module.errors(text)
    contradiction_count = sum("contradiction" in item for item in violations)
    energy = float(len(violations) + 2 * contradiction_count)
    return energy == 0.0, energy


def balanced_accuracy(rows: list[tuple[bool, bool]]) -> float:
    pos = [pred == truth for pred, truth in rows if truth]
    neg = [pred == truth for pred, truth in rows if not truth]
    return ((sum(pos) / len(pos)) + (sum(neg) / len(neg))) / 2


def run(seeds: list[int]) -> dict[str, object]:
    cases = corpus(DOC.read_text(encoding="utf-8"))
    results = []
    for seed in seeds:
        shuffled = list(cases)
        random.Random(seed).shuffle(shuffled)
        j_rows = [(jespa_energy(text)[0], truth) for _, truth, text in shuffled]
        b_rows = [(baseline(text), truth) for _, truth, text in shuffled]
        results.append({
            "seed": seed,
            "jespa": balanced_accuracy(j_rows),
            "baseline": balanced_accuracy(b_rows),
            "cases": len(shuffled),
        })
    return {
        "metric": "balanced accuracy on faithful/adversarial AGENTS variants",
        "results": results,
        "jespa": min(float(r["jespa"]) for r in results),
        "baseline": max(float(r["baseline"]) for r in results),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seeds", nargs="+", type=int, default=[17, 43])
    parser.add_argument("--assert-win", action="store_true")
    parser.add_argument("--verify-ledger", action="store_true")
    args = parser.parse_args()
    result = run(args.seeds)
    print(json.dumps(result, sort_keys=True))
    won = float(result["jespa"]) > float(result["baseline"])
    if args.verify_ledger:
        ledger = ROOT / "bench" / "jespa" / "benchmarks-ledger.jsonl"
        rows = [json.loads(line) for line in ledger.read_text().splitlines() if line.strip()]
        match = any(
            row["bench"] == "agents-contract-discrimination"
            and row["jespa"] == result["jespa"]
            and row["baseline"] == result["baseline"]
            and row["won"] == won
            for row in rows
        )
        if not match:
            print("[benchmark] FAIL: live result does not match ledger", file=sys.stderr)
            return 1
    if args.assert_win and not won:
        print("[benchmark] FAIL: structural energy did not beat baseline", file=sys.stderr)
        return 1
    print(f"[benchmark] {'WIN' if won else 'HONEST NEGATIVE'}: {result['jespa']:.3f} vs {result['baseline']:.3f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
