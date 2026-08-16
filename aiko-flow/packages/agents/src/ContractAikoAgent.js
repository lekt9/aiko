import { createHash } from "node:crypto";
import { SpawnAuthorityAikoAgent } from "./SpawnAuthorityPolicy.js";

const HEX64 = /^[0-9a-f]{64}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const FORBIDDEN_CONTEXT = new Set(["transcript", "prompt", "handoff", "account", "accountConfig", "globalMemory", "messages", "sessionId"]);
const REQUIRED_CONTRACT_METHODS = [
  "authenticateHook", "acceptHook", "readPurposeContext", "readAdmittedLimb",
  "readPinnedCellWorkflow", "beginExecution", "issueDelegation", "adoptDelegation", "runDelegatedChild",
  "recordExecutionEvidence", "requestCancellation", "readExternalEffects", "openCompensation",
];

function required(value, label, pattern = ID) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is not a canonical identifier`);
  return value;
}
function uniqueStrings(value, label) {
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string" || !ID.test(x)) || new Set(value).size !== value.length) {
    throw new Error(`${label} must be unique canonical identifiers`);
  }
  return [...value].sort();
}
function intersection(...sets) {
  if (sets.length === 0) return [];
  return [...new Set(sets[0])].filter((x) => sets.slice(1).every((s) => s.includes(x))).sort();
}
function assertClosed(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains forbidden field: ${key}`);
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function digest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/**
 * Contract-owned orchestration around the hardened Aiko process membrane.
 * Smithers schedules this object; Contract authenticates, scopes, delegates,
 * settles and compensates. No caller supplied lineage or account field is used.
 */
export class ContractAikoAgent extends SpawnAuthorityAikoAgent {
  constructor(options) {
    if (!options?.contract) throw new Error("ContractAikoAgent requires a Contract adapter");
    for (const method of REQUIRED_CONTRACT_METHODS) {
      if (typeof options.contract[method] !== "function") throw new Error(`Contract adapter missing ${method}`);
    }
    const pins = options.pins ?? {};
    const policy = options.childPolicy ?? {};
    required(pins.limbDigest, "pins.limbDigest", HEX64);
    required(pins.cellPackageDigest, "pins.cellPackageDigest", HEX64);
    required(pins.workflowDigest, "pins.workflowDigest", HEX64);
    const purpose = required(options.purpose, "purpose");
    const audience = required(options.audience, "audience");
    super(options.spawn);
    this.contract = options.contract;
    this.pins = Object.freeze({ ...pins });
    this.purpose = purpose;
    this.audience = audience;
    this.childPolicy = Object.freeze({
      effectScopes: uniqueStrings(policy.effectScopes ?? [], "childPolicy.effectScopes"),
      resourceScopes: uniqueStrings(policy.resourceScopes ?? [], "childPolicy.resourceScopes"),
      maxEffects: Number.isSafeInteger(policy.maxEffects) && policy.maxEffects >= 0 ? policy.maxEffects : 0,
      readOnly: policy.readOnly === true,
    });
    this.executions = new Map();
  }

  async verifyPins() {
    const limb = await this.contract.readAdmittedLimb({ digest: this.pins.limbDigest });
    if (limb?.status !== "admitted" || limb.digest !== this.pins.limbDigest || !Number.isSafeInteger(limb.attachmentGeneration)) {
      throw new Error("pinned limb is not admitted and attached");
    }
    const harness = await this.contract.readPinnedCellWorkflow({
      cellPackageDigest: this.pins.cellPackageDigest,
      workflowDigest: this.pins.workflowDigest,
    });
    if (harness?.cellPackageDigest !== this.pins.cellPackageDigest || harness?.workflowDigest !== this.pins.workflowDigest || harness?.status !== "pinned") {
      throw new Error("Cell/workflow pins were not independently read back");
    }
    return { limb, harness };
  }

  async projectContext(authority, occurrence) {
    const projection = await this.contract.readPurposeContext({
      tenant: authority.tenant, rootId: occurrence.rootId, occurrenceId: occurrence.occurrenceId,
      purpose: this.purpose, audience: this.audience,
    });
    assertClosed(projection, new Set(["sourceVersion", "items"]), "context projection");
    if (!Number.isSafeInteger(projection.sourceVersion) || projection.sourceVersion < 1 || !Array.isArray(projection.items)) {
      throw new Error("malformed Contract context projection");
    }
    const citations = [];
    const parentLines = [];
    for (const item of projection.items) {
      assertClosed(item, new Set(["field", "value", "citationId", "commitOrdinal"]), "context item");
      if (FORBIDDEN_CONTEXT.has(item.field)) throw new Error(`forbidden context field: ${item.field}`);
      required(item.field, "context field");
      required(item.citationId, "context citationId", HEX64);
      if (!Number.isSafeInteger(item.commitOrdinal) || item.commitOrdinal < 1 || typeof item.value !== "string") throw new Error("malformed cited context item");
      citations.push(item.citationId);
      parentLines.push(`${item.field}=${item.value} [citation:${item.citationId}]`);
    }
    if (new Set(citations).size !== citations.length) throw new Error("duplicate delegated citation identity");
    return Object.freeze({ sourceVersion: projection.sourceVersion, citationIds: Object.freeze(citations), parentLines: Object.freeze(parentLines) });
  }

  /** Public hook entry. The request is untrusted; only authenticateHook's result supplies authority. */
  async enqueueFromHook(request) {
    const authority = await this.contract.authenticateHook(request);
    assertClosed(authority, new Set(["authenticatedSubject", "tenant", "grantedScopes", "credentialGeneration", "verificationEvidence"]), "verified ingress");
    required(authority.authenticatedSubject, "authenticated subject");
    required(authority.tenant, "verified tenant");
    required(authority.credentialGeneration, "verified credential generation");
    const grantedScopes = uniqueStrings(authority.grantedScopes, "verified scopes");
    if (!grantedScopes.includes("deploy-aiko")) throw new Error("verified ingress lacks deploy-aiko scope");
    const occurrence = await this.contract.acceptHook({
      authenticatedSubject: authority.authenticatedSubject, tenant: authority.tenant,
      purpose: this.purpose, audience: this.audience, verificationEvidence: authority.verificationEvidence,
      requestDigest: digest(request),
    });
    required(occurrence.rootId, "Contract root");
    required(occurrence.occurrenceId, "parent occurrence");
    required(occurrence.executionId, "parent execution");
    const state = { rootId: occurrence.rootId, occurrenceId: occurrence.occurrenceId, executionId: occurrence.executionId, stage: "queued", controller: new AbortController() };
    this.executions.set(state.occurrenceId, state);
    // Return the durable identity before the scheduler turn begins so the
    // public cancellation route can fence work while it is genuinely queued.
    const completion = new Promise((resolve, reject) => setImmediate(() => {
      if (state.stage === "cancelled") resolve({ status: "cancelled", phase: "queued", occurrenceId: state.occurrenceId });
      else this.executeOccurrence(authority, grantedScopes, occurrence, state).then(resolve, reject);
    }));
    return Object.freeze({ occurrenceId: state.occurrenceId, executionId: state.executionId, completion });
  }

  async launchFromHook(request) {
    const queued = await this.enqueueFromHook(request);
    return queued.completion;
  }

  async executeOccurrence(authority, grantedScopes, occurrence, state) {
    state.stage = "executing";
    await this.contract.beginExecution({ rootId: state.rootId, occurrenceId: state.occurrenceId, executionId: state.executionId });
    const [pins, context] = await Promise.all([this.verifyPins(), this.projectContext(authority, occurrence)]);
    if (state.stage === "cancelled") return { status: "cancelled", phase: "executing", occurrenceId: state.occurrenceId };
    const parentPrompt = [`Purpose: ${this.purpose}`, ...context.parentLines].join("\n");
    let parent;
    try {
      parent = await this.generate({ prompt: parentPrompt, rootDir: this.cwd, abortSignal: state.controller.signal });
    } catch (error) {
      if (state.stage === "cancelled") return { status: "cancelled", phase: "executing", occurrenceId: state.occurrenceId };
      throw error;
    }
    if (state.stage === "cancelled") return { status: "cancelled", phase: "executing", occurrenceId: state.occurrenceId };
    if (state.stage === "compensating") return { status: "compensating", occurrenceId: state.occurrenceId, compensationId: state.compensationId };

    const parentEffects = uniqueStrings(occurrence.effectScopes ?? [], "parent effect scopes");
    const parentResources = uniqueStrings(occurrence.resourceScopes ?? [], "parent resource scopes");
    const effectScopes = intersection(grantedScopes, parentEffects, this.childPolicy.effectScopes);
    const resourceScopes = intersection(grantedScopes, parentResources, this.childPolicy.resourceScopes);
    const requestGrant = {
      rootId: occurrence.rootId, parentOccurrenceId: occurrence.occurrenceId,
      parentExecutionId: occurrence.executionId, audience: this.audience, purpose: this.purpose,
      effectScopes, resourceScopes, maxEffects: Math.min(occurrence.maxEffects ?? 0, this.childPolicy.maxEffects),
      readOnly: occurrence.readOnly === true || this.childPolicy.readOnly,
      citationIds: [...context.citationIds], credentialGeneration: authority.credentialGeneration,
    };
    if (requestGrant.readOnly) { requestGrant.maxEffects = 0; requestGrant.effectScopes = []; }
    const issued = await this.contract.issueDelegation(requestGrant);
    required(issued.grantId, "opaque delegation", HEX64);
    const adopted = await this.contract.adoptDelegation({ grantId: issued.grantId, audience: this.audience });
    if (adopted.rootId !== occurrence.rootId || adopted.parentOccurrenceId !== occurrence.occurrenceId ||
        adopted.occurrenceId === occurrence.occurrenceId || adopted.executionId === occurrence.executionId) {
      throw new Error("child lineage is not a distinct occurrence/execution in the same root");
    }
    for (const [key, expected] of [["effectScopes", requestGrant.effectScopes], ["resourceScopes", requestGrant.resourceScopes], ["citationIds", requestGrant.citationIds]]) {
      if (JSON.stringify([...(adopted[key] ?? [])].sort()) !== JSON.stringify([...expected].sort())) throw new Error(`adopted child ${key} widened or moved`);
    }
    if (adopted.maxEffects !== requestGrant.maxEffects || adopted.readOnly !== requestGrant.readOnly || adopted.credentialGeneration !== requestGrant.credentialGeneration) {
      throw new Error("adopted child authority differs from the intersection");
    }

    // A fresh sealed process is the one child. Its prompt carries citation IDs
    // only: no parent response, transcript, handoff, account or global memory.
    const child = new SpawnAuthorityAikoAgent({
      workspaceRoot: this.spawnAuthority.workspaceRoot, cwd: this.spawnAuthority.cwd,
      runtimeEnv: this.opts.env && Object.fromEntries(Object.entries(this.opts.env).filter(([k]) => ["PATH","TMPDIR","TMP","TEMP","LANG","LC_ALL","NO_COLOR","TERM"].includes(k))),
      account: this._sealedAccountForChild,
      agent: this._sealedAgentForChild,
    });
    const childPrompt = `Purpose: ${this.purpose}\nDelegated citations: ${context.citationIds.join(",")}`;
    const childResult = await this.contract.runDelegatedChild({
      grantId: issued.grantId, rootId: adopted.rootId, occurrenceId: adopted.occurrenceId,
      executionId: adopted.executionId, citationIds: [...context.citationIds],
    }, () => child.generate({ prompt: childPrompt, rootDir: this.cwd, abortSignal: state.controller.signal }));
    if (state.stage === "compensating") return { status: "compensating", occurrenceId: state.occurrenceId, compensationId: state.compensationId };
    const evidence = { rootId: occurrence.rootId, occurrenceId: occurrence.occurrenceId, executionId: occurrence.executionId,
      childOccurrenceId: adopted.occurrenceId, childExecutionId: adopted.executionId, grantId: issued.grantId,
      citationIds: [...context.citationIds], limbDigest: pins.limb.digest, workflowDigest: pins.harness.workflowDigest,
      parentResultDigest: createHash("sha256").update(parent.text ?? "").digest("hex"), childResultDigest: createHash("sha256").update(childResult.text ?? "").digest("hex") };
    await this.contract.recordExecutionEvidence(evidence);
    state.stage = "settled";
    return Object.freeze({ status: "settled", ...evidence });
  }

  /** Bind child reconstruction material without exposing it in diagnostics or persisted evidence. */
  sealChildSpawn({ account, agent = {} }) {
    const parent = this.spawnAuthority.account;
    if (!account || account.id !== parent.id || account.provider !== parent.provider || account.generation !== parent.generation) {
      throw new Error("child must use the fixed parent account/provider generation");
    }
    this._sealedAccountForChild = account;
    this._sealedAgentForChild = agent;
    return this;
  }

  async cancel(occurrenceId, reason = "caller-requested") {
    required(occurrenceId, "occurrenceId");
    const state = this.executions.get(occurrenceId);
    if (!state) throw new Error("unknown Contract occurrence");
    const effects = await this.contract.readExternalEffects({ rootId: state.rootId, occurrenceId });
    if ((effects ?? []).length > 0) {
      const compensation = await this.contract.openCompensation({ rootId: state.rootId, occurrenceId, reason, effectIds: effects.map((x) => x.effectId) });
      state.stage = "compensating";
      state.compensationId = compensation.compensationId;
      return { status: "compensating", compensationId: compensation.compensationId };
    }
    if (state.stage === "settled") throw new Error("settled execution without an external effect cannot be retroactively cancelled");
    const phase = state.stage;
    await this.contract.requestCancellation({ rootId: state.rootId, occurrenceId, executionId: state.executionId, phase, reason });
    state.stage = "cancelled";
    state.controller.abort(new Error(`Contract cancellation: ${reason}`));
    return { status: "cancelled", phase };
  }
}

export function createContractAikoAgent(options) {
  const agent = new ContractAikoAgent(options);
  if (!options.childSpawn) throw new Error("ContractAikoAgent requires one explicit child spawn binding");
  return agent.sealChildSpawn(options.childSpawn);
}
