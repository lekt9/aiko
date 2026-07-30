//! development.zig — explicit, attributable, atomic, reversible topology
//! changes. The machinery proposes graph patches; authority approves them.

const std = @import("std");
const agency = @import("agency.zig");

pub const NodeRecord = struct {
    id: []const u8,
    role: agency.NodeRole,
    cadence: agency.CadenceClass,
    owner: []const u8,
};

pub const EdgeRecord = struct {
    from: []const u8,
    to: []const u8,
    kind: agency.EdgeKind,
};

pub const EdgeKey = struct {
    from: []const u8,
    to: []const u8,
    kind: agency.EdgeKind,
};

pub const CadenceChange = struct {
    id: []const u8,
    cadence: agency.CadenceClass,
};

pub const OwnerChange = struct {
    id: []const u8,
    owner: []const u8,
};

pub const SplitLoop = struct {
    action_id: []const u8,
    sensor: NodeRecord,
    evaluator: NodeRecord,
};

pub const Operation = union(enum) {
    add_node: NodeRecord,
    remove_node: []const u8,
    replace_node: NodeRecord,
    add_edge: EdgeRecord,
    remove_edge: EdgeKey,
    change_cadence: CadenceChange,
    change_owner: OwnerChange,
    split_loop: SplitLoop,
};

pub const GraphSnapshot = struct {
    version: u64,
    nodes: []NodeRecord,
    edges: []EdgeRecord,

    pub fn deinit(self: *GraphSnapshot, allocator: std.mem.Allocator) void {
        allocator.free(self.nodes);
        allocator.free(self.edges);
        self.* = undefined;
    }
};

pub fn validateSnapshot(snapshot: GraphSnapshot) !void {
    for (snapshot.nodes, 0..) |node, i| {
        if (node.id.len == 0 or node.owner.len == 0) return error.InvalidProposal;
        for (snapshot.nodes[i + 1 ..]) |other| {
            if (std.mem.eql(u8, node.id, other.id)) return error.DuplicateNode;
        }
    }
    for (snapshot.edges, 0..) |edge, i| {
        const from = snapshot.nodes[nodeIndex(snapshot.nodes, edge.from) orelse return error.MissingNode];
        const to = snapshot.nodes[nodeIndex(snapshot.nodes, edge.to) orelse return error.MissingNode];
        try agency.validateEdge(from.role, to.role, edge.kind);
        for (snapshot.edges[i + 1 ..]) |other| {
            if (sameEdge(other, .{ .from = edge.from, .to = edge.to, .kind = edge.kind }))
                return error.DuplicateEdge;
        }
    }
}

/// Linear-time node audit for large graphs. Edge legality remains linear in
/// the number of edges plus endpoint lookups.
pub fn validateSnapshotFast(allocator: std.mem.Allocator, snapshot: GraphSnapshot) !void {
    var nodes: std.StringHashMap(agency.NodeRole) = .init(allocator);
    defer nodes.deinit();
    for (snapshot.nodes) |node| {
        if (node.id.len == 0 or node.owner.len == 0) return error.InvalidProposal;
        const entry = try nodes.getOrPut(node.id);
        if (entry.found_existing) return error.DuplicateNode;
        entry.value_ptr.* = node.role;
    }
    var edges: std.StringHashMap(void) = .init(allocator);
    defer edges.deinit();
    var owned_keys: std.ArrayList([]u8) = .empty;
    defer {
        for (owned_keys.items) |key| allocator.free(key);
        owned_keys.deinit(allocator);
    }
    for (snapshot.edges) |edge| {
        const from = nodes.get(edge.from) orelse return error.MissingNode;
        const to = nodes.get(edge.to) orelse return error.MissingNode;
        try agency.validateEdge(from, to, edge.kind);
        const key = try std.fmt.allocPrint(allocator, "{s}\x00{s}\x00{s}", .{ edge.from, edge.to, @tagName(edge.kind) });
        errdefer allocator.free(key);
        const entry = try edges.getOrPut(key);
        if (entry.found_existing) {
            allocator.free(key);
            return error.DuplicateEdge;
        }
        try owned_keys.append(allocator, key);
    }
}

pub const Proposal = struct {
    id: []const u8,
    purpose_id: []const u8,
    actor_identity: []const u8,
    required_authority: []const u8,
    rationale: []const u8,
    evidence_ids: []const []const u8,
    predicted_impact: []const u8,
    operations: []const Operation,
    rollback_operations: []const Operation,
    approved: bool,
    schema_version: u32 = 1,
};

pub const DevelopmentError = error{
    InvalidProposal,
    UnsupportedSchema,
    AuthorityRequired,
    ApprovalRequired,
    MissingNode,
    DuplicateNode,
    MissingEdge,
    DuplicateEdge,
    IllegalEdge,
    OutOfMemory,
};

fn sameEdge(a: EdgeRecord, b: EdgeKey) bool {
    return std.mem.eql(u8, a.from, b.from) and
        std.mem.eql(u8, a.to, b.to) and
        a.kind == b.kind;
}

fn nodeIndex(nodes: []const NodeRecord, id: []const u8) ?usize {
    for (nodes, 0..) |node, index| {
        if (std.mem.eql(u8, node.id, id)) return index;
    }
    return null;
}

fn edgeIndex(edges: []const EdgeRecord, key: EdgeKey) ?usize {
    for (edges, 0..) |edge, index| {
        if (sameEdge(edge, key)) return index;
    }
    return null;
}

fn sensitiveOperation(operation: Operation) bool {
    return switch (operation) {
        .remove_node, .replace_node, .change_owner, .split_loop => true,
        .add_node => |node| node.role == .purpose or node.role == .governor or node.role == .development,
        .change_cadence => |change| change.cadence == .audit or change.cadence == .purpose,
        .add_edge, .remove_edge => false,
    };
}

pub fn validateProposal(proposal: Proposal) DevelopmentError!void {
    if (proposal.schema_version != 1) return DevelopmentError.UnsupportedSchema;
    if (proposal.id.len == 0 or proposal.purpose_id.len == 0 or
        proposal.actor_identity.len == 0 or proposal.required_authority.len == 0 or
        proposal.rationale.len == 0 or proposal.predicted_impact.len == 0 or
        proposal.evidence_ids.len == 0 or proposal.operations.len == 0 or
        proposal.rollback_operations.len == 0)
        return DevelopmentError.InvalidProposal;
    if (!std.mem.eql(u8, proposal.actor_identity, proposal.required_authority))
        return DevelopmentError.AuthorityRequired;
    for (proposal.operations) |operation| {
        if (sensitiveOperation(operation) and !proposal.approved)
            return DevelopmentError.ApprovalRequired;
    }
}

fn applyOperation(
    allocator: std.mem.Allocator,
    nodes: *std.ArrayList(NodeRecord),
    edges: *std.ArrayList(EdgeRecord),
    operation: Operation,
) DevelopmentError!void {
    switch (operation) {
        .add_node => |node| {
            if (node.id.len == 0 or node.owner.len == 0) return DevelopmentError.InvalidProposal;
            if (nodeIndex(nodes.items, node.id) != null) return DevelopmentError.DuplicateNode;
            nodes.append(allocator, node) catch return DevelopmentError.OutOfMemory;
        },
        .remove_node => |id| {
            const index = nodeIndex(nodes.items, id) orelse return DevelopmentError.MissingNode;
            _ = nodes.orderedRemove(index);
            var edge_index: usize = 0;
            while (edge_index < edges.items.len) {
                const edge = edges.items[edge_index];
                if (std.mem.eql(u8, edge.from, id) or std.mem.eql(u8, edge.to, id)) {
                    _ = edges.orderedRemove(edge_index);
                } else {
                    edge_index += 1;
                }
            }
        },
        .replace_node => |node| {
            const index = nodeIndex(nodes.items, node.id) orelse return DevelopmentError.MissingNode;
            nodes.items[index] = node;
        },
        .add_edge => |edge| {
            const from_index = nodeIndex(nodes.items, edge.from) orelse return DevelopmentError.MissingNode;
            const to_index = nodeIndex(nodes.items, edge.to) orelse return DevelopmentError.MissingNode;
            if (edgeIndex(edges.items, .{ .from = edge.from, .to = edge.to, .kind = edge.kind }) != null)
                return DevelopmentError.DuplicateEdge;
            agency.validateEdge(nodes.items[from_index].role, nodes.items[to_index].role, edge.kind) catch
                return DevelopmentError.IllegalEdge;
            edges.append(allocator, edge) catch return DevelopmentError.OutOfMemory;
        },
        .remove_edge => |edge| {
            const index = edgeIndex(edges.items, edge) orelse return DevelopmentError.MissingEdge;
            _ = edges.orderedRemove(index);
        },
        .change_cadence => |change| {
            const index = nodeIndex(nodes.items, change.id) orelse return DevelopmentError.MissingNode;
            nodes.items[index].cadence = change.cadence;
        },
        .change_owner => |change| {
            if (change.owner.len == 0) return DevelopmentError.InvalidProposal;
            const index = nodeIndex(nodes.items, change.id) orelse return DevelopmentError.MissingNode;
            nodes.items[index].owner = change.owner;
        },
        .split_loop => |split| {
            const action_index = nodeIndex(nodes.items, split.action_id) orelse return DevelopmentError.MissingNode;
            if (nodes.items[action_index].role != .action or split.sensor.role != .sensor or
                split.evaluator.role != .evaluator)
                return DevelopmentError.IllegalEdge;
            try applyOperation(allocator, nodes, edges, .{ .add_node = split.sensor });
            try applyOperation(allocator, nodes, edges, .{ .add_node = split.evaluator });
            try applyOperation(allocator, nodes, edges, .{ .add_edge = .{
                .from = split.action_id,
                .to = split.sensor.id,
                .kind = .contains,
            } });
            try applyOperation(allocator, nodes, edges, .{ .add_edge = .{
                .from = split.evaluator.id,
                .to = split.sensor.id,
                .kind = .evaluates,
            } });
        },
    }
}

/// Apply on cloned arrays and publish only after every operation validates.
/// A failing operation never mutates the caller's snapshot.
pub fn apply(
    allocator: std.mem.Allocator,
    current: GraphSnapshot,
    proposal: Proposal,
) DevelopmentError!GraphSnapshot {
    try validateProposal(proposal);
    var nodes: std.ArrayList(NodeRecord) = .empty;
    defer nodes.deinit(allocator);
    var edges: std.ArrayList(EdgeRecord) = .empty;
    defer edges.deinit(allocator);
    nodes.appendSlice(allocator, current.nodes) catch return DevelopmentError.OutOfMemory;
    edges.appendSlice(allocator, current.edges) catch return DevelopmentError.OutOfMemory;
    for (proposal.operations) |operation|
        try applyOperation(allocator, &nodes, &edges, operation);
    return .{
        .version = current.version + 1,
        .nodes = nodes.toOwnedSlice(allocator) catch return DevelopmentError.OutOfMemory,
        .edges = edges.toOwnedSlice(allocator) catch return DevelopmentError.OutOfMemory,
    };
}

/// Dry-run a proposal using the exact atomic application path and then audit
/// the resulting topology. The caller owns the returned preview.
pub fn preview(
    allocator: std.mem.Allocator,
    current: GraphSnapshot,
    proposal: Proposal,
) DevelopmentError!GraphSnapshot {
    var candidate = try apply(allocator, current, proposal);
    errdefer candidate.deinit(allocator);
    validateSnapshotFast(allocator, candidate) catch return DevelopmentError.IllegalEdge;
    return candidate;
}

pub fn rollback(
    allocator: std.mem.Allocator,
    current: GraphSnapshot,
    proposal: Proposal,
) DevelopmentError!GraphSnapshot {
    var inverse = proposal;
    inverse.operations = proposal.rollback_operations;
    inverse.rollback_operations = proposal.operations;
    inverse.approved = true;
    return apply(allocator, current, inverse);
}

pub fn contentEqual(a: GraphSnapshot, b: GraphSnapshot) bool {
    if (a.nodes.len != b.nodes.len or a.edges.len != b.edges.len) return false;
    for (a.nodes, b.nodes) |left, right| {
        if (!std.mem.eql(u8, left.id, right.id) or left.role != right.role or
            left.cadence != right.cadence or !std.mem.eql(u8, left.owner, right.owner))
            return false;
    }
    for (a.edges, b.edges) |left, right| {
        if (!sameEdge(left, .{ .from = right.from, .to = right.to, .kind = right.kind }))
            return false;
    }
    return true;
}

test "approved topology patch applies and rollback restores exact content" {
    var base = GraphSnapshot{
        .version = 1,
        .nodes = try std.testing.allocator.dupe(NodeRecord, &.{
            .{ .id = "action-1", .role = .action, .cadence = .operational, .owner = "governor-1" },
        }),
        .edges = try std.testing.allocator.alloc(EdgeRecord, 0),
    };
    defer base.deinit(std.testing.allocator);
    const operations = [_]Operation{
        .{ .add_node = .{ .id = "sensor-1", .role = .sensor, .cadence = .operational, .owner = "governor-1" } },
        .{ .add_edge = .{ .from = "action-1", .to = "sensor-1", .kind = .contains } },
    };
    const rollback_operations = [_]Operation{
        .{ .remove_edge = .{ .from = "action-1", .to = "sensor-1", .kind = .contains } },
        .{ .remove_node = "sensor-1" },
    };
    const proposal = Proposal{
        .id = "development-1",
        .purpose_id = "purpose-1",
        .actor_identity = "identity:human",
        .required_authority = "identity:human",
        .rationale = "add an independent consequence sensor",
        .evidence_ids = &.{"anchor-1"},
        .predicted_impact = "close the reach-governance gap",
        .operations = &operations,
        .rollback_operations = &rollback_operations,
        .approved = true,
    };
    var changed = try preview(std.testing.allocator, base, proposal);
    defer changed.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 2), changed.nodes.len);
    var restored = try rollback(std.testing.allocator, changed, proposal);
    defer restored.deinit(std.testing.allocator);
    try std.testing.expect(contentEqual(base, restored));
}

test "failed patch is atomic and sensitive patch needs approval" {
    var base = GraphSnapshot{
        .version = 1,
        .nodes = try std.testing.allocator.dupe(NodeRecord, &.{
            .{ .id = "action-1", .role = .action, .cadence = .operational, .owner = "governor-1" },
        }),
        .edges = try std.testing.allocator.alloc(EdgeRecord, 0),
    };
    defer base.deinit(std.testing.allocator);
    const operations = [_]Operation{
        .{ .add_node = .{ .id = "sensor-1", .role = .sensor, .cadence = .operational, .owner = "governor-1" } },
        .{ .remove_node = "missing-node" },
    };
    const rollback_operations = [_]Operation{.{ .remove_node = "sensor-1" }};
    var proposal = Proposal{
        .id = "development-1",
        .purpose_id = "purpose-1",
        .actor_identity = "identity:human",
        .required_authority = "identity:human",
        .rationale = "test atomicity",
        .evidence_ids = &.{"anchor-1"},
        .predicted_impact = "none",
        .operations = &operations,
        .rollback_operations = &rollback_operations,
        .approved = true,
    };
    try std.testing.expectError(
        DevelopmentError.MissingNode,
        apply(std.testing.allocator, base, proposal),
    );
    try std.testing.expectEqual(@as(usize, 1), base.nodes.len);

    const owner_change = [_]Operation{.{ .change_owner = .{ .id = "action-1", .owner = "other" } }};
    const owner_rollback = [_]Operation{.{ .change_owner = .{ .id = "action-1", .owner = "governor-1" } }};
    proposal.operations = &owner_change;
    proposal.rollback_operations = &owner_rollback;
    proposal.approved = false;
    try std.testing.expectError(
        DevelopmentError.ApprovalRequired,
        apply(std.testing.allocator, base, proposal),
    );
}

test "one thousand node graph audit remains deterministic" {
    const allocator = std.testing.allocator;
    const nodes = try allocator.alloc(NodeRecord, 1000);
    defer allocator.free(nodes);
    var ids: [1000][16]u8 = undefined;
    for (nodes, 0..) |*item, i| {
        const id = try std.fmt.bufPrint(&ids[i], "sensor-{d}", .{i});
        item.* = .{ .id = id, .role = .sensor, .cadence = .operational, .owner = "governor-1" };
    }
    try validateSnapshot(.{ .version = 1, .nodes = nodes, .edges = &.{} });
    try validateSnapshotFast(allocator, .{ .version = 1, .nodes = nodes, .edges = &.{} });
}

test "fast graph audit rejects duplicate injection at every position" {
    const allocator = std.testing.allocator;
    var nodes = [_]NodeRecord{
        .{ .id = "a", .role = .sensor, .cadence = .operational, .owner = "g" },
        .{ .id = "b", .role = .sensor, .cadence = .operational, .owner = "g" },
        .{ .id = "c", .role = .sensor, .cadence = .operational, .owner = "g" },
    };
    for (0..nodes.len) |position| {
        const saved = nodes[position].id;
        nodes[position].id = "duplicate";
        const other = (position + 1) % nodes.len;
        const other_saved = nodes[other].id;
        nodes[other].id = "duplicate";
        try std.testing.expectError(
            error.DuplicateNode,
            validateSnapshotFast(allocator, .{ .version = 1, .nodes = &nodes, .edges = &.{} }),
        );
        nodes[position].id = saved;
        nodes[other].id = other_saved;
    }
}

test "split-loop development operation creates action sensor evaluator topology" {
    const allocator = std.testing.allocator;
    var base = GraphSnapshot{
        .version = 1,
        .nodes = try allocator.dupe(NodeRecord, &.{
            .{ .id = "action", .role = .action, .cadence = .operational, .owner = "governor" },
        }),
        .edges = try allocator.alloc(EdgeRecord, 0),
    };
    defer base.deinit(allocator);
    const operations = [_]Operation{.{ .split_loop = .{
        .action_id = "action",
        .sensor = .{ .id = "sensor", .role = .sensor, .cadence = .operational, .owner = "governor" },
        .evaluator = .{ .id = "evaluator", .role = .evaluator, .cadence = .audit, .owner = "governor" },
    } }};
    const rollback_ops = [_]Operation{
        .{ .remove_node = "evaluator" },
        .{ .remove_node = "sensor" },
    };
    const proposal = Proposal{
        .id = "split-1",
        .purpose_id = "purpose-1",
        .actor_identity = "human",
        .required_authority = "human",
        .rationale = "split one optimizer into observed and evaluated roles",
        .evidence_ids = &.{"evidence-1"},
        .predicted_impact = "independent evaluation",
        .operations = &operations,
        .rollback_operations = &rollback_ops,
        .approved = true,
    };
    var changed = try preview(allocator, base, proposal);
    defer changed.deinit(allocator);
    try std.testing.expectEqual(@as(usize, 3), changed.nodes.len);
    try std.testing.expectEqual(@as(usize, 2), changed.edges.len);
}
