import { expect, test, spyOn } from "bun:test";
import {
  createCdpCookieAdapter,
  type PrivateCdp,
} from "../../../packages/sdk/src/cdp.ts";
import {
  PrivateBrowserSessions,
  type PrivateSessionInstall,
  type PrivateSessionRecord,
  type PrivateBrowserContext,
  openPrivateBrowserCdp,
  createOwnedCookieAdapter,
} from "../src/browser-driver.ts";
import {
  Codegraff,
  CodegraffSandbox,
  replayKeys,
  wrapReplay,
  unwrapReplay,
  sealReplay,
  openReplay,
  PrivateOperationFence,
} from "../src/codegraff.ts";

const context: PrivateBrowserContext = {
  owner: "alice",
  contextId: "owned-context",
  generation: 1,
};
const domain = "private.vendor.com";
function material(revision = 1): PrivateSessionInstall {
  return {
    ...context,
    domain,
    tenantId: "11111111-1111-4111-8111-111111111111",
    profileId: "22222222-2222-4222-8222-222222222222",
    runtimeId: "33333333-3333-4333-8333-333333333333",
    connectionId: "44444444-4444-4444-8444-444444444444",
    allowedDomains: [domain],
    connectionGeneration: 1,
    revision,
    expiresAt: Date.now() + 60000,
    cookies: [
      {
        name: "session",
        value: "PRIVATE_COOKIE_SENTINEL",
        domain,
        path: "/",
        expires: -1,
        secure: true,
        httpOnly: true,
        sameSite: "Strict",
        hostOnly: true,
      },
    ],
  };
}
async function fixture(records: PrivateSessionRecord[] = []) {
  let jar: any[] = [
    {
      name: "unrelated",
      value: "KEEP_OTHER_DOMAIN",
      domain: "other.vendor.com",
      path: "/",
      session: true,
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ];
  const calls: { method: string; params: any }[] = [];
  const saved: PrivateSessionRecord[] = [];
  let now = Date.now(),
    failSet = false;
  const cdp: PrivateCdp = {
    send: async (method, params) => {
      calls.push({ method, params });
      if (method === "Target.getTargetInfo")
        return { targetInfo: { browserContextId: "sdk-context" } };
      if (method === "Target.attachToTarget")
        return { sessionId: "sdk-target-session" };
      if (method === "Storage.getCookies")
        return { cookies: structuredClone(jar) };
      if (method === "Network.deleteCookies")
        jar = jar.filter(
          (c) =>
            !(
              c.name === params.name &&
              c.domain === params.domain &&
              c.path === params.path &&
              JSON.stringify(c.partitionKey) ===
                JSON.stringify(params.partitionKey)
            ),
        );
      if (method === "Storage.setCookies") {
        if (failSet) {
          failSet = false;
          throw new Error("PRIVATE_BACKEND_ERROR");
        }
        jar.push(
          ...(params.cookies as any[]).map((c) => ({
            ...c,
            domain: c.domain ?? new URL(c.url).hostname,
            session: c.expires === undefined,
          })),
        );
      }
      return {};
    },
  };
  const adapter = await createCdpCookieAdapter(cdp, {
    browserContextId: "sdk-context",
    targetId: "sdk-target",
  });
  const sessions = new PrivateBrowserSessions(
    context,
    async () => adapter,
    (row) => {
      saved.push(structuredClone(row));
    },
    records,
    () => now,
  );
  return {
    sessions,
    adapter,
    calls,
    saved,
    jar: () => structuredClone(jar),
    advance: () => {
      now += 120000;
    },
    failNextSet: () => {
      failSet = true;
    },
  };
}

test("actual SDK CDP adapter installs privately, replaces deletions and partitions, and preserves unrelated domains", async () => {
  const f = await fixture();
  try {
    const input = material();
    input.cookies.push({
      ...input.cookies[0]!,
      name: "deleted",
      partitionKey: {
        topLevelSite: "https://private.vendor.com",
        hasCrossSiteAncestor: false,
      },
    });
    const ack = await f.sessions.install(input);
    expect(ack).toEqual({
      owner: context.owner,
      contextId: context.contextId,
      generation: 1,
      domain,
      tenantId: input.tenantId,
      profileId: input.profileId,
      runtimeId: input.runtimeId,
      connectionId: input.connectionId,
      allowedDomains: [domain],
      revision: 1,
    });
    expect(JSON.stringify(ack)).not.toContain("PRIVATE_COOKIE_SENTINEL");
    expect(
      f.jar().some((c) => c.httpOnly && c.value === "PRIVATE_COOKIE_SENTINEL"),
    ).toBe(true);
    const next = material(2);
    next.cookies[0]!.value = "NEW_PRIVATE_COOKIE";
    await f.sessions.install(next);
    expect(f.jar().filter((c) => c.domain === domain)).toHaveLength(1);
    expect(f.jar().find((c) => c.domain === domain).value).toBe(
      "NEW_PRIVATE_COOKIE",
    );
    expect(f.jar().find((c) => c.domain === "other.vendor.com").value).toBe(
      "KEEP_OTHER_DOMAIN",
    );
    expect(f.calls.some((c) => c.method === "Storage.clearCookies")).toBe(
      false,
    );
    expect(
      f.calls.some(
        (c) => c.method === "Network.deleteCookies" && c.params.partitionKey,
      ),
    ).toBe(true);
    expect(JSON.stringify(f.saved)).not.toMatch(
      /PRIVATE_COOKIE|cookies|password/,
    );
  } finally {
    await f.sessions.close();
  }
});

test("owner/context/generation/domain mismatch, stale revision and expired material cannot install", async () => {
  const f = await fixture();
  try {
    await f.sessions.install(material(3));
    const before = f.calls.length;
    for (const input of [
      { ...material(4), owner: "bob" },
      { ...material(4), contextId: "prior-context" },
      { ...material(4), generation: 2 },
      { ...material(4), allowedDomains: ["other.vendor.com"] },
      { ...material(4), expiresAt: 0 },
      material(2),
      { ...material(4), connectionGeneration: 0 },
      {
        ...material(4),
        cookies: [
          { ...material().cookies[0]!, domain: ".vendor.com", hostOnly: false },
        ],
      },
    ])
      await expect(f.sessions.install(input)).rejects.toThrow();
    expect(f.calls).toHaveLength(before);
    expect(f.jar().find((c) => c.domain === domain).value).toBe(
      "PRIVATE_COOKIE_SENTINEL",
    );
  } finally {
    await f.sessions.close();
  }
});

test("same revision does not restore browser-deleted cookies; revocation fences stale reinstall", async () => {
  const f = await fixture();
  try {
    const first = material();
    await f.sessions.install(first);
    await f.adapter.replaceCookies([], first.allowedDomains);
    await f.sessions.install(first);
    expect(f.jar().filter((c) => c.domain === domain)).toHaveLength(0);
    await f.sessions.clear(first);
    await expect(f.sessions.install(first)).rejects.toThrow("Stale");
    await f.sessions.install({ ...first, revision: 2 });
    expect(f.jar().some((c) => c.domain === domain)).toBe(true);
    f.advance();
    let performed = false;
    await expect(
      f.sessions.run(`https://${domain}/`, async () => {
        performed = true;
      }),
    ).rejects.toThrow("expired");
    expect(performed).toBe(false);
    expect(f.jar().filter((c) => c.domain === domain)).toHaveLength(0);
  } finally {
    await f.sessions.close();
  }
});

test("session reset on reconstruction clears prior profile jar; failure never acknowledges material", async () => {
  const f = await fixture();
  const input = material();
  await f.sessions.install(input);
  const metadata = f.saved.at(-1)!;
  await f.sessions.close();
  const restored = await fixture([metadata]);
  try {
    await restored.adapter.replaceCookies(input.cookies, input.allowedDomains);
    await restored.sessions.run(`https://${domain}/`, async () => {
      expect(restored.jar().some((c) => c.domain === domain)).toBe(false);
    });
    restored.failNextSet();
    await expect(
      restored.sessions.install({ ...input, revision: 2 }),
    ).rejects.toThrow("installation failed");
    expect(restored.jar().some((c) => c.domain === domain)).toBe(false);
    await expect(
      restored.sessions.install({ ...input, revision: 2 }),
    ).rejects.toThrow("Stale");
  } finally {
    await restored.sessions.close();
  }
});

test("encrypted private install channel contains no cookie values; acknowledgement is metadata only", async () => {
  const f = await fixture(),
    keys = replayKeys();
  try {
    const sent = wrapReplay(
      { operation: "session-install", input: material() },
      keys.publicKey,
    );
    expect(JSON.stringify(sent.envelope)).not.toContain(
      "PRIVATE_COOKIE_SENTINEL",
    );
    const received = unwrapReplay(sent.envelope, keys.privateKey);
    const ack = await f.sessions.install(received.value.input);
    const response = sealReplay({ output: ack }, received.key);
    expect(openReplay(response, sent.key).output.revision).toBe(1);
    expect(JSON.stringify(f.saved)).not.toContain("PRIVATE_COOKIE_SENTINEL");
    expect(JSON.stringify(response)).not.toContain("PRIVATE_COOKIE_SENTINEL");
  } finally {
    await f.sessions.close();
  }
});

test("clear-before-install and cancellation fence in-flight stale session deliveries", async () => {
  const f = await fixture();
  try {
    await f.sessions.clear(material());
    await expect(f.sessions.install(material())).rejects.toThrow("Stale");
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      f.sessions.install(
        { ...material(), connectionId: crypto.randomUUID() },
        aborted.signal,
      ),
    ).rejects.toThrow();
    expect(f.jar().some((c) => c.domain === domain)).toBe(false);
  } finally {
    await f.sessions.close();
  }
});

const liveEndpoint = process.env.AIKO_SESSION_TEST_CDP;
(liveEndpoint ? test : test.skip)(
  "live Chrome SDK adapter physically installs and revokes an HttpOnly session without model tools",
  async () => {
    const cdp = await openPrivateBrowserCdp(liveEndpoint!);
    const targets = await cdp.send("Target.getTargets", {});
    const target = targets.targetInfos.find((t: any) => t.type === "page");
    const adapter = await createOwnedCookieAdapter(cdp, {
      browserContextId: target.browserContextId,
      targetId: target.targetId,
    });
    const metadata: PrivateSessionRecord[] = [];
    const sessions = new PrivateBrowserSessions(
      context,
      async () => adapter,
      (r) => {
        metadata.push(r);
      },
    );
    try {
      await sessions.install(material());
      const actual = await adapter.exportCookies([domain]);
      expect(actual[0]?.value).toBe("PRIVATE_COOKIE_SENTINEL");
      expect(actual[0]?.httpOnly).toBe(true);
      await sessions.clear(material());
      expect(await adapter.exportCookies([domain])).toEqual([]);
      await expect(sessions.install(material())).rejects.toThrow("Stale");
      expect(JSON.stringify(metadata)).not.toContain("PRIVATE_COOKIE_SENTINEL");
    } finally {
      await sessions.close();
      cdp.close();
    }
  },
);

test("existing Codegraff private channel installs SDK sessions before navigation without plaintext upload/event values", async () => {
  const f = await fixture(),
    keys = replayKeys(),
    uploads = new Map<string, string>(),
    commands: string[] = [],
    events: object[] = [];
  const sandbox = new CodegraffSandbox({
    owner: context.owner,
    gateway: new Codegraff("controlled-gateway-key"),
    store: { get: async () => undefined, put: async () => {} },
    emit: async (e) => {
      events.push(e);
    },
    runnerBundle: "fixture",
    bootstrap: "fixture",
  });
  const ensure = spyOn(sandbox, "ensure").mockResolvedValue("owned-vm");
  const upload = spyOn(sandbox, "upload").mockImplementation(
    async (_id, path, text) => {
      uploads.set(path, text);
    },
  );
  const exec = spyOn(sandbox, "exec").mockImplementation(
    async (_id, command) => {
      commands.push(command);
      if (command.endsWith(" health"))
        return JSON.stringify({
          ready: true,
          replayPublicKey: keys.publicKey,
          privateContext: context,
        });
      const id = command.split(" ").at(-1)!;
      if (command.includes(" request-replay ")) {
        const envelope = JSON.parse(
          [...uploads.entries()].find(([path]) =>
            path.endsWith(id + ".json"),
          )![1],
        );
        const { key, value } = unwrapReplay(envelope, keys.privateKey);
        const output =
          value.operation === "session-install"
            ? await f.sessions.install(value.input)
            : await f.sessions
                .clear(value.scope)
                .then(() => ({ cleared: true }));
        return JSON.stringify(sealReplay({ output }, key));
      }
      expect(
        f
          .jar()
          .some(
            (c) =>
              c.domain === domain &&
              c.httpOnly &&
              c.value === "PRIVATE_COOKIE_SENTINEL",
          ),
      ).toBe(true);
      return JSON.stringify({
        status: "completed",
        output: { navigation: "completed" },
        events: [],
        through: 0,
        hasMore: false,
      });
    },
  );
  try {
    const driver = await sandbox.browserFactory()({
      owner: context.owner,
      domains: ["*"],
      emit: async (e) => {
        events.push(e);
      },
    });
    expect(await driver.sessionContext!()).toEqual(context);
    await driver.installSession!(material());
    await driver.execute({ action: "navigate", url: `https://${domain}/` });
    await driver.clearSession!(material());
    expect(f.jar().some((c) => c.domain === domain)).toBe(false);
    expect(JSON.stringify([...uploads.values()])).not.toContain(
      "PRIVATE_COOKIE_SENTINEL",
    );
    expect(JSON.stringify(events)).not.toContain("PRIVATE_COOKIE_SENTINEL");
    expect(commands.join()).not.toContain("PRIVATE_COOKIE_SENTINEL");
    expect(commands.some((c) => /request-replay [a-f0-9-]{36}$/.test(c))).toBe(
      true,
    );
  } finally {
    ensure.mockRestore();
    upload.mockRestore();
    exec.mockRestore();
    await f.sessions.close();
  }
});

test("cancellation after cookie read prevents a late SDK cookie insertion", async () => {
  const aborted = new AbortController();
  let abortOnRead = true;
  const inserts: unknown[] = [];
  const cdp: PrivateCdp = {
    send: async (method, params) => {
      if (method === "Target.getBrowserContexts")
        return { browserContextIds: ["sdk-context"] };
      if (method === "Target.getTargetInfo")
        return { targetInfo: { browserContextId: "sdk-context" } };
      if (method === "Target.attachToTarget")
        return { sessionId: "target-session" };
      if (method === "Storage.getCookies") {
        if (abortOnRead) {
          abortOnRead = false;
          aborted.abort();
        }
        return { cookies: [] };
      }
      if (method === "Storage.setCookies") inserts.push(params.cookies);
      return {};
    },
  };
  const sessions = new PrivateBrowserSessions(
    context,
    (signal) =>
      createOwnedCookieAdapter(
        cdp,
        { browserContextId: "sdk-context", targetId: "target" },
        signal,
      ),
    () => {},
  );
  try {
    await expect(
      sessions.install(material(), aborted.signal),
    ).rejects.toThrow();
    expect(
      inserts.every((value) => Array.isArray(value) && value.length === 0),
    ).toBe(true);
    await expect(sessions.install(material())).rejects.toThrow("Stale");
  } finally {
    await sessions.close();
  }
});

test("metadata persistence failure after insertion clears cookies and blocks every subsequent action", async () => {
  const f = await fixture();
  let saves = 0;
  const sessions = new PrivateBrowserSessions(
    context,
    async () => f.adapter,
    () => {
      if (++saves > 1) throw new Error("disk unavailable");
    },
  );
  try {
    await expect(sessions.install(material())).rejects.toThrow();
    expect(f.jar().some((c) => c.domain === domain)).toBe(false);
    let performed = false;
    await expect(
      sessions.run(`https://${domain}/`, async () => {
        performed = true;
      }),
    ).rejects.toThrow();
    expect(performed).toBe(false);
  } finally {
    await sessions.close();
    await f.sessions.close();
  }
});

const nativeChrome = process.env.AIKO_NATIVE_SESSION_CHROME;
(nativeChrome ? test : test.skip)(
  "actual trusted browser driver installs SDK session on blank context before any navigation",
  async () => {
    const { browserDriverFactory } = await import("../src/browser-driver.ts");
    const { mkdtemp, rm, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const directory = await mkdtemp("/tmp/aiko-native-unlock-");
    const events: object[] = [];
    const driver = await browserDriverFactory(nativeChrome!, {
      persistentDirectory: directory,
    })({
      owner: "alice",
      domains: ["*"],
      emit: async (e) => {
        events.push(e);
      },
    });
    try {
      const bound = await driver.sessionContext!();
      const packet = { ...material(), ...bound };
      const ack = await driver.installSession!(packet);
      expect(ack.revision).toBe(1);
      expect(ack.contextId).toBe(bound.contextId);
      expect(JSON.stringify(events)).not.toContain("PRIVATE_COOKIE_SENTINEL");
      expect(JSON.stringify(events)).not.toContain('"action":"navigate"');
      await driver.clearSession!(packet);
      await expect(driver.installSession!(packet)).rejects.toThrow("Stale");
    } finally {
      await driver.close();
      // The isolated Chrome cookie store is expected to contain cookies while active.
      // Scan metadata files and event records, not that permitted browser store.
      for (const name of ["request-evidence.sqlite", "request-memory.sqlite"]) {
        const bytes = await readFile(join(directory, name));
        expect(bytes.includes(Buffer.from("PRIVATE_COOKIE_SENTINEL"))).toBe(
          false,
        );
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
  60000,
);

test("routine release permits verified same revision; revoke and older revisions stay fenced across release", async () => {
  const f = await fixture();
  const input = material(2);
  try {
    await f.sessions.install(input);
    await expect(
      f.sessions.clear({ ...input, reason: "unknown" as any }),
    ).rejects.toThrow("Invalid private session clear reason");
    await f.sessions.clear({ ...input, reason: "release" });
    expect(f.jar().filter((c) => c.domain === domain)).toHaveLength(0);
    await f.sessions.install(input);
    await expect(f.sessions.install(material(1))).rejects.toThrow("Stale");
    await f.sessions.clear(input);
    await f.sessions.clear({ ...input, reason: "release" });
    await expect(f.sessions.install(input)).rejects.toThrow("Stale");
    expect(JSON.stringify(f.saved)).not.toContain("PRIVATE_COOKIE_SENTINEL");
    const resumed = new PrivateBrowserSessions(
      { ...context, contextId: "new-owned-context" },
      async () => f.adapter,
      () => {},
      [f.saved.at(-1)!],
    );
    try {
      await resumed.install({ ...input, contextId: "new-owned-context" });
      await expect(resumed.install(input)).rejects.toThrow("context mismatch");
      await expect(
        resumed.install({ ...material(1), contextId: "new-owned-context" }),
      ).rejects.toThrow("Stale");
    } finally {
      await resumed.close();
    }
  } finally {
    await f.sessions.close();
  }
});

test("encrypted operation replay cannot reinstall a released session; capacity never evicts old fences", () => {
  const identity = replayKeys();
  const id = crypto.randomUUID();
  const { envelope } = wrapReplay(
    { id, operation: "session-install", input: material() },
    identity.publicKey,
  );
  const fence = new PrivateOperationFence(2);
  const first = unwrapReplay(envelope, identity.privateKey);
  fence.consume(first.value.id);
  const replay = unwrapReplay(envelope, identity.privateKey);
  expect(() => fence.consume(replay.value.id)).toThrow(
    "Private operation rejected",
  );
  fence.consume(crypto.randomUUID());
  expect(() => fence.consume(crypto.randomUUID())).toThrow(
    "Private operation rejected",
  );
  expect(() => fence.consume(id)).toThrow("Private operation rejected");
});
