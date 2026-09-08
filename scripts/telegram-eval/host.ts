/** Private-config bridge. Emits redacted host data, never credentials. */
import {cloudflareOperatorConfig, cloudflareState} from "../cloudflare-paths.ts";
const [command, owner, after = "0"] = process.argv.slice(2);
if (!owner || !/^[A-Za-z0-9_-]{1,128}$/.test(owner)) throw Error("Invalid evaluation owner");
const [config, state] = await Promise.all([cloudflareOperatorConfig(), cloudflareState()]);
const base = state.AIKO_CLOUDFLARE_URL ?? "https://aiko-agent.lewis-6d8.workers.dev";
let url: string;
if (command === "events") {
 if (!/^\d+$/.test(after)) throw Error("Invalid event cursor");
 url = `${base}/api/control/events?thread=user-${owner}&after=${after}&limit=100`;
} else if (command === "threads") url = `${base}/api/control/threads?account=${owner}`;
else if (command === "ready") url = `${base}/ready`;
else if (command === "bot") {
 if (!config.botToken) throw Error("Bot identity unavailable");
 const r = await fetch(`https://api.telegram.org/bot${config.botToken}/getMe`, {signal: AbortSignal.timeout(15000)});
 const data = await r.json() as any;
 if (!r.ok || !data.ok || !data.result?.is_bot) throw Error("Bot identity lookup failed");
 console.log(JSON.stringify({id:data.result.id, username:data.result.username, base}));
 process.exit(0);
} else throw Error("Unknown read-only host command");
const r = await fetch(url, {headers:{authorization:`Bearer ${config.operatorToken}`}, signal:AbortSignal.timeout(30000)});
if (!r.ok) throw Error(`Host ${command} returned HTTP ${r.status}`);
console.log(JSON.stringify(await r.json()));
