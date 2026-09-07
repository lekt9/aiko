import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { loadConfig, privateEnv } from "../apps/agent/src/config.ts";
import { credentialDigest } from "../apps/agent/src/plane-auth.ts";
import { redactor } from "../apps/agent/src/security.ts";

// Deployment never changes Telegram's webhook or stops the previous host.
process.umask(0o077);
const config = await loadConfig();
if (
  config.mode !== "live" ||
  !config.modelKey ||
  !config.botToken ||
  !config.webhookSecret
)
  throw new Error("The private live configuration is incomplete");
const path = "/home/deck/.config/unbrowse/aiko-cloudflare.env";
let state: Record<string, string>;
try {
  state = await privateEnv(path);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  await mkdir("/home/deck/.config/unbrowse", { recursive: true, mode: 0o700 });
  state = {
    AIKO_E2E_OWNER: "acct_cloudflare_e2e02",
    AIKO_E2E_TOKEN: randomBytes(32).toString("base64url"),
  };
  await writeFile(
    path,
    Object.entries(state)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
    { flag: "wx", mode: 0o600 },
  );
}
if (
  state.AIKO_E2E_OWNER !== "acct_cloudflare_e2e02" ||
  !/^[A-Za-z0-9_-]{40,}$/.test(state.AIKO_E2E_TOKEN ?? "")
)
  throw new Error("Invalid deployment canary binding");
const credentials = [
  ...(config.planeCredentials ?? []),
  {
    account: state.AIKO_E2E_OWNER,
    digest: credentialDigest(state.AIKO_E2E_TOKEN),
    scopes: ["read", "write"],
  },
];
const secrets = {
  AIKO_CODE_MODE: String(config.codeMode === true),
  ...(config.arcadeKey ? { ARCADE_API_KEY: config.arcadeKey } : {}),
  ...(config.cerebrasKey ? { CEREBRAS_API_KEY: config.cerebrasKey } : {}),
  AIKO_OPERATOR_TOKEN: config.operatorToken,
  CODEGRAFF_API_KEY: config.modelKey,
  AIKO_BOT_TOKEN: config.botToken,
  AIKO_WEBHOOK_SECRET: config.webhookSecret,
  AIKO_ALLOWED_USERS: [...config.allowedUsers].join(","),
  AIKO_PLANE_CREDENTIALS: JSON.stringify(credentials),
  ...(config.voiceKey ? { AIKO_VOICE_KEY: config.voiceKey } : {}),
};
const redact = redactor([...Object.values(secrets), state.AIKO_E2E_TOKEN]);
async function run(args: string[], input?: string) {
  const process = Bun.spawn(args, {
    cwd: "/home/deck/work/unlock/apps/agent",
    stdin: input ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input) {
    (process.stdin as import("bun").FileSink).write(input);
    (process.stdin as import("bun").FileSink).end();
  }
  const [out, err, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  console.log(redact(out + err));
  if (code !== 0) throw new Error(`Deployment step failed (${code})`);
  return out;
}
const runner = await Bun.build({
  entrypoints: ["/home/deck/work/unlock/apps/agent/src/sandbox-runner.ts"],
  target: "bun",
  external: ["@huggingface/transformers"],
  minify: true,
});
if (!runner.success) throw new Error("Trusted browser runner build failed");
await Bun.write(
  "/home/deck/work/unlock/apps/agent/assets/runner.txt",
  runner.outputs[0]!,
);
await run([
  "pnpm",
  "--filter",
  "@unlock/web",
  "exec",
  "vite",
  "build",
  "--config",
  "vite.connectors.config.ts",
]);
await run([
  "pnpm",
  "exec",
  "tsc",
  "--noEmit",
  "-p",
  "tsconfig.cloudflare.json",
]);
await run(["pnpm", "exec", "wrangler", "deploy", "--dry-run"]);
if (!process.argv.includes("--deploy")) {
  console.log(
    "Dry run passed; use --deploy to publish. Telegram is unchanged.",
  );
  process.exit(0);
}
// This existing deployment can receive the new provider secret before role vars change.
if (config.cerebrasKey)
  await run(
    ["pnpm", "exec", "wrangler", "secret", "put", "CEREBRAS_API_KEY"],
    config.cerebrasKey,
  );
// First publish creates the namespaced SQLite DOs; config fails closed until secrets arrive.
const output = await run(["pnpm", "exec", "wrangler", "deploy"]);
await run(
  ["pnpm", "exec", "wrangler", "secret", "bulk"],
  JSON.stringify(secrets),
);
const url = output.match(
  /https:\/\/aiko-agent\.[A-Za-z0-9_-]+\.workers\.dev/,
)?.[0];
if (!url) throw new Error("Deployment URL missing; verify Wrangler output");
await writeFile(
  path,
  Object.entries({ ...state, AIKO_CLOUDFLARE_URL: url })
    .map(([key, value]) => `${key}=${value}`)
    .join("\n") + "\n",
  { mode: 0o600 },
);
let ready = false;
for (let attempt = 0; attempt < 20 && !ready; attempt++) {
  const response = await fetch(`${url}/ready`, {
    signal: AbortSignal.timeout(10000),
  });
  ready =
    response.ok &&
    ((await response.json()) as any).storage === "durable-object";
  if (!ready) await Bun.sleep(1000);
}
if (!ready)
  throw new Error("Cloudflare readiness failed; Telegram remains unchanged");
console.log(
  JSON.stringify({
    deployed: url,
    control: `${url}/control`,
    telegramCutover: false,
  }),
);
