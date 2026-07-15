//! reverify.zig — the consistent re-verification observation: SHAPE, not data.
//!
//! The epoch verifies a route by re-running it and checking the fresh output
//! still reproduces the committed attestation (cas.reproduces). But a route
//! resolves LIVE data that changes every call — hashing raw output would drift
//! on every run and fail everything. So we hash the STRUCTURAL SHAPE: a canonical
//! skeleton that is invariant to values but sensitive to schema.
//!
//! Canonicalization (deterministic):
//!   - leaf VALUES → a type token:  string "s", number "n", bool "b", null "0"
//!   - object      → "{" sorted `key:shape` joined by "," "}"   (key-order invariant)
//!   - array       → "[" sorted+deduped union of element shapes joined by "|" "]"
//!                   (length- and order-invariant; heterogeneity preserved)
//!
//! Result: data churn (prices, timestamps, list length) → SAME shape → stays
//! verified; a dropped/renamed field, a type change, a route that stops resolving
//! → DIFFERENT shape → drift caught → the route forfeits. This is the whole
//! "it still resolves and its shape matches" verdict, made mechanical.
//!
//! `shapeObservation(raw)` yields the bytes the epoch treats as fresh_observation.
//! `attestationKey(raw)` yields the committed cas key (hexKey(contentHash(shape))).
//! ZERO-DEPENDENCY: std + the std-only cas module. std.json parses.

const std = @import("std");
const cas = @import("cas.zig");

/// The canonical shape string of `value`. Allocated in `a` (use an arena).
fn shapeOf(a: std.mem.Allocator, value: std.json.Value) ![]u8 {
    switch (value) {
        .null => return a.dupe(u8, "0"),
        .bool => return a.dupe(u8, "b"),
        .integer, .float, .number_string => return a.dupe(u8, "n"),
        .string => return a.dupe(u8, "s"),
        .array => |arr| {
            // distinct element shapes, sorted → length/order invariant.
            var shapes: std.ArrayList([]const u8) = .empty;
            for (arr.items) |item| {
                const s = try shapeOf(a, item);
                var seen = false;
                for (shapes.items) |existing| {
                    if (std.mem.eql(u8, existing, s)) {
                        seen = true;
                        break;
                    }
                }
                if (!seen) try shapes.append(a, s);
            }
            std.mem.sort([]const u8, shapes.items, {}, lessThanStr);
            var out: std.ArrayList(u8) = .empty;
            try out.append(a, '[');
            for (shapes.items, 0..) |s, i| {
                if (i > 0) try out.append(a, '|');
                try out.appendSlice(a, s);
            }
            try out.append(a, ']');
            return out.toOwnedSlice(a);
        },
        .object => |obj| {
            // sorted `key:shape` entries → key-order invariant.
            var entries: std.ArrayList([]const u8) = .empty;
            var it = obj.iterator();
            while (it.next()) |e| {
                const vs = try shapeOf(a, e.value_ptr.*);
                const entry = try std.fmt.allocPrint(a, "{s}:{s}", .{ e.key_ptr.*, vs });
                try entries.append(a, entry);
            }
            std.mem.sort([]const u8, entries.items, {}, lessThanStr);
            var out: std.ArrayList(u8) = .empty;
            try out.append(a, '{');
            for (entries.items, 0..) |entry, i| {
                if (i > 0) try out.append(a, ',');
                try out.appendSlice(a, entry);
            }
            try out.append(a, '}');
            return out.toOwnedSlice(a);
        },
    }
}

fn lessThanStr(_: void, a: []const u8, b: []const u8) bool {
    return std.mem.lessThan(u8, a, b);
}

/// The canonical SHAPE observation of a route's raw JSON output — the bytes the
/// epoch hashes as fresh_observation. Value-invariant, schema-sensitive. Caller
/// frees.
pub fn shapeObservation(allocator: std.mem.Allocator, raw_json: []const u8) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const av = arena.allocator();
    const parsed = std.json.parseFromSlice(std.json.Value, av, raw_json, .{}) catch return error.BadJson;
    const shape = try shapeOf(av, parsed.value);
    return allocator.dupe(u8, shape);
}

/// The committed attestation key for a route output = hexKey(contentHash(shape)).
/// Emit this in an `attest` row when a route is verified; the epoch checks a
/// fresh re-run reproduces it.
pub fn attestationKey(allocator: std.mem.Allocator, raw_json: []const u8, out: *[cas.HEX_LEN]u8) !void {
    const shape = try shapeObservation(allocator, raw_json);
    defer allocator.free(shape);
    cas.hexKey(cas.contentHash(shape), out);
}

// ── witnesses (zig test) — no fabricated green ───────────────────────────────

fn expectSameShape(a: std.mem.Allocator, x: []const u8, y: []const u8) !void {
    const sx = try shapeObservation(a, x);
    defer a.free(sx);
    const sy = try shapeObservation(a, y);
    defer a.free(sy);
    try std.testing.expectEqualStrings(sx, sy);
}

fn expectDiffShape(a: std.mem.Allocator, x: []const u8, y: []const u8) !void {
    const sx = try shapeObservation(a, x);
    defer a.free(sx);
    const sy = try shapeObservation(a, y);
    defer a.free(sy);
    try std.testing.expect(!std.mem.eql(u8, sx, sy));
}

test "VALUE-INVARIANT: same schema, different data → same shape (stays verified)" {
    const a = std.testing.allocator;
    try expectSameShape(a,
        \\{"price": 1, "sym": "SOL", "ok": true}
    ,
        \\{"price": 999999, "sym": "zzzzz", "ok": false}
    );
}

test "KEY-ORDER-INVARIANT: reordered keys → same shape" {
    const a = std.testing.allocator;
    try expectSameShape(a,
        \\{"a": 1, "b": "x"}
    ,
        \\{"b": "y", "a": 42}
    );
}

test "ARRAY length/order invariant; heterogeneity preserved" {
    const a = std.testing.allocator;
    try expectSameShape(a, "[1,2,3]", "[9,8]"); // both → [n]
    try expectSameShape(a, "[1,\"a\"]", "[\"b\",2,3]"); // both → [n|s]
    try expectDiffShape(a, "[1,2]", "[\"a\"]"); // [n] vs [s]
}

test "SCHEMA-SENSITIVE: dropped field / type change / stops resolving → drift" {
    const a = std.testing.allocator;
    // a field disappears (route half-broke)
    try expectDiffShape(a,
        \\{"price": 1, "sym": "SOL"}
    ,
        \\{"price": 1}
    );
    // a type changes (number → string)
    try expectDiffShape(a,
        \\{"price": 1}
    ,
        \\{"price": "1"}
    );
    // resolves to nothing / an error object
    try expectDiffShape(a,
        \\{"price": 1}
    ,
        \\{"error": "upstream 500"}
    );
}

test "END-TO-END: cas.reproduces stays true through data churn, false on drift" {
    const a = std.testing.allocator;
    // commit the attestation from an initial observation
    var key: [cas.HEX_LEN]u8 = undefined;
    try attestationKey(a,
        \\{"price": 100, "ts": "2026-07-15T00:00:00Z"}
    , &key);

    // a later re-run with totally different DATA but the same schema → verified
    const fresh_ok = try shapeObservation(a,
        \\{"price": 250, "ts": "2026-07-15T09:59:59Z"}
    );
    defer a.free(fresh_ok);
    try std.testing.expect(cas.reproduces(&key, fresh_ok));

    // a re-run where the route drifted (lost a field) → NOT verified → forfeits
    const fresh_drift = try shapeObservation(a,
        \\{"price": 250}
    );
    defer a.free(fresh_drift);
    try std.testing.expect(!cas.reproduces(&key, fresh_drift));
}
