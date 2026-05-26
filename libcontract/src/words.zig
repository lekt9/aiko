//! words.zig — every word in a plan is itself a /contract pointer.
//!
//! The recursive substrate rule (this turn): `/contract` is the only
//! primitive; every word in a sentence is a child `/contract` whose
//! action is `word:<tok>`, whose parent is the sentence-contract above
//! it, and whose layer (0 — sub-cell) sits below the parent. A sentence
//! is a `/contract` of `/contract`s; a word is a leaf pointer. There is
//! no other primitive.
//!
//! Mechanically wired in `cmdDeclare` (zig/src/main.zig): after the
//! parent row is appended and its id is known, `emitWordChildren` is
//! invoked once with that id + the plan text. Each token becomes its
//! own declared row, lineage-signed by the parent via the existing
//! `declare()` path — no special row writer.
//!
//! Tokenization is intentionally minimal: split on ASCII whitespace +
//! common punctuation (`.,;:!?`), drop empties, lowercase preserved.
//! Tokens longer than 64 bytes are truncated (sanity cap; words longer
//! than 64 chars are usually identifiers we don't want fanning out). A
//! per-call dedup map prevents the same word firing twice in one
//! sentence (the second occurrence resolves to the first child via
//! inputs_hash cache hit anyway, but skipping saves the lock churn).

const std = @import("std");
const contract = @import("contract.zig");

const MAX_WORD_LEN: usize = 64;
const MAX_WORDS_PER_PLAN: usize = 256;

/// Return true if `c` separates tokens in a plan-sentence.
fn isSeparator(c: u8) bool {
    return switch (c) {
        ' ', '\t', '\n', '\r', '.', ',', ';', ':', '!', '?', '"', '\'', '(', ')', '[', ']', '{', '}', '<', '>', '/', '\\', '|', '`' => true,
        else => false,
    };
}

/// Tokenize `plan` into a heap-allocated list of unique words (≤
/// MAX_WORD_LEN bytes each, ≤ MAX_WORDS_PER_PLAN total). Returns owned
/// outer slice + each inner slice; caller frees both layers.
pub fn tokenize(allocator: std.mem.Allocator, plan: []const u8) ![][]u8 {
    var out: std.ArrayList([]u8) = .empty;
    errdefer {
        for (out.items) |w| allocator.free(w);
        out.deinit(allocator);
    }

    var i: usize = 0;
    while (i < plan.len) {
        // Skip separators.
        while (i < plan.len and isSeparator(plan[i])) : (i += 1) {}
        if (i >= plan.len) break;
        const start = i;
        while (i < plan.len and !isSeparator(plan[i])) : (i += 1) {}
        var end = i;
        if (end - start > MAX_WORD_LEN) end = start + MAX_WORD_LEN;
        const tok = plan[start..end];
        if (tok.len == 0) continue;

        // Dedup against words already emitted from THIS plan.
        var seen = false;
        for (out.items) |existing| {
            if (std.mem.eql(u8, existing, tok)) {
                seen = true;
                break;
            }
        }
        if (seen) continue;

        const copy = try allocator.dupe(u8, tok);
        errdefer allocator.free(copy);
        try out.append(allocator, copy);

        if (out.items.len >= MAX_WORDS_PER_PLAN) break;
    }

    return try out.toOwnedSlice(allocator);
}

/// For each token in `plan`, declare a child `/contract` whose action
/// is `word:<tok>` and whose parent is `parent_id`. Each child rides
/// the existing `contract.declare` cache (v2 inputs_hash) so repeated
/// emissions of the same (parent, word) pair are idempotent: the
/// cache-hit short-circuit returns the prior child id without writing
/// a new row.
///
/// Errors mid-loop are logged via the returned `Stats.failed` counter
/// but do not halt the cascade — a failed word-emission must not
/// invalidate the parent's declared row.
pub const Stats = struct {
    emitted: usize = 0,
    skipped: usize = 0,
    failed: usize = 0,
};

pub fn emitWordChildren(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    parent_id: []const u8,
    plan: []const u8,
) !Stats {
    var stats = Stats{};
    const words = try tokenize(allocator, plan);
    defer {
        for (words) |w| allocator.free(w);
        allocator.free(words);
    }

    var action_buf: [MAX_WORD_LEN + 8]u8 = undefined;
    for (words) |w| {
        const action = std.fmt.bufPrint(&action_buf, "word:{s}", .{w}) catch {
            stats.skipped += 1;
            continue;
        };
        // The word IS the plan — recursive self-pointing per the rule
        // "every word itself is a /contract to be defined within a
        // sentence that is also a /contract of /contracts that are
        // words." The child's plan field carries the same token so
        // search/list surfaces show what the pointer points at.
        const cid = contract.declare(allocator, env, w, action, .{ .parent_id = parent_id }) catch {
            stats.failed += 1;
            continue;
        };
        allocator.free(cid);
        stats.emitted += 1;
    }
    return stats;
}

// ─────────────────────────────────────────────────────────────────────────
// Tests — Σ27 binding: tests live with the source.

test "tokenize splits on whitespace + punctuation, dedups" {
    const allocator = std.testing.allocator;
    const words = try tokenize(allocator, "the quick brown fox; the quick brown fox.");
    defer {
        for (words) |w| allocator.free(w);
        allocator.free(words);
    }
    try std.testing.expectEqual(@as(usize, 4), words.len);
    try std.testing.expectEqualStrings("the", words[0]);
    try std.testing.expectEqualStrings("quick", words[1]);
    try std.testing.expectEqualStrings("brown", words[2]);
    try std.testing.expectEqualStrings("fox", words[3]);
}

test "tokenize handles empty and whitespace-only" {
    const allocator = std.testing.allocator;
    const a = try tokenize(allocator, "");
    defer allocator.free(a);
    try std.testing.expectEqual(@as(usize, 0), a.len);

    const b = try tokenize(allocator, "   \t\n  ");
    defer allocator.free(b);
    try std.testing.expectEqual(@as(usize, 0), b.len);
}

test "tokenize caps overlong words at MAX_WORD_LEN" {
    const allocator = std.testing.allocator;
    var long_buf: [128]u8 = undefined;
    @memset(&long_buf, 'a');
    const words = try tokenize(allocator, long_buf[0..128]);
    defer {
        for (words) |w| allocator.free(w);
        allocator.free(words);
    }
    try std.testing.expectEqual(@as(usize, 1), words.len);
    try std.testing.expectEqual(MAX_WORD_LEN, words[0].len);
}

test "isSeparator covers the punctuation set" {
    try std.testing.expect(isSeparator(' '));
    try std.testing.expect(isSeparator('.'));
    try std.testing.expect(isSeparator('/'));
    try std.testing.expect(!isSeparator('a'));
    try std.testing.expect(!isSeparator('-'));
    try std.testing.expect(!isSeparator('_'));
}
