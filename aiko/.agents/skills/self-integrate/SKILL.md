---
name: self-integrate
description: "Turn a handed-over credential into a durable, witnessed integration instead of ad-hoc probing. Read this BEFORE reaching for curl. Use the moment a user pastes an API token, bot token, API key, webhook URL, or account for ANY external system — Telegram, Slack, email/IMAP, SAP, GitHub, Stripe, a bare REST endpoint — or says 'connect me to X', 'talk to me through X', 'wire up the bot', 'set up the channel', 'integrate with X', 'let me message you on X'. Verify read-only exactly once, then stop probing and stand up a durable Smithers workflow with an Aiko worker that covers the boundary's whole capability surface, secrets in env only, witnessed by a gate that can fail before anything is claimed."
---

# Self-integrate: from a handed credential to a held boundary

Someone gave you a key to a system you do not yet talk to. Everything below is
one refusal wearing seven coats: **refuse to call a boundary integrated when
nothing durable is holding it.**

A `curl` that returns `200` proves the credential is valid. It does not prove
the boundary is wired, and the gap between those two claims is where the whole
failure in [Anti-pattern](#anti-pattern-the-failure-this-skill-exists-to-prevent)
lives. A boundary is finished when a durable loop holds it — an ingest source
with a persisted cursor, a workflow parked on the inbound event, a worker
producing typed output, and a router that maps that output onto real verbs. Not
when a probe succeeded.

Path conventions below: `packages/`, `.smithers/` and `e2e/` are in the Smithers
tree (`aiko-flow/`); `crates/` and `.agents/` are in the aiko tree.

This procedure is not an analogy borrowed from Telegram. `packages/integrations/src/core/README.md:3`
calls itself "the service-agnostic integration pipeline every service builds
on", and GitHub (`packages/integrations/src/github/`) and Linear
(`packages/integrations/src/linear/`) are sibling instances of exactly the shape
below. You are filling in slots in a pipeline that already exists, not inventing
one. The [slot table](#the-slot-table) says which slots.

---

## 1. Refuse the secret's location

If the credential arrived in chat, it is **already compromised**. Say that
plainly, before anything else, and tell the user to rotate it at the issuer
(BotFather, the API console, the IAM page). Do not soften it into "best practice
would be" — the message was typed into a transcript, and transcripts are stored,
synced, and replayed.

Then never make it worse. **Never interpolate a secret into a command line.**
The value goes in `process.env`; the command text carries only the *unexpanded*
variable:

```bash
# correct — the literal string ${TOKEN_ENV_VAR} is what appears in argv logs
curl -sS "https://api.example.com/v1/me" -H "Authorization: Bearer ${SERVICE_TOKEN}"
```

The refusal exists because argv is not a private channel. It is visible to `ps`
for every user on the box, it lands in shell history, and — since an agent's
tool calls are echoed — it lands in the transcript a second time. Library-level
redaction cannot reach any of those. `sanitizeTelegramNetworkCause`
(`packages/telegram/src/index.js:138-155`) and `redactBotToken`
(`packages/integrations/src/telegram/TelegramClient.d.ts:12`) both exist and both
work, and both are downstream of the mistake: they scrub *error strings*, not the
process table. Redaction is defence in depth for the case where you were already
careful.

Neither may a secret enter a durable row. The rule the prior art already follows:
**the workflow input carries the environment variable's name, the process env
carries its value, and nothing carries it into a row.** See
`.smithers/workflows/telegram-daily-digest.tsx:15` (`DEFAULT_TOKEN_ENV`), `:103`
(input described as "Environment variable containing the … token"), `:280`
(`process.env[name]`), and `:611`/`:1040` (resolved inside the effect, at the
moment of the call, never returned into an output).

## Exclusive poller (Telegram)

Telegram allows **exactly one** `getUpdates` holder per bot token. A second
long-poll — `curl …/getUpdates`, `bridgeHost.js`, a Smithers Loop that polls,
or the desktop Remote IM channel — returns `409 Conflict` and the inbox
becomes a coin flip.

If any of these already own the slot, **attach; do not start a second host**:

- `systemctl --user is-active aiko-telegram` is `active`
- `pgrep -x telegram-daemon` finds `~/.local/bin/telegram-daemon`
- cockpit `/api/telegram/self-aware` reports the bridge running

Then: one `getMe` (identity only). **Do NOT curl getUpdates.** **Do NOT start
`bridgeHost.js`.** Restart or authorize chats on the existing daemon if needed.
Claiming "wired" after standing up a second poller is the bug this section
exists to prevent.

## 2. Verify read-only, exactly once

Every boundary has an identity call: `getMe`, `auth.test`, `GET /me`, `whoami`, a
session-metadata endpoint. Make **one** of them. In memory. Summarize the result
without secrets — the account name and id are fine, the credential is not, and
neither is the raw response body.

This step is correct and necessary: you should not build against a credential you
have not confirmed. It is also the *only* read you are entitled to before wiring
starts. For Telegram, that one read is `getMe` — never `getUpdates`.

## 3. Stop probing. A chat quiz is not integration

The second probe is the failure mode. Once identity is confirmed, every further
hand-rolled call — listing pending updates, fetching a channel list, polling for
the message you asked the user to send — is a probe wearing the costume of
progress. The tell is unmistakable and you should treat it as an alarm:

> **If your next sentence asks the user to do something at the boundary so that
> you can go look again, you have built a probe, not a wire.**

"Send it a message and tell me when, and I'll re-poll" is a human being
hand-cranking a loop that the substrate is supposed to hold. So is "reply A or B
and I'll connect". A menu is not a plan; it is the absence of one, offered as
interactivity.

The refusal exists because probing feels like progress and terminates only when
the user gets bored. Wiring has a completion condition: the gate goes green.

## 4. Enumerate the capability surface and name the gaps

Before writing a line, list what the boundary actually offers, in the categories
that matter:

- read / list / ingest
- send text
- send each media type (image, video, audio, voice, document)
- presence and status signals (typing, read receipts, availability)
- interactions and callbacks (buttons, approvals, slash commands)
- file download — being able to *see* an inbound attachment is not being able to
  *fetch* it
- admin and lifecycle (webhook registration, membership, rate-limit metadata)

Then diff that list against the client library actually on hand, and **write the
gaps down as gaps.** The capability table is part of the deliverable. "It can
send text" is a probe result; "it covers these seven verbs and lacks `getFile`"
is a wire with a known edge.

**Never promise a verb the code lacks.** A skill or a doc that names an effect
the client cannot perform is worse than silence, because the next reader — human
or model — plans against it and discovers the hole at the boundary, at runtime,
with a user watching. This repository already contains one instance:
the retired `telegram-contracts` skill named `sendVoice` as an available
effect child while an exhaustive grep across `packages/telegram/**` and
`packages/integrations/**` matched zero files for `sendPhoto`, `sendVideo`,
`sendAudio`, `sendVoice`, `sendVideoNote`, `sendAnimation`, `sendSticker`,
`sendMediaGroup`, `getFile`, `editMessageMedia` or `sendLocation`. The
description sat outside anything that checked it, so it was free to drift — the
same rot `SKILL.md` being inside the package digest exists to close
(`neuron/src/limb_ops.zig`, `computePackageDigest`).

Enumerating honestly is also what makes step 7 possible: you cannot assert "each
kind selects its verb and only its verb" over a surface you never listed.

## 5. Close the gaps inert, then admit them

Add the missing verbs to the typed client with no behaviour change anywhere else.
Write them **inert** — present, typed, unreachable from any live path — and let
them earn their place by being exercised in step 7.

The invariant is the repository's own: *write inert → admit by digest → never
retain on compilation alone.* A verb that compiles has demonstrated that it
parses. Compilation is not evidence that it crosses the boundary correctly, and a
generated or hand-added handler retained on compilation alone is exactly the
thing `meta-agent-gate.sh` refuses.

Teach the fixture the new verbs in the same pass. A well-built fixture returns
404 for an unknown method, which means a newly added verb **fails loudly** until
the fixture learns it (`packages/integrations/tests/telegram-fixture.js:114-117`).
That default is a feature: it is what stops the stub tier from silently agreeing
with whatever you wrote.

## 6. Declare the typed reply union

One discriminated union over a `kind` field, one arm per capability, so a single
worker output selects exactly one verb:

```ts
const reply = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"),  text: z.string().min(1) }),
  z.object({ kind: z.literal("photo"), path: z.string(), caption: z.string().nullable().default(null) }),
  z.object({ kind: z.literal("voice"), path: z.string(), caption: z.string().nullable().default(null) }),
  // …one arm per verb the boundary actually has, per step 4
]);
const workerOut = z.object({ replies: z.array(reply).min(1), conversationId: z.string() });
```

Two properties, both load-bearing:

- **The router is a total function.** An unknown `kind` is a schema failure —
  caught and retried by `maxSchemaRetries` (`packages/components/src/components/TaskProps.ts:26`)
  — rather than a silent no-op. A stringly-typed `action` field with an
  `if/else` chain fails by doing nothing, which is the failure mode you cannot
  see in a log.
- **The worker never crosses the boundary; the router does.** `path` is a local
  file the worker already produced. Keeping every upload in one place keeps
  every secret, retry, rate-limit and redaction decision in one place too.

`replies` is an array because one turn legitimately answers with a caption plus a
voice note.

## 7. Wire the durable loop, then witness before claiming

**The loop.** An ingest source with a persisted cursor, a long-lived workflow
parked on the inbound event, an agent worker producing the typed reply from
step 6, and a router mapping `kind → verb`. Long waits park on a durable timer —
the engine releases the worker and persists only the fire time
(`packages/server/src/gateway.js:6372-6379`), so a parked run costs no process.
Bound the history of an unbounded loop with `continueAsNewEvery`
(`packages/components/src/components/LoopProps.ts:9`). Run it detached
(`smithers up <wf> -d`) and supervised (`smithers supervise`).

**Never a `while true` in a shell.** A shell loop holds a process, loses its
cursor on restart, and has no durable record that it ran — which means it cannot
be witnessed, only observed.

**The worker layer.** `AikoAgent` (`packages/agents/src/AikoAgent.js:82`,
re-exported from `smthrs`) shells out to `aiko --single … --output-format
streaming-json`. Copy the provider wiring verbatim from
`e2e/fixtures/aiko-harness/.smithers/agents.ts:7-16` and bind the schema with
`output={outputs.reply}` as in
`e2e/fixtures/aiko-harness/.smithers/workflows/aiko-sentinel.tsx:21-32`.

**Contract lineage crosses the hop for free.** `lineage_env_for_child_of`
(`crates/codegen/xai-grok-shell/src/contract_native.rs:3897-3910`) emits
`AIKO_CONTRACT_PARENT_ID`, `AIKO_CONTRACT_ROOT_ID` and `AIKO_CONTRACT_DEPTH`;
`BaseCliAgent` inherits the environment by default
(`packages/agents/src/BaseCliAgent/BaseCliAgent.js:923,944`), so outer aiko →
`smithers` → `AikoAgent` → inner aiko carries the lineage with no extra plumbing
(aiko ≥ 0.2.116, witnessed at `tmp/witness-one-aiko.sh:78-99`).
`AIKO_CONTRACT_ID` is deliberately **excluded** (`contract_native.rs:3884-3888`)
— it is the adopt-identity path, and exporting it would make every child
impersonate its parent.

**Then witness, and only then claim.** Two tiers:

- **Tier 1 — mandatory, hermetic.** A gate against a fixture speaking the
  boundary's *real wire format* over real HTTP (not a mock of the code under
  test). It asserts against durable state, never stdout: the workflow admits and
  reaches `status=finished` with a row in `_smithers_runs`; each `kind` selects
  its verb **and only its verb**; the presence signal fires *before* the send; an
  off-schema worker reply is rejected; and a token-shaped regex over the run db,
  logs and product files returns **zero** hits. Structure it on
  `e2e/aiko-harness-gate.sh:11-27`.
- **Tier 2 — optional, live.** First line is
  `[ -n "${SERVICE_TOKEN:-}" ] || { echo "SKIP: no token"; exit 0; }`. It must
  print `SKIP`, never `PASS`, when the credential is absent, so a missing token
  can never be mistaken for a green live run.

**Prove the gate can fail.** Delete one router branch, run the gate, watch it go
red, restore. A gate that stays green with the feature removed proves nothing —
the falsification leg at `tmp/witness-one-aiko.sh:94-99` is the pattern.

---

## The slot table

The procedure is boundary-agnostic; only these seven slots change per service.

| Slot | Telegram | Slack | Email (IMAP/SMTP) | SAP / arbitrary REST |
|---|---|---|---|---|
| identity check (step 2) | `getMe` | `auth.test` | IMAP login | `GET /ping` or session-token exchange |
| ingest source (step 7) | `getUpdates` long-poll | Events API webhook | IMAP IDLE | webhook, or interval poll |
| cursor | `update_id` offset | event `ts` | UID / `Message-Id` | ETag / high-water mark |
| capability surface (step 4) | text, photo, video, audio, voice, chat action, callback | text, blocks, files, reactions | body, attachments, headers | the OpenAPI verb list |
| presence signal (step 4) | `sendChatAction` typing | `users.setPresence` / ephemeral | none | none |
| reply-union arms (step 6) | `text｜photo｜video｜audio｜voice` | `text｜blocks｜file` | `text｜html｜attachment` | one arm per write verb |
| fixture (step 7) | `packages/integrations/tests/telegram-fixture.js` | equivalent `Bun.serve` speaking the real wire format | local SMTP/IMAP | recorded OpenAPI stub |

A boundary whose row you cannot fill in is a boundary you have not enumerated
yet — go back to step 4. An empty cell is a legitimate answer (email and SAP have
no presence signal); an *unknown* cell is not.

## Where things go

A procedure that cannot say where to write is a suggestion.

| Artifact | Path | Why there |
|---|---|---|
| a new skill | `<repo>/.agents/skills/<name>/SKILL.md` | **Local scope, highest precedence** (`crates/codegen/xai-grok-agent/src/prompt/skills.rs:176-193`), live-reloaded on a 2 s debounce (`crates/codegen/xai-grok-shell/src/config/watcher.rs:402-423`) — no rebuild, no restart |
| **not** here | `~/.aiko/skills/<name>/SKILL.md` | bundled skills are `include_str!`-compiled into the binary (`crates/codegen/xai-grok-shell/src/builtin.rs:10-11`) and **re-extracted over this directory on every startup** (`:242-249`). A skill written only here, under a bundled name, is silently overwritten. It is also only *User* scope, so the repo copy wins anyway |
| workflow | `<repo>/.smithers/workflows/<id>.tsx` | the local discovery tier (`apps/cli/src/workflows.js:566-585`); `<dir>/<id>.tsx` or `<dir>/<id>/workflow.tsx` (`:595-611`) |
| agent providers | `<repo>/.smithers/agents.ts` | pattern at `e2e/fixtures/aiko-harness/.smithers/agents.ts:7-16` |
| gate | `<repo>/e2e/<name>-gate.sh` | idiom at `e2e/aiko-harness-gate.sh:11-27` |
| client verbs | `packages/integrations/src/<service>/` | sibling to `github/` and `linear/` in the same pipeline |

Verify discovery rather than assuming it: `aiko inspect --json` run from the repo
directory lists every skill the binary resolves, with its `name`, `description`
and resolved `source.path`. If your new skill is not in that list, it does not
exist as far as selection is concerned.

## Secrets

- **Env only.** The value lives in the process environment. Config resolution
  order for the Telegram instance is explicit prop > registry >
  `SMITHERS_TELEGRAM_BOT_TOKEN` (`packages/integrations/src/telegram/config.js:36-47`);
  `packages/telegram/src/index.js:341-342` takes it as an argument and never
  reads env at all.
- **Never in argv.** See step 1. This is the one that cannot be fixed after the
  fact.
- **Never in a prompt, a Contract row, a proof, a log, or a shared descriptor.**
  Durable rows outlive the credential and are read by people who should not have
  it.
- **Never prompt the user for it in chat.** Asking is how it ends up in the
  transcript. Ask them to `export` it in the shell you run in, and tell them the
  variable's name.
- **Never echo it back**, not even truncated to a prefix. A prefix confirms which
  credential you hold and links the transcript to the account.
- The worker subprocess inherits the whole environment
  (`BaseCliAgent.js:944`), so it *can* read the token. The discipline is that it
  never needs to: the worker decides, the router sends.
- Assert the discipline instead of trusting it. A token-shaped regex over run
  artifacts (`[0-9]{8,}:[A-Za-z0-9_-]{30,}` for a Telegram-style token, adapted
  per issuer) belongs in the Tier 1 gate. It costs nothing and it is the only
  check that fails when a future edit reintroduces the leak.

## Anti-pattern: the failure this skill exists to prevent

`aiko/test.md` is a real transcript. Aiko read the right skill unprompted
(`test.md:30`), gave correct security advice (`test.md:37`), proposed the correct
unexpanded-variable form (`test.md:48`) — and then **verified the bot, offered a
multiple-choice menu, and wired nothing.**

What she actually ran, token redacted here as `<TOKEN>` (the real value is live,
compromised, and must be rotated — never copy it, never call the API with it):

```text
- Execute: python3 -c "… token='<TOKEN>'; url=f'https://api.telegram.org/bot{token}/getMe' …"
- Execute: curl -s --max-time 15 "https://api.telegram.org/bot<TOKEN>/getMe"
- Execute: curl -s --max-time 15 "https://api.telegram.org/bot<TOKEN>/getUpdates?limit=5&timeout=0"
```

Three subprocesses with the secret in argv (`test.md:77`, `:86`, `:88`) — shell
history and process listings, which no library redaction can reach. Then a menu
("say `A` or `B`", `test.md:60`), and the closing line:

> "Message the bot and say "polled" — I'll immediately show you your inbound
> event." (`test.md:131`)

That last sentence is the whole diagnosis. The user was being asked to hand-crank
the loop.

**What should have happened**, from the same starting point:

1. Say the pasted token is compromised; tell them to revoke it at BotFather now.
   Ask them to `export TELEGRAM_BOT_TOKEN=…` in the shell — never paste it back.
2. One `getMe`, with the variable unexpanded in the command text. Report the bot
   username. Stop.
3. Enumerate the surface and name the gaps out loud: text, documents, callbacks,
   webhooks and long-poll ingest exist; `sendPhoto`, `sendVideo`, `sendAudio`,
   `sendVoice` and `getFile` do not, and the typing indicator is not
   independently invocable.
4. Close those verbs inert in `packages/integrations/src/telegram/`, teach the
   fixture, add the components.
5. Declare the reply union.
6. Write `.smithers/workflows/telegram-aiko-bridge.tsx` — a `<Loop>` parked on
   `<OnMessage>`, `<SendChatAction>`, a `<Task agent={providers.aiko}>` with the
   typed output, and a router on `reply.kind` — plus the host process that
   actually starts the polling source, which nothing in the repo does today.
7. Run the hermetic gate, delete a router branch to prove it can go red, restore,
   re-run green. *Then* say it is connected.

The difference between the two lists is not effort. It is that the second one
ends with something the user can message tomorrow without you in the room.
