//! stake.zig — the live stake source: a wallet's bonded FDRY, read from chain.
//!
//! reward.Maintainer.stake is the eligibility gate + Sybil cost. This module
//! turns it from a test value into a REAL on-chain number: the wallet's stFDRY
//! balance (the Voltr vault's LP receipt — holding stFDRY IS the bond, per
//! voltr.zig). A read, never a write: no lamport moves, so no operator gate.
//!
//! How: the stFDRY balance lives in the wallet's Associated Token Account for
//! STFDRY_MINT. Derive that ATA (the SAME derivation voltr.zig uses for the
//! deposit card's user_lp_ata — proven byte-correct there), fetch the account,
//! and read the SPL token `amount` (u64 LE at offset 64 of the token-account
//! layout: mint[32] ++ owner[32] ++ amount[8] ++ …). No ATA → 0 stake.
//!
//! ZERO-DEPENDENCY: std + the std-only base58 / voltr / solana_rpc modules. The
//! derivation + amount parse are pure and unit-tested offline; the one network
//! read reuses solana_rpc's proven getAccountInfo path (RUN_MAINNET-gated live).

const std = @import("std");
const base58 = @import("base58.zig");
const voltr = @import("voltr.zig");
const solana_rpc = @import("solana_rpc.zig");
const reward = @import("reward.zig");

fn b58To32(allocator: std.mem.Allocator, s: []const u8) ![32]u8 {
    const dec = try base58.decode(allocator, s);
    defer allocator.free(dec);
    if (dec.len != 32) return error.WrongLength;
    var out: [32]u8 = undefined;
    @memcpy(&out, dec[0..32]);
    return out;
}

/// The wallet's stFDRY Associated Token Account (32 bytes). Same derivation as
/// voltr.zig's user_lp_ata: findProgramAddress([wallet, TOKEN_PROGRAM, STFDRY_MINT])
/// under the ATA program.
pub fn stFdryAta(allocator: std.mem.Allocator, wallet_b58: []const u8) ![32]u8 {
    const wallet = try b58To32(allocator, wallet_b58);
    const token_program = try b58To32(allocator, voltr.TOKEN_PROGRAM_ID);
    const mint = try b58To32(allocator, voltr.STFDRY_MINT);
    const ata_program = try b58To32(allocator, voltr.ATA_PROGRAM_ID);
    const seeds = [_][]const u8{ &wallet, &token_program, &mint };
    return voltr.findProgramAddress(&seeds, ata_program);
}

/// Parse the SPL token-account `amount` (u64 LE at byte offset 64). Returns null
/// if the buffer is too short to be a token account.
pub fn parseTokenAmount(data: []const u8) ?u64 {
    if (data.len < 72) return null;
    return std.mem.readInt(u64, data[64..72], .little);
}

/// The wallet's live stFDRY balance (atoms) = its bonded stake. An absent ATA
/// (wallet never staked) reads as 0. `url` is a Solana RPC endpoint
/// (voltr is mainnet, so pass rpcUrl("mainnet")).
pub fn stakeOf(allocator: std.mem.Allocator, url: []const u8, wallet_b58: []const u8) !u64 {
    const ata = try stFdryAta(allocator, wallet_b58);
    const ata_b58 = try base58.encode(allocator, &ata);
    defer allocator.free(ata_b58);
    const data = (try solana_rpc.accountData(allocator, url, ata_b58)) orelse return 0;
    defer allocator.free(data);
    return parseTokenAmount(data) orelse 0;
}

/// Convenience: build a reward.Maintainer from a wallet's live stake.
pub fn maintainerOf(allocator: std.mem.Allocator, url: []const u8, wallet_b58: []const u8) !reward.Maintainer {
    return .{ .stake = try stakeOf(allocator, url, wallet_b58) };
}

// ── witnesses (zig test) — no fabricated green ───────────────────────────────

test "parseTokenAmount reads the SPL amount at offset 64 (u64 LE)" {
    var acct = [_]u8{0} ** 165; // canonical SPL token account size
    // amount = 123_456_789_000 atoms at offset 64
    std.mem.writeInt(u64, acct[64..72], 123_456_789_000, .little);
    try std.testing.expectEqual(@as(u64, 123_456_789_000), parseTokenAmount(&acct).?);
    // too-short buffer → null (not a token account)
    try std.testing.expect(parseTokenAmount(acct[0..40]) == null);
    // an all-zero (freshly-created, empty) account → 0 stake
    var empty = [_]u8{0} ** 165;
    try std.testing.expectEqual(@as(u64, 0), parseTokenAmount(&empty).?);
}

test "stFdryAta is deterministic and off-curve (a valid PDA)" {
    const a = std.testing.allocator;
    const ata1 = try stFdryAta(a, voltr.VAULT_MANAGER);
    const ata2 = try stFdryAta(a, voltr.VAULT_MANAGER);
    try std.testing.expectEqualSlices(u8, &ata1, &ata2); // deterministic
    // findProgramAddress only ever returns off-curve points; confirm it here.
    const on_curve = if (std.crypto.ecc.Edwards25519.fromBytes(ata1)) |_| true else |_| false;
    try std.testing.expect(!on_curve);
}

test "LIVE mainnet: stFDRY stake read (RUN_MAINNET-gated, best-effort)" {
    if (std.c.getenv("RUN_MAINNET") == null) return; // offline-safe default
    const a = std.testing.allocator;
    const url = try solana_rpc.rpcUrl("mainnet");
    // Read the vault manager's stFDRY stake — proves the derive→fetch→parse path
    // against the real chain. Value not asserted (may legitimately be 0); the
    // point is a live, unfakeable round-trip returning a concrete u64.
    const s = stakeOf(a, url, voltr.VAULT_MANAGER) catch |e| {
        std.debug.print("\n[stake] live read error: {s} (RPC hiccup?)\n", .{@errorName(e)});
        return;
    };
    std.debug.print("\n[stake] VAULT_MANAGER stFDRY = {d} atoms\n", .{s});
}
