#!/usr/bin/env python3
"""Offline tests for inventory classification + queue identity."""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

import inventory
import jobqueue


class InventoryTests(unittest.TestCase):
    def test_decode_claude_project(self) -> None:
        self.assertEqual(
            inventory.decode_claude_project("-home-deck-work-commons"),
            "/home/deck/work/commons",
        )

    def test_classify_claude_unfinished_queue(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            project = Path(td) / "-home-deck-work-x"
            project.mkdir()
            path = project / "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
            rows = [
                {"type": "queue-operation", "operation": "enqueue", "sessionId": path.stem},
                {"type": "queue-operation", "operation": "dequeue", "sessionId": path.stem},
                {"type": "queue-operation", "operation": "enqueue", "sessionId": path.stem},
                {"type": "last-prompt", "lastPrompt": "finish me"},
            ]
            path.write_text("".join(json.dumps(r) + "\n" for r in rows))
            row = inventory.classify_claude(path, running=set())
            self.assertIsNotNone(row)
            assert row is not None
            self.assertEqual(row["harness"], "claude")
            self.assertTrue(any(r.startswith("unfinished_queue") for r in row["reasons"]))
            self.assertEqual(row["cwd"], "/home/deck/work/x")


class QueueTests(unittest.TestCase):
    def test_enqueue_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            os.environ["HOME"] = td
            inv = {
                "sessions": [
                    {
                        "harness": "claude",
                        "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                        "cwd": "/tmp",
                        "path": "/tmp/x.jsonl",
                        "reasons": ["stalled:last-prompt"],
                        "running": False,
                    }
                ]
            }
            first = jobqueue.enqueue_from_inventory(inv, now=1)
            second = jobqueue.enqueue_from_inventory(inv, now=2)
            self.assertEqual(first["added"], 1)
            self.assertEqual(second["added"], 0)
            self.assertEqual(jobqueue.summary()["pending"], 1)


if __name__ == "__main__":
    raise SystemExit(unittest.main(verbosity=2))
