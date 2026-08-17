# Adding a native limb — the recipe Aiko actually obeys

> *No capability becomes default by compiling.* A limb earns admission as an inert package, its `SKILL.md` inside its digest, its gate refusing to pass without the feature working. That is the same refusal the whole harness is built on: refuse to claim something happened when it didn't.

**Worked example:** `neuron/limbs/product-forge` — business requirements (free-form text) → pinned product (PRD + IA + design tokens + CRUD) with no product/UX spec. See `Claude.md § Adding a native limb` for the 4-line version.

## 1) Create the package

```
neuron/limbs/<name>/
  neuron.json           — package, neurons[], caps, budgets, schemas
  SKILL.md              — name, description, probe_input, expect_contains + prose
  neurons/<neuron>.py   — pure stdin Stimulus -> stdout Decision/Rejection
  schemas/<schema>.v1.json (0..n)
  tests/conformance.py  — declarative check (optional, not the gate)
```

**manifest (`neuron.json`)**

```json
{
  "schema": "typed-neuron.limb-manifest/v1",
  "package": "typed-neuron/<name>",
  "version": "0.1.0",
  "description": "one sentence: what this limb is for",
  "neurons": [{
    "id": "<neuron>",
    "accepts": ["<input-schema>/v1"],
    "emits":   ["<output-schema>/v1"],
    "argv": ["python3", "neurons/<neuron>.py"],
    "caps_request": {
      "allow_write": true, "write_prefix": "artifact/<ns>/",
      "allow_send": false, "allow_spawn": false,
      "budget": { "max_effects": 8, "max_writes": 6, "max_bytes": 131072, "max_depth": 1 }
    }
  }],
  "budgets": { "deadline_ms_per_firing": 30000 },
  "schemas": { "request": "<input-schema>/v1", "result": "<output-schema>/v1" }
}
```

Rules: `write_prefix` scopes *exactly* what the limb may write. `max_writes` ≥ number of effect writes. `deadline_ms_per_firing` is the harness-enforced kill — a limb must still be pure and fast.

**`SKILL.md` — inside the digest**

```yaml
---
name: typed-neuron/<name>
description: One sentence a stranger could act on.
probe_input: {"schema":"neuron.stimulus/v1","firing_id":"probe-...","receptor_schema":"...","reads":[...],"permitted_reads":[...],"messages":[],"now_ms":0}
expect_contains: <a substring only correct behaviour yields>
---

# <name>

Prose the reader needs, not what a line does.
## Why the probe is what it is
...
## Gating
...
```

Three properties, all asserted by `neuron/tests/skill-doc-gate.sh`:

1. **Prose is inside `computePackageDigest`** (`neuron/src/limb_ops.zig`). Edit the body → new digest. The doc cannot drift from the code.
2. **Acceptance-free is refused** as `SkillDocUnfalsifiable` — same rule as `morphogenesis.CapabilityGap.parse` for gaps. The package must falsify something.
3. **The declaration reaches the ledger** — admission row carries `skill { expect_contains, ... }`, readable without re-reading a file that may have moved.

Pick an `expect_contains` a do-nothing handler *cannot* print: an artifact id, a derived count, a transformed value. `product-forge.prd/v1` qualifies; `OK` does not — that's the authored-gap bound in miniature.

## 2) Write the neuron (pure)

Contract: `Stimulus (JSON stdin) -> Decision | Rejection (JSON stdout)`.

```python
#!/usr/bin/env python3
import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "shared"))
from _neuron import Reject, artifact_ref, decision, run
#                     ^^^^^ two levels up from neurons/ is limbs/shared
#          `..` (one dot) -> limbs/<pkg>/shared (does not exist) — admission still green on macOS if you only test with interface attached; breaks on Linux/replay.

REQUEST = "my.request/v1"
RESULT  = "my.result/v1"

def fire(stim):
    if stim.get("receptor_schema") != REQUEST:
        raise Reject("validation", f"expects {REQUEST}")
    ref, req = artifact_ref(stim, REQUEST)
    # validate, classify, derive — all deterministic, all from `ref`
    ...
    return decision(
        control={"kind":"terminate","result":"done"},
        effects=[{"kind":"write","artifact":{"id":"artifact/<ns>/...","schema":RESULT,"bytes":json.dumps(body, sort_keys=True)}}],
        evidence=[{"claim":"...","sources":[ref["id"]],"method":"..."}],
        stim=stim,
    )
if __name__ == "__main__":
    sys.exit(run(fire))
```

**Quirks that have cost real time** — encode them, don't explain them away:

| Quirk | Why it bites | How the gate proves it |
|---|---|---|
| `_neuron` import is `../../shared` from `neurons/` | `..` resolves to `limbs/<pkg>/shared` (missing) — still passes an empty-substrate gate | `skill-doc-gate.sh` + `product-forge-gate.sh` fire through admitted path |
| `now_ms` is *inside* the firing identity (`cborRuntimeStimulus`) | Wall clock in stimulus → every redelivery is `FiringMismatch`, idempotent replay breaks | `agent_ops.zig` pins `now_ms=0`; bridge carries `seq` (commit ordinal), not clock |
| `set` / `hash()` in a producer | CPython randomises `str` hash per process — stable in one firing, divergent across two → invalidation loop never reaches fixpoint | Gate fires twice with different `PYTHONHASHSEED` and compares bytes |
| Uncited reads | `evidence[].sources` is how `telemetry stale` reconstructs the derivation graph; an uncited read is an invisible dependency | Every decision must non-empty cite `sources` in provenance set |
| `schemas/` opened without `.iterate` | `BADF` on Linux, invisible on macOS | `limb_ops.zig` fix checked on Linux |
| `build.zig` install step in dependency context | `dep.builder.getInstallStep()` compiles, binds, builds nothing — green but empty | Sub-builds driven as `b.addSystemCommand({"zig","build"})` with `setCwd` |
| `artifact("contract")` | libcontract publishes both `.a` and `.dylib` under that name → panic | Avoid `artifact("contract")` entirely |
| "observer must not classify what it cannot see" | `telemetry serve` never opens the substrate (live node keeps committing) so it must not derive `redrivable`/`crossed` from journal alone | Gate attaches an interface before classifying |

**Boundedness & gap-blindness.** A limb must never read its own `expect_contains` to decide what to produce (the authored-gap catalogue is a bounded search over gap-blind transforms; `channelVariants` is the parallel for input shapes). `product-forge` classifies on `brief.lower()` lexical keywords, not on the gap's acceptance — a gap that staples `"inventory"` into `expect_contains` still classifies by the brief.

## 3) Make it deterministic & grounded

- **Deterministic** on `artifact_ref` bytes only: `json.dumps(..., sort_keys=True)`, no clock, no LLM on the recompute path (models belong at edges: OCR, wording, summaries — never on re-derivation).
- **Grounded** — every decision's `evidence[].sources` lists the pinned read ids it folded. `telemetry stale` + `redrive` read that to invalidate.
- **Fail-closed** — bad input is a typed `Reject("validation", ...)` with zero effects, not a truncated success.
- **Budget is policy, not kernel** — declare it in `neuron.json`; the harness enforces it.

## 4) Wire the gate (the acceptance criterion)

Gates drive the **public CLI from an empty directory and assert against durable state** — never stdout resemblance. They are scheduled by `build.zig`'s `gate` step; `zig build gate` is "before trusting a build."

```sh
# neuron/tests/<name>-gate.sh
BIN="$repo/neuron/zig-out/bin/neuron"   # neuron/zig-out, not zig-out
LIMB="$repo/neuron/limbs/<name>"
root="$(mktemp -d)"; export HOME="$root"
$BIN agent init "$root/node" a1; state="$root/node/state"
# 1. prose in pin: edit SKILL.md prose -> digest changes
# 2. 0..n functional firings -> artifacts at <write_prefix>/$project/...
# 3. deterministic: same bytes, different firing_id -> byte-identical Decision
# 4. gap-blind: expect_contains cannot steer classification
# 5. fail-closed: bad input -> non-zero exit, zero artifacts
# 6. ledger: limb-admission carries skill{expect_contains}
```

Register in `build.zig`:

```zig
for ([_][]const u8{
    "neuron/tests/product-forge-gate.sh", // <— add here
}) |witness| {
    const g = b.addSystemCommand(&.{ "bash", witness });
    g.step.dependOn(b.getInstallStep());
    gate_step.dependOn(&g.step);
}
```

And mirror in `Claude.md`'s `<!-- root-gate-inventory:start -->` list — the self-check asserts the two lists agree. A gate that can pass without the feature working is not a gate; prove it by removing the feature.

## 5) Rebuild & prove

```sh
zig build                      # -> zig-out/bin/aiko + neuron/zig-out/bin/neuron + contract/libcontract/zig-out
zig build test                 # both layers' suites
zig build gate                 # all gates (witnesses)
bash neuron/tests/<name>-gate.sh      # solo
python3 neuron/limbs/<name>/tests/conformance.py  # solo (if present)
./zig-out/bin/aiko-doctor      # both layers link in one process
# Rust host (not in Zig build — would OOM on 16 GB):
aiko/scripts/contract-runtime.sh install  # -> ~/bin/aiko + ~/.aiko/lib/libcontract.*
```

Contract proof: `contract task begin "<goal>" --check "<gate command>"` then `contract task verify <id>` — compile passes are not runtime proof.

## Prior art actually reused (as bounded code, not deps)

| Borrowed heuristic | Source (installs) | How it was rebuilt |
|---|---|---|
| Archetype→palette/type/signature chooser | `nextlevelbuilder/ui-ux-pro-max` (318K) | Lexical `ARCHETYPES` over `brief.lower()` |
| PRD shape (problem/goals/functional/acceptance) | `mattpocock/to-prd` (364K) | Deterministic `forge_body` with `sort_keys` |
| Frontend token/radii anti-default | `anthropics/frontend-design` (783K) + local `design-taste-frontend` | Fixed `palette` + `type` + `radii` per archetype |
| Idea→requirements interview before build | `obra/superpowers@brainstorming` (327K) | `question→delete` before `simplify` (algorithm §5) |

Copy the decision logic into `SKILL.md`+code; do not `npx skills add` them as runtime deps — the limb must stay native, bounded, and gap-blind.

## Where the doctrine lives when you forget

- Normative architecture: `neuron/AGENTS.md` (Part I) — read the section, not the file.
- What's actually built: `neuron/IMPLEMENTATION.md`, `neuron/reference/ROADMAP.md` (unsettled only).
- Substrate doctrine: `contract/DOCTRINE.md`, `contract/docs/AGENCY-SUBSTRATE.md`.
- Published-tree inventory: `docs/SOURCE-OF-TRUTH.md` (+ `build.zig`).
- Never-publish subtree: `contract/NEVER-PUBLISH.md`.
- Convergence reasoning: `archive/plans/PLAN-aiko-convergence.md` (historical, not a worklist).
