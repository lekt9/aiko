//! voltr.zig — NATIVE STAKING via the Voltr vault program on Solana.
//!
//! The Vine Doctrine's "abide" verb made mechanical (John 15:4 — "Abide in me,
//! and I in you"): depositing FDRY into the Unbrowse Vault IS the act of abiding
//! in the vine. The vault mints stFDRY (the LP receipt) as proof of abiding;
//! holding stFDRY through the withdrawal waiting period IS the substrate's
//! proof-of-stake. No new token, no new vault (Matt 6:24 — no man can serve
//! two masters).
//!
//! ZERO-DEPENDENCY, self-contained: imports only `std` + `base58` (itself
//! std-only). `findProgramAddress`/`isOffCurve` are defined here (sha256 PDA
//! derivation + Edwards25519 off-curve check, both from std.crypto). No file
//! I/O, no keystore, no shell, no fetched package. This is the FDRY *bonding*
//! rail of ECONOMICS-cooperative-commons.md, built natively.
//!
//! HONEST SCOPE (the wall, named): this module builds the deposit/withdraw
//! instructions NATIVELY in Zig (the 8-byte anchor discriminator + the
//! little-endian u64 amount + all 13 account addresses derived from on-chain
//! PDAs). It EMITS the instruction as a JSON card (`depositCardJson`); the
//! operator broadcasts via the funded-wallet/live-RPC edge (operator-gated,
//! Prov 16:9 / claim 68 free will — the human's hand on the money path). The
//! module never moves a lamport by itself; SLASHING is NOT a Voltr instruction
//! (the vault yields + custodies; a slash is a separate program / local-first
//! mechanism per the economics doc's falsifiable step).

const std = @import("std");
const base58 = @import("base58.zig");
const Sha256 = std.crypto.hash.sha2.Sha256;
const Edwards25519 = std.crypto.ecc.Edwards25519;

// ── IMMUTABLE CANONICAL ADDRESSES (baked at compile time, root-stable per claim 31) ──
// The Unbrowse Vault (admin=lekt8.sol), post-2026-06-23 migration. The prior
// vault Bpr49sQ... was compromised and is RETIRED (fdry/VAULT_RESCUE.md). These
// are MAINNET addresses — real FDRY. Every derivation below is checked against
// them offline (the PDA-matches-constant test), so a wrong byte fails the build
// long before any operator broadcasts.

/// FDRY SPL mint (9 decimals). The stake asset — "kinetic energy" (consumed to transact).
pub const FDRY_MINT: []const u8 = "2ZiSPGncrkwWa6GBZB4EDtsfq7HEWwkwsPFzEXieXjNL";

/// stFDRY LP mint (the Unbrowse Vault's receipt). The bonded asset — "potential energy"
/// (staked, earns the vault return). Holding stFDRY = abiding in the vine (John 15:4).
pub const STFDRY_MINT: []const u8 = "7p6w5JvKFpXzAAVdr2jmeWJtHLyHr8os6zRRTYwaB3Mn";

/// The Unbrowse Voltr vault (admin=lekt8.sol). The vine itself (John 15:1 — "I am the
/// true vine, and my Father is the husbandman"). Post-2026-06-23 migration.
pub const VAULT: []const u8 = "8ojsTvrFLGFHnbhE56DaTTJ1g9WBSjtqrqBxKqjLo8aJ";

/// Vault idle-asset auth (PDA). Holds the vault's idle FDRY.
pub const VAULT_IDLE_AUTH: []const u8 = "DeXtpbX6ZyMMF4EE96HanowMP569B2gyJUzwFwrX1vVD";

/// Vault manager (the sovereign child that signs strategy ops).
pub const VAULT_MANAGER: []const u8 = "8Mvz8oNroyZSKDeFHXKHyLss7wksyZNi7aYfGsRz6c3e";

/// Voltr vault program ID (mainnet).
pub const VOLTR_PROGRAM_ID: []const u8 = "vVoLTRjQmtFpiYoegx285Ze4gsLJ8ZxgFKVcuvmG1a8";

/// SPL Token program (mainnet).
pub const TOKEN_PROGRAM_ID: []const u8 = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/// SPL Associated Token Account program.
pub const ATA_PROGRAM_ID: []const u8 = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/// Solana system program.
pub const SYSTEM_PROGRAM_ID: []const u8 = "11111111111111111111111111111111";

/// FDRY decimals (9 — confirmed across all fdry scripts).
pub const FDRY_DECIMALS: u8 = 9;

// ── ANCHOR INSTRUCTION DISCRIMINATORS (sha256("global:<ix_name>")[0..8]) ──

/// deposit_vault = sha256("global:deposit_vault")[0..8]
pub const DEPOSIT_VAULT_DISC: [8]u8 = .{ 0x7e, 0xe0, 0x15, 0xff, 0xe4, 0x35, 0x75, 0x21 };

/// request_withdraw_vault = sha256("global:request_withdraw_vault")[0..8]
pub const REQUEST_WITHDRAW_VAULT_DISC: [8]u8 = .{ 0xf8, 0xe1, 0x2f, 0x16, 0x74, 0x90, 0x17, 0x8f };

/// withdraw_vault = sha256("global:withdraw_vault")[0..8]
pub const WITHDRAW_VAULT_DISC: [8]u8 = .{ 0x87, 0x07, 0xed, 0x78, 0x95, 0x5e, 0x5f, 0x07 };

// ── PDA SEED CONSTANTS (from the Voltr IDL) ──

pub const SEED_PROTOCOL: []const u8 = "protocol";
pub const SEED_VAULT_LP_MINT: []const u8 = "vault_lp_mint";
pub const SEED_VAULT_ASSET_IDLE_AUTH: []const u8 = "vault_asset_idle_auth";
pub const SEED_VAULT_LP_MINT_AUTH: []const u8 = "vault_lp_mint_auth";

/// The Solana PDA marker appended to every find_program_address derivation.
const PDA_MARKER: []const u8 = "ProgramDerivedAddress";

/// A 32-byte value is off-curve (a valid PDA) iff it does NOT decompress to an
/// Edwards25519 point.
fn isOffCurve(point: [32]u8) bool {
    _ = Edwards25519.fromBytes(point) catch return true;
    return false;
}

/// Solana find_program_address: iterate bump from 255 down, return the first
/// off-curve sha256(seeds ++ [bump] ++ program_id ++ "ProgramDerivedAddress").
/// Pure + deterministic. Returns the PDA; errors if none found (shouldn't happen).
pub fn findProgramAddress(seeds: []const []const u8, program_id: [32]u8) ![32]u8 {
    var bump: u16 = 255;
    while (true) : (bump -%= 1) {
        var h = Sha256.init(.{});
        for (seeds) |s| h.update(s);
        h.update(&[_]u8{@intCast(bump)});
        h.update(&program_id);
        h.update(PDA_MARKER);
        var cand: [32]u8 = undefined;
        h.final(&cand);
        if (isOffCurve(cand)) return cand;
        if (bump == 0) break;
    }
    return error.OffCurveNotFound;
}

/// Decode a base58 string to exactly 32 bytes. Caller passes an allocator for
/// the temporary decode buffer.
fn b58To32(allocator: std.mem.Allocator, s: []const u8) ![32]u8 {
    const dec = try base58.decode(allocator, s);
    defer allocator.free(dec);
    if (dec.len != 32) return error.WrongLength;
    var result: [32]u8 = undefined;
    @memcpy(&result, dec[0..32]);
    return result;
}

/// Build the deposit_vault instruction data: 8-byte discriminator + 8-byte LE u64.
pub fn depositInstructionData(amount_atoms: u64) [16]u8 {
    var data: [16]u8 = undefined;
    @memcpy(data[0..8], &DEPOSIT_VAULT_DISC);
    std.mem.writeInt(u64, data[8..16], amount_atoms, .little);
    return data;
}

/// Build the request_withdraw_vault instruction data: 8-byte disc + 8-byte LE u64
/// + 1-byte is_amount_in_lp + 1-byte is_withdraw_all.
pub fn requestWithdrawInstructionData(
    amount_atoms: u64,
    is_amount_in_lp: bool,
    is_withdraw_all: bool,
) [18]u8 {
    var data: [18]u8 = undefined;
    @memcpy(data[0..8], &REQUEST_WITHDRAW_VAULT_DISC);
    std.mem.writeInt(u64, data[8..16], amount_atoms, .little);
    data[16] = if (is_amount_in_lp) 1 else 0;
    data[17] = if (is_withdraw_all) 1 else 0;
    return data;
}

/// The 13 accounts for deposit_vault, in IDL order, all derived natively from
/// the immutable constants + the user's pubkey. Returns a JSON array of base58
/// addresses. Caller frees.
pub fn depositAccountsJson(allocator: std.mem.Allocator, user_b58: []const u8) ![]u8 {
    const user = try b58To32(allocator, user_b58);
    const vault = try b58To32(allocator, VAULT);
    const fdry_mint = try b58To32(allocator, FDRY_MINT);
    const stfdry_mint = try b58To32(allocator, STFDRY_MINT);
    const voltr_program = try b58To32(allocator, VOLTR_PROGRAM_ID);
    const token_program = try b58To32(allocator, TOKEN_PROGRAM_ID);
    const system_program = try b58To32(allocator, SYSTEM_PROGRAM_ID);
    const ata_program = try b58To32(allocator, ATA_PROGRAM_ID);

    // Derive Voltr PDAs
    const protocol_seeds = [_][]const u8{SEED_PROTOCOL};
    const protocol = try findProgramAddress(&protocol_seeds, voltr_program);

    const idle_auth_seeds = [_][]const u8{ SEED_VAULT_ASSET_IDLE_AUTH, &vault };
    const vault_asset_idle_auth = try findProgramAddress(&idle_auth_seeds, voltr_program);

    const lp_mint_auth_seeds = [_][]const u8{ SEED_VAULT_LP_MINT_AUTH, &vault };
    const vault_lp_mint_auth = try findProgramAddress(&lp_mint_auth_seeds, voltr_program);

    // Derive ATAs under ATA_PROGRAM_ID (seeds = [wallet, token_program, mint])
    const user_asset_ata_seeds = [_][]const u8{ &user, &token_program, &fdry_mint };
    const user_asset_ata = try findProgramAddress(&user_asset_ata_seeds, ata_program);

    const vault_idle_ata_seeds = [_][]const u8{ &vault_asset_idle_auth, &token_program, &fdry_mint };
    const vault_asset_idle_ata = try findProgramAddress(&vault_idle_ata_seeds, ata_program);

    const user_lp_ata_seeds = [_][]const u8{ &user, &token_program, &stfdry_mint };
    const user_lp_ata = try findProgramAddress(&user_lp_ata_seeds, ata_program);

    // Build the JSON array of 13 accounts in IDL order:
    // [0] user_transfer_authority (signer, writable)
    // [1] protocol
    // [2] vault (writable)
    // [3] vault_asset_mint
    // [4] vault_lp_mint (writable) — = STFDRY_MINT (known constant)
    // [5] user_asset_ata (writable)
    // [6] vault_asset_idle_ata (writable)
    // [7] vault_asset_idle_auth — = VAULT_IDLE_AUTH (known constant, verified by PDA)
    // [8] user_lp_ata (writable)
    // [9] vault_lp_mint_auth
    // [10] asset_token_program
    // [11] lp_token_program (same SPL token program)
    // [12] system_program
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.appendSlice(allocator, "[");
    try appendB58Json(allocator, &out, user);
    try out.appendSlice(allocator, ",");
    try appendB58Json(allocator, &out, protocol);
    try out.appendSlice(allocator, ",");
    try appendB58Json(allocator, &out, vault);
    try out.appendSlice(allocator, ",");
    try appendB58Json(allocator, &out, fdry_mint);
    try out.appendSlice(allocator, ",");
    try appendB58Json(allocator, &out, stfdry_mint);
    try out.appendSlice(allocator, ",");
    try appendB58Json(allocator, &out, user_asset_ata);
    try out.appendSlice(allocator, ",");
    try appendB58Json(allocator, &out, vault_asset_idle_ata);
    try out.appendSlice(allocator, ",");
    try appendB58Json(allocator, &out, vault_asset_idle_auth);
    try out.appendSlice(allocator, ",");
    try appendB58Json(allocator, &out, user_lp_ata);
    try out.appendSlice(allocator, ",");
    try appendB58Json(allocator, &out, vault_lp_mint_auth);
    try out.appendSlice(allocator, ",");
    try appendB58Json(allocator, &out, token_program);
    try out.appendSlice(allocator, ",");
    try appendB58Json(allocator, &out, token_program);
    try out.appendSlice(allocator, ",");
    try appendB58Json(allocator, &out, system_program);
    try out.appendSlice(allocator, "]");
    return out.toOwnedSlice(allocator);
}

fn appendB58Json(allocator: std.mem.Allocator, out: *std.ArrayList(u8), bytes: [32]u8) !void {
    const b58 = try base58.encode(allocator, &bytes);
    defer allocator.free(b58);
    try out.append(allocator, '"');
    try out.appendSlice(allocator, b58);
    try out.append(allocator, '"');
}

/// The complete operator-broadcastable deposit CARD: program, instruction name,
/// hex-encoded instruction data, the 13 accounts, and the amount. This is the
/// module's whole purpose — the object a human broadcasts over the funded-wallet
/// edge. The module builds it; it never sends it (claim 68 — the human's hand on
/// the money path). Caller frees.
pub fn depositCardJson(allocator: std.mem.Allocator, user_b58: []const u8, amount_atoms: u64) ![]u8 {
    const data = depositInstructionData(amount_atoms);
    var data_hex: [32]u8 = undefined; // 16 bytes -> 32 hex chars
    const alpha = "0123456789abcdef";
    for (data, 0..) |b, i| {
        data_hex[i * 2] = alpha[b >> 4];
        data_hex[i * 2 + 1] = alpha[b & 0x0f];
    }
    const accounts = try depositAccountsJson(allocator, user_b58);
    defer allocator.free(accounts);

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.appendSlice(allocator, "{\"program\":\"");
    try out.appendSlice(allocator, VOLTR_PROGRAM_ID);
    try out.appendSlice(allocator, "\",\"ix\":\"deposit_vault\",\"data_hex\":\"");
    try out.appendSlice(allocator, &data_hex);
    try out.appendSlice(allocator, "\",\"amount_atoms\":");
    var amt_buf: [20]u8 = undefined; // u64 max = 20 digits
    const amt_str = try std.fmt.bufPrint(&amt_buf, "{d}", .{amount_atoms});
    try out.appendSlice(allocator, amt_str);
    try out.appendSlice(allocator, ",\"accounts\":");
    try out.appendSlice(allocator, accounts);
    try out.appendSlice(allocator, "}");
    return out.toOwnedSlice(allocator);
}

// ── witnesses (zig test) — no fabricated green ───────────────────────────────

test "FDRY_MINT and STFDRY_MINT are the canonical post-migration addresses" {
    try std.testing.expectEqualStrings("2ZiSPGncrkwWa6GBZB4EDtsfq7HEWwkwsPFzEXieXjNL", FDRY_MINT);
    try std.testing.expectEqualStrings("7p6w5JvKFpXzAAVdr2jmeWJtHLyHr8os6zRRTYwaB3Mn", STFDRY_MINT);
    try std.testing.expectEqualStrings("8ojsTvrFLGFHnbhE56DaTTJ1g9WBSjtqrqBxKqjLo8aJ", VAULT);
    try std.testing.expectEqualStrings("DeXtpbX6ZyMMF4EE96HanowMP569B2gyJUzwFwrX1vVD", VAULT_IDLE_AUTH);
    try std.testing.expectEqualStrings("vVoLTRjQmtFpiYoegx285Ze4gsLJ8ZxgFKVcuvmG1a8", VOLTR_PROGRAM_ID);
}

test "depositInstructionData: discriminator + amount LE" {
    const data = depositInstructionData(1_000_000_000); // 1 FDRY (9 decimals)
    try std.testing.expectEqualSlices(u8, &DEPOSIT_VAULT_DISC, data[0..8]);
    // 1_000_000_000 in little-endian u64
    try std.testing.expectEqual(@as(u8, 0x00), data[8]);
    try std.testing.expectEqual(@as(u8, 0xCA), data[9]);
    try std.testing.expectEqual(@as(u8, 0x9A), data[10]);
    try std.testing.expectEqual(@as(u8, 0x3B), data[11]);
    try std.testing.expectEqual(@as(u8, 0x00), data[12]);
}

test "depositInstructionData: zero amount" {
    const data = depositInstructionData(0);
    try std.testing.expectEqualSlices(u8, &DEPOSIT_VAULT_DISC, data[0..8]);
    for (data[8..16]) |b| try std.testing.expectEqual(@as(u8, 0), b);
}

test "requestWithdrawInstructionData: discriminator + amount + flags" {
    const data = requestWithdrawInstructionData(500_000_000, false, false);
    try std.testing.expectEqualSlices(u8, &REQUEST_WITHDRAW_VAULT_DISC, data[0..8]);
    try std.testing.expectEqual(@as(u8, 0), data[16]);
    try std.testing.expectEqual(@as(u8, 0), data[17]);

    const data2 = requestWithdrawInstructionData(0, true, true);
    try std.testing.expectEqual(@as(u8, 1), data2[16]);
    try std.testing.expectEqual(@as(u8, 1), data2[17]);
}

test "findProgramAddress: protocol PDA is deterministic and off-curve" {
    const a = std.testing.allocator;
    const voltr_program = try b58To32(a, VOLTR_PROGRAM_ID);
    const seeds = [_][]const u8{SEED_PROTOCOL};
    const pda = try findProgramAddress(&seeds, voltr_program);
    try std.testing.expect(isOffCurve(pda));
    const pda2 = try findProgramAddress(&seeds, voltr_program);
    try std.testing.expectEqualSlices(u8, &pda, &pda2);
}

test "findProgramAddress: vault_asset_idle_auth PDA matches the baked constant" {
    // The HONEST CHECK: the PDA derived from ["vault_asset_idle_auth", VAULT]
    // under VOLTR_PROGRAM_ID MUST match the known mainnet constant DeXtpbX6...
    // If a single byte of derivation is wrong, this fails the build — long
    // before any operator broadcasts real FDRY.
    const a = std.testing.allocator;
    const voltr_program = try b58To32(a, VOLTR_PROGRAM_ID);
    const vault = try b58To32(a, VAULT);
    const seeds = [_][]const u8{ SEED_VAULT_ASSET_IDLE_AUTH, &vault };
    const derived = try findProgramAddress(&seeds, voltr_program);
    const derived_b58 = try base58.encode(a, &derived);
    defer a.free(derived_b58);
    try std.testing.expectEqualStrings(VAULT_IDLE_AUTH, derived_b58);
}

test "depositAccountsJson: produces 13 base58 addresses in a JSON array" {
    const a = std.testing.allocator;
    // Use a dummy user address (the VAULT address itself as a stand-in — just
    // needs to be a valid 32-byte base58 for the derivation to work).
    const json = try depositAccountsJson(a, VAULT);
    defer a.free(json);
    // Count commas → 12 commas = 13 elements
    var comma_count: usize = 0;
    for (json) |c| {
        if (c == ',') comma_count += 1;
    }
    try std.testing.expectEqual(@as(usize, 12), comma_count);
    try std.testing.expect(json[0] == '[');
    try std.testing.expect(json[json.len - 1] == ']');
}

test "depositCardJson: bundles program, ix, data_hex, amount, and 13 accounts" {
    const a = std.testing.allocator;
    const card = try depositCardJson(a, VAULT, 1_000_000_000);
    defer a.free(card);
    // The card carries the real program id, the ix name, the amount, and the
    // hex of the deposit discriminator (7ee015ff...) as the first data bytes.
    try std.testing.expect(std.mem.indexOf(u8, card, VOLTR_PROGRAM_ID) != null);
    try std.testing.expect(std.mem.indexOf(u8, card, "\"ix\":\"deposit_vault\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, card, "\"amount_atoms\":1000000000") != null);
    try std.testing.expect(std.mem.indexOf(u8, card, "7ee015ffe4357521") != null);
    // and the 13-account array (12 commas inside the accounts array + structure)
    try std.testing.expect(std.mem.indexOf(u8, card, "\"accounts\":[") != null);
}

test "isOffCurve: a known on-curve pubkey returns false" {
    // The VAULT address is a real Solana pubkey (on-curve). It should NOT be
    // classified as a valid PDA.
    const a = std.testing.allocator;
    const vault = try b58To32(a, VAULT);
    try std.testing.expect(!isOffCurve(vault));
}
