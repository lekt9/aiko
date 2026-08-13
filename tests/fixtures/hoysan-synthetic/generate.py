#!/usr/bin/env python3
"""Generate synthetic-only Hoysan drafting fixtures; never reads customer files."""
from __future__ import annotations
import argparse, copy, json
from pathlib import Path


def worker(i: int, pool: str, *, wah: bool = True) -> dict:
    return {
        "nric": f"SYN-W{i:04d}",
        "name": f"Synthetic Worker {i:04d}",
        "pool": pool,
        "wah": wah,
        "exceptions": [],
        "last_crane": None,
        "last_role": None,
        "last_shift": None,
        "role_history": [],
        "hours_since_last": None,
        "available": True,
    }


def base() -> dict:
    workers = [worker(i, "TS") for i in range(1, 6)]
    workers += [worker(i, "SIN") for i in range(6, 16)]
    workers += [worker(i, "NTS") for i in range(16, 36)]
    return {"request": {
        "shift_date": "2030-01-15", "shift_code": "D",
        "cranes": [
            {"crane_number": "SYN-C01", "vessel": "Synthetic Vessel 1", "wta_required": False},
            {"crane_number": "SYN-C02", "vessel": "Synthetic Vessel 2", "wta_required": True},
            {"crane_number": "SYN-C03", "vessel": "Synthetic Vessel 3", "wta_required": False},
        ],
        "workers": workers,
    }}


def cases() -> dict[str, dict]:
    feasible = base()
    shortfall = base(); shortfall["request"]["workers"] = shortfall["request"]["workers"][:4]
    wah = base(); wah["request"]["workers"] = [worker(i, "TS", wah=False) for i in range(1, 21)]
    exception = base(); exception["request"]["workers"] = [worker(i, "TS") for i in range(1, 21)]
    for w in exception["request"]["workers"]: w["exceptions"] = ["STA", "LW", "CM", "WTA"]
    rest = base(); rest["request"]["workers"] = [worker(i, "NTS") for i in range(1, 21)]
    for w in rest["request"]["workers"]: w.update(last_shift="G", hours_since_last=12)
    rest_unknown = copy.deepcopy(rest)
    for w in rest_unknown["request"]["workers"]: w["hours_since_last"] = None
    pair = base(); pair["request"]["workers"] = [worker(i, "TS") for i in range(1, 21)]
    pair["request"]["pair_state"] = {w["nric"]: "STA" for w in pair["request"]["workers"]}
    standby = base(); standby["request"]["workers"] = standby["request"]["workers"][:15]
    duplicate = base(); duplicate["request"]["workers"][1]["nric"] = duplicate["request"]["workers"][0]["nric"]
    unknown_pool = base(); unknown_pool["request"]["workers"][0]["pool"] = "UNKNOWN"
    return {"feasible": feasible, "shortfall": shortfall, "wah": wah, "exception": exception,
            "rest": rest, "rest-unknown": rest_unknown, "pair": pair, "standby": standby,
            "duplicate": duplicate, "unknown-pool": unknown_pool}


def assert_synthetic(value) -> None:
    req = value["request"]
    assert req["shift_date"].startswith("2030-")
    for w in req["workers"]:
        assert w["nric"].startswith("SYN-W"), w
        assert w["name"].startswith("Synthetic Worker "), w
    for c in req["cranes"]:
        assert c["crane_number"].startswith("SYN-C"), c
        assert c["vessel"].startswith("Synthetic Vessel "), c


def main() -> None:
    ap=argparse.ArgumentParser(); ap.add_argument("--out",type=Path,required=True); args=ap.parse_args()
    args.out.mkdir(parents=True,exist_ok=True)
    for name, value in cases().items():
        assert_synthetic(value)
        (args.out/f"{name}.json").write_text(json.dumps(value,sort_keys=True,indent=2)+"\n")

if __name__ == "__main__": main()
