//! epoch.zig — the commons economics, wired end-to-end for one epoch.
//!
//! This is the orchestration the proven parts were waiting for. Given an epoch's
//! metered usage events + the routes + their maintainers, it runs the whole
//! pipeline and emits the payout set:
//!
//!   re-verify (cas.reproduces)  →  which routes are still fresh/valid
//!        │
//!   usage.compute               →  Sybil-dampened weight + real gross pool
//!        │                          (self-exclusion + per-payer cap)
//!        ▼
//!   reward.distribute           →  USDC payouts to used + verified + staked
//!                                   maintainers; forfeits redistribute to the
//!                                   honest; nothing burned.
//!
//! Every gate is applied in one place: a route earns only if it (a) re-verifies
//! against its committed attestation, (b) drew genuine distinct-payer usage, and
//! (c) its maintainer is staked. A route that fails any gate forfeits — its real
//! fees stay in the pool and redistribute to the honest. Reward, never slash.
//!
//! ZERO-DEPENDENCY: imports only std + the (std-only) cas/usage/reward modules.
//! Pure w.r.t. inputs. The one thing it does NOT do yet is parse the on-chain /
//! JSONL ledger into `Event`s — that adapter is the thin next step once usage
//! events are actually emitted to the ledger; the economics it drives are proven
//! here first.

const std = @import("std");
const cas = @import("cas.zig");
const usage = @import("usage.zig");
const reward = @import("reward.zig");

/// One route in this epoch.
pub const RouteSpec = struct {
    /// index into the `maintainers` slice (many routes may share a maintainer).
    maintainer: usize,
    /// the maintainer's wallet-identity hash — used by usage.zig for
    /// self-exclusion (a payment from this identity to this route earns nothing).
    owner_identity: u64,
    /// the content-addressed attestation committed when the route was last
    /// verified (HEX_LEN hex chars). Empty/short → the route is unattested and
    /// will not verify.
    committed_attestation: []const u8,
    /// the bytes observed by re-running the route this epoch. If they reproduce
    /// `committed_attestation`, the route is verified.
    fresh_observation: []const u8,
};

pub const EpochResult = struct {
    /// per-maintainer payout (index-aligned with the maintainers slice). Owned.
    payouts: []u64,
    pool: u64,
    treasury: u64,

    pub fn deinit(self: EpochResult, allocator: std.mem.Allocator) void {
        allocator.free(self.payouts);
    }
};

/// Run one epoch. `cap` is usage.zig's per-payer weight cap (0 = uncapped).
/// Caller owns the returned `payouts` (see EpochResult.deinit).
pub fn runEpoch(
    allocator: std.mem.Allocator,
    maintainers: []const reward.Maintainer,
    specs: []const RouteSpec,
    events: []const usage.Event,
    cap: u64,
) !EpochResult {
    const n = specs.len;

    // Owner identities for usage self-exclusion (route index → owner wallet id).
    const owner_ids = try allocator.alloc(u64, n);
    defer allocator.free(owner_ids);
    for (specs, owner_ids) |s, *o| o.* = s.owner_identity;

    // Sybil-dampened usage: gross (real pool) + weight (what each route earns from).
    const ru = try allocator.alloc(usage.RouteUsage, n);
    defer allocator.free(ru);
    try usage.compute(allocator, events, owner_ids, cap, ru);

    // Apply the re-verification gate and assemble the reward routes.
    const routes = try allocator.alloc(reward.Route, n);
    defer allocator.free(routes);
    for (specs, ru, routes) |s, u, *r| {
        const verified = cas.reproduces(s.committed_attestation, s.fresh_observation);
        r.* = .{
            .maintainer = s.maintainer,
            .gross_fee = u.gross,
            .weight = u.weight,
            .verified = verified,
        };
    }

    const payouts = try allocator.alloc(u64, maintainers.len);
    errdefer allocator.free(payouts);
    const d = reward.distribute(maintainers, routes, payouts);
    return .{ .payouts = payouts, .pool = d.pool, .treasury = d.treasury };
}

// ── witnesses (zig test) — no fabricated green ───────────────────────────────

/// Helper: the committed attestation for an observation that WILL verify.
fn attest(obs: []const u8, out: *[cas.HEX_LEN]u8) void {
    cas.hexKey(cas.contentHash(obs), out);
}

test "CAPSTONE: one epoch exercises every gate at once" {
    const a = std.testing.allocator;

    // Five maintainers, five routes (one route each), one epoch:
    //   m0 — HONEST, verified, two distinct outside payers (500 each)  → EARNS
    //   m1 — HONEST, verified, one payer (1000)                        → EARNS
    //   m2 — DRIFTED: fresh observation ≠ committed → unverified       → forfeits
    //   m3 — WASH: owner pays its own route (400)                      → weight 0
    //   m4 — UNSTAKED: verified + used (300) but stake 0               → ineligible
    const maintainers = [_]reward.Maintainer{
        .{ .stake = 10 }, // m0
        .{ .stake = 10 }, // m1
        .{ .stake = 10 }, // m2
        .{ .stake = 10 }, // m3
        .{ .stake = 0 }, //  m4 — unstaked
    };

    // committed attestations
    var k0: [cas.HEX_LEN]u8 = undefined;
    attest("m0 shape", &k0);
    var k1: [cas.HEX_LEN]u8 = undefined;
    attest("m1 shape", &k1);
    var k2: [cas.HEX_LEN]u8 = undefined;
    attest("m2 shape v1", &k2); // committed to v1 ...
    var k3: [cas.HEX_LEN]u8 = undefined;
    attest("m3 shape", &k3);
    var k4: [cas.HEX_LEN]u8 = undefined;
    attest("m4 shape", &k4);

    const specs = [_]RouteSpec{
        .{ .maintainer = 0, .owner_identity = 0xA0, .committed_attestation = &k0, .fresh_observation = "m0 shape" },
        .{ .maintainer = 1, .owner_identity = 0xB0, .committed_attestation = &k1, .fresh_observation = "m1 shape" },
        .{ .maintainer = 2, .owner_identity = 0xC0, .committed_attestation = &k2, .fresh_observation = "m2 shape v2 DRIFTED" }, // ≠ v1
        .{ .maintainer = 3, .owner_identity = 0xD0, .committed_attestation = &k3, .fresh_observation = "m3 shape" },
        .{ .maintainer = 4, .owner_identity = 0xE0, .committed_attestation = &k4, .fresh_observation = "m4 shape" },
    };

    const events = [_]usage.Event{
        .{ .route = 0, .payer = 0x111, .fee = 500 }, // m0: two distinct payers
        .{ .route = 0, .payer = 0x222, .fee = 500 },
        .{ .route = 1, .payer = 0x333, .fee = 1000 }, // m1: one payer
        .{ .route = 2, .payer = 0x444, .fee = 600 }, // m2: real usage but DRIFTED
        .{ .route = 3, .payer = 0xD0, .fee = 400 }, // m3: owner pays ITSELF (wash)
        .{ .route = 4, .payer = 0x555, .fee = 300 }, // m4: used but unstaked
    };

    const res = try runEpoch(a, &maintainers, &specs, &events, 0);
    defer res.deinit(a);

    // Pool = every real fee: 1000 + 1000 + 600 + 400 + 300 = 3300.
    try std.testing.expectEqual(@as(u64, 3300), res.pool);

    // Only m0 and m1 are eligible (verified + used + staked), equal weight 1000
    // each → each takes half the WHOLE pool = 1650. They absorb the 900 forfeited
    // by drift (600) + wash (400 gross, 0 weight) + unstaked (300) — MINUS... let
    // us just assert the arithmetic: 3300 split 50/50 = 1650 each.
    try std.testing.expectEqual(@as(u64, 1650), res.payouts[0]);
    try std.testing.expectEqual(@as(u64, 1650), res.payouts[1]);
    // each earns MORE than its own 1000 — forfeits became provision.
    try std.testing.expect(res.payouts[0] > 1000);

    // every gate that should zero a maintainer did:
    try std.testing.expectEqual(@as(u64, 0), res.payouts[2]); // drifted (unverified)
    try std.testing.expectEqual(@as(u64, 0), res.payouts[3]); // wash (self-pay, weight 0)
    try std.testing.expectEqual(@as(u64, 0), res.payouts[4]); // unstaked

    // conservation: nothing burned.
    var paid: u64 = 0;
    for (res.payouts) |p| paid += p;
    try std.testing.expectEqual(res.pool, paid + res.treasury);
}

test "epoch with no eligible routes parks the whole pool in the treasury" {
    const a = std.testing.allocator;
    const maintainers = [_]reward.Maintainer{.{ .stake = 0 }}; // unstaked
    var k: [cas.HEX_LEN]u8 = undefined;
    attest("shape", &k);
    const specs = [_]RouteSpec{
        .{ .maintainer = 0, .owner_identity = 0x1, .committed_attestation = &k, .fresh_observation = "shape" },
    };
    const events = [_]usage.Event{.{ .route = 0, .payer = 0x2, .fee = 777 }};
    const res = try runEpoch(a, &maintainers, &specs, &events, 0);
    defer res.deinit(a);
    try std.testing.expectEqual(@as(u64, 0), res.payouts[0]);
    try std.testing.expectEqual(@as(u64, 777), res.treasury);
    try std.testing.expectEqual(res.pool, res.treasury);
}
