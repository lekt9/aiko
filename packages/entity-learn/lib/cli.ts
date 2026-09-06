import { readBoundedFile } from "./sources-node.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Memory, MemoryError, importContract, importLegacy, type RecallInput } from "./index.js";

const HELP = `entity-learn — cited memory, not an executable command database

  remember '<JSON>' [--key KEY]           Record a fact/episode/skill; corrections need supersedes
  query [--search TEXT] [--subject ID]    Recall ONLY; no source calls
        [--type TYPE] [--kind KIND] [--as-of ISO]
        [--limit N] [--max-bytes N] [--max-candidates N] [--max-nodes N] [--depth N] [--fresh-only]
  get OBSERVATION                       Read pinned bytes; never refresh
  history SUBJECT [--limit N]           Inspect prior revisions
  forget SUBJECT --expected OBSERVATION Suppress, not physically erase
  learn --file PATH --id ID --namespace NS --type TYPE [--format json|jsonl|text] [--ttl N]
                                        Register a DISABLED source; executes nothing
  approve SOURCE --revision HASH        Grant refresh for an exact source revision
  disable SOURCE --revision HASH        Remove the grant
  refresh SOURCE [--timeout-ms N]        Explicitly obtain an observation; bounded, no shell
  sources | pointers | types            Inspect scoped catalog
  import-v1 --file PATH                 Import cached data only; legacy commands are discarded
  import-contract --file PATH           Import digest-checked Contract evidence, not signed truth
  rebuild                              Verify journal chain and rebuild read projections

Global: --db PATH (default ~/.agent-org/memory.sqlite), --scope NAME (default local), --key KEY.
Returns JSON. A failed refresh exits nonzero and preserves labeled prior observations.
Shell learning, implicit refresh, automatic bootstrap replay, and the old HUD are not v0.2 APIs.
`;

async function main(args: string[]): Promise<void> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) { process.stdout.write(HELP); return; }
  const command = args.shift()!;
  const positional: string[] = []; const flags: Record<string, string | boolean> = Object.create(null);
  const switches = new Set(["fresh-only", "related"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const name = arg.slice(2);
    if (name in flags) throw new MemoryError("invalid_input", `Duplicate flag: --${name}`);
    if (switches.has(name)) flags[name] = true;
    else {
      const next = args[++i];
      if (next === undefined || next.startsWith("--")) throw new MemoryError("invalid_input", `Missing value for --${name}`);
      flags[name] = next;
    }
  }
  const options: Record<string, string[]> = {
    remember: [], query: ["search", "subject", "type", "kind", "as-of", "limit", "max-bytes", "max-candidates", "max-nodes", "depth", "fresh-only", "related"],
    recall: ["search", "subject", "type", "kind", "as-of", "limit", "max-bytes", "max-candidates", "max-nodes", "depth", "fresh-only", "related"],
    get: [], history: ["limit"], forget: ["expected"], learn: ["file", "id", "namespace", "type", "format", "ttl", "id-field", "title-field"],
    approve: ["revision"], disable: ["revision"], refresh: ["timeout-ms", "max-bytes"], sources: [], pointers: [], types: [],
    "import-v1": ["file"], "import-contract": ["file"], rebuild: [],
  };
  if (!Object.hasOwn(options, command)) throw new MemoryError("invalid_input", `Unknown command: ${command}. Use --help.`);
  for (const key of Object.keys(flags)) if (!["db", "scope", "key", ...options[command]!].includes(key))
    throw new MemoryError("invalid_input", `Unknown flag for ${command}: --${key}`);
  const required = (name: string): string => {
    if (typeof flags[name] !== "string") throw new MemoryError("invalid_input", `--${name} is required`);
    return flags[name] as string;
  };
  const argument = (): string => {
    if (positional.length !== 1) throw new MemoryError("invalid_input", `${command} requires exactly one argument`);
    return positional[0]!;
  };
  const numeric = (name: string, defaultValue: number): number => flags[name] === undefined ? defaultValue : Number(flags[name]);
  const file = async (): Promise<unknown> => JSON.parse(new TextDecoder("utf-8", { fatal: true })
    .decode(await readBoundedFile(required("file"), 8 * 1024 * 1024)));
  if (["sources", "pointers", "types", "import-v1", "import-contract", "rebuild"].includes(command) && positional.length)
    throw new MemoryError("invalid_input", `${command} takes no positional arguments`);
  const memory = new Memory({ path: String(flags.db ?? process.env.ENTITY_MEMORY_DB ?? join(homedir(), ".agent-org", "memory.sqlite")),
    scope: String(flags.scope ?? process.env.ENTITY_MEMORY_SCOPE ?? "local") });
  const key = String(flags.key ?? randomUUID());
  let result: unknown;
  try {
    switch (command) {
      case "remember": result = memory.remember(JSON.parse(argument()), { key, producer: { kind: "tool", reference: `local-cli:${key}` } }); break;
      case "get": result = memory.get(argument()); break;
      case "history": result = memory.history(argument(), numeric("limit", 20)); break;
      case "forget": result = memory.forget(argument(), required("expected"), key); break;
      case "query": case "recall": {
        if (positional.length) throw new MemoryError("invalid_input", "Use --search TEXT, not a positional search");
        const input: Record<string, unknown> = {};
        for (const name of ["search", "subject", "type", "kind"]) if (flags[name] !== undefined) input[name] = flags[name];
        for (const [flag, name] of [["limit", "limit"], ["max-bytes", "maxBytes"], ["max-candidates", "maxCandidates"], ["max-nodes", "maxNodes"], ["depth", "depth"]])
          if (flags[flag!] !== undefined) input[name!] = Number(flags[flag!]);
        if (flags["as-of"] !== undefined) input.asOf = Date.parse(required("as-of"));
        if (flags["fresh-only"]) input.includeStale = false;
        if (flags.related) input.depth = input.depth ?? 1;
        result = memory.recall(input as RecallInput); break;
      }
      case "learn": {
        if (positional.length) throw new MemoryError("unsafe_recipe", "Shell commands are no longer learned or replayed. Use --file or a host-owned adapter.");
        result = memory.registerSource({ id: required("id"), namespace: required("namespace"), type: required("type"), resolver: "file", locator: required("file"),
          format: String(flags.format ?? "json") as "json", ttlSeconds: numeric("ttl", 300),
          schema: { ...(flags["id-field"] ? { id: required("id-field") } : {}), ...(flags["title-field"] ? { title: required("title-field") } : {}) },
        }, key); break;
      }
      case "approve": case "disable": result = memory.approveSource(argument(), required("revision"), command === "approve", key); break;
      case "refresh": {
        const refreshed = await memory.refresh(argument(), { key, timeoutMs: numeric("timeout-ms", 10000), maxBytes: numeric("max-bytes", 65536) });
        result = refreshed; if (refreshed.error) process.exitCode = 1; break;
      }
      case "sources": case "pointers": result = memory.sources(); break;
      case "types": {
        const projection = memory.recall({ limit: 100, maxCandidates: 10000, maxBytes: 262144 });
        result = { types: [...new Set(projection.items.map(i => i.observation.type))], coverage: projection.coverage, reasons: projection.reasons }; break;
      }
      case "import-v1": result = importLegacy(memory, await file()); break;
      case "import-contract": result = importContract(memory, await file()); break;
      case "rebuild": result = memory.rebuild(); break;
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { memory.close(); }
}
main(process.argv.slice(2)).catch(error => {
  const code = error instanceof MemoryError ? error.code : "operation_failed";
  const message = error instanceof MemoryError ? error.message : "Operation failed. Check input JSON, file access, and the memory database.";
  process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
  process.exitCode = 1;
});
