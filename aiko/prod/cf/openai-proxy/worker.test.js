import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

const env = {
    CODEGRAFF_API_KEY: 'cg_sk_test',
    ISSUER_URL: 'https://aiko.theclarityproject.net',
    CODEGRAFF_URL: 'https://gateway.codegraff.com',
    BEST_MODEL: 'muse-spark-1.2-contributor',
    BEST_CONTEXT_WINDOW: '1048576',
};

function token(payload = {}) {
    const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${enc({ alg: 'none' })}.${enc({ iss: env.ISSUER_URL, sub: 'user-1', team_id: 'team-1', exp: 4102444800, ...payload })}.x`;
}

function request(path, init = {}) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token()}`);
    return new Request(`https://aiko.example${path}`, { ...init, headers });
}

test('forwards every /v1 route, method, query, SDK headers, and response metadata', async t => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    let seen;
    globalThis.fetch = async (url, init) => {
        seen = { url, init };
        return new Response('{"id":"file-1"}', { status: 201, headers: {
            'content-type': 'application/json', 'x-request-id': 'req_123',
            'openai-processing-ms': '42', 'x-ratelimit-remaining-requests': '9',
        }});
    };
    const body = new Uint8Array([1, 2, 3]);
    const response = await worker.fetch(request('/v1/uploads/u_1/parts?purpose=batch', {
        method: 'POST', body, headers: {
            'content-type': 'application/octet-stream', 'openai-beta': 'assistants=v2',
            'idempotency-key': 'idem-1', 'x-aiko-user-id': 'spoofed',
        },
    }), env);

    // Codegraff is primary when both keys are present.
    assert.equal(seen.url, 'https://gateway.codegraff.com/v1/uploads/u_1/parts?purpose=batch');
    assert.equal(seen.init.headers.get('authorization'), 'Bearer cg_sk_test');
    assert.equal(seen.init.headers.get('x-aiko-user-id'), 'user-1');
    assert.equal(seen.init.headers.get('x-aiko-team-id'), 'team-1');
    assert.equal(seen.init.headers.get('openai-beta'), 'assistants=v2');
    assert.equal(seen.init.headers.get('idempotency-key'), 'idem-1');
    assert.equal(seen.init.headers.get('content-type'), 'application/octet-stream');
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('x-request-id'), 'req_123');
    assert.equal(response.headers.get('openai-processing-ms'), '42');
    assert.equal(response.headers.get('x-ratelimit-remaining-requests'), '9');
    assert.equal(response.headers.get('x-aiko-upstream'), 'codegraff');
});

test('normalizes Azure-style /openai/v1 without losing the endpoint', async t => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    let seenUrl;
    globalThis.fetch = async url => { seenUrl = url; return new Response('{}'); };
    await worker.fetch(request('/openai/v1/responses/r_1?include=output'), env);
    assert.equal(seenUrl, 'https://gateway.codegraff.com/v1/responses/r_1?include=output');
});

test('passes SSE through byte-for-byte and retains event headers', async t => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => new Response('event: response.created\ndata: {}\n\n', { headers: {
        'content-type': 'text/event-stream', 'x-request-id': 'stream-1',
    }});
    const response = await worker.fetch(request('/v1/responses', {
        method: 'POST', body: '{"stream":true}', headers: { 'content-type': 'application/json' },
    }), env);
    assert.equal(await response.text(), 'event: response.created\ndata: {}\n\n');
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.equal(response.headers.get('x-request-id'), 'stream-1');
});

test('supports DELETE and reports missing proxy configuration as an OpenAI error', async () => {
    const response = await worker.fetch(request('/v1/files/file-1', { method: 'DELETE' }), {
        ISSUER_URL: env.ISSUER_URL,
    });
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.error.type, 'proxy_error');
    assert.equal(payload.error.param, null);
    assert.equal(payload.error.code, null);
});

test('CORS preflight advertises the complete method surface', async () => {
    const response = await worker.fetch(new Request('https://aiko.example/v1/files', { method: 'OPTIONS' }), env);
    assert.match(response.headers.get('access-control-allow-methods'), /DELETE/);
    assert.equal(response.headers.get('access-control-allow-headers'), '*');
});

// ── Model gate ──────────────────────────────────────────────────────────────

test('publishes exactly one model, `best`, without consulting upstream', async t => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    let upstreamCalled = false;
    globalThis.fetch = async () => { upstreamCalled = true; return new Response('{}'); };

    const response = await worker.fetch(request('/v1/models'), env);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(upstreamCalled, false);
    assert.equal(payload.data.length, 1);
    assert.equal(payload.data[0].id, 'best');
    assert.equal(payload.data[0].model, 'best');
    assert.equal(payload.data[0].contextWindow, 1048576);
    assert.equal(payload.data[0].apiBackend, 'chat_completions');
    assert.equal(payload.data[0].baseUrl, 'https://aiko.example/v1');
});

test('rewrites `best` to the bound upstream slug and forwards to Codegraff', async t => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    let seen;
    globalThis.fetch = async (url, init) => {
        seen = { url: String(url), body: init.body ? new TextDecoder().decode(init.body) : null };
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
    };

    await worker.fetch(request('/v1/chat/completions', {
        method: 'POST',
        body: '{"model":"best","stream":true,"messages":[{"role":"user","content":"hi"}]}',
        headers: { 'content-type': 'application/json' },
    }), env);

    assert.equal(seen.url, 'https://gateway.codegraff.com/v1/chat/completions');
    const forwarded = JSON.parse(seen.body);
    assert.equal(forwarded.model, 'muse-spark-1.2-contributor');
    // The rest of the request survives the rewrite untouched.
    assert.equal(forwarded.stream, true);
    assert.deepEqual(forwarded.messages, [{ role: 'user', content: 'hi' }]);
});

test('older clients pinned to a previous default still resolve', async t => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    const bodies = [];
    globalThis.fetch = async (url, init) => {
        bodies.push(new TextDecoder().decode(init.body));
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
    };

    for (const legacy of ['deepseek-v4-pro', 'kimi-k3', 'auto', '']) {
        await worker.fetch(request('/v1/chat/completions', {
            method: 'POST',
            body: JSON.stringify({ model: legacy, messages: [] }),
            headers: { 'content-type': 'application/json' },
        }), env);
    }
    assert.equal(bodies.length, 4);
    for (const b of bodies) assert.equal(JSON.parse(b).model, 'muse-spark-1.2-contributor');
});

test('refuses a model the catalog does not publish, and never reaches upstream', async t => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    let upstreamCalled = false;
    globalThis.fetch = async () => { upstreamCalled = true; return new Response('{}'); };

    for (const model of ['anthropic/claude-opus-5', 'gpt-5.6', 'grok-4.3']) {
        const response = await worker.fetch(request('/v1/chat/completions', {
            method: 'POST',
            body: JSON.stringify({ model, messages: [] }),
            headers: { 'content-type': 'application/json' },
        }), env);
        assert.equal(response.status, 400, `${model} must be refused`);
        assert.match((await response.json()).error.message, /serves exactly one model: "best"/);
    }
    assert.equal(upstreamCalled, false);

    const missing = await worker.fetch(request('/v1/models/anthropic%2Fclaude-opus-5'), env);
    assert.equal(missing.status, 404);
});

test('the binding moves with BEST_MODEL, without a client release', async t => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    let seen;
    globalThis.fetch = async (url, init) => {
        seen = new TextDecoder().decode(init.body);
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
    };

    const rebound = { ...env, BEST_MODEL: 'muse-spark-1.3-contributor', BEST_CONTEXT_WINDOW: '2097152' };
    await worker.fetch(request('/v1/responses', {
        method: 'POST', body: '{"model":"best"}', headers: { 'content-type': 'application/json' },
    }), rebound);
    assert.equal(JSON.parse(seen).model, 'muse-spark-1.3-contributor');

    const listed = await (await worker.fetch(request('/v1/models'), rebound)).json();
    assert.equal(listed.data[0].contextWindow, 2097152);
});

test('leaves non-chat routes transparent so embeddings keep their own model', async t => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    let seen;
    globalThis.fetch = async (url, init) => {
        seen = { url: String(url), body: new TextDecoder().decode(init.body) };
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
    };

    await worker.fetch(request('/v1/embeddings', {
        method: 'POST',
        body: '{"model":"openai/text-embedding-3-small","input":"hi"}',
        headers: { 'content-type': 'application/json' },
    }), env);

    assert.equal(seen.url, 'https://gateway.codegraff.com/v1/embeddings');
    assert.equal(JSON.parse(seen.body).model, 'openai/text-embedding-3-small');
});

test('Codegraff is the only upstream — a missing key fails closed', async () => {
    const response = await worker.fetch(request('/v1/chat/completions', {
        method: 'POST', body: '{"model":"best"}', headers: { 'content-type': 'application/json' },
    }), { ISSUER_URL: env.ISSUER_URL });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error.message, /CODEGRAFF_API_KEY/);
});
