//! terminal.zig — the ONE terminal-event classifier for the substrate.
//!
//! Biology: a cell has a single apoptosis-recognition machinery, not one in the
//! liver and a different one in the brain. Before this module, terminality was
//! decided in at least four places that disagreed — isSatisfied and isDead
//! (main.zig), terminalClass and findLatestTerminalSignature (cache.zig) — and
//! `isDead` was blind to `purged`, so a satisfied-then-purged producer was read
//! two contradictory ways (fork F3 in the plan). This leaf is the single
//! authority every reader must route through.
//!
//! The terminal alphabet is EXACTLY three events: `satisfied`, `died`, `purged`.
//! `apoptosed` / `superseded` / `contradicts` / `stale` are NOT events — they are
//! DeathCause values written ON a `died` row (contract.zig markDied). Verified
//! against the real 51k-row ledger.
//!
//! Note on purge (fork F11): a Decalogue purge is written two ways in the code —
//! `markPurged` emits a distinct `purged` event, while the runAction path emits a
//! `died` row with `cause=apoptosed, reason="purged by ..."`. In the current
//! ledger only the latter has ever fired (0 `purged` events, 237 `died`). This
//! single authority makes that writing-fork irrelevant to every READER: both
//! `died` and `purged` satisfy `nullifies()`, so downstream truth stops the same
//! way regardless of which purge path wrote the row.
//!
//! Row-representation-agnostic by design: it takes the event STRING, so the
//! struct-slice Row (main.zig), the raw-bytes line view (cache.zig), and the
//! fractal Row all share one classifier without first unifying their row types.
const std = @import("std");

/// The complete terminal classification of a single ledger event.
pub const TerminalClass = enum {
    /// Not a terminal event — the walk keeps going.
    pending,
    /// Positive terminal. Resolves the contract TRUE; carries a value /
    /// output_signature. The ONLY class that makes a claim hold now.
    satisfied,
    /// Negative terminal (event `died`, any DeathCause). Carries an
    /// output_signature; nullifies downstream truth.
    dead,
    /// Nulling terminal (event `purged`, the Decalogue gate). Nullifies
    /// downstream truth AND contributes no signature — the row is treated as
    /// never-resolved while history stays visible (append-only).
    purged,
};

/// Classify one ledger event name. The single source of truth for "is this a
/// terminal, and which one." Every hand-rolled `eql(event,"satisfied"/"died"/
/// "purged")` in the codebase must be replaced by a call to this.
pub fn classify(event: []const u8) TerminalClass {
    if (std.mem.eql(u8, event, "satisfied")) return .satisfied;
    if (std.mem.eql(u8, event, "died")) return .dead;
    if (std.mem.eql(u8, event, "purged")) return .purged;
    return .pending;
}

/// Terminal at all? (the row ends the newest-first walk)
pub fn isTerminal(c: TerminalClass) bool {
    return c != .pending;
}

/// Does this terminal resolve the contract TRUE? Only `satisfied`.
pub fn isSatisfiedClass(c: TerminalClass) bool {
    return c == .satisfied;
}

/// Does this terminal NULLIFY the contract? Biology's apoptosis: BOTH natural
/// death and Decalogue purge stop downstream truth. This is the predicate whose
/// absence was fork F3 — `isDead` recognized only `dead` and missed `purged`.
pub fn nullifies(c: TerminalClass) bool {
    return c == .dead or c == .purged;
}

/// Does this terminal carry an `output_signature`? `satisfied` and `died` do;
/// `purged` nullifies (no signature contribution); `pending` is not terminal.
/// Mirrors the old cache 3-way `.signature` class.
pub fn carriesSignature(c: TerminalClass) bool {
    return c == .satisfied or c == .dead;
}

test "classify: the terminal alphabet is exactly satisfied/died/purged" {
    try std.testing.expectEqual(TerminalClass.satisfied, classify("satisfied"));
    try std.testing.expectEqual(TerminalClass.dead, classify("died"));
    try std.testing.expectEqual(TerminalClass.purged, classify("purged"));
    // Non-terminal / process events → pending.
    for ([_][]const u8{ "declared", "iterated", "cache_check", "cache_resolved", "evidence", "guard", "pattern", "grant", "child_added", "" }) |ev| {
        try std.testing.expectEqual(TerminalClass.pending, classify(ev));
    }
    // A DeathCause is NOT an event — it never classifies as terminal on its own.
    try std.testing.expectEqual(TerminalClass.pending, classify("apoptosed"));
    try std.testing.expectEqual(TerminalClass.pending, classify("superseded"));
}

test "predicates encode the biology: purge nullifies exactly like death" {
    // The whole point of F3: nullifies() must be true for BOTH dead and purged.
    try std.testing.expect(nullifies(.dead));
    try std.testing.expect(nullifies(.purged));
    try std.testing.expect(!nullifies(.satisfied));
    try std.testing.expect(!nullifies(.pending));

    // Only satisfied resolves true.
    try std.testing.expect(isSatisfiedClass(.satisfied));
    try std.testing.expect(!isSatisfiedClass(.dead));
    try std.testing.expect(!isSatisfiedClass(.purged));

    // satisfied XOR nullifies partitions the terminals; pending is neither.
    for ([_]TerminalClass{ .satisfied, .dead, .purged }) |c| {
        try std.testing.expect(isTerminal(c));
        try std.testing.expect(isSatisfiedClass(c) != nullifies(c)); // exactly one
    }
    try std.testing.expect(!isTerminal(.pending));

    // Signature carriers = satisfied + dead; purged carries none.
    try std.testing.expect(carriesSignature(.satisfied));
    try std.testing.expect(carriesSignature(.dead));
    try std.testing.expect(!carriesSignature(.purged));
    try std.testing.expect(!carriesSignature(.pending));
}
