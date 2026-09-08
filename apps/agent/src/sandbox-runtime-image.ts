import { dlopen, FFIType } from "bun:ffi";
import { createHash } from "node:crypto";
import { createDeflateRaw } from "node:zlib";
import { Readable } from "node:stream";
import { closeSync, constants, fchmodSync, fstatSync, openSync, writeSync } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { sandboxDigest, type SandboxDigest } from "./sandbox-job.ts";

// Trusted Linux supervisor primitives. No candidate can load host FFI through
// this adapter. A sealed memfd cannot be changed even through another open fd.
const libc = dlopen("libc.so.6", {
  memfd_create: { args: [FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
  fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  pipe2: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
});
const SEALS = 15, F_ADD_SEALS = 1033, F_GET_SEALS = 1034, O_CLOEXEC = 0x80000;
const safeClose = (fd: number) => { try { closeSync(fd); } catch { /* already released */ } };
const finalize = new FinalizationRegistry<Set<number>>(fds => { for (const fd of fds) safeClose(fd); });

export function resourceGate(): { read: number; write: number; release(): void; close(): void } {
  const fds = new Int32Array(2);
  if (libc.symbols.pipe2(fds, O_CLOEXEC) !== 0) throw Error("Resource admission pipe unavailable");
  let closed = false;
  return { read: fds[0]!, write: fds[1]!,
    release() { if (closed) throw Error("Resource admission pipe closed"); writeSync(fds[1]!, Buffer.from([1])); },
    close() { if (!closed) { closed = true; safeClose(fds[0]!); safeClose(fds[1]!); } },
  };
}
type ImageFile = { fd: number; bytes: number; storedBytes: number; encoding: "raw" | "deflate"; digest: SandboxDigest; mode: number };
export type ImageEntry = Omit<ImageFile, "fd"> & { path: string };

/** Captured guest bytes, not a mutable host pathname cache. Each launch gets
 * independent read offsets. Runtime files may be streamed into deflate storage;
 * source digests and capacity limits always describe the expanded bytes. Only
 * the checked, cgroup-admitted supervisor can expand compressed leases.
 * The trusted supervisor materializes these bytes
 * into a private guest snapshot; source package/model replacement cannot affect
 * it. Bubblewrap then mounts that snapshot read-only for candidate execution. */
export class SealedRuntimeImage {
  private readonly files = new Map<string, ImageFile>();
  private readonly directories = new Set<string>();
  private readonly fds = new Set<number>();
  private total = 0;
  private readonly pending = new Map<string, number>();
  // File capture is sequential for trees. Reuse a bounded streaming buffer
  // instead of leaving one 256 KiB external allocation per file for GC.
  private readBuffer?: Buffer;
  private frozen = false;
  private closed = false;
  constructor(readonly maxBytes = 2 * 1024 ** 3, readonly maxFiles = 16384, readonly compressFiles = false) { finalize.register(this, this.fds, this); }
  private target(path: string) {
    if (!path.startsWith("/") || path.includes("\0") || resolve(path) !== path || path === "/") throw Error("Invalid immutable image path");
    if (this.frozen || this.closed) throw Error("Immutable image is not writable");
    let parent = dirname(path);
    while (parent !== "/") {
      if (this.files.has(parent) || this.pending.has(parent)) throw Error("Immutable image parent is a file");
      this.directories.add(parent); parent = dirname(parent);
    }
    return path;
  }
  directory(path: string) {
    if (this.files.has(path) || this.pending.has(path)) throw Error("Immutable image directory conflicts with a file");
    this.directories.add(this.target(path));
  }
  private allocate(path: string, bytes: number) {
    this.target(path);
    const pendingBytes = [...this.pending.values()].reduce((sum, value) => sum + value, 0);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.files.has(path) || this.directories.has(path) || this.pending.has(path) || this.files.size + this.pending.size >= this.maxFiles || this.total + pendingBytes + bytes > this.maxBytes) throw Error("Immutable image capacity or path conflict");
    const fd = libc.symbols.memfd_create(Buffer.from("unlock-runtime\0"), 3);
    if (fd < 0) throw Error("Sealed runtime file unavailable");
    this.fds.add(fd);
    this.pending.set(path, bytes);
    return fd;
  }
  private retain(path: string, fd: number, bytes: number, digest: SandboxDigest, executable: boolean, encoding: "raw" | "deflate" = "raw", storedBytes = bytes) {
    if (this.frozen || this.closed || this.pending.get(path) !== bytes) throw Error("Immutable image capture is no longer active");
    const mode = executable ? 0o555 : 0o444;
    fchmodSync(fd, mode);
    if (libc.symbols.fcntl(fd, F_ADD_SEALS, SEALS) !== 0 || libc.symbols.fcntl(fd, F_GET_SEALS, 0) !== SEALS) throw Error("Immutable runtime sealing failed");
    this.files.set(path, { fd, bytes, storedBytes, encoding, digest, mode }); this.total += bytes; this.pending.delete(path);
  }
  async bytes(path: string, bytes: Uint8Array, executable = false) {
    const fd = this.allocate(path, bytes.byteLength);
    try {
      let at = 0;
      while (at < bytes.byteLength) at += writeSync(fd, bytes, at, bytes.byteLength - at);
      const digest: SandboxDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      this.retain(path, fd, bytes.byteLength, digest, executable); return digest;
    } catch (error) { this.pending.delete(path); if (this.fds.delete(fd)) safeClose(fd); throw error; }
  }
  async file(source: string, path: string, signal?: AbortSignal, sourceRoot?: string): Promise<SandboxDigest> {
    signal?.throwIfAborted();
    const input = await open(source, "r");
    let fd: number | undefined;
    const buffer = this.readBuffer ?? Buffer.allocUnsafe(256 * 1024);
    this.readBuffer = undefined;
    try {
      // Resolve the opened inode through its descriptor, so switching a file
      // symlink between a pathname check and open cannot escape the tree.
      if (sourceRoot) {
        const actual = await realpath(`/proc/self/fd/${input.fd}`), rel = relative(sourceRoot, actual);
        if (rel === ".." || rel.startsWith("../")) throw Error("Runtime file link escaped its declared tree");
      }
      const before = await input.stat({ bigint: true });
      if (!before.isFile()) throw Error("Runtime source must be a regular file");
      fd = this.allocate(path, Number(before.size));
      const hash = createHash("sha256");
      let at = 0;
      const image = this;
      async function* chunks() {
        while (true) {
          signal?.throwIfAborted();
          const { bytesRead } = await input.read(buffer, 0, buffer.length, at);
          if (image.closed) throw Error("Immutable runtime image disposed during capture");
          if (!bytesRead) break;
          if (at + bytesRead > Number(before.size)) throw Error("Runtime source changed while capturing");
          const chunk = buffer.subarray(0, bytesRead); hash.update(chunk); at += bytesRead;
          // The compressor may retain a chunk after requesting the next one.
          yield Buffer.from(chunk);
        }
      }
      const source = Readable.from(chunks());
      // Bun's level-1 fast encoder expands incompressible weights by ~5%;
      // level 2 uses bounded stored blocks for those inputs.
      const compressed = this.compressFiles ? createDeflateRaw({ level: 2 }) : undefined;
      const stream = compressed ? source.pipe(compressed) : source;
      source.on("error", error => stream.destroy(error));
      let storedBytes = 0;
      try {
        for await (const chunk of stream) {
          signal?.throwIfAborted();
          storedBytes += chunk.length;
          // Incompressible model weights can expand by more than 64 KiB.
          // Keep a proportional storage ceiling; the original-byte allocation
          // and checked decoder still enforce the independent expanded limit.
          if (storedBytes > Number(before.size) + Math.ceil(Number(before.size) / 100) + 65536) throw Error("Immutable compressed capacity exceeded");
          let written = 0; while (written < chunk.length) written += writeSync(fd, chunk, written, chunk.length - written);
        }
      } finally { source.destroy(); compressed?.destroy(); }
      const after = await input.stat({ bigint: true });
      if (at !== Number(before.size) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw Error("Runtime source changed while capturing");
      const digest: SandboxDigest = `sha256:${hash.digest("hex")}`;
      this.retain(path, fd, at, digest, (Number(before.mode) & 0o111) !== 0, this.compressFiles ? "deflate" : "raw", storedBytes); return digest;
    } catch (error) { if (fd !== undefined) { this.pending.delete(path); if (this.fds.delete(fd)) safeClose(fd); } throw error; }
    finally { await input.close(); if (!this.closed && !this.readBuffer) this.readBuffer = buffer; }
  }
  async tree(source: string, target: string, options: { omit?: string[]; omitBytecodeCache?: boolean; signal?: AbortSignal } = {}) {
    const base = await realpath(source);
    const visit = async (path: string, to: string, ancestors: Set<string>) => {
      options.signal?.throwIfAborted();
      const actual = await realpath(path);
      if (ancestors.has(actual)) throw Error("Runtime directory link cycle");
      if (actual !== base && (relative(base, actual).startsWith("../") || relative(base, actual) === "..")) throw Error("Runtime directory link escaped its declared tree");
      const before = await stat(path, { bigint: true }), chain = new Set([...ancestors, actual]);
      this.directory(to);
      for (const name of (await readdir(path)).sort()) {
        if (path === source && options.omit?.includes(name)) continue;
        // Python -B compiles retained source in memory. Cache directories are
        // disposable host artifacts, never part of the selected source closure.
        if (options.omitBytecodeCache && name === "__pycache__") continue;
        const child = join(path, name), destination = join(to, name), info = await stat(child);
        if (info.isDirectory()) await visit(child, destination, chain);
        else await this.file(child, destination, options.signal, base);
      }
      const after = await stat(path, { bigint: true });
      if (before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw Error("Runtime tree changed while capturing");
    };
    await visit(source, target, new Set());
  }
  entries(): ImageEntry[] { return [...this.files].sort(([a], [b]) => a.localeCompare(b)).map(([path, { fd: _, ...entry }]) => ({ path, ...entry })); }
  has(path: string) { return this.files.has(path); }
  directoryEntries() { return [...this.directories].sort((a, b) => a.length - b.length || a.localeCompare(b)); }
  async seal(): Promise<SandboxDigest> {
    if (this.pending.size) throw Error("Immutable runtime capture is still pending");
    this.frozen = true; this.check();
    return sandboxDigest({ version: 1, directories: [...this.directories].sort(), files: this.entries() });
  }
  check() {
    if (this.closed) throw Error("Immutable runtime image disposed");
    for (const file of this.files.values()) if (libc.symbols.fcntl(file.fd, F_GET_SEALS, 0) !== SEALS || fstatSync(file.fd).size !== file.storedBytes) throw Error("Immutable runtime image integrity lost");
  }
  lease(startFd: number) {
    if (!this.frozen) throw Error("Runtime image has not been sealed");
    this.check();
    const fds: number[] = [], args: string[] = [...this.directories].sort((a, b) => a.length - b.length || a.localeCompare(b)).flatMap(path => ["--dir", path]);
    try {
      for (const [path, file] of [...this.files].sort(([a], [b]) => a.localeCompare(b))) {
        const descriptor = openSync(`/proc/self/fd/${file.fd}`, constants.O_RDONLY | O_CLOEXEC);
        if (file.mode !== 0o444) args.push("--perms", file.mode.toString(8));
        args.push("--ro-bind-data", String(startFd + fds.length), path); fds.push(descriptor);
      }
      let released = false;
      const files = this.entries().map((entry, index) => ({ ...entry, fd: startFd + index }));
      return { fds, get args() { if (files.some(file => file.encoding !== "raw")) throw Error("Compressed image requires checked snapshot materialization"); return args; }, files, directories: this.directoryEntries(), release() { if (!released) { released = true; for (const fd of fds) safeClose(fd); } } };
    } catch (error) { for (const fd of fds) safeClose(fd); throw error; }
  }
  dispose() {
    if (!this.closed) {
      this.closed = true;
      this.readBuffer = undefined;
      // An asynchronous read still owns its capture descriptor. Let that
      // operation release it, preventing a late write to a reused fd number.
      for (const file of this.files.values()) if (this.fds.delete(file.fd)) safeClose(file.fd);
      finalize.unregister(this);
    }
  }
}
