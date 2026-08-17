# Aiko Drop-In — Repo Primitive Reuse Map

**Goal:** every human `observe → decide → effect` breakpoint re-wires through primitives that already exist and already have gates. Nothing new invented until reuse is proven exhausted.

**Pilot:** Hoysan PSA prime-mover deployment (`/Users/lewis/Downloads/hoysan`) — 51 DAY + 15 NIGHT + 32 NTS workers, 5-consecutive-day fence, level to 40 (contract 42 vs WA 40), `X`=off-day, blue=flaky backup pool, paper master = fence ground truth, pre-shift cascade 5:00→5:30→call→NTS, LD $60 vs last-minute, roster-must-refuse on infeasible.

---

## 1. Inventory: what the repo already ships (with gates)

### Cell primitives (frozen membranes, `cell/primitives/*.cell.yaml`)
| Primitive | Membrane | Gate / Use | Drop-In reuse |
|---|---|---|---|
| `session` | `base_url+headers? → session` | holds cookies/headers | GSheets / Forms API capture for B1 |
| `auth` | `session+credentials → session` | fail-closed login | PSA email + Google OIDC for Sheets |
| `account-handle` | `account → handle+session` | refuses raw token/api_key/password; emits `cred:tenant/origin/account` | **Employee seat itself** — the spawned child Aiko's identity; Hoysan foreman handle, not raw WA token |
| `request` | `session+method+url → response` | respects `allow_net` | fetch Form responses, Sheets cell reads, WA send |
| `cas` | `data → key+deduped` | `.cell-cas/` SHA256 | dedup 100KB roster Excels, large screenshots |
| `fal-generate` / `fal-status` | — | mock if no key | NOT for Hoysan (video) — ignore |
| `indexer` | — | — | roster index for retrieval |

### Cell patterns (composable wiring, `cell/patterns/*`)
| Pattern | What | Drop-In reuse |
|---|---|---|
| `fde/self-wire` | `account-handle → deploy-workflow → deploy-aiko` = "Aiko seats Aiko" | **Direct parent of drop-in.** Hoysan: `account-handle` (foreman) → `deploy-workflow` (roster engine digest) → `deploy-aiko` (spawn child to operate that shift). |
| `fde/deploy-workflow` + `deploy-aiko` | child cells of self-wire | workflow pin + spawn |
| `input-sources/{poll,webhook,hook,cas-read}` | four interchangeable ingress cells, same `item+next_cursor` membrane underneath | B1: `poll` (Forms pull) ⊕ `webhook` (WA delivery) ⊕ `hook` (Excel file watch) → same downstream roster engine. Proves provider branches live in *wiring*, not core. |
| `confirm` | `claim+evidence → confirmed+diff` | roster claim "local X has off 2026-09-05" + evidence (Form row digest) → confirmed |
| `api-reveng` | `session→auth→request→extract` | Sheets/Forms reverse-eng harness |
| `dashboard` + `render` | json-render on typed port | **Excel muscle-memory UI**: frozen panes, day 1-31 columns, `X` marks, yellow `FFFFFF00` locals / green `FF00B050` Sunday / orange `FF92D050` NTS, totals `=SUM(C89+C90-C88)`, `=COUNTIF(.."ABS")`; `render` pins the visual membrane |
| `context-cell` (retrieve/curate/answer) | wiring is context + retriever organelles | staffing context: only cite `hoysan-roster` + `consecutive-days` + `quota16` — narrow reads, not transcript dump |
| `loop-cell` / `graph-cell` (router/reduce/approval) | retry, fan-out→reduce, orchestrator-workers, human gate | leveling loop (even out 40), fan-out roster to 51 DAY workers |

### Neuron limbs (admitted packages, `neuron/limbs/*/SKILL.md`, `conformance.py` gates)
| Limb | Status | Drop-In reuse |
|---|---|---|
| `unbrowse` | conforming, read boundary | **B1 capture**: Form/WhatsApp screenshot → typed route DAG → replay promotion/drift demotion |
| `telethon` | conforming, **synthetic** fixtures, `outbox→send→read-back→compensation` | **B6 cascade**: per-worker WA `outbox` send, independent read-back (delivered/read), per-recipient amendment, pending expiry, `ALREADY_SENT` → compensation-gap not resend. Hoysan's 5:00 WA → 5:30 call → NTS fallback is an `escalation-ladder` variant — reuse that pattern exactly. |
| `webhook` | conforming | PSA order webhook if tenant moves off email |
| `outbox-drainer` | conforming, `lifecycle.py` PASS (admit→duplicate-suppression→revoke→GC) | drains ANY Cell's committed `outbox/` work; Hoysan replaces blind resend |
| `conversation` | conforming, 14 checks, **forger adversarial fixture proves `ForgedSender` blocked** | foreman reply authority: child can answer the `reply_to` that asked it with **no `allow_send`** grant (SMP-33 proof); phone negotiation reply path |
| `fanout` | conforming, narrowed delegations | **Roster broadcast**: 1 firing → 51 determinate child spawns, each narrowed grant, commit-serialised. |
| `energy-router` + `registry_lookup` | conforming, honest benchmark 74 wins/26 ties | **Roster ranking**: eligibility (5-day fence, night-shift ban first 2 weeks, NTS dormitory proximity, 16-shift headcount) BEFORE ranking; then rank remaining slots by lowest-energy (utilization gap to 40, cost NTS<TS<local) |
| `auto-attacher` | conforming | auto-wire `accepts` schemas into `topology/edges/` |
| `client-emitter` | conforming | emit digest-pinned Sheets API TS client from `neuron.published-manifest/v1` |
| `pipeline` | conforming | roster pipeline `stage` neuron with in-flight budget |
| `introspection` + `introspection-trigger` | conforming | when leveling finds no feasible draft → emit `PatternGap` "no transform fits" (see also `hoysan-draft`) |
| `publication-morphogenesis` | conforming | Hoysan published interface: `neuron port http` → manifest → judgment over real listener |
| `hoysan-draft` (existing `cell/patterns/hoysan-draft/hoysan-draft.cell.yaml`) | **already a Hoysan limb!** `deterministic synthetic-safe crane-gang draft; infeasible drafts refuse and retain nothing` | **Reuse as roster engine leaf** — do not rebuild. Extend its request schema to carry Hoysan constraints. |

### Neuron runtime mechanisms (standalone `src/*.zig`, production Contract)
| Mechanism | Location | Drop-In reuse |
|---|---|---|
| `telemetry stale/trace/project` + `collectStale` | `observability.zig`, `limb_ops.zig` | derivation graph: `produced_by` + `evidence[].sources` → detect roster stale when paper master or preference moves |
| `redrive` (3 cases) | `redrive.zig`, gated | **The load-bearing primitive**: `redrivable:true → refire`, `false+not-crossed → agent goal`, `false+ALREADY_SENT → CompensationGap` (notify 35 workers → amendment: tell only the 4 who changed). Hoysan: shift changed after WA sent. |
| `compact` (snapshot) | `substrate.zig` | evidence+`seq` cross fold (12.4% snapshot cost), `redrivable=false` conservative after fold |
| `limb_ops` admission lifecycle | `limb_ops.zig` | `computePackageDigest→admit→limbRun(digest-pinned caps)→revoke→detach(op:gc)→inspect`; SKILL.md inside digest, `expect_contains` falsifiable |
| `interface membrane` (`InterfaceManifest` v1) | `membrane.zig`, Phase 1+2 settled, `universal-interface-gate.sh` | classify reads vs commands, derived least-authority grants, outbox-committed commands; refuse spawn/wildcard/write-conjunction upstairs |
| `agent_ops` (`neuron agent init\|run\|inspect\|cancel\|retire`) | `agent_ops.zig`, gated | composed stage network through Runtime+Pump, durably; `worker` vs `effector` slots (still single each) |
| `conversation` envelope (SMP-33) | `wire.zig` + runtime | `from/correlation/reply_to/turn`, `ForgedSender` reject, park on `reply/<correlation>`, `Budget.max_turns` narrowing-only |
| `mesh` / `tailnet` / `mcp` | mesh.zig etc | multi-foreman mesh via `mesh-topology` limb later; CGNAT-only egress |

### Contract substrate (`contract/libcontract/src/*.zig`)
| Primitive | Drop-In reuse |
|---|---|
| `delegation_capability.zig` | child Aiko gets opaque capability handle (subject/tenant/root+parent/fence + audience/purpose + expiry/max_effects), *not* env-string lineage |
| `context_projection.zig` | purpose-scoped read projection over Contract rows + `input_bindings` + settlements + Neuron citations; filters on `VerifiedIngress` delegation, not payload claims |
| `execution_control.zig` + `execution_recovery.zig` | fenced `lease_id/fence` CAS on execution/attempt/graph+input version/non-terminal state; expired worker cannot `invoke` or `settle`; bounded retries, DLQ, compensation |
| `cross_journal_retention.zig` | reachability across roots/leases/settlements/Smithers descriptors/manifests/Neuron evidence; pinned rows stay queryable while live descendant refers; citation IDs survive `compact` |
| `ledger.zig` / `event_schema.zig` / `w6h.zig` | W6H refusal of rows missing who/what/when/where/why/how — every drop-in row must answer all six |

### Smithers / Aiko host
| Primitive | Drop-In reuse |
|---|---|
| `aiko-flow/packages/components/src/components/ContractCell` | typed Cell as workflow element inside Smithers, composed with native Contract lifecycle/recovery; Cell owns no credential/context/ledger |
| `SpawnAuthorityPolicy.js` | `inheritEnv=false`, minimal env allowlist, `yolo=false`, funnelled caps, exact account/provider generation |
| `machine-cockpit` skill | bare Mac → `aiko install` + `:8787` cockpit — composes under drop-in as seat baseline, not competing |

---

## 2. SMP coverage (33 patterns total — which the drop-in exercises)

| ID | Name | Exercised by |
|---|---|---|
| SMP-01 | One primitive, many scales | Neuron `fire` is the only primitive throughout |
| SMP-03 | Self-similar composition | Cell fractal `membrane+(run\|organelles+wiring)` and limb-inside-limb |
| SMP-04 | Mechanism below, policy in limbs | roster policy lives in `hoysan-draft` limb, not kernel |
| SMP-06 | Sparse receptor-driven firing | `input-sources` poll/webhook/hook fire only grounded ready frontier |
| SMP-07 | Cardiac valve, dual circulation | `telethon`/`outbox-drainer` keep WS inert until validated decision → `outbox` |
| SMP-08 | Persistent organism, finite work | rosters run indefinitely; each invocation bounded by `Budget` |
| SMP-10 | Artifacts as reconstructible memory | roster artifacts immutable, CAS successor on amend |
| SMP-11 | Immutable successors & CAS roots | `TopologyManifest` CAS, roster amend CAS |
| SMP-12 | Content identity & replay | roster fire: `(neuron, stimulus, read-set digests, Caps fingerprint)` → skip if same |
| SMP-13 | Provenance as causal spine | `produced_by + evidence[].sources` is the derivation graph |
| SMP-14 | Least authority | account-handle handle, membrane-derived grants, narrowed fanout |
| SMP-15 | Discovery ≠ authority | `self-wire` emits inert `NodeClaim`/`PackageOffer` candidates; admission separate |
| SMP-16 | Code inert until admission | `limb_ops` stage→admit→attach, SKILL.md in digest |
| SMP-17 | Grounded independent evidence | `confirm` cell, independent verifier ≠ producer |
| SMP-18 | Adapter membrane + reconciliation | outbox → idempotent dispatch → ack → typed reconciliation |
| SMP-23 | Eligibility before ranking | energy-router: fence → rank eligible slots only |
| SMP-24 | Reuse before generation | check `hoysan-draft` + `energy-router` + `telethon` before authoring |
| SMP-25 | Generative limb lifecycle | describe→write→admit→attach→operate→judge→cache→retire (reuse over rewrite) |
| SMP-26 | Bounded growth & retirement | `max_spawn`/`max_turns`/`max_depth`, revoke→detach→GC |
| SMP-30 | Runnable witness | every node settles only on its gate script |
| SMP-33 | Reply authority by possession | `conversation` parked reply with no `allow_send` |

*(SMP-02, -05, -09, -19..-22, -27..-32 remain structural defaults rather than Hoysan-specific focus.)*

---

## 3. What the original drop-in graph wasted

| Graph node (original) | Unused primitive it should compose | Fix |
|---|---|---|
| `hoysan-breakpoint-inventory` | `hoysan-draft` limb already models Hoysan feasibility + refusal; `neuron/limbs/telethon` + `unbrowse` already exist | `reads` must list `cell/patterns/hoysan-draft/hoysan-draft.cell.yaml` + both limbs; `inspire_from` must cite them |
| `drop-in-receptor-spec` | `receptor.schema.json` existed but `input-sources/harness.cell.yaml` was not cited | prove the same receptor with `poll` vs `webhook` vs `hook` — one harness harness that swaps source by rewiring |
| `harness-generator-integration` | mentioned `grow.py` generically, not `cell/patterns/fde/self-wire` | wire `fde/self-wire.cell.yaml` *as* the generator's parent; `account-handle` is the membership handle, not a token |
| `delegated-spawn-membrane` | omitted `conversation` (reply) + `cross_journal_retention` | spawn must prove reply-park without `allow_send` *and* citation survival across `compact` |
| `hoysan-pilot-roster-pack` | proposed to *generate* a roster engine, ignoring that `hoysan_draft.py` IS one | extend `hoysan-draft`'s schemas (`schemas/hoysan-draft-request.v1.json`), not fork; keep determinism (`policy: determinism: required`) + `check` double-fire gate |
| `hoysan-pilot-deploy-pack` | ignored `fanout` limb and `energy-router` eligibility | broadcast uses `fanout` with narrowed delegations; level-to-40 uses `energy-router` after eligibility fence |
| `drop-in-verify` | narrow verify | add coverage for `redrive` case-3 compensation, `confirm` diff, `dashboard` Excel parity (`render` membrane), `compact` survival |

---

## 4. Revised wiring (delta to `docs/graph-engineering/aiko-drop-in.walk.json`)

Patch each node to list the primitive as a `reads` or `inspire_from` so `graph.py` can derive real edges and `check_agents.py`-style guards can reject a fork:

```diff
# hoysan-breakpoint-inventory
+reads: [..., "cell/patterns/hoysan-draft/hoysan-draft.cell.yaml",
+         "neuron/limbs/telethon/neuron.json", "neuron/limbs/unbrowse/neuron.json"]
+inspire_from: [..., "src:cell/patterns/hoysan-draft/hoysan-draft.cell.yaml"]

# drop-in-receptor-spec
+reads: [..., "cell/patterns/input-sources/harness.cell.yaml",
+         "cell/patterns/input-sources/poll.cell.yaml",
+         "cell/patterns/input-sources/webhook.cell.yaml"]
+produces: [..., "input-source-alias-proof"]  # poll vs webhook vs hook equivalence

# harness-generator-integration
+reads: [..., "cell/patterns/fde/self-wire.cell.yaml",
+         "cell/primitives/account-handle.cell.yaml"]
+inspire_from: [..., "src:cell/patterns/fde/self-wire.cell.yaml"]

# delegated-spawn-membrane
+reads: [..., "neuron/limbs/conversation/neuron.json",
+         "contract/libcontract/src/cross_journal_retention.zig"]
+witness: + " && grep -q 'reply/<correlation>' neuron/limbs/conversation/tests/conformance.py"

# hoysan-pilot-roster-pack
-what: "Generate Hoysan roster pilot pack: (a) preference ingest ... (b) deterministic engine ... (c) Excel parity"
+what: "Extend hoysan-draft limb into Hoysan roster pilot pack: ingest normalization (poll/webhook/hook), deterministic engine via hoysan_draft.py (reuse, add NTS flexi + blue pool + 40/42 + 5-day fence + contracted-vs-WA actual + 16-shift headcount quota), Excel parity via dashboard render membrane, confirm cell for grounded preference evidence, mixer via energy-router eligibility→rank"
+reads: [..., "cell/patterns/hoysan-draft/hoysan-draft.cell.yaml",
+         "cell/patterns/confirm/confirm.cell.yaml",
+         "cell/patterns/dashboard/dashboard.cell.yaml",
+         "neuron/limbs/energy-router/neuron.json"]
+writes: [..., "schemas/hoysan-draft-request.v1.json"]  # extended, not forked

# hoysan-pilot-deploy-pack
+reads: [..., "neuron/limbs/fanout/neuron.json",
+         "neuron/limbs/outbox-drainer/neuron.json",
+         "neuron/tests/escalation-ladder-gate.sh"]
+inspire_from: [..., "src:neuron/limbs/outbox-drainer/neurons/drainer.py"]

# drop-in-verify
+reads: [..., "cell/patterns/confirm/confirm.cell.yaml",
+         "neuron/src/redrive.zig", "neuron/src/observability.zig"]
+witness: + " && python3 cell/patterns/confirm/tests ... && neuron redrive <state> --dry-run --json | jq -e '.compensation_gaps|length>0'"
```

No new top-level node needed — the eight existing nodes already cover covenant→inventory→skill→harness→pilot→verify. The expansion is making each node *compose* instead of generate.

---

## 5. End-to-end witness (what proves reuse, not reinvention)

```sh
# Tier 1 — each node green
bash tests/drop-in-covenant-gate.sh
# hoysan inventory cites hoysan-draft + telethon + unbrowse digests
bash tests/hoysan-roster-engine-gate.sh   # extends hoysan_draft.py, still deterministic double-fire, still refuses infeasible
bash tests/hoysan-deploy-gate.sh           # fanout narrowed delegations + escalation terminates
bash tests/drop-in-spawn-gate.sh           # child replies with no allow_send, citation survives compact
python3 .agents/skills/aiko-drop-in/scripts/conform.py --all   # receptor validates under poll/webhook/hook alias
bash tests/aiko-drop-in-gate.sh            # redrive case 3 compensation, confirm diff, dashboard render parity

# Tier 2 — composition proof (the "we hvae a lot of unused primitives" claim)
python3 tools/check_reuse.py --walk docs/graph-engineering/aiko-drop-in.walk.json
# → every drop-in node lists ≥1 reads under cell/primitives|cell/patterns|neuron/limbs|contract/libcontract
# → no node invents a write that a prior limb already owns
```

The `walk.json` update to enforce that is the next commit.
