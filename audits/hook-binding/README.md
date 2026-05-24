# audits/hook-binding — every hook is /contract-bound on both edges

Programmatic enforcement of Lewis's request: every `~/.contracts/hooks/*.{py,sh}`
must have BOTH:

1. **PRE-fire gate** — calls `contract feature-status <hook-name>` (or
   imports `hook_sdk.should_fire`) to check the substrate-as-config toggle
   before doing any work. Safe-OFF by default; substrate enables, never
   prescribes.

2. **POST-fire record** — appends a `hook_fired` row to `contracts.jsonl`
   (via `hook_sdk.record` or direct `contract_core._append`) so every hook
   firing is observable. The ledger IS the query history; hooks are no
   exception.

This file (the README) is informational. The audit logic lives in
`verify.sh`, which the substrate-level `audits/` self-binding doctrine
fires on every pre-commit hook on `~/.contracts/.git`.

## Why both edges

Pre-only enforcement leaves hooks unobservable — they fire, do work,
leave no trace. Post-only enforcement leaves hooks ungated — they fire
on every iterate/mark whether the user wants them or not. Both edges
together close the loop: the ledger records what's enabled AND what
actually fired.

## How to bind a new hook

```python
from hook_sdk import should_fire, record

def main():
    if not should_fire("my-hook"):
        return 0
    # ... do the work, capture an exit_code + metadata ...
    record("my-hook", event=sys.argv[1] if len(sys.argv) > 1 else "fired",
           exit_code=0, things_done=42)
    return 0
```

Or in shell:

```bash
#!/usr/bin/env bash
CLI="$HOME/.claude/skills/contract/scripts/contract"
"$CLI" feature-status my-hook >/dev/null 2>&1 || exit 0
# ... do the work ...
python3 -c "
import sys; sys.path.insert(0, '$HOME/.claude/skills/contract/scripts/lib')
from hook_sdk import record
record('my-hook', event='${1:-fired}', exit_code=0, things_done=42)
"
```

## What the audit checks

For each hook file under `~/.contracts/hooks/`:

- **Pre-gate present:** matches `feature-status` OR `should_fire(` OR
  `_toggle_on(` (legacy unbrowse-mirror.py pattern).
- **Post-record present:** matches `hook_fired` OR `record(` OR
  `_append(` (direct ledger write).

Reports per-hook status as a table. Audit FAILS overall iff any hook
under scope lacks either edge.

## What `fix.sh` does NOT do

There's no `fix.sh` because hook-bodies are too custom to mechanically
patch. The audit surfaces violations; the agent reads the list, picks
the right pattern (SDK call vs inline shell), patches per-hook in a
declared contract. Captured Β1-style as deferred children of organ
`d5c39337` for hooks not yet patched.
