//! cas.zig — content-addressed store: dedup for free (Phase 2 cost lever).
//!
//! A chunk is (sha256(bytes), bytes). Storing content under its hash-derived key
//! is WRITE-IF-ABSENT: identical content maps to the identical key, so a shared
//! blob (a base centroid, a common weight tensor) is written/paid exactly ONCE
//! no matter how many contracts reference it. This makes "share data in the
//! ledger" a property of the addressing, not a special case.
//!
//! This module is the backend-agnostic core: `contentHash`/`hexKey` (also used
//! by the Solana backend to derive a content PDA) plus `Store`, an in-memory
//! reference backend that proves the put-if-absent + dedup + integrity contract.
//! Persistent backends (a local dir via libc I/O; a Solana content-PDA) satisfy
//! the SAME contract and are wired later — prove the mechanism first, then pay
//! to persist it. Never pay on-chain for a mechanism unproven off-chain.

const std = @import("std");
const Sha256 = std.crypto.hash.sha2.Sha256;

pub const HASH_LEN = 32;
pub const HEX_LEN = 64;

pub fn contentHash(bytes: []const u8) [HASH_LEN]u8 {
    var h: [HASH_LEN]u8 = undefined;
    Sha256.hash(bytes, &h, .{});
    return h;
}

pub fn hexKey(h: [HASH_LEN]u8, out: *[HEX_LEN]u8) void {
    const alpha = "0123456789abcdef";
    for (h, 0..) |b, i| {
        out[i * 2] = alpha[b >> 4];
        out[i * 2 + 1] = alpha[b & 0x0f];
    }
}

/// Re-verification verdict, content-addressed. Does `bytes` reproduce the
/// attestation `key`? Re-run a route, hash the observation, compare to the
/// committed key — TRUE iff they match. This is the whole payoff of
/// content-addressing: "is it still fresh/valid" is a HASH EQUALITY anyone can
/// recompute, not a trust assertion. A drifted route hashes to a different key
/// and fails. `key` must be HEX_LEN hex chars (a non-matching length is false,
/// never an error — an unattested route is simply unverified).
pub fn reproduces(key: []const u8, bytes: []const u8) bool {
    if (key.len != HEX_LEN) return false;
    var got: [HEX_LEN]u8 = undefined;
    hexKey(contentHash(bytes), &got);
    return std.mem.eql(u8, &got, key);
}

pub const PutResult = struct {
    key: [HEX_LEN]u8,
    /// false when the content was already present — DEDUP: no new bytes stored.
    new: bool,
};

/// In-memory content-addressed store — the reference backend. Persistent
/// backends (local dir, Solana content-PDA) implement the same put/get contract.
pub const Store = struct {
    allocator: std.mem.Allocator,
    map: std.StringHashMap([]u8), // hex-key -> owned bytes

    pub fn init(allocator: std.mem.Allocator) Store {
        return .{ .allocator = allocator, .map = std.StringHashMap([]u8).init(allocator) };
    }

    pub fn deinit(self: *Store) void {
        var it = self.map.iterator();
        while (it.next()) |e| {
            self.allocator.free(e.key_ptr.*);
            self.allocator.free(e.value_ptr.*);
        }
        self.map.deinit();
    }

    /// Write-if-absent. Content already present -> new=false, nothing stored.
    pub fn put(self: *Store, bytes: []const u8) !PutResult {
        var res: PutResult = .{ .key = undefined, .new = false };
        hexKey(contentHash(bytes), &res.key);
        if (self.map.contains(&res.key)) return res; // DEDUP
        const key_owned = try self.allocator.dupe(u8, &res.key);
        errdefer self.allocator.free(key_owned);
        const val_owned = try self.allocator.dupe(u8, bytes);
        errdefer self.allocator.free(val_owned);
        try self.map.put(key_owned, val_owned);
        res.new = true;
        return res;
    }

    /// Read a chunk back by hex key, verifying integrity (stored bytes must hash
    /// to the key — a corrupted store is caught, never silently surfaced).
    /// Returns a view owned by the Store (valid until deinit); null if absent.
    pub fn get(self: *Store, key: []const u8) !?[]const u8 {
        const v = self.map.get(key) orelse return null;
        var got: [HEX_LEN]u8 = undefined;
        hexKey(contentHash(v), &got);
        if (!std.mem.eql(u8, &got, key)) return error.HashMismatch;
        return v;
    }

    pub fn count(self: *Store) usize {
        return self.map.count();
    }
};

// ── tests ────────────────────────────────────────────────────────────────

test "put is write-if-absent: identical content stored once (dedup)" {
    var s = Store.init(std.testing.allocator);
    defer s.deinit();
    const blob = "the shared base centroid bytes";

    const a = try s.put(blob);
    try std.testing.expect(a.new); // first store: written

    const b = try s.put(blob);
    try std.testing.expect(!b.new); // second identical: DEDUP, not written
    try std.testing.expectEqualSlices(u8, &a.key, &b.key); // same content -> same key
    try std.testing.expectEqual(@as(usize, 1), s.count()); // exactly one entry
}

test "distinct content -> distinct keys, both stored" {
    var s = Store.init(std.testing.allocator);
    defer s.deinit();
    const a = try s.put("base weights");
    const b = try s.put("a small delta");
    try std.testing.expect(a.new and b.new);
    try std.testing.expect(!std.mem.eql(u8, &a.key, &b.key));
    try std.testing.expectEqual(@as(usize, 2), s.count());
}

test "get round-trips and verifies integrity; absent -> null" {
    var s = Store.init(std.testing.allocator);
    defer s.deinit();
    const r = try s.put("weight delta payload");
    const got = (try s.get(&r.key)).?;
    try std.testing.expectEqualStrings("weight delta payload", got);
    try std.testing.expect((try s.get(&("f" ** HEX_LEN).*)) == null);
}

test "content key is deterministic and matches a fresh hash" {
    var k1: [HEX_LEN]u8 = undefined;
    hexKey(contentHash("route:verb:python"), &k1);
    var k2: [HEX_LEN]u8 = undefined;
    hexKey(contentHash("route:verb:python"), &k2);
    try std.testing.expectEqualSlices(u8, &k1, &k2);
}

test "reproduces: a matching re-run verifies; a drifted one does not" {
    var key: [HEX_LEN]u8 = undefined;
    hexKey(contentHash("route shape v1"), &key);
    // same observation reproduces the committed attestation → verified
    try std.testing.expect(reproduces(&key, "route shape v1"));
    // drifted observation → different hash → NOT verified
    try std.testing.expect(!reproduces(&key, "route shape v2 (drifted)"));
    // a malformed/absent key length → unverified, not an error
    try std.testing.expect(!reproduces("deadbeef", "route shape v1"));
}
