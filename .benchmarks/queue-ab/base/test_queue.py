import tempfile
import unittest
from pathlib import Path

from jobqueue import DurableQueue


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "jobs.db"
        self.queue = DurableQueue(self.db, max_attempts=3, base_backoff=10)

    def tearDown(self):
        self.queue.close()
        self.tmp.cleanup()

    def test_enqueue_claim_ack(self):
        job_id = self.queue.enqueue({"kind": "email"}, "email-1", now=1)
        claimed = self.queue.claim("worker-a", lease_seconds=30, now=1)
        self.assertEqual(claimed.id, job_id)
        self.assertEqual(claimed.payload, {"kind": "email"})
        self.assertEqual(claimed.attempts, 1)
        self.assertTrue(self.queue.ack(job_id, claimed.lease_token, now=2))
        self.assertEqual(self.queue.get(job_id).state, "completed")

    def test_retry_backoff(self):
        job_id = self.queue.enqueue("work", now=0)
        first = self.queue.claim("w", lease_seconds=5, now=0)
        self.assertTrue(self.queue.fail(job_id, first.lease_token, "no", now=1))
        self.assertIsNone(self.queue.claim("w", lease_seconds=5, now=10))
        second = self.queue.claim("w", lease_seconds=5, now=11)
        self.assertEqual(second.attempts, 2)

    def test_wrong_token_cannot_ack(self):
        job_id = self.queue.enqueue("work")
        self.queue.claim("worker", lease_seconds=10, now=0)
        self.assertFalse(self.queue.ack(job_id, "wrong", now=1))
        self.assertEqual(self.queue.get(job_id).state, "leased")

    def test_idempotency_survives_reopen(self):
        first = self.queue.enqueue({"x": 1}, "same", now=0)
        self.queue.close()
        self.queue = DurableQueue(self.db)
        second = self.queue.enqueue({"x": 2}, "same", now=99)
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
