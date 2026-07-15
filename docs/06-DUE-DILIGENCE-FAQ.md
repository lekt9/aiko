# 06 · Due-diligence FAQ

> Confidential DD dossier. Direct answers to the questions raised in the
> second-round diligence conversation. Cross-references point to the fuller
> treatment. Honest status tags throughout.

### Q1 · What are you actually building? What's the core product and problem?

**Product:** Aiko — a local agent that does the things you'd do on your laptop, so
you don't have to (triage your Telegram in your voice; find a restaurant and book
the table; *if you can do it on your laptop, ask Aiko*). **Problem:** existing
agentic tools for computer use are unreliable, expensive, and privacy-hostile —
brilliant generalists with no memory of what worked here and no structure forcing
rigor. **Core insight:** instead of "unbrowsing" the *internet* (the original
Unbrowse), Aiko "unbrowses" the *context of your own computer* — building reflexes
that call the right binary at the right time, from an agent that actually
understands you. See `01-PRODUCT-aiko.md`.

### Q2 · Who is the core customer?

Anyone who wants a **personal agent that truly understands their context** — the
current ChatGPT/Claude/Claude-Code user who tried an open agentic tool and found
it unusable. Aiko is a **better open agent for computer use.** See `01`.

### Q3 · How is this different from what frontier labs ship?

Frontier labs are **parametric-LLM-centric** — intelligence ∝ params × data ×
compute, static, and *your data trains their model*. Aiko is **harness-centric**:
intelligence ∝ index-coverage × collective-history × routing/verification, live
and local, and *your data stays yours*. Very few players take **energy-based
models** seriously because the naive version needs a data-center to "simulate
reality." The breakthrough is **breaking the EBM into fractal atoms** — not one
giant EBM, but many tiny ones, each wrapping a route from first principles — which
makes it cheap and local. See `02-ARCHITECTURE`, foundation THESIS.

### Q4 · Are people using it today?

The **founder uses it daily; it is not publicly released.** Two honest reasons:
the energy-based design is power-hungry and is being contained (R5), and the
on-chain layer is being hardened. Zero external users today — pre-launch by
choice, not for lack of a working build. See `04-PROOF-traction.md`, `05-RISK`.

### Q5 · When did you pivot from the browser approach?

**Partial, recent pivot (~2–3 months), not complete.** Unbrowse originally built a
*commons for agents to browse the internet*. As agents/AI improved, they learned
to browse anyway — diminishing returns on a route-commons. Inverting the idea —
point the same route-engineering at *your computer* instead of the web — is Aiko,
started for the Colosseum hackathon. Unbrowse still exists; the two are sister
projects (R12). See `00-README`.

### Q6 · If the EBM approach works, why wouldn't OpenAI/Anthropic copy it?

**They would — it's copyable.** The moat is **not the algorithm; it's the
ledger + distribution.** No one in AI has a distributed ledger the size of Solana
to hold all the weights, plus wallet-level distribution. Win the storage substrate
and the network of corroborated weights before the technique is commoditized.
**Honest:** this is a *race*, not a technical lock (R7). See `03-ONCHAIN`.

### Q7 · How close are you to containing the energy usage?

Founder estimate: **~95% — the remaining work is stability, not invention.** In
principle it can run fully on-chain and even remotely (not on your machine),
because the design lets you push data on-chain by paying some SOL. **Honest
status:** the on-chain offload is **DESIGNED and partially proven** (real reads,
real vault, anchoring primitives) but the full "weights on-chain, laptop is a
frecency cache" loop is not yet running at scale (R5). See `03`.

### Q8 · How do you measure whether it's working?

The falsifiable atom: **does energy-ranked resolution beat scan-order at choosing
what fires next?** — **yes, measured: 2 passes vs 3, mutation-verified**
(`04-PROOF`). At the capability level, **ARC-AGI-3**: an earlier version reached a
high score **without any large model** — the harness carried the reasoning.
**Founder-reported, awaiting independent replication** (request the score, split,
and a reproducible invocation).

### Q9 · The one-shot game build — did you pre-train it? How did it learn?

**No task-specific pre-training.** At that time it was **harness + Opus** (the
model as reasoner *inside* the harness), which **rebuilt a Wine layer to run
Overwatch on a Mac in one shot.** It works by forcing the model to think in **first
principles** — decompose the route/travel problem layer by layer, locate where the
failure actually is, and fix it — made mechanical and instinctive by default,
rather than free-associating. See `01`, `04`.

### Q10 · Is this more a harness than a model? Is the harness the EBM?

**Yes — it's primarily a harness, and the harness *is* the energy-based model.**
The EBM is the **recommendation/routing system** that learns which action to fire
from collective history (BUILT+PROVEN). *Separately*, a **small non-parametric
reasoning model** is in training — kept as small as possible so it's local, and
made powerful by being **grounded** by the harness (retrieval + energy routing)
rather than by parameter count. A small grounded model beats a same-size ungrounded
one. See `02-ARCHITECTURE §6`.

### Q11 · What's the next step if it works?

Beyond automating enormous amounts of work, the founder's stated end-vision is to
**accelerate the creative process** and eventually **define a new currency** — one
that rewards *value created / novelty*, not value-of-work. **Honest:** this is an
early, unformed aspiration with real regulatory surface (R10) and should be
de-scoped from the near-term investment thesis; the near-term is: contain the
energy, ship to first users, prove the collective with more than one agent.

### Q12 · What can we diligence right now?

- **This dossier** (00–06) — product, architecture grounded in real code,
  economics, on-chain/privacy, proof, and this FAQ.
- **The code** — the `arc-lean` tree; run `bash scripts/build.sh` (unit tests + 53
  parity claims + signed attestation) to verify the **PROVEN** claims yourself.
- **The best next artifacts to request:** a recorded (Loom) demo of the harness
  one-shotting a fresh computer-use task, and the ARC-AGI-3 run with its exact
  numbers and a reproducible command.

---

**Bottom line for the panel:** the hard, cheap-to-test atom is proven (the router
routes better than chance); the grand claim (reasoning-grade collective
intelligence) is a named, ordered bet; the moat is a race to own a commons; and
every seam is labelled in `05-RISK-honest-wall.md`. This is a research-risk
investment with an unusually disciplined honesty culture and a working, demonstrated
harness — underwrite the founder and the falsifiable next gate, not the destination.
