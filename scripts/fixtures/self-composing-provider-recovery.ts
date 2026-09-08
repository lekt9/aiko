/** Independent process-cut witness. Only platform storage/model/HTTP edges are controlled. */
import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import { writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import {
  Effect,
  Layer,
} from "../../apps/agent/node_modules/effect/dist/index.js";
import { Infer } from "../../apps/agent/node_modules/tardie/src/agent/index.ts";
import { createService } from "../../apps/agent/src/server.ts";
import { PERSONA } from "../../apps/agent/src/config.ts";
import { credentialDigest } from "../../apps/agent/src/plane-auth.ts";
import { harnessDigest } from "../../apps/agent/src/harness-library.ts";
import { localHarnessSandbox } from "../../apps/agent/src/harness-sandbox-local.ts";
import { sandboxEnvironment } from "../../apps/agent/src/sandbox-job-runner.ts";
import { sandboxJobJournal } from "../../apps/agent/src/sandbox-job-journal.ts";
import { runCodeSegment } from "../../apps/agent/src/code-sandbox-runner.ts";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { serialize, deserialize } from "node:v8";
process.umask(0o077);
const [dir, mode = "driver", hostKind = "bun", stage = "cut"] =
  process.argv.slice(2);
assert(dir);
mkdirSync(dir, { recursive: true });
const keys = {
  request: "independent-request-key-0011223344",
  receipt: "independent-receipt-key-0011223344",
  receive: "independent-receive-key-0011223344",
};
const sign = (key: string, x: unknown) =>
  createHmac("sha256", key).update(harnessDigest(x)).digest("hex");
const contract: any = {
  version: 1,
  outcome:
    "Preserve exact operation payload; decode only the declared message field",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  effect: "read",
  verifierDigest: harnessDigest("independent-provider-checker-v1"),
  evaluatorDigest: harnessDigest("independent-provider-cases-v1"),
  applicability: {
    channel: {
      directions: ["inbox", "outbox"],
      operations: ["decode", "poll", "send", "reconcile"],
    },
  },
  timeoutMs: 3000,
};
const cases = [
  {
    id: "poll",
    split: "development",
    input: {
      operation: "poll",
      input: { partition: "provider", cursor: null, limit: 8 },
      binding: {},
    },
  },
  {
    id: "send",
    split: "held-out",
    input: {
      operation: "send",
      input: { payload: "fixed", replyTo: "destination" },
      binding: {},
    },
  },
];
const verifier: any = {
  digest: contract.verifierDigest,
  evaluatorDigest: contract.evaluatorDigest,
  cases,
  verify: async ({ contract: c, input, output }: any) => {
    const expected =
      input.operation === "decode"
        ? {
            kind: "external",
            schemaVersion: "provider.text.v1",
            text: JSON.parse(input.input.body).message,
          }
        : { payload: input.input };
    const passed =
      harnessDigest(c) === harnessDigest(contract) &&
      harnessDigest(output) === harnessDigest(expected);
    return {
      passed,
      quality: passed ? 1 : 0,
      evidence: ["independent-exact-operation-oracle"],
    };
  },
};
const artifact: any = {
  version: 1,
  name: "independent.provider",
  description: "Fixed payload adapter",
  runtime: "javascript",
  entrypoint: "main.js",
  files: {
    "main.js":
      'if(input.operation==="decode")return {kind:"external",schemaVersion:"provider.text.v1",text:JSON.parse(input.input.body).message};return {payload:input.input};',
  },
  dependencies: [],
  sources: [],
  contractDigest: harnessDigest(contract),
};

const lifecycle =
  mode === "lifecycle" ||
  mode === "boundaries" ||
  (mode === "child" &&
    JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).lifecycle ===
      true);
if (lifecycle) {
  contract.applicability.channel.operations.push(
    "subscribe",
    "renew",
    "remove",
  );
  artifact.contractDigest = harnessDigest(contract);
}
function storage(db: Database) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS fixture_kv(key TEXT PRIMARY KEY,value BLOB)",
  );
  const get = async (key: string) => {
    const r = db
      .query("SELECT value FROM fixture_kv WHERE key=?")
      .get(key) as any;
    return r ? deserialize(r.value) : undefined;
  };
  const put = async (key: string, value: any) => {
    db.query("INSERT OR REPLACE INTO fixture_kv VALUES(?,?)").run(
      key,
      serialize(value),
    );
  };
  const s: any = {
    get,
    put,
    delete: async (key: string) => {
      db.query("DELETE FROM fixture_kv WHERE key=?").run(key);
    },
    list: async ({ prefix = "" } = {}) =>
      new Map(
        (
          db
            .query("SELECT key,value FROM fixture_kv WHERE key LIKE ?")
            .all(prefix + "%") as any[]
        ).map((r) => [r.key, deserialize(r.value)]),
      ),
    sql: {
      exec: (q: string, ...args: any[]) => {
        const rows = db
          .query(q)
          .all(
            ...args.map((v) =>
              v instanceof ArrayBuffer ? new Uint8Array(v) : v,
            ),
          );
        return {
          toArray: () => rows,
          [Symbol.iterator]: () => rows[Symbol.iterator](),
        };
      },
    },
    transactionSync: (fn: any) => db.transaction(fn)(),
    sync: async () => {},
    getAlarm: async () => (await get("alarm")) ?? null,
    setAlarm: (at: any) => put("alarm", Number(at)),
    deleteAlarm: () => s.delete("alarm"),
  };
  let tail = Promise.resolve();
  s.transaction = (fn: any) => {
    const next = tail.then(async () => {
      db.exec("SAVEPOINT atomic_fixture");
      try {
        const value = await fn(s);
        db.exec("RELEASE atomic_fixture");
        return value;
      } catch (e) {
        appendFileSync(
          join(dir, stage + "-storage-errors.log"),
          String(e) + "\n",
        );
        db.exec("ROLLBACK TO atomic_fixture");
        db.exec("RELEASE atomic_fixture");
        throw e;
      }
    });
    tail = next.catch(() => {});
    return next;
  };
  return s;
}
async function workerModule() {
  const build = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "../../apps/agent/src/cloudflare.ts"),
    ],
    target: "bun",
    format: "esm",
    conditions: ["workerd"],
    external: ["node:*"],
    plugins: [
      {
        name: "controlled-platform",
        setup(b) {
          b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "workers",
            namespace: "platform",
          }));
          b.onLoad({ filter: /.*/, namespace: "platform" }, () => ({
            loader: "js",
            contents:
              "export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}",
          }));
          b.onLoad({ filter: /\.(sh|py|txt)$/ }, async ({ path }) => ({
            loader: "text",
            contents: await readFile(path, "utf8"),
          }));
        },
      },
    ],
  });
  assert(build.success, build.logs.map(String).join("\n"));
  const path = join(dir, "worker-entry.mjs");
  await Bun.write(path, await build.outputs[0]!.text());
  return import(path);
}
if (mode === "driver" || mode === "lifecycle" || mode === "boundaries") {
  const observations: any[] = [];
  for (const kind of mode === "boundaries"
    ? ["worker", "bun"]
    : ["bun", "worker"])
    for (const missing of lifecycle ? [false] : [false, true]) {
      const target = join(dir, kind + (missing ? "-missing" : "-retained"));
      mkdirSync(target, { recursive: true });
      const db = new Database(join(target, "physical.sqlite"));
      db.exec("CREATE TABLE requests(seq INTEGER PRIMARY KEY,request TEXT)");
      db.exec(
        "CREATE TABLE mutations(key TEXT PRIMARY KEY,operation TEXT,receipt TEXT); CREATE TABLE subscriptions(key TEXT PRIMARY KEY)",
      );
      db.exec(
        "CREATE TABLE ingress(seq INTEGER PRIMARY KEY,generation INTEGER,status INTEGER)",
      );
      const ingress =
        mode === "boundaries"
          ? Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch: async (req) => {
                const origin = readFileSync(
                  join(target, "ingress-target.txt"),
                  "utf8",
                );
                return fetch(new URL(new URL(req.url).pathname, origin), {
                  method: req.method,
                  headers: req.headers,
                  body: await req.arrayBuffer(),
                });
              },
            })
          : undefined;
      let empty = false;
      const provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (req) => {
          const { request: r, proof } =
            req.method === "GET"
              ? JSON.parse(new URL(req.url).searchParams.get("request")!)
              : await req.json();
          assert.equal(proof, sign(keys.request, r));
          db.query("INSERT INTO requests(request) VALUES(?)").run(
            JSON.stringify(r),
          );
          if (
            lifecycle &&
            (["subscribe", "renew", "remove"].includes(r.operation) ||
              (r.operation === "reconcile" &&
                r.payload.kind === "subscription"))
          ) {
            let status: string;
            if (r.operation === "reconcile") {
              const original = db
                .query("SELECT operation,receipt FROM mutations WHERE key=?")
                .get(r.payload.operationId) as any;
              assert(
                original,
                "Reconciliation must name an actually retained provider mutation",
              );
              status = JSON.parse(original.receipt).status;
            } else {
              assert(
                !db.query("SELECT key FROM mutations WHERE key=?").get(r.key),
                "Duplicate physical mutation",
              );
              if (r.operation === "subscribe")
                db.query("INSERT INTO subscriptions VALUES(?)").run(r.key);
              else
                assert(
                  db
                    .query("SELECT key FROM subscriptions WHERE key=?")
                    .get(r.subscriptionKey),
                  "Missing remote subscription",
                );
              if (r.operation === "remove")
                db.query("DELETE FROM subscriptions WHERE key=?").run(
                  r.subscriptionKey,
                );
              status =
                r.operation === "subscribe"
                  ? "ready"
                  : r.operation === "renew"
                    ? "renewed"
                    : "removed";
            }
            const receipt = {
              owner: r.owner,
              account: r.account,
              operation: r.operation,
              key: r.key,
              requestDigest: harnessDigest(r),
              channel: r.channel,
              generation: r.generation,
              status,
              subscriptionRef: "retained-remote-subscription",
            };
            if (r.operation !== "reconcile")
              db.query("INSERT INTO mutations VALUES(?,?,?)").run(
                r.key,
                r.operation,
                JSON.stringify(receipt),
              );
            if (mode === "boundaries" && r.operation === "subscribe") {
              if (kind === "bun" && r.generation === 2) {
                const ready = await fetch(new URL("/ready", ingress!.url));
                assert.equal(
                  ready.status,
                  503,
                  "Bun remains unready during native recovery",
                );
                writeFileSync(
                  join(target, "upgrade-readiness.json"),
                  JSON.stringify({ duringRecovery: ready.status }),
                );
              }
              const body = JSON.stringify({
                message: "PRIVATE_EARLY_GENERATION_" + r.generation,
              });
              const occurrence = "early-" + r.generation,
                conversation = "controlled-conversation";
              const response = await fetch(r.webhook, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-channel-receive-capability": r.receiveCapability,
                  "x-provider-occurrence": occurrence,
                  "x-provider-conversation": conversation,
                  "x-provider-signature": createHmac("sha256", keys.receive)
                    .update(
                      JSON.stringify([
                        "123",
                        r.account,
                        r.channel,
                        r.generation,
                        occurrence,
                        conversation,
                        body,
                      ]),
                    )
                    .digest("hex"),
                },
                body,
              });
              db.query(
                "INSERT INTO ingress(generation,status) VALUES(?,?)",
              ).run(r.generation, response.status);
              assert.equal(response.status, 202, await response.text());
            }
            return Response.json({
              receipt,
              signature: sign(keys.receipt, receipt),
            });
          }
          assert(["poll", "send", "reconcile"].includes(r.operation));
          const items = empty
            ? []
            : [
                {
                  occurrence: "valid",
                  conversation: "conversation",
                  observation: {
                    kind: "external",
                    schemaVersion: "provider.text.v1",
                    text: "PRIVATE_PROCESS_BATCH",
                  },
                },
                {
                  occurrence: "invalid",
                  conversation: "conversation",
                  observation: { kind: "invalid" },
                },
              ];
          const receipt = {
            owner: r.owner,
            account: r.account,
            operation: r.operation,
            key: r.key,
            requestDigest: harnessDigest(r),
            channel: r.channel,
            generation: r.generation,
            status:
              r.operation === "poll"
                ? "polled"
                : r.operation === "send"
                  ? "accepted_by_provider"
                  : "delivered",
            ...(r.operation === "poll"
              ? {
                  partition: "account-fixed",
                  previous: r.payload.cursor,
                  cursor: empty ? r.payload.cursor : "PRIVATE_PROCESS_CURSOR",
                  items,
                }
              : { providerId: "message-fixed" }),
          };
          return Response.json({
            receipt,
            signature: sign(keys.receipt, receipt),
          });
        },
      });
      writeFileSync(
        join(target, "config.json"),
        JSON.stringify({
          lifecycle,
          ingressOrigin: ingress?.url.origin,
          origin: provider.url.origin,
          expiresAt: Date.now() + 180000,
        }),
      );
      const run = async (stage: string, expected = 0) => {
        const child = Bun.spawn(
          [process.execPath, import.meta.path, target, "child", kind, stage],
          {
            env: { ...process.env, TMPDIR: "/tmp" },
            stdout: "pipe",
            stderr: "pipe",
            signal: AbortSignal.timeout(60000),
          },
        );
        const [out, err, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        writeFileSync(join(target, stage + ".log"), out + err);
        assert.equal(
          exit,
          expected,
          kind + " " + stage + " " + err.slice(-2500),
        );
      };
      try {
        if (lifecycle) {
          const requests = () =>
            db
              .query("SELECT request FROM requests ORDER BY seq")
              .all()
              .map((r: any) => JSON.parse(r.request));
          const rows = (phase: string) =>
            JSON.parse(readFileSync(join(target, phase + ".json"), "utf8"));
          const number = (op: string) =>
            requests().filter((r: any) => r.operation === op).length;
          if (mode === "boundaries") {
            await run("creation-cut", 79);
            assert.equal(number("subscribe"), 1);
            await run("recover-creation");
            assert.equal(number("subscribe"), 1);
            assert(
              rows("recover-creation").some(
                (e: any) =>
                  e.type === "AikoChannelSubscriptionSettled" &&
                  e.status === "unknown",
              ),
            );
            await run("reconcile-creation");
            const creation = requests().find(
              (r: any) => r.operation === "subscribe",
            );
            assert(
              requests().some(
                (r: any) =>
                  r.operation === "reconcile" &&
                  r.payload.operationId === creation.key,
              ),
            );
            assert(
              rows("reconcile-creation").some(
                (e: any) =>
                  e.type === "AikoChannelRenewSettled" &&
                  e.id === "create-reconcile" &&
                  e.status === "ready",
              ),
            );
            assert(
              rows("reconcile-creation").some(
                (e: any) => e.type === "AikoChannelBindingReady",
              ),
            );
            writeFileSync(
              join(target, "original-subscribe.json"),
              JSON.stringify(creation),
            );
            for (const [phase, status] of [
              ["pause", "paused"],
              ["resume", "active"],
            ]) {
              const before = requests().length;
              await run(phase + "-cut", 80);
              await run("recover-" + phase);
              const states = rows("recover-" + phase).filter(
                (e: any) => e.type === "AikoChannelLifecycle",
              );
              assert.equal(states.at(-1)?.status, status);
              assert.equal(
                requests().length,
                before,
                "Lifecycle recovery must not repeat provider mutations",
              );
            }
            await run("live-resume");
            assert.equal(number("subscribe"), 1);
          } else await run("setup");
          assert.equal(number("subscribe"), 1);
          await run("renew-cut", 79);
          assert.equal(number("renew"), 1);
          assert(
            rows("renew-cut").some(
              (e: any) =>
                e.type === "AikoChannelSubscriptionStarted" &&
                e.operation === "renew",
            ),
          );
          await run("recover-renew");
          assert(
            rows("recover-renew").some(
              (e: any) =>
                e.type === "AikoChannelRenewSettled" &&
                e.id === "renew-once" &&
                e.status === "unknown",
            ),
          );
          assert.equal(number("renew"), 1);
          await run("reconcile-renew");
          assert(
            rows("reconcile-renew").some(
              (e: any) =>
                e.type === "AikoChannelRenewSettled" &&
                e.id === "renew-reconcile" &&
                e.status === "ready",
            ),
          );
          const renewal = requests().find((r: any) => r.operation === "renew");
          assert(
            requests().some(
              (r: any) =>
                r.operation === "reconcile" &&
                r.payload.operationId === renewal.key &&
                r.payload.originalOperation === "renew",
            ),
          );
          await run("retire-cut", 79);
          assert.equal(number("remove"), 1);
          await run("recover-retire");
          assert.equal(number("remove"), 1);
          assert(
            rows("recover-retire").some(
              (e: any) =>
                e.type === "AikoChannelSubscriptionSettled" &&
                e.status === "unknown",
            ),
          );
          await run("reconcile-retire");
          assert(
            rows("reconcile-retire").some(
              (e: any) =>
                e.type === "AikoChannelLifecycle" && e.status === "retired",
            ),
          );
          const removal = requests().find((r: any) => r.operation === "remove");
          assert(
            requests().some(
              (r: any) =>
                r.operation === "reconcile" &&
                r.payload.operationId === removal.key,
            ),
          );
          const before = requests().length;
          await run("reopen");
          assert.equal(requests().length, before);
          assert.equal(
            db.query("SELECT count(*) AS n FROM subscriptions").get()!.n,
            0,
          );
          assert.equal(number("subscribe"), 1);
          assert.equal(number("renew"), 1);
          assert.equal(number("remove"), 1);
          if (mode === "boundaries") {
            const cutRows = rows("creation-cut");
            const armed = cutRows.findIndex(
              (e: any) => e.type === "AikoChannelIngressArmed",
            );
            const started = cutRows.findIndex(
              (e: any) => e.type === "AikoChannelSubscriptionStarted",
            );
            const received = cutRows.find(
              (e: any) => e.type === "AikoChannelReceived",
            );
            assert(armed >= 0 && armed < started);
            assert(received && received.generation === 1);
            assert(
              !cutRows.some(
                (e: any) =>
                  [
                    "AikoChannelInputAccepted",
                    "AikoChannelInputRejected",
                  ].includes(e.type) && e.id === received.id,
              ),
              "Early input is still queued at the process cut",
            );
            const decodeKey =
              createHash("sha256")
                .update(
                  JSON.stringify([
                    received.owner,
                    received.channel,
                    received.generation,
                    received.artifact.digest,
                    "decode",
                    received.id,
                  ]),
                )
                .digest("hex") + ":plan";
            assert(
              !cutRows.some(
                (e: any) =>
                  e.type === "AikoHarnessChecked" && e.id === decodeKey,
              ),
            );
            const recoveredCreation = rows("reconcile-creation");
            const checkedDecode = recoveredCreation.find(
              (e: any) => e.type === "AikoHarnessChecked" && e.id === decodeKey,
            );
            assert(
              checkedDecode && checkedDecode.witness.status === "satisfied",
            );
            assert.equal(
              checkedDecode.witness.harnessDigest,
              received.artifact.digest,
            );
            assert.equal(
              checkedDecode.witness.contractDigest,
              received.artifact.contractDigest,
            );
            assert(
              recoveredCreation.some(
                (e: any) =>
                  e.type === "AikoChannelInputAccepted" &&
                  e.id === received.id &&
                  e.artifact.digest === received.artifact.digest,
              ),
            );

            assert(
              !cutRows.some((e: any) => e.type === "AikoChannelBindingReady"),
            );
            assert(
              rows("reconcile-creation").some(
                (e: any) =>
                  e.type === "AikoChannelWiringSettled" &&
                  e.status === "satisfied",
              ),
            );
            assert(
              rows("reconcile-creation").some(
                (e: any) =>
                  e.type === "AikoChannelOutputSettled" &&
                  e.result.status === "accepted_by_provider",
              ),
            );
            assert.equal(
              db.query("SELECT status FROM ingress WHERE generation=1").get()!
                .status,
              202,
            );
            writeFileSync(
              join(target, "original-subscribe.json"),
              JSON.stringify(
                requests().find((r: any) => r.operation === "subscribe"),
              ),
            );
            await run("upgrade-cut", 80);
            assert.equal(
              number("subscribe"),
              1,
              "Upgrade intent cut precedes its physical subscription",
            );
            await run("recover-upgrade");
            assert.equal(number("subscribe"), 2);
            const upgraded = rows("recover-upgrade");
            const old = upgraded.find(
              (e: any) =>
                e.type === "AikoChannelBindingIntent" && e.generation === 1,
            );
            const next = upgraded.find(
              (e: any) =>
                e.type === "AikoChannelBindingIntent" && e.generation === 2,
            );
            assert(next);
            assert.notEqual(
              next.binding.artifact.digest,
              old.binding.artifact.digest,
            );
            for (const e of upgraded.filter(
              (e: any) => e.type === "AikoChannelReceived",
            )) {
              assert.equal(
                e.artifact.digest,
                e.generation === 1
                  ? old.binding.artifact.digest
                  : next.binding.artifact.digest,
              );
            }
            assert(
              upgraded.some(
                (e: any) =>
                  e.type === "AikoChannelReceived" && e.generation === 2,
              ),
            );
            assert.equal(
              db.query("SELECT status FROM ingress WHERE generation=2").get()!
                .status,
              202,
            );
            const prior = requests().length;
            await run("stale-upgrade");
            assert.equal(requests().length, prior);
            assert.deepEqual(
              JSON.parse(
                readFileSync(
                  join(target, "recover-upgrade-counts.json"),
                  "utf8",
                ),
              ),
              JSON.parse(
                readFileSync(join(target, "stale-upgrade-counts.json"), "utf8"),
              ),
            );
            assert(
              upgraded.some(
                (e: any) =>
                  e.type === "AikoChannelOutputSettled" &&
                  e.generation === 2 &&
                  e.result.status === "accepted_by_provider",
              ),
            );
            for (const received of upgraded.filter(
              (e: any) => e.type === "AikoChannelReceived",
            )) {
              const key =
                createHash("sha256")
                  .update(
                    JSON.stringify([
                      received.owner,
                      received.channel,
                      received.generation,
                      received.artifact.digest,
                      "decode",
                      received.id,
                    ]),
                  )
                  .digest("hex") + ":plan";
              const checked = upgraded.find(
                (e: any) => e.type === "AikoHarnessChecked" && e.id === key,
              );
              assert(checked && checked.witness.status === "satisfied");
              assert.equal(
                checked.witness.harnessDigest,
                received.artifact.digest,
              );
            }

            for (const phase of [
              "creation-cut",
              "recover-upgrade",
              "stale-upgrade",
            ])
              assert(!JSON.stringify(rows(phase)).includes("PRIVATE_EARLY_"));
          }
          observations.push({
            host: kind,
            creationPauseResumeCuts: mode === "boundaries",
            earlyIngressUpgradeFence: mode === "boundaries",
            renewalProcessCut: true,
            retirementProcessCut: true,
            originalKeyReconciliation: true,
            subscriptions: number("subscribe"),
            renewals: number("renew"),
            removals: number("remove"),
            reopenQuiet: true,
          });
          writeFileSync(
            join(target, "provider-requests.json"),
            JSON.stringify(requests(), null, 2),
          );
          writeFileSync(
            join(dir, "observed.json"),
            JSON.stringify(
              {
                status: "partial-C08",
                observations,
                remaining:
                  mode === "boundaries"
                    ? [
                        "Coordinated registration pending; other S24 children are outside this proof",
                      ]
                    : ["creation/pause/resume/upgrade cuts not exercised"],
              },
              null,
              2,
            ),
          );
          continue;
        }
        await run("cut", 78);
        const cut = JSON.parse(readFileSync(join(target, "cut.json"), "utf8"));
        assert(cut.some((e: any) => e.type === "AikoChannelPollFetched"));
        assert(!cut.some((e: any) => e.type === "AikoChannelCursorAdvanced"));
        const requests = () =>
          db
            .query("SELECT request FROM requests ORDER BY seq")
            .all()
            .map((r: any) => JSON.parse(r.request));
        assert.equal(
          requests().filter((r: any) => r.operation === "poll").length,
          1,
        );
        if (missing) {
          const fetched = cut.find(
            (e: any) => e.type === "AikoChannelPollFetched",
          );
          const key =
            "harness-blobs:" +
            harnessDigest("123") +
            ":" +
            fetched.privateRef.ref;
          const custody = new Database(
            join(target, kind === "bun" ? "workflows.sqlite" : "worker.sqlite"),
          );
          const table = kind === "bun" ? "workflow_records" : "fixture_kv";
          assert.equal(
            custody.query("DELETE FROM " + table + " WHERE key=?").run(key)
              .changes,
            1,
          );
          custody.close();
        }
        await run("recover");
        let rows = JSON.parse(
          readFileSync(join(target, "recover.json"), "utf8"),
        );
        assert.equal(
          requests().filter((r: any) => r.operation === "poll").length,
          1,
        );
        assert.equal(
          rows.filter((e: any) => e.type === "AikoChannelCursorAdvanced")
            .length,
          missing ? 0 : 1,
        );
        assert(
          rows.some(
            (e: any) =>
              e.type === "AikoChannelPollSettled" &&
              e.status === (missing ? "invalid_batch" : "accepted"),
          ),
        );

        if (!missing) {
          const cursorIndex = rows.findIndex(
            (e: any) => e.type === "AikoChannelCursorAdvanced",
          );
          const acceptedIndex = rows.findIndex(
            (e: any) => e.type === "AikoChannelInputAccepted",
          );
          const rejectedIndex = rows.findIndex(
            (e: any) =>
              e.type === "AikoChannelInputRejected" &&
              e.reason === "schema_invalid",
          );
          assert(
            acceptedIndex >= 0 &&
              rejectedIndex >= 0 &&
              acceptedIndex < cursorIndex &&
              rejectedIndex < cursorIndex,
            "Both batch dispositions precede cursor advancement",
          );
          assert(
            rows[acceptedIndex].privateRef,
            "Accepted item has retained private custody",
          );
        }
        const countRows = (phase: string) =>
          JSON.parse(
            readFileSync(join(target, phase + "-counts.json"), "utf8"),
          );
        if (missing) assert.deepEqual(countRows("recover"), countRows("cut"));
        else
          assert.deepEqual(
            countRows("recover").find((r: any) => r.kind === "model"),
            countRows("cut").find((r: any) => r.kind === "model"),
          );
        const before = requests().length;
        await run("reopen");
        assert.equal(requests().length, before);
        assert.deepEqual(countRows("reopen"), countRows("recover"));
        if (!missing) {
          empty = true;
          await run("quiet");
          assert.equal(
            requests().filter((r: any) => r.operation === "send").length,
            1,
          );
          assert.equal(
            requests().filter((r: any) => r.operation === "poll").length,
            2,
          );
        }
        if (!missing) {
          const quiet = JSON.parse(
            readFileSync(join(target, "quiet.json"), "utf8"),
          );
          const reopened = JSON.parse(
            readFileSync(join(target, "reopen.json"), "utf8"),
          );
          assert.deepEqual(
            quiet
              .filter((e: any) => e.type === "AikoChannelCursorAdvanced")
              .at(-1)?.cursor,
            reopened
              .filter((e: any) => e.type === "AikoChannelCursorAdvanced")
              .at(-1)?.cursor,
          );
          for (const type of [
            "AikoChannelInputAccepted",
            "AikoChannelInputRejected",
            "AikoChannelOutputSettled",
            "AikoReplyPrepared",
          ])
            assert.equal(
              quiet.filter((e: any) => e.type === type).length,
              reopened.filter((e: any) => e.type === type).length,
              "Unchanged poll is silent: " + type,
            );
        }
        rows = JSON.parse(readFileSync(join(target, "reopen.json"), "utf8"));
        assert(!JSON.stringify(rows).includes("PRIVATE_PROCESS_"));
        observations.push({
          host: kind,
          missing,
          cutProcessExit: 78,
          physicalPolls: requests().filter((r: any) => r.operation === "poll")
            .length,
          recoveryNoGet: true,
          cursorAdvances: missing ? 0 : 1,
          reopenQuiet: true,
          unchangedQuiet: !missing,
          missingStatus: missing ? "invalid_batch" : undefined,
        });
        writeFileSync(
          join(target, "provider-requests.json"),
          JSON.stringify(requests(), null, 2),
        );
        writeFileSync(
          join(dir, "observed.json"),
          JSON.stringify(
            { status: "partial", observations, wholeC08: false },
            null,
            2,
          ),
        );
      } catch (error) {
        writeFileSync(
          join(dir, "observed.json"),
          JSON.stringify(
            {
              status: "blocked",
              observations,
              failedCase: { host: kind, missing, error: String(error) },
              wholeC08: false,
            },
            null,
            2,
          ),
        );
        throw error;
      } finally {
        await ingress?.stop(true);
        await provider.stop(true);
        db.close();
      }
    }
  writeFileSync(
    join(dir, "observed.json"),
    JSON.stringify(
      {
        observations,
        remaining:
          mode === "boundaries"
            ? [
                "Coordinated registration pending; other S24 children are outside this proof",
              ]
            : lifecycle
              ? ["C08 creation/pause/resume/upgrade cuts not exercised"]
              : ["C08 renewal/retirement process cuts not exercised"],
        wholeC05: mode === "driver",
        wholeC08: mode === "boundaries",
        registration: "proposed-runtime-proof-only",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(observations));
} else {
  const retained = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  const provider = { url: new URL(retained.origin) };
  const token = "independent-owner-token-00112233445566",
    db = new Database(join(dir, "jobs.sqlite"));
  db.exec("CREATE TABLE IF NOT EXISTS fixture_counts(kind TEXT)");
  const count = (kind: string) => {
    db.query("INSERT INTO fixture_counts VALUES(?)").run(kind);
  };
  const local = localHarnessSandbox({
    owner: "123",
    environmentDigest: await sandboxEnvironment("independent-provider"),
    journal: await sandboxJobJournal(db, join(dir, "job.key")),
    send: async (r, s) => {
      assert.equal(new URL(r.url).origin, provider.url.origin);
      const response = await fetch(r.url, {
        method: r.method,
        headers: r.headers,
        body: r.body === undefined ? undefined : JSON.stringify(r.body),
        signal: s,
        redirect: "manual",
      });
      if (
        (stage === "creation-cut" &&
          new URL(r.url).pathname === "/subscribe") ||
        (stage === "renew-cut" && new URL(r.url).pathname === "/renew") ||
        (stage === "retire-cut" && new URL(r.url).pathname === "/remove")
      ) {
        await response.text();
        const host = await getHost();
        writeFileSync(
          join(dir, stage + ".json"),
          JSON.stringify(await host.read("user-123"), null, 2),
        );
        process.exit(79);
      }
      return {
        status: response.status,
        headers: { "content-type": "application/json" },
        body: await response.json(),
        classification: "application",
      };
    },
  });
  const policy: any = {
    id: "independent",
    revision: "v1",
    owner: "123",
    active: true,
    expiresAt: retained.expiresAt,
    account: "account-fixed",
    source: "source-fixed",
    destination: "destination-fixed",
    authorityRef: "provider-bind",
    sendAuthorityRef: "provider-send",
    ingressBaseUrl: retained.ingressOrigin ?? "http://127.0.0.1:1",
    origin: provider.url.origin,
    receiveKey: keys.receive,
    receiptKey: keys.receipt,
    requestToken: keys.request,
    endpoints: {
      poll: "/poll",
      send: "/send",
      reconcile: "/reconcile",
      ...(lifecycle
        ? { subscribe: "/subscribe", renew: "/renew", remove: "/remove" }
        : {}),
    },
    definition: { contract, verifier, artifact },
    maxInstances: 2,
    maxBytes: 4096,
    backlog: 8,
    retentionMs: 60000,
  };
  let program = "";
  program = `const a=await tools.call({name:'provider_adapter_acquire',arguments:{policy:'independent',operationId:'acquire-provider'}});if(a.status!=='ready')throw Error('not acquired');const h=await tools.call({name:'harness_acquire',arguments:{name:'channel.text.echo',operationId:'acquire-handler'}});if(h.status!=='ready')throw Error('handler unavailable');const l=await tools.call({name:'harness_list',arguments:{}}),e=l.candidates.find(x=>x.name==='channel.text.echo');const authorityRef='registry-internal:123';const p=await channels.bind({name:'input',schema:'text.message.v1',directions:['inbox','outbox'],authorityRef,operationId:'input'}),o=await channels.bind({name:'output',schema:'text.message.v1',directions:['inbox','outbox'],authorityRef,operationId:'output'});const w=await channels.connect({name:'hook',generation:1,input:{channel:p.channel,generation:p.generation},accepts:'text.message.v1',handler:{harness:e.harnessDigest,contract:e.contractDigest},output:{channel:o.channel,generation:o.generation,mode:'port'},start:'after-registration',authorityRef,operationId:'hook'});if(w.status!=='active')throw Error('inactive');return await tools.call({name:'provider_adapter_bind',arguments:{policy:'independent',name:'mail',digest:a.harnessDigest,generation:1,bridge:{operationId:'bridge',input:{channel:p.channel,generation:p.generation},output:{channel:o.channel,generation:o.generation},wiring:{id:w.id,generation:w.generation},decodeSchema:'provider.text.v1',expiresAt:Date.now()+90000}}});`;

  const model = Layer.succeed(Infer, {
    resolve: () => ({ model: { provider: "controlled", model_id: "fixture" } }),
    react: (r: any) => {
      count("model");
      return Effect.succeed(
        r.trajectory.some(
          (e: any) => e.type === "ToolReturned" && e.turn === r.identity.turn,
        )
          ? { kind: "complete" as const, output: "Setup completed" }
          : {
              kind: "call" as const,
              name: "execute",
              callId: "setup-" + r.identity.turn,
              arguments: { code: program },
            },
      );
    },
  });
  const config: any = {
    mode: "demo",
    codeMode: true,
    port: 0,
    stateDir: dir,
    operatorToken: "independent-operator-00112233445566",
    persona: PERSONA,
    voiceEnabled: false,
    allowedUsers: new Set(["123"]),
    planeCredentials: [
      {
        account: "123",
        digest: credentialDigest(token),
        scopes: ["read", "write"],
      },
    ],
  };
  const options = {
    model,
    registrySandbox: () => ({
      placement: "local" as const,
      sandbox: {
        harnessEnvironment: local.harnessEnvironment,
        harnessJob: async (j: any, s?: AbortSignal) => {
          count("job");
          return local.harnessJob(j, s);
        },
      },
      codeTransport: async (...a: Parameters<typeof runCodeSegment>) => {
        count("code");
        return runCodeSegment(...a);
      },
    }),
    providerAdapters: (owner: string) => (owner === "123" ? [policy] : []),
  };
  let account: any,
    workerDb: Database | undefined,
    registryDb: Database | undefined,
    service: any;
  const startup = (event: string) =>
    appendFileSync(
      join(dir, stage + "-startup.jsonl"),
      JSON.stringify({ event, at: Date.now() }) + "\n",
    );
  const ingressReady = Promise.withResolvers<void>();
  const ingressServer = retained.ingressOrigin
    ? Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (req) => {
          startup("ingress_waiting_for_service");
          await ingressReady.promise;
          startup("ingress_dispatched");
          return service.fetch(req);
        },
      })
    : undefined;
  if (ingressServer)
    writeFileSync(join(dir, "ingress-target.txt"), ingressServer.url.origin);
  startup("service_constructing");
  if (hostKind === "bun") service = await createService(config, options);
  else {
    const module = await workerModule();
    workerDb = new Database(join(dir, "worker.sqlite"));
    registryDb = new Database(join(dir, "registry.sqlite"));
    const env: any = {
      AIKO_MODE: "live",
      AIKO_CODE_MODE: "true",
      AIKO_INSTANCE_ID: "independent-worker",
      AIKO_REPLY_STYLE: "direct",
      AIKO_OPERATOR_TOKEN: config.operatorToken,
      CODEGRAFF_API_KEY: "controlled-unused-model",
      AIKO_ALLOWED_USERS: "123",
      AIKO_PLANE_CREDENTIALS: JSON.stringify(config.planeCredentials),
      AIKO_VOICE_ENABLED: "false",
      AIKO_PROVIDER_ADAPTERS: options.providerAdapters,
      AIKO_REGISTRY_SANDBOX: options.registrySandbox,
      AIKO_MODEL_FETCH: async (_url: unknown, init?: RequestInit) => {
        count("model");
        // The controlled provider derives continuation from the actual wire
        // history, so a new OS process does not re-issue a completed tool call.
        const messages = JSON.parse(String(init?.body)).messages as any[];
        const lastUser = messages.findLastIndex((m) => m.role === "user");
        const called = messages
          .slice(lastUser + 1)
          .some((m) => m.role === "tool");
        const delta = called
          ? { content: "Setup complete" }
          : {
              tool_calls: [
                {
                  index: 0,
                  id:
                    "controlled-" +
                    harnessDigest(messages[lastUser]).slice(-16),
                  type: "function",
                  function: {
                    name: "execute",
                    arguments: JSON.stringify({ code: program }),
                  },
                },
              ],
            };
        return new Response(
          [
            { choices: [{ index: 0, delta, finish_reason: null }] },
            {
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: called ? "stop" : "tool_calls",
                },
              ],
              usage: { prompt_tokens: 30, completion_tokens: 10, cost: 0 },
            },
          ]
            .map((e) => "data: " + JSON.stringify(e) + "\n\n")
            .join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    };
    const id = (name: string) => ({
      name,
      equals: (other: any) => other?.name === name,
      toString: () => name,
    });
    const registry = new module.AikoRegistryDO(
      { storage: storage(registryDb) },
      env,
    );
    env.AIKO_REGISTRY = { getByName: () => registry };
    env.AIKO_ACCOUNTS = {
      idFromName: id,
      getByName: (name: string) => {
        assert.equal(name, module.accountObjectName("123"));
        return account;
      },
    };
    account = new module.AikoAccountDO(
      {
        id: id(module.accountObjectName("123")),
        storage: storage(workerDb),
        waitUntil: () => {},
        blockConcurrencyWhile: (fn: any) => fn(),
      },
      env,
    );
    service = {
      fetch: (r: Request) => module.default.fetch(r, env),
      close: async () => {
        await (await account.runtime)?.host.close();
      },
    };
  }
  startup("service_ready");
  ingressReady.resolve();
  const request = (path: string, body?: any) =>
    service.fetch(
      new Request("http://localhost" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const getHost = async () =>
    hostKind === "bun" ? service.host : (await account.runtime).host;
  const drive = async () => {
    for (let i = 0; i < 4; i++)
      if (hostKind === "bun") await service.host.wake("user-123");
      else await account.alarm();
  };
  try {
    if (stage === "cut" || stage === "setup" || stage === "creation-cut") {
      const response = await request("/api/messages", {
        id: "provider-recovery-setup",
        text: "Run controlled setup",
      });
      assert.equal(response.status, 202, await response.text());
      await drive();
    } else {
      await request("/api/harness/readiness");
      await drive();
    }
    const host = await getHost(),
      rows = await host.read("user-123"),
      binding = rows.find((e: any) => e.type === "AikoChannelBindingIntent");
    assert(binding, "binding unavailable");
    if (stage === "upgrade-cut") {
      const wire = rows.find(
        (e: any) => e.type === "AikoChannelWiringConnected",
      ).wire;
      const next = {
        ...artifact,
        files: {
          "main.js":
            'const request=input;if(request.operation==="decode")return {kind:"external",schemaVersion:"provider.text.v1",text:JSON.parse(request.input.body).message};return {payload:request.input};',
        },
      };
      const args = {
        policy: "independent",
        name: "mail",
        generation: 2,
        bridge: {
          operationId: "bridge-v2",
          input: wire.input,
          output: {
            channel: wire.output.channel,
            generation: wire.output.generation,
          },
          wiring: { id: wire.id, generation: wire.generation },
          decodeSchema: "provider.text.v1",
          expiresAt: Date.now() + 90000,
        },
      };
      program = `const next=await tools.call({name:"provider_adapter_acquire",arguments:{policy:"independent",operationId:"acquire-v2",candidate:${JSON.stringify(next)}}});if(next.status!=="ready")throw Error("upgrade unavailable");return await tools.call({name:"provider_adapter_bind",arguments:{...${JSON.stringify(args)},digest:next.harnessDigest}});`;
      const seed = host.seed.bind(host);
      host.seed = async (thread: string, events: any[]) => {
        await seed(thread, events);
        if (
          events.some(
            (e) => e.type === "AikoChannelBindingIntent" && e.generation === 2,
          )
        ) {
          writeFileSync(
            join(dir, stage + ".json"),
            JSON.stringify(await host.read("user-123"), null, 2),
          );
          process.exit(80);
        }
      };
      const response = await request("/api/messages", {
        id: "provider-upgrade-cut",
        text: "Run controlled upgrade",
      });
      assert.equal(response.status, 202, await response.text());
      await drive();
      writeFileSync(
        join(dir, "upgrade-not-reached.json"),
        JSON.stringify(await host.read("user-123"), null, 2),
      );
      throw Error("Upgrade intent cut not reached");
    }
    if (stage === "recover-upgrade" && hostKind === "bun") {
      const ready = await request("/ready");
      assert.equal(ready.status, 200, await ready.text());
    }
    if (["stale-upgrade", "recover-pause", "live-resume"].includes(stage)) {
      const original = JSON.parse(
        readFileSync(join(dir, "original-subscribe.json"), "utf8"),
      );
      const body = JSON.stringify({ message: "PRIVATE_STALE_GENERATION" }),
        occurrence = stage,
        conversation = "controlled-conversation";
      const response = await service.fetch(
        new Request(original.webhook, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-channel-receive-capability": original.receiveCapability,
            "x-provider-occurrence": occurrence,
            "x-provider-conversation": conversation,
            "x-provider-signature": createHmac("sha256", keys.receive)
              .update(
                JSON.stringify([
                  "123",
                  original.account,
                  original.channel,
                  original.generation,
                  occurrence,
                  conversation,
                  body,
                ]),
              )
              .digest("hex"),
          },
          body,
        }),
      );
      assert.equal(
        response.status,
        stage === "recover-pause" ? 409 : stage === "live-resume" ? 202 : 403,
        await response.text(),
      );
      await drive();
    }
    if (stage === "cut") {
      const seed = host.seed.bind(host);
      host.seed = async (thread: string, events: any[]) => {
        await seed(thread, events);
        if (events.some((e) => e.type === "AikoChannelPollFetched")) {
          writeFileSync(
            join(dir, "cut.json"),
            JSON.stringify(await host.read("user-123"), null, 2),
          );
          writeFileSync(
            join(dir, "cut-counts.json"),
            JSON.stringify(
              db
                .query(
                  "SELECT kind,count(*) AS count FROM fixture_counts GROUP BY kind",
                )
                .all(),
            ),
          );
          process.exit(78);
        }
      };
      assert.equal(
        (
          await request("/v1/channels/poll", {
            id: binding.channel,
            generation: 1,
            partition: "provider",
            operationId: "first",
          })
        ).status,
        202,
      );
      await drive();
      throw Error("Cut was not reached");
    }
    if (stage === "pause-cut" || stage === "resume-cut") {
      const status = stage === "pause-cut" ? "paused" : "active";
      const seed = host.seed.bind(host);
      host.seed = async (thread: string, events: any[]) => {
        await seed(thread, events);
        if (
          events.some(
            (e) => e.type === "AikoChannelLifecycle" && e.status === status,
          )
        ) {
          writeFileSync(
            join(dir, stage + ".json"),
            JSON.stringify(await host.read("user-123"), null, 2),
          );
          process.exit(80);
        }
      };
      const result = await request("/v1/channels/lifecycle", {
        id: binding.channel,
        generation: 1,
        status,
        operationId: stage,
        authorization: "provider-bind",
      });
      assert.equal(result.status, 202, await result.text());
      await drive();
      throw Error("Lifecycle retained cut not reached");
    }
    if (
      [
        "renew-cut",
        "reconcile-renew",
        "reconcile-retire",
        "reconcile-creation",
      ].includes(stage)
    ) {
      const result = await request("/v1/channels/subscription", {
        id: binding.channel,
        generation: 1,
        operation: stage === "renew-cut" ? "renew" : "reconcile",
        operationId:
          stage === "renew-cut"
            ? "renew-once"
            : stage === "reconcile-renew"
              ? "renew-reconcile"
              : stage === "reconcile-creation"
                ? "create-reconcile"
                : "retire-reconcile",
        authorization: "provider-bind",
        ...(stage === "reconcile-renew"
          ? { originalRenewalId: "renew-once" }
          : {}),
      });
      assert.equal(result.status, 202, await result.text());
      await drive();
      if (stage === "renew-cut")
        throw Error("Renewal physical cut not reached");
    }
    if (stage === "retire-cut") {
      const result = await request("/v1/channels/lifecycle", {
        id: binding.channel,
        generation: 1,
        status: "retiring",
        operationId: "retire-once",
        authorization: "provider-bind",
      });
      assert.equal(result.status, 202, await result.text());
      await drive();
      throw Error("Retirement physical cut not reached");
    }
    if (stage === "quiet") {
      assert.equal(
        (
          await request("/v1/channels/poll", {
            id: binding.channel,
            generation: 1,
            partition: "provider",
            operationId: "quiet",
          })
        ).status,
        202,
      );
      await drive();
    }
    writeFileSync(
      join(dir, stage + ".json"),
      JSON.stringify(await host.read("user-123"), null, 2),
    );
    writeFileSync(
      join(dir, stage + "-counts.json"),
      JSON.stringify(
        db
          .query(
            "SELECT kind,count(*) AS count FROM fixture_counts GROUP BY kind",
          )
          .all(),
      ),
    );
  } finally {
    await ingressServer?.stop(true);
    await service.close();
    workerDb?.close();
    registryDb?.close();
    db.close();
  }
}
