"""bun_layer — plank 7 of 386497eb. bun:<spec> pointer-type for TS-native exec.

ACTION FORMAT:
  bun:run <script.ts> [args...]    → bun run <script.ts> [args...]
  bun:<other-bun-args>              → bun <other-bun-args>  (e.g. bun:-e 'console.log(1)')

Why not just use cli (`bun run script.ts` as a plain shell command)? Two reasons:
1. Symmetric with sandbox:/runpod:/machine: — bun is an L1 backend tier per
   capabilities probe, so it deserves a uniform dispatch surface.
2. Emits BUN MISSING block (not silent shell error) when bun isn't on PATH,
   matching the SANDBOX/RUNPOD UNAVAILABLE pattern. No fallback to node (would
   violate Locality 79c2d656 — TS-only semantics must run in TS).
"""
from __future__ import annotations
import os
import shutil
import subprocess
import sys


def _emit_unavailable(reason: str, hint: str) -> None:
    sys.stdout.write("\n  === BUN MISSING ===\n")
    sys.stdout.write(f"  reason:  {reason}\n")
    sys.stdout.write(f"  fix:     {hint}\n\n")


def run(spec: str) -> int:
    bun = shutil.which("bun")
    if not bun:
        _emit_unavailable(
            reason="bun not on PATH",
            hint="install via `curl -fsSL https://bun.sh/install | bash` or "
                 "`brew install bun`; then re-iterate",
        )
        print(f"  result: FAIL (bun: binary missing on host={os.uname().nodename})")
        return 1
    print(f"  pointer(bun): {bun} {spec}")
    rc = subprocess.call([bun] + spec.split(" ") if " " in spec else [bun, spec], shell=False) \
         if not spec.startswith("-") else subprocess.call(f"{bun} {spec}", shell=True)
    if rc == 0:
        print(f"  result: PASS (bun exit=0)")
    else:
        print(f"  result: FAIL (bun exit={rc})")
    return rc


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.stderr.write("usage: bun_layer.py <spec>\n")
        sys.exit(2)
    sys.exit(run(" ".join(sys.argv[1:])))
