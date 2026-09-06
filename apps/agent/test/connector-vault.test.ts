import { expect, test } from "bun:test";
import { connectorVault, parseConnectorVault, type VaultFetch } from "../src/connector-vault.ts";
const settings = { origin: "https://vault.example.com", accounts: { "123": { token: "private-runtime-token-fixture", tenantId: "tenant-a", profileId: "profile-a", runtimeId: "runtime-a", connections: { "service.example.com": "connection-a" } } } };
const binding = { owner: "123", domain: "service.example.com", connectionId: "aiko-connection" };
const status = { tenantId: "tenant-a", profileId: "profile-a", runtimeId: "runtime-a", connectionId: "connection-a", allowedDomains: ["service.example.com"], verified: true, revision: 3, expiresAt: Date.now() + 600000 };
test("vault adapter verifies assigned session metadata without retrieving credential material", async () => {
  const calls: string[] = [];
  const adapter = connectorVault(parseConnectorVault(JSON.stringify(settings)), "123", (async (url, init) => {
    calls.push(String(url)); if (init?.method !== "GET") expect((init?.headers as any)["Content-Type"]).toBe("application/json"); expect(init?.redirect).toBe("manual"); expect((init?.headers as any).Authorization).toBe("Bearer private-runtime-token-fixture");
    return Response.json(String(url).endsWith("/status") ? status : String(url).endsWith("/session") ? { revoked: true } : { queued: true });
  }) as VaultFetch)!;
  expect(await adapter.begin(binding)).toEqual({ authorizationUrl: settings.origin + "/" });
  expect((await adapter.status!(binding)).status).toBe("connected");
  expect((await adapter.disconnect!(binding)).status).toBe("disconnected");
  expect(calls.filter(u => u.endsWith("/session"))).toHaveLength(1);
  expect(calls.some(u => u.includes("credential"))).toBe(false);
});
test("vault adapter refuses foreign owners, assignments, identities and redirects", async () => {
  let reads = 0;
  const adapter = connectorVault(settings, "123", (async () => { reads++; return Response.json({ ...status, tenantId: "foreign" }); }) as VaultFetch)!;
  await expect(adapter.begin({ ...binding, owner: "456" })).rejects.toThrow();
  await expect(adapter.begin({ ...binding, domain: "other.example.com" })).rejects.toThrow(); expect(reads).toBe(0);
  await expect(adapter.status!(binding)).rejects.toThrow("identity mismatch");
  const redirected = connectorVault(settings, "123", (async () => new Response(null, { status: 302, headers: { Location: "https://evil.example.com" } })) as VaultFetch)!;
  await expect(redirected.begin(binding)).rejects.toThrow("could not be verified");
});
test("pending or expired vault sessions cannot become connected", async () => {
  for (const patch of [{ verified: false }, { expiresAt: 1 }, { revision: 0 }]) {
    const adapter = connectorVault(settings, "123", (async () => Response.json({ ...status, ...patch })) as VaultFetch)!;
    expect((await adapter.status!(binding)).status).toBe("pending");
  }
});
test("vault config stays optional and rejects unsafe origins with generic secret-free errors", () => {
  expect(parseConnectorVault()).toBeUndefined(); expect(connectorVault(settings, "456")).toBeUndefined();
  for (const origin of ["http://vault.example.com", "https://127.0.0.1", "https://user:private@vault.example.com", "https://vault.example.com/path"]) expect(() => parseConnectorVault(JSON.stringify({ ...settings, origin }))).toThrow("Invalid connector vault configuration");
});
