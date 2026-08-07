# Input as cell — input nodes are cells

An **input node is a cell**. No special `source:` type. What triggers it (poll, webhook, hook, CAS hash moving) is an orchestration choice, not a type.

| Source cell | Membrane | When it fires | Manifest digest is... |
|---|---|---|---|
| `poll.cell.yaml` | `cursor? -> item + next_cursor` | Timer / queue poll (`GET ?cursor=`) | `next_cursor` |
| `webhook.cell.yaml` | `webhook -> event` | HTTP POST lands as `inputs/webhook.json` | `event.type` |
| `hook.cell.yaml` | `file -> change` | `PostToolUse` on `Write\|Edit` for `*.cell.yaml` | `change.path` |
| `cas-read.cell.yaml` | `key -> data` | Content hash moved in `.cell-cas/` | `key` |

Any of these can be wired as `from: in.order` exactly like `example/pipeline.cell.yaml`:

```yaml
organelles:
  - { name: in,   cell: ./poll.cell.yaml }   # or webhook / hook / cas-read
  - { name: work, cell: ./rank.cell.yaml }
wiring:
  - { from: in.item, to: work.order }
  - { from: work.roster, to: membrane.roster }
```

The parent sees `manifest: {source, digest}` from any of them alongside `item`. `patterns/reactive-cell/check` compares `in:<port>` digests in `out/manifest.json` — poll moved it, webhook moved it, hook moved it → `changed[]` → `system/redrive` says `stale` vs `ALREADY_SENT`.

`harness.cell.yaml` shows the four interchangeable wirings in one harness; `route.cell.yaml` routes `source` → right leaf. Replace the choice by rewiring, not by new syntax.
