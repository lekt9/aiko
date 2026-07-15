//! reward.zig — the commons pays out, it does not punish (Luke 10:7 — "the
//! labourer is worthy of his hire"). The positive-sum replacement for slashing.
//!
//! All usage fees (converted to SOL lamports) form a pool. The pool is paid to
//! the maintainers whose routes were actually USED and still VERIFY — weighted
//! by the usage they generated, gated by stake (Sybil cost) + verification.
//!
//! The transmutation of the slash: a route that fails re-verification does NOT
//! get its maintainer's principal seized. It simply earns nothing, and the fees
//! its usage generated REDISTRIBUTE to the honest, verified maintainers. Nobody
//! is punished; the users' payments still create value — they reward whoever is
//! actually correct. Forfeiture becomes provision.
//!
//! Design invariants, all mechanically tested below:
//!   1. CONSERVATION — every lamport in the pool is either paid out or lands in
//!      the treasury remainder. Nothing is burned (contrast slashing, which
//!      destroys value). sum(payouts) + treasury == pool.
//!   2. USAGE-WEIGHTED — more verified usage → strictly more payout.
//!   3. VERIFICATION-GATED — an unverified route earns 0; its fees redistribute
//!      to the verified maintainers (a verified maintainer can earn MORE than
//!      its own fees — the "forfeit → value to the honest" property).
//!   4. STAKE-GATED — an unstaked maintainer earns 0 (the Sybil cost of entry).
//!
//! ZERO-DEPENDENCY: imports only `std`. Lamports are u64 (SOL's atom); the
//! pool*weight product uses u128 to never overflow. This proves the economics
//! OFF-CHAIN first — the on-chain payout (SOL transfers to stFDRY holders, an
//! operator-gated card like voltr.zig) is wired only after the math is proven.

const std = @import("std");

/// A staker/maintainer of routes. `stake` is their bonded FDRY (in atoms) — the
/// eligibility gate and Sybil cost, NEVER seized. `stake == 0` → cannot earn.
pub const Maintainer = struct {
    stake: u64,
};

/// A route's usage this epoch. `usage_fee` is the SOL (lamports) users paid to
/// call it. `verified` is the current re-verification verdict (cas.zig). A route
/// whose maintainer is unstaked OR whose `verified` is false is INELIGIBLE — it
/// earns nothing and its fee redistributes to the eligible.
pub const Route = struct {
    maintainer: usize, // index into the maintainers slice
    usage_fee: u64, // lamports of SOL paid for this route's usage this epoch
    verified: bool,
};

pub const Distribution = struct {
    /// pool == sum of ALL usage fees (every payment enters, verified or not).
    pool: u64,
    /// lamports that could not be attributed to an eligible maintainer:
    /// integer-division dust, plus the WHOLE pool when no route is eligible.
    treasury: u64,
};

fn eligible(m: []const Maintainer, r: Route) bool {
    return r.verified and m[r.maintainer].stake > 0;
}

/// Distribute the usage-fee pool to eligible maintainers, usage-weighted.
/// `out_payouts` must have length == maintainers.len; it is zeroed then filled.
/// Returns the pool total and the treasury remainder. Pure + deterministic.
pub fn distribute(
    maintainers: []const Maintainer,
    routes: []const Route,
    out_payouts: []u64,
) Distribution {
    std.debug.assert(out_payouts.len == maintainers.len);
    @memset(out_payouts, 0);

    var pool: u64 = 0;
    var weight: u64 = 0; // sum of ELIGIBLE usage fees
    for (routes) |r| {
        pool += r.usage_fee;
        if (eligible(maintainers, r)) weight += r.usage_fee;
    }

    if (weight == 0) {
        // Nobody earned: the whole pool waits in the treasury (the commons),
        // to roll into the next epoch or fund the open tier. Not burned.
        return .{ .pool = pool, .treasury = pool };
    }

    // payout[m] = pool * (eligible_usage[m] / weight), integer floor. The floor
    // dust accrues to the treasury so conservation is exact.
    var paid: u64 = 0;
    for (routes) |r| {
        if (!eligible(maintainers, r)) continue;
        const share: u64 = @intCast(@as(u128, pool) * @as(u128, r.usage_fee) / @as(u128, weight));
        out_payouts[r.maintainer] += share;
        paid += share;
    }

    return .{ .pool = pool, .treasury = pool - paid };
}

// ── witnesses (zig test) — no fabricated green ───────────────────────────────

fn sum(xs: []const u64) u64 {
    var s: u64 = 0;
    for (xs) |x| s += x;
    return s;
}

test "CONSERVATION: payouts + treasury == pool, always (nothing burned)" {
    const m = [_]Maintainer{ .{ .stake = 100 }, .{ .stake = 100 }, .{ .stake = 100 } };
    const routes = [_]Route{
        .{ .maintainer = 0, .usage_fee = 700, .verified = true },
        .{ .maintainer = 1, .usage_fee = 300, .verified = true },
        .{ .maintainer = 2, .usage_fee = 137, .verified = false }, // forfeits
    };
    var payouts: [3]u64 = undefined;
    const d = distribute(&m, &routes, &payouts);
    try std.testing.expectEqual(@as(u64, 1137), d.pool);
    try std.testing.expectEqual(d.pool, sum(&payouts) + d.treasury);
}

test "USAGE-WEIGHTED: 70/30 usage split pays ~70/30 of the whole pool" {
    const m = [_]Maintainer{ .{ .stake = 1 }, .{ .stake = 1 } };
    const routes = [_]Route{
        .{ .maintainer = 0, .usage_fee = 7000, .verified = true },
        .{ .maintainer = 1, .usage_fee = 3000, .verified = true },
    };
    var payouts: [2]u64 = undefined;
    const d = distribute(&m, &routes, &payouts);
    // no ineligible fees → pool == weight → payouts equal the raw usage fees.
    try std.testing.expectEqual(@as(u64, 7000), payouts[0]);
    try std.testing.expectEqual(@as(u64, 3000), payouts[1]);
    try std.testing.expectEqual(@as(u64, 0), d.treasury);
}

test "FORFEIT -> VALUE: an unverified route's fee redistributes to the honest" {
    // m0 and m1 each generated 500 in verified usage. m2 generated 1000 but is
    // UNVERIFIED — it forfeits. The honest two split m2's 1000 pro-rata, so each
    // earns MORE than its own 500. Punishment became provision.
    const m = [_]Maintainer{ .{ .stake = 10 }, .{ .stake = 10 }, .{ .stake = 10 } };
    const routes = [_]Route{
        .{ .maintainer = 0, .usage_fee = 500, .verified = true },
        .{ .maintainer = 1, .usage_fee = 500, .verified = true },
        .{ .maintainer = 2, .usage_fee = 1000, .verified = false },
    };
    var payouts: [3]u64 = undefined;
    const d = distribute(&m, &routes, &payouts);
    try std.testing.expectEqual(@as(u64, 2000), d.pool);
    try std.testing.expectEqual(@as(u64, 0), payouts[2]); // forfeiter earns nothing
    try std.testing.expect(payouts[0] > 500); // honest earns MORE than its own fees
    try std.testing.expect(payouts[1] > 500);
    // pool split 50/50 between the two eligible (equal eligible usage): 1000 each
    try std.testing.expectEqual(@as(u64, 1000), payouts[0]);
    try std.testing.expectEqual(@as(u64, 1000), payouts[1]);
}

test "STAKE-GATED: an unstaked maintainer earns 0 (Sybil cost of entry)" {
    const m = [_]Maintainer{ .{ .stake = 0 }, .{ .stake = 5 } }; // m0 unstaked
    const routes = [_]Route{
        .{ .maintainer = 0, .usage_fee = 900, .verified = true }, // ineligible: unstaked
        .{ .maintainer = 1, .usage_fee = 100, .verified = true },
    };
    var payouts: [2]u64 = undefined;
    const d = distribute(&m, &routes, &payouts);
    try std.testing.expectEqual(@as(u64, 0), payouts[0]);
    // the only eligible maintainer takes the whole pool (incl. the unstaked fee)
    try std.testing.expectEqual(@as(u64, 1000), payouts[1]);
    try std.testing.expectEqual(@as(u64, 0), d.treasury);
}

test "NO ELIGIBLE: the whole pool waits in the treasury, unburned" {
    const m = [_]Maintainer{.{ .stake = 0 }};
    const routes = [_]Route{.{ .maintainer = 0, .usage_fee = 4242, .verified = true }};
    var payouts: [1]u64 = undefined;
    const d = distribute(&m, &routes, &payouts);
    try std.testing.expectEqual(@as(u64, 0), payouts[0]);
    try std.testing.expectEqual(@as(u64, 4242), d.treasury);
    try std.testing.expectEqual(d.pool, d.treasury);
}
