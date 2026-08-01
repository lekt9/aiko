#!/usr/bin/env python3
"""witness_muscle_persistence.py — proves muscle memory survives a >16 MiB ledger.

The defect (residual a2): ensureMuscleLoaded() set muscle_loaded=true BEFORE
readAll(); readAll caps at 16 MiB (LedgerTooLarge); on a large ledger readAll
errored and the error was swallowed (catch return) -> the bank stayed EMPTY and
muscle_loaded=true prevented retry. So contract_muscle_recall returned None for
every persisted binary: persistence was silently broken. A second latent defect:
Bank.ensure returned error.TooManyBinaries at 64 distinct cells (no eviction),
so once replay actually loaded 64 binaries every NEW observe returned false.

FIX (contract substrate): stream the ledger line-by-line (ledger.forEachLine)
so replay never hits the 16 MiB slurp cap; and evict least-recently-used in
Bank.ensure so a full bank accepts a new grounded binary instead of rejecting it.

This witness manufactures a ledger that is BOTH >16 MiB AND has >64 distinct
bulk binaries (to exercise both fixes), then:

  Phase 1 (seed):  observe_binary(probe_ctx, probe_bin, ...) through the REAL
                   path so the probe's stored context vector is a true string
                   embedding (appends one row to the end of the big ledger).
  Phase 2 (recall, fresh process): ensureMuscleLoaded streams the whole >16 MiB
                   ledger (exercising streaming + eviction), then:
      (A) recall_binary(probe_ctx) == probe_bin   # persistence survived replay
      (B) observe_binary(new) is True              # eviction accepts a new cell

Red without the substrate fix (bank empty -> recall None). Green with streaming
replay + LRU eviction. Exits 0 only when both hold.
"""
import json
import os
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
VENV_PYTHON = os.environ.get("ARC_AGI3_PYTHON", "/Users/lewis/Unbrowse/ARC-AGI-3-Agents/.venv/bin/python")
NATIVE_MOD = str(ROOT / ".agents/skills/arc-agi-3/scripts")

DIM = 256
BULK_BINARIES = 80          # > 64 cap
ROWS_PER_BINARY = 90        # 80*90 = 7200 rows, ~2.6 KiB each -> ~18.7 MiB > 16 MiB cap


def manufacture_bulk(path: Path) -> None:
    """Write >16 MiB of valid muscle_observed rows across >64 distinct binaries.

    The context/delta vectors are raw floats (not string embeddings); they only
    need to parse under replayObservation and bloat the store past readAll's cap
    while filling the bank past 64 cells. They are never recalled by string.
    """
    with open(path, "w") as f:
        for i in range(BULK_BINARIES):
            vec = [float((i % 7) * 0.1)] * DIM
            dvec = [float((i % 5) * 0.1)] * DIM
            row = {
                "event": "muscle_observed",
                "binary": f"bulk-binary-{i}",
                "reward": 1.0,
                "context": vec,
                "delta": dvec,
            }
            line = json.dumps(row) + "\n"
            for _ in range(ROWS_PER_BINARY):
                f.write(line)


CHILD = r'''
import json, sys, os
sys.path.insert(0, %r)
from native_contract import NativeContract
mode = sys.argv[1]
meta = json.load(open(%r))
probe_ctx = meta["probe_ctx"]; probe_bin = meta["probe_bin"]
n = NativeContract()
if mode == "seed":
    ok = n.observe_binary(probe_ctx, probe_bin, "before-probe", "after-probe", 1.0)
    print("SEEDED=" + repr(ok))
    sys.exit(0 if ok else 1)
if mode == "recall":
    recalled = n.recall_binary(probe_ctx)
    new_bin = "new-after-replay-" + os.path.basename(probe_bin)
    observed = n.observe_binary("new-ctx-" + probe_bin, new_bin, "b", "a", 1.0)
    print("RECALL=" + repr(recalled))
    print("OBSERVE=" + repr(observed))
    ok = (recalled == probe_bin) and (observed is True)
    print("VERDICT=" + ("PASS" if ok else "FAIL"))
    sys.exit(0 if ok else 1)
sys.exit(2)
'''


def run_child(tmp: Path, meta: Path, mode: str) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["AIKO_CONTRACT_LIBRARY"] = os.environ.get(
        "AIKO_CONTRACT_LIBRARY", str(Path.home() / ".aiko/lib/libcontract.dylib"))
    script = CHILD % (NATIVE_MOD, str(meta))
    return subprocess.run(
        [VENV_PYTHON, "-c", script, mode], cwd=str(tmp), env=env,
        capture_output=True, text=True)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="muscle-persist-") as tmp:
        tmp = Path(tmp)
        claude_dir = tmp / ".claude"
        claude_dir.mkdir()
        ledger = claude_dir / "contracts.jsonl"
        manufacture_bulk(ledger)
        size = ledger.stat().st_size
        print(f"bulk ledger: {size} bytes ({size/1024/1024:.2f} MiB)  "
              f"distinct bulk binaries={BULK_BINARIES}  DIM={DIM}")
        assert size > 16 * 1024 * 1024, f"bulk ledger too small to trip 16 MiB cap: {size}"

        probe_ctx = f"probe-context-{uuid.uuid4().hex}"
        probe_bin = f"probe-binary-{uuid.uuid4().hex}"
        meta = ledger.parent / "probe_meta.json"
        meta.write_text(json.dumps({"probe_ctx": probe_ctx, "probe_bin": probe_bin}))

        # Phase 1: seed the probe through the real observe path (appends a row
        # whose context vector is a true string embedding of probe_ctx).
        p1 = run_child(tmp, meta, "seed")
        print("--- phase 1 (seed) ---"); print(p1.stdout.strip())
        if p1.returncode != 0:
            print("seed phase failed:", p1.stderr.strip()); return 1
        seeded_size = ledger.stat().st_size
        print(f"ledger after seed: {seeded_size} bytes ({seeded_size/1024/1024:.2f} MiB)")

        # Phase 2: fresh process streams the whole >16 MiB ledger, then recalls.
        p2 = run_child(tmp, meta, "recall")
        print("--- phase 2 (recall, fresh process) ---"); print(p2.stdout.strip())
        if p2.stderr.strip():
            print("stderr:", p2.stderr.strip())
        print(f"exit={p2.returncode}")
        return p2.returncode


if __name__ == "__main__":
    raise SystemExit(main())
