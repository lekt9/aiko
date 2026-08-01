import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AikoNativeClient } from "./index.js";

export function defaultDiscoveryPath() {
  return join(homedir(), ".aiko", "native", "api.json");
}

export async function readAikoDiscovery(path = defaultDiscoveryPath()) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function connectToAiko(path = defaultDiscoveryPath()) {
  return new AikoNativeClient(await readAikoDiscovery(path));
}
