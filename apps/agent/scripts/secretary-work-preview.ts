/** Local-only UI witness with the real work API and native coordinator; no provider credentials or sends. */
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { actor } from "tardie";
import { createBunHost, type BunHost } from "tardie/bun/host";
import { handles } from "tardie/core/actor/contract";
import {
  secretaryCoordination,
  workWaitMethod,
} from "../src/secretary-coordination.ts";
import {
  createSecretaryWorkBinding,
  secretaryWorkApi,
} from "../src/secretary-work.ts";
import { secretaryEventKey } from "../src/secretary-state.ts";
import { workAppendAllowed, workEventKey } from "../src/commitments.ts";
import type { SecretaryWorkBinding } from "../src/secretary-policy.ts";

const root = new URL("../../../", import.meta.url).pathname;
const outdir = join(root, "artifacts/secretary-work/preview");
const built = await Bun.build({
  entrypoints: [join(root, "apps/web/test/secretary-work.fixture.tsx")],
  outdir,
  target: "browser",
  minify: false,
});
if (!built.success) throw Error(built.logs.join("\n"));
const dir = await mkdtemp("/tmp/aiko-secretary-preview-"),
  owner = "123",
  thread = "user-123";
const connection = {
  id: "preview-business",
  owner,
  ownerChat: owner,
  enabled: true,
  canReply: true,
  canRead: true,
};
let binding!: SecretaryWorkBinding, host!: BunHost;
const definition = () =>
  actor({
    name: "aiko",
    methods: { workWait: workWaitMethod },
    components: [handles(workWaitMethod, secretaryCoordination(binding))],
  });
host = await createBunHost({
  database: join(dir, "actor.sqlite"),
  actorName: "aiko",
  actorInstance: "preview",
  threadDatabase: (t) => join(dir, t + ".sqlite"),
  actorFor: (t) => (t === thread ? definition() : undefined),
  keyOf: (e) => workEventKey(e) ?? secretaryEventKey(e),
  canAppend: workAppendAllowed,
});
binding = createSecretaryWorkBinding(
  host,
  {
    owner,
    thread,
    stateDir: dir,
    redact: (s) => s,
    readPage: (after, limit) => host.readPage(thread, after, limit),
  },
  {
    resolve: async () => connection,
    receive: async () => undefined,
    markRead: async () => {},
    send: async () => ({
      status: "delivered",
      providerId: "preview-" + crypto.randomUUID(),
    }),
  },
);
let ordinal = 1;
async function incoming(text: string) {
  const id = String(ordinal++);
  await host.commitRoot(host.self("secretary-123"), {
    type: "AikoSecretaryUpdate",
    id,
    updateId: Number(id),
    at: Date.now(),
    update: {
      kind: "message",
      connection,
      message: {
        connectionId: connection.id,
        chat: "456",
        chatType: "private",
        name: "Maya",
        messageId: Number(id),
        sender: "456",
        text,
        date: Math.floor(Date.now() / 1000),
        viaBot: false,
        unsupported: false,
      },
    },
  });
  await host.commitRoot(host.self(thread), {
    type: "AikoWorkContactObserved",
    owner,
    id,
    at: Date.now(),
  });
  await host.wake(thread);
}
await incoming("Hi, what should I prepare?");
await host.commitRoot(host.self("secretary-123"), {
  type: "AikoSecretaryGrant",
  id: "preview-grant",
  connectionId: connection.id,
  chat: "456",
  enabled: true,
  at: Date.now(),
});
const html =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aiko secretary work preview</title><link rel="stylesheet" href="/secretary-work.fixture.css"></head><body><div id="root"></div><script type="module" src="/secretary-work.fixture.js"></script></body></html>';
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 4129,
  async fetch(request) {
    const url = new URL(request.url);
    if (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/preview/")
    ) {
      if (
        request.headers.get("authorization") !== "Bearer secretary-preview-only"
      )
        return new Response("Unauthorized", { status: 401 });
      if (url.pathname === "/api/secretary/work")
        return secretaryWorkApi(request, binding, () => host.wake(thread));
      if (url.pathname === "/preview/reply" && request.method === "POST") {
        await incoming(
          "1. Launch readiness\n2. Budget approval\n3. Hiring plan",
        );
        return Response.json({ status: "received" });
      }
      return new Response("Not found", { status: 404 });
    }
    if (
      ["/secretary-work.fixture.css", "/secretary-work.fixture.js"].includes(
        url.pathname,
      )
    )
      return new Response(Bun.file(outdir + url.pathname));
    if (url.pathname === "/")
      return new Response(html, { headers: { "content-type": "text/html" } });
    return new Response("Not found", { status: 404 });
  },
});
console.log(
  "Secretary preview ready at " + server.url + " — synthetic data only",
);
process.on("SIGINT", async () => {
  await host.close();
  server.stop(true);
  process.exit(0);
});
