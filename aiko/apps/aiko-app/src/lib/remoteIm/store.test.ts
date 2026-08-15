import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetBridgeMock,
  bridgeGetStatus,
  bridgeReloadInstance,
  bridgeStart,
} from "./bridgeClient";
import {
  __resetRemoteImSecretsMock,
  credentialsRefFor,
  remoteImSecretsGetMasked,
  remoteImSecretsPut,
} from "./secretsApi";
import {
  createDefaultInstance,
  deleteChannelInstance,
  removeInstance,
} from "./store";

describe("remoteIm deleteChannelInstance", () => {
  beforeEach(() => {
    __resetBridgeMock();
    __resetRemoteImSecretsMock();
  });

  it("clears secrets vault and disconnects Bridge (not just list remove)", async () => {
    const inst = {
      ...createDefaultInstance("feishu"),
      enabled: true,
      hasCredentials: true,
      credentialsRef: credentialsRefFor("feishu", "feishu-default"),
    };
    await remoteImSecretsPut({
      credentialsRef: inst.credentialsRef!,
      channel: "feishu",
      instanceId: inst.id,
      secrets: { app_secret: "must-be-deleted" },
    });
    expect(await remoteImSecretsGetMasked(inst.credentialsRef!)).toBeTruthy();

    await bridgeStart();
    await bridgeReloadInstance(inst);
    let st = await bridgeGetStatus();
    expect(st.connectedChannels.some((c) => c.instanceId === inst.id)).toBe(
      true,
    );

    const result = await deleteChannelInstance({
      list: [inst],
      instanceId: inst.id,
    });

    expect(result.secretsCleared).toBe(true);
    expect(result.disconnected).toBe(true);
    expect(result.list).toEqual([]);
    expect(await remoteImSecretsGetMasked(inst.credentialsRef!)).toBeNull();

    st = await bridgeGetStatus();
    expect(st.connectedChannels.some((c) => c.instanceId === inst.id)).toBe(
      false,
    );
  });

  it("removeInstance alone does NOT clear secrets or disconnect (regression guard)", async () => {
    const inst = {
      ...createDefaultInstance("telegram"),
      id: "telegram-x",
      enabled: true,
      hasCredentials: true,
      credentialsRef: credentialsRefFor("telegram", "telegram-x"),
    };
    await remoteImSecretsPut({
      credentialsRef: inst.credentialsRef!,
      channel: "telegram",
      instanceId: inst.id,
      secrets: { token: "keep-me" },
    });
    await bridgeStart();
    await bridgeReloadInstance(inst);

    const onlyList = removeInstance([inst], inst.id);
    expect(onlyList).toEqual([]);
    // Still in vault and connected — proves deleteChannelInstance is required
    expect(await remoteImSecretsGetMasked(inst.credentialsRef!)).toBeTruthy();
    const st = await bridgeGetStatus();
    expect(st.connectedChannels.some((c) => c.instanceId === inst.id)).toBe(
      true,
    );
  });

  it("noop when instance missing", async () => {
    const r = await deleteChannelInstance({
      list: [],
      instanceId: "nope",
    });
    expect(r.deleted).toBeNull();
    expect(r.secretsCleared).toBe(false);
    expect(r.disconnected).toBe(false);
  });
});
