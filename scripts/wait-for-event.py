#!/usr/bin/env python3
"""wait-for-event.py — block until a matching event row appears in an inbox.

A receptor contract has an action like:

    wait-for-event.py --inbox telegram --filter 'ping'

The script tails ~/.contracts/inbox/<channel>/*.jsonl looking for a row whose
JSON body matches the regex filter. It also accepts a --since-id (numeric
message_id) and a --json-field/--json-equals pair for structured matches.

Exits 0 on match (PASS for the cell), 1 on timeout/no-match, 2 on usage error.

The substrate enables: this script never writes a ledger row, never marks
anything satisfied. The contract CLI does that on KEY 2.
"""

import argparse, json, os, re, sys, time
from pathlib import Path

INBOX_ROOT = Path(os.path.expanduser("~/.contracts/inbox"))


def iter_rows(channel, since_ts):
    base = INBOX_ROOT / channel
    if not base.exists():
        return
    files = sorted(base.glob("*.jsonl"))
    for f in files:
        if f.stat().st_mtime < since_ts - 1:
            continue
        try:
            with f.open() as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        yield json.loads(line), f
                    except json.JSONDecodeError:
                        continue
        except FileNotFoundError:
            continue


def matches(row, filter_regex, field, equals, since_id):
    if since_id is not None:
        mid = row.get("message_id") or row.get("id")
        if mid is None or int(mid) <= since_id:
            return False
    if field is not None:
        cur = row
        for k in field.split("."):
            if isinstance(cur, dict) and k in cur:
                cur = cur[k]
            else:
                cur = None
                break
        if equals is not None and str(cur) != equals:
            return False
    if filter_regex is not None:
        if not filter_regex.search(json.dumps(row, ensure_ascii=False)):
            return False
    return True


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--inbox", required=True, help="Channel under ~/.contracts/inbox/")
    p.add_argument("--filter", default=None, help="Regex against the full JSON row")
    p.add_argument("--field", default=None, help="Dotted JSON path to a field (e.g. sender.username)")
    p.add_argument("--equals", default=None, help="Exact-string match for --field")
    p.add_argument("--since-id", type=int, default=None, help="Only consider rows whose message_id/id is greater")
    p.add_argument("--timeout", type=float, default=30.0)
    p.add_argument("--poll", type=float, default=1.0)
    args = p.parse_args()

    regex = re.compile(args.filter) if args.filter else None
    start = time.time()
    while True:
        for row, _f in iter_rows(args.inbox, start):
            if matches(row, regex, args.field, args.equals, args.since_id):
                print(json.dumps({"matched": True, "row": row}))
                return 0
        if time.time() - start >= args.timeout:
            print(json.dumps({"matched": False, "timeout": args.timeout}), file=sys.stderr)
            return 1
        time.sleep(args.poll)


if __name__ == "__main__":
    sys.exit(main())
