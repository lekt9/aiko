# Aiko connector engine

`apps/agent/src/connectors.ts` implements catalog search, owner-bound Arcade authorization, server-side auth polling, tool execution, and evidence-based declarative discovery. `connectors-store.ts` supplies durable private file storage. Actor tools and HTTP/UI integration are owned separately; the shared interface is in `.agent-grid/notes/connector-contract.md`.

Create one engine for the authenticated account, using the existing server account binding. Never accept `owner` from a model argument or request body. The only API-key source is `ARCADE_API_KEY`: Node uses `process.env.ARCADE_API_KEY`; Cloudflare supplies `{env: {ARCADE_API_KEY: env.ARCADE_API_KEY}}`. There is no general API-key constructor argument and no hardcoded credential. An injected fetch is a trusted host transport, not a user-configurable proxy.

```ts
const engine = new ConnectorEngine({
  owner: authenticatedAccountId,
  store: new FileConnectorStore(privateConnectorDirectory),
});
const result = await engine.search("github.com");
// Display the catalog result before choosing a specific tool.
const connection = await engine.connect(result.connectors[0].id);
// Deliver authorizationUrl directly to this owner through the secure UI.
// Poll completeAuth(connection.id); never accept an upstream auth ID from the client.
```

## Arcade precedence and availability

Search reads all pages of `/v1/tools?limit=1000&offset=...`, with at most three page requests in flight after the first page. The live engine accepts 1,000 tools per page (8,252 tools in nine requests). It validates `items`, `offset`, stable `total_count`, unique tool identities and metadata. Limits, empty catalogs, malformed responses, unstable pagination, missing configuration, denied access, timeouts, and service errors all return `unavailable`, with `fallbackAllowed:false`. There are no automatic retries of side effects.

Name and task search use a sparse weighted token/BM25 index over toolkit, tool name, and description, with exact toolkit/tool identities ranked first. CamelCase names are tokenized; a qualified name such as `Gmail.ListEmails` is treated as a tool identity. Search returns at most 50 compact matches plus `totalMatches` and `catalogSize`; full schemas are retrieved with `describe(id)`. Domain search uses genuine DNS domains in `metadata.classification.service_domains`, explicit provider scope resource hosts, and documented toolkit/provider mappings, including subdomains. Semantic category labels such as `EMAIL` and `MESSAGING` are retained as metadata, never parsed as website domains. Documented mappings currently cover Gmail/mail.google.com, Slack and GitHub; they establish positive matches only. Absence for a domain requires a complete, nonempty catalog and genuine DNS domain classification on every entry. A positive match can come from a documented mapping even when metadata is absent; those mappings never establish exhaustive absence. The auth-provider listing must also succeed before any absence result can enable fallback. Available auth providers also block browser fallback for matching domains even if they have no executable tools. Unclassified tools make absence uncertain. The result describes the configured Arcade engine catalog, not every catalog visible to every Arcade customer. Pagination cannot prove a transactional catalog snapshot; a count change or duplicate invalidates the read.

`connectBrowser(domain)` and `discover(domain)` independently check the complete cached catalog and provider results. They reuse only unexpired successful snapshots; an expired snapshot must refresh successfully. Only `absent` can permit them. A failed authorization or tool execution never enables browser fallback. Empty catalogs fail closed because an empty configuration cannot establish global service absence.

## Router interface and cache

- `listCatalog(): Promise<ConnectorDescription[]>` returns a defensive copy of all public tool definitions.
- `describe(id): Promise<ConnectorDescription>` returns one tool by its `arcade:<qualified_name>` ID; unknown IDs fail.
- `listAuthProviders(): Promise<ConnectorAuthProvider[]>` returns safe metadata from the official `/v1/admin/auth_providers` listing. A denied, malformed or partial response throws; it is not an empty successful listing.
- Existing `search(query)` adds `totalMatches`, `catalogSize`, `authProviders`, and `authProvidersStatus`. It remains a compact discovery API. A result may be available with no connectors and nonempty authProviders: authorization integration exists, but custom tools are still needed.

`ConnectorDescription` extends the existing connector fields with `toolkit` (name, version, description), `inputSchema`, safe Arcade-native `input.parameters`, structural `requirements`, `metadata`, and `domainEvidence` provenance. `inputSchema` is projected from formatted schemas when present or converted from Arcade value types. An unconstrained Arcade `json` value remains unconstrained JSON rather than incorrectly requiring an object. Parameter names such as `page_token` and secret *requirement names* survive; defaults, credential values, arbitrary configuration extras and auth URLs do not. Requirement statuses describe the catalog snapshot, not an account's completed grant. The router should select a candidate, inspect its schema/requirements, and let the existing authorization/execution APIs enforce actual runtime access.

Auth providers have `{id,providerId,type,status,description,kind:'auth_provider',executable:false,domains,authorizationDomains}`. Authorization origins are hostname-only descriptive metadata, not proof of resource-domain coverage. OAuth endpoint URLs, client IDs/secrets, parameter bags, bindings and grants are omitted. Public provider metadata is separate from tools and cannot be passed to `connect` as an executable connector.

Successful snapshots are cached for five minutes and concurrent requests share one load. Cache scope is transport identity plus SHA-256 of the configured environment key, never the key itself. Account grants/connections remain outside this cache. Key rotation creates a separate scope; an in-flight load pins its original key across every page. At most 16 key scopes are retained per transport. Failed refreshes discard expired snapshots and apply a five-second failure cooldown. Cache consumers receive defensive copies; they cannot mutate the shared definitions. No stale results are used to authorize browser fallback. These caches are process-local; worker isolates each maintain their own cache.

No dependency was added for ranking. The sparse index stores token postings once per snapshot; each query scores posting-list candidates with BM25 and deterministic ties. The catalog parser validates total counts, offsets, page sizes, duplicate identities and page budgets before publishing a snapshot.

## Authorization and execution

Authorization POSTs `{tool_name,user_id}` to `/v1/tools/authorize`. Pending connections durably bind the generated connection ID to account, tool, upstream auth ID, and a ten-minute expiry. `completeAuth` polls `/v1/auth/status?id=...` using only the stored ID and validates returned identity/flow information. Callback query parameters cannot mark a connection connected. Authorization links must use HTTPS on `arcade.dev` or its subdomains.

The provider's completed status enables only the bound tool; `execute` POSTs `{tool_name,user_id,input}` to `/v1/tools/execute`. Reserved identity/auth arguments are rejected. HTTP success alone is insufficient: the response must report `success:true` without an output error or authorization requirement. Provider logs, context, credentials and stack traces are never returned. Value fields are recursively scrubbed for credential keys, known key material and recognized credential strings. This is defense in depth, not a guarantee that arbitrary unlabeled provider data contains no secrets; hosts must keep private tool results within the owning account.

`disconnect` disables this local connection and removes its auth link/flow. It does **not** claim to revoke the upstream OAuth grant. A request already sent cannot be recalled. Connection transitions and execution serialize by account across engine instances in one process. Hosts must enforce a single writer per account across processes, such as a Cloudflare account Durable Object; the file store alone is not a distributed lock.

## Secure browser/password path

After confirmed Arcade absence, a host may inject `secureBrowser.begin({owner,domain,connectionId})`. It must create an owner-bound sign-in relay with credential vault custody and independent browser egress controls. The engine accepts no password and never requests one in chat. Without that adapter the engine reports that secure browser/password connection is not configured. An opened relay produces only a pending connection; this module does not fabricate browser completion or allow browser execution. Relay URLs are host-trusted, HTTPS, owner-only return fields.

## Discovery and durable capabilities

Discovery accepts any syntactically public HTTPS domain. It can read owner-scoped past log projections through `readOwnedLogs(owner,domain)` and exact public GitHub, raw GitHub or DeepWiki evidence URLs. The default public reader reuses `publicTarget`, DNS public-address validation and pinned-IP network requests from existing security code. It refuses credentials in URLs, private/reserved addresses, custom ports and unsafe redirects; it sends no ambient browser cookies or API key to public evidence sites. Custom readers must preserve those protections. Redirected or truncated evidence is not used.

The extractor recognizes explicit `METHOD https://domain/path` endpoint evidence. It rejects cross-domain routes, query strings, fragments and credential-like paths. It never persists request headers, bodies, passwords, cookies or the raw log. Log references are hashed; public evidence retains its cited URL. Records include method/path, source, version, timestamp and `review_required` status, under the owner's namespace. Discovery reloads persisted records after restart. These are candidates, not executable generated code; absence of evidence returns `needs_evidence`. Host log readers must supply authentic owned records, not model-written provenance. This module does not automatically search GitHub or DeepWiki for repositories; callers supply public evidence URLs, while the separate actor capability builder handles its own richer workflow.

`FileConnectorStore` uses owner-prefixed keys, private directory/file modes, no-follow record reads, atomic rename and fsync. Store it outside web roots in a host-controlled private directory. Protect its parent directories and backups; auth links/flow IDs are sensitive and this file adapter does not encrypt at rest. Production hosts can instead implement `ConnectorStore` on encrypted account storage. Never log store records or owner-only auth links.

## Verified API sources

Verified 2026-09-06 against Arcade's authoritative docs and generated TypeScript SDK:

- [Authorized tool calling](https://docs.arcade.dev/en/build/tool-calling/custom-apps/auth-tool-calling)
- [Tool invocation quickstart](https://docs.arcade.dev/en/get-started/quickstarts/call-tool-agent)
- [Official tools resource and schemas](https://github.com/ArcadeAI/arcade-js/blob/main/src/resources/tools/tools.ts)
- [Official auth resource](https://github.com/ArcadeAI/arcade-js/blob/main/src/resources/auth.ts)
- [Authorization response schema](https://github.com/ArcadeAI/arcade-js/blob/main/src/resources/shared.ts)
- [Official auth-provider resource and response schema](https://github.com/ArcadeAI/arcade-js/blob/main/src/resources/admin/auth-providers.ts)
- [Gmail toolkit and Google provider mapping](https://docs.arcade.dev/en/resources/integrations/productivity/gmail)
- [Slack toolkit and provider mapping](https://docs.arcade.dev/en/resources/integrations/social/slack)
- [Slack API toolkit](https://docs.arcade.dev/en/resources/integrations/social/slack-api)
- [GitHub provider mapping](https://docs.arcade.dev/en/references/auth-providers/github)
- [Offset pagination schema](https://github.com/ArcadeAI/arcade-js/blob/main/src/core/pagination.ts)

## Verification

Run `bun test apps/agent/test/connector-engine.test.ts apps/agent/test/connector-catalog.test.ts` and `bun run --cwd apps/agent typecheck`. Tests exercise pagination, catalog failure/coverage rules, account isolation, auth identity/flow substitution, expired auth, disconnect races, output redaction, SSRF URL rejection, same-owner discovery, durable restart and unconfigured relay behavior. Regression tests use deterministic contract fixtures. A separate read-only live verification on 2026-09-06 loaded 8,252 tools and 27 auth providers, confirmed `Gmail` (31 text matches), `gmail.com` (30 tools), and `slack.com` (83 tools). Three simultaneous searches used nine tool-page requests plus one provider request in approximately 20.2 seconds cold; the subsequent `listCatalog()` made no extra requests. The key was read with `privateEnv` from the authorized private environment file and was not printed or persisted by the probe. No live authorization, tool execution or auth-flow URLs were requested. Regression tests additionally cover coalescing across engine instances, key-scope separation, pinned credentials during rotation, cache expiry/failure/recovery, mutation resistance, documented domain mapping, semantic categories, provider-only availability, schema projection and BM25 ranking. Existing public-reader network tests cover DNS pinning and redirect protection.
