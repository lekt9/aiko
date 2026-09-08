# Production language/catalog activation

Configured Bun and Worker hosts now provision both locked model directories in
one immutable separate-compute runtime: the existing English `whisper-tiny.en`
and multilingual `whisper-tiny` revision
`d90ca5fe260221311c53c58e660288d3deb8d356`. The trusted host recipe hashes both
closures and checks every downloaded file's exact size and SHA-256. The runner
then seals the runtime image and retains its actual runtime/environment pins.
Existing English-only custom compute configurations are preserved; they cannot
successfully evaluate the multilingual artifact without its locked model bytes.

Authenticated owner write API:

- `POST /api/media/catalog`, JSON `{"variant":"multilingual"}` publishes this
  fixed allowed variant to the owner's retained live catalog. No arbitrary model,
  URL, recipe, verifier or credential is accepted. Publication uses the existing
  owner KV/native journal and does not itself allocate a VM or assert readiness.
- `POST /api/media`, JSON `{"id":"message_001","language":"es","text":"...",
  "media":{"mimeType":"audio/wav","data":"<canonical base64>"}}` admits bytes
  privately. `language` is optional; omission keeps English behavior. Spanish
  without publication, unknown languages and malformed hints fail closed.

A running host observes publication without redeployment or registry factory
replacement. The first Spanish admission acquires and independently evaluates
the pinned multilingual executable; subsequent API and Telegram operations reuse
it across host restart. Accepted requests retain their language, exact selection,
absolute deadline and private content/prompt identities. Retries with a changed
hint conflict; unknown jobs never authorize another dispatch.

Telegram `from.language_code` is normalized to a bounded lowercase language hint,
retained through polling serialization, and passed to the same private media
admission. It is a sender-locale hint, not detected speech language or installation
permission. Unsupported attachment types retain the existing legacy behavior.
The current API accepts one attachment up to 8 MiB; Telegram keeps its existing
20 MiB download limit. Existing acquisition/resource ceilings remain unchanged.

Model downloads occur only in the trusted setup entry. Generated Python jobs
have no network or model-provider credentials. Setup records retain dedicated VM,
command and report identities, so restart polls existing setup rather than
reinstalling. Changed recipes create distinct immutable roots and truthful pins;
the earlier live English VM evidence is historical, not evidence for this image.

The checked asset `media-multilingual-host-fixtures.json` is a gzip/base64 package
of the existing frozen fixture generator's outputs, including its original fixed
cases. Compression is storage only; the resolver verifies the decoded per-asset
digests before execution. No quality corpus or threshold was added or weakened.

Evidence: `media-host.test.ts` runs actual default createService, isolated Python,
fixed multilingual evaluation, Spanish private input, API/Telegram reuse, restart,
lost acknowledgement, wrong runtime and owner revocation. The language/provision
suites cover normalized ingress, absent runtime, model hashes and inert/cancelled
setup. These controlled results do not attest live Codegraff installation of the
new multilingual image or deployed Worker execution.

## Native host boundary follow-up

The media execution binding now explicitly owns its standing evaluation grant.
It admits only an exact artifact, contract and fixture from the currently enabled
host media catalog, then rechecks the media sandbox authority. Inheriting the
base registry's JavaScript-only evaluation grant prevented Python acquisition
before any evaluator job could start. This correction does not widen the default
registry or permit attachment text to install an artifact.

Retained ingress hydration now checks current owner authority before reading
private custody and again before releasing it. The original absolute admission
deadline also covers runtime preparation, not only evaluation and invocation.
A restart does not renew this deadline. Terminal unavailable/unknown operations
remain terminal; a repaired runtime requires a distinct admitted operation.

The current mounted routes remain `/api/media` and normalized Telegram single
voice/video attachments. No actor/server/Worker mount change is required for
these fixes. The host processes at most one pending native media effect at a
time, with at most two accepted pending inputs, 10 admissions/minute and
100/day. Controlled provider fixtures must verify the same promoted digest and
bound reply destination rather than count only output frames.

Remaining integration qualification: the default catalog does not currently
include `media.video.crossing` or a general photographic semantic interpreter.
Existing probe/frame/transcription witnesses therefore do not establish general
video understanding. Runtime replacement under a changed environment needs a
new recorded operation and fresh contract acquisition; automatic repair of a
terminal media operation is not implemented. The prior five-case live receipts
remain historical evidence for their exact bundle/image, not for later source
or compression changes.

The strengthened host fixture uses production `mode: live` with the supported
`replyStyle: direct`, injected native inference and controlled provider transports.
It invokes `media_result` through actual codeMode before completing its answer.
Demo mode intentionally substitutes a sample-capability fallback and therefore
cannot prove production reply wording. The fixture checks owner `123`, the controlled Telegram
reply destination, unchanged promoted digests, private captions absent
from SQLite/native facts, passive indexer SKILL derivation, and video reuse after
reopening the service. Reuse checks distinguish JavaScript continuation jobs from
Python media jobs: a new message may execute code, but must not rerun media
acquisition fixtures for an already promoted capability.

Immutable runtime capture also uses compression level 2 and a proportional
compressed-storage allowance. A real 256 MiB incompressible-file regression
checks sealed byte recovery after source deletion. Bun's level-1 encoder expanded
that input by approximately 5%, while a fixed 64 KiB allowance could reject large
weights even with normal DEFLATE overhead. Original expanded limits and all source
hash, descriptor seal, decoder and cgroup checks remain enforced. Rebuilding a
compute bundle from this source creates new image evidence; historical live
receipts are not relabeled.

This follow-up does not yet qualify racing cold admissions/build deduplication
across multiple host processes, an automatic runtime/environment repair workflow,
or the default-mount semantic-video catalog. Those remain separate required
checks and implementation work; serialized two-adapter reuse does not substitute
for them. No whole-S20 or full-plan completion is claimed.

Fresh scoped Contract `bf75a7bb` is satisfied for the four-file check below
(9 tests). The separate existing native acquisition race test also passed
(1 test, 5 assertions), and the final agent TypeScript check exited successfully.
The successful Contract follows explicit failed attempts that exposed the
JavaScript-only evaluator inheritance and incorrect fixture assumptions about
demo reply policy and trusted pixel-checker jobs; those failures were not counted
as success.

```bash
TMPDIR=/tmp bun test apps/agent/test/sandbox-runtime-image-large.test.ts \
  apps/agent/test/media-authority.test.ts \
  apps/agent/test/media-language-ingress.test.ts \
  apps/agent/test/media-host.test.ts
TMPDIR=/tmp bun test apps/agent/test/harness-acquisition.test.ts \
  -t 'concurrent acquisitions'
TMPDIR=/tmp bunx tsc --noEmit -p apps/agent/tsconfig.json
```

These are controlled production-entry/local physical sandbox checks, not a new
live Codegraff installation or deployed Worker attestation. No canary, external
user message or deployment was created by this round.

## Automatic bounded runtime reconstruction

The default `ProvisionedComputeHarness` path now supports automatic repair of a
**definite pre-processing runtime miss**. This supersedes the earlier automatic
repair caveat only for the bounded cases below. It does not reopen a terminal
unknown media operation or retry an uncertain setup, VM creation or send.

`pythonComputeRunner` emits a finite trusted environment report for `ENOENT`
(`runtime-missing`) or a reconstructed closure whose lock differs from the
configured lock (`runtime-lock-mismatch`). It executes no candidate while making
that report. `CodegraffComputeHarness` requires the probe's completed, zero-exit
receipt and expected old lock before retaining owner-private failure evidence.
Missing reports, lost handles, isolation failures, resource exhaustion and other
unclassified errors do not authorize repair.

The existing native media component retains `AikoMediaIngressFailed` for the
original operation. Only a trusted failure observed **before**
`AikoMediaAccepted` can activate its finite repair effect. It checks current
owner/grant and retained bytes, calls the configured repair binding, then admits
`media-repair:<operation-derived digest>` with `repairedFrom` pointing to the
original. The private caption, content reference, delivery binding, language and
absolute deadline are preserved. The original never receives a new completion;
the child uses the ordinary acquisition, fixed evaluator, SandboxJob, reply and
passive-SKILL path. A repaired child cannot recursively repair itself.

Repair uses the existing owner WorkflowKV, `SandboxCompute.exec/poll` identities
and native event log. A definite failure is scoped to its machine, runtime config,
old environment, bundle and owner. Concurrent requests for that same failed
runtime/grant share a setup identity while retaining their own media admissions.
The rebuild uses a **new setup command and separate runtime directory**, preserving
the earlier closure. A verified report precedes durable activation. Reopening
between report retention and activation reuses the same report/build. Missing
output remains unconfirmed; it never dispatches a replacement command. The
five-minute setup deadline is retained and cannot renew on restart; the original
media deadline may impose a shorter limit. Rebuild never allocates another VM:
the retained owner/machine must still match before dispatch.

### Exact root integration

No additional actor, server or Worker component is needed. Their existing
`mediaHostEventKey` and `mediaProcessingAppendAllowed` mounts now include repair
settlement and enforce one scoped child per failed original. The default
`dispatchHarnessSandbox(standard, provisionedPython, javascriptPin)` forwards the
optional repair capability automatically. Existing `/api/media` and normalized
Telegram voice/video admissions activate it; no new public lifecycle endpoint or
provider authority was added.

Custom trusted transports may implement `ComputeRuntimeRepair` from
`compute-runtime-recovery.ts`:

```ts
repairRuntime(
  { owner, operationId, failureRef, grant, deadline },
  signal,
  authorized, // rechecks current original owner/grant; not candidate code
): Promise<{ status: 'ready'; runtimeLockDigest: HarnessDigest }>
```

Expose this method only with an already configured locked reconstruction recipe.
A manually supplied `CodegraffComputeHarness` without a recipe stays explicitly
unsupported. The media adapter supplies current authority; attachment JSON cannot
supply this method, callback, recipe or a `DefiniteComputeRuntimeFailure` instance.
Never convert arbitrary provider error JSON to that error class.

The rebuilt `assets/compute-runner.txt` contains the trusted probe and isolated
per-setup directory changes. Root must include this asset in its normal future
release; no Worker/Bun deployment or live VM change was performed here. An old
running bundle cannot retrospectively supply the new definite-failure witness.

Focused evidence: `media-runtime-repair.test.ts` uses actual `createService`,
controlled Codegraff transport, real deleted runtime bytes, the trusted preflight,
actual isolated Python/FFmpeg jobs, retained-VM rebuild, linked native admission,
API-to-Telegram reuse and disk restart. Provisioning fixtures cover interrupted
activation, retained deadline, revoked authority and unknown-output refusal.
Corrupt local closure bytes produce an explicit lock-mismatch probe report.
These checks do not assert multilingual quality anew, generic video semantics,
live provider installation, repair of unknown original executions, or recovery
from loss of the owner's private attachment bytes. Full S20 remains open.

Final scoped Contract `1b7290a5` is satisfied after the retained-machine allocation
race fence and durable repair-budget checks. Its four-file check runs 21 focused
tests; scoped strict TypeScript over the changed modules/tests also passes.

```bash
TMPDIR=/tmp bun test apps/agent/test/media-runtime-repair.test.ts \
  apps/agent/test/compute-provisioning.test.ts \
  apps/agent/test/compute-harness.test.ts \
  apps/agent/test/media-authority.test.ts
```

Prepared compute bundle: 2,285,638 bytes, SHA-256
`a0f33a9ac6efc2a4bfaef9ff8488130235c7b9eda23a086f3f663888b0b9c83e`.
An independent rebuild matched it byte-for-byte. The earlier live media bundle
and receipts remain historical evidence; this repair increment has controlled
native-host and local physical execution evidence only. Root-owned host files,
fixed criteria, manifests, pins, quality rubrics and source fixtures were not
edited by this increment.

## Default schematic video activation

`createMediaHost.prepare` now includes the immutable `media.video.crossing`
catalog artifact, bound to the same runtime lock and `media.frames` verifier.
The existing authenticated `/api/media` and normalized Telegram video paths
activate it without a new route, subscription, provider credential or actor
component. `registry-defaults` already constructs the media host, and Bun/Worker
already wrap native Infer with `media.inference`. No actor/server/cloudflare
mount edit is required. This supersedes the absent-default-semantic-catalog
caveat above **only for schematic crossing diagrams**.

The catalog pack `assets/media-video-host-fixtures.json` retains the original
CC0 crossing fixture bytes, manifest hashes and frozen occupancy/order rubric.
Its extraction inputs were assembled with v2 isolated FFmpeg SandboxJobs; source
and extraction-runtime digests are recorded in the pack. Extraction data is not
semantic ground truth: the expected labels come from the original independent
manifest and existing dense-short/negative oracle cases. Every acquisition still
runs the fixed development/held-out cases and independently verifies the source
frames under the current runtime before promotion. Merely packaging a fixture
or completing a Python process does not promote the artifact.

Selection remains declaration-driven: probe, frames, applicable transcription,
then the crossing interpreter. The interpreter recognizes only its explicit
schematic grammar. Unsupported scenes, failed stages and malformed video produce
`Video interpretation unknown` in the reply, without a photographic-model
fallback. A satisfied schematic result reports actual frame timestamps,
vehicle/pedestrian occupancy, first observed order and largest unsampled gap.
Sparse misses never establish absence or safety; general semantic accuracy
remains unmeasured. There is no new external perception grant.

At the existing native Infer boundary, the **current** admitted video turn reads
only owner-authorized retained stage outputs and completes with the deterministic
`renderVerifiedVideoFinding` renderer. It does not send captions or JPEG base64
to inference for an unconstrained semantic answer. Historical media messages
cannot replace the current ordinary user turn. Missing/revoked custody fails
closed. The normal native reply/outbox retains the original API/Telegram
correlation and its delivery/restart rules.

The exact final-wording witness uses the production-supported
`AIKO_REPLY_STYLE=direct` setting. A separately configured ThinkFeel composer can
rewrite the draft downstream; this increment does not independently validate
that composer's output against the video oracle. Hosts requiring that path must
preserve/check the factual receipt in their final voice boundary before claiming
identical final findings. No voice-policy bypass was introduced.

Focused test: `TMPDIR=/tmp bun test apps/agent/test/media-video-host.test.ts`.
It runs real `createService`, native SQLite processing/acquisition/skill/outbox,
physical local v2 Python+FFmpeg, and controlled provider transports. Assertions
cover exact conflict timestamps/order/coverage in the API reply, a deliberately
misleading injected model which receives no video inference call, Telegram
short-event uncertainty and destination after reopen, unchanged artifact and
evaluation counts, duplicate delivery/restart, foreign caller rejection,
unsupported/malformed input, private trace exclusion and kernel cleanup evidence.
No live provider, deployment or broad photographic S20 parent claim follows.

Cross-process pending-acquisition continuation is now implemented and checked
as described below. Broad multilingual/photographic quality, arbitrary
channel-adapter media admission, and a joined full S20 parent witness remain
separate work. The existing definite pre-admission runtime repair
path and its limits are unchanged by this activation.

Fresh scoped evidence (Contract `c99dcdde`, satisfied): the final default-host
check passed 59 assertions with 77/77 completed physical jobs, zero video model
calls and exactly one controlled Telegram send; a later ordinary message made
one normal inference call. The run recorded runtime lock
`sha256:3c0f2dbccfa74f61f750597474b90ee5340b08ff5eaf7bcefb92902e3f2c3ede`
and semantic artifact
`sha256:f170cbcecec9b94685189b2b8c3971fbf3b10f4018648f6e1382863c57017565`.
First acquisition/processing took 73.267s; the different short-event input after
restart took 12.307s. These are local fixture timings excluding initial runtime
capture and model download, not a matched benchmark or live deployment claim.
The unchanged physical `harness-video.test.ts` passed 2 tests/53 assertions;
authority/language ingress checks passed 7 tests/30 assertions. Full agent
TypeScript checking passed. The fixed plan, requirements and crossing manifest
were unchanged. No full S20 parent or protected acceptance status was updated.

## Shared acquisition continuation (native media)

`createMediaProcessing` no longer turns `HarnessAcquisition.status=pending`
into terminal media `unknown`. It returns an `AikoMediaAcquisitionWaiting` fact
with the original owner/channel/operation/content binding, exact acquisition,
artifact/contract/evaluation IDs, expected evaluation witness IDs, original
absolute admission deadline and an observed relevant-receipt digest. No private
input, output or caption is in that fact. The append fence ties it to the retained
admission, acquisition request and recorded candidate, including the existing
acquisition evaluation identity formula.

`mediaProcessingReady` offers another finite native effect only after a matching
case witness, evaluation settlement, or that acquisition's settlement changes,
or when the original deadline is due. Unrelated owners/evaluations and repeated
host reopen do not cause a retry. The observed receipt snapshot is taken BEFORE
calling acquisition, so a completion between the pending result and wait append
remains visible. This includes the case where it arrives before the wait is
committed. There is no immediate retry loop, secondary queue or in-memory
continuation. Reconciliation uses the same acquisition and stage operation IDs;
already checked stages hydrate retained outputs rather than dispatch again.
Recorded unknown underlying executions remain unknown and are never reopened.
Cancellation suppresses the waiter; expiry does not renew admission or compute
budgets. The default host's outer effect now selects only its own inner media
operation, preserving separate tasks and deadlines when more than one is ready.

### Mounted native deadline aggregation

The default mounts are now present. `registry-host.ts` exports
`hostedRegistryNextWake(events, owner)`, taking the minimum of
`channelWiringNextWake` and `mediaProcessingNextWake`. Both
`hostedChannelWaitMethod.projection.output().invocationState` and
`hostedChannelDeadlines(owner).output` use it. `createAikoActor` mounts the
existing `channelWait` method and deadline component when either channel wiring
OR media is configured, including media-only actors. The Worker `nextWake`
uses this helper alongside sandbox, automation, promise and login deadlines,
sharing one owner-log read for the event projections. No additional media
queue, timer or controller is required.

The aggregate invocation completes when no eligible deadline remains, when the
current earliest deadline is later than its recorded deadline, or when its
native `AlarmFired` has arrived. The strict later-than check retracts an obsolete
early alarm after cancellation/completion while retaining the later waiter's
alarm, including across SQLite restart. The native alarm event refreshes the
materialized media projection; merely marking a cached projection would not
provide that guarantee. `MediaHost.nextWake()` remains available for binding
composition and does not start a runtime.

Race review: media records the receipt snapshot before calling acquisition, so
settlement before wait append remains detectable. Wait readiness observes only
the pinned acquisition/evaluation/case receipts and original deadline; terminal
media cancellation/completion suppresses it. Reconciliation retains acquisition
and stage operation identities, and the outer host executes only its own inner
media operation. An already admitted expired request settles unavailable before
runtime preparation, without a late output. An unknown execution cannot authorize
replay or runtime repair. No additional defect was reproduced in these reviewed
paths; this is not exhaustive concurrent production execution evidence.

### Focused evidence and limits

`media-acquisition-wait.test.ts` starts actual separate Bun processes using
`createCloudflareAccountHost` over the same SQLite native log and private KV.
A controlled finite executor holds a shared evaluation while another process
accepts and retains the follower, exits, then reopens. Fixtures assign the two
original inputs to separate host instances to force the otherwise serialized
race. One shared evaluation/promotion serves both separately keyed private runs;
finished input execution and outbox settlement are not duplicated after reopen.
The test also interleaves completion before wait append, tries a forged evaluation
reference through the ACTUAL native EventLog guarded append, checks unrelated
owner receipts, cancellation, original deadline/alarm storage and unknown jobs.
Each task's retained output and delivery turn remain separately bound.

The fixture's executor is controlled; this is native acquisition/continuation
and subprocess/storage evidence, not a fresh Python compiler, FFmpeg quality or
live VM witness. Admission/library setup uses trusted fixture journal boundaries;
the forged wait check specifically uses native guarded append. The physical
video/Whisper fixtures, artifacts and quality rubrics were not changed or rerun.
This does not constitute a full S20 parent or change protected acceptance status.

Scoped Contract `18d8d578` satisfied. Final direct checks with `TMPDIR=/tmp`:
5 subprocess continuation cases / 95 assertions and 4 authority cases / 24
assertions passed. No owned-file TypeScript errors remain; the full agent check
reported unrelated `channel-response.test.ts` Usage/Action typing errors. The
deadline aggregation was subsequently mounted and freshly checked below.


Mounted-state verification (2026-09-08), with `TMPDIR=/tmp`:

```sh
bun test apps/agent/test/registry-deadlines.test.ts apps/agent/test/media-acquisition-wait.test.ts apps/agent/test/media-authority.test.ts
```

All 15 tests passed with 175 assertions (11.05s). Six deadline cases use actual
`createAikoActor` with Bun and Worker SQLite hosts, no channel wiring, and an
isolated fixture media component: they verify native alarm expiry/restart and
retraction of cancelled/completed earliest deadlines while a later waiter
remains. They deliberately seed trusted retained rows, so they do not prove
production media admission or acquisition by themselves. The five separate
subprocess cases exercise actual media processing/acquisition and retained
outputs/outbox task identities; four authority cases exercise custody revocation,
expired default-host ingress and refusal to repair an admitted uncertain run.
Together these check the mounted scheduling path and media reconciliation at
their respective boundaries, not one joined physical-video/default-actor alarm
fixture. No physical media suite, live provider, or VM was run for this review;
prior physical semantic/quality evidence above remains separate. Only this guide
was edited; production source, fixed rubrics and protected acceptance files were
unchanged by this review.
