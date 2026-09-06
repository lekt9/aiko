import { describe, expect, it } from "vitest";
import { createUnlockClient } from "../packages/sdk/src/index";
import { createRuntimeClient } from "../packages/sdk/src/runtime";
import { createDemoService } from "../apps/web/src/server/demo";
function setup() {
  const handle = createDemoService();
  const transport: typeof fetch = (url, init) => handle(new Request(url, init));
  const options = { baseUrl: "http://127.0.0.1:4173/api", transport };
  return {
    api: createUnlockClient(options),
    runtime: createRuntimeClient(options),
    transport,
  };
}
describe("vault-first metadata and access", () => {
  it("saves favorites without modifying sign-in revisions or profile access", async () => {
    const { api } = setup();
    const before = await api.workspace();
    const c = await api.connections.update("github", { favorite: false });
    expect(c.favorite).toBe(false);
    expect(c.revision).toBe(24);
    expect((await api.workspace()).profiles).toEqual(before.profiles);
  });
  it("edits display names without rewriting source credentials", async () => {
    const { api } = setup();
    const c = await api.connections.update("github", { name: "GitHub work" });
    expect(c.name).toBe("GitHub work");
    expect(c.sourceId).toBe("onepassword");
    await expect(
      api.connections.update("github", { identity: "another@studio.example" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("edits a synthetic username and requires another sign-in", async () => {
    const { api } = setup();
    const c = await api.connections.update("figma", {
      name: "Design work",
      identity: "design@new.example",
    });
    expect(c.identity).toBe("design@new.example");
    expect(c.status).toBe("challenge");
  });
  it("rejects real-domain username input and unsupported password fields", async () => {
    const { api, transport } = setup();
    await expect(
      api.connections.update("figma", { identity: "someone@gmail.com" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const response = await transport(
      "http://127.0.0.1:4173/api/connections/figma",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "do-not-store", name: "Figma" }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("do-not-store");
  });
  it("shares one saved login across profiles with no credential duplication", async () => {
    const { api, runtime } = setup();
    await api.connections.assign("github", ["builder", "research"]);
    expect(await api.connections.list()).toHaveLength(4);
    expect(
      (await api.profiles.list()).filter((p) =>
        p.connectionIds.includes("github"),
      ),
    ).toHaveLength(2);
    expect(
      (
        await runtime.retrieve({
          connectionId: "github",
          profileId: "research",
        })
      ).connectionId,
    ).toBe("github");
  });
  it("validates every profile before atomically changing access", async () => {
    const { api } = setup();
    const before = await api.profiles.list();
    await expect(
      api.connections.assign("github", ["unknown"]),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await api.profiles.list()).toEqual(before);
  });
  it("removes one profile without deleting a login or changing another profile", async () => {
    const { api, runtime } = setup();
    await api.connections.assign("github", ["builder", "research"]);
    const builder = (await api.profiles.list())[0];
    await api.profiles.update(builder.id, {
      connectionIds: builder.connectionIds.filter((id) => id !== "github"),
    });
    expect(await api.connections.list()).toHaveLength(4);
    await expect(
      runtime.retrieve({ connectionId: "github", profileId: "builder" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await runtime.retrieve({ connectionId: "github", profileId: "research" });
  });
  it("creates a profile with color and selected logins in one validated write", async () => {
    const { api } = setup();
    const p = await api.profiles.create({
      name: "Release agent",
      description: "Agent profile",
      avatar: "mint",
      connectionIds: ["github", "github"],
    });
    expect(p.avatar).toBe("mint");
    expect(p.connectionIds).toEqual(["github"]);
    await api.profiles.update(p.id, { avatar: "blue", name: "Release helper" });
    expect((await api.profiles.list()).find((x) => x.id === p.id)?.avatar).toBe(
      "blue",
    );
  });
  it("does not create a partially assigned profile on invalid input", async () => {
    const { api } = setup();
    await expect(
      api.profiles.create({
        name: "Invalid agent",
        description: "Agent profile",
        connectionIds: ["missing"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await api.profiles.list()).toHaveLength(3);
  });
  it("deleting a login removes it from every profile and prevents further editing or assignment", async () => {
    const { api } = setup();
    await api.connections.assign("github", ["builder", "research"]);
    await api.connections.action("github", "revoke");
    expect(
      (await api.profiles.list()).every(
        (p) => !p.connectionIds.includes("github"),
      ),
    ).toBe(true);
    await expect(
      api.connections.update("github", { name: "Undelete" }),
    ).rejects.toMatchObject({ code: "REVOKED" });
    await expect(
      api.connections.assign("github", ["research"]),
    ).rejects.toMatchObject({ code: "REVOKED" });
  });
});
