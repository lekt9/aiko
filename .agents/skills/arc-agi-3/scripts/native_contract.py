"""Minimal ctypes adapter for the installed Contract FECH/fractal-EBM ABI."""

from __future__ import annotations

import ctypes
import json
import os
import platform
from datetime import datetime, timezone
from pathlib import Path


def library_path() -> Path:
    if override := os.environ.get("AIKO_CONTRACT_LIBRARY"):
        return Path(override).expanduser()
    name = "contract.dll" if os.name == "nt" else "libcontract.dylib" if platform.system() == "Darwin" else "libcontract.so"
    candidates = [
        Path.home() / ".aiko/lib" / name,
        Path(__file__).resolve().parents[5] / "contract/libcontract/zig-out/lib" / name,
    ]
    return next((path for path in candidates if path.is_file()), candidates[0])


class NativeContract:
    VERSION = "arc-action-v1"

    def __init__(self, path: Path | None = None) -> None:
        self.path = (path or library_path()).resolve()
        self.lib = ctypes.CDLL(str(self.path))
        self.lib.contract_abi_version.restype = ctypes.c_uint32
        self.lib.contract_register_capabilities.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
        self.lib.contract_register_capabilities.restype = ctypes.c_void_p
        self.lib.contract_recommend_plan.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint32]
        self.lib.contract_recommend_plan.restype = ctypes.c_void_p
        self.lib.contract_record_capability_observation.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
        self.lib.contract_record_capability_observation.restype = ctypes.c_void_p
        if hasattr(self.lib, "contract_muscle_observe"):
            self.lib.contract_muscle_observe.argtypes = [
                ctypes.c_char_p,
                ctypes.c_char_p,
                ctypes.c_char_p,
                ctypes.c_char_p,
                ctypes.c_double,
            ]
            self.lib.contract_muscle_observe.restype = ctypes.c_bool
            self.lib.contract_muscle_recall.argtypes = [ctypes.c_char_p]
            self.lib.contract_muscle_recall.restype = ctypes.c_void_p
            self.lib.contract_muscle_predict.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
            self.lib.contract_muscle_predict.restype = ctypes.c_void_p
            if hasattr(self.lib, "contract_muscle_rank_json"):
                self.lib.contract_muscle_rank_json.argtypes = [
                    ctypes.c_char_p,
                    ctypes.c_char_p,
                    ctypes.c_char_p,
                    ctypes.c_uint32,
                ]
                self.lib.contract_muscle_rank_json.restype = ctypes.c_void_p
        self.lib.contract_free.argtypes = [ctypes.c_void_p]
        self.abi_version = int(self.lib.contract_abi_version())
        if self.abi_version not in (2, 3, 4, 5, 6):
            raise RuntimeError(f"unsupported Contract ABI {self.abi_version}")

    def _take(self, pointer: int | None):
        if not pointer:
            return None
        try:
            return json.loads(ctypes.string_at(pointer).decode("utf-8"))
        finally:
            self.lib.contract_free(pointer)

    @staticmethod
    def capability_id(action: int) -> str:
        return f"aiko-arc.action.{int(action)}"

    @staticmethod
    def click_capability_id(label: str) -> str:
        safe = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in label.lower()).strip("-")
        return f"aiko-arc.click.{safe or 'object'}"

    def register_candidates(self, candidates: list[dict]):
        descriptors = []
        for candidate in candidates:
            capability = str(candidate["capability_id"])
            hypothesis_contract = {
                "hypothesis": candidate.get("hypothesis"),
                "predicted_delta": candidate.get("predicted_delta"),
                "evidence_state": candidate.get("evidence_state", "unverified"),
                "scope": candidate.get("scope", "archetype"),
            }
            hypothesis_contract = {
                key: value for key, value in hypothesis_contract.items()
                if value is not None
            }
            descriptors.append(
                {
                    "schema_version": 1,
                    "id": capability,
                    "capability_version": self.VERSION,
                    "provider": "aiko-arc",
                    "tool": "arc_action",
                    "action": str(candidate.get("label") or capability),
                    "description": str(candidate.get("description") or candidate.get("label") or capability),
                    "input_schema": {},
                    # Contract catalog data is the durable, provider-neutral
                    # hypothesis declaration. Coordinates stay in the
                    # episode-local candidate and never enter this schema.
                    "output_schema": {
                        "type": "object",
                        "x-contract-hypothesis": hypothesis_contract,
                    },
                    "requires": [],
                    "permission": "write",
                    "effects": ["local_write"],
                    "available": True,
                }
            )
        return self._take(
            self.lib.contract_register_capabilities(
                b"aiko-arc", json.dumps(descriptors, separators=(",", ":")).encode()
            )
        )

    def plan_candidates(self, context: str, candidates: list[dict]):
        availability = [
            {
                "capability_id": str(candidate["capability_id"]),
                "capability_version": self.VERSION,
                "available": True,
            }
            for candidate in candidates
        ]
        return self._take(
            self.lib.contract_recommend_plan(
                context.encode(),
                json.dumps(availability, separators=(",", ":")).encode(),
                min(8, max(1, len(availability))),
            )
        )

    def register_actions(self, actions: list[int]):
        return self.register_candidates([
            {
                "capability_id": self.capability_id(action),
                "label": f"action-{action}",
                "description": (
                    "Apply a coordinate click in an unseen grid environment"
                    if action == 6
                    else f"Apply discrete action {action}; learn its meaning from observed transitions"
                ),
            }
            for action in sorted(set(int(value) for value in actions))
        ])

    def plan(self, context: str, actions: list[int]):
        return self.plan_candidates(context, [
            {"capability_id": self.capability_id(action)}
            for action in sorted(set(int(value) for value in actions))
        ])

    def observe_capability(self, context: str, capability_id: str, success: bool, result_shape: str):
        observation = {
            "schema_version": 1,
            "capability_id": capability_id,
            "capability_version": self.VERSION,
            "success": bool(success),
            "duration_ms": 0,
            "permission_result": "allowed",
            "error_class": None if success else "provider_failure",
            "result_shape": result_shape,
            "observed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        return self._take(
            self.lib.contract_record_capability_observation(
                context.encode(), json.dumps(observation, separators=(",", ":")).encode()
            )
        )

    def observe(self, context: str, action: int, success: bool, result_shape: str):
        return self.observe_capability(context, self.capability_id(action), success, result_shape)

    def observe_binary(self, context: str, binary: str, before: str, after: str, reward: float) -> bool:
        if self.abi_version < 4:
            return False
        return bool(self.lib.contract_muscle_observe(
            context.encode(), binary.encode(), before.encode(), after.encode(), float(reward)
        ))

    def recall_binary(self, context: str) -> str | None:
        if self.abi_version < 4:
            return None
        return self._take_text(self.lib.contract_muscle_recall(context.encode()))

    def predict_binary(self, before: str, target: str) -> str | None:
        if self.abi_version < 4:
            return None
        return self._take_text(self.lib.contract_muscle_predict(before.encode(), target.encode()))

    def rank_binary(
        self,
        context: str,
        before: str | None = None,
        target: str | None = None,
        limit: int = 8,
    ):
        if self.abi_version < 6 or not hasattr(self.lib, "contract_muscle_rank_json"):
            return None
        return self._take(
            self.lib.contract_muscle_rank_json(
                context.encode(),
                before.encode() if before is not None else None,
                target.encode() if target is not None else None,
                max(1, int(limit)),
            )
        )

    def _take_text(self, pointer: int | None) -> str | None:
        if not pointer:
            return None
        try:
            return ctypes.string_at(pointer).decode("utf-8")
        finally:
            self.lib.contract_free(pointer)

    @staticmethod
    def recommended_capability(plan) -> str | None:
        if not isinstance(plan, dict):
            return None
        candidates = plan.get("candidates") or plan.get("cells") or []
        if not candidates or not isinstance(candidates[0], dict):
            return None
        return str(candidates[0].get("capability_id") or candidates[0].get("id") or "") or None

    @staticmethod
    def recommended_action(plan) -> int | None:
        if not isinstance(plan, dict):
            return None
        capability = NativeContract.recommended_capability(plan) or ""
        try:
            return int(capability.rsplit(".", 1)[1])
        except (IndexError, ValueError):
            return None
