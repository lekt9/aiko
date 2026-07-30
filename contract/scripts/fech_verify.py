#!/usr/bin/env python3
"""Deterministic FECH ABI acceptance and benchmark harness."""

from __future__ import annotations

import ctypes
import json
import os
import platform
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "fixtures" / "fech" / "evaluation.json"


def library_path() -> Path:
    override = os.environ.get("AIKO_CONTRACT_LIBRARY")
    if override:
        return Path(override)
    name = "contract.dll" if os.name == "nt" else "libcontract.dylib" if platform.system() == "Darwin" else "libcontract.so"
    return ROOT / "libcontract" / "zig-out" / "lib" / name


class Contract:
    def __init__(self, path: Path):
        self.lib = ctypes.CDLL(str(path))
        self.lib.contract_register_capabilities.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
        self.lib.contract_register_capabilities.restype = ctypes.c_void_p
        self.lib.contract_list_capabilities.argtypes = [ctypes.c_char_p]
        self.lib.contract_list_capabilities.restype = ctypes.c_void_p
        self.lib.contract_recommend_plan.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint32]
        self.lib.contract_recommend_plan.restype = ctypes.c_void_p
        self.lib.contract_record_capability_observation.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
        self.lib.contract_record_capability_observation.restype = ctypes.c_void_p
        self.lib.contract_recommend.argtypes = [ctypes.c_char_p]
        self.lib.contract_recommend.restype = ctypes.c_void_p
        self.lib.contract_free.argtypes = [ctypes.c_void_p]

    def _take(self, pointer: int | None):
        if not pointer:
            return None
        try:
            return json.loads(ctypes.string_at(pointer).decode("utf-8"))
        finally:
            self.lib.contract_free(pointer)

    def register(self, source: str, descriptors: list[dict]):
        return self._take(self.lib.contract_register_capabilities(source.encode(), json.dumps(descriptors, separators=(",", ":")).encode()))

    def list(self):
        return self._take(self.lib.contract_list_capabilities(b"{}"))

    def plan(self, context: str, availability: list[dict]):
        return self._take(self.lib.contract_recommend_plan(context.encode(), json.dumps(availability, separators=(",", ":")).encode(), 3))

    def observe(self, context: str, observation: dict):
        return self._take(self.lib.contract_record_capability_observation(context.encode(), json.dumps(observation, separators=(",", ":")).encode()))

    def recommend(self, context: str):
        return self._take(self.lib.contract_recommend(context.encode()))


def availability_for(sources: dict[str, list[dict]]) -> list[dict]:
    return [
        {"capability_id": item["id"], "capability_version": item["capability_version"], "available": item["available"]}
        for descriptors in sources.values()
        for item in descriptors
    ]


def observation(capability_id: str, version: str, success: bool, error: str | None = None) -> dict:
    return {
        "schema_version": 1,
        "capability_id": capability_id,
        "capability_version": version,
        "success": success,
        "duration_ms": 42,
        "permission_result": "allowed",
        "error_class": error,
        "result_shape": "object" if success else "null",
        "observed_at": "2026-07-21T00:00:00Z",
    }


def percentile(values: list[float], ratio: float) -> float:
    return sorted(values)[round((len(values) - 1) * ratio)]


def durable_failure_check(home: str) -> None:
    os.environ["HOME"] = home
    os.chdir(home)
    fixture = json.loads(FIXTURE.read_text())
    contract = Contract(library_path())
    for source, descriptors in fixture["sources"].items():
        assert contract.register(source, descriptors)
    availability = availability_for(fixture["sources"])
    route_id = "unbrowse.clinic.appointments"
    plan = contract.plan("list clinic appointment availability browser fallback", availability)
    candidate = next((item for item in plan["candidates"] if item["capability_id"] == route_id), None)
    assert candidate is None or candidate["status"] == "inhibited", (contract.recommend("list clinic appointment availability browser fallback"), plan)
    assert not plan["automatic"]


def main() -> None:
    fixture = json.loads(FIXTURE.read_text())
    with tempfile.TemporaryDirectory(prefix="fech-verification-") as home:
        os.environ["HOME"] = home
        os.chdir(home)
        contract = Contract(library_path())
        sources = fixture["sources"]
        for source, descriptors in sources.items():
            assert contract.register(source, descriptors)["count"] == len(descriptors)
            assert contract.register(source, descriptors)["count"] == len(descriptors)
        availability = availability_for(sources)

        # Fixed-corpus accuracy and cold automatic false positives.
        correct = 0
        cold_automatic = 0
        cold_automatic_diagnostics = []
        for context, expected in fixture["queries"]:
            plan = contract.plan(context, availability)
            ids = [candidate["capability_id"] for candidate in plan["candidates"]]
            correct += expected in ids
            cold_automatic += bool(plan["automatic"])
            if plan["automatic"]:
                cold_automatic_diagnostics.append((context, plan))
        accuracy = correct / len(fixture["queries"])
        false_positive_rate = cold_automatic / len(fixture["queries"])
        assert accuracy >= 0.85, accuracy
        assert false_positive_rate <= 0.02, (false_positive_rate, cold_automatic_diagnostics)

        # Scenario 1: Contract-owned application prerequisites remain native.
        application = sources["aiko"] + [
            {"schema_version":1,"id":"aiko.application_observe.invoke","capability_version":"tools-v1","provider":"aiko","tool":"application_observe","action":"invoke","description":"Observe an application","input_schema":{},"output_schema":{},"requires":[],"permission":"read","effects":["read_only"],"available":True},
            {"schema_version":1,"id":"aiko.application_act.invoke","capability_version":"tools-v1","provider":"aiko","tool":"application_act","action":"invoke","description":"Act in an application","input_schema":{},"output_schema":{},"requires":[],"permission":"write","effects":["local_write"],"available":True},
        ]
        sources["aiko"] = application
        assert contract.register("aiko", application)
        availability = availability_for(sources)
        app_plan = contract.plan("click the login button", availability)
        assert app_plan["sequence"] == ["application.attach", "application.snapshot", "application.click"]
        assert not app_plan["automatic"]

        # Scenario 2/3: MCP learns, then live disconnect vetoes it.
        mcp_id = "mcp:github.issues_list.invoke"
        assert contract.observe("list GitHub issues", observation(mcp_id, "1", True))
        learned = contract.plan("list repository GitHub issues", availability)
        learned_candidate = next(candidate for candidate in learned["candidates"] if candidate["capability_id"] == mcp_id)
        assert learned_candidate["status"] == "verified_fresh"
        disconnected = [dict(item, available=False) if item["capability_id"] == mcp_id else item for item in availability]
        inhibited = contract.plan("list repository GitHub issues", disconnected)
        disconnected_candidate = next((candidate for candidate in inhibited["candidates"] if candidate["capability_id"] == mcp_id), None)
        assert disconnected_candidate is None or disconnected_candidate["status"] == "unavailable"
        assert not inhibited["sequence"] or inhibited["sequence"][-1] != mcp_id
        assert not inhibited["automatic"]

        # Scenario 4: installed skills stay guidance-only.
        skill_plan = contract.plan("load deployment guidance in parallel", availability)
        assert skill_plan["candidates"][0]["capability_id"] == "skill.skill.deploy"
        assert "skill.skill.deploy" not in skill_plan["parallel"]
        assert not skill_plan["automatic"]

        # Scenario 5/6: proven Unbrowse wins; a typed failure inhibits it and
        # leaves the browser fallback available without retaining payloads.
        route_id = "unbrowse.clinic.appointments"
        assert contract.observe("list clinic appointment availability", observation(route_id, "1", True))
        route_plan = contract.plan("list clinic appointment availability", availability)
        assert route_plan["candidates"][0]["capability_id"] == route_id
        assert contract.observe("list clinic appointment availability", observation(route_id, "1", False, "provider_failure"))
        fallback = contract.plan("list clinic appointment availability browser fallback", availability)
        route_candidate = next((candidate for candidate in fallback["candidates"] if candidate["capability_id"] == route_id), None)
        assert route_candidate is None or route_candidate["status"] == "inhibited"
        assert fallback["candidates"][0]["capability_id"] == "mcp:browser.clinic_fallback.invoke"
        subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--durable-failure-check", home],
            check=True,
        )
        invalid = observation(route_id, "1", False, "provider_failure") | {"raw_result": "RESULT_SENTINEL"}
        assert contract.observe("ARG_SENTINEL", invalid) is None

        # Scenario 7: independent reads compose; mutation cannot join.
        # Restore the route after Scenario 6 so the composition suite measures
        # available independent reads rather than the failure veto itself.
        assert contract.observe("list clinic appointment availability", observation(route_id, "1", True))
        parallel_successes = 0
        parallel_diagnostics = []
        for context, expected in fixture["parallel_queries"]:
            plan = contract.plan(context, availability)
            passed = set(expected).issubset(set(plan["parallel"]))
            parallel_successes += passed
            parallel_diagnostics.append((context, expected, plan["parallel"], [item["capability_id"] for item in plan["candidates"]]))
        parallel_rate = parallel_successes / len(fixture["parallel_queries"])
        assert parallel_rate >= 0.90, (parallel_rate, parallel_diagnostics)
        mutation = contract.plan("compare both create issue and shop products in parallel", availability)
        assert "mcp:github.issue_create.invoke" not in mutation["parallel"]

        # Scenario 8: an incompatible descriptor version cannot inherit proof.
        updated_unbrowse = [dict(item, capability_version="2") if item["id"] == route_id else item for item in sources["unbrowse"]]
        sources["unbrowse"] = updated_unbrowse
        assert contract.register("unbrowse", updated_unbrowse)
        availability = availability_for(sources)
        versioned = contract.plan("list clinic appointment availability", availability)
        versioned_route = next(candidate for candidate in versioned["candidates"] if candidate["capability_id"] == route_id)
        assert versioned_route["capability_version"] == "2"
        assert versioned_route["status"] == "available_unverified"
        assert not versioned["automatic"]

        # Performance gates on the current reference machine.
        warm_samples = []
        for _ in range(30):
            started = time.perf_counter()
            contract.plan("read the local weather forecast", availability)
            warm_samples.append((time.perf_counter() - started) * 1000)
        benchmark = []
        for index in range(1000):
            benchmark.append({"schema_version":1,"id":f"mcp:bench.item_{index}.read","capability_version":"1","provider":"mcp:bench","tool":f"item_{index}","action":"read","description":f"Read benchmark item {index}","input_schema":{},"output_schema":{},"requires":[],"permission":"read","effects":["read_only"],"available":True})
        started = time.perf_counter()
        assert contract.register("mcp:bench", benchmark)["count"] == 1000
        refresh_ms = (time.perf_counter() - started) * 1000
        p50 = statistics.median(warm_samples)
        p95 = percentile(warm_samples, 0.95)
        assert p50 <= 50, p50
        assert p95 <= 150, p95
        assert refresh_ms <= 500, refresh_ms

        ledger_text = "\n".join(
            path.read_text(errors="replace")
            for path in Path(home).rglob("*")
            if path.is_file() and path.stat().st_size <= 20_000_000
        )
        assert "ARG_SENTINEL" not in ledger_text
        assert "RESULT_SENTINEL" not in ledger_text

        print(json.dumps({
            "ok": True,
            "top3_accuracy": accuracy,
            "automatic_false_positive_rate": false_positive_rate,
            "parallel_success_rate": parallel_rate,
            "warm_ranking_p50_ms": round(p50, 3),
            "warm_ranking_p95_ms": round(p95, 3),
            "refresh_1000_ms": round(refresh_ms, 3),
            "scenarios_passed": 8,
            "privacy_sentinels_absent": True,
        }, indent=2))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--durable-failure-check":
        durable_failure_check(sys.argv[2])
    else:
        main()
