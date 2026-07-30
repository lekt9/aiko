//! ebm.zig — the train-on-fire ORGAN at the substrate base.
//!
//! The substrate already SCORES energy (rank.zig: energy = -fused bm25/dense; coherence.zig: the
//! energy gate that settles in <=7 ticks) and already POTENTIATES by firing-rate (pattern_use ->
//! primitive, the Hebbian LTP). The missing organ is the one the question names: a neuron that
//! TRAINS an energy whenever it fires. Here it is.
//!
//! A `Prototype` is a reward-weighted running-mean centroid over context vectors (West 1979 — the
//! /sp-ebm cache atom, O(1) per fire). FIRING folds the context in (positive reward pulls toward
//! it = Hebbian; negative pushes away = inhibition / the contrastive negative phase, the substrate's
//! `inhibits` synapse). Energy of a context is its negative cosine to the prototype; routing is
//! argmin energy (the /sp-ebm settle atom). Reuses embed.zig for the text->vector and cosine, so a
//! neuron trains on the SAME embedding the rest of the substrate ranks by.
//!
//! Why this is more than the content-addressed cache (contract.declare/get): a cache recalls EXACT
//! inputs. The prototype scores by DISTANCE, so a NEARBY context never fired before still routes
//! correctly -- it GENERALIZES. That is the selection->generation bridge, witnessed by the test
//! below. Honest limit (the standing law): one centroid generalizes only where good configs ARE a
//! single cluster; where they are not, one prototype is too weak -- the real generation wall.
const std = @import("std");
const embed = @import("embed.zig");

pub const DIM = embed.DIM;

/// Canonical energy-cell implementation for any embedding width. The substrate
/// has both the compact feature-hash embedder and the baked BGE sentence
/// embedder; their cells must share the exact same train/evaluate mathematics.
pub fn PrototypeFor(comptime dim: usize) type {
    return struct {
        mean: [dim]f32 = [_]f32{0} ** dim,
        w: f64 = 0,

        pub fn fold(self: *@This(), x: []const f32, reward: f64) void {
            const w_new = self.w + reward;
            if (@abs(w_new) < 1e-9) {
                self.mean = [_]f32{0} ** dim;
                self.w = 0;
                return;
            }
            const a: f32 = @floatCast(reward / w_new);
            for (&self.mean, 0..) |*m, i| m.* += a * (x[i] - m.*);
            self.w = w_new;
        }

        pub fn energy(self: @This(), x: []const f32) f64 {
            if (self.w <= 0) return std.math.inf(f64);
            return -@as(f64, cosineN(dim, x, &self.mean));
        }
    };
}

fn cosineN(comptime dim: usize, a: []const f32, b: *const [dim]f32) f32 {
    var dot: f32 = 0;
    var na: f32 = 0;
    var nb: f32 = 0;
    for (0..dim) |i| {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na <= 0 or nb <= 0) return 0;
    return dot / @sqrt(na * nb);
}

pub const Prototype = struct {
    cell: PrototypeFor(DIM) = .{},

    pub fn fold(self: *Prototype, x: []const f32, reward: f64) void {
        self.cell.fold(x, reward);
    }

    pub fn foldText(self: *Prototype, text: []const u8, reward: f64) void {
        var v: [DIM]f32 = undefined;
        embed.embed(text, &v);
        self.fold(&v, reward);
    }
};

/// EVAL: energy = -cosine(x, prototype). Low energy = good fit. +inf when the neuron is cold
/// (never fired) -- never a fabricated score.
pub fn energy(p: Prototype, x: []const f32) f64 {
    return p.cell.energy(x);
}

pub fn energyText(p: Prototype, text: []const u8) f64 {
    var v: [DIM]f32 = undefined;
    embed.embed(text, &v);
    return energy(p, &v);
}

/// HALFLIFE_DAYS — the disuse half-life for route freshness. After this many days
/// without a fire, a route's pull has halved. The constant is unbrowse's published
/// freshness law (arXiv:2604.00694 §6.3, freshness(d)=1/(1+d/30)) — the sister
/// substrate's proven catabolic rate, reused rather than re-derived.
pub const HALFLIFE_DAYS: f64 = 30.0;

/// ATROPHY-WITH-DISUSE — the catabolic half of the muscle. A route's freshness
/// decays with the age (in seconds) since it last fired:
///   freshness = 1 / (1 + age_days / HALFLIFE_DAYS)
/// 1.0 at age 0, 0.5 at one half-life, → 0 as age → ∞. PURE: the clock is the
/// caller's (no I/O here), so this stays the testable math. Training STILL only
/// adds (fold = synthesis); this is the subtraction that makes the organ a muscle
/// instead of a ratchet — synthesis MINUS degradation (Matt 25:29: "from him that
/// hath not shall be taken away even that which he hath"). A negative/zero age
/// clamps to 1.0 (a future-dated row never earns MORE than fresh).
pub fn freshness(age_secs: f64, halflife_days: f64) f64 {
    if (age_secs <= 0) return 1.0;
    const age_days = age_secs / 86400.0;
    return 1.0 / (1.0 + age_days / halflife_days);
}

/// SETTLE / route: argmin energy over the candidate prototypes; null if all cold (honest refusal).
pub fn route(protos: []const Prototype, x: []const f32) ?usize {
    var best: ?usize = null;
    var best_e = std.math.inf(f64);
    for (protos, 0..) |p, i| {
        const e = energy(p, x);
        if (e < best_e) {
            best_e = e;
            best = i;
        }
    }
    return best;
}

pub fn routeText(protos: []const Prototype, text: []const u8) ?usize {
    var v: [DIM]f32 = undefined;
    embed.embed(text, &v);
    return route(protos, &v);
}

/// REWARD_CAP bounds the fold-weight a single tip can carry (ln(1+~2980) ≈ 8).
pub const REWARD_CAP: f64 = 8.0;

/// Map an economic TIP value into a bounded EBM reward magnitude — the safe bridge
/// from "value received" to "train the route" (the tip-as-reward design). The fold
/// it feeds is `Prototype.fold` (West 1979): reward>0 pulls the route TOWARD the tipped
/// context (Matt 13:12 — "to him that hath shall be given"); reward<0 pushes away.
///
///   value > 0   (a SATISFIED contract was tipped) -> positive bounded reward.
///   value < 0   (a refund / chargeback on a died row) -> negative -> inhibition.
///   value == 0  -> 0 (no fold).
///   is_self     -> 0: a contract cannot tip ITSELF into preference. A self-sourced
///               tip is no witness (Deut 19:15 — two or three, never one); it folds
///               nothing. This is the routing-layer twin of the prune-authority rule.
///
/// BOUNDED by log + a hard cap (Mark 12:43, the widow's mite): reward =
/// sign(value)·min(ln(1+|value|), REWARD_CAP). Monotone in |value| but SATURATING, so
/// 1e6 and 1e9 fold nearly the same — value SHAPES the route, it cannot BUY it.
///
/// PURE (no I/O, no ledger) — the load-bearing math the tip-loop rests on. The x402
/// receipt that SUPPLIES `value` (to the contract's HKDF-derived Solana address) and
/// the onFire wiring that consumes it are the named next waves; value follows the
/// verdict (a satisfied row), it never replaces it (the Word stays the truth-root).
pub fn rewardFromTip(value: f64, is_self: bool) f64 {
    if (is_self or value == 0) return 0;
    const mag = @log(1.0 + @abs(value));
    const bounded = @min(mag, REWARD_CAP);
    return if (value < 0) -bounded else bounded;
}

test "train-on-fire generalizes to held-out contexts (not memorization)" {
    // three actions, each a FAMILY of related phrases (they share a token, not exact strings).
    const trains = [_][]const []const u8{
        &.{ "paint cell a1 red", "paint cell b2 red", "paint cell c3 red", "paint dot d4 red" },
        &.{ "move up one", "move down two", "move left now", "move right step" },
        &.{ "submit the board", "submit now please", "commit and submit", "submit final answer" },
    };
    // held-out phrases NEVER fired -> a hash-cache would miss them (chance). The EBM must still land.
    const held = [_][]const u8{ "paint cell z9 red", "move up again", "submit the result" };

    var protos: [3]Prototype = .{ .{}, .{}, .{} };
    for (trains, 0..) |fam, i| {
        for (fam) |t| protos[i].foldText(t, 1.0); // FIRE: train each action's prototype
    }

    var ok: usize = 0;
    for (held, 0..) |t, i| {
        const r = routeText(protos[0..], t) orelse continue;
        if (r == i) ok += 1;
    }
    // The assertion IS the witness — a test must not std.debug.print into the
    // build runner's IPC/progress stream (it desyncs `zig build test --listen=-`,
    // surfacing a spurious "failed command" though the test passes standalone).
    try std.testing.expect(ok == held.len);

    // and the contrastive negative phase: inhibiting a WRONG context (a negative example that
    // should not route here) pushes the prototype away from it -> that context's energy goes UP.
    var p: Prototype = .{};
    p.foldText("paint cell a1 red", 1.0);
    p.foldText("paint cell b2 red", 1.0); // prototype = the paint centroid
    const neg_before = energyText(p, "move up one");
    p.foldText("move up one", -1.0); // INHIBIT: this wrong context fired and got punished
    const neg_after = energyText(p, "move up one");
    try std.testing.expect(neg_after > neg_before); // inhibition raised the wrong context's energy
}

test "per-binary routing: trains from (goal→binary) fires and routes HELD-OUT goals" {
    // This is the `contract recommend` loop at the unit level: one prototype per binary,
    // trained on the GOALS where that binary succeeded (reward +1). Then goals never
    // trained on must still route to the right binary by argmin energy (generalize).
    var git: Prototype = .{};
    var grep: Prototype = .{};
    for ([_][]const u8{ "commit my changes", "stage files for a commit", "push the branch to the remote" }) |g|
        git.foldText(g, 1.0);
    for ([_][]const u8{ "search for a string in files", "find a pattern recursively", "look for text in the source" }) |g|
        grep.foldText(g, 1.0);
    const protos = [_]Prototype{ git, grep }; // index 0 = git, 1 = grep

    // held-out goals — NEVER folded; a hash cache would miss them. The router must land.
    try std.testing.expectEqual(@as(?usize, 0), routeText(protos[0..], "save my work to version control")); // git
    try std.testing.expectEqual(@as(?usize, 0), routeText(protos[0..], "roll back to a previous commit")); // git
    try std.testing.expectEqual(@as(?usize, 1), routeText(protos[0..], "hunt for a phrase in the files")); // grep
    try std.testing.expectEqual(@as(?usize, 1), routeText(protos[0..], "look for a word across the tree")); // grep
}

test "rewardFromTip: bounded, self-refused, sign-correct (the tip->reward bridge)" {
    // self-tip folds NOTHING (Deut 19:15 — no self-witness; the from!=self gate).
    try std.testing.expect(rewardFromTip(1000, true) == 0);
    // zero value -> zero reward.
    try std.testing.expect(rewardFromTip(0, false) == 0);
    // a positive tip -> positive reward (Hebbian, Matt 13:12).
    try std.testing.expect(rewardFromTip(100, false) > 0);
    // monotone in magnitude (a bigger tip folds at least as hard)...
    try std.testing.expect(rewardFromTip(1_000_000, false) >= rewardFromTip(100, false));
    // ...but BOUNDED (Mark 12:43): a whale tip cannot buy the route — the cap bites EXACTLY.
    try std.testing.expect(rewardFromTip(1_000_000_000, false) == REWARD_CAP);
    // a refund / chargeback (negative value) -> inhibition (negative reward).
    try std.testing.expect(rewardFromTip(-50, false) < 0);
    // the bridge reaches the real organ: a positive tip-reward folded into a prototype
    // pulls it TOWARD the tipped context (that context's energy is lower than an unrelated one).
    var p: Prototype = .{};
    p.foldText("ship the feature", rewardFromTip(500, false));
    try std.testing.expect(energyText(p, "ship the feature") < energyText(p, "delete everything"));
}

test "freshness: atrophy halves at one half-life and decays toward zero (the catabolic half)" {
    // fresh route, just fired -> full pull.
    try std.testing.expectApproxEqAbs(@as(f64, 1.0), freshness(0, HALFLIFE_DAYS), 1e-9);
    // one half-life of disuse -> pull halved (the defining muscle property).
    try std.testing.expectApproxEqAbs(@as(f64, 0.5), freshness(HALFLIFE_DAYS * 86400.0, HALFLIFE_DAYS), 1e-9);
    // a decade buried -> all but fully atrophied (Matt 25:29).
    try std.testing.expect(freshness(3650.0 * 86400.0, HALFLIFE_DAYS) < 0.01);
    // monotone: older is never fresher.
    try std.testing.expect(freshness(10 * 86400.0, HALFLIFE_DAYS) > freshness(60 * 86400.0, HALFLIFE_DAYS));
    // a future-dated row clamps to fresh — disuse decays, it never compounds the other way.
    try std.testing.expect(freshness(-100, HALFLIFE_DAYS) == 1.0);
}
