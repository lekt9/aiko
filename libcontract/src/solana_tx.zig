//! solana_tx.zig — legacy transaction encoding and signing. Pure, offline, testable.
//!
//! The substrate could already derive a PDA (voltr.findProgramAddress), encode an
//! instruction (spl_balance), sign with Ed25519 (lineage), and base58 (link) — but
//! it could never *build a transaction*, so every on-chain write shelled out to
//! python/solders. This is the missing middle: account-list compilation, message
//! serialization, signing, wire format.
//!
//! Nothing here touches the network or the filesystem. Given the same inputs it
//! emits the same bytes, so it can be tested against a known-good transaction
//! without a validator.

const std = @import("std");
const Ed25519 = std.crypto.sign.Ed25519;
const Sha256 = std.crypto.hash.sha2.Sha256;

pub const TxError = error{ OutOfMemory, TooManyAccounts };

pub const SYSTEM_PROGRAM: [32]u8 = [_]u8{0} ** 32;

pub const AccountMeta = struct {
    pubkey: [32]u8,
    is_signer: bool,
    is_writable: bool,
};

/// Anchor's global instruction discriminator: sha256("global:<name>")[0..8].
pub fn anchorDiscriminator(name: []const u8) [8]u8 {
    var h = Sha256.init(.{});
    h.update("global:");
    h.update(name);
    var digest: [32]u8 = undefined;
    h.final(&digest);
    return digest[0..8].*;
}

/// shortvec / compact-u16: Solana's length prefix.
fn encodeLength(out: *std.ArrayList(u8), allocator: std.mem.Allocator, n: usize) TxError!void {
    var rem = n;
    while (true) {
        var elem: u8 = @intCast(rem & 0x7f);
        rem >>= 7;
        if (rem == 0) {
            out.append(allocator, elem) catch return TxError.OutOfMemory;
            return;
        }
        elem |= 0x80;
        out.append(allocator, elem) catch return TxError.OutOfMemory;
    }
}

/// Compile a single-instruction legacy message.
///
/// Solana demands deduplicated account keys in canonical order — writable signers,
/// readonly signers, writable non-signers, readonly non-signers — with the fee
/// payer first. `accounts` is the instruction's list in *program* order, and the
/// same pubkey may legitimately appear twice (declare_iq passes the deployer as
/// both `deployer` and `payer`); duplicates are merged here, taking the union of
/// their flags, exactly as solders does.
pub fn compileMessage(
    allocator: std.mem.Allocator,
    accounts: []const AccountMeta,
    program_id: [32]u8,
    data: []const u8,
    recent_blockhash: [32]u8,
    fee_payer: [32]u8,
) TxError![]u8 {
    var merged: std.ArrayList(AccountMeta) = .empty;
    defer merged.deinit(allocator);

    const upsert = struct {
        fn f(list: *std.ArrayList(AccountMeta), alloc: std.mem.Allocator, meta: AccountMeta) TxError!void {
            for (list.items) |*existing| {
                if (std.mem.eql(u8, &existing.pubkey, &meta.pubkey)) {
                    existing.is_signer = existing.is_signer or meta.is_signer;
                    existing.is_writable = existing.is_writable or meta.is_writable;
                    return;
                }
            }
            list.append(alloc, meta) catch return TxError.OutOfMemory;
        }
    }.f;

    // Fee payer first: it always signs and always pays, whatever the instruction said.
    try upsert(&merged, allocator, .{ .pubkey = fee_payer, .is_signer = true, .is_writable = true });
    for (accounts) |meta| try upsert(&merged, allocator, meta);
    try upsert(&merged, allocator, .{ .pubkey = program_id, .is_signer = false, .is_writable = false });

    // Canonical order, fee payer pinned at index 0.
    const keys = merged.items;
    if (keys.len > 255) return TxError.TooManyAccounts;
    std.mem.sort(AccountMeta, keys[1..], {}, struct {
        fn rank(m: AccountMeta) u2 {
            if (m.is_signer) return if (m.is_writable) 0 else 1;
            return if (m.is_writable) 2 else 3;
        }
        fn lessThan(_: void, a: AccountMeta, b: AccountMeta) bool {
            return rank(a) < rank(b);
        }
    }.lessThan);

    var num_signers: u8 = 0;
    var num_readonly_signed: u8 = 0;
    var num_readonly_unsigned: u8 = 0;
    for (keys) |k| {
        if (k.is_signer) {
            num_signers += 1;
            if (!k.is_writable) num_readonly_signed += 1;
        } else if (!k.is_writable) num_readonly_unsigned += 1;
    }

    const indexOf = struct {
        fn f(list: []const AccountMeta, pubkey: [32]u8) u8 {
            for (list, 0..) |k, i| {
                if (std.mem.eql(u8, &k.pubkey, &pubkey)) return @intCast(i);
            }
            unreachable; // every key was upserted above
        }
    }.f;

    var msg: std.ArrayList(u8) = .empty;
    errdefer msg.deinit(allocator);

    msg.append(allocator, num_signers) catch return TxError.OutOfMemory;
    msg.append(allocator, num_readonly_signed) catch return TxError.OutOfMemory;
    msg.append(allocator, num_readonly_unsigned) catch return TxError.OutOfMemory;

    try encodeLength(&msg, allocator, keys.len);
    for (keys) |k| msg.appendSlice(allocator, &k.pubkey) catch return TxError.OutOfMemory;

    msg.appendSlice(allocator, &recent_blockhash) catch return TxError.OutOfMemory;

    try encodeLength(&msg, allocator, 1); // exactly one instruction
    msg.append(allocator, indexOf(keys, program_id)) catch return TxError.OutOfMemory;
    try encodeLength(&msg, allocator, accounts.len);
    for (accounts) |a| msg.append(allocator, indexOf(keys, a.pubkey)) catch return TxError.OutOfMemory;
    try encodeLength(&msg, allocator, data.len);
    msg.appendSlice(allocator, data) catch return TxError.OutOfMemory;

    return msg.toOwnedSlice(allocator) catch TxError.OutOfMemory;
}

/// Sign a compiled message and prepend the signature vector → the wire transaction.
pub fn signTransaction(
    allocator: std.mem.Allocator,
    message: []const u8,
    kp: Ed25519.KeyPair,
) TxError![]u8 {
    const sig = kp.sign(message, null) catch return TxError.OutOfMemory;
    const sig_bytes = sig.toBytes();

    var tx: std.ArrayList(u8) = .empty;
    errdefer tx.deinit(allocator);
    try encodeLength(&tx, allocator, 1);
    tx.appendSlice(allocator, &sig_bytes) catch return TxError.OutOfMemory;
    tx.appendSlice(allocator, message) catch return TxError.OutOfMemory;
    return tx.toOwnedSlice(allocator) catch TxError.OutOfMemory;
}

test "anchor discriminator matches the on-chain declare_iq" {
    // sha256("global:declare_iq")[0..8] — the value the deployed program dispatches on.
    // Independently: python -c 'import hashlib;print(hashlib.sha256(b"global:declare_iq").hexdigest()[:16])'
    const disc = anchorDiscriminator("declare_iq");
    try std.testing.expectEqualSlices(
        u8,
        &[_]u8{ 0xcd, 0xaf, 0xd7, 0xe1, 0xc0, 0x3a, 0x8b, 0x3d },
        &disc,
    );
}

test "shortvec encodes the compact-u16 boundary cases" {
    const t = std.testing;
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(t.allocator);

    try encodeLength(&buf, t.allocator, 0);
    try t.expectEqualSlices(u8, &.{0}, buf.items);

    buf.clearRetainingCapacity();
    try encodeLength(&buf, t.allocator, 127);
    try t.expectEqualSlices(u8, &.{0x7f}, buf.items);

    buf.clearRetainingCapacity();
    try encodeLength(&buf, t.allocator, 128);
    try t.expectEqualSlices(u8, &.{ 0x80, 0x01 }, buf.items);
}

test "compileMessage dedupes a repeated signer and pins the fee payer first" {
    const t = std.testing;
    const signer = [_]u8{1} ** 32;
    const pda = [_]u8{2} ** 32;
    const program = [_]u8{3} ** 32;
    const blockhash = [_]u8{4} ** 32;

    // declare_iq's shape: pda, deployer, payer (same key as deployer), system program.
    const accounts = [_]AccountMeta{
        .{ .pubkey = pda, .is_signer = false, .is_writable = true },
        .{ .pubkey = signer, .is_signer = true, .is_writable = false },
        .{ .pubkey = signer, .is_signer = true, .is_writable = true },
        .{ .pubkey = SYSTEM_PROGRAM, .is_signer = false, .is_writable = false },
    };

    const msg = try compileMessage(t.allocator, &accounts, program, "hi", blockhash, signer);
    defer t.allocator.free(msg);

    // header: 1 signer, 0 readonly-signed, 2 readonly-unsigned (system + program)
    try t.expectEqual(@as(u8, 1), msg[0]);
    try t.expectEqual(@as(u8, 0), msg[1]);
    try t.expectEqual(@as(u8, 2), msg[2]);
    // 4 unique keys (signer merged from two entries), fee payer first
    try t.expectEqual(@as(u8, 4), msg[3]);
    try t.expectEqualSlices(u8, &signer, msg[4..36]);
}
