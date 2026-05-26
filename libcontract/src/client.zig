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
// Route shared low-level files through the contract module (one canonical
// owner) so Zig 0.16's "file ∈ one module" rule is honored. Direct file
// imports here would create duplicates across the contract / contract_client
// module boundary.
const contract_mod = @import("contract");
const http = contract_mod.http;
const env_fingerprint = contract_mod.env_fingerprint;
const verses = contract_mod.verses;
const lineage = contract_mod.lineage;

// liveEnv/getenv removed — env-driven admin bypass + payment overrides stripped.

/// Canonical Unbrowse LLM-compiler endpoint. Hardcoded — never overridable.
/// The substrate's natural-language → contract-tree compilation flows solely
/// through this base. The previous `UNBROWSE_BASE` env override is removed.
pub const UNBROWSE_BASE: []const u8 = "https://beta-api.unbrowse.ai";

/// Backward-compat alias. Same value as UNBROWSE_BASE.
pub const DEFAULT_UNBROWSE_BASE = UNBROWSE_BASE;

/// Foundry-operated faucet worker. On 402 from UNBROWSE_BASE, the substrate
/// chains the same declare body here. The faucet rate-limits per IP, then
/// either drops USDC into the caller's deployer wallet via /v1/faucet/claim
/// (the Manna pattern) or auto-signs the x402 envelope from a shared
/// FAUCET_PRIVATE_KEY. Either path makes the declare land on EmergentDB
/// without the user ever seeing the seam. See
/// ~/.agent-skills/contract/deploy/wrangler/aiko-faucet/ for the worker.
pub const AIKO_FAUCET_URL: []const u8 =
    "https://aiko-faucet.lewis-6d8.workers.dev/v1/contract/declare";

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
/// Current state: returns null (caller-side payment header is forbidden
/// per "no env-provided payment header" doctrine). On 402, declareRemoteAiko
/// chains the same body to AIKO_FAUCET_URL (the Foundry-operated faucet
/// worker at aiko-faucet.lewis-6d8.workers.dev). The faucet rate-limits by
/// IP and either onramps the caller's wallet or auto-signs the envelope
/// from its own FAUCET_PRIVATE_KEY. Long-term auto-resolution of cold-wallet
/// declares lands them on EmergentDB without the user seeing the 402 seam.
///
/// Pending: inline Faremeter Flex / x402-exact envelope construction
/// from the 402 response's `accepts[]` (target payTo + amount + asset),
/// signed with deriveKeyPair(root, "aiko-payment-wallet"). Requires
/// Solana SPL token transfer transaction construction in Zig — tracked
/// as its own substrate contract.
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
        } else |err| {
            // Fingerprint failed — declare proceeds without it. Surface per
            // "fallbacks are visible, never silent" doctrine (SKILL.md).
            std.debug.print("env_fingerprint: fingerprintCwd failed: {s} — declare proceeds without cwd_fingerprint\n", .{@errorName(err)});
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
            } else |err| {
                std.debug.print("verses: toJsonArray failed: {s} — LLM call proceeds without relevant_verses field\n", .{@errorName(err)});
            }
        }
    } else |err| {
        std.debug.print("verses: relevantVerses failed: {s} — LLM call proceeds without verse RAG context\n", .{@errorName(err)});
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
) ClientError![]u8 {
    const base = aikoBaseUrl(env);

    var url_buf: std.ArrayList(u8) = .empty;
    defer url_buf.deinit(allocator);
    url_buf.appendSlice(allocator, base) catch return ClientError.OutOfMemory;
    url_buf.appendSlice(allocator, "/v1/contract/declare") catch return ClientError.OutOfMemory;

    // ─── Signed-declare prep — SKILL.md "Lineage is server-determined" ───
    //
    // The cloud reconstructs containment from wallet identity + declare
    // timestamp. The binary advertises both, signed with the deployer
    // keypair's HKDF-derived "aiko-declare-identity" subkey. Server
    // verifies via declare-signature.ts; on success the row is trusted
    // and the wallet identity is bound to it for onramp routing.
    //
    // No env hatches — wallet is derived from root.key per the three-tier
    // bootstrap; signing is deterministic given the root + the identity
    // string. Same caller, same wallet, every invocation.
    const root = lineage.loadOrInitRootKey(allocator, env) catch |e| {
        std.debug.print("aiko declare: loadOrInitRootKey failed: {s} — wallet bootstrap required for signed declare per SKILL.md\n", .{@errorName(e)});
        return ClientError.RequestFailed;
    };
    const declare_kp = lineage.deriveKeyPair(root, "aiko-declare-identity") catch |e| {
        std.debug.print("aiko declare: deriveKeyPair failed: {s}\n", .{@errorName(e)});
        return ClientError.RequestFailed;
    };
    var wid_hex: [64]u8 = undefined;
    lineage.bytesToHex(&declare_kp.public_key.bytes, &wid_hex);

    // ts — ISO 8601 UTC with us precision. Server reads req.ts verbatim
    // for canonical-body reconstruction, so client and server agree on
    // the exact string we just generated.
    var ts_buf: [32]u8 = undefined;
    const ts = nowIsoUtc(&ts_buf) catch |e| {
        std.debug.print("aiko declare: nowIsoUtc failed: {s}\n", .{@errorName(e)});
        return ClientError.RequestFailed;
    };

    // Canonical body — byte-for-byte match of server's canonicalizeDeclareBody
    // (declare-signature.ts): JSON.stringify with the six keys in fixed order,
    // null literals for missing parent_id/agent.
    var canon: std.ArrayList(u8) = .empty;
    defer canon.deinit(allocator);
    buildCanonicalDeclareBody(&canon, allocator, plan, action, parent_id, agent, &wid_hex, ts) catch return ClientError.OutOfMemory;

    // Sign the canonical bytes with ed25519.
    const sig = declare_kp.sign(canon.items, null) catch |e| {
        std.debug.print("aiko declare: sign failed: {s}\n", .{@errorName(e)});
        return ClientError.RequestFailed;
    };
    var sig_hex: [128]u8 = undefined;
    lineage.bytesToHex(&sig.toBytes(), &sig_hex);

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
        } else |err| {
            // Fingerprint failed — declare proceeds without it. Surface per
            // "fallbacks are visible, never silent" doctrine (SKILL.md).
            std.debug.print("env_fingerprint: fingerprintCwd failed: {s} — declare proceeds without cwd_fingerprint\n", .{@errorName(err)});
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
            } else |err| {
                std.debug.print("verses: toJsonArray failed: {s} — LLM call proceeds without relevant_verses field\n", .{@errorName(err)});
            }
        }
    } else |err| {
        std.debug.print("verses: relevantVerses failed: {s} — LLM call proceeds without verse RAG context\n", .{@errorName(err)});
    }

    // Signed-declare wire fields. The server's gate at /v1/contract/declare
    // (routes/contract.ts:509) verifies declare_signature against the
    // canonical body reconstructed from these fields. Same bytes the binary
    // just signed above.
    body.appendSlice(allocator, ",\"wallet_identity\":") catch return ClientError.OutOfMemory;
    writeJsonString(&body, allocator, &wid_hex) catch return ClientError.OutOfMemory;
    body.appendSlice(allocator, ",\"declare_signature\":") catch return ClientError.OutOfMemory;
    writeJsonString(&body, allocator, &sig_hex) catch return ClientError.OutOfMemory;
    body.appendSlice(allocator, ",\"ts\":") catch return ClientError.OutOfMemory;
    writeJsonString(&body, allocator, ts) catch return ClientError.OutOfMemory;

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
        .payment_scheme = "@faremeter/flex",
        .idempotency_key = &ikey_buf,
    }) catch |e| {
        std.debug.print("aiko remote: transport error: {s}\n", .{@errorName(e)});
        return ClientError.RequestFailed;
    };
    if (resp.status < 200 or resp.status >= 300) {
        const peek_len = @min(resp.body.len, 400);
        if (resp.status == 402) {
            // Native onramp chain (per SKILL.md "Native onramp is the cloud's
            // obligation"): the substrate chains the same declare body to the
            // Foundry-operated faucet worker, which rate-limits by IP and
            // either onramps the caller's wallet (via /v1/faucet/claim) and
            // retries, or auto-signs the x402 envelope from a shared
            // FAUCET_PRIVATE_KEY. On faucet success, the declare row lands
            // on EmergentDB exactly as if the caller's wallet had paid.
            // On faucet failure, surface BOTH envelopes and PaymentRequired.
            std.debug.print("aiko remote: 402 — chaining to faucet at {s}\n", .{AIKO_FAUCET_URL});
            const original_envelope = resp.body;
            defer allocator.free(original_envelope);
            const fbody = fbody: {
                // Re-issue the same body to the faucet's /v1/contract/declare.
                // The faucet IS a /v1/contract/declare proxy — same path,
                // different host. Use a small helper to avoid duplicating the
                // POST scaffolding.
                const f_resp = http.postJsonWithHeaders(allocator, AIKO_FAUCET_URL, body.items, .{
                    .client = "aiko",
                    .payment = headers.payment,
                    .payment_provider = headers.payment_provider,
                    .payment_scheme = headers.payment_scheme,
                }) catch |e| {
                    std.debug.print("aiko remote: faucet request error: {s}\n", .{@errorName(e)});
                    break :fbody null;
                };
                if (f_resp.status >= 200 and f_resp.status < 300) {
                    std.debug.print("aiko remote: faucet onramp ok (HTTP {d})\n", .{f_resp.status});
                    break :fbody f_resp.body;
                }
                const f_peek = @min(f_resp.body.len, 400);
                std.debug.print("aiko remote: faucet HTTP {d}\n  body[:{d}]={s}\n", .{ f_resp.status, f_peek, f_resp.body[0..f_peek] });
                allocator.free(f_resp.body);
                break :fbody null;
            };
            if (fbody) |fb| return fb;
            std.debug.print("aiko remote: 402 payment_required\n  envelope[:{d}]={s}\n", .{ peek_len, original_envelope[0..peek_len] });
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

/// Format current UTC time as ISO 8601 with microsecond precision —
/// matches the shape `new Date().toISOString()` produces (though with us
/// precision instead of ms; server reads our ts verbatim so both sides
/// agree on the bytes). Inlined here because libcontract's module
/// topology forbids client.zig importing contract.zig.
fn nowIsoUtc(buf: []u8) ![]u8 {
    var tv: std.c.timeval = undefined;
    _ = std.c.gettimeofday(&tv, null);
    const secs_total: i64 = @intCast(tv.sec);
    const us_remainder: i64 = @intCast(tv.usec);
    const epoch_secs = std.time.epoch.EpochSeconds{ .secs = @intCast(secs_total) };
    const epoch_day = epoch_secs.getEpochDay();
    const year_day = epoch_day.calculateYearDay();
    const month_day = year_day.calculateMonthDay();
    const day_secs = epoch_secs.getDaySeconds();
    return try std.fmt.bufPrint(buf, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.{d:0>6}Z", .{
        year_day.year,
        month_day.month.numeric(),
        month_day.day_index + 1,
        day_secs.getHoursIntoDay(),
        day_secs.getMinutesIntoHour(),
        day_secs.getSecondsIntoMinute(),
        @as(u64, @intCast(us_remainder)),
    });
}

/// Build the canonical signed body for a declare. Byte-for-byte match of
/// the server's canonicalizeDeclareBody (unbrowse-dev/backend/src/services/
/// declare-signature.ts): JSON.stringify with the six keys in fixed order
/// (plan, action, parent_id, agent, wallet_identity, ts), null literals
/// for missing parent_id/agent.
///
/// Same Zig writeJsonString escape rules used in the request body — both
/// sides agree on the bytes-on-wire, so ed25519 verification round-trips.
fn buildCanonicalDeclareBody(
    out: *std.ArrayList(u8),
    allocator: std.mem.Allocator,
    plan: []const u8,
    action: []const u8,
    parent_id: ?[]const u8,
    agent: ?[]const u8,
    wallet_identity_hex: []const u8,
    ts: []const u8,
) !void {
    try out.append(allocator, '{');
    try out.appendSlice(allocator, "\"plan\":");
    try writeJsonString(out, allocator, plan);
    try out.appendSlice(allocator, ",\"action\":");
    try writeJsonString(out, allocator, action);
    try out.appendSlice(allocator, ",\"parent_id\":");
    if (parent_id) |p| {
        try writeJsonString(out, allocator, p);
    } else {
        try out.appendSlice(allocator, "null");
    }
    try out.appendSlice(allocator, ",\"agent\":");
    if (agent) |a| {
        try writeJsonString(out, allocator, a);
    } else {
        try out.appendSlice(allocator, "null");
    }
    try out.appendSlice(allocator, ",\"wallet_identity\":");
    try writeJsonString(out, allocator, wallet_identity_hex);
    try out.appendSlice(allocator, ",\"ts\":");
    try writeJsonString(out, allocator, ts);
    try out.append(allocator, '}');
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
