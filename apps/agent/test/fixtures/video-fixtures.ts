import { readFile,writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createMediaFixtures } from "./media-fixtures.ts";
import manifest from "./video-crossing/manifest.json";
export { manifest as crossingManifest };
export async function createVideoFixtures() {
  const base=await createMediaFixtures();
  try {
    if(createHash("sha256").update(await readFile(new URL("./video-crossing/generate.ts",import.meta.url))).digest("hex")!==manifest.generatorSha256)throw Error("Frozen video generator changed");
    for(const f of manifest.fixtures) {
      const bytes=await readFile(new URL(`./video-crossing/${f.file}`,import.meta.url));
      if(bytes.length!==f.bytes||createHash("sha256").update(bytes).digest("hex")!==f.sha256)throw Error("Frozen video fixture changed");
      await writeFile(join(base.directory,f.file),bytes);
    }
    return base;
  }catch(e){await base.close();throw e;}
}
