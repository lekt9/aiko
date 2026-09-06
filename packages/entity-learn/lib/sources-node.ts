import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { fail, safePayload } from "./codec.js";
import type { Source, SourceResult } from "./types.js";

export async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
  // NONBLOCK prevents opening a FIFO from hanging before the regular-file check.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) fail("too_large", "Source is not a bounded regular file");
    const bytes = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    if (size > maxBytes) fail("too_large", "Source grew beyond the read budget");
    return bytes.subarray(0, size);
  } finally { await file.close(); }
}
export async function readFileSource(source: Source, maxBytes: number): Promise<SourceResult> {
  if (await realpath(source.locator) !== source.locator) fail("source_moved", "Registered file path changed; register its canonical location again");
  const content = new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedFile(source.locator, maxBytes));
  let data: unknown;
  if (source.format === "text") data = { text: content };
  else if (source.format === "jsonl") data = content.split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
  else data = JSON.parse(content);
  return { data: safePayload(data) };
}
