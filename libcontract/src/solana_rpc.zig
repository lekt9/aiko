//! solana_rpc.zig — Solana JSON-RPC over native TLS. No curl, no shell.
//!
//! `http.zig` reaches the network by `popen`ing curl. That was a deliberate
//! choice when std.http churned between zig versions, but it means every RPC
//! call forks a shell — an escape hatch out of the binary, and a dependency on
//! curl existing. On zig 0.16 `std.http.Client` speaks TLS natively, so the
//! chain path needs no such hatch: the substrate talks to Solana itself.
//!
//! Everything here is one function shape: build a JSON-RPC body, POST it, hand
//! back the parsed `result` (or an error). Callers own the parsed tree.

const std = @import("std");

pub const RpcError = error{
    Unreachable,
    BadResponse,
    RpcFailed,
    OutOfMemory,
    UnknownNetwork,
};

/// The clusters aiko can anchor to. `localhost` is solana-test-validator.
///
/// mainnet does NOT use api.mainnet-beta.solana.com: that endpoint 403s requests
/// from cloud IPs and blocks getProgramAccounts outright. publicnode serves both,
/// keyless. The endpoint is a pure function of `network` — no env override, per
/// claim 1 ("no env vars are read"). A paid provider is passed explicitly by the
/// caller as `url` to `call`/`latestBlockhash`/etc., never through ambient env.
pub fn rpcUrl(network: []const u8) RpcError![]const u8 {
    if (std.mem.eql(u8, network, "mainnet-beta") or std.mem.eql(u8, network, "mainnet"))
        return "https://solana-rpc.publicnode.com";
    if (std.mem.eql(u8, network, "devnet"))
        return "https://api.devnet.solana.com";
    if (std.mem.eql(u8, network, "localhost"))
        return "http://127.0.0.1:8899";
    return RpcError.UnknownNetwork;
}

/// A parsed JSON-RPC response. `arena` owns every slice reachable from `result`;
/// deinit it and the whole tree goes.
pub const Response = struct {
    arena: *std.heap.ArenaAllocator,
    result: std.json.Value,

    pub fn deinit(self: Response) void {
        const child = self.arena.child_allocator;
        self.arena.deinit();
        child.destroy(self.arena);
    }
};

/// POST a JSON-RPC call and return its `result` member.
///
/// `params_json` is the raw JSON text of the params array — callers build it,
/// because every method's shape differs and a generic encoder would cost more
/// than it saves.
pub fn call(
    allocator: std.mem.Allocator,
    url: []const u8,
    method: []const u8,
    params_json: []const u8,
) RpcError!Response {
    var body: std.ArrayList(u8) = .empty;
    defer body.deinit(allocator);
    body.appendSlice(allocator, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"") catch return RpcError.OutOfMemory;
    body.appendSlice(allocator, method) catch return RpcError.OutOfMemory;
    body.appendSlice(allocator, "\",\"params\":") catch return RpcError.OutOfMemory;
    body.appendSlice(allocator, params_json) catch return RpcError.OutOfMemory;
    body.appendSlice(allocator, "}") catch return RpcError.OutOfMemory;

    var threaded: std.Io.Threaded = .init(allocator, .{});
    defer threaded.deinit();

    var client: std.http.Client = .{ .allocator = allocator, .io = threaded.io() };
    defer client.deinit();

    var out: std.Io.Writer.Allocating = .init(allocator);
    defer out.deinit();

    const res = client.fetch(.{
        .location = .{ .url = url },
        .method = .POST,
        .payload = body.items,
        .headers = .{ .content_type = .{ .override = "application/json" } },
        .response_writer = &out.writer,
    }) catch return RpcError.Unreachable;

    if (res.status != .ok) return RpcError.BadResponse;

    const arena = allocator.create(std.heap.ArenaAllocator) catch return RpcError.OutOfMemory;
    arena.* = .init(allocator);
    errdefer {
        arena.deinit();
        allocator.destroy(arena);
    }

    const parsed = std.json.parseFromSliceLeaky(
        std.json.Value,
        arena.allocator(),
        out.written(),
        .{},
    ) catch return RpcError.BadResponse;

    if (parsed != .object) return RpcError.BadResponse;
    if (parsed.object.get("error")) |_| return RpcError.RpcFailed;
    const result = parsed.object.get("result") orelse return RpcError.BadResponse;

    return .{ .arena = arena, .result = result };
}

/// getLatestBlockhash → the 32-byte blockhash, base58. Caller frees.
pub fn latestBlockhash(
    allocator: std.mem.Allocator,
    url: []const u8,
) RpcError![]u8 {
    const resp = try call(allocator, url, "getLatestBlockhash", "[{\"commitment\":\"finalized\"}]");
    defer resp.deinit();

    const value = switch (resp.result) {
        .object => |o| o.get("value") orelse return RpcError.BadResponse,
        else => return RpcError.BadResponse,
    };
    const hash = switch (value) {
        .object => |o| o.get("blockhash") orelse return RpcError.BadResponse,
        else => return RpcError.BadResponse,
    };
    return switch (hash) {
        .string => |s| allocator.dupe(u8, s) catch RpcError.OutOfMemory,
        else => RpcError.BadResponse,
    };
}

/// getAccountInfo → the account's base64 data, or null when the account does not
/// exist. "confirmed", not the default "finalized": a row anchored seconds ago
/// must read back as present, not as missing for the ~13s until finalization.
pub fn accountData(
    allocator: std.mem.Allocator,
    url: []const u8,
    address_b58: []const u8,
) RpcError!?[]u8 {
    var params: std.ArrayList(u8) = .empty;
    defer params.deinit(allocator);
    params.appendSlice(allocator, "[\"") catch return RpcError.OutOfMemory;
    params.appendSlice(allocator, address_b58) catch return RpcError.OutOfMemory;
    params.appendSlice(allocator, "\",{\"encoding\":\"base64\",\"commitment\":\"confirmed\"}]") catch
        return RpcError.OutOfMemory;

    const resp = try call(allocator, url, "getAccountInfo", params.items);
    defer resp.deinit();

    const value = switch (resp.result) {
        .object => |o| o.get("value") orelse return RpcError.BadResponse,
        else => return RpcError.BadResponse,
    };
    if (value == .null) return null; // never declared

    const data = switch (value) {
        .object => |o| o.get("data") orelse return RpcError.BadResponse,
        else => return RpcError.BadResponse,
    };
    // data is ["<base64>", "base64"]
    const b64 = switch (data) {
        .array => |a| if (a.items.len == 0) return RpcError.BadResponse else a.items[0],
        else => return RpcError.BadResponse,
    };
    const b64_str = switch (b64) {
        .string => |s| s,
        else => return RpcError.BadResponse,
    };

    const dec = std.base64.standard.Decoder;
    const n = dec.calcSizeForSlice(b64_str) catch return RpcError.BadResponse;
    const out = allocator.alloc(u8, n) catch return RpcError.OutOfMemory;
    errdefer allocator.free(out);
    dec.decode(out, b64_str) catch return RpcError.BadResponse;
    return out;
}

/// sendTransaction → the signature, base58. Caller frees.
pub fn sendTransaction(
    allocator: std.mem.Allocator,
    url: []const u8,
    wire_tx: []const u8,
) RpcError![]u8 {
    const enc = std.base64.standard.Encoder;
    const b64 = allocator.alloc(u8, enc.calcSize(wire_tx.len)) catch return RpcError.OutOfMemory;
    defer allocator.free(b64);
    _ = enc.encode(b64, wire_tx);

    var params: std.ArrayList(u8) = .empty;
    defer params.deinit(allocator);
    params.appendSlice(allocator, "[\"") catch return RpcError.OutOfMemory;
    params.appendSlice(allocator, b64) catch return RpcError.OutOfMemory;
    params.appendSlice(allocator, "\",{\"encoding\":\"base64\",\"preflightCommitment\":\"confirmed\"}]") catch
        return RpcError.OutOfMemory;

    const resp = try call(allocator, url, "sendTransaction", params.items);
    defer resp.deinit();

    return switch (resp.result) {
        .string => |s| allocator.dupe(u8, s) catch RpcError.OutOfMemory,
        else => RpcError.BadResponse,
    };
}

/// getBalance → lamports. Used to decide whether a declare can be paid for at all.
pub fn balance(allocator: std.mem.Allocator, url: []const u8, address_b58: []const u8) RpcError!u64 {
    var params: std.ArrayList(u8) = .empty;
    defer params.deinit(allocator);
    // "confirmed", not the default "finalized" — a transfer that just landed must
    // count, or a freshly funded signer reads as broke and the declare is refused.
    params.appendSlice(allocator, "[\"") catch return RpcError.OutOfMemory;
    params.appendSlice(allocator, address_b58) catch return RpcError.OutOfMemory;
    params.appendSlice(allocator, "\",{\"commitment\":\"confirmed\"}]") catch return RpcError.OutOfMemory;

    const resp = try call(allocator, url, "getBalance", params.items);
    defer resp.deinit();

    const value = switch (resp.result) {
        .object => |o| o.get("value") orelse return RpcError.BadResponse,
        else => return RpcError.BadResponse,
    };
    return switch (value) {
        .integer => |i| if (i < 0) 0 else @intCast(i),
        else => RpcError.BadResponse,
    };
}

test "rpcUrl maps the three clusters and rejects the rest" {
    const t = std.testing;
    try t.expectEqualStrings("https://solana-rpc.publicnode.com", try rpcUrl("mainnet-beta"));
    try t.expectEqualStrings("https://api.devnet.solana.com", try rpcUrl("devnet"));
    try t.expectEqualStrings("http://127.0.0.1:8899", try rpcUrl("localhost"));
    try t.expectError(RpcError.UnknownNetwork, rpcUrl("testnet"));
}
