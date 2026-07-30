#!/usr/bin/env python3
"""Compile sequential phases of parallel work into one Contract skill DAG."""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import re
import sys
from pathlib import Path


def safe(value: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return value or "task"


def contract_library_candidates() -> list[str]:
    sibling_lib = Path(__file__).resolve().parents[2] / "contract/libcontract/zig-out/lib"
    return [
        item for item in (
            os.environ.get("AIKO_CONTRACT_LIBRARY"),
            str(Path.home() / ".aiko/lib/libcontract.dylib"),
            str(Path.home() / ".aiko/lib/libcontract.so"),
            str(sibling_lib / "libcontract.dylib"),
            str(sibling_lib / "libcontract.so"),
        )
        if item
    ]


def validate_effect_evidence(evidence: dict) -> bool:
    failures = []
    for candidate in contract_library_candidates():
        try:
            library = ctypes.CDLL(candidate)
            validate = library.contract_validate_effect_evidence_json
            validate.argtypes = [ctypes.c_char_p]
            validate.restype = ctypes.c_ubyte
            return validate(json.dumps(evidence, separators=(",", ":")).encode()) == 0
        except (AttributeError, OSError) as error:
            failures.append(f"{candidate}: {error}")
    raise RuntimeError("native Contract effect validator unavailable; " + "; ".join(failures))


def compile_internal_system(spec: dict) -> dict:
    """Ask the native Contract substrate to compile a loop/funnel system."""
    failures = []
    for candidate in contract_library_candidates():
        try:
            library = ctypes.CDLL(candidate)
            compile_native = library.contract_compile_internal_system_json
            compile_native.argtypes = [ctypes.c_char_p]
            compile_native.restype = ctypes.c_void_p
            library.contract_free.argtypes = [ctypes.c_void_p]
            pointer = compile_native(json.dumps(spec, separators=(",", ":")).encode())
            if not pointer:
                raise ValueError("Contract rejected the internal-system specification")
            try:
                compiled = json.loads(ctypes.string_at(pointer))
            finally:
                library.contract_free(pointer)
            for loop in compiled["output_schema"]["x-contract-system"]["feedback_loops"]:
                evidence = {"effect": loop["effect"], **loop["antiparticle"]}
                if not validate_effect_evidence(evidence):
                    raise RuntimeError("Contract emitted an incomplete antiparticle profile")
            return compiled
        except ValueError:
            raise
        except (AttributeError, OSError) as error:
            failures.append(f"{candidate}: {error}")
    raise RuntimeError(
        "native Contract internal-system compiler unavailable; "
        + "; ".join(failures)
    )


def compile_workflow(spec: dict) -> dict:
    if spec.get("kind") == "contract_internal_system" or "loops" in spec:
        return compile_internal_system(spec)
    phases = spec.get("phases")
    if not isinstance(phases, list) or not phases:
        raise ValueError("phases must be a non-empty array")
    nodes: list[dict] = []
    previous: list[str] = []
    for phase_index, phase in enumerate(phases):
        tasks = phase.get("tasks") if isinstance(phase, dict) else None
        if not isinstance(tasks, list) or not tasks:
            raise ValueError(f"phase {phase_index + 1} tasks must be non-empty")
        current: list[str] = []
        for task_index, task in enumerate(tasks):
            if not isinstance(task, dict) or not str(task.get("prompt", "")).strip():
                raise ValueError("every task requires a prompt")
            key = f"p{phase_index + 1}-{safe(str(task.get('id') or task.get('description') or task_index + 1))}"
            if any(node["key"] == key for node in nodes):
                key = f"{key}-{task_index + 1}"
            bindings = {
                f"previous_{i + 1}": f"{dependency}.result"
                for i, dependency in enumerate(previous)
            }
            prompt = str(task["prompt"]).replace(
                "{{prev}}",
                "{{inputs}}",
            )
            nodes.append({
                "key": key,
                "plan": prompt,
                "worker": task.get("worker", "aiko"),
                "depends_on": previous,
                "input_bindings": bindings,
                "can_parallel": len(tasks) > 1,
                "timeout_ms": int(task.get("timeout_ms", 120000)),
                "effect": task.get("effect", "read_only"),
                "reversible": bool(task.get("reversible", False)),
                "read_only": task.get("effect", "read_only") == "read_only",
                "requires_authority": bool(task.get("requires_authority", False)),
                "evidence": task.get("evidence", ["result"]),
            })
            current.append(key)
        previous = current
    if len(nodes) > 16:
        raise ValueError("compiled Contract graph exceeds 16 nodes")
    workflow_id = safe(str(spec.get("id", "generated-workflow")))
    return {
        "schema_version": 1,
        "id": workflow_id,
        "version": str(spec.get("version", "1.0.0")),
        "description": str(spec.get("description", "Contract-native compiled workflow")),
        "platforms": ["all"],
        "triggers": spec.get("triggers", [workflow_id.replace("-", " ")]),
        "input_schema": {"type": "object"},
        "output_schema": {"type": "object"},
        "nodes": nodes,
        "examples": [],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("-o", "--output", type=Path)
    args = parser.parse_args()
    try:
        result = compile_workflow(json.loads(args.input.read_text()))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"workflow compile failed: {error}", file=sys.stderr)
        return 2
    rendered = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(rendered)
    else:
        print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
