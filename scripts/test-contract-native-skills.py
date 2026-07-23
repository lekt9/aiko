#!/usr/bin/env python3
"""Deterministic, dependency-free checks for Aiko contract-native bundles."""

from __future__ import annotations

import copy
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NAMES = (
    "inspect-project",
    "build-and-test-project",
    "transform-local-files",
    "observe-desktop",
    "schedule-follow-up",
    "apply-standing-rule",
    "act-on-web-api",
    "send-notification",
    "control-local-media",
    "issue-to-patch",
    "contract-interface",
)
EFFECTS = {
    "read_only", "local_reversible", "local_write", "external_message",
    "purchase", "job_application", "credential_access", "delete", "publish",
    "permission_change", "account_mutation",
}


def reject(manifest: dict, directory: Path) -> str | None:
    if manifest.get("schema_version") != 1:
        return "schema"
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", str(manifest.get("id", ""))):
        return "id"
    if not re.fullmatch(r"\d+\.\d+\.\d+", str(manifest.get("version", ""))):
        return "version"
    nodes = manifest.get("nodes")
    if not isinstance(nodes, list) or not 1 <= len(nodes) <= 16:
        return "nodes"
    keys = [node.get("key") for node in nodes]
    if len(keys) != len(set(keys)):
        return "duplicate"
    graph = {}
    for node in nodes:
        key = node.get("key")
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", str(key or "")):
            return "node-key"
        if node.get("effect") not in EFFECTS:
            return "effect"
        if node.get("worker") not in {"aiko", "host", "tool", "script"}:
            return "worker"
        if node.get("effect") != "read_only" and not any(
            node.get(flag) for flag in ("requires_authority", "reversible", "read_only")
        ):
            return "laundered-effect"
        script = node.get("script")
        if script:
            path = Path(script)
            if path.is_absolute() or ".." in path.parts or not (directory / path).is_file():
                return "script-path"
        graph[key] = node.get("depends_on", [])
        if any(dependency not in keys or dependency == key for dependency in graph[key]):
            return "dependency"
    visiting, visited = set(), set()
    def walk(key: str) -> bool:
        if key in visited:
            return True
        if key in visiting:
            return False
        visiting.add(key)
        if not all(walk(dependency) for dependency in graph[key]):
            return False
        visiting.remove(key)
        visited.add(key)
        return True
    if not all(walk(key) for key in graph):
        return "cycle"
    return None


def main() -> int:
    manifests = []
    for name in NAMES:
        directory = ROOT / ".agents" / "skills" / name
        manifest = json.loads((directory / "contract-skill.json").read_text())
        assert manifest["id"] == name
        assert reject(manifest, directory) is None
        assert (directory / "SKILL.md").is_file()
        assert (directory / "agents" / "openai.yaml").is_file()
        cases = json.loads((directory / "tests" / "cases.json").read_text())
        assert cases and manifest["examples"]
        for case in cases:
            assert case["prompt"]
            assert case["expect"]["selected"] == name
            held = {
                node["effect"] for node in manifest["nodes"]
                if node.get("requires_authority")
            }
            assert set(case["expect"]["held_effects"]).issubset(held)
        manifests.append((manifest, directory))

    base, directory = manifests[0]
    attacks = []
    bad = copy.deepcopy(base); bad["version"] = "latest"; attacks.append(bad)
    bad = copy.deepcopy(base); bad["nodes"][0]["depends_on"] = [bad["nodes"][0]["key"]]; attacks.append(bad)
    bad = copy.deepcopy(base); bad["nodes"][0]["effect"] = "purchase"; bad["nodes"][0]["read_only"] = False; attacks.append(bad)
    bad = copy.deepcopy(base); bad["nodes"][0].update(worker="script", script="../../steal"); attacks.append(bad)
    bad = copy.deepcopy(base); bad["nodes"][0]["effect"] = "unknown"; attacks.append(bad)
    assert all(reject(attack, directory) is not None for attack in attacks)

    print(f"validated {len(manifests)} contract-native skills and {len(attacks)} adversarial cases")
    return 0


if __name__ == "__main__":
    sys.exit(main())
