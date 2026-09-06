import { useState } from "react";
import { Check, Code2, Copy, Plus, Terminal } from "lucide-react";
import { api, useAction, useNotify, useWorkspace } from "../lib/workspace";
import { Empty, Modal, Notice, PageHeader, SaveButton } from "./ui";
const snippets = {
  sdk: `// Local workspace package — not published to npm.\nimport { createUnlockClient } from '@unlock/sdk'\n\nconst unlock = createUnlockClient({\n  baseUrl: 'http://127.0.0.1:4173/api',\n  // Production only: token: () => privateTokenStore.get()\n})\n\n// Management metadata only. No passwords or cookie values.\nconst accounts = await unlock.connections.list()\nconst profiles = await unlock.profiles.list()\nawait unlock.profiles.update('builder', {\n  connectionIds: ['github', 'linear'],\n})`,
  runtime: `// TRUSTED HOST CODE — never register as an LLM-visible tool.\nimport { createRuntimeClient, createSessionBridge }\n  from '@unlock/sdk/runtime'\n\nconst runtime = createRuntimeClient({\n  baseUrl: 'http://127.0.0.1:4173/api',\n})\n\n// adapter implements replaceCookies(cookies, domains)\n// and exportCookies(domains) in a dedicated browser context.\nconst bridge = createSessionBridge(runtime, adapter, {\n  connectionId: 'github', profileId: 'builder',\n})\nawait bridge.initialize() // hydrate once before navigation\nawait existingBrowserTools.navigate(destination)\n// Delegate regular browser tools without reinjecting cookies.\nawait bridge.sync() // compare-and-swap; no blind overwrite\n// On challenge/conflict, explicitly recover in trusted code.`,
  oauth: `# Proposed production OAuth contract — NOT a live endpoint.\n# Public clients: Authorization Code + PKCE (S256).\n# Bind grant to an owner-provisioned agent profile.\n\nscopes: connections:read sessions:use\naudience: unlock-api\nprofile: builder\n\n# Agent → Unlock OAuth is independent of CLI, SDK or MCP.\n# Never place tokens in URLs, prompts, or tool results.\n# Owner login and destination website SSO are separate flows.`,
  cli: `# Planned CLI interface — not implemented in this demo.\n# These commands are contract examples, not runnable yet.\n\nunlock auth login --profile builder\nunlock accounts list --json\nunlock sessions status --json\n\n# Login launches owner consent + PKCE, or a supported\n# device flow. Persist tokens in a protected OS key store.\n# Cookie retrieval belongs in the private runtime, not stdout.`,
  mcp: `// Optional MCP adapter — not implemented in this demo.\n// Metadata-only tool contract:\n{\n  "name": "unlock_sessions_status",\n  "description": "List assigned session health metadata",\n  "inputSchema": { "type": "object", "properties": {} }\n}\n\n// Reuse the same OAuth grant as CLI/SDK.\n// Do NOT add a cookie-returning MCP tool.\n// Trusted host retrieves/injects cookies privately, then\n// ordinary browser tools continue in that prepared context.`,
};
function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const notify = useNotify();
  return (
    <div
      className="code-block"
      role="region"
      aria-label="Integration code example"
      tabIndex={0}
    >
      <button
        className="copy-button"
        aria-label="Copy code"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            notify("Code copied");
          } catch {
            notify("Clipboard unavailable. Select and copy the code manually.");
          }
        }}
      >
        {copied ? <Check size={15} /> : <Copy size={15} />}{" "}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}
export function Developers() {
  const data = useWorkspace();
  const [tab, setTab] = useState<keyof typeof snippets>("sdk");
  const [modal, setModal] = useState(false);
  const [name, setName] = useState("");
  const [redirectUri, setRedirect] = useState("http://127.0.0.1:8787/callback");
  const [profileId, setProfileId] = useState(data.profiles[0]?.id ?? "");
  const create = useAction(
    () => api.clients.create({ name, redirectUri, profileId }),
    "Demo OAuth client configuration saved",
  );
  return (
    <>
      <PageHeader
        title="Built for your stack."
        description="A typed SDK. Your browser runtime. OAuth without a required MCP layer."
        action={
          <span className="version-label">
            <Code2 size={16} />
            @unlock/sdk · 0.1.0 local
          </span>
        }
      />
      <div className="developer-intro">
        <Terminal size={26} />
        <div>
          <h2>Start with metadata. Keep material private.</h2>
          <p>
            The management package is safe for this demo UI. Cookie retrieval is
            a separate import for trusted host code—not a tool result an agent
            reads.
          </p>
        </div>
      </div>
      <div className="tabs" aria-label="Integration examples">
        {(
          [
            ["sdk", "TypeScript SDK"],
            ["runtime", "Browser runtime"],
            ["oauth", "OAuth"],
            ["cli", "CLI"],
            ["mcp", "MCP"],
          ] as const
        ).map(([id, label]) => (
          <button
            aria-pressed={tab === id}
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <CodeBlock key={tab} code={snippets[tab]} />
      <Notice>
        {tab === "sdk" || tab === "runtime"
          ? "This local SDK and synthetic HTTP API are implemented and tested. Production auth, real vault custody and provider adapters are not connected."
          : "Design contract only. No live OAuth issuer, CLI executable, or MCP server ships in this prototype."}
      </Notice>
      <div className="section-head below">
        <div>
          <h2>OAuth client configurations</h2>
          <p>
            Try profile binding and redirect validation. Registration does not
            issue a token.
          </p>
        </div>
        <button className="button" onClick={() => setModal(true)}>
          <Plus size={16} />
          Register demo client
        </button>
      </div>
      <div
        className="panel table-scroll"
        role="region"
        aria-label="OAuth client configurations"
        tabIndex={0}
      >
        {data.clients.length ? (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Profile</th>
                <th>Redirect URI</th>
                <th>Mode</th>
              </tr>
            </thead>
            <tbody>
              {data.clients.map((c) => (
                <tr key={c.id}>
                  <td>
                    <strong>{c.name}</strong>
                    <small className="mono">{c.id}</small>
                  </td>
                  <td>
                    {data.profiles.find((p) => p.id === c.profileId)?.name}
                  </td>
                  <td>
                    <code>{c.redirectUri}</code>
                  </td>
                  <td>
                    <span className="demo-chip">Demo only</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="No clients configured">
            <p>
              Create a demo configuration to explore the agent authorization
              boundary.
            </p>
          </Empty>
        )}
      </div>
      {modal && (
        <Modal title="Register demo OAuth client" close={() => setModal(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(undefined, {
                onSuccess: () => {
                  setModal(false);
                  setName("");
                },
              });
            }}
          >
            <label className="field">
              Client name
              <input
                required
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Local build runner"
              />
            </label>
            <label className="field">
              Redirect URI
              <input
                type="url"
                aria-label="Redirect URI"
                required
                value={redirectUri}
                onChange={(e) => setRedirect(e.target.value)}
              />
              <small>
                HTTPS or HTTP loopback only. No fragments, userinfo, or query
                parameters.
              </small>
            </label>
            <label className="field">
              Agent profile
              <select
                value={profileId}
                onChange={(e) => setProfileId(e.target.value)}
                required
              >
                {data.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.enabled ? "" : " (disabled)"}
                  </option>
                ))}
              </select>
            </label>
            <Notice>
              Public client + PKCE in production. No secret or usable token is
              generated here.
            </Notice>
            {create.isError && (
              <p className="form-error" role="alert">
                {create.error.message}
              </p>
            )}
            <div className="form-actions">
              <button
                type="button"
                className="button"
                onClick={() => setModal(false)}
              >
                Cancel
              </button>
              <SaveButton pending={create.isPending}>
                Register configuration
              </SaveButton>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
