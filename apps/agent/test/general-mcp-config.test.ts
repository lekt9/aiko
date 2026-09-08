import { expect, test } from "bun:test";
import {
  configuredMcpBinding,
  parseMcpServers,
} from "../src/general-mcp-config.ts";
import { GeneralMcp } from "../src/general-mcp.ts";
import { Effect } from "effect";
import { Self } from "tardie/core/runtime";
import { EventLog } from "tardie/core/log";
import type { Event } from "tardie/core/event";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

const server = {
  id: "inventory",
  revision: "v1",
  description: "Project inventory",
  url: "https://inventory.example.test/mcp",
  tools: { list_projects: "read" as const },
  headerRefs: { Authorization: "INVENTORY_MCP_AUTHORIZATION" },
};

test("stock MCP grants revoke immediately while existing bindings retain no replacement authority", async () => {
  let config = parseMcpServers(JSON.stringify({ "123": [server] }));
  const binding = configuredMcpBinding({
    owner: "123",
    thread: "user-123",
    servers: () => config,
    env: { INVENTORY_MCP_AUTHORIZATION: "Bearer fixture-private-key" },
    current: () => true,
    redact: (s) => s,
  })!;
  const tool = new GeneralMcp(binding)
    .tools()
    .find((t) => t.spec.name === "mcp_server_call")!;
  const args = {
    server: "inventory",
    tool: "list_projects",
    schemaDigest: "fixture",
    arguments: {},
  };
  expect(await binding.current(server)).toBe(true);
  expect(await tool.authorizeRetained!(args)).toBe(true);
  config = parseMcpServers(
    JSON.stringify({ "123": [{ ...server, revision: "v2" }] }),
  );
  expect(await binding.current(server)).toBe(false);
  expect(await tool.authorizeRetained!(args)).toBe(false);
  config = {};
  expect(binding.servers()).toEqual([]);
  expect(await binding.current(server)).toBe(false);
});

test("local config resolves MCP grants and only named credentials from the existing private secret file", async () => {
  const dir = await mkdtemp("/tmp/aiko-mcp-private-config-");
  try {
    const file = join(dir, "aiko.env");
    await writeFile(
      file,
      `AIKO_MCP_SERVERS=${JSON.stringify({ "123": [server] })}\nINVENTORY_MCP_AUTHORIZATION=Bearer private-file-key\nUNRELATED_PRIVATE_VALUE=never-import\n`,
      { mode: 0o600 },
    );
    const env = {
      AIKO_SECRET_FILE: file,
      AIKO_STATE_DIR: dir,
      AIKO_OPERATOR_TOKEN: "fixture-operator-12345678901234567890",
    };
    const config = await loadConfig(env, { readonly: true });
    expect(config.mcpServers?.["123"]).toEqual([server]);
    expect(config.mcpSecrets).toEqual({
      INVENTORY_MCP_AUTHORIZATION: "Bearer private-file-key",
    });
    const override = await loadConfig(
      { ...env, INVENTORY_MCP_AUTHORIZATION: "Bearer environment-wins" },
      { readonly: true },
    );
    expect(override.mcpSecrets?.INVENTORY_MCP_AUTHORIZATION).toBe(
      "Bearer environment-wins",
    );
    expect(JSON.stringify(override.mcpServers)).not.toContain(
      "private-file-key",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("stock MCP configuration accepts secret references and rejects unsafe or ambiguous metadata", () => {
  expect(parseMcpServers(undefined)).toEqual({});
  expect(parseMcpServers(JSON.stringify({ "123": [server] }))).toEqual({
    "123": [server],
  });
  for (const invalid of [
    { ...server, url: "http://inventory.example.test/mcp" },
    { ...server, url: server.url + "?key=private" },
    { ...server, headers: { Authorization: "literal" } },
    { ...server, headerRefs: { Host: "INVENTORY_MCP_AUTHORIZATION" } },
    { ...server, tools: { list_projects: ["read"] } },
  ])
    expect(() =>
      parseMcpServers(JSON.stringify({ "123": [invalid] })),
    ).toThrow();
  expect(() =>
    parseMcpServers(JSON.stringify({ "123": [server, server] })),
  ).toThrow();
});

test("stock HTTP binding uses actual SDK discovery/calls, owner grants and private named credentials", async () => {
  let active = true;
  const env: Record<string, unknown> = {
      INVENTORY_MCP_AUTHORIZATION: "Bearer inventory-private-credential",
    },
    wires: any[] = [],
    rows: Event[] = [];
  const options = {
    owner: "123",
    thread: "user-123",
    servers: parseMcpServers(JSON.stringify({ "123": [server] })),
    env,
    current: () => active,
    redact: (s: string) => s,
    fetch: (async (url: any, init: any) => {
      expect(String(url)).toBe(server.url);
      expect(new Headers(init.headers).get("Authorization")).toBe(
        String(env.INVENTORY_MCP_AUTHORIZATION),
      );
      if (init.method === "GET") return new Response(null, { status: 405 });
      const request = JSON.parse(init.body);
      wires.push(request);
      const reply = (result: unknown) =>
        Response.json({ jsonrpc: "2.0", id: request.id, result });
      if (request.method === "initialize")
        return reply({
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        });
      if (!request.id) return new Response(null, { status: 202 });
      if (request.method === "tools/list")
        return reply({
          tools: [
            {
              name: "list_projects",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
            },
          ],
        });
      return reply({
        content: [{ type: "text", text: "inventory-private-credential" }],
        structuredContent: { projects: ["held-out-project"] },
      });
    }) as typeof fetch,
  };
  expect(configuredMcpBinding({ ...options, owner: "456" })).toBeUndefined();
  const binding = configuredMcpBinding(options)!,
    mcp = new GeneralMcp(binding);
  const invoke = (name: string, args: unknown) =>
    Effect.runPromise(
      mcp
        .tools()
        .find((t) => t.spec.name === name)!
        .run(args, {
          callId: `test-${wires.length}`,
          turn: "read",
          signal: AbortSignal.timeout(5000),
        })
        .pipe(
          Effect.provideService(Self, {
            actor: "aiko",
            instance: "test",
            thread: "user-123",
          }),
          Effect.provideService(EventLog, {
            read: Effect.sync(() => rows),
            append: (events: Event[]) =>
              Effect.sync(() => rows.push(...events)),
          } as any),
        ),
    ) as Promise<any>;
  try {
    const catalogue = await invoke("mcp_server_tools", { server: "inventory" });
    env.INVENTORY_MCP_AUTHORIZATION = "Bearer inventory-rotated-credential";
    const result = await invoke("mcp_server_call", {
      server: "inventory",
      tool: "list_projects",
      schemaDigest: catalogue.tools[0].schemaDigest,
      arguments: {},
    });
    expect(result.structuredContent).toEqual({
      projects: ["held-out-project"],
    });
    expect(JSON.stringify(result)).not.toContain(
      "inventory-private-credential",
    );
    expect(JSON.stringify(rows)).not.toContain("inventory-private-credential");
    active = false;
    expect(
      (await invoke("mcp_server_tools", { server: "inventory" })).status,
    ).toBe("blocked");
    active = true;
    delete env.INVENTORY_MCP_AUTHORIZATION;
    expect(await binding.current(server)).toBe(false);
    expect(wires.filter((r) => r.method === "tools/call")).toHaveLength(1);
  } finally {
    await mcp.close();
  }
});
