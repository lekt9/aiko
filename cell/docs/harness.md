# Harness — how this repo follows harness-engineering

> Harness = operating system for agents. Model is CPU, context is RAM, harness is OS. Start simple, add only when needed, build for deletion.

This file maps that doctrine onto `cell`.

## Layers (what this repo has)

| Layer | In this repo | Notes |
|---|---|---|
| Project setup | `AGENTS.md` (router) + `docs/` (system of record) | AGENTS points, docs holds — 50–200 lines vs focused docs |
| Context | Progressive disclosure: AGENTS -> docs/ -> SPEC.md -> system/neurons/DESIGN_NOTES | See `docs/context.md` |
| Constraints | Schema validation, DAG cycle refusal, HTTP host allowlist; other caps are declaration/audit only | See `docs/constraints.md` |
| Eval & feedback | `python run.py check` + `tests/` + fixture-driven cases | See `tests/README.md` |
| Primitives | `primitives/session·auth·request·cas` (frozen membranes) | `primitives/README.md` + `patterns/api-reveng/` + `out/manifest.json` (merkle) |
| Patterns | `patterns/prompt·context·loop·graph` (examples, not spec) | `patterns/README.md` + `SPEC.md §6` |
| Loop | `patterns/loop-cell/` — `python` loop inside a leaf (no spec syntax) | Bounded `for` in `neurons/iterate.py` |
| Graph | `wiring:` + typed `schemas/` + `reduce`/`router`/`approval` | `patterns/graph-cell/` |
| Long-running | `run.py` treats Kahn frontiers as topological readiness and fires them serially in lexical order, with work dirs per leaf | DAG + typed ports give handoff; Only a mechanically confined and witnessed kind may ever parallelize; Python/exec caps are audit metadata |
| Evidence | `patterns/confirm/` (encouraged confirmation cell) | `patterns/api-reveng/confirm.cell.yaml` |
| Redrive | `system/redrive.cell.yaml` (organelle, not spec) | manifests + prior -> stale vs ALREADY_SENT |
| Reactive | `patterns/reactive-cell/` (merkle diff → redrive) | Manifest identifies changes, organelle reacts — not spec |
| Memory | Git history + distilled `skills/` (shared cells) + `.cell-cas/` (CAS) | Skills amortize exploration |


## How we apply the workflow

1. **Assess** — python-native DAG that composes programs (exec/python/http) + fixed primitives (session/auth/request), fractal, minimal.
2. **Setup** — `AGENTS.md` + `docs/` + `primitives/` + `patterns/` + `system/` + `example/` + `schemas/` + `skills/`.
3. **Context** — see `docs/context.md`.
4. **Constraints** — see `docs/constraints.md`.
5. **Eval** — `python run.py check <root> --inputs <json>` is the gate. Add a gate per mistake.

---

## Audit against `harness-creator` (2026-08-19)

Scored with `walkinglabs/learn-harness-engineering@harness-creator`
(`node ~/.claude/skills/harness-creator/scripts/validate-harness.mjs --target .`),
run from the repository root. **32/100, bottleneck `state`.**

Read it with one correction: the validator scores by *filename* — it looks for
`feature_list.json`, `progress.md`, `init.sh`, `session-handoff.md`. This repo
answers several of those subsystems in a different shape (gates, the engine's
SQLite firing store, `CLAUDE.md`), so part of the deficit is naming, not absence.

What survives that correction, and what it changed here:

| Subsystem | Score | Honest reading |
|---|---|---|
| verification | 3/5 | It found the test and build commands and the recorded evidence. The gap it names — no single entrypoint — is real but cheap. |
| scope | 1/5 | **Real.** Nothing declared what a unit of work was allowed to touch. Closed at the cell layer by `policy.writes` (SPEC §7.1); still open at the repo layer. |
| state | 1/5 | **Real, and the bottleneck.** There is no machine-readable answer to "what is in flight, what is done, what is next" — every session rebuilds it from `git log` and this file. Any fix must be *derived* from gates and git, not hand-maintained prose: a hand-written status file is a declaration outside the digest, and this repo already knows how those end. |
| instructions | 2/5 | `CLAUDE.md` exists and is strong on doctrine; it does not state a startup path or a definition of done in the form a fresh agent can follow mechanically. |
| lifecycle | 1/5 | Mostly filename matching. |

The skill's five-subsystem model independently arrived at the same two fields
this repo added to the cell spec on the same day — verification is `witness`,
scope is `writes`. That agreement is why the audit is recorded rather than
dismissed.

**Note on the word.** `harness-creator` means *harness* as agent-reliability
scaffolding for a repository. `spec.harness` in SPEC §7.2 means the adapter that
connects an agent node to an external system. Same word, two different things —
do not wire one expecting the other.

## codegraff as an agent inside the graph

[`justrach/codegraff`](https://github.com/justrach/codegraff) (`graff`) is a Zig
agentic coding harness — multi-provider models, MCP over stdio and Streamable
HTTP, sub-agents, a one-shot `-p` mode, and `--json` for structured stdio.

It is wired here as `cell/primitives/graff-agent.cell.yaml`: an agent node whose
reach into a target system runs through an MCP server registered with graff, and
whose attachment the engine verifies before the node fires (SPEC §7.2, §7.3).
`graff --schema` is what makes this derivable rather than asserted — a boundary
that publishes its own interface is one a harness can be built against.

Two things not to confuse:

* **`justrach/codedb`** is a *different* tool by the same author — a code
  intelligence MCP server, 1.4K★, blogged on the same `codegraff.com` domain.
  It is installed on this machine and its hooks are active in this repo; its
  MCP server is deliberately disabled in `~/.claude.json` (the `~/bin/codedb`
  shim refuses `mcp` by default after an FD leak caused `ENFILE`, unless
  `CODEDB_ALLOW_MCP=1`). The CLI works: `codedb search "<text>"`.
* **`harness-creator`** means harness as *agent-reliability scaffolding*.
  `spec.harness` means the *adapter to an external system*. Same word.
