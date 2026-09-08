# Native media processing mount

This optional binding preserves legacy frontend and Telegram processing when absent.
It does not use `Codegraff.processMedia`, the browser VM, or `assets/media.py`.
Route only types for which `processing.supports(mimeType)` is true into this path;
keep existing photo/text-document and other legacy handling for unsupported types.
The default may select it only after trusted separate-compute setup has produced
the actual immutable runtime lock and a current owned-media execution grant.
The existing default `pure` / `channel.reply` grant does not include Python media.

## Trusted setup

1. Construct `createMediaEvidence({owner, blobs, sourceCode, runtimeLockDigest,
   environmentDigest, contextRef, authorityRef, authorize, assets, execute})`.
   Source is the independent `assets/media-evidence.py`; `execute` must use the
   separate compute SandboxJob receipt transport, never the browser/vault runner.
   The existing runner owns job claims, isolation, resources and private receipts.
2. Construct `mediaHarnessDefinitions(runtimeLockDigest, mediaSource, {
   modelPath: '/models/whisper-tiny.en', modelRevision, fixtures, ...evidence})`.
   Merge these definitions and verifiers into the owner's existing acquisition
   catalog and registry binding. This is trusted setup, not an attachment action.
3. Construct `createMediaProcessing({library, definitions, journal, authorize})`.
   `library.thread` is the owner's foreground thread, shared across channels.
   `journal` must be that existing serialized native owner journal, also used by
   HarnessAcquisition; do not create a second registry or per-channel job store.
   `authorize(scope, action, signal)` checks the actual configured media grant,
   owner, channel and content ownership for `admit/process/read/cancel`.
   The library additionally checks its own current contract/execution authority.
   Optional `delivery(scope, signal)` resolves **existing trusted ingress** into
   `{source:'api'}`, `{source:'telegram',chat:owner,sender:owner,
   telegram:{messageId,messageThreadId?}}`, or
   `{source:'channel',channelBinding,channelGeneration,channelInput}`. It is pinned
   at admission and checked again before completion. For dynamic channels the
   original `operationId` must already be the existing channel handle operation
   key. This preserves the current sender path and generation/correlation fences.
   Absence defaults to API-only delivery; it never fabricates Telegram authority.

Mount `processing.component` beside `harnessLibraryComponent`, keeping the existing
`harnessSkillForwarder` and background `harnessSkillDeriver`. Add `processing.tools`
to the existing CodeHarness tool list. Compose `mediaProcessingEventKey` with host
keys and `mediaProcessingAppendAllowed(batch, read)` with existing **atomic** append
fences. Do not replace the existing registry/source/channel/login components.

## Attachment admission and inference

Authenticated provider/API code first normalizes and retains the bytes:

```ts
const contentRef = await retainMediaAsset(library.blobs, owner, bytes);
const promptRef = await library.blobs.putPrivate(owner, originalText);
await processing.admit({
  owner, channel, operationId, contentRef, promptRef, mimeType,
  deadline: Date.now() + 180_000,
}, signal);
```

The operation ID identifies the original message/attachment occurrence. Keep the
same ID, deadline and refs for a retry. A different input with that ID conflicts.
Admission durably accepts custody before acknowledging. Never expose raw internal
event append or infer grants from captions, filenames, MIME claims or tool output.
Provider download authorization remains in the existing account-bound adapter.

For this optional path, delay the ordinary `MessageReceived` until processing: the
native component emits it atomically with `AikoMediaCompleted`, using the original
operation ID and channel plus private refs. Do not also emit the legacy message.
The native actor drives pending input automatically; no poll loop or model step
selects/builds the initial capability. Declaration metadata supplies ordered
capabilities, prerequisite output fields and bounded sampling inputs.

At the authorized inference boundary, `processing.hydrateInput(scope, signal)`
returns the original private prompt and stage manifest, explicitly marked
`provenance: 'untrusted-attachment-input'`. Hydrate this only as user/data content in
the transient inference request; never turn it into system/developer instructions,
an imported handler, installation policy or a grant, and never append it back to
the native log. The first native processing handler is selected from trusted
declarations before inference; text and transcripts never select its implementation.
`media_result` in code mode retrieves the manifest. Use `media_output` with the same
`channel`, original `operationId`, `contentRef`, and the selected `stageOperationId`
to hydrate that stage through the private CodeHarness facade. Host callers can use
`readOutput(scope, stageOperationId, signal)`. These accessors recheck current read
authority before and after custody reads and reject stages outside this attachment.
The general registry's `harness_output` remains a separate root-owned API with its
own authorization policy; it is not the scoped media continuation accessor.
Images/transcripts must remain private code/model inputs, not registry or SKILL
content. Hosts retain their existing sender/channel reply correlation and limits.
No media event is itself permission to send an external message.

`resolveMediaAssets(blobs, owner, input)` resolves only opaque `media-<private-ref>`
asset names into the existing SandboxJob private assets mapping. Compose this into
`HarnessSandboxBinding.assets`; controlled evaluation assets require a separate
trusted fixture resolver. The Python driver supplies reserved `_files` paths under
`/input`; FFmpeg/FFprobe live under `/tools` and models under read-only `/models`.

## Recovery and limits

`cancel(scope, signal)` records cancellation; completion uses the atomic fence.
Cancelling an already completed operation returns `already-completed`.
`status` and `readResult` recheck owner/channel/content scope and current authority.
Replay projects metadata only. Stable acquisition/run IDs reuse retained receipts;
an interrupted library claim is unknown and is not redispatched. Missing input,
output, request or SKILL custody stays unavailable; do not regenerate deleted data.
Existing passive SKILL derivation can update its evidence after subsequent runs;
reuse never rebuilds or reevaluates the immutable executable merely for a new
message or channel. A restored pending input with retained terminal stage witnesses
reuses those witnesses before emitting its correlated wake; it does not rerun the
media processor. A claim without confirmation remains unknown.

Runtime owners must call `runtime.dispose()` when their captured v2 runtime is no
longer needed. Media fixtures do this in `afterAll`; already acquired launch leases
remain valid until the runtime releases them. V1 test evidence is not V2 evidence.

Normal probe/frame verification independently decodes owned source bytes. Normal
transcription requires the exact trusted seed, physical VAD coverage and fixed
confidence bounds. Its semantic quality is **unmeasured**, not a fabricated WER.
Fixed English evaluation cases retain the WER threshold. Low-confidence or missing
speech coverage fails the check; silence means no speech detected by this locked
VAD, not an assertion that no sound exists. The default model is English-only; the optional multilingual variant is described below.

This declaration currently samples three real video frames with observed PTS and
explicit non-exhaustive coverage. It does not establish semantic video understanding,
multilingual accuracy, image/document support, C20 completion, or live-provider
compute attestation. Physical fixtures use local isolated native execution; hosts
must attest their separate provider VM transport before default activation.

### Cold v2 lifecycle budgets

V2 reconstructs the immutable package/model closure privately inside each job's cgroup. Root's completed physical run measured four probe cases at about 49 seconds total; that is not a 49-second individual FFprobe execution. It includes repeated cold reconstruction. The older 30-second total acquisition limit cannot cover all fixed cases. No case or quality threshold has been removed.

`mediaLifecycleBudgets` declares 60 seconds per physical job and 120 seconds per harness invocation (candidate plus independent physical verification). These ceilings do not expand the current host's resource grant. Hosts must explicitly configure sufficient `current().budget.wallMs`; a smaller current grant still wins. `mediaAcquisitionWallMs(definition)` sums all fixed-case invocation ceilings; `mediaProcessingWallMs(definitions)` additionally includes one normal invocation per selected capability. This conservative cold-start estimate can exceed a warm reuse deadline. Admission permits at most 30 minutes and retains the caller's exact absolute deadline; callers must choose that deadline explicitly, bounded by their current authority. Recovery does not refresh it.

`HarnessAcquisition` derives its total ceiling from the trusted case count and contract invocation timeout, with a 30-second minimum and 30-minute maximum. It pins that policy in the request/evaluation identities and retains an absolute request deadline; recovery cannot renew that window. Older requests use their original acceptance timestamp. Caller cancellation and per-job host grants still apply. Settled receipt inspection and verified-route reuse do not repeat evaluation. The media component passes its retained absolute deadline signal through acquisition, run, assets, and verification.

The physical fixture emits `media-setup-profile` for fixture construction plus sealed runtime capture, and `media-job-profile` for complete job elapsed time and trusted cgroup receipt resources (CPU, peak memory, cleanup, process limit). These are host observations, not candidate-reported timings. They do not separately measure snapshot copy, Bubblewrap startup, module imports and inference; those subphases require root runtime instrumentation before attributing a bottleneck to any one of them.

Optimization boundary: derive a minimal immutable runtime closure from declared artifact dependencies and a locked runtime catalog, with separate closure digests and the same resource/custody enforcement. Probe/frame jobs need FFmpeg/Python dependencies but not Whisper models or CTranslate2. Do not select an unmeasured runtime by hardcoded capability name, share writable model mounts, or exclude reconstruction from resource accounting. A reusable sealed image/closure cache needs explicit trust, eviction and launch-lease semantics in root's runtime layer.

Sequential local evidence (2026-09-08): `/tmp/media-budget-physical.log` passed all six physical tests, 46 assertions, in 33.6 seconds. `/tmp/media-budget-whisper.log` separately measured development/held-out WER 22.2%/11.1% under the unchanged 35% threshold; speech jobs took 4.15/4.11 seconds with about 1.01 GB cgroup peak memory and cleanup confirmed. Silence/no-audio passed. These short English fixtures do not establish multilingual quality, long-recording latency, or worst-case contention. The earlier ~12-second cold jobs and 30-second failures remain valid evidence that the total acquisition cap needs independent configuration.

### Multilingual catalog activation (bounded S20 increment)

`mediaHarnessDefinitions(runtimeLockDigest, sourceCode, trustedConfig)` now accepts
`languages`, `selectionLanguages`, and `transcriptionName`. Defaults remain
English (`["en"]`) and `media.transcribe`. To publish a separately pinned Spanish
variant, supply `languages: ["en", "es"]`, `selectionLanguages: ["es"]`,
`transcriptionName: "media.transcribe.multilingual"`,
`modelPath: "/models/whisper-tiny"`, and the revision from
`media-multilingual-model.lock.json`. Keep the existing shared probe/frame
artifacts; publish only the returned multilingual transcription definition beside
the existing catalog. Language-specific selection prevents both transcribers
running for an English request. Supported languages and model identity enter the
immutable contract/artifact; candidate source cannot change the trusted labels,
WER threshold, physical inspector or verifier.

`createMediaProcessing` accepts an optional trusted async `catalog()` returning
current immutable definitions. Register each definition's independent verifier
in `library.verifiers` before publishing it. A component created before publication
can select/acquire the new variant without recreating the actor or adding an
application handler. Admission accepts an optional `language: "es"` routing hint;
it is retained privately with the exact operation and deadline. Omission means
English; this is not automatic language detection. Admission pins the selected
contract/artifact digests. Each processing attempt uses one catalog snapshot and
fails closed if a pinned definition disappears or changes. Recovery never selects
a replacement for an already accepted operation. Keep old definitions resolvable
through their retained-request lifetimes.

This is trusted host configuration, not installation authority from a caption,
attachment, provider JSON or model output. An unsupported language does not acquire
an undeclared transcriber. `supports(mimeType)` remains a synchronous baseline MIME
hint, not proof that the live catalog covers a language. Examine selected stages;
probe-only success is not transcription success. Known transcribers execute Python
in the separate CPU sandbox with network disabled; no browser-vault VM is involved.

**Mount instructions for the host owner:** the existing `createMediaHost` currently
constructs its static English catalog. Forward a trusted catalog and verifier
registration path to `createMediaProcessing`, and carry a validated language hint
through authenticated ingress's retained request into `media.admit`. Do not infer
the hint as an authority grant. Before publishing the variant, provision its model
files into the permitted immutable compute runtime and advertise the matching
runtime lock digest through the existing sandbox binding. `verifyMediaModelDirectory`
and `mediaRuntimeLockMetadata` accept an explicit trusted model pin; the exported
`mediaMultilingualModelPin` leaves the default English pin unchanged. A runtime
containing both variants, or a trusted digest-based runtime resolver, is needed
when both model closures must remain executable. No host mount/provisioner was
changed by this increment. Automatic model procurement, runtime rebuilding, and
production multilingual ingress activation remain host integration work; the
native fixture proves dynamic artifact acquisition with model bytes preprovisioned.

### Frozen multilingual evidence and limits

The fixture manifests in `test/fixtures/media-multilingual/` preserve original
labels, audio byte sizes/SHA-256, archive members, label-file hashes, selection
rules and licenses. Spanish uses the first audio member of each female/male
[OpenSLR 72 archive](https://www.openslr.org/72/) (Google, CC BY-SA 4.0). English
uses the first two audio members of the [LibriSpeech test-clean archive](https://www.openslr.org/12/)
(Panayotov/Povey, CC BY 4.0). No audio or label was edited. These are two Spanish
readers and one English reader, not representative language benchmarks. Selection
and WER ≤35% were frozen before inference; punctuation is ignored, Unicode
letters/numbers are lowercased, and diacritics remain significant. The existing
synthetic English cases retain the same threshold.

The multilingual CPU/int8 model is
[SYSTRAN faster-whisper tiny](https://huggingface.co/Systran/faster-whisper-tiny/tree/d90ca5fe260221311c53c58e660288d3deb8d356),
MIT, revision `d90ca5fe260221311c53c58e660288d3deb8d356`. Its four exact file pins
and the SHA-256 of the 30-package hash-locked dependency closure are retained in
`assets/media-multilingual-model.lock.json`; setup verifies model bytes before
sealing the runtime. Jobs read `/models/whisper-tiny` offline. This is an optional
variant; the `tiny.en` lock and model directory remain unchanged.

Physical measurements on 2026-09-08 passed natural English WER 0%/0%, natural
Spanish 0%/14.3%, and synthetic English 22.2%/0%, all below the frozen 35% gate.
The second Spanish clip varied between 0% and 14.3% on repeated jobs; exact decoder
output determinism is not claimed. All segment timestamps were monotonic and
within independently probed duration; no word-alignment accuracy is claimed.
Silence and seeded white noise returned `no_speech` with empty text/segments;
malformed input returned `invalid_media`; video without audio returned `no_audio`.
A 601-second silence file returned `unsupported_duration` with `limitSeconds:600`
from transcription, without loading Whisper. This witnesses bounded rejection,
not long-form transcription quality. The normal pipeline's probe still reports
out-of-budget media as invalid; long recordings are not silently truncated.

`harness-media-multilingual.test.ts` runs actual v2 CPU SandboxJobs, checks trusted
receipts, reopens SQLite with an executor that would fail on repeat dispatch, and
cancels a physical job while checking retained terminal custody and cgroup cleanup.
Speech jobs measured about 3–4 seconds and 1.01 GB peak including cold closure
reconstruction. `media-multilingual-processing.test.ts` publishes the missing
variant after component creation, acquires/evaluates it through the native registry,
derives passive SKILL, runs actual codeMode, and reuses it across Telegram/API-shaped
fixture channels and SQLite restart without reevaluation. A distinct volume-scaled
owned input exercises the normal independent physical checker; its semantic WER
is explicitly unmeasured. Raw native traces exclude input bytes, transcript and
private prompt. Current-authority denial and cancellation are checked. No provider
message is sent.

Remaining S20 evidence includes broader readers/accents/languages/noise conditions,
long-form processing rather than rejection, independently labeled word timing,
short-event/scene answer quality and adaptive visual composition, and production
compute transport/model lifecycle attestation. These samples do not close S20.

Reproduction (run suites sequentially; no model download occurs in these tests):

```bash
TMPDIR=/tmp \
MEDIA_HARNESS_PACKAGES=/tmp/unlock-media-runtime/lib/python3.13/site-packages \
MEDIA_HARNESS_PYTHON=/tmp/unlock-media-runtime/bin/python \
MEDIA_HARNESS_MODELS=/tmp/unlock-media-multilingual-models \
bun test apps/agent/test/harness-media-definitions.test.ts \
  apps/agent/test/harness-media-multilingual.test.ts \
  apps/agent/test/media-multilingual-processing.test.ts
```

“Held-out” identifies the fixed application evaluator split. It does not assert
that Whisper's training corpus excluded these public recordings. Segment bounds
are checked against independently probed audio duration, not human word timing.

Final scoped verification: Contract `69522a9f` executed the three suites above and
returned `satisfied` (13 tests, zero failures). This includes recreating the media
component when reopening SQLite and rejecting fabricated words, wrong language or
model identity, and overflowing segment timestamps. The existing English physical
suite separately passed 6 tests/48 assertions using the unchanged `tiny.en` model
directory. `pnpm --dir apps/agent exec tsc --noEmit --pretty false` exited 0.
These are local CPU/runtime and native component witnesses, not production
multilingual activation or full-S20 attestation.

### Optional schematic video semantics (bounded S20 increment)

`mediaVideoHarnessDefinition(runtimeLockDigest, sourceCode, { frames, fixtures })`
in `harness-video.ts` publishes `media.video.crossing`. `frames` must be the trusted
`media.frames` definition for the same immutable runtime. `fixtures` are retained
`VideoOracleCase` inputs and independent authored answers; candidate source and
SKILL do not receive those answers. Register the returned verifier before adding
the definition to the existing trusted live catalog. Publish this narrow tool only
where schematic crossing interpretation is intended, not as a general-purpose
photographic video interpreter.

The existing `media.admit` entry and native component then execute probe → frames
→ interpretation. No direct application call to the semantic classifier is needed.
Two declaration input forms were added to `media-processing.ts`:

- `{source: "literal", value: ...}` supplies a trusted, contract-pinned task.
- `{source: "output", capability: "media.frames"}` supplies the complete verified
  prior-stage output. A missing prior output fails closed. It is hydrated through
  the existing current-authorized owner blob boundary, copied into the new private
  harness input, and sealed before native call facts are appended.

The video declaration uses literal task `crossing-conflict`, the original owned
asset, and the verified frame output. Existing artifact selection, absolute
operation deadline, acquisition/run identities, native keyed effects, output
custody, cancellation and append fences remain in force. Replay reloads retained
stage results; it does not reconstruct private frames by processing the input again.
No new queue, scheduler, endpoint or provider callback was introduced.

The Python artifact in `assets/media-video.py` decodes real extracted JPEG pixels
with FFmpeg, recognizes the published schematic road/vehicle/pedestrian grammar,
and computes sampled crossing occupancy, first-observed order and witnessed
conflicts. The fixed independent oracle checks those meanings, not just frame
counts. Its verifier also calls the existing independent frame verifier to check
source pixels, extraction timestamps and coverage. Normal inputs require the exact
trusted seed artifact plus retained SandboxJob evidence. That is tested-algorithm
execution evidence, not independent ground truth for every new semantic answer:
normal result quality remains `semanticAccuracy: "unmeasured"`.

Output distinguishes `interpreted`, `unsupported_scene`, `no_video` and
`invalid_media`. An interpreted answer is `observed_conflict` or `not_observed`.
`firstObservedOrder` refers only to the sampled observations, not true entry times.
`coverage` retains sampled seconds, maximum unsampled gap and `exhaustive: false`;
`absenceEstablished` is always false. Out-of-bounds times fail execution/verification.
Sparse observations cannot prove that no short event happened. A denser **explicit**
frame request detects the frozen short event; automatic adaptive sampling is not
implemented by this increment.

Runtime/mount instructions for the host owner: the artifact needs only the existing
read-only Python standard library and `/tools/ffmpeg`; physical verification also
needs `/tools/ffprobe`. It needs no additional vision model, dependency package,
provider credential or network authority. Use the host's already authorized locked
compute runtime and current resource grant. The tests capture a small tool-only
runtime to avoid repeated copies of Whisper packages/models; production runtime
closure selection remains the host/runtime owner's responsibility. Resolve the
oracle's fixture media through the existing trusted fixture asset resolver, and
register both frame and video verifiers. No host or provisioning file was changed.

`test/fixtures/video-crossing/manifest.json` freezes original CC0-1.0 geometry-based
media, source-generator and MP4 hashes, expected occupancy/order and true short
event interval. There are no imported media assets or external licenses to procure.
The physical/native fixture in `harness-video.test.ts` witnesses:

- First acquisition, independent evaluation, immutable promotion, passive SKILL and
  actual codeMode access through a normal media admission.
- A visible pedestrian-before-vehicle conflict at 2 seconds; sampled ordered
  non-overlap; a one-frame [1.1, 1.2) conflict missed by default samples and found
  with an added 1.1-second sample.
- Malformed/no-video/unsupported scenes, bounds rejection, false but internally
  consistent semantic answers, forged exhaustive coverage and mismatched source.
- Recreated-component SQLite restart, second-channel artifact reuse without
  reevaluation, private frame/input exclusion from native traces, current owner
  authority denial and cancelled-input recovery without processing.

This adds a real but constrained computer-vision/temporal interpretation capability.
It does not establish natural photographic video understanding, general question
answering, real-world safety decisions, learned vision-model accuracy, automatic
adaptive sampling, or whole-S20 completion. Those remain explicit residuals.

Fresh semantic-video Contract `e7ee4a14` returned `satisfied` after scoped
TypeScript and 9 focused tests (7 existing media-definition tests plus 2 actual
video/native suites). Reproduce the runtime checks sequentially with:

```bash
TMPDIR=/tmp bun test apps/agent/test/harness-media-definitions.test.ts \
  apps/agent/test/harness-video.test.ts
```

No model environment variables are needed for this tool-only fixture. Scoped
TypeScript includes `src/assets.d.ts`, `src/harness-video.ts`,
`src/media-processing.ts` and `test/harness-video.test.ts` under the agent's strict
ES2023/Bundler settings. An aggregate check during this round found a separate
readonly-assignment error in `test/harness-library.test.ts:121`; that file was not
changed here. The bounded video witness does not attest unrelated aggregate work.
