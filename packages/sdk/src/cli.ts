#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { z } from "@unlock/protocol";
import { createAgentOAuth, EncryptedFileTokenStore } from "./oauth.js";
import { createVaultAgent } from "./agent.js";
import { createAgentTools } from "./tools.js";
import { UnlockError } from "./transport.js";
const commands = {
  status: {
    description: "Show local authorization metadata; never prints tokens.",
    input: z.object({}).strict(),
  },
  logins: {
    description: "List approved login metadata.",
    input: z.object({}).strict(),
  },
  login: {
    description:
      "Operator-only browser authorization; requires UNLOCK_ALLOW_AUTH_UI=1.",
    input: z.object({}).strict(),
  },
  logout: {
    description:
      "Operator-only token revocation/local deletion; requires --confirm.",
    input: z.object({ confirm: z.literal(true) }).strict(),
  },
};
const output = (data: unknown) =>
  console.log(
    JSON.stringify(
      { ok: true, data, meta: { schema_version: "1.0" } },
      null,
      process.stdout.isTTY ? 2 : 0,
    ),
  );
const invalid = () =>
  new UnlockError(
    "INVALID_INPUT",
    0,
    "Use unlock-agent help or unlock-agent schema <command>.",
  );
async function privateFile(path: string) {
  const info = await stat(path);
  if (!info.isFile() || info.mode & 0o077 || info.size > 32768)
    throw new UnlockError(
      "TOKEN_STORAGE",
      0,
      "Configuration/key files must be private and bounded.",
    );
  return readFile(path);
}
async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "help" || command === "--help") {
    output({
      commands: Object.fromEntries(
        Object.entries(commands).map(([name, c]) => [name, c.description]),
      ),
      configuration:
        "UNLOCK_AGENT_CONFIG names a private JSON configuration file.",
      exitCodes: { success: 0, runtime: 1, auth: 2, input: 3 },
    });
    return;
  }
  if (command === "schema") {
    if (args.length !== 1 || !Object.hasOwn(commands, args[0])) throw invalid();
    output(z.toJSONSchema(commands[args[0] as keyof typeof commands].input));
    return;
  }
  if (!Object.hasOwn(commands, command)) throw invalid();
  const selected = command as keyof typeof commands,
    dry = args.includes("--dry-run"),
    rest = args.filter((a) => a !== "--dry-run");
  if (rest.some((a) => a !== "--confirm")) throw invalid();
  const parsed = commands[selected].input.safeParse(
    rest.includes("--confirm") ? { confirm: true } : {},
  );
  if (!parsed.success) throw invalid();
  if (dry) {
    output({
      command: selected,
      willExecute: false,
      requiresAuthorization: ["login", "logout"].includes(selected)
        ? "operator opt-in"
        : "preconfigured agent",
    });
    return;
  }
  if (
    ["login", "logout"].includes(selected) &&
    process.env.UNLOCK_ALLOW_AUTH_UI !== "1"
  )
    throw new UnlockError(
      "AUTH_UI_REQUIRED",
      401,
      "The operator must enable UNLOCK_ALLOW_AUTH_UI=1 for this command.",
    );
  if (!process.env.UNLOCK_AGENT_CONFIG)
    throw new UnlockError(
      "CONFIG_REQUIRED",
      401,
      "The operator must set UNLOCK_AGENT_CONFIG.",
    );
  const config = z
    .object({
      issuer: z.url(),
      clientId: z.string().uuid(),
      redirectUri: z.url(),
      tokenFile: z.string(),
      keyFile: z.string(),
      allowLocalHttp: z.boolean().default(false),
    })
    .strict()
    .parse(
      JSON.parse(
        (await privateFile(process.env.UNLOCK_AGENT_CONFIG)).toString("utf8"),
      ),
    );
  if (
    config.tokenFile === config.keyFile ||
    config.tokenFile === process.env.UNLOCK_AGENT_CONFIG
  )
    throw invalid();
  const key = await privateFile(config.keyFile);
  if (key.length !== 32) throw invalid();
  const store = new EncryptedFileTokenStore(config.tokenFile, key),
    auth = createAgentOAuth({ ...config, store });
  key.fill(0);
  if (selected === "status") {
    const value = await auth.status();
    output({
      ...value,
      expiresAt: value.expiresAt
        ? new Date(value.expiresAt).toISOString()
        : null,
    });
    return;
  }
  if (selected === "logout") {
    output(await auth.logout());
    return;
  }
  if (selected === "logins") {
    const agent = createVaultAgent({
      baseUrl: new URL(config.issuer).origin + "/v1",
      token: auth.accessToken,
    });
    output(await createAgentTools(agent).unlock_logins.execute({}));
    return;
  }
  const redirect = new URL(config.redirectUri);
  if (
    redirect.protocol !== "http:" ||
    redirect.hostname !== "127.0.0.1" ||
    !redirect.port ||
    Number(redirect.port) < 1024
  )
    throw new UnlockError(
      "INVALID_INPUT",
      0,
      "CLI login requires its pre-registered HTTP 127.0.0.1 callback with an explicit unprivileged port.",
    );
  const server = createServer();
  let settle!: (value: boolean) => void;
  const completed = new Promise<boolean>((r) => (settle = r));
  server.on("request", (req, res) => {
    void (async () => {
      if (
        req.headers.host !== redirect.host ||
        new URL(req.url!, redirect).pathname !== redirect.pathname
      ) {
        res.writeHead(404);
        res.end();
        return;
      }
      try {
        await auth.finish(new URL(req.url!, redirect).href);
        res.writeHead(200, {
          "Content-Type": "text/plain",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        });
        res.end("Unlock agent connected. You can close this tab.");
        settle(true);
      } catch {
        res.writeHead(400, {
          "Content-Type": "text/plain",
          "Cache-Control": "no-store",
        });
        res.end("Authorization failed. Restart login from the CLI.");
        settle(false);
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(redirect.port), "127.0.0.1", resolve);
  });
  const timeout = setTimeout(() => settle(false), 300000);
  try {
    const { url } = await auth.begin();
    console.error(
      JSON.stringify({
        event: "owner_action_required",
        authorization_url: url,
        expires_in_seconds: 300,
      }),
    );
    if (!(await completed))
      throw new UnlockError(
        "UNAUTHENTICATED",
        401,
        "Agent authorization did not complete.",
      );
    output({ authorized: true });
  } finally {
    clearTimeout(timeout);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
main().catch((error) => {
  const fault =
    error instanceof UnlockError
      ? error
      : new UnlockError(
          "INVALID_INPUT",
          0,
          "The command could not complete. Check private configuration and use help.",
        );
  console.log(
    JSON.stringify({
      ok: false,
      error: { code: fault.code, message: fault.message, retryable: false },
      meta: { schema_version: "1.0" },
    }),
  );
  process.exitCode =
    fault.status === 401 ? 2 : fault.code === "INVALID_INPUT" ? 3 : 1;
});
