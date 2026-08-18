#!/usr/bin/env python3
"""graff-agent leaf — hand one task to codegraff, return its answer.

The node fires only after its harness attached, so graff and the named MCP
server were both verified present by the engine before this runs. This file
never re-checks that; a second check here would be a second answer to a
question the engine already settled.
"""
import json, os, shutil, subprocess, sys

def main() -> int:
    stimulus = json.load(sys.stdin)
    inputs = stimulus.get("inputs", stimulus)
    task, system = inputs.get("task"), inputs.get("system")
    if not task or not system:
        json.dump({"rejection": "graff-agent requires both `task` and `system`"}, sys.stdout)
        return 1
    graff = shutil.which("graff") or shutil.which("codegraff")
    if not graff:
        json.dump({"rejection": "graff is not on PATH"}, sys.stdout)
        return 1
    proc = subprocess.run(
        [graff, "-p", f"Using only the {system} MCP server, {task}"],
        capture_output=True, text=True,
        # -p writes the answer on stdout and tool progress on stderr, so the
        # answer is never mixed with the trace.
        env={**os.environ, "NO_COLOR": "1"},
    )
    if proc.returncode != 0:
        json.dump({"rejection": f"graff exited {proc.returncode}: {proc.stderr.strip()[-300:]}"}, sys.stdout)
        return 1
    json.dump({"answer": proc.stdout.strip()}, sys.stdout, sort_keys=True)
    return 0

if __name__ == "__main__":
    sys.exit(main())
