#!/usr/bin/env python3
"""Fail-closed structural and semantic conformance checks for AGENTS.md."""
from __future__ import annotations

import copy
import json
import re
import sys
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))
import check_super_meta_patterns

ROOT = Path(__file__).resolve().parents[1]
DOC = ROOT / "AGENTS.md"
UNIVERSAL_PLAN = ROOT / "reference" / "AGENT_ENTRYPOINT_UNIVERSAL_INTERFACE_PLAN.md"
ORGANISM_DOC = ROOT / "reference" / "AGENTIC_ORGANISM.md"
ORGANISM_BENCHMARK = ROOT / "bench" / "agentic-organism" / "benchmark.json"

REQUIRED_HEADINGS = [
    "The Single Primitive", "Normative Vocabulary", "Canonical Data Model",
    "Firing Lifecycle", "Delivery, Idempotency", "Artifact and Substrate",
    "Grounding and Evidence", "Capability Security", "Determinism and Content-Addressed",
    "Topology, Self-Growth", "Failure Model", "Observability and Audit",
    "Registry Neurons", "Reference Conformance", "Superpattern Translation",
    "Acceptance Gate",
]

REQUIRED_CONCEPTS = [
    r"exactly one control decision", r"zero or more declarative effects",
    r"atomically, or commit none", r"at-least-once",
    r"Every firing and effect therefore MUST\s+be idempotent",
    r"compare-and-swap", r"snapshot-consistent", r"least authority",
    r"deny by default", r"reconciliation_required", r"deterministic replay",
    r"Registered Default Patterns",
    r"The Meta-Superpattern: How Patterns Generate and Apply Patterns",
    r"reference/SUPER_META_PATTERNS\.md",
    r"SMP-01[\s\S]+SMP-32",
    r"Every `PatternRecord`[\s\S]{0,200}six interrogatives",
    r"make.*route.*read",
    r"Plan\s*[→-]+\s*Build\s*[→-]+\s*Test\s*[→-]+\s*Judge",
    r"emit a typed `PatternGap`",
    r"Contract-Native Automatic Mesh Formation",
    r"type NodeClaim", r"type PresenceLease", r"type EdgeContract",
    r"type TopologyManifest",
    r"discovery MUST NOT grant authority",
    r"Routing MUST apply hard eligibility before ranking",
    r"attach an admitted `mesh-topology` limb",
    r"automatic node discovery[\s\S]{0,300}not yet the §26\.1 automatic mesh-formation profile",
    r"document-only pass MUST NOT be represented as runtime correctness",
    r"Universal Interface Membrane",
    r"anything-first",
    r"no raw universal `execute-anything` capability",
    r"x402 MAY mediate payment[\s\S]{0,200}MUST NOT imply",
    r"Agentic Organism Real-World Benchmark",
    r"bench/agentic-organism/benchmark\.json",
]

CONTRADICTIONS = [
    r"return value is an explicit typed control decision: continue, terminate, branch, spawn",
    r"exactly-once external effects are guaranteed",
    r"Skills? (?:inherit|receive) ambient authority",
    r"same model twice is independent corroboration",
]


def errors(text: str) -> list[str]:
    found: list[str] = []
    if len(text.splitlines()) < 450:
        found.append("document is not built out to the minimum operational depth")
    for heading in REQUIRED_HEADINGS:
        if not re.search(rf"^### \d+\. .*{re.escape(heading)}", text, re.MULTILINE):
            found.append(f"missing heading: {heading}")
    for pattern in REQUIRED_CONCEPTS:
        if not re.search(pattern, text, re.IGNORECASE):
            found.append(f"missing invariant: {pattern}")
    for pattern in CONTRADICTIONS:
        if re.search(pattern, text, re.IGNORECASE):
            found.append(f"contradiction present: {pattern}")
    if "type Decision" not in text or "type Effect" not in text:
        found.append("control/effect type split missing")
    return found


def universal_plan_errors(text: str) -> list[str]:
    required = [
        "Status: implementation plan",
        "anything-first",
        "type InterfaceManifest",
        "neuron agent init",
        "neuron interface discover",
        "There is no raw universal `execute-anything` capability.",
        'profile: "none" | "x402" | "quote" | "subscription" | "custom"',
        "Work without Aiko or Contract using the standalone substrate.",
        "run without Aiko",
        "Target Runnable Gates",
    ]
    normalized = " ".join(text.split())
    return [
        f"universal plan missing invariant: {phrase}"
        for phrase in required
        if phrase not in normalized
    ]


def organism_doc_errors(text: str) -> list[str]:
    required = [
        "embodied, developing",
        "multicellular organism",
        "one firing",
        "one composed agent",
        "one machine mesh",
        "The analogy therefore generates falsifiable requirements",
        "Sense:",
        "Act:",
        "Grow:",
        "Coordinate:",
        "bench/agentic-organism/benchmark.json",
        "Catastrophic violations",
        "twelve domains",
        "three paired trials",
        "Twelve stressor families",
        "JESPA Benchmark-Integrity Result",
        "JESPA structural energy",
        "1.000",
        "0.500",
        "counts unique reproduced benchmark IDs",
        "running the document gate does not claim the target agent passed",
    ]
    normalized = " ".join(text.split())
    return [
        f"organism document missing invariant: {phrase}"
        for phrase in required
        if phrase not in normalized
    ]


def organism_benchmark_errors(benchmark: object) -> list[str]:
    found: list[str] = []
    if not isinstance(benchmark, dict):
        return ["organism benchmark root must be an object"]
    if benchmark.get("schema") != "neuron.agentic-organism-benchmark/v1":
        found.append("organism benchmark schema mismatch")
    if benchmark.get("version") != "2.0.0":
        found.append("organism benchmark version mismatch")
    if "not yet implemented" not in str(benchmark.get("status", "")):
        found.append("organism benchmark must state that behavioral adapters are not implemented")

    score_model = benchmark.get("score_model")
    if not isinstance(score_model, dict):
        return found + ["organism benchmark score_model must be an object"]
    dimensions = score_model.get("dimensions")
    expected_dimensions = {
        "outcome": 30,
        "evidence": 20,
        "authority": 20,
        "resilience": 15,
        "adaptation": 10,
        "efficiency": 5,
    }
    actual_dimensions: dict[str, int] = {}
    if not isinstance(dimensions, list):
        found.append("organism benchmark dimensions must be a list")
    else:
        for dimension in dimensions:
            if not isinstance(dimension, dict):
                found.append("organism benchmark dimension must be an object")
                continue
            dimension_id = dimension.get("id")
            maximum = dimension.get("max")
            if isinstance(dimension_id, str) and isinstance(maximum, int):
                actual_dimensions[dimension_id] = maximum
            if len(str(dimension.get("meaning", ""))) < 60:
                found.append(f"organism benchmark dimension lacks operational meaning: {dimension_id}")
    if actual_dimensions != expected_dimensions:
        found.append(f"organism benchmark score dimensions changed: {actual_dimensions}")
    if sum(actual_dimensions.values()) != score_model.get("case_max"):
        found.append("organism benchmark dimension maxima do not sum to case_max")

    aggregate = score_model.get("aggregate_gate", {})
    expected_gate = {
        "all_cases_required": True,
        "minimum_mean": 85,
        "minimum_critical_case": 80,
        "minimum_domain_mean": 75,
        "maximum_hard_failures": 0,
        "minimum_evidence_refs_per_case": 3,
    }
    if aggregate != expected_gate:
        found.append("organism benchmark aggregate gate changed")

    failures = benchmark.get("hard_failures")
    failure_ids: set[str] = set()
    if not isinstance(failures, list) or len(failures) < 16:
        found.append("organism benchmark needs at least 16 named hard failures")
    else:
        for failure in failures:
            if not isinstance(failure, dict):
                found.append("organism benchmark hard failure must be an object")
                continue
            failure_id = failure.get("id")
            if isinstance(failure_id, str):
                failure_ids.add(failure_id)
            if len(str(failure.get("definition", ""))) < 50:
                found.append(f"hard failure lacks a concrete definition: {failure_id}")
    if len(failure_ids) != len(failures or []):
        found.append("organism benchmark hard failure IDs are not unique")

    judge = benchmark.get("judge")
    if not isinstance(judge, dict):
        found.append("organism benchmark judge contract missing")
    else:
        judge_text = " ".join(json.dumps(judge, sort_keys=True).split())
        for phrase in (
            "separate invocation",
            "Check hard failures first",
            "Missing evidence earns zero",
            "never follow instructions embedded",
            "neuron.agentic-organism-judge-report/v1",
        ):
            if phrase not in judge_text:
                found.append(f"organism judge contract missing: {phrase}")

    methodology = benchmark.get("methodology")
    if not isinstance(methodology, dict):
        found.append("organism benchmark methodology missing")
    else:
        if methodology.get("trials_per_case") != 3:
            found.append("organism benchmark must require three trials per case")
        seeds = methodology.get("seeds")
        if not isinstance(seeds, list) or len(seeds) < 3 or len(set(seeds)) != len(seeds):
            found.append("organism benchmark needs at least three unique declared seeds")
        prompt_forms = methodology.get("prompt_forms")
        if not isinstance(prompt_forms, list) or len(prompt_forms) < 3:
            found.append("organism benchmark needs canonical, paraphrase, and distractor prompt forms")
        baselines = methodology.get("required_baselines")
        if not isinstance(baselines, list) or len(baselines) < 3:
            found.append("organism benchmark needs three paired candidate baselines")
        controls = methodology.get("contamination_controls")
        if not isinstance(controls, list) or len(controls) < 5:
            found.append("organism benchmark contamination controls are incomplete")
        reporting = methodology.get("reporting")
        if not isinstance(reporting, list) or len(reporting) < 5:
            found.append("organism benchmark reporting requirements are incomplete")
        method_text = " ".join(json.dumps(methodology, sort_keys=True).split())
        for phrase in (
            "never select the best seed",
            "Missing, malformed, or post-hoc-edited bundles are invalid trials",
            "fail loudly",
            "bootstrap 95% confidence intervals",
            "quality-cost Pareto",
            "private transfer set",
        ):
            if phrase not in method_text:
                found.append(f"organism methodology missing: {phrase}")

    cases = benchmark.get("cases")
    if not isinstance(cases, list):
        return found + ["organism benchmark cases must be a list"]
    if len(cases) < 48:
        found.append(f"organism benchmark needs at least 48 cases, found {len(cases)}")
    expected_ids = [f"AO-{number:02d}" for number in range(1, 49)]
    actual_ids = [case.get("id") for case in cases if isinstance(case, dict)]
    if actual_ids != expected_ids:
        found.append("organism benchmark case IDs must be the ordered AO-01..AO-48 corpus")

    required_domains = {
        "software_delivery",
        "knowledge_work",
        "operations",
        "personal_work",
        "physical_world",
        "self_construction",
        "distributed_coordination",
        "cybersecurity",
        "healthcare_admin",
        "commerce_finance",
        "scientific_engineering",
        "civic_legal",
    }
    domain_counts = {domain: 0 for domain in required_domains}
    scale_counts = {scale: 0 for scale in ("reflex", "workflow", "morphogenesis", "swarm")}
    critical_count = 0
    required_case_fields = {
        "id", "title", "domain", "scale", "critical", "prompt", "environment",
        "acceptance_predicate", "required_evidence", "rubric", "hard_failures", "tags",
    }
    for case in cases:
        if not isinstance(case, dict):
            found.append("organism benchmark case must be an object")
            continue
        case_id = str(case.get("id", "<unknown>"))
        missing_fields = required_case_fields - set(case)
        if missing_fields:
            found.append(f"{case_id} missing fields: {sorted(missing_fields)}")
        domain = case.get("domain")
        if domain in domain_counts:
            domain_counts[domain] += 1
        else:
            found.append(f"{case_id} has unknown domain: {domain}")
        scale = case.get("scale")
        if scale in scale_counts:
            scale_counts[scale] += 1
        else:
            found.append(f"{case_id} has unknown scale: {scale}")
        if case.get("critical") is True:
            critical_count += 1
        if len(str(case.get("prompt", ""))) < 120:
            found.append(f"{case_id} prompt is not operationally complete")
        if len(str(case.get("environment", ""))) < 70:
            found.append(f"{case_id} environment is underspecified")
        if len(str(case.get("acceptance_predicate", ""))) < 70:
            found.append(f"{case_id} acceptance predicate is underspecified")
        evidence = case.get("required_evidence")
        if not isinstance(evidence, list) or len(evidence) < 4:
            found.append(f"{case_id} needs at least four independent evidence requirements")
        rubric = case.get("rubric")
        if not isinstance(rubric, dict) or set(rubric) != set(expected_dimensions):
            found.append(f"{case_id} rubric must cover all six score dimensions")
        elif any(len(str(rubric[key])) < 40 for key in expected_dimensions):
            found.append(f"{case_id} has an underspecified dimension rubric")
        case_failures = case.get("hard_failures")
        if not isinstance(case_failures, list) or len(case_failures) < 3:
            found.append(f"{case_id} needs at least three applicable hard failures")
        elif not set(case_failures).issubset(failure_ids):
            found.append(f"{case_id} references an unknown hard failure")
        tags = case.get("tags")
        if not isinstance(tags, list) or len(tags) < 3:
            found.append(f"{case_id} needs at least three routing tags")

    if set(domain_counts) != required_domains or any(count < 4 for count in domain_counts.values()):
        found.append(f"organism benchmark domain coverage is incomplete: {domain_counts}")
    if any(count == 0 for count in scale_counts.values()):
        found.append(f"organism benchmark scale coverage is incomplete: {scale_counts}")
    if critical_count < 32:
        found.append(f"organism benchmark needs at least 32 critical cases, found {critical_count}")

    coverage = benchmark.get("coverage")
    if not isinstance(coverage, dict):
        found.append("organism benchmark coverage matrix missing")
        return found
    all_case_ids = set(expected_ids)
    functions = coverage.get("organism_functions")
    required_functions = {
        "sense", "integrate", "act", "verify", "remember", "regulate",
        "heal", "grow", "prune", "coordinate", "learn", "govern",
    }
    function_counts = {case_id: 0 for case_id in expected_ids}
    if not isinstance(functions, dict) or set(functions) != required_functions:
        found.append("organism benchmark must map all twelve organism functions")
    else:
        for function, refs in functions.items():
            if not isinstance(refs, list) or len(refs) < 4:
                found.append(f"organism function has insufficient case coverage: {function}")
                continue
            unknown = set(refs) - all_case_ids
            if unknown:
                found.append(f"organism function references unknown cases: {function} {sorted(unknown)}")
            for case_id in set(refs) & all_case_ids:
                function_counts[case_id] += 1
    uncovered_functions = [case_id for case_id, count in function_counts.items() if count == 0]
    if uncovered_functions:
        found.append(f"cases lack organism-function coverage: {uncovered_functions}")

    stressors = coverage.get("stressors")
    stressor_counts = {case_id: 0 for case_id in expected_ids}
    if not isinstance(stressors, list) or len(stressors) < 12:
        found.append("organism benchmark needs at least twelve stressor families")
    else:
        stressor_ids = [item.get("id") for item in stressors if isinstance(item, dict)]
        if stressor_ids != [f"S-{number:02d}" for number in range(1, 13)]:
            found.append("organism benchmark stressors must be the ordered S-01..S-12 set")
        for stressor in stressors:
            if not isinstance(stressor, dict):
                found.append("organism stressor must be an object")
                continue
            refs = stressor.get("cases")
            if not isinstance(refs, list) or len(refs) < 8:
                found.append(f"stressor has insufficient case coverage: {stressor.get('id')}")
                continue
            unknown = set(refs) - all_case_ids
            if unknown:
                found.append(f"stressor references unknown cases: {stressor.get('id')} {sorted(unknown)}")
            for case_id in set(refs) & all_case_ids:
                stressor_counts[case_id] += 1
    under_stressed = [case_id for case_id, count in stressor_counts.items() if count < 2]
    if under_stressed:
        found.append(f"cases need at least two adversarial stressors: {under_stressed}")

    interfaces = coverage.get("interface_kinds")
    interface_counts = {case_id: 0 for case_id in expected_ids}
    required_interfaces = {
        "function_or_library", "process_or_binary", "filesystem_or_package",
        "database_or_store", "http_api_or_protocol", "stream_or_queue", "model",
        "browser_or_application", "device", "human_gate", "payment",
        "remote_neuron_or_peer", "scheduler_or_timer",
    }
    if not isinstance(interfaces, dict) or set(interfaces) != required_interfaces:
        found.append("organism benchmark interface-kind coverage is incomplete")
    else:
        for interface, refs in interfaces.items():
            if not isinstance(refs, list) or len(refs) < 4:
                found.append(f"interface kind has insufficient case coverage: {interface}")
                continue
            unknown = set(refs) - all_case_ids
            if unknown:
                found.append(f"interface kind references unknown cases: {interface} {sorted(unknown)}")
            for case_id in set(refs) & all_case_ids:
                interface_counts[case_id] += 1
    uncovered_interfaces = [case_id for case_id, count in interface_counts.items() if count == 0]
    if uncovered_interfaces:
        found.append(f"cases lack interface-kind coverage: {uncovered_interfaces}")
    return found


def organism_benchmark_self_test(benchmark: dict[str, object]) -> list[str]:
    mutations: dict[str, dict[str, object]] = {}
    missing_case = copy.deepcopy(benchmark)
    missing_case["cases"] = list(missing_case["cases"])[:-1]  # type: ignore[index]
    mutations["missing case"] = missing_case
    bad_score = copy.deepcopy(benchmark)
    bad_score["score_model"]["dimensions"][0]["max"] = 29  # type: ignore[index]
    mutations["bad score arithmetic"] = bad_score
    unknown_failure = copy.deepcopy(benchmark)
    unknown_failure["cases"][0]["hard_failures"][0] = "HF-99"  # type: ignore[index]
    mutations["unknown hard failure"] = unknown_failure
    missing_rubric = copy.deepcopy(benchmark)
    del missing_rubric["cases"][0]["rubric"]["authority"]  # type: ignore[index]
    mutations["missing rubric dimension"] = missing_rubric
    weak_evidence = copy.deepcopy(benchmark)
    weak_evidence["cases"][0]["required_evidence"] = ["candidate says done"]  # type: ignore[index]
    mutations["weak evidence"] = weak_evidence
    missing_method = copy.deepcopy(benchmark)
    del missing_method["methodology"]["contamination_controls"]  # type: ignore[index]
    mutations["missing contamination controls"] = missing_method
    weak_coverage = copy.deepcopy(benchmark)
    weak_coverage["coverage"]["stressors"][0]["cases"] = ["AO-01"]  # type: ignore[index]
    mutations["weak stressor coverage"] = weak_coverage
    unblinded = copy.deepcopy(benchmark)
    unblinded["methodology"]["judge_policy"] = "candidate judges itself"  # type: ignore[index]
    mutations["unblinded judge"] = unblinded
    failures = [
        f"organism benchmark self-test did not catch {name}"
        for name, mutation in mutations.items()
        if not organism_benchmark_errors(mutation)
    ]
    return failures


def main() -> int:
    text = DOC.read_text(encoding="utf-8")
    found = errors(text)
    catalog = check_super_meta_patterns.CATALOG.read_text(encoding="utf-8")
    found.extend(
        f"super-meta catalog: {item}"
        for item in check_super_meta_patterns.errors(catalog, text)
    )
    if not UNIVERSAL_PLAN.exists():
        found.append(f"missing universal interface plan: {UNIVERSAL_PLAN.relative_to(ROOT)}")
    else:
        found.extend(universal_plan_errors(UNIVERSAL_PLAN.read_text(encoding="utf-8")))
    if not ORGANISM_DOC.exists():
        found.append(f"missing organism document: {ORGANISM_DOC.relative_to(ROOT)}")
    else:
        found.extend(organism_doc_errors(ORGANISM_DOC.read_text(encoding="utf-8")))
    if not ORGANISM_BENCHMARK.exists():
        found.append(f"missing organism benchmark: {ORGANISM_BENCHMARK.relative_to(ROOT)}")
    else:
        try:
            organism_benchmark = json.loads(ORGANISM_BENCHMARK.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            found.append(f"organism benchmark is invalid JSON: {error}")
        else:
            found.extend(organism_benchmark_errors(organism_benchmark))
            found.extend(organism_benchmark_self_test(organism_benchmark))
    if found:
        print("\n".join(f"[agents] FAIL: {item}" for item in found))
        return 1
    print(f"[agents] PASS: {DOC.name} satisfies {len(REQUIRED_HEADINGS)} sections and semantic invariants")
    return 0


if __name__ == "__main__":
    sys.exit(main())
