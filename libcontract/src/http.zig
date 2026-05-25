//! http.zig — minimal HTTP client for thin-client mode (Σ28 9d88a55c).
//!
//! Per Σ28 thin-client-no-local-ledger: when UNBROWSE_BASE is set, the
//! binary sends public contract operations to the unbrowse server instead of
//! appending locally. Server owns the canonical ledger; client holds only
//! pointers + lineage.
//!
//! This module shells to libcurl via popen so we stay in pure libc
//! (no std.http API churn between zig versions, no dyld deps beyond what
//! macOS / linux ship by default).

const std = @import("std");

extern fn popen(cmd: [*:0]const u8, mode: [*:0]const u8) ?*anyopaque;
extern fn pclose(stream: *anyopaque) c_int;
extern fn fread(ptr: [*]u8, size: usize, nmemb: usize, stream: *anyopaque) usize;

pub const HttpError = error{
    CurlMissing,
    CurlFailed,
    BadResponse,
    OutOfMemory,
};

pub const Response = struct {
    status: u16,
    body: []u8, // owned by caller
};

pub const Headers = struct {
    bearer_token: ?[]const u8 = null,
    payment: ?[]const u8 = null,
    client: ?[]const u8 = null,
    payment_provider: ?[]const u8 = null,
    payment_scheme: ?[]const u8 = null,
    idempotency_key: ?[]const u8 = null,
    /// Admin bypass: pubkey of the identity that wants 402 skipped.
    /// Server checks against hardcoded allowlist before granting bypass.
    admin_pubkey: ?[]const u8 = null,
    /// Admin signature: ed25519 sig over `aiko-admin-bypass\0<ts>` where
    /// ts is unix seconds in admin_ts. Validates the admin_pubkey claim.
    admin_signature: ?[]const u8 = null,
    admin_ts: ?[]const u8 = null,
};

/// POST JSON body to url. Returns owned Response.body (caller frees).
/// Adds Authorization: Bearer <token> when token != null.
/// Status is parsed from the trailing line `__STATUS__:NNN` we tell curl
/// to write — keeps parsing simple, no separate header pass.
pub fn postJson(
    allocator: std.mem.Allocator,
    url: []const u8,
    body: []const u8,
    token: ?[]const u8,
) HttpError!Response {
    return postJsonWithHeaders(allocator, url, body, .{ .bearer_token = token });
}

pub fn postJsonWithHeaders(
    allocator: std.mem.Allocator,
    url: []const u8,
    body: []const u8,
    headers: Headers,
) HttpError!Response {
    // Build curl command:
    //   curl -sS -X POST -H 'Content-Type: application/json' -H 'Authorization: Bearer ...'
    //        -d @- -w '\n__STATUS__:%{http_code}\n' <url>
    // Body comes via stdin (-d @-) which we wire through a shell heredoc — but
    // popen only gives us read OR write, not both, so we instead write body
    // to a temp file and pass it as -d @<file>.
    var tmp_buf: [256]u8 = undefined;
    const tmp_path = std.fmt.bufPrintZ(&tmp_buf, "/tmp/contract-http-{d}.json", .{std.c.getpid()}) catch return HttpError.OutOfMemory;
    {
        const fd = std.c.open(tmp_path.ptr, .{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = true }, @as(std.c.mode_t, 0o600));
        if (fd < 0) return HttpError.CurlFailed;
        defer _ = std.c.close(fd);
        var written: usize = 0;
        while (written < body.len) {
            const n = std.c.write(fd, body.ptr + written, body.len - written);
            if (n <= 0) return HttpError.CurlFailed;
            written += @intCast(n);
        }
    }

    var cmd_buf: std.ArrayList(u8) = .empty;
    defer cmd_buf.deinit(allocator);
    cmd_buf.appendSlice(allocator, "curl -sS -X POST -H 'Content-Type: application/json' ") catch return HttpError.OutOfMemory;
    if (headers.bearer_token) |t| {
        cmd_buf.appendSlice(allocator, "-H 'Authorization: Bearer ") catch return HttpError.OutOfMemory;
        // Naive escape — assume token has no single quotes (unbrowse keys don't).
        cmd_buf.appendSlice(allocator, t) catch return HttpError.OutOfMemory;
        cmd_buf.appendSlice(allocator, "' ") catch return HttpError.OutOfMemory;
    }
    if (headers.payment) |p| {
        cmd_buf.appendSlice(allocator, "-H 'X-PAYMENT: ") catch return HttpError.OutOfMemory;
        cmd_buf.appendSlice(allocator, p) catch return HttpError.OutOfMemory;
        cmd_buf.appendSlice(allocator, "' ") catch return HttpError.OutOfMemory;
    }
    if (headers.client) |c| {
        cmd_buf.appendSlice(allocator, "-H 'X-Unbrowse-Contract-Client: ") catch return HttpError.OutOfMemory;
        cmd_buf.appendSlice(allocator, c) catch return HttpError.OutOfMemory;
        cmd_buf.appendSlice(allocator, "' ") catch return HttpError.OutOfMemory;
    }
    if (headers.payment_provider) |p| {
        cmd_buf.appendSlice(allocator, "-H 'X-Payment-Provider: ") catch return HttpError.OutOfMemory;
        cmd_buf.appendSlice(allocator, p) catch return HttpError.OutOfMemory;
        cmd_buf.appendSlice(allocator, "' ") catch return HttpError.OutOfMemory;
    }
    if (headers.payment_scheme) |s| {
        cmd_buf.appendSlice(allocator, "-H 'X-Payment-Scheme: ") catch return HttpError.OutOfMemory;
        cmd_buf.appendSlice(allocator, s) catch return HttpError.OutOfMemory;
        cmd_buf.appendSlice(allocator, "' ") catch return HttpError.OutOfMemory;
    }
    if (headers.idempotency_key) |k| {
        cmd_buf.appendSlice(allocator, "-H 'Idempotency-Key: ") catch return HttpError.OutOfMemory;
        cmd_buf.appendSlice(allocator, k) catch return HttpError.OutOfMemory;
        cmd_buf.appendSlice(allocator, "' ") catch return HttpError.OutOfMemory;
    }
    cmd_buf.appendSlice(allocator, "-d @") catch return HttpError.OutOfMemory;
    cmd_buf.appendSlice(allocator, tmp_path) catch return HttpError.OutOfMemory;
    cmd_buf.appendSlice(allocator, " -w '\\n__STATUS__:%{http_code}\\n' ") catch return HttpError.OutOfMemory;
    // url — assume no shell-meta chars (we control the URL prefix).
    cmd_buf.append(allocator, '\'') catch return HttpError.OutOfMemory;
    cmd_buf.appendSlice(allocator, url) catch return HttpError.OutOfMemory;
    cmd_buf.append(allocator, '\'') catch return HttpError.OutOfMemory;
    cmd_buf.append(allocator, 0) catch return HttpError.OutOfMemory;

    const cmd_z: [*:0]const u8 = @ptrCast(cmd_buf.items.ptr);
    const f = popen(cmd_z, "r") orelse return HttpError.CurlMissing;
    defer _ = pclose(f);

    var body_buf: std.ArrayList(u8) = .empty;
    errdefer body_buf.deinit(allocator);
    var chunk: [4096]u8 = undefined;
    while (true) {
        const got = fread(&chunk, 1, chunk.len, f);
        if (got == 0) break;
        body_buf.appendSlice(allocator, chunk[0..got]) catch return HttpError.OutOfMemory;
    }

    // Strip trailing __STATUS__:NNN line; parse status.
    const marker = "__STATUS__:";
    const at = std.mem.lastIndexOf(u8, body_buf.items, marker) orelse return HttpError.BadResponse;
    var status_end: usize = at + marker.len;
    while (status_end < body_buf.items.len and body_buf.items[status_end] >= '0' and body_buf.items[status_end] <= '9') status_end += 1;
    const status_str = body_buf.items[at + marker.len .. status_end];
    const status = std.fmt.parseInt(u16, status_str, 10) catch return HttpError.BadResponse;
    // Trim status line + the leading \n curl wrote.
    var end = at;
    if (end > 0 and body_buf.items[end - 1] == '\n') end -= 1;
    body_buf.shrinkRetainingCapacity(end);
    const owned = body_buf.toOwnedSlice(allocator) catch return HttpError.OutOfMemory;
    return .{ .status = status, .body = owned };
}

/// GET url. Returns owned Response.body (caller frees).
/// Adds Authorization: Bearer <token> when token != null.
pub fn get(
    allocator: std.mem.Allocator,
    url: []const u8,
    token: ?[]const u8,
) HttpError!Response {
    var cmd_buf: std.ArrayList(u8) = .empty;
    defer cmd_buf.deinit(allocator);
    cmd_buf.appendSlice(allocator, "curl -sS ") catch return HttpError.OutOfMemory;
    if (token) |t| {
        cmd_buf.appendSlice(allocator, "-H 'Authorization: Bearer ") catch return HttpError.OutOfMemory;
        cmd_buf.appendSlice(allocator, t) catch return HttpError.OutOfMemory;
        cmd_buf.appendSlice(allocator, "' ") catch return HttpError.OutOfMemory;
    }
    cmd_buf.appendSlice(allocator, "-w '\\n__STATUS__:%{http_code}\\n' ") catch return HttpError.OutOfMemory;
    cmd_buf.append(allocator, '\'') catch return HttpError.OutOfMemory;
    cmd_buf.appendSlice(allocator, url) catch return HttpError.OutOfMemory;
    cmd_buf.append(allocator, '\'') catch return HttpError.OutOfMemory;
    cmd_buf.append(allocator, 0) catch return HttpError.OutOfMemory;

    const cmd_z: [*:0]const u8 = @ptrCast(cmd_buf.items.ptr);
    const f = popen(cmd_z, "r") orelse return HttpError.CurlMissing;
    defer _ = pclose(f);

    var body_buf: std.ArrayList(u8) = .empty;
    errdefer body_buf.deinit(allocator);
    var chunk: [4096]u8 = undefined;
    while (true) {
        const got = fread(&chunk, 1, chunk.len, f);
        if (got == 0) break;
        body_buf.appendSlice(allocator, chunk[0..got]) catch return HttpError.OutOfMemory;
    }

    const marker = "__STATUS__:";
    const at = std.mem.lastIndexOf(u8, body_buf.items, marker) orelse return HttpError.BadResponse;
    var status_end: usize = at + marker.len;
    while (status_end < body_buf.items.len and body_buf.items[status_end] >= '0' and body_buf.items[status_end] <= '9') status_end += 1;
    const status_str = body_buf.items[at + marker.len .. status_end];
    const status = std.fmt.parseInt(u16, status_str, 10) catch return HttpError.BadResponse;
    var end = at;
    if (end > 0 and body_buf.items[end - 1] == '\n') end -= 1;
    body_buf.shrinkRetainingCapacity(end);
    const owned = body_buf.toOwnedSlice(allocator) catch return HttpError.OutOfMemory;
    return .{ .status = status, .body = owned };
}

// ─────────────────────────────────────────────────────────────────────────
// Tests — pure unit tests (no network). We test the URL+command builder
// shape indirectly via the postJson signature and the parsing helpers.

test "Response struct fields compile" {
    const r: Response = .{ .status = 200, .body = &[_]u8{} };
    try std.testing.expectEqual(@as(u16, 200), r.status);
}

test "status marker shape is what we tell curl to write" {
    // Hand-assemble a fake curl-output buffer and verify our trim+parse logic.
    const fake = "{\"id\":\"abc\"}\n__STATUS__:201\n";
    const marker = "__STATUS__:";
    const at = std.mem.lastIndexOf(u8, fake, marker).?;
    var end: usize = at + marker.len;
    while (end < fake.len and fake[end] >= '0' and fake[end] <= '9') end += 1;
    const status_str = fake[at + marker.len .. end];
    const status = try std.fmt.parseInt(u16, status_str, 10);
    try std.testing.expectEqual(@as(u16, 201), status);
}
