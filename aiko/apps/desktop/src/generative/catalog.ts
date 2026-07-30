import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

/**
 * Aiko generative UI catalog — dashboards, metrics, tables, and interactive
 * cards constrained so the model cannot invent unsafe components.
 */
export const aikoCatalog = defineCatalog(schema, {
  components: {
    Stack: {
      props: z.object({
        direction: z.enum(["row", "column"]).nullable(),
        gap: z.enum(["sm", "md", "lg"]).nullable(),
        align: z.enum(["start", "center", "end", "stretch"]).nullable(),
      }),
      slots: ["default"],
      description: "Flex layout container for arranging children in a row or column",
    },
    Grid: {
      props: z.object({
        columns: z.number().nullable(),
        gap: z.enum(["sm", "md", "lg"]).nullable(),
      }),
      slots: ["default"],
      description: "Responsive grid for dashboard cards and metrics",
    },
    Card: {
      props: z.object({
        title: z.string().nullable(),
        description: z.string().nullable(),
        tone: z.enum(["default", "accent", "success", "warning", "danger"]).nullable(),
      }),
      slots: ["default"],
      description: "Surface card with optional title and description",
    },
    Heading: {
      props: z.object({
        text: z.string(),
        level: z.enum(["1", "2", "3"]).nullable(),
      }),
      description: "Section heading",
    },
    Text: {
      props: z.object({
        content: z.string(),
        muted: z.boolean().nullable(),
      }),
      description: "Body text paragraph",
    },
    Metric: {
      props: z.object({
        label: z.string(),
        value: z.string(),
        delta: z.string().nullable(),
        trend: z.enum(["up", "down", "flat"]).nullable(),
        hint: z.string().nullable(),
      }),
      description: "KPI metric tile with optional delta/trend",
    },
    Badge: {
      props: z.object({
        label: z.string(),
        tone: z.enum(["default", "accent", "success", "warning", "danger"]).nullable(),
      }),
      description: "Small status or category pill",
    },
    Progress: {
      props: z.object({
        label: z.string().nullable(),
        value: z.number(),
        max: z.number().nullable(),
      }),
      description: "Progress bar 0–max (default max 100)",
    },
    List: {
      props: z.object({
        items: z.array(z.string()),
        ordered: z.boolean().nullable(),
      }),
      description: "Bullet or numbered list of strings",
    },
    Table: {
      props: z.object({
        columns: z.array(z.string()),
        rows: z.array(z.array(z.string())),
        caption: z.string().nullable(),
      }),
      description: "Simple data table (string cells)",
    },
    BarChart: {
      props: z.object({
        title: z.string().nullable(),
        labels: z.array(z.string()),
        values: z.array(z.number()),
        unit: z.string().nullable(),
      }),
      description: "Horizontal bar chart for comparing numeric series",
    },
    Divider: {
      props: z.object({
        label: z.string().nullable(),
      }),
      description: "Visual separator with optional label",
    },
    Button: {
      props: z.object({
        label: z.string(),
        variant: z.enum(["primary", "secondary", "ghost"]).nullable(),
      }),
      description: "Interactive button; wire via on.press actions",
    },
    Code: {
      props: z.object({
        content: z.string(),
        language: z.string().nullable(),
      }),
      description: "Monospace code or command block",
    },
    Callout: {
      props: z.object({
        title: z.string().nullable(),
        content: z.string(),
        tone: z.enum(["info", "success", "warning", "danger"]).nullable(),
      }),
      description: "Highlighted notice for status or advice",
    },
    Tabs: {
      props: z.object({
        tabs: z.array(
          z.object({
            id: z.string(),
            label: z.string(),
          }),
        ),
        activeId: z.string().nullable(),
      }),
      slots: ["default"],
      description:
        "Tab strip; set active via state /activeTab and setState on press",
    },
  },
  actions: {
    copy: {
      params: z.object({ text: z.string() }),
      description: "Copy text to the clipboard",
    },
    open_url: {
      params: z.object({ url: z.string() }),
      description: "Open an external URL",
    },
    notify: {
      params: z.object({
        message: z.string(),
        tone: z.enum(["info", "success", "warning", "danger"]).nullable(),
      }),
      description: "Show a transient notice in the generative surface",
    },
  },
});

export type AikoCatalog = typeof aikoCatalog;

/**
 * Compact agent instructions for emitting generative UI in chat.
 * Prefer this over the full JSONL stream tutorial for desktop transcripts.
 * Includes prop schemas + layout recipes so the model matches the real registry.
 */
export function generativeUiAgentGuide(): string {
  void aikoCatalog.prompt;

  return `## Generative UI registry (json-render — exact components only)

Aiko renders **only** these components. Invented types render as "Unknown".
Put titles and body copy **inside** the fence. At most one short intro line outside.
Never dump HTML/XML/React. Never empty title-only Cards with no children content.

### Component props (required unless marked optional / null)

| Type | Props | Children |
|------|-------|----------|
| Stack | direction: row\\|column\\|null, gap: sm\\|md\\|lg\\|null, align: start\\|center\\|end\\|stretch\\|null | yes |
| Grid | columns: number\\|null (1–4), gap: sm\\|md\\|lg\\|null | yes |
| Card | title?, description?, tone: default\\|accent\\|success\\|warning\\|danger\\|null | yes (put List/Table/Text inside) |
| Heading | text, level: "1"\\|\\"2"\\|\\"3"\\|null | no |
| Text | content, muted?: bool\\|null | no |
| Metric | label, value, delta?, trend: up\\|down\\|flat\\|null, hint? | no |
| Badge | label, tone? | no |
| Progress | value (number), label?, max? (default 100) | no |
| List | items: string[], ordered?: bool\\|null | no |
| Table | columns: string[], rows: string[][], caption? | no |
| BarChart | labels: string[], values: number[], title?, unit? | no |
| Divider | label? | no |
| Button | label, variant: primary\\|secondary\\|ghost\\|null | no |
| Code | content, language? | no |
| Callout | content, title?, tone: info\\|success\\|warning\\|danger\\|null | no |
| Tabs | tabs: {id,label}[], activeId? | yes |

Actions on Button: setState, pushState, removeState, copy, open_url, notify.

### Layout recipes (use these shapes)

1. **Playlist / music library / file list** → one Card + **Table** (or ordered List).  
   Columns like \`#\`, \`Title\`, \`Artist\`, \`Duration\`. Do **not** emit one empty Card per genre.

2. **KPI board** → Heading + Grid of Metric tiles (columns 2–3).

3. **Status / notice** → Callout or Card with Text + Badge.

4. **Categories with items** → Stack of Cards, each Card **must** contain a List or Table of real items (not title alone).

### Flat tree shape

\`\`\`json-render
{
  "root": "root",
  "elements": {
    "root": { "type": "Stack", "props": { "gap": "md", "direction": "column" }, "children": ["title", "panel"] },
    "title": { "type": "Heading", "props": { "text": "Downloads playlist", "level": "2" } },
    "panel": {
      "type": "Card",
      "props": { "title": "Tracks", "description": "From ~/Downloads", "tone": "default" },
      "children": ["tracks"]
    },
    "tracks": {
      "type": "Table",
      "props": {
        "columns": ["#", "Title", "Artist", "Time"],
        "rows": [
          ["1", "Track A", "Artist", "3:21"],
          ["2", "Track B", "Artist", "2:58"]
        ],
        "caption": "Local files"
      }
    }
  },
  "state": { "source": "session" }
}
\`\`\`

### Anti-patterns (do not)
- Empty Cards that only have a title emoji and no List/Table/Text children
- Giant column of thin Cards for each genre with no tracks inside
- Duplicating the same heading in prose **and** in the UI fence
- Nested object trees (must be flat \`elements\` map + string key children)
- Inventing types like Playlist, SongRow, MediaPlayer, Image, Link

### Durability (contract-native — pull / rank / re-retrieve)
Complete blocks are **contract-native surfaces**:
- Pointer: \`aiko:ui/<id>\` (id = content-hash of spec; same UI → same pointer)
- Spec blob: \`aiko:data/<sha256>\` (content-addressed, immutable)
- On disk: \`~/.aiko/ui/by-id/<id>/{meta,spec,state,bindings}.json\`
- Ledger action (rankable, **no shell: prefix**):
  \`ui.resolve {"pointer":"aiko:ui/<id>","id":"<id>"}\`
- Retrieve CLI: \`ui resolve aiko:ui/<id>\` or \`ui rank "playlist downloads"\`
- Rank in desktop Surfaces (⌘4) search; same keywords as \`contract recommend "ui:…"\`
- Catalog types (Card, Table, …) are registered as \`aiko:ui/catalog-<Type>\`
- Check: \`test -f ~/.aiko/ui/by-id/<id>/spec.json\`

When you need a past board, **re-retrieve** by pointer or rank — do not rebuild from scratch.`;
}
