import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

const env = {
    CODEGRAFF_API_KEY: 'cg_sk_test',
    SURPLUS_API_KEY: 'inf_test',
    ISSUER_URL: 'https://aiko.theclarityproject.net',
    CODEGRAFF_URL: 'https://gateway.codegraff.com',
    TARGET_URL: 'https://api.surplusintelligence.ai',
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

test('fails over to surplus when codegraff returns 503', async t => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    const seen = [];
    globalThis.fetch = async (url, init) => {
        seen.push({ url: String(url), auth: init.headers.get('authorization') });
        if (String(url).includes('gateway.codegraff.com')) {
            return new Response('busy', { status: 503 });
        }
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const response = await worker.fetch(request('/v1/chat/completions', {
        method: 'POST', body: '{"model":"deepseek-v4-pro"}', headers: { 'content-type': 'application/json' },
    }), env);
    assert.equal(response.status, 200);
    assert.ok(seen.some(s => s.url.includes('gateway.codegraff.com')));
    assert.ok(seen.some(s => s.url.includes('api.surplusintelligence.ai') && s.auth === 'Bearer inf_test'));
    assert.equal(response.headers.get('x-aiko-upstream'), 'surplus');
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

// ── Difficulty routing ──────────────────────────────────────────────────────

const routingEnv = { ...env, HARD_ROUTING: '1', EASY_MODELS: 'deepseek-v4-flash', HARD_MODEL: 'deepseek-v4-pro' };

async function forwardedBody(reqInit, useEnv = routingEnv) {
    const originalFetch = globalThis.fetch;
    let seen;
    globalThis.fetch = async (url, init) => {
        seen = { url: String(url), body: init.body ? new TextDecoder().decode(init.body) : null };
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
        const resp = await worker.fetch(request('/v1/chat/completions', {
            method: 'POST', headers: { 'content-type': 'application/json', ...(reqInit.headers || {}) },
            body: reqInit.body,
        }), useEnv);
        return { model: seen.body ? JSON.parse(seen.body).model : null, resp };
    } finally {
        globalThis.fetch = originalFetch;
    }
}

test('escalates a hard task (code / multi-step) to the strong model', async () => {
    const { model, resp } = await forwardedBody({
        body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [
            { role: 'user', content: 'Refactor this function and explain the complexity trade-offs:\n```js\nfunction f(){}\n```' },
        ] }),
    });
    assert.equal(model, 'deepseek-v4-pro');
    assert.equal(resp.headers.get('x-aiko-routed-model'), 'deepseek-v4-pro');
});

test('leaves an easy task on the cheap model', async () => {
    const { model, resp } = await forwardedBody({
        body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [
            { role: 'user', content: 'Translate "hello" to French.' },
        ] }),
    });
    assert.equal(model, 'deepseek-v4-flash');
    assert.equal(resp.headers.get('x-aiko-routed-model'), null);
});

test('caller tag overrides the heuristic in both directions', async () => {
    // Tag=easy keeps a code prompt cheap.
    const easy = await forwardedBody({
        headers: { 'x-aiko-difficulty': 'easy' },
        body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: '```py\nprint(1)\n```' }] }),
    });
    assert.equal(easy.model, 'deepseek-v4-flash');
    // Tag=hard escalates a trivial prompt.
    const hard = await forwardedBody({
        headers: { 'x-aiko-difficulty': 'hard' },
        body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(hard.model, 'deepseek-v4-pro');
});

test('never rewrites a model outside EASY_MODELS (no accidental downgrade/upgrade)', async () => {
    const { model } = await forwardedBody({
        body: JSON.stringify({ model: 'grok-4.5', messages: [{ role: 'user', content: 'prove that P=NP step by step' }] }),
    });
    assert.equal(model, 'grok-4.5');
});

test('is a no-op when HARD_ROUTING is off', async () => {
    const { model } = await forwardedBody({
        body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'debug this race condition' }] }),
    }, { ...env });  // HARD_ROUTING unset
    assert.equal(model, 'deepseek-v4-flash');
});

test('passes a non-JSON body through untouched even with routing on', async () => {
    const originalFetch = globalThis.fetch;
    let seenBody;
    globalThis.fetch = async (url, init) => {
        seenBody = init.body;
        return new Response('{}', { status: 200 });
    };
    try {
        const raw = new Uint8Array([1, 2, 3, 4]);
        await worker.fetch(request('/v1/chat/completions', {
            method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: raw,
        }), routingEnv);
        assert.deepEqual(new Uint8Array(seenBody), raw);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
