#!/usr/bin/env python3
"""Generate Aiko's bundled contract-native reference skill fixtures."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / ".agents" / "skills"


def node(
    key: str,
    plan: str,
    *,
    worker: str = "aiko",
    depends_on: list[str] | None = None,
    effect: str = "read_only",
    read_only: bool = True,
    reversible: bool = False,
    authority: bool = False,
    evidence: list[str] | None = None,
    input_bindings: dict[str, str] | None = None,
    writes: list[str] | None = None,
) -> dict:
    return {
        "key": key,
        "plan": plan,
        "worker": worker,
        "depends_on": depends_on or [],
        "input_bindings": input_bindings or {},
        "can_parallel": not depends_on,
        "timeout_ms": 30_000,
        "effect": effect,
        "read_only": read_only,
        "reversible": reversible,
        "requires_authority": authority,
        "evidence": evidence or ["structured_result"],
        "writes": writes or [],
    }


SPECS: dict[str, dict] = {
    "inspect-project": {
        "description": "Inspect bounded Git and project metadata without reading secrets or mutating files.",
        "triggers": ["inspect project", "git status", "repository state", "project structure"],
        "steps": [
            "Inspect bounded repository and toolchain metadata.",
            "Run independent read-only probes in parallel.",
            "Return structured evidence; never infer success from prose.",
        ],
        "nodes": [
            node("git-state", "Inspect bounded Git branch, status, and recent history for {{goal}}.", worker="host"),
            node("project-shape", "Inspect bounded non-hidden project structure and toolchain markers for {{goal}}.", worker="host"),
            node("summarize", "Merge project inspection evidence for {{goal}}.", depends_on=["git-state", "project-shape"]),
        ],
        "prompt": "Please inspect project and show the git status.",
    },
    "build-and-test-project": {
        "description": "Detect a project toolchain and run bounded builds and tests with exact exit evidence.",
        "triggers": ["build project", "run tests", "test project", "compile project"],
        "steps": [
            "Compose with inspect-project to identify the toolchain.",
            "Prepare exact build and test commands before execution.",
            "Run safe independent checks concurrently and report exit evidence.",
        ],
        "nodes": [
            node("detect", "Use inspect-project evidence to detect the toolchain for {{goal}}."),
            node("build", "Run the declared bounded build for {{goal}}.", worker="tool", depends_on=["detect"], effect="local_write", read_only=False, reversible=True),
            node("test", "Run the declared bounded tests for {{goal}}.", worker="tool", depends_on=["detect"], effect="local_write", read_only=False, reversible=True),
            node("verify", "Verify build and test exit evidence for {{goal}}.", depends_on=["build", "test"]),
        ],
        "prompt": "Build project and run tests.",
    },
    "transform-local-files": {
        "description": "Preview and apply explicitly scoped, reversible local file transformations.",
        "triggers": ["transform files", "edit files", "rewrite file", "rename files"],
        "steps": [
            "Resolve only explicitly scoped files.",
            "Prepare and display a bounded diff.",
            "Apply with local-write authority and verify the resulting diff.",
        ],
        "nodes": [
            node("scope", "Resolve explicitly scoped non-sensitive files for {{goal}}.", worker="host"),
            node("preview", "Prepare a reversible patch preview for {{goal}}.", depends_on=["scope"]),
            node("apply", "Apply the approved local file transformation for {{goal}}.", worker="tool", depends_on=["preview"], effect="local_reversible", read_only=False, reversible=True, authority=True),
            node("verify", "Verify the post-edit state and rollback metadata for {{goal}}.", depends_on=["apply"]),
        ],
        "prompt": "Transform files in this explicitly scoped fixture.",
    },
    "observe-desktop": {
        "description": "Observe privacy-safe application identity and explicitly requested desktop visuals.",
        "triggers": ["observe desktop", "foreground application", "running applications", "take screenshot"],
        "steps": [
            "Read application identity only; exclude titles, contents, and keystrokes.",
            "Capture a visual only when explicitly requested.",
            "Return sanitized platform-neutral evidence.",
        ],
        "nodes": [
            node("applications", "Observe privacy-safe foreground and running application identity for {{goal}}.", worker="host"),
            node("visual", "Prepare an explicitly requested desktop visual for {{goal}}.", worker="host"),
            node("verify", "Verify desktop evidence contains no title, content, keystroke, or credential payload.", depends_on=["applications", "visual"]),
        ],
        "prompt": "Observe desktop foreground application.",
    },
    "schedule-follow-up": {
        "description": "Interpret explicit cadence and create deduplicated governed future contracts.",
        "triggers": ["remind me", "schedule follow-up", "every day", "every week", "tomorrow"],
        "steps": [
            "Parse only explicit deadlines or cadence.",
            "Create a held proposal when durable authority is absent.",
            "Deduplicate and re-check authority when each occurrence fires.",
        ],
        "nodes": [
            node("parse-cadence", "Parse explicit deadline and recurrence semantics for {{goal}}."),
            node(
                "deduplicate",
                "Check equivalent durable future contracts for {{goal}}.",
                depends_on=["parse-cadence"],
                input_bindings={"cadence": "parse-cadence.structured_result"},
            ),
            node(
                "schedule",
                "Create the governed future contract for {{goal}}.",
                depends_on=["deduplicate"],
                input_bindings={"deduplication": "deduplicate.structured_result"},
                effect="local_reversible",
                read_only=False,
                reversible=True,
                writes=["workspace://**"],
            ),
        ],
        "prompt": "Remind me tomorrow to check the build.",
    },
    "apply-standing-rule": {
        "description": "Turn explicit trigger-action preferences into governed durable Contract rules.",
        "triggers": ["whenever", "from now on", "always when", "every time"],
        "steps": [
            "Separate trigger, preparation, effect, and verification.",
            "Classify authority from the effect rather than confidence.",
            "Store no task-, person-, media-, or application-specific defaults.",
        ],
        "nodes": [
            node("parse-rule", "Parse the explicit standing rule in {{goal}}."),
            node("classify-effect", "Classify effect scope and durable authority for {{goal}}.", depends_on=["parse-rule"]),
            node("register-rule", "Register the governed standing rule for {{goal}}.", worker="host", depends_on=["classify-effect"], effect="local_reversible", read_only=False, reversible=True, authority=True),
        ],
        "prompt": "Whenever tests fail, prepare a diagnostic summary.",
    },
    "act-on-web-api": {
        "description": "Resolve and execute indexed Unbrowse, HTTP API, or browser capabilities with governed effects.",
        "triggers": [
            "web api",
            "unbrowse",
            "website action",
            "fetch website",
            "api route",
            "take over my browser",
            "browser automation",
            "download from website",
        ],
        "steps": [
            "Resolve an indexed route when available; otherwise use admitted browser automation.",
            "Prepare structured parameters and redact credentials.",
            "Gate account mutation, publication, and other consequential effects.",
        ],
        "nodes": [
            node("resolve-route", "Resolve a cached Unbrowse, API, or browser route for {{goal}}."),
            node("prepare-request", "Prepare sanitized structured API parameters for {{goal}}.", depends_on=["resolve-route"]),
            node("execute-request", "Execute the governed API or browser request for {{goal}}.", depends_on=["prepare-request"], effect="account_mutation", read_only=False, reversible=True),
            node("verify-response", "Verify response status and declared output shape for {{goal}}.", depends_on=["execute-request"]),
        ],
        "prompt": "Use a web API route to update the fixture account.",
    },
    "send-notification": {
        "description": "Prepare outbound notifications and send only with applicable durable authority.",
        "triggers": ["send notification", "notify me", "message me", "send message"],
        "steps": [
            "Resolve a channel-specific child skill.",
            "Prepare content without sending.",
            "Require explicit or durable outbound-message authority before delivery.",
        ],
        "nodes": [
            node("resolve-channel", "Resolve an available notification channel for {{goal}}."),
            node("prepare-message", "Prepare a bounded notification payload for {{goal}}.", depends_on=["resolve-channel"]),
            node("send-message", "Send the authorized notification for {{goal}}.", worker="tool", depends_on=["prepare-message"], effect="external_message", read_only=False, authority=True),
            node("delivery-evidence", "Verify channel delivery evidence for {{goal}}.", depends_on=["send-message"]),
        ],
        "prompt": "Send notification to the local mock channel.",
    },
    "control-local-media": {
        "description": "Resolve, preview, and control explicitly selected local media through platform adapters.",
        "triggers": ["play media", "play song", "open image", "local media", "playlist"],
        "steps": [
            "Resolve only local, non-sensitive media metadata.",
            "Preview the selected asset before action.",
            "Use the platform child implementation only when enabled.",
        ],
        "nodes": [
            node("resolve-media", "Resolve explicitly selected local media for {{goal}}.", worker="host"),
            node("preview-media", "Prepare media metadata preview for {{goal}}.", depends_on=["resolve-media"]),
            node("control-media", "Invoke the enabled platform media adapter for {{goal}}.", worker="tool", depends_on=["preview-media"], effect="local_reversible", read_only=False, reversible=True, authority=True),
        ],
        "prompt": "Play media from the local fixture.",
    },
    "issue-to-patch": {
        "description": "Turn a repository issue into a narrow verified patch while holding publication.",
        "triggers": ["fix issue", "implement issue", "issue to patch", "prepare pull request"],
        "steps": [
            "Compose project inspection, file transformation, and build/test skills.",
            "Make the narrowest evidence-backed patch.",
            "Prepare commits or pull requests but hold publication without authority.",
        ],
        "nodes": [
            node("inspect", "Inspect the issue and repository integration points for {{goal}}."),
            node("patch", "Prepare and apply the narrow verified patch for {{goal}}.", depends_on=["inspect"], effect="local_reversible", read_only=False, reversible=True, authority=True),
            node("test", "Run focused regression checks for {{goal}}.", worker="tool", depends_on=["patch"], effect="local_write", read_only=False, reversible=True),
            node("prepare-publication", "Prepare commit or pull-request metadata for {{goal}}.", depends_on=["test"]),
            node("publish", "Publish the authorized commit or pull request for {{goal}}.", worker="tool", depends_on=["prepare-publication"], effect="publish", read_only=False, authority=True),
        ],
        "prompt": "Fix issue 123 and prepare a pull request.",
    },
}


def skill_markdown(name: str, spec: dict) -> str:
    steps = "\n".join(f"{index}. {step}" for index, step in enumerate(spec["steps"], 1))
    return f"""---
name: {name}
description: {spec["description"]} Use when the user request matches this workflow or explicitly names ${name}.
---

# {name.replace("-", " ").title()}

Materialize this workflow through `contract-skill.json`; do not bypass Contract
with an untracked action.

{steps}

Read `contract-skill.json` for the executable graph, effects, evidence, and
examples. Treat consequential nodes as preparation-only until Contract reports
applicable authority. A direct user request is applicable task authority for
actions within its stated scope. Settle completion only from observed evidence.
"""


def manifest(name: str, spec: dict) -> dict:
    return {
        "schema_version": 1,
        "id": name,
        "version": "1.0.0",
        "description": spec["description"],
        "platforms": ["all"],
        "triggers": spec["triggers"],
        "input_schema": {"type": "object", "additionalProperties": True},
        "output_schema": {"type": "object", "additionalProperties": True},
        "nodes": spec["nodes"],
        "examples": [
            {
                "name": "default",
                "prompt": spec["prompt"],
                "expect": {
                    "selected": name,
                    "root_count": 1,
                    "held_effects": [
                        item["effect"]
                        for item in spec["nodes"]
                        if item["requires_authority"]
                    ],
                },
            }
        ],
    }


def main() -> None:
    for name, spec in SPECS.items():
        directory = SKILLS / name
        tests = directory / "tests"
        tests.mkdir(parents=True, exist_ok=True)
        (directory / "SKILL.md").write_text(skill_markdown(name, spec))
        data = manifest(name, spec)
        (directory / "contract-skill.json").write_text(
            json.dumps(data, indent=2, sort_keys=True) + "\n"
        )
        (tests / "cases.json").write_text(
            json.dumps(data["examples"], indent=2, sort_keys=True) + "\n"
        )


if __name__ == "__main__":
    main()
