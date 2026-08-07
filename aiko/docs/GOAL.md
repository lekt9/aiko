# Aiko's goal — zero setup, one shot, nothing to install

This is the north star. It is short on purpose: every feature, and every
decision about scope, is judged against it. When two designs are in tension, the
one that removes a setup step from the user wins.

## The one sentence

**You describe what you want, in one prompt, and it happens — with nothing to
configure and nothing to bolt on first.**

## What that means, concretely

### Zero setup — "everything just works"
Opening Aiko is enough. It stands up its own runtime, adopts or starts whatever
it needs (databases, the local agent runtime, the proxy), and **degrades
honestly** when a piece is missing instead of blocking on it. There is no config
file to edit before first use, no API key to paste, no side service to run. The
first-run experience is: it opens, and it is ready.

The mechanical backstop for this is the harness's core refusal — *never claim
something happened when it didn't*. "Just works" is not a slogan; it is the
system making "done" checkable so that re-checking, re-configuring, and
babysitting stop being rational.

### One-shot prompts — a task is a sentence, not a session
You state the goal once and Aiko carries it through — plan, act, verify — without
a wizard, a scaffold, or a second round of setup questions. A prompt is the whole
interface. Multi-step configuration to *begin* a task is a failure of this goal,
not a feature.

### Internal tooling — not a plugin bag
Aiko's capabilities are **native**. The user does **not** install a skill or
stand up an MCP server to grant a new power — that ceremony is exactly what this
product refuses. Tooling ships inside the agent and is available on first run.

> Internally, Aiko is still built from skill-shaped packages and can speak MCP —
> that is how the harness stays honest and composable. The goal is about the
> **user** never having to install, register, or assemble any of it. Native to
> the agent; invisible to the person.

### Integration is Unbrowse — not bespoke wiring
When Aiko needs to reach into another system, site, or workflow, it acts through
**[Unbrowse](https://github.com/Unbrowse)** — the action engine of the internet —
rather than a hand-written per-service integration or a connector the user must
install and authorize. Unbrowse captures and replays real routes, so one
mechanism reaches everything, and adding a new destination is not a new install.

## How the goal decides scope

Use this as the gate on any proposed change:

| A change is **aligned** when it… | A change is **against the goal** when it… |
|---|---|
| removes a setup step | adds a step the user must perform first |
| makes a task a single prompt | requires a wizard or multi-turn config to start |
| ships a capability natively | asks the user to install a skill or MCP |
| reaches a new system via Unbrowse | writes a bespoke connector the user must wire |
| degrades honestly when something is absent | blocks with a checklist until configured |

The test for any feature is one question: **does it move Aiko toward *prompt in,
result out, nothing installed* — or does it add a step the user has to perform
first?** If it adds a step, it is working against the goal, however useful it
seems in isolation.

## How this goal is enforced — a reactive gate

This goal is not just prose; it is a **runnable, falsifiable witness**, the same
way every other claim in this repo is made checkable. "Everything just works" is
honest only because the system refuses to claim something happened when it
didn't — and that refusal is pointed at the north star itself:

- **The gate:** [`scripts/goal-gate.sh`](../scripts/goal-gate.sh) exits 0 only
  when the four pillars are stated here, linked from the surfaces that steer work
  (README, docs map, AGENTS.md, desktop README) with every link resolving, **and**
  the product still leans the way the goal says (the desktop app stands up its own
  stack and bundles the runtime; the CLI takes a one-shot prompt). Break a pillar,
  drop a link, or make the user path require an install, and the matching check
  goes red.
- **Reactive:** [`scripts/install-goal-hook.sh`](../scripts/install-goal-hook.sh)
  installs a git pre-commit hook that re-fires the gate **only when the files it
  is derived from change** — the runtime's own invalidation loop (a node re-fires
  when the thing it was derived from moves), applied to the goal. A commit that
  quietly adds a setup step goes red before it lands; a commit that touches
  nothing goal-related stays quiet. Bypass a single commit with
  `git commit --no-verify`.

So the goal is not a poster on the wall. It is wired into the tree: it re-checks
itself whenever the product or its docs move.

## What this is *not*
- Not a claim that the *developer* build is zero-setup — building the harness from
  source needs a real toolchain (see the repo README). The goal is about the
  **user** path: open it, prompt it, done.
- Not "no skills and no MCP anywhere" — those exist inside the system. It is "the
  user never installs or assembles them."
