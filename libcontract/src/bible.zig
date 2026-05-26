//! bible.zig — KJV (public domain) baked into the substrate as a /contract corpus.
//!
//! Every verse is a contract neuron: deterministic id = HKDF(root, "verse:<ref>").
//! Cross-references (openbible CC-BY 4.0 graph) are typed edges between verse
//! contracts. The voice canon (Galatians 5:22-23, Philippians 4:8, Proverbs 15:1)
//! is scored from this corpus alongside the curated 33-verse harness corpus in
//! verses.zig.
//!
//! Data shape (see ../data/preprocess.py for the producer):
//!
//!   bible.dat:
//!     u32 verse_count                                 (= 31100)
//!     u32 book_count                                  (= 66)
//!     book_table:   66 × { u16 name_off, u16 abbrev_off,
//!                          u16 first_verse_idx, u16 chapter_count }
//!     chap_table:   per book, [u16 first_verse_idx_of_chapter; chapter_count]
//!     verse_off:    [u32 text_offset_into_text_blob; verse_count + 1]
//!     u32 pool_len   ; string_pool (null-terminated name + abbrev pairs)
//!     u32 text_len   ; text_blob (UTF-8 verse texts concatenated)
//!
//!   bible-xrefs.dat:
//!     u32 edge_count
//!     edges: [{ u16 from_verse_idx, u16 to_start, u16 to_end, u16 votes };
//!             edge_count] sorted by from_verse_idx ascending.
//!
//!   bible-xrefs-idx.dat:
//!     [u32 first_edge_offset_for_verse; verse_count + 1]

const std = @import("std");
const lineage = @import("lineage.zig");
const sha256 = std.crypto.hash.sha2.Sha256;

/// Surface a fallback / degradation event to stderr. Same contract as the
/// surface() helpers in keystore.zig / lineage.zig — fallbacks never silent.
fn surface(comptime fmt: []const u8, args: anytype) void {
    var buf: [1024]u8 = undefined;
    const line = std.fmt.bufPrint(&buf, "bible: " ++ fmt ++ "\n", args) catch return;
    _ = std.c.write(std.c.STDERR_FILENO, line.ptr, line.len);
}

// ─── embedded data ─────────────────────────────────────────────────────
// Resolved through the src/data → ../data symlink. `@embedFile` in Zig 0.16
// only honors paths reachable from the module's source-file directory; the
// --embed-dir flag and Module.addEmbedPath don't transitively expose the
// referenced file at the embed-name level. Symlink keeps the canonical
// layout (data lives at libcontract/data/) while satisfying the package
// boundary the compiler enforces.
const BIBLE_DAT: []const u8 = @embedFile("data/bible.dat");
const XREFS_DAT: []const u8 = @embedFile("data/bible-xrefs.dat");
const IDX_DAT: []const u8 = @embedFile("data/bible-xrefs-idx.dat");

pub const VERSE_COUNT: usize = 31100;
pub const BOOK_COUNT: usize = 66;

pub const VerseRef = struct {
    book_idx: u16, // 0..65
    chapter: u16, // 1-indexed
    verse: u16, // 1-indexed
    verse_idx: u32, // flat 0..31099
};

pub const CrossRef = struct {
    target_start: VerseRef,
    target_end: VerseRef, // == target_start for non-range
    votes: u16,
};

// ─── parsed header views (computed once, zero-cost slices) ─────────────
const HEADER_LEN: usize = 8; // u32 verse_count + u32 book_count
const BOOK_ENTRY_LEN: usize = 8; // u16 × 4

fn readU16(buf: []const u8, off: usize) u16 {
    return std.mem.readInt(u16, buf[off..][0..2], .little);
}
fn readU32(buf: []const u8, off: usize) u32 {
    return std.mem.readInt(u32, buf[off..][0..4], .little);
}

fn bookEntry(book_idx: u16) struct {
    name_off: u16,
    abbrev_off: u16,
    first_verse_idx: u16,
    chapter_count: u16,
} {
    const off = HEADER_LEN + @as(usize, book_idx) * BOOK_ENTRY_LEN;
    return .{
        .name_off = readU16(BIBLE_DAT, off + 0),
        .abbrev_off = readU16(BIBLE_DAT, off + 2),
        .first_verse_idx = readU16(BIBLE_DAT, off + 4),
        .chapter_count = readU16(BIBLE_DAT, off + 6),
    };
}

fn chapterTableOffset() usize {
    return HEADER_LEN + BOOK_COUNT * BOOK_ENTRY_LEN;
}

fn chapterTableLen() usize {
    var total: usize = 0;
    var bi: u16 = 0;
    while (bi < BOOK_COUNT) : (bi += 1) {
        total += @as(usize, bookEntry(bi).chapter_count) * 2;
    }
    return total;
}

fn bookChapterFirstVerse(book_idx: u16, chapter_1: u16) ?u32 {
    const be = bookEntry(book_idx);
    if (chapter_1 == 0 or chapter_1 > be.chapter_count) return null;
    // Walk to this book's chapter slot
    var off = chapterTableOffset();
    var bi: u16 = 0;
    while (bi < book_idx) : (bi += 1) off += @as(usize, bookEntry(bi).chapter_count) * 2;
    off += @as(usize, chapter_1 - 1) * 2;
    return readU16(BIBLE_DAT, off);
}

fn verseOffsetTableOffset() usize {
    return chapterTableOffset() + chapterTableLen();
}

fn verseTextRange(verse_idx: u32) struct { start: u32, end: u32 } {
    const base = verseOffsetTableOffset();
    const s = readU32(BIBLE_DAT, base + @as(usize, verse_idx) * 4);
    const e = readU32(BIBLE_DAT, base + (@as(usize, verse_idx) + 1) * 4);
    return .{ .start = s, .end = e };
}

fn stringPool() []const u8 {
    const off = verseOffsetTableOffset() + (VERSE_COUNT + 1) * 4;
    const len = readU32(BIBLE_DAT, off);
    return BIBLE_DAT[off + 4 .. off + 4 + len];
}

fn textBlob() []const u8 {
    const off = verseOffsetTableOffset() + (VERSE_COUNT + 1) * 4;
    const pool_len = readU32(BIBLE_DAT, off);
    const text_off = off + 4 + pool_len;
    const text_len = readU32(BIBLE_DAT, text_off);
    return BIBLE_DAT[text_off + 4 .. text_off + 4 + text_len];
}

fn poolString(pool: []const u8, off: u16) []const u8 {
    var end: usize = off;
    while (end < pool.len and pool[end] != 0) : (end += 1) {}
    return pool[off..end];
}

pub fn bookName(book_idx: u16) []const u8 {
    return poolString(stringPool(), bookEntry(book_idx).name_off);
}
pub fn bookAbbrev(book_idx: u16) []const u8 {
    return poolString(stringPool(), bookEntry(book_idx).abbrev_off);
}

fn chapterVerseCount(book_idx: u16, chapter_1: u16) u32 {
    const fv = bookChapterFirstVerse(book_idx, chapter_1) orelse return 0;
    const be = bookEntry(book_idx);
    const next_fv: u32 = if (chapter_1 < be.chapter_count)
        bookChapterFirstVerse(book_idx, chapter_1 + 1) orelse 0
    else blk: {
        // Last chapter of this book: next book's first verse, or VERSE_COUNT.
        if (@as(usize, book_idx) + 1 < BOOK_COUNT) {
            break :blk @as(u32, bookEntry(book_idx + 1).first_verse_idx);
        } else break :blk @as(u32, VERSE_COUNT);
    };
    return next_fv - @as(u32, fv);
}

// ─── public API ────────────────────────────────────────────────────────

/// Look up a book index by name OR canonical abbreviation (case-insensitive,
/// trimmed of trailing punctuation). Accepts "Gen", "Genesis", "1Sam",
/// "1 Sam", "1 Samuel", "Song", "Song of Solomon". Returns null on miss.
pub fn lookupBook(name_in: []const u8) ?u16 {
    // Compact: strip spaces, lowercase, into stack buffer.
    var buf: [64]u8 = undefined;
    var n: usize = 0;
    for (name_in) |c| {
        if (c == ' ' or c == '.') continue;
        if (n >= buf.len) return null;
        buf[n] = std.ascii.toLower(c);
        n += 1;
    }
    const needle = buf[0..n];
    const pool = stringPool();

    var bi: u16 = 0;
    while (bi < BOOK_COUNT) : (bi += 1) {
        const nm = poolString(pool, bookEntry(bi).name_off);
        const ab = poolString(pool, bookEntry(bi).abbrev_off);
        if (compactLowerEq(nm, needle)) return bi;
        if (compactLowerEq(ab, needle)) return bi;
    }
    // Aliases for common KJV-name variants not in the abbrev pool.
    const aliases = [_]struct { alias: []const u8, name_substr: []const u8 }{
        .{ .alias = "song", .name_substr = "Song" },
        .{ .alias = "songofsongs", .name_substr = "Song" },
        .{ .alias = "psalm", .name_substr = "Psalm" },
    };
    for (aliases) |al| {
        if (std.mem.eql(u8, needle, al.alias)) {
            var bi2: u16 = 0;
            while (bi2 < BOOK_COUNT) : (bi2 += 1) {
                const nm = poolString(pool, bookEntry(bi2).name_off);
                if (std.mem.startsWith(u8, nm, al.name_substr)) return bi2;
            }
        }
    }
    return null;
}

fn compactLowerEq(a: []const u8, needle_lower_no_space: []const u8) bool {
    var i: usize = 0;
    for (a) |c| {
        if (c == ' ' or c == '.') continue;
        if (i >= needle_lower_no_space.len) return false;
        if (std.ascii.toLower(c) != needle_lower_no_space[i]) return false;
        i += 1;
    }
    return i == needle_lower_no_space.len;
}

/// Parse a canonical "Book Ch:V" reference. Accepts "Gen 1:1", "1 Sam 17:45",
/// "Genesis 1:1", "Psalm 23:1". Returns null on unknown book / OOB.
pub fn resolve(ref_str: []const u8) ?VerseRef {
    // Find the LAST space-or-tab — book name may itself contain spaces
    // ("1 Samuel", "Song of Solomon"). The book portion is everything
    // before the last whitespace; the rest is "Ch:V".
    var split: ?usize = null;
    var i: usize = ref_str.len;
    while (i > 0) {
        i -= 1;
        if (ref_str[i] == ' ' or ref_str[i] == '\t') {
            split = i;
            break;
        }
    }
    if (split == null) return null;
    const book_part = std.mem.trim(u8, ref_str[0..split.?], " \t");
    const cv_part = std.mem.trim(u8, ref_str[split.? + 1 ..], " \t");

    const colon = std.mem.indexOfScalar(u8, cv_part, ':') orelse return null;
    const ch = std.fmt.parseInt(u16, cv_part[0..colon], 10) catch return null;
    const vs = std.fmt.parseInt(u16, cv_part[colon + 1 ..], 10) catch return null;

    const bi = lookupBook(book_part) orelse return null;
    const fv = bookChapterFirstVerse(bi, ch) orelse return null;
    const cvc = chapterVerseCount(bi, ch);
    if (vs == 0 or vs > cvc) return null;
    return VerseRef{
        .book_idx = bi,
        .chapter = ch,
        .verse = vs,
        .verse_idx = fv + @as(u32, vs - 1),
    };
}

/// Reverse: VerseRef → "Genesis 1:1" (full book name).
pub fn formatRef(ref: VerseRef, out: []u8) ![]const u8 {
    const name = bookName(ref.book_idx);
    const s = try std.fmt.bufPrint(out, "{s} {d}:{d}", .{ name, ref.chapter, ref.verse });
    return s;
}

/// Lookup the verse text. Returns a slice into the embedded blob.
pub fn verseText(ref: VerseRef) []const u8 {
    const r = verseTextRange(ref.verse_idx);
    return textBlob()[r.start..r.end];
}

/// Build the VerseRef for a flat verse_idx. O(log BOOK_COUNT) via linear
/// scan (66 books — fast enough).
pub fn refFromIdx(verse_idx: u32) ?VerseRef {
    if (verse_idx >= VERSE_COUNT) return null;
    // Find book whose [first_verse_idx, next.first_verse_idx) contains it.
    var bi: u16 = 0;
    var book_for: u16 = 0;
    while (bi < BOOK_COUNT) : (bi += 1) {
        if (@as(u32, bookEntry(bi).first_verse_idx) <= verse_idx) book_for = bi else break;
    }
    const be = bookEntry(book_for);
    // Within this book, find chapter.
    var ch: u16 = 1;
    var found_ch: u16 = 1;
    while (ch <= be.chapter_count) : (ch += 1) {
        const fv = bookChapterFirstVerse(book_for, ch) orelse return null;
        if (fv <= verse_idx) found_ch = ch else break;
    }
    const fv = bookChapterFirstVerse(book_for, found_ch) orelse return null;
    return VerseRef{
        .book_idx = book_for,
        .chapter = found_ch,
        .verse = @intCast(verse_idx - fv + 1),
        .verse_idx = verse_idx,
    };
}

/// HKDF-derived per-verse contract id. Uses lineage.deriveKeyPair against
/// the label "verse:<abbrev>.<chapter>.<verse>"; the id is the first 16
/// hex chars of sha256(public_key_bytes). Deterministic.
pub fn verseId(root: [32]u8, ref: VerseRef, out_hex: *[16]u8) !void {
    var label_buf: [64]u8 = undefined;
    const abbrev = bookAbbrev(ref.book_idx);
    const label = try std.fmt.bufPrint(&label_buf, "verse:{s}.{d}.{d}", .{ abbrev, ref.chapter, ref.verse });
    const kp = try lineage.deriveKeyPair(root, label);
    var digest: [32]u8 = undefined;
    sha256.hash(&kp.public_key.bytes, &digest, .{});
    // First 8 bytes → 16 hex chars
    const hex = "0123456789abcdef";
    var i: usize = 0;
    while (i < 8) : (i += 1) {
        out_hex[i * 2] = hex[(digest[i] >> 4) & 0x0f];
        out_hex[i * 2 + 1] = hex[digest[i] & 0x0f];
    }
}

/// Return all cross-references from `ref`, sorted by votes desc.
pub fn crossReferences(allocator: std.mem.Allocator, ref: VerseRef) ![]CrossRef {
    const start = readU32(IDX_DAT, @as(usize, ref.verse_idx) * 4);
    const end = readU32(IDX_DAT, (@as(usize, ref.verse_idx) + 1) * 4);
    if (start == end) return try allocator.alloc(CrossRef, 0);

    var out = try allocator.alloc(CrossRef, end - start);
    errdefer allocator.free(out);
    var i: u32 = start;
    var k: usize = 0;
    // Edge layout in xrefs.dat: 4-byte header, then 8 bytes per edge.
    while (i < end) : (i += 1) {
        const eoff: usize = 4 + @as(usize, i) * 8;
        const fi = readU16(XREFS_DAT, eoff + 0);
        _ = fi;
        const ts = readU16(XREFS_DAT, eoff + 2);
        const te = readU16(XREFS_DAT, eoff + 4);
        const vt = readU16(XREFS_DAT, eoff + 6);
        const tsr = refFromIdx(ts) orelse continue;
        const ter = refFromIdx(te) orelse continue;
        out[k] = .{ .target_start = tsr, .target_end = ter, .votes = vt };
        k += 1;
    }
    // Resize if any refs failed to resolve (shouldn't, but defensive).
    if (k != out.len) {
        const resized = try allocator.realloc(out, k);
        out = resized;
    }
    // Sort by votes desc.
    std.mem.sort(CrossRef, out, {}, struct {
        fn lt(_: void, a: CrossRef, b: CrossRef) bool {
            return a.votes > b.votes;
        }
    }.lt);
    return out;
}

/// Score the full 31100-verse corpus against the plan via naive token
/// overlap (same style as verses.zig — port for the open scoring surface).
/// Performance: ~50ms cold. Returns top-K verse refs.
pub fn relevantVerses(allocator: std.mem.Allocator, plan: []const u8, k: usize) ![]VerseRef {
    if (k == 0) return try allocator.alloc(VerseRef, 0);
    // Tokenize plan once.
    var plan_tokens: std.ArrayList([]const u8) = .empty;
    defer plan_tokens.deinit(allocator);
    var plan_lower_storage: std.ArrayList(u8) = .empty;
    defer plan_lower_storage.deinit(allocator);

    var p_iter = std.mem.tokenizeAny(u8, plan, " \t\n\r.,;:()[]{}\"'!?/-");
    while (p_iter.next()) |raw| {
        if (raw.len < 3 or raw.len > 64) continue;
        const start = plan_lower_storage.items.len;
        try plan_lower_storage.ensureUnusedCapacity(allocator, raw.len);
        for (raw) |c| plan_lower_storage.appendAssumeCapacity(std.ascii.toLower(c));
        try plan_tokens.append(allocator, plan_lower_storage.items[start..]);
    }
    if (plan_tokens.items.len == 0) {
        // No useful tokens; return first K verses as default context.
        const out = try allocator.alloc(VerseRef, @min(k, VERSE_COUNT));
        for (out, 0..) |*v, i| v.* = refFromIdx(@intCast(i)).?;
        return out;
    }

    // Score every verse.
    var scores = try allocator.alloc(u32, VERSE_COUNT);
    defer allocator.free(scores);
    @memset(scores, 0);

    var vi: u32 = 0;
    while (vi < VERSE_COUNT) : (vi += 1) {
        const r = verseTextRange(vi);
        const text = textBlob()[r.start..r.end];
        var s: u32 = 0;
        var f_iter = std.mem.tokenizeAny(u8, text, " \t\n\r.,;:()[]{}\"'!?/-");
        while (f_iter.next()) |ftok| {
            if (ftok.len < 3 or ftok.len > 64) continue;
            var lower_f: [64]u8 = undefined;
            const fl = std.ascii.lowerString(lower_f[0..ftok.len], ftok);
            for (plan_tokens.items) |pt| {
                if (std.mem.eql(u8, pt, fl)) {
                    s += 1;
                    break;
                }
            }
        }
        scores[vi] = s;
    }

    // Top-K via selection (k is small).
    var out = try allocator.alloc(VerseRef, k);
    var picked = try allocator.alloc(bool, VERSE_COUNT);
    defer allocator.free(picked);
    @memset(picked, false);

    var picks: usize = 0;
    while (picks < k) : (picks += 1) {
        var best_i: i64 = -1;
        var best_s: i64 = -1;
        var ii: u32 = 0;
        while (ii < VERSE_COUNT) : (ii += 1) {
            if (picked[ii]) continue;
            const s: i64 = @intCast(scores[ii]);
            if (s > best_s) {
                best_s = s;
                best_i = @intCast(ii);
            }
        }
        if (best_i < 0) break;
        const bi: u32 = @intCast(best_i);
        picked[bi] = true;
        out[picks] = refFromIdx(bi).?;
    }
    if (picks < k) {
        const resized = try allocator.realloc(out, picks);
        return resized;
    }
    return out;
}

/// Format verse + text as a single evidence line:
///   "[Gen 1:1] In the beginning God created the heaven and the earth."
pub fn formatLine(allocator: std.mem.Allocator, ref: VerseRef) ![]u8 {
    var ref_buf: [64]u8 = undefined;
    const rs = try formatRef(ref, &ref_buf);
    const text = verseText(ref);
    return try std.fmt.allocPrint(allocator, "[{s}] {s}", .{ rs, text });
}

/// Verifier helper: confirm every entry of a bible_chain matches
/// verseId(root, ref). Used by the Stop-hook signature traceback.
pub const ChainEntry = struct { ref: VerseRef, id_hex: [16]u8 };

pub fn verifyChain(root: [32]u8, chain: []const ChainEntry) bool {
    for (chain) |e| {
        var derived: [16]u8 = undefined;
        verseId(root, e.ref, &derived) catch {
            surface("verifyChain: derive failed for verse_idx={d}", .{e.ref.verse_idx});
            return false;
        };
        if (!std.mem.eql(u8, &derived, &e.id_hex)) return false;
    }
    return true;
}

// ─── tests ─────────────────────────────────────────────────────────────

test "resolve Gen 1:1 → verse_idx 0" {
    const r = resolve("Gen 1:1") orelse return error.TestFailed;
    try std.testing.expectEqual(@as(u32, 0), r.verse_idx);
    try std.testing.expectEqual(@as(u16, 0), r.book_idx);
    try std.testing.expectEqual(@as(u16, 1), r.chapter);
    try std.testing.expectEqual(@as(u16, 1), r.verse);
}

test "resolve Genesis 1:1 (full name) matches Gen 1:1" {
    const r1 = resolve("Gen 1:1") orelse return error.TestFailed;
    const r2 = resolve("Genesis 1:1") orelse return error.TestFailed;
    try std.testing.expectEqual(r1.verse_idx, r2.verse_idx);
}

test "resolve 1 Samuel 17:45 (multi-word book)" {
    const r = resolve("1 Samuel 17:45") orelse return error.TestFailed;
    try std.testing.expectEqual(@as(u16, 8), r.book_idx);
    try std.testing.expectEqual(@as(u16, 17), r.chapter);
    try std.testing.expectEqual(@as(u16, 45), r.verse);
}

test "verseText Gen 1:1 starts with In the beginning" {
    const r = resolve("Gen 1:1") orelse return error.TestFailed;
    const t = verseText(r);
    try std.testing.expect(std.mem.startsWith(u8, t, "In the beginning"));
}

test "verseText Rev 22:21 is the last verse" {
    const r = resolve("Rev 22:21") orelse return error.TestFailed;
    try std.testing.expectEqual(@as(u32, VERSE_COUNT - 1), r.verse_idx);
    const t = verseText(r);
    try std.testing.expect(t.len > 0);
}

test "formatRef round-trips" {
    const r = resolve("Gen 1:1").?;
    var buf: [64]u8 = undefined;
    const s = try formatRef(r, &buf);
    try std.testing.expectEqualSlices(u8, "Genesis 1:1", s);
}

test "crossReferences Gen 1:1 returns at least one edge" {
    const allocator = std.testing.allocator;
    const r = resolve("Gen 1:1").?;
    const xs = try crossReferences(allocator, r);
    defer allocator.free(xs);
    try std.testing.expect(xs.len >= 1);
    // Top edge should have highest votes (sorted desc).
    if (xs.len >= 2) try std.testing.expect(xs[0].votes >= xs[1].votes);
}

test "verseId deterministic + root-dependent" {
    const root_a: [32]u8 = [_]u8{0xaa} ** 32;
    const root_b: [32]u8 = [_]u8{0xbb} ** 32;
    const r = resolve("Gen 1:1").?;
    var id_a1: [16]u8 = undefined;
    var id_a2: [16]u8 = undefined;
    var id_b: [16]u8 = undefined;
    try verseId(root_a, r, &id_a1);
    try verseId(root_a, r, &id_a2);
    try verseId(root_b, r, &id_b);
    try std.testing.expectEqualSlices(u8, &id_a1, &id_a2);
    try std.testing.expect(!std.mem.eql(u8, &id_a1, &id_b));
}

test "relevantVerses includes Luke 14:28 for count-the-cost plan" {
    const allocator = std.testing.allocator;
    // Words drawn directly from Luke 14:28 KJV so token overlap can hit it.
    const verses = try relevantVerses(allocator, "intending build tower sitteth counteth cost finish", 10);
    defer allocator.free(verses);
    try std.testing.expect(verses.len > 0);
    var luke_present = false;
    for (verses) |v| {
        if (v.book_idx == 41 and v.chapter == 14 and v.verse == 28) luke_present = true;
    }
    if (!luke_present) {
        for (verses) |v| {
            var buf: [64]u8 = undefined;
            const s = formatRef(v, &buf) catch continue;
            std.debug.print("top: {s}\n", .{s});
        }
    }
    try std.testing.expect(luke_present);
}

test "verifyChain matches when ids derived from same root" {
    const root: [32]u8 = [_]u8{0xcd} ** 32;
    const r = resolve("Gen 1:1").?;
    var id_buf: [16]u8 = undefined;
    try verseId(root, r, &id_buf);
    const chain = [_]ChainEntry{.{ .ref = r, .id_hex = id_buf }};
    try std.testing.expect(verifyChain(root, &chain));
    // Wrong root → reject.
    const wrong: [32]u8 = [_]u8{0xef} ** 32;
    try std.testing.expect(!verifyChain(wrong, &chain));
}
