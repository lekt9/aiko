//! route.zig — the LEARNED energy router, ONE implementation shared by the CLI
//! (`contract recommend`), the C ABI (`contract_recommend`, so aiko-cli can call
//! it via FFI), and any future caller. One verb: recommend().
//!
//! It trains a per-binary energy prototype straight from the ledger — the ledger
//! IS the weights (like energyRankCandidates): every SATISFIED contract folds its
//! GOAL into the prototype of the binary its action named (+1, Hebbian); every
//! DIED one inhibits it (−1). recommend() then returns the argmin-energy binary
//! for a new goal — the binary whose past successes sit closest to it,
//! generalizing to goals never seen — PLUS the nearest proven command for it (the
//! self-documented usage exemplar). No LLM. Cold (nothing learned) → null
//! (honest refusal, never a fabricated route).

const std = @import("std");
const ledger = @import("ledger.zig");
const terminal = @import("terminal.zig");
const embed = @import("embed.zig");
const bge = @import("bge.zig");

// The router embeds with the baked BERT (bge-small, bge.zig) — a real learned
// sentence embedder that knows phrase-level meaning ("roll back a version"≈git,
// search≈hunt), well past GloVe averaging. A per-binary reward-weighted centroid over
// goal vectors (West 1979, like ebm.Prototype); energy = −cosine; routing = argmin.
//
// PURE LEDGER — no hardcoded lexicon, no cold-start seed. A binary becomes a routable
// candidate ONLY once a real fire (a satisfied contract naming it) folds a goal into
// its prototype; the ledger is the sole source of meaning, so the router flexes to
// whatever tools are actually used. A goal for a never-used binary gets no hint
// (honest refusal, null), not a fabricated route from a typed description.
const SEM = bge.DIM;

const SemProto = struct {
    mean: [SEM]f32 = [_]f32{0} ** SEM,
    w: f64 = 0, // reward-weight folded in

    /// Fold a PRE-EMBEDDED goal vector (West 1979 reward-weighted mean) — the caller
    /// embeds the goal once and reuses it (both for the centroid and exemplar lookup).
    fn foldVec(self: *SemProto, v: []const f32, reward: f64) void {
        const w_new = self.w + reward;
        if (@abs(w_new) < 1e-9) {
            self.mean = [_]f32{0} ** SEM;
            self.w = 0;
            return;
        }
        const a: f32 = @floatCast(reward / w_new);
        for (&self.mean, 0..) |*m, i| m.* += a * (v[i] - m.*);
        self.w = w_new;
    }

    fn energyVec(self: SemProto, v: []const f32) f64 {
        if (self.w <= 0) return std.math.inf(f64);
        return -@as(f64, embed.cosine(v, &self.mean));
    }
};

/// Extract a JSON string field's value (a slice INTO `line`), or null. Handles both
/// `"key": "v"` and `"key":"v"`; skips backslash-escapes crudely (enough for plans).
fn field(line: []const u8, key: []const u8) ?[]const u8 {
    var kbuf: [64]u8 = undefined;
    const needle = std.fmt.bufPrint(&kbuf, "\"{s}\"", .{key}) catch return null;
    const k = std.mem.indexOf(u8, line, needle) orelse return null;
    var i = k + needle.len;
    while (i < line.len and (line[i] == ':' or line[i] == ' ')) i += 1;
    if (i >= line.len or line[i] != '"') return null;
    i += 1;
    const start = i;
    while (i < line.len and line[i] != '"') : (i += 1) {
        if (line[i] == '\\' and i + 1 < line.len) i += 1;
    }
    if (i > line.len) return null;
    return line[start..i];
}

const Decl = struct { plan: []const u8, action: []const u8 };

// ────────── semantic KV cache + recency bound ──────────
//
// Embedding is the router's only expensive step: bge.embed on every terminal
// row's plan made recommend() O(history × BERT-forward) — measured minutes on
// a 1k-terminal store (2026-07-18), which silently breaks every caller that
// treats recommend as interactive. Two mechanical fixes, no semantics change:
//
//  1. RECENT_CANDIDATES — only the newest K terminal rows feed the centroids.
//     Old fires age out of routing influence (they stay in the ledger).
//  2. A persistent plan→vector cache beside the store (`<ledger>.embcache`):
//     fixed 1544-byte records of wyhash64(plan) ‖ f32[SEM]. Each call embeds
//     only unseen plans and appends them, so the steady state is ONE query
//     embed per call. Local file, local floats — no portability contract.

pub const RECENT_CANDIDATES: usize = 512;
/// Cold-cache warmup budget: at most this many NEW embeds per call. Rows
/// without a cached vector yet simply sit out this call's centroids and get
/// picked up by a later one — every call is interactive, warmup converges
/// across calls instead of hanging the first caller for minutes. Sized to
/// the measured ReleaseFast bge forward (~0.6 s each): 16 ≈ a 10 s worst
/// case on an interactive path; the resolver tick warms in bigger strides.
pub const MAX_NEW_EMBEDS_PER_CALL: usize = 16;

/// A sealed payload (legacy encrypted plan/action bytes) is base64 noise to
/// the embedder and ciphertext garbage as a returned example — never a
/// routing candidate. Same cheap shape test as the display-side unsealer.
/// Substrate-internal action classes are the router's own exhaust — folding
/// them teaches the router to recommend its own plumbing ("turn", sabbath
/// heartbeats) over real commands. Observed 2026-07-18: "turn" anchor rows
/// outnumbered every real binary and won every query.
fn isInternalBin(bin: []const u8) bool {
    const internal = [_][]const u8{ "claim", "neuron", "turn", "tool", "sabbath", "word", "guard", "drill", "goal" };
    for (internal) |x| if (std.mem.eql(u8, bin, x)) return true;
    // Typed-pointer prefixes ("word:where", "tool:read_file") arrive with the
    // colon attached to the first token — same exhaust, same exclusion.
    if (std.mem.indexOfScalar(u8, bin, ':') != null) return true;
    return false;
}

fn looksSealed(s: []const u8) bool {
    if (s.len < 56) return false;
    for (s) |ch| {
        if (!(std.ascii.isAlphanumeric(ch) or ch == '+' or ch == '/' or ch == '=')) return false;
    }
    return true;
}
const CACHE_REC: usize = 8 + SEM * 4;
const libc = std.c;

fn cachePath(allocator: std.mem.Allocator, env: std.process.Environ) ![]u8 {
    const lp = try ledger.resolvePath(allocator, env);
    defer allocator.free(lp);
    return try std.fmt.allocPrint(allocator, "{s}.embcache", .{lp});
}

fn loadEmbCache(allocator: std.mem.Allocator, map: *std.AutoHashMap(u64, [SEM]f32), path: []const u8) void {
    const path_z = allocator.dupeZ(u8, path) catch return;
    defer allocator.free(path_z);
    var flags: libc.O = .{};
    flags.ACCMODE = .RDONLY;
    const fd: c_int = libc.open(path_z.ptr, flags, @as(c_uint, 0));
    if (fd < 0) return;
    defer _ = libc.close(fd);
    var data: std.ArrayList(u8) = .empty;
    defer data.deinit(allocator);
    var chunk: [65536]u8 = undefined;
    while (true) {
        const n = libc.read(fd, &chunk, chunk.len);
        if (n <= 0) break;
        data.appendSlice(allocator, chunk[0..@intCast(n)]) catch return;
    }
    var off: usize = 0;
    while (off + CACHE_REC <= data.items.len) : (off += CACHE_REC) {
        const h = std.mem.bytesToValue(u64, data.items[off..][0..8]);
        var vec: [SEM]f32 = undefined;
        @memcpy(std.mem.sliceAsBytes(vec[0..]), data.items[off + 8 ..][0 .. SEM * 4]);
        map.put(h, vec) catch return;
    }
}

fn appendEmbCache(allocator: std.mem.Allocator, path: []const u8, recs: []const u8) void {
    if (recs.len == 0) return;
    const path_z = allocator.dupeZ(u8, path) catch return;
    defer allocator.free(path_z);
    var flags: libc.O = .{};
    flags.ACCMODE = .WRONLY;
    flags.CREAT = true;
    flags.APPEND = true;
    const fd: c_int = libc.open(path_z.ptr, flags, @as(c_uint, 0o644));
    if (fd < 0) return;
    defer _ = libc.close(fd);
    var off: usize = 0;
    while (off < recs.len) {
        const n = libc.write(fd, recs.ptr + off, recs.len - off);
        if (n <= 0) return;
        off += @intCast(n);
    }
}

/// Cached embed: look the plan up by wyhash64, embed only on miss, and stage
/// the new record into `new_recs` for one append at the end of the call.
/// Returns false when the plan has no cached vector and the per-call embed
/// budget is spent — the caller must skip that row for this call.
fn embedCached(
    allocator: std.mem.Allocator,
    map: *std.AutoHashMap(u64, [SEM]f32),
    new_recs: *std.ArrayList(u8),
    budget: *usize,
    text: []const u8,
    out_vec: *[SEM]f32,
) bool {
    const h = std.hash.Wyhash.hash(0, text);
    if (map.get(h)) |v| {
        out_vec.* = v;
        return true;
    }
    if (budget.* == 0) return false;
    budget.* -= 1;
    bge.embed(text, out_vec);
    map.put(h, out_vec.*) catch {};
    new_recs.appendSlice(allocator, std.mem.asBytes(&h)) catch return true;
    new_recs.appendSlice(allocator, std.mem.sliceAsBytes(out_vec[0..])) catch return true;
    return true;
}

/// A satisfied row's proven usage: which binary, the exact action that satisfied, and
/// the goal embedding (so the nearest proven command to a new goal can be retrieved).
const Usage = struct { bin: []const u8, action: []const u8, vec: [SEM]f32 };

/// Append `s` as a JSON string body (escaping " and \) to `buf`.
fn appendJsonStr(buf: *std.ArrayList(u8), allocator: std.mem.Allocator, s: []const u8) !void {
    for (s) |c| switch (c) {
        '"' => try buf.appendSlice(allocator, "\\\""),
        '\\' => try buf.appendSlice(allocator, "\\\\"),
        '\n' => try buf.appendSlice(allocator, "\\n"),
        else => try buf.append(allocator, c),
    };
}

/// Recommend a tool for `context` AND the nearest PROVEN command for it — the router
/// self-documents usage: selection is the centroid argmin (as `route`), then the
/// exemplar is the single satisfied row of that binary whose goal sits closest to the
/// new one. Returns JSON {"binary":..,"example":..,"score":..} or null (nothing learned).
/// Caller owns the slice.
pub fn recommend(allocator: std.mem.Allocator, env: std.process.Environ, context: []const u8) !?[]u8 {
    const data = try ledger.readAll(allocator, env);
    defer allocator.free(data);

    var declared = std.StringHashMap(Decl).init(allocator);
    defer declared.deinit();
    var it = std.mem.splitScalar(u8, data, '\n');
    while (it.next()) |line| {
        if (line.len == 0 or std.mem.indexOf(u8, line, "\"declared\"") == null) continue;
        const id = field(line, "id") orelse continue;
        const plan = field(line, "plan") orelse continue;
        try declared.put(id, .{ .plan = plan, .action = field(line, "action") orelse "" });
    }

    // Collect candidates cheaply first (no embedding), then bound to the
    // newest RECENT_CANDIDATES before paying for any BERT forward pass.
    const Cand = struct { bin: []const u8, plan: []const u8, action: []const u8, reward: f64 };
    var cands: std.ArrayList(Cand) = .empty;
    defer cands.deinit(allocator);
    var seen = std.StringHashMap(void).init(allocator);
    defer seen.deinit();
    it = std.mem.splitScalar(u8, data, '\n');
    while (it.next()) |line| {
        if (line.len == 0) continue;
        const ev = field(line, "event") orelse continue;
        const reward: f64 = switch (terminal.classify(ev)) {
            .satisfied => 1.0,
            .dead => -1.0,
            else => continue,
        };
        const id = field(line, "id") orelse continue;
        if (seen.contains(id)) continue;
        try seen.put(id, {});
        const d = declared.get(id) orelse continue;
        const end = std.mem.indexOfScalar(u8, d.action, ' ') orelse d.action.len;
        const bin = d.action[0..end];
        if (bin.len == 0 or isInternalBin(bin)) continue;
        // A proven command worth returning is a full command line, not a
        // bare classifier token — require arguments after the binary name.
        if (d.action.len == bin.len) continue;
        if (looksSealed(d.plan) or looksSealed(bin)) continue;
        try cands.append(allocator, .{ .bin = bin, .plan = d.plan, .action = d.action, .reward = reward });
    }
    const recent = cands.items[cands.items.len -| RECENT_CANDIDATES..];

    var emb_cache = std.AutoHashMap(u64, [SEM]f32).init(allocator);
    defer emb_cache.deinit();
    const cpath = try cachePath(allocator, env);
    defer allocator.free(cpath);
    loadEmbCache(allocator, &emb_cache, cpath);
    var new_recs: std.ArrayList(u8) = .empty;
    defer new_recs.deinit(allocator);

    var protos = std.StringHashMap(SemProto).init(allocator);
    defer protos.deinit();
    var usages: std.ArrayList(Usage) = .empty;
    defer usages.deinit(allocator);
    var embed_budget: usize = MAX_NEW_EMBEDS_PER_CALL;
    for (recent) |cand| {
        var v: [SEM]f32 = undefined;
        if (!embedCached(allocator, &emb_cache, &new_recs, &embed_budget, cand.plan, &v)) continue;
        const gop = try protos.getOrPut(cand.bin);
        if (!gop.found_existing) gop.value_ptr.* = .{};
        gop.value_ptr.foldVec(&v, cand.reward);
        if (cand.reward > 0) try usages.append(allocator, .{ .bin = cand.bin, .action = cand.action, .vec = v });
    }
    appendEmbCache(allocator, cpath, new_recs.items);

    // Selection: argmin energy over centroids (same as route). Embed the query once.
    var qv: [SEM]f32 = undefined;
    bge.embed(context, &qv);
    var best_bin: ?[]const u8 = null;
    var best_e: f64 = std.math.inf(f64);
    var pit = protos.iterator();
    while (pit.next()) |e| {
        const en = e.value_ptr.energyVec(&qv);
        if (en < best_e) {
            best_e = en;
            best_bin = e.key_ptr.*;
        }
    }
    const b = best_bin orelse return null;

    // Exemplar: the satisfied row of `b` whose goal is nearest the new goal.
    var ex_action: ?[]const u8 = null;
    var ex_c: f32 = -2;
    for (usages.items) |u| {
        if (!std.mem.eql(u8, u.bin, b)) continue;
        const c = embed.cosine(&qv, &u.vec);
        if (c > ex_c) {
            ex_c = c;
            ex_action = u.action;
        }
    }

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.appendSlice(allocator, "{\"binary\":\"");
    try appendJsonStr(&out, allocator, b);
    try out.appendSlice(allocator, "\",\"example\":\"");
    if (ex_action) |a| try appendJsonStr(&out, allocator, a);
    try out.appendSlice(allocator, "\",\"score\":");
    var scorebuf: [16]u8 = undefined;
    try out.appendSlice(allocator, try std.fmt.bufPrint(&scorebuf, "{d:.3}", .{ex_c}));
    try out.append(allocator, '}');
    return try out.toOwnedSlice(allocator);
}

test "recommend: the JSON field parser (the ledger-row glue)" {
    // The per-binary routing is proven in ebm.zig + route_bench.zig; here we only
    // assert the field parser recommend() relies on to read declared/terminal rows.
    const line = "{\"event\": \"declared\", \"id\": \"abc\", \"plan\": \"commit my changes\", \"action\": \"git commit\"}";
    try std.testing.expectEqualStrings("abc", field(line, "id").?);
    try std.testing.expectEqualStrings("commit my changes", field(line, "plan").?);
    try std.testing.expectEqualStrings("git commit", field(line, "action").?);
    try std.testing.expect(field(line, "missing") == null);
}

test "recommend: JSON string escaping keeps the example well-formed" {
    const A = std.testing.allocator;
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(A);
    try appendJsonStr(&buf, A, "grep -rn \"foo\\bar\" src/");
    try std.testing.expectEqualStrings("grep -rn \\\"foo\\\\bar\\\" src/", buf.items);
}
