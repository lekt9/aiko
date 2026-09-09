/** Read-only deployed witness. Stores counts/digests, never customer event bodies
 * or production bearer credentials. The optional browser handoff is owner-only
 * and contains only a short-lived encrypted viewer session. */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { cloudflareOperatorConfig, cloudflareState } from "./cloudflare-paths.ts";

process.umask(0o077);
const base = process.argv[2];
if (!base || !/^https:\/\/aiko-voyager\.[A-Za-z0-9_-]+\.workers\.dev$/.test(base))
  throw Error("Usage: bun scripts/verify-aiko-voyager.ts https://aiko-voyager.ACCOUNT.workers.dev");
const config = await cloudflareOperatorConfig(), state = await cloudflareState();
const source = state.AIKO_CLOUDFLARE_URL;
if (!source?.startsWith("https://") || !state.AIKO_E2E_TOKEN || !state.AIKO_E2E_OWNER) throw Error("Hosted verification credentials are not configured");
const checks: string[] = [];
function check(value: unknown, name: string): asserts value {
  if (!value) throw Error(`Voyager verification failed: ${name}`);
  checks.push(name);
}
const fetchView = (path: string, cookie?: string, options: RequestInit = {}) => fetch(base + path, {
  ...options, headers: { ...(cookie ? { cookie } : {}), ...options.headers }, redirect: "manual", signal: AbortSignal.timeout(60_000),
});
async function login(token: string) {
  const response = await fetchView("/session", undefined, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ token }) });
  check(response.ok, "current production credential accepted");
  const header = response.headers.get("set-cookie");
  check(header && header.includes("Secure") && header.includes("HttpOnly") && !header.includes(token), "encrypted HttpOnly session returned");
  return header.split(";", 1)[0]!;
}
const denied = await fetchView("/v1/metadata");
check(denied.status === 401, "anonymous native reads denied");
await denied.body?.cancel();
const cookie = await login(config.operatorToken);
const metadataResponse = await fetchView("/v1/metadata", cookie);
check(metadataResponse.ok, "production metadata readable");
const metadata = await metadataResponse.json() as { name?: string; storage?: { location?: string } };
check(metadata.name === "aiko" && metadata.storage?.location === source, "viewer addresses the existing production host");
const accountsResponse = await fetchView("/v1/actors", cookie);
check(accountsResponse.ok, "operator account discovery readable");
const accounts = await accountsResponse.json() as { id: string }[];
const owner = accounts.find(account => /^[1-9]\d{0,15}$/.test(account.id))?.id;
check(owner, "a real Telegram account is available, not only a canary");
const thread = `user-${owner}`, eventPath = `/v1/actors/${encodeURIComponent(owner)}/threads/${encodeURIComponent(thread)}/events`;
const pageResponse = await fetchView(`${eventPath}?limit=10`, cookie);
check(pageResponse.ok, "production event page readable");
const page = await pageResponse.json() as { seq: number; event: unknown }[];
check(page.length > 0, "production account has retained events");
const originalResponse = await fetch(`${source}/api/control/events?thread=${encodeURIComponent(thread)}&after=0&limit=10`, {
  headers: { authorization: `Bearer ${config.operatorToken}` }, redirect: "error", signal: AbortSignal.timeout(60_000),
});
check(originalResponse.ok, "independent production event read succeeded");
const original = await originalResponse.json() as { events: unknown[] };
check(JSON.stringify(page) === JSON.stringify(original.events), "viewer events and sequences exactly match production");
const tail = await fetchView(`${eventPath}/stream?after=0&limit=10`, cookie, { headers: { "last-event-id": String(page.at(-1)!.seq) } });
check(tail.ok && tail.headers.get("content-type")?.includes("text/event-stream"), "authenticated SSE tail readable");
const frames = await tail.text();
const ids = [...frames.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]));
check(ids.every(id => id > page.at(-1)!.seq), "SSE reconnect honors its production cursor");
const nativeResponse = await fetchView(`/?actor=${encodeURIComponent(owner)}&thread=${encodeURIComponent(thread)}`, cookie);
check(nativeResponse.ok, "native production page readable");
const native = await nativeResponse.text();
check(native.includes("Production · Read-only") && native.includes('id="root"'), "native entry has an explicit production scope");
for (const asset of [...native.matchAll(/(?:src|href)="(\/assets\/[^\"]+\.(?:js|css))"/g)].map(match => match[1]!)) {
  const response = await fetchView(asset);
  check(response.ok, "native asset served");
  const actual = new Uint8Array(await response.arrayBuffer());
  const expected = await readFile(join(import.meta.dir, "../apps/agent/node_modules/tardie/ui", asset));
  check(createHash("sha256").update(actual).digest("hex") === createHash("sha256").update(expected).digest("hex"), "native asset matches the pinned package byte-for-byte");
}
const write = await fetchView(eventPath, cookie, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
check(write.status === 405, "native writes are refused even for the operator");
await write.body?.cancel();
const scoped = await login(state.AIKO_E2E_TOKEN);
const scopedAccountsResponse = await fetchView("/v1/actors", scoped);
const scopedAccounts = await scopedAccountsResponse.json() as { id: string }[];
check(scopedAccountsResponse.ok && scopedAccounts.length === 1 && scopedAccounts[0]!.id === state.AIKO_E2E_OWNER, "account discovery is restricted to the credential owner");
const cross = await fetchView(eventPath, scoped);
check(cross.status === 403, "production account cannot read another owner's events");
await cross.body?.cancel();
const scratch = await mkdtemp(join(tmpdir(), "aiko-voyager-live-"));
const browserSession = join(scratch, "browser-session.json");
await writeFile(browserSession, JSON.stringify({ base, path: `/?actor=${encodeURIComponent(owner)}&thread=${encodeURIComponent(thread)}`, cookie }), { mode: 0o600 });
const evidence = { checkedAt: new Date().toISOString(), viewer: base, production: source, checks, accountCount: accounts.length, verifiedEventCount: page.length, eventPageSha256: createHash("sha256").update(JSON.stringify(page)).digest("hex"), requestedProductionMutations: 0, browserRendering: "not yet checked" };
await mkdir(join(import.meta.dir, "../artifacts/voyager"), { recursive: true, mode: 0o700 });
await writeFile(join(import.meta.dir, "../artifacts/voyager/deployed.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ viewer: base, checks: checks.length, accounts: accounts.length, verifiedProductionEvents: page.length, privateBrowserSession: browserSession }));
