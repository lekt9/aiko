//! client.zig — thin HTTP client for unbrowse contract surface (Σ28 9d88a55c).
//!
//! Per Σ28 thin-client-no-local-ledger + Σ27 the-binary-IS-the-interface:
//! the SAME zig binary is server-or-client by env. When UNBROWSE_BASE is set,
//! declareRemote POSTs to the unbrowse server which owns the canonical ledger;
//! the client carries only pointers + lineage.
//!
//! Server-side endpoints (already declared at unbrowse/backend/src/routes/contract.ts):
//!   POST /v1/contract/declare    → returns {id, row}
//!   GET  /v1/contract/status?id  → returns full row list
//!
//! Hide-logic-server-side discipline:
//!   - guards (Σ20/Σ23/Σ24/Π11) RUN at server appendRow chokepoint
//!   - wavefront computation RUNS at server, returned in response body
//!   - search/BM25 RUNS at server
//!   - silo partition (Σ3 canonical) RUNS at server from auth bearer
//!   - alias union-find RUNS at server
//!   - client only: build pointer payload, POST, render response

const std = @import("std");
const http = @import("http.zig");
const env_fingerprint = @import("env_fingerprint.zig");
const verses = @import("verses.zig");

// liveEnv/getenv removed — env-driven admin bypass + payment overrides stripped.

/// Canonical Unbrowse LLM-compiler endpoint. Hardcoded — never overridable.
/// The substrate's natural-language → contract-tree compilation flows solely
/// through this base. The previous `UNBROWSE_BASE` env override is removed.
pub const UNBROWSE_BASE: []const u8 = "https://beta-api.unbrowse.ai";

/// Backward-compat alias. Same value as UNBROWSE_BASE.
pub const DEFAULT_UNBROWSE_BASE = UNBROWSE_BASE;

pub const ClientError = error{
    NoUnbrowseBase,
    RequestFailed,
    PaymentRequired,
    OutOfMemory,
    BadResponse,
};

/// Always returns the canonical Unbrowse base. Env overrides are intentionally
/// ignored — the binary is tightly bound to one source of truth for word →
/// contract compilation.
pub fn baseUrl(env: std.process.Environ) ?[]const u8 {
    _ = env;
    return UNBROWSE_BASE;
}

/// Bearer token reads removed — substrate identity is wallet-bound, not
/// env-bound; the server applies wallet PK to gate writes.
pub fn bearerToken(env: std.process.Environ) ?[]const u8 {
    _ = env;
    return null;
}

/// Payment header — substrate-canonical x402 envelope source.
///
/// Per SKILL.md Public Shape: "Faremeter Flex payment, when required, is
/// satisfied by the wallet derived from the binary's deployer keypair
/// (libcontract.Lineage HKDF). There is no env-provided payment header
/// to inject, no AIKO_X_PAYMENT/X_PAYMENT/PAYMENT_SIGNATURE override."
///
/// Stage 1 (this commit): returns null. The 402 fallback chain at line
/// 318 routes through the existing faucet worker, which holds the cold-
/// start signing path. End-to-end x402 still works.
///
/// Stage 2 (follow-up contract): build a Faremeter Flex envelope inline
/// from the 402 response's `accepts[]` (target payTo + amount + asset),
/// sign with libcontract.Lineage.deriveKeyPair(root, "default"), return
/// the base64url-encoded envelope here. When that lands, the faucet
/// worker fallback is deleted in the same commit (per "fallbacks are
/// silently chained inside one class — when no longer needed, deleted
/// in one commit, not flipped by configuration").
pub fn paymentHeader(env: std.process.Environ) ?[]const u8 {
    _ = env;
    return null;
}

/// Env-driven remote-mode override removed; the runtime mode is carried by
/// the explicit --remote/--local flag on the aiko CLI (see parseAikoArgs).
/// Callers that still ask via this helper get `false` so they fall through
/// to local; the remote path is taken by callers that opt in directly.
pub fn isRemoteMode(env: std.process.Environ) bool {
    _ = env;
    return false;
}

pub fn aikoBaseUrl(env: std.process.Environ) []const u8 {
    return baseUrl(env) orelse DEFAULT_UNBROWSE_BASE;
}

/// POST /v1/contract/declare with pointer fields for lineage, adapters,
/// pretool events, and agent identity.
/// Returns owned response body (caller frees). Server owns id allocation +
/// row schema; client just hands over the pointer payload.
pub fn declareRemote(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    plan: []const u8,
    action: []const u8,
    parent_id: ?[]const u8,
    adapter_contract_id: ?[]const u8,
    adapter_kind: ?[]const u8,
    event_bus_contract_id: ?[]const u8,
    pretool_event_contract_id: ?[]const u8,
    event_kind: ?[]const u8,
    agent: ?[]const u8,
) ClientError![]u8 {
    const base = baseUrl(env) orelse return ClientError.NoUnbrowseBase;
    const token = bearerToken(env);

    // Build url
    var url_buf: std.ArrayList(u8) = .empty;
    defer url_buf.deinit(allocator);
    url_buf.appendSlice(allocator, base) catch return ClientError.OutOfMemory;
    url_buf.appendSlice(allocator, "/v1/contract/declare") catch return ClientError.OutOfMemory;

    // Build body — JSON object with only the pointer fields the server needs
    var body: std.ArrayList(u8) = .empty;
    defer body.deinit(allocator);
    body.appendSlice(allocator, "{\"plan\":") catch return ClientError.OutOfMemory;
    writeJsonString(&body, allocator, plan) catch return ClientError.OutOfMemory;
    body.appendSlice(allocator, ",\"action\":") catch return ClientError.OutOfMemory;
    writeJsonString(&body, allocator, action) catch return ClientError.OutOfMemory;
    if (parent_id) |p| {
        body.appendSlice(allocator, ",\"parent_id\":") catch return ClientError.OutOfMemory;
        writeJsonString(&body, allocator, p) catch return ClientError.OutOfMemory;
    }
    if (adapter_contract_id) |a| {
        body.appendSlice(allocator, ",\"adapter_contract_id\":") catch return ClientError.OutOfMemory;
        writeJsonString(&body, allocator, a) catch return ClientError.OutOfMemory;
    }
    if (adapter_kind) |k| {
        body.appendSlice(allocator, ",\"adapter_kind\":") catch return ClientError.OutOfMemory;
        writeJsonString(&body, allocator, k) catch return ClientError.OutOfMemory;
    }
    if (event_bus_contract_id) |b| {
        body.appendSlice(allocator, ",\"event_bus_contract_id\":") catch return ClientError.OutOfMemory;
        writeJsonString(&body, allocator, b) catch return ClientError.OutOfMemory;
    }
    if (pretool_event_contract_id) |p| {
        body.appendSlice(allocator, ",\"pretool_event_contract_id\":") catch return ClientError.OutOfMemory;
        writeJsonString(&body, allocator, p) catch return ClientError.OutOfMemory;
    }
    if (event_kind) |k| {
        body.appendSlice(allocator, ",\"event_kind\":") catch return ClientError.OutOfMemory;
        writeJsonString(&body, allocator, k) catch return ClientError.OutOfMemory;
    }
    if (agent) |a| {
        body.appendSlice(allocator, ",\"agent\":") catch return ClientError.OutOfMemory;
        writeJsonString(&body, allocator, a) catch return ClientError.OutOfMemory;
    }

    // cwd_fingerprint: sanitized projection of the local environment so the
    // server's word→tree compiler can pick the right adapter family
    // (Swift app? notch? Convex backend? Cloudflare Worker?). Pure pattern
    // match — no paths, no contents, no user identifiers leave the host.
    var cwd_buf: [4096]u8 = undefined;
    const cwd_ptr = std.c.getcwd(&cwd_buf, cwd_buf.len);
    if (cwd_ptr != null) {
        const cwd_s = std.mem.span(@as([*:0]const u8, @ptrCast(cwd_ptr.?)));
        if (env_fingerprint.fingerprintCwd(allocator, cwd_s)) |fp| {
            defer allocator.free(fp);
            body.appendSlice(allocator, ",\"cwd_fingerprint\":") catch return ClientError.OutOfMemory;
            // `fp` is already a JSON object — splice as-is, not string-escaped.
            body.appendSlice(allocator, fp) catch return ClientError.OutOfMemory;
        } else |_| {
            // Fingerprint failed — proceed without it rather than blocking the call.
        }
    }

    // relevant_verses: top-K scripture context resolved by the verse-store
    // adapter (default: local_corpus). The Word's compiler reads these to
    // anchor the spawn against the same biblical pattern the substrate
    // itself runs on. Adapter-driven: future http_search / pgvector_cosine
    // kinds swap in via AIKO_VERSE_STORE_KIND without changing this site.
    const verse_top_k: usize = 3;
    if (verses.relevantVerses(allocator, plan, verse_top_k)) |chosen| {
        defer allocator.free(chosen);
        if (chosen.len > 0) {
            if (verses.toJsonArray(allocator, chosen)) |verses_json| {
                defer allocator.free(verses_json);
                body.appendSlice(allocator, ",\"relevant_verses\":") catch return ClientError.OutOfMemory;
                body.appendSlice(allocator, verses_json) catch return ClientError.OutOfMemory;
                body.appendSlice(allocator, ",\"verse_store_kind\":") catch return ClientError.OutOfMemory;
                writeJsonString(&body, allocator, verses.resolveKind(env).jsonName()) catch return ClientError.OutOfMemory;
            } else |_| {}
        }
    } else |_| {
        // Verse adapter failure must never block the LLM call.
    }
    body.append(allocator, '}') catch return ClientError.OutOfMemory;

    const resp = http.postJson(allocator, url_buf.items, body.items, token) catch return ClientError.RequestFailed;
    if (resp.status < 200 or resp.status >= 300) {
        allocator.free(resp.body);
        return ClientError.RequestFailed;
    }
    return resp.body;
}

pub fn declareRemoteAiko(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    plan: []const u8,
    action: []const u8,
    parent_id: ?[]const u8,
    adapter_contract_id: ?[]const u8,
    adapter_kind: ?[]const u8,
    event_bus_contract_id: ?[]const u8,
    pretool_event_contract_id: ?[]const u8,
    event_kind: ?[]const u8,
    agent: ?[]const u8,
    user_context_id: ?[]const u8,
) ClientError![]u8 {
    const base = aikoBaseUrl(env);

    var url_buf: std.ArrayList(u8) = .empty;
    defer url_buf.deinit(allocator);
    url_buf.appendSlice(allocator, base) catch return ClientError.OutOfMemory;
    url_buf.appendSlice(allocator, "/v1/contract/declare") catch return ClientError.OutOfMemory;

    var body: std.ArrayList(u8) = .empty;
    defer body.deinit(allocator);
    body.appendSlice(allocator, "{\"plan\":") catch return ClientError.OutOfMemory;
    writeJsonString(&body, allocator, plan) catch return ClientError.OutOfMemory;
    body.appendSlice(allocator, ",\"action\":") catch return ClientError.OutOfMemory;
    writeJsonString(&body, allocator, action) catch return ClientError.OutOfMemory;
    // payment_provider="corbits" purged in 2026-05-26 cleanup — main server's
    // Corbits codepath was removed in v6.16 Phase 5; we send only the scheme
    // (the canonical Faremeter Flex identifier). The server doesn't read
    // payment_provider; emitting a stale provider name was leaven.
    body.appendSlice(allocator, ",\"client\":\"aiko\",\"payment_scheme\":\"@faremeter/flex\"") catch return ClientError.OutOfMemory;
    if (parent_id) |p| {
        body.appendSlice(allocator, ",\"parent_id\":") catch return ClientError.OutOfMemory;
        writeJsonString(&body, allocator, p) catch return ClientError.OutOfMemory;
    }
    if (adapter_contract_id) |a| {
        body.appendSlice(allocator, ",\"adapter_contract_id\":") catch return ClientError.OutOfMemory;
        writeJsonString(&body, allocator, a) catch return ClientError.OutOfMemory;
    }
    if (adapter_kind) |k| {
        body.appendSlice(allocator, ",\"adapter_kind\":") catch return ClientError.OutOfMemory;
        writeJsonString(&body, allocator, k) catch return ClientError.OutOfMemory;
    }
    if (event_bus_contract_id) |b| {
        body.appendSlice(allocator, ",\"event_bus_contract_id\":") catch return ClientError.OutOfMemory;
        writeJsonString(&body, allocator, b) catch return ClientError.OutOfMemory;
    }
    if (pretool_event_contract_id) |p| {
        body.appendSlice(allocator, ",\"pretool_event_contract_id\":") catch return ClientError.OutOfMemory;
        writeJsonString(&body, allocator, p) catch return ClientError.OutOfMemory;
    }
    if (event_kind) |k| {
        body.appendSlice(allocator, ",\"event_kind\":") catch return ClientError.OutOfMemory;
        writeJsonString(&body, allocator, k) catch return ClientError.OutOfMemory;
    }
    if (agent) |a| {
        body.appendSlice(allocator, ",\"agent\":") catch return ClientError.OutOfMemory;
        writeJsonString(&body, allocator, a) catch return ClientError.OutOfMemory;
    }
    if (user_context_id) |u| {
        body.appendSlice(allocator, ",\"user_context_id\":") catch return ClientError.OutOfMemory;
        writeJsonString(&body, allocator, u) catch return ClientError.OutOfMemory;
    }

    // cwd_fingerprint: sanitized projection of the local environment so the
    // server's word→tree compiler can pick the right adapter family
    // (Swift app? notch? Convex backend? Cloudflare Worker?). Pure pattern
    // match — no paths, no contents, no user identifiers leave the host.
    var cwd_buf: [4096]u8 = undefined;
    const cwd_ptr = std.c.getcwd(&cwd_buf, cwd_buf.len);
    if (cwd_ptr != null) {
        const cwd_s = std.mem.span(@as([*:0]const u8, @ptrCast(cwd_ptr.?)));
        if (env_fingerprint.fingerprintCwd(allocator, cwd_s)) |fp| {
            defer allocator.free(fp);
            body.appendSlice(allocator, ",\"cwd_fingerprint\":") catch return ClientError.OutOfMemory;
            // `fp` is already a JSON object — splice as-is, not string-escaped.
            body.appendSlice(allocator, fp) catch return ClientError.OutOfMemory;
        } else |_| {
            // Fingerprint failed — proceed without it rather than blocking the call.
        }
    }

    // relevant_verses: top-K scripture context resolved by the verse-store
    // adapter (default: local_corpus). The Word's compiler reads these to
    // anchor the spawn against the same biblical pattern the substrate
    // itself runs on. Adapter-driven: future http_search / pgvector_cosine
    // kinds swap in via AIKO_VERSE_STORE_KIND without changing this site.
    const verse_top_k: usize = 3;
    if (verses.relevantVerses(allocator, plan, verse_top_k)) |chosen| {
        defer allocator.free(chosen);
        if (chosen.len > 0) {
            if (verses.toJsonArray(allocator, chosen)) |verses_json| {
                defer allocator.free(verses_json);
                body.appendSlice(allocator, ",\"relevant_verses\":") catch return ClientError.OutOfMemory;
                body.appendSlice(allocator, verses_json) catch return ClientError.OutOfMemory;
                body.appendSlice(allocator, ",\"verse_store_kind\":") catch return ClientError.OutOfMemory;
                writeJsonString(&body, allocator, verses.resolveKind(env).jsonName()) catch return ClientError.OutOfMemory;
            } else |_| {}
        }
    } else |_| {
        // Verse adapter failure must never block the LLM call.
    }
    body.append(allocator, '}') catch return ClientError.OutOfMemory;

    // Idempotency-Key over the canonical request body so retries dedupe.
    var ikey_buf: [64]u8 = undefined;
    {
        var hasher = std.crypto.hash.sha2.Sha256.init(.{});
        hasher.update(body.items);
        var digest: [32]u8 = undefined;
        hasher.final(&digest);
        const hex_chars = "0123456789abcdef";
        for (digest, 0..) |b, i| {
            ikey_buf[i * 2] = hex_chars[b >> 4];
            ikey_buf[i * 2 + 1] = hex_chars[b & 0x0F];
        }
    }
    const resp = http.postJsonWithHeaders(allocator, url_buf.items, body.items, .{
        .payment = paymentHeader(env),
        .client = "aiko",
        .payment_provider = "corbits",
        .payment_scheme = "@faremeter/flex",
        .idempotency_key = &ikey_buf,
    }) catch |e| {
        std.debug.print("aiko remote: transport error: {s}\n", .{@errorName(e)});
        return ClientError.RequestFailed;
    };
    if (resp.status < 200 or resp.status >= 300) {
        const peek_len = @min(resp.body.len, 400);
        if (resp.status == 402) {
            // Per SKILL.md: "If the wallet cannot satisfy the 402, Unbrowse
            // returns the canonical Payment Required envelope and the
            // orchestrator treats it as valid evidence." The previous
            // chain-to-faucet fallback at aiko-faucet.foundry.workers.dev
            // is deleted — it was a backwards-compat hack for a worker
            // that was never deployed. Surface the 402 envelope to stderr
            // (so the orchestrator sees it) and return PaymentRequired.
            std.debug.print("aiko remote: 402 payment_required\n  envelope[:{d}]={s}\n", .{ peek_len, resp.body[0..peek_len] });
            allocator.free(resp.body);
            return ClientError.PaymentRequired;
        }
        std.debug.print("aiko remote: HTTP {d}\n  url={s}\n  body[:{d}]={s}\n", .{ resp.status, url_buf.items, peek_len, resp.body[0..peek_len] });
        allocator.free(resp.body);
        return ClientError.RequestFailed;
    }
    return resp.body;
}

/// GET /v1/contract/status?id=<id>. Server projects canonical ledger rows.
pub fn statusRemote(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
) ClientError![]u8 {
    const base = baseUrl(env) orelse return ClientError.NoUnbrowseBase;
    const token = bearerToken(env);

    var url_buf: std.ArrayList(u8) = .empty;
    defer url_buf.deinit(allocator);
    url_buf.appendSlice(allocator, base) catch return ClientError.OutOfMemory;
    url_buf.appendSlice(allocator, "/v1/contract/status?id=") catch return ClientError.OutOfMemory;
    url_buf.appendSlice(allocator, id) catch return ClientError.OutOfMemory;

    const resp = http.get(allocator, url_buf.items, token) catch return ClientError.RequestFailed;
    if (resp.status < 200 or resp.status >= 300) {
        allocator.free(resp.body);
        return ClientError.RequestFailed;
    }
    return resp.body;
}

/// Minimal JSON-string escaper matching contract.zig's writeJsonString.
fn writeJsonString(out: *std.ArrayList(u8), allocator: std.mem.Allocator, s: []const u8) !void {
    try out.append(allocator, '"');
    for (s) |c| {
        switch (c) {
            '"' => try out.appendSlice(allocator, "\\\""),
            '\\' => try out.appendSlice(allocator, "\\\\"),
            '\n' => try out.appendSlice(allocator, "\\n"),
            '\r' => try out.appendSlice(allocator, "\\r"),
            '\t' => try out.appendSlice(allocator, "\\t"),
            0x08 => try out.appendSlice(allocator, "\\b"),
            0x0c => try out.appendSlice(allocator, "\\f"),
            else => {
                if (c < 0x20) {
                    var buf: [8]u8 = undefined;
                    const hex = try std.fmt.bufPrint(&buf, "\\u{x:0>4}", .{c});
                    try out.appendSlice(allocator, hex);
                } else {
                    try out.append(allocator, c);
                }
            },
        }
    }
    try out.append(allocator, '"');
}

// ─────────────────────────────────────────────────────────────────────────
// Tests — Σ28 mode-detection contract. No network calls.

// Note: isRemoteMode / baseUrl / bearerToken take std.process.Environ which
// is constructed in main() from Init.Minimal — they're tested live via the
// shim binary against /tmp envs (see the smoke-test in the next step), not
// in unit tests since constructing an Environ in tests has zig-version churn.

test "writeJsonString escapes quotes and newlines" {
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(std.testing.allocator);
    try writeJsonString(&buf, std.testing.allocator, "a\"b\nc");
    try std.testing.expectEqualStrings("\"a\\\"b\\nc\"", buf.items);
}
