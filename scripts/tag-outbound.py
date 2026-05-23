#!/usr/bin/env python3
"""tag-outbound.py — record outbound channel writes for origin-chain tracing.

Companion to the mail-stdin doctrine (contract b2d15246, 2026-05-24). When
a contract action sends an outbound (Telegram message, X post, email, etc.),
it calls this helper to append a row to:

    ~/.contracts/outbox/<channel>/<msg-id>.jsonl

The row carries {origin_contract_id, message_id, channel, sent_at,
reply_to?}. When the inbound poller later sees a reply whose reply_to ==
<msg-id>, it can look up the originating contract id via this outbox and
stage a pending inbox event for it (~/.contracts/inbox-pending/<cid>.json),
which the next iterate picks up on stdin. That closes the loop:

    outbound (contract A sends msg X)
       → inbound reply (poller sees reply_to=X)
       → outbox lookup (X → contract A)
       → stage event for A
       → next iterate → A's action reads stdin → calls `contract context A`
       → loads originating context → chains forward.

Usage:
    tag-outbound.py --channel telegram --message-id 12345 \\
                    --origin-contract-id abc12345 [--reply-to 999]
                    [--extra-json '{"thread_id":2738}']

Exits 0 on success, 2 on usage error, 3 if the outbox row could not be
written (filesystem issue surfaced honestly).
"""
from __future__ import annotations
import argparse, json, os, sys
from datetime import datetime, timezone
from pathlib import Path

OUTBOX_ROOT = Path(os.path.expanduser("~/.contracts/outbox"))


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--channel", required=True, help="e.g. telegram, x, email, webhook")
    p.add_argument("--message-id", required=True, help="the outbound's message id")
    p.add_argument("--origin-contract-id", required=True, help="contract that caused this send")
    p.add_argument("--reply-to", default=None, help="if this outbound is itself a reply")
    p.add_argument("--extra-json", default=None, help="extra fields as JSON object")
    args = p.parse_args()

    if not args.channel.strip() or not args.message_id.strip() or not args.origin_contract_id.strip():
        sys.stderr.write("usage: tag-outbound.py --channel <c> --message-id <id> --origin-contract-id <cid>\n")
        return 2

    row = {
        "channel": args.channel.strip(),
        "message_id": args.message_id.strip(),
        "origin_contract_id": args.origin_contract_id.strip(),
        "sent_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if args.reply_to:
        row["reply_to"] = args.reply_to.strip()
    if args.extra_json:
        try:
            extra = json.loads(args.extra_json)
            if isinstance(extra, dict):
                row.update(extra)
        except json.JSONDecodeError as e:
            sys.stderr.write(f"--extra-json must be a JSON object: {e}\n")
            return 2

    channel_dir = OUTBOX_ROOT / args.channel.strip()
    try:
        channel_dir.mkdir(parents=True, exist_ok=True)
        out = channel_dir / f"{args.message_id.strip()}.jsonl"
        with out.open("a") as fh:
            fh.write(json.dumps(row) + "\n")
    except OSError as e:
        sys.stderr.write(f"tag-outbound: could not write outbox row: {e}\n")
        return 3

    print(json.dumps({"ok": True, "outbox": str(out), "row": row}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
