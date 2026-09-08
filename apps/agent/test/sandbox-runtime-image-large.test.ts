import { test, expect } from 'bun:test';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { SealedRuntimeImage } from '../src/sandbox-runtime-image.ts';

test('large incompressible model closure stays bounded and exactly recoverable after source deletion', async () => {
  const dir = await mkdtemp('/tmp/image-large-');
  const size = 256 * 1024 ** 2;
  const image = new SealedRuntimeImage(size, 1, true);
  try {
    const file = await open(`${dir}/weights`, 'w');
    const hash = createHash('sha256');
    try {
      for (let i = 0; i < 256; i++) {
        const chunk = randomBytes(1024 ** 2);
        hash.update(chunk);
        await file.writeFile(chunk);
      }
    } finally { await file.close(); }
    const expected = `sha256:${hash.digest('hex')}` as const;
    expect(await image.file(`${dir}/weights`, '/weights')).toBe(expected);
    await image.seal();
    const entry = image.entries()[0]!;
    expect(entry.storedBytes).toBeGreaterThan(size + 65536);
    expect(entry.storedBytes).toBeLessThan(size + Math.ceil(size / 100) + 65536);
    await rm(dir, {recursive:true});
    const lease = image.lease(3);
    try {
      const recovered = inflateRawSync(readFileSync(`/proc/self/fd/${lease.fds[0]}`), {maxOutputLength:size});
      expect(recovered.length).toBe(size);
      expect(`sha256:${createHash('sha256').update(recovered).digest('hex')}`).toBe(expected);
    } finally { lease.release(); }
  } finally { image.dispose(); await rm(dir, {recursive:true,force:true}); }
}, 60000);
