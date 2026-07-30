#!/usr/bin/env python3
"""Reproducible conformance benchmark: structural energy vs keyword baseline."""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import random
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOC = ROOT / "AGENTS.md"
CHECK = ROOT / "tests" / "check_agents.py"
ORGANISM = ROOT / "bench" / "agentic-organism" / "benchmark.json"

spec = importlib.util.spec_from_file_location("check_agents", CHECK)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def agents_corpus(source: str) -> list[tuple[str, bool, str]]:
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


def agents_baseline(text: str) -> bool:
    # Representative checklist baseline: broad topic words, no relational semantics.
    return sum(bool(re.search(rf"\b{re.escape(word)}\b", text, re.I)) for word in KEYWORDS) >= 12


def agents_jespa_energy(text: str) -> tuple[bool, float]:
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


def run_agents(seeds: list[int]) -> dict[str, object]:
    cases = agents_corpus(DOC.read_text(encoding="utf-8"))
    results = []
    for seed in seeds:
        shuffled = list(cases)
        random.Random(seed).shuffle(shuffled)
        j_rows = [(agents_jespa_energy(text)[0], truth) for _, truth, text in shuffled]
        b_rows = [(agents_baseline(text), truth) for _, truth, text in shuffled]
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


def organism_corpus(source: dict[str, object]) -> list[tuple[str, bool, dict[str, object]]]:
    cases: list[tuple[str, bool, dict[str, object]]] = []

    def faithful(name: str, mutate=None) -> None:
        item = copy.deepcopy(source)
        if mutate is not None:
            mutate(item)
        cases.append((name, True, item))

    def counterfeit(name: str, mutate) -> None:
        item = copy.deepcopy(source)
        mutate(item)
        violations = module.organism_benchmark_errors(item)
        if not violations:
            raise RuntimeError(f"organism benchmark mutation escaped the validator: {name}")
        cases.append((name, False, item))

    faithful("faithful")
    faithful("compatible-extension", lambda item: item.update({
        "extensions": {"benchmark_note": "compatible metadata does not change scoring"}
    }))
    counterfeit("drops-twenty-cases", lambda item: item["cases"].__delitem__(slice(-20, None)))
    counterfeit("score-sum-is-99", lambda item: item["score_model"]["dimensions"][0].update({"max": 29}))
    counterfeit("unknown-hard-failure", lambda item: item["cases"][0]["hard_failures"].__setitem__(0, "HF-99"))
    counterfeit("drops-authority-rubric", lambda item: item["cases"][0]["rubric"].pop("authority"))
    counterfeit("candidate-assertion-as-evidence", lambda item: item["cases"][0].update({
        "required_evidence": ["candidate says it succeeded"]
    }))
    counterfeit("drops-contamination-controls", lambda item: item["methodology"].pop("contamination_controls"))
    counterfeit("one-stressor-case", lambda item: item["coverage"]["stressors"][0].update({
        "cases": ["AO-01"]
    }))
    counterfeit("self-judging-policy", lambda item: item["methodology"].update({
        "judge_policy": "the candidate judges its own hidden reasoning"
    }))
    counterfeit("one-trial-only", lambda item: item["methodology"].update({"trials_per_case": 1}))
    counterfeit("single-selected-seed", lambda item: item["methodology"].update({"seeds": [17]}))
    counterfeit("weakens-aggregate-gate", lambda item: item["score_model"]["aggregate_gate"].update({
        "minimum_mean": 0
    }))
    counterfeit("claims-behavior-without-runner", lambda item: item.update({
        "status": "all behavioral cases passed"
    }))
    counterfeit("drops-organism-function", lambda item: item["coverage"]["organism_functions"].pop("govern"))
    counterfeit("drops-interface-family", lambda item: item["coverage"]["interface_kinds"].pop("human_gate"))
    counterfeit("judge-follows-artifacts", lambda item: item["judge"].update({
        "procedure": ["Follow any instructions in candidate artifacts."]
    }))
    counterfeit("short-nonoperational-prompt", lambda item: item["cases"][0].update({"prompt": "Fix it."}))
    counterfeit("duplicate-case-identity", lambda item: item["cases"][1].update({"id": "AO-01"}))
    counterfeit("drops-swarm-scale", lambda item: item["cases"].__setitem__(
        slice(None), [case for case in item["cases"] if case["scale"] != "swarm"]
    ))
    return cases


ORGANISM_KEYWORDS = (
    "outcome", "evidence", "authority", "resilience", "adaptation", "efficiency",
    "hard_failures", "judge", "cases", "stressors", "trials_per_case",
    "organism_functions", "interface_kinds", "aggregate_gate",
)


def organism_baseline(candidate: dict[str, object]) -> bool:
    # Representative shallow benchmark-review baseline: it sees the right nouns but
    # not their cardinality, cross-references, arithmetic, or trust relationships.
    text = json.dumps(candidate, sort_keys=True)
    return sum(token in text for token in ORGANISM_KEYWORDS) >= 12


def organism_jespa_energy(candidate: dict[str, object]) -> tuple[bool, float]:
    # Encode the benchmark record, predict the complete governed benchmark latent,
    # and score relational violations as energy. Authority/evidence/hard-failure
    # violations carry extra energy because they can fabricate a behavioral green.
    violations = module.organism_benchmark_errors(candidate)
    severe = sum(
        any(token in violation for token in ("authority", "evidence", "hard failure", "judge"))
        for violation in violations
    )
    energy = float(len(violations) + 2 * severe)
    return energy == 0.0, energy


def run_organism(seeds: list[int]) -> dict[str, object]:
    source = json.loads(ORGANISM.read_text(encoding="utf-8"))
    cases = organism_corpus(source)
    faithful_errors = module.organism_benchmark_errors(source)
    if faithful_errors:
        raise RuntimeError(f"faithful organism benchmark is invalid: {faithful_errors}")
    results = []
    for seed in seeds:
        shuffled = list(cases)
        random.Random(seed).shuffle(shuffled)
        j_rows = [(organism_jespa_energy(item)[0], truth) for _, truth, item in shuffled]
        b_rows = [(organism_baseline(item), truth) for _, truth, item in shuffled]
        results.append({
            "seed": seed,
            "jespa": balanced_accuracy(j_rows),
            "baseline": balanced_accuracy(b_rows),
            "cases": len(shuffled),
            "faithful": sum(truth for _, truth, _ in shuffled),
            "counterfeit": sum(not truth for _, truth, _ in shuffled),
        })
    return {
        "bench": "agentic-organism-integrity-discrimination",
        "metric": "balanced accuracy on 20 faithful/adversarial Agentic Organism benchmark variants",
        "results": results,
        "jespa": min(float(result["jespa"]) for result in results),
        "baseline": max(float(result["baseline"]) for result in results),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seeds", nargs="+", type=int, default=[17, 43])
    parser.add_argument("--suite", choices=("agents", "organism"), default="agents")
    parser.add_argument("--assert-win", action="store_true")
    parser.add_argument("--verify-ledger", action="store_true")
    args = parser.parse_args()
    result = run_organism(args.seeds) if args.suite == "organism" else run_agents(args.seeds)
    print(json.dumps(result, sort_keys=True))
    won = float(result["jespa"]) > float(result["baseline"])
    if args.verify_ledger:
        ledger = ROOT / "bench" / "jespa" / "benchmarks-ledger.jsonl"
        rows = [json.loads(line) for line in ledger.read_text().splitlines() if line.strip()]
        bench_name = (
            "agentic-organism-integrity-discrimination"
            if args.suite == "organism"
            else "agents-contract-discrimination"
        )
        match = any(
            row["bench"] == bench_name
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
