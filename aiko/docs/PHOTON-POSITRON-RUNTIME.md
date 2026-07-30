# Photon / positron → runtime

**Canon:** [`../../contract/docs/PHOTON-POSITRON-RUNTIME.md`](../../contract/docs/PHOTON-POSITRON-RUNTIME.md)

**Product plan:** [`../plan3.md`](../plan3.md) — resident clock hand over ledger-stateless Contract.

## One-liner

Daemons are not antipatterns; **stateful-as-truth** daemons are.  
Contract schedules the next occurrence; a **killable while** ticks the ledger.

## Three loops

1. **Graph waves** — bounded DAG (`muscle.schedule`), no cycles  
2. **Time re-entry** — `repeat:` / lease retry / `when:contract:`  
3. **Process while** — `contract tick --every` or Aiko claim worker  

## Already in tree

- `contract tick` / `tick --every <s>`  
- `contract_tick_json` + Aiko `tick_due_contracts`  
- `run_contract_worker` claim → single-shot → settle  

Witness: `scripts/witness-plan3-resident.sh`
