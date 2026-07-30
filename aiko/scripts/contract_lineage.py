#!/usr/bin/env python3
"""Append and verify tamper-evident, signed evaluation lineage records."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import math
import os
import secrets
import sys
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = "aiko-evaluation-lineage-v1"
FIELDS = (
    "schema", "prompt_sha256", "parent_sha256", "score", "run_id", "judge_id",
    "artifact_sha256", "eval_set_sha256", "provider_class", "timestamp", "previous_record_sha256",
)


def sha_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def key_bytes(path: Path | None) -> bytes:
    if path:
        data = path.read_bytes()
    elif value := os.environ.get("AIKO_EVAL_SIGNING_KEY"):
        data = value.encode()
    else:
        path = Path.home() / ".aiko" / "keys" / "evaluation-lineage.key"
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            descriptor = os.open(path, flags, 0o600)
            try:
                os.write(descriptor, secrets.token_bytes(32))
            finally:
                os.close(descriptor)
        mode = path.stat().st_mode & 0o777
        if mode & 0o077:
            raise ValueError(f"default signing key permissions are too broad: {oct(mode)}")
        data = path.read_bytes()
    if len(data) < 32:
        raise ValueError("evaluation signing key must contain at least 32 bytes")
    return data


def canonical(record: dict) -> bytes:
    return "\n".join(str(record[field]) for field in FIELDS).encode()


def record_hash(record: dict) -> str:
    return hashlib.sha256(
        json.dumps(record, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def load(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def append(args: argparse.Namespace) -> int:
    if not math.isfinite(args.score) or not 0.0 <= args.score <= 1.0:
        raise ValueError("score must be finite and between 0 and 1")
    rows = load(args.archive)
    record = {
        "schema": SCHEMA,
        "prompt_sha256": sha_file(args.prompt),
        "parent_sha256": args.parent_sha256 or "",
        "score": f"{args.score:.6f}",
        "run_id": args.run_id,
        "judge_id": args.judge_id,
        "artifact_sha256": sha_file(args.artifact),
        "eval_set_sha256": sha_file(args.eval_set),
        "provider_class": args.provider_class,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "previous_record_sha256": record_hash(rows[-1]) if rows else "",
    }
    record["signature"] = hmac.new(key_bytes(args.key_file), canonical(record), hashlib.sha256).hexdigest()
    args.archive.parent.mkdir(parents=True, exist_ok=True)
    with args.archive.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    print(record_hash(record))
    return 0


def verify(args: argparse.Namespace) -> int:
    rows = load(args.archive)
    key = key_bytes(args.key_file)
    previous = ""
    known_prompts: set[str] = set()
    for index, row in enumerate(rows, 1):
        if row.get("schema") != SCHEMA or row.get("previous_record_sha256") != previous:
            print(f"lineage verification failed at record {index}", file=sys.stderr)
            return 1
        expected = hmac.new(key, canonical(row), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(str(row.get("signature", "")), expected):
            print(f"signature verification failed at record {index}", file=sys.stderr)
            return 1
        parent = str(row.get("parent_sha256", ""))
        if parent and parent not in known_prompts:
            print(f"unknown parent at record {index}", file=sys.stderr)
            return 1
        known_prompts.add(str(row["prompt_sha256"]))
        previous = record_hash(row)
    print(f"verified {len(rows)} signed evaluation records")
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    commands = root.add_subparsers(dest="command", required=True)
    add = commands.add_parser("append")
    add.add_argument("--archive", type=Path, required=True)
    add.add_argument("--key-file", type=Path)
    add.add_argument("--prompt", type=Path, required=True)
    add.add_argument("--parent-sha256", default="")
    add.add_argument("--artifact", type=Path, required=True)
    add.add_argument("--eval-set", type=Path, required=True)
    add.add_argument("--score", type=float, required=True)
    add.add_argument("--run-id", required=True)
    add.add_argument("--judge-id", required=True)
    add.add_argument("--provider-class", required=True)
    add.set_defaults(run=append)
    check = commands.add_parser("verify")
    check.add_argument("--archive", type=Path, required=True)
    check.add_argument("--key-file", type=Path)
    check.set_defaults(run=verify)
    return root


def main() -> int:
    try:
        args = parser().parse_args()
        return args.run(args)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"lineage error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
