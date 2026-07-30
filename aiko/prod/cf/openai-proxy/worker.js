/**
 * Aiko OpenAI-Compatible Chat Proxy — Cloudflare Worker (authenticated)
 *
 * Authenticated gateway that validates Aiko bearer tokens (JWT), extracts
 * user identity, and forwards requests to Codegraff's OpenAI-compatible API.
 * Unauthenticated requests are rejected with 401.
 *
 * Architecture (per docs/aiko-provider-gateway.md):
 *   Client → [Bearer token] → this worker → [CODEGRAFF_API_KEY] → Codegraff
 *
 * Token validation: decodes the JWT (base64url), checks issuer + expiration,
 * and extracts the user identity from `sub` / `principalId` claims.
 *
 * TODO: Add full JWT signature verification via JWKS once the issuer
 *       (https://aiko.theclarityproject.net) exposes a JWKS endpoint.
 *       Today the issuer's OIDC discovery document lacks `jwks_uri`.
 *
 * Environment (set via `wrangler secret put`):
 *   CODEGRAFF_API_KEY — server-side upstream API key (required)
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

function resolveUpstream(env) {
    return (env.TARGET_URL || 'https://gateway.codegraff.com').replace(/\/+$/, '');
}

/**
 * Build upstream headers.
 *
 * Always uses CODEGRAFF_API_KEY as the upstream bearer — the client's token
 * never reaches Codegraff. Passes user identity as x-aiko-user-id for usage
 * tracking.
 */
const HOP_BY_HOP_HEADERS = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

function upstreamHeaders(request, env, user) {
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

    // Server-side Codegraff key (required)
    h.set('Authorization', `Bearer ${env.CODEGRAFF_API_KEY}`);

    // User identity for usage tracking
    if (user.userId) {
        h.set('x-aiko-user-id', user.userId);
    }
    if (user.teamId) {
        h.set('x-aiko-team-id', user.teamId);
    }

    return h;
}

async function forward(request, env, path, user) {
    const base = resolveUpstream(env);
    const url = `${base}${path}`;
    if (!env.CODEGRAFF_API_KEY) {
        return err(503, 'Proxy is not configured: CODEGRAFF_API_KEY is missing');
    }
    const headers = upstreamHeaders(request, env, user);

    const urlObj = new URL(request.url);
    const query = urlObj.search;
    const fullUrl = query ? `${url}${query}` : url;

    const init = {
        method: request.method,
        headers,
    };

    if (!['GET', 'HEAD'].includes(request.method)) {
        init.body = request.body;
    }

    let resp;
    try {
        resp = await fetch(fullUrl, init);
    } catch (e) {
        return err(502, `Upstream unreachable: ${e.message}`);
    }

    // Cloudflare attaches the accepted WebSocket to the original 101 response.
    // Reconstructing that response would detach it and break Realtime API use.
    if (resp.status === 101 || resp.webSocket) return resp;

    const responseHeaders = new Headers(resp.headers);
    for (const name of HOP_BY_HOP_HEADERS) responseHeaders.delete(name);
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Expose-Headers', '*');
    return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: responseHeaders,
    });
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
            return json({
                ok: true,
                service: 'aiko-openai-proxy',
                auth: 'required',
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
