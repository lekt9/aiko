#!/usr/bin/env python3
"""Fail closed when the super-meta catalog loses shape, coverage, or honesty."""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "reference" / "SUPER_META_PATTERNS.md"
AGENTS = ROOT / "AGENTS.md"

PATTERN_IDS = [f"SMP-{number:02d}" for number in range(1, 34)]
REQUIRED_FIELDS = [
    "Version",
    "Trigger",
    "Why",
    "What",
    "Who",
    "When",
    "Where",
    "How",
    "Trust boundary",
    "Lifecycle",
    "Relates",
    "Falsifier",
    "Sources",
    "Status",
]
ALLOWED_STATUSES = {
    "implemented",
    "partial",
    "normative-unimplemented",
    "implemented locally; distributed projection partial",
    "implemented locally; mesh-wide routing unimplemented",
    "normative-unimplemented beyond address-directed transport",
    "normative-unimplemented as an automatic runtime Neuron; document registry implemented",
    "implemented as design discipline",
}
ATOMS = ["root", "node", "tree", "verb", "settle", "witness", "cache", "seal", "walk", "loop"]


def numbered_part_one_sections(agents: str) -> set[str]:
    part_one = agents.split("## Part II", 1)[0]
    whole = {match.group(1) for match in re.finditer(r"^### (\d+)\.", part_one, re.MULTILINE)}
    subsections = {
        match.group(1)
        for match in re.finditer(r"^#### (\d+\.\d+)\b", part_one, re.MULTILINE)
    }
    return whole | subsections


def pattern_blocks(text: str) -> dict[str, str]:
    matches = list(re.finditer(r"^### (SMP-\d{2}) — .+$", text, re.MULTILINE))
    blocks: dict[str, str] = {}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else text.find("\n## 5.", match.end())
        if end < 0:
            end = len(text)
        blocks[match.group(1)] = text[match.start():end]
    return blocks


def errors(catalog: str, agents: str) -> list[str]:
    found: list[str] = []
    blocks = pattern_blocks(catalog)
    expected = set(PATTERN_IDS)
    actual = set(blocks)
    for missing in sorted(expected - actual):
        found.append(f"missing pattern record: {missing}")
    for extra in sorted(actual - expected):
        found.append(f"unexpected pattern record: {extra}")
    if len(blocks) != len(PATTERN_IDS):
        found.append(f"expected {len(PATTERN_IDS)} unique pattern records, found {len(blocks)}")

    for pattern_id in PATTERN_IDS:
        block = blocks.get(pattern_id)
        if block is None:
            continue
        for field in REQUIRED_FIELDS:
            if not re.search(rf"^- \*\*{re.escape(field)}:\*\* .+", block, re.MULTILINE):
                found.append(f"{pattern_id} missing field: {field}")
        status = re.search(r"^- \*\*Status:\*\* (.+)$", block, re.MULTILINE)
        if status and status.group(1).rstrip(".") not in ALLOWED_STATUSES:
            found.append(f"{pattern_id} has unknown status: {status.group(1)}")
        sources = re.search(r"^- \*\*Sources:\*\* (.+)$", block, re.MULTILINE)
        if sources and not any(token in sources.group(1) for token in ("AGENTS.md", "reference/", "src/", "tests/", "limbs/", "IMPLEMENTATION.md", "$jesus-pattern:", "bench/")):
            found.append(f"{pattern_id} has no concrete repository source")
        if pattern_id not in agents:
            found.append(f"{pattern_id} is not registered in AGENTS.md")

    atom_table = catalog.split("## 3.", 1)[0]
    for atom in ATOMS:
        if not re.search(rf"^\| {atom} \|", atom_table, re.MULTILINE):
            found.append(f"missing atom translation: {atom}")

    coverage_rows = {
        match.group(1): match.group(2)
        for match in re.finditer(r"^\| §(\d+(?:\.\d+)?) \| ([^|]+) \|$", catalog, re.MULTILINE)
    }
    normative = numbered_part_one_sections(agents)
    for section in sorted(normative, key=lambda value: tuple(map(int, value.split(".")))):
        ids = coverage_rows.get(section)
        if ids is None:
            found.append(f"normative section lacks catalog coverage: §{section}")
            continue
        if not re.search(r"SMP-\d{2}", ids):
            found.append(f"normative section has empty catalog coverage: §{section}")
    for section in sorted(set(coverage_rows) - normative):
        found.append(f"coverage row is not a current Part I section: §{section}")
    covered_patterns = {
        pattern_id
        for ids in coverage_rows.values()
        for pattern_id in re.findall(r"SMP-\d{2}", ids)
    }
    for pattern_id in sorted(expected - covered_patterns):
        found.append(f"pattern has no normative section coverage: {pattern_id}")

    for pattern_id, block in blocks.items():
        relates = re.search(r"^- \*\*Relates:\*\* (.+)$", block, re.MULTILINE)
        if relates is None:
            continue
        relation_ids = set(re.findall(r"SMP-\d{2}", relates.group(1)))
        if not relation_ids:
            found.append(f"{pattern_id} has no catalog relation")
        if pattern_id in relation_ids:
            found.append(f"{pattern_id} relates to itself")
        for unknown in sorted(relation_ids - expected):
            found.append(f"{pattern_id} relates to unknown pattern: {unknown}")

    required_phrases = [
        "complete relative to the normative architecture corpus",
        "PatternGap",
        "Plan → Build → Test → Judge",
        "Current Residual Frontier",
        "document pass proves catalog integrity only",
    ]
    normalized_catalog = " ".join(catalog.split())
    for phrase in required_phrases:
        if phrase not in normalized_catalog:
            found.append(f"missing honesty/meta invariant: {phrase}")
    return found


def checker_self_test(catalog: str, agents: str) -> list[str]:
    """Prove the checker rejects representative damage, not only this snapshot."""
    mutations = {
        "missing record": catalog.replace("### SMP-32 —", "### REMOVED-32 —", 1),
        "missing six-interrogative field": catalog.replace("- **Why:**", "- **Removed-why:**", 1),
        "invalid implementation status": catalog.replace("- **Status:** implemented.", "- **Status:** imaginary.", 1),
        "missing atom": catalog.replace("| root |", "| removed-root |", 1),
    }
    failures: list[str] = []
    for name, mutated_catalog in mutations.items():
        if not errors(mutated_catalog, agents):
            failures.append(f"checker self-test did not catch {name}")
    expanded_agents = agents.replace(
        "\n---\n\n### Summary",
        "\n#### 17.4 Newly Unmapped Pattern\n\nDeliberate checker mutation.\n\n---\n\n### Summary",
        1,
    )
    if not errors(catalog, expanded_agents):
        failures.append("checker self-test did not catch an uncovered normative subsection")
    return failures


def main() -> int:
    catalog = CATALOG.read_text(encoding="utf-8")
    agents = AGENTS.read_text(encoding="utf-8")
    found = errors(catalog, agents)
    found.extend(checker_self_test(catalog, agents))
    if found:
        print("\n".join(f"[super-meta] FAIL: {item}" for item in found))
        return 1
    print(
        f"[super-meta] PASS: {len(PATTERN_IDS)} patterns, "
        f"{len(numbered_part_one_sections(agents))} normative sections, "
        f"{len(ATOMS)} atoms, 5 mutation guards"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
