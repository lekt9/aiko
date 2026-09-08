# Codegraff runtime canary — 2026-09-08

The live canary verified CloakBrowser launch/CDP, an isolated code SandboxJob,
and a read-only public network SandboxJob. Both Whisper models and all 30 wheel
archives matched their pins. Python runtime attestation did **not** finish:
setup exited 137 without producing its report. Live frame extraction and
English/Spanish transcription under Python SandboxJobs therefore remain unverified.

## Current state and preservation

The official gateway list initially returned one started and 17 stopped VMs.
The existing started VM `717f8f6c-4544-4b16-930b-803458b732c7` was inspected
read-only. Debian reported 13.4; Python, Bun and setpriv matched the recipe, but
FFmpeg/FFprobe differed. No Aiko compute root or CloakBrowser installation was
found at the expected locations. Its disk, sessions and lifecycle were not changed.

A disposable canary `1dc5f3f5-36d6-421a-9073-600138422ec4` was created through
`CodegraffSandbox.ensure`, using the ordinary browser bootstrap. It reused the same
VM for both compute setup attempts. It was deleted only after evidence retention;
a subsequent authoritative GET returned 404. No other VM was deleted or stopped.
No Worker/Bun application deployment, frontend, authentication configuration,
real account login or user-channel message was performed.

## Verified artifact and pin correction

A fresh isolated build of `compute-runner-main.ts` matched the existing bundle:
2,282,754 bytes, SHA-256
`ec1df8e315d3ace84d0bea26c5307111c91ad1ca0f221a4300ef8d63bd4dd0c4`.
The review copy is retained with evidence; shared builder outputs were not
rewritten. The local dependency inventory contains 4,066 non-cache regular files,
417,436,235 bytes, tree digest
`688249c2b76a88e76b6321fe8af7f8eb898f5d42d3202d01eaa35aa6d4bc8957`.
This inventory is not a live runtime attestation.

The original recipe failed closed on FFmpeg's native pin. The fresh image has
Debian `ffmpeg 7:7.1.5-0+deb13u1`. The package was independently downloaded from
Debian, verified against its [published checksum](https://packages.debian.org/trixie/amd64/ffmpeg/download),
and its binaries extracted and compared to the VM:

| Item | SHA-256 |
| --- | --- |
| Official 2,001,944-byte package | `8669bc77e55393c14e0dd257ba9a916007cb6da0e1074c9b5e1d53812024f2af` |
| FFmpeg binary | `e8a8d46f5225f3062cec7c07fb145d58ae73c603cb740dcd5bad34bfb54e455a` |
| FFprobe binary | `cefc5f81c0b18429cdbf8fa5a89e1e9c759235e10f93f9b329ff1b2fdff26f46` |

`trustedCodegraffMediaRecipe` now explicitly uses recipe v2 and these two audited
pins. There is no TOFU, alternate-hash fallback, or model/dependency-lock relaxation.
Older images still fail closed if they do not match. Host mounting files were not
changed.

## Physical results

- Standard browser bootstrap installed verified CloakBrowser release
  `146.0.7680.177.5`; the actual executable reports `Chromium 146.0.7680.177`.
  Native browser-harness/CDP navigation read the IANA Example Domain fixture.
- `live-code-canary-v1` completed inside the VM and returned 42, with `process`,
  `Bun`, and ambient `fetch` unavailable to guest code.
- `live-network-canary-public-v1` fetched the public read-only fixture inside the
  VM with an explicit GET/origin grant. Its receipt records one request and zero
  browser starts. Repeating its operation returned the same receipt. A separate
  loopback request was denied under the default network boundary; that boundary
  was not weakened to make the fixture pass.
- Both pinned model revisions were installed: English
  `0d3d19a32d3338f10357c0889762bd8d64bbdeba` and multilingual
  `d90ca5fe260221311c53c58e660288d3deb8d356`. All eight model files matched
  size/SHA-256. All 30 downloaded wheel hashes matched the existing requirement
  lock. This does not claim those packages completed a Python SandboxJob.
- Recipe-v2 setup exec `16731af9-59da-400e-8f21-01dc2d811791` exited 137 after
  “Trusted compute dependencies verified.” The canary subsequently appeared
  stopped. It was woken once to read the retained exec handle and filesystem;
  installation was not resubmitted. The retained phase was `isolation-probe`.
- The parent memory limit was 1,073,741,824 bytes. Exit 137 is consistent with
  SIGKILL; OOM is plausible but **not established** by the post-restart counters.
  No runtime lock report exists, so the adapter correctly remains unavailable.

## Evidence and next boundaries

Evidence, review bundles, redacted provider exec tails, model/wheel audit and job
receipts are retained in `artifacts/aiko-cloudflare/compute-live-20260908/`.
`summary.json` explicitly records false Python/media readiness and confirmed cleanup.
No provider credentials, cookies or private provider URLs are included in this report.

Next work must establish adequate provider memory authority and bounded setup
capture, then obtain a complete runtime report before live frame/Whisper jobs.
Do not automatically repeat the terminated setup identity. The current raw
`SandboxCompute` allocation path does not call the CloakBrowser bootstrap; this
canary proves the browser-factory path, **not** the requirement that every new
compute VM installs CloakBrowser. A shared mandatory initialization path remains
needed. Production DB/backup recovery was not reverified in this runtime-only round.

Local checks: provisioning, compute-harness and sandbox-compute tests, plus scoped
TypeScript. The evidence checker is read-only and never allocates resources:

```bash
TMPDIR=/tmp bun test apps/agent/test/compute-provisioning.test.ts \
  apps/agent/test/compute-harness.test.ts apps/agent/test/sandbox-compute.test.ts
bun apps/agent/scripts/verify-compute-canary-evidence.ts \
  artifacts/aiko-cloudflare/compute-live-20260908
```

This is a bounded partial live witness and audited provisioning fix, not full-plan
completion, live Python readiness, broad semantic-video quality, or production cutover.

Final scoped Contract `7ca57594` is satisfied: 19 local tests/113 assertions plus
read-only validation of the retained live evidence and cleanup. Scoped TypeScript
passed. The Contract deliberately does not assert live Python/media readiness.
A provider immutable image digest was not obtained; the recorded image evidence
is Debian 13.4 and independently audited executable hashes. Next diagnosis must
distinguish provider lifecycle/exec termination from memory pressure before changing
resource grants or retry policy. No authentication blocker was observed.

## Raw compute allocation follow-up (2026-09-08)

`SandboxCompute.wake` now gates every newly allocated raw compute VM, and every
previously retained compute VM lacking a current receipt, through the **same**
`assets/bootstrap.sh` and `assets/runner.txt install` used by browser allocation.
The runner's install branch calls `installPinnedCloakBrowser`; its signed archive
and full resource-tree verification remain unchanged. This path never runs
`serve`, `health`, or browser profile configuration. Direct HTTP jobs still do
not start a browser. No host mount/configuration opt-in is required.

`codegraff:compute-cloak:<machine>:<artifact>` retains the owner, machine, digest of
both uploaded artifacts, dispatch state, exec handle and terminal exit code in
existing owner KV. Atomic claim precedes setup dispatch. Successful install exit
is the control-plane readiness receipt; setup stdout is not treated as a receipt.
Caller cancellation leaves the provider exec running and retained; reconstructing
`SandboxCompute` polls it rather than launching another. A failed exit stays
unavailable. A lost dispatch acknowledgement with no handle stays unknown and
requires provider reconciliation; it never triggers automatic reinstall or VM
replacement. `status()` exposes setup state/handle, not private logs. Existing
browser disks and allocations are unchanged. Setup wait is capped at ten minutes
and the caller's earlier deadline; this bounds waiting, not remote process life.
An artifact update verifies the existing binary in place through install mode.
The readiness receipt is installation evidence, not continuous filesystem
attestation after arbitrary user shell modifications.

Controlled gateway tests cover new allocation, legacy in-place setup, restart,
cancellation, terminal failure, lost acknowledgement, subsequent HTTP admission,
and absence of browser service commands. Existing browser allocation tests cover
its bootstrap/install path. Compute harness/provisioning fixtures also traverse
the mandatory installer gate. Browser installation itself is simulated in these
routine tests; the separate live canary receipt above is the physical browser
witness. No new provider sandbox was created for this change.

### Python exit 137: source diagnosis and sizing boundary

`compute-runner-entry.ts` emits `Trusted compute dependencies verified`, then
calls `createPythonSandboxRuntime(runtime)` and `python.check()` before retaining
a successful runtime report. `sandbox-python.ts` captures Python, stdlib (without
site-packages/cache), packages, both model directories, resolved shared libraries,
tools and driver into `SealedRuntimeImage`. `sandbox-runtime-image.ts:file`
streams in 256 KiB buffers, but retains each entire file in sealed memfd until
`dispose()`. Its default capacity is 2 GiB, which is an image safety ceiling,
**not** proof that capture fits the canary's 1 GiB parent memory limit. Later
per-job private snapshot creation has additional separately accounted cost.

Retained canary inventory confirms all model files match their pinned metadata:
English 78,090,594 bytes + multilingual 78,203,619 = 156,294,213 bytes. It records
30 verified wheel downloads, but does not inventory extracted package, stdlib
or shared-library closure bytes. The independently retained **local** package
inventory is 417,436,235 bytes (4,066 non-cache regular files); packages plus
models alone are 573,730,448 bytes / 547.2 MiB. This is a local partial sizing
reference, not the canary's total. Bun/native heaps, other VM services, cache,
stdlib and remaining library/tool captures add costs.

The original setup exec ended 137 / `Killed`, without a runtime report. After
restart, `memory.max=1073741824`, peak=59,850,752 and OOM counters=0 were observed.
Those reset counters cannot establish the cause of the earlier kill. OOM remains
a plausible hypothesis, not a verified diagnosis. Next physical verification
should retain pre-capture selected file counts/bytes, phase memory.current/peak
and memory.events deltas from a surviving supervisor, then size the parent for
capture + active job + measured host overhead. A 2 GiB canary is a reasonable
measurement candidate, not a proven sufficient minimum or an authorized change
made here. Do not relax job isolation, model pins, or quality gates to fit 1 GiB.
Live Python attestation and live English/Spanish/frame execution remain open.

## Live Python/media follow-up (2026-09-08, round 21)

The new raw-compute canary reproduced the old failure with contemporaneous
cgroup evidence: exec `622e7571-248c-470b-904b-8267b51d7d8c` ended 137 while
`memory.events` advanced to `oom=1`, `oom_kill=1`. A bounded reusable read buffer
alone was insufficient; its separate terminal exec also received an OOM kill.
These are retained failed operations, not retries under the same identity.

The selected Debian closure is 859,300,417 bytes in 4,911 guest files, including
the driver. `SealedRuntimeImage` now streams runtime files through fixed raw
DEFLATE into sealed memfd storage. Its retained payload is 407,241,895 bytes.
Every entry still binds the original expanded size and SHA-256. After cgroup
admission, the existing trusted supervisor expands bounded chunks into the
private snapshot, rejects truncation/trailing data/size or hash mismatch, and
mounts the result read-only through Bubblewrap. The entire source closure,
model revisions, wheel pins, namespace denial, network denial and job limits
remain in force. Private input/argument images remain raw sealed bytes. No
candidate receives provider credentials, and no new queue or scheduler exists.

A second issue was independently diagnosed: the original installation left
only about 572 MB free on the 3 GiB disk, and the snapshot writer failed with
`ENOSPC`. Raw bootstrap now passes `--compute`, which preserves the pinned Cloak
installer and media tools but skips the browser service's embedding packages.
Default browser bootstrap behavior is unchanged. Trusted Python setup uses
`pip download --no-cache-dir`, verifies each wheel before extraction, then removes
the redundant wheel archives. Installed packages, licenses, dependency locks and
both model directories remain retained. The fresh replacement canary had
1,252,872,192 bytes free before execution, enough for its full checked snapshot.
No old user VM or its disk was changed.

The gateway's public [sandbox documentation](https://codegraff.com/docs/sandboxes)
says the default is 2 CPU / 4 GiB, but both current allocations reported 1 CPU /
1 GiB / 3 GiB. A bounded probe specifying `cpu:2,memory:4,disk:6` returned the
same smaller spec: those fields were ignored. They have **not** been added as a
supported production configuration API. The source fix works within observed
capacity rather than relying on that override.

`ComputeSetupReport.capture` now records source/retained bytes, file count,
capture wall time, and parent memory counters before/after. The replacement
canary attested in 39.5 seconds with zero OOM kills. Runtime lock:
`sha256:0f75bde44ee99a7f998dde7728c38181ce09f50b54e60b1a40a2074f54cd0c0b`.

Cold native invocations reconstruct once for environment attestation and once
for execution. `computeLifecycleBudgets` gives default control-plane waits of
120 seconds for attestation and job wall time + 240 seconds for invocation.
Explicit caller deadlines still win; these waits grant no extra candidate CPU,
network, memory, or job wall time. Measured successful speech invocations took
about 110 seconds end to end, including both cold captures. Hosts should budget
that full lifecycle separately from the 60-second candidate execution ceiling.
A 512 MiB speech job failed at `mkl_malloc`; an explicitly granted 1 GiB job
succeeded. This fixture grant does not broaden production host grants.

English LibriSpeech `6930-75918-0000` achieved WER 12.5%; Spanish OpenSLR72
`cof_00610_00008989777` achieved WER 0%, under the frozen 35% rubric. Both were
actual CPU SandboxJobs using the locked English and multilingual models, with
bounded timestamps and offline loading. Each survived host SQLite reopen with
an identical retained receipt and zero gateway replay calls. These two samples
do not establish broad language coverage, natural-video interpretation, or all
S20 quality requirements. Concurrent cold jobs on this small provider spec have
not been qualified; this live round deliberately ran them sequentially.

All five final-bundle live cases passed: `frames-colors`, English
`6930-75918-0000`, Spanish `cof_00610_00008989777`, `silence-es`, and `malformed-es`.
Each recorded successful native completion, independent oracle acceptance,
resource cleanup, zero OOM/process-limit hits, and byte-equivalent canonical
receipt reuse with zero gateway calls after host SQLite reopen. The final
parent counters also recorded zero OOM kills. Cloak's physical binary reported
`Chromium 146.0.7680.177`; the pinned installer release remains
`146.0.7680.177.5`. It was installed without starting a browser/profile.

Qualified compute bundle: 2,285,086 bytes, SHA-256
`705cbda7e6a2e5bf5792c9e7dc5e2bf077acdb6e38028694f2b5f2c5f8f9397f`.
`apps/agent/assets/compute-runner.txt` now contains that exact artifact. Existing
`ProvisionedComputeHarness`/`CodegraffComputeHarness` bindings consume it; no new
host mount API is needed. No Worker/Bun application was deployed in this round.
An existing persisted setup remains bound to its original runner/recipe identity.

Retained evidence is in
`artifacts/aiko-cloudflare/compute-media-live-20260908/`: final job inputs and
receipts (public controlled fixtures), exact runtime/bundle/model pins, native
exec handles reconciled to terminal state, independent failure diagnostics and
memory measurements, and cleanup confirmation. The read-only recheck is:

```sh
TMPDIR=/tmp bun apps/agent/scripts/verify-compute-media-evidence.ts artifacts/aiko-cloudflare/compute-media-live-20260908
```

Both disposable canaries (`56b2e277-c24b-4a05-8d76-2076b37a93c2` and
`f057835d-b672-4588-bb82-6fc0d72eb04d`) were deleted with authoritative 404
confirmation after evidence retention. Existing VM
`717f8f6c-4544-4b16-930b-803458b732c7` remained started and was not modified.
Scoped Contract `38c89c10` covers this physical readiness/quality/replay/cleanup
witness. The full plan remains open.
