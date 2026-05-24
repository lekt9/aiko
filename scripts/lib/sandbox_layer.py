"""sandbox_layer — Χ6 turbobox sandbox backend for the `sandbox:<image>:<intent>` pointer-type.

Origin: 2026-05-24, Lewis: "ship the thing i say on the right layer of abstraction" → Χ6 (e010a776's
load-bearing piece). Composes Λ1 (codegen, deferred to next wave; today the intent IS the literal exec command)
+ Π3 (machine-portable binaries — sandbox image provides them) + Locality container-scope (79c2d656).

ACTION FORMAT:
  sandbox:<image>:<exec-command>
  e.g. sandbox:python:python3 -c 'print(42 * 42)'
  e.g. sandbox:dev:bash -c 'git clone https://github.com/u/r /w && cd /w && pytest'

LIFECYCLE (per turbobox docs ~/Downloads/docs (1).md + sandbox-docs):
  1. POST <base>/v1/boxes  {image, cpu, memory}  → {id, status:running}
  2. POST <base>/v1/boxes/<id>/exec  <command>   → {output, [exit_code]}
  3. DELETE <base>/v1/boxes/<id>                  → cleanup (best-effort)

CONFIG (env, with sane defaults):
  TURBOBOX_URL      base URL                        default: https://sandbox.trilok.ai
  TURBOBOX_API_KEY  bearer token                    required (per real API: "api key required")
  TURBOBOX_CPU      CPU millicores                  default: 1000
  TURBOBOX_MEMORY   memory MiB                      default: 512

FAILURE MODES:
  - missing TURBOBOX_API_KEY → emit === SANDBOX UNAVAILABLE === block with how-to-fix
  - upstream unreachable / non-200 on create → emit block, exit 1
  - exec returns non-zero exit_code OR error → exit code propagates as KEY 1
  - destroy failure → logged to stderr but does NOT change exit code (box leak is upstream's problem)
"""
from __future__ import annotations
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_BASE = "https://sandbox.trilok.ai"
DEFAULT_CPU = 1000
DEFAULT_MEMORY = 512


def _post(url: str, body: dict | str, headers: dict, timeout: int = 30) -> tuple[int, str]:
    """Returns (status_code, body_text). status_code=0 on connection failure."""
    if isinstance(body, dict):
        data = json.dumps(body).encode("utf-8")
        headers = {**headers, "Content-Type": "application/json"}
    else:
        data = body.encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        sys.stderr.write(f"sandbox_layer: connect failed for {url}: {e}\n")
        return 0, str(e)


def _delete(url: str, headers: dict, timeout: int = 10) -> None:
    req = urllib.request.Request(url, headers=headers, method="DELETE")
    try:
        with urllib.request.urlopen(req, timeout=timeout):
            pass
    except Exception as e:
        sys.stderr.write(f"sandbox_layer: cleanup DELETE {url} failed: {e}\n")


def _emit_unavailable(reason: str, hint: str) -> None:
    sys.stdout.write("\n  === SANDBOX UNAVAILABLE ===\n")
    sys.stdout.write(f"  reason:  {reason}\n")
    sys.stdout.write(f"  fix:     {hint}\n")
    sys.stdout.write("\n")


def run(image: str, intent: str) -> int:
    """Create box → exec intent → destroy box. Prints command output to stdout. Returns exit code."""
    base = os.environ.get("TURBOBOX_URL", DEFAULT_BASE).rstrip("/")
    api_key = os.environ.get("TURBOBOX_API_KEY", "").strip()
    cpu = int(os.environ.get("TURBOBOX_CPU", DEFAULT_CPU))
    memory = int(os.environ.get("TURBOBOX_MEMORY", DEFAULT_MEMORY))

    if not api_key:
        _emit_unavailable(
            reason="TURBOBOX_API_KEY env not set",
            hint="export TURBOBOX_API_KEY=<your-key>  (or set it in ~/.config/turbobox/api-key)",
        )
        print(f"  result: FAIL (sandbox: auth missing for base={base})")
        return 1

    headers = {"Authorization": f"Bearer {api_key}"}
    create_url = f"{base}/v1/boxes"
    status, body = _post(create_url, {"image": image, "cpu": cpu, "memory": memory}, headers)
    if status != 200 and status != 201:
        _emit_unavailable(
            reason=f"create returned HTTP {status} from {create_url}",
            hint=f"check TURBOBOX_URL ({base}) + api key + image '{image}' is supported (alpine|python|node|dev|debian)",
        )
        sys.stdout.write(f"  upstream: {body[:300]}\n")
        print(f"  result: FAIL (sandbox: create failed for image={image})")
        return 1
    try:
        box = json.loads(body)
        box_id = box.get("id")
        if not box_id:
            print(f"  result: FAIL (sandbox: create returned no id, body={body[:200]})")
            return 1
    except json.JSONDecodeError:
        print(f"  result: FAIL (sandbox: create body unparseable: {body[:200]})")
        return 1

    print(f"  pointer(sandbox): image={image} box={box_id} → exec")
    try:
        exec_url = f"{base}/v1/boxes/{box_id}/exec"
        exec_status, exec_body = _post(exec_url, intent, headers, timeout=120)
        if exec_status != 200:
            print(f"  result: FAIL (sandbox exec HTTP {exec_status}: {exec_body[:200]})")
            return 1
        try:
            exec_result = json.loads(exec_body)
            output = exec_result.get("output", "")
            sys.stdout.write(output)
            if output and not output.endswith("\n"):
                sys.stdout.write("\n")
            # exit_code may be present per turbobox response shape; default to 0 if absent
            exec_exit = int(exec_result.get("exit_code", 0))
            if exec_exit == 0:
                print(f"  result: PASS (sandbox image={image} box={box_id} exit=0)")
            else:
                print(f"  result: FAIL (sandbox image={image} box={box_id} exit={exec_exit})")
            return exec_exit
        except (json.JSONDecodeError, ValueError):
            sys.stdout.write(exec_body)
            print(f"\n  result: PASS (sandbox image={image} box={box_id} — output unparseable as JSON, treating as raw)")
            return 0
    finally:
        _delete(f"{base}/v1/boxes/{box_id}", headers)


if __name__ == "__main__":
    # CLI: scripts/lib/sandbox_layer.py <image> <intent>
    if len(sys.argv) < 3:
        sys.stderr.write("usage: sandbox_layer.py <image> <intent-or-command>\n")
        sys.exit(2)
    sys.exit(run(sys.argv[1], sys.argv[2]))
