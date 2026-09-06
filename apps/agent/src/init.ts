import { mkdir, writeFile, lstat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

process.umask(0o077);
const directory = join(homedir(), ".config/unbrowse");
const path = join(directory, "aiko-operator.env");
await mkdir(directory, { recursive: true, mode: 0o700 });
const stat = await lstat(directory);
if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
  throw new Error("Configuration directory must be private (0700)");
try {
  await writeFile(
    path,
    `AIKO_OPERATOR_TOKEN=${randomBytes(32).toString("hex")}\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.info(`Created private local operator configuration: ${path}`);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST")
    throw new Error("Could not create private operator configuration");
  console.info(`Existing operator configuration preserved: ${path}`);
}
console.info(
  "The token is not printed. Open that private file locally to unlock the console. ThinkFeel configuration was not modified.",
);
