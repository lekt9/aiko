/**
 * Aiko OpenAI-Compatible Chat Proxy — Cloudflare Worker (authenticated)
 *
 * Authenticated gateway that validates Aiko bearer tokens (JWT), extracts
 * user identity, and forwards requests to the multi-model upstream with
 * Codegraff primary and Surplus as failover. Unauthenticated requests are
 * rejected with 401.
 *
 * Architecture (per docs/aiko-provider-gateway.md):
 *   Client → [Bearer Aiko JWT] → this worker
 *     → [CODEGRAFF_API_KEY] → https://gateway.codegraff.com   (primary)
 *
 * Token validation: decodes the JWT (base64url), checks issuer + expiration,
 * and extracts the user identity from `sub` / `principalId` claims.
 *
 * TODO: Add full JWT signature verification via JWKS once the issuer
 *       (https://aiko.theclarityproject.net) exposes a JWKS endpoint.
 *       Today the issuer's OIDC discovery document lacks `jwks_uri`.
 *
 * Environment (set via `wrangler secret put`):
 *   CODEGRAFF_API_KEY — primary upstream key (cg_sk_...)
 *   CODEGRAFF_URL     — Codegraff base (default https://gateway.codegraff.com)
 *   BEST_MODEL        — upstream slug `best` is bound to (see model gate below)
 *   BEST_CONTEXT_WINDOW — context window advertised for `best`
 *   ISSUER_URL        — OAuth issuer base URL
 *                        (defaults to https://aiko.theclarityproject.net)
 */

// ═══════════════════════════════════════════════════════════════════════════════
// JWT utilities
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Base64url decode to a UTF-8 string.
 */
function base64urlDecodeStr(str) {
    const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const binary = atob(padded);
    // Convert binary string to UTF-8 byte array, then decode
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
}

/**
 * Parse a JWT into its header and payload (unverified).
 * Returns null if the token is not a well-formed JWT.
 */
function decodeJwt(token) {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    try {
        const header = JSON.parse(base64urlDecodeStr(parts[0]));
        const payload = JSON.parse(base64urlDecodeStr(parts[1]));
        return { header, payload };
    } catch {
        return null;
    }
}

/**
 * Extract user identity from a decoded JWT payload.
 *
 * Tries (in order): principalId, sub, then falls back to email.
 */
function extractUserId(payload) {
    return payload.principalId || payload.sub || payload.email || null;
}

/**
 * Extract team identity from a decoded JWT payload (if present).
 */
function extractTeamId(payload) {
    return payload.team_id || payload.teamId || null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        },
    });
}

function cors() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'OPTIONS, GET, HEAD, POST, PUT, PATCH, DELETE',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Expose-Headers': '*',
            'Access-Control-Max-Age': '86400',
        },
    });
}

function err(status, message) {
    return json({ error: { message, type: 'proxy_error', param: null, code: null } }, status);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Auth middleware
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Authenticate the request.
 *
 * 1. Extracts `Authorization: Bearer <token>`
 * 2. Decodes the JWT (base64url, unverified — see TODO at top of file)
 * 3. Checks `iss` matches the expected issuer
 * 4. Checks `exp` is in the future
 * 5. Extracts user/team identity
 *
 * Returns { userId, teamId } or throws AuthError.
 */
function authenticate(request, env) {
    const issuerUrl = (env.ISSUER_URL || 'https://aiko.theclarityproject.net')
        .replace(/\/+$/, '');

    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
        throw new AuthError('Missing Authorization header');
    }

    const parts = authHeader.split(/\s+/);
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
        throw new AuthError('Authorization header must be "Bearer <token>"');
    }

    const token = parts[1];
    if (!token || token.length === 0) {
        throw new AuthError('Empty token');
    }

    // Decode the JWT (unverified peek — matches the Rust shell's
    // peek_access_token_principal approach)
    const decoded = decodeJwt(token);
    if (!decoded) {
        throw new AuthError('Invalid token: not a well-formed JWT');
    }

    const { payload } = decoded;

    // Check issuer (if present in payload)
    if (payload.iss && payload.iss !== issuerUrl) {
        throw new AuthError(
            `Token issuer mismatch: expected ${issuerUrl}, got ${payload.iss}`
        );
    }

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
        throw new AuthError('Token expired');
    }

    // Check not-before (if present)
    if (payload.nbf && payload.nbf > now) {
        throw new AuthError('Token not yet valid');
    }

    // Extract user identity
    const userId = extractUserId(payload);
    if (!userId) {
        throw new AuthError('Token missing user identity (no sub, principalId, or email)');
    }

    return {
        userId,
        teamId: extractTeamId(payload),
    };
}

class AuthError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AuthError';
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Upstream forwarding
// ═══════════════════════════════════════════════════════════════════════════════

/** The only multi-model upstream. Path `/v1/...` is appended. */
const DEFAULT_CODEGRAFF = 'https://gateway.codegraff.com';

/**
 * Upstream candidates — Codegraff and nothing else.
 *
 * This returns a list because `forward` retries on a retryable status, not
 * because there is a second provider to fail over to. Aiko routes to Codegraff
 * only; a fallback to another vendor would keep serving while looking healthy,
 * which is the one failure nobody notices from outside.
 */
function resolveUpstreamCandidates(env) {
    if (!env.CODEGRAFF_API_KEY) return [];
    return [{
        name: 'codegraff',
        base: (env.CODEGRAFF_URL || DEFAULT_CODEGRAFF).replace(/\/+$/, ''),
        key: env.CODEGRAFF_API_KEY,
    }];
}

function resolveUpstream(env) {
    const candidates = resolveUpstreamCandidates(env);
    return candidates[0]?.base
        || (env.CODEGRAFF_URL || env.TARGET_URL || DEFAULT_CODEGRAFF).replace(/\/+$/, '');
}

/** Server-held upstream bearer. Codegraff is the only upstream. */
function upstreamApiKey(env) {
    return env.CODEGRAFF_API_KEY || '';
}

/**
 * Build upstream headers.
 *
 * Always uses the server-held Codegraff key as the upstream bearer — the
 * client's Aiko JWT never reaches Codegraff. Passes user identity as
 * x-aiko-user-id for usage tracking.
 */
const HOP_BY_HOP_HEADERS = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

function upstreamHeaders(request, user, bearerKey) {
    const h = new Headers();

    // Preserve OpenAI SDK feature, idempotency, content negotiation, multipart,
    // range, and tracing headers. Strip transport headers and all credentials /
    // client-controlled accounting identity before adding trusted values below.
    for (const [name, value] of request.headers) {
        const lower = name.toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'authorization' ||
            lower === 'x-api-key' || lower === 'x-aiko-user-id' ||
            lower === 'x-aiko-team-id' || lower.startsWith('cf-')) continue;
        h.set(name, value);
    }

    // Server-side upstream key for this candidate (never the client JWT).
    h.set('Authorization', `Bearer ${bearerKey}`);

    // User identity for usage tracking
    if (user.userId) {
        h.set('x-aiko-user-id', user.userId);
    }
    if (user.teamId) {
        h.set('x-aiko-team-id', user.teamId);
    }

    return h;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Difficulty routing — send hard tasks to a stronger model
const RETRYABLE_UPSTREAM = new Set([429, 500, 502, 503, 504]);

async function forward(request, env, path, user) {
    const candidates = resolveUpstreamCandidates(env);
    if (candidates.length === 0) {
        return err(503, 'Proxy is not configured: CODEGRAFF_API_KEY is missing');
    }

    const urlObj = new URL(request.url);
    const query = urlObj.search;

    // Buffer non-idempotent bodies once so a retry can re-send them.
    let body = null;
    if (!['GET', 'HEAD'].includes(request.method)) {
        body = await request.arrayBuffer();
    }


    let lastErr = null;
    for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const fullUrl = query
            ? `${candidate.base}${path}${query}`
            : `${candidate.base}${path}`;
        const headers = upstreamHeaders(request, user, candidate.key);
        const init = { method: request.method, headers };
        if (body !== null) init.body = body;

        let resp;
        try {
            resp = await fetch(fullUrl, init);
        } catch (e) {
            lastErr = e;
            if (i < candidates.length - 1) continue;
            return err(502, `Upstream unreachable: ${e.message}`);
        }

        // Cloudflare attaches the accepted WebSocket to the original 101 response.
        // Reconstructing that response would detach it and break Realtime API use.
        if (resp.status === 101 || resp.webSocket) return resp;

        if (RETRYABLE_UPSTREAM.has(resp.status) && i < candidates.length - 1) {
            try { await resp.body?.cancel(); } catch { /* ignore */ }
            continue;
        }

        const responseHeaders = new Headers(resp.headers);
        for (const name of HOP_BY_HOP_HEADERS) responseHeaders.delete(name);
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Access-Control-Expose-Headers', '*');
        responseHeaders.set('x-aiko-upstream', candidate.name);
        return new Response(resp.body, {
            status: resp.status,
            statusText: resp.statusText,
            headers: responseHeaders,
        });
    }

    if (lastErr) {
        return err(502, `Upstream unreachable: ${lastErr.message}`);
    }
    return err(502, 'All upstreams failed');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Model gate
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Aiko publishes exactly one chat model id: `best`. The binding from that id to
 * a concrete upstream slug lives here, so re-pointing `best` at a newer model is
 * a worker var change, not a client release — every installed client follows
 * without updating.
 *
 * The gate refuses any other id on the chat surface rather than forwarding it.
 * A proxy that lists one model and routes a hundred is lying about one of the
 * two; refusing keeps `/v1/models` an honest statement of what Aiko will serve.
 */
const GATE_MODEL_ID = 'best';
const DEFAULT_BOUND_MODEL = 'muse-spark-1.2-contributor';
const DEFAULT_BOUND_CONTEXT_WINDOW = 1048576;

/**
 * Ids that resolve to the bound model rather than being refused: the gate id
 * itself, plus the defaults older installed clients still send. Dropping an
 * entry here breaks every client pinned to that id until it updates.
 */
const LEGACY_MODEL_IDS = new Set([
    '', 'default', 'auto', 'aiko', 'aiko-default',
    'deepseek-v4-pro', 'deepseek-v4-flash', 'kimi-k3',
]);

/**
 * Chat-shaped endpoints whose JSON body carries the model id we gate. Other
 * `/v1` routes (embeddings, images, audio, files, batches) stay transparent —
 * they name models from families `best` does not stand in for, and rewriting
 * their model field would break them.
 */
const GATED_PATHS = new Set([
    '/v1/chat/completions',
    '/v1/completions',
    '/v1/responses',
    '/v1/messages',
]);

function boundModel(env) {
    return env.BEST_MODEL || DEFAULT_BOUND_MODEL;
}

function boundContextWindow(env) {
    const raw = Number(env.BEST_CONTEXT_WINDOW);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_BOUND_CONTEXT_WINDOW;
}

/**
 * The single published catalog entry.
 *
 * `id` and `model` are both `best` so clients send `best` back to us and the
 * gate — not the client — decides what that resolves to. `baseUrl` is derived
 * from the request origin so a dev or staging deployment advertises itself
 * rather than production.
 */
function modelDescriptor(request, env) {
    const origin = new URL(request.url).origin;
    const contextWindow = boundContextWindow(env);
    return {
        id: GATE_MODEL_ID,
        model: GATE_MODEL_ID,
        object: 'model',
        owned_by: 'aiko',
        name: 'Best',
        description: "Aiko's best available model. Bound server-side; the binding moves without a client update.",
        contextWindow,
        context_window: contextWindow,
        apiBackend: 'chat_completions',
        baseUrl: `${origin}/v1`,
        supportsReasoningEffort: true,
        supportedInApi: true,
        hidden: false,
    };
}

/**
 * Resolve the requested model to the bound upstream slug, or `null` to refuse.
 * A body carrying no `model` field passes through untouched — only a stated
 * model is gated, never an absent one.
 */
function gateModel(requested, env) {
    const id = typeof requested === 'string' ? requested.trim() : '';
    const upstream = boundModel(env);
    if (id === GATE_MODEL_ID || id === upstream) return upstream;
    if (LEGACY_MODEL_IDS.has(id.toLowerCase())) return upstream;
    return null;
}

function isJsonBody(request) {
    return (request.headers.get('content-type') || '').toLowerCase().includes('application/json');
}

function canonicalApiPath(path) {
    if (path === '/openai/v1') return '/v1';
    if (path.startsWith('/openai/v1/')) return path.slice('/openai'.length);
    const legacyRoots = ['/models', '/chat/completions', '/completions', '/embeddings'];
    if (legacyRoots.includes(path)) return `/v1${path}`;
    return path;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Worker entry
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') return cors();

        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, '') || '/';

        // ── health (no auth required) ──
        if (request.method === 'GET' && (path === '/health' || path === '/')) {
            const candidates = resolveUpstreamCandidates(env);
            return json({
                ok: true,
                service: 'aiko-openai-proxy',
                auth: 'required',
                upstream: resolveUpstream(env),
                upstreams: candidates.map((c) => ({ name: c.name, base: c.base })),
                primary: candidates[0]?.name ?? null,
                upstream_key_configured: Boolean(upstreamApiKey(env)),
                time: Math.floor(Date.now() / 1000),
            });
        }

        // ── authenticate every other request ──
        let user;
        try {
            user = authenticate(request, env);
        } catch (e) {
            if (e instanceof AuthError) {
                return err(401, e.message);
            }
            return err(500, `Authentication error: ${e.message}`);
        }

        // Method-agnostic pass-through for the complete OpenAI surface. This
        // covers Responses, Chat/Completions, Embeddings, Images, Audio, Files,
        // Uploads, Batches, Moderations, Assistants/Threads, Vector Stores,
        // Fine-tuning, Evals, Containers, and future /v1 endpoints without the
        // proxy needing a release for every API addition.
        const apiPath = canonicalApiPath(path);

        // ── the published catalog: exactly one model ──
        if (request.method === 'GET' && apiPath === '/v1/models') {
            return json({ object: 'list', data: [modelDescriptor(request, env)] });
        }
        if (request.method === 'GET' && apiPath.startsWith('/v1/models/')) {
            const id = decodeURIComponent(apiPath.slice('/v1/models/'.length));
            if (id !== GATE_MODEL_ID && id !== boundModel(env)) {
                return err(404, `Unknown model "${id}". This gateway serves exactly one model: "${GATE_MODEL_ID}".`);
            }
            return json(modelDescriptor(request, env));
        }

        // ── the chat surface: `best` is the only id that routes ──
        if (GATED_PATHS.has(apiPath) && !['GET', 'HEAD'].includes(request.method) && isJsonBody(request)) {
            let text;
            try {
                text = await request.text();
            } catch (e) {
                return err(400, `Unreadable request body: ${e.message}`);
            }
            let payload = null;
            try {
                payload = JSON.parse(text);
            } catch {
                // Not JSON we can reason about; let the upstream reject it.
            }
            if (payload && typeof payload === 'object' && !Array.isArray(payload)
                && payload.model !== null && payload.model !== undefined) {
                const resolved = gateModel(payload.model, env);
                if (resolved === null) {
                    return err(400, `Unknown model "${payload.model}". This gateway serves exactly one model: "${GATE_MODEL_ID}".`);
                }
                payload.model = resolved;
                text = JSON.stringify(payload);
            }
            const gated = new Request(request, { body: text });
            return forward(gated, env, apiPath, user);
        }

        if (apiPath === '/v1' || apiPath.startsWith('/v1/')) {
            return forward(request, env, apiPath, user);
        }

        return err(404, `Not found: ${path}`);
    },
};
