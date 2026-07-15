//! payout.zig — the loop's OUTPUT, operator-gated: turn epoch payouts into
//! broadcastable USDC transfer cards.
//!
//! reward/epoch computes who is owed how much (in USDC atoms). This module turns
//! each payout into a native SPL Token `TransferChecked` instruction — treasury
//! USDC ATA → maintainer USDC ATA — and EMITS it as a JSON card. It never sends
//! (claim 68: the human's hand on the money path; the operator holds the treasury
//! key and broadcasts). No conversion: USDC in, USDC out (per the economics doc).
//!
//! TransferChecked (ix 12) over the plain `usage`→`reward` shape: it verifies the
//! mint + decimals on-chain, so a wrong-mint or wrong-decimals card is rejected
//! by the token program rather than moving the wrong asset. Accounts, in order:
//!   [0] source USDC ATA (writable)   [1] USDC mint
//!   [2] dest USDC ATA (writable)     [3] treasury authority (signer)
//!
//! ZERO-DEPENDENCY: std + the std-only base58 / voltr modules (ATA derivation via
//! voltr.findProgramAddress — the same proven derivation).

const std = @import("std");
const base58 = @import("base58.zig");
const voltr = @import("voltr.zig");

/// Mainnet USDC SPL mint (6 decimals). The reward/payout asset.
pub const USDC_MINT: []const u8 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
pub const USDC_DECIMALS: u8 = 6;

/// SPL Token `TransferChecked` instruction index.
pub const TRANSFER_CHECKED: u8 = 12;

fn b58To32(allocator: std.mem.Allocator, s: []const u8) ![32]u8 {
    const dec = try base58.decode(allocator, s);
    defer allocator.free(dec);
    if (dec.len != 32) return error.WrongLength;
    var out: [32]u8 = undefined;
    @memcpy(&out, dec[0..32]);
    return out;
}

/// A wallet's USDC Associated Token Account (32 bytes), derived exactly as
/// voltr.zig derives token ATAs: findProgramAddress([owner, TOKEN_PROGRAM, USDC_MINT]).
pub fn usdcAta(allocator: std.mem.Allocator, owner_b58: []const u8) ![32]u8 {
    const owner = try b58To32(allocator, owner_b58);
    const token_program = try b58To32(allocator, voltr.TOKEN_PROGRAM_ID);
    const mint = try b58To32(allocator, USDC_MINT);
    const ata_program = try b58To32(allocator, voltr.ATA_PROGRAM_ID);
    const seeds = [_][]const u8{ &owner, &token_program, &mint };
    return voltr.findProgramAddress(&seeds, ata_program);
}

/// TransferChecked instruction data: [ix=12][amount u64 LE][decimals u8] = 10 bytes.
pub fn transferCheckedData(amount: u64) [10]u8 {
    var d: [10]u8 = undefined;
    d[0] = TRANSFER_CHECKED;
    std.mem.writeInt(u64, d[1..9], amount, .little);
    d[9] = USDC_DECIMALS;
    return d;
}

fn appendHex(out: *std.ArrayList(u8), allocator: std.mem.Allocator, bytes: []const u8) !void {
    const alpha = "0123456789abcdef";
    for (bytes) |b| {
        try out.append(allocator, alpha[b >> 4]);
        try out.append(allocator, alpha[b & 0x0f]);
    }
}

fn appendAtaJson(out: *std.ArrayList(u8), allocator: std.mem.Allocator, ata: [32]u8) !void {
    const b58 = try base58.encode(allocator, &ata);
    defer allocator.free(b58);
    try out.append(allocator, '"');
    try out.appendSlice(allocator, b58);
    try out.append(allocator, '"');
}

/// One operator-broadcastable USDC payout card: pay `amount` atoms from the
/// treasury's USDC ATA to `recipient`'s USDC ATA. `treasury_owner_b58` signs.
/// Caller frees.
pub fn payoutCardJson(
    allocator: std.mem.Allocator,
    treasury_owner_b58: []const u8,
    recipient_owner_b58: []const u8,
    amount: u64,
) ![]u8 {
    const src = try usdcAta(allocator, treasury_owner_b58);
    const dst = try usdcAta(allocator, recipient_owner_b58);
    const data = transferCheckedData(amount);

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.appendSlice(allocator, "{\"program\":\"");
    try out.appendSlice(allocator, voltr.TOKEN_PROGRAM_ID);
    try out.appendSlice(allocator, "\",\"ix\":\"transfer_checked\",\"data_hex\":\"");
    try appendHex(&out, allocator, &data);
    try out.appendSlice(allocator, "\",\"mint\":\"");
    try out.appendSlice(allocator, USDC_MINT);
    try out.appendSlice(allocator, "\",\"amount\":");
    var amt_buf: [20]u8 = undefined;
    try out.appendSlice(allocator, try std.fmt.bufPrint(&amt_buf, "{d}", .{amount}));
    // accounts in IDL order: [source, mint, dest, authority]
    try out.appendSlice(allocator, ",\"accounts\":[");
    try appendAtaJson(&out, allocator, src);
    try out.appendSlice(allocator, ",\"");
    try out.appendSlice(allocator, USDC_MINT);
    try out.appendSlice(allocator, "\",");
    try appendAtaJson(&out, allocator, dst);
    try out.appendSlice(allocator, ",\"");
    try out.appendSlice(allocator, treasury_owner_b58);
    try out.appendSlice(allocator, "\"]}");
    return out.toOwnedSlice(allocator);
}

/// A whole epoch's payouts as a JSON ARRAY of transfer cards, one per NON-ZERO
/// payout (a zero payout is not a transaction). `recipients[i]` is maintainer i's
/// wallet; `amounts[i]` its EpochResult payout. Caller frees.
pub fn payoutBatchJson(
    allocator: std.mem.Allocator,
    treasury_owner_b58: []const u8,
    recipients: []const []const u8,
    amounts: []const u64,
) ![]u8 {
    std.debug.assert(recipients.len == amounts.len);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.append(allocator, '[');
    var first = true;
    for (recipients, amounts) |wallet, amt| {
        if (amt == 0) continue; // nothing owed → no transaction
        if (!first) try out.append(allocator, ',');
        first = false;
        const card = try payoutCardJson(allocator, treasury_owner_b58, wallet, amt);
        defer allocator.free(card);
        try out.appendSlice(allocator, card);
    }
    try out.append(allocator, ']');
    return out.toOwnedSlice(allocator);
}

// ── witnesses (zig test) — no fabricated green ───────────────────────────────

test "USDC_MINT is the canonical mainnet USDC address" {
    try std.testing.expectEqualStrings("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", USDC_MINT);
    try std.testing.expectEqual(@as(u8, 6), USDC_DECIMALS);
}

test "transferCheckedData: [12, amount LE, 6 decimals]" {
    const d = transferCheckedData(1_000_000); // 1 USDC (6 decimals)
    try std.testing.expectEqual(@as(u8, 12), d[0]);
    // 1_000_000 = 0x0F4240 → LE: 40 42 0F 00 00 00 00 00
    try std.testing.expectEqual(@as(u8, 0x40), d[1]);
    try std.testing.expectEqual(@as(u8, 0x42), d[2]);
    try std.testing.expectEqual(@as(u8, 0x0F), d[3]);
    for (d[4..9]) |b| try std.testing.expectEqual(@as(u8, 0), b);
    try std.testing.expectEqual(@as(u8, 6), d[9]); // decimals
}

test "usdcAta is deterministic and off-curve (a valid ATA)" {
    const a = std.testing.allocator;
    const ata1 = try usdcAta(a, voltr.VAULT_MANAGER);
    const ata2 = try usdcAta(a, voltr.VAULT_MANAGER);
    try std.testing.expectEqualSlices(u8, &ata1, &ata2);
    const on_curve = if (std.crypto.ecc.Edwards25519.fromBytes(ata1)) |_| true else |_| false;
    try std.testing.expect(!on_curve);
}

test "payoutCardJson bundles ix, amount, mint, and the 4 accounts" {
    const a = std.testing.allocator;
    const card = try payoutCardJson(a, voltr.VAULT_MANAGER, voltr.VAULT, 2_500_000);
    defer a.free(card);
    try std.testing.expect(std.mem.indexOf(u8, card, "\"ix\":\"transfer_checked\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, card, "\"amount\":2500000") != null);
    try std.testing.expect(std.mem.indexOf(u8, card, USDC_MINT) != null);
    try std.testing.expect(std.mem.indexOf(u8, card, voltr.TOKEN_PROGRAM_ID) != null);
    // data_hex begins with 0c (12 = TransferChecked)
    try std.testing.expect(std.mem.indexOf(u8, card, "\"data_hex\":\"0c") != null);
    try std.testing.expect(std.mem.indexOf(u8, card, voltr.VAULT_MANAGER) != null); // authority
}

test "payoutBatchJson emits one card per non-zero payout, skips zeros" {
    const a = std.testing.allocator;
    const recipients = [_][]const u8{ voltr.VAULT, voltr.VAULT_MANAGER, voltr.FDRY_MINT };
    const amounts = [_]u64{ 1000, 0, 500 }; // middle one owed nothing
    const batch = try payoutBatchJson(a, voltr.VAULT_MANAGER, &recipients, &amounts);
    defer a.free(batch);
    try std.testing.expect(batch[0] == '[' and batch[batch.len - 1] == ']');
    // exactly two cards → exactly two "transfer_checked" occurrences
    var count: usize = 0;
    var i: usize = 0;
    while (std.mem.indexOfPos(u8, batch, i, "transfer_checked")) |p| : (i = p + 1) count += 1;
    try std.testing.expectEqual(@as(usize, 2), count);
}
