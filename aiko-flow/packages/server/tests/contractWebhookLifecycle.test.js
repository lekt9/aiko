import { describe, expect, test } from "bun:test";
import { createContractWebhookLifecycle, WebhookLifecycleError } from "../src/contractWebhookLifecycle.js";

const A = Object.freeze({ authenticatedSubject: "user:alice", verifiedTenant: "tenant-a", grantedScopes: ["hooks:write", "orders:declare"] });
const B = Object.freeze({ authenticatedSubject: "user:bob", verifiedTenant: "tenant-b", grantedScopes: ["hooks:write", "orders:declare"] });
const declaration = () => ({
  provider: "github.v1", audience: "https://hooks.example.test/github", route: "/v1/hooks/github",
  methods: ["POST"], contentType: "application/json", bodyLimitBytes: 65536,
  credentialHandle: { handle: "cred_github_0001", generation: 4 }, replayWindowSeconds: 300,
  contractTemplate: { name: "github.pull-request", generation: 2 }, requiredScopes: ["hooks:write"],
});

function fakeContract() {
  const records = new Map();
  const commands = [];
  const key = (tenantId, endpointId) => `${tenantId}\0${endpointId}`;
  return {
    commands,
    async read(q) {
      if (q.projection === "webhook_endpoints") return [...records.values()].filter((r) => r.tenantId === q.tenantId).map(structuredClone);
      const value = records.get(key(q.tenantId, q.endpointId));
      return value && structuredClone(value);
    },
    async command(c) {
      const k = key(c.tenantId, c.endpointId);
      const current = records.get(k);
      const generation = current?.endpointGeneration ?? 0;
      if (generation !== c.expectedGeneration) throw new WebhookLifecycleError("CAS_CONFLICT", "Contract CAS conflict");
      commands.push(structuredClone(c));
      records.set(k, structuredClone(c.next));
    },
    inject(record) { records.set(key(record.tenantId, record.endpointId), structuredClone(record)); },
  };
}
function harness() {
  const contract = fakeContract();
  let id = 0;
  const lifecycle = createContractWebhookLifecycle({ contract, allocateEndpointId: () => `wh_${String(++id).padStart(16, "0")}` });
  return { contract, lifecycle };
}
async function rejectsCode(fn, code) {
  try { await fn(); } catch (error) { expect(error).toBeInstanceOf(WebhookLifecycleError); expect(error.code).toBe(code); return; }
  throw new Error(`expected ${code}`);
}

describe("Contract webhook endpoint lifecycle kernel", () => {
  test("server allocates opaque IDs and Contract is the only store", async () => {
    const { contract, lifecycle } = harness();
    const created = await lifecycle.create(A, declaration());
    expect(created.endpointId).toBe("wh_0000000000000001");
    expect(created.endpointGeneration).toBe(1);
    expect(created.credentialHandle.generation).toBe(4);
    expect(contract.commands).toHaveLength(1);
    expect(JSON.stringify(contract.commands)).not.toMatch(/rawBody|secretBytes|secretValue|payload/);
    await rejectsCode(() => lifecycle.create(A, { ...declaration(), endpointId: "wh_callerchosen0000" }), "CALLER_AUTHORITY");
    await rejectsCode(() => lifecycle.create(A, { ...declaration(), tenantId: "tenant-b" }), "CALLER_AUTHORITY");
    await rejectsCode(() => lifecycle.create(A, { ...declaration(), secret: "hunter2" }), "CALLER_AUTHORITY");
    await rejectsCode(() => lifecycle.create(A, { ...declaration(), rawBody: "{}" }), "CALLER_AUTHORITY");
  });

  test("list and inspect are tenant-scoped projections", async () => {
    const { lifecycle } = harness();
    const a = await lifecycle.create(A, declaration());
    const b = await lifecycle.create(B, declaration());
    expect((await lifecycle.list(A)).map((x) => x.endpointId)).toEqual([a.endpointId]);
    expect((await lifecycle.list(B)).map((x) => x.endpointId)).toEqual([b.endpointId]);
    await rejectsCode(() => lifecycle.inspect(B, a.endpointId), "NOT_FOUND");
  });

  test("rotate is CAS-protected and advances both fences", async () => {
    const { lifecycle } = harness();
    const endpoint = await lifecycle.create(A, declaration());
    await rejectsCode(() => lifecycle.rotate(A, endpoint.endpointId, {
      expectedGeneration: 1, credentialHandle: { handle: "cred_github_0002", generation: 4 },
    }), "CREDENTIAL_FENCE");
    const rotated = await lifecycle.rotate(A, endpoint.endpointId, {
      expectedGeneration: 1, credentialHandle: { handle: "cred_github_0002", generation: 5 },
    });
    expect(rotated.endpointGeneration).toBe(2);
    expect(rotated.credentialHandle.generation).toBe(5);
    await rejectsCode(() => lifecycle.rotate(A, endpoint.endpointId, {
      expectedGeneration: 1, credentialHandle: { handle: "cred_github_0003", generation: 6 },
    }), "CAS_CONFLICT");
    await rejectsCode(() => lifecycle.authorizeGeneration(A, endpoint.endpointId, { endpointGeneration: 1, credentialGeneration: 4 }), "FENCED");
  });

  test("pause and revoke monotonically fence all old generations", async () => {
    const { lifecycle } = harness();
    const endpoint = await lifecycle.create(A, declaration());
    const paused = await lifecycle.pause(A, endpoint.endpointId, { expectedGeneration: 1 });
    expect(paused.status).toBe("paused");
    expect(paused.endpointGeneration).toBe(2);
    await rejectsCode(() => lifecycle.authorizeGeneration(A, endpoint.endpointId, { endpointGeneration: 1, credentialGeneration: 4 }), "FENCED");
    await rejectsCode(() => lifecycle.authorizeGeneration(A, endpoint.endpointId, { endpointGeneration: 2, credentialGeneration: 4 }), "FENCED");
    const revoked = await lifecycle.revoke(A, endpoint.endpointId, { expectedGeneration: 2 });
    expect(revoked.status).toBe("revoked");
    expect(revoked.endpointGeneration).toBe(3);
    await rejectsCode(() => lifecycle.authorizeGeneration(A, endpoint.endpointId, { endpointGeneration: 3, credentialGeneration: 4 }), "FENCED");
    await rejectsCode(() => lifecycle.rotate(A, endpoint.endpointId, { expectedGeneration: 3, credentialHandle: { handle: "cred_github_0005", generation: 5 } }), "FENCED");
  });

  test("bindings are closed and cannot widen scope or smuggle store fields", async () => {
    const { lifecycle } = harness();
    for (const mutation of [
      { methods: ["GET"] }, { route: "/v1/*" }, { bodyLimitBytes: 10 * 1024 * 1024 + 1 },
      { audience: "http://hooks.example.test" }, { contentType: "text/plain" },
      { replayWindowSeconds: 86401 }, { requiredScopes: ["admin"] },
      { contractTemplate: { name: "github.pull-request", generation: 2, store: "other" } },
      { credentialHandle: { handle: "cred_github_0001", generation: 4, secret: "x" } },
    ]) {
      await expect(lifecycle.create(A, { ...declaration(), ...mutation })).rejects.toBeInstanceOf(WebhookLifecycleError);
    }
    const endpoint = await lifecycle.create(A, declaration());
    await rejectsCode(() => lifecycle.pause(A, endpoint.endpointId, { expectedGeneration: 1, status: "active" }), "CALLER_AUTHORITY");
    await rejectsCode(() => lifecycle.rotate(A, endpoint.endpointId, {
      expectedGeneration: 1, credentialHandle: { handle: "cred_github_0002", generation: 5 }, route: "/wider",
    }), "CLOSED_BINDING");
  });

  test("malicious Contract projection cannot cross tenant scope", async () => {
    const { contract, lifecycle } = harness();
    const endpoint = await lifecycle.create(A, declaration());
    const originalRead = contract.read;
    contract.read = async (q) => q.projection === "webhook_endpoints"
      ? [{ ...(await originalRead({ projection: "webhook_endpoint", tenantId: A.verifiedTenant, endpointId: endpoint.endpointId })), tenantId: "tenant-b" }]
      : originalRead(q);
    await rejectsCode(() => lifecycle.list(A), "PROJECTION_VIOLATION");
  });
});
