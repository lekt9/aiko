# Standing internal management in configured hosts

Bun `createService(config, {registryManagement: owner => policy})` and Worker
`AIKO_REGISTRY_MANAGEMENT: owner => policy` activate the default registry's native
continuation executor. They do not require a custom RegistryHostFactory. The
existing configured code transport, private owner WorkflowKV, journal, code-mode
component and alarm path are reused. Absence of a trusted policy grants nothing.
These function bindings are trusted host setup, not environment JSON or HTTP input.

`RegistryManagementPolicy` (registry-management.ts) supplies a revision, exact
parent artifact/contract/independent verifier definitions, digest-pinned child
handlers, maxCalls (1–16), maxBytes (1–65536), and wallMs (1–60000). Default seed
registration happens through native effects, never projection or construction.
Only host-configured parent definitions enter this allowlist. Candidate names,
source text, imported guidance and channel payloads cannot install policy.

Registration is deliberately staged. Register/evaluate the permitted children
(normally `harness_acquire` for builtins), then `harness_evaluate` the exact parent
artifact digest with its trusted fixed preflight cases. The ordinary default
acquisition catalog remains unchanged. A parent's pure preflight branch is not
an evaluation of its management effects and does not establish their general
correctness. The separate real invocation creates child channels through native
package effects and verifies its retained final value with the registered
independent verifier. A wrong final value is violated despite passing preflight.

At every management call and private result read, the host rechecks the current
standing policy, exact parent claim/pin, receiving authority and cancellation.
The retained claim must originate from a root internal port with no inherited
ancestry, using the standing internal receiving authority. Depth is therefore
zero; child management is unavailable (maxDepth 1). Child pins may only declare
pure/channel.reply JavaScript behavior. Grants cap backlog 8 and hops 2; their
absolute deadline is bounded by the retained source admission time plus wallMs
and the parent's contract timeout. Replay never refreshes that deadline.

Removing/changing the policy, cancelling the parent native execution or its
retained request waiter, expiry, or missing custody denies continuation. Children
already accepted under their own pure receiving authority may finish; they gain
no provider credential, subscription, network transport, or recursive management
permission. Future recursive management requires a separately reviewed lineage
policy; callers cannot supply a depth or authority override.

Both host and effect-specific Sandbox layers install the continuation wrapper
around the existing private CodeHarness/channel layers. Native HandlerDispatched,
ManagementGranted, CodeDispatched/Settled and checked receipts retain progress;
no scheduler or database is added. The Bun append transaction now applies the
channel wiring fence alongside the existing library/media fences.

Evidence: registry-management-host.test.ts exercises actual createService default
assembly, staged registration, child execution, independent rejection, cancellation,
revocation and disk reopen. channel-registry.test.ts separately exercises parked
native continuation recovery and missing envelopes using the Worker account-host
adapter. This is controlled local evidence, not a deployed Worker/provider witness.
