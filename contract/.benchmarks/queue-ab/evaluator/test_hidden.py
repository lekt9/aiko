import json
import sqlite3
import sys
import tempfile
import threading
import unittest
from pathlib import Path


SUBMISSION = Path(sys.argv.pop(1)).resolve()
sys.path.insert(0, str(SUBMISSION))

from jobqueue import DurableQueue, QueueDataError


class HiddenQueueTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "queue.db"

    def tearDown(self):
        self.tmp.cleanup()

    def test_invalid_configuration_and_lease_durations(self):
        for kwargs in (
            {"max_attempts": 0},
            {"max_attempts": -1},
            {"base_backoff": -0.1},
        ):
            with self.assertRaises((TypeError, ValueError)):
                DurableQueue(self.db, **kwargs)

        q = DurableQueue(self.db)
        try:
            q.enqueue("x")
            for duration in (0, -1):
                with self.assertRaises((TypeError, ValueError)):
                    q.claim("w", lease_seconds=duration, now=0)
                with self.assertRaises((TypeError, ValueError)):
                    q.heartbeat("missing", "token", lease_seconds=duration, now=0)
        finally:
            q.close()

    def test_empty_keys_do_not_deduplicate_but_real_key_is_permanent(self):
        q = DurableQueue(self.db)
        try:
            a = q.enqueue(1, None)
            b = q.enqueue(2, None)
            c = q.enqueue(3, "")
            d = q.enqueue(4, "")
            self.assertEqual(len({a, b, c, d}), 4)

            original = q.enqueue({"v": 1}, "forever")
            lease = q.claim("w", lease_seconds=10, now=0)
            # Earlier anonymous jobs come first; drain until the keyed job.
            while lease.id != original:
                self.assertTrue(q.ack(lease.id, lease.lease_token, now=1))
                lease = q.claim("w", lease_seconds=10, now=1)
            self.assertTrue(q.ack(original, lease.lease_token, now=2))
            self.assertEqual(q.enqueue({"v": 999}, "forever", now=50), original)
            self.assertEqual(q.get(original).payload, {"v": 1})
        finally:
            q.close()

    def test_exact_expiry_makes_all_old_token_operations_stale(self):
        q = DurableQueue(self.db)
        try:
            job_id = q.enqueue("x")
            lease = q.claim("w", lease_seconds=5, now=10)
            self.assertFalse(q.ack(job_id, lease.lease_token, now=15))
            self.assertFalse(
                q.fail(job_id, lease.lease_token, "late", now=15)
            )
            self.assertFalse(
                q.heartbeat(
                    job_id,
                    lease.lease_token,
                    lease_seconds=5,
                    now=15,
                )
            )
            replacement = q.claim("w2", lease_seconds=5, now=15)
            self.assertEqual(replacement.id, job_id)
            self.assertNotEqual(replacement.lease_token, lease.lease_token)
            self.assertEqual(replacement.attempts, 2)
        finally:
            q.close()

    def test_heartbeat_extends_only_live_matching_lease(self):
        q = DurableQueue(self.db)
        try:
            job_id = q.enqueue("x")
            lease = q.claim("w", lease_seconds=5, now=0)
            self.assertFalse(
                q.heartbeat(job_id, "wrong", lease_seconds=20, now=1)
            )
            self.assertTrue(
                q.heartbeat(
                    job_id,
                    lease.lease_token,
                    lease_seconds=20,
                    now=1,
                )
            )
            self.assertEqual(q.get(job_id).lease_until, 21)
            self.assertIsNone(q.claim("other", lease_seconds=5, now=6))
        finally:
            q.close()

    def test_backoff_formula_and_dead_letter_threshold(self):
        q = DurableQueue(self.db, max_attempts=3, base_backoff=2)
        try:
            job_id = q.enqueue("x")
            first = q.claim("w", lease_seconds=5, now=0)
            self.assertTrue(q.fail(job_id, first.lease_token, "one", now=1))
            self.assertEqual(q.get(job_id).available_at, 3)

            second = q.claim("w", lease_seconds=5, now=3)
            self.assertTrue(q.fail(job_id, second.lease_token, "two", now=4))
            self.assertEqual(q.get(job_id).available_at, 8)

            third = q.claim("w", lease_seconds=5, now=8)
            self.assertTrue(q.fail(job_id, third.lease_token, "three", now=9))
            record = q.get(job_id)
            self.assertEqual(record.state, "dead")
            self.assertEqual(record.attempts, 3)
            self.assertEqual(record.last_error, "three")
            self.assertIsNone(q.claim("w", lease_seconds=5, now=1000))
        finally:
            q.close()

    def test_expired_final_attempt_dies_and_does_not_block_next_job(self):
        q = DurableQueue(self.db, max_attempts=1)
        try:
            first_id = q.enqueue("first", now=0)
            first = q.claim("w", lease_seconds=5, now=0)
            self.assertEqual(first.id, first_id)
            second_id = q.enqueue("second", now=1)

            claimed = q.claim("w2", lease_seconds=5, now=5)
            self.assertEqual(q.get(first_id).state, "dead")
            self.assertEqual(claimed.id, second_id)
        finally:
            q.close()

    def test_order_is_available_time_then_insertion(self):
        q = DurableQueue(self.db)
        try:
            late = q.enqueue("late", now=10)
            first = q.enqueue("first", now=2)
            second = q.enqueue("second", now=2)
            self.assertEqual(
                q.claim("w", lease_seconds=1, now=2).id, first
            )
            # Ack so the next insertion-order peer is eligible.
            first_record = q.get(first)
            self.assertTrue(q.ack(first, first_record.lease_token, now=2.5))
            lease2 = q.claim("w", lease_seconds=1, now=2.5)
            self.assertEqual(lease2.id, second)
            self.assertTrue(q.ack(second, lease2.lease_token, now=2.75))
            self.assertEqual(
                q.claim("w", lease_seconds=1, now=10).id, late
            )
        finally:
            q.close()

    def test_concurrent_queue_instances_never_double_claim(self):
        q1 = DurableQueue(self.db)
        q2 = DurableQueue(self.db)
        try:
            job_id = q1.enqueue({"work": True})
            barrier = threading.Barrier(3)
            results = []
            errors = []

            def run(queue, worker):
                try:
                    barrier.wait()
                    results.append(
                        queue.claim(worker, lease_seconds=30, now=0)
                    )
                except BaseException as exc:
                    errors.append(exc)

            threads = [
                threading.Thread(target=run, args=(q1, "a")),
                threading.Thread(target=run, args=(q2, "b")),
            ]
            for thread in threads:
                thread.start()
            barrier.wait()
            for thread in threads:
                thread.join(timeout=5)

            self.assertEqual(errors, [])
            claimed = [item for item in results if item is not None]
            self.assertEqual(len(claimed), 1)
            self.assertEqual(claimed[0].id, job_id)
            self.assertEqual(q1.get(job_id).attempts, 1)
        finally:
            q1.close()
            q2.close()

    def test_state_and_error_survive_reopen(self):
        q = DurableQueue(self.db, max_attempts=3, base_backoff=3)
        job_id = q.enqueue({"nested": [1, True, None]}, "stable", now=2)
        lease = q.claim("w", lease_seconds=10, now=2)
        q.fail(job_id, lease.lease_token, "transient", now=3)
        q.close()

        reopened = DurableQueue(self.db, max_attempts=3, base_backoff=3)
        try:
            record = reopened.get(job_id)
            self.assertEqual(record.payload, {"nested": [1, True, None]})
            self.assertEqual(record.state, "pending")
            self.assertEqual(record.attempts, 1)
            self.assertEqual(record.last_error, "transient")
            self.assertEqual(reopened.enqueue("changed", "stable"), job_id)
        finally:
            reopened.close()

    def test_malformed_payload_raises_queue_data_error(self):
        q = DurableQueue(self.db)
        try:
            job_id = q.enqueue({"ok": True})
            q._conn.execute(
                "UPDATE jobs SET payload='not-json' WHERE id=?", (job_id,)
            )
            q._conn.commit()
            with self.assertRaises(QueueDataError):
                q.get(job_id)
        finally:
            q.close()

    def test_close_is_idempotent(self):
        q = DurableQueue(self.db)
        q.close()
        q.close()

    def test_wrong_token_fail_has_no_side_effects(self):
        q = DurableQueue(self.db)
        try:
            job_id = q.enqueue("x")
            lease = q.claim("w", lease_seconds=10, now=0)
            before = q.get(job_id)
            self.assertFalse(q.fail(job_id, "wrong", "poison", now=1))
            after = q.get(job_id)
            self.assertEqual(after.state, before.state)
            self.assertEqual(after.available_at, before.available_at)
            self.assertEqual(after.last_error, before.last_error)
            self.assertEqual(after.lease_token, lease.lease_token)
        finally:
            q.close()


if __name__ == "__main__":
    unittest.main()
