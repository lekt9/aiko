/** Operator-only verification through the SAME native code/tool runtime.
 * No paid model, default user, browser profile, OAuth consent or email send.
 * bun scripts/verify-integrations.ts --owner local --instance demo --request request.json
 * request.json: {server:"composio", tool?:"COMPOSIO_SEARCH_TOOLS", arguments?:{...}}
 * Omit tool to inspect live meta schemas. Only read tools are accepted here.
 */
import { Database } from "bun:sqlite";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Effect, Layer } from "effect";
import { actor, agentMessageMethod, codeMode, infer, Infer, outputValidateOnce } from "tardie";
import { CodeHarness } from "../src/code-harness.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";
import { FileConnectorStore } from "../src/connectors-store.ts";
import { configuredIntegrations } from "../src/integrations.ts";
import { safeUserId } from "../src/security.ts";
import { validateRouterInput } from "../src/connector-router-host.ts";

const { values } = parseArgs({ args: process.argv.slice(2), options: { owner: { type: "string" }, instance: { type: "string" }, request: { type: "string" }, state: { type: "string" }, evidence: { type: "string" } }, strict: true });
if (!safeUserId(values.owner) || !values.instance || !values.request) throw Error("Explicit --owner, --instance and --request are required. Use the deployment's existing identity.");
const owner = values.owner, thread = `user-${owner}`;
const input = JSON.parse(await readFile(values.request, "utf8"));
validateRouterInput(input);
if (!["composio", "agentmail"].includes(input.server)) throw Error("Invalid integration server");
const db = new Database(":memory:");
let alarm: number | null = null;
const storage: AccountStorage = {
  sql: { exec: (sql, ...args) => { const rows = db.query(sql).all(...args as any); return { toArray: () => rows as never }; } },
  transactionSync: fn => db.transaction(fn)(), sync: async () => {}, getAlarm: async () => alarm,
  setAlarm: async at => { alarm = at; }, deleteAlarm: async () => { alarm = null; },
};
const gateway = configuredIntegrations({ owner, thread, instance: values.instance,
  config: { owners: [owner], composioKey: process.env.COMPOSIO_API_KEY, agentmailKey: process.env.AGENTMAIL_API_KEY },
  store: new FileConnectorStore(resolve(values.state ?? ".aiko/integration-verification")), current: () => true,
  read: async () => [], deliverLinks: async () => "rejected",
});
if (!gateway) throw Error("Configure COMPOSIO_API_KEY or AGENTMAIL_API_KEY in the private environment");
const redact = gateway.binding.redact;
const harness = new CodeHarness(owner, thread, runCodeSegment, redact);
const code = `const input=${JSON.stringify(input)};
const list=await tools.call({name:'integration_list',arguments:{}});
const grant=list.servers?.find(s=>s.id===input.server);
if(!grant)throw Error('Integration not mounted');
if(input.tool && !grant.tools.some(t=>t.name===input.tool && t.effect==='read'))throw Error('This verifier permits read tools only');
const catalog=await tools.call({name:'integration_tools',arguments:{server:input.server}});
if(!input.tool)return catalog;
const tool=catalog.tools?.find(t=>t.name===input.tool);
if(!tool)return catalog;
return await tools.call({name:'integration_call',arguments:{server:input.server,tool:input.tool,schemaDigest:tool.schemaDigest,arguments:input.arguments??{}}});`;
let calls = 0, result: unknown;
const model = Layer.succeed(Infer, {
  resolve: () => ({ model: { provider: "local-verifier", model_id: "no-inference" } }),
  react: (request: any) => {
    if (calls++ === 0) return Effect.succeed({ kind: "call" as const, name: "execute", callId: "integration-verification", arguments: { code } });
    result = request.trajectory.findLast((e: any) => e.type === "ToolReturned")?.result;
    return Effect.succeed({ kind: "complete" as const, output: "Verification attempted; inspect result and receipts." });
  },
});
const definition = actor({ name: "aiko", methods: { message: agentMessageMethod }, components: [infer([codeMode([harness.package(gateway.tools())]), outputValidateOnce])] });
const host = await createCloudflareAccountHost({ storage, actorName: "aiko", actorInstance: values.instance,
  ownsThread: t => t === thread, actorFor: () => definition,
  layersFor: () => Layer.merge(harness.inference(model), harness.sandboxLayer()),
});
try {
  await host.commitRoot(host.self(thread), { type: "MessageReceived", id: "integration-verification", text: "Run the operator-authorized read-only integration verification", at: Date.now() });
  await host.drive();
  const rows = await host.read(thread);
  const receipts = rows.filter(e => e.type === "AikoMcpToolObserved" && e.namespace === "integration");
  const summary = { at: new Date().toISOString(), owner, instance: values.instance, server: input.server, tool: input.tool ?? "catalog",
    paidInference: false, telegramDelivery: false, result, receipts };
  const serialized = redact(JSON.stringify(summary, null, 2));
  console.log(serialized);
  if (values.evidence) {
    // Evidence can contain private API results; operator explicitly picks an
    // owner-only file. Never upload raw mail or credentials as public evidence.
    const path = resolve(values.evidence);
    await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(path, serialized + "\n", { flag: "wx", mode: 0o600 });
  }
  if (!rows.some(e => e.type === "TurnCompleted") || (input.tool && !receipts.some(e => e.status === "completed" && e.succeeded))) process.exitCode = 1;
} finally { await host.close(); await gateway.close(); db.close(); }
