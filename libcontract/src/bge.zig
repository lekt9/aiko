//! bge.zig — a REAL learned sentence embedder, baked into the binary. Pure Zig: a
//! 12-layer BERT (bge-small-en-v1.5) forward pass over per-row int8 weights + a
//! WordPiece tokenizer, both @embedFile'd. Zero runtime deps, zero network, signed —
//! the same collapse-to-binary doctrine as the GloVe lexicon, extended from a lookup
//! table to a genuine transformer. It knows phrase-level meaning (search≈hunt,
//! "roll back a version"≈git) that the feature-hash and even GloVe averaging miss.
//!
//! Weights are generated ONCE at build time by libcontract/gen-bge-embed.py (per-row
//! int8 dynamic quant; the numpy reference forward this mirrors routes 88.9% on the
//! router benchmark — see bge_ref.bin for the golden CLS vectors this file matches).
//!
//! Storage: int8 weights dequantize as w[o,i] = q[o,i]·scale[o]; activations stay f32
//! (LayerNorm, GELU, softmax in f32). The matmul folds the per-row scale ONCE:
//! y[o] = scale[o]·Σ_i x[i]·q[o,i] + b[o] — exact to the numpy reference, no int8 matmul.

const std = @import("std");

pub const DIM: usize = 384; // CLS embedding dimension (== hidden size)
const H: usize = 384;
const NLAYER: usize = 12;
const HEADS: usize = 12;
const DH: usize = H / HEADS; // 32
const INTER: usize = 1536;
const EPS: f32 = 1e-12;
const CLS_ID: u32 = 101;
const SEP_ID: u32 = 102;
const UNK_ID: u32 = 100;
const MAX_TOK: usize = 64; // truncation (matches the generator's max_length)

const weights_blob = @embedFile("bge_weights.bin");
const vocab_blob = @embedFile("bge_vocab.txt");

// ── unaligned little-endian readers (the blob is not 4-byte aligned) ──
inline fn f32At(data: []const u8, idx: usize) f32 {
    return @bitCast(std.mem.readInt(u32, data[idx * 4 ..][0..4], .little));
}
inline fn i8At(data: []const u8, idx: usize) f32 {
    return @floatFromInt(@as(i8, @bitCast(data[idx])));
}

const Tensor = struct { dtype: u8, data: []const u8 }; // dtype 0=i8, 1=f32

// ── lazily-initialized, process-lifetime model (maps key into the embedded blobs) ──
var g_state: u8 = 0; // 0 empty · 1 initializing · 2 ready
var g_tensors: std.StringHashMap(Tensor) = undefined;
var g_vocab: std.StringHashMap(u32) = undefined;
var g_arena: std.heap.ArenaAllocator = undefined;

fn parse() !void {
    g_arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    const a = g_arena.allocator();

    // tensor table
    g_tensors = std.StringHashMap(Tensor).init(a);
    if (!std.mem.eql(u8, weights_blob[0..4], "BGEW")) return error.BadBlob;
    const n = std.mem.readInt(u32, weights_blob[8..12], .little);
    var off: usize = 12;
    for (0..n) |_| {
        const nl = std.mem.readInt(u16, weights_blob[off..][0..2], .little);
        off += 2;
        const tname = weights_blob[off .. off + nl];
        off += nl;
        const dtype = weights_blob[off];
        const ndim = weights_blob[off + 1];
        off += 2;
        var count: usize = 1;
        for (0..ndim) |d| {
            count *= std.mem.readInt(u32, weights_blob[off + d * 4 ..][0..4], .little);
        }
        off += ndim * 4;
        const bytes = count * (if (dtype == 0) @as(usize, 1) else 4);
        try g_tensors.put(tname, .{ .dtype = dtype, .data = weights_blob[off .. off + bytes] });
        off += bytes;
    }

    // vocab: line index == token id (keys slice into the embedded file)
    g_vocab = std.StringHashMap(u32).init(a);
    var it = std.mem.splitScalar(u8, vocab_blob, '\n');
    var id: u32 = 0;
    while (it.next()) |line| : (id += 1) {
        if (line.len == 0 and it.peek() == null) break; // trailing newline
        try g_vocab.put(line, id);
    }
}

fn ensureReady() void {
    if (@atomicLoad(u8, &g_state, .acquire) == 2) return;
    // Claim the init exactly once; late callers spin until the winner marks ready.
    if (@cmpxchgStrong(u8, &g_state, 0, 1, .acq_rel, .acquire) == null) {
        parse() catch |e| std.debug.panic("bge: model blob parse failed: {}", .{e});
        @atomicStore(u8, &g_state, 2, .release);
        return;
    }
    while (@atomicLoad(u8, &g_state, .acquire) != 2) std.atomic.spinLoopHint();
}

inline fn tref(key: []const u8) []const u8 {
    return (g_tensors.get(key) orelse std.debug.panic("bge: missing tensor {s}", .{key})).data;
}

// ── WordPiece tokenizer (BERT uncased): [CLS] + pieces + [SEP], truncated ──
fn isPunct(c: u8) bool {
    return (c >= 33 and c <= 47) or (c >= 58 and c <= 64) or (c >= 91 and c <= 96) or (c >= 123 and c <= 126);
}
fn isSpace(c: u8) bool {
    return c == ' ' or c == '\t' or c == '\n' or c == '\r' or c == 0x0b or c == 0x0c;
}

/// Tokenize `text` into ids (writes into `out`, returns the count incl. CLS/SEP).
fn tokenize(text: []const u8, out: []u32) usize {
    ensureReady(); // vocab lookup needs the model parsed (safe if called standalone)
    var nid: usize = 0;
    out[nid] = CLS_ID;
    nid += 1;

    var i: usize = 0;
    var word: [128]u8 = undefined;
    while (i < text.len and nid + 1 < MAX_TOK) {
        // skip whitespace
        if (isSpace(text[i])) {
            i += 1;
            continue;
        }
        // gather one basic token: a run of non-space, non-punct chars; OR a single punct
        var wl: usize = 0;
        if (isPunct(text[i])) {
            word[0] = text[i];
            wl = 1;
            i += 1;
        } else {
            while (i < text.len and !isSpace(text[i]) and !isPunct(text[i]) and wl < word.len) : (i += 1) {
                word[wl] = std.ascii.toLower(text[i]);
                wl += 1;
            }
        }
        // WordPiece the basic token, greedy longest-match with "##" continuation
        nid += wordpiece(word[0..wl], out[nid..]);
    }
    if (nid < MAX_TOK) {
        out[nid] = SEP_ID;
        nid += 1;
    } else {
        out[MAX_TOK - 1] = SEP_ID; // hard truncate keeps a closing [SEP]
        nid = MAX_TOK;
    }
    return nid;
}

/// Greedy WordPiece of a single basic token; writes ids to `out`, returns count.
fn wordpiece(w: []const u8, out: []u32) usize {
    if (w.len == 0) return 0;
    if (w.len > 100) {
        out[0] = UNK_ID;
        return 1;
    }
    var buf: [130]u8 = undefined;
    var n: usize = 0;
    var start: usize = 0;
    while (start < w.len) {
        var end = w.len;
        var found: ?u32 = null;
        while (end > start) : (end -= 1) {
            var sub: []const u8 = undefined;
            if (start == 0) {
                sub = w[start..end];
            } else {
                buf[0] = '#';
                buf[1] = '#';
                @memcpy(buf[2 .. 2 + (end - start)], w[start..end]);
                sub = buf[0 .. 2 + (end - start)];
            }
            if (g_vocab.get(sub)) |vid| {
                found = vid;
                break;
            }
        }
        if (found) |vid| {
            out[n] = vid;
            n += 1;
            start = end;
        } else {
            out[0] = UNK_ID; // any un-piece-able span → whole token is [UNK]
            return 1;
        }
        if (n >= out.len) break;
    }
    return n;
}

// ── math ──
fn erf(x: f32) f32 {
    // Abramowitz-Stegun 7.1.26 — SAME approximation as gen-bge-embed.py (numerics match)
    const s: f32 = if (x < 0) -1 else 1;
    const ax = @abs(x);
    const t = 1.0 / (1.0 + 0.3275911 * ax);
    const y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * @exp(-ax * ax);
    return s * y;
}
inline fn gelu(x: f32) f32 {
    return 0.5 * x * (1.0 + erf(x * 0.7071067811865476));
}
/// In-place row-wise LayerNorm over the last dim (H) of `x` [T*H], with gamma/beta.
fn layerNorm(x: []f32, T: usize, g: []const u8, b: []const u8) void {
    for (0..T) |ti| {
        const row = x[ti * H .. ti * H + H];
        var mean: f32 = 0;
        for (row) |v| mean += v;
        mean /= @floatFromInt(H);
        var variance: f32 = 0;
        for (row) |v| variance += (v - mean) * (v - mean);
        variance /= @floatFromInt(H);
        const inv = 1.0 / @sqrt(variance + EPS);
        for (row, 0..) |*v, d| v.* = (v.* - mean) * inv * f32At(g, d) + f32At(b, d);
    }
}

/// y[t,o] = scale[o]·Σ_i x[t,i]·q[o,i] + bias[o]   (per-row int8 dequant, folded).
/// `wbase` names the int8 weight (e.g. "L3.q.w"); its scale is "<wbase>.s" and its
/// bias strips the ".w" → "<base>.b".
fn linear(x: []const f32, T: usize, in: usize, out: usize, y: []f32, wbase: []const u8) void {
    var nb: [64]u8 = undefined;
    const w = tref(wbase); // i8 [out,in]
    const s = tref(std.fmt.bufPrint(&nb, "{s}.s", .{wbase}) catch unreachable);
    const bb = tref(std.fmt.bufPrint(&nb, "{s}.b", .{wbase[0 .. wbase.len - 2]}) catch unreachable);
    for (0..T) |ti| {
        const xr = x[ti * in .. ti * in + in];
        for (0..out) |o| {
            var acc: f32 = 0;
            const wr = w[o * in .. o * in + in];
            for (0..in) |ii| acc += xr[ii] * i8At(wr, ii);
            y[ti * out + o] = acc * f32At(s, o) + f32At(bb, o);
        }
    }
}

/// Embed `text` into `out` (len == DIM), CLS-pooled + L2-normalized. Never fails:
/// empty/whitespace/unembeddable text → the zero vector (no NaN), so callers can
/// treat the output as always-valid.
pub fn embed(text: []const u8, out: []f32) void {
    std.debug.assert(out.len == DIM);
    ensureReady();
    @memset(out, 0);

    var ids: [MAX_TOK]u32 = undefined;
    const T = tokenize(text, &ids);
    if (T <= 2) return; // only [CLS][SEP] → nothing to embed

    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const al = arena.allocator();

    var nb: [64]u8 = undefined; // per-tensor name builder (tref returns blob slices, so reuse is safe)
    const E = al.alloc(f32, T * H) catch return;
    // embeddings: word (int8 dequant) + position + token_type[0]
    const wq = tref("emb.word");
    const ws = tref("emb.word.s");
    const pos = tref("emb.pos");
    const typ = tref("emb.type");
    for (0..T) |ti| {
        const id = ids[ti];
        const sc = f32At(ws, id);
        for (0..H) |d| {
            E[ti * H + d] = i8At(wq, id * H + d) * sc + f32At(pos, ti * H + d) + f32At(typ, d);
        }
    }
    layerNorm(E, T, tref("emb.ln.g"), tref("emb.ln.b"));

    const Q = al.alloc(f32, T * H) catch return;
    const K = al.alloc(f32, T * H) catch return;
    const V = al.alloc(f32, T * H) catch return;
    const ctx = al.alloc(f32, T * H) catch return;
    const attn = al.alloc(f32, T * H) catch return;
    const inter = al.alloc(f32, T * INTER) catch return;
    const ffn = al.alloc(f32, T * H) catch return;
    const scores = al.alloc(f32, T) catch return;

    for (0..NLAYER) |l| {
        linear(E, T, H, H, Q, layerName(&nb, l, "q.w"));
        linear(E, T, H, H, K, layerName(&nb, l, "k.w"));
        linear(E, T, H, H, V, layerName(&nb, l, "v.w"));
        // scaled dot-product attention, per head
        const inv_sqrt: f32 = 1.0 / @sqrt(@as(f32, DH));
        for (0..HEADS) |h| {
            const base = h * DH;
            for (0..T) |qi| {
                var maxs: f32 = -std.math.inf(f32);
                for (0..T) |ki| {
                    var dot: f32 = 0;
                    for (0..DH) |d| dot += Q[qi * H + base + d] * K[ki * H + base + d];
                    dot *= inv_sqrt;
                    scores[ki] = dot;
                    if (dot > maxs) maxs = dot;
                }
                var sum: f32 = 0;
                for (0..T) |ki| {
                    scores[ki] = @exp(scores[ki] - maxs);
                    sum += scores[ki];
                }
                for (0..DH) |d| {
                    var acc: f32 = 0;
                    for (0..T) |ki| acc += scores[ki] * V[ki * H + base + d];
                    ctx[qi * H + base + d] = acc / sum;
                }
            }
        }
        linear(ctx, T, H, H, attn, layerName(&nb, l, "ao.w"));
        for (0..T * H) |k| attn[k] += E[k]; // residual
        layerNorm(attn, T, tref(layerName(&nb, l, "attnln.g")), tref(layerName(&nb, l, "attnln.b")));
        // FFN
        linear(attn, T, H, INTER, inter, layerName(&nb, l, "inter.w"));
        for (0..T * INTER) |k| inter[k] = gelu(inter[k]);
        linear(inter, T, INTER, H, ffn, layerName(&nb, l, "out.w"));
        for (0..T * H) |k| ffn[k] += attn[k]; // residual
        layerNorm(ffn, T, tref(layerName(&nb, l, "outln.g")), tref(layerName(&nb, l, "outln.b")));
        @memcpy(E, ffn);
    }

    // CLS pool + L2 normalize
    var norm: f32 = 0;
    for (0..H) |d| {
        out[d] = E[d];
        norm += E[d] * E[d];
    }
    norm = @sqrt(norm);
    if (norm > 0) for (out) |*v| {
        v.* /= norm;
    };
}

fn layerName(buf: []u8, layer: usize, suffix: []const u8) []const u8 {
    return std.fmt.bufPrint(buf, "L{d}.{s}", .{ layer, suffix }) catch unreachable;
}

/// Cosine similarity (both args are L2-unit from `embed`).
pub fn cosine(a: []const f32, b: []const f32) f32 {
    var dot: f32 = 0;
    for (a, b) |x, y| dot += x * y;
    return dot;
}

// ── runnable witnesses (the gate: `zig test src/bge.zig`) ──────────────────────
//
// bge_ref.bin (written by gen-bge-embed.py): u32 n_probes, then per probe
// u16 n_ids · u32 ids[n_ids] · f32 cls[DIM]. The probe TEXTS are known (the
// generator's `probes` list), so the test re-derives ids + embedding and asserts
// BOTH the tokenizer and the forward pass match the numpy golden reference.
const ref_blob = @embedFile("bge_ref.bin");
const probe_texts = [_][]const u8{
    "hunt for a phrase across the whole tree",
    "commit my changes to the repository",
    "search",
};
inline fn readU32(data: []const u8, off: usize) u32 {
    return std.mem.readInt(u32, data[off..][0..4], .little);
}

test "bge: tokenizer + forward match the numpy golden reference (bge_ref.bin)" {
    var off: usize = 4; // skip n_probes
    for (probe_texts) |p| {
        const nids = std.mem.readInt(u16, ref_blob[off..][0..2], .little);
        off += 2;
        var ref_ids: [MAX_TOK]u32 = undefined;
        for (0..nids) |k| {
            ref_ids[k] = readU32(ref_blob, off);
            off += 4;
        }
        var ref_cls: [DIM]f32 = undefined;
        for (0..DIM) |d| {
            ref_cls[d] = @bitCast(readU32(ref_blob, off));
            off += 4;
        }
        // (a) the Zig WordPiece tokenizer reproduces the HF ids exactly
        var mine: [MAX_TOK]u32 = undefined;
        const t = tokenize(p, &mine);
        try std.testing.expectEqual(@as(usize, nids), t);
        for (0..nids) |k| try std.testing.expectEqual(ref_ids[k], mine[k]);
        // (b) the pure-Zig forward pass matches the numpy CLS vector (cosine ~1)
        var out: [DIM]f32 = undefined;
        embed(p, &out);
        try std.testing.expect(cosine(&out, &ref_cls) > 0.999);
    }
}

test "bge: knows phrase-level synonymy (search≈hunt, not≈commit)" {
    var s: [DIM]f32 = undefined;
    var h: [DIM]f32 = undefined;
    var c: [DIM]f32 = undefined;
    embed("search the files for a keyword", &s);
    embed("hunt for a phrase across the tree", &h);
    embed("commit my changes to the repo", &c);
    try std.testing.expect(cosine(&s, &h) > cosine(&s, &c));
    // empty text → zero vector (no NaN)
    var e: [DIM]f32 = undefined;
    embed("", &e);
    for (e) |x| try std.testing.expectEqual(@as(f32, 0), x);
}
