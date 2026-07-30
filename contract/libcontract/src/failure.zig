//! Priority bad-news propagation and deterministic recovery routing.

const std = @import("std");

pub const FailureKind = enum {
    action_failure,
    contradiction,
    sensor_loss,
    anchor_expiry,
    capability_breach,
    compromised_evidence,
};

pub const FailureEvent = struct {
    id: []const u8,
    source_node: []const u8,
    kind: FailureKind,
    observed_at_ms: i64,
    anchor_id: ?[]const u8 = null,
};

pub const Dependency = struct {
    producer: []const u8,
    consumer: []const u8,
};

pub const Invalidation = struct {
    node_id: []const u8,
    caused_by: []const u8,
    depth: u32,
    emitted_at_ms: i64,
};

pub const RecoveryCheckpoint = struct {
    id: []const u8,
    graph_version: u64,
    policy_id: []const u8,
    verified: bool,
    revoked: bool,
    activated_at_ms: i64,
};

/// Negative events always enter this queue, independent of positive cache
/// state. Output is breadth-first and contains each downstream node once.
pub fn propagate(
    allocator: std.mem.Allocator,
    event: FailureEvent,
    dependencies: []const Dependency,
    resolver_tick_ms: i64,
) ![]Invalidation {
    if (event.id.len == 0 or event.source_node.len == 0) return error.InvalidFailure;
    var out: std.ArrayList(Invalidation) = .empty;
    errdefer out.deinit(allocator);
    try out.append(allocator, .{
        .node_id = event.source_node,
        .caused_by = event.id,
        .depth = 0,
        .emitted_at_ms = resolver_tick_ms,
    });
    var cursor: usize = 0;
    while (cursor < out.items.len) : (cursor += 1) {
        const current = out.items[cursor];
        for (dependencies) |edge| {
            if (!std.mem.eql(u8, edge.producer, current.node_id)) continue;
            var seen = false;
            for (out.items) |existing| {
                if (std.mem.eql(u8, existing.node_id, edge.consumer)) {
                    seen = true;
                    break;
                }
            }
            if (!seen) try out.append(allocator, .{
                .node_id = edge.consumer,
                .caused_by = event.id,
                .depth = current.depth + 1,
                .emitted_at_ms = resolver_tick_ms,
            });
        }
    }
    return out.toOwnedSlice(allocator);
}

/// Latest verified, unrevoked checkpoint compatible with the active policy.
pub fn lastKnownGood(checkpoints: []const RecoveryCheckpoint, policy_id: []const u8) ?RecoveryCheckpoint {
    var selected: ?RecoveryCheckpoint = null;
    for (checkpoints) |candidate| {
        if (!candidate.verified or candidate.revoked) continue;
        if (!std.mem.eql(u8, candidate.policy_id, policy_id)) continue;
        if (selected == null or candidate.activated_at_ms > selected.?.activated_at_ms)
            selected = candidate;
    }
    return selected;
}

test "fresh bad news invalidates every dependant within the same resolver tick" {
    const allocator = std.testing.allocator;
    const edges = [_]Dependency{
        .{ .producer = "sensor", .consumer = "evaluator" },
        .{ .producer = "evaluator", .consumer = "action" },
        .{ .producer = "action", .consumer = "governor" },
        .{ .producer = "sensor", .consumer = "action" },
    };
    const event = FailureEvent{
        .id = "failure-1",
        .source_node = "sensor",
        .kind = .contradiction,
        .observed_at_ms = 100,
    };
    const invalidations = try propagate(allocator, event, &edges, 100);
    defer allocator.free(invalidations);
    try std.testing.expectEqual(@as(usize, 4), invalidations.len);
    for (invalidations) |invalidation|
        try std.testing.expectEqual(event.observed_at_ms, invalidation.emitted_at_ms);
}

test "recovery refuses revoked unverified and wrong-policy checkpoints" {
    const checkpoints = [_]RecoveryCheckpoint{
        .{ .id = "old", .graph_version = 1, .policy_id = "policy-1", .verified = true, .revoked = false, .activated_at_ms = 10 },
        .{ .id = "wrong", .graph_version = 2, .policy_id = "policy-2", .verified = true, .revoked = false, .activated_at_ms = 30 },
        .{ .id = "revoked", .graph_version = 3, .policy_id = "policy-1", .verified = true, .revoked = true, .activated_at_ms = 40 },
        .{ .id = "new", .graph_version = 4, .policy_id = "policy-1", .verified = true, .revoked = false, .activated_at_ms = 50 },
    };
    try std.testing.expectEqualStrings("new", lastKnownGood(&checkpoints, "policy-1").?.id);
    try std.testing.expect(lastKnownGood(&checkpoints, "absent") == null);
}
