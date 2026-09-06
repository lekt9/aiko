import { realpathSync } from "node:fs";
import { Memory as NativeMemory, type MemoryOptions as NativeMemoryOptions } from "./memory-core.js";
import { nodeStorage } from "./storage-node.js";
import { readFileSource } from "./sources-node.js";
import { text } from "./codec.js";

/** Backwards-compatible local-file entry point. Cloudflare hosts use entity-learn/cloudflare. */
export interface MemoryOptions extends Omit<NativeMemoryOptions, "storage" | "files"> { path: string }
export class Memory extends NativeMemory {
  constructor(options: MemoryOptions) {
    text(options.scope, "scope", 256);
    const storage = nodeStorage(options.path);
    try {
      super({ ...options, storage, files: { canonicalPath: realpathSync, read: readFileSource } });
    } catch (error) { storage.close(); throw error; }
  }
}
