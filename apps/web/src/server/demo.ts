import { z } from "zod";
import type { Activity, Connection, Workspace } from "@unlock/sdk";
import type { SessionMaterial } from "@unlock/sdk/runtime";
import { MAX_IMPORT_BODY_BYTES, MAX_VAULT_LOGINS } from "../lib/import-policy";
import { CsvImportCapacityError, importCsvLogins } from "./csv-import";
import { readBoundedJson } from "./read-json";

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
export const fixtures = {
  github: {
    name: "GitHub",
    domain: "github.example.test",
    identity: "developer@studio.example",
  },
  linear: {
    name: "Linear",
    domain: "linear.example.test",
    identity: "product@studio.example",
  },
  notion: {
    name: "Notion",
    domain: "notion.example.test",
    identity: "team@studio.example",
  },
  figma: {
    name: "Figma",
    domain: "figma.example.test",
    identity: "design@studio.example",
  },
  vercel: {
    name: "Vercel",
    domain: "vercel.example.test",
    identity: "deploy@studio.example",
  },
} as const;
export function seedWorkspace(): Workspace {
  const connection = (
    id: string,
    key: keyof typeof fixtures,
    extra: Partial<Connection>,
  ): Connection => ({
    id,
    ...fixtures[key],
    kind: "both",
    sourceId: "onepassword",
    sourceLabel: "1Password",
    sourceMode: "reference",
    status: "healthy",
    revision: 12,
    verifiedAt: minutes(-8),
    expiresAt: minutes(360),
    maintenance: true,
    recipe: "Supported refresh → password login",
    createdAt: minutes(-4320),
    ...extra,
  });
  return {
    demo: true,
    settings: { name: "Studio workspace", digest: true },
    connections: [
      connection("github", "github", {
        revision: 24,
        verifiedAt: minutes(-2),
        favorite: true,
      }),
      connection("linear", "linear", {
        revision: 8,
        sourceId: "google",
        sourceLabel: "Google SSO",
        sourceMode: "sso",
        kind: "session",
        recipe: "Private IdP context → destination login",
        verifiedAt: minutes(-4),
      }),
      connection("notion", "notion", {
        status: "challenge",
        revision: 6,
        expiresAt: minutes(-30),
        recipe: "Password login · MFA required",
      }),
      connection("figma", "figma", {
        sourceId: "import",
        sourceLabel: "One-time import",
        sourceMode: "snapshot",
        kind: "password",
        revision: 3,
        verifiedAt: minutes(-14),
      }),
    ],
    profiles: [
      {
        id: "builder",
        name: "Build agent",
        description: "Code, issues, and releases",
        enabled: true,
        connectionIds: ["github", "linear"],
      },
      {
        id: "research",
        name: "Research agent",
        description: "Read, collect, and synthesize",
        enabled: true,
        connectionIds: ["notion"],
      },
      {
        id: "design",
        name: "Design agent",
        description: "Design operations",
        enabled: false,
        connectionIds: ["figma"],
      },
    ],
    sources: [
      {
        id: "native",
        name: "Unlock vault",
        kind: "native",
        connected: true,
        description:
          "Synthetic native records. Production encryption is not connected.",
      },
      {
        id: "onepassword",
        name: "1Password",
        kind: "reference",
        connected: true,
        description: "Demo item references only. No live vault authorization.",
      },
      {
        id: "import",
        name: "One-time import",
        kind: "snapshot",
        connected: true,
        description:
          "Independent snapshots; changes in the original export do not sync.",
      },
      {
        id: "google",
        name: "Google SSO context",
        kind: "sso",
        connected: true,
        description:
          "Private parent context. Task browsers receive only destination sessions.",
      },
      {
        id: "nordpass",
        name: "NordPass",
        kind: "reference",
        connected: false,
        description:
          "Not implemented. Provider API suitability has not been verified.",
      },
    ],
    clients: [],
    activity: [
      {
        id: "seed1",
        at: minutes(-2),
        action: "Session renewed",
        subject: "GitHub",
        detail: "Revision 24 published · supported refresh",
        tone: "success",
      },
      {
        id: "seed2",
        at: minutes(-4),
        action: "Session verified",
        subject: "Linear",
        detail: "Destination session checked · parent context kept private",
        tone: "success",
      },
      {
        id: "seed3",
        at: minutes(-8),
        action: "Challenge required",
        subject: "Notion",
        detail: "Maintenance waiting for reconnect · MFA challenge",
        tone: "warning",
      },
      {
        id: "seed4",
        at: minutes(-14),
        action: "Import completed",
        subject: "Figma",
        detail: "One-time synthetic snapshot · no ongoing source sync",
        tone: "neutral",
      },
    ],
  };
}
class ApiError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
const label = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[\p{L}\p{N} ._()\-]+$/u);
const ids = z.array(z.string().min(1).max(100)).max(MAX_VAULT_LOGINS);
const connectSchema = z
  .object({
    fixture: z.enum(["github", "linear", "notion", "figma", "vercel"]),
    mode: z.enum(["native", "session", "import", "reference", "sso"]),
    profileIds: ids,
  })
  .strict();
const description = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[^\p{C}]+$/u);
const avatar = z.enum(["violet", "blue", "mint", "peach"]);
const profileSchema = z
  .object({
    name: label,
    description,
    avatar: avatar.optional(),
    connectionIds: ids.optional(),
  })
  .strict();
const loginUpdateSchema = z
  .object({
    name: description.optional(),
    identity: z
      .string()
      .email()
      .max(120)
      .refine((value) => /\.(example|test)$/.test(value))
      .optional(),
    favorite: z.boolean().optional(),
  })
  .strict();
const updateProfile = z
  .object({
    name: label.optional(),
    avatar: avatar.optional(),
    description: description.optional(),
    enabled: z.boolean().optional(),
    connectionIds: ids.optional(),
  })
  .strict();
const bindingSchema = z
  .object({ connectionId: z.string(), profileId: z.string() })
  .strict();
const cookieSchema = z
  .object({
    name: z.literal("unlock_demo"),
    value: z.literal("synthetic-not-a-real-session"),
    domain: z.string(),
    path: z.literal("/"),
    expires: z.number(),
    httpOnly: z.literal(true),
    secure: z.literal(true),
    sameSite: z.literal("Lax"),
  })
  .strict();
const syncSchema = z
  .object({
    connectionId: z.string(),
    profileId: z.string(),
    revision: z.number().int().positive(),
    allowedDomains: z.array(z.string()).length(1),
    cookies: z.array(cookieSchema).length(1),
  })
  .strict();

/** Process-local, deliberately unauthenticated fixture service. Bind to loopback only. */
export function createDemoService() {
  let state = seedWorkspace();
  const record = (
    action: string,
    subject: string,
    detail: string,
    tone: Activity["tone"] = "neutral",
  ) => {
    state.activity.unshift({
      id: crypto.randomUUID(),
      at: minutes(0),
      action,
      subject,
      detail,
      tone,
    });
    state.activity = state.activity.slice(0, 250);
  };
  const getConnection = (id: string) => {
    const c = state.connections.find((c) => c.id === id);
    if (!c) throw new ApiError("NOT_FOUND", 404);
    return c;
  };
  const boundConnection = (connectionId: string, profileId: string) => {
    const p = state.profiles.find((p) => p.id === profileId);
    if (!p?.enabled || !p.connectionIds.includes(connectionId))
      throw new ApiError("FORBIDDEN", 403);
    const c = getConnection(connectionId);
    if (c.status === "revoked") throw new ApiError("REVOKED", 403);
    if (
      !["healthy", "paused"].includes(c.status) ||
      Date.parse(c.expiresAt) <= Date.now()
    )
      throw new ApiError(
        c.status === "source-unavailable" ? "SOURCE_UNAVAILABLE" : "CHALLENGE",
        409,
      );
    return c;
  };
  return async function handle(request: Request): Promise<Response> {
    const json = (data: unknown, status = 200) =>
      Response.json(data, {
        status,
        headers: {
          "Cache-Control": "no-store",
          "X-Unlock-Mode": "synthetic-demo",
        },
      });
    try {
      const url = new URL(request.url);
      const host = url.hostname;
      if (!["127.0.0.1", "localhost", "[::1]"].includes(host))
        throw new ApiError("FORBIDDEN", 403);
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) throw new ApiError("FORBIDDEN", 403);
      const path = url.pathname
        .replace(/^\/api\/?/, "")
        .split("/")
        .map(decodeURIComponent);
      const method = request.method;
      let body: unknown = undefined;
      if (method !== "GET") {
        if (
          !request.headers.get("content-type")?.startsWith("application/json")
        )
          throw new ApiError("INVALID_INPUT");
        try {
          const isImport =
            method === "POST" &&
            path.length === 2 &&
            path[0] === "connections" &&
            path[1] === "import";
          const isProfileWrite =
            path[0] === "profiles" &&
            ((path.length === 1 && method === "POST") ||
              (path.length === 2 && method === "PATCH"));
          body = await readBoundedJson(
            request,
            isImport
              ? MAX_IMPORT_BODY_BYTES
              : isProfileWrite
                ? 131_072
                : 16_384,
          );
        } catch {
          throw new ApiError("INVALID_INPUT");
        }
      }
      if (method === "GET" && path.length === 1) {
        if (path[0] === "workspace") return json(state);
        if (path[0] === "connections") return json(state.connections);
        if (path[0] === "profiles") return json(state.profiles);
        if (path[0] === "sources") return json(state.sources);
        if (path[0] === "sessions")
          return json(
            state.connections.map((c) => ({
              connectionId: c.id,
              status: c.status,
              revision: c.revision,
              verifiedAt: c.verifiedAt,
              expiresAt: c.expiresAt,
              maintenance: c.maintenance,
            })),
          );
      }
      if (path[0] === "reset" && path.length === 1 && method === "POST") {
        z.object({}).strict().parse(body);
        state = seedWorkspace();
        return json(state);
      }
      if (
        path[0] === "connections" &&
        path[1] === "import" &&
        path.length === 2 &&
        method === "POST"
      ) {
        const result = importCsvLogins(state, body);
        record(
          "CSV import completed",
          "CSV import",
          `${result.imported} imported · ${result.duplicates} duplicates · ${result.invalid} invalid · passwords omitted`,
          "success",
        );
        return json(result, 201);
      }
      if (path[0] === "connections" && path.length === 1 && method === "POST") {
        const input = connectSchema.parse(body);
        if (state.connections.length >= MAX_VAULT_LOGINS)
          throw new ApiError("INVALID_INPUT");
        const f = fixtures[input.fixture];
        if (
          state.connections.some(
            (c) => c.domain === f.domain && c.status !== "revoked",
          )
        )
          throw new ApiError("DUPLICATE", 409);
        if (
          input.profileIds.some(
            (id) => !state.profiles.some((p) => p.id === id),
          )
        )
          throw new ApiError("INVALID_INPUT");
        const sourceId = (
          {
            native: "native",
            session: "native",
            import: "import",
            reference: "onepassword",
            sso: "google",
          } as const
        )[input.mode];
        const source = state.sources.find((s) => s.id === sourceId)!;
        if (!source.connected) throw new ApiError("SOURCE_UNAVAILABLE", 409);
        const c: Connection = {
          id: crypto.randomUUID(),
          ...f,
          sourceId,
          sourceLabel: source.name,
          sourceMode: source.kind,
          kind:
            input.mode === "session" || input.mode === "sso"
              ? "session"
              : input.mode === "native" || input.mode === "reference"
                ? "both"
                : "password",
          status: "healthy",
          revision: 1,
          maintenance: true,
          expiresAt: minutes(360),
          verifiedAt: minutes(0),
          createdAt: minutes(0),
          recipe:
            input.mode === "sso"
              ? "Private IdP context → destination login"
              : "Supported refresh → configured login",
        };
        state.connections.push(c);
        for (const p of state.profiles)
          if (input.profileIds.includes(p.id)) p.connectionIds.push(c.id);
        record(
          input.mode === "import" ? "Import completed" : "Account connected",
          c.name,
          `Synthetic ${input.mode} fixture · ${input.profileIds.length} standing assignments`,
          "success",
        );
        return json(c, 201);
      }
      if (
        path[0] === "connections" &&
        path.length === 2 &&
        method === "PATCH"
      ) {
        const input = loginUpdateSchema.parse(body);
        const c = getConnection(path[1]);
        if (c.status === "revoked") throw new ApiError("REVOKED", 409);
        if (input.identity && ["reference", "sso"].includes(c.sourceMode))
          throw new ApiError("INVALID_INPUT");
        if (input.identity && input.identity !== c.identity)
          c.status = "challenge";
        Object.assign(c, input);
        record("Login updated", c.name, "Saved login details updated");
        return json(c);
      }
      if (
        path[0] === "connections" &&
        path.length === 3 &&
        path[2] === "access" &&
        method === "PUT"
      ) {
        const { profileIds } = z
          .object({ profileIds: ids })
          .strict()
          .parse(body);
        const c = getConnection(path[1]);
        if (c.status === "revoked") throw new ApiError("REVOKED", 409);
        if (profileIds.some((id) => !state.profiles.some((p) => p.id === id)))
          throw new ApiError("INVALID_INPUT");
        for (const p of state.profiles) {
          p.connectionIds = p.connectionIds.filter((id) => id !== c.id);
          if (profileIds.includes(p.id)) p.connectionIds.push(c.id);
        }
        record("Login access updated", c.name, "Agent profile access saved");
        return json(state.profiles);
      }
      if (
        path[0] === "connections" &&
        path.length === 3 &&
        path[2] === "action" &&
        method === "POST"
      ) {
        const { action } = z
          .object({
            action: z.enum([
              "refresh",
              "pause",
              "resume",
              "challenge",
              "recover",
              "revoke",
            ]),
          })
          .strict()
          .parse(body);
        const c = getConnection(path[1]);
        if (c.status === "revoked") throw new ApiError("REVOKED", 409);
        const source = state.sources.find((s) => s.id === c.sourceId)!;
        if (action === "revoke") {
          c.status = "revoked";
          c.maintenance = false;
          for (const p of state.profiles)
            p.connectionIds = p.connectionIds.filter((id) => id !== c.id);
          record(
            "Access revoked",
            c.name,
            "Future retrieval and sync blocked. Delivered cookies may remain valid.",
            "warning",
          );
        } else if (action === "pause") {
          c.maintenance = false;
          c.status = !source.connected
            ? "source-unavailable"
            : c.status === "challenge"
              ? "challenge"
              : "paused";
          record(
            "Maintenance paused",
            c.name,
            "No new renewal attempts scheduled",
          );
        } else if (action === "challenge") {
          c.status = "challenge";
          record(
            "Challenge required",
            c.name,
            "Simulated MFA · use demo recovery",
            "warning",
          );
        } else {
          if (!source.connected) throw new ApiError("SOURCE_UNAVAILABLE", 409);
          if (c.status === "challenge" && action !== "recover")
            throw new ApiError("CHALLENGE", 409);
          c.status = "healthy";
          c.maintenance = true;
          c.revision++;
          c.verifiedAt = minutes(0);
          c.expiresAt = minutes(360);
          record(
            action === "recover" ? "Session recovered" : "Session renewed",
            c.name,
            `Revision ${c.revision} published · synthetic ${action}`,
            "success",
          );
        }
        return json(c);
      }
      if (path[0] === "profiles" && path.length === 1 && method === "POST") {
        const input = profileSchema.parse(body);
        if (state.profiles.length >= 50) throw new ApiError("INVALID_INPUT");
        if (
          state.profiles.some(
            (p) => p.name.toLowerCase() === input.name.toLowerCase(),
          )
        )
          throw new ApiError("DUPLICATE", 409);
        if (
          input.connectionIds?.some(
            (id) =>
              !state.connections.some(
                (c) => c.id === id && c.status !== "revoked",
              ),
          )
        )
          throw new ApiError("INVALID_INPUT");
        const p = {
          ...input,
          id: crypto.randomUUID(),
          enabled: true,
          connectionIds: [...new Set(input.connectionIds ?? [])],
        };
        state.profiles.push(p);
        record(
          "Profile created",
          p.name,
          `${p.connectionIds.length} saved logins assigned`,
        );
        return json(p, 201);
      }
      if (path[0] === "profiles" && path.length === 2 && method === "PATCH") {
        const input = updateProfile.parse(body);
        const p = state.profiles.find((p) => p.id === path[1]);
        if (!p) throw new ApiError("NOT_FOUND", 404);
        if (
          input.name &&
          state.profiles.some(
            (other) =>
              other.id !== p.id &&
              other.name.toLowerCase() === input.name!.toLowerCase(),
          )
        )
          throw new ApiError("DUPLICATE", 409);
        if (
          input.connectionIds?.some(
            (id) =>
              !state.connections.some(
                (c) => c.id === id && c.status !== "revoked",
              ),
          )
        )
          throw new ApiError("INVALID_INPUT");
        Object.assign(
          p,
          input,
          input.connectionIds
            ? { connectionIds: [...new Set(input.connectionIds)] }
            : {},
        );
        record(
          "Profile updated",
          p.name,
          "Standing access configuration saved",
        );
        return json(p);
      }
      if (path[0] === "sources" && path.length === 2 && method === "PATCH") {
        const { connected } = z
          .object({ connected: z.boolean() })
          .strict()
          .parse(body);
        const source = state.sources.find((s) => s.id === path[1]);
        if (!source) throw new ApiError("NOT_FOUND", 404);
        if (
          source.kind === "native" ||
          source.kind === "snapshot" ||
          source.id === "nordpass"
        )
          throw new ApiError("DEMO_ONLY", 409);
        source.connected = connected;
        for (const c of state.connections.filter(
          (c) => c.sourceId === source.id && c.status !== "revoked",
        ))
          c.status = connected
            ? c.maintenance
              ? "challenge"
              : "paused"
            : "source-unavailable";
        record(
          connected ? "Source reconnected" : "Source disconnected",
          source.name,
          connected
            ? "Demo source available; recover each destination session."
            : "Renewal blocked. Already-delivered cookies are not invalidated.",
          connected ? "success" : "warning",
        );
        return json(source);
      }
      if (path[0] === "clients" && path.length === 1 && method === "POST") {
        if (state.clients.length >= 50) throw new ApiError("INVALID_INPUT");
        const input = z
          .object({
            name: label,
            redirectUri: z.string().url().max(500),
            profileId: z.string(),
          })
          .strict()
          .parse(body);
        const uri = new URL(input.redirectUri);
        if (
          uri.hash ||
          uri.username ||
          uri.password ||
          uri.search ||
          !(
            uri.protocol === "https:" ||
            (uri.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(uri.hostname))
          )
        )
          throw new ApiError("INVALID_INPUT");
        if (!state.profiles.some((p) => p.id === input.profileId))
          throw new ApiError("INVALID_INPUT");
        const c = {
          ...input,
          id: `demo_client_${crypto.randomUUID()}`,
          scopes: ["connections:read", "sessions:use"],
        };
        state.clients.push(c);
        record(
          "OAuth client registered",
          c.name,
          "Demo configuration only · no token issuer",
        );
        return json(c, 201);
      }
      if (path[0] === "settings" && path.length === 1 && method === "PATCH") {
        const input = z
          .object({ name: label, digest: z.boolean() })
          .strict()
          .parse(body);
        state.settings = input;
        record(
          "Settings updated",
          "Workspace",
          "Preferences saved for this demo process",
        );
        return json(input);
      }
      if (
        path[0] === "runtime" &&
        path[1] === "session" &&
        path.length === 2 &&
        method === "POST"
      ) {
        const binding = bindingSchema.parse(body);
        const c = boundConnection(binding.connectionId, binding.profileId);
        const material: SessionMaterial = {
          ...binding,
          revision: c.revision,
          allowedDomains: [c.domain],
          cookies: [
            {
              name: "unlock_demo",
              value: "synthetic-not-a-real-session",
              domain: c.domain,
              path: "/",
              expires: Date.parse(c.expiresAt) / 1000,
              httpOnly: true,
              secure: true,
              sameSite: "Lax",
            },
          ],
        };
        return json(material);
      }
      if (
        path[0] === "runtime" &&
        path[1] === "sync" &&
        path.length === 2 &&
        method === "POST"
      ) {
        const input = syncSchema.parse(body);
        const c = boundConnection(input.connectionId, input.profileId);
        if (input.revision !== c.revision) throw new ApiError("CONFLICT", 409);
        if (
          input.allowedDomains[0] !== c.domain ||
          input.cookies[0].domain !== c.domain
        )
          throw new ApiError("FORBIDDEN", 403);
        c.revision++;
        c.verifiedAt = minutes(0);
        record(
          "Runtime synchronized",
          c.name,
          `Revision ${c.revision} · fixture cookie values not recorded`,
          "success",
        );
        return json({ revision: c.revision });
      }
      throw new ApiError("NOT_FOUND", 404);
    } catch (error) {
      if (error instanceof CsvImportCapacityError)
        return json({ error: { code: "VAULT_FULL" } }, 409);
      if (error instanceof z.ZodError)
        return json({ error: { code: "INVALID_INPUT" } }, 400);
      if (error instanceof ApiError)
        return json({ error: { code: error.code } }, error.status);
      return json({ error: { code: "BAD_REQUEST" } }, 400);
    }
  };
}
// Vite SSR loads this module once per process. No disk or browser storage.
export const handleDemoRequest = createDemoService();
