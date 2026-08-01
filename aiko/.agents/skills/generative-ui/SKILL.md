---
name: generative-ui
description: Create native, persisted Aiko interfaces from json-render specifications. Use when the user asks for a dashboard, interactive visualization, rich data presentation, playlist/library view, KPI board, reusable surface, or other structured UI instead of plain prose.
---

# Generative UI

Emit a complete `json-render` fenced block when structured UI materially improves the answer. Keep ordinary answers as prose.

## Schema

Use a flat tree with a root element and an `elements` map. Children are arrays of element IDs.

```json-render
{
  "root": "root",
  "elements": {
    "root": { "type": "Stack", "props": { "direction": "column", "gap": "md" }, "children": ["title", "content"] },
    "title": { "type": "Heading", "props": { "text": "Overview", "level": "2" } },
    "content": { "type": "Card", "props": { "title": "Results" }, "children": ["table"] },
    "table": { "type": "Table", "props": { "columns": ["Name", "Value"], "rows": [["Example", "42"]] } }
  },
  "state": { "source": "session" }
}
```

Allowed types:

- Containers: `Stack`, `Grid`, `Card`, `Tabs`
- Content: `Heading`, `Text`, `Metric`, `Badge`, `Progress`, `List`, `Table`, `BarChart`, `Divider`, `Code`, `Callout`
- Interaction: `Button`

Actions: `setState`, `pushState`, `removeState`, `copy`, `open_url`, `notify`.

## Composition rules

- Use one `Card` containing a `Table` or `List` for libraries, files, and playlists.
- Use a `Grid` of two or three `Metric` elements for KPI boards.
- Put useful content inside every card. Never emit title-only cards.
- Use only the registered types. Do not invent HTML, `Playlist`, `SongRow`, or `MediaPlayer`.
- Put titles and explanatory copy inside the block; avoid duplicating them in prose.

## Persistence

Complete blocks are stored as `aiko:ui/<id>` with data at `aiko:data/<sha256>`. Reopen an existing matching pointer rather than regenerating it. Resolve with `ui resolve aiko:ui/<id>` and rank prior surfaces with `ui rank "<goal>"` when those commands are available.
