# Generated provider adapters in the default hosts

The default Bun and Worker registry now assembles `createProviderAdapterHost` when its sandbox and trusted `ProviderAdapterPolicies` are configured. Bun uses `createService(config, {providerAdapters})`; Worker uses `AIKO_PROVIDER_ADAPTERS`. These are owner-scoped trusted application functions, alongside the existing sandbox configuration, not HTTP inputs. Custom registry/channel/ingress factories keep their override precedence. No provider is configured implicitly.

`ProviderAdapterPolicy` pins an owner, provider account/source/destination, separate bind and send grants, expiry, endpoints, ingress base URL, immutable operation contract and independent verifier, and private signing keys. It bounds instances (1–16), backlog, bytes and retention. Endpoint, account, credentials, grant, limits and runtime/job identities are checked separately from generated output. The retained binding pins the policy digest; mutating an endpoint or credential cannot silently retarget it. Native append fencing enforces the instance quota across competing writers. Policy revocation/expiry blocks new ingress and execution; cleanup needs its current exact authorized policy restored or a separately authorized provider recovery procedure. It never retries an unknown mutation automatically.

Native code-mode tools are mounted in both actual owner actors through their existing tool construction:

- `provider_adapter_catalog`: discover currently permitted fixed contracts and operation bounds, without private keys.
- `provider_adapter_acquire({policy, operationId, candidate?})`: use the existing `HarnessAcquisition`/library evaluation path. Candidate code can be supplied at runtime without app redeploy. The candidate cannot replace the contract, verifier, held-out cases or network grant. Acquisition executes only the pure planner and does not subscribe/send.
- `provider_adapter_control({channel,generation,operation,operationId,originalRenewalId?})`: request one bounded `poll`, `renew`, `reconcile`, `pause`, `resume`, or `retire`; `status` reads the current binding. The host supplies policy authority and the poll partition. Unknown renewal reconciliation names its original renewal operation ID.
- `provider_adapter_bind({policy, name, digest, generation, bridge})`: select the verified immutable candidate, reuse previously created internal ports and a checked hook, persist the external binding and bridge, then arm ingress. The bridge argument contains `operationId`, input/output `{channel,generation}`, wiring `{id,generation}`, `decodeSchema` and `expiresAt`. External identity and authority fields come from policy. The call returns **pending**, not active.

Use the existing `channels.bind/connect` package for typed ports and the known handler. The provider tool does not create another actor, queue, journal or scheduler. The native channel runtime drives subscription, sends and cleanup; existing channel APIs request lifecycle changes and reconciliation. Actor identity remains `aiko`.

## Supported provider wire contract

This bounded implementation supports `signed-json-v1`. It is not a general claim of compatibility with arbitrary provider webhook APIs. A webhook policy supplies subscribe/remove endpoints; a poll-only source instead supplies a poll endpoint, without a subscription or removal endpoint. Correlated output still requires a separate send grant and endpoint. Reconciliation is GET; optional renewal is POST. Synchronous challenge handshakes, arbitrary credential-header protocols and provider account/mailbox creation remain unavailable.

The generated JavaScript artifact receives the existing channel adapter invocation `{operation,input,binding}`. It returns an independently checked external observation for decode, or exactly `{payload: ...}` for an operation request. It cannot choose the destination URL, verb, account, credentials, operation key, webhook address, or host facts. One-file source uses the existing async-function-body convention.

The host builds a digest-pinned network SandboxJob using the configured operation endpoint. Subscribe/send/remove/renew use POST; reconcile and poll use GET with a `request` JSON query parameter. The JSON envelope is `{request,proof}`. `proof` is HMAC-SHA256 using the private request key over `harnessDigest(request)` (hex output). The request key itself never enters generated code or a network job. The request includes owner/account, operation and exact stable key, channel/generation, destination, checked payload, original subscription key and observed subscription reference. Subscribe additionally includes the stable webhook URL and its receive-only capability. The network job has one request, a 10-second deadline, 64 KiB output limit, and exactly the configured origin/verb. It uses the existing owner sandbox job receipts and private custody, with no browser or host fetch.

A provider returns `{receipt,signature}`. Its signature is HMAC-SHA256 over `harnessDigest(receipt)` using the separately configured receipt key. The receipt must match owner/account/channel/generation/operation/key and the exact `requestDigest`. Subscription replies require `ready`/`removed`/`renewed` and an observed `subscriptionRef`; send/reconciliation replies distinguish `accepted_by_provider`, `delivered`, `failed` and `unknown`, with a provider ID for known outcomes. Merely returning JSON or HTTP 200 proves neither activation nor delivery. Signed proofs are retained in the owner's encrypted harness blob store. Public native receipts carry bounded references and outcome metadata, not raw payloads, signing material or provider bodies.

Ingress is the existing receive-only `/v1/channel-ingress/pa_<base64url-owner>_<channel-digest>` route, before account authentication. It requires `x-channel-receive-capability`, `x-provider-occurrence`, `x-provider-conversation`, and `x-provider-signature`. The signature is HMAC-SHA256 over `JSON.stringify([owner,account,channel,generation,occurrence,conversation,rawBody])` using the receiving key. The receiving capability is scoped to the exact route and generation. It cannot authorize sends or account APIs. Neither credentials nor a verifier can be supplied by the HTTP body.

## Early input and recovery

`AikoChannelIngressArmed` is appended only after the typed hook and provider bridge exist. A generated pending binding cannot subscribe before that receipt. Armed pending instances can retain bounded signed input in encrypted custody and acknowledge it. Decoding and hook execution remain gated on verified activation. The stable host ingress does not depend on a running adapter guest. Once activated, the existing bridge routes to the checked handler and creates a correlated outbox intent; no extra `MessageReceived` or model decision is introduced.

Existing native `SubscriptionStarted` and `OutputStarted` claims fence side effects. Lost acknowledgements become unknown. Explicit reconciliation uses a separate bounded GET operation with the original mutation identity, rather than replaying subscribe/send/remove. Retiring a confirmed subscription carries its observed remote reference; uncertain cleanup remains uncertain until provider evidence confirms removal. Raw ingress remains private throughout restart and duplicate acknowledgement.

## Poll-only source and lifecycle recovery

Configure `endpoints: {poll:"/poll",send:"/send",reconcile:"/reconcile"}` for the supported poll-only source. Native acquisition and bind are unchanged. The binding retains its exact bridge intent before activation; the mounted native channel runtime recovers bridge registration and ingress arming from that intent after a cut. With no subscribe operation, activation is local and allocates no provider subscription. The existing typed bridge and separate receiving/send policy checks still apply.

```js
await tools.call({name:"provider_adapter_control",arguments:{
  channel:bound.channel,generation:bound.generation,
  operation:"poll",operationId:"mailbox-read-1"}});
// Subsequent explicit lifecycle requests use pause, resume, renew or retire.
```

The fixed poll protocol exposes one symbolic partition, `provider`, mapped by the host to the configured account. It is not an arbitrary mailbox query capability. The signed request payload is `{partition:account,cursor,limit}`; generated planner data cannot override it. The signed receipt adds `{status:"polled"|"gap",partition:account,previous,cursor,items}`. Each item is `{occurrence,conversation,observation}`; the host constructs principal, partition, empty ancestry and verification evidence. The existing observation schema either admits the item or retains a rejection. Provider cursors stay in encrypted custody; owner/generation-scoped opaque references enter native cursor events.

A keyed `PollFetched` native effect retains the private batch before a separate admission effect. Acceptance/rejection and `CursorAdvanced` commit together through the shared HostedChannels gate. Reopening that cut consumes the retained batch without another GET. Missing batch custody produces an invalid/unavailable outcome rather than re-fetching the operation. Empty unchanged batches create no input, handler invocation or correlated outbox. A signed gap advances no cursor and stops later requests in that partition/generation. Requests are explicit and bounded by existing backlog/byte limits and the one-request, ten-second sandbox budget; there is no new polling timer or queue.

Renewal uses the existing `SubscriptionStarted` and `RenewSettled` receipts. Lost renewal acknowledgments remain unknown and block another renewal. `reconcile` with `originalRenewalId` uses a signed GET naming the exact original renewal key. It records the checked renewal outcome without re-emitting `BindingReady` for an already active instance. Later operations use the most recently observed subscription reference, including reconciliation receipts.

Pause/resume are retained native lifecycle transitions. Paused ingress is rejected; retirement reconciles remote cleanup before subscription-backed generation upgrade. Acquire a new immutable candidate and call bind with the next generation after retirement. The prior ingress token/generation stays fenced; old queued work follows the runtime's pinned-generation cancellation policy. Restoring a binding-intent cut reuses the retained bridge specification instead of requiring a lost tool call to run again.

## Direct evidence and limits

`provider-adapter-host.test.ts` runs both actual production host entries with their **default** registry factory. The test supplies a different candidate from the template through native acquisition, uses real local sandbox guests and controlled HTTP provider/ingress servers, verifies HMAC receipts, captures input during subscribe before activation, processes a known hook, and observes accepted then delivered receipts. It closes/reopens the host, sends a fresh occurrence after setup guests have exited, and checks no subscription duplication or extra inference. It also exercises poll-only Bun/Worker execution, unchanged polling, signed partition gaps, the actual Worker private-batch and binding-intent cuts, signed renewal recovery, pause/resume and immutable candidate upgrade across reopen, lost subscribe/send/remove acknowledgements, explicit reconciliation, retirement, forged provider proof/signature, foreign authentication, expiry/retargeting, instance quota and inbox-only grant denial. Entire native logs and SQLite bytes are scanned for private input and signing keys.

These are controlled protocol witnesses, not live third-party/provider compatibility or deployed Worker evidence. Production providers need independently reviewed adapters/policies for this supported protocol; unsupported auth/handshake/lifecycle features stay unavailable. Full plan and protected acceptance gates remain open.

### Finite automatic controls (native host, no separate scheduler)

Trusted `ProviderAdapterPolicy.automaticControls` explicitly supplies
`{maxRuns, minIntervalMs, maxDurationMs}`. Limits are capped at 16 physical cycles,
a minimum 100 ms interval and a maximum one-day plan. Absence denies scheduling;
receiving/send grants and current owner authorization are still independently
required. Catalog discovery reports the limits and signed-lease support.

The owner-native `provider_adapter_control` tool accepts `operation: "schedule"`
with `operationId` and this plan (owner, configured account partition, policy digest
and immutable artifact/generation scope are supplied by the host):

```js
await tools.call({name: "provider_adapter_control", arguments: {
  channel, generation: 1, operation: "schedule", operationId: "bounded-poll",
  plan: {action: "poll", maxRuns: 3, intervalMs: 1000, backoffMs: 2000,
    firstAt: Date.now() + 1000, expiresAt: Date.now() + 10_000, leaseLeadMs: 0}
}});
```

`backoffMs` is a bounded minimum cooldown between successfully settled cycles,
not permission to retry unknown effects. Non-accepted polls and unknown renewals
stop progression. `cancel-schedule` takes `planId`; `status` reports retained plan
usage and due/stopped state. Pause suppresses new work; resume uses its retained
lifecycle timestamp as a fresh minimum due anchor without restoring spent runs or
extending expiry. Retirement and generation changes fence the old plan.

`channel-controls.ts` is only a pure log projection. `createChannelRuntime` owns
ControlPlan/ControlTick/ControlStopped effects and invokes its existing
requestPoll/requestSubscription methods under stable per-plan ordinal IDs. There
is one outstanding operation per plan. PollFetched private custody is reused on
restart; the next cycle requires accepted/rejected batch custody and cursor
settlement. Backpressure/missing custody remain pending or unavailable and never
justify another GET for the same fetched batch. Typed-inbox backpressure now retains `PollAdmissionDeferred` under the original
poll ID. The runtime observes scoped consumer cursors and lifecycle receipts;
only progress on that bridge input, resume, cancellation or the original deadline
changes the admission effect key. It reopens the existing private `PollFetched`
batch and retries only the shared admission transaction. It never reissues the
provider GET, advances a cursor ahead of admission, or restores spent runs.
Unrelated cursors cannot trigger retries. Admission is limited to 64 deferrals
and the earlier of the original request retention deadline and plan expiry.
The existing native alarm also expires a blocked batch without consumer progress.
Pause preserves the batch and original deadline. Cancellation or expiry records
`admission_unavailable` without advancing its source cursor. Missing private
custody remains unavailable; it does not authorize another fetch. Current artifact,
source-change policy, scheduled grant and receiving authority are rechecked,
including after asynchronous custody work under the shared host commit gate. No catch-up bursts, model loop or additional queue.

Automatic renewal additionally requires trusted policy
`leaseReceiptVersion: "signed-lease-v1"`. The actual provider's HMAC-signed
subscription/renewal receipt must include `receiptVersion: "signed-lease-v1"` and
an integer `leaseExpiresAt` later than verification time. The verified timestamp
is retained with the subscription receipt. No locally invented lease dates or
planner-provided expiry can qualify. Renewal runs no earlier than both the
configured cooldown/firstAt and signed expiry minus leaseLeadMs. Unknown renewal
stops the plan; the existing explicit originalRenewalId signed reconciliation path
remains required. Reconciliation does not silently resume the old plan.

The existing `channelWiringNextWake` now includes `channelRuntimeNextWake`, so the
already-mounted hostedChannelDeadlines/channelWait method and Worker alarm minimum
receive these deadlines. No actor/server/cloudflare changes are required; avoid
adding another scheduler. `channel-controls.test.ts` tests actual Bun/Worker
entries, native AlarmFired, finite polls, signed renewal, unknown acknowledgement,
expiry/cancel/revocation, pause/resume and a Worker PollFetched storage cut. All
physical HTTP services are controlled localhost fixtures. No live provider setup
or deployment is attested. The full S24 acceptance parent remains open.


Backpressure recovery evidence: `channel-controls.test.ts` uses actual default
Bun and Worker entries. Native code fills a one-item private inbox before hook
registration. A separately authorized, bounded native backfill consumes the old
item after pause and storage restart, freeing capacity for the retained provider
batch. Tests assert the original poll identity, one GET, one cursor settlement,
unchanged expiry/allowance and private SQLite custody. Separate cancellation and
real AlarmFired expiry cases retain the cursor and perform no additional jobs.
No host mount is needed: `channelWiringNextWake` already composes
`channelRuntimeNextWake` through the existing Bun/Worker deadline method.
This is typed-inbox admission recovery; oversized or invalid batches are not split
or transformed to force acceptance, and unknown provider mutations still require
the existing signed reconciliation path.
