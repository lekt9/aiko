import { defineCatalog } from "@json-render/core";
import { schema as reactSchema } from "@json-render/react/schema";
import { z } from "zod";

export const catalog = defineCatalog(reactSchema, {
  components: {
    BlockHeader: {
      props: z.object({
        title: z.string(),
        subtitle: z.string().nullable().optional(),
        badge: z.string().nullable().optional(),
        tone: z.enum(["neutral", "accent", "ok", "warn", "err"]).nullable().optional(),
      }),
      description: "Block header: title + subtitle + badge. Tone maps to dot.",
    },
    Stat: {
      props: z.object({
        label: z.string(),
        value: z.string(),
        hint: z.string().nullable().optional(),
      }),
      description: "Key-value stat line.",
    },
    Badge: {
      props: z.object({
        label: z.string(),
        tone: z.enum(["ok", "warn", "err", "neutral", "accent"]).nullable().optional(),
      }),
      description: "Inline status badge.",
    },
    KVGrid: {
      props: z.object({
        pairs: z.array(z.object({ k: z.string(), v: z.string() })),
      }),
      description: "2-col key-value grid for object properties.",
    },
    MiniTable: {
      props: z.object({
        columns: z.array(z.object({ key: z.string(), label: z.string().nullable().optional() })),
        rows: z.array(z.record(z.string(), z.unknown())),
      }),
      description: "Compact table for array-of-objects.",
    },
    Timeline: {
      props: z.object({
        items: z.array(z.object({ at: z.string(), message: z.string() })),
      }),
      description: "Vertical timeline for hcs_updates / tracking events.",
    },
    RelationTag: {
      props: z.object({
        label: z.string().nullable().optional(),
        relationKey: z.string(),
        value: z.string(),
        sourceId: z.string().nullable().optional(),
      }),
      description: "Notion-style clickable relation tag. Click links to entities that share the same key/value.",
    },
    PropertyRow: {
      props: z.object({ label: z.string(), value: z.string() }),
      description: "Single key-value row.",
    },
    Block: {
      props: z.object({}),
      description: "Container block — cellulose boundary. Holds children.",
    },
  },
  actions: {
    openCell: { params: z.object({ cellPath: z.string() }), description: "Navigate to graph for this cell" },
    drillRelation: { params: z.object({ key: z.string(), value: z.string() }), description: "Filter dashboard by shared relation key/value" },
  },
});
