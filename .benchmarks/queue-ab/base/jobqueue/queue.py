from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import Path
from typing import Any, Optional

from .models import ClaimedJob, JobRecord


class DurableQueue:
    def __init__(
        self,
        path: str | Path,
        *,
        max_attempts: int = 3,
        base_backoff: float = 5.0,
    ):
        self.path = str(path)
        self.max_attempts = max_attempts
        self.base_backoff = base_backoff
        self._seen_keys: dict[str, str] = {}
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL UNIQUE,
                payload TEXT NOT NULL,
                state TEXT NOT NULL,
                attempts INTEGER NOT NULL,
                available_at REAL NOT NULL,
                lease_owner TEXT,
                lease_token TEXT,
                lease_until REAL,
                last_error TEXT,
                idempotency_key TEXT
            );
            """
        )

    def enqueue(
        self,
        payload: Any,
        idempotency_key: Optional[str] = None,
        *,
        now: float = 0.0,
    ) -> str:
        if idempotency_key and idempotency_key in self._seen_keys:
            return self._seen_keys[idempotency_key]
        job_id = uuid.uuid4().hex
        self._conn.execute(
            """
            INSERT INTO jobs
              (id, payload, state, attempts, available_at, idempotency_key)
            VALUES (?, ?, 'pending', 0, ?, ?)
            """,
            (job_id, json.dumps(payload), now, idempotency_key),
        )
        self._conn.commit()
        if idempotency_key:
            self._seen_keys[idempotency_key] = job_id
        return job_id

    def claim(
        self,
        worker_id: str,
        *,
        lease_seconds: float,
        now: float,
    ) -> Optional[ClaimedJob]:
        # Incorrect: selection and update are separate, so another connection
        # can claim the same row between these statements.
        row = self._conn.execute(
            """
            SELECT * FROM jobs
            WHERE (state = 'pending' AND available_at <= ?)
               OR (state = 'leased' AND lease_until < ?)
            ORDER BY available_at, seq
            LIMIT 1
            """,
            (now, now),
        ).fetchone()
        if row is None:
            return None
        token = worker_id  # Incorrect: predictable and reused.
        lease_until = now + lease_seconds
        attempts = row["attempts"] + 1
        self._conn.execute(
            """
            UPDATE jobs
            SET state='leased', attempts=?, lease_owner=?,
                lease_token=?, lease_until=?
            WHERE id=?
            """,
            (attempts, worker_id, token, lease_until, row["id"]),
        )
        self._conn.commit()
        return ClaimedJob(
            row["id"], json.loads(row["payload"]), attempts, token, lease_until
        )

    def ack(self, job_id: str, lease_token: str, *, now: float) -> bool:
        # Incorrect: ignores token and expiry.
        changed = self._conn.execute(
            "UPDATE jobs SET state='completed' WHERE id=? AND state='leased'",
            (job_id,),
        ).rowcount
        self._conn.commit()
        return changed == 1

    def fail(
        self,
        job_id: str,
        lease_token: str,
        error: str,
        *,
        now: float,
    ) -> bool:
        row = self._conn.execute(
            "SELECT * FROM jobs WHERE id=? AND state='leased'", (job_id,)
        ).fetchone()
        if row is None:
            return False
        if row["attempts"] > self.max_attempts:
            state = "dead"
            available_at = row["available_at"]
        else:
            state = "pending"
            available_at = now + self.base_backoff * 2 ** row["attempts"]
        self._conn.execute(
            """
            UPDATE jobs SET state=?, available_at=?, last_error=?,
              lease_owner=NULL, lease_token=NULL, lease_until=NULL
            WHERE id=?
            """,
            (state, available_at, error, job_id),
        )
        self._conn.commit()
        return True

    def heartbeat(
        self,
        job_id: str,
        lease_token: str,
        *,
        lease_seconds: float,
        now: float,
    ) -> bool:
        changed = self._conn.execute(
            "UPDATE jobs SET lease_until=? WHERE id=? AND state='leased'",
            (now + lease_seconds, job_id),
        ).rowcount
        self._conn.commit()
        return changed == 1

    def get(self, job_id: str) -> Optional[JobRecord]:
        row = self._conn.execute(
            "SELECT * FROM jobs WHERE id=?", (job_id,)
        ).fetchone()
        if row is None:
            return None
        return JobRecord(
            id=row["id"],
            payload=json.loads(row["payload"]),
            state=row["state"],
            attempts=row["attempts"],
            available_at=row["available_at"],
            lease_token=row["lease_token"],
            lease_until=row["lease_until"],
            last_error=row["last_error"],
            idempotency_key=row["idempotency_key"],
        )

    def close(self) -> None:
        self._conn.close()
