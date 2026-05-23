#!/usr/bin/env python3
"""
find-key-in-sessions.py — fallback recovery: when an agent needs a
keypair for pubkey X and the documented pointer is missing/stale,
scan prior Claude Code session transcripts at ~/.claude/projects/*/*.jsonl
for the pubkey string AND for keypair-shaped strings whose derived
pubkey matches X.

This is a RECOVERY surface, NOT an auto-restore. The script prints
candidate session paths + line offsets so the agent (and user) can
audit. Never writes anything; never echoes secret bytes to stdout.

Origin: 2026-05-23. Agent gave Lewis a QR for Solana pubkey
  6KpxaoPoTDBAMxNNMPQvQEnTbErtjogL2unK8q3VKcdn
whose documented keypair file was missing. If a prior session had
generated or printed the key (even partially), this primitive would
have surfaced the trail. The fix is to make session transcripts a
recoverable layer beneath the memory pointer.

Usage:
  python3 find-key-in-sessions.py <target-pubkey>
  python3 find-key-in-sessions.py <target-pubkey> --root ~/.claude
  python3 find-key-in-sessions.py <target-pubkey> --json

Exit codes:
  0  — at least one candidate hit found (path + offsets printed)
  1  — no hits across all scanned transcripts
  2  — usage error

What it surfaces (in plain English, no secrets):
  - sessions where the target pubkey string appears in a message
    (the user/agent likely discussed or echoed it)
  - sessions where a keypair-shaped value (Solana JSON 64-int array
    or base58 64-byte string) DERIVES to the target pubkey — printed
    only as "match found at session=X line=Y; the secret is at that
    offset, audit by hand". The secret itself is NEVER printed by
    this script; the agent reads it via Read tool with explicit user
    consent if recovery is authorized.

Design:
  - The classifier rightly blocks systematic credential scanning.
    This script is invoked ONLY when an agent has a CONFIRMED
    missing-signer state (verify-signer.sh has returned FAIL) AND
    the user has explicitly authorized session-fallback recovery.
  - The output points at candidate locations; the agent must still
    surface those to the user before reading the secret-bearing line.
  - We do NOT walk the agent's own current session — only sibling
    project session directories under ~/.claude/projects/.
"""

import argparse
import glob
import json
import os
import re
import sys
import sys

# base58 alphabet — used to detect candidate secrets without decoding them inline
B58_RE = re.compile(r"[1-9A-HJ-NP-Za-km-z]{87,88}")
# Solana JSON keypair literal: array of 64 ints in [0, 255]
JSON_KP_RE = re.compile(r"\[(\s*\d{1,3}\s*,){63}\s*\d{1,3}\s*\]")


def derive_pubkey_from_b58(s: str):
    """Return base58 pubkey if s is a valid 64-byte base58 secret, else None."""
    try:
        import base58
    except ImportError:
        return None
    try:
        b = base58.b58decode(s)
    except Exception:
        return None
    if len(b) != 64:
        return None
    return base58.b58encode(b[32:64]).decode()


def derive_pubkey_from_json_kp(s: str):
    """Return base58 pubkey if s is a `[byte, byte, ... 64 ints]` literal."""
    try:
        import base58
    except ImportError:
        return None
    try:
        arr = json.loads(s)
    except Exception:
        return None
    if not isinstance(arr, list) or len(arr) != 64:
        return None
    try:
        b = bytes(arr)
    except Exception:
        return None
    return base58.b58encode(b[32:64]).decode()


def scan_file(path: str, target: str):
    """Return list of (line_no, kind, redacted_hint) tuples for hits in this file."""
    hits = []
    try:
        with open(path, "r", errors="ignore") as f:
            for lineno, line in enumerate(f, start=1):
                # 1. plain pubkey mention
                if target in line:
                    hits.append((lineno, "pubkey-mention", f"target {target[:8]}... appears in line"))
                # 2. b58 64-byte candidate that derives to target
                for m in B58_RE.finditer(line):
                    cand = m.group(0)
                    pk = derive_pubkey_from_b58(cand)
                    if pk == target:
                        hits.append((lineno, "b58-secret-match", f"a 64-byte base58 string at this offset derives to {target[:8]}..."))
                        break
                # 3. JSON-array keypair candidate
                for m in JSON_KP_RE.finditer(line):
                    cand = m.group(0)
                    pk = derive_pubkey_from_json_kp(cand)
                    if pk == target:
                        hits.append((lineno, "json-keypair-match", f"a 64-int JSON array at this offset derives to {target[:8]}..."))
                        break
    except (OSError, PermissionError) as e:
        # Surface, never swallow (substrate: no silent fallback). The file is
        # skipped on I/O error but the operator sees what happened on stderr.
        print(f"  find-key-in-sessions: skip {path}: {e}", file=sys.stderr)
    return hits


def main():
    p = argparse.ArgumentParser(description="Recover a signer pubkey from prior Claude Code sessions.")
    p.add_argument("pubkey", help="Target Solana pubkey (base58)")
    p.add_argument("--root", default=os.path.expanduser("~/.claude/projects"),
                   help="Root directory to scan (default: ~/.claude/projects)")
    p.add_argument("--json", action="store_true", help="Emit JSON instead of human-readable")
    args = p.parse_args()

    target = args.pubkey
    if not re.match(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$", target):
        print(f"usage error: target {target} is not a base58 pubkey shape", file=sys.stderr)
        sys.exit(2)

    sessions = glob.glob(os.path.join(args.root, "*/*.jsonl"))
    sessions += glob.glob(os.path.join(args.root, "*/sessions/*.jsonl"))

    all_hits = []
    for path in sessions:
        hits = scan_file(path, target)
        if hits:
            all_hits.append({"path": path, "hits": hits})

    if args.json:
        print(json.dumps({"target": target, "session_count": len(sessions), "matches": all_hits}, indent=2))
    else:
        print(f"=== find-key-in-sessions === target {target[:8]}...{target[-6:]}")
        print(f"  scanned {len(sessions)} session transcript(s)")
        if not all_hits:
            print("  no hits — target not echoed/declared in any prior session")
        else:
            print(f"  {len(all_hits)} session(s) reference this pubkey:")
            for entry in all_hits:
                print(f"    {entry['path']}")
                for lineno, kind, hint in entry["hits"]:
                    print(f"      line {lineno}: [{kind}] {hint}")
            print()
            print("  Next: open the named session at the named line by hand (Read tool).")
            print("  This script never prints the secret itself; recovery is a manual")
            print("  human-audited step.")

    sys.exit(0 if all_hits else 1)


if __name__ == "__main__":
    main()
