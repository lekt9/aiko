#!/usr/bin/env python3
"""PreToolUse(Write): block a new *.cell.yaml / neurons/*.py that duplicates an existing cell.

Inert unless armed: .claude/cell-steer.local or CELL_STEER_ON=1. Mirrors jesus-ralph/steer safety.
Exit 0=allow, 2=block+steer message (fed back to model).
"""
import json, os, subprocess, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if data.get("tool_name") != "Write":
    sys.exit(0)
ti = data.get("tool_input") or {}
fp = ti.get("file_path") or ""
content = ti.get("content") or ""
if not fp:
    sys.exit(0)
# only gate new files that look like cells or neurons
is_cell = fp.endswith(".cell.yaml") or fp.endswith(".cell.yml")
is_neuron = fp.endswith(".py") and ("/neurons/" in fp or "/patterns/" in fp or "/system/" in fp)
if not (is_cell or is_neuron):
    sys.exit(0)
if os.path.exists(fp):
    sys.exit(0)  # edit, not a fork
root = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
armed = os.environ.get("CELL_STEER_ON") == "1" or os.environ.get("STEER_ON") == "1" or os.path.exists(os.path.join(root, ".claude", "cell-steer.local")) or os.path.exists(os.path.join(root, ".claude", "steer.local"))
if not armed:
    sys.exit(0)
# resolve repo root for radar: prefer cell/ if exists, else project root
# The radar's --repo should be the cell/ tree when checking cells
repo = os.path.join(root, "cell") if os.path.isdir(os.path.join(root, "cell")) else root
radar = os.path.join(root, "cell", "scripts", "cell_reuse_radar.py")
if not os.path.exists(radar):
    # fallback to plugin steer radar if cell radar missing
    alt = os.path.join(os.path.expanduser("~"), ".aiko/installed-plugins/jesus-pattern-672eed01/skills/steer/scripts/reuse_radar.py")
    if os.path.exists(alt):
        radar = alt
    else:
        sys.exit(0)
try:
    proc = subprocess.run([sys.executable, radar, "--repo", repo, "--name", os.path.basename(fp), "--content-stdin"],
                          input=content, capture_output=True, text=True, timeout=20)
except Exception:
    sys.exit(0)
if proc.returncode == 0:
    sys.stderr.write(
        "CELL-STEER (reuse-existing-cells): you are about to create a NEW file that duplicates an existing cell/neuron.\n\n"
        + proc.stdout + ("\n" + proc.stderr if proc.stderr else "") +
        "\nReuse it instead: wire the existing cell as an organelle (cell: ./existing.cell.yaml) or fix it where it lives — its tests + callers come free.\n"
        "To fork anyway, say so explicitly; to disable this guard remove .claude/cell-steer.local or unset CELL_STEER_ON.\n")
    sys.exit(2)
sys.exit(0)
