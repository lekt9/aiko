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
 *     → [SURPLUS_API_KEY]   → https://api.surplusintelligence.ai  (failover)
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
 *   SURPLUS_API_KEY   — secondary upstream key (inf_...)
 *   CODEGRAFF_URL     — Codegraff base (default https://gateway.codegraff.com)
 *   TARGET_URL        — Surplus base (default https://api.surplusintelligence.ai)
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

/** Primary multi-model upstream (Codegraff). Path `/v1/...` is appended. */
const DEFAULT_CODEGRAFF = 'https://gateway.codegraff.com';
/** Secondary multi-model upstream (Surplus). */
const DEFAULT_SURPLUS = 'https://api.surplusintelligence.ai';

/**
 * Ordered upstream candidates: Codegraff first, Surplus second.
 * Each entry is `{ name, base, key }`.
 */
function resolveUpstreamCandidates(env) {
    const out = [];
    if (env.CODEGRAFF_API_KEY) {
        out.push({
            name: 'codegraff',
            base: (env.CODEGRAFF_URL || DEFAULT_CODEGRAFF).replace(/\/+$/, ''),
            key: env.CODEGRAFF_API_KEY,
        });
    }
    if (env.SURPLUS_API_KEY) {
        out.push({
            name: 'surplus',
            base: (env.TARGET_URL || DEFAULT_SURPLUS).replace(/\/+$/, ''),
            key: env.SURPLUS_API_KEY,
        });
    }
    // Legacy: only CODEGRAFF key used to mean "whatever TARGET_URL is" when
    // Surplus was the sole hop. Prefer a real codegraff URL now; if neither
    // named key is set, fall through to empty.
    return out;
}

function resolveUpstream(env) {
    const candidates = resolveUpstreamCandidates(env);
    return candidates[0]?.base
        || (env.CODEGRAFF_URL || env.TARGET_URL || DEFAULT_CODEGRAFF).replace(/\/+$/, '');
}

/**
 * Server-held primary upstream bearer. Prefer CODEGRAFF_API_KEY, then SURPLUS.
 */
function upstreamApiKey(env) {
    return env.CODEGRAFF_API_KEY || env.SURPLUS_API_KEY || '';
}

/**
 * Build upstream headers.
 *
 * Always uses the server-held Surplus (or legacy) key as the upstream bearer —
 * the client's Aiko JWT never reaches Surplus. Passes user identity as
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
// ═══════════════════════════════════════════════════════════════════════════════
//
// Research-grounded (RouteLLM 2406.18665, Hybrid-LLM 2404.14618): the only
// routing signal that fits an edge proxy's latency budget is PRE-inference — no
// generation round-trip. Cascades (FrugalGPT/AutoMix) buy quality by spending a
// full extra round-trip, which is the wrong default here. So this is a
// cheapest-first, first-hit-wins decision:
//
//   Tier 0  caller tag   — an explicit `x-aiko-difficulty: hard|easy` header (or
//                          `metadata.difficulty` in the body) always wins. The
//                          agent usually knows the task; free and most accurate.
//   Tier 1  heuristics   — microsecond regex/counting on the prompt: code, math,
//                          multi-step cues, length. Routes the head of the
//                          distribution for zero model calls.
//   (Tier 2  a tiny embedding+linear router for the ambiguous middle is the
//    documented next step — Workers AI `bge-small` + a shipped weight vector —
//    but it needs an AI binding and calibrated weights, so it is intentionally
//    left as an extension rather than guessed at here.)
//
// Off unless HARD_ROUTING is truthy, so deploying changes nothing until enabled.
// Only requests whose model is in EASY_MODELS are ever escalated, so an explicit
// strong-model call is never downgraded or altered.

const DEFAULT_EASY_MODELS = 'deepseek-v4-flash';
// deepseek-v4-pro is served by the gateway today, so flash→pro works now.
// Set HARD_MODEL=kimi-k3 once the gateway allowlists that slug.
const DEFAULT_HARD_MODEL = 'deepseek-v4-pro';

const HARD_CODE = /```|\bdef\s|\bclass\s|\bfunction\s|=>|\bimport\s|\bSELECT\b|<\/?\w+>|\$\$?[^$]+\$\$?/i;
const HARD_CUES = /\b(step[- ]by[- ]step|prove|derive|debug|refactor|architect(?:ure)?|optimi[sz]e|explain why|reason through|trade[- ]?offs?|algorithm|complexity|concurren|race condition|migrat|design a|plan (?:out|the)|root cause)\b/i;
const EASY_CUES = /\b(translate|summari[sz]e|rewrite|rephrase|classify|extract|format|list|tl;?dr|spell|capitali[sz]e)\b/i;

function truthy(v) {
    return v === true || v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Concatenate the user-authored text of a chat/completions body. */
function userText(bodyObj) {
    const msgs = Array.isArray(bodyObj?.messages) ? bodyObj.messages : [];
    let text = '';
    for (const m of msgs) {
        if (m?.role && m.role !== 'user') continue;
        if (typeof m.content === 'string') text += m.content + '\n';
        else if (Array.isArray(m.content)) {
            for (const part of m.content) {
                if (typeof part?.text === 'string') text += part.text + '\n';
            }
        }
    }
    return text;
}

/** Tier-1 heuristic: 'hard' | 'easy' | 'unknown', from the prompt alone. */
function heuristicDifficulty(bodyObj) {
    const text = userText(bodyObj);
    const len = text.length;
    const msgCount = Array.isArray(bodyObj?.messages) ? bodyObj.messages.length : 0;
    if (HARD_CODE.test(text) || HARD_CUES.test(text)) return 'hard';
    if (len > 6000 || msgCount > 12) return 'hard';   // long context to reason over
    if (len < 240 && EASY_CUES.test(text)) return 'easy';
    return 'unknown';
}

/**
 * Decide the model for a chat/completions request. Returns `{ from, to }` when a
 * rewrite should happen, else null. Tier 0 (explicit tag) wins over Tier 1.
 */
function chooseModel(bodyObj, request, env) {
    const current = bodyObj?.model;
    if (typeof current !== 'string' || !current) return null;

    const easy = (env.EASY_MODELS || DEFAULT_EASY_MODELS)
        .split(',').map(s => s.trim()).filter(Boolean);
    // Never touch an explicit strong-model (or unknown) request.
    if (!easy.includes(current)) return null;

    const hardModel = env.HARD_MODEL || DEFAULT_HARD_MODEL;
    if (hardModel === current) return null;

    // Tier 0: caller override (header or body field).
    const tag = (request.headers.get('x-aiko-difficulty')
        || bodyObj?.metadata?.difficulty || '').toString().toLowerCase();
    if (tag === 'easy') return null;
    if (tag === 'hard') return { from: current, to: hardModel };

    // Tier 1: heuristics.
    return heuristicDifficulty(bodyObj) === 'hard'
        ? { from: current, to: hardModel }
        : null;
}

const RETRYABLE_UPSTREAM = new Set([429, 500, 502, 503, 504]);

async function forward(request, env, path, user) {
    const candidates = resolveUpstreamCandidates(env);
    if (candidates.length === 0) {
        return err(503, 'Proxy is not configured: set CODEGRAFF_API_KEY and/or SURPLUS_API_KEY');
    }

    const urlObj = new URL(request.url);
    const query = urlObj.search;

    // Buffer non-idempotent bodies once so failover can re-send.
    let body = null;
    if (!['GET', 'HEAD'].includes(request.method)) {
        body = await request.arrayBuffer();
    }

    // Difficulty routing: only for a JSON chat/completions body, and only when
    // enabled. Everything else (uploads, multipart, SSE bodies) passes through
    // byte-for-byte untouched — parsing/re-serializing those would corrupt them.
    let routedTo = null;
    if (
        truthy(env.HARD_ROUTING) &&
        request.method === 'POST' &&
        path === '/v1/chat/completions' &&
        body !== null &&
        (request.headers.get('content-type') || '').includes('application/json')
    ) {
        try {
            const obj = JSON.parse(new TextDecoder().decode(body));
            const decision = chooseModel(obj, request, env);
            if (decision) {
                obj.model = decision.to;
                body = new TextEncoder().encode(JSON.stringify(obj)).buffer;
                routedTo = decision.to;
            }
        } catch {
            // Not valid JSON after all — forward the original bytes unchanged.
        }
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
        if (routedTo) responseHeaders.set('x-aiko-routed-model', routedTo);
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
        if (apiPath === '/v1' || apiPath.startsWith('/v1/')) {
            return forward(request, env, apiPath, user);
        }

        return err(404, `Not found: ${path}`);
    },
};
