#!/usr/bin/env python3
"""proposer_receptor.py -- a native-substrate LLM-proposer receptor.

The collapse the arc-skill author half-built: the LLM PROPOSER is not an ARC
neuron. It is a provider-neutral, task-neutral receptor over the Contract
substrate. ARC is ONE consumer; any task that needs "propose a next move given a
prompt" consumes this. The LLM backend and the prompt shape stay OUT of the core.

Provider-neutral: the LLM backend is a pluggable TRANSPORT behind a
TransportRegistry (aiko CLI, cloud HTTP, local GGUF, ...). Swapping backends does
not touch the receptor or any consumer. (RM3 TransportRegistry shape.)

Task-neutral: no ARC system prompt, no ARC capability id, no ARC action schema.
The caller supplies the prompt and the candidate schema. The capability declared
in the substrate is the generic `aiko-proposer.propose`, NOT `aiko-arc.*`.

Substrate-native: declares its capability via the GENERIC contract ABI
(contract_register_capabilities / contract_record_capability_observation) and
vetes candidates via the generic muscle EBM/jepa surface
(contract_muscle_rank_json). Fail-open: if libcontract is absent the receptor
still runs; it just cannot register/record/rank.

Fixed cell (contract-interface doctrine):
  observe -> normalize -> authorize -> prepare -> execute -> sense -> evaluate -> settle

Authority: an LLM call is a PAID external effect. propose() is fail-closed
unless the caller passes authority=True (mirrors send-notification / effect
gating). A consumer running inside an authorized loop passes it; a stray call
HOLDs.
"""
from __future__ import annotations

import ctypes
import json
import os
import platform
import subprocess
import time
from pathlib import Path
from typing import Any, Protocol


# --------------------------------------------------------------------------- #
# Substrate ABI -- the GENERIC surface (provider aiko-proposer, never aiko-arc).
# --------------------------------------------------------------------------- #
def _library_path() -> Path:
    if override := os.environ.get("AIKO_CONTRACT_LIBRARY"):
        return Path(override).expanduser()
    name = "contract.dll" if os.name == "nt" else "libcontract.dylib" if platform.system() == "Darwin" else "libcontract.so"
    for cand in (Path.home() / ".aiko/lib" / name,):
        if cand.is_file():
            return cand
    return name  # let ctypes raise a clear error if truly absent


class SubstrateABI:
    """Thin generic ctypes binding. Loads libcontract; fail-open if absent."""

    PROVIDER = "aiko-proposer"
    CAPABILITY = "aiko-proposer.propose"
    VERSION = "proposer-v1"

    def __init__(self) -> None:
        self.lib = None
        self.abi_version = 0
        try:
            lib = ctypes.CDLL(str(_library_path()))
            lib.contract_abi_version.restype = ctypes.c_uint32
            lib.contract_register_capabilities.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
            lib.contract_register_capabilities.restype = ctypes.c_void_p
            lib.contract_record_capability_observation.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
            lib.contract_record_capability_observation.restype = ctypes.c_void_p
            if hasattr(lib, "contract_muscle_rank_json"):
                lib.contract_muscle_rank_json.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint32]
                lib.contract_muscle_rank_json.restype = ctypes.c_void_p
            lib.contract_free.argtypes = [ctypes.c_void_p]
            self.lib = lib
            self.abi_version = int(lib.contract_abi_version())
        except Exception:
            self.lib = None  # fail-open: receptor runs without the substrate

    @property
    def available(self) -> bool:
        return self.lib is not None

    def _take(self, ptr: int | None):
        if not ptr or self.lib is None:
            return None
        try:
            return json.loads(ctypes.string_at(ptr).decode("utf-8"))
        finally:
            self.lib.contract_free(ptr)

    def register_capability(self, capability_id: str | None = None) -> dict | None:
        """Declare a generic proposer capability in the substrate catalog.

        Idempotent: re-registering an existing id may return None (the substrate
        treats duplicate registration as a no-op). Callers must not treat None as
        rejection; use a fresh capability_id to probe acceptance. NOTE: the
        substrate rejects hyphens in the description field, so keep it hyphen-free.
        """
        if self.lib is None:
            return None
        descriptor = [{
            "schema_version": 1,
            "id": capability_id or self.CAPABILITY,
            "capability_version": self.VERSION,
            "provider": self.PROVIDER,           # NOT aiko-arc
            "tool": "llm_proposer",
            "action": "propose",
            "description": "Propose a next move from a task neutral prompt. Provider neutral LLM transport.",
            "input_schema": {"type": "object"},
            "output_schema": {"type": "object"},
            "requires": [],
            "permission": "write",
            "effects": ["local_write"],          # the call itself is a paid external effect gated by authority
            "available": True,
        }]
        return self._take(self.lib.contract_register_capabilities(
            self.PROVIDER.encode(),
            json.dumps(descriptor, separators=(",", ":")).encode(),
        ))

    def record_observation(self, context: str, success: bool, result_shape: str) -> dict | None:
        if self.lib is None:
            return None
        obs = {
            "schema_version": 1,
            "capability_id": self.CAPABILITY,
            "capability_version": self.VERSION,
            "success": bool(success),
            "duration_ms": 0,
            "permission_result": "allowed",
            "error_class": None if success else "provider_failure",
            "result_shape": result_shape,
            "observed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        return self._take(self.lib.contract_record_capability_observation(
            context.encode(), json.dumps(obs, separators=(",", ":")).encode(),
        ))

    def rank_candidates(self, context: str, candidates: list[str], limit: int = 8) -> list[str] | None:
        """Generic muscle EBM/jepa vetting of candidate proposals. Fail-open."""
        if self.lib is None or not hasattr(self.lib, "contract_muscle_rank_json") or self.abi_version < 6:
            return None
        before = json.dumps(candidates)
        ranked = self._take(self.lib.contract_muscle_rank_json(
            context.encode(), before.encode(), None, max(1, int(limit)),
        ))
        return ranked


# --------------------------------------------------------------------------- #
# Transports -- provider-neutral adapters (RM3). The receptor never names a
# provider; it names a Transport interface. Adding a backend = adding a class.
# --------------------------------------------------------------------------- #
class ProposerTransport(Protocol):
    name: str
    def propose(self, system_prompt: str, user_prompt: str, model: str) -> str: ...


class EchoTransport:
    """Deterministic, zero-cost transport for tests/witnesses. Proves the
    receptor is provider-neutral and task-neutral WITHOUT spending tokens or
    touching the ARC skill."""
    name = "echo"

    def __init__(self, reply: str = '{"ok": true}') -> None:
        self._reply = reply

    def propose(self, system_prompt: str, user_prompt: str, model: str) -> str:
        return self._reply


class AikoCliTransport:
    """The local aiko CLI as one transport (the wire fixed in 3cf54de). This is
    a provider ADAPTER, not the core: replacing it with a cloud-HTTP or GGUF
    transport changes nothing in the receptor or its consumers."""
    name = "aiko-cli"

    def __init__(self, aiko_bin: str | None = None, timeout: int = 120) -> None:
        import shutil
        self.bin = aiko_bin or os.environ.get("AIKO_BIN") or shutil.which("aiko") or ""
        self.timeout = int(os.environ.get("AIKO_TIMEOUT", str(timeout)))

    def propose(self, system_prompt: str, user_prompt: str, model: str) -> str:
        if not self.bin or not os.path.exists(self.bin):
            return ""
        env = dict(os.environ)
        env["AIKO_NO_TELEMETRY"] = "1"
        # --single takes the prompt as its VALUE (the argv bug that deadened the
        # ARC wire); model/system-prompt are plain options.
        argv = [self.bin, "--model", model, "--system-prompt", system_prompt, "--single", user_prompt]
        try:
            p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=self.timeout, env=env,
                               stdin=subprocess.DEVNULL)
            return p.stdout or ""
        except Exception:
            return ""


class TransportRegistry:
    """Provider-neutral transport registry (RM3 shape): register / replace /
    effective / get. The receptor holds one; consumers never reference a provider."""
    def __init__(self) -> None:
        self._transports: dict[str, ProposerTransport] = {}
        self._effective: str | None = None

    def register(self, transport: ProposerTransport, make_effective: bool = False) -> None:
        self._transports[transport.name] = transport
        if make_effective or self._effective is None:
            self._effective = transport.name

    def replace(self, name: str, transport: ProposerTransport) -> None:
        self._transports[name] = transport
        if self._effective == name:
            self._effective = transport.name

    def get(self, name: str) -> ProposerTransport | None:
        return self._transports.get(name)

    def effective(self) -> ProposerTransport | None:
        return self._transports.get(self._effective) if self._effective else None

    def names(self) -> list[str]:
        return list(self._transports)


# --------------------------------------------------------------------------- #
# The receptor -- the fixed cell.
# --------------------------------------------------------------------------- #
class ProposerReceptor:
    def __init__(self, registry: TransportRegistry | None = None, substrate: SubstrateABI | None = None) -> None:
        self.registry = registry or TransportRegistry()
        self.substrate = substrate or SubstrateABI()
        self._declared = False

    def declare(self) -> dict | None:
        """Register the generic capability in the substrate catalog (idempotent)."""
        if self._declared:
            return None
        self._declared = True
        return self.substrate.register_capability()

    def propose(self, *, domain: str, system_prompt: str, user_prompt: str,
                candidate_schema: dict | None = None, context: str = "",
                authority: bool = False, model: str = "glm-5.2") -> dict[str, Any]:
        """Fixed cell: observe -> normalize -> authorize -> prepare -> execute
        -> sense -> evaluate -> settle. Returns a settlement envelope.

        authority=False HOLDs (paid external effect, fail-closed). The caller
        inside an authorized loop passes authority=True.
        """
        t0 = time.time()
        # observe + normalize
        envelope: dict[str, Any] = {
            "domain": domain, "context": context, "model": model,
            "capability": self.substrate.CAPABILITY, "provider": self.substrate.PROVIDER,
        }
        # authorize (paid external effect)
        if not authority:
            envelope.update(settled=False, held=True, reason="authority required for paid LLM effect")
            return envelope
        # prepare
        transport = self.registry.effective()
        if transport is None:
            envelope.update(settled=False, held=True, reason="no transport registered")
            return envelope
        envelope["transport"] = transport.name
        # execute
        raw = transport.propose(system_prompt, user_prompt, model)
        # sense: parse + validate against the caller's candidate schema
        parsed, valid = self._sense(raw, candidate_schema)
        # evaluate: generic muscle vetting (fail-open)
        vetted = None
        if valid and parsed is not None and self.substrate.available:
            vetted = self.substrate.rank_candidates(context or domain, [raw])
        # settle
        ok = valid and parsed is not None
        if self.substrate.available:
            self.substrate.record_observation(context or domain, ok, "object" if ok else "invalid")
        envelope.update(
            settled=ok, held=not ok, raw=raw, parsed=parsed, valid=valid,
            vetted=vetted, duration_ms=int((time.time() - t0) * 1000),
        )
        return envelope

    @staticmethod
    def _sense(raw: str, schema: dict | None) -> tuple[dict | None, bool]:
        """Parse the last JSON object in raw; validate required keys if schema given."""
        if not raw or not raw.strip():
            return None, False
        # find the last {...} in the reply (LLMs prepend prose)
        text = raw.strip()
        start = text.rfind("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end < start:
            return None, False
        try:
            obj = json.loads(text[start:end + 1])
        except Exception:
            return None, False
        if not isinstance(obj, dict):
            return None, False
        if schema:
            for key in schema.get("required", []):
                if key not in obj:
                    return obj, False
        return obj, True
