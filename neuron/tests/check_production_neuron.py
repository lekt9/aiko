#!/usr/bin/env python3
"""Fail closed when production drifts from the canonical Typed Neuron package."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
UNBROWSE = ROOT.parent
CONTRACT = UNBROWSE / "contract/libcontract"
AIKO = UNBROWSE / "aiko"


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def main() -> int:
    errors: list[str] = []
    wire = (ROOT / "src/wire.zig").read_text()
    runtime = (ROOT / "src/runtime.zig").read_text()
    types = (ROOT / "src/types.zig").read_text()
    caps = (ROOT / "src/caps.zig").read_text()
    neuron = (ROOT / "src/neuron.zig").read_text()
    contract_neuron = (CONTRACT / "src/neuron.zig").read_text()
    settle = (CONTRACT / "src/skill_execution/settle.zig").read_text()
    bridge = (
        AIKO / "crates/codegen/xai-grok-shell/src/contract_native/neuron_bridge.rs"
    ).read_text()
    aiko_contract = (
        AIKO / "crates/codegen/xai-grok-shell/src/contract_native.rs"
    ).read_text()
    tool_calls = (
        AIKO
        / "crates/codegen/xai-grok-shell/src/session/acp_session_impl/tool_calls.rs"
    ).read_text()
    contract_abi = (CONTRACT / "src/c_abi.zig").read_text()

    require("pub const Neuron = struct" in wire, "canonical package does not own Neuron.fire", errors)
    require(
        "pub fn runtimeDecisionDigest" in wire,
        "canonical package does not own standalone decision identity",
        errors,
    )
    require(
        not re.search(r"pub const (Control|Effect|Decision|Stimulus) = (union|struct)", types),
        "standalone types still redefine the canonical contract",
        errors,
    )
    require(
        "pub const Caps = core.Caps" in caps and "pub const Neuron = core.Neuron" in neuron,
        "standalone runtime is not fully imported from typed_neuron",
        errors,
    )
    require(
        "pub fn decisionDigest" not in runtime,
        "standalone runtime still owns a second decision digest",
        errors,
    )
    require(
        "mod typed_neuron_wire;" in bridge
        and not re.search(r"struct Neuron(FireRequest|Decision|Stimulus|Caps|Effect|Evidence)", bridge),
        "Aiko still hand-maintains canonical wire DTOs",
        errors,
    )
    require(
        "decision: NeuronDecision" in bridge,
        "Aiko settlement does not carry the Neuron-produced canonical decision",
        errors,
    )
    require(
        "struct FiredNeuronSkillNode" in aiko_contract
        and "decision: Option<NeuronDecision>" in aiko_contract
        and "execute_neuron_skill_adapter" in aiko_contract,
        "Aiko production execution still returns only an adapter verdict",
        errors,
    )
    require(
        "appendRowsAtomic" in settle,
        "Contract settlement does not atomically publish firing and settlement rows",
        errors,
    )
    transaction_at = settle.find("appendRowsAtomic")
    artifact_cache_at = settle.find("artifact.put", transaction_at)
    require(
        transaction_at >= 0
        and artifact_cache_at > transaction_at
        and "evidence_payload" in settle,
        "Contract materializes an artifact before its authoritative decision transaction",
        errors,
    )
    require(
        "pub const validate = core.validate" in contract_neuron
        and "pub const decisionDigest = core.decisionDigest" in contract_neuron,
        "Contract no longer delegates pure semantics to typed_neuron",
        errors,
    )
    require(
        (CONTRACT / "typed-neuron.lock.json").is_file(),
        "Contract has no content pin for its local typed_neuron dependency",
        errors,
    )
    lock_path = CONTRACT / "typed-neuron.lock.json"
    if lock_path.is_file():
        lock = json.loads(lock_path.read_text())
        schema = json.loads((ROOT / "schema/typed-neuron-wire.json").read_text())
        schema_bytes = json.dumps(
            schema, sort_keys=True, separators=(",", ":")
        ).encode()
        hasher = hashlib.sha256()
        package_files = lock.get("package_files", [])
        for name in package_files:
            content = (
                schema_bytes
                if name == "schema/typed-neuron-wire.json"
                else (ROOT / name).read_bytes()
            )
            encoded_name = name.encode()
            hasher.update(len(encoded_name).to_bytes(8, "big"))
            hasher.update(encoded_name)
            hasher.update(len(content).to_bytes(8, "big"))
            hasher.update(content)
        require(
            package_files
            and lock.get("package_digest") == hasher.hexdigest()
            and lock.get("schema_digest") == hashlib.sha256(schema_bytes).hexdigest(),
            "Contract typed_neuron content pin does not match the imported package",
            errors,
        )
    require(
        "contract_neuron_effect_settle_json" in contract_abi
        and "neuron_effect_settle" in bridge
        and "settle_tool_effect" in bridge,
        "external adapters do not acknowledge the canonical outbox",
        errors,
    )
    bind_at = tool_calls.find("bind_active_tool_contract(")
    dispatch_at = tool_calls.find("dispatch_tool(")
    require(
        bind_at >= 0 and dispatch_at >= 0 and bind_at < dispatch_at,
        "Aiko dispatches tools before the canonical Neuron membrane",
        errors,
    )
    require(
        aiko_contract.find("admit_tool_effect(")
        < aiko_contract.find("Some(ActiveToolContract"),
        "Aiko authorizes an effect without first committing its canonical decision",
        errors,
    )
    require(
        'SCRIPT_RUNNER_SANDBOX, "read-only"' in aiko_contract
        and 'sandbox != "read-only"' in aiko_contract,
        "admitted script Neurons can perform effects before returning a decision",
        errors,
    )

    if errors:
        for error in errors:
            print(f"[production-neuron] FAIL: {error}")
        return 1
    print("[production-neuron] structural conformance checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
