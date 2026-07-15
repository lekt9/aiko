//! usage_ledger.zig — the thin adapter: ledger rows ⇄ usage events.
//!
//! Closes the last LOCAL gap in the commons loop. A metered call is recorded as
//! a `"usage"` ledger row (a non-terminal event, doctrine-legal like `evidence`
//! / `called` — the terminal alphabet stays exactly satisfied/died/purged):
//!
//!   {"event":"usage","source_id":"<route contract id>",
//!    "env_pubkey":"<payer identity>","amount":<fee atoms>,"ts":"<iso8601>"}
//!
//!   - `source_id` — the route (contract) that was used.
//!   - `env_pubkey` — the payer's identity (the canonical signer field).
//!   - `amount`    — the fee paid, in USDC atoms.
//!
//! `emitRow` only BUILDS the line — it never opens the ledger file (parity
//! claim 8: spawn = appendRow, and only ledger.zig opens contracts.jsonl). The
//! caller appends it through the canonical path. `parse` reads a window of the
//! ledger back into `usage.Event`s ready for `epoch.runEpoch`.
//!
//! Identity resolution: payer/owner strings collapse to a stable u64 via
//! `identityHash` (sha256[0..8]). BOTH the route owner (RouteSpec.owner_identity)
//! and the event payer must be hashed by THIS function, so self-exclusion fires
//! exactly when the payer string equals the route owner's string.
//!
//! ZERO-DEPENDENCY: std + the std-only usage.zig. std.json does the parsing.

const std = @import("std");
const usage = @import("usage.zig");

/// The canonical usage event (clean shape: source_id / env_pubkey / amount).
pub const USAGE_EVENT = "usage";
/// The REAL settlement event already emitted live by contract.appendFlexSettleRow
/// on `flex:settle:<auth_id>:<amount>` — an x402 hold converted to on-chain
/// settlement at actual consumption. It carries the same three facts under
/// different field names (id / agent / settle_amount), so it IS a usage record
/// and the parser reads it directly — no redundant second emit (algorithm:
/// don't duplicate an event that already lands in the ledger).
pub const SETTLE_EVENT = "flex_settle";

const Fields = struct { route: []const u8, payer: []const u8, fee: i64 };

/// Map a recognized ledger row to (route, payer, fee), else null.
fn extract(obj: std.json.ObjectMap) ?Fields {
    const ev = strField(obj, "event") orelse return null;
    if (std.mem.eql(u8, ev, USAGE_EVENT)) {
        return .{
            .route = strField(obj, "source_id") orelse return null,
            .payer = strField(obj, "env_pubkey") orelse return null,
            .fee = intField(obj, "amount") orelse return null,
        };
    }
    if (std.mem.eql(u8, ev, SETTLE_EVENT)) {
        return .{
            .route = strField(obj, "id") orelse return null,
            // Prefer the cryptographic identity (env_pubkey) so self-exclusion
            // shares a namespace with the route owner (declared.env_pubkey). Fall
            // back to `agent` for rows that predate the emit carrying env_pubkey.
            .payer = strField(obj, "env_pubkey") orelse strField(obj, "agent") orelse return null,
            .fee = intField(obj, "settle_amount") orelse return null,
        };
    }
    return null;
}

/// Stable 64-bit identity from a wallet/agent string (sha256 first 8 bytes, LE).
/// The one canonical hash for BOTH payers and route owners — self-exclusion in
/// usage.zig compares these u64s, so they must be produced here on both sides.
pub fn identityHash(s: []const u8) u64 {
    var h: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(s, &h, .{});
    return std.mem.readInt(u64, h[0..8], .little);
}

/// Build ONE usage ledger line (JSONL, no trailing newline). Pure string
/// builder — does NOT touch the ledger file. Caller owns the result.
pub fn emitRow(
    allocator: std.mem.Allocator,
    route_id: []const u8,
    payer: []const u8,
    fee: u64,
    ts: []const u8,
) ![]u8 {
    return std.fmt.allocPrint(
        allocator,
        "{{\"event\":\"{s}\",\"source_id\":\"{s}\",\"env_pubkey\":\"{s}\",\"amount\":{d},\"ts\":\"{s}\"}}",
        .{ USAGE_EVENT, route_id, payer, fee, ts },
    );
}

fn strField(obj: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const v = obj.get(key) orelse return null;
    return switch (v) {
        .string => |s| s,
        else => null,
    };
}

fn intField(obj: std.json.ObjectMap, key: []const u8) ?i64 {
    const v = obj.get(key) orelse return null;
    return switch (v) {
        .integer => |n| n,
        else => null,
    };
}

fn routeIndex(route_ids: []const []const u8, id: []const u8) ?usize {
    for (route_ids, 0..) |rid, i| {
        if (std.mem.eql(u8, rid, id)) return i;
    }
    return null;
}

/// Parse a window of JSONL ledger text into usage events. `route_ids[i]` is the
/// contract id of route index i (aligned with the specs/maintainers passed to
/// epoch.runEpoch). A `"usage"` row whose `source_id` is not in `route_ids` is
/// skipped (usage of an unknown/unranked route); non-usage rows are ignored;
/// malformed lines are skipped, never fatal. Caller frees the returned slice.
pub fn parse(
    allocator: std.mem.Allocator,
    jsonl: []const u8,
    route_ids: []const []const u8,
) ![]usage.Event {
    var out: std.ArrayList(usage.Event) = .empty;
    errdefer out.deinit(allocator);

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

        const f = extract(obj) orelse continue; // usage OR flex_settle row
        if (f.fee < 0) continue; // a negative fee is malformed, not a refund
        const idx = routeIndex(route_ids, f.route) orelse continue;

        try out.append(allocator, .{
            .route = idx,
            .payer = identityHash(f.payer),
            .fee = @intCast(f.fee),
        });
    }
    return out.toOwnedSlice(allocator);
}

/// The event every contract's birth row carries.
pub const DECLARED_EVENT = "declared";

/// Resolve each route's OWNER identity from the ledger's `declared` rows: a
/// contract's birth row records `id` (the route) and `env_pubkey` (the declarer
/// — its owner). Fills `out_owner_ids[i]` with identityHash(env_pubkey) for the
/// route `route_ids[i]`, or 0 if no `declared` row is found (unknown owner →
/// never self-excludes — honest: we don't guess ownership). The u64 it writes is
/// the SAME hash a usage event's payer gets, so self-exclusion fires exactly when
/// the payer's env_pubkey equals the route owner's. `out_owner_ids.len` must ==
/// `route_ids.len`.
pub fn resolveOwners(
    allocator: std.mem.Allocator,
    jsonl: []const u8,
    route_ids: []const []const u8,
    out_owner_ids: []u64,
) !void {
    std.debug.assert(out_owner_ids.len == route_ids.len);
    @memset(out_owner_ids, 0);

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
        if (!std.mem.eql(u8, ev, DECLARED_EVENT)) continue;
        const id = strField(obj, "id") orelse continue;
        const owner = strField(obj, "env_pubkey") orelse continue;
        if (owner.len == 0) continue; // no cryptographic owner recorded
        const idx = routeIndex(route_ids, id) orelse continue;
        out_owner_ids[idx] = identityHash(owner);
    }
}

// ── witnesses (zig test) — no fabricated green ───────────────────────────────

test "emit → parse round-trips route index, payer identity, and fee" {
    const a = std.testing.allocator;
    const route_ids = [_][]const u8{ "route:alpha", "route:beta" };

    const r0 = try emitRow(a, "route:alpha", "wallet:X", 500, "2026-07-15T00:00:00Z");
    defer a.free(r0);
    const r1 = try emitRow(a, "route:beta", "wallet:Y", 700, "2026-07-15T00:00:01Z");
    defer a.free(r1);

    const jsonl = try std.mem.join(a, "\n", &.{ r0, r1 });
    defer a.free(jsonl);

    const events = try parse(a, jsonl, &route_ids);
    defer a.free(events);

    try std.testing.expectEqual(@as(usize, 2), events.len);
    try std.testing.expectEqual(@as(usize, 0), events[0].route);
    try std.testing.expectEqual(identityHash("wallet:X"), events[0].payer);
    try std.testing.expectEqual(@as(u64, 500), events[0].fee);
    try std.testing.expectEqual(@as(usize, 1), events[1].route);
    try std.testing.expectEqual(@as(u64, 700), events[1].fee);
}

test "resolveOwners maps route → declared owner; unknown route → 0" {
    const a = std.testing.allocator;
    const route_ids = [_][]const u8{ "ed9421cb", "route:orphan" };
    const jsonl =
        \\{"event":"declared","id":"ed9421cb","env_pubkey":"6ce0f8a054611d64"}
        \\{"event":"declared","id":"other","env_pubkey":"deadbeef"}
        \\{"event":"evidence","id":"ed9421cb","env_pubkey":"IGNORED"}
    ;
    var owners: [2]u64 = undefined;
    try resolveOwners(a, jsonl, &route_ids, &owners);
    try std.testing.expectEqual(identityHash("6ce0f8a054611d64"), owners[0]);
    try std.testing.expectEqual(@as(u64, 0), owners[1]); // no declared row → unknown
}

test "OWNER SELF-PAY EXCLUDED end-to-end: owner ← ledger changes the distribution" {
    const a = std.testing.allocator;
    const cas = @import("cas.zig");
    const reward = @import("reward.zig");
    const epoch = @import("epoch.zig");

    // ONE owner ("OWNERKEY") declares TWO routes. It self-pays route:wash (1000)
    // and an OUTSIDER genuinely pays route:honest (1000). Owner identity is taken
    // from the ledger's declared rows — not stubbed. Because self-pay is excluded,
    // route:wash earns 0 and route:honest takes the whole pool. If owner
    // resolution had failed, wash would have split the pool 50/50 — so the
    // payout split is a live assertion that the ledger-sourced owner took effect.
    const route_ids = [_][]const u8{ "route:honest", "route:wash" };
    const jsonl =
        \\{"event":"declared","id":"route:honest","env_pubkey":"OWNERKEY"}
        \\{"event":"declared","id":"route:wash","env_pubkey":"OWNERKEY"}
        \\{"event":"usage","source_id":"route:honest","env_pubkey":"OUTSIDER","amount":1000}
        \\{"event":"usage","source_id":"route:wash","env_pubkey":"OWNERKEY","amount":1000}
    ;

    var owners: [2]u64 = undefined;
    try resolveOwners(a, jsonl, &route_ids, &owners);
    try std.testing.expectEqual(identityHash("OWNERKEY"), owners[0]);
    try std.testing.expectEqual(identityHash("OWNERKEY"), owners[1]);

    const events = try parse(a, jsonl, &route_ids);
    defer a.free(events);

    var kh: [cas.HEX_LEN]u8 = undefined;
    cas.hexKey(cas.contentHash("honest shape"), &kh);
    var kw: [cas.HEX_LEN]u8 = undefined;
    cas.hexKey(cas.contentHash("wash shape"), &kw);
    const specs = [_]epoch.RouteSpec{
        .{ .maintainer = 0, .owner_identity = owners[0], .committed_attestation = &kh, .fresh_observation = "honest shape" },
        .{ .maintainer = 1, .owner_identity = owners[1], .committed_attestation = &kw, .fresh_observation = "wash shape" },
    };
    const maintainers = [_]reward.Maintainer{ .{ .stake = 1 }, .{ .stake = 1 } };
    const res = try epoch.runEpoch(a, &maintainers, &specs, events, 0);
    defer res.deinit(a);

    try std.testing.expectEqual(@as(u64, 2000), res.pool);
    try std.testing.expectEqual(@as(u64, 2000), res.payouts[0]); // honest takes all
    try std.testing.expectEqual(@as(u64, 0), res.payouts[1]); // wash self-pay excluded
}

test "reads the REAL flex_settle settlement row (the live emit site)" {
    const a = std.testing.allocator;
    const route_ids = [_][]const u8{"contract:abcd1234"};
    // Byte-for-byte the shape contract.appendFlexSettleRow emits:
    // {"event": "flex_settle", "id": "...", "authorization_id": "...",
    //  "settle_amount": N, "ts": "...", "agent": "..."}
    const jsonl =
        \\{"event": "flex_settle", "id": "contract:abcd1234", "authorization_id": "auth:9", "settle_amount": 1250, "ts": "2026-07-15T02:04:49Z", "agent": "payer@example.com"}
    ;
    const events = try parse(a, jsonl, &route_ids);
    defer a.free(events);
    try std.testing.expectEqual(@as(usize, 1), events.len);
    try std.testing.expectEqual(@as(usize, 0), events[0].route);
    try std.testing.expectEqual(identityHash("payer@example.com"), events[0].payer);
    try std.testing.expectEqual(@as(u64, 1250), events[0].fee);
}

test "non-usage rows ignored; unknown routes skipped; junk skipped" {
    const a = std.testing.allocator;
    const route_ids = [_][]const u8{"route:known"};
    const jsonl =
        \\{"event":"evidence","source_id":"route:known","env_pubkey":"w","bytes":10}
        \\{"event":"usage","source_id":"route:UNKNOWN","env_pubkey":"w","amount":99}
        \\{"event":"satisfied","id":"abc"}
        \\not even json
        \\{"event":"usage","source_id":"route:known","env_pubkey":"w","amount":42}
    ;
    const events = try parse(a, jsonl, &route_ids);
    defer a.free(events);
    // only the last line qualifies: usage + known route
    try std.testing.expectEqual(@as(usize, 1), events.len);
    try std.testing.expectEqual(@as(usize, 0), events[0].route);
    try std.testing.expectEqual(@as(u64, 42), events[0].fee);
}

test "FULL LOOP: ledger lines → parse → epoch payouts (incl. wash donation)" {
    const a = std.testing.allocator;
    const cas = @import("cas.zig");
    const reward = @import("reward.zig");
    const epoch = @import("epoch.zig");

    // Two routes. route 0 (owner "wallet:owner0") is honestly used by two
    // distinct outside payers. route 1 (owner "wallet:owner1") is WASH-traded:
    // its only payer is its own owner.
    const route_ids = [_][]const u8{ "route:honest", "route:wash" };

    const lines = [_][]const u8{
        try emitRow(a, "route:honest", "wallet:alice", 500, "t"),
        try emitRow(a, "route:honest", "wallet:bob", 500, "t"),
        try emitRow(a, "route:wash", "wallet:owner1", 1000, "t"), // self-pay
    };
    defer for (lines) |l| a.free(l);
    const jsonl = try std.mem.join(a, "\n", &lines);
    defer a.free(jsonl);

    const events = try parse(a, jsonl, &route_ids);
    defer a.free(events);

    // Build the epoch specs. owner_identity MUST be identityHash of the SAME
    // owner string used in the wash row, so self-exclusion fires.
    var k0: [cas.HEX_LEN]u8 = undefined;
    cas.hexKey(cas.contentHash("honest shape"), &k0);
    var k1: [cas.HEX_LEN]u8 = undefined;
    cas.hexKey(cas.contentHash("wash shape"), &k1);
    const specs = [_]epoch.RouteSpec{
        .{ .maintainer = 0, .owner_identity = identityHash("wallet:owner0"), .committed_attestation = &k0, .fresh_observation = "honest shape" },
        .{ .maintainer = 1, .owner_identity = identityHash("wallet:owner1"), .committed_attestation = &k1, .fresh_observation = "wash shape" },
    };
    const maintainers = [_]reward.Maintainer{ .{ .stake = 1 }, .{ .stake = 1 } };

    const res = try epoch.runEpoch(a, &maintainers, &specs, events, 0);
    defer res.deinit(a);

    // Pool = 2000 (all real fees, incl. the wash 1000). The honest maintainer
    // captures the whole pool; the wash-trader paid 1000 and earns 0 — donation.
    try std.testing.expectEqual(@as(u64, 2000), res.pool);
    try std.testing.expectEqual(@as(u64, 2000), res.payouts[0]);
    try std.testing.expectEqual(@as(u64, 0), res.payouts[1]);
}
