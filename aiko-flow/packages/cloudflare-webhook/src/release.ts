import { sha256Hex } from "./manifest";

export const RELEASE_RECEIPT_VERSION = "aiko.cloudflare-release.receipt.v1" as const;
export type ReleaseEnvironment = "preview" | "staging" | "production";

export type ReleasePins = Readonly<{
  gitSha: string;
  manifestDigest: string;
  bindingsDigest: string;
  migrationsDigest: string;
}>;
export type DestinationCredential = Readonly<{
  provider: "cloudflare";
  accountId: string;
  handleId: string;
  generation: string;
  destinations: readonly ReleaseEnvironment[];
}>;
export type ProviderUpload = Readonly<{ accountId: string; versionId: string; artifactDigest: string }>;
export type ProviderPromotion = Readonly<{ accountId: string; environment: ReleaseEnvironment; versionId: string; deploymentId: string }>;
export type ProviderVersion = Readonly<{ accountId: string; versionId: string; artifactDigest: string }>;

/** The provider is injected deliberately: this kernel neither invokes Wrangler nor claims a live smoke. */
export interface ReleaseProvider {
  upload(input: Readonly<{ accountId: string; credentialHandleId: string; artifact: Uint8Array; artifactDigest: string; pins: ReleasePins }>): Promise<ProviderUpload>;
  promote(input: Readonly<{ accountId: string; credentialHandleId: string; environment: ReleaseEnvironment; versionId: string }>): Promise<ProviderPromotion>;
  verifyVersion(input: Readonly<{ accountId: string; credentialHandleId: string; versionId: string }>): Promise<ProviderVersion>;
}

export type ReleaseReceipt = Readonly<{
  receiptVersion: typeof RELEASE_RECEIPT_VERSION;
  operation: "upload" | "promote" | "rollback";
  releaseId: string;
  accountId: string;
  artifactDigest: string;
  providerVersionId: string;
  environment?: ReleaseEnvironment;
  deploymentId?: string;
  pins: ReleasePins;
  liveDeploymentClaim: false;
  smoke: "not-run";
}>;

type VersionRecord = {
  releaseId: string;
  accountId: string;
  artifactDigest: string;
  versionId: string;
  pins: ReleasePins;
  credentialHandleId: string;
  credentialGeneration: string;
  nextPromotion: number;
  reachedProduction: boolean;
};

const DIGEST = /^[a-f0-9]{64}$/;
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const ORDER: readonly ReleaseEnvironment[] = ["preview", "staging", "production"];

function exactObject(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) if (!keys.includes(key)) throw new Error(`${name}.${key} is not allowed`);
  for (const key of keys) if (!(key in object)) throw new Error(`${name}.${key} is required`);
  return object;
}
function id(value: unknown, name: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`${name} is invalid`);
  return value;
}
function digest(value: unknown, name: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(`${name} must be a pinned sha256 digest`);
  return value;
}
function sealPins(input: unknown): ReleasePins {
  const pins = exactObject(input, ["gitSha", "manifestDigest", "bindingsDigest", "migrationsDigest"], "pins");
  if (typeof pins.gitSha !== "string" || !GIT_SHA.test(pins.gitSha)) throw new Error("pins.gitSha must be pinned");
  return Object.freeze({ gitSha: pins.gitSha, manifestDigest: digest(pins.manifestDigest, "pins.manifestDigest"), bindingsDigest: digest(pins.bindingsDigest, "pins.bindingsDigest"), migrationsDigest: digest(pins.migrationsDigest, "pins.migrationsDigest") });
}
function sealCredential(input: unknown): DestinationCredential {
  const value = exactObject(input, ["provider", "accountId", "handleId", "generation", "destinations"], "credential");
  if (value.provider !== "cloudflare") throw new Error("credential provider is invalid");
  const destinations = value.destinations;
  if (!Array.isArray(destinations) || destinations.length !== ORDER.length || ORDER.some((entry) => !destinations.includes(entry))) throw new Error("credential is not bound to the release destinations");
  if (new Set(destinations).size !== ORDER.length) throw new Error("credential destinations contain duplicates");
  return Object.freeze({ provider: "cloudflare", accountId: id(value.accountId, "credential.accountId"), handleId: id(value.handleId, "credential.handleId"), generation: id(value.generation, "credential.generation"), destinations: Object.freeze([...ORDER]) });
}
function receipt(record: VersionRecord, operation: ReleaseReceipt["operation"], extra: Pick<ReleaseReceipt, "environment" | "deploymentId"> = {}): ReleaseReceipt {
  return Object.freeze({ receiptVersion: RELEASE_RECEIPT_VERSION, operation, releaseId: record.releaseId, accountId: record.accountId, artifactDigest: record.artifactDigest, providerVersionId: record.versionId, pins: record.pins, ...extra, liveDeploymentClaim: false, smoke: "not-run" });
}
function assertUploadResult(result: ProviderUpload, accountId: string, artifactDigest: string): void {
  if (result.accountId !== accountId) throw new Error("provider upload account mismatch");
  id(result.versionId, "provider versionId");
  if (result.artifactDigest !== artifactDigest) throw new Error("provider artifact digest mismatch");
}
function assertPromotionResult(result: ProviderPromotion, accountId: string, environment: ReleaseEnvironment, versionId: string): void {
  if (result.accountId !== accountId) throw new Error("provider promotion account mismatch");
  if (result.environment !== environment) throw new Error("provider promotion destination mismatch");
  if (result.versionId !== versionId) throw new Error("provider promotion version mismatch");
  id(result.deploymentId, "provider deploymentId");
}

/** In-memory orchestration state; callers persist the secret-free receipts as their durable ledger. */
export class CloudflareReleaseMachine {
  readonly #provider: ReleaseProvider;
  readonly #releases = new Map<string, VersionRecord>();
  readonly #versions = new Map<string, VersionRecord>();
  #active: VersionRecord | undefined;
  #production: VersionRecord | undefined;

  constructor(provider: ReleaseProvider) { this.#provider = provider; }

  async upload(input: Readonly<{ releaseId: string; artifact: Uint8Array; pins: ReleasePins; credential: DestinationCredential }>): Promise<ReleaseReceipt> {
    const releaseId = id(input.releaseId, "releaseId");
    if (!(input.artifact instanceof Uint8Array) || input.artifact.byteLength === 0) throw new Error("prebuilt artifact bytes are required");
    if (this.#releases.has(releaseId)) throw new Error("release was already uploaded");
    if (this.#active && !this.#active.reachedProduction) throw new Error("an immutable release is already in promotion");
    const pins = sealPins(input.pins);
    const credential = sealCredential(input.credential);
    const artifact = Uint8Array.from(input.artifact);
    const artifactDigest = await sha256Hex(artifact);
    const result = await this.#provider.upload({ accountId: credential.accountId, credentialHandleId: credential.handleId, artifact, artifactDigest, pins });
    if (await sha256Hex(artifact) !== artifactDigest) throw new Error("provider mutated immutable artifact bytes");
    assertUploadResult(result, credential.accountId, artifactDigest);
    if (this.#versions.has(result.versionId)) throw new Error("provider version was already recorded");
    const record: VersionRecord = { releaseId, accountId: credential.accountId, artifactDigest, versionId: result.versionId, pins, credentialHandleId: credential.handleId, credentialGeneration: credential.generation, nextPromotion: 0, reachedProduction: false };
    this.#releases.set(releaseId, record);
    this.#versions.set(result.versionId, record);
    this.#active = record;
    return receipt(record, "upload");
  }

  async promote(environment: ReleaseEnvironment): Promise<ReleaseReceipt> {
    const record = this.#active;
    if (!record) throw new Error("no uploaded release");
    const expected = ORDER[record.nextPromotion];
    if (environment !== expected) throw new Error(`promotion must target ${expected ?? "no further environment"}`);
    const result = await this.#provider.promote({ accountId: record.accountId, credentialHandleId: record.credentialHandleId, environment, versionId: record.versionId });
    assertPromotionResult(result, record.accountId, environment, record.versionId);
    record.nextPromotion += 1;
    if (environment === "production") { record.reachedProduction = true; this.#production = record; }
    return receipt(record, "promote", { environment, deploymentId: result.deploymentId });
  }

  async rollback(priorVersionId: string): Promise<ReleaseReceipt> {
    const current = this.#production;
    if (!current) throw new Error("nothing is deployed to production");
    const prior = this.#versions.get(priorVersionId);
    if (!prior || !prior.reachedProduction || prior === current) throw new Error("rollback target is not a verified prior production version");
    if (prior.accountId !== current.accountId) throw new Error("rollback target belongs to another account");
    const verified = await this.#provider.verifyVersion({ accountId: current.accountId, credentialHandleId: current.credentialHandleId, versionId: prior.versionId });
    if (verified.accountId !== prior.accountId || verified.versionId !== prior.versionId || verified.artifactDigest !== prior.artifactDigest) throw new Error("rollback target failed immutable provider verification");
    const promoted = await this.#provider.promote({ accountId: current.accountId, credentialHandleId: current.credentialHandleId, environment: "production", versionId: prior.versionId });
    assertPromotionResult(promoted, prior.accountId, "production", prior.versionId);
    this.#production = prior;
    this.#active = prior;
    return receipt(prior, "rollback", { environment: "production", deploymentId: promoted.deploymentId });
  }
}
