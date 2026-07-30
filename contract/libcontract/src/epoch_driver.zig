//! epoch_driver.zig — the capstone: run a whole epoch and emit the payout cards.
//!
//! Ties every proven piece into one runnable flow, consistent with the repo's
//! metapattern (the ledger is the source of truth; a route is a contract; its
//! output is its resolved action_result):
//!
//!   route output ──reverify.observation──► fresh_observation (shape, not data)
//!   ledger  ──resolveOwners/Attestations/parse──► owner · committed · usage
//!   owner   ──link_ledger.linkedWallet──► Solana wallet (mutual-signed)
//!   wallet  ──stake.stakeOf (chain)────► live stake
//!        └─► epoch.runEpoch ─► payouts ─► payout.payoutBatchJson ─► CARDS
//!
//! `epochPayoutCards` is the PURE core (wallets + stakes injected, so it is
//! offline-testable and moves nothing); `resolveMaintainer` is the thin LIVE
//! helper that fills a maintainer's wallet (from the ledger) + stake (from chain).
//! The cards it returns are operator-broadcastable via broadcast-tool — the
//! money-move stays the human's (claim 68).
//!
//! ZERO-DEPENDENCY: std + the std-rooted substrate modules it composes.

const std = @import("std");
const usage_ledger = @import("usage_ledger.zig");
const reverify = @import("reverify.zig");
const payout = @import("payout.zig");
const link_ledger = @import("link_ledger.zig");
const stake = @import("stake.zig");

/// A route to score this epoch: its ledger id, which maintainer it belongs to,
/// and its CURRENT resolved output (the latest action_result — the ledger already
/// holds it). The driver shapes this into the fresh_observation.
pub const RouteRun = struct {
    route_id: []const u8,
    maintainer: usize,
    current_output: []const u8,
};

/// PURE capstone. Given the ledger + route runs + each maintainer's wallet +
/// stake, produce the operator-broadcastable payout-card batch (USDC transfers,
/// one per non-zero payout). Owner identity, committed attestation, and usage are
/// read from the ledger; observations are shaped by reverify (data-invariant);
/// distribution is the proven epoch. Caller frees the returned JSON.
pub fn epochPayoutCards(
    allocator: std.mem.Allocator,
    jsonl: []const u8,
    runs: []const RouteRun,
    wallets: []const []const u8,
    stakes: []const u64,
    treasury_owner_b58: []const u8,
    cap: u64,
) ![]u8 {
    std.debug.assert(wallets.len == stakes.len);
    const n = runs.len;

    // Shape each route's current output into its fresh_observation. Kept alive
    // (in `obs`) until the epoch has run, then freed.
    const obs = try allocator.alloc([]u8, n);
    var built: usize = 0;
    defer {
        for (obs[0..built]) |o| allocator.free(o);
        allocator.free(obs);
    }
    const routes = try allocator.alloc(usage_ledger.LedgerRoute, n);
    defer allocator.free(routes);
    for (runs, 0..) |run, i| {
        obs[i] = try reverify.observation(allocator, run.current_output);
        built = i + 1;
        routes[i] = .{ .route_id = run.route_id, .maintainer = run.maintainer, .fresh_observation = obs[i] };
    }

    const res = try usage_ledger.runEpochFromLedger(allocator, jsonl, routes, stakes, cap);
    defer res.deinit(allocator);

    return payout.payoutBatchJson(allocator, treasury_owner_b58, wallets, res.payouts);
}

/// A resolved maintainer: the verified wallet (from the ledger's link rows) and
/// its live stake (from chain). `wallet` is owned by the caller.
pub const Maintainer = struct {
    wallet: []u8,
    stake: u64,
};

/// LIVE: resolve a route owner's wallet (link_ledger, mutual-signed, from the
/// ledger) and its stFDRY stake (stake.zig, from chain via `url`). Returns null
/// if the owner has no verified wallet link (unlinked owners can't earn — honest).
pub fn resolveMaintainer(
    allocator: std.mem.Allocator,
    jsonl: []const u8,
    owner_env_pubkey_hex: []const u8,
    url: []const u8,
) !?Maintainer {
    const wallet = (try link_ledger.linkedWallet(allocator, jsonl, owner_env_pubkey_hex)) orelse return null;
    errdefer allocator.free(wallet);
    const s = try stake.stakeOf(allocator, url, wallet);
    return .{ .wallet = wallet, .stake = s };
}

// ── witnesses (zig test) — no fabricated green ───────────────────────────────

test "CAPSTONE: ledger + route runs → payout cards; churn stays, drift forfeits" {
    const a = std.testing.allocator;
    const cas = @import("cas.zig");
    const voltr = @import("voltr.zig");

    // Two routes, two maintainers. Attestations are committed from an INITIAL
    // output; the epoch re-runs with the CURRENT output:
    //   route:A committed {"price":1,"sym":"S"}; current {"price":999,"sym":"Z"}
    //           → same SHAPE → verified → earns.
    //   route:B committed {"x":1,"y":2};          current {"x":1}
    //           → shape DRIFTED (lost a field) → forfeits.
    var kA: [cas.HEX_LEN]u8 = undefined;
    try reverify.attestationKey(a,
        \\{"price":1,"sym":"S"}
    , &kA);
    var kB: [cas.HEX_LEN]u8 = undefined;
    try reverify.attestationKey(a,
        \\{"x":1,"y":2}
    , &kB);

    const lines = [_][]const u8{
        try std.fmt.allocPrint(a, "{{\"event\":\"declared\",\"id\":\"route:A\",\"env_pubkey\":\"KEYA\"}}", .{}),
        try std.fmt.allocPrint(a, "{{\"event\":\"declared\",\"id\":\"route:B\",\"env_pubkey\":\"KEYB\"}}", .{}),
        try usage_ledger.emitAttestRow(a, "route:A", &kA, "t"),
        try usage_ledger.emitAttestRow(a, "route:B", &kB, "t"),
        try usage_ledger.emitRow(a, "route:A", "OUT1", 600, "t"),
        try usage_ledger.emitRow(a, "route:A", "OUT2", 400, "t"),
        try usage_ledger.emitRow(a, "route:B", "OUT3", 500, "t"),
    };
    defer for (lines) |l| a.free(l);
    const jsonl = try std.mem.join(a, "\n", &lines);
    defer a.free(jsonl);

    const runs = [_]RouteRun{
        .{ .route_id = "route:A", .maintainer = 0, .current_output =
        \\{"price":999,"sym":"Z"}
        },
        .{ .route_id = "route:B", .maintainer = 1, .current_output =
        \\{"x":1}
        },
    };
    // maintainer wallets (any valid base58 pubkeys) + live-style stakes.
    const wallets = [_][]const u8{ voltr.VAULT, voltr.VAULT_MANAGER };
    const stakes = [_]u64{ 10, 10 };

    const cards = try epochPayoutCards(a, jsonl, &runs, &wallets, &stakes, voltr.VAULT_MANAGER, 0);
    defer a.free(cards);

    // Pool = 1500; route:A verified (shape held through data churn) takes it all;
    // route:B forfeited (drift). Exactly ONE payout card, to maintainer 0's wallet.
    var count: usize = 0;
    var i: usize = 0;
    while (std.mem.indexOfPos(u8, cards, i, "transfer_checked")) |p| : (i = p + 1) count += 1;
    try std.testing.expectEqual(@as(usize, 1), count);
    try std.testing.expect(std.mem.indexOf(u8, cards, "\"amount\":1500") != null);
}
