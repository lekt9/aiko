import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { VOYAGER_BANNER, VOYAGER_LOGOUT_SCRIPT } from "../apps/agent/src/voyager-ui.ts";

export const voyagerAgentDirectory = join(import.meta.dir, "../apps/agent");
export const voyagerConfig = join(voyagerAgentDirectory, "wrangler.voyager.jsonc");
export async function buildVoyager() {
  const source = join(voyagerAgentDirectory, "node_modules/tardie");
  const metadata = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  if (metadata.version !== "0.22.0") throw Error("Review the native Voyager adapter before changing the pinned Tardie version");
  const output = join(voyagerAgentDirectory, "dist/voyager");
  await mkdir(output, { recursive: true });
  await cp(join(source, "ui/assets"), join(output, "assets"), { recursive: true });
  const index = await readFile(join(source, "ui/index.html"), "utf8");
  if (!index.includes('<div id="root"></div>') || !index.includes("<body>")) throw Error("The native Voyager entry changed; review the hosting wrapper");
  const sessionGuard = `<script>${VOYAGER_LOGOUT_SCRIPT}window.addEventListener('pageshow',event=>{if(event.persisted)location.reload()});let checking=false;async function checkSession(){if(checking||document.hidden)return;checking=true;try{const response=await fetch('/session',{credentials:'same-origin',cache:'no-store',redirect:'error'});if(response.status===401||response.status===403)location.replace('/login')}catch{}finally{checking=false}}setInterval(checkSession,60000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkSession()});</script>`;
  await writeFile(join(output, "index.html"), index.replace("<body>", `<body>${VOYAGER_BANNER}${sessionGuard}`));
  const provenance = { package: "tardie", version: metadata.version, nativeIndexSha256: createHash("sha256").update(index).digest("hex"), nativeAssets: "Copied unchanged from the pinned package; index.html adds the production banner, session guard and readable secondary-label color." };
  await writeFile(join(output, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
  const workerOutput = join(voyagerAgentDirectory, "dist/voyager-worker");
  for (const args of [
    ["pnpm", "exec", "tsc", "--noEmit", "-p", "tsconfig.voyager.json"],
    ["pnpm", "exec", "wrangler", "deploy", "--config", voyagerConfig, "--dry-run", "--outdir", workerOutput],
    ["node", join(import.meta.dir, "verify-voyager-workerd.mjs"), join(workerOutput, "voyager-worker.js")],
  ]) {
    const child = Bun.spawn(args, { cwd: voyagerAgentDirectory, stdout: "inherit", stderr: "inherit" });
    if (await child.exited !== 0) throw Error("Voyager build verification failed");
  }
  console.log("Native Voyager built; production agent code and state were not changed.");
}
if (import.meta.main) await buildVoyager();
