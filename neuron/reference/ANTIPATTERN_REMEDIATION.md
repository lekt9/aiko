# Antipattern remediation plan

Status: SETTLED 2026-07-27 — every item struck with gate evidence below;
80/80 tests, `zig build`, `tests/runtime-gate.sh`, and `tests/gate.sh`
all exit 0 on the final state.

`AGENTS.md` defines the target. `IMPLEMENTATION.md` records what exists. This
file is the ordered plan for the implementation antipatterns found in review
on 2026-07-27. Every item lands as one PR-sized change with a runnable
witness and green gates, and is struck through here when its witness passes.

Dependency note: none of this work touches the Contract repo. Neuron builds
and gates on a bare clone; Contract is a consumer of the canonical wire
package (§18), never a dependency of this remediation.

## Process contract for every item

- One `contract task begin ... --check "zig build test && bash tests/runtime-gate.sh"`
  per item; `contract task verify` after the gates pass.
- `zig build test`, `bash tests/runtime-gate.sh`, and `bash tests/gate.sh`
  all green before the item is called settled.
- Honesty counts (`bench/jespa/runtime_tasks.py`,
  `bench/jespa/benchmarks-ledger.jsonl`) updated in the same change — until
  C1 lands, by hand; after C1, mechanically.
- Algorithm order per item: question → delete → simplify → accelerate →
  automate. Deletion before addition.

## Wave 1 — highest leverage

### ~~A1. Durable substrate behind `src/substrate.zig`~~ — SETTLED 2026-07-27

**Evidence.** Contract task `4c9ce409` verified. `zig build test` 73/73,
`bash tests/runtime-gate.sh` PASS, `bash tests/gate.sh` PASS. Witness test:
"durable substrate survives restart with dedupe and delivery state intact"
(restart preserves artifacts, delivery status, firing-id dedupe; torn tail →
`error.CorruptLog`; live dir → `error.SubstrateLocked`). `neuron serve` /
`neuron mcp` take an optional `[state_dir]`; in-memory remains the default
so the gate CLI assertions are unchanged. Journal: one
`neuron.substrate/v1` JSON line per commit, WAL before in-memory mutation,
fsync per record, exclusive `O_EXLOCK` single-writer.

**Problem.** The reference substrate is process-local hash maps. Restart is
total amnesia: artifacts, message dedupe state, firing records, and CAS
pointers all vanish. §9 specifies self-generative persistence and §22
specifies partition semantics, but the runtime implements neither — mesh
"partitions" are per-process heaps.

**Fix.** Append-only, schema-versioned commit log on disk behind the
existing Substrate API, replayed at boot. Committed artifacts as
content-addressed blobs; named mutable pointers stay CAS through
`expectedPrior` (§22). The API surface does not change; runtime and tests
are untouched except construction taking a directory path. Corrupt or
truncated log tails fail closed as typed errors (§27), never partial state.
Log compaction/GC is explicit follow-up, not bundled.

**Witness.** Commit artifacts and a firing, drop the runtime, construct a
fresh one on the same directory: artifacts readable, redelivery of the same
firing id still deduped (§21 survives restart), a truncated tail produces a
typed error and zero commits.

**Scope.** Single node only. Cross-machine artifact sync is separate future
work and is not implied here.

### ~~A2. Per-peer ceilings via `tailscale whois` (tailnet v1.5)~~ — SETTLED 2026-07-27

**Evidence.** Contract task `63151e0c` verified. `zig build test` 76/76,
`bash tests/runtime-gate.sh` exit 0, `bash tests/gate.sh` exit 0. Witnesses:
"ceiling table parses strictly and denies by default" (wrong schema,
duplicate identity, unknown field, empty identity, malformed JSON →
InvalidTable), "per-peer ceilings pin each tailnet peer to its own
authority" (alice commits to `artifact/alice/`, cross-prefix reach into
`artifact/bob/` dies as CapabilityDenied, unlisted identity → deny, adapter
failure → deny, off-tailnet never consults the adapter), "whois cache
honors its TTL and re-resolves after expiry" (failures never cached).
`neuron serve ... [ceilings.json]` opts in; the single-ceiling classifier
remains the default. Daemon clock is still fixed (cache entries stay fresh
at now=0) — real clocks are B1.

**Problem.** `tailnetClassifier` pins one ceiling for every CGNAT peer
(`src/tailnet.zig`). Any machine admitted to the tailnet holds identical
power; §24 least-authority stops at the subnet boundary.

**Fix.** Classifier v2: peer IP → `tailscale whois --json <ip>` → tailnet
node identity → operator-configured ceiling table (schema-versioned JSON,
deny-by-default for unlisted nodes). The whois call sits behind an injected
adapter so tests never shell out; results cached per IP with a TTL; whois
failure or timeout denies before a single byte is read (fail closed). The
single-ceiling classifier remains as the fallback configuration.

**Witness.** Injected fake adapter returns two peers: each fires under its
own ceiling, and peer A cannot reach peer B's prefix. Unlisted peer is
dropped at classification. Adapter error → deny, nothing admitted.

### ~~A3. Wire symmetry: response frames on the signed mesh path~~ — SETTLED 2026-07-27

**Evidence.** Contract task `b427916e` verified. `zig build test` 77/77,
`zig build` exit 0, both gates exit 0. Witness: "signed mesh path answers
framed results like the tailnet path" — over-ceiling signed envelope
answers `{"status":"error","error":"AttenuationDenied"}` and commits
nothing, a good envelope on the same connection then commits (rejections
don't drop the pipe), and a close-before-read client leaves the server
clean with its commit intact. `dialSend` deleted; `dialExchange` is the
only client shape; the framing helpers live once in mesh.zig and the
tailnet path builds on them. Lesson recorded: `expected_prior == null` is
create-only in the commit validator — two writes to one artifact id in one
substrate need an explicit prior digest.

**Problem.** The trusted tailnet path answers every frame
(`tailnet.serveConnection`); the signed mesh path (`mesh.serveConnection`)
is still fire-and-forget. One protocol, two semantics, and a client cannot
know which it will get.

**Fix.** The signed path answers with the same framed result shape
(`{"status":"committed",...}` / `{"status":"error",...}`). `dialSend` is
deleted in favor of `dialExchange` everywhere (CLI included) — one wire
semantics, not two. Old fire-and-forget clients stay tolerated: a failed
response write ends the connection without undoing commits.

**Witness.** Signed-path exchange returns a commit summary; over-ceiling
signed envelope returns a framed typed error; a close-before-read client
still yields a clean EOF on the server.

## Wave 2 — sharp edges

### ~~B1. Real clocks in daemons~~ — SETTLED 2026-07-27

**Evidence.** Contract task `4aa17302` verified. `zig build test` 78/78,
`zig build` exit 0, both gates exit 0. Witness: "daemon and edge read the
wall clock so delegation expiry is real" — a validly signed but
1970-expired delegation answers `{"status":"error","error":"ExpiredDelegation"}`
on the wire (it fired silently under the old fixed clock), a live
delegation commits, and a null-clock MCP edge fires through the wall
clock at fire time. `tailnet.serve` and `mcp.Server` take `?u64` clocks:
null = wall clock per accept/fire (production), fixed value = tests.
Side effect: the A2 whois cache TTL is now live in the daemon.

**Problem.** `neuron serve` and the MCP edge run on `now_ms = 0`
(`src/main.zig`), so delegation expiry is a dead letter on the signed path.
Fine for loopback development; an antipattern anywhere else.

**Fix.** Wall clock read at accept/fire time in the daemon and edge paths.
Tests keep injected fixed clocks — determinism is a test property, not a
deployment one.

**Witness.** An expired delegation is rejected under the real clock in a
daemon-shaped test with an injectable clock; a live delegation still
verifies.

### ~~B2. Bounded exchange reads~~ — SETTLED 2026-07-27

**Evidence.** Contract task `a1692efa` verified. `zig build test` 79/79,
`zig build` exit 0, both gates exit 0. Witness: "bounded exchange read
shares the dial deadline" — a server that accepts and never writes yields
`error.Timeout` at ~300ms against its 1s hold (elapsed asserted < 900ms),
and a server answering 200ms into a 2s budget completes the exchange.
`dialExchange`'s bounded path now keeps the fd non-blocking after connect
and runs the request write and response read through a poll-gated loop on
one absolute monotonic deadline; EOF mid-frame is `TruncatedFrame`, EOF
before any byte is `NoResponse`. Legacy blocking path remains for
`timeout_ms == null` and Windows.

**Problem.** Dials are deadline-bounded (`mesh.connectBounded`); the
response read is not. A peer that accepts and never answers still wedges
the exchange — half the §20 deadline story.

**Fix.** The bounded path keeps the fd non-blocking after connect and reads
the response through a poll-gated loop inside `dialExchange`, sharing one
deadline across dial + response. Blocking restore happens only if the
exchange is handed off.

**Witness.** A server that accepts and never writes yields `error.Timeout`
inside the budget; a response arriving just under budget succeeds.

### ~~B3. Typed proxy payload (`mesh.proxy/v2`)~~ — SETTLED 2026-07-27

**Evidence.** Contract task `7223e110` verified. `zig build test` 80/80,
`zig build` exit 0, both gates exit 0. Witness: "proxy payload v2 decodes
typed fields and rejects the v1 flat form" — `artifact/mesh/weird\nid`
(with a literal newline) round-trips unambiguously; the flat v1 form,
malformed JSON, a wrong schema tag, and a missing field are all
`InvalidPayload` before any effect. Algorithm step 1–2 applied to the
compat flag: every producer ships in this repo, so the migration window
was zero and v1 parsing plus the flag were deleted in this same change —
there is no flag left to rot. `ProxyNeuron` decodes into an
operator-owned arena reset per firing (same lifetime discipline as the
effect buffers); `mesh.proxyPayloadV2` is the single producer helper;
the MCP tool doc advertises the v2 shape.

**Problem.** `ProxyNeuron`'s payload is `'<artifact-id>\n<bytes>'` — an
untyped channel in a typed world. An id containing `\n` misparses; ceilings
contain the damage but do not type it.

**Fix.** Schema-versioned JSON payload with explicit `artifact_id` and
`bytes` fields and a real decoder (§19: opaque input plus explicit decode).
v1 is accepted behind a compat flag during migration, then the flag and v1
parsing are deleted in the same plan — not left to rot.

**Witness.** v2 round-trip with ids containing newlines is unambiguous by
construction; with the flag off, v1 payloads are rejected as schema-invalid
before any effect.

## Wave 3 — hygiene

### ~~C1. Mechanical honesty counts~~ — SETTLED 2026-07-27

**Evidence.** Contract task `427e39c7` verified. `bash tests/runtime-gate.sh`
exit 0, `bash tests/gate.sh` exit 0. The suite size is derived from
`zig build test --summary all` and must cover the ledger's "N executable
tests" claim; the hand-maintained count comment is deleted. Negative
witness demonstrated: with the ledger claim doctored to 999,
`python3 bench/jespa/runtime_tasks.py --assert-win` exits 1 with
"shrank below the ledger claim: 80 < 999" (ledger restored after).
Adding a test now requires no count edit anywhere. The six witness tests
from A1–B3 are also mapped into CONFORMANCE by name, so deleting or
renaming one unwitnesses its property and fails `--assert-win` even when
the raw count still covers the floor.

**Problem.** The "N-test suite" comment in `bench/jespa/runtime_tasks.py`
and the ledger prose are hand-maintained. The gates verify behavior, not
the counts; drift has already required three manual bumps.

**Fix.** `runtime_tasks.py` derives the count from
`zig build test --summary all` and asserts the suite did not shrink below
the ledger's claim. Hand-edited count comments are deleted, not kept in
sync.

**Witness.** A test removal makes the gate fail; adding a test requires no
count edit anywhere.

### ~~C2. Classifier ceiling by value~~ — SETTLED 2026-07-27

**Evidence.** Contract task `b8edd98c` verified. `zig build test` 80/80,
`zig build` exit 0, both gates exit 0. The borrowed-context
`tailnetClassifier(*const Caps)` constructor is deleted; `SingleCeiling`
owns its ceiling copy (Caps is a small value struct), so no lifetime
discipline exists to document — the "caller keeps it alive" comment is
gone with the borrow. All existing tailnet witnesses pass unchanged in
behavior; the only touched test line is the construction site.

**Problem (settled).** `tailnetClassifier` borrowed `*const Caps` through
a `*const anyopaque` context with a "caller keeps it alive" comment. A
dangling ceiling was UB; the discipline was manual. Fixed as planned:
the classifier owns a copy; the borrowed-context constructor is deleted.

## Non-goals

- No new third-party dependencies; no policy moved into the kernel (§30 —
  anything expressible as a limb stays a limb).
- No mesh artifact sync, no distributed cache dedupe (§25): separate plans.
- No Windows-specific transport work; the unbounded fallbacks stay
  documented.
- No relaxation of the CGNAT-only egress guard under any item.
- No change to the Contract repo; §18 consumption stays generated, not
  hand-ported.

## Settlement of this plan

SETTLED 2026-07-27. All eight items (A1, A2, A3, B1, B2, B3, C1, C2)
landed in order, each as one PR-sized change with a contract task, a
runnable witness, and both gates green. The suite grew 72 → 80 tests
along the way, and from C1 onward the count is derived mechanically
against the ledger claim. Final verification on the settled state:
`zig build test` 80/80, `zig build` exit 0, `bash tests/runtime-gate.sh`
exit 0, `bash tests/gate.sh` exit 0.
