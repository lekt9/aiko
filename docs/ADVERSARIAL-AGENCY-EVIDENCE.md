# Adversarial agency evidence

The release scenarios in `PLAN.md` map to deterministic checks below. A scenario
passes only when its unsafe green state is rejected, invalidated, or rolled back.

| # | Scenario | Expected causal result | Executable evidence |
|---:|---|---|---|
| 1 | Command exits zero while browser state is wrong | browser/API disagreement is `contradicted`; no promotion | `workflow.test.independent matching anchor satisfies and disagreement contradicts` |
| 2 | Five evaluators derive from one source | one independence class, not five witnesses | `trust.test.two wallets sharing one source are not independent` and anchor copied-source test |
| 3 | Evaluators confirm each other circularly | derived cycle rejected | `trust.test.derived evidence cycle is rejected` |
| 4 | Sensor expires after cached success | stale anchor cannot promote and emits bad news | anchor expiry and trust stale tests |
| 5 | Action weakens its veto threshold | frozen amendment rejected | `trust.test.frozen policy rejects optimizer amendment` |
| 6 | Operational speed conflicts with safety | counter-metric veto blocks promotion | `trust.test.counter metric prevents Goodhart promotion` |
| 7 | Network mutation exceeds sensor reach | reach verdict refuses action | governance capability/scope tests |
| 8 | Bad news arrives during cache reuse | negative event bypasses positive cache and invalidates in the same tick | governance bad-news test and failure propagation test |
| 9 | Topology patch fails halfway | input graph remains byte-for-byte equivalent | development atomic patch test |
| 10 | Identity is compromised | evidence and all downstream consumers are revoked once | trust recursive revocation test |
| 11 | Human attestation exceeds scope/expiry | anchor validation/freshness fails closed | anchor human-authority and expiry tests |
| 12 | Log/renderer receives planted secrets | persistence rejects secret-shaped fields; renderer redacts hostile imported JSON | event-schema secret fixture and renderer redactor |
| 13 | Keychain unavailable during inspection | local read-only commands finish without wallet access | `tools/audit-readonly-keychain.sh` |
| 14 | Legacy and typed resolvers disagree | shadow verdict is `stricter` or `incompatible`, never silently accepted | migration shadow-verdict tests |

The worked failure and recovery sequence is
`fixtures/storefront-grounded-trace.jsonl`. Open
`tools/contract-events.html`, drop the fixture on the page, and inspect the
five-event chain: deployment → browser observation → independent contradiction
→ rollback → verified recovery. No network connection is used.

Security interpretation: the renderer is not an authority. It shows persisted
control events, but promotion remains governed by validated anchors, evaluator
independence, and policy. Editing a JSONL visualization cannot change a ledger
verdict.
