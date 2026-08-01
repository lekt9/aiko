#!/usr/bin/env python3
"""Emit a bounded Contract graph skeleton; performs no Telegram actions."""

import argparse
import json


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["watch-message", "handle-update"])
    parser.add_argument("--person", default="specified contact")
    parser.add_argument("--notify-owner", action="store_true")
    args = parser.parse_args()

    children = [
        {"key": "observe", "plan": "Observe and normalize the Telegram update", "action": "telegram.updates.observe", "depends_on": []},
        {"key": "identity", "plan": f"Resolve identity for {args.person}", "depends_on": ["observe"]},
        {"key": "rules", "plan": "Match durable Telegram notification rules", "depends_on": ["observe"]},
        {"key": "log", "plan": "Record redacted event evidence", "depends_on": ["observe"]},
    ]
    if args.notify_owner:
        children.extend(
            [
                {"key": "authorize", "plan": "Verify owner notification permission", "depends_on": ["identity", "rules"]},
                {"key": "notify", "plan": "Notify the owner through Telegram", "action": "telegram.message.send", "depends_on": ["authorize", "log"], "requires_authorization": True, "authorization": "pending_authorization"},
            ]
        )
    graph = {
        "plan": f"Telegram {args.mode} contract for {args.person}",
        "action": "channel-event",
        "agent": "telegram-contracts",
        "children": children,
    }
    print(json.dumps(graph, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
