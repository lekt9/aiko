import { AikoNativeClient, type AikoNativeDiscovery } from "./index.js";

export declare function defaultDiscoveryPath(): string;
export declare function readAikoDiscovery(
  path?: string,
): Promise<AikoNativeDiscovery>;
export declare function connectToAiko(
  path?: string,
): Promise<AikoNativeClient>;
