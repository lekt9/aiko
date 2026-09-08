import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createTelegramVision } from "../apps/agent/src/telegram-tools.ts";
import { loadConfig } from "../apps/agent/src/config.ts";
import { Codegraff, CodegraffSandbox } from "../apps/agent/src/codegraff.ts";
import { codegraffSandboxService } from "../apps/agent/src/code-sandbox.ts";

process.umask(0o077);
const mode = process.argv[2];
if (mode === "--browser-runtime" || mode === "--browser-fresh" || mode === "--code-smoke") {
  const build = await Bun.build({ entrypoints: ["apps/agent/src/sandbox-runner.ts"], target: "bun", external: ["@huggingface/transformers"], minify: true });
  if (!build.success) throw new Error("Sandbox runner build failed");
  await Bun.write("apps/agent/assets/runner.txt", build.outputs[0]!);
}
const config = await loadConfig();
const directory = (process.env.AIKO_PROBE_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "unbrowse/aiko/cloudflare-probe")) +
  (mode === "--browser-fresh" ? `/fresh-${crypto.randomUUID()}` : "");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const db = new Database(`${directory}/probe.sqlite`);
db.exec(
  "CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
);
// Count the real provisioning calls without retaining command bodies or keys.
const provisioning = { allocations: 0, bootstraps: 0, nativeInstalls: 0 };
const gateway = new Codegraff(config.modelKey!, async (input, init) => {
  const path = new URL(String(input)).pathname;
  if (init?.method === "POST" && path === "/v1/sandboxes") provisioning.allocations++;
  if (init?.method === "POST" && path.endsWith("/exec")) {
    const command = JSON.parse(String(init.body)).command;
    if (command === "bash /tmp/aiko-bootstrap.sh") provisioning.bootstraps++;
    if (typeof command === "string" && command.endsWith("runner.js install")) provisioning.nativeInstalls++;
  }
  return fetch(input, init);
});
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
function evidence(name: string, value: unknown) {
  mkdirSync("artifacts/aiko-cloudflare", { recursive: true, mode: 0o700 });
  writeFileSync(
    `artifacts/aiko-cloudflare/${name}.json`,
    JSON.stringify(value, null, 2) + "\n",
    { mode: 0o600 },
  );
}
try {
  if (mode === "--code-smoke") {
    const {Effect}=await import(Bun.resolveSync("effect",new URL("../apps/agent",import.meta.url).pathname));
    const startedAt=Date.now();
    let calls=0;
    const service=codegraffSandboxService((input,signal)=>sandbox.codeSegment(input,signal));
    const result=await Effect.runPromise(service.run("const values=await Promise.all([tools.read({id:2}),tools.read({id:5})]); return {sum:values.reduce((a,b)=>a+b,0),isolated:[typeof Bun,typeof process,typeof fetch,typeof require],now:Date.now()};",{
      tools:{read:async(args:any)=>{calls++;return {_tag:"Returned",result:args.id*10};}},
    },{at:1234,seed:"codegraff-read-only-smoke"}));
    const expected={sum:70,isolated:["undefined","undefined","undefined","undefined"],now:1234};
    if(result.error || JSON.stringify(result.result)!==JSON.stringify(expected) || calls!==2)throw new Error("Codegraff code-mode smoke failed: "+JSON.stringify(result));
    const report={verified:true,at:Date.now(),durationMs:Date.now()-startedAt,calls,result:result.result,provisioning};
    evidence("code-mode-smoke",report);console.log(JSON.stringify(report));
  } else if (mode === "--search") {
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
  } else if (mode === "--browser-fresh") {
    // A disposable VM proves the normal factory installs everything from zero.
    // The private DB retains the allocated ID if the process is interrupted.
    const signal = AbortSignal.timeout(15 * 60_000);
    const events: Record<string, unknown>[] = [];
    const options = { domains: ["*"], signal, emit: async (event: any) => { events.push(event); } };
    const startedAt = Date.now();
    const report: Record<string, unknown> = { verified: false, startedAt, stateDirectory: directory };
    evidence("browser-fresh", report);
    const assert = (ok: unknown, stage: string) => { if (!ok) throw new Error(`Fresh browser probe failed: ${stage}`); };
    try {
      const driver = await sandbox.browserFactory()(options);
      const coldReadyMs = Date.now() - startedAt;
      const installed = await sandbox.status();
      assert("id" in installed && installed.id, "allocation recorded");
      const id = (installed as { id: string }).id;
      const health = JSON.parse(await sandbox.exec(id, "cd /home/daytona/aiko && /home/daytona/.bun/bin/bun runner.js health", signal));
      assert(health.browser === "cloakbrowser" && health.browserVersion === "146.0.7680.177.5", "CloakBrowser is the default in a newly allocated VM");
      report.browser = health.browser;
      report.browserVersion = health.browserVersion;
      await driver.execute({ action: "navigate", url: "https://example.com" }, signal);
      assert(JSON.stringify(await driver.execute({ action: "title" }, signal)).includes("Example Domain"), "public browsing after automatic installation");
      const processes = await sandbox.exec(id, "python3 -c 'import glob,os; print(any(\"/native/cloakbrowser-\" in os.readlink(p) for p in glob.glob(\"/proc/[0-9]*/exe\") if os.path.exists(p)))'", signal);
      assert(processes.trim() === "True", "new VM actually launches the CloakBrowser executable");
      report.cloakProcessVerified = true;
      const screenshot = await sandbox.captureScreenshot(signal);
      assert(screenshot.mimeType === "image/png" && screenshot.bytes.length > 1000, "fresh browser screenshot");
      assert(events.some(e => e.type === "BrowserToolResultObserved" && e.success === true), "browser trace delivered");
      await sandbox.upload(id, "/home/daytona/aiko/browser/fresh-probe-marker", "persistent-browser", signal);
      console.log(JSON.stringify({ stage: "fresh VM installed and browsing", coldReadyMs }));
      assert(await sandbox.stop(), "stop settled");
      const restartAt = Date.now();
      const restored = new CodegraffSandbox(sandbox.options);
      const resumed = await restored.browserFactory()(options);
      const restartReadyMs = Date.now() - restartAt;
      const resumedStatus = await restored.status();
      assert("id" in resumedStatus && resumedStatus.id === id, "same VM after host reconstruction and restart");
      assert((await restored.exec(id, "cat /home/daytona/aiko/browser/fresh-probe-marker", signal)).trim() === "persistent-browser", "browser directory survived restart");
      await resumed.execute({ action: "navigate", url: "https://example.org" }, signal);
      assert(JSON.stringify(await resumed.execute({ action: "title" }, signal)).includes("Example Domain"), "browser usable after restart");
      assert(provisioning.allocations === 1 && provisioning.bootstraps === 1 && provisioning.nativeInstalls === 1, "installation runs once across repeated factory calls and restart");
      report.coldReadyMs = coldReadyMs;
      report.restartReadyMs = restartReadyMs;
      report.provisioning = { ...provisioning };
      report.runnerVersion = "runnerVersion" in installed ? installed.runnerVersion : undefined;
      report.runnerSha256 = createHash("sha256").update(sandbox.options.runnerBundle).digest("hex");
      report.bootstrapSha256 = createHash("sha256").update(sandbox.options.bootstrap).digest("hex");
      report.sameSandboxAfterRestart = true;
      report.persistentBrowserDirectory = true;
      report.traceEvents = events.length;
      report.checksPassed = true;
    } finally {
      const record = await sandbox.status();
      if ("id" in record && record.id) {
        // Only this invocation's disposable VM. Production VMs are never deleted.
        await gateway.request(`/v1/sandboxes/${record.id}`, undefined, AbortSignal.timeout(60_000), "DELETE");
        report.sandboxDeleted = true;
        await sandbox.options.store.put("probe:cleanup", { deleted: true, at: Date.now(), id: record.id });
      }
      report.verified = report.checksPassed === true && report.sandboxDeleted === true;
      evidence("browser-fresh", report);
    }
    console.log(JSON.stringify(report));
  } else if (mode === "--browser-runtime") {
    // Use the dedicated probe tenant only. Never print raw page/runner output.
    const signal = AbortSignal.timeout(10 * 60_000);
    const events: Record<string, unknown>[] = [];
    const options = { domains: ["*"], signal, emit: async (event: any) => { events.push(event); } };
    evidence("browser-runtime", { verified: false, startedAt: Date.now() });
    let result: Record<string, unknown> | undefined;
    const assert = (ok: unknown, stage: string) => { if (!ok) throw new Error(`Browser runtime probe failed: ${stage}`); };
    const progress = (stage: string) => console.log(JSON.stringify({ stage, verified: true }));
    try {
      const id = await sandbox.ensure(signal);
      const bundle = await Bun.file("apps/agent/assets/runner.txt").text();
      let staleRejected = false;
      await sandbox.upload(id, "/home/daytona/aiko/runner.js", bundle + "\n// digest probe\n", signal);
      try { await sandbox.exec(id, "cd /home/daytona/aiko && /home/daytona/.bun/bin/bun runner.js health", signal); }
      catch { staleRejected = true; }
      finally { await sandbox.upload(id, "/home/daytona/aiko/runner.js", bundle, signal); }
      assert(staleRejected, "stale resident bundle rejected");
      const driver = await sandbox.browserFactory()(options);
      await driver.execute({ action: "navigate", url: "https://example.com" }, signal);
      assert(JSON.stringify(await driver.execute({ action: "title" }, signal)).includes("Example Domain"), "first public host");
      await driver.execute({ action: "wait", milliseconds: 50 }, signal);
      await driver.execute({ action: "wait", selector: "h1" }, signal);
      progress("navigation and both wait variants");
      let recovered = false;
      try { await driver.execute({ action: "wait", selector: "#aiko-runtime-probe-absent" }, signal); }
      catch (error) { recovered = (error as {code?: string}).code === "element_not_found"; }
      assert(recovered, "settled selector timeout classification");
      assert(JSON.stringify(await driver.execute({ action: "title" }, signal)).includes("Example Domain"), "read after selector timeout");
      await driver.execute({ action: "navigate", url: "https://example.org" }, signal);
      assert(JSON.stringify(await driver.execute({ action: "title" }, signal)).includes("Example Domain"), "cross-site navigation without domain input");
      const screenshot = await sandbox.captureScreenshot(signal);
      const png = Buffer.from(screenshot.bytes);
      assert(png.readUInt32BE(16) === 1280 && png.readUInt32BE(20) === 1000, "fixed viewport");
      assert(events.some(e => e.type === "BrowserToolResultObserved" && e.success === false), "failed read trace flushed");
      const through = events.length;
      await sandbox.upload(id, "/home/daytona/aiko/browser/runtime-probe-marker", "persisted-runtime-probe", signal);
      progress("selector recovery, cross-site navigation, viewport and trace");
      assert(await sandbox.stop(), "stop");
      assert(await sandbox.ensure(signal) === id, "reuse same sandbox");
      const persisted = await sandbox.exec(id, "test -f /home/daytona/aiko/browser/runtime-probe-marker && echo persisted", signal);
      assert(persisted.trim() === "persisted", "persistent browser directory");
      const resumed = await sandbox.browserFactory()(options);
      await resumed.execute({ action: "navigate", url: "https://example.org" }, signal);
      assert(JSON.stringify(await resumed.execute({ action: "title" }, signal)).includes("Example Domain"), "browser after restart");
      assert(events.length > through, "trace after restart");
      await sandbox.exec(id, "rm /home/daytona/aiko/browser/runtime-probe-marker", signal);
      const privateStatus = await resumed.nativeAuth!({ connectionId: crypto.randomUUID(), domain: "example.org", action: "status" }, signal);
      assert(privateStatus.status === "pending", "private status check without a login");
      assert(JSON.stringify(await resumed.execute({ action: "title" }, signal)).includes("Example Domain"), "controller reconnect after private browser handoff");
      progress("same VM restart, persisted directory and private handoff reconnect");
      const abort = new AbortController();
      const cancelAfter = setTimeout(() => abort.abort(), 5000);
      const beforeCancel = events.length;
      let cancelled = false;
      try { await resumed.execute({ action: "wait", milliseconds: 30_000 }, AbortSignal.any([signal, abort.signal])); }
      catch { cancelled = abort.signal.aborted; }
      finally { clearTimeout(cancelAfter); }
      console.log(JSON.stringify({ stage: "cancellation returned", cancelled, busy: sandbox.busy, failedWaitResults: events.slice(beforeCancel).filter(e => e.type === "BrowserToolResultObserved" && e.action === "wait" && e.success === false).length }));
      assert(cancelled && !sandbox.busy, "cancelled browser operation settled");
      assert(events.slice(beforeCancel).some(e => e.type === "BrowserToolResultObserved" && e.action === "wait" && e.success === false), "cancelled wait trace delivered before return");
      result = { verified: true, at: Date.now(), staleBundleRejected: true, sameSandboxAfterRestart: true, persistentBrowserDirectory: true, privateHandoffReconnect: true, cancellationSettled: true, selectorRecovery: true, waitVariants: true, publicCrossSite: true, viewport: { width: 1280, height: 1000 }, traceEvents: events.length };
    } finally {
      if (!(await sandbox.stop())) throw new Error("Probe sandbox did not settle for stop");
    }
    evidence("browser-runtime", { ...result, sandboxStopped: true });
    console.log(JSON.stringify({ ...result, sandboxStopped: true }));
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
