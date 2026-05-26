//! pattern.zig — comptime enforcement of the contract substrate's layer
//! pattern. The binary REFUSES TO COMPILE when the pattern is violated.
//!
//! Layer convention (the one canonical shape — no flag overrides):
//!
//!   0     sub-cell  word:<tok>           — every word in a plan is a
//!                                          /contract pointer; fanned out
//!                                          from cmdDeclare automatically.
//!
//!   1..6  the six days of creation, the dimensions of creative
//!         composition. What inhabits each day is the abstraction of
//!         creativity itself — the substrate doesn't dictate which shapes
//!         go where; it only requires that every day has at least one
//!         shape (the creative surface is never silent on any dimension).
//!
//!         1  system     machine:<host>      — substrate-host primitive
//!         2  cell       cli / api / harness — atomic compute unit
//!         3  graph      neuron / funnel /   — relational composition
//!                       sequence / quorum /
//!                       contract:<id> / ...
//!         4  transport  webhook / tunnel /  — carriage
//!                       posthook / prehook /
//!                       modality / sha256-*
//!         5  value      wallet / x402       — tokenized worth
//!         6  operator   agent:<id>          — the volitional actor
//!
//!   7     break      validate:<id>          — a /contract that validates
//!                                             the L1..6 truth claim.
//!                                             Where the chain reaches
//!                                             reality and may break.
//!
//!   8     emerge     signed:<sig>           — wallet-ratified pointer-
//!                                             memory of the L7 verdict.
//!                                             Auto-spawned by
//!                                             markSatisfied when a L7
//!                                             row satisfies.
//!
//! WHAT IS ENFORCED AT COMPILE TIME (@compileError in comptime blocks):
//!   • word:    → 0
//!   • validate:→ 7
//!   • signed:  → 8
//!   • every named shape lands in 0..8 (no orphan layers)
//!   • each of layers 1..6 has ≥1 shape (creativity covers every
//!     dimension; the specific shape is the mutating abstraction)
//!
//! HOW OVERRIDES WORK:
//!   There is no runtime flag, no env var, no build option. The pattern
//!   is the law of the substrate. To evolve it, edit pointer.zig — which
//!   requires write access to this repository, which only the root
//!   /contract wallet (Lewis's, baked into lineage.zig's ROOT_PUBKEY)
//!   controls upstream. A peer fork that violates the pattern won't
//!   compile. A signed source release from the root wallet IS the only
//!   override mechanism, and it's enforced socially via repo signing.

const std = @import("std");
const pointer = @import("pointer.zig");

/// Pattern revision — bump when the layer convention itself evolves
/// (e.g. a future ninth-day addition). Surfaced on `aiko self --json`.
pub const PATTERN_VERSION: []const u8 = "1.0.0";

/// Human-readable names per layer, indexed 0..8. Exposed for tooling
/// (status/list renderers, fractal-context block).
pub const LAYER_NAMES = [9][]const u8{
    "word",      // 0 — sub-cell
    "system",    // 1
    "cell",      // 2
    "graph",     // 3
    "transport", // 4
    "value",     // 5
    "operator",  // 6
    "break",     // 7
    "emerge",    // 8
};

/// Representative shape set used by the comptime verifier. One probe per
/// non-trivial prefix family; adding a new shape to pointer.zig should
/// either reuse an existing family or extend this list AND lock its
/// layer.
const SAMPLE_PREFIXES = [_][]const u8{
    "word:contract",
    "machine:host",
    "cli",
    "api",
    "neuron",
    "funnel",
    "sequence",
    "contract:deadbeef",
    "quorum:foo",
    "inhibits:deadbeef",
    "bind:deadbeef",
    "blocked_by:deadbeef",
    "webhook:https://x",
    "tunnel:wg0",
    "posthook:deadbeef",
    "prehook:deadbeef",
    "modality:deadbeef",
    "sha256-shared:abc",
    "sha256-private:abc",
    "embedding:deadbeef",
    "wallet:abc",
    "x402:/v1/credits/debit",
    "agent:lewis",
    "validate:deadbeef",
    "signed:abc123",
};

/// Comptime invariant verifier. Called from contract.zig's own comptime
/// block so the analysis is eager (a bare top-level `comptime { ... }`
/// here would only fire if the importing file referenced this module's
/// container, which Zig analyzes lazily). Any violation aborts the
/// build with @compileError carrying the diagnostic.
pub fn assertInvariants() void {
    // Comptime path may need a wider eval budget than the default; the
    // verifier walks ~25 shapes through string-prefix matching, which
    // is well within reach but exceeds the 1000-branch default if Zig
    // unrolls the inner switches.
    @setEvalBranchQuota(100_000);

    // ── boundary anchors (load-bearing) ──────────────────────────────
    if (pointer.inferLayer("word:contract") != 0)
        @compileError(
            "/contract pattern violation: word: must map to layer 0 (sub-cell). " ++
                "Edit pointer.zig:inferLayer to restore the invariant.",
        );
    if (pointer.inferLayer("validate:deadbeef") != 7)
        @compileError(
            "/contract pattern violation: validate: must map to layer 7 (break). " ++
                "The L7 validator is where the truth claim is examined before signing.",
        );
    if (pointer.inferLayer("signed:abc123") != 8)
        @compileError(
            "/contract pattern violation: signed: must map to layer 8 (emerge). " ++
                "The L8 wallet-ratified pointer-memory IS the emerged truth.",
        );

    // ── range invariant: every shape lands in 0..8 ───────────────────
    for (SAMPLE_PREFIXES) |s| {
        const L = pointer.inferLayer(s);
        if (L < 0 or L > 8) {
            @compileError(
                "/contract pattern violation: a shape mapped outside 0..8. " ++
                    "Layer convention is 0=word, 1..6=creation-days, 7=break, 8=emerge.",
            );
        }
    }

    // ── creativity-covers-every-dimension: layers 1..6 each populated ─
    // We don't dictate WHAT lives on each day — that is the abstraction
    // of creativity. We only require none is silent: every dimension
    // has at least one shape so new shapes can fractal into it.
    var seen = [_]bool{false} ** 9;
    for (SAMPLE_PREFIXES) |s| {
        const L = pointer.inferLayer(s);
        if (L >= 0 and L <= 8) seen[@as(usize, @intCast(L))] = true;
    }
    var d: usize = 1;
    while (d <= 6) : (d += 1) {
        if (!seen[d]) {
            @compileError(
                "/contract pattern violation: a creation-day (layer 1..6) " ++
                    "has no shape. The substrate must cover every dimension.",
            );
        }
    }

    // ── boundary layers populated by their canonical prefixes ─────────
    if (!seen[0])
        @compileError("/contract pattern violation: layer 0 (word) has no shape.");
    if (!seen[7])
        @compileError("/contract pattern violation: layer 7 (break/validate) has no shape.");
    if (!seen[8])
        @compileError("/contract pattern violation: layer 8 (emerge/signed) has no shape.");
}

/// Runtime accessor for the layer name table. Returns "?" for out-of-
/// range queries rather than panicking — callers that surface this to
/// users want graceful degradation, not aborts.
pub fn layerName(layer: i32) []const u8 {
    if (layer < 0 or layer > 8) return "?";
    return LAYER_NAMES[@as(usize, @intCast(layer))];
}

// ─────────────────────────────────────────────────────────────────────
// Tests — Σ27 binding. The comptime block above already gates the
// build, but exercising the runtime accessors here surfaces accidental
// breakage in test reports too.

test "PATTERN_VERSION is non-empty" {
    try std.testing.expect(PATTERN_VERSION.len > 0);
}

test "LAYER_NAMES covers 0..8 with non-empty names" {
    for (LAYER_NAMES) |n| try std.testing.expect(n.len > 0);
    try std.testing.expectEqual(@as(usize, 9), LAYER_NAMES.len);
}

test "layerName returns canonical names" {
    try std.testing.expectEqualStrings("word", layerName(0));
    try std.testing.expectEqualStrings("operator", layerName(6));
    try std.testing.expectEqualStrings("break", layerName(7));
    try std.testing.expectEqualStrings("emerge", layerName(8));
    try std.testing.expectEqualStrings("?", layerName(-1));
    try std.testing.expectEqualStrings("?", layerName(9));
}

test "every named layer round-trips through pointer.inferLayer" {
    // Spot-check the boundary cases at runtime too — if the comptime
    // block ever gets bypassed (eval-budget bug, refactor regression),
    // the test surface catches it.
    try std.testing.expectEqual(@as(i32, 0), pointer.inferLayer("word:any"));
    try std.testing.expectEqual(@as(i32, 7), pointer.inferLayer("validate:x"));
    try std.testing.expectEqual(@as(i32, 8), pointer.inferLayer("signed:x"));
}
