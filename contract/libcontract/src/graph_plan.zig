//! graph_plan.zig — chain-vs-graph verdict from the Contract walk data.
//!
//! The substrate holds every obligation and its dependencies from previous
//! declare + expand_graph calls. This module reads the open set, groups
//! independent nodes, and returns a structured verdict the LLM can consume
//! without having to reason about independence from source code.
//!
//! An edge exists only when data actually crosses it — a child depends on
//! its parent's declared ID. Absent that, two obligations are independent
//! and can fan out.

const std = @import("std");

pub const GraphPlan = struct {
    allocator: std.mem.Allocator,

    /// Structured verdict returned to callers (JSON-serializable).
    pub const Verdict = struct {
        kind: Kind,
        independent_groups: []const []const []const u8,
        total_agents: usize,
        peak_parallelism: usize,
        obligation_count: usize,
        ready_count: usize,

        pub const Kind = enum { chain, graph };

        pub fn deinit(self: *Verdict, allocator: std.mem.Allocator) void {
            for (self.independent_groups) |group| {
                for (group) |id| allocator.free(id);
                allocator.free(group);
            }
            allocator.free(self.independent_groups);
        }
    };

    /// Index-based tracking — avoids Zig 0.16 Aligned ArrayList issue.
    const NodeEntry = struct {
        id: []const u8,
        plan: []const u8,
        dep_count: usize,
        deps: [][]const u8,
    };

    /// Parse the Contract walk JSON and produce a Verdict.
    pub fn analyze(self: *@This(), walk_json: []const u8) !Verdict {
        const parsed = try std.json.parseFromSlice(
            std.json.Value,
            self.allocator,
            walk_json,
            .{},
        );
        defer parsed.deinit();

        const nodes = if (parsed.value == .object)
            parsed.value.object.get("nodes")
        else
            null;

        const array = if (nodes) |n| n.array.items else &.{};

        // First pass: count pending nodes.
        var pending_count: usize = 0;
        for (array) |node| {
            if (node != .object) continue;
            const obj = node.object;
            const status = obj.get("status") orelse continue;
            const s = if (status == .string) status.string else continue;
            if (std.mem.eql(u8, s, "pending") or std.mem.eql(u8, s, "failed"))
                pending_count += 1;
        }

        if (pending_count == 0) {
            return Verdict{
                .kind = .chain,
                .independent_groups = &[_][]const []const u8{},
                .total_agents = 0,
                .peak_parallelism = 0,
                .obligation_count = 0,
                .ready_count = 0,
            };
        }

        // Allocate entries.
        var entries = try self.allocator.alloc(NodeEntry, pending_count);
        defer {
            for (entries) |*e| {
                self.allocator.free(e.id);
                self.allocator.free(e.plan);
                for (e.deps) |d| self.allocator.free(d);
                self.allocator.free(e.deps);
            }
            self.allocator.free(entries);
        }

        // Populate entries.
        var ei: usize = 0;
        for (array) |node| {
            if (node != .object) continue;
            const obj = node.object;
            const status = obj.get("status") orelse continue;
            const s = if (status == .string) status.string else continue;
            if (!std.mem.eql(u8, s, "pending") and !std.mem.eql(u8, s, "failed")) continue;

            const id = obj.get("id") orelse continue;
            const id_str = if (id == .string) id.string else continue;

            var dep_list: std.ArrayListUnmanaged([]const u8) = .empty;
            if (obj.get("depends_on")) |depends_value| {
                if (depends_value == .array) {
                    for (depends_value.array.items) |dep| {
                        if (dep == .string)
                            try dep_list.append(self.allocator, try self.allocator.dupe(u8, dep.string));
                    }
                }
            }

            const plan = obj.get("plan") orelse continue;
            const plan_str = if (plan == .string) plan.string else "";

            entries[ei] = NodeEntry{
                .id = try self.allocator.dupe(u8, id_str),
                .plan = try self.allocator.dupe(u8, plan_str),
                .dep_count = dep_list.items.len,
                .deps = try dep_list.toOwnedSlice(self.allocator),
            };
            ei += 1;
        }

        // Build open ID lookup (flat map: check membership by scanning).
        const isOpen = struct {
            fn check(entries_: []NodeEntry, id: []const u8) bool {
                for (entries_) |e| {
                    if (std.mem.eql(u8, e.id, id)) return true;
                }
                return false;
            }
        }.check;

        // Count ready nodes.
        var ready_count: usize = 0;
        for (entries) |*e| {
            var blocked = false;
            for (e.deps) |dep| {
                if (isOpen(entries, dep)) { blocked = true; break; }
            }
            if (!blocked) ready_count += 1;
        }

        // Greedy grouping: nodes with disjoint deps go in same group.
        var groups: std.ArrayListUnmanaged(std.ArrayListUnmanaged([]const u8)) = .empty;
        defer {
            for (groups.items) |*g| g.deinit(self.allocator);
            groups.deinit(self.allocator);
        }

        for (entries) |*e| {
            var placed = false;
            for (groups.items) |*group| {
                var compatible = true;
                // Check: does e share any dep with anyone already in group?
                outer: for (e.deps) |edep| {
                    for (group.items) |member| {
                        // Find the entry for this member.
                        for (entries) |me| {
                            if (!std.mem.eql(u8, me.id, member)) continue;
                            for (me.deps) |mdep| {
                                if (std.mem.eql(u8, edep, mdep)) {
                                    compatible = false;
                                    break :outer;
                                }
                            }
                        }
                    }
                }
                if (compatible) {
                    try group.append(self.allocator, try self.allocator.dupe(u8, e.id));
                    placed = true;
                    break;
                }
            }
            if (!placed) {
                var new_group: std.ArrayListUnmanaged([]const u8) = .empty;
                try new_group.append(self.allocator, try self.allocator.dupe(u8, e.id));
                try groups.append(self.allocator, new_group);
            }
        }

        // Build output.
        var independent_groups = try self.allocator.alloc([]const []const u8, groups.items.len);
        errdefer {
            for (independent_groups) |g| self.allocator.free(g);
            self.allocator.free(independent_groups);
        }
        for (groups.items, 0..) |*group, gi| {
            independent_groups[gi] = try group.toOwnedSlice(self.allocator);
        }

        const total = 1 + (pending_count - ready_count);
        const peak = @max(1, independent_groups.len);

        return Verdict{
            .kind = if (independent_groups.len > 1 and ready_count > 1) .graph else .chain,
            .independent_groups = independent_groups,
            .total_agents = total,
            .peak_parallelism = peak,
            .obligation_count = pending_count,
            .ready_count = ready_count,
        };
    }

    /// Serialize a Verdict to JSON (caller owns the returned string).
    pub fn toJson(self: *@This(), verdict: *const Verdict) ![]u8 {
        var buf: std.ArrayList(u8) = .empty;
        defer buf.deinit(self.allocator);
        const gpa = self.allocator;
        try buf.appendSlice(gpa, "{\"kind\":\"");
        try buf.appendSlice(gpa, switch (verdict.kind) { .chain => "chain", .graph => "graph" });
        try buf.print(gpa, "\",\"total_agents\":{d},\"peak_parallelism\":{d}", .{
            verdict.total_agents, verdict.peak_parallelism,
        });
        try buf.print(gpa, ",\"obligation_count\":{d},\"ready_count\":{d}", .{
            verdict.obligation_count, verdict.ready_count,
        });
        try buf.appendSlice(gpa, ",\"independent_groups\":[");
        for (verdict.independent_groups, 0..) |group, gi| {
            if (gi > 0) try buf.append(gpa, ',');
            try buf.append(gpa, '[');
            for (group, 0..) |id, ii| {
                if (ii > 0) try buf.append(gpa, ',');
                try buf.append(gpa, '"');
                try buf.appendSlice(gpa, id);
                try buf.append(gpa, '"');
            }
            try buf.append(gpa, ']');
        }
        try buf.appendSlice(gpa, "]}");
        return buf.toOwnedSlice(self.allocator);
    }
};

test "empty walk returns chain with zero agents" {
    var ga = GraphPlan{ .allocator = std.testing.allocator };
    const v = try ga.analyze("{\"nodes\":[]}");
    defer v.deinit(std.testing.allocator);
    try std.testing.expectEqual(GraphPlan.Verdict.Kind.chain, v.kind);
    try std.testing.expectEqual(@as(usize, 0), v.total_agents);
}

test "single pending node is a chain" {
    var ga = GraphPlan{ .allocator = std.testing.allocator };
    const v = try ga.analyze(
        \\{"nodes":[{"id":"a","plan":"do A","depends_on":[],"status":"pending"}]}
    );
    defer v.deinit(std.testing.allocator);
    try std.testing.expectEqual(GraphPlan.Verdict.Kind.chain, v.kind);
    try std.testing.expectEqual(@as(usize, 1), v.ready_count);
}

test "two independent pending nodes form a graph" {
    var ga = GraphPlan{ .allocator = std.testing.allocator };
    const v = try ga.analyze(
        \\{"nodes":[
        \\  {"id":"a","plan":"fix shim","depends_on":[],"status":"pending"},
        \\  {"id":"b","plan":"install gcc","depends_on":[],"status":"pending"}
        \\]}
    );
    defer v.deinit(std.testing.allocator);
    try std.testing.expectEqual(GraphPlan.Verdict.Kind.graph, v.kind);
    try std.testing.expectEqual(@as(usize, 2), v.ready_count);
}

test "chain when B depends on A" {
    var ga = GraphPlan{ .allocator = std.testing.allocator };
    const v = try ga.analyze(
        \\{"nodes":[
        \\  {"id":"a","plan":"do A","depends_on":[],"status":"pending"},
        \\  {"id":"b","plan":"do B","depends_on":["a"],"status":"pending"}
        \\]}
    );
    defer v.deinit(std.testing.allocator);
    try std.testing.expectEqual(GraphPlan.Verdict.Kind.chain, v.kind);
    try std.testing.expectEqual(@as(usize, 1), v.ready_count);
}

test "ignores satisfied nodes" {
    var ga = GraphPlan{ .allocator = std.testing.allocator };
    const v = try ga.analyze(
        \\{"nodes":[
        \\  {"id":"a","plan":"done","depends_on":[],"status":"satisfied"},
        \\  {"id":"b","plan":"do B","depends_on":[],"status":"pending"}
        \\]}
    );
    defer v.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 1), v.obligation_count);
    try std.testing.expectEqual(@as(usize, 1), v.ready_count);
}
