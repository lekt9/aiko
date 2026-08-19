---
name: typed-neuron/client-emitter
description: 'Emits an inert, digest-pinned frontend client (`ts`, `js`, or `json`) from a published boundary''s accepts/emits/errors triple. Use when a frontend must consume the exact contract a server serves instead of a hand-written guess — it fires on a `neuron.client-emit-request/v1` naming a `neuron.published-manifest/v1` read and writes a `neuron.emitted-client/v1` artifact.'
probe_input: '{"budget":{"max_bytes":262144,"max_depth":1,"max_effects":2,"max_messages":0,"max_spawns":0,"max_writes":1},"firing_id":"client-emitter-probe-001","messages":[{"durable":false,"payload":"{\"client_name\":\"echo\",\"format\":\"ts\",\"manifest_ref_id\":\"client-emitter/example-manifest\"}","schema":"neuron.client-emit-request/v1","to":"client-emitter/client-emitter"}],"now_ms":0,"permitted_reads":["client-emitter/example-manifest"],"reads":[{"bytes":"{\"accepts\":[\"echo.request/v1\"],\"bind\":{\"method\":\"POST\",\"path\":\"/agents/reference/echo\"},\"emits\":[\"echo.response/v1\"],\"errors\":[\"echo.invalid/v1\"],\"id\":\"agents/reference/echo\",\"manifest_digest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"node_address\":\"https://node.example:8443\",\"transport\":\"http\",\"version\":\"1.0.0\"}","digest":"0081ff7c22676dc4c04c9dd31aeaf20345d00359cc15859bf2c834582c8e9349","id":"client-emitter/example-manifest","schema":"neuron.published-manifest/v1"}],"receptor_schema":"neuron.client-emit-request/v1","schema":"neuron.stimulus/v1"}'
expect_contains: 'b908dca784d149a2a286200ee992027ae8d6233ae25af3d92716bbe67835a3d0'
grounding: neuron/AGENTS.md#30, neuron/IMPLEMENTATION.md
---

# client-emitter — typed frontend clients from a published manifest

A generative limb that turns a published boundary's `accepts`/`emits`/`errors`
triple into a client a frontend can import directly, so the frontend consumes
the exact pinned contract the server serves rather than a hand-written guess
at it.

## Why this is a limb, not kernel

Emitting source text from a manifest makes no capability decision: it does
not admit anything, grant anything, or decide what may run. It has no
trust-boundary, atomicity, isolation, or liveness claim — the four reasons
`IMPLEMENTATION.md`'s change procedure requires kernel placement. As a limb it
is digest-pinned, admitted, and revocable like any other package; as kernel
code it would hold ambient authority it does not need and could not be
revoked without a rebuild. `limbs/introspection/neurons/limb_designer.py` is
the direct precedent: it already generates a whole limb package (spec +
manifest) as inert data from substrate state, admitted only by a later,
independent step.

## Neuron

### client-emitter
Reads a `neuron.published-manifest/v1` artifact (staged as an ordinary
digest-pinned read — never a live capability grant) and a
`neuron.client-emit-request/v1` request, and writes a
`neuron.emitted-client/v1` artifact containing generated client source text.

Accepts: `neuron.client-emit-request/v1` (references the manifest read by id)
Produces: `neuron.emitted-client/v1` write

Formats:
- `ts` — a TypeScript ES module: string-union types over `accepts`/`emits`/`errors`,
  a frozen `*_CONTRACT` object, a `*_MANIFEST_DIGEST` constant, and a typed
  `fetch` wrapper that sends the digest as a request header.
- `js` — the same module without TypeScript type syntax.
- `json` — the pinned contract as a plain data document, for callers who
  generate their own bindings rather than consuming JS/TS.

Every format embeds the source manifest's `manifest_digest` as a literal
constant inside the generated text (not only in the wrapping artifact), so a
caller who has only the generated file — not this limb's output artifact —
can still diff that constant against a later server manifest and detect
drift without making a request.

## What this neuron refuses

- A published manifest missing `accepts`, `emits`, `errors`, or
  `manifest_digest` — `validation`. A smaller contract is a different,
  unverifiable one; it is never defaulted.
- A `bind.path` containing a `{placeholder}` — `poisoned_input`. A route
  parameter would be an un-schema'd input channel outside `accepts`; the
  emitter refuses to generate a client that would "just work" against an
  inadmissible source document instead of surfacing the defect.
- An unsupported `format` — `validation`.

## Output is inert

The emitted `source` is written text. This neuron never imports, evaluates,
or executes what it generates, and it performs no admission of its own —
admitting the emitted manifest as an interface (or shipping the generated
file to a real frontend build) is an act the harness performs later, entirely
outside this limb, through the ordinary describe → test → admit → attach
path.

## Shared runtime

Uses `limbs/shared/_neuron.py` for stimulus validation, provenance, budget
enforcement, and typed decision emission — the same contract every other
in-repo generative limb runs against.

## Witness

`tests/conformance.py` admits this package, fires `client-emitter` against a
minimal published manifest through the real `neuron limb admit|run|revoke|detach`
lifecycle, and asserts: the emitted source contains the source manifest's
digest verbatim; a duplicate firing is suppressed; a revoked package refuses
the next `limb run`; and a detached package's audit firings survive (§30).

## Acceptance

The frontmatter `expect_contains` is the emitted artifact's `generated_digest`
— SHA-256 over the *rendered TypeScript source*, not over the input. Nothing
in the probe stimulus contains that value; it exists only once the full
template has run: `safe_ident("echo")` upcased into `ECHO_MANIFEST_DIGEST` and
`ECHO_CONTRACT`, the three string unions rendered from `accepts`/`emits`/
`errors`, the fetch URL built by joining `node_address` with `bind.path`, the
`POST` method taken from `bind`, and the drift-marker comment carrying the
manifest digest verbatim. Change any byte of the generated module and the
digest changes; a handler that only prints a plausible decision cannot reach
it. This is the same property `client_emitter.py` asserts on itself at line
215 (`assert manifest["manifest_digest"] in source`), lifted to cover the
whole rendering rather than one substring.
