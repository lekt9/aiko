import { describe, expect, test } from "bun:test";
import { CloudflareReleaseMachine, type DestinationCredential, type ProviderPromotion, type ReleaseEnvironment, type ReleasePins, type ReleaseProvider } from "../src/release";
import { sha256Hex } from "../src/manifest";

const bytes = (text: string) => new TextEncoder().encode(text);
const d = (character: string) => character.repeat(64);
const pins: ReleasePins = { gitSha: "a".repeat(40), manifestDigest: d("b"), bindingsDigest: d("c"), migrationsDigest: d("d") };
const credential: DestinationCredential = { provider: "cloudflare", accountId: "acct-42", handleId: "native-handle-7", generation: "cred-3", destinations: ["preview", "staging", "production"] };

class ProviderDouble implements ReleaseProvider {
  uploads: Array<{ accountId: string; credentialHandleId: string; artifact: Uint8Array; artifactDigest: string; pins: ReleasePins }> = [];
  promotions: Array<{ accountId: string; credentialHandleId: string; environment: ReleaseEnvironment; versionId: string }> = [];
  versions = new Map<string, string>();
  uploadMutation?: (result: { accountId: string; versionId: string; artifactDigest: string }, input: { artifact: Uint8Array }) => void;
  promotionMutation?: (result: ProviderPromotion) => ProviderPromotion;
  verifyMutation?: (result: { accountId: string; versionId: string; artifactDigest: string }) => { accountId: string; versionId: string; artifactDigest: string };

  async upload(input: { accountId: string; credentialHandleId: string; artifact: Uint8Array; artifactDigest: string; pins: ReleasePins }) {
    this.uploads.push(input);
    const result = { accountId: input.accountId, versionId: `version-${this.uploads.length}`, artifactDigest: input.artifactDigest };
    this.versions.set(result.versionId, result.artifactDigest);
    this.uploadMutation?.(result, input);
    return result;
  }
  async promote(input: { accountId: string; credentialHandleId: string; environment: ReleaseEnvironment; versionId: string }) {
    this.promotions.push(input);
    const result: ProviderPromotion = { accountId: input.accountId, environment: input.environment, versionId: input.versionId, deploymentId: `deployment-${this.promotions.length}` };
    return this.promotionMutation?.(result) ?? result;
  }
  async verifyVersion(input: { accountId: string; credentialHandleId: string; versionId: string }) {
    const result = { accountId: input.accountId, versionId: input.versionId, artifactDigest: this.versions.get(input.versionId) ?? "missing" };
    return this.verifyMutation?.(result) ?? result;
  }
}

async function deploy(machine: CloudflareReleaseMachine, releaseId: string, artifact: Uint8Array) {
  const uploaded = await machine.upload({ releaseId, artifact, pins, credential });
  const preview = await machine.promote("preview");
  const staging = await machine.promote("staging");
  const production = await machine.promote("production");
  return { uploaded, preview, staging, production };
}

function expectRefusal(promise: Promise<unknown>, fragment: string) {
  return expect(promise).rejects.toThrow(fragment);
}

describe("hermetic immutable Cloudflare release promotion kernel", () => {
  test("uploads prebuilt bytes once and promotes the provider's exact immutable version without rebuilding", async () => {
    const provider = new ProviderDouble();
    const machine = new CloudflareReleaseMachine(provider);
    const artifact = bytes("already-built-worker-v1");
    const receipts = await deploy(machine, "release-1", artifact);
    const digest = await sha256Hex(artifact);

    expect(provider.uploads).toHaveLength(1);
    expect(provider.uploads[0]).toMatchObject({ accountId: "acct-42", credentialHandleId: "native-handle-7", artifactDigest: digest, pins });
    expect(provider.promotions.map(({ environment, versionId }) => [environment, versionId])).toEqual([["preview", "version-1"], ["staging", "version-1"], ["production", "version-1"]]);
    expect(receipts.uploaded).toMatchObject({ operation: "upload", artifactDigest: digest, providerVersionId: "version-1", smoke: "not-run", liveDeploymentClaim: false });
    expect(receipts.production).toMatchObject({ operation: "promote", environment: "production", providerVersionId: "version-1", smoke: "not-run", liveDeploymentClaim: false });
    expect(Object.keys(receipts.uploaded).sort()).toEqual(["accountId", "artifactDigest", "liveDeploymentClaim", "operation", "pins", "providerVersionId", "receiptVersion", "releaseId", "smoke"]);
    expect(JSON.stringify(receipts)).not.toContain(credential.handleId);
    expect(JSON.stringify(receipts)).not.toContain(credential.generation);
  });

  test("changed bytes/rebuild attempts and out-of-order promotion cannot replace the active release", async () => {
    const provider = new ProviderDouble();
    const machine = new CloudflareReleaseMachine(provider);
    await machine.upload({ releaseId: "release-1", artifact: bytes("worker-v1"), pins, credential });
    await expectRefusal(machine.upload({ releaseId: "release-1", artifact: bytes("rebuilt-worker-v1"), pins, credential }), "already uploaded");
    await expectRefusal(machine.upload({ releaseId: "release-mutated", artifact: bytes("rebuilt-worker-v1"), pins, credential }), "already in promotion");
    await expectRefusal(machine.promote("staging"), "must target preview");
    expect(provider.uploads).toHaveLength(1);
    expect(provider.promotions).toHaveLength(0);
  });

  test("fails closed on every missing pin and on plaintext or unscoped credential metadata", async () => {
    for (const key of Object.keys(pins) as Array<keyof ReleasePins>) {
      const provider = new ProviderDouble();
      const machine = new CloudflareReleaseMachine(provider);
      const incomplete = { ...pins } as Record<string, unknown>;
      delete incomplete[key];
      await expectRefusal(machine.upload({ releaseId: `missing-${key}`, artifact: bytes("x"), pins: incomplete as ReleasePins, credential }), `pins.${key}`);
      expect(provider.uploads).toHaveLength(0);
    }
    const provider = new ProviderDouble();
    const secret = "super-secret-cloudflare-bearer";
    await expectRefusal(new CloudflareReleaseMachine(provider).upload({ releaseId: "secret", artifact: bytes("x"), pins, credential: { ...credential, token: secret } as DestinationCredential }), "credential.token is not allowed");
    await expectRefusal(new CloudflareReleaseMachine(provider).upload({ releaseId: "unscoped", artifact: bytes("x"), pins, credential: { ...credential, destinations: ["preview"] } }), "not bound");
    expect(provider.uploads).toHaveLength(0);
  });

  test("rejects wrong provider account, digest, promoted version, and destination", async () => {
    for (const mutation of [
      (r: ProviderPromotion) => ({ ...r, accountId: "wrong-account" }),
      (r: ProviderPromotion) => ({ ...r, versionId: "wrong-version" }),
      (r: ProviderPromotion) => ({ ...r, environment: "production" as const }),
    ]) {
      const provider = new ProviderDouble();
      provider.promotionMutation = mutation;
      const machine = new CloudflareReleaseMachine(provider);
      await machine.upload({ releaseId: "release", artifact: bytes("x"), pins, credential });
      await expect(machine.promote("preview")).rejects.toThrow(/mismatch/);
    }
    const wrongAccount = new ProviderDouble();
    wrongAccount.uploadMutation = (result) => { result.accountId = "wrong-account"; };
    await expectRefusal(new CloudflareReleaseMachine(wrongAccount).upload({ releaseId: "release", artifact: bytes("x"), pins, credential }), "account mismatch");
    const wrongDigest = new ProviderDouble();
    wrongDigest.uploadMutation = (result) => { result.artifactDigest = d("0"); };
    await expectRefusal(new CloudflareReleaseMachine(wrongDigest).upload({ releaseId: "release", artifact: bytes("x"), pins, credential }), "digest mismatch");
  });

  test("provider cannot mutate handed-off bytes and upload is evidence, never deployment or smoke success", async () => {
    const provider = new ProviderDouble();
    provider.uploadMutation = (_result, input) => { input.artifact[0] ^= 1; };
    await expectRefusal(new CloudflareReleaseMachine(provider).upload({ releaseId: "release", artifact: bytes("x"), pins, credential }), "mutated immutable artifact");

    const clean = new ProviderDouble();
    const upload = await new CloudflareReleaseMachine(clean).upload({ releaseId: "release", artifact: bytes("x"), pins, credential });
    expect(upload.operation).toBe("upload");
    expect(upload).not.toHaveProperty("environment");
    expect(upload).not.toHaveProperty("deploymentId");
    expect(upload.smoke).toBe("not-run");
    expect(upload.liveDeploymentClaim).toBe(false);
  });

  test("rolls production back only to a provider-verified prior production version", async () => {
    const provider = new ProviderDouble();
    const machine = new CloudflareReleaseMachine(provider);
    await deploy(machine, "release-1", bytes("worker-v1"));
    await deploy(machine, "release-2", bytes("worker-v2"));
    const rollback = await machine.rollback("version-1");
    expect(provider.promotions.at(-1)).toMatchObject({ environment: "production", versionId: "version-1", accountId: "acct-42" });
    expect(rollback).toMatchObject({ operation: "rollback", providerVersionId: "version-1", environment: "production", smoke: "not-run", liveDeploymentClaim: false });

    await expectRefusal(machine.rollback("version-1"), "not a verified prior");
    await expectRefusal(machine.rollback("release-2"), "not a verified prior");
    await expectRefusal(machine.rollback("unknown-version"), "not a verified prior");

    const tamperedProvider = new ProviderDouble();
    const tampered = new CloudflareReleaseMachine(tamperedProvider);
    await deploy(tampered, "release-1", bytes("worker-v1"));
    await deploy(tampered, "release-2", bytes("worker-v2"));
    tamperedProvider.verifyMutation = (result) => ({ ...result, artifactDigest: d("f") });
    await expectRefusal(tampered.rollback("version-1"), "failed immutable provider verification");
    expect(tamperedProvider.promotions).toHaveLength(6);
  });
});
