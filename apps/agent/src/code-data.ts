import { createHash } from "node:crypto";
import type { Event } from "tardie/core/event";
import type { HarnessBlobStore, HarnessDigest } from "./harness-library.ts";
import type { CodeResultScope } from "./code-harness.ts";
import { sandboxCanonical } from "./sandbox-job.ts";

export interface CodeDataHandle {
  kind: "aiko-data.v1";
  owner: string;
  thread: string;
  ref: HarnessDigest;
  bytes: number;
  type: string;
}
type Manifest = {
  kind: "aiko-data-manifest.v1";
  owner: string;
  thread: string;
  bytes: number;
  type: string;
  chunks: HarnessDigest[];
  sources: CodeResultScope[];
};
export interface CodeDataBinding {
  owner: string;
  thread: string;
  blobs: HarnessBlobStore;
  read(): Promise<readonly Event[]>;
  append(events: Event[]): Promise<unknown>;
  current(): Promise<boolean>;
  authorizeSource(scope: CodeResultScope): Promise<boolean>;
  redact(value: string): string;
}
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const MAX_BYTES = 32 * 1024 * 1024,
  CHUNK_BYTES = 32 * 1024,
  RESULT_BYTES = 64 * 1024;
const denied =
  "Working data is unavailable under the current account or source authority";
const nameOf = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_.-]{0,95}$/.test(value)
  )
    throw Error("Use a working binding name of 1–96 identifier characters");
  return value;
};
const int = (value: unknown, fallback: number, max: number) => {
  const n = value ?? fallback;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > max)
    throw Error("Invalid data query bound");
  return n;
};
const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);
/** JSON Pointer over own properties only; no expression evaluation or prototype traversal. */
export function codeDataPointer(value: unknown, path: unknown): unknown {
  if (path === undefined || path === "") return value;
  if (typeof path !== "string" || path.length > 2048 || !path.startsWith("/"))
    throw Error("Use an RFC 6901 JSON pointer");
  let result = value;
  for (const encoded of path.slice(1).split("/")) {
    if (/~(?![01])/.test(encoded)) throw Error("Invalid JSON pointer escape");
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (["__proto__", "prototype", "constructor"].includes(key))
      throw Error("Prototype paths are not supported");
    if (!result || typeof result !== "object" || !Object.hasOwn(result, key))
      return undefined;
    result = (result as Record<string, unknown>)[key];
  }
  return result;
}
function queryValue(value: unknown, args: Record<string, any>) {
  let selected = codeDataPointer(value, args.path);
  if (args.filter !== undefined) {
    if (
      !Array.isArray(selected) ||
      !object(args.filter) ||
      Object.keys(args.filter).some(
        (k) => !["path", "op", "value"].includes(k),
      ) ||
      !["eq", "ne", "contains", "gt", "gte", "lt", "lte"].includes(
        args.filter.op,
      )
    )
      throw Error("Filter requires an array and a supported comparison");
    const { path, op, value: expected } = args.filter;
    selected = selected.filter((row) => {
      const actual = codeDataPointer(row, path);
      if (op === "eq" || op === "ne") {
        const equal =
          sandboxCanonical(actual ?? null) ===
          sandboxCanonical(expected ?? null);
        return op === "eq" ? equal : !equal;
      }
      if (op === "contains")
        return (
          typeof actual === "string" &&
          typeof expected === "string" &&
          actual.includes(expected)
        );
      if (typeof actual !== "number" || typeof expected !== "number")
        return false;
      return op === "gt"
        ? actual > expected
        : op === "gte"
          ? actual >= expected
          : op === "lt"
            ? actual < expected
            : actual <= expected;
    });
  }
  const total =
    Array.isArray(selected) || typeof selected === "string"
      ? selected.length
      : selected === undefined
        ? 0
        : 1;
  if (args.count === true) return { count: total };
  const offset = int(args.offset, 0, MAX_BYTES),
    limit = int(
      args.limit,
      Array.isArray(selected) ? 50 : 4096,
      Array.isArray(selected) ? 256 : 16384,
    );
  if (Array.isArray(selected) || typeof selected === "string")
    selected = selected.slice(offset, offset + limit);
  if (args.fields !== undefined) {
    if (
      !Array.isArray(args.fields) ||
      args.fields.length > 64 ||
      args.fields.some((path: unknown) => typeof path !== "string")
    )
      throw Error("Use up to 64 projection pointers");
    const project = (row: unknown) =>
      Object.fromEntries(
        args.fields.map((path: string) => [
          path,
          codeDataPointer(row, path) ?? null,
        ]),
      );
    selected = Array.isArray(selected)
      ? selected.map(project)
      : project(selected);
  }
  const result = {
    value: selected ?? null,
    total,
    offset,
    nextOffset: Math.min(total, offset + limit) < total ? offset + limit : null,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > RESULT_BYTES)
    throw Error("Query exceeds 64 KiB; select fewer fields or a smaller slice");
  return result;
}

export function codeDataEventKey(event: Event): string | undefined {
  if (typeof event.owner !== "string" || typeof event.thread !== "string")
    return;
  const scope = hash([event.owner, event.thread]);
  if (event.type === "AikoCodeDataRetained" && typeof event.ref === "string")
    return `aiko-code-data:retained:${scope}:${event.ref}`;
  if (
    event.type === "AikoCodeDataRead" &&
    typeof event.callId === "string" &&
    typeof event.ref === "string"
  )
    return `aiko-code-data:read:${scope}:${hash([event.callId, event.ref])}`;
  if (
    event.type === "AikoCodeBindingChanged" &&
    typeof event.nameHash === "string" &&
    Number.isSafeInteger(event.generation)
  )
    return `aiko-code-data:binding:${scope}:${event.nameHash}:${event.generation}`;
}

/** Data operations use the native package journal. Blobs are private immutable payloads, never execution state. */
export class CodeData {
  constructor(readonly binding: CodeDataBinding) {}
  private async current() {
    if (!(await this.binding.current())) throw Error(denied);
  }
  private async manifest(handle: CodeDataHandle): Promise<Manifest> {
    await this.current();
    const { owner, thread } = this.binding;
    if (
      handle?.kind !== "aiko-data.v1" ||
      handle.owner !== owner ||
      handle.thread !== thread ||
      !/^sha256:[a-f0-9]{64}$/.test(handle.ref)
    )
      throw Error(denied);
    const rows = await this.binding.read();
    if (
      !rows.some(
        (e) =>
          e.type === "AikoCodeDataRetained" &&
          e.owner === owner &&
          e.thread === thread &&
          e.ref === handle.ref,
      )
    )
      throw Error(denied);
    const value = (await this.binding.blobs.get(owner, handle.ref)) as Manifest;
    if (
      value?.kind !== "aiko-data-manifest.v1" ||
      value.owner !== owner ||
      value.thread !== thread ||
      value.bytes !== handle.bytes ||
      value.type !== handle.type ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 0 ||
      value.bytes > MAX_BYTES ||
      !Array.isArray(value.chunks) ||
      value.chunks.length > MAX_BYTES / CHUNK_BYTES ||
      value.chunks.some(
        (ref) => typeof ref !== "string" || !/^sha256:[a-f0-9]{64}$/.test(ref),
      ) ||
      !Array.isArray(value.sources) ||
      value.sources.length > 1024
    )
      throw Error(denied);
    for (const source of value.sources)
      if (!(await this.binding.authorizeSource(source))) throw Error(denied);
    await this.current();
    return value;
  }
  async authorize(handle: CodeDataHandle) {
    await this.manifest(handle);
  }
  async sources(handle: CodeDataHandle) {
    return (await this.manifest(handle)).sources;
  }
  async retain(
    value: unknown,
    callId: string,
    sources: CodeResultScope[] = [],
  ): Promise<CodeDataHandle> {
    await this.current();
    const encoded = JSON.stringify(value ?? null);
    if (this.binding.redact(encoded) !== encoded)
      throw Error("Sensitive data cannot be retained in working bindings");
    const bytes = new TextEncoder().encode(encoded);
    if (bytes.length > MAX_BYTES)
      throw Error("Working value exceeds 32 MiB; partition the source");
    const unique = [
      ...new Map(sources.map((source) => [hash(source), source])).values(),
    ];
    if (unique.length > 1024)
      throw Error(
        "Working value has too many source dependencies; partition the source",
      );
    for (const source of unique)
      if (!(await this.binding.authorizeSource(source))) throw Error(denied);
    const dependencies = [...new Set(unique.flatMap(source => source.dependencies ?? []))];
    const chunks: HarnessDigest[] = [];
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      await this.current();
      chunks.push(
        await this.binding.blobs.putPrivate(this.binding.owner, {
          kind: "aiko-data-chunk.v1",
          data: Buffer.from(
            bytes.subarray(offset, offset + CHUNK_BYTES),
          ).toString("base64"),
        }, dependencies),
      );
    }
    const type = Array.isArray(value)
      ? "array"
      : value === null
        ? "null"
        : typeof value;
    const manifest: Manifest = {
      kind: "aiko-data-manifest.v1",
      owner: this.binding.owner,
      thread: this.binding.thread,
      bytes: bytes.length,
      type,
      chunks,
      sources: unique,
    };
    const ref = await this.binding.blobs.putPrivate(
      this.binding.owner,
      manifest,
      dependencies,
    );
    await this.current();
    await this.binding.append([
      {
        type: "AikoCodeDataRetained",
        owner: this.binding.owner,
        thread: this.binding.thread,
        callId,
        ref,
        bytes: bytes.length,
        dependencies: unique.map((source) => ({
          tool: source.tool,
          digest: source.definitionDigest,
        })),
        at: Date.now(),
      },
    ]);
    return {
      kind: "aiko-data.v1",
      owner: this.binding.owner,
      thread: this.binding.thread,
      ref,
      bytes: bytes.length,
      type,
    };
  }
  async query(
    handle: CodeDataHandle,
    args: Record<string, any>,
    callId: string,
  ) {
    const manifest = await this.manifest(handle),
      parts: Uint8Array[] = [];
    let size = 0;
    for (const ref of manifest.chunks) {
      const chunk = (await this.binding.blobs.get(this.binding.owner, ref)) as {
        kind: string;
        data: string;
      };
      if (
        chunk?.kind !== "aiko-data-chunk.v1" ||
        typeof chunk.data !== "string"
      )
        throw Error(denied);
      const bytes = new Uint8Array(Buffer.from(chunk.data, "base64"));
      size += bytes.length;
      if (bytes.length > CHUNK_BYTES || size > manifest.bytes)
        throw Error(denied);
      parts.push(bytes);
    }
    if (size !== manifest.bytes) throw Error(denied);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    const result = queryValue(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes,
        ),
      ),
      args,
    );
    await this.manifest(handle);
    await this.binding.append([
      {
        type: "AikoCodeDataRead",
        owner: this.binding.owner,
        thread: this.binding.thread,
        callId,
        ref: handle.ref,
        sources: manifest.sources,
        at: Date.now(),
      },
    ]);
    return result;
  }
  private async head(name: string) {
    const nameHash = hash([this.binding.owner, this.binding.thread, name]);
    const rows = await this.binding.read();
    let head: Event | undefined;
    for (const event of rows)
      if (
        event.type === "AikoCodeBindingChanged" &&
        event.owner === this.binding.owner &&
        event.thread === this.binding.thread &&
        event.nameHash === nameHash &&
        event.generation === Number(head?.generation ?? 0) + 1
      )
        head = event;
    return { head, nameHash };
  }
  async bind(
    name: unknown,
    handle: CodeDataHandle | undefined,
    expected: unknown,
    callId: string,
  ) {
    await this.current();
    const key = nameOf(name);
    if (this.binding.redact(key) !== key) throw Error("Invalid binding name");
    if (handle) await this.manifest(handle);
    const { head, nameHash } = await this.head(key),
      previous = Number(head?.generation ?? 0),
      expectedGeneration = int(expected, 0, Number.MAX_SAFE_INTEGER);
    if (head?.callId === callId) return this.load(key);
    if (expectedGeneration !== previous)
      throw Error(`Binding conflict: current generation ${previous}`);
    const descriptor = await this.binding.blobs.putPrivate(this.binding.owner, {
      name: key,
      handle: handle ?? null,
    });
    const event: Event = {
      type: "AikoCodeBindingChanged",
      owner: this.binding.owner,
      thread: this.binding.thread,
      callId,
      nameHash,
      generation: previous + 1,
      descriptor,
      at: Date.now(),
    };
    await this.current();
    await this.binding.append([event]);
    const committed = (await this.head(key)).head;
    if (committed?.callId !== callId)
      throw Error("Concurrent binding update won; reload before replacing it");
    return { name: key, generation: previous + 1, handle: handle ?? null };
  }
  async load(name: unknown, callId?: string) {
    await this.current();
    const key = nameOf(name),
      { head } = await this.head(key);
    if (!head) return { name: key, generation: 0, handle: null };
    const data = (await this.binding.blobs.get(
      this.binding.owner,
      head.descriptor as HarnessDigest,
    )) as { name: string; handle: CodeDataHandle | null };
    if (data?.name !== key) throw Error(denied);
    if (data.handle) {
      const manifest = await this.manifest(data.handle);
      if (callId)
        await this.binding.append([
          {
            type: "AikoCodeDataRead",
            owner: this.binding.owner,
            thread: this.binding.thread,
            callId,
            ref: data.handle.ref,
            sources: manifest.sources,
            at: Date.now(),
          },
        ]);
    }
    await this.current();
    return {
      name: key,
      generation: Number(head.generation),
      handle: data.handle,
    };
  }
}
