//! Learned binary muscle memory and bounded fractal execution planning.
//!
//! Each real invocation trains two related cells:
//!   1. an EBM context prototype, used to recall which binary fits a new goal;
//!   2. a JEPA-style transition delta, used to predict how that binary changes
//!      a sanitized machine-state descriptor.
//!
//! Composite contracts are a DAG. A pointer may expand into child pointers,
//! but expansion is bounded and cycle-checked. Independent ready children share
//! a wave and may execute in parallel. A parent receives positive reinforcement
//! only after all of its children have externally grounded successful outcomes.

const std = @import("std");
const embed = @import("embed.zig");
const ebm = @import("ebm.zig");

pub const MAX_BINARIES = 64;
pub const MAX_NODES = 128;
pub const MAX_WAVES = 32;
pub const MAX_PARALLEL = 16;
const GROUNDED_SUCCESS_REWARD: f64 = 1.0;
const GROUNDED_FAILURE_REWARD: f64 = -1.0;

pub const Invocation = struct {
    context: []const u8,
    binary: []const u8,
    before: []const u8,
    after: []const u8,
    reward: f64,
};

const Transition = struct {
    delta: [embed.DIM]f32 = [_]f32{0} ** embed.DIM,
    weight: f64 = 0,

    fn train(self: *Transition, before: []const u8, after: []const u8, reward: f64) void {
        if (reward == 0) return;
        var a: [embed.DIM]f32 = undefined;
        var b: [embed.DIM]f32 = undefined;
        embed.embed(before, &a);
        embed.embed(after, &b);
        const next_weight = self.weight + @abs(reward);
        const alpha: f32 = @floatCast(@abs(reward) / next_weight);
        const direction: f32 = if (reward > 0) 1 else -1;
        for (&self.delta, 0..) |*value, index| {
            const observed = (b[index] - a[index]) * direction;
            value.* += alpha * (observed - value.*);
        }
        self.weight = next_weight;
    }

    fn trainDelta(self: *Transition, observed_delta: []const f32, reward: f64) void {
        if (reward == 0 or observed_delta.len != embed.DIM) return;
        const next_weight = self.weight + @abs(reward);
        const alpha: f32 = @floatCast(@abs(reward) / next_weight);
        const direction: f32 = if (reward > 0) 1 else -1;
        for (&self.delta, 0..) |*value, index| {
            const observed = observed_delta[index] * direction;
            value.* += alpha * (observed - value.*);
        }
        self.weight = next_weight;
    }

    fn energy(self: Transition, before: []const u8, target: []const u8) f64 {
        if (self.weight <= 0) return std.math.inf(f64);
        var a: [embed.DIM]f32 = undefined;
        var goal: [embed.DIM]f32 = undefined;
        embed.embed(before, &a);
        embed.embed(target, &goal);
        var squared: f64 = 0;
        for (0..embed.DIM) |index| {
            const predicted = a[index] + self.delta[index];
            const error_value = @as(f64, predicted - goal[index]);
            squared += error_value * error_value;
        }
        return squared;
    }
};

const Cell = struct {
    binary_bytes: [128]u8 = [_]u8{0} ** 128,
    binary_len: usize = 0,
    context: ebm.Prototype = .{},
    transition: Transition = .{},
    fires: usize = 0,
    successes: usize = 0,
    failures: usize = 0,

    fn binary(self: *const Cell) []const u8 {
        return self.binary_bytes[0..self.binary_len];
    }
};

pub const Bank = struct {
    cells: [MAX_BINARIES]Cell = undefined,
    count: usize = 0,

    fn find(self: *Bank, binary: []const u8) ?*Cell {
        for (self.cells[0..self.count]) |*cell| {
            if (std.mem.eql(u8, cell.binary(), binary)) return cell;
        }
        return null;
    }

    fn ensure(self: *Bank, binary: []const u8) !*Cell {
        if (self.find(binary)) |cell| return cell;
        if (self.count >= MAX_BINARIES) return error.TooManyBinaries;
        if (binary.len > 128) return error.BinaryNameTooLong;
        self.cells[self.count] = .{};
        @memcpy(self.cells[self.count].binary_bytes[0..binary.len], binary);
        self.cells[self.count].binary_len = binary.len;
        self.count += 1;
        return &self.cells[self.count - 1];
    }

    pub fn observe(self: *Bank, invocation: Invocation) !void {
        if (invocation.binary.len == 0 or invocation.context.len == 0) return error.InvalidInvocation;
        const cell = try self.ensure(invocation.binary);
        // Recall context is authorization evidence, so only grounded outcomes
        // may train it. Fractional observations belong exclusively to the
        // transition model and must not broaden a later successful reflex.
        if (invocation.reward >= GROUNDED_SUCCESS_REWARD or invocation.reward <= GROUNDED_FAILURE_REWARD) {
            cell.context.foldText(invocation.context, @abs(invocation.reward));
        }
        cell.transition.train(invocation.before, invocation.after, invocation.reward);
        cell.fires += 1;
        // Fractional rewards are transition evidence, not authorization
        // evidence. A changed frame may train the world model without proving
        // that the action advanced the task.
        if (invocation.reward >= GROUNDED_SUCCESS_REWARD) {
            cell.successes += 1;
        } else if (invocation.reward <= GROUNDED_FAILURE_REWARD) {
            cell.failures += 1;
        }
    }

    /// Encode privacy-safe training evidence. Text is embedded before it
    /// reaches durable storage; only the capability name, reward and numeric
    /// context/transition vectors are retained.
    pub fn encodeObservation(allocator: std.mem.Allocator, invocation: Invocation) ![]u8 {
        var context_vec: [embed.DIM]f32 = undefined;
        var before_vec: [embed.DIM]f32 = undefined;
        var after_vec: [embed.DIM]f32 = undefined;
        embed.embed(invocation.context, &context_vec);
        embed.embed(invocation.before, &before_vec);
        embed.embed(invocation.after, &after_vec);
        var out: std.ArrayList(u8) = .empty;
        defer out.deinit(allocator);
        try out.appendSlice(allocator, "{\"event\":\"muscle_observed\",\"binary\":\"");
        for (invocation.binary) |byte| switch (byte) {
            '"' => try out.appendSlice(allocator, "\\\""),
            '\\' => try out.appendSlice(allocator, "\\\\"),
            0...31 => try out.append(allocator, '_'),
            else => try out.append(allocator, byte),
        };
        try out.appendSlice(allocator, "\",\"reward\":");
        try out.print(allocator, "{d},\"context\":[", .{invocation.reward});
        for (context_vec, 0..) |value, index| {
            if (index > 0) try out.append(allocator, ',');
            try out.print(allocator, "{d}", .{value});
        }
        try out.appendSlice(allocator, "],\"delta\":[");
        for (before_vec, after_vec, 0..) |before_value, after_value, index| {
            if (index > 0) try out.append(allocator, ',');
            try out.print(allocator, "{d}", .{after_value - before_value});
        }
        try out.appendSlice(allocator, "]}");
        return out.toOwnedSlice(allocator);
    }

    /// Replay one durable vector observation without needing original user or
    /// machine text. Malformed or wrong-width rows fail closed.
    pub fn replayObservation(self: *Bank, row: []const u8) !void {
        var parsed = try std.json.parseFromSlice(std.json.Value, std.heap.page_allocator, row, .{});
        defer parsed.deinit();
        if (parsed.value != .object) return error.InvalidInvocation;
        const object = parsed.value.object;
        const event = object.get("event") orelse return error.InvalidInvocation;
        if (event != .string or !std.mem.eql(u8, event.string, "muscle_observed")) return error.InvalidInvocation;
        const binary_value = object.get("binary") orelse return error.InvalidInvocation;
        const reward_value = object.get("reward") orelse return error.InvalidInvocation;
        const context_value = object.get("context") orelse return error.InvalidInvocation;
        const delta_value = object.get("delta") orelse return error.InvalidInvocation;
        if (binary_value != .string or context_value != .array or delta_value != .array) return error.InvalidInvocation;
        if (context_value.array.items.len != embed.DIM or delta_value.array.items.len != embed.DIM) return error.InvalidInvocation;
        const reward: f64 = switch (reward_value) {
            .float => |value| value,
            .integer => |value| @floatFromInt(value),
            else => return error.InvalidInvocation,
        };
        var context_vec: [embed.DIM]f32 = undefined;
        var delta_vec: [embed.DIM]f32 = undefined;
        for (context_value.array.items, 0..) |value, index| context_vec[index] = switch (value) {
            .float => |number| @floatCast(number),
            .integer => |number| @floatFromInt(number),
            else => return error.InvalidInvocation,
        };
        for (delta_value.array.items, 0..) |value, index| delta_vec[index] = switch (value) {
            .float => |number| @floatCast(number),
            .integer => |number| @floatFromInt(number),
            else => return error.InvalidInvocation,
        };
        const cell = try self.ensure(binary_value.string);
        if (reward >= GROUNDED_SUCCESS_REWARD or reward <= GROUNDED_FAILURE_REWARD) {
            cell.context.fold(&context_vec, @abs(reward));
        }
        cell.transition.trainDelta(&delta_vec, reward);
        cell.fires += 1;
        if (reward >= GROUNDED_SUCCESS_REWARD) {
            cell.successes += 1;
        } else if (reward <= GROUNDED_FAILURE_REWARD) {
            cell.failures += 1;
        }
    }

    pub fn delete(self: *Bank, binary: []const u8) bool {
        for (self.cells[0..self.count], 0..) |*cell, index| {
            if (!std.mem.eql(u8, cell.binary(), binary)) continue;
            if (index + 1 < self.count) self.cells[index] = self.cells[self.count - 1];
            self.count -= 1;
            return true;
        }
        return false;
    }

    pub const Candidate = struct {
        binary: []const u8,
        energy: f64,
        context_energy: f64,
        transition_energy: ?f64,
        fires: usize,
        successes: usize,
        failures: usize,
        confidence: f64,
    };

    /// Rank every warm cell. Lower energy is better. Grounded successes lower
    /// energy; failures raise it. Confidence is evidence-calibrated and cannot
    /// reach the automatic-reflex threshold from raw ungrounded volume.
    pub fn rank(
        self: *const Bank,
        context: []const u8,
        before: ?[]const u8,
        target: ?[]const u8,
        output: *[MAX_BINARIES]Candidate,
    ) usize {
        var count: usize = 0;
        for (self.cells[0..self.count]) |*cell| {
            const context_energy = ebm.energyText(cell.context, context);
            if (!std.math.isFinite(context_energy)) continue;
            const transition_energy = if (before != null and target != null)
                cell.transition.energy(before.?, target.?)
            else
                null;
            const evidence = cell.successes + cell.failures;
            const confidence = if (evidence == 0)
                0
            else
                @as(f64, @floatFromInt(cell.successes)) / @as(f64, @floatFromInt(evidence));
            const failure_penalty = @as(f64, @floatFromInt(cell.failures)) * 0.35;
            const grounded_bonus = @as(f64, @floatFromInt(@min(cell.successes, 10))) * 0.05;
            output[count] = .{
                .binary = cell.binary(),
                .energy = context_energy + (transition_energy orelse 0) + failure_penalty - grounded_bonus,
                .context_energy = context_energy,
                .transition_energy = transition_energy,
                .fires = cell.fires,
                .successes = cell.successes,
                .failures = cell.failures,
                .confidence = confidence,
            };
            count += 1;
        }
        std.mem.sort(Candidate, output[0..count], {}, struct {
            fn lessThan(_: void, lhs: Candidate, rhs: Candidate) bool {
                if (lhs.energy == rhs.energy) return std.mem.lessThan(u8, lhs.binary, rhs.binary);
                return lhs.energy < rhs.energy;
            }
        }.lessThan);
        return count;
    }

    /// Recall a grounded successful capability by semantic use-context. Dense
    /// transition evidence remains available to rank/predict, but cannot turn
    /// an experiment into an authorized reflex.
    pub fn recall(self: *const Bank, context: []const u8) ?[]const u8 {
        var best: ?[]const u8 = null;
        var best_energy = std.math.inf(f64);
        for (0..self.count) |index| {
            const cell = &self.cells[index];
            if (cell.successes == 0) continue;
            const value = ebm.energyText(cell.context, context) + outcomePenalty(cell);
            if (value < best_energy) {
                best_energy = value;
                best = cell.binary();
            }
        }
        return best;
    }

    /// JEPA planning: choose the binary whose learned transition brings the
    /// current machine state closest to the requested target state.
    pub fn predict(self: *const Bank, before: []const u8, target: []const u8) ?[]const u8 {
        var best: ?[]const u8 = null;
        var best_energy = std.math.inf(f64);
        for (0..self.count) |index| {
            const cell = &self.cells[index];
            const value = cell.transition.energy(before, target) + outcomePenalty(cell);
            if (value < best_energy) {
                best_energy = value;
                best = cell.binary();
            }
        }
        return best;
    }

    /// Grounding is part of the energy, not a post-hoc annotation. Repeated
    /// failures inhibit a superficially similar reflex while successful uses
    /// reinforce it. Keeping this shared by recall, prediction, and rank makes
    /// the learned world model behave consistently on every host.
    fn outcomePenalty(cell: *const Cell) f64 {
        return @as(f64, @floatFromInt(cell.failures)) * 0.35 -
            @as(f64, @floatFromInt(@min(cell.successes, 10))) * 0.05;
    }
};

pub const Node = struct {
    id: []const u8,
    children: []const usize = &.{},
    depends_on: []const usize = &.{},
    outcome: ?bool = null,
};

pub const Schedule = struct {
    waves: [MAX_WAVES][MAX_PARALLEL]usize = [_][MAX_PARALLEL]usize{[_]usize{0} ** MAX_PARALLEL} ** MAX_WAVES,
    counts: [MAX_WAVES]usize = [_]usize{0} ** MAX_WAVES,
    wave_count: usize = 0,
};

fn markReachable(nodes: []const Node, index: usize, depth: usize, marks: []bool, visiting: []bool) !void {
    if (index >= nodes.len) return error.InvalidPointer;
    if (depth >= MAX_WAVES) return error.DepthExceeded;
    if (visiting[index]) return error.PointerCycle;
    if (marks[index]) return;
    visiting[index] = true;
    marks[index] = true;
    if (nodes[index].children.len > MAX_PARALLEL) return error.FanoutExceeded;
    for (nodes[index].children) |child| try markReachable(nodes, child, depth + 1, marks, visiting);
    visiting[index] = false;
}

/// Expand a root pointer into bounded topological waves. All members of a wave
/// are dependency-independent and therefore safe for the host to run in parallel.
pub fn schedule(nodes: []const Node, root: usize) !Schedule {
    if (nodes.len == 0 or nodes.len > MAX_NODES) return error.InvalidPointer;
    var reachable = [_]bool{false} ** MAX_NODES;
    var visiting = [_]bool{false} ** MAX_NODES;
    try markReachable(nodes, root, 0, reachable[0..nodes.len], visiting[0..nodes.len]);
    var emitted = [_]bool{false} ** MAX_NODES;
    var result: Schedule = .{};
    var remaining: usize = 0;
    for (reachable[0..nodes.len]) |value| if (value) {
        remaining += 1;
    };

    while (remaining > 0) {
        if (result.wave_count >= MAX_WAVES) return error.DepthExceeded;
        var count: usize = 0;
        for (nodes, 0..) |node, index| {
            if (!reachable[index] or emitted[index]) continue;
            var ready = true;
            for (node.depends_on) |dependency| {
                if (dependency >= nodes.len or (reachable[dependency] and !emitted[dependency])) ready = false;
            }
            if (ready) {
                if (count >= MAX_PARALLEL) return error.FanoutExceeded;
                result.waves[result.wave_count][count] = index;
                count += 1;
            }
        }
        if (count == 0) return error.DependencyCycle;
        result.counts[result.wave_count] = count;
        for (result.waves[result.wave_count][0..count]) |index| {
            emitted[index] = true;
            remaining -= 1;
        }
        result.wave_count += 1;
    }
    return result;
}

/// Mechanically grounded parent feedback. Unknown or failed children prohibit
/// positive parent training; only a completely witnessed child set returns +1.
pub fn groundedReward(nodes: []const Node, parent: usize) f64 {
    if (parent >= nodes.len or nodes[parent].children.len == 0) return 0;
    for (nodes[parent].children) |child| {
        if (child >= nodes.len) return -1;
        const outcome = nodes[child].outcome orelse return 0;
        if (!outcome) return -1;
    }
    return 1;
}

test "actual binary usage becomes semantic muscle memory" {
    var bank: Bank = .{};
    try bank.observe(.{ .context = "find a phrase recursively", .binary = "rg", .before = "unknown files", .after = "matching source lines", .reward = 1 });
    try bank.observe(.{ .context = "search source text", .binary = "rg", .before = "unknown files", .after = "matching source lines", .reward = 1 });
    try bank.observe(.{ .context = "compile the native library", .binary = "zig", .before = "source tree", .after = "built library", .reward = 1 });
    try std.testing.expectEqualStrings("rg", bank.recall("search for source text").?);
    try std.testing.expectEqualStrings("zig", bank.recall("compile native library").?);
}

test "JEPA transition chooses the binary predicted to reach the target state" {
    var bank: Bank = .{};
    try bank.observe(.{ .context = "inspect", .binary = "rg", .before = "source tree", .after = "matching source lines", .reward = 1 });
    try bank.observe(.{ .context = "build", .binary = "zig", .before = "source tree", .after = "built library", .reward = 1 });
    try std.testing.expectEqualStrings("zig", bank.predict("source tree", "built library").?);
    try std.testing.expectEqualStrings("rg", bank.predict("source tree", "matching source lines").?);
}

test "fractional transition evidence does not become grounded recall" {
    var bank: Bank = .{};
    try bank.observe(.{
        .context = "novel visual state",
        .binary = "experimental-click",
        .before = "object present",
        .after = "object recolored",
        .reward = 0.15,
    });
    try std.testing.expect(bank.recall("novel visual state") == null);
    try std.testing.expectEqualStrings(
        "experimental-click",
        bank.predict("object present", "object recolored").?,
    );
    var ranked: [MAX_BINARIES]Bank.Candidate = undefined;
    // Transition-only cells have no authorization context and are therefore
    // absent from context ranking even though JEPA prediction can use them.
    try std.testing.expectEqual(@as(usize, 0), bank.rank("novel visual state", null, null, &ranked));
    try bank.observe(.{
        .context = "novel visual state",
        .binary = "experimental-click",
        .before = "object recolored",
        .after = "level progressed",
        .reward = 1,
    });
    try std.testing.expectEqual(@as(usize, 1), bank.rank("novel visual state", null, null, &ranked));
    try std.testing.expectEqual(@as(usize, 1), ranked[0].successes);
    try std.testing.expectEqual(@as(usize, 0), ranked[0].failures);
    try std.testing.expectEqual(@as(f64, 1), ranked[0].confidence);
}

test "failed reflexes are inhibited in both semantic recall and JEPA prediction" {
    var bank: Bank = .{};
    try bank.observe(.{ .context = "open matching object", .binary = "failed-click", .before = "closed", .after = "open", .reward = -1 });
    try bank.observe(.{ .context = "open matching object", .binary = "failed-click", .before = "closed", .after = "open", .reward = -1 });
    try bank.observe(.{ .context = "open matching object", .binary = "grounded-click", .before = "closed", .after = "open", .reward = 1 });
    try std.testing.expectEqualStrings("grounded-click", bank.recall("open matching object").?);
    try std.testing.expectEqualStrings("grounded-click", bank.predict("closed", "open").?);
}

test "vector observations survive stateless replay without retaining raw text" {
    const invocation: Invocation = .{
        .context = "private user intent search source",
        .binary = "rg",
        .before = "unknown files",
        .after = "matching lines",
        .reward = 1,
    };
    const encoded = try Bank.encodeObservation(std.testing.allocator, invocation);
    defer std.testing.allocator.free(encoded);
    try std.testing.expect(std.mem.indexOf(u8, encoded, "private user intent") == null);
    var restored: Bank = .{};
    try restored.replayObservation(encoded);
    try std.testing.expectEqualStrings("rg", restored.recall("search source").?);
    try std.testing.expectEqualStrings("rg", restored.predict("unknown files", "matching lines").?);
}

test "rank exposes multiple candidates and grounded failure raises energy" {
    var bank: Bank = .{};
    try bank.observe(.{ .context = "search source", .binary = "rg", .before = "tree", .after = "matches", .reward = 1 });
    try bank.observe(.{ .context = "search source", .binary = "grep", .before = "tree", .after = "matches", .reward = 1 });
    var ranked: [MAX_BINARIES]Bank.Candidate = undefined;
    const before_count = bank.rank("search source", null, null, &ranked);
    try std.testing.expectEqual(@as(usize, 2), before_count);
    const rg_before = if (std.mem.eql(u8, ranked[0].binary, "rg")) ranked[0].energy else ranked[1].energy;
    try bank.observe(.{ .context = "search source", .binary = "rg", .before = "tree", .after = "error", .reward = -1 });
    const after_count = bank.rank("search source", null, null, &ranked);
    try std.testing.expectEqual(@as(usize, 2), after_count);
    const rg_after = if (std.mem.eql(u8, ranked[0].binary, "rg")) ranked[0].energy else ranked[1].energy;
    try std.testing.expect(rg_after > rg_before);
    try std.testing.expect(bank.delete("rg"));
    try std.testing.expectEqual(@as(usize, 1), bank.rank("search source", null, null, &ranked));
}

test "pointer trees expand recursively into parallel dependency waves" {
    const root_children = [_]usize{ 1, 2, 3 };
    const child3_deps = [_]usize{ 1, 2 };
    const grandchild = [_]usize{4};
    const nodes = [_]Node{
        .{ .id = "root", .children = &root_children },
        .{ .id = "inspect" },
        .{ .id = "test" },
        .{ .id = "judge", .children = &grandchild, .depends_on = &child3_deps },
        .{ .id = "report", .depends_on = &[_]usize{3} },
    };
    const plan = try schedule(&nodes, 0);
    try std.testing.expectEqual(@as(usize, 3), plan.wave_count);
    // Root, inspect and test have no dependencies and can share the first wave.
    try std.testing.expectEqual(@as(usize, 3), plan.counts[0]);
    try std.testing.expectEqual(@as(usize, 1), plan.counts[1]);
    try std.testing.expectEqual(@as(usize, 1), plan.counts[2]);
}

test "parent reward requires grounded child feedback" {
    const children = [_]usize{ 1, 2 };
    var nodes = [_]Node{
        .{ .id = "root", .children = &children },
        .{ .id = "a", .outcome = true },
        .{ .id = "b", .outcome = null },
    };
    try std.testing.expectEqual(@as(f64, 0), groundedReward(&nodes, 0));
    nodes[2].outcome = false;
    try std.testing.expectEqual(@as(f64, -1), groundedReward(&nodes, 0));
    nodes[2].outcome = true;
    try std.testing.expectEqual(@as(f64, 1), groundedReward(&nodes, 0));
}

test "recursive pointer cycles are refused" {
    const a = [_]usize{1};
    const b = [_]usize{0};
    const nodes = [_]Node{ .{ .id = "a", .children = &a }, .{ .id = "b", .children = &b } };
    try std.testing.expectError(error.PointerCycle, schedule(&nodes, 0));
}
