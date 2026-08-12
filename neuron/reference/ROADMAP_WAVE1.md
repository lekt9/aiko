# Roadmap wave 1 — compaction, daemon availability, admitted drainer

> **Historical.** Dated roadmap wave. Not current product documentation. What the tree is today: [../../docs/SOURCE-OF-TRUTH.md](../../docs/SOURCE-OF-TRUTH.md).

Status: ACTIVE 2026-07-27 (jesus-ralph loop; gate `bash tests/roadmap-wave1-gate.sh`)

Wave selection per the roadmap review on 2026-07-27: the two sharpest
operational debts first (same antipattern genre as the settled remediation
plan), then R1's lifecycle witness — the item that converts a prototype into
the first reusable admitted limb, which is the architectural point of §30.

Scope follows the recommendation recorded in the review: journal compaction +
server-side read deadlines, then the outbox-drainer lifecycle. Explicitly NOT
in this wave (queued, in roadmap priority order): R2 energy-router completion,
R3 fan-out/pipeline limbs, R4 telemetry→advisor loop, R5 immutable source pin,
cross-machine artifact sync, mesh-wide cache dedupe. R6 stays intentionally
out (Contract/Aiko is the production profile).

Every item settles through a runnable witness. File presence, prose, and a
green document validator are not completion.

---

## W1. Journal compaction / GC (§22)

**Gap.** A1's durable substrate journal (`neuron.substrate/v1` JSON-lines WAL)
replays faithfully but grows forever: superseded artifact writes, intermediate
delivery transitions, and settled firing records accumulate without bound.
§22 requires garbage collection that preserves anything reachable from a
retention root, audit hold, live topology, or admitted cache entry.

**Shape.** `Substrate.compact()` folds the entire live state — the retention
closure: every artifact, every message with its current delivery state, every
spawned neuron with its grant, every firing record — into one `snapshot`
record, written to a sibling temp file that is fsynced and atomically renamed
over `substrate.log` while the exclusive lock is continuously held (the temp
file is locked before rename; the lock follows the inode). The pre-rename log
is untouched on any earlier failure, so compaction fails closed.

Replay rules: a `snapshot` record is valid only as the first record (a mid-log
snapshot is `error.CorruptLog`); messages inside a snapshot carry their
delivery status and attempts so positional delivery indices stay stable for
records appended after the snapshot. Snapshot serialization is deterministic
(map keys sorted) so identical states produce identical bytes.

Operator surface: `neuron compact <state_dir>` — replays, snapshots, prints
before/after sizes.

**Witnesses** (in `zig build test`):
- compaction folds history and preserves the exact committed state:
  fingerprint (artifacts/messages/statuses/neurons/firings) identical before
  and after, log shrinks to one line, post-compaction commits append and
  reopen-replay reproduces the same state again;
- rejection paths fail closed: torn snapshot line, mid-log snapshot, and a
  delivery record with an out-of-range index after a snapshot are all
  `error.CorruptLog`.

Operator witness: `tests/compact-witness.sh` round-trips a journaled state
dir through the MCP edge, compacts via the CLI, and asserts continuity
(surviving artifacts, one-line log, further commits append).

## W2. Daemon head-of-line blocking / server-side read deadlines

**Gap.** `tailnet.serve` is sequential: one accepted connection is served to
EOF before the next accept. A peer that trickles bytes slowly (slow-loris)
wedges every other peer, and server-side reads have no deadline — B2 bounded
the client; the accept side is the mirror.

**Shape.** `tailnet.serve` accepts each connection onto its own thread with:
- a bounded in-flight connection count — connections beyond the cap are
  closed unread (fail closed under load);
- one absolute monotonic deadline per connection, shared by every read and
  write on that connection (the mirror of `dialExchange`'s bounded path:
  non-blocking fd + poll-gated `readFrameBounded`/`writeAllBounded`);
- commits serialized through a daemon-held mutex (the substrate is
  single-writer; concurrency is between reads and other peers, never inside
  the commit critical section);
- a stop predicate for clean shutdown: serve returns after in-flight
  connections drain (WaitGroup), so tests and operators get a real lifecycle.

The sequential `acceptOnce`/`serveConnection` paths stay for single-shot
tests and the signed-mesh edge; the daemon is the concurrent path.

**Witness** (in `zig build test`): slow-loris — peer A sends a partial frame
and holds; peer B's well-formed envelope is committed and answered while A is
still stuck; A's connection is closed by its budget; everything A never sent
committed nothing; in-flight cap closes excess connections.

## W3. Outbox-drainer generative-limb lifecycle (R1, §30)

**Gap.** `limbs/outbox-drainer/` has its policy core, manifest, and
full-driver conformance witness, but the generative-limb lifecycle is open:
admit by digest → attach via typed edge with a narrow grant → operate through
ordinary firings → judge → revoke → detach → garbage-collect. The reference
Meta-Agent demonstrates this lifecycle for a limb it generated itself; R1
requires it for the outbox-drainer package, plus honest ledger rows for
duplicate suppression, bounded retry, and dead-letter under the *admitted*
path.

**Shape.** A lifecycle witness that drives the package through the runtime's
real admission machinery (content digest pin, schema validation, narrow
capability grant scoped to the outbox schemas and write prefixes) and the
ordinary firing path — never a private back door — then asserts: decisions
match the conformance outcome classes; a grant narrower than the limb's
needs fails closed; after revocation firings are denied; after detach the
limb's unreachable artifacts are collected while audit roots remain
readable.

**Witness:** `python3 limbs/outbox-drainer/tests/lifecycle.py` (exit 0),
folded into the wave gate; ledger rows land in
`bench/jespa/benchmarks-ledger.jsonl` only with real reproduced numbers.

---

## Settlement record

- ~~W3. Outbox-drainer generative-limb lifecycle (R1, §30)~~ — SETTLED
  2026-07-27 (contract `ffbd8aa7`). Evidence:
  `src/limb_ops.zig` implements the harness admission boundary: `computePackageDigest`
  (SHA-256 over ordered manifest + script files + schemas/*), `admit` (validate +
  digest-pin + journaled admission record, idempotent), `limbRun` (digest-checked
  with admitted caps from the immutable record, not a mutable file — drift = fail
  closed), `revoke` (§24 block), `detach` (§22 GC over admitted write prefixes
  via `op:"gc"` journaled deletions, preserving audit roots). `substrate.zig`
  gains `journalGc`/`gcArtifacts` + replay support. CLI: `neuron limb admit|run|
  revoke|detach|inspect`. `lifecycle.py` drives the full §30 sequence: admit
  (idempotent), operate (admitted drainer + reconciler firings), duplicate
  suppression across runs (non-zero skipped), FiringMismatch fail-closed, secret
  absence, revoke (denied), detach + GC (4→3 artifacts, firings intact).
  `python3 limbs/outbox-drainer/tests/lifecycle.py` exit 0.
  `zig build test` 83/83, `zig build`, both standing gates green.

- ~~W1. Journal compaction / GC (§22)~~ — SETTLED 2026-07-27 (contract
  `1f88eaec`). Evidence: `Substrate.compact()` folds the retention closure
  (artifacts, messages with delivery state, spawned neurons with grants,
  firing records) into one deterministic `snapshot` record; the temp file is
  synced and locked before an atomic rename so the single-writer lock follows
  the inode and pre-rename state is untouched on failure. Rejection paths:
  mid-log snapshot, torn snapshot, out-of-range post-snapshot delivery index,
  unknown delivery status — all `error.CorruptLog`; in-memory substrates get
  `error.NoJournal`. Witnesses: `zig build test` 82/82 (was 80; +2:
  "journal compaction folds history into a snapshot and preserves committed
  state", "journal compaction rejects torn, misplaced, and out-of-range
  snapshot records"), `bash tests/compact-witness.sh` PASS (MCP-edge commits
  → live-lock refusal → CLI fold 664B→594B → replay continuity), `zig build`
  exit 0, `bash tests/runtime-gate.sh` exit 0, `bash tests/gate.sh` exit 0.
- ~~W2. Daemon head-of-line blocking / server-side read deadlines~~ — SETTLED
  2026-07-27 (contract `dcdfba9f`). Evidence: `tailnet.serve` now serves each
  classified connection on its own thread under one absolute monotonic
  deadline shared by every read and write (`mesh.serveConnectionBounded`,
  non-blocking fd + poll, the accept-side mirror of `dialExchange`); the
  in-flight cap (default 64) closes excess peers unread; commits serialize
  through a daemon-held `std.Io.Mutex`; a stop predicate plus wakeup
  connection gives clean shutdown with drain bounded by one connection
  budget (hand-rolled `Drain`: the 0.16 stdlib has no WaitGroup). Witness:
  "slow-loris peer neither wedges the daemon nor outlives its connection
  budget" — a trickling peer's partial frame never commits and is cut at its
  budget while a well-formed peer is admitted, committed, and answered;
  with all 4 slots held by tricklers the 5th connection is closed unread.
  `zig build test` 83/83 (was 82), `zig build` exit 0, both standing gates
  exit 0.
