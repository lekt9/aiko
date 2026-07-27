#!/usr/bin/env python3
"""Minimal structural energy scorer for neuron firing candidates.

This is the seed for a generative EnergyRouter limb.
It scores candidate next firings / actions / generations by predicted energy drop.

Lower energy is better. Grounding + strong evidence + low cost + low settlement distance wins.

Used by routers / planners to recommend which neuron to fire or which effect to emit next.
"""
from __future__ import annotations
import json
from typing import Any

def firing_energy(
    grounding_ok: bool,
    evidence_conf_milli: int,
    normalized_cost: float,
    settlement_distance: float,
    violations: int = 0,
) -> float:
    """Structural energy of one firing candidate (0+ ; lower = better settlement)."""
    e = 0.0
    e += 0.0 if grounding_ok else 3.0
    e += max(0.0, (1000 - evidence_conf_milli) / 250.0)
    e += normalized_cost * 2.0
    e += settlement_distance
    e += violations * 2.5
    return round(e, 4)

def choose_lowest_energy(candidates: list[dict[str, Any]]) -> dict[str, Any]:
    """Return the candidate with lowest predicted energy + the score."""
    scored = []
    for c in candidates:
        e = firing_energy(
            c.get("grounding_ok", False),
            int(c.get("evidence_conf_milli", 0)),
            float(c.get("normalized_cost", 1.0)),
            float(c.get("settlement_distance", 10.0)),
            int(c.get("violations", 0)),
        )
        scored.append((e, c))
    scored.sort(key=lambda t: t[0])
    best_e, best = scored[0]
    return {"energy": best_e, "choice": best, "all_ranked": [{"e": e, "id": c.get("id", "?")} for e, c in scored]}

if __name__ == "__main__":
    demo = [
        {"id": "context-narrow", "grounding_ok": True, "evidence_conf_milli": 920, "normalized_cost": 0.15, "settlement_distance": 0.4},
        {"id": "spawn-micro-ebm", "grounding_ok": True, "evidence_conf_milli": 880, "normalized_cost": 0.25, "settlement_distance": 0.1},
        {"id": "router-heuristic", "grounding_ok": True, "evidence_conf_milli": 710, "normalized_cost": 0.35, "settlement_distance": 1.2},
    ]
    print(json.dumps(choose_lowest_energy(demo), indent=2))
