import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import manifest from "./media-multilingual/manifest.json";
import englishManifest from "./media-multilingual/english-manifest.json";
import { createMediaFixtures, mediaCommand } from "./media-fixtures.ts";
import type { MediaFixture } from "../../src/harness-media.ts";

/** Selection and WER were frozen in the checked-in manifest before inference. */
export async function createMultilingualFixtures() {
  const base = await createMediaFixtures();
  try {
    const license = await readFile(new URL("./media-multilingual/LICENSE", import.meta.url));
    if (createHash("sha256").update(license).digest("hex") !== manifest.licenseSha256) throw Error("Fixture license changed");
    const extra: MediaFixture[] = [];
    const englishLicense = await readFile(new URL("./media-multilingual/LIBRISPEECH-LICENSE.TXT", import.meta.url));
    if (createHash("sha256").update(englishLicense).digest("hex") !== englishManifest.licenseSha256) throw Error("English fixture license changed");
    for (const sample of [...manifest.fixtures,...englishManifest.fixtures]) {
      const bytes = await readFile(new URL(`./media-multilingual/${sample.file}`, import.meta.url));
      if (bytes.length !== sample.bytes || createHash("sha256").update(bytes).digest("hex") !== sample.sha256) throw Error("Labeled fixture bytes changed");
      await writeFile(join(base.directory, sample.file), bytes);
      const probe = JSON.parse(new TextDecoder().decode(await mediaCommand(["/usr/bin/ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", join(base.directory, sample.file)])));
      extra.push({ id: sample.id, split: sample.split as "development" | "held-out", capability: "media.transcribe", input: {asset: sample.file, language: sample.language}, expected: {status:"transcribed", durationSeconds:Number(probe.format.duration), transcript:sample.transcript, maxWordErrorRate:manifest.rubric.maxWordErrorRate} });
    }
    for (const [name, input, duration] of [["noise.wav", "anoisesrc=color=white:seed=732:amplitude=0.05:r=16000", "3"], ["long.wav", "anullsrc=r=16000:cl=mono", "601"]]) {
      await mediaCommand(["/usr/bin/ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", input!, "-t", duration!, "-c:a", "pcm_s16le", "-y", join(base.directory, name!)]);
    }
    extra.push(
      {id:"noise-es",split:"held-out",capability:"media.transcribe",input:{asset:"noise.wav",language:"es"},expected:{status:"no_speech",durationSeconds:3}},
      {id:"silence-es",split:"held-out",capability:"media.transcribe",input:{asset:"silence.wav",language:"es"},expected:{status:"no_speech",durationSeconds:3}},
      {id:"malformed-es",split:"held-out",capability:"media.transcribe",input:{asset:"malformed.bin",language:"es"},expected:{status:"invalid_media"}},
      {id:"long-es",split:"held-out",capability:"media.transcribe",input:{asset:"long.wav",language:"es"},expected:{status:"unsupported_duration"}},
    );
    return {...base, fixtures:[...base.fixtures,...extra]};
  } catch(error) { await base.close(); throw error; }
}
