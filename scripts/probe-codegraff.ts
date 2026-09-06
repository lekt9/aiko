import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { createTelegramVision } from "../apps/agent/src/telegram-tools.ts";
import { loadConfig } from "../apps/agent/src/config.ts";
import { Codegraff, CodegraffSandbox } from "../apps/agent/src/codegraff.ts";

process.umask(0o077);
const config = await loadConfig();
const directory = "/home/deck/.local/share/unbrowse/aiko/cloudflare-probe";
mkdirSync(directory, { recursive: true, mode: 0o700 });
const db = new Database(`${directory}/probe.sqlite`);
db.exec(
  "CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
);
const gateway = new Codegraff(config.modelKey!);
const sandbox = new CodegraffSandbox({
  owner: "acct_cloudflare_probe01",
  gateway,
  store: {
    get: async <T>(key: string) => {
      const r = db.query("SELECT value FROM state WHERE key=?").get(key) as {
        value: string;
      } | null;
      return r ? (JSON.parse(r.value) as T) : undefined;
    },
    put: async (key, value) => {
      db.query(
        "INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(key, JSON.stringify(value));
    },
  },
  emit: async (event) => {
    console.log(JSON.stringify(event));
  },
  runnerBundle: await Bun.file("apps/agent/assets/runner.txt").text(),
  bootstrap: await Bun.file("apps/agent/assets/bootstrap.sh").text(),
  mediaScript: await Bun.file("apps/agent/assets/media.py").text(),
});
const mode = process.argv[2];
function evidence(name: string, value: unknown) {
  mkdirSync("artifacts/aiko-cloudflare", { recursive: true, mode: 0o700 });
  writeFileSync(
    `artifacts/aiko-cloudflare/${name}.json`,
    JSON.stringify(value, null, 2) + "\n",
    { mode: 0o600 },
  );
}
try {
  if (mode === "--search") {
    const r = await gateway.search(
      "Eatigo Singapore restaurants 50 percent discount",
    );
    console.log(
      JSON.stringify({
        results: r.results?.map((x: any) => ({ title: x.title, url: x.url })),
        cost: r.codegraff_usage?.cost_micro_usd,
      }),
    );
  } else if (mode === "--wake") {
    console.log(JSON.stringify({ ready: await sandbox.ensure() }));
  } else if (mode === "--browse") {
    const discovery = await gateway.search(
      "Eatigo Singapore restaurants 50 percent discount",
    );
    const target = discovery.results?.find(
      (r: any) => new URL(r.url).hostname === "eatigo.com",
    )?.url;
    if (!target) throw new Error("Search did not discover an Eatigo page");
    const driver = await sandbox.browserFactory()({
      domains: ["*"],
      emit: async (event) => {
        console.log(JSON.stringify({ eventType: (event as any).type }));
      },
    });
    console.log(JSON.stringify({ discovered: target }));
    console.log(
      JSON.stringify(await driver.execute({ action: "navigate", url: target })),
    );
    console.log(JSON.stringify(await driver.execute({ action: "snapshot" })));
  } else if (mode === "--screenshot") {
    const driver = await sandbox.browserFactory()({
      domains: ["*"],
      emit: async (event) => {
        console.log(JSON.stringify({ eventType: (event as any).type }));
      },
    });
    await driver.execute({
      action: "navigate",
      url: "https://aiko-agent.lewis-6d8.workers.dev/control",
    });
    const result = await sandbox.captureScreenshot(
      new AbortController().signal,
    );
    if (
      result.owner !== "acct_cloudflare_probe01" ||
      result.mimeType !== "image/png" ||
      result.bytes.length < 1000
    )
      throw new Error("Screenshot capture failed");
    const path = `${directory}/test-screenshot.png`;
    writeFileSync(path, result.bytes, { mode: 0o600 });
    evidence("screenshot", {
      verified: true,
      at: Date.now(),
      bytes: result.bytes.length,
      mimeType: result.mimeType,
      path,
    });
    console.log(
      JSON.stringify({ verified: true, bytes: result.bytes.length, path }),
    );
  } else if (mode === "--speech") {
    const bytes = await sandbox.speak(
      "Aiko can search the web and remember useful facts.",
      new AbortController().signal,
    );
    const result = await sandbox.processMedia({
      owner: "acct_cloudflare_probe01",
      media: {
        owner: "acct_cloudflare_probe01",
        kind: "voice",
        fileId: "synthetic_voice",
        mimeType: "audio/ogg",
      },
      bytes,
      mimeType: "audio/ogg",
      signal: new AbortController().signal,
    });
    console.log(
      JSON.stringify({
        voiceBytes: bytes.byteLength,
        status: result.status,
        transcript: result.text,
      }),
    );
    if (
      result.status !== "processed" ||
      !/search.*web/i.test(result.text ?? "")
    )
      throw new Error("Speech round trip failed");
    evidence("speech", {
      verified: true,
      at: Date.now(),
      voiceBytes: bytes.byteLength,
      transcript: result.text,
      provider: "private-Codegraff-VM",
      synthesizer: "espeak-ng",
      transcriber: "faster-whisper-small",
    });
  } else if (mode === "--video") {
    const signal = new AbortController().signal;
    const bytes = await sandbox.speak(
      "Aiko can search the web and remember useful facts.",
      signal,
    );
    const id = await sandbox.ensure(signal),
      operation = crypto.randomUUID();
    const base = `/home/daytona/aiko/operations/${operation}`;
    await gateway.request(`/v1/sandboxes/${id}/upload`, {
      path: `${base}.ogg`,
      contentBase64: Buffer.from(bytes).toString("base64"),
    });
    await sandbox.exec(
      id,
      `ffmpeg -v error -y -f lavfi -i color=c=red:s=320x240:r=10 -i ${base}.ogg -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac ${base}.mp4`,
    );
    const output = await sandbox.exec(
      id,
      `python3 -c 'import base64,json,pathlib; print(json.dumps({"data":base64.b64encode(pathlib.Path("${base}.mp4").read_bytes()).decode()}))'`,
    );
    const video = new Uint8Array(
      Buffer.from(JSON.parse(output).data, "base64"),
    );
    const processed = await sandbox.processMedia({
      owner: "acct_cloudflare_probe01",
      media: {
        owner: "acct_cloudflare_probe01",
        kind: "video",
        fileId: "synthetic_video",
        mimeType: "video/mp4",
      },
      bytes: video,
      mimeType: "video/mp4",
      signal,
    });
    if (
      processed.status !== "processed" ||
      processed.images?.length !== 6 ||
      !/search.*web/i.test(processed.text ?? "")
    )
      throw new Error("Video decoding/transcription failed");
    const vision = await createTelegramVision({
      apiKey: config.modelKey!,
      model: "glm-5.3-flash",
    })({
      owner: "acct_cloudflare_probe01",
      images: processed.images,
      question: "What color is visible in these frames? State the color only.",
      signal,
    });
    if (!/red/i.test(vision)) throw new Error("Video vision failed");
    const result = {
      verified: true,
      at: Date.now(),
      videoBytes: video.byteLength,
      frames: processed.images.length,
      transcript: processed.text,
      vision,
      sampled: true,
    };
    evidence("video", result);
    console.log(JSON.stringify(result));
    writeFileSync(`${directory}/test-video.mp4`, video, { mode: 0o600 });
    writeFileSync(`${directory}/test-voice.ogg`, bytes, { mode: 0o600 });
    await sandbox.exec(
      id,
      `python3 -c 'import pathlib; pathlib.Path("${base}.mp4").unlink(); pathlib.Path("${base}.ogg").unlink()'`,
    );
  } else if (mode === "--document") {
    const response = await fetch(
      "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
    );
    if (!response.ok) throw new Error("Public PDF fixture unavailable");
    const processed = await sandbox.processMedia({
      owner: "acct_cloudflare_probe01",
      media: {
        owner: "acct_cloudflare_probe01",
        kind: "document",
        fileId: "synthetic_pdf",
        mimeType: "application/pdf",
      },
      bytes: new Uint8Array(await response.arrayBuffer()),
      mimeType: "application/pdf",
      signal: new AbortController().signal,
    });
    if (
      processed.status !== "processed" ||
      !/Dummy PDF file/.test(processed.text ?? "")
    )
      throw new Error("PDF extraction failed");
    evidence("document", {
      verified: true,
      at: Date.now(),
      text: processed.text,
      reason: processed.reason,
    });
    console.log(
      JSON.stringify({
        verified: true,
        format: "PDF",
        text: processed.text,
        reason: processed.reason,
      }),
    );
  } else if (mode === "--stop") await sandbox.stop();
  else if (mode === "--diagnose") {
    const record = await sandbox.status();
    if (!record.id) throw new Error("No sandbox allocated");
    const r = await gateway.request(`/v1/sandboxes/${record.id}/exec`, {
      command:
        "id && uname -a && command -v sudo && command -v apt-get && df -h /home/daytona",
    });
    console.log(JSON.stringify(r));
  } else console.log(JSON.stringify(await sandbox.status()));
} finally {
  db.close();
}
