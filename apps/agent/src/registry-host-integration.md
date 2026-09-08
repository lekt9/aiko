# Trusted account registry activation

With code mode enabled and a configured SandboxJob/code-segment transport, Bun
and Worker hosts now assemble a default trusted registry. In live mode the
configured Codegraff credentials supply the transport; construction is lazy and
does not allocate a VM. An awaited native bootstrap effect records the fixed
builtin contracts and seed candidates in the account log after account activity.
Metadata projection and host construction do not register or execute artifacts.

Defaults permit same-owner pure JavaScript and separately scoped public registry
source reads. They supply fixed contracts for `json.project`, `text.chunk`,
`media.sample_times` and `channel.text.echo`. The sampling capability only plans
timestamps; it does not perform FFmpeg extraction, transcription or vision.
Task-specific network execution, credentials and external delivery still need
their corresponding trusted capabilities. Missing configuration is unavailable.

Bun also accepts `createService(config, { registry: factory })`; Worker account hosts
accept the in-process `AIKO_REGISTRY_FACTORY` configuration function. These are
trusted application configuration, not HTTP or Wrangler JSON input.

`RegistryHostFactory` receives `{ owner, thread, kv, read, sandbox? }`. `read`
is the live account EventLog. `kv` reuses private workflow storage (including
atomic claim/update). Worker supplies its configured native sandbox when present.
Return `{ sources?, library?, codeTransport?, authorizeReceiving? }`:

- `sources` is a `HarnessSourceBinding`. Its library must bind exactly the given
  owner and `user-${owner}` thread. Use `harnessBlobStore(kv)` for private blobs,
  `createHarnessSandboxBinding` for execution/context, and
  `sandboxSourceTransport` for VM HTTP. Supply independent current authority,
  repository policy and trusted verifiers; source origins do not grant access.
- `library` provides legacy library-only activation. `sources.library` takes
  precedence when both exist, avoiding duplicate native tool names.
- `codeTransport` runs native code segments. A custom Bun factory supplies this
  binding with `config.codeMode`; defaults and Worker can use configured Codegraff.
- `authorizeReceiving` is the trusted channel handler authorization callback.
  Registry verifiers plus this policy activate internal ports even when no
  external provider adapter is configured. It must check exact scopes, not just
  owner identity. The host supplies the source-aware registry handler bridge.

Authenticated `GET /api/harness/readiness` (also `/v1/harness/readiness`) reports
registry, source, verifier, codeMode and internal-channel readiness. Absent
configuration fails closed. The default internal receiving reference is supplied
to the scoped actor. Readiness is configuration evidence with
`runtimeChecked: false`; execution checks the current runtime and authority.
A custom factory takes precedence, including one returning undefined to disable
defaults. No default provider subscription or unrestricted package installer is
created.

## Native capability acquisition

`harness_capabilities` returns the fixed contracts and retained active routes
without starting a VM. `harness_acquire({name, operationId, candidate?})` reuses
an eligible route or evaluates its seed/supplied immutable artifact in the
sandbox. Candidate code must preserve the named trusted contract. Unsupported
outcomes return unavailable so the composing actor can discover guidance and
obtain the required independently registered contract.

```js
const acquired = await tools.call({
  name: "harness_acquire",
  arguments: { name: "text.chunk", operationId: "task-42:acquire-chunker" },
});
if (acquired.status !== "ready") return acquired;
const witness = await tools.call({
  name: "harness_call",
  arguments: {
    name: "text.chunk", contractDigest: acquired.contractDigest,
    input: { text: "An example message", maxCharacters: 8 },
    operationId: "task-42:chunk-message",
  },
});
if (witness.status !== "satisfied") return witness;
return await tools.call({
  name: "harness_output", arguments: { operationId: "task-42:chunk-message" },
});
```

The retained acquisition receipt records historical verification. API readiness
is computed after settlement from the current permission and exact route
generation; replay rechecks both. Concurrent identical acquisitions share their
fixed evaluation identity. Interrupted outcomes stay unknown, and recovery only
runs untouched cases. Ordinary output lookup cannot retrieve evaluation answers.
The existing background indexer derives private `SKILL.md` resources after
foreground settlement. This is acquisition under a fixed catalog; generalized
media construction and sealed held-out optimization remain separate work.

The account actor mounts source/library tools, the library event component and
both typed channel components/package. The library component owns its key prefix;
foreground hooks continue observing promotion events. Code effects explicitly
receive the private composer Sandbox so Bun's default host Sandbox cannot bypass
argument/result custody. Channel wait deadlines project onto native method alarms;
there is no second scheduler. Worker append guards include wiring and library
promotion fences. Public control imports and sandbox callbacks cannot inject
private registry/waiter events.

`test/registry-host.test.ts` uses actual `createService` and native codeMode:
controlled GitHub responses through sandbox HTTP → source derivation → independent
verification → promotion → typed handler output. It also checks host reopening,
parked waiter expiry/delivery, missing configuration and foreign owner rejection.
No public provider request or message is sent.

`test/registry-defaults.test.ts` additionally exercises the default actual Bun
host, acquisition, typed dispatch, source ingestion and disk recovery without a
custom registry factory. Provider bridge and receive-only ingress mounts exist;
their independent receiving/signature/send policies still require configuration
as described in `channel-wiring-integration.md`. Worker runtime recovery still
needs its platform fixture. These controlled tests do not attest live provider
configuration, deployment or full-plan completion.
