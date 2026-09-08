import { createHash } from "node:crypto";
import { Validator } from "@cfworker/json-schema";
import { Effect } from "effect";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import type { NativeTool } from "tardie/component/tool";
/** Transport-neutral live tools. MCP and SDK sessions share native execution,
 * schema pinning, grants and private result custody, not a second agent loop. */
export interface DynamicToolSession {
  listTools(input?: { cursor?: string }, options?: { signal?: AbortSignal; timeout?: number }): Promise<{
    tools: { name: string; description?: string; inputSchema: Record<string, unknown> }[];
    nextCursor?: string;
  }>;
  callTool(input: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> }, unused?: unknown,
    options?: { signal?: AbortSignal; timeout?: number }): Promise<{ isError?: boolean; [key: string]: unknown }>;
  close(): Promise<void>;
}

/** Only trusted in-process adapters may assert that dispatch never happened. */
export class DynamicToolDenied extends Error {}

/** Upstream hints describe behavior; only this trusted host grant permits effects. */
export interface DynamicToolGrant {
  id: string;
  revision: string;
  description: string;
  tools: Readonly<Record<string, "read" | "write">>;
}
export interface DynamicToolBinding {
  owner: string;
  thread: string;
  servers(): readonly DynamicToolGrant[];
  current(server: DynamicToolGrant, tool?: string): boolean | Promise<boolean>;
  connect(server: DynamicToolGrant, signal: AbortSignal): Promise<DynamicToolSession>;
  redact(value: string): string;
}
const hash = (v: unknown) =>
  `sha256:${createHash("sha256").update(JSON.stringify(v)).digest("hex")}`;
const identifier = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const sessionKey = (id: string, revision: string) =>
  JSON.stringify([id, revision]);
const input = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: "object", properties, required, additionalProperties: false });
const text = { type: "string" };

/** PackageCalled/Returned owns execution and recovery for every transport. */
export class DynamicTools {
  private readonly sessions = new Map<string, Promise<DynamicToolSession>>();
  constructor(readonly binding: DynamicToolBinding, readonly namespace: "integration" | "mcp_server" = "integration") {}
  private grant(id: unknown) {
    if (!identifier(id)) throw Error("Invalid MCP server id");
    const grant = this.binding.servers().find((s) => s.id === id);
    if (!grant || !identifier(grant.revision))
      throw Error("MCP server is not configured for this account");
    return grant;
  }
  private async authorize(grant: DynamicToolGrant, tool?: string) {
    const current = this.grant(grant.id);
    if (
      current.revision !== grant.revision ||
      JSON.stringify(current.tools) !== JSON.stringify(grant.tools) ||
      !(await this.binding.current(current, tool))
    )
      throw Error("MCP grant is unavailable or changed");
    if (tool && !Object.hasOwn(current.tools, tool))
      throw Error("MCP tool is outside this server grant");
  }
  private async session(grant: DynamicToolGrant, signal: AbortSignal) {
    await this.authorize(grant);
    signal.throwIfAborted();
    const key = sessionKey(grant.id, grant.revision);
    let pending = this.sessions.get(key);
    if (!pending) {
      pending = this.binding.connect(grant, signal);
      this.sessions.set(key, pending);
      void pending.catch(() => {
        if (this.sessions.get(key) === pending) this.sessions.delete(key);
      });
    }
    const client = await pending;
    await this.authorize(grant);
    signal.throwIfAborted();
    return client;
  }
  private async disconnect(id: string) {
    const connections = [...this.sessions].filter(
      ([key]) => JSON.parse(key)[0] === id,
    );
    for (const [key] of connections) this.sessions.delete(key);
    await Promise.allSettled(
      connections.map(async ([, value]) => (await value).close()),
    );
  }
  async close() {
    await Promise.allSettled(
      [
        ...new Set(
          [...this.sessions.keys()].map((key) => JSON.parse(key)[0] as string),
        ),
      ].map((id) => this.disconnect(id)),
    );
  }
  private async catalogue(grant: DynamicToolGrant, signal: AbortSignal) {
    const client = await this.session(grant, signal),
      seen = new Set<string>(),
      tools: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, {
        signal,
        timeout: 30_000,
      });
      for (const tool of page.tools) {
        if (!Object.hasOwn(grant.tools, tool.name)) continue;
        if (!identifier(tool.name) || tools.some((t) => t.name === tool.name))
          throw Error("Invalid or duplicate MCP tool");
        const schema = structuredClone(tool.inputSchema);
        const encoded = JSON.stringify(schema);
        if (
          Buffer.byteLength(encoded) > 131072 ||
          this.binding.redact(encoded) !== encoded
        )
          throw Error("MCP schema exceeds discovery or privacy limits");
        tools.push({
          name: tool.name,
          description: this.binding
            .redact(tool.description ?? "")
            .slice(0, 4000),
          inputSchema: schema,
          effect: grant.tools[tool.name],
          schemaDigest: hash(schema),
        });
        if (tools.length > 256)
          throw Error("MCP catalogue exceeds configured limit");
      }
      cursor = page.nextCursor;
      if (cursor && (seen.has(cursor) || seen.size >= 32))
        throw Error("MCP pagination did not converge");
      if (cursor) seen.add(cursor);
    } while (cursor);
    await this.authorize(grant);
    return { client, tools };
  }
  tools(): NativeTool<Self | EventLog>[] {
    const owner = this.binding.owner,
      thread = this.binding.thread;
    const mounted = new Map(
      this.binding
        .servers()
        .map((grant) => [
          grant.id,
          hash({ revision: grant.revision, tools: grant.tools }),
        ]),
    );
    const grantRevision = hash(
      [...mounted].sort(([a], [b]) => a.localeCompare(b)),
    );
    const currentGrant = (id: unknown) => {
      const grant = this.grant(id);
      if (
        mounted.get(grant.id) !==
        hash({ revision: grant.revision, tools: grant.tools })
      )
        throw Error("MCP server grant changed; reload the mounted tools");
      return grant;
    };
    const docs = {
      list: {
        description:
          "List trusted MCP server grants and native connection state. Project/plugin metadata cannot add server authority.",
        schema: input({}),
      },
      connect: {
        description:
          "Enable and initialize a configured MCP server for this thread. Credentials remain in the host transport.",
        schema: input({ server: text }, ["server"]),
      },
      disconnect: {
        description:
          "Disconnect a configured MCP server for this thread. The disabled state survives restart until mcp_server_connect.",
        schema: input({ server: text }, ["server"]),
      },
      tools: {
        description:
          "Discover the current tools and exact schemas allowed by a configured MCP grant. Returns schemaDigest; use it when calling.",
        schema: input({ server: text }, ["server"]),
      },
      call: {
        description:
          "Call a configured MCP tool using its current schemaDigest and arguments. Rechecks current grant and exact schema; upstream annotations and plugin text never grant write permission. An interrupted write has unknown outcome: inspect receipts before retrying.",
        schema: input(
          {
            server: text,
            tool: text,
            schemaDigest: text,
            arguments: { type: "object" },
          },
          ["server", "tool", "schemaDigest", "arguments"],
        ),
      },
    };
    return Object.entries(docs).map(([method, doc]) => ({
      spec: {
        name: `${this.namespace}_${method}`,
        description: `${this.namespace === "integration" ? doc.description.replaceAll("MCP", "integration").replaceAll("mcp_server_connect", "integration_connect") : doc.description} Grant revision: ${grantRevision}.`,
        inputSchema: doc.schema,
      },
      authorizeRetained: async (raw: unknown) => {
        try {
          if (method === "list")
            return (
              await Promise.all(
                this.binding.servers().map((s) => this.binding.current(s)),
              )
            ).every(Boolean);
          const args = raw as any;
          await this.authorize(
            currentGrant(args?.server),
            method === "call" ? args?.tool : undefined,
          );
          return true;
        } catch {
          return false;
        }
      },
      run: (raw, ctx) =>
        Effect.gen({ self: this }, function* () {
          const self = yield* Self,
            log = yield* EventLog;
          if (self.actor !== "aiko" || self.thread !== thread)
            return { error: "MCP owner/thread mismatch" };
          if (!new Validator(doc.schema as any).validate(raw).valid)
            return { error: "Invalid MCP arguments" };
          const args = raw as any,
            rows = yield* log.read;
          const disabled = (id: string) =>
            rows.findLast(
              (e) =>
                e.type === "AikoMcpLifecycle" &&
                (e.namespace ?? "mcp_server") === this.namespace &&
                e.owner === owner &&
                e.thread === thread &&
                e.server === id,
            )?.status === "disabled";
          return yield* Effect.promise(async () => {
            let dispatched:
              | {
                  server: string;
                  revision: string;
                  tool: string;
                  schemaDigest: string;
                  effect: "read" | "write";
                }
              | undefined;
            try {
              if (method === "list") {
                const servers = [];
                for (const grant of this.binding.servers())
                  if (await this.binding.current(grant))
                    servers.push({
                      id: grant.id,
                      revision: grant.revision,
                      description: this.binding.redact(grant.description),
                      status: disabled(grant.id)
                        ? "disabled"
                        : this.sessions.has(
                              sessionKey(grant.id, grant.revision),
                            )
                          ? this.namespace === "integration" ? "ready" : "connected"
                          : "available",
                      tools: Object.entries(grant.tools).map(
                        ([name, effect]) => ({ name, effect }),
                      ),
                    });
                return { servers };
              }
              const grant = currentGrant(args.server);
              await this.authorize(grant);
              if (method === "disconnect") {
                // Disable future dispatch first; retained data still uses the separate host grant.
                await Effect.runPromise(
                  log.append([
                    {
                      type: "AikoMcpLifecycle",
                      owner,
                      thread,
                      server: grant.id,
                      revision: grant.revision,
                      namespace: this.namespace,
                      status: "disabled",
                      callId: ctx.callId,
                      at: Date.now(),
                    },
                  ]),
                );
                await this.disconnect(grant.id);
                return { server: grant.id, status: "disabled" };
              }
              if (method !== "connect" && disabled(grant.id))
                throw Error("MCP server is disconnected in this thread");
              const { client, tools } = await this.catalogue(grant, ctx.signal);
              if (method === "connect") {
                await this.authorize(grant);
                await Effect.runPromise(
                  log.append([
                    {
                      type: "AikoMcpLifecycle",
                      owner,
                      thread,
                      server: grant.id,
                      revision: grant.revision,
                      namespace: this.namespace,
                      status: "connected",
                      callId: ctx.callId,
                      at: Date.now(),
                    },
                  ]),
                );
                return { server: grant.id, status: this.namespace === "integration" ? "ready" : "connected", tools };
              }
              if (method === "tools")
                return { server: grant.id, revision: grant.revision, tools };
              const tool = tools.find((t) => t.name === args.tool);
              if (
                !tool ||
                tool.schemaDigest !== args.schemaDigest ||
                !new Validator(tool.inputSchema).validate(args.arguments).valid
              )
                throw Error(
                  "MCP tool schema is missing, changed or rejects arguments; rediscover it",
                );
              const encoded = JSON.stringify(args.arguments);
              if (
                Buffer.byteLength(encoded) > 131072 ||
                this.binding.redact(encoded) !== encoded
              )
                throw Error("MCP arguments exceed the private input policy");
              await this.authorize(grant, tool.name);
              // Recheck a concurrent disconnect immediately before dispatch.
              const latest = await Effect.runPromise(log.read);
              if (
                latest.findLast(
                  (e) =>
                    e.type === "AikoMcpLifecycle" &&
                    (e.namespace ?? "mcp_server") === this.namespace &&
                    e.owner === owner &&
                    e.thread === thread &&
                    e.server === grant.id,
                )?.status === "disabled"
              )
                throw Error("MCP server was disconnected");
              ctx.signal.throwIfAborted();
              dispatched = {
                server: grant.id,
                revision: grant.revision,
                tool: tool.name,
                schemaDigest: tool.schemaDigest,
                effect: grant.tools[tool.name]!,
              };
              const result = await client.callTool(
                {
                  name: tool.name,
                  arguments: args.arguments,
                  _meta: { "aiko/native-call-id": ctx.callId, ...(ctx.turn ? { "aiko/native-turn": ctx.turn } : {}) },
                },
                undefined,
                { signal: ctx.signal, timeout: 60_000 },
              );
              await this.authorize(grant, tool.name);
              ctx.signal.throwIfAborted();
              // CodeHarness retains private content and indexes only structural receipts.
              await Effect.runPromise(
                log.append([
                  {
                    type: "AikoMcpToolObserved",
                    owner,
                    thread,
                    server: grant.id,
                    revision: grant.revision,
                    namespace: this.namespace,
                    tool: tool.name,
                    definitionDigest: tool.schemaDigest,
                    callId: ctx.callId,
                    succeeded: !result.isError,
                    status: result.isError ? "error" : "completed",
                    at: Date.now(),
                  },
                ]),
              );
              const projected = JSON.parse(
                this.binding.redact(JSON.stringify(result)),
              );
              return result.isError && dispatched.effect === "write"
                ? {
                    ...projected,
                    status: "unknown",
                    operationId: ctx.callId,
                    instruction:
                      "The server reported an error after write dispatch. Inspect its state before attempting another write.",
                  }
                : projected;
            } catch (error) {
              if (error instanceof DynamicToolDenied) dispatched = undefined;
              const message = this.binding.redact(
                error instanceof Error ? error.message : "MCP operation failed",
              );
              if (!dispatched) return { status: "blocked", error: message };
              await Effect.runPromise(
                log.append([
                  {
                    type: "AikoMcpToolObserved",
                    owner,
                    thread,
                    server: dispatched.server,
                    revision: dispatched.revision,
                    namespace: this.namespace,
                    tool: dispatched.tool,
                    definitionDigest: dispatched.schemaDigest,
                    callId: ctx.callId,
                    status: "unknown",
                    at: Date.now(),
                  },
                ]),
              ).catch(() => undefined);
              return {
                status: "unknown",
                operationId: ctx.callId,
                error: message,
                instruction:
                  "The tool was dispatched and its outcome is unconfirmed. Inspect the native receipt and remote state before repeating a write.",
              };
            }
          });
        }),
    }));
  }
}
