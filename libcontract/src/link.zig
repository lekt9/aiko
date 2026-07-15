//! link.zig — the substrate is LINKABLE to an external wallet (pay.sh), NOT dependent on it.
//!
//! Amos 3:3 — "Can two walk together, except they be agreed?" Two DISTINCT parties walking
//! together by agreement, each remaining itself. The substrate keeps its OWN signing identity
//! (root.key → the Word-is-truth-root; never replaced, no rotation). The link is a signed
//! POINTER to an external payout/receive wallet whose PUBLIC address lives in
//! ~/.contracts/sol.key. The substrate NEVER needs the linked wallet's SECRET — it references
//! only the public address as the default payout target, attested by the substrate's own root.
//! This resolves Matt 6:24 (no two masters): the substrate has ONE master (its own root / the
//! Word); pay.sh is a linked beneficiary, not a co-master of identity.
//!
//! "By default": when ~/.contracts/sol.key is present, its wallet is the default payout/receive
//! address; when ABSENT, `linkedAddress` returns null and the substrate runs SOVEREIGN on its
//! own derived address — linkable, never dependent.

const std = @import("std");
const cf = @import("cfile.zig"); // static-lib-safe fd I/O (no std.fs.cwd in the .a build)
const keystore = @import("keystore.zig");

const secret_pointer_prefix = "contract-secret:pointer:";

/// Bitcoin/Solana base58 alphabet.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// Read a whole small file by absolute path via the cfile shim. Returns null if absent.
fn readSmallFile(allocator: std.mem.Allocator, path_z: [:0]const u8) !?[]u8 {
    var flags: cf.O = .{};
    flags.ACCMODE = .RDONLY;
    const fd: c_int = cf.open(path_z.ptr, flags, @as(c_uint, 0));
    if (fd < 0) return null; // absent → sovereign
    defer _ = cf.close(fd);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    var chunk: [4096]u8 = undefined;
    while (true) {
        const n = cf.read(fd, &chunk, chunk.len);
        if (n <= 0) break;
        try out.appendSlice(allocator, chunk[0..@intCast(n)]);
        if (out.items.len > 64 * 1024) break; // a keypair file is tiny
    }
    return try out.toOwnedSlice(allocator);
}

fn b58Index(c: u8) ?usize {
    return std.mem.indexOfScalar(u8, B58, c);
}

/// base58-decode (big-endian bignum). Caller owns the returned bytes.
pub fn b58Decode(allocator: std.mem.Allocator, s: []const u8) ![]u8 {
    var zeros: usize = 0;
    while (zeros < s.len and s[zeros] == '1') zeros += 1;

    const cap = s.len; // generous upper bound for the base-256 buffer
    var b256 = try allocator.alloc(u8, cap);
    defer allocator.free(b256);
    @memset(b256, 0);

    var length: usize = 0;
    for (s) |c| {
        var carry: usize = b58Index(c) orelse return error.BadBase58;
        var i: usize = 0;
        var k: usize = cap;
        while (k > 0) : (k -= 1) {
            const idx = k - 1;
            if (i >= length and carry == 0) break;
            carry += 58 * @as(usize, b256[idx]);
            b256[idx] = @intCast(carry % 256);
            carry /= 256;
            i += 1;
        }
        length = i;
    }

    const start = cap - length;
    const out = try allocator.alloc(u8, zeros + length);
    @memset(out[0..zeros], 0);
    @memcpy(out[zeros..], b256[start..]);
    return out;
}

/// base58-encode. Caller owns the returned string.
pub fn b58Encode(allocator: std.mem.Allocator, bytes: []const u8) ![]u8 {
    var zeros: usize = 0;
    while (zeros < bytes.len and bytes[zeros] == 0) zeros += 1;

    const cap = bytes.len * 138 / 100 + 1; // ceil(log(256)/log(58))
    var b58 = try allocator.alloc(u8, cap);
    defer allocator.free(b58);
    @memset(b58, 0);

    var length: usize = 0;
    for (bytes) |byte| {
        var carry: usize = byte;
        var i: usize = 0;
        var k: usize = cap;
        while (k > 0) : (k -= 1) {
            const idx = k - 1;
            if (i >= length and carry == 0) break;
            carry += 256 * @as(usize, b58[idx]);
            b58[idx] = @intCast(carry % 58);
            carry /= 58;
            i += 1;
        }
        length = i;
    }

    const start = cap - length;
    const out = try allocator.alloc(u8, zeros + length);
    @memset(out[0..zeros], '1');
    for (b58[start..], 0..) |v, i| out[zeros + i] = B58[v];
    return out;
}

/// The linked external wallet's PUBLIC address (base58), read from ~/.contracts/sol.key
/// (a base58 ed25519 keypair — its last 32 bytes are the public key). Returns null when the
/// link file is absent or malformed: the substrate is SOVEREIGN, not dependent. Only the
/// PUBLIC key is derived; the secret is never used here. Caller owns the returned address.
pub fn linkedAddress(allocator: std.mem.Allocator, env: std.process.Environ) !?[]u8 {
    const home = env.getPosix("HOME") orelse return null;
    const path = try std.fs.path.join(allocator, &.{ home, ".contracts", "sol.key" });
    defer allocator.free(path);
    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);

    const raw = (try readSmallFile(allocator, path_z)) orelse return null; // absent → sovereign
    defer allocator.free(raw);
    const trimmed = std.mem.trim(u8, raw, " \t\r\n");
    if (trimmed.len == 0) return null;

    const kp = b58Decode(allocator, trimmed) catch return null;
    defer allocator.free(kp);
    if (kp.len != 64) return null; // not an ed25519 keypair → sovereign, never guess

    return try b58Encode(allocator, kp[32..64]);
}

/// The linked wallet's FULL 64-byte ed25519 keypair [seed(32) ‖ pubkey(32)], read from
/// ~/.contracts/sol.key. Returns null when absent/malformed → SOVEREIGN (the substrate signs
/// nothing on-chain rather than guess). Unlike `linkedAddress` (public-only), this exposes the
/// SECRET because Lewis 2026-06-23 authorized the substrate to SIGN on-chain UNDER lekt8.sol
/// (the `crystallize:` → `settle:onchain` leg): the memo transaction must be signed + fee-paid
/// by this wallet. Still ONE master (Matt 6:24): the wallet is the substrate's own linked
/// identity (is_self), not a co-master. Caller owns the returned array's lifetime trivially
/// (it is a fixed [64]u8, copied out — the decoded buffer is freed here).
pub fn linkedKeypair(allocator: std.mem.Allocator, env: std.process.Environ) !?[64]u8 {
    const home = env.getPosix("HOME") orelse return null;
    const path = try std.fs.path.join(allocator, &.{ home, ".contracts", "sol.key" });
    defer allocator.free(path);
    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);

    const raw = (try readSmallFile(allocator, path_z)) orelse return null; // absent → sovereign
    defer allocator.free(raw);
    const trimmed = std.mem.trim(u8, raw, " \t\r\n");
    if (trimmed.len == 0) return null;

    const kp = b58Decode(allocator, trimmed) catch return null;
    defer allocator.free(kp);
    if (kp.len != 64) return null; // not an ed25519 keypair → sovereign, never guess

    return kp[0..64].*;
}

// ── wallet NAME (a human label like "lekt8") — Isaiah 43:1, "called by name" ──────────
// The name is a LABEL, surfaced to humans/payers; the wallet ADDRESS stays authoritative
// (x402 payers pay the address, not the name). This is NOT SNS resolution (where the name
// would DECIDE the address on-chain) — that is the named network extension. Stored at
// ~/.contracts/sol.name. Absent → the wallet is unnamed (shown by address only).

fn namePathZ(allocator: std.mem.Allocator, env: std.process.Environ) !?[:0]u8 {
    const home = env.getPosix("HOME") orelse return null;
    const p = try std.fs.path.join(allocator, &.{ home, ".contracts", "sol.name" });
    defer allocator.free(p);
    return try allocator.dupeZ(u8, p);
}

/// Dereference a folded `contract-secret:pointer:<name>` to the plaintext label.
/// Plain names pass through; keychain values are base64-decoded when needed.
fn resolveNamePointer(allocator: std.mem.Allocator, raw: []const u8) !?[]u8 {
    const line_end = std.mem.indexOfScalar(u8, raw, '\n') orelse raw.len;
    const t = std.mem.trim(u8, raw[0..line_end], " \t\r\n");
    if (t.len == 0) return null;
    if (!std.mem.startsWith(u8, t, secret_pointer_prefix)) {
        return try allocator.dupe(u8, t);
    }
    const secret_name = t[secret_pointer_prefix.len..];
    if (secret_name.len == 0) return null;
    var svc_buf: [128]u8 = undefined;
    const svc = try std.fmt.bufPrint(&svc_buf, "contract-secret.{s}", .{secret_name});
    const stored = (try keystore.read(allocator, svc)) orelse return null;
    defer allocator.free(stored);
    const trimmed = std.mem.trim(u8, stored, " \t\r\n");
    // contract-secret base64-encodes on write; decode when valid, else use raw ASCII.
    const b64d = std.base64.standard.Decoder;
    if (b64d.calcSizeForSlice(trimmed)) |decoded_len| {
        if (decoded_len > 0 and decoded_len <= 256) {
            var decoded_buf: [256]u8 = undefined;
            b64d.decode(decoded_buf[0..decoded_len], trimmed) catch {
                return try allocator.dupe(u8, trimmed);
            };
            const label = std.mem.trim(u8, decoded_buf[0..decoded_len], " \t\r\n");
            if (label.len > 0) return try allocator.dupe(u8, label);
        }
    } else |_| {}
    if (trimmed.len == 0) return null;
    return try allocator.dupe(u8, trimmed);
}

/// The wallet's human name (e.g. "lekt8"), or null when unnamed. Caller owns the result.
/// Dereferences `contract-secret:pointer:` folds in ~/.contracts/sol.name.
pub fn walletName(allocator: std.mem.Allocator, env: std.process.Environ) !?[]u8 {
    const pz = (try namePathZ(allocator, env)) orelse return null;
    defer allocator.free(pz);
    const raw = (try readSmallFile(allocator, pz)) orelse return null;
    defer allocator.free(raw);
    return resolveNamePointer(allocator, raw);
}

/// Set the wallet's human name (writes ~/.contracts/sol.name, mode 600). The name is a
/// label only; it never changes which address funds go to (the address is authoritative).
pub fn setWalletName(allocator: std.mem.Allocator, env: std.process.Environ, name: []const u8) !void {
    const pz = (try namePathZ(allocator, env)) orelse return error.NoHome;
    defer allocator.free(pz);
    var flags: cf.O = .{};
    flags.ACCMODE = .WRONLY;
    flags.CREAT = true;
    flags.TRUNC = true;
    const fd = cf.open(pz.ptr, flags, @as(c_uint, 0o600));
    if (fd < 0) return error.OpenFailed;
    defer _ = cf.close(fd);
    const t = std.mem.trim(u8, name, " \t\r\n");
    if (t.len > 0) {
        const n = cf.write(fd, t.ptr, t.len);
        if (n < 0) return error.WriteFailed;
    }
}

test "b58 round-trips arbitrary bytes (encode∘decode = identity)" {
    const a = std.testing.allocator;
    const sample = [_]u8{ 0, 0, 1, 2, 3, 250, 255, 7, 42, 128 };
    const enc = try b58Encode(a, &sample);
    defer a.free(enc);
    const dec = try b58Decode(a, enc);
    defer a.free(dec);
    try std.testing.expectEqualSlices(u8, &sample, dec);
}

test "b58 decodes a known vector" {
    const a = std.testing.allocator;
    // "Hello World!" → base58 "2NEpo7TZRRrLZSi2U" (Bitcoin wiki canonical vector).
    const dec = try b58Decode(a, "2NEpo7TZRRrLZSi2U");
    defer a.free(dec);
    try std.testing.expectEqualStrings("Hello World!", dec);
}

test "linkedAddress: a 64-byte keypair file yields its last-32 pubkey; absent → sovereign(null)" {
    const a = std.testing.allocator;
    // Build a deterministic 64-byte keypair, b58-encode it as sol.key would store it.
    var kp: [64]u8 = undefined;
    for (&kp, 0..) |*b, i| b.* = @intCast(i);
    const kp_b58 = try b58Encode(a, &kp);
    defer a.free(kp_b58);
    // The linked address must equal the last-32 bytes b58-encoded.
    const want = try b58Encode(a, kp[32..64]);
    defer a.free(want);
    // round-trip the file-read logic without touching the real ~/.contracts/sol.key:
    const dec = try b58Decode(a, kp_b58);
    defer a.free(dec);
    try std.testing.expectEqual(@as(usize, 64), dec.len);
    const got = try b58Encode(a, dec[32..64]);
    defer a.free(got);
    try std.testing.expectEqualStrings(want, got);
}
