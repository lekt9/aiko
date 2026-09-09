import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../src/server.ts";
import { PERSONA } from "../src/config.ts";
import { credentialDigest } from "../src/plane-auth.ts";

test("local scheduled-task routes explain unsupported execution without accepting decisions", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "scheduled-task-disabled-"));
  const token = "synthetic-scheduled-task-owner-token";
  const service = await createService({ mode: "demo", port: 4242, stateDir, operatorToken: "synthetic-scheduled-task-operator-token",
    persona: PERSONA, voiceEnabled: false, allowedUsers: new Set(["123"]),
    planeCredentials: [{ account: "123", digest: credentialDigest(token), scopes: ["read", "write"] }],
  });
  const request = (auth?: string) => new Request("http://localhost/api/promises/decision", { method: "POST",
    headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), "content-type": "application/json" },
    body: JSON.stringify({ id: "saved-task", hash: "frozen-task", decision: "approve" }),
  });
  try {
    expect((await service.fetch(request())).status).toBe(401);
    const result = await service.fetch(request(token));
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({
      error: "promises_unavailable",
      message: "Scheduled tasks need a configured native code executor. Your saved tasks have not been changed.",
    });
    expect((await service.fetch(request("synthetic-scheduled-task-operator-token"))).status).toBe(403);
    // Reading an unregistered native thread opens it; inspect the directory
    // instead so the no-task assertion itself does not create work.
    expect(await service.host.threads()).toEqual([]);
  } finally { await service.close(); await rm(stateDir, { recursive: true, force: true }); }
});
