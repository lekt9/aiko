//! broadcast_card.zig — the bridge: an emitted CARD → a signable Instruction.
//!
//! Cards (voltr deposit, payout transfer) emit account ADDRESSES but not the
//! per-account signer/writable flags a transaction needs. Those flags are a
//! property of the instruction TYPE, not the card, so this module carries a flag
//! template per known `ix` and applies it — turning a card into a
//! broadcast.Instruction the operator can sign + send.
//!
//! Refuses an unknown `ix` (no guessing flags → no malformed money-moving tx).
//! Pure parse, offline-testable against the real card emitters.
//!
//! ZERO-DEPENDENCY: std + the std-only base58 / solana_tx / broadcast modules.

const std = @import("std");
const base58 = @import("base58.zig");
const solana_tx = @import("solana_tx.zig");
const broadcast = @import("broadcast.zig");

const AccountMeta = solana_tx.AccountMeta;

/// A parsed, owned instruction. `deinit` frees the account list + data.
pub const ParsedCard = struct {
    program_id: [32]u8,
    accounts: []AccountMeta,
    data: []u8,
    allocator: std.mem.Allocator,

    pub fn instruction(self: *const ParsedCard) broadcast.Instruction {
        return .{ .program_id = self.program_id, .accounts = self.accounts, .data = self.data };
    }
    pub fn deinit(self: ParsedCard) void {
        self.allocator.free(self.accounts);
        self.allocator.free(self.data);
    }
};

/// Per-ix account flags: which indices are signers, which are writable. Kept
/// next to the card emitters' documented account order.
const FlagTemplate = struct {
    signers: []const usize,
    writables: []const usize,
    len: usize, // expected account count (a mismatch is a malformed card)
};

fn templateFor(ix: []const u8) ?FlagTemplate {
    // deposit_vault (voltr.depositAccountsJson order): [0] user auth (signer),
    // [2] vault, [4] vault_lp_mint, [5] user_asset_ata, [6] vault_asset_idle_ata,
    // [8] user_lp_ata are writable; the rest readonly. 13 accounts.
    if (std.mem.eql(u8, ix, "deposit_vault")) return .{
        .signers = &.{0},
        .writables = &.{ 2, 4, 5, 6, 8 },
        .len = 13,
    };
    // transfer_checked (payout.payoutCardJson order): [0] source, [1] mint,
    // [2] dest, [3] authority(signer). source + dest writable. 4 accounts.
    if (std.mem.eql(u8, ix, "transfer_checked")) return .{
        .signers = &.{3},
        .writables = &.{ 0, 2 },
        .len = 4,
    };
    return null;
}

fn contains(xs: []const usize, i: usize) bool {
    for (xs) |x| if (x == i) return true;
    return false;
}

fn b58To32(allocator: std.mem.Allocator, s: []const u8) ![32]u8 {
    const dec = try base58.decode(allocator, s);
    defer allocator.free(dec);
    if (dec.len != 32) return error.WrongLength;
    var out: [32]u8 = undefined;
    @memcpy(&out, dec[0..32]);
    return out;
}

fn hexDigit(c: u8) ?u8 {
    return switch (c) {
        '0'...'9' => c - '0',
        'a'...'f' => c - 'a' + 10,
        'A'...'F' => c - 'A' + 10,
        else => null,
    };
}

fn decodeHex(allocator: std.mem.Allocator, hex: []const u8) ![]u8 {
    if (hex.len % 2 != 0) return error.BadHex;
    const out = try allocator.alloc(u8, hex.len / 2);
    errdefer allocator.free(out);
    var i: usize = 0;
    while (i < out.len) : (i += 1) {
        const hi = hexDigit(hex[i * 2]) orelse return error.BadHex;
        const lo = hexDigit(hex[i * 2 + 1]) orelse return error.BadHex;
        out[i] = (hi << 4) | lo;
    }
    return out;
}

fn strField(obj: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const v = obj.get(key) orelse return null;
    return switch (v) {
        .string => |s| s,
        else => null,
    };
}

/// Parse a card JSON into a signable instruction. Applies the ix flag template;
/// errors on an unknown ix or an account-count mismatch. Caller owns the result.
pub fn parseCard(allocator: std.mem.Allocator, card_json: []const u8) !ParsedCard {
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, card_json, .{});
    defer parsed.deinit();
    const obj = switch (parsed.value) {
        .object => |o| o,
        else => return error.NotAnObject,
    };

    const program_s = strField(obj, "program") orelse return error.MissingProgram;
    const ix = strField(obj, "ix") orelse return error.MissingIx;
    const data_hex = strField(obj, "data_hex") orelse return error.MissingData;
    const accounts_v = obj.get("accounts") orelse return error.MissingAccounts;
    const accounts_arr = switch (accounts_v) {
        .array => |arr| arr,
        else => return error.MissingAccounts,
    };

    const tmpl = templateFor(ix) orelse return error.UnknownIx;
    if (accounts_arr.items.len != tmpl.len) return error.AccountCountMismatch;

    const program_id = try b58To32(allocator, program_s);
    const data = try decodeHex(allocator, data_hex);
    errdefer allocator.free(data);

    const metas = try allocator.alloc(AccountMeta, accounts_arr.items.len);
    errdefer allocator.free(metas);
    for (accounts_arr.items, 0..) |item, i| {
        const s = switch (item) {
            .string => |str| str,
            else => return error.BadAccount,
        };
        metas[i] = .{
            .pubkey = try b58To32(allocator, s),
            .is_signer = contains(tmpl.signers, i),
            .is_writable = contains(tmpl.writables, i),
        };
    }

    return .{ .program_id = program_id, .accounts = metas, .data = data, .allocator = allocator };
}

// ── witnesses (zig test) — no fabricated green ───────────────────────────────

test "parseCard bridges a REAL payout card → transfer_checked instruction" {
    const a = std.testing.allocator;
    const payout = @import("payout.zig");
    const voltr = @import("voltr.zig");
    const card = try payout.payoutCardJson(a, voltr.VAULT_MANAGER, voltr.VAULT, 2_500_000);
    defer a.free(card);

    var pc = try parseCard(a, card);
    defer pc.deinit();
    // program = SPL Token
    const token = try b58To32(a, voltr.TOKEN_PROGRAM_ID);
    try std.testing.expectEqualSlices(u8, &token, &pc.program_id);
    // 4 accounts, flags [w, r, w, signer]
    try std.testing.expectEqual(@as(usize, 4), pc.accounts.len);
    try std.testing.expect(pc.accounts[0].is_writable and !pc.accounts[0].is_signer); // source
    try std.testing.expect(!pc.accounts[1].is_writable and !pc.accounts[1].is_signer); // mint
    try std.testing.expect(pc.accounts[2].is_writable and !pc.accounts[2].is_signer); // dest
    try std.testing.expect(pc.accounts[3].is_signer and !pc.accounts[3].is_writable); // authority
    // data begins with TransferChecked (12)
    try std.testing.expectEqual(@as(u8, 12), pc.data[0]);
}

test "parseCard bridges a REAL voltr deposit card → deposit_vault instruction" {
    const a = std.testing.allocator;
    const voltr = @import("voltr.zig");
    const card = try voltr.depositCardJson(a, voltr.VAULT, 1_000_000_000);
    defer a.free(card);

    var pc = try parseCard(a, card);
    defer pc.deinit();
    try std.testing.expectEqual(@as(usize, 13), pc.accounts.len);
    try std.testing.expect(pc.accounts[0].is_signer); // user transfer authority
    try std.testing.expect(pc.accounts[2].is_writable); // vault
    try std.testing.expect(pc.accounts[8].is_writable); // user_lp_ata
    try std.testing.expect(!pc.accounts[12].is_writable and !pc.accounts[12].is_signer); // system program
    // data begins with the deposit_vault discriminator
    try std.testing.expectEqualSlices(u8, &voltr.DEPOSIT_VAULT_DISC, pc.data[0..8]);
}

test "parseCard refuses an unknown ix (no guessing flags)" {
    const a = std.testing.allocator;
    const card =
        \\{"program":"11111111111111111111111111111111","ix":"mystery","data_hex":"00","accounts":[]}
    ;
    try std.testing.expectError(error.UnknownIx, parseCard(a, card));
}
