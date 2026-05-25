//! client.zig — thin HTTP client for unbrowse contract surface (Σ28 9d88a55c).
//!
//! Per Σ28 thin-client-no-local-ledger + Σ27 the-binary-IS-the-interface:
//! the SAME zig binary is server-or-client by env. When UNBROWSE_BASE is set,
//! declareRemote / markSatisfiedRemote POST to the unbrowse server which
//! owns the canonical ledger; the client carries only pointers + lineage.
//!
//! Server-side endpoints (already declared at unbrowse/backend/src/routes/contract.ts):
//!   POST /v1/contract/declare    → returns {id, row}
//!   POST /v1/contract/iterate    → returns {id, wave, action_result, ...}
//!   POST /v1/contract/mark       → returns {id, satisfied}
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

pub const ClientError = error{
    NoUnbrowseBase,
    RequestFailed,
    OutOfMemory,
    BadResponse,
};

/// Get UNBROWSE_BASE from env; returns null in offline mode (Σ28 transient cache).
pub fn baseUrl(env: std.process.Environ) ?[]const u8 {
    return env.getPosix("UNBROWSE_BASE");
}

/// Get UNBROWSE_API_KEY bearer token, if present.
pub fn bearerToken(env: std.process.Environ) ?[]const u8 {
    return env.getPosix("UNBROWSE_API_KEY");
}

/// Whether the binary is in thin-client mode (remote ledger).
pub fn isRemoteMode(env: std.process.Environ) bool {
    return baseUrl(env) != null;
}

/// POST /v1/contract/declare with {plan, action, parent_id?, agent?}.
/// Returns owned response body (caller frees). Server owns id allocation +
/// row schema; client just hands over the pointer payload.
pub fn declareRemote(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    plan: []const u8,
    action: []const u8,
    parent_id: ?[]const u8,
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
    if (agent) |a| {
        body.appendSlice(allocator, ",\"agent\":") catch return ClientError.OutOfMemory;
        writeJsonString(&body, allocator, a) catch return ClientError.OutOfMemory;
    }
    body.append(allocator, '}') catch return ClientError.OutOfMemory;

    const resp = http.postJson(allocator, url_buf.items, body.items, token) catch return ClientError.RequestFailed;
    if (resp.status < 200 or resp.status >= 300) {
        allocator.free(resp.body);
        return ClientError.RequestFailed;
    }
    return resp.body;
}

/// POST /v1/contract/iterate with {id, agent?, local_result?}.
pub fn iterateRemote(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
    agent: ?[]const u8,
) ClientError![]u8 {
    const base = baseUrl(env) orelse return ClientError.NoUnbrowseBase;
    const token = bearerToken(env);

    var url_buf: std.ArrayList(u8) = .empty;
    defer url_buf.deinit(allocator);
    url_buf.appendSlice(allocator, base) catch return ClientError.OutOfMemory;
    url_buf.appendSlice(allocator, "/v1/contract/iterate") catch return ClientError.OutOfMemory;

    var body: std.ArrayList(u8) = .empty;
    defer body.deinit(allocator);
    body.appendSlice(allocator, "{\"id\":") catch return ClientError.OutOfMemory;
    writeJsonString(&body, allocator, id) catch return ClientError.OutOfMemory;
    if (agent) |a| {
        body.appendSlice(allocator, ",\"agent\":") catch return ClientError.OutOfMemory;
        writeJsonString(&body, allocator, a) catch return ClientError.OutOfMemory;
    }
    body.append(allocator, '}') catch return ClientError.OutOfMemory;

    const resp = http.postJson(allocator, url_buf.items, body.items, token) catch return ClientError.RequestFailed;
    if (resp.status < 200 or resp.status >= 300) {
        allocator.free(resp.body);
        return ClientError.RequestFailed;
    }
    return resp.body;
}

/// POST /v1/contract/mark with {id, proof?, proof_skip?}.
pub fn markSatisfiedRemote(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
    proof: ?[]const u8,
) ClientError![]u8 {
    const base = baseUrl(env) orelse return ClientError.NoUnbrowseBase;
    const token = bearerToken(env);

    var url_buf: std.ArrayList(u8) = .empty;
    defer url_buf.deinit(allocator);
    url_buf.appendSlice(allocator, base) catch return ClientError.OutOfMemory;
    url_buf.appendSlice(allocator, "/v1/contract/mark") catch return ClientError.OutOfMemory;

    var body: std.ArrayList(u8) = .empty;
    defer body.deinit(allocator);
    body.appendSlice(allocator, "{\"id\":") catch return ClientError.OutOfMemory;
    writeJsonString(&body, allocator, id) catch return ClientError.OutOfMemory;
    if (proof) |p| {
        body.appendSlice(allocator, ",\"proof\":") catch return ClientError.OutOfMemory;
        writeJsonString(&body, allocator, p) catch return ClientError.OutOfMemory;
    }
    body.append(allocator, '}') catch return ClientError.OutOfMemory;

    const resp = http.postJson(allocator, url_buf.items, body.items, token) catch return ClientError.RequestFailed;
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

test "isRemoteMode true when UNBROWSE_BASE set, false otherwise" {
    // We can't easily mutate the live env in zig tests without poking libc setenv.
    // Instead: assert the function compiles + returns bool consistent with env lookup.
    // Real wire tests run via the shim binary against /tmp envs.
    const env = std.process.Environ.init();
    const present = env.getPosix("UNBROWSE_BASE") != null;
    try std.testing.expectEqual(present, isRemoteMode(env));
}

test "writeJsonString escapes quotes and newlines" {
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(std.testing.allocator);
    try writeJsonString(&buf, std.testing.allocator, "a\"b\nc");
    try std.testing.expectEqualStrings("\"a\\\"b\\nc\"", buf.items);
}
