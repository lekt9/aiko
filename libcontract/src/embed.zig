//! embed.zig — an EMBEDDABLE embedding (the dense term for energy ranking).
//!
//! Baked into the binary, zero data files, zero network — consistent with the
//! substrate's dependency-free / collapse-to-binary doctrine. This is a
//! deterministic FEATURE-HASHING embedding (the hashing trick): each token and
//! each character-trigram is hashed into a fixed-dimension vector, then L2-
//! normalized. Cosine over these vectors captures lexical + sub-word overlap
//! (morphological variants — open/opened/opening share trigrams — and typo
//! tolerance) that exact-token bm25 misses.
//!
//! HONEST SCOPE (fallbacks visible, never silent): this is NOT a learned
//! semantic model — it does not know that "door" and "gate" are related. It is
//! the embeddable dense signal that improves ranking over pure bm25 without a
//! runtime dependency. A learned model (true synonymy) can swap in behind the
//! same `embed`/`cosine` seam later, at the cost of bundling weights.

const std = @import("std");

pub const DIM: usize = 256;

/// Embed `text` into a DIM-dimensional L2-normalized vector written to `out`
/// (must be length DIM). Tokens (>=2 chars, lowercased) and their char-trigrams
/// are hashed into buckets with sign, summed, then normalized.
pub fn embed(text: []const u8, out: []f32) void {
    std.debug.assert(out.len == DIM);
    embedDim(text, out);
}

/// Embed `text` into an `out.len`-dimensional L2-normalized feature-hash vector —
/// ANY dimension (the hashing trick is dim-agnostic). Native, zero-data, zero-network,
/// STATELESS: this is the in-body replacement for the removed llama.cpp embedding server
/// (`contract_embed_1536` calls it at 1536-d, the emergent-RAG-locked dim).
pub fn embedDim(text: []const u8, out: []f32) void {
    @memset(out, 0);

    var i: usize = 0;
    while (i < text.len) {
        if (!isWord(text[i])) {
            i += 1;
            continue;
        }
        var j = i;
        while (j < text.len and isWord(text[j])) j += 1;
        const tok = text[i..j];
        i = j;
        if (tok.len < 2) continue;

        var lbuf: [64]u8 = undefined;
        const n = @min(tok.len, lbuf.len);
        const low = std.ascii.lowerString(lbuf[0..n], tok[0..n]);

        // IDF-approx: drop function words. They carry no routing signal and their
        // shared buckets (+ trigrams like "the"/"ing"/"for") make unrelated texts
        // look similar — the noise that capped routing accuracy. No corpus needed:
        // a fixed stop list is the dependency-free stand-in for a low IDF weight.
        if (isStopword(low)) continue;

        // whole-token feature (content words carry the signal → full weight)
        addFeature(out, low, 1.0);
        // char-trigram features (sub-word: morphology + typo tolerance)
        if (low.len >= 3) {
            var k: usize = 0;
            while (k + 3 <= low.len) : (k += 1) addFeature(out, low[k .. k + 3], 0.5);
        }
    }

    // L2 normalize (so cosine = dot product).
    var norm: f32 = 0;
    for (out) |v| norm += v * v;
    norm = @sqrt(norm);
    if (norm > 0) {
        for (out) |*v| v.* /= norm;
    }
}

/// Cosine similarity of two embeddings in [-1, 1] (dot product, since both are
/// L2-normalized by `embed`).
pub fn cosine(a: []const f32, b: []const f32) f32 {
    std.debug.assert(a.len == b.len);
    var dot: f32 = 0;
    for (a, b) |x, y| dot += x * y;
    return dot;
}

/// Map cosine [-1,1] → [0,1] so it can blend as the `dense_norm` term in
/// rank.energyRank.
pub fn denseNorm(a: []const f32, b: []const f32) f64 {
    return (@as(f64, cosine(a, b)) + 1.0) / 2.0;
}

fn addFeature(out: []f32, feature: []const u8, weight: f32) void {
    const h = std.hash.Wyhash.hash(0x9e3779b97f4a7c15, feature);
    const bucket = h % out.len;
    // sign bit from a separate part of the hash → reduces collision bias
    const sign: f32 = if ((h >> 63) & 1 == 1) -1.0 else 1.0;
    out[bucket] += sign * weight;
}

fn isWord(c: u8) bool {
    return std.ascii.isAlphanumeric(c);
}

/// English function words that carry no routing signal (the IDF-approx stop list).
/// Tokens < 2 chars are already dropped, so single letters need not appear here.
fn isStopword(w: []const u8) bool {
    const stops = [_][]const u8{
        "of",   "to",   "in",    "on",   "at",    "by",   "is",    "it",   "as",
        "or",   "my",   "me",    "be",   "do",    "so",   "up",    "we",   "he",
        "if",   "an",   "the",   "and",  "for",   "are",  "was",   "its",  "you",
        "all",  "any",  "can",   "get",  "got",   "out",  "not",   "but",  "use",
        "via",  "per",  "new",   "see",  "let",   "this", "that",  "with", "from",
        "into", "over", "your",  "them", "then",  "than", "some",  "each", "have",
        "has",  "had",  "will",  "been", "here",  "does", "onto",  "off",  "our",
        "one",  "two",  "a",     "i",
    };
    for (stops) |s| if (std.mem.eql(u8, w, s)) return true;
    return false;
}

// ── runnable witnesses (the gate: `zig test src/embed.zig`) ─────────────────

test "embed is L2-normalized (unit vector) for non-empty text" {
    var v: [DIM]f32 = undefined;
    embed("open the door", &v);
    var norm: f32 = 0;
    for (v) |x| norm += x * x;
    try std.testing.expectApproxEqAbs(@as(f32, 1.0), norm, 1e-4);
}

test "similar texts are closer than dissimilar ones" {
    var a: [DIM]f32 = undefined;
    var b: [DIM]f32 = undefined;
    var c: [DIM]f32 = undefined;
    embed("open the door", &a);
    embed("opening the doors", &b); // morphological variant — shares trigrams
    embed("compute quarterly revenue", &c); // unrelated
    const sim_related = cosine(&a, &b);
    const sim_unrelated = cosine(&a, &c);
    try std.testing.expect(sim_related > sim_unrelated);
}

test "morphology: bm25 would miss open/opened, trigrams catch it" {
    var a: [DIM]f32 = undefined;
    var b: [DIM]f32 = undefined;
    embed("open", &a);
    embed("opened", &b); // no shared whole-token, but shares 'ope','pen'
    try std.testing.expect(cosine(&a, &b) > 0.0);
}

test "deterministic: same text embeds identically" {
    var a: [DIM]f32 = undefined;
    var b: [DIM]f32 = undefined;
    embed("the door is open", &a);
    embed("the door is open", &b);
    try std.testing.expectApproxEqAbs(@as(f32, 1.0), cosine(&a, &b), 1e-5);
}

test "denseNorm maps cosine into [0,1]" {
    var a: [DIM]f32 = undefined;
    embed("open the door", &a);
    const d = denseNorm(&a, &a); // identical → cosine 1 → denseNorm 1
    try std.testing.expectApproxEqAbs(@as(f64, 1.0), d, 1e-5);
}

test "empty text embeds to the zero vector (no NaN)" {
    var v: [DIM]f32 = undefined;
    embed("", &v);
    for (v) |x| try std.testing.expectEqual(@as(f32, 0.0), x);
}

test "embedDim: native stateless 1536-d embedding is L2-unit and deterministic (no server)" {
    // The emergent-RAG-locked 1536 dim, produced natively by the feature-hash —
    // the in-body replacement for the removed llama.cpp embedding server.
    var a: [1536]f32 = undefined;
    var b: [1536]f32 = undefined;
    embedDim("the contract substrate bakes the embedder natively", &a);
    embedDim("the contract substrate bakes the embedder natively", &b);
    var norm: f32 = 0;
    for (a) |x| norm += x * x;
    try std.testing.expectApproxEqAbs(@as(f32, 1.0), @sqrt(norm), 1e-4); // L2-unit
    try std.testing.expectApproxEqAbs(@as(f32, 1.0), cosine(&a, &b), 1e-5); // deterministic
}
