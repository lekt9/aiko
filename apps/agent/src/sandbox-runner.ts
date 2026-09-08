import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { browserDriverFactory } from "./browser-driver.ts";
import { installPinnedCloakBrowser, verifyCloakBrowser, CLOAK_BROWSER_VERSION } from "@unbrowse/browser-harness/install-cloakbrowser";
import {
  replayKeys,
  unwrapReplay,
  sealReplay,
  PrivateOperationFence,
} from "./codegraff.ts";
import { BrowserEventQueue } from "./browser-event-queue.ts";
import { runSandboxJob, sandboxEnvironment } from "./sandbox-job-runner.ts";
import { sandboxJobJournal } from "./sandbox-job-journal.ts";
import { runCodeSegment } from "./code-sandbox-runner.ts";
import { snapshotVm, readVmSnapshot, discardVmSnapshot, writeVmRestore, verifyVmRestore, publishVmRestore } from "./vm-backup.ts";
import {
  agentBrowserAgentActionOf,
  AgentBrowserClientError,
  pinnedAgentBrowserAssetFor,
  pinnedAgentBrowserExecutablePath,
  verifyPinnedAgentBrowserExecutable,
} from "@unbrowse/browser-harness/client";

// Trusted execution adapter in one tenant VM. Tardigrade stays in the control plane.
const root = "/home/daytona/aiko";
const endpoint = "http://127.0.0.1:4860";
const cloakDirectory = `${root}/native/cloakbrowser-${CLOAK_BROWSER_VERSION}`;
await mkdir(`${root}/operations`, { recursive: true, mode: 0o700 });
const mode = process.argv[2];
if (mode === "install") {
  await installPinnedCloakBrowser({ directory: cloakDirectory });
  const asset = pinnedAgentBrowserAssetFor();
  const path = pinnedAgentBrowserExecutablePath(asset, `${root}/native`);
  await mkdir(path.slice(0, path.lastIndexOf("/")), {
    recursive: true,
    mode: 0o700,
  });
  if (!(await Bun.file(path).exists())) {
    const res = await fetch(
      `https://github.com/vercel-labs/agent-browser/releases/download/v0.36.0/${asset.name}`,
    );
    if (!res.ok) throw new Error("Browser asset unavailable");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length !== asset.sizeBytes)
      throw new Error("Browser asset size mismatch");
    // A cancelled bootstrap must never leave an incomplete executable at the
    // installed path. Validate the download before making it visible to launch.
    const temporary = `${path}.partial`;
    try {
      await writeFile(temporary, bytes, { mode: 0o700 });
      await verifyPinnedAgentBrowserExecutable(temporary, asset);
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  await verifyPinnedAgentBrowserExecutable(path, asset);
  console.log(JSON.stringify({ installed: true, asset: asset.name }));
} else if (mode === "serve") {
  const db = new Database(`${root}/runner.sqlite`);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,status TEXT NOT NULL,result TEXT)",
  );
  const replayIdentity = replayKeys();
  const privateOperations = new PrivateOperationFence();
  const runnerDigest = createHash("sha256")
    .update(await readFile(`${root}/runner.js`))
    .digest("hex");
  const owner = JSON.parse(await readFile(`${root}/owner.json`, "utf8")).owner;
  const environmentDigest = await sandboxEnvironment(runnerDigest);
  const jobJournal = await sandboxJobJournal(db, `${root}/sandbox-receipts.key`);
  let closing = false;
  let busy = false;
  const active = new Map<string, AbortController>();
  const queue = new BrowserEventQueue(db);
  const batch = () => queue.batch();
  const driver = await browserDriverFactory(await verifyCloakBrowser(cloakDirectory), {
    browserBackend: "cloakbrowser",
    persistentDirectory: `${root}/browser`,
    nativeAssetDirectory: `${root}/native`,
  })({
    domains: ["*"],
    owner: JSON.parse(await readFile(`${root}/owner.json`, "utf8")).owner,
    emit: async (event) => {
      queue.append(event);
    },
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 4860,
    // Browser operations and cancellation have their own controller deadlines.
    // Bun's default idle timeout must not sever a long, private loopback reply.
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (closing) return new Response("Runner closing", { status: 503 });
      if (url.pathname === "/health")
        return Response.json({
          ready: true,
          runnerDigest,
          environmentDigest,
          replayPublicKey: replayIdentity.publicKey,
          privateContext: await driver.sessionContext?.(),
          backend: "playground-agent-browser",
          browser: "cloakbrowser",
          browserVersion: CLOAK_BROWSER_VERSION,
          persistentProfile: true,
        });
      if (url.pathname === "/drain" && request.method === "GET")
        return Response.json(batch());
      if (url.pathname === "/acknowledge" && request.method === "POST") {
        const input = (await request.json()) as { through?: unknown };
        const through = input?.through;
        try {
          queue.acknowledge(through);
        } catch {
          return new Response("Invalid cursor", { status: 400 });
        }
        return Response.json({ acknowledged: through });
      }
      if (url.pathname === "/cancel" && request.method === "POST") {
        const input = (await request.json()) as { id?: unknown };
        if (typeof input?.id !== "string" || !/^[a-f0-9-]{36}$/.test(input.id))
          return new Response("Invalid operation", { status: 400 });
        // Fence a cancellation that arrives before the execution request itself.
        db.query(
          "INSERT OR IGNORE INTO operations(id,status,result) VALUES(?,'unknown',?)",
        ).run(
          input.id,
          JSON.stringify({
            status: "unknown",
            reason: "cancelled_before_start",
          }),
        );
        active.get(input.id)?.abort();
        const deadline = performance.now() + 30_000;
        while (active.has(input.id) && performance.now() < deadline)
          await Bun.sleep(25);
        if (active.has(input.id))
          return new Response("Cancellation unsettled", { status: 409 });
        return Response.json({
          cancellationRequested: true,
          settled: true,
          ...batch(),
        });
      }
      if (url.pathname === "/capture" && request.method === "POST") {
        if (busy || !driver.screenshot)
          return new Response("No capture available", { status: 409 });
        const input = (await request.json()) as { id?: unknown };
        if (typeof input?.id !== "string" || !/^[a-f0-9-]{36}$/.test(input.id))
          return new Response("Invalid operation", { status: 400 });
        const cancellation = new AbortController();
        active.set(input.id, cancellation);
        busy = true;
        try {
          const bytes = await driver.screenshot(cancellation.signal);
          // The gateway's file download converts bytes through UTF-8. Keep binary
          // pixels ASCII-armored in this owner VM; the host verifies original bytes.
          await writeFile(
            `${root}/operations/${input.id}.screenshot.png.b64`,
            Buffer.from(bytes).toString("base64"),
            { mode: 0o600 },
          );
          return Response.json({
            mimeType: "image/png",
            size: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            ...batch(),
          });
        } finally {
          active.delete(input.id);
          busy = false;
        }
      }
      if (url.pathname === "/request-replay" && request.method === "POST") {
        let ownsBrowser = false;
        try {
          const { key, value } = unwrapReplay(
            await request.json(),
            replayIdentity.privateKey,
          );
          privateOperations.consume(value.id);
          if (value.operation !== "code" && value.operation !== "harness-job") {
            if (busy || !driver.requestTransport)
              return new Response("Unavailable", { status: 409 });
            busy = true;
            ownsBrowser = true;
          }
          const cancellation = new AbortController();
          active.set(value.id, cancellation);
          // No operation result or plaintext request is journaled. Retrying requires a new read.
          try {
            const output =
              value.operation === "backup"
                ? await (async () => {
                    if(value.action === "prepare" || value.action === "pause") {
                      await driver.close();
                      if(value.action === "pause") return {paused:true};
                      return snapshotVm(root,value.snapshotId);
                    }
                    if(value.action === "read") return readVmSnapshot(root,value.snapshotId,value.path,value.offset,value.length);
                    if(value.action === "write") return writeVmRestore(root,value.snapshotId,value.path,value.offset,value.bytes).then(()=>({written:true}));
                    if(value.action === "verify") return verifyVmRestore(root,value.snapshotId,value.owner,value.files);
                    if(value.action === "discard") return discardVmSnapshot(root,value.snapshotId).then(()=>({discarded:true}));
                    throw Error("Unknown backup action");
                  })()
              : value.operation === "harness-job"
                ? await runSandboxJob(value.input, {owner, environmentDigest, journal:jobJournal}, cancellation.signal)
              : value.operation === "code"
                ? await runCodeSegment(value.input, cancellation.signal)
                  : value.operation === "authorize-inspection" && driver.authorizeInspection
                    ? await driver.authorizeInspection(value.policy,cancellation.signal)
                  : value.operation === "inspect-current-page" && driver.inspectCurrentPage
                    ? await driver.inspectCurrentPage(value.policy,cancellation.signal)
                  : value.operation === "connection-page" && driver.readConnectionPage
                    ? await driver.readConnectionPage(value.url,value.linkOffset,cancellation.signal)
                  : value.operation === "native-auth" && driver.nativeAuth
                    ? await driver.nativeAuth(value.input, cancellation.signal)
                    : value.operation === "session-install" &&
                        driver.installSession
                      ? await driver.installSession(
                          value.input,
                          cancellation.signal,
                        )
                      : value.operation === "session-clear" &&
                          driver.clearSession
                        ? await driver
                            .clearSession(value.scope, cancellation.signal)
                            .then(() => ({ cleared: true }))
                        : value.operation === "search" && driver.requestSearch
                          ? await driver.requestSearch(
                              value.query,
                              value.limit,
                              cancellation.signal,
                            )
                          : value.operation === "hydrate" &&
                              driver.requestRehydrate
                            ? await driver.requestRehydrate(
                                value.pointerId,
                                value.inputs,
                                cancellation.signal,
                              )
                            : value.operation === "send"
                              ? await driver.requestTransport!.send(
                                  value.request,
                                )
                              : (() => {
                                  throw new Error("Unknown replay operation");
                                })();
            return Response.json(sealReplay({ output }, key));
          } catch {
            return Response.json(
              sealReplay({ error: "browser_replay_unavailable" }, key),
            );
          } finally {
            active.delete(value.id);
          }
        } catch {
          return new Response("Invalid envelope", { status: 400 });
        } finally {
          if (ownsBrowser) busy = false;
        }
      }
      if (url.pathname === "/close" && request.method === "POST") {
        if (busy) return new Response("busy", { status: 409 });
        closing = true;
        let cleaned = false;
        try {
          await driver.close();
          cleaned = true;
          return Response.json({ closed: true });
        } catch {
          return Response.json(
            { closed: false, reason: "cleanup_failed" },
            { status: 500 },
          );
        } finally {
          // A failed flush must not strand a resident process permanently in closing.
          setTimeout(() => {
            try {
              server.stop(true);
              db.close();
            } finally {
              process.exit(cleaned ? 0 : 1);
            }
          }, 200);
        }
      }
      if (url.pathname !== "/execute" || request.method !== "POST")
        return new Response("Not found", { status: 404 });
      if (busy) return new Response("busy", { status: 409 });
      const body = (await request.json()) as {
        id: string;
        action: Record<string, unknown>;
      };
      if (!/^[a-f0-9-]{36}$/.test(body.id))
        return new Response("Invalid operation", { status: 400 });
      const old = db
        .query("SELECT status,result FROM operations WHERE id=?")
        .get(body.id) as { status: string; result?: string } | null;
      if (old)
        return Response.json({
          ...(old.result
            ? JSON.parse(old.result)
            : { status: "unknown", reason: "interrupted_operation" }),
          ...batch(),
        });
      // The original library performs exact per-operation argument validation.
      // The control plane already decoded the tool into the closed action union.
      // Wait variants share action:"wait" and are not model function names.
      let action;
      try {
        action = agentBrowserAgentActionOf(body.action, ["*"]);
      } catch {
        return new Response("Invalid action", { status: 400 });
      }
      busy = true;
      const cancellation = new AbortController();
      active.set(body.id, cancellation);
      db.query("INSERT INTO operations(id,status) VALUES(?,'started')").run(
        body.id,
      );
      try {
        const output = await driver.execute(action, cancellation.signal);
        const result = JSON.stringify({ status: "completed", output });
        db.query(
          "UPDATE operations SET status='completed',result=? WHERE id=?",
        ).run(result, body.id);
        return Response.json({ ...JSON.parse(result), ...batch() });
      } catch (error) {
        // Only the client's settled, telemetry-corroborated failed read is
        // recoverable. The driver has flushed its evidence before throwing.
        const outcome =
          error instanceof AgentBrowserClientError &&
          error.code === "element_not_found"
            ? { status: "failed", reason: "element_not_found" }
            : error && typeof error === "object" && "code" in error &&
              ["private_sign_in_pending", "private_sign_in_cleanup_failed"].includes(String(error.code))
              ? {status: "blocked", reason: error.code}
              : { status: "unknown" };
        const result = JSON.stringify(outcome);
        db.query("UPDATE operations SET status=?,result=? WHERE id=?").run(
          outcome.status,
          result,
          body.id,
        );
        return Response.json({ ...outcome, ...batch() });
      } finally {
        busy = false;
        active.delete(body.id);
      }
    },
  });
} else if (mode === "health") {
  let ready = await fetch(`${endpoint}/health`)
    .then((r) => r.ok)
    .catch(() => false);
  if (!ready) {
    const child = Bun.spawn([process.execPath, `${root}/runner.js`, "serve"], {
      cwd: root,
      stdin: "ignore",
      stdout: Bun.file(`${root}/runner.log`),
      stderr: Bun.file(`${root}/runner-error.log`),
    });
    child.unref();
    for (let i = 0; i < 100 && !ready; i++) {
      await Bun.sleep(100);
      ready = await fetch(`${endpoint}/health`)
        .then((r) => r.ok)
        .catch(() => false);
    }
  }
  if (!ready) throw new Error("Browser runner did not start");
  const health = (await (await fetch(`${endpoint}/health`)).json()) as {
    ready?: boolean;
    runnerDigest?: string;
  };
  const expected = createHash("sha256")
    .update(await readFile(`${root}/runner.js`))
    .digest("hex");
  if (health.ready !== true || health.runnerDigest !== expected)
    throw new Error("Browser runner bundle mismatch");
  console.log(JSON.stringify(health));
} else if (mode === "close") {
  const res = await fetch(`${endpoint}/close`, { method: "POST" });
  if (!res.ok) throw new Error("Runner close failed");
  const result = await res.text();
  // Acknowledging close is not process settlement. Wait before replacement or VM stop.
  let stopped = false;
  const deadline = performance.now() + 10_000;
  while (!stopped && performance.now() < deadline) {
    await Bun.sleep(100);
    stopped = await fetch(`${endpoint}/health`, {
      signal: AbortSignal.timeout(1000),
    })
      .then(async (r) => {
        await r.body?.cancel();
        return false;
      })
      .catch(
        (error) =>
          error?.code === "ConnectionRefused" || error?.code === "ECONNREFUSED",
      );
  }
  if (!stopped) throw new Error("Browser runner did not stop");
  console.log(result);
} else if (mode === "restore") {
  const id=process.argv[3];
  if(!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid restore identity");
  const active=await fetch(`${endpoint}/health`).then(()=>true).catch(()=>false);
  if(active) throw Error("Restore requires a stopped runner");
  const owner=JSON.parse(await readFile(`${root}/owner.json`,"utf8")).owner;
  const allowed=JSON.parse(await readFile(`${root}/backups/${id}/allowed.json`,"utf8"));
  console.log(JSON.stringify(await publishVmRestore(root,id,owner,allowed)));
} else if (mode === "drain") {
  const res = await fetch(`${endpoint}/drain`);
  if (!res.ok) throw new Error("Trace drain failed");
  console.log(await res.text());
} else if (mode === "acknowledge") {
  const through = Number(process.argv[3]);
  if (!Number.isSafeInteger(through) || through < 0)
    throw new Error("Invalid trace cursor");
  const res = await fetch(`${endpoint}/acknowledge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ through }),
  });
  if (!res.ok) throw new Error("Trace acknowledgement failed");
  console.log(await res.text());
} else if (mode === "cancel") {
  const id = process.argv[3];
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid operation ID");
  const res = await fetch(`${endpoint}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error("Runner cancellation failed");
  console.log(await res.text());
} else if (mode === "discard-screenshot") {
  const id = process.argv[3];
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid operation ID");
  await Promise.all([
    rm(`${root}/operations/${id}.screenshot.png`, { force: true }),
    rm(`${root}/operations/${id}.screenshot.png.b64`, { force: true }),
  ]);
  console.log(JSON.stringify({ discarded: true }));
} else if (mode === "capture" || mode === "screenshot") {
  const id = process.argv[3];
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid operation ID");
  const res = await fetch(`${endpoint}/capture`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error("Runner screenshot unavailable");
  console.log(await res.text());
} else if (mode === "request-replay") {
  const id = process.argv[3];
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid operation ID");
  const path = `${root}/operations/${id}.json`;
  try {
    const body = await readFile(path, "utf8");
    if (body.length > 1_500_000) throw new Error("Replay envelope too large");
    const res = await fetch(`${endpoint}/request-replay`, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error("Replay unavailable");
    console.log(await res.text());
  } finally {
    await rm(path, { force: true });
  }
} else if (mode === "execute") {
  const id = process.argv[3];
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid operation ID");
  const body = await readFile(`${root}/operations/${id}.json`, "utf8");
  if (body.length > 64_000) throw new Error("Operation too large");
  const res = await fetch(`${endpoint}/execute`, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Runner HTTP ${res.status}`);
  console.log(await res.text());
} else throw new Error("Unknown runner operation");
