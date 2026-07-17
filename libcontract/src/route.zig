//! route.zig — the LEARNED energy router, ONE implementation shared by the CLI
//! (`contract route`), the C ABI (`contract_route`, so aiko-cli can call it via
//! FFI), and any future caller.
//!
//! It trains a per-binary energy prototype straight from the ledger — the ledger
//! IS the weights (like energyRankCandidates): every SATISFIED contract folds its
//! GOAL into the prototype of the binary its action named (+1, Hebbian); every
//! DIED one inhibits it (−1). Then it returns the argmin-energy binary for a new
//! goal — the binary whose past successes sit closest to it, generalizing to goals
//! never seen (ebm.zig scores by cosine distance, not exact match). No LLM. Cold
//! (nothing learned) → null (honest refusal, never a fabricated route).

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

    var protos = std.StringHashMap(SemProto).init(allocator);
    defer protos.deinit();
    var usages: std.ArrayList(Usage) = .empty;
    defer usages.deinit(allocator);

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
        if (bin.len == 0 or std.mem.eql(u8, bin, "claim") or std.mem.eql(u8, bin, "neuron")) continue;
        var v: [SEM]f32 = undefined;
        bge.embed(d.plan, &v);
        const gop = try protos.getOrPut(bin);
        if (!gop.found_existing) gop.value_ptr.* = .{};
        gop.value_ptr.foldVec(&v, reward);
        if (reward > 0) try usages.append(allocator, .{ .bin = bin, .action = d.action, .vec = v });
    }

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
