# Patterns — the five layers as runnable cells + primitives demo

Each folder is a runnable `*.cell.yaml` that implements one rung of the Prompt -> Context -> Harness -> Loop -> Graph ladder or the primitives. Same primitive (`Cell = membrane + (run | organelles+wiring)`), same runtime, no second harness.

| Pattern | Folder | What it wires |
|---|---|---|
| **Prompt** | `prompt-cell/` | Wording lives in a `python` leaf (`def run(inputs, ctx)`). No `prompt:` field — Python templating, prompt inside digest. |
| **Context** | `context-cell/` | `retrieve` (query->hits, re-rank top-k) + `curate` (all_tools->allowed_tools) + `answer` (ctx+tools+query->answer). Wiring is context. |
| **Harness** | `system/` + `docs/` | `caps`/`policy`/`out/`/`skills/`, builder that builds itself. |
| **Loop** | `loop-cell/` | `python` loop inside a leaf (`for _ in range(max): ... if done: break`) — no spec syntax, raw Python bounded `for`. |
| **Graph** | `graph-cell/` | Router -> parallel workers -> reduce -> human approval. Pipeline, router, fan-out->reduce, orchestrator-workers — all via `wiring:` |
| **Video** | `video/` | `prompt -> fal-generate -> poll -> cas` (mock without `FAL_KEY`). |
| **Primitives demo** | `api-reveng/` | Fixed stdlib demo — `session -> auth -> request -> extract` using `primitives/` (add HMAC/OAuth to `request.py`). |

```sh
python run.py build patterns/prompt-cell/classify.cell.yaml
python run.py run   patterns/prompt-cell/classify.cell.yaml --inputs '{"ticket":{"text":"refund please"}}' --out /tmp/p
python run.py run   patterns/context-cell/context.cell.yaml --inputs '{"query":"battery?"}' --out /tmp/c
python run.py run   patterns/loop-cell/loop.cell.yaml --inputs '{"ticket":{"text":"battery issue"},"capacity":{"available_pct":90}}' --out /tmp/l
python run.py run   patterns/graph-cell/graph.cell.yaml --inputs '{"query":"battery refund"}' --out /tmp/g
python run.py run   patterns/api-reveng/api-reveng.cell.yaml --inputs '{"base_url":"https://postman-echo.com","credentials":{"token":"demo"},"path":"/get"}' --out /tmp/a
```

See `SPEC.md §5` (primitives) + `§6` (patterns) for the normative description; each folder is its executable proof.
