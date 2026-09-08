import { Database } from "bun:sqlite";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { sandboxJobJournal } from "./sandbox-job-journal.ts";
import { runCodingWorkspace } from "./coding-workspace-runner.ts";
import { codingWorkspaceEnvironment, type CodingRepositoryGrant } from "./coding-workspace.ts";
import { sandboxDigest } from "./sandbox-job.ts";

/** Trusted entry bundled and uploaded by CodegraffCodingWorkspace. Repository
 * grants and the runtime pin come from the host configuration, never tool args. */
export async function codingWorkspaceMain(args = process.argv.slice(2)) {
  const [flag, configPath, mode, inputPath, outputPath] = args;
  const path = (value: string | undefined, suffix: string) => !!value && new RegExp(`^/tmp/aiko-coding-[a-f0-9]{64}\\.${suffix}\\.json$`).test(value);
  if (flag !== "--config" || mode !== "job" || !path(configPath, "config") || !path(inputPath, "input") || !path(outputPath, "receipt")) throw Error("Invalid trusted coding entry arguments");
  const config = JSON.parse(await readFile(configPath!, "utf8")) as { owner: string; environmentDigest: `sha256:${string}`; repositories: CodingRepositoryGrant[]; wallMs?: number; stateRoot?: string; terminalOperation?: {thread:string;operation:string} };
  const bundle = await readFile(process.argv[1]!, "utf8");
  const actual = await codingWorkspaceEnvironment(bundle, Bun.version);
  if (actual !== config.environmentDigest) throw Error("Coding runner environment pin mismatch");
  const stateRoot = config.stateRoot ?? `/home/daytona/.aiko-coding/${(await sandboxDigest(config.owner)).slice(7)}`;
  if (!stateRoot.startsWith("/")) throw Error("Trusted coding state directory must be absolute");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const db = new Database(`${stateRoot}/jobs.sqlite`);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
  const cancellation = new AbortController();
  const stop = () => cancellation.abort();
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  try {
    const journal = await sandboxJobJournal(db, `${stateRoot}/receipt.key`);
    const receipt = await runCodingWorkspace(JSON.parse(await readFile(inputPath!, "utf8")), { ...config, stateRoot, journal }, cancellation.signal);
    const temporary = `${outputPath}.${crypto.randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(receipt)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, outputPath!);
  } finally { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); db.close(); }
}
if (import.meta.main) await codingWorkspaceMain();
