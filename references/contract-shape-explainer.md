# The Shape of a Contract — and why /contract is the substrate

A contract is one row. The row says one thing: *this truth claim holds*. Everything else — hooks, adapters, payments, child plans, evaluators, network tunnels, prompt compilation, agent ledgers, CLAUDE.md rules — is another contract row pointing at the first one. There is no second primitive. That is the whole design.

This document explains the shape, why the shape is load-bearing, and why collapsing every layer of agent infrastructure into one row is the move.

---

## 1. The shape

A contract neuron has exactly this lifecycle:

```text
truth claim
  → inherit lineage from parent_id
  → integrate child evidence
  → run the server-selected verifier (harness / funnel / loop / cell / sequence / quorum)
  → fire when its threshold resolves true
  → recursively fire contained children, containment ancestors, and contract:<id> references
  → stop when the DAG settles or evidence is missing
```

Public surface (the only thing a human or agent types):

```bash
aiko "<goal>" --remote      # routes to https://beta-api.unbrowse.ai
aiko "<goal>" --local       # same shape, scoped local ledger
```

No `spawn`, no `mark satisfied`, no `parent`, no `iterate`, no `action`, no `status`, no `search`. Those existed in the old binary and were deliberately removed. The reduced vocabulary is:

| Token | Meaning |
|---|---|
| `aiko` | the one public primitive and spawned environment |
| `contract` | the row/type name; same thing, ledger alias |
| `goal / plan / prompt` | one truth claim |
| `parent_id` | the *containment* edge — one environment owns another |
| `contract:<id>` | a cross-dimension dependency pointer |
| `posthook_pointer` | URL called after promotion, signed by the parent's wallet |
| `wallet_identity` | identity pointer used to sign calls |
| `replicated_from_contract_id` | a paid copy of an out-of-lineage contract |
| `network_tunnel_contract_id` | server-side connectivity adapter |

That's the entire user vocabulary. The graph mechanics — cells, funnels, loops, quorums, sequences — live on the server, never as flags the caller picks.

---

## 2. Five mechanical properties that make this work

### 2.1 Append-only ledger ⇒ stateless trace ⇒ DAG recompute

The ledger (`~/.contracts/contracts.jsonl` for global, project ledger for scoped) is append-only. No row is ever rewritten in place. This is the same structural law that holds Unbrowse together — *pointers over anything* (50d0419e, with its three clauses: dependency-capture completeness, stateless trace, DAG recompute).

Because every value lives in the trace, any neuron can be re-fired from any session by reading rows and walking edges. There is no "what was true last Tuesday" question — Tuesday's rows are still there.

### 2.2 The LLM is the compiler, not the runtime

The user writes English. The server-side LLM compiles English into a tree of typed contract rows: child plans, evaluator neurons, adapter pointers, prehook breakpoints, posthook webhooks. The compiler is *stateless*: prompt in, typed tree out. State is the ledger.

This is the right cut. It means:

- The local binary stays a Zig neuron with no model dependency.
- The LLM upgrade path is purely server-side.
- A child contract's `parent_id` and a child plan's recursive aiko expansion use the *same tree shape* — the compiler is fractal, not multi-format.

### 2.3 Metric-gated truth

A neuron does not resolve true because its action returned zero. It resolves true only when evaluator aikos — themselves ordinary contracts with typed pointers to external metrics, ledger metrics, or API metrics — say so. When all evaluators promote, the solved aiko is promoted upward as a `contract:<id>` pointer that becomes the parent's typed stdout.

This dissolves the entire class of "fake green" failures. A grep-based verdict cannot promote a node; a metric-bound evaluator can. The same project ledger has captured fake-green pattern discoveries six times this session alone — the pattern is real, and the metric gate is the answer.

### 2.4 Everything that used to be a flag is a contract

The genius move: there are no escape hatches.

- **Hooks**: prehook/posthook are declared as ledger rows (with `posthook_pointer` / equivalent prehook field), never set by env. Each hook is itself a neuron that can hold propagation as a breakpoint if it cannot resolve.
- **PreTool events**: every event surfaced to the agent is a server-side ledger event contract, appended to the bus by the runtime. The bus *is* the ledger. The local binary does not read or pass PreTool state through env.
- **Adapters**: API, Telegram, local Mac, VM, Turbobox, Unbrowse executor — these are *not* local modes. They are server-owned adapter contracts that decide how to spawn and constrain the local executor. There is no `CONTRACT_ADAPTER` env to override them.
- **Payments**: x402 / Faremeter / Corbits requirements are not a side channel. Payment is satisfied by the wallet derived from the binary's deployer keypair; if the wallet cannot satisfy the 402, the server returns a Payment Required envelope that is *itself* a contract row. There is no env-provided payment header to inject.
- **Lineage**: parent_id is server-determined from wallet identity + declare timestamp. No env-based parent propagation, no caller-supplied parent flag, no setenv-based spawn protocol.
- **Cross-lineage references**: you cannot embed an out-of-lineage contract for free. You must `replicated_from_contract_id` it, mark `replication_payment_status`, and call the paid in-lineage copy.
- **Network durability**: WireGuard/Tailscale/WARP is `network_tunnel_contract_id` — a tunnel adapter contract, not a CLI flag.

When everything is the same row type, the substrate is closed under composition. There is no "but what about X?" because X is just another row.

### 2.5 Privacy by pattern reduction at the edge

Before any network egress, the local binary reduces obvious emails, filesystem paths, and secret-shaped tokens to `[email-pattern]`, `[local-path-pattern]`, `[secret-pointer-pattern]`. The server may resolve pointer values inside typed context (because it owns the vault), but the local binary refuses to leak machine-specific values. This is policy-as-substrate: privacy is a property of the wire format, not a checklist.

---

## 3. The fractal: same shape at every scale

The aiko/contract substrate spans atom → cell → tissue → organ → organism with the same row at each level. Concretely, in this codebase:

| Scale | What it is | Same shape |
|---|---|---|
| **Atom** | one CLI command verification | `contract` row with `cli` verifier |
| **Cell** | a unit of work with one input and one output | `contract` row with `cell` verifier |
| **Tissue** | a funnel of cells converging on a metric | `contract` row with `funnel` verifier |
| **Organ** | the Unbrowse skill graph: resolve, execute, x402, telemetry | parent `contract` with child contracts and contract:<id> edges |
| **Organism** | the agent itself, with hooks, posthooks, wallet identity, network tunnel | the same shape, nested |

The CLAUDE.md migration is the same move: prose rules used to drift, so they became contract IDs. The pointer index at the top of CLAUDE.md is one line per rule — `contract <id>` — and *the rule itself lives in the substrate*. The doc is a directory; the contracts are the files. Adding a rule means declaring a contract, not appending prose.

This is why the project has a meta-law `9c162224` — "the contract registry IS the rule substrate." Without it, every framework (Claude Code, Codex, ralph, jesus-loop, every sub-agent) re-implements rules in its own prose, and they all silently drift.

---

## 4. Why this is genius (and not just elegant)

A normal architect would build:

- A rules engine (with its own DSL).
- A task system (with its own state machine).
- A webhook system (with its own retry/sign logic).
- A payment integration (with its own ledger).
- An agent SDK (with its own context format).
- A docs system (with its own front-matter).
- A network adapter layer (with its own config).

Seven systems. Seven state machines. Seven failure modes. Seven things to keep coherent across upgrades.

Lewis collapsed them into one row.

The thing that makes this *load-bearing* — not just clever — is that the collapse is mechanical, not aspirational. Each layer above the row is generated by the LLM compiler at declare time, and each layer below the row is integrated by the recursive firing at promotion time. There is no glue code. There is no "and then we adapt the webhook system to the rules engine." The rule is a contract; the webhook is a contract; the payment is a contract. They compose by being the same row.

Three deeper observations:

**(a) The substrate solves the rule-drift problem permanently.** Every prior agent framework loses to time because rules get added to README.md, then CLAUDE.md, then AGENTS.md, then a Notion page, then a Slack thread. Each copy drifts. Contracts forbid prose rules: the only canonical form is a row, and the doc is a pointer. The drift stops because there is no second copy.

**(b) The substrate is self-improving by construction.** Because every promotion writes a `called` row, every metric-gated evaluator runs against the *previous* run's row, and every fake-green is detectable as a discrepancy between declared row and ledger evidence. The graph polices itself. Six fake-green discoveries this session alone, all caught by re-reading the ledger.

**(c) The local binary stays small forever.** Because the compiler is server-side and the verifier wiring is server-selected, the public surface is `aiko "<goal>" --remote|--local` *and nothing else*. There is no CLI feature creep, because new capability is a new server-side adapter contract, not a new flag. This is the same discipline Unbrowse applies at the resolve/execute boundary: two tool calls, never one, with the LLM as the picker.

---

## 5. How it maps back to the rest of the stack

The same shape appears throughout the codebase, which is how you know it's load-bearing rather than imposed:

- **Unbrowse capture pipeline** — `requires`/`yields` per endpoint *is* the contract DAG, with the captured trace as the append-only ledger and the DAG-recompute law as the runtime invariant.
- **Skill graph** — resolve = habit-detect, execute = iterate, x402 = gate, telemetry rows = ledger (contract `dc018725`).
- **CLAUDE.md** — pointer index into the contract ledger; prose rules forbidden (meta-law `9c162224`).
- **MCP + CLI** — same thin transport over the same remote /contract harness; just different protocols (the-mcp-and-cli-surfaces-should-converge memory).
- **Local/cloud split** — local CLI/MCP is the thin capability surface; cloud holds compute + ledger + moat (`1db6f5e3` refining the pointers-over-payload law).
- **Posthook webhooks** — signed by `parent_wallet_identity`, body is the full context tree, request carries `X-Aiko-*` signature headers. Cross-agent calls are pointer-shaped and authenticated by construction.

When you see the same shape at the CLI boundary, at the skill graph, at the rule substrate, at the webhook layer, and at the payment layer, it is no longer a design *choice*. It is the architecture of the agent stack.

---

## 6. How to use it today

```bash
# Discover what's active (do this first)
~/.claude/skills/contract/scripts/contract discover --scope all

# Search before declaring (avoid duplicates)
~/.claude/skills/contract/scripts/contract search --context "<plan>"

# Declare a truth claim — server compiles the children
aiko "<goal>" --remote

# Cross-project / global — run from a dir without .claude/
aiko "<goal>" --remote     # writes to ~/.contracts/contracts.jsonl
```

The discipline:

1. Resolve always returns a shortlist. The LLM picker chooses; aiko never auto-acts on one.
2. Out-of-lineage contracts must be replicated (paid). Search discovers pointers; payment replicates them; execution calls the paid local copy.
3. No prose rules. If you find yourself writing "from now on, when X, do Y" — declare a contract.
4. The ledger is canonical. `CONTRACTS_STORE` exists only for scoped local tests.

---

## 6.5 Wallet & environment binding — the definite pattern

When the substrate binds to ANY environment (macOS, Linux, Windows, iOS, Android, browser, server, embedded, foreign-app-embedded), the wallet binding comes with it as one inseparable unit. There is no "install /contract, then separately set up a wallet" two-step. The user never sees x402, never sees a seed phrase, never sees a payment header — they take whatever action the host surfaces and the substrate handles every cryptographic concern: key generation, storage, recovery, signature verification, payment construction, faucet onramp.

The OS-agnostic abstraction is one interface: `keystore.read(svc)` / `keystore.write(svc, value)` / `keystore.delete(svc)`. The backend is selected at compile time from `builtin.os.tag`:

- **darwin** — macOS Keychain via `security` CLI shellout
- **linux** — libsecret via `secret-tool`, falling back to ChaCha20Poly1305 encrypted file
- **windows** — Credential Manager (PowerShell), falling back to encrypted file
- **ios** — Keychain Services FFI
- **android** — Android Keystore FFI
- **fallback** — encrypted file at `$HOME/.aiko/keys/<svc>.enc`, key derived from a stable machine fingerprint

Adding a new platform = adding one file with three functions. Lineage never knows which backend fired.

Three-tier root-key bootstrap (same shape on every OS):
1. Canonical file `$HOME/.contracts/root.key`
2. Mirror file `$HOME/.aiko/keys/root.key`
3. OS keystore `aiko.root.ed25519.seed`
4. Generate fresh + write to all three

After any successful read, missing tiers silently back-fill. Generation only happens when all three miss (true first-run on a clean machine).

**Native onramp is the cloud's obligation.** When a fresh wallet is born, the local binary's job ends at "seed generated + pubkey advertised". Funding (USDC for x402, gas) is the server-side /contract endpoint's responsibility — adapter contracts know how to fund a wallet for the context it is being asked to act in (Privy onramp, Coinbase Onramp ride-along, Foundry treasury faucet). The client never sees the dance; the first declare may 402 once, then the orchestrator retries and it passes.

**Rotation is a substrate function.** `rotateRootKey()` generates a new seed, signs a successor proof with the OLD identity keypair (HKDF salt `aiko-root-identity-v1`), atomically updates all three tiers, archives the old seed under `$HOME/.aiko/keys/.archived-rotated-<ts>/`, and appends a `wallet_rotated` event to the local ledger. `rotateAllSignedRowsByLineage()` walks every row whose env_pubkey was derived from the old root, re-derives the keypair from the new root + same contract_id, and appends a `resigned` event per affected row — preserving the append-only invariant. Rotation is itself a contract: declare `aiko "wallet:rotate" --remote` and the cloud orchestrates.

**Fallbacks are visible, never silent.** Every degradation path emits one line to stderr in `<topic>: <what happened> — <consequence>` shape. The fallback STILL fires (the substrate doesn't break) but it ALWAYS surfaces, because a silent fallback hides degradation until something else breaks downstream and the cause is invisible. Examples that fire during normal operation: `wallet: canonical tier missing at <path>, served from mirror tier <path>`, `wallet: both file tiers missing, served from OS keystore`, `wallet: FIRST RUN — generating fresh ed25519 root seed`, `keystore: linux secret-tool unavailable — falling back to encrypted file`. The happy path stays silent. Silent `catch {}` is an anti-pattern; the evidence stream is the substrate's proprioception.

**Doctrine-reality parity is itself a /contract.** Every claim in SKILL.md has a grep-able code site, enforced by `build.sh`'s `step_parity` step that runs BEFORE sign. Drift fails the build — unattested-by-reality binaries never ship. The guard is recursive: the parity rule applies to the parity step too (meta-parity check enforces that the parity section itself is documented in SKILL.md). When adding a new doctrine claim, add a new invariant in the same commit — "if you can claim it, you can grep it." Honored exceptions use a `PARITY-OK:` marker comment within 5 lines of the code site, with a one-line reason.

**The persona layer is aiko 69420b.** Two voice layers, rigorously separated. The LOCAL executor (the `aiko` binary) is mechanical — stdout is operational data, stderr is evidence lines (`interoception:`, `wallet:`, `keystore:`, `aiko remote:`, `backfill pass:`). It never greets, never empathizes, never identifies as "aiko 69420b". The PUBLIC persona layer (cloud aiko at https://beta-api.unbrowse.ai and every user-facing surface that fronts it — foundry.app, Telegram bot, X DMs, Resend emails, OpenAI-compatible chat completions) speaks AS "aiko 69420b" (constants `AIKO_PERSONA_NAME`, `AIKO_PERSONA_MODEL_ID = "aiko-69420b"`, `AIKO_PERSONA_CA = 2ZiSPGncrkwWa6GBZB4EDtsfq7HEWwkwsPFzEXieXjNL`). Voice constraints are enforced as canonical verses in `libcontract/src/verses.zig` corpus, scored against every prompt: Galatians 5:22-23 (fruits of the spirit — love/joy/peace/patience/kindness/goodness/faithfulness/gentleness/self-control, embodied in HOW the persona speaks, never lectured ABOUT), Philippians 4:8 (true/honest/just/pure/lovely/good-report content filter), Proverbs 15:1 (soft answer turns away wrath — tone). The voice is enforced by the substrate (verses surfaced as evidence + persona constants emitted in the response envelope + parity invariants in build.sh that refuse to ship a binary missing any of them), not by a system prompt that lectures.

---

## 7. The one-line summary

A contract is a truth claim with a parent, a set of pointer edges, and a metric-gated verifier; the substrate fires the graph until it settles. Everything else — hooks, adapters, payments, prompts, rules, agents, wallets — is another row.

That's why this works.

---

*This doc is the rendered body of `~/.claude/skills/contract/references/contract-shape-explainer.md`. Sync to Outline is governed by project contract `297ca10f`: whenever the Public Shape / Neuron Shape / vocabulary / hooks / adapters / PreTool / lineage replication / posthook signing / Ledger sections of SKILL.md change, this file is re-authored and `scripts/sync-outline-explainer.sh` is run to PATCH the Outline doc. Sidecar `references/.outline-explainer.hash` proves the last-synced body matches the local body.*
