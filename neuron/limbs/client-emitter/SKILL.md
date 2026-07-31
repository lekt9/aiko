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
