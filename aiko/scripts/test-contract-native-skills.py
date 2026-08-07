#!/usr/bin/env python3
"""Deterministic, dependency-free checks for Aiko contract-native bundles."""

from __future__ import annotations

import copy
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Discovery is structural: every contract-skill.json under .agents/skills/
# crosses the gate. Adding a skill must require zero new harness entries —
# an enumerated name list is a blind spot for the next package.
SKILL_DIRS = sorted(
    manifest_path.parent
    for manifest_path in (ROOT / ".agents" / "skills").glob("*/contract-skill.json")
)
EFFECTS = {
    "read_only", "local_reversible", "local_write", "external_message",
    "purchase", "job_application", "credential_access", "delete", "publish",
    "permission_change", "account_mutation", "process_spawn",
}
HOST_ADAPTERS = {
    "aiko.meta.observe/v1",
    "aiko.meta.recall/v1",
    "aiko.meta.route/v1",
    "aiko.meta.settle/v1",
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
        worker = node.get("worker")
        adapter = node.get("adapter")
        if worker not in {"aiko", "host", "tool", "script"}:
            return "worker"
        if node.get("effect") != "read_only" and not any(
            node.get(flag) for flag in ("requires_authority", "reversible", "read_only")
        ):
            return "laundered-effect"
        script = node.get("script")
        if worker == "aiko" and (adapter is not None or script is not None):
            return "aiko-implementation"
        if worker == "host" and (adapter not in HOST_ADAPTERS or script is not None):
            return "host-adapter"
        if worker == "tool":
            return "unpinned-tool"
        if worker == "script" and adapter != "aiko.neuron-json-stdio/v1":
            return "script-adapter"
        if worker == "script":
            if (
                node.get("effect") != "local_reversible"
                or node.get("read_only")
                or not node.get("reversible")
            ):
                return "script-caps"
            if not isinstance(script, str) or not script:
                return "script-path"
            path = Path(script)
            if path.is_absolute() or ".." in path.parts or not (directory / path).is_file():
                return "script-path"
        elif script is not None:
            return "script-worker"
        graph[key] = node.get("depends_on", [])
        if any(dependency not in keys or dependency == key for dependency in graph[key]):
            return "dependency"
        bindings = node.get("input_bindings", {})
        if not isinstance(bindings, dict):
            return "input-bindings"
        for source in bindings.values():
            if not isinstance(source, str) or "." not in source:
                return "input-binding"
            dependency, output = source.split(".", 1)
            if dependency not in graph[key] or not output:
                return "input-binding-dependency"
        for list_field in ("writes", "capabilities", "research"):
            value = node.get(list_field, [])
            if not isinstance(value, list) or not all(
                isinstance(scope, str) for scope in value
            ):
                return f"node-{list_field}"
        witness = node.get("witness")
        if witness is not None and not isinstance(witness, str):
            return "node-witness"
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
    activation = manifest.get("activation", "matched")
    composition = manifest.get("composition")
    if activation == "core":
        if not isinstance(composition, dict):
            return "core-composition"
        attach = composition.get("attach_children_at")
        join = composition.get("join_children_at")
        if attach == join or attach not in graph or join not in graph:
            return "core-ports"
        def reaches(key: str, target: str, seen: set[str]) -> bool:
            if key == target:
                return True
            if key in seen:
                return False
            seen.add(key)
            return any(reaches(dependency, target, seen) for dependency in graph[key])
        if not reaches(join, attach, set()):
            return "core-port-order"
    elif activation != "matched" or composition is not None:
        return "activation"
    return None


def main() -> int:
    assert SKILL_DIRS, "no contract-native skill packages discovered"
    manifests = []
    for directory in SKILL_DIRS:
        name = directory.name
        manifest = json.loads((directory / "contract-skill.json").read_text())
        assert manifest["id"] == name
        assert reject(manifest, directory) is None
        assert (directory / "SKILL.md").is_file()
        assert (directory / "agents" / "openai.yaml").is_file()
        cases = json.loads((directory / "tests" / "cases.json").read_text())
        assert cases and manifest["examples"]
        for case in cases:
            assert case["prompt"]
            if name == "aiko-meta-agent":
                assert case["expect"]["core"] == name
                continue
            assert case["expect"]["selected"] == name
            held = {
                node["effect"] for node in manifest["nodes"]
                if node.get("requires_authority")
            }
            assert set(case["expect"]["held_effects"]).issubset(held)
        manifests.append((manifest, directory))

    base, directory = next(
        item for item in manifests if item[0]["id"] == "aiko-meta-agent"
    )
    attacks = []
    bad = copy.deepcopy(base); bad["version"] = "latest"; attacks.append((bad, directory))
    bad = copy.deepcopy(base); bad["nodes"][0]["depends_on"] = [bad["nodes"][0]["key"]]; attacks.append((bad, directory))
    bad = copy.deepcopy(base); bad["nodes"][0]["effect"] = "purchase"; bad["nodes"][0]["read_only"] = False; attacks.append((bad, directory))
    bad = copy.deepcopy(base); bad["nodes"][0].update(worker="script", adapter="aiko.neuron-json-stdio/v1", script="../../steal"); attacks.append((bad, directory))
    bad = copy.deepcopy(base); bad["nodes"][0]["effect"] = "unknown"; attacks.append((bad, directory))
    bad = copy.deepcopy(base); bad["nodes"][0]["input_bindings"] = {"stolen": "missing.result"}; attacks.append((bad, directory))
    bad = copy.deepcopy(base); bad["nodes"][0].update(worker="host", adapter="unknown/v1"); attacks.append((bad, directory))
    bad = copy.deepcopy(base); bad["nodes"][0].update(worker="tool", adapter=None); attacks.append((bad, directory))
    script_manifest, script_directory = next(
        item for item in manifests if item[0]["id"] == "contract-interface"
    )
    bad = copy.deepcopy(script_manifest)
    script_node = next(node for node in bad["nodes"] if node["worker"] == "script")
    script_node.update(effect="read_only", read_only=True, reversible=False)
    attacks.append((bad, script_directory))
    bad = copy.deepcopy(script_manifest)
    script_node = next(node for node in bad["nodes"] if node["worker"] == "script")
    script_node.pop("script", None)
    attacks.append((bad, script_directory))
    assert all(reject(attack, attack_directory) is not None for attack, attack_directory in attacks)

    print(f"validated {len(manifests)} contract-native skills and {len(attacks)} adversarial cases")
    return 0


if __name__ == "__main__":
    sys.exit(main())
