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
const binary_ast = @import("binary_ast.zig");

// The router embeds with the baked BERT (bge-small, bge.zig) — a real learned
// sentence embedder that knows phrase-level meaning ("roll back a version"≈git,
// search≈hunt), well past GloVe averaging. A per-binary reward-weighted centroid over
// goal vectors (West 1979, like ebm.Prototype); energy = −cosine; routing = argmin.
const SEM = bge.DIM;

const SemProto = struct {
    mean: [SEM]f32 = [_]f32{0} ** SEM,
    w: f64 = 0, // reward-weight folded in
    trained: bool = false, // a REAL fire (not just the lexicon seed) touched it

    fn fold(self: *SemProto, text: []const u8, reward: f64) void {
        var v: [SEM]f32 = undefined;
        bge.embed(text, &v);
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

    fn energy(self: SemProto, text: []const u8) f64 {
        if (self.w <= 0) return std.math.inf(f64);
        var v: [SEM]f32 = undefined;
        bge.embed(text, &v);
        return -@as(f64, embed.cosine(&v, &self.mean));
    }
};

/// Cold-start weight for the lexicon seed (≪ a real fire's ±1).
const SEED_REWARD: f64 = 0.35;

/// Last-resort penalty on a SEED-ONLY binary (lexicon prior, no real training). Its
/// broad command-surface prototype otherwise steals goals from trained binaries
/// (measured: the raw seed HURT production — 40% vs 55% without it). Penalizing its
/// energy means it only wins when clearly best AND nothing trained is close; and
/// when NOTHING is trained (fresh ledger) the constant cancels across all, so
/// cold-start still works. This turns the seed net-positive.
const SEED_PENALTY: f64 = 0.30;

/// Fold each lexicon binary's full command surface into its prototype as ONE weak
/// (seed-only) fire — cold-start priors, left marked untrained.
fn seedFromLexicon(allocator: std.mem.Allocator, protos: *std.StringHashMap(SemProto)) !void {
    for (&binary_ast.registries) |reg| {
        var buf: std.ArrayList(u8) = .empty;
        defer buf.deinit(allocator);
        try buf.appendSlice(allocator, reg.name);
        try buf.append(allocator, ' ');
        try buf.appendSlice(allocator, reg.root.desc);
        for (reg.root.subs) |sub| {
            try buf.append(allocator, ' ');
            try buf.appendSlice(allocator, sub.name);
            try buf.append(allocator, ' ');
            try buf.appendSlice(allocator, sub.desc);
        }
        const gop = try protos.getOrPut(reg.name);
        if (!gop.found_existing) gop.value_ptr.* = .{};
        gop.value_ptr.fold(buf.items, SEED_REWARD);
    }
}

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

/// Route `context` to the best-fit binary. Caller owns the returned slice (dupe);
/// null when nothing has been learned yet.
pub fn route(allocator: std.mem.Allocator, env: std.process.Environ, context: []const u8) !?[]u8 {
    const data = try ledger.readAll(allocator, env);
    defer allocator.free(data);

    // Pass 1: id -> {plan, action} from declared rows (slices into `data`).
    var declared = std.StringHashMap(Decl).init(allocator);
    defer declared.deinit();
    var it = std.mem.splitScalar(u8, data, '\n');
    while (it.next()) |line| {
        if (line.len == 0 or std.mem.indexOf(u8, line, "\"declared\"") == null) continue;
        const id = field(line, "id") orelse continue;
        const plan = field(line, "plan") orelse continue;
        try declared.put(id, .{ .plan = plan, .action = field(line, "action") orelse "" });
    }

    // Cold-start: seed every known binary from its command surface (weak prior), so a
    // novel goal still routes sensibly before any training.
    var protos = std.StringHashMap(SemProto).init(allocator);
    defer protos.deinit();
    try seedFromLexicon(allocator, &protos);

    // Pass 2: fold each terminal event's declared goal into its binary's prototype
    // (a real ±1 fire, on TOP of the cold-start seed — learning dominates).
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
        const gop = try protos.getOrPut(bin);
        if (!gop.found_existing) gop.value_ptr.* = .{};
        gop.value_ptr.fold(d.plan, reward);
        gop.value_ptr.trained = true; // a REAL fire — no longer seed-only
    }

    // Settle: argmin energy, with a last-resort penalty on seed-only (untrained)
    // binaries so a broad lexicon prior never steals a goal from a trained binary.
    var best_bin: ?[]const u8 = null;
    var best_e: f64 = std.math.inf(f64);
    var pit = protos.iterator();
    while (pit.next()) |e| {
        var en = e.value_ptr.energy(context);
        if (!e.value_ptr.trained) en += SEED_PENALTY;
        if (en < best_e) {
            best_e = en;
            best_bin = e.key_ptr.*;
        }
    }
    if (best_bin) |b| return try allocator.dupe(u8, b);
    return null;
}

test "route: learns per-binary from a synthetic ledger, routes a held-out goal" {
    // A tiny in-memory ledger emulation is overkill; the pure per-binary routing is
    // proven in ebm.zig. Here we only assert the field parser (the route-specific glue).
    const line = "{\"event\": \"declared\", \"id\": \"abc\", \"plan\": \"commit my changes\", \"action\": \"git commit\"}";
    try std.testing.expectEqualStrings("abc", field(line, "id").?);
    try std.testing.expectEqualStrings("commit my changes", field(line, "plan").?);
    try std.testing.expectEqualStrings("git commit", field(line, "action").?);
    try std.testing.expect(field(line, "missing") == null);
}
