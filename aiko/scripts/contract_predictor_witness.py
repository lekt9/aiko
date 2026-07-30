#!/usr/bin/env python3
"""Two-invocation witness for Contract muscle persistence."""

from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADAPTER = ROOT / ".agents/skills/arc-agi-3/scripts/native_contract.py"


def native_type():
    spec = importlib.util.spec_from_file_location("aiko_native_contract", ADAPTER)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load native Contract adapter")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.NativeContract


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("train", "recall"))
    parser.add_argument("key")
    args = parser.parse_args()
    contract = native_type()()
    context = f"predictor-restart-witness:{args.key}"
    if args.mode == "train":
        if not contract.observe_binary(context, "witness-action", "state:before", "state:after", 1.0):
            raise RuntimeError("native predictor rejected observation")
        recalled = contract.recall_binary(context)
        if recalled != "witness-action":
            raise RuntimeError(f"same-process recall failed: {recalled!r}")
        print("TRAIN-OK")
        return 0
    recalled = contract.recall_binary(context)
    prediction = contract.predict_binary("state:before", "state:after")
    if recalled != "witness-action":
        raise RuntimeError(f"cross-process recall failed: {recalled!r}")
    if not prediction:
        raise RuntimeError("cross-process predictor state was not loadable")
    print("RESTART-LOAD-OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
