#!/usr/bin/env python3
"""CHECK A analyzer — is the PRINCIPLE discoverable at the moment of need?

Input is `aiko inspect --json` output: the binary's OWN resolution of this
directory, not a directory listing. The question this answers is not "does the
file exist" (witness-self-integrate-skill.sh already settles that) but "of the
N skills aiko resolves here, would the credential-handover prompt select THIS
one".

There is no skill-selection dry-run verb on the binary — `aiko --help` lists
agent/background/completions/contract-pair/dashboard/export/help/inspect/
leader/login/logout/mcp/memory/models/native/plugin/sessions/setup/tasks/trace/
update/version/worktree/wrap, and `aiko inspect --help` offers only --json —
so the honest proxy is: rank aiko's own resolved corpus with a standard
retrieval function and require self-integrate to come first. BM25 (k1=1.5,
b=0.75) is used unmodified, with no per-skill weighting, because a scoring
function tuned until the intended skill wins proves only that it was tuned.

Subject is a FILE PATH so the gate's falsification leg can point the identical
checks at a mutated corpus.

    select-skill.py <inspect.json> <prompt-shapes.json> <expected-skill-path>

Exits 0 printing evidence lines, or 1 printing "CHECK_A FAIL: ..." — the
gate greps for that name, so a red leg must be caught by the check that owns
the claim, not by an unrelated crash.
"""

from __future__ import annotations

import json
import math
import re
import sys

K1 = 1.5
B = 0.75


def die(message: str) -> None:
    print(f"CHECK_A FAIL: {message}")
    sys.exit(1)


def tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower())


def bm25_rank(skills: list[dict], query: str) -> list[tuple[float, str]]:
    """Rank every resolved skill against one prompt. Standard BM25, no tuning."""
    docs = [(s.get("name") or "", tokens(f"{s.get('name') or ''} {s.get('description') or ''}")) for s in skills]
    n = len(docs)
    df: dict[str, int] = {}
    for _, terms in docs:
        for term in set(terms):
            df[term] = df.get(term, 0) + 1
    avgdl = sum(len(terms) for _, terms in docs) / n
    query_terms = set(tokens(query))
    scored: list[tuple[float, str]] = []
    for name, terms in docs:
        tf: dict[str, int] = {}
        for term in terms:
            tf[term] = tf.get(term, 0) + 1
        score = 0.0
        for term in query_terms:
            if term not in df:
                continue
            idf = math.log((n - df[term] + 0.5) / (df[term] + 0.5) + 1)
            freq = tf.get(term, 0)
            score += idf * (freq * (K1 + 1)) / (freq + K1 * (1 - B + B * len(terms) / avgdl))
        scored.append((score, name))
    # Ties broken by name so the ranking is a total order: two skills with the
    # same score must not swap places between runs.
    scored.sort(key=lambda pair: (-pair[0], pair[1]))
    return scored


def main() -> None:
    if len(sys.argv) != 4:
        die("usage: select-skill.py <inspect.json> <prompt-shapes.json> <expected-skill-path>")
    inspect_path, shapes_path, expected_path = sys.argv[1:4]

    try:
        with open(inspect_path, encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception as error:  # noqa: BLE001 - any unreadable corpus is the same failure
        die(f"could not parse `aiko inspect --json` output at {inspect_path}: {error}")
    with open(shapes_path, encoding="utf-8") as handle:
        shapes = json.load(handle)

    skills = data.get("skills")
    if not isinstance(skills, list) or len(skills) < 2:
        die(f"aiko resolved no usable skill corpus ({type(skills).__name__}) — nothing to select from")

    hits = [s for s in skills if s.get("name") == "self-integrate"]
    if not hits:
        die(
            "aiko does not resolve 'self-integrate' in this directory "
            f"({len(skills)} skills resolved) — the principle is invisible at the moment of need"
        )
    if len(hits) > 1:
        die(f"'self-integrate' resolved {len(hits)} times — an ambiguous corpus selects unpredictably")
    skill = hits[0]

    source = skill.get("source") or {}
    if source.get("path") != expected_path:
        die(f"resolved path {source.get('path')!r} != {expected_path!r}")
    if source.get("type") != "project":
        die(f"resolved scope {source.get('type')!r}, expected 'project'")
    description = (skill.get("description") or "").strip()
    if not description:
        die("resolved entry carries no description — there is nothing to select on")

    # (A1) the description must name the shapes a handover actually arrives in.
    low = description.lower()
    missing = [t for t in shapes["triggers"] if t.lower() not in low]
    if missing:
        die(f"description lacks trigger phrase(s) {missing!r} — the handover prompt would not match it")
    print(f"EVIDENCE[CHECK_A/triggers]: all {len(shapes['triggers'])} trigger phrases present in the resolved description")

    # (A2) among everything aiko resolves here, the handover prompt selects it.
    for prompt in shapes["prompts"]:
        ranking = bm25_rank(skills, prompt["text"])
        top_score, top_name = ranking[0]
        runner_score, runner_name = ranking[1]
        rank = next(i for i, (_, name) in enumerate(ranking, start=1) if name == "self-integrate")
        if top_name != "self-integrate":
            die(
                f"prompt {prompt['id']!r} selects {top_name!r} (score {top_score:.2f}); "
                f"self-integrate ranks #{rank} of {len(ranking)} — it would not be read at the moment of need"
            )
        margin = top_score / runner_score if runner_score > 0 else float("inf")
        print(
            f"EVIDENCE[CHECK_A/select]: {prompt['id']:<16} rank 1 of {len(ranking)} "
            f"(bm25 {top_score:.2f}; runner-up {runner_name} {runner_score:.2f}; x{margin:.2f})"
        )

    print(
        f"EVIDENCE[CHECK_A]: aiko {data.get('grokVersion', '?')} resolves self-integrate "
        f"(scope={source.get('type')}) among {len(skills)} skills in {data.get('cwd')}, "
        f"and it is the top-ranked skill for every credential-handover prompt shape"
    )


if __name__ == "__main__":
    main()
