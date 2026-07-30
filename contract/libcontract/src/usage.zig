//! usage.zig — Sybil-dampened usage accounting: the crux the reward model rests
//! on (ECONOMICS-cooperative-commons.md, honest wall). Turns raw usage events
//! into the two numbers reward.zig needs per route: the REAL fee pool (`gross`)
//! and the DAMPENED weight the route earns from (`weight`), plus the count of
//! distinct genuine payers.
//!
//! The attack it answers: payout ∝ usage, so a maintainer wash-calls their own
//! route to fake demand and capture honest payers' fees. Two rules close the
//! profit motive (neither formally solves Sybil — see the wall):
//!
//!   1. SELF-EXCLUSION. A payment from the route's own maintainer adds ZERO
//!      weight (you cannot be your own customer) — yet the money STILL enters
//!      `gross` (the pool). So a self-dealer just DONATES to the commons.
//!   2. PER-PAYER CAP. One identity's contribution to a route's weight is capped
//!      at `cap`. Weight then tracks BREADTH of distinct demand, not fee volume a
//!      single whale/Sybil can manufacture. To fake weight W you need ≈ W/cap
//!      DISTINCT funded wallets — each paying real fees that land in the pool.
//!
//! Net effect (proven below): a route funded only by its maintainer earns 0; a
//! route funded by one capped whale earns less than one funded by many small
//! distinct payers of the same total; and the wash-trader's own fees redistribute
//! to the honest. Wash-trading becomes break-even-minus-gas at best, a donation
//! at worst — the profit is gone. The residual Sybil surface (many cheap
//! identities) is bounded by the per-payer cap + the real x402 fee each must pay.
//!
//! ZERO-DEPENDENCY: imports only `std`. u64 atoms; grouping via AutoHashMap.

const std = @import("std");

/// One metered call: `payer` (a wallet-identity hash) paid `fee` USDC atoms to
/// call the route at index `route`.
pub const Event = struct {
    route: usize,
    payer: u64,
    fee: u64,
};

/// Per-route accounting result (index-aligned with the routes).
pub const RouteUsage = struct {
    gross: u64 = 0, // ALL real fees to this route (incl. self) → the pool
    weight: u64 = 0, // self-excluded, per-payer-capped → what it earns from
    distinct_payers: u64 = 0, // count of distinct non-self payers
};

const Key = struct { route: usize, payer: u64 };

/// Compute per-route usage from raw events.
///   - `route_maintainer[r]` = the maintainer IDENTITY (wallet hash) that owns
///     route r (used for self-exclusion). NOTE: this is the identity, not the
///     maintainer index — self-exclusion compares payer identities.
///   - `cap` = the per-(route,payer) weight cap. 0 means "no cap" (uncapped).
///   - `out` length must equal route_maintainer.len; it is filled.
/// Pure w.r.t. inputs; deterministic. Allocates a scratch map, frees it.
pub fn compute(
    allocator: std.mem.Allocator,
    events: []const Event,
    route_maintainer: []const u64,
    cap: u64,
    out: []RouteUsage,
) !void {
    std.debug.assert(out.len == route_maintainer.len);
    for (out) |*o| o.* = .{};

    // Group summed fee per (route, payer) so the cap + distinct-count apply to a
    // payer's TOTAL contribution to a route, not per call.
    var pair_fee = std.AutoHashMap(Key, u64).init(allocator);
    defer pair_fee.deinit();

    for (events) |e| {
        std.debug.assert(e.route < out.len);
        out[e.route].gross += e.fee; // every real atom enters the pool
        const gop = try pair_fee.getOrPut(.{ .route = e.route, .payer = e.payer });
        if (!gop.found_existing) gop.value_ptr.* = 0;
        gop.value_ptr.* += e.fee;
    }

    var it = pair_fee.iterator();
    while (it.next()) |entry| {
        const k = entry.key_ptr.*;
        const paid = entry.value_ptr.*;
        if (k.payer == route_maintainer[k.route]) continue; // SELF-EXCLUSION
        if (paid == 0) continue;
        const credited = if (cap == 0) paid else @min(paid, cap); // PER-PAYER CAP
        out[k.route].weight += credited;
        out[k.route].distinct_payers += 1;
    }
}

// ── witnesses (zig test) — no fabricated green ───────────────────────────────

test "SELF-EXCLUSION: a route funded only by its own maintainer earns 0 weight" {
    const a = std.testing.allocator;
    // route 0 owned by identity 0xAA; the only payer IS 0xAA (self).
    const events = [_]Event{
        .{ .route = 0, .payer = 0xAA, .fee = 1000 },
        .{ .route = 0, .payer = 0xAA, .fee = 500 },
    };
    const owners = [_]u64{0xAA};
    var out: [1]RouteUsage = undefined;
    try compute(a, &events, &owners, 0, &out);
    try std.testing.expectEqual(@as(u64, 1500), out[0].gross); // money still pooled
    try std.testing.expectEqual(@as(u64, 0), out[0].weight); // but earns nothing
    try std.testing.expectEqual(@as(u64, 0), out[0].distinct_payers);
}

test "PER-PAYER CAP: breadth beats depth — many small payers > one capped whale" {
    const a = std.testing.allocator;
    const cap: u64 = 100;
    // route 0 (owner 0xA0): one whale pays 1000 → capped to 100.
    // route 1 (owner 0xB0): ten distinct payers pay 100 each → 10*min(100,100)=1000.
    var events: [11]Event = undefined;
    events[0] = .{ .route = 0, .payer = 0x999, .fee = 1000 };
    for (0..10) |i| events[1 + i] = .{ .route = 1, .payer = 0x1000 + @as(u64, i), .fee = 100 };
    const owners = [_]u64{ 0xA0, 0xB0 };
    var out: [2]RouteUsage = undefined;
    try compute(a, &events, &owners, cap, &out);
    // same gross-ish, wildly different earned weight:
    try std.testing.expectEqual(@as(u64, 1000), out[0].gross);
    try std.testing.expectEqual(@as(u64, 100), out[0].weight); // whale capped
    try std.testing.expectEqual(@as(u64, 1), out[0].distinct_payers);
    try std.testing.expectEqual(@as(u64, 1000), out[1].weight); // breadth uncapped
    try std.testing.expectEqual(@as(u64, 10), out[1].distinct_payers);
    try std.testing.expect(out[1].weight > out[0].weight);
}

test "distinct payers counted once regardless of call count" {
    const a = std.testing.allocator;
    // one payer calls route 0 five times; counts as ONE distinct payer.
    const events = [_]Event{
        .{ .route = 0, .payer = 0x1, .fee = 10 },
        .{ .route = 0, .payer = 0x1, .fee = 10 },
        .{ .route = 0, .payer = 0x1, .fee = 10 },
        .{ .route = 0, .payer = 0x2, .fee = 10 },
        .{ .route = 0, .payer = 0x2, .fee = 10 },
    };
    const owners = [_]u64{0xFF}; // owner is neither payer
    var out: [1]RouteUsage = undefined;
    try compute(a, &events, &owners, 0, &out);
    try std.testing.expectEqual(@as(u64, 50), out[0].gross);
    try std.testing.expectEqual(@as(u64, 50), out[0].weight); // uncapped
    try std.testing.expectEqual(@as(u64, 2), out[0].distinct_payers);
}

test "WASH-TRADE IS A DONATION: end-to-end through reward.distribute" {
    const a = std.testing.allocator;
    const reward = @import("reward.zig");
    const cap: u64 = 0; // even with NO cap, self-exclusion alone defeats the wash

    // Two maintainers. m0 (identity 0xA0) runs an HONEST route funded by two
    // distinct outside payers. m1 (identity 0xB0) WASH-TRADES: it pays its own
    // route 1 the same 1000 total, hoping to capture the pool.
    const events = [_]Event{
        .{ .route = 0, .payer = 0x111, .fee = 500 },
        .{ .route = 0, .payer = 0x222, .fee = 500 },
        .{ .route = 1, .payer = 0xB0, .fee = 1000 }, // m1 pays ITSELF
    };
    const owners = [_]u64{ 0xA0, 0xB0 };
    var u: [2]RouteUsage = undefined;
    try compute(a, &events, &owners, cap, &u);

    // wash route earned 0 weight; its 1000 is still in the pool.
    try std.testing.expectEqual(@as(u64, 0), u[1].weight);
    try std.testing.expectEqual(@as(u64, 1000), u[1].gross);

    const maintainers = [_]reward.Maintainer{ .{ .stake = 1 }, .{ .stake = 1 } };
    const routes = [_]reward.Route{
        .{ .maintainer = 0, .gross_fee = u[0].gross, .weight = u[0].weight, .verified = true },
        .{ .maintainer = 1, .gross_fee = u[1].gross, .weight = u[1].weight, .verified = true },
    };
    var payouts: [2]u64 = undefined;
    const d = reward.distribute(&maintainers, &routes, &payouts);

    // Pool = 2000 (all real money). The honest maintainer captures the WHOLE
    // pool — including the wash-trader's own 1000. The wash-trader paid 1000 and
    // earns 0: a pure donation to the honest. Profit motive: gone.
    try std.testing.expectEqual(@as(u64, 2000), d.pool);
    try std.testing.expectEqual(@as(u64, 2000), payouts[0]);
    try std.testing.expectEqual(@as(u64, 0), payouts[1]);
}
