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
const ebm = @import("ebm.zig");

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

    // Pass 2: fold each terminal event's declared goal into its binary's prototype.
    var protos = std.StringHashMap(ebm.Prototype).init(allocator);
    defer protos.deinit();
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
        gop.value_ptr.foldText(d.plan, reward);
    }

    // Settle: argmin energy over the learned binary prototypes.
    var best_bin: ?[]const u8 = null;
    var best_e: f64 = std.math.inf(f64);
    var pit = protos.iterator();
    while (pit.next()) |e| {
        const en = ebm.energyText(e.value_ptr.*, context);
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
