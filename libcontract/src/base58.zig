//! base58.zig — the pure base58 codec, std-only. Zero dependencies.
//!
//! Self-contained: imports NOTHING but `std` (no file I/O, no keystore, no
//! shell, no fetched package). This is the whole reason the Solana devnet
//! capability is a zero-dependency unit — `solana_rpc` (std + native TLS) plus
//! this codec plus `devnet_probe` form a closure that touches only `std`.
//!
//! Extracted verbatim from link.zig's b58 core (link kept its wallet-file
//! plumbing, which the devnet path never needs). The Bitcoin/Solana alphabet;
//! leading-zero bytes map to leading '1's and back, so encode∘decode = identity.

const std = @import("std");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

fn b58Index(c: u8) ?usize {
    return std.mem.indexOfScalar(u8, B58, c);
}

/// base58-decode (big-endian bignum). Caller owns the returned bytes.
pub fn decode(allocator: std.mem.Allocator, s: []const u8) ![]u8 {
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
pub fn encode(allocator: std.mem.Allocator, bytes: []const u8) ![]u8 {
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

// ── tests ────────────────────────────────────────────────────────────────

test "b58 round-trips arbitrary bytes (encode∘decode = identity)" {
    const a = std.testing.allocator;
    const sample = [_]u8{ 0, 0, 1, 2, 3, 250, 255, 7, 42, 128 };
    const enc = try encode(a, &sample);
    defer a.free(enc);
    const dec = try decode(a, enc);
    defer a.free(dec);
    try std.testing.expectEqualSlices(u8, &sample, dec);
}

test "b58 decodes a known vector" {
    const a = std.testing.allocator;
    // "Hello World!" → base58 "2NEpo7TZRRrLZSi2U" (Bitcoin wiki canonical vector).
    const dec = try decode(a, "2NEpo7TZRRrLZSi2U");
    defer a.free(dec);
    try std.testing.expectEqualStrings("Hello World!", dec);
}
