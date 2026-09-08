import type { HarnessDigest } from './harness-library.ts';
/** Only a trusted pre-dispatch environment probe may issue this failure. */
export class DefiniteComputeRuntimeFailure extends Error {
  constructor(readonly failureRef: HarnessDigest) { super('Compute runtime definitely unavailable'); }
}
export type ComputeRuntimeRepairRequest = {
  owner: string; operationId: string; failureRef: HarnessDigest;
  grant: string; deadline: number;
};
export interface ComputeRuntimeRepair {
  repairRuntime(request: ComputeRuntimeRepairRequest, signal: AbortSignal, authorized: () => Promise<boolean>): Promise<{status:'ready'; runtimeLockDigest:HarnessDigest}>;
}
