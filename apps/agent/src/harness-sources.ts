import { createHash } from "node:crypto";
import { Effect } from "effect";
import { Self } from "tardie/core/runtime";
import { EventLog } from "tardie/core/log";
import type { Event } from "tardie/core/event";
import type { NativeTool } from "tardie/component/tool";
import { Validator } from "@cfworker/json-schema";
import { validateSiteHarnessArtifact } from "@unbrowse/browser-harness/harness-artifact";
import { deriveOpenApiAction } from "./harness-openapi.ts";
import { HarnessLibrary, harnessDigest, harnessLibraryTools, type HarnessArtifact, type HarnessDigest, type HarnessJournal, type HarnessLibraryBinding } from "./harness-library.ts";

/** Source acquisition is a finite native effect. Implement get with the selected
 * sandbox transport; this module never installs packages or executes source. */
export interface HarnessSourceTransport {
  get(url: string, operationId: string, signal: AbortSignal): Promise<{ value: unknown; receipt: string }>;
}
export interface HarnessSourceBinding {
  library: HarnessLibraryBinding;
  transport: HarnessSourceTransport;
  /** Host policy, independent of README/skill text or a repository's popularity. */
  authorize(repository: string, action: "discover" | "ingest" | "derive", signal: AbortSignal): Promise<boolean>;
}
export interface SourceFile { path: string; digest: HarnessDigest; gitBlob: string; bytes: number; contentRef: HarnessDigest }
export interface SourceSnapshot {
  version: 1; repository: string; revision: string; kind: "github" | "skills.sh";
  registryUri: string | null; registryRef: HarnessDigest | null;
  files: SourceFile[]; license: { path: string; digest: HarnessDigest; declared: string };
  requestedPaths: string[]; coverage: "selected-files"; receipts: string[];
}
export interface SourceIngestInput {
  repository: string; ref: string; paths: string[]; licensePath: string;
  registryUri?: string; operationId: string; expectedGeneration: number;
}
const repoPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const sha1 = /^[a-f0-9]{40}$/;
const sourcePath = (path: string) => typeof path === "string" && /^[A-Za-z0-9_.@/-]{1,180}$/.test(path) && path.split("/").every(p => p !== "" && p !== "." && p !== "..") && !path.startsWith("/");
function need(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
function repository(value: string) { need(typeof value === "string" && repoPattern.test(value) && !value.split("/").some(x => x === "." || x === ".."), "Invalid repository"); return value.toLowerCase(); }
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const eventOf = (owner: string, type: string, id: string, data: Record<string, unknown>): Event => ({ type, id, owner, at: Date.now(), ...data });
const sourceId = (repo: string) => harnessDigest(["github", repo]);

/** Authoritative source heads change only through a shared generation slot.
 * Observing another snapshot alone cannot silently replace the tracked head. */
export function harnessSourceState(events: readonly Event[], owner: string) {
  const snapshots = new Map<string, Event>(), heads = new Map<string, Event>(), derived = new Map<string, Event>();
  for (const e of events) {
    if (e.owner !== owner) continue;
    if (e.type === "AikoHarnessSourceObserved") snapshots.set(String(e.snapshotDigest), e);
    if (e.type === "AikoHarnessSourceHeadChanged") {
      const previous = heads.get(String(e.sourceId));
      if (e.previousGeneration === (previous?.generation ?? 0) && e.generation === Number(e.previousGeneration) + 1 && snapshots.has(String(e.snapshotDigest))) heads.set(String(e.sourceId), e);
    }
    if (e.type === "AikoHarnessSourceCandidateDerived") derived.set(String(e.harnessDigest), e);
  }
  return { snapshots, heads, derived };
}

export class HarnessSources {
  readonly library: HarnessLibrary;
  constructor(readonly binding: HarnessSourceBinding, readonly journal: HarnessJournal) { this.library = new HarnessLibrary(binding.library, journal); }
  private async emit(type: string, id: string, data: Record<string, unknown>) { await this.journal.append([eventOf(this.binding.library.owner, type, id, data)]); }
  private async permit(repo: string, action: "discover" | "ingest" | "derive", signal: AbortSignal) { signal.throwIfAborted(); need(await this.binding.authorize(repo, action, signal), "Source authority rejected"); }
  private async read(url: string, operationId: string, signal: AbortSignal) {
    const result = await this.binding.transport.get(url, operationId, signal);
    signal.throwIfAborted();
    need(typeof result.receipt === "string" && result.receipt.length > 0 && result.receipt.length <= 256, "Source execution receipt required");
    need(Buffer.byteLength(JSON.stringify(result.value)) <= 262144, "Source response too large");
    return structuredClone(result);
  }
  async discover(query: string, operationId: string, signal: AbortSignal) {
    need(typeof query === "string" && query.trim().length > 0 && query.length <= 240 && idPattern.test(operationId), "Bounded source query required");
    this.binding.library.guard(query);
    await this.permit("github.com", "discover", signal);
    const identity = harnessDigest(query);
    const previous = (await this.journal.read()).find(e => e.type === "AikoHarnessSourceDiscoveryRecorded" && e.owner === this.binding.library.owner && e.id === operationId);
    if (previous) { need(previous.queryDigest === identity, "Source discovery identity conflict"); return previous; }
    const result = await this.read(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=10&page=1`, operationId, signal);
    need(object(result.value) && Array.isArray(result.value.items), "Invalid GitHub discovery response");
    const entries = result.value.items.slice(0, 10).map((entry: any) => {
      const repo = repository(entry.full_name);
      need(typeof entry.description === "string" || entry.description === null, "Invalid repository description");
      return { repository: repo, description: entry.description?.slice(0, 500) ?? "", stars: Number.isSafeInteger(entry.stargazers_count) ? entry.stargazers_count : null, archived: entry.archived === true };
    });
    this.binding.library.guard(entries);
    await this.emit("AikoHarnessSourceDiscoveryRecorded", operationId, { queryDigest: identity, entries, coverage: "first-page", incomplete: result.value.incomplete_results === true, total: result.value.total_count ?? null, receipt: result.receipt });
    return (await this.journal.read()).find(e => e.type === "AikoHarnessSourceDiscoveryRecorded" && e.owner === this.binding.library.owner && e.id === operationId)!;
  }
  async ingest(raw: SourceIngestInput, signal: AbortSignal) {
    const input = structuredClone(raw), repo = repository(input.repository);
    this.binding.library.guard(input);
    need(idPattern.test(input.operationId) && typeof input.ref === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(input.ref) && !input.ref.includes(".."), "Invalid source identity or revision");
    need(Array.isArray(input.paths) && input.paths.length > 0 && input.paths.length <= 24 && input.paths.every(sourcePath) && sourcePath(input.licensePath) && /^licen[sc]e(?:[._-].*)?$/i.test(input.licensePath.split("/").at(-1)!), "Explicit bounded source and license paths required");
    need(Number.isSafeInteger(input.expectedGeneration) && input.expectedGeneration >= 0, "Source generation required");
    const paths = [...new Set([...input.paths, input.licensePath])].sort();
    const requestDigest = harnessDigest({ ...input, repository: repo, paths });
    const prior = (await this.journal.read()).find(e => e.type === "AikoHarnessSourceIngested" && e.owner === this.binding.library.owner && e.id === input.operationId);
    if (prior) { need(prior.requestDigest === requestDigest, "Source ingestion identity conflict"); return prior; }
    await this.permit(repo, "ingest", signal);
    await this.emit("AikoHarnessSourceIngestStarted", input.operationId, { requestDigest });
    const start = (await this.journal.read()).find(e => e.type === "AikoHarnessSourceIngestStarted" && e.owner === this.binding.library.owner && e.id === input.operationId);
    need(start?.requestDigest === requestDigest, "Source ingestion identity conflict");
    const commit = await this.read(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(input.ref)}`, `${input.operationId}:commit`, signal);
    need(object(commit.value) && sha1.test(commit.value.sha), "Resolved commit SHA required");
    const revision: string = commit.value.sha, receipts = [commit.receipt];
    const metadata = await this.read(`https://api.github.com/repos/${repo}`, `${input.operationId}:metadata`, signal);
    need(object(metadata.value) && repository(metadata.value.full_name) === repo, "Repository identity mismatch"); receipts.push(metadata.receipt);
    let registryUri: string | null = null, registryRef: HarnessDigest | null = null;
    if (input.registryUri) {
      const url = new URL(input.registryUri);
      need(url.protocol === "https:" && ["skills.sh", "www.skills.sh"].includes(url.hostname) && !url.port && !url.username && !url.password && !url.search && !url.hash, "Invalid skills.sh source");
      const segments = url.pathname.split("/").filter(Boolean);
      need(segments.length === 3 && repository(segments.slice(0, 2).join("/")) === repo && /^[a-z0-9][a-z0-9-]{0,63}$/.test(segments[2]!), "Skill source repository mismatch");
      need(paths.some(path => path.endsWith("SKILL.md")), "Skill source must retain SKILL.md");
      registryUri = url.href;
      const page = await this.read(registryUri, `${input.operationId}:registry`, signal);
      need(typeof page.value === "string" && page.value.length > 0, "Skill registry evidence required");
      registryRef = await this.binding.library.blobs.put(this.binding.library.owner, page.value); receipts.push(page.receipt);
    }
    const files: SourceFile[] = [];
    let bytes = 0;
    for (const [index, path] of paths.entries()) {
      const item = await this.read(`https://api.github.com/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${revision}`, `${input.operationId}:file:${index}`, signal);
      need(object(item.value) && item.value.type === "file" && item.value.path === path && item.value.encoding === "base64" && typeof item.value.content === "string" && sha1.test(item.value.sha), "Pinned regular GitHub file required");
      const buffer = Buffer.from(item.value.content, "base64");
      need(buffer.length === item.value.size && buffer.length <= 65536 && (bytes += buffer.length) <= 196608, "Source file byte limit or size mismatch");
      const blob = createHash("sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex");
      need(blob === item.value.sha, "Git blob integrity mismatch");
      // Round-trip validation works on the Worker and Bun runtimes and preserves
      // a leading BOM, which belongs to the pinned source bytes.
      const content = buffer.toString("utf8");
      need(Buffer.from(content, "utf8").equals(buffer), "Source file must be valid UTF-8");
      this.binding.library.guard(content);
      const digest = harnessDigest(content), contentRef = await this.binding.library.blobs.put(this.binding.library.owner, content);
      files.push({ path, digest, gitBlob: blob, bytes: buffer.length, contentRef }); receipts.push(item.receipt);
    }
    const license = files.find(f => f.path === input.licensePath)!;
    need(license.bytes > 0, "Empty license evidence");
    // Repository metadata describes its current default branch. Resolve license
    // classification at the selected commit and require the same retained blob.
    let declared = "NOASSERTION";
    try {
      const evidence = await this.read(`https://api.github.com/repos/${repo}/license?ref=${revision}`, `${input.operationId}:license`, signal);
      if (object(evidence.value) && evidence.value.path === license.path && evidence.value.sha === license.gitBlob && typeof evidence.value.license?.spdx_id === "string") declared = evidence.value.license.spdx_id;
      receipts.push(evidence.receipt);
    } catch { signal.throwIfAborted(); /* Retained license bytes remain available; classification is explicitly unknown. */ }
    const snapshot: SourceSnapshot = { version: 1, repository: repo, revision, kind: registryUri ? "skills.sh" : "github", registryUri, registryRef, files, license: { path: license.path, digest: license.digest, declared }, requestedPaths: paths, coverage: "selected-files", receipts };
    const snapshotDigest = await this.binding.library.blobs.put(this.binding.library.owner, snapshot);
    await this.permit(repo, "ingest", signal); signal.throwIfAborted();
    await this.emit("AikoHarnessSourceObserved", snapshotDigest, { sourceId: sourceId(repo), repository: repo, revision, kind: snapshot.kind, snapshotDigest, files: files.map(({ contentRef, ...f }) => f), license: snapshot.license, coverage: snapshot.coverage });
    const id = `${sourceId(repo)}:${input.expectedGeneration}`;
    const state = harnessSourceState(await this.journal.read(), this.binding.library.owner), current = state.heads.get(sourceId(repo));
    if (current?.snapshotDigest !== snapshotDigest) {
      need((current?.generation ?? 0) === input.expectedGeneration, "Source generation conflict");
      await this.permit(repo, "ingest", signal); signal.throwIfAborted();
      await this.emit("AikoHarnessSourceHeadChanged", id, { sourceId: sourceId(repo), snapshotDigest, previousGeneration: input.expectedGeneration, generation: input.expectedGeneration + 1 });
    }
    need(harnessSourceState(await this.journal.read(), this.binding.library.owner).heads.get(sourceId(repo))?.snapshotDigest === snapshotDigest, "Source head changed concurrently");
    await this.emit("AikoHarnessSourceIngested", input.operationId, { requestDigest, snapshotDigest, sourceId: sourceId(repo), revision });
    return (await this.journal.read()).find(e => e.type === "AikoHarnessSourceIngested" && e.owner === this.binding.library.owner && e.id === input.operationId)!;
  }
  async snapshot(digest: HarnessDigest): Promise<SourceSnapshot> {
    need(harnessSourceState(await this.journal.read(), this.binding.library.owner).snapshots.has(digest), "Owned source snapshot unavailable");
    const value = await this.binding.library.blobs.get(this.binding.library.owner, digest);
    need(object(value) && value.version === 1 && value.coverage === "selected-files" && Array.isArray(value.files), "Retained source snapshot invalid");
    return value as SourceSnapshot;
  }
  async inspect(digest: HarnessDigest, paths?: string[]) {
    const snapshot = await this.snapshot(digest);
    const selected = paths ?? snapshot.files.filter(f => /(?:^|\/)(?:SKILL\.md|README(?:\.md)?|package\.json)$/i.test(f.path)).map(f => f.path);
    need(Array.isArray(selected) && selected.length <= 8 && selected.every(sourcePath), "Bounded inspection required");
    const files = [];
    for (const path of selected) {
      const file = snapshot.files.find(f => f.path === path); need(file, "Source path was not inspected at this revision");
      files.push({ path, content: await this.binding.library.blobs.get(this.binding.library.owner, file.contentRef) });
    }
    return { repository: snapshot.repository, revision: snapshot.revision, coverage: snapshot.coverage, license: snapshot.license, trust: "external-procedural-guidance", files };
  }
  async derive(digest: HarnessDigest, options: { name: string; description: string; contractDigest: HarnessDigest; kind: "code" | "network"; entrypoint: string; modules?: string[]; exportName?: string; argumentKeys?: string[]; actionId?: string }, signal: AbortSignal) {
    options = structuredClone(options);
    const snapshot = await this.snapshot(digest);
    await this.permit(snapshot.repository, "derive", signal);
    need(sourcePath(options.entrypoint), "Selected source entrypoint required");
    const paths = [...new Set([options.entrypoint, ...(options.modules ?? [])])];
    need(paths.length <= 24 && paths.every(sourcePath), "Bounded module closure required");
    const files: Record<string, string> = Object.create(null), selected: SourceFile[] = [];
    for (const path of paths) {
      const file = snapshot.files.find(f => f.path === path); need(file, "Uninspected dependency");
      const content = await this.binding.library.blobs.get(this.binding.library.owner, file.contentRef); need(typeof content === "string" && harnessDigest(content) === file.digest, "Source content unavailable");
      files[path] = content; selected.push(file);
    }
    let entrypoint: string, runtime: HarnessArtifact["runtime"];
    if (options.kind === "network") {
      need(paths.length === 1 && typeof options.actionId === "string", "One network graph and action required");
      const parsed = JSON.parse(files[options.entrypoint]!);
      const draft = object(parsed) && typeof parsed.openapi === "string" ? deriveOpenApiAction(parsed, options.actionId) : undefined;
      if (draft?.status === "unresolved") {
        await this.permit(snapshot.repository, "derive", signal); signal.throwIfAborted();
        await this.emit("AikoHarnessSourceDraftRecorded", harnessDigest([digest, options]), { snapshotDigest: digest, status: "unresolved", unresolved: draft.unresolved, operationId: options.actionId });
        return { status: "unresolved" as const, snapshotDigest: digest, unresolved: draft.unresolved };
      }
      const graph = draft?.graph ?? validateSiteHarnessArtifact(parsed), actionId = draft?.actionId ?? options.actionId;
      need(graph.actions.some(a => a.id === actionId), "Network action unavailable");
      entrypoint = "network.json"; runtime = "network";
      for (const path of Object.keys(files)) delete files[path];
      files[entrypoint] = JSON.stringify({ graph, actionId });
    } else {
      need(options.kind === "code" && paths.every(p => /\.(?:m?js)$/.test(p)), "Only pinned JavaScript modules can derive code");
      const name = options.exportName ?? "default", args = options.argumentKeys ?? [];
      need(/^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/.test(name) && !["constructor", "__proto__", "prototype"].includes(name) && args.length <= 16 && args.every(k => /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(k) && !["constructor", "prototype"].includes(k)), "Invalid export or argument mapping");
      entrypoint = "__registry_entry__.js"; runtime = "javascript";
      need(!Object.hasOwn(files, entrypoint), "Reserved registry wrapper path");
      files[entrypoint] = `import * as source from ${JSON.stringify(options.entrypoint)};\nexport default async input => { const run = source[${JSON.stringify(name)}]; if (typeof run !== "function") throw Error("Selected export is not callable"); return await run(${args.length ? args.map(k => `input[${JSON.stringify(k)}]`).join(", ") : "input"}); };`;
    }
    const artifact: HarnessArtifact = { version: 1, name: options.name, description: options.description, runtime, entrypoint, files, contractDigest: options.contractDigest,
      dependencies: Object.entries(files).filter(([path]) => path !== entrypoint).map(([name, code]) => ({ name, digest: harnessDigest(code) })),
      sources: selected.map(file => ({ uri: `https://github.com/${snapshot.repository}/blob/${snapshot.revision}/${file.path}`, revision: snapshot.revision, digest: file.digest, license: snapshot.license.declared })) };
    await this.permit(snapshot.repository, "derive", signal); signal.throwIfAborted();
    const harnessDigestValue = await this.library.record(artifact);
    await this.permit(snapshot.repository, "derive", signal); signal.throwIfAborted();
    await this.emit("AikoHarnessSourceCandidateDerived", harnessDigestValue, { harnessDigest: harnessDigestValue, sourceId: sourceId(snapshot.repository), snapshotDigest: digest, dependencies: selected.map(f => ({ path: f.path, digest: f.digest })), licenseDigest: snapshot.license.digest });
    return { harnessDigest: harnessDigestValue, status: "candidate" as const, snapshotDigest: digest };
  }
  async catalog() {
    const state = harnessSourceState(await this.journal.read(), this.binding.library.owner);
    return { heads: [...state.heads.values()], candidates: [...state.derived.values()] };
  }
}

function sourceStatePin(state: ReturnType<typeof harnessSourceState>, artifactDigest: HarnessDigest) {
  const source = state.derived.get(artifactDigest);
  return harnessDigest([source ?? null, source ? state.heads.get(String(source.sourceId)) ?? null : null]);
}
/** Retained source relation and current head used by an eligibility query. A
 * caller can fence later awaits without hydrating the same snapshot again. */
export function harnessSourcePin(events: readonly Event[], owner: string, artifactDigest: HarnessDigest) {
  return sourceStatePin(harnessSourceState(events, owner), artifactDigest);
}

/** Wrap the host binding before mounting its library tools. Each new dispatch
 * rechecks just the candidate's dependency leaves; in-flight jobs remain pinned. */
export function sourceAwareHarnessBinding(binding: HarnessLibraryBinding, journal: HarnessJournal): HarnessLibraryBinding {
  const eligible = async (artifact: HarnessArtifact) => {
    const artifactDigest = harnessDigest(artifact);
    const state = harnessSourceState(await journal.read(), binding.owner), source = state.derived.get(artifactDigest);
    if (!source) return !artifact.sources.some(s => { try { return new URL(s.uri).hostname.toLowerCase() === "github.com"; } catch { return false; } });
    const head = state.heads.get(String(source.sourceId)); if (!head) return false;
    const snapshot = await binding.blobs.get(binding.owner, head.snapshotDigest as HarnessDigest) as SourceSnapshot;
    // Blob hydration can await remote custody. Its content is immutable, but
    // the source relation/head that made it current can change during the read.
    if (sourceStatePin(state, artifactDigest) !== harnessSourcePin(await journal.read(), binding.owner, artifactDigest)) return false;
    return source.licenseDigest === snapshot.license.digest && (source.dependencies as { path: string; digest: string }[]).every(d => snapshot.files.some(f => f.path === d.path && f.digest === d.digest));
  };
  return { ...binding,
    authorize: async (a, c, x, i, signal) => {
      if (signal.aborted || !await eligible(a) || !await binding.authorize(a, c, x, i, signal)) return false;
      // Host authorization may await a remote policy/context read. A source head
      // can change in that interval; recheck the pinned dependency leaves before
      // returning eligibility to acquisition, promotion or notification callers.
      const current = await eligible(a);
      return !signal.aborted && current;
    },
    execute: async (input, signal) => { need(await eligible(input.artifact), "Source dependency changed; revalidation required"); return binding.execute(input, signal); },
  };
}

export function harnessSourceTools(binding: HarnessSourceBinding): NativeTool<Self | EventLog>[] {
  const text = { type: "string" }, integer = { type: "integer", minimum: 0 }, paths = { type: "array", items: text, maxItems: 24 };
  const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
  const shapes = {
    discover: schema({ query: text, operationId: text }, ["query", "operationId"]),
    ingest: schema({ repository: text, ref: text, paths, licensePath: text, registryUri: text, operationId: text, expectedGeneration: integer }, ["repository", "ref", "paths", "licensePath", "operationId", "expectedGeneration"]),
    inspect: schema({ snapshotDigest: text, paths }, ["snapshotDigest"]),
    derive: schema({ snapshotDigest: text, options: schema({ name: text, description: text, contractDigest: text, kind: { enum: ["code", "network"] }, entrypoint: text, modules: paths, exportName: text, argumentKeys: paths, actionId: text }, ["name", "description", "contractDigest", "kind", "entrypoint"]) }, ["snapshotDigest", "options"]),
    catalog: schema({}, []),
  };
  return (["discover", "ingest", "inspect", "derive", "catalog"] as const).map(method => ({
    spec: { name: `harness_source_${method}`, description: `Source ${method}: immutable scoped registry evidence and candidates. External guidance cannot grant authority; derived code must pass the existing contract evaluation before promotion.`, inputSchema: shapes[method] },
    run: (input: unknown) => Effect.gen(function* () {
      const self = yield* Self, log = yield* EventLog;
      if (self.actor !== "aiko" || self.thread !== binding.library.thread || !object(input) || !new Validator(shapes[method] as never).validate(input).valid) return { status: "rejected" };
      const sources = new HarnessSources(binding, { read: () => Effect.runPromise(log.read), append: events => Effect.runPromise(log.append(events)).then(() => undefined) });
      return yield* Effect.tryPromise({ try: async (signal): Promise<unknown> => {
        if (method === "discover") return sources.discover(input.query, input.operationId, signal);
        if (method === "ingest") return sources.ingest(input as SourceIngestInput, signal);
        if (method === "inspect") return sources.inspect(input.snapshotDigest, input.paths);
        if (method === "derive") return sources.derive(input.snapshotDigest, input.options, signal);
        return sources.catalog();
      }, catch: () => Error("Source operation failed; inspect retained receipts before retrying") }).pipe(Effect.catch(() => Effect.succeed({ status: "failed" })));
    }),
  }));
}

/** One native package surface: source operations and execution share the current
 * actor's journal. This prevents an accidental mount of unguarded library tools
 * or a source policy looking at a different, process-local event collection. */
export function harnessRegistryTools(binding: HarnessSourceBinding): NativeTool<Self | EventLog>[] {
  const tools = harnessLibraryTools(binding.library).map((tool): NativeTool<Self | EventLog> => ({
    spec: tool.spec,
    run: (input, context) => Effect.gen(function* () {
      const log = yield* EventLog;
      const journal: HarnessJournal = { read: () => Effect.runPromise(log.read), append: events => Effect.runPromise(log.append(events)).then(() => undefined) };
      const guarded = sourceAwareHarnessBinding(binding.library, journal);
      const native = harnessLibraryTools(guarded).find(candidate => candidate.spec.name === tool.spec.name)!;
      return yield* native.run(input, context);
    }),
  }));
  return [...tools, ...harnessSourceTools(binding)];
}
