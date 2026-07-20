# Task: repair the durable leased job queue

The `jobqueue` package is a SQLite-backed queue intended to be safe across
threads, independent queue instances, and process restarts. Repair and complete
the implementation without changing its public classes or method signatures.
Use only the Python standard library.

Required behavior:

1. `enqueue(payload, idempotency_key, now)` durably stores JSON-compatible
   payloads. Reusing a non-empty idempotency key returns the original job id
   forever, including after completion, death, or reopening the database.
   Empty/`None` keys do not deduplicate.
2. `claim(worker_id, lease_seconds, now)` atomically returns at most one job.
   Across concurrent queue instances, a job may have only one live lease.
   Eligible work is ordered by `(available_at, insertion order)`.
3. A claim returns an unpredictable lease token. `attempts` increments exactly
   once for every successful claim, including reclamation after lease expiry.
4. A lease is live only while `lease_until > now`. At or after expiry, its old
   token is stale and cannot acknowledge, fail, or heartbeat the job.
5. `ack(job_id, lease_token, now)` completes only the current live lease.
   Duplicate or stale acknowledgements return `False` without changing state.
6. `fail(job_id, lease_token, error, now)` accepts only the current live lease.
   Before `max_attempts`, it makes the job pending at
   `now + base_backoff * 2 ** (attempts - 1)`. At `max_attempts`, it moves the
   job to `dead`. Failure text is persisted.
7. `heartbeat(job_id, lease_token, lease_seconds, now)` extends only a current
   live lease, setting its deadline to `now + lease_seconds`. It cannot revive
   an expired lease.
8. An expired lease below `max_attempts` becomes claimable again. An expired
   lease whose attempts already equal `max_attempts` becomes dead and must not
   block later eligible jobs.
9. State, attempts, payloads, errors, and idempotency survive closing and
   reopening the database. `close()` is idempotent.
10. Invalid configuration and lease durations are rejected. Malformed payload
    JSON in the database raises `QueueDataError`, not an arbitrary decoder
    exception.

Do not inspect files outside this repository. Add tests where useful.
