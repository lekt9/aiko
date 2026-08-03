import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

const env = {
    SURPLUS_API_KEY: 'upstream-secret',
    ISSUER_URL: 'https://aiko.theclarityproject.net',
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

    assert.equal(seen.url, 'https://api.surplusintelligence.ai/v1/uploads/u_1/parts?purpose=batch');
    assert.equal(seen.init.headers.get('authorization'), 'Bearer upstream-secret');
    assert.equal(seen.init.headers.get('x-aiko-user-id'), 'user-1');
    assert.equal(seen.init.headers.get('x-aiko-team-id'), 'team-1');
    assert.equal(seen.init.headers.get('openai-beta'), 'assistants=v2');
    assert.equal(seen.init.headers.get('idempotency-key'), 'idem-1');
    assert.equal(seen.init.headers.get('content-type'), 'application/octet-stream');
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('x-request-id'), 'req_123');
    assert.equal(response.headers.get('openai-processing-ms'), '42');
    assert.equal(response.headers.get('x-ratelimit-remaining-requests'), '9');
});

test('normalizes Azure-style /openai/v1 without losing the endpoint', async t => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    let seenUrl;
    globalThis.fetch = async url => { seenUrl = url; return new Response('{}'); };
    await worker.fetch(request('/openai/v1/responses/r_1?include=output'), env);
    assert.equal(seenUrl, 'https://api.surplusintelligence.ai/v1/responses/r_1?include=output');
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
