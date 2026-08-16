import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AikoAgent } from "./AikoAgent.js";

/** Environment names that may cross the Aiko process membrane. */
export const AIKO_SPAWN_RUNTIME_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "TERM",
]);

export const AIKO_PROVIDER_CREDENTIAL_ENV = Object.freeze({
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  xai: "XAI_API_KEY",
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const REDACTED = "[REDACTED]";
const SECRET_ENV = /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|AUTH)/i;
const SECRET_ARG_FLAGS = new Set(["--single", "--rules", "--resume", "--session-id"]);

function required(value, label, pattern = ID) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${label} must be an explicit canonical identifier`);
  }
  return value;
}

function canonicalDirectory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute existing directory`);
  }
  try {
    return realpathSync(value);
  } catch {
    throw new TypeError(`${label} must be an absolute existing directory`);
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Resolve a cwd by filesystem identity, not spelling. A symlink which names a
 * path below the workspace but resolves outside it is therefore refused.
 */
export function confineAikoCwd(workspaceRoot, requestedCwd = workspaceRoot) {
  const root = canonicalDirectory(workspaceRoot, "workspaceRoot");
  const cwd = canonicalDirectory(requestedCwd, "cwd");
  if (!isWithin(root, cwd)) {
    throw new Error(`Aiko cwd escapes its canonical workspace root: ${cwd}`);
  }
  return { workspaceRoot: root, cwd };
}

function minimalEnvironment(runtimeEnv, account) {
  if (!runtimeEnv || typeof runtimeEnv !== "object" || Array.isArray(runtimeEnv)) {
    throw new TypeError("runtimeEnv must be supplied explicitly");
  }
  const env = {};
  for (const name of AIKO_SPAWN_RUNTIME_ENV_ALLOWLIST) {
    const value = runtimeEnv[name];
    if (typeof value === "string" && value.length > 0) env[name] = value;
  }
  for (const name of Object.keys(runtimeEnv)) {
    if (!AIKO_SPAWN_RUNTIME_ENV_ALLOWLIST.includes(name)) {
      throw new Error(`environment variable is outside the Aiko spawn allowlist: ${name}`);
    }
  }

  const credentialName = AIKO_PROVIDER_CREDENTIAL_ENV[account.provider];
  if (!credentialName) throw new Error(`unsupported Aiko credential provider: ${account.provider}`);
  if (account.credential?.name !== credentialName || typeof account.credential.value !== "string" || !account.credential.value) {
    throw new Error(`account ${account.id} must supply exactly ${credentialName} for provider ${account.provider}`);
  }
  env[credentialName] = account.credential.value;
  env.AIKO_AUTH_PROVIDER = account.provider;
  env.AIKO_ACCOUNT_ID = account.id;
  env.AIKO_CREDENTIAL_GENERATION = account.generation;
  return env;
}

/** Return diagnostics safe to persist; it never returns credential or prompt bytes. */
export function redactAikoSpawnDiagnostics({ command, args = [], cwd, env = {} }) {
  const safeArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    if (SECRET_ARG_FLAGS.has(flag) || /(?:key|token|secret|password|credential)/i.test(flag)) {
      safeArgs.push(equals === -1 ? flag : `${flag}=${REDACTED}`);
      if (equals === -1 && index + 1 < args.length) {
        safeArgs.push(REDACTED);
        index += 1;
      }
    } else {
      safeArgs.push(arg);
    }
  }
  return {
    command,
    args: safeArgs,
    cwd,
    env: Object.fromEntries(Object.entries(env).map(([name, value]) => [name, SECRET_ENV.test(name) ? REDACTED : value])),
  };
}

/**
 * Aiko adapter whose constructor is the spawn-authority membrane. It deliberately
 * has no account discovery or fallback path: one provider, account and credential
 * generation are required and are the only authentication material in the child.
 */
export class SpawnAuthorityAikoAgent extends AikoAgent {
  constructor(options) {
    if (!options || typeof options !== "object") throw new TypeError("spawn authority options are required");
    const { workspaceRoot, cwd } = confineAikoCwd(options.workspaceRoot, options.cwd ?? options.workspaceRoot);
    const account = {
      id: required(options.account?.id, "account.id"),
      provider: required(options.account?.provider, "account.provider"),
      generation: required(options.account?.generation, "account.generation", GENERATION),
      credential: options.account?.credential,
    };
    const env = minimalEnvironment(options.runtimeEnv, account);
    const reservedArg = options.agent?.extraArgs?.find((arg) =>
      /^(?:--cwd|--permission-mode|--model|--agent|--single|--resume|--continue)(?:=|$)/.test(String(arg)),
    );
    if (reservedArg) {
      throw new Error(`Aiko spawn authority refuses reserved argument: ${reservedArg}`);
    }
    if (options.agent?.continueSession || options.agent?.sessionId) {
      throw new Error("Aiko spawn authority refuses an unbound prior session");
    }
    super({
      ...(options.agent ?? {}),
      id: `aiko:${account.provider}:${account.id}:${account.generation}`,
      cwd,
      env,
      inheritEnv: false,
      yolo: false,
      permissionMode: "default",
    });
    this.spawnAuthority = Object.freeze({ workspaceRoot, cwd, account: Object.freeze({ ...account, credential: undefined }) });
  }

  runGenerateEffect(options, operation) {
    if (options?.rootDir) confineAikoCwd(this.spawnAuthority.workspaceRoot, options.rootDir);
    // BaseCliAgent normally projects taskContext into SMITHERS_* environment
    // variables. Authority-bound Aiko children receive no implicit context.
    return super.runGenerateEffect({ ...(options ?? {}), rootDir: this.cwd, taskContext: undefined }, operation);
  }

  async buildCommand(params) {
    // Re-check at the last responsible moment so replacing a formerly safe
    // directory with an escaping symlink after construction fails closed.
    confineAikoCwd(this.spawnAuthority.workspaceRoot, this.cwd);
    const spec = await super.buildCommand({ ...params, cwd: this.cwd });
    if (spec.args.includes("bypassPermissions")) throw new Error("Aiko spawn authority refused bypassPermissions");
    // BaseCliAgent annotates its process argv. Put the sensitive Aiko argv on
    // stdin to a fixed runner so prompt/rules/resume bytes never enter those
    // diagnostics. The runner performs the real Aiko spawn with the sealed env.
    return {
      ...spec,
      command: process.execPath,
      args: [fileURLToPath(import.meta.url), "--spawn-authority-runner"],
      stdin: JSON.stringify({ command: spec.command, args: spec.args, cwd: this.cwd }),
    };
  }
}

export function createSpawnAuthorityAikoAgent(options) {
  return new SpawnAuthorityAikoAgent(options);
}

async function runSealedChildFromStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const invocation = JSON.parse(input);
  if (invocation.command !== "aiko" || !Array.isArray(invocation.args) || invocation.cwd !== process.cwd()) {
    throw new Error("invalid sealed Aiko invocation");
  }
  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: process.env,
    stdio: "inherit",
  });
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (exit.signal) process.kill(process.pid, exit.signal);
  process.exitCode = exit.code ?? 1;
}

if (process.argv[2] === "--spawn-authority-runner") {
  await runSealedChildFromStdin();
}
