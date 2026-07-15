//! broadcast_main.zig — the operator's broadcast utility (a standalone binary).
//!
//! Deliberately OUTSIDE the contract-resolution flow: the substrate's declare
//! path redacts local file paths and the public persona takes no verbs, so a
//! money-moving action cannot live there. This is a separate operator tool that
//! uses the proven library directly — no declare, no redaction, no ambient key.
//!
//!   broadcast-tool <keypair.json> <card.json> <network>
//!
//! Loads the operator's funded Solana keypair (id.json), parses an emitted card
//! (voltr deposit / payout), signs, and SUBMITS. THIS MOVES REAL VALUE. Running
//! it with a funded keypair + an explicit network IS the deliberate operator act
//! (claim 68 — the human's hand on the money path). The agent never runs it.

const std = @import("std");
const broadcast = @import("broadcast.zig");
const broadcast_card = @import("broadcast_card.zig");
const solana_rpc = @import("solana_rpc.zig");
const Ed25519 = std.crypto.sign.Ed25519;

fn readSmallFile(allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);
    const fd = std.c.open(path_z.ptr, .{ .ACCMODE = .RDONLY }, @as(c_uint, 0));
    if (fd < 0) return error.OpenFailed;
    defer _ = std.c.close(fd);
    var buf: std.ArrayList(u8) = .empty;
    errdefer buf.deinit(allocator);
    var chunk: [8192]u8 = undefined;
    while (buf.items.len <= 1024 * 1024) {
        const n = std.c.read(fd, &chunk, chunk.len);
        if (n < 0) return error.ReadFailed;
        if (n == 0) break;
        try buf.appendSlice(allocator, chunk[0..@intCast(n)]);
    }
    return buf.toOwnedSlice(allocator);
}

/// Load a Solana keypair from an `id.json` (a JSON array of 64 u8: seed ++ pubkey).
fn loadKeypair(allocator: std.mem.Allocator, path: []const u8) !Ed25519.KeyPair {
    const bytes = try readSmallFile(allocator, path);
    defer allocator.free(bytes);
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, bytes, .{});
    defer parsed.deinit();
    const arr = switch (parsed.value) {
        .array => |a| a,
        else => return error.BadKeypair,
    };
    if (arr.items.len != 64) return error.BadKeypair;
    var sk_bytes: [64]u8 = undefined;
    for (arr.items, 0..) |v, i| {
        const num = switch (v) {
            .integer => |x| x,
            else => return error.BadKeypair,
        };
        if (num < 0 or num > 255) return error.BadKeypair;
        sk_bytes[i] = @intCast(num);
    }
    const sk = try Ed25519.SecretKey.fromBytes(sk_bytes);
    return Ed25519.KeyPair.fromSecretKey(sk);
}

fn out(bytes: []const u8) void {
    _ = std.c.write(1, bytes.ptr, bytes.len);
}

pub fn main(init: std.process.Init.Minimal) !u8 {
    const allocator = std.heap.page_allocator;
    const args = try init.args.toSlice(allocator);

    if (args.len < 4) {
        std.debug.print(
            \\broadcast-tool — submit an emitted card as a signed Solana tx.
            \\
            \\  broadcast-tool <keypair.json> <card.json> <network>
            \\
            \\  network is REQUIRED (no default) so mainnet is never accidental:
            \\    mainnet | devnet | localhost
            \\
            \\THIS MOVES REAL VALUE. Running it with a funded keypair is the
            \\operator's deliberate act; nothing else fires it.
            \\
        , .{});
        return 2;
    }
    const kp_path = args[1];
    const card_path = args[2];
    const network = args[3];

    const url = solana_rpc.rpcUrl(network) catch {
        std.debug.print("broadcast-tool: unknown network '{s}' (mainnet|devnet|localhost)\n", .{network});
        return 2;
    };
    const kp = loadKeypair(allocator, kp_path) catch |e| {
        std.debug.print("broadcast-tool: keypair load failed: {s}\n", .{@errorName(e)});
        return 1;
    };
    const card_json = readSmallFile(allocator, card_path) catch |e| {
        std.debug.print("broadcast-tool: card read failed: {s}\n", .{@errorName(e)});
        return 1;
    };
    defer allocator.free(card_json);
    var pc = broadcast_card.parseCard(allocator, card_json) catch |e| {
        std.debug.print("broadcast-tool: card parse failed: {s}\n", .{@errorName(e)});
        return 1;
    };
    defer pc.deinit();

    std.debug.print("broadcast-tool: SUBMITTING to {s} — real value moves. card={s}\n", .{ network, card_path });
    const sig = broadcast.broadcast(allocator, url, pc.instruction(), kp) catch |e| {
        std.debug.print("broadcast-tool: submit failed: {s}\n", .{@errorName(e)});
        return 1;
    };
    defer allocator.free(sig);
    // The signature to stdout (capturable); status to stderr above.
    out(sig);
    out("\n");
    return 0;
}
