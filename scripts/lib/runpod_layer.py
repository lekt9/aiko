"""runpod_layer — alternative-backend sandbox for the `runpod:<endpoint>:<intent>` pointer-type.

Plank 1 of the DEFERRED-MEGA-VISION organ (`386497eb`, 2026-05-24). Lewis's
framing: "allow runpod as an alternative to the turbobox sandbox so shit runs".
Symmetric to sandbox_layer.py (Χ6) — same lifecycle shape, different upstream.

ACTION FORMAT:
  runpod:<endpoint_id>:<exec-intent>
  e.g. runpod:abc123xyz:python3 -c 'print(42 * 42)'
  e.g. runpod:bash-pod-id:bash -c 'curl -s https://example.com'

LIFECYCLE (RunPod serverless API — runsync flavour):
  POST <base>/v2/<endpoint_id>/runsync
       body: {"input": {"cmd": "<intent>"}}
       auth: Authorization: Bearer <RUNPOD_API_KEY>
       resp: {"id": "...", "status": "COMPLETED"|"FAILED"|"IN_QUEUE", "output": {...}}

Output is the user's serverless handler's return value; we look for
"exit_code" first, then fall back to status==COMPLETED → exit 0.

CONFIG (env, with sane defaults):
  RUNPOD_BASE       base URL                        default: https://api.runpod.ai
  RUNPOD_API_KEY    bearer token                    required (per RunPod docs)
  RUNPOD_TIMEOUT    runsync timeout seconds         default: 120

FAILURE MODES:
  - missing RUNPOD_API_KEY → emit === RUNPOD UNAVAILABLE === block with how-to-fix
  - upstream unreachable / non-200 → emit block, exit 1
  - status FAILED → exit code from output.exit_code if present, else 1
  - status COMPLETED + exit_code 0 → PASS
  - status IN_QUEUE after runsync (rare, indicates upstream timeout) → FAIL,
    block names the status so the agent can fall back to /run async

WHY symmetric-but-separate from sandbox_layer (instead of a unified backend
selector): two different upstreams with different lifecycle semantics
(turbobox: ephemeral box per call; runpod: persistent serverless endpoint
preconfigured by the user). One module per backend keeps each loop tight
and makes a third backend (modal, fly.io, etc) a clear addition pattern.
"""
from __future__ import annotations
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_BASE = "https://api.runpod.ai"
DEFAULT_TIMEOUT = 120


def _post(url: str, body: dict, headers: dict, timeout: int) -> tuple[int, str]:
    """Returns (status_code, body_text). status_code=0 on connection failure."""
    data = json.dumps(body).encode("utf-8")
    req_headers = {**headers, "Content-Type": "application/json"}
    req = urllib.request.Request(url, data=data, headers=req_headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        sys.stderr.write(f"runpod_layer: connect failed for {url}: {e}\n")
        return 0, str(e)


def _emit_unavailable(reason: str, hint: str) -> None:
    sys.stdout.write("\n  === RUNPOD UNAVAILABLE ===\n")
    sys.stdout.write(f"  reason:  {reason}\n")
    sys.stdout.write(f"  fix:     {hint}\n")
    sys.stdout.write("\n")


def run(endpoint: str, intent: str) -> int:
    """POST intent to RunPod serverless endpoint, return exit code."""
    base = os.environ.get("RUNPOD_BASE", DEFAULT_BASE).rstrip("/")
    api_key = os.environ.get("RUNPOD_API_KEY", "").strip()
    timeout = int(os.environ.get("RUNPOD_TIMEOUT", DEFAULT_TIMEOUT))

    if not api_key:
        _emit_unavailable(
            reason="RUNPOD_API_KEY env not set",
            hint="export RUNPOD_API_KEY=<your-key>  (find at runpod.io/console/user/settings → API Keys)",
        )
        print(f"  result: FAIL (runpod: auth missing for base={base})")
        return 1

    if not endpoint:
        _emit_unavailable(
            reason="endpoint id empty",
            hint="action must be 'runpod:<endpoint_id>:<intent>' — the endpoint is preconfigured at runpod.io/console/serverless",
        )
        print("  result: FAIL (runpod: empty endpoint)")
        return 1

    headers = {"Authorization": f"Bearer {api_key}"}
    url = f"{base}/v2/{endpoint}/runsync"
    print(f"  pointer(runpod): endpoint={endpoint} → runsync")
    status, body = _post(url, {"input": {"cmd": intent}}, headers, timeout)
    if status != 200:
        _emit_unavailable(
            reason=f"runsync returned HTTP {status} from {url}",
            hint=f"check RUNPOD_BASE ({base}) + api key + endpoint id '{endpoint}' is active",
        )
        sys.stdout.write(f"  upstream: {body[:300]}\n")
        print(f"  result: FAIL (runpod: runsync failed for endpoint={endpoint})")
        return 1

    try:
        result = json.loads(body)
    except json.JSONDecodeError:
        print(f"  result: FAIL (runpod: body unparseable: {body[:200]})")
        return 1

    rp_status = str(result.get("status", "")).upper()
    output = result.get("output", {})

    # Surface output to stdout regardless of status
    if isinstance(output, dict):
        stdout_text = output.get("stdout", "")
        if stdout_text:
            sys.stdout.write(stdout_text)
            if not stdout_text.endswith("\n"):
                sys.stdout.write("\n")
        stderr_text = output.get("stderr", "")
        if stderr_text:
            sys.stderr.write(stderr_text)
    elif isinstance(output, str):
        sys.stdout.write(output)
        if not output.endswith("\n"):
            sys.stdout.write("\n")

    if rp_status == "COMPLETED":
        if isinstance(output, dict) and "exit_code" in output:
            try:
                exit_code = int(output["exit_code"])
            except (TypeError, ValueError):
                exit_code = 0
        else:
            exit_code = 0
        if exit_code == 0:
            print(f"  result: PASS (runpod endpoint={endpoint} status=COMPLETED exit=0)")
        else:
            print(f"  result: FAIL (runpod endpoint={endpoint} status=COMPLETED exit={exit_code})")
        return exit_code

    if rp_status == "FAILED":
        err = (
            output.get("error", "unknown")
            if isinstance(output, dict)
            else str(output)[:200]
        )
        print(f"  result: FAIL (runpod endpoint={endpoint} status=FAILED error={err})")
        if isinstance(output, dict) and "exit_code" in output:
            try:
                return int(output["exit_code"])
            except (TypeError, ValueError):
                return 1
        return 1

    # IN_QUEUE / IN_PROGRESS / CANCELLED / other — runsync should have waited
    _emit_unavailable(
        reason=f"runsync returned status={rp_status} (expected COMPLETED or FAILED)",
        hint="endpoint may have timed out before completing — try /run async or raise RUNPOD_TIMEOUT",
    )
    print(f"  result: FAIL (runpod endpoint={endpoint} unresolved status={rp_status})")
    return 1


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.stderr.write("usage: runpod_layer.py <endpoint_id> <intent-or-command>\n")
        sys.exit(2)
    sys.exit(run(sys.argv[1], sys.argv[2]))
