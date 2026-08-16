import { createContractLifecyclePolicy, ContractLifecyclePolicyError } from "./contractLifecyclePolicy.js";
import { SmithersError } from "@smthrs/errors/SmithersError";

export class ContractLifecycleSurfaceError extends SmithersError {
  constructor(code, message, status = 409) { super(code, message); this.name = "ContractLifecycleSurfaceError"; this.status = status; }
}
function verifiedGatewayAuthority(context) {
  const tenant = context?.verifiedTenant ?? context?.tenantId;
  const owner = context?.verifiedOwner ?? context?.ownerId ?? context?.userId;
  const scopes = context?.grantedScopes ?? context?.scopes;
  if (typeof tenant !== "string" || !tenant || typeof owner !== "string" || !owner || !Array.isArray(scopes)) {
    throw new ContractLifecycleSurfaceError("UNVERIFIED_AUTHORITY", "verified tenant, owner, and scopes are required", 403);
  }
  return { verifiedTenant: tenant, verifiedOwner: owner, grantedScopes: scopes };
}
/** Public transport adapter. All state reads and writes remain Contract commands/projections. */
export function createContractLifecycleSurface({ contract, policy, authorityFromContext = verifiedGatewayAuthority, allocateForkRunId } = {}) {
  const lifecycle = policy ?? createContractLifecyclePolicy({ contract, allocateForkRunId });
  if (!lifecycle || typeof lifecycle.inspect !== "function") throw new ContractLifecycleSurfaceError("INVALID_INTERFACE", "Contract lifecycle policy is required", 500);
  const calls = Object.freeze({
    "contractLifecycle.inspect": (a,p) => lifecycle.inspect(a,p.runId),
    "contractLifecycle.pause": (a,p) => lifecycle.pause(a,p.runId,{expectedGeneration:p.expectedGeneration}),
    "contractLifecycle.resume": (a,p) => lifecycle.resume(a,p.runId,{expectedGeneration:p.expectedGeneration}),
    "contractLifecycle.cancel": (a,p) => lifecycle.cancel(a,p.runId,{expectedGeneration:p.expectedGeneration,reason:p.reason}),
    "contractLifecycle.revoke": (a,p) => lifecycle.revoke(a,p.runId,{kind:p.kind,id:p.id,expectedGeneration:p.expectedGeneration,reason:p.reason}),
    "contractLifecycle.semanticRollback": (a,p) => lifecycle.semanticRollback(a,p.runId,{expectedGeneration:p.expectedGeneration,targetOccurrenceId:p.targetOccurrenceId,reason:p.reason}),
    "contractLifecycle.timeTravelFork": (a,p) => lifecycle.timeTravelFork(a,p.runId,{expectedGeneration:p.expectedGeneration,frameNo:p.frameNo}),
  });
  return Object.freeze({ lifecycle, methods:Object.freeze(Object.keys(calls)), async rpc(method, context, params = {}) {
    const call = calls[method];
    if (!call) throw new ContractLifecycleSurfaceError("METHOD_NOT_FOUND", `unknown Contract lifecycle method: ${method}`, 404);
    try { return await call(authorityFromContext(context), params); }
    catch (error) {
      if (error instanceof ContractLifecycleSurfaceError) throw error;
      if (error instanceof ContractLifecyclePolicyError) {
        const status = ["FORBIDDEN","TENANT_MISMATCH","OWNER_MISMATCH"].includes(error.code) ? 403 : error.code === "NOT_FOUND" ? 404 : 409;
        throw new ContractLifecycleSurfaceError(error.code, error.message, status);
      }
      throw error;
    }
  }});
}
