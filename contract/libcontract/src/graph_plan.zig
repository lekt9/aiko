//! graph_plan.zig — deterministic, fail-closed graph analysis for Contract walks.
//!
//! This is an observer, not a scheduler. It validates the declared walk, emits
//! executable Kahn frontiers, and names the conditions that prevent safe fan
//! out. Invalid graphs never receive an executable frontier.

const std = @import("std");

pub const GraphPlan = struct {
    allocator: std.mem.Allocator,

    pub const Collision = struct {
        a: []const u8,
        b: []const u8,
        shared: []const []const u8,
    };
    pub const Tier = struct {
        id: []const u8,
        tier: enum { mechanical, judgement },
    };
    pub const UnknownDependency = struct {
        node: []const u8,
        dependency: []const u8,
    };

    pub const Verdict = struct {
        kind: Kind,
        independent_groups: []const []const []const u8,
        waves: []const []const []const u8,
        ready: []const []const u8,
        write_collisions: []const Collision,
        model_tiers: []const Tier,
        cycle_list: []const []const u8,
        unknown_dependencies: []const UnknownDependency,
        ungrounded: []const []const u8,
        ungated: []const []const u8,
        total_agents: usize,
        peak_parallelism: usize,
        obligation_count: usize,
        ready_count: usize,

        pub const Kind = enum { chain, graph };

        pub fn deinit(self: *Verdict, allocator: std.mem.Allocator) void {
            freeGroups(allocator, self.independent_groups);
            freeGroups(allocator, self.waves);
            freeStrings(allocator, self.ready);
            for (self.write_collisions) |collision| {
                allocator.free(collision.a);
                allocator.free(collision.b);
                freeStrings(allocator, collision.shared);
            }
            allocator.free(self.write_collisions);
            for (self.model_tiers) |tier| allocator.free(tier.id);
            allocator.free(self.model_tiers);
            freeStrings(allocator, self.cycle_list);
            for (self.unknown_dependencies) |gap| {
                allocator.free(gap.node);
                allocator.free(gap.dependency);
            }
            allocator.free(self.unknown_dependencies);
            freeStrings(allocator, self.ungrounded);
            freeStrings(allocator, self.ungated);
        }
    };

    const NodeEntry = struct {
        id: []const u8,
        plan: []const u8,
        deps: []const []const u8,
        writes: []const []const u8,
        active: bool,
        grounded: bool,
        gated: bool,
        how_eval: bool,
    };

    pub fn analyze(self: *@This(), walk_json: []const u8) !Verdict {
        var parsed = try std.json.parseFromSlice(std.json.Value, self.allocator, walk_json, .{});
        defer parsed.deinit();
        if (parsed.value != .object) return error.InvalidWalk;
        const nodes_value = parsed.value.object.get("nodes") orelse return error.InvalidWalk;
        if (nodes_value != .array) return error.InvalidWalk;

        var entries: std.ArrayListUnmanaged(NodeEntry) = .empty;
        defer {
            for (entries.items) |entry| freeNode(self.allocator, entry);
            entries.deinit(self.allocator);
        }

        for (nodes_value.array.items) |node_value| {
            if (node_value != .object) return error.InvalidWalk;
            const obj = node_value.object;
            const id = try requiredString(obj, "id");
            if (id.len == 0 or findNode(entries.items, id) != null) return error.InvalidWalk;
            const status = try requiredString(obj, "status");
            const active = try activeStatus(status);
            const plan = if (obj.get("plan")) |value| try stringValue(value) else "";
            const deps = try parseStringArray(self.allocator, obj, "depends_on", true);
            errdefer freeStrings(self.allocator, deps);
            const writes = try parseStringArray(self.allocator, obj, "writes", false);
            errdefer freeStrings(self.allocator, writes);
            const grounded = try fieldHasStrings(obj, "invoke_skills") or
                try fieldHasStrings(obj, "inspire_from") or try fieldHasStrings(obj, "capability_gaps");
            const witness = if (obj.get("witness")) |value| try stringValue(value) else "";
            const how_eval = if (obj.get("how")) |value|
                std.mem.eql(u8, try stringValue(value), "eval")
            else
                false;
            const owned_id = try self.allocator.dupe(u8, id);
            errdefer self.allocator.free(owned_id);
            const owned_plan = try self.allocator.dupe(u8, plan);
            errdefer self.allocator.free(owned_plan);
            try entries.append(self.allocator, .{
                .id = owned_id,
                .plan = owned_plan,
                .deps = deps,
                .writes = writes,
                .active = active,
                .grounded = grounded,
                .gated = witness.len != 0,
                .how_eval = how_eval,
            });
        }
        std.mem.sort(NodeEntry, entries.items, {}, lessNode);

        var active_indices: std.ArrayListUnmanaged(usize) = .empty;
        defer active_indices.deinit(self.allocator);
        for (entries.items, 0..) |entry, index| if (entry.active) try active_indices.append(self.allocator, index);

        var unknown: std.ArrayListUnmanaged(UnknownDependency) = .empty;
        errdefer freeUnknownList(self.allocator, &unknown);
        for (active_indices.items) |index| {
            for (entries.items[index].deps) |dep| {
                if (findNode(entries.items, dep) == null) {
                    const owned_node = try self.allocator.dupe(u8, entries.items[index].id);
                    errdefer self.allocator.free(owned_node);
                    const owned_dependency = try self.allocator.dupe(u8, dep);
                    errdefer self.allocator.free(owned_dependency);
                    try unknown.append(self.allocator, .{
                        .node = owned_node,
                        .dependency = owned_dependency,
                    });
                }
            }
        }
        std.mem.sort(UnknownDependency, unknown.items, {}, lessUnknown);

        var waves_list: std.ArrayListUnmanaged([]const []const u8) = .empty;
        errdefer freeGroupList(self.allocator, &waves_list);
        var processed = try self.allocator.alloc(bool, entries.items.len);
        defer self.allocator.free(processed);
        @memset(processed, false);

        if (unknown.items.len == 0) {
            while (true) {
                var wave: std.ArrayListUnmanaged([]const u8) = .empty;
                errdefer freeStringList(self.allocator, &wave);
                for (active_indices.items) |index| {
                    if (processed[index]) continue;
                    var blocked = false;
                    for (entries.items[index].deps) |dep| {
                        if (findNode(entries.items, dep)) |dep_index| {
                            if (entries.items[dep_index].active and !processed[dep_index]) {
                                blocked = true;
                                break;
                            }
                        }
                    }
                    if (!blocked) {
                        const owned_id = try self.allocator.dupe(u8, entries.items[index].id);
                        errdefer self.allocator.free(owned_id);
                        try wave.append(self.allocator, owned_id);
                    }
                }
                if (wave.items.len == 0) {
                    wave.deinit(self.allocator);
                    break;
                }
                for (wave.items) |id| processed[findNode(entries.items, id).?] = true;
                const owned_wave = try wave.toOwnedSlice(self.allocator);
                errdefer freeStrings(self.allocator, owned_wave);
                try waves_list.append(self.allocator, owned_wave);
            }
        }

        var cycles: std.ArrayListUnmanaged([]const u8) = .empty;
        errdefer freeStringList(self.allocator, &cycles);
        if (unknown.items.len == 0) {
            for (active_indices.items) |index| if (!processed[index]) {
                const owned_id = try self.allocator.dupe(u8, entries.items[index].id);
                errdefer self.allocator.free(owned_id);
                try cycles.append(self.allocator, owned_id);
            };
        }

        // A partially executable cyclic plan is not an executable plan.
        if (cycles.items.len != 0) {
            freeGroupList(self.allocator, &waves_list);
        }

        var collisions: std.ArrayListUnmanaged(Collision) = .empty;
        errdefer freeCollisionList(self.allocator, &collisions);
        for (active_indices.items, 0..) |left_index, i| {
            for (active_indices.items[i + 1 ..]) |right_index| {
                var shared: std.ArrayListUnmanaged([]const u8) = .empty;
                errdefer freeStringList(self.allocator, &shared);
                for (entries.items[left_index].writes) |left| {
                    for (entries.items[right_index].writes) |right| {
                        if (scopeOverlap(left, right)) {
                            const description = try std.fmt.allocPrint(self.allocator, "{s} <-> {s}", .{ left, right });
                            errdefer self.allocator.free(description);
                            try shared.append(self.allocator, description);
                        }
                    }
                }
                if (shared.items.len != 0) {
                    const owned_a = try self.allocator.dupe(u8, entries.items[left_index].id);
                    errdefer self.allocator.free(owned_a);
                    const owned_b = try self.allocator.dupe(u8, entries.items[right_index].id);
                    errdefer self.allocator.free(owned_b);
                    const owned_shared = try shared.toOwnedSlice(self.allocator);
                    errdefer freeStrings(self.allocator, owned_shared);
                    try collisions.append(self.allocator, .{
                        .a = owned_a,
                        .b = owned_b,
                        .shared = owned_shared,
                    });
                } else shared.deinit(self.allocator);
            }
        }

        var tiers = try self.allocator.alloc(Tier, active_indices.items.len);
        var initialized_tiers: usize = 0;
        errdefer {
            for (tiers[0..initialized_tiers]) |tier| self.allocator.free(tier.id);
            self.allocator.free(tiers);
        }
        for (active_indices.items, 0..) |index, tier_index| {
            var fan_out: usize = 0;
            var fan_in: usize = 0;
            for (entries.items[index].deps) |dep| {
                if (findActive(entries.items, dep)) fan_in += 1;
            }
            for (active_indices.items) |other| for (entries.items[other].deps) |dep|
                if (std.mem.eql(u8, dep, entries.items[index].id)) {
                    fan_out += 1;
                    break;
                };
            tiers[tier_index] = .{
                .id = try self.allocator.dupe(u8, entries.items[index].id),
                .tier = if (fan_in >= 3 or fan_out >= 3 or entries.items[index].how_eval) .judgement else .mechanical,
            };
            initialized_tiers += 1;
        }

        var ungrounded_list: std.ArrayListUnmanaged([]const u8) = .empty;
        errdefer freeStringList(self.allocator, &ungrounded_list);
        var ungated_list: std.ArrayListUnmanaged([]const u8) = .empty;
        errdefer freeStringList(self.allocator, &ungated_list);
        for (active_indices.items) |index| {
            if (!entries.items[index].grounded) {
                const owned_id = try self.allocator.dupe(u8, entries.items[index].id);
                errdefer self.allocator.free(owned_id);
                try ungrounded_list.append(self.allocator, owned_id);
            }
            if (!entries.items[index].gated) {
                const owned_id = try self.allocator.dupe(u8, entries.items[index].id);
                errdefer self.allocator.free(owned_id);
                try ungated_list.append(self.allocator, owned_id);
            }
        }

        const valid = unknown.items.len == 0 and cycles.items.len == 0;
        const waves = try waves_list.toOwnedSlice(self.allocator);
        errdefer freeGroups(self.allocator, waves);
        const independent_groups = try cloneGroups(self.allocator, waves);
        errdefer freeGroups(self.allocator, independent_groups);
        const ready = if (valid and waves.len != 0) try cloneStrings(self.allocator, waves[0]) else try self.allocator.alloc([]const u8, 0);
        errdefer freeStrings(self.allocator, ready);
        var peak: usize = 0;
        for (waves) |wave| peak = @max(peak, wave.len);

        const owned_collisions = try collisions.toOwnedSlice(self.allocator);
        errdefer freeCollisions(self.allocator, owned_collisions);
        const owned_cycles = try cycles.toOwnedSlice(self.allocator);
        errdefer freeStrings(self.allocator, owned_cycles);
        const owned_unknown = try unknown.toOwnedSlice(self.allocator);
        errdefer freeUnknown(self.allocator, owned_unknown);
        const owned_ungrounded = try ungrounded_list.toOwnedSlice(self.allocator);
        errdefer freeStrings(self.allocator, owned_ungrounded);
        const owned_ungated = try ungated_list.toOwnedSlice(self.allocator);
        errdefer freeStrings(self.allocator, owned_ungated);

        return .{
            .kind = if (valid and ready.len > 1) .graph else .chain,
            .independent_groups = independent_groups,
            .waves = waves,
            .ready = ready,
            .write_collisions = owned_collisions,
            .model_tiers = tiers,
            .cycle_list = owned_cycles,
            .unknown_dependencies = owned_unknown,
            .ungrounded = owned_ungrounded,
            .ungated = owned_ungated,
            .total_agents = active_indices.items.len,
            .peak_parallelism = peak,
            .obligation_count = active_indices.items.len,
            .ready_count = ready.len,
        };
    }

    pub fn toJson(self: *@This(), verdict: *const Verdict) ![]u8 {
        var out: std.ArrayList(u8) = .empty;
        defer out.deinit(self.allocator);
        try out.appendSlice(self.allocator, "{\"kind\":\"");
        try out.appendSlice(self.allocator, if (verdict.kind == .graph) "graph" else "chain");
        try out.print(self.allocator, "\",\"total_agents\":{d},\"peak_parallelism\":{d},\"obligation_count\":{d},\"ready_count\":{d}", .{ verdict.total_agents, verdict.peak_parallelism, verdict.obligation_count, verdict.ready_count });
        try appendGroups(&out, self.allocator, "independent_groups", verdict.independent_groups);
        try appendGroups(&out, self.allocator, "waves", verdict.waves);
        try appendStringsField(&out, self.allocator, "ready", verdict.ready);
        try out.appendSlice(self.allocator, ",\"write_collisions\":[");
        for (verdict.write_collisions, 0..) |collision, index| {
            if (index != 0) try out.append(self.allocator, ',');
            try out.appendSlice(self.allocator, "{\"a\":");
            try appendJsonString(&out, self.allocator, collision.a);
            try out.appendSlice(self.allocator, ",\"b\":");
            try appendJsonString(&out, self.allocator, collision.b);
            try out.appendSlice(self.allocator, ",\"shared\":[");
            try appendStringValues(&out, self.allocator, collision.shared);
            try out.appendSlice(self.allocator, "]}");
        }
        try out.appendSlice(self.allocator, "],\"model_tiers\":[");
        for (verdict.model_tiers, 0..) |tier, index| {
            if (index != 0) try out.append(self.allocator, ',');
            try out.appendSlice(self.allocator, "{\"id\":");
            try appendJsonString(&out, self.allocator, tier.id);
            try out.appendSlice(self.allocator, ",\"tier\":\"");
            try out.appendSlice(self.allocator, if (tier.tier == .judgement) "judgement" else "mechanical");
            try out.appendSlice(self.allocator, "\"}");
        }
        try out.append(self.allocator, ']');
        try appendStringsField(&out, self.allocator, "cycle_list", verdict.cycle_list);
        // `cycles` is the additive frontend spelling; cycle_list remains ABI-compatible.
        try appendStringsField(&out, self.allocator, "cycles", verdict.cycle_list);
        try out.appendSlice(self.allocator, ",\"unknown_dependencies\":[");
        for (verdict.unknown_dependencies, 0..) |gap, index| {
            if (index != 0) try out.append(self.allocator, ',');
            try out.appendSlice(self.allocator, "{\"node\":");
            try appendJsonString(&out, self.allocator, gap.node);
            try out.appendSlice(self.allocator, ",\"dependency\":");
            try appendJsonString(&out, self.allocator, gap.dependency);
            try out.append(self.allocator, '}');
        }
        try out.append(self.allocator, ']');
        try appendStringsField(&out, self.allocator, "ungrounded", verdict.ungrounded);
        try appendStringsField(&out, self.allocator, "grounding_gaps", verdict.ungrounded);
        try appendStringsField(&out, self.allocator, "ungated", verdict.ungated);
        try appendStringsField(&out, self.allocator, "gating_gaps", verdict.ungated);
        try out.append(self.allocator, '}');
        return out.toOwnedSlice(self.allocator);
    }
};

fn requiredString(obj: std.json.ObjectMap, key: []const u8) ![]const u8 {
    return stringValue(obj.get(key) orelse return error.InvalidWalk);
}
fn stringValue(value: std.json.Value) ![]const u8 {
    return if (value == .string) value.string else error.InvalidWalk;
}
fn activeStatus(status: []const u8) !bool {
    // Keep this exhaustive with the authoritative JesusNodeStatus walk enum.
    // Treating a new spelling as settled would silently release dependants.
    if (std.mem.eql(u8, status, "pending") or
        std.mem.eql(u8, status, "in_progress") or
        std.mem.eql(u8, status, "blocked")) return true;
    if (std.mem.eql(u8, status, "settled")) return false;
    return error.InvalidWalk;
}
fn parseStringArray(allocator: std.mem.Allocator, obj: std.json.ObjectMap, key: []const u8, required: bool) ![]const []const u8 {
    const value = obj.get(key) orelse {
        if (required) return error.InvalidWalk;
        return allocator.alloc([]const u8, 0);
    };
    if (value != .array) return error.InvalidWalk;
    var list: std.ArrayListUnmanaged([]const u8) = .empty;
    errdefer freeStringList(allocator, &list);
    for (value.array.items) |item| {
        const text = try stringValue(item);
        if (text.len == 0) return error.InvalidWalk;
        for (list.items) |prior| if (std.mem.eql(u8, prior, text)) return error.InvalidWalk;
        const owned_text = try allocator.dupe(u8, text);
        errdefer allocator.free(owned_text);
        try list.append(allocator, owned_text);
    }
    std.mem.sort([]const u8, list.items, {}, lessString);
    return list.toOwnedSlice(allocator);
}
fn fieldHasStrings(obj: std.json.ObjectMap, key: []const u8) !bool {
    const value = obj.get(key) orelse return false;
    if (value != .array) return error.InvalidWalk;
    var populated = false;
    for (value.array.items) |item| {
        const text = try stringValue(item);
        if (text.len == 0) return error.InvalidWalk;
        populated = true;
    }
    return populated;
}
fn lessString(_: void, a: []const u8, b: []const u8) bool {
    return std.mem.order(u8, a, b) == .lt;
}
fn lessNode(_: void, a: GraphPlan.NodeEntry, b: GraphPlan.NodeEntry) bool {
    return lessString({}, a.id, b.id);
}
fn lessUnknown(_: void, a: GraphPlan.UnknownDependency, b: GraphPlan.UnknownDependency) bool {
    const order = std.mem.order(u8, a.node, b.node);
    return order == .lt or (order == .eq and lessString({}, a.dependency, b.dependency));
}
fn findNode(entries: []const GraphPlan.NodeEntry, id: []const u8) ?usize {
    for (entries, 0..) |entry, index| if (std.mem.eql(u8, entry.id, id)) return index;
    return null;
}
fn findActive(entries: []const GraphPlan.NodeEntry, id: []const u8) bool {
    const index = findNode(entries, id) orelse return false;
    return entries[index].active;
}

/// Match one path scope. `*` stays inside a component; `**` may cross `/`.
fn globMatch(pattern: []const u8, path: []const u8) bool {
    return globMatchAt(pattern, 0, path, 0);
}
fn globMatchAt(pattern: []const u8, pi: usize, path: []const u8, si: usize) bool {
    if (pi == pattern.len) return si == path.len;
    if (pattern[pi] == '*') {
        if (pi + 1 < pattern.len and pattern[pi + 1] == '*') {
            var next = si;
            while (next <= path.len) : (next += 1) if (globMatchAt(pattern, pi + 2, path, next)) return true;
            return false;
        }
        var next = si;
        while (next <= path.len and (next == si or path[next - 1] != '/')) : (next += 1)
            if (globMatchAt(pattern, pi + 1, path, next)) return true;
        return false;
    }
    if (si == path.len) return false;
    if (pattern[pi] == '?' or pattern[pi] == path[si]) return globMatchAt(pattern, pi + 1, path, si + 1);
    return false;
}
fn literalPrefix(scope: []const u8) []const u8 {
    for (scope, 0..) |byte, index| if (byte == '*' or byte == '?') return scope[0..index];
    return scope;
}
fn directoryContains(directory: []const u8, path: []const u8) bool {
    if (!std.mem.endsWith(u8, directory, "/")) return false;
    return std.mem.startsWith(u8, path, directory);
}
fn hasGlob(scope: []const u8) bool {
    return std.mem.indexOfAny(u8, scope, "*?") != null;
}
fn scopeOverlap(a: []const u8, b: []const u8) bool {
    if (std.mem.eql(u8, a, b) or globMatch(a, b) or globMatch(b, a)) return true;
    const a_glob = hasGlob(a);
    const b_glob = hasGlob(b);
    if (a_glob != b_glob) {
        const pattern = if (a_glob) a else b;
        const literal = if (a_glob) b else a;
        // A concrete file was decided by the direct match above. A directory
        // denotes every path beneath it, so only divergent mandatory prefixes
        // prove that the pattern cannot write somewhere inside that scope.
        if (!std.mem.endsWith(u8, literal, "/")) return false;
        const prefix = literalPrefix(pattern);
        return std.mem.startsWith(u8, prefix, literal) or std.mem.startsWith(u8, literal, prefix);
    }
    if (!a_glob) return directoryContains(a, b) or directoryContains(b, a);
    // Two patterns cannot in general be intersected without constructing an
    // automaton. Their literal prefixes prove disjointness only when they
    // diverge. Nested (including empty) prefixes remain possible intersections
    // and must collide; false positives are safer than concurrent writers.
    const ap = literalPrefix(a);
    const bp = literalPrefix(b);
    return std.mem.startsWith(u8, ap, bp) or std.mem.startsWith(u8, bp, ap);
}

fn freeNode(allocator: std.mem.Allocator, entry: GraphPlan.NodeEntry) void {
    allocator.free(entry.id);
    allocator.free(entry.plan);
    freeStrings(allocator, entry.deps);
    freeStrings(allocator, entry.writes);
}
fn freeStrings(allocator: std.mem.Allocator, strings: []const []const u8) void {
    for (strings) |string| allocator.free(string);
    allocator.free(strings);
}
fn freeStringList(allocator: std.mem.Allocator, list: *std.ArrayListUnmanaged([]const u8)) void {
    for (list.items) |string| allocator.free(string);
    list.deinit(allocator);
}
fn freeGroups(allocator: std.mem.Allocator, groups: []const []const []const u8) void {
    for (groups) |group| freeStrings(allocator, group);
    allocator.free(groups);
}
fn freeGroupList(allocator: std.mem.Allocator, groups: *std.ArrayListUnmanaged([]const []const u8)) void {
    for (groups.items) |group| freeStrings(allocator, group);
    groups.deinit(allocator);
    groups.* = .empty;
}
fn freeUnknown(allocator: std.mem.Allocator, gaps: []const GraphPlan.UnknownDependency) void {
    for (gaps) |gap| {
        allocator.free(gap.node);
        allocator.free(gap.dependency);
    }
    allocator.free(gaps);
}
fn freeUnknownList(allocator: std.mem.Allocator, gaps: *std.ArrayListUnmanaged(GraphPlan.UnknownDependency)) void {
    for (gaps.items) |gap| {
        allocator.free(gap.node);
        allocator.free(gap.dependency);
    }
    gaps.deinit(allocator);
    gaps.* = .empty;
}
fn freeCollisions(allocator: std.mem.Allocator, collisions: []const GraphPlan.Collision) void {
    for (collisions) |collision| {
        allocator.free(collision.a);
        allocator.free(collision.b);
        freeStrings(allocator, collision.shared);
    }
    allocator.free(collisions);
}
fn freeCollisionList(allocator: std.mem.Allocator, collisions: *std.ArrayListUnmanaged(GraphPlan.Collision)) void {
    for (collisions.items) |collision| {
        allocator.free(collision.a);
        allocator.free(collision.b);
        freeStrings(allocator, collision.shared);
    }
    collisions.deinit(allocator);
    collisions.* = .empty;
}
fn cloneStrings(allocator: std.mem.Allocator, strings: []const []const u8) ![]const []const u8 {
    var out = try allocator.alloc([]const u8, strings.len);
    errdefer allocator.free(out);
    var initialized: usize = 0;
    errdefer for (out[0..initialized]) |string| allocator.free(string);
    for (strings, 0..) |string, index| {
        out[index] = try allocator.dupe(u8, string);
        initialized += 1;
    }
    return out;
}
fn cloneGroups(allocator: std.mem.Allocator, groups: []const []const []const u8) ![]const []const []const u8 {
    var out = try allocator.alloc([]const []const u8, groups.len);
    errdefer allocator.free(out);
    var initialized: usize = 0;
    errdefer for (out[0..initialized]) |group| freeStrings(allocator, group);
    for (groups, 0..) |group, index| {
        out[index] = try cloneStrings(allocator, group);
        initialized += 1;
    }
    return out;
}
fn appendJsonString(out: *std.ArrayList(u8), allocator: std.mem.Allocator, value: []const u8) !void {
    try out.append(allocator, '"');
    for (value) |byte| switch (byte) {
        '"' => try out.appendSlice(allocator, "\\\""),
        '\\' => try out.appendSlice(allocator, "\\\\"),
        '\n' => try out.appendSlice(allocator, "\\n"),
        '\r' => try out.appendSlice(allocator, "\\r"),
        '\t' => try out.appendSlice(allocator, "\\t"),
        else => if (byte < 0x20)
            try out.print(allocator, "\\u00{x:0>2}", .{byte})
        else
            try out.append(allocator, byte),
    };
    try out.append(allocator, '"');
}
fn appendStringValues(out: *std.ArrayList(u8), allocator: std.mem.Allocator, values: []const []const u8) !void {
    for (values, 0..) |value, index| {
        if (index != 0) try out.append(allocator, ',');
        try appendJsonString(out, allocator, value);
    }
}
fn appendStringsField(out: *std.ArrayList(u8), allocator: std.mem.Allocator, name: []const u8, values: []const []const u8) !void {
    try out.appendSlice(allocator, ",\"");
    try out.appendSlice(allocator, name);
    try out.appendSlice(allocator, "\":[");
    try appendStringValues(out, allocator, values);
    try out.append(allocator, ']');
}
fn appendGroups(out: *std.ArrayList(u8), allocator: std.mem.Allocator, name: []const u8, groups: []const []const []const u8) !void {
    try out.appendSlice(allocator, ",\"");
    try out.appendSlice(allocator, name);
    try out.appendSlice(allocator, "\":[");
    for (groups, 0..) |group, index| {
        if (index != 0) try out.append(allocator, ',');
        try out.append(allocator, '[');
        try appendStringValues(out, allocator, group);
        try out.append(allocator, ']');
    }
    try out.append(allocator, ']');
}

const allocation_test_walk =
    \\{"nodes":[
    \\ {"id":"e","plan":"evaluate","depends_on":["a"],"status":"pending","writes":["reports/e.json"],"how":"eval","invoke_skills":["review"],"witness":"test -e reports/e.json"},
    \\ {"id":"d","plan":"build","depends_on":["a"],"status":"pending","writes":["src/d.zig"]},
    \\ {"id":"c","plan":"build","depends_on":["a"],"status":"pending","writes":["src/c.zig"],"inspire_from":["design"]},
    \\ {"id":"b","plan":"sibling","depends_on":[],"status":"pending","writes":["src/**"]},
    \\ {"id":"a","plan":"root","depends_on":[],"status":"pending","writes":["src/"],"invoke_skills":["graph"],"witness":"true"}
    \\]}
;

fn allocationSafeAnalyze(allocator: std.mem.Allocator) !void {
    var planner = GraphPlan{ .allocator = allocator };
    var verdict = try planner.analyze(allocation_test_walk);
    defer verdict.deinit(allocator);
    try std.testing.expect(verdict.write_collisions.len != 0);
    try std.testing.expect(verdict.ungrounded.len != 0);
    try std.testing.expect(verdict.ungated.len != 0);
}

fn allocationSafeSerialization(allocator: std.mem.Allocator) !void {
    var planner = GraphPlan{ .allocator = allocator };
    var verdict = try planner.analyze(allocation_test_walk);
    defer verdict.deinit(allocator);
    const encoded = try planner.toJson(&verdict);
    defer allocator.free(encoded);
    try std.testing.expect(std.mem.indexOf(u8, encoded, "\"write_collisions\"") != null);
}

test "graph analysis is allocation-failure safe" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationSafeAnalyze, .{});
}

test "graph serialization is allocation-failure safe" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationSafeSerialization, .{});
}

test "Kahn waves are deterministic and the current frontier decides graphness" {
    var planner = GraphPlan{ .allocator = std.testing.allocator };
    var verdict = try planner.analyze(
        \\{"nodes":[
        \\ {"id":"c","plan":"judge","depends_on":["a"],"status":"pending","writes":["docs/"],"invoke_skills":["review"],"witness":"true"},
        \\ {"id":"b","plan":"write","depends_on":["a"],"status":"pending","writes":["src/ui.ts"]},
        \\ {"id":"a","plan":"root","depends_on":[],"status":"pending","writes":["src/"]}
        \\]}
    );
    defer verdict.deinit(std.testing.allocator);
    try std.testing.expectEqual(GraphPlan.Verdict.Kind.chain, verdict.kind);
    try std.testing.expectEqual(@as(usize, 2), verdict.waves.len);
    try std.testing.expectEqualStrings("a", verdict.waves[0][0]);
    try std.testing.expectEqualStrings("b", verdict.waves[1][0]);
    try std.testing.expectEqualStrings("c", verdict.waves[1][1]);
    try std.testing.expectEqual(@as(usize, 1), verdict.write_collisions.len);
    try std.testing.expectEqualStrings("a", verdict.write_collisions[0].a);
    try std.testing.expectEqual(@as(usize, 2), verdict.ungrounded.len);
    try std.testing.expectEqual(@as(usize, 2), verdict.ungated.len);
}

test "independent roots form a graph" {
    var planner = GraphPlan{ .allocator = std.testing.allocator };
    var verdict = try planner.analyze(
        \\{"nodes":[{"id":"b","depends_on":[],"status":"pending"},{"id":"a","depends_on":[],"status":"pending"}]}
    );
    defer verdict.deinit(std.testing.allocator);
    try std.testing.expectEqual(GraphPlan.Verdict.Kind.graph, verdict.kind);
    try std.testing.expectEqualStrings("a", verdict.ready[0]);
    try std.testing.expectEqualStrings("b", verdict.ready[1]);
}

test "cycles and unknown dependencies fail closed" {
    var planner = GraphPlan{ .allocator = std.testing.allocator };
    var cycle = try planner.analyze(
        \\{"nodes":[{"id":"a","depends_on":["b"],"status":"pending"},{"id":"b","depends_on":["a"],"status":"pending"}]}
    );
    defer cycle.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 0), cycle.waves.len);
    try std.testing.expectEqual(@as(usize, 2), cycle.cycle_list.len);

    var unknown = try planner.analyze(
        \\{"nodes":[{"id":"a","depends_on":["missing"],"status":"pending"}]}
    );
    defer unknown.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 0), unknown.waves.len);
    try std.testing.expectEqual(@as(usize, 1), unknown.unknown_dependencies.len);
}

test "path and glob write scopes overlap component-aware" {
    try std.testing.expect(scopeOverlap("src/", "src/ui.ts"));
    try std.testing.expect(scopeOverlap("src/**", "src/ui.ts"));
    try std.testing.expect(!scopeOverlap("src/", "docs/readme.md"));
    try std.testing.expect(!scopeOverlap("src/*.zig", "src/nested/a.zig"));
    try std.testing.expect(scopeOverlap("src/", "src/**/generated.zig"));
    try std.testing.expect(scopeOverlap("src/", "**/*.zig"));
    try std.testing.expect(!scopeOverlap("src/", "docs/**/*.zig"));
    try std.testing.expect(scopeOverlap("**/*.zig", "**/foo.*"));
    try std.testing.expect(!scopeOverlap("src/**/*.zig", "docs/**/foo.*"));
}

test "broad glob collision reports are deterministic" {
    var planner = GraphPlan{ .allocator = std.testing.allocator };
    const first =
        \\{"nodes":[{"id":"b","depends_on":[],"status":"pending","writes":["**/foo.*"]},{"id":"a","depends_on":[],"status":"pending","writes":["**/*.zig"]}]}
    ;
    const reordered =
        \\{"nodes":[{"id":"a","depends_on":[],"status":"pending","writes":["**/*.zig"]},{"id":"b","depends_on":[],"status":"pending","writes":["**/foo.*"]}]}
    ;
    var a = try planner.analyze(first);
    defer a.deinit(std.testing.allocator);
    var b = try planner.analyze(reordered);
    defer b.deinit(std.testing.allocator);
    const a_json = try planner.toJson(&a);
    defer std.testing.allocator.free(a_json);
    const b_json = try planner.toJson(&b);
    defer std.testing.allocator.free(b_json);
    try std.testing.expectEqualStrings(a_json, b_json);
    try std.testing.expectEqual(@as(usize, 1), a.write_collisions.len);
    try std.testing.expectEqualStrings("**/*.zig <-> **/foo.*", a.write_collisions[0].shared[0]);
}

test "unknown walk statuses are refused" {
    var planner = GraphPlan{ .allocator = std.testing.allocator };
    try std.testing.expectError(error.InvalidWalk, planner.analyze(
        \\{"nodes":[{"id":"a","depends_on":[],"status":"pendng"},{"id":"b","depends_on":["a"],"status":"pending"}]}
    ));
    try std.testing.expectError(error.InvalidWalk, planner.analyze(
        \\{"nodes":[{"id":"a","depends_on":[],"status":"future"}]}
    ));
}

test "malformed walks are refused" {
    var planner = GraphPlan{ .allocator = std.testing.allocator };
    try std.testing.expectError(error.InvalidWalk, planner.analyze("{}"));
    try std.testing.expectError(error.InvalidWalk, planner.analyze("{\"nodes\":{}}"));
    try std.testing.expectError(error.InvalidWalk, planner.analyze("{\"nodes\":[{\"id\":\"a\",\"status\":\"pending\"}]}"));
}
