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
const ebm = @import("ebm.zig");

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

const SemProto = ebm.PrototypeFor(SEM);

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

fn numberField(line: []const u8, key: []const u8) ?f64 {
    var kbuf: [64]u8 = undefined;
    const needle = std.fmt.bufPrint(&kbuf, "\"{s}\"", .{key}) catch return null;
    const key_index = std.mem.indexOf(u8, line, needle) orelse return null;
    var index = key_index + needle.len;
    while (index < line.len and (line[index] == ':' or line[index] == ' ')) index += 1;
    const start = index;
    while (index < line.len and (std.ascii.isDigit(line[index]) or line[index] == '.' or line[index] == '-')) index += 1;
    if (index == start) return null;
    return std.fmt.parseFloat(f64, line[start..index]) catch null;
}

fn numberOrStringField(line: []const u8, key: []const u8) ?f64 {
    return numberField(line, key) orelse if (field(line, key)) |value|
        std.fmt.parseFloat(f64, value) catch null
    else
        null;
}

const Decl = struct { plan: []const u8, action: []const u8, duration_ms: ?f64 };

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
    // Version-qualified FECH capability keys intentionally contain provider
    // colons (for example `mcp:github.issues.list@1`). The `@version` suffix
    // distinguishes them from substrate pointer prefixes such as
    // `word:where`, which remain internal exhaust.
    if (std.mem.indexOfScalar(u8, bin, ':') != null and
        std.mem.indexOfScalar(u8, bin, '@') == null) return true;
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
        try declared.put(id, .{
            .plan = plan,
            .action = field(line, "action") orelse "",
            .duration_ms = numberOrStringField(line, "duration_ms"),
        });
    }

    // Collect candidates cheaply first (no embedding), then bound to the
    // newest RECENT_CANDIDATES before paying for any BERT forward pass.
    const Cand = struct {
        bin: []const u8,
        plan: []const u8,
        action: []const u8,
        reward: f64,
        observed_at: []const u8,
        duration_ms: ?f64,
    };
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
        try cands.append(allocator, .{
            .bin = bin,
            .plan = d.plan,
            .action = d.action,
            .reward = reward,
            .observed_at = field(line, "ts") orelse "",
            .duration_ms = d.duration_ms,
        });
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
        gop.value_ptr.fold(&v, cand.reward);
        if (cand.reward > 0) try usages.append(allocator, .{ .bin = cand.bin, .action = cand.action, .vec = v });
    }
    // Selection: argmin energy over centroids (same as route). Embed the query once.
    if (protos.count() == 0) {
        appendEmbCache(allocator, cpath, new_recs.items);
        return null;
    }
    var qv: [SEM]f32 = undefined;
    var query_budget: usize = 1;
    _ = embedCached(
        allocator,
        &emb_cache,
        &new_recs,
        &query_budget,
        context,
        &qv,
    );
    appendEmbCache(allocator, cpath, new_recs.items);
    var best_bin: ?[]const u8 = null;
    var best_e: f64 = std.math.inf(f64);
    var pit = protos.iterator();
    while (pit.next()) |e| {
        const en = e.value_ptr.energy(&qv);
        if (en < best_e) {
            best_e = en;
            best_bin = e.key_ptr.*;
        }
    }
    const b = best_bin orelse return null;
    var latest_observed_at: []const u8 = "";
    var latest_duration_ms: ?f64 = null;
    var latest_reward: f64 = 0;
    var events_ago: usize = recent.len;
    var reverse_index: usize = recent.len;
    while (reverse_index > 0) {
        reverse_index -= 1;
        const candidate = recent[reverse_index];
        if (std.mem.eql(u8, candidate.bin, b)) {
            latest_observed_at = candidate.observed_at;
            latest_duration_ms = candidate.duration_ms;
            latest_reward = candidate.reward;
            events_ago = recent.len - 1 - reverse_index;
            break;
        }
    }
    // Freshness is ledger-relative, not wall-clock guesswork: a capability is
    // fresh while it has an outcome in the newest quarter of the bounded
    // routing window. Old evidence remains usable but is explicitly stale.
    const freshness = if (events_ago < RECENT_CANDIDATES / 4) "fresh" else "stale";

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
    // A fresh terminal failure is an inhibition, even when an older success
    // remains the nearest usage exemplar for semantic training.
    if (latest_reward > 0) {
        if (ex_action) |a| try appendJsonStr(&out, allocator, a);
    }
    try out.appendSlice(allocator, "\",\"score\":");
    var scorebuf: [16]u8 = undefined;
    try out.appendSlice(allocator, try std.fmt.bufPrint(&scorebuf, "{d:.3}", .{ex_c}));
    try out.appendSlice(allocator, ",\"freshness\":\"");
    try out.appendSlice(allocator, freshness);
    try out.appendSlice(allocator, "\",\"observed_at\":\"");
    try appendJsonStr(&out, allocator, latest_observed_at);
    try out.appendSlice(allocator, "\",\"events_ago\":");
    var recencybuf: [24]u8 = undefined;
    try out.appendSlice(allocator, try std.fmt.bufPrint(&recencybuf, "{d}", .{events_ago}));
    try out.appendSlice(allocator, ",\"duration_ms\":");
    if (latest_duration_ms) |duration| {
        var duration_buf: [32]u8 = undefined;
        try out.appendSlice(allocator, try std.fmt.bufPrint(&duration_buf, "{d:.0}", .{duration}));
    } else {
        try out.appendSlice(allocator, "null");
    }
    try out.append(allocator, '}');
    return try out.toOwnedSlice(allocator);
}

/// Reconstruct the latest exact-version FECH outcome for every capability
/// directly from the canonical ledger. This is deterministic evidence input
/// for the dynamic registry after process restart; no second store exists.
pub fn latestCapabilityEvidenceJson(allocator: std.mem.Allocator, env: std.process.Environ) ![]u8 {
    const data = try ledger.readAll(allocator, env);
    defer allocator.free(data);
    var declared = std.StringHashMap(Decl).init(allocator);
    defer declared.deinit();
    var lines = std.mem.splitScalar(u8, data, '\n');
    while (lines.next()) |line| {
        if (line.len == 0 or std.mem.indexOf(u8, line, "\"declared\"") == null) continue;
        const id = field(line, "id") orelse continue;
        try declared.put(id, .{
            .plan = field(line, "plan") orelse "",
            .action = field(line, "action") orelse "",
            .duration_ms = numberOrStringField(line, "duration_ms"),
        });
    }
    const Latest = struct {
        action: []const u8,
        success: bool,
        observed_at: []const u8,
        duration_ms: ?f64,
        terminal_index: usize,
    };
    var latest = std.StringHashMap(Latest).init(allocator);
    defer latest.deinit();
    var terminal_count: usize = 0;
    lines = std.mem.splitScalar(u8, data, '\n');
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        const event = field(line, "event") orelse continue;
        const class = terminal.classify(event);
        if (class != .satisfied and class != .dead) continue;
        const id = field(line, "id") orelse continue;
        const declaration = declared.get(id) orelse continue;
        const end = std.mem.indexOfScalar(u8, declaration.action, ' ') orelse declaration.action.len;
        const bin = declaration.action[0..end];
        if (bin.len == 0 or std.mem.indexOfScalar(u8, bin, '@') == null or isInternalBin(bin)) continue;
        try latest.put(bin, .{
            .action = declaration.action,
            .success = class == .satisfied,
            .observed_at = field(line, "ts") orelse "",
            .duration_ms = declaration.duration_ms,
            .terminal_index = terminal_count,
        });
        terminal_count += 1;
    }

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.append(allocator, '[');
    var iterator = latest.iterator();
    var first = true;
    while (iterator.next()) |entry| {
        if (!first) try out.append(allocator, ',');
        first = false;
        try out.appendSlice(allocator, "{\"binary\":\"");
        try appendJsonStr(&out, allocator, entry.key_ptr.*);
        try out.appendSlice(allocator, "\",\"example\":\"");
        if (entry.value_ptr.success) try appendJsonStr(&out, allocator, entry.value_ptr.action);
        try out.appendSlice(allocator, "\",\"score\":");
        try out.appendSlice(allocator, if (entry.value_ptr.success) "1" else "-1");
        try out.appendSlice(allocator, ",\"freshness\":\"");
        const events_ago = terminal_count -| (entry.value_ptr.terminal_index + 1);
        try out.appendSlice(allocator, if (events_ago < RECENT_CANDIDATES / 4) "fresh" else "stale");
        try out.appendSlice(allocator, "\",\"observed_at\":\"");
        try appendJsonStr(&out, allocator, entry.value_ptr.observed_at);
        try out.appendSlice(allocator, "\",\"duration_ms\":");
        if (entry.value_ptr.duration_ms) |duration| {
            var duration_buf: [32]u8 = undefined;
            try out.appendSlice(allocator, try std.fmt.bufPrint(&duration_buf, "{d:.0}", .{duration}));
        } else {
            try out.appendSlice(allocator, "null");
        }
        try out.append(allocator, '}');
    }
    try out.append(allocator, ']');
    return out.toOwnedSlice(allocator);
}

test "recommend: the JSON field parser (the ledger-row glue)" {
    // The per-binary routing is proven in ebm.zig + route_bench.zig; here we only
    // assert the field parser recommend() relies on to read declared/terminal rows.
    const line = "{\"event\": \"declared\", \"id\": \"abc\", \"plan\": \"commit my changes\", \"action\": \"git commit\"}";
    try std.testing.expectEqualStrings("abc", field(line, "id").?);
    try std.testing.expectEqualStrings("commit my changes", field(line, "plan").?);
    try std.testing.expectEqualStrings("git commit", field(line, "action").?);
    try std.testing.expect(field(line, "missing") == null);
    try std.testing.expectEqual(@as(f64, 42), numberField("{\"duration_ms\":42}", "duration_ms").?);
    try std.testing.expectEqual(@as(f64, 42), numberOrStringField("{\"duration_ms\":\"42\"}", "duration_ms").?);
}

test "recommend: JSON string escaping keeps the example well-formed" {
    const A = std.testing.allocator;
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(A);
    try appendJsonStr(&buf, A, "grep -rn \"foo\\bar\" src/");
    try std.testing.expectEqualStrings("grep -rn \\\"foo\\\\bar\\\" src/", buf.items);
}

test "version-qualified FECH provider ids are routable but pointer exhaust is not" {
    try std.testing.expect(!isInternalBin("mcp:github.issues.list@1"));
    try std.testing.expect(!isInternalBin("aiko.read_file.invoke@abc123"));
    try std.testing.expect(isInternalBin("word:where"));
    try std.testing.expect(isInternalBin("neuron:application-root"));
}
