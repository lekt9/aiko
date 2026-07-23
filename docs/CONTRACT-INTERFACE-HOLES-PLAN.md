# Contract interface holes — universal adapter plan

## North star

Any interface—Telegram, iOS, email, Slack, a local app, a future device—can
connect to Contract through the same typed holes without adding provider
branches to the core runtime.

Contract is the control plane. Adapters still perform real platform work
through the Telegram Bot API, iOS frameworks, local tools, or another provider.
The core routes typed capability envelopes, authority, lineage, evidence,
retry, and settlement; it does not pretend a ledger row sent a message.

## Current truth

| Surface | What exists | Honest gap |
|---|---|---|
| Base Contract skill | Says limbs use typing, rich formatting, uploads, voice, keyboards, edits, reactions | Narrative guidance is not a validated adapter protocol |
| Telegram skill | Event graph, identity gate, message/voice/callback mapping | `assets/capabilities.json` exposes only update observation and text send |
| Native capability catalog | Typed input/output, permission, effects, availability, observations | No shared event/effect envelope, reply/media union, TTL, or correlation law |
| Contract-native skills | Bounded graph bundles and held consequential effects | Interface conformance suite is missing |
| iOS | Native application interfaces exist separately | No Contract interface adapter pack proving entitlement, lifecycle, and UI-effect routing |

Nothing in this plan marks those gaps implemented.

## 1. Universal interface-hole protocol

An interface pack is data plus an adapter. It registers capabilities; Contract
selects and governs them; the adapter invokes the real platform.

Every event or effect travels through these ports:

```text
observe → normalize → authorize → prepare → execute → sense → evaluate → settle
```

| Port | Required result |
|---|---|
| observe | Durable event identity before destructive filtering |
| normalize | Provider payload becomes the shared envelope; secrets/raw bytes excluded |
| authorize | Actor, resource, capability, and effect scope resolve to allow/HOLD/deny |
| prepare | Validate shape, resolve references/media, establish idempotency and TTL |
| execute | Invoke the provider exactly once per idempotency scope |
| sense | Capture provider acknowledgement and externally observable result |
| evaluate | Decide satisfied/died/retry/HOLD from declared evidence policy |
| settle | Append terminal/release outcome and local learning observation |

Read-only ports may wave-parallel after observation. An effect port depends on
authorization and preparation. Parent success waits for required child effects.

## 2. Shared envelopes

### 2.1 Interface event

```json
{
  "schema_version": 1,
  "interface": {"kind": "telegram", "instance_id": "bot:hash"},
  "event": {
    "id": "update:291764682",
    "kind": "message.received",
    "occurred_at": "RFC3339",
    "deduplication_key": "bot-hash:update-id",
    "correlation_id": "conversation-or-turn-id",
    "causation_id": null
  },
  "actor": {"id": "provider-scoped-hash", "authorization": "pending"},
  "conversation": {"id": "provider-scoped-hash", "thread_id": null},
  "content": {"kind": "text", "summary": "bounded redacted text"},
  "reply_context": {"message_id": null, "quoted_kind": null},
  "privacy": {"classification": "private", "retention": "metadata"},
  "raw_payload_ref": null
}
```

`raw_payload_ref` may point to an adapter-owned, access-controlled temporary
object; raw provider payloads, tokens, contact details, and media bytes never
enter the shared ledger.

### 2.2 Interface effect

```json
{
  "schema_version": 1,
  "capability_id": "interface.respond",
  "target": {"interface": "telegram", "conversation_id": "provider-scoped-hash"},
  "response": {
    "kind": "text",
    "text": "hello",
    "media_ref": null,
    "caption": null,
    "reply_to": null,
    "thread_id": null,
    "controls": []
  },
  "effects": ["network_write", "message_send"],
  "permission": "write",
  "idempotency_key": "turn-id:response:0",
  "delivery": {"ttl_ms": 30000, "ephemeral": false, "coalesce_key": null},
  "evidence_policy": {"require_provider_ack": true, "require_delivery_probe": false}
}
```

`response.kind` is a closed, versioned union initially containing `text`,
`voice`, `audio`, `image`, `video`, `file`, `reaction`, `edit`, `delete`,
`typing`, `callback_answer`, and `custom`. Provider packs publish which variants
and fields they support. Unsupported variants HOLD or fail shape validation;
they never silently degrade to text.

## 3. Ephemeral and durable effects

Typing indicators are effects, but they are not durable messages:

- `typing` is `network_write + ephemeral_presence`.
- It requires conversation authorization but not durable-message permission.
- It carries a short TTL and a coalesce key per conversation.
- Repeated starts refresh one lease; they do not append an unbounded event stream.
- Cancellation, terminal response, timeout, or lost turn ownership stops refresh.
- Its success never satisfies the parent response and does not train semantic
  route quality; it records only adapter health/latency.

Voice and other media are durable message effects:

- inbound metadata is observed before download;
- download/transcode/transcribe are separate bounded children;
- media bytes remain behind temporary references with expiry;
- outbound `voice` depends on synthesis/validation plus message authorization;
- provider acknowledgement proves send acceptance, not that the user listened;
- reply, thread, caption, and correlation metadata survive normalization.

## 4. Telegram conformance pack

The Telegram pack maps shared capabilities to Bot API methods without putting
Telegram branches in Contract core.

| Shared capability | Telegram method/event | Contract shape |
|---|---|---|
| `interface.events.observe` | webhook / `getUpdates` | network-read occurrence, `(bot_id, update_id)` dedupe |
| `interface.presence.set` | `sendChatAction` | typing lease, TTL/coalescing, never parent success |
| `interface.respond` text | `sendMessage` | authorized message-send effect |
| `interface.respond` voice | `sendVoice` | authorized media effect with temporary file/ref |
| `interface.respond` edit | `editMessageText` / caption variants | authorized mutation of named message |
| `interface.respond` reaction | `setMessageReaction` | authorized message mutation |
| `interface.respond` callback | `answerCallbackQuery` | short-TTL acknowledgement effect |
| `interface.media.inspect` | `getFile` | authorized network read; metadata first |
| `interface.message.delete` | `deleteMessage` | consequential delete effect |

Telegram-specific result normalization is
`{ok, provider_id, result_shape, error_class, retry_after_ms}`. HTTP 429 and
transient transport errors release for bounded retry. Malformed input and
unsupported response variants die. Authorization absence HOLDs.

### Required Telegram scenarios

1. Text inbound → durable observation → authorized typing lease → text reply →
   typing stop → response settle.
2. Voice inbound → metadata observation → authorized fetch → transcription →
   response selection → optional synthesis → `sendVoice` settle.
3. Reply-to message preserves `reply_to` and thread correlation.
4. Callback query is acknowledged within TTL even when later work HOLDs.
5. Unauthorized actor is observed and normalized, while send/voice/delete HOLD.
6. Duplicate update creates no duplicate effect.
7. Rate limit releases with `retry_after_ms`; idempotency prevents double send.
8. Provider acknowledgement cannot falsely satisfy “user heard voice.”

## 5. iOS conformance pack

iOS is another adapter pack, not a privileged exception. It maps shared holes
to framework calls while retaining OS lifecycle and entitlement truth.

| Shared capability/event | iOS surface | Contract constraint |
|---|---|---|
| `interface.events.observe` | App Intent, deep link, notification response, scene event | Stable event/correlation id before dispatch |
| `interface.presence.set` | In-app progress/live state | MainActor UI projection, TTL, cancellable |
| `interface.respond` text/media | SwiftUI/UIKit presentation, notification content, share sheet | Capability advertises foreground/background support |
| `interface.media.capture` | AVFoundation / Photos picker / microphone | Explicit OS permission + user gesture where required |
| `interface.voice.transcribe` | Speech framework or provider | Permission, locale, temporary audio retention |
| `interface.notification.send` | UserNotifications | Authorization and scheduling evidence |
| `interface.background.run` | BGTaskScheduler | Finite lease; expiration handler releases |
| `interface.open` | universal link / app route | Allowlisted destination and scene availability |

The adapter never treats an entitlement request as an entitlement grant.
MainActor, scene phase, background expiration, protected-data availability, and
user cancellation are sensor evidence. UI rendering alone does not prove a
notification was delivered or content consumed.

### Required iOS scenarios

1. App Intent enters once, preserves correlation, and routes to a bounded graph.
2. Background task expiry cancels work and releases the occurrence.
3. Denied microphone permission HOLDs/terminates capture without invoking speech.
4. Voice capture bytes stay out of the ledger and expire after processing.
5. A typed response projects on MainActor and settlement uses adapter evidence.
6. Deep link destinations are allowlisted and preserve scene/thread context.
7. Notification authorization, scheduling, delivery, and user-open remain
   distinct evidence states.
8. Foreground progress/typing projection stops on response, cancellation, or TTL.

## 6. Agent knowledge and routing policy

The agent must receive a compact live rule, not rely on this plan being read:

```text
Treat interfaces as typed Contract holes.
Observe and normalize inbound events before filtering.
For effects, select a registered capability; require authority, idempotency,
and evidence; then let the adapter execute the real platform action.
Use the shared response union. Never invent a provider branch or silently
degrade an unsupported response kind.
```

The host injects only descriptors relevant to the current event and available
adapter. The agent chooses intent and response shape; deterministic code
validates the envelope, gates authority, expands the graph, invokes the adapter,
and settles evidence. Routing must work without the model memorizing Telegram
method names or iOS framework APIs.

## 7. Delivery phases and gates

### Phase 0 — freeze the protocol

- Publish shared event/effect JSON Schemas and effect taxonomy.
- Define response union, evidence states, TTL/coalescing, idempotency, and
  privacy/reference rules.
- Add conformance fixtures for Telegram and iOS.

Gate: schema validation plus positive/negative fixtures; unknown effect,
unsupported response kind, leaked secret/raw bytes, or missing idempotency fails.

### Phase 1 — generic adapter registry

- Extend capability descriptors with response variants, lifecycle support,
  ephemeral semantics, and evidence policy.
- Resolve packs by interface kind/version/availability.
- Expand the fixed port algebra into bounded Contract children.

Gate: provider-neutral registry tests; no Telegram/iOS branch in Contract core;
cycles, authority laundering, and effect downgrades fail closed.

### Phase 2 — Telegram reference adapter

- Add descriptors and executors for typing, voice, edit, reaction, callback,
  media inspect, and delete.
- Route all inbound update kinds through the shared event envelope.
- Implement typing lease/coalescing and media temporary references.

Gate: all eight Telegram scenarios with a fake Bot API plus replay,
rate-limit, duplicate, authorization, and privacy falsifiers.

### Phase 3 — iOS reference adapter

- Add a Swift adapter translating App Intents, scenes, notifications, media,
  speech, and background tasks into the shared protocol.
- Keep Contract state outside view models; expose projections through an
  observable adapter store.

Gate: all eight iOS scenarios using protocol/unit tests plus simulator tests
for permissions, cancellation, background expiry, MainActor projection, and
deep-link allowlisting.

### Phase 4 — agent policy and cross-provider proof

- Inject the compact routing rule and relevant descriptors into every agent
  surface.
- Add positive and negative boundary examples.
- Run one conversation flow unchanged across Telegram and iOS adapters.

Gate: the same normalized intent graph selects the correct adapter; an
unsupported provider capability HOLDs rather than hallucinating execution.

### Phase 5 — third-adapter generalization

- Implement a third adapter (Slack, email, or a local test interface) using only
  the published protocol.
- Measure core changes required.

Gate: zero provider-specific branches added to Contract core. If core changes
are required, revise the protocol rather than adding an exception.

## 8. Test pyramid

1. Schema/property tests for envelopes, union variants, redaction, TTL, and keys.
2. Graph tests for port order, parallel reads, authority barriers, and parent settle.
3. Adapter contract tests against fake Telegram and iOS transports.
4. Replay tests for duplicates, retries, cancellation, expiry, and crash recovery.
5. Privacy tests proving tokens, raw contacts, and media bytes never reach ledger.
6. Agent routing evals for capability selection and unsupported-capability HOLD.
7. Cross-provider golden tests comparing one intent graph across adapters.
8. Live opt-in smoke tests with isolated test accounts/devices; never CI defaults.

## 9. Definition of done

- Shared schemas and adapter SDK are versioned.
- Telegram and iOS pass every required scenario and falsifier.
- Typing/presence is leased, coalesced, cancellable, and never parent success.
- Text, voice, media, reply, thread, callback, edit, reaction, and delete use the
  same response/effect algebra.
- Agents receive and pass tests for the routing rule.
- Secrets and media bytes remain outside Contract rows and prompts.
- A third adapter ships without a Contract-core provider branch.
- Open claims remain Open until their runnable gates pass.

## 10. Explicit non-goals

- Contract does not replace Telegram/iOS APIs or application code.
- The model does not execute effects by emitting JSON alone.
- The core does not learn provider-specific method names.
- A provider acknowledgement is not user consumption evidence.
- No live account/device mutation is required by the plan witness.
