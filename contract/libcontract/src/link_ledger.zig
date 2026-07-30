//! link_ledger.zig — bind a route owner's lineage identity to a Solana wallet.
//!
//! The commons has two identity systems for the same person: the ledger's
//! `env_pubkey` (the ed25519 LINEAGE identity that declares routes, used for
//! self-exclusion) and a Solana WALLET (base58, holds stFDRY / receives USDC,
//! used for stake + payout). The epoch needs to know they are the same party —
//! but a bare assertion would let an attacker claim a heavily-staked wallet they
//! don't own (to borrow its stake) or claim someone else's rewards.
//!
//! So the binding is MUTUAL: a `link` row is valid only if BOTH keys signed the
//! same digest. The env key can't borrow a wallet's stake without the wallet's
//! signature; the wallet can't claim the env's rewards without the env's
//! signature. Both are ed25519, so both sides reuse lineage.verifyDigest.
//!
//!   {"event":"link","env_pubkey":"<hex>","solana_wallet":"<b58>",
//!    "env_signature":"<hex>","wallet_signature":"<hex>","ts":"..."}
//!
//! `emitLinkRow` only BUILDS the row (parity claim 8 — only ledger.zig appends).
//! `linkedWallet` resolves the VERIFIED wallet for an env_pubkey from a ledger
//! window. Zero external dependency: std + base58 + the core lineage module.

const std = @import("std");
const base58 = @import("base58.zig");
const lineage = @import("lineage.zig");
const Sha256 = std.crypto.hash.sha2.Sha256;
const ed = std.crypto.sign.Ed25519;

pub const LINK_EVENT = "link";

/// The digest both keys sign: sha256("link:" ++ env_pubkey_hex ++ ":" ++ wallet_b58).
pub fn linkDigest(env_pubkey_hex: []const u8, solana_wallet_b58: []const u8) [32]u8 {
    var h = Sha256.init(.{});
    h.update("link:");
    h.update(env_pubkey_hex);
    h.update(":");
    h.update(solana_wallet_b58);
    var d: [32]u8 = undefined;
    h.final(&d);
    return d;
}

/// Sign one side of a link with `kp` (either the env lineage key or the wallet
/// key). Writes the hex signature. Used by the operator to produce a link row.
pub fn signSide(
    kp: ed.KeyPair,
    env_pubkey_hex: []const u8,
    solana_wallet_b58: []const u8,
    out: *[lineage.SIG_HEX_LEN]u8,
) !void {
    try lineage.signDigest(kp, linkDigest(env_pubkey_hex, solana_wallet_b58), out);
}

/// Verify a MUTUAL binding: BOTH the env key and the wallet key signed the digest.
pub fn verifyLink(
    allocator: std.mem.Allocator,
    env_pubkey_hex: []const u8,
    solana_wallet_b58: []const u8,
    env_sig_hex: []const u8,
    wallet_sig_hex: []const u8,
) bool {
    const digest = linkDigest(env_pubkey_hex, solana_wallet_b58);
    // env side — env_pubkey is already hex.
    lineage.verifyDigest(env_sig_hex, env_pubkey_hex, digest) catch return false;
    // wallet side — base58 wallet → 32 bytes → hex, then verify.
    const wbytes = base58.decode(allocator, solana_wallet_b58) catch return false;
    defer allocator.free(wbytes);
    if (wbytes.len != 32) return false;
    var wallet_hex: [lineage.PUBKEY_HEX_LEN]u8 = undefined;
    lineage.bytesToHex(wbytes[0..32], &wallet_hex);
    lineage.verifyDigest(wallet_sig_hex, &wallet_hex, digest) catch return false;
    return true;
}

/// Build a link ledger line (JSONL). Pure string builder — never opens the
/// ledger. Caller frees.
pub fn emitLinkRow(
    allocator: std.mem.Allocator,
    env_pubkey_hex: []const u8,
    solana_wallet_b58: []const u8,
    env_sig_hex: []const u8,
    wallet_sig_hex: []const u8,
    ts: []const u8,
) ![]u8 {
    return std.fmt.allocPrint(
        allocator,
        "{{\"event\":\"{s}\",\"env_pubkey\":\"{s}\",\"solana_wallet\":\"{s}\",\"env_signature\":\"{s}\",\"wallet_signature\":\"{s}\",\"ts\":\"{s}\"}}",
        .{ LINK_EVENT, env_pubkey_hex, solana_wallet_b58, env_sig_hex, wallet_sig_hex, ts },
    );
}

fn strField(obj: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const v = obj.get(key) orelse return null;
    return switch (v) {
        .string => |s| s,
        else => null,
    };
}

/// Resolve the VERIFIED Solana wallet linked to `env_pubkey_hex`, scanning the
/// ledger window. The LATEST link whose mutual signatures verify wins (append-only
/// → newest binding); an unsigned/half-signed/forged link is skipped. Returns the
/// wallet base58 (owned), or null if none. Caller frees.
pub fn linkedWallet(
    allocator: std.mem.Allocator,
    jsonl: []const u8,
    env_pubkey_hex: []const u8,
) !?[]u8 {
    var result: ?[]u8 = null;
    errdefer if (result) |w| allocator.free(w);

    var it = std.mem.splitScalar(u8, jsonl, '\n');
    while (it.next()) |raw| {
        const line = std.mem.trim(u8, raw, " \t\r");
        if (line.len == 0) continue;
        const parsed = std.json.parseFromSlice(std.json.Value, allocator, line, .{}) catch continue;
        defer parsed.deinit();
        const obj = switch (parsed.value) {
            .object => |o| o,
            else => continue,
        };
        const ev = strField(obj, "event") orelse continue;
        if (!std.mem.eql(u8, ev, LINK_EVENT)) continue;
        const ep = strField(obj, "env_pubkey") orelse continue;
        if (!std.mem.eql(u8, ep, env_pubkey_hex)) continue;
        const wallet = strField(obj, "solana_wallet") orelse continue;
        const esig = strField(obj, "env_signature") orelse continue;
        const wsig = strField(obj, "wallet_signature") orelse continue;
        if (!verifyLink(allocator, ep, wallet, esig, wsig)) continue; // forged → skip
        if (result) |old| allocator.free(old);
        result = try allocator.dupe(u8, wallet);
    }
    return result;
}

// ── witnesses (zig test) — no fabricated green ───────────────────────────────

const TestLink = struct {
    env_hex: [lineage.PUBKEY_HEX_LEN]u8,
    wallet_b58: []u8,
    env_sig: [lineage.SIG_HEX_LEN]u8,
    wallet_sig: [lineage.SIG_HEX_LEN]u8,
};

/// Build a fully mutually-signed link from two keypairs (test helper).
fn makeLink(allocator: std.mem.Allocator, env_kp: ed.KeyPair, wallet_kp: ed.KeyPair) !TestLink {
    var l: TestLink = undefined;
    lineage.bytesToHex(&env_kp.public_key.bytes, &l.env_hex);
    l.wallet_b58 = try base58.encode(allocator, &wallet_kp.public_key.bytes);
    try signSide(env_kp, &l.env_hex, l.wallet_b58, &l.env_sig);
    try signSide(wallet_kp, &l.env_hex, l.wallet_b58, &l.wallet_sig);
    return l;
}

test "verifyLink: mutual signatures pass" {
    const a = std.testing.allocator;
    const env_kp = try ed.KeyPair.generateDeterministic([_]u8{1} ** 32);
    const wallet_kp = try ed.KeyPair.generateDeterministic([_]u8{2} ** 32);
    var l = try makeLink(a, env_kp, wallet_kp);
    defer a.free(l.wallet_b58);
    try std.testing.expect(verifyLink(a, &l.env_hex, l.wallet_b58, &l.env_sig, &l.wallet_sig));
}

test "STAKE-BORROW BLOCKED: env signs, but the wallet did NOT (forged wallet sig)" {
    const a = std.testing.allocator;
    // attacker env key; a rich victim wallet the attacker does NOT control.
    const env_kp = try ed.KeyPair.generateDeterministic([_]u8{3} ** 32);
    const victim_wallet = try ed.KeyPair.generateDeterministic([_]u8{4} ** 32);
    var env_hex: [lineage.PUBKEY_HEX_LEN]u8 = undefined;
    lineage.bytesToHex(&env_kp.public_key.bytes, &env_hex);
    const wallet_b58 = try base58.encode(a, &victim_wallet.public_key.bytes);
    defer a.free(wallet_b58);
    var env_sig: [lineage.SIG_HEX_LEN]u8 = undefined;
    try signSide(env_kp, &env_hex, wallet_b58, &env_sig);
    // attacker forges the wallet sig by signing with THEIR OWN key (not the victim's).
    var forged: [lineage.SIG_HEX_LEN]u8 = undefined;
    try signSide(env_kp, &env_hex, wallet_b58, &forged);
    // mutual check fails: the victim wallet never signed → no stake borrowing.
    try std.testing.expect(!verifyLink(a, &env_hex, wallet_b58, &env_sig, &forged));
}

test "REWARD-HIJACK BLOCKED: wallet signs, but env sig is tampered" {
    const a = std.testing.allocator;
    const env_kp = try ed.KeyPair.generateDeterministic([_]u8{5} ** 32);
    const wallet_kp = try ed.KeyPair.generateDeterministic([_]u8{6} ** 32);
    var l = try makeLink(a, env_kp, wallet_kp);
    defer a.free(l.wallet_b58);
    l.env_sig[0] = if (l.env_sig[0] == 'a') 'b' else 'a'; // tamper one hex char
    try std.testing.expect(!verifyLink(a, &l.env_hex, l.wallet_b58, &l.env_sig, &l.wallet_sig));
}

test "linkedWallet resolves a verified link from the ledger; forged is skipped" {
    const a = std.testing.allocator;
    const env_kp = try ed.KeyPair.generateDeterministic([_]u8{7} ** 32);
    const wallet_kp = try ed.KeyPair.generateDeterministic([_]u8{8} ** 32);
    var l = try makeLink(a, env_kp, wallet_kp);
    defer a.free(l.wallet_b58);

    // a valid row + a forged row (wallet_sig garbage) for a DIFFERENT env key.
    const good = try emitLinkRow(a, &l.env_hex, l.wallet_b58, &l.env_sig, &l.wallet_sig, "t");
    defer a.free(good);
    const forged = try emitLinkRow(a, "ff" ** 32, "SomeWallet1111111111111111111111111111111111", "00" ** 64, "00" ** 64, "t");
    defer a.free(forged);
    const jsonl = try std.mem.join(a, "\n", &.{ forged, good });
    defer a.free(jsonl);

    const w = (try linkedWallet(a, jsonl, &l.env_hex)).?;
    defer a.free(w);
    try std.testing.expectEqualStrings(l.wallet_b58, w);

    // a env with no valid link → null.
    const none = try linkedWallet(a, jsonl, "ab" ** 32);
    try std.testing.expect(none == null);
}
