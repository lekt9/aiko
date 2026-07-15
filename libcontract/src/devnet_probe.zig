//! devnet_probe.zig — REAL Solana devnet connectivity via the ported engine.
//! No mocks: a live JSON-RPC round-trip to api.devnet.solana.com. Gated on
//! RUN_DEVNET so the offline test suite stays offline. Run:
//!   RUN_DEVNET=1 zig test libcontract/src/devnet_probe.zig
const std = @import("std");
const rpc = @import("solana_rpc.zig");
const link = @import("link.zig");
const Ed25519 = std.crypto.sign.Ed25519;
extern "c" fn sleep(seconds: c_uint) c_uint;

test "REAL devnet: live blockhash (hard) + airdrop/balance (best-effort)" {
    const a = std.testing.allocator;
    if (std.c.getenv("RUN_DEVNET") == null) return; // offline-safe default
    const url = try rpc.rpcUrl("devnet");
    std.debug.print("\n[devnet] endpoint = {s}\n", .{url});

    // HARD PROOF of a real, live round-trip: a finalized blockhash changes every
    // call and can be verified on a devnet explorer — impossible to fake offline.
    const bh = try rpc.latestBlockhash(a, url);
    defer a.free(bh);
    std.debug.print("[devnet] latestBlockhash = {s}\n", .{bh});
    try std.testing.expect(bh.len >= 32 and bh.len <= 44); // valid base58 blockhash

    // A fresh, real keypair.
    // Seed a throwaway devnet keypair from the live (unpredictable) blockhash.
    var seed: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bh, &seed, .{});
    const kp = try Ed25519.KeyPair.generateDeterministic(seed);
    const pk = try link.b58Encode(a, &kp.public_key.bytes);
    defer a.free(pk);
    std.debug.print("[devnet] fresh account = {s}\n", .{pk});

    // Best-effort real airdrop (public faucet rate-limits — don't hard-fail on it).
    const params = try std.fmt.allocPrint(a, "[\"{s}\", 1000000000]", .{pk});
    defer a.free(params);
    if (rpc.call(a, url, "requestAirdrop", params)) |resp| {
        defer resp.deinit();
        switch (resp.result) {
            .string => |sig| {
                std.debug.print("[devnet] airdrop tx = {s}  (verify on explorer)\n", .{sig});
                var bal: u64 = 0;
                var tries: usize = 0;
                while (tries < 12) : (tries += 1) {
                    _ = sleep(2);
                    bal = rpc.balance(a, url, pk) catch 0;
                    if (bal > 0) break;
                }
                std.debug.print("[devnet] balance = {d} lamports ({d:.4} SOL) after {d} poll(s)\n", .{ bal, @as(f64, @floatFromInt(bal)) / 1e9, tries + 1 });
            },
            else => std.debug.print("[devnet] airdrop returned non-string (faucet rate-limited?) — blockhash proof stands\n", .{}),
        }
    } else |e| {
        std.debug.print("[devnet] airdrop RPC error: {s} (rate-limited?) — blockhash proof stands\n", .{@errorName(e)});
    }
}
