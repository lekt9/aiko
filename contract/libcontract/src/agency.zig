//! agency.zig — typed agency roles and policy envelope for one resolver.
//!
//! Roles do not create a second graph engine. They constrain the existing
//! contract row, its edges, and its authority. Legacy rows remain readable;
//! new agency rows gain canonical, versioned semantics.

const std = @import("std");

pub const SCHEMA_VERSION: u32 = 1;

pub const NodeRole = enum {
    legacy,
    purpose,
    sensor,
    action,
    evaluator,
    governor,
    development,
};

pub const CadenceClass = enum {
    immediate,
    operational,
    management,
    audit,
    purpose,

    pub fn rank(self: CadenceClass) u8 {
        return switch (self) {
            .immediate => 0,
            .operational => 1,
            .management => 2,
            .audit => 3,
            .purpose => 4,
        };
    }
};

pub const EffectScope = enum {
    none,
    local_read,
    local_write,
    network_read,
    network_mutation,
    deployment,
    message,
    payment,
    onchain,
    human_impact,

    pub fn requiresConsequenceSensor(self: EffectScope) bool {
        return switch (self) {
            .network_mutation, .deployment, .message, .payment, .onchain, .human_impact => true,
            else => false,
        };
    }

    pub fn requiresExplicitApproval(self: EffectScope) bool {
        return switch (self) {
            .network_mutation, .deployment, .message, .payment, .onchain, .human_impact => true,
            else => false,
        };
    }
};

pub const EdgeKind = enum {
    contains,
    observes,
    evaluates,
    governs,
    proposes,
    depends,
};

pub const NodeEnvelope = struct {
    role: NodeRole,
    authority_pointer: []const u8,
    purpose_id: []const u8,
    cadence_class: CadenceClass,
    effect_scope: EffectScope = .none,
    evidence_policy_id: ?[]const u8 = null,
    valid_from: i64,
    valid_until: i64,
    revokes: ?[]const u8 = null,
    supersedes: ?[]const u8 = null,
    schema_version: u32 = SCHEMA_VERSION,
};

pub const AgencyError = error{
    InvalidJson,
    MissingField,
    InvalidField,
    UnsupportedSchema,
    EmptyAuthority,
    EmptyPurpose,
    InvalidValidityWindow,
    IllegalEdge,
    AuthorityEscalation,
    MissingEvidencePolicy,
    InvalidEffectScope,
    OutOfMemory,
};

pub fn validateEnvelope(node: NodeEnvelope) AgencyError!void {
    if (node.schema_version != SCHEMA_VERSION) return AgencyError.UnsupportedSchema;
    if (node.authority_pointer.len == 0) return AgencyError.EmptyAuthority;
    if (node.purpose_id.len == 0) return AgencyError.EmptyPurpose;
    if (node.valid_until <= node.valid_from) return AgencyError.InvalidValidityWindow;

    switch (node.role) {
        .legacy => {
            if (node.effect_scope != .none) return AgencyError.InvalidEffectScope;
        },
        .purpose => {
            if (node.cadence_class != .purpose or node.effect_scope != .none)
                return AgencyError.InvalidEffectScope;
        },
        .sensor, .evaluator => {
            if (node.effect_scope != .none and node.effect_scope != .local_read and
                node.effect_scope != .network_read)
                return AgencyError.InvalidEffectScope;
            if (node.evidence_policy_id == null) return AgencyError.MissingEvidencePolicy;
        },
        .action => {},
        .governor => {
            if (node.cadence_class.rank() < CadenceClass.management.rank())
                return AgencyError.AuthorityEscalation;
            if (node.evidence_policy_id == null) return AgencyError.MissingEvidencePolicy;
        },
        .development => {
            if (node.cadence_class.rank() < CadenceClass.audit.rank())
                return AgencyError.AuthorityEscalation;
            if (node.evidence_policy_id == null) return AgencyError.MissingEvidencePolicy;
        },
    }
}

/// Validate a typed relationship. `contains` is intentionally acyclic:
/// evaluator feedback governs through a cross-edge, never by becoming the
/// governor's parent.
pub fn validateEdge(from: NodeRole, to: NodeRole, kind: EdgeKind) AgencyError!void {
    const allowed = switch (kind) {
        .contains => (from == .purpose and to == .governor) or
            (from == .governor and to == .action) or
            (from == .action and to == .sensor),
        .observes => from == .sensor and to == .action,
        .evaluates => from == .evaluator and (to == .sensor or to == .action),
        .governs => from == .governor and
            (to == .action or to == .sensor or to == .evaluator or to == .development),
        .proposes => from == .development and
            (to == .purpose or to == .governor or to == .action or to == .sensor or to == .evaluator),
        .depends => from != .purpose and to != .legacy,
    };
    if (!allowed) return AgencyError.IllegalEdge;
}

/// A node may amend another node only when it is slower and authoritative.
/// Equal-cadence peers require their shared governor to arbitrate.
pub fn authorizeMutation(
    actor: NodeEnvelope,
    target: NodeEnvelope,
    actor_authority: []const u8,
) AgencyError!void {
    if (!std.mem.eql(u8, actor.authority_pointer, actor_authority))
        return AgencyError.AuthorityEscalation;
    if (actor.role != .governor and actor.role != .purpose)
        return AgencyError.AuthorityEscalation;
    if (actor.cadence_class.rank() <= target.cadence_class.rank())
        return AgencyError.AuthorityEscalation;
    if (!std.mem.eql(u8, actor.purpose_id, target.purpose_id))
        return AgencyError.AuthorityEscalation;
}

fn writeJsonString(out: *std.ArrayList(u8), allocator: std.mem.Allocator, value: []const u8) AgencyError!void {
    out.append(allocator, '"') catch return AgencyError.OutOfMemory;
    for (value) |byte| {
        switch (byte) {
            '"' => out.appendSlice(allocator, "\\\"") catch return AgencyError.OutOfMemory,
            '\\' => out.appendSlice(allocator, "\\\\") catch return AgencyError.OutOfMemory,
            '\n' => out.appendSlice(allocator, "\\n") catch return AgencyError.OutOfMemory,
            '\r' => out.appendSlice(allocator, "\\r") catch return AgencyError.OutOfMemory,
            '\t' => out.appendSlice(allocator, "\\t") catch return AgencyError.OutOfMemory,
            else => out.append(allocator, byte) catch return AgencyError.OutOfMemory,
        }
    }
    out.append(allocator, '"') catch return AgencyError.OutOfMemory;
}

fn writeField(
    out: *std.ArrayList(u8),
    allocator: std.mem.Allocator,
    name: []const u8,
    value: []const u8,
    first: bool,
) AgencyError!void {
    if (!first) out.append(allocator, ',') catch return AgencyError.OutOfMemory;
    try writeJsonString(out, allocator, name);
    out.append(allocator, ':') catch return AgencyError.OutOfMemory;
    try writeJsonString(out, allocator, value);
}

pub fn encodeEnvelope(allocator: std.mem.Allocator, node: NodeEnvelope) AgencyError![]u8 {
    try validateEnvelope(node);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    out.append(allocator, '{') catch return AgencyError.OutOfMemory;
    try writeField(&out, allocator, "role", @tagName(node.role), true);
    try writeField(&out, allocator, "authority_pointer", node.authority_pointer, false);
    try writeField(&out, allocator, "purpose_id", node.purpose_id, false);
    try writeField(&out, allocator, "cadence_class", @tagName(node.cadence_class), false);
    try writeField(&out, allocator, "effect_scope", @tagName(node.effect_scope), false);
    if (node.evidence_policy_id) |value|
        try writeField(&out, allocator, "evidence_policy_id", value, false);

    var integer_buf: [32]u8 = undefined;
    out.appendSlice(allocator, ",\"valid_from\":") catch return AgencyError.OutOfMemory;
    const valid_from = std.fmt.bufPrint(&integer_buf, "{d}", .{node.valid_from}) catch
        return AgencyError.InvalidField;
    out.appendSlice(allocator, valid_from) catch return AgencyError.OutOfMemory;
    out.appendSlice(allocator, ",\"valid_until\":") catch return AgencyError.OutOfMemory;
    const valid_until = std.fmt.bufPrint(&integer_buf, "{d}", .{node.valid_until}) catch
        return AgencyError.InvalidField;
    out.appendSlice(allocator, valid_until) catch return AgencyError.OutOfMemory;
    if (node.revokes) |value| try writeField(&out, allocator, "revokes", value, false);
    if (node.supersedes) |value| try writeField(&out, allocator, "supersedes", value, false);
    out.appendSlice(allocator, ",\"schema_version\":") catch return AgencyError.OutOfMemory;
    const version = std.fmt.bufPrint(&integer_buf, "{d}", .{node.schema_version}) catch
        return AgencyError.InvalidField;
    out.appendSlice(allocator, version) catch return AgencyError.OutOfMemory;
    out.append(allocator, '}') catch return AgencyError.OutOfMemory;
    return out.toOwnedSlice(allocator) catch return AgencyError.OutOfMemory;
}

pub const ParsedEnvelope = struct {
    tree: std.json.Parsed(std.json.Value),
    value: NodeEnvelope,

    pub fn deinit(self: *ParsedEnvelope) void {
        self.tree.deinit();
    }
};

fn requiredString(object: std.json.ObjectMap, name: []const u8) AgencyError![]const u8 {
    const value = object.get(name) orelse return AgencyError.MissingField;
    if (value != .string or value.string.len == 0) return AgencyError.InvalidField;
    return value.string;
}

fn optionalString(object: std.json.ObjectMap, name: []const u8) AgencyError!?[]const u8 {
    const value = object.get(name) orelse return null;
    if (value == .null) return null;
    if (value != .string or value.string.len == 0) return AgencyError.InvalidField;
    return value.string;
}

fn requiredInteger(object: std.json.ObjectMap, name: []const u8) AgencyError!i64 {
    const value = object.get(name) orelse return AgencyError.MissingField;
    if (value != .integer) return AgencyError.InvalidField;
    return value.integer;
}

pub fn decodeEnvelope(allocator: std.mem.Allocator, encoded: []const u8) AgencyError!ParsedEnvelope {
    var tree = std.json.parseFromSlice(std.json.Value, allocator, encoded, .{}) catch
        return AgencyError.InvalidJson;
    errdefer tree.deinit();
    if (tree.value != .object) return AgencyError.InvalidJson;
    const object = tree.value.object;
    const schema_integer = try requiredInteger(object, "schema_version");
    if (schema_integer < 1 or schema_integer > std.math.maxInt(u32))
        return AgencyError.InvalidField;
    const node = NodeEnvelope{
        .role = std.meta.stringToEnum(NodeRole, try requiredString(object, "role")) orelse
            return AgencyError.InvalidField,
        .authority_pointer = try requiredString(object, "authority_pointer"),
        .purpose_id = try requiredString(object, "purpose_id"),
        .cadence_class = std.meta.stringToEnum(
            CadenceClass,
            try requiredString(object, "cadence_class"),
        ) orelse return AgencyError.InvalidField,
        .effect_scope = std.meta.stringToEnum(
            EffectScope,
            try requiredString(object, "effect_scope"),
        ) orelse return AgencyError.InvalidField,
        .evidence_policy_id = try optionalString(object, "evidence_policy_id"),
        .valid_from = try requiredInteger(object, "valid_from"),
        .valid_until = try requiredInteger(object, "valid_until"),
        .revokes = try optionalString(object, "revokes"),
        .supersedes = try optionalString(object, "supersedes"),
        .schema_version = @intCast(schema_integer),
    };
    try validateEnvelope(node);
    return .{ .tree = tree, .value = node };
}

test "all role envelopes canonical round-trip" {
    const roles = [_]NodeRole{ .legacy, .purpose, .sensor, .action, .evaluator, .governor, .development };
    for (roles) |role| {
        const node = NodeEnvelope{
            .role = role,
            .authority_pointer = "identity:owner",
            .purpose_id = "purpose:root",
            .cadence_class = switch (role) {
                .purpose => .purpose,
                .governor => .management,
                .development => .audit,
                else => .operational,
            },
            .effect_scope = if (role == .action) .local_write else .none,
            .evidence_policy_id = switch (role) {
                .sensor, .evaluator, .governor, .development => "policy:grounded",
                else => null,
            },
            .valid_from = 100,
            .valid_until = 200,
        };
        const encoded = try encodeEnvelope(std.testing.allocator, node);
        defer std.testing.allocator.free(encoded);
        var parsed = try decodeEnvelope(std.testing.allocator, encoded);
        defer parsed.deinit();
        try std.testing.expectEqual(role, parsed.value.role);
        try std.testing.expectEqualStrings(node.authority_pointer, parsed.value.authority_pointer);
        try std.testing.expectEqual(node.cadence_class, parsed.value.cadence_class);
    }
}

test "illegal role edges and fast-loop amendments fail closed" {
    try std.testing.expectError(AgencyError.IllegalEdge, validateEdge(.action, .purpose, .contains));
    try validateEdge(.purpose, .governor, .contains);
    try validateEdge(.evaluator, .action, .evaluates);

    const action = NodeEnvelope{
        .role = .action,
        .authority_pointer = "identity:operator",
        .purpose_id = "purpose:root",
        .cadence_class = .operational,
        .effect_scope = .local_write,
        .valid_from = 1,
        .valid_until = 2,
    };
    try std.testing.expectError(
        AgencyError.AuthorityEscalation,
        authorizeMutation(action, action, "identity:operator"),
    );
}

test "slower owner may amend faster node within one purpose" {
    const governor = NodeEnvelope{
        .role = .governor,
        .authority_pointer = "identity:owner",
        .purpose_id = "purpose:root",
        .cadence_class = .management,
        .evidence_policy_id = "policy:grounded",
        .valid_from = 1,
        .valid_until = 10,
    };
    const action = NodeEnvelope{
        .role = .action,
        .authority_pointer = "identity:operator",
        .purpose_id = "purpose:root",
        .cadence_class = .operational,
        .effect_scope = .local_write,
        .valid_from = 1,
        .valid_until = 2,
    };
    try authorizeMutation(governor, action, "identity:owner");
}
