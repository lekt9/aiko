"""macos_sandbox_layer — macos-sandbox:<profile>:<cmd> pointer-type.

OS-native isolation tier via macOS's sandbox-exec. Composes with sandbox: (turbobox)
and runpod: as third backend at L1 — but DIFFERENT semantics: this runs the
command on the same host inside a kernel-enforced sandbox profile, not in a
remote container. Use when: (a) you trust the binary but want to constrain
filesystem/network access, (b) cross-host backends are unavailable, (c) hot loop
where remote round-trip is too slow.

ACTION FORMAT:
  macos-sandbox:<profile>:<cmd>
  e.g. macos-sandbox:no-network:python3 -c "print(42)"
  e.g. macos-sandbox:read-only:cat /etc/hosts

PROFILES (built-in — written to /tmp inline on each run):
  - no-network    : allow filesystem read+write, deny all network
  - read-only     : allow filesystem read only, deny write + network
  - pure-compute  : deny filesystem + network (compute only — args/env in, exit out)

For custom profiles, use macos-sandbox:custom:<path-to-.sb>:<cmd> — passes the .sb
file to sandbox-exec -f directly.

FAILURE MODES:
  - non-darwin           → SANDBOX-EXEC UNAVAILABLE block, exit 1
  - sandbox-exec missing → SANDBOX-EXEC UNAVAILABLE block, exit 1
  - unknown profile name → ERROR, exit 1
  - command exit_code    → propagated as KEY 1
"""
from __future__ import annotations
import os
import platform
import shutil
import subprocess
import sys
import tempfile

PROFILES = {
    "no-network": """(version 1)
(deny default)
(allow file*)
(allow process-fork)
(allow process-exec)
(allow signal)
(allow sysctl-read)
(deny network*)
""",
    "read-only": """(version 1)
(deny default)
(allow file-read*)
(allow process-fork)
(allow process-exec)
(allow signal)
(allow sysctl-read)
(deny file-write*)
(deny network*)
""",
    "pure-compute": """(version 1)
(deny default)
(allow process-fork)
(allow process-exec)
(allow signal)
(allow sysctl-read)
(deny file-read* (subpath "/Users"))
(deny file-read* (subpath "/private"))
(deny file-write*)
(deny network*)
""",
}


def _emit_unavailable(reason: str, hint: str) -> None:
    sys.stdout.write("\n  === SANDBOX-EXEC UNAVAILABLE ===\n")
    sys.stdout.write(f"  reason:  {reason}\n")
    sys.stdout.write(f"  fix:     {hint}\n\n")


def run(profile: str, cmd: str) -> int:
    if platform.system() != "Darwin":
        _emit_unavailable(
            reason=f"macos-sandbox: requires Darwin; this host is {platform.system()}",
            hint="use sandbox: (turbobox), runpod:, or docker (via cli) for non-mac hosts",
        )
        print(f"  result: FAIL (macos-sandbox: wrong os={platform.system()})")
        return 1
    if not shutil.which("sandbox-exec"):
        _emit_unavailable(
            reason="sandbox-exec binary not on PATH (rare on macOS — usually at /usr/bin/sandbox-exec)",
            hint="check System Integrity Protection; sandbox-exec ships with macOS but may be restricted in some configs",
        )
        print(f"  result: FAIL (macos-sandbox: binary missing)")
        return 1
    # Custom-profile dispatch: macos-sandbox:custom:<path>:<cmd>
    if profile == "custom":
        # cmd here is "<path-to-.sb>:<cmd>"
        if ":" not in cmd:
            print(f"  result: FAIL (custom profile needs 'custom:<path.sb>:<cmd>')")
            return 1
        sb_path, real_cmd = cmd.split(":", 1)
        if not os.path.isfile(sb_path):
            print(f"  result: FAIL (custom profile .sb not found: {sb_path})")
            return 1
        print(f"  pointer(macos-sandbox): custom={sb_path} cmd={real_cmd}")
        rc = subprocess.call(["sandbox-exec", "-f", sb_path, "sh", "-c", real_cmd])
    else:
        if profile not in PROFILES:
            print(f"  result: FAIL (unknown profile '{profile}'; valid: {', '.join(PROFILES)} or 'custom')")
            return 1
        with tempfile.NamedTemporaryFile(mode="w", suffix=".sb", delete=False) as f:
            f.write(PROFILES[profile])
            sb_path = f.name
        print(f"  pointer(macos-sandbox): profile={profile} cmd={cmd}")
        try:
            rc = subprocess.call(["sandbox-exec", "-f", sb_path, "sh", "-c", cmd])
        finally:
            os.unlink(sb_path)
    if rc == 0:
        print(f"  result: PASS (macos-sandbox profile={profile} exit=0)")
    else:
        print(f"  result: FAIL (macos-sandbox profile={profile} exit={rc})")
    return rc


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.stderr.write("usage: macos_sandbox_layer.py <profile> <cmd>\n")
        sys.exit(2)
    sys.exit(run(sys.argv[1], " ".join(sys.argv[2:])))
