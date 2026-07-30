//! fractal.zig — Φ11 fractal-context-on-every-emission (doctrine 23dff9bf).
//!
//! Per Σ27 (a4e162c8): this renderer is native zig, called from the
//! appendRow chokepoint in contract.zig. NOT a bash patch, NOT a verb-gate
//! folder script. The block is structurally bound to row writes.
//!
//! Emits one `=== FRACTAL CONTEXT ===` block to a writer, carrying:
//!   THIS shape + plan
//!   PARENT_CHAIN root → ... → THIS  (with each shape)
//!   COMPOSITION_ROLE (Nth-of-M under parent)
//!   REFERRERS (contracts whose action is contract:THIS_ID)
//!   FIRST_PRINCIPLE (root.plan first sentence)
//!   FUNNEL+LOOP+HARNESS self-statement
//!
//! Composes Ω3 root-walk 69d06a4c, KEY 3 refractory 0bc383d0,
//! plan-fulfillment proof 173c8819, Ω6 face dc13b225.

const std = @import("std");
const pointer = @import("pointer.zig");
const ledger = @import("ledger.zig");

const Row = struct {
    id: []const u8,
    event: []const u8,
    plan: []const u8,
    action: []const u8,
    parent_id: ?[]const u8,
    satisfied: bool,
};

/// Naively extract the JSON string value for `key` from a single ledger line.
/// Returns a slice into the input (no allocation). Returns null if the key
/// is absent or its value is not a string.
fn extractString(line: []const u8, key: []const u8) ?[]const u8 {
    var needle_buf: [128]u8 = undefined;
    const needle = std.fmt.bufPrint(&needle_buf, "\"{s}\": \"", .{key}) catch return null;
    const start = std.mem.indexOf(u8, line, needle) orelse return null;
    const value_start = start + needle.len;
    var i: usize = value_start;
    while (i < line.len) : (i += 1) {
        if (line[i] == '\\') {
            i += 1;
            continue;
        }
        if (line[i] == '"') return line[value_start..i];
    }
    return null;
}

fn isSatisfiedRow(line: []const u8) bool {
    return std.mem.indexOf(u8, line, "\"event\": \"satisfied\"") != null;
}

fn isDeclaredRow(line: []const u8) bool {
    return std.mem.indexOf(u8, line, "\"event\": \"declared\"") != null;
}

/// Walk the parent chain from `id` up to the root.
/// Returns an owned slice of Row structs, root first to leaf last.
fn walkChain(
    allocator: std.mem.Allocator,
    rows: []const Row,
    id: []const u8,
) ![]Row {
    var chain: std.ArrayList(Row) = .empty;
    defer chain.deinit(allocator);

    // Find THIS first
    var cur: ?Row = null;
    for (rows) |r| {
        if (std.mem.eql(u8, r.id, id)) {
            cur = r;
            break;
        }
    }
    if (cur == null) return chain.toOwnedSlice(allocator);

    try chain.append(allocator, cur.?);
    var seen_count: usize = 1;
    while (cur.?.parent_id) |pid| {
        if (seen_count > 64) break; // sanity cap on lineage depth
        var found: ?Row = null;
        for (rows) |r| {
            if (std.mem.eql(u8, r.id, pid)) {
                found = r;
                break;
            }
        }
        if (found == null) break;
        // Cycle guard: don't re-visit.
        var already = false;
        for (chain.items) |c| {
            if (std.mem.eql(u8, c.id, found.?.id)) {
                already = true;
                break;
            }
        }
        if (already) break;
        try chain.append(allocator, found.?);
        cur = found;
        seen_count += 1;
    }

    // Reverse so root is first.
    const out = try chain.toOwnedSlice(allocator);
    std.mem.reverse(Row, out);
    return out;
}

/// Render the FRACTAL CONTEXT block for `id` to `writer`.
/// `event` is the substrate event that triggered the render (declared, iterated, satisfied, …).
/// Reads the ledger via ledger.readAll; if id is not in the ledger, writes nothing.
pub fn renderContext(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
    event: []const u8,
    writer: anytype,
) !void {
    const data = try ledger.readAll(allocator, env);
    defer allocator.free(data);
    if (data.len == 0) return;

    // Parse rows we care about (declared + satisfied)
    var rows: std.ArrayList(Row) = .empty;
    defer rows.deinit(allocator);
    var satisfied_ids: std.ArrayList([]const u8) = .empty;
    defer satisfied_ids.deinit(allocator);

    var line_it = std.mem.splitScalar(u8, data, '\n');
    while (line_it.next()) |line| {
        if (line.len == 0) continue;
        if (isDeclaredRow(line)) {
            const row_id = extractString(line, "id") orelse continue;
            const plan = extractString(line, "plan") orelse "";
            const action = extractString(line, "action") orelse "";
            const parent_id = extractString(line, "parent_id");
            try rows.append(allocator, .{
                .id = row_id,
                .event = "declared",
                .plan = plan,
                .action = action,
                .parent_id = parent_id,
                .satisfied = false,
            });
        } else if (isSatisfiedRow(line)) {
            if (extractString(line, "id")) |sid| try satisfied_ids.append(allocator, sid);
        }
    }

    // Mark satisfied
    for (rows.items) |*r| {
        for (satisfied_ids.items) |sid| {
            if (std.mem.eql(u8, r.id, sid)) {
                r.satisfied = true;
                break;
            }
        }
    }

    // Find THIS
    var this_row: ?Row = null;
    for (rows.items) |r| {
        if (std.mem.eql(u8, r.id, id)) {
            this_row = r;
            break;
        }
    }
    if (this_row == null) return; // id unknown — silent skip

    // Walk parent chain
    const chain = try walkChain(allocator, rows.items, id);
    defer allocator.free(chain);

    const root = if (chain.len > 0) chain[0] else this_row.?;

    // Find composition role: Nth of M under parent
    var role_buf: [128]u8 = undefined;
    var role_text: []const u8 = "ROOT organ (no parent)";
    if (this_row.?.parent_id) |pid| {
        var siblings: usize = 0;
        var my_idx: usize = 0;
        var found_me = false;
        for (rows.items) |r| {
            if (r.parent_id) |rp| {
                if (std.mem.eql(u8, rp, pid)) {
                    if (std.mem.eql(u8, r.id, id)) {
                        my_idx = siblings;
                        found_me = true;
                    }
                    siblings += 1;
                }
            }
        }
        // Parent shape
        var parent_shape: []const u8 = "?";
        for (rows.items) |r| {
            if (std.mem.eql(u8, r.id, pid)) {
                parent_shape = pointer.inferPointerType(r.action);
                break;
            }
        }
        if (found_me) {
            role_text = try std.fmt.bufPrint(&role_buf, "child {d} of {d} under parent[{s}]", .{ my_idx + 1, siblings, parent_shape });
        }
    }

    // Find referrers
    var refs: std.ArrayList([]const u8) = .empty;
    defer refs.deinit(allocator);
    var needle_buf: [32]u8 = undefined;
    const needle = try std.fmt.bufPrint(&needle_buf, "contract:{s}", .{id});
    for (rows.items) |r| {
        if (std.mem.indexOf(u8, r.action, needle) != null) {
            try refs.append(allocator, r.id);
        }
    }

    // First principle: root.plan up to first period or 120 chars
    const root_plan = root.plan;
    var fp_end: usize = root_plan.len;
    if (std.mem.indexOfScalar(u8, root_plan, '.')) |dot| fp_end = dot;
    if (fp_end > 120) fp_end = 120;
    const fp = root_plan[0..fp_end];

    // Plan prefix for THIS
    var plan_end: usize = this_row.?.plan.len;
    if (plan_end > 70) plan_end = 70;
    const plan_prefix = this_row.?.plan[0..plan_end];

    const this_shape = pointer.inferPointerType(this_row.?.action);

    try writer.writeAll("\n=== FRACTAL CONTEXT ===\n");
    try writer.print("  EVENT:             {s}\n", .{event});
    try writer.print("  THIS:              {s}  [{s}]  \"{s}{s}\"\n", .{
        id,
        this_shape,
        plan_prefix,
        if (this_row.?.plan.len > 70) @as([]const u8, "…") else "",
    });

    if (chain.len > 1) {
        try writer.writeAll("  PARENT_CHAIN:      ");
        for (chain, 0..) |r, idx| {
            if (idx > 0) try writer.writeAll(" → ");
            const shape = pointer.inferPointerType(r.action);
            if (std.mem.eql(u8, r.id, id)) {
                try writer.print("THIS[{s}]", .{shape});
            } else {
                try writer.print("{s}[{s}]", .{ r.id, shape });
            }
        }
        try writer.writeAll("\n");
    } else {
        try writer.writeAll("  PARENT_CHAIN:      THIS is root (no ancestors)\n");
    }

    try writer.print("  COMPOSITION_ROLE:  {s}\n", .{role_text});

    if (refs.items.len > 0) {
        try writer.writeAll("  REFERRERS:         ");
        for (refs.items, 0..) |r, idx| {
            if (idx > 0) try writer.writeAll(", ");
            if (idx >= 5) {
                try writer.writeAll(" …");
                break;
            }
            try writer.writeAll(r);
        }
        try writer.writeAll("\n");
        try writer.writeAll("                     (wavefront these will fire when THIS satisfies)\n");
    } else {
        try writer.writeAll("  REFERRERS:         none (no contract:<id> points at THIS yet)\n");
    }

    try writer.print("  FIRST_PRINCIPLE:   \"{s}\"\n", .{fp});
    try writer.writeAll("  FUNNEL+LOOP+HARNESS:\n");
    try writer.print("    funnel  → narrows to children's truth   (root={s})\n", .{root.id});
    try writer.print("    loop    → iterate until KEY 1+2+3 fire  ({d}-deep lineage)\n", .{chain.len});
    const proof_status: []const u8 = if (this_row.?.satisfied) "satisfied" else "pending";
    try writer.print("    harness → evidence on row                ({s})\n", .{proof_status});
}

// ─────────────────────────────────────────────────────────────────────────
// Tests — Σ27 binding: zig tests inline. No verb-gate folder.

test "extractString picks out a JSON string value" {
    const line = "{\"event\": \"declared\", \"id\": \"deadbeef\", \"plan\": \"hello\"}";
    try std.testing.expectEqualStrings("deadbeef", extractString(line, "id").?);
    try std.testing.expectEqualStrings("hello", extractString(line, "plan").?);
    try std.testing.expect(extractString(line, "missing") == null);
}

test "isDeclaredRow / isSatisfiedRow classify event lines" {
    try std.testing.expect(isDeclaredRow("{\"event\": \"declared\", \"id\": \"abc\"}"));
    try std.testing.expect(isSatisfiedRow("{\"event\": \"satisfied\", \"id\": \"abc\"}"));
    try std.testing.expect(!isDeclaredRow("{\"event\": \"satisfied\", \"id\": \"abc\"}"));
}
