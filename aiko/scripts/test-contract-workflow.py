#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("workflow", ROOT / "scripts/contract_workflow.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

workflow = module.compile_workflow({
    "id": "port-witness",
    "phases": [
        {"tasks": [
            {"id": "research-a", "prompt": "research A"},
            {"id": "research-b", "prompt": "research B"},
        ]},
        {"tasks": [{"id": "synthesize", "prompt": "synthesize {{prev}}"}]},
    ],
})
nodes = {node["key"]: node for node in workflow["nodes"]}
assert nodes["p1-research-a"]["depends_on"] == []
assert nodes["p1-research-b"]["can_parallel"] is True
synthesis = nodes["p2-synthesize"]
assert synthesis["depends_on"] == ["p1-research-a", "p1-research-b"]
assert synthesis["input_bindings"] == {
    "previous_1": "p1-research-a.result",
    "previous_2": "p1-research-b.result",
}
assert "{{prev}}" not in synthesis["plan"] and "{{inputs}}" in synthesis["plan"]
try:
    module.compile_workflow({"phases": [{"tasks": []}]})
except ValueError:
    pass
else:
    raise AssertionError("empty phase accepted")

system = module.compile_workflow({
    "kind": "contract_internal_system",
    "id": "agent-tool-flywheel",
    "purpose": "Improve an internal agent tool from grounded use",
    "authority": "identity:owner",
    "evidence_policy": "policy:independent-tool-evidence",
    "recurrence": {"trigger": "when:tool-event", "max_occurrences": 32},
    "interface_hooks": ["cli", "mcp", "tui"],
    "loops": [
        {
            "scale": scale,
            "action": {"prompt": f"{scale} action", "effect": "local_write", "reversible": True},
            "sensor": {"prompt": f"observe {scale} consequence"},
            "evaluator": {"prompt": f"evaluate {scale} evidence"},
        }
        for scale in ("micro", "meso", "macro", "global")
    ],
})
system_nodes = {node["key"]: node for node in system["nodes"]}
system_meta = system["output_schema"]["x-contract-system"]
assert system_meta["compiler"] == "libcontract"
assert system_meta["interface_hooks"] == ["cli", "mcp", "tui"]
assert len(system_nodes) == 12
assert len(system_meta["feedback_loops"]) == 4
assert len(system_meta["funnels"]) == 3
assert system_meta["occurrence_policy"] == {
    "trigger": "when:tool-event",
    "max_occurrences": 32,
    "graph_reentry": False,
}
for scale in ("micro", "meso", "macro", "global"):
    action = system_nodes[f"{scale}-action"]
    sensor = system_nodes[f"{scale}-sensor"]
    evaluator = system_nodes[f"{scale}-evaluator"]
    assert sensor["depends_on"] == [action["key"]]
    assert evaluator["depends_on"] == [sensor["key"]]
    assert sensor["read_only"] and evaluator["read_only"]
    assert "agency:role=action" in action["evidence"]
    assert "agency:role=sensor" in sensor["evidence"]
    assert "agency:role=evaluator" in evaluator["evidence"]
    assert "positron:sensor=postcondition_snapshot" in sensor["evidence"]
    assert "positron:evaluator=goal_postcondition" in evaluator["evidence"]
assert system_nodes["meso-action"]["input_bindings"] == {
    "lower_scale_evidence": "micro-evaluator.result"
}
assert system_meta["governance"]["development_changes_require_new_version"] is True
assert system_meta["feedback_loops"][0]["antiparticle"] == {
    "approval_class": "declared_authority",
    "sensor_evidence": [
        "positron:sensor=postcondition_snapshot",
        "positron:sensor=state_diff",
    ],
    "evaluator_evidence": [
        "positron:evaluator=goal_postcondition",
        "positron:evaluator=independent_check",
    ],
}
message_evidence = {
    "effect": "external_message",
    "approval_class": "outbound_message",
    "sensor_evidence": [
        "positron:sensor=provider_acknowledgement",
        "positron:sensor=message_identity",
        "positron:sensor=delivery_state",
    ],
    "evaluator_evidence": [
        "positron:evaluator=intended_recipient",
        "positron:evaluator=intended_payload",
        "positron:evaluator=delivery_not_goal_progress",
    ],
}
assert module.validate_effect_evidence(message_evidence)
message_evidence["sensor_evidence"].remove("positron:sensor=delivery_state")
assert not module.validate_effect_evidence(message_evidence)

for invalid in (
    {**system, "purpose": ""},
    {
        "kind": "contract_internal_system",
        "purpose": "x", "authority": "a", "evidence_policy": "e",
        "recurrence": {"trigger": "event", "max_occurrences": 0},
        "loops": [],
    },
    {
        "kind": "contract_internal_system",
        "purpose": "x", "authority": "a", "evidence_policy": "e",
        "recurrence": {"trigger": "event", "max_occurrences": 2},
        "loops": [{
            "scale": "global",
            "action": {"prompt": "a"}, "sensor": {"prompt": "s"}, "evaluator": {"prompt": "e"},
        }],
    },
):
    try:
        module.compile_internal_system(invalid)
    except ValueError:
        pass
    else:
        raise AssertionError("invalid internal system accepted")

print(json.dumps({
    "workflow_nodes": len(nodes),
    "parallel": 2,
    "bound_inputs": 2,
    "system_nodes": len(system_nodes),
    "feedback_loops": len(system_meta["feedback_loops"]),
    "funnels": len(system_meta["funnels"]),
}))
