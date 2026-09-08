import assert from "node:assert/strict";
import { createUnlockClient } from "../packages/sdk/dist/index.js";
import {
  createRuntimeClient,
  createSessionBridge,
} from "../packages/sdk/dist/runtime.js";
const origin = process.env.UNLOCK_BASE_URL ?? "http://127.0.0.1:4173";
const api = createUnlockClient({ baseUrl: `${origin}/api` });
const runtime = createRuntimeClient({ baseUrl: `${origin}/api` });
const checks = [];
const pass = (name) => {
  checks.push(name);
  if (!process.argv.includes("--json")) console.log(`PASS: ${name}`);
};
try {
  await api.reset();
  assert.equal((await api.workspace()).connections.length, 4);
  pass("HTTP management SDK reads seeded workspace");
  const updated = await api.connections.update("github", {
    name: "GitHub work",
    favorite: false,
  });
  assert.equal(updated.name, "GitHub work");
  assert.equal(updated.favorite, false);
  pass("HTTP vault metadata PATCH saves names and favorites");
  await api.connections.assign("github", ["builder", "research"]);
  await runtime.retrieve({ connectionId: "github", profileId: "research" });
  await api.connections.assign("github", ["builder"]);
  await assert.rejects(
    runtime.retrieve({ connectionId: "github", profileId: "research" }),
    { code: "FORBIDDEN" },
  );
  pass(
    "HTTP access PUT grants and removes standing access without duplicating logins",
  );
  const rows = [0, 1].map((i) => ({
    row: i + 2,
    name: `CSV ${i}`,
    domain: `csv-${i}.example.test`,
    identity: `user${i}@demo.example`,
  }));
  assert.equal((await api.connections.importCsv({ rows })).imported, 2);
  assert.equal((await api.connections.importCsv({ rows })).duplicates, 2);
  assert.equal(
    (await api.connections.list()).filter((c) => c.passwordUnavailable).length,
    2,
  );
  pass(
    "HTTP CSV bulk import creates independent password-free metadata and skips repeated rows",
  );
  const c = await api.connections.connect({
    fixture: "vercel",
    mode: "sso",
    profileIds: ["builder"],
  });
  assert.equal(c.sourceMode, "sso");
  assert.equal(c.sourceId, "google");
  pass("HTTP connect creates destination SSO metadata and assignment");
  let cookies = [];
  const bridge = createSessionBridge(
    runtime,
    {
      async replaceCookies(next) {
        cookies = structuredClone(next);
      },
      async exportCookies() {
        return structuredClone(cookies);
      },
    },
    { connectionId: c.id, profileId: "builder" },
  );
  assert.deepEqual(await bridge.initialize(), { revision: 1 });
  assert.deepEqual(await bridge.sync(), { revision: 2 });
  pass("HTTP private runtime hydrates a fake browser and syncs a new revision");
  await api.connections.action(c.id, "refresh");
  await assert.rejects(bridge.sync(), { code: "CONFLICT", status: 409 });
  await bridge.recover();
  assert.deepEqual(await bridge.sync(), { revision: 4 });
  pass("HTTP revision conflict refuses stale overwrite and supports recovery");
  await api.connections.action(c.id, "revoke");
  await assert.rejects(bridge.sync(), { code: "FORBIDDEN" });
  pass("HTTP revocation blocks subsequent synchronization");
  for (const path of [
    "/",
    "/accounts",
    "/accounts/github",
    "/connect",
    "/agents",
    "/sessions",
    "/sources",
    "/activity",
    "/developers",
    "/settings",
  ]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), /<html lang="en"/);
  }
  pass("Ten Start HTML deep links return 200");
  const missing = await fetch(origin + "/not-a-real-page");
  assert.equal(missing.status, 404);
  pass("Unknown route returns 404");
  console.log(
    JSON.stringify({ origin, passed: checks.length, failed: 0, checks }, null, 2),
  );
} finally {
  await api.reset();
}
