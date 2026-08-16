import type React from "react";
import type { SmithersCtx } from "@smthrs/driver";
import type { OutputTarget } from "./OutputTarget.ts";
import type { DepsSpec } from "./DepsSpec.ts";
export type ContractFrontierSignal = { commitOrdinal: number } & Record<string, unknown>;
export type ContractDriver = { handleSignal(signal: ContractFrontierSignal): Promise<unknown> };
export type ContractCellProps<D extends DepsSpec = {}> = {
  id: string; driver: ContractDriver; signal: ContractFrontierSignal | ((deps: unknown) => ContractFrontierSignal);
  output: OutputTarget; deps?: D; skipIf?: boolean; label?: string; meta?: Record<string, unknown>;
  smithersContext?: React.Context<SmithersCtx<unknown> | null>;
};
