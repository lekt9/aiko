//! verses.zig — verse-store adapter for the contract substrate.
//!
//! Adapter pattern: the substrate calls `relevantVerses(plan, k)` which
//! resolves the backing store from env (default `local_corpus`). The embedded
//! corpus is the 33-verse Genesis-days + tactical-teachings set canonical to
//! jstack/data/{creation-teachings,teachings}.json. Future adapter kinds
//! (`http_search`, `pgvector_cosine`) swap in via env without changing the
//! interface.
//!
//! Default scoring is naive token-overlap (lowercase, strip-punct, count
//! intersect against verse.label + .pattern + .apply). When a real embedding
//! backend lands (http_search posts to an embedding+ANN endpoint), the
//! scorer becomes the backend's response order.

const std = @import("std");

pub const Verse = struct {
    ref: []const u8,
    quote: []const u8,
    label: []const u8,
    pattern: []const u8,
    apply: []const u8,
};

pub const VerseStoreKind = enum {
    local_corpus,
    http_search,
    pgvector_cosine,

    pub fn jsonName(self: VerseStoreKind) []const u8 {
        return switch (self) {
            .local_corpus => "local_corpus",
            .http_search => "http_search",
            .pgvector_cosine => "pgvector_cosine",
        };
    }
};

pub fn resolveKind(env: std.process.Environ) VerseStoreKind {
    if (env.getPosix("AIKO_VERSE_STORE_KIND")) |v| {
        if (std.mem.eql(u8, v, "http_search")) return .http_search;
        if (std.mem.eql(u8, v, "pgvector_cosine")) return .pgvector_cosine;
    }
    return .local_corpus;
}

/// The canonical embedded verse corpus. Transcribed from
/// jstack/data/{creation-teachings,teachings}.json. The local_corpus adapter
/// scores this set against the spawn's plan and returns top-K.
pub const corpus = [_]Verse{
    // --- Genesis creation days (Gen 1–2 + Rev 20:12 + Rev 21:1) ---
    .{ .ref = "Genesis 1:3", .quote = "And God said, Let there be light: and there was light.", .label = "let there be light", .pattern = "inventory — what exists", .apply = "Inventory the relevant files, prior art, constraints before laying stones." },
    .{ .ref = "Genesis 1:6-7", .quote = "And God said, Let there be a firmament in the midst of the waters, and let it divide the waters from the waters.", .label = "divide the waters", .pattern = "separate — what divides", .apply = "Design the separations: layers, modules, contracts, directories before content." },
    .{ .ref = "Genesis 1:11", .quote = "And God said, Let the earth bring forth grass, the herb yielding seed, and the fruit tree yielding fruit after his kind.", .label = "earth brings forth", .pattern = "seed — what produces", .apply = "Write the minimal working slice — a stub that compiles, a draft that reads." },
    .{ .ref = "Genesis 1:14", .quote = "And God said, Let there be lights in the firmament of the heaven to divide the day from the night.", .label = "lights for signs", .pattern = "test — what signals", .apply = "Add one falsifiable check per shipped thing: unit test, type, schema, threshold." },
    .{ .ref = "Genesis 1:20", .quote = "And God said, Let the waters bring forth abundantly the moving creature that hath life.", .label = "creatures of waters", .pattern = "run — what moves", .apply = "Run against golden path + two edges + one adversarial case. Fix failures first." },
    .{ .ref = "Genesis 1:26", .quote = "And God said, Let us make man in our image, after our likeness: and let them have dominion.", .label = "dominion granted", .pattern = "integrate — what rules", .apply = "Run one real end-to-end exercise — the full path a user would take." },
    .{ .ref = "Genesis 2:2-3", .quote = "And on the seventh day God ended his work which he had made; and he rested on the seventh day from all his work.", .label = "the sabbath verdict", .pattern = "verdict — PROMOTE/HOLD/REJECT", .apply = "Render the verdict. If PROMOTE: ship. If HOLD: name the one remaining thing." },
    .{ .ref = "Revelation 20:12", .quote = "And I saw the dead, small and great, stand before God; and the books were opened.", .label = "the books opened", .pattern = "audit — cold re-read", .apply = "Re-read the actual artifact without the builder's eye. List what evidence confirms vs claims." },
    .{ .ref = "Revelation 21:1", .quote = "And I saw a new heaven and a new earth: for the first heaven and the first earth were passed away.", .label = "all things new", .pattern = "emergence — publish", .apply = "Publish or hand off: commit, tag, write the changelog, update the README." },
    // --- Tactical teachings (jstack/data/teachings.json) ---
    .{ .ref = "Luke 14:28", .quote = "For which of you, intending to build a tower, sitteth not down first, and counteth the cost.", .label = "count the cost", .pattern = "Reckon scope before laying stones.", .apply = "Name the concrete finish-line state. If you can't, shrink until you can." },
    .{ .ref = "Matthew 7:24-25", .quote = "Whosoever heareth these sayings of mine, and doeth them, I will liken him unto a wise man, which built his house upon a rock.", .label = "house on rock", .pattern = "Storms reveal foundations.", .apply = "Run the tests or an end-to-end call this step. If no foundation yet, write one failing test first." },
    .{ .ref = "Matthew 6:34", .quote = "Sufficient unto the day is the evil thereof.", .label = "today's trouble", .pattern = "Do not borrow tomorrow's problem.", .apply = "Work only on the next concrete step. Resist refactoring for hypothetical needs." },
    .{ .ref = "Mark 9:24", .quote = "Lord, I believe; help thou mine unbelief.", .label = "help thou mine unbelief", .pattern = "Honest confession of partial faith is where help arrives.", .apply = "Name what you don't know about this bug. Probe the unknown before patching blind." },
    .{ .ref = "Luke 15:4", .quote = "What man of you, having an hundred sheep, if he lose one of them, doth not leave the ninety and nine in the wilderness, and go after that which is lost.", .label = "the one lost sheep", .pattern = "One failing case is more informative than many passing ones.", .apply = "Chase the single failing test or edge. Fix it before returning to the herd." },
    .{ .ref = "Matthew 13:31-32", .quote = "The kingdom of heaven is like to a grain of mustard seed.", .label = "mustard seed", .pattern = "Ship the smallest working slice that grows.", .apply = "Commit the skeleton that runs before growing it." },
    .{ .ref = "John 15:2", .quote = "Every branch in me that beareth not fruit he taketh away: and every branch that beareth fruit, he purgeth it.", .label = "vinedresser prunes", .pattern = "Working code still needs cutting.", .apply = "After a green test, delete scaffolding, dead branches, duplicated helpers." },
    .{ .ref = "Matthew 9:17", .quote = "Neither do men put new wine into old bottles: else the bottles break.", .label = "new wine, new skins", .pattern = "New feature needs a fitting vessel.", .apply = "If the feature strains the abstraction, reshape it before continuing." },
    .{ .ref = "Matthew 7:7", .quote = "Ask, and it shall be given you; seek, and ye shall find; knock, and it shall be opened.", .label = "seek and find", .pattern = "Three honest axes of search; after three, absence is evidence.", .apply = "Search the codebase three ways (grep, file, test) before guessing." },
    .{ .ref = "1 Corinthians 5:6-7", .quote = "Know ye not that a little leaven leaveneth the whole lump?", .label = "a little leaven", .pattern = "Tainted input spreads through the pure body.", .apply = "Don't let test fixtures, mocks, or debug flags leak into production paths." },
    .{ .ref = "Ecclesiastes 3:1", .quote = "To every thing there is a season, and a time to every purpose under the heaven.", .label = "a time for every purpose", .pattern = "A single-window win is not trans-window truth.", .apply = "Before celebrating a passing run, vary the seed, input, conditions." },
    .{ .ref = "Judges 6:36-37", .quote = "Gideon said unto God, If thou wilt save Israel by mine hand, Behold, I will put a fleece of wool in the floor.", .label = "Gideon's fleece", .pattern = "Two independent tests on different conditions.", .apply = "Verify two ways that can't share a failure mode — unit + integration, local + staging." },
    .{ .ref = "1 Kings 19:11-12", .quote = "And after the fire a still small voice.", .label = "still small voice", .pattern = "Three dramatic attempts failed; the quiet channel carries the signal.", .apply = "If three tries failed, keep the one quiet thing that works. Retire the grand attempt." },
    .{ .ref = "Genesis 11:7", .quote = "Go to, let us go down, and there confound their language.", .label = "Babel", .pattern = "One rule for all domains produces confusion.", .apply = "Resist a single config/helper spanning unrelated domains." },
    .{ .ref = "Matthew 4:10", .quote = "Get thee hence, Satan: for it is written, Thou shalt worship the Lord thy God, and him only shalt thou serve.", .label = "the wilderness", .pattern = "Grand cross-domain proofs of power are refused.", .apply = "Reject temptations to prove the module can do everything. Keep its contract tight." },
    .{ .ref = "2 Kings 5:13", .quote = "If the prophet had bid thee do some great thing, wouldest thou not have done it? how much rather then, when he saith to thee, Wash, and be clean.", .label = "Naaman's washing", .pattern = "Grand miracle refused in favor of small humble practice that heals.", .apply = "Prefer the boring fix — bounds check, retry, clear error — over the ambitious rewrite." },
    .{ .ref = "2 Corinthians 6:14", .quote = "Be ye not unequally yoked together with unbelievers.", .label = "unequally yoked", .pattern = "Validated + unvalidated cannot plow together.", .apply = "Don't merge an unvetted dependency into the validated flow. Gate behind a flag." },
    .{ .ref = "John 14:6", .quote = "I am the way, the truth, and the life: no man cometh unto the Father, but by me.", .label = "way, truth, life", .pattern = "Distinct functions within one unity.", .apply = "Separate the three roles: routing (way), contract (truth), runtime (life). Don't collapse them." },
    .{ .ref = "Matthew 25:21", .quote = "Well done, thou good and faithful servant: thou hast been faithful over a few things, I will make thee ruler over many.", .label = "faithful in little", .pattern = "Small working things earn larger responsibility.", .apply = "Ship the small working version before expanding." },
    .{ .ref = "John 2:7", .quote = "Jesus saith unto them, Fill the waterpots with water. And they filled them up to the brim.", .label = "water into wine", .pattern = "Full obedience to the small instruction; the miracle follows.", .apply = "Do the unglamorous full-coverage step: handle the null case, write the missing test, fix the lint." },
    .{ .ref = "Luke 10:41-42", .quote = "Martha, Martha, thou art careful and troubled about many things: But one thing is needful.", .label = "Mary and Martha", .pattern = "One thing is needful.", .apply = "Name the one thing this step must finish. Close every other tab." },
    .{ .ref = "Proverbs 27:17", .quote = "Iron sharpeneth iron; so a man sharpeneth the countenance of his friend.", .label = "iron sharpens iron", .pattern = "Friction between two makes edges.", .apply = "Read back the last step's output critically before continuing." },
    .{ .ref = "Ecclesiastes 4:12", .quote = "And if one prevail against him, two shall withstand him; and a threefold cord is not quickly broken.", .label = "threefold cord", .pattern = "Redundancy is strength.", .apply = "For the load-bearing path, add a second check: a type, a test, a logged assertion." },
    .{ .ref = "John 12:24", .quote = "Except a corn of wheat fall into the ground and die, it abideth alone: but if it die, it bringeth forth much fruit.", .label = "corn of wheat", .pattern = "Death of the seed yields multiplication.", .apply = "Let the superseded contract die so the canonical successor can bear fruit." },
    .{ .ref = "Hebrews 9:27", .quote = "It is appointed unto men once to die, and after this the judgment.", .label = "appointed once to die", .pattern = "Death is final, appointed; no re-kill.", .apply = "Once a contract is marked dead, it stays dead. Append-only ledger preserves the verdict." },
};

/// Naive token-overlap score. Tokenizes both inputs, lowercases, counts
/// intersection. Stop-words ignored implicitly by minimum-token-length 3.
fn tokenOverlap(plan: []const u8, verse: Verse) usize {
    var score: usize = 0;
    var p_iter = std.mem.tokenizeAny(u8, plan, " \t\n\r.,;:()[]{}\"'!?/-");
    while (p_iter.next()) |ptok_raw| {
        if (ptok_raw.len < 3) continue;
        var lower_p: [128]u8 = undefined;
        if (ptok_raw.len > lower_p.len) continue;
        const ptok = std.ascii.lowerString(lower_p[0..ptok_raw.len], ptok_raw);
        // Match against label + pattern + apply + ref (any field).
        const fields = [_][]const u8{ verse.label, verse.pattern, verse.apply, verse.ref };
        for (fields) |field| {
            var f_iter = std.mem.tokenizeAny(u8, field, " \t\n\r.,;:()[]{}\"'!?/-");
            while (f_iter.next()) |ftok_raw| {
                if (ftok_raw.len < 3) continue;
                var lower_f: [128]u8 = undefined;
                if (ftok_raw.len > lower_f.len) continue;
                const ftok = std.ascii.lowerString(lower_f[0..ftok_raw.len], ftok_raw);
                if (std.mem.eql(u8, ptok, ftok)) {
                    score += 1;
                    break; // count each plan token at most once per verse
                }
            }
        }
    }
    return score;
}

/// Return top-K most-relevant verses from the corpus for a given plan.
/// Caller owns the returned slice; no inner allocation (verses point into
/// the const corpus). k clamped to [1, 5].
pub fn relevantVerses(allocator: std.mem.Allocator, plan: []const u8, k_in: usize) ![]Verse {
    const k = @min(@max(k_in, 1), 5);
    const N = corpus.len;
    // Score every corpus entry.
    var scores: [N]usize = undefined;
    for (corpus, 0..) |v, i| scores[i] = tokenOverlap(plan, v);
    // Pick top-K via simple selection (N is small).
    var out: std.ArrayList(Verse) = .empty;
    errdefer out.deinit(allocator);
    var picked: [N]bool = .{false} ** N;
    var picks: usize = 0;
    while (picks < k) : (picks += 1) {
        var best_i: ?usize = null;
        var best_s: isize = -1;
        for (corpus, 0..) |_, i| {
            if (picked[i]) continue;
            if (@as(isize, @intCast(scores[i])) > best_s) {
                best_s = @intCast(scores[i]);
                best_i = i;
            }
        }
        if (best_i) |bi| {
            picked[bi] = true;
            // Score 0 = no overlap; still include up to k for default context,
            // since presence of any verse is better than none for the LLM.
            try out.append(allocator, corpus[bi]);
        } else break;
    }
    return try out.toOwnedSlice(allocator);
}

/// JSON-encode a verse slice as `[{"ref":"...","label":"...",...},...]`.
/// Caller owns the returned slice. Caller frees.
pub fn toJsonArray(allocator: std.mem.Allocator, verses: []const Verse) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.append(allocator, '[');
    for (verses, 0..) |v, i| {
        if (i > 0) try out.append(allocator, ',');
        try out.appendSlice(allocator, "{\"ref\":");
        try writeJsonString(&out, allocator, v.ref);
        try out.appendSlice(allocator, ",\"label\":");
        try writeJsonString(&out, allocator, v.label);
        try out.appendSlice(allocator, ",\"pattern\":");
        try writeJsonString(&out, allocator, v.pattern);
        try out.appendSlice(allocator, ",\"apply\":");
        try writeJsonString(&out, allocator, v.apply);
        try out.append(allocator, '}');
    }
    try out.append(allocator, ']');
    return try out.toOwnedSlice(allocator);
}

fn writeJsonString(out: *std.ArrayList(u8), allocator: std.mem.Allocator, s: []const u8) !void {
    try out.append(allocator, '"');
    for (s) |b| switch (b) {
        '"' => try out.appendSlice(allocator, "\\\""),
        '\\' => try out.appendSlice(allocator, "\\\\"),
        '\n' => try out.appendSlice(allocator, "\\n"),
        '\r' => try out.appendSlice(allocator, "\\r"),
        '\t' => try out.appendSlice(allocator, "\\t"),
        else => {
            if (b < 0x20) {
                var hex: [8]u8 = undefined;
                const hex_s = try std.fmt.bufPrint(&hex, "\\u{x:0>4}", .{b});
                try out.appendSlice(allocator, hex_s);
            } else try out.append(allocator, b);
        },
    };
    try out.append(allocator, '"');
}

test "relevantVerses returns top-K for a Genesis-shaped plan" {
    const allocator = std.testing.allocator;
    // A plan that should match Day 5 (Creatures — run/test) + Day 3 (Land — seed)
    const verses = try relevantVerses(allocator, "let the substrate bring forth working code that runs against tests", 3);
    defer allocator.free(verses);
    try std.testing.expectEqual(@as(usize, 3), verses.len);
    // At least one verse should reference 'run', 'test', or 'bring forth'.
    var hit = false;
    for (verses) |v| {
        if (std.mem.indexOf(u8, v.pattern, "run") != null) hit = true;
        if (std.mem.indexOf(u8, v.label, "bring forth") != null) hit = true;
    }
    try std.testing.expect(hit);
}

test "toJsonArray produces parseable JSON" {
    const allocator = std.testing.allocator;
    const verses = try relevantVerses(allocator, "count the cost before building the tower", 2);
    defer allocator.free(verses);
    const json = try toJsonArray(allocator, verses);
    defer allocator.free(json);
    try std.testing.expect(json.len > 2);
    try std.testing.expectEqual(@as(u8, '['), json[0]);
    try std.testing.expectEqual(@as(u8, ']'), json[json.len - 1]);
}
