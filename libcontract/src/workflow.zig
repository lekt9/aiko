//! Grounded action → consequence sensor → evaluator workflow.

const std = @import("std");
const agency = @import("agency.zig");
const anchor = @import("anchor.zig");
const event_schema = @import("event_schema.zig");
const governance = @import("governance.zig");

pub const InternalSystemError = error{
    InvalidJson,
    InvalidSpec,
    MissingPurpose,
    MissingAuthority,
    MissingEvidencePolicy,
    InvalidRecurrence,
    InvalidScale,
    InvalidLoop,
    InvalidEffect,
    MissingAntiparticle,
    ApprovalMismatch,
    OutOfMemory,
};

const scales = [_][]const u8{ "micro", "meso", "macro", "global" };
const cadences = [_][]const u8{ "immediate", "operational", "management", "purpose" };

const EffectProfile = struct {
    sensor: []const []const u8,
    evaluator: []const []const u8,
    approval: []const u8,
};

const effect_profiles = .{
    .{ "read_only", EffectProfile{
        .sensor = &.{"positron:sensor=fresh_observation"},
        .evaluator = &.{"positron:evaluator=independent_consistency"},
        .approval = "none",
    } },
    .{ "local_reversible", EffectProfile{
        .sensor = &.{ "positron:sensor=postcondition_snapshot", "positron:sensor=state_diff" },
        .evaluator = &.{ "positron:evaluator=goal_postcondition", "positron:evaluator=rollback_available" },
        .approval = "declared_authority",
    } },
    .{ "local_write", EffectProfile{
        .sensor = &.{ "positron:sensor=postcondition_snapshot", "positron:sensor=state_diff" },
        .evaluator = &.{ "positron:evaluator=goal_postcondition", "positron:evaluator=independent_check" },
        .approval = "declared_authority",
    } },
    .{ "external_message", EffectProfile{
        .sensor = &.{ "positron:sensor=provider_acknowledgement", "positron:sensor=message_identity", "positron:sensor=delivery_state" },
        .evaluator = &.{ "positron:evaluator=intended_recipient", "positron:evaluator=intended_payload", "positron:evaluator=delivery_not_goal_progress" },
        .approval = "outbound_message",
    } },
    .{ "purchase", EffectProfile{
        .sensor = &.{ "positron:sensor=authorization_receipt", "positron:sensor=provider_acknowledgement", "positron:sensor=order_or_balance_state" },
        .evaluator = &.{ "positron:evaluator=amount_and_counterparty", "positron:evaluator=goal_postcondition", "positron:evaluator=refund_or_dispute_path" },
        .approval = "payment",
    } },
    .{ "job_application", EffectProfile{
        .sensor = &.{ "positron:sensor=submission_acknowledgement", "positron:sensor=application_identity", "positron:sensor=remote_status" },
        .evaluator = &.{ "positron:evaluator=intended_recipient", "positron:evaluator=intended_application", "positron:evaluator=submission_not_outcome" },
        .approval = "external_submission",
    } },
    .{ "credential_access", EffectProfile{
        .sensor = &.{ "positron:sensor=access_audit_receipt", "positron:sensor=granted_scope" },
        .evaluator = &.{ "positron:evaluator=least_privilege", "positron:evaluator=secret_non_persistence" },
        .approval = "credential",
    } },
    .{ "delete", EffectProfile{
        .sensor = &.{ "positron:sensor=target_preimage", "positron:sensor=deletion_acknowledgement", "positron:sensor=absence_observation" },
        .evaluator = &.{ "positron:evaluator=exact_target", "positron:evaluator=recovery_or_irreversibility_declared" },
        .approval = "destructive",
    } },
    .{ "publish", EffectProfile{
        .sensor = &.{ "positron:sensor=publication_acknowledgement", "positron:sensor=public_identity", "positron:sensor=retrievable_state" },
        .evaluator = &.{ "positron:evaluator=intended_audience", "positron:evaluator=intended_content", "positron:evaluator=takedown_path" },
        .approval = "publication",
    } },
    .{ "permission_change", EffectProfile{
        .sensor = &.{ "positron:sensor=authorization_receipt", "positron:sensor=permission_state" },
        .evaluator = &.{ "positron:evaluator=least_privilege", "positron:evaluator=revocation_path" },
        .approval = "permission",
    } },
    .{ "account_mutation", EffectProfile{
        .sensor = &.{ "positron:sensor=provider_acknowledgement", "positron:sensor=account_state" },
        .evaluator = &.{ "positron:evaluator=exact_account", "positron:evaluator=goal_postcondition", "positron:evaluator=recovery_path" },
        .approval = "account",
    } },
    .{ "process_spawn", EffectProfile{
        .sensor = &.{ "positron:sensor=process_identity", "positron:sensor=health_state", "positron:sensor=lease_state" },
        .evaluator = &.{ "positron:evaluator=cancellation_path", "positron:evaluator=restart_owner", "positron:evaluator=bounded_child_tree" },
        .approval = "process",
    } },
};

fn effectProfile(effect: []const u8) InternalSystemError!EffectProfile {
    inline for (effect_profiles) |entry| {
        if (std.mem.eql(u8, effect, entry[0])) return entry[1];
    }
    return InternalSystemError.InvalidEffect;
}

fn containsString(values: []const std.json.Value, expected: []const u8) bool {
    for (values) |value| {
        if (value == .string and std.mem.eql(u8, value.string, expected)) return true;
    }
    return false;
}

/// Enforce pair-production at settlement: every effect-specific sensor and
/// evaluator antiparticle, plus the exact approval class, must be present.
pub fn validateEffectEvidenceJson(
    allocator: std.mem.Allocator,
    encoded: []const u8,
) InternalSystemError!void {
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, encoded, .{}) catch
        return InternalSystemError.InvalidJson;
    defer parsed.deinit();
    if (parsed.value != .object) return InternalSystemError.InvalidSpec;
    const object = parsed.value.object;
    const effect = requiredString(object, "effect") catch return InternalSystemError.InvalidEffect;
    const profile = try effectProfile(effect);
    const approval = requiredString(object, "approval_class") catch
        return InternalSystemError.ApprovalMismatch;
    if (!std.mem.eql(u8, approval, profile.approval)) return InternalSystemError.ApprovalMismatch;
    const sensor = object.get("sensor_evidence") orelse return InternalSystemError.MissingAntiparticle;
    const evaluator = object.get("evaluator_evidence") orelse return InternalSystemError.MissingAntiparticle;
    if (sensor != .array or evaluator != .array) return InternalSystemError.MissingAntiparticle;
    for (profile.sensor) |required| {
        if (!containsString(sensor.array.items, required)) return InternalSystemError.MissingAntiparticle;
    }
    for (profile.evaluator) |required| {
        if (!containsString(evaluator.array.items, required)) return InternalSystemError.MissingAntiparticle;
    }
}

fn requiredString(object: std.json.ObjectMap, key: []const u8) InternalSystemError![]const u8 {
    const value = object.get(key) orelse return InternalSystemError.InvalidSpec;
    if (value != .string or std.mem.trim(u8, value.string, " \t\r\n").len == 0)
        return InternalSystemError.InvalidSpec;
    return value.string;
}

fn optionalString(object: std.json.ObjectMap, key: []const u8, fallback: []const u8) []const u8 {
    const value = object.get(key) orelse return fallback;
    if (value != .string or value.string.len == 0) return fallback;
    return value.string;
}

fn optionalBool(object: std.json.ObjectMap, key: []const u8, fallback: bool) bool {
    const value = object.get(key) orelse return fallback;
    if (value != .bool) return fallback;
    return value.bool;
}

fn optionalInteger(object: std.json.ObjectMap, key: []const u8, fallback: i64) i64 {
    const value = object.get(key) orelse return fallback;
    if (value != .integer) return fallback;
    return value.integer;
}

fn jsonString(
    allocator: std.mem.Allocator,
    out: *std.ArrayList(u8),
    value: []const u8,
) InternalSystemError!void {
    var allocating = std.Io.Writer.Allocating.init(allocator);
    defer allocating.deinit();
    var stringify = std.json.Stringify{ .writer = &allocating.writer };
    stringify.write(value) catch return InternalSystemError.OutOfMemory;
    out.appendSlice(allocator, allocating.written()) catch return InternalSystemError.OutOfMemory;
}

fn appendLiteral(
    allocator: std.mem.Allocator,
    out: *std.ArrayList(u8),
    value: []const u8,
) InternalSystemError!void {
    out.appendSlice(allocator, value) catch return InternalSystemError.OutOfMemory;
}

fn appendStringArray(
    allocator: std.mem.Allocator,
    out: *std.ArrayList(u8),
    value: ?std.json.Value,
) InternalSystemError!void {
    try appendLiteral(allocator, out, "[");
    if (value) |present| {
        if (present != .array) return InternalSystemError.InvalidSpec;
        for (present.array.items, 0..) |item, index| {
            if (item != .string or item.string.len == 0) return InternalSystemError.InvalidSpec;
            if (index > 0) try appendLiteral(allocator, out, ",");
            try jsonString(allocator, out, item.string);
        }
    }
    try appendLiteral(allocator, out, "]");
}

fn appendStringSlice(
    allocator: std.mem.Allocator,
    out: *std.ArrayList(u8),
    values: []const []const u8,
) InternalSystemError!void {
    try appendLiteral(allocator, out, "[");
    for (values, 0..) |value, index| {
        if (index > 0) try appendLiteral(allocator, out, ",");
        try jsonString(allocator, out, value);
    }
    try appendLiteral(allocator, out, "]");
}

fn safeId(allocator: std.mem.Allocator, value: []const u8) InternalSystemError![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    var dash = false;
    for (value) |byte| {
        const lower = std.ascii.toLower(byte);
        if (std.ascii.isAlphanumeric(lower)) {
            if (dash and out.items.len > 0)
                out.append(allocator, '-') catch return InternalSystemError.OutOfMemory;
            out.append(allocator, lower) catch return InternalSystemError.OutOfMemory;
            dash = false;
        } else {
            dash = true;
        }
    }
    while (out.items.len > 0 and out.items[out.items.len - 1] == '-') _ = out.pop();
    if (out.items.len == 0)
        out.appendSlice(allocator, "internal-system") catch return InternalSystemError.OutOfMemory;
    return out.toOwnedSlice(allocator) catch return InternalSystemError.OutOfMemory;
}

fn appendEvidence(
    allocator: std.mem.Allocator,
    out: *std.ArrayList(u8),
    base: []const u8,
    role: []const u8,
    scale: []const u8,
    cadence: []const u8,
    evidence_policy: ?[]const u8,
    derived: []const []const u8,
) InternalSystemError!void {
    try appendLiteral(allocator, out, "[");
    try jsonString(allocator, out, base);
    for ([_][]const u8{ role, scale, cadence }) |value| {
        try appendLiteral(allocator, out, ",");
        try jsonString(allocator, out, value);
    }
    if (evidence_policy) |policy| {
        try appendLiteral(allocator, out, ",");
        try jsonString(allocator, out, policy);
    }
    for (derived) |requirement| {
        try appendLiteral(allocator, out, ",");
        try jsonString(allocator, out, requirement);
    }
    try appendLiteral(allocator, out, "]");
}

fn appendNode(
    allocator: std.mem.Allocator,
    out: *std.ArrayList(u8),
    key: []const u8,
    plan: []const u8,
    worker: []const u8,
    dependency: ?[]const u8,
    binding_name: ?[]const u8,
    binding_source: ?[]const u8,
    effect: []const u8,
    reversible: bool,
    read_only: bool,
    requires_authority: bool,
    evidence_base: []const u8,
    role_tag: []const u8,
    scale_tag: []const u8,
    cadence_tag: []const u8,
    evidence_policy_tag: ?[]const u8,
    derived_evidence: []const []const u8,
    timeout_ms: i64,
) InternalSystemError!void {
    try appendLiteral(allocator, out, "{\"key\":");
    try jsonString(allocator, out, key);
    try appendLiteral(allocator, out, ",\"plan\":");
    try jsonString(allocator, out, plan);
    try appendLiteral(allocator, out, ",\"worker\":");
    try jsonString(allocator, out, worker);
    try appendLiteral(allocator, out, ",\"depends_on\":[");
    if (dependency) |item| try jsonString(allocator, out, item);
    try appendLiteral(allocator, out, "],\"input_bindings\":{");
    if (binding_name) |name| {
        try jsonString(allocator, out, name);
        try appendLiteral(allocator, out, ":");
        try jsonString(allocator, out, binding_source.?);
    }
    try appendLiteral(allocator, out, "},\"can_parallel\":false,\"timeout_ms\":");
    var integer_buf: [32]u8 = undefined;
    const integer = std.fmt.bufPrint(&integer_buf, "{d}", .{timeout_ms}) catch
        return InternalSystemError.InvalidLoop;
    try appendLiteral(allocator, out, integer);
    try appendLiteral(allocator, out, ",\"effect\":");
    try jsonString(allocator, out, effect);
    try appendLiteral(allocator, out, if (reversible) ",\"reversible\":true" else ",\"reversible\":false");
    try appendLiteral(allocator, out, if (read_only) ",\"read_only\":true" else ",\"read_only\":false");
    try appendLiteral(allocator, out, if (requires_authority) ",\"requires_authority\":true,\"evidence\":" else ",\"requires_authority\":false,\"evidence\":");
    try appendEvidence(
        allocator,
        out,
        evidence_base,
        role_tag,
        scale_tag,
        cadence_tag,
        evidence_policy_tag,
        derived_evidence,
    );
    try appendLiteral(allocator, out, "}");
}

/// Compile a provider-neutral multiscale internal system into the strict
/// Contract skill manifest ABI. A flywheel re-enters through a bounded new
/// occurrence; dependencies inside one occurrence remain acyclic.
pub fn compileInternalSystem(
    allocator: std.mem.Allocator,
    encoded: []const u8,
) InternalSystemError![]u8 {
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, encoded, .{}) catch
        return InternalSystemError.InvalidJson;
    defer parsed.deinit();
    if (parsed.value != .object) return InternalSystemError.InvalidSpec;
    const root = parsed.value.object;
    const purpose = requiredString(root, "purpose") catch return InternalSystemError.MissingPurpose;
    const authority = requiredString(root, "authority") catch return InternalSystemError.MissingAuthority;
    const evidence_policy = requiredString(root, "evidence_policy") catch
        return InternalSystemError.MissingEvidencePolicy;
    const loops_value = root.get("loops") orelse return InternalSystemError.InvalidLoop;
    if (loops_value != .array or loops_value.array.items.len == 0 or loops_value.array.items.len > 4)
        return InternalSystemError.InvalidLoop;
    const recurrence_value = root.get("recurrence") orelse return InternalSystemError.InvalidRecurrence;
    if (recurrence_value != .object) return InternalSystemError.InvalidRecurrence;
    const trigger = requiredString(recurrence_value.object, "trigger") catch
        return InternalSystemError.InvalidRecurrence;
    const max_occurrences = optionalInteger(recurrence_value.object, "max_occurrences", 0);
    if (max_occurrences < 1 or max_occurrences > 1024)
        return InternalSystemError.InvalidRecurrence;

    for (loops_value.array.items, 0..) |loop_value, index| {
        if (loop_value != .object) return InternalSystemError.InvalidLoop;
        const scale = requiredString(loop_value.object, "scale") catch
            return InternalSystemError.InvalidScale;
        if (!std.mem.eql(u8, scale, scales[index])) return InternalSystemError.InvalidScale;
        for ([_][]const u8{ "action", "sensor", "evaluator" }) |role| {
            const cell = loop_value.object.get(role) orelse return InternalSystemError.InvalidLoop;
            if (cell != .object) return InternalSystemError.InvalidLoop;
            _ = requiredString(cell.object, "prompt") catch return InternalSystemError.InvalidLoop;
        }
        const action = loop_value.object.get("action").?.object;
        _ = effectProfile(optionalString(action, "effect", "local_write")) catch
            return InternalSystemError.InvalidEffect;
    }

    const id_source = optionalString(root, "id", "internal-system");
    const id = try safeId(allocator, id_source);
    defer allocator.free(id);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try appendLiteral(allocator, &out, "{\"schema_version\":1,\"id\":");
    try jsonString(allocator, &out, id);
    try appendLiteral(allocator, &out, ",\"version\":");
    try jsonString(allocator, &out, optionalString(root, "version", "1.0.0"));
    try appendLiteral(allocator, &out, ",\"description\":");
    try jsonString(allocator, &out, optionalString(root, "description", purpose));
    try appendLiteral(allocator, &out, ",\"platforms\":[\"all\"],\"triggers\":[");
    try jsonString(allocator, &out, id);
    try appendLiteral(allocator, &out, "],\"input_schema\":{\"type\":\"object\"},\"output_schema\":{\"type\":\"object\",\"x-contract-system\":{\"kind\":\"contract_internal_system\",\"purpose\":");
    try jsonString(allocator, &out, purpose);
    try appendLiteral(allocator, &out, ",\"governance\":{\"authority_pointer\":");
    try jsonString(allocator, &out, authority);
    try appendLiteral(allocator, &out, ",\"evidence_policy_id\":");
    try jsonString(allocator, &out, evidence_policy);
    try appendLiteral(allocator, &out, ",\"development_changes_require_new_version\":true},\"feedback_loops\":[");
    for (loops_value.array.items, 0..) |_, index| {
        if (index > 0) try appendLiteral(allocator, &out, ",");
        const scale = scales[index];
        const loop = loops_value.array.items[index].object;
        const action_effect = optionalString(loop.get("action").?.object, "effect", "local_write");
        const profile = try effectProfile(action_effect);
        try appendLiteral(allocator, &out, "{\"scale\":");
        try jsonString(allocator, &out, scale);
        for ([_][]const u8{ "action", "sensor", "evaluator" }) |role| {
            try appendLiteral(allocator, &out, ",\"");
            try appendLiteral(allocator, &out, role);
            try appendLiteral(allocator, &out, "\":");
            const key = try std.fmt.allocPrint(allocator, "{s}-{s}", .{ scale, role });
            defer allocator.free(key);
            try jsonString(allocator, &out, key);
        }
        try appendLiteral(allocator, &out, ",\"reentry\":\"new_occurrence\",\"effect\":");
        try jsonString(allocator, &out, action_effect);
        try appendLiteral(allocator, &out, ",\"antiparticle\":{\"approval_class\":");
        try jsonString(allocator, &out, profile.approval);
        try appendLiteral(allocator, &out, ",\"sensor_evidence\":");
        try appendStringSlice(allocator, &out, profile.sensor);
        try appendLiteral(allocator, &out, ",\"evaluator_evidence\":");
        try appendStringSlice(allocator, &out, profile.evaluator);
        try appendLiteral(allocator, &out, "}}");
    }
    try appendLiteral(allocator, &out, "],\"funnels\":[");
    var funnel_index: usize = 1;
    while (funnel_index < loops_value.array.items.len) : (funnel_index += 1) {
        if (funnel_index > 1) try appendLiteral(allocator, &out, ",");
        const from = try std.fmt.allocPrint(allocator, "{s}-evaluator", .{scales[funnel_index - 1]});
        defer allocator.free(from);
        const to = try std.fmt.allocPrint(allocator, "{s}-action", .{scales[funnel_index]});
        defer allocator.free(to);
        try appendLiteral(allocator, &out, "{\"from\":");
        try jsonString(allocator, &out, from);
        try appendLiteral(allocator, &out, ",\"to\":");
        try jsonString(allocator, &out, to);
        try appendLiteral(allocator, &out, ",\"binding\":\"lower_scale_evidence\"}");
    }
    try appendLiteral(allocator, &out, "],\"occurrence_policy\":{\"trigger\":");
    try jsonString(allocator, &out, trigger);
    var occurrence_buf: [32]u8 = undefined;
    const occurrence_text = std.fmt.bufPrint(&occurrence_buf, "{d}", .{max_occurrences}) catch
        return InternalSystemError.InvalidRecurrence;
    try appendLiteral(allocator, &out, ",\"max_occurrences\":");
    try appendLiteral(allocator, &out, occurrence_text);
    try appendLiteral(allocator, &out, ",\"graph_reentry\":false},\"interface_hooks\":");
    try appendStringArray(allocator, &out, root.get("interface_hooks"));
    try appendLiteral(allocator, &out, ",\"compiler\":\"libcontract\"}},\"nodes\":[");

    for (loops_value.array.items, 0..) |loop_value, index| {
        if (index > 0) try appendLiteral(allocator, &out, ",");
        const loop = loop_value.object;
        const scale = scales[index];
        const cadence = cadences[index];
        const action = loop.get("action").?.object;
        const sensor = loop.get("sensor").?.object;
        const evaluator = loop.get("evaluator").?.object;
        const action_key = try std.fmt.allocPrint(allocator, "{s}-action", .{scale});
        defer allocator.free(action_key);
        const sensor_key = try std.fmt.allocPrint(allocator, "{s}-sensor", .{scale});
        defer allocator.free(sensor_key);
        const evaluator_key = try std.fmt.allocPrint(allocator, "{s}-evaluator", .{scale});
        defer allocator.free(evaluator_key);
        const previous = if (index > 0)
            try std.fmt.allocPrint(allocator, "{s}-evaluator", .{scales[index - 1]})
        else
            null;
        defer if (previous) |value| allocator.free(value);
        const lower_source = if (previous) |value|
            try std.fmt.allocPrint(allocator, "{s}.result", .{value})
        else
            null;
        defer if (lower_source) |value| allocator.free(value);
        const action_effect = optionalString(action, "effect", "local_write");
        const profile = try effectProfile(action_effect);
        const action_scale = try std.fmt.allocPrint(allocator, "agency:scale={s}", .{scale});
        defer allocator.free(action_scale);
        const action_cadence = try std.fmt.allocPrint(allocator, "agency:cadence={s}", .{cadence});
        defer allocator.free(action_cadence);
        try appendNode(
            allocator,
            &out,
            action_key,
            try requiredString(action, "prompt"),
            optionalString(action, "worker", "aiko"),
            previous,
            if (previous != null) "lower_scale_evidence" else null,
            lower_source,
            action_effect,
            optionalBool(action, "reversible", false),
            std.mem.eql(u8, action_effect, "read_only"),
            !std.mem.eql(u8, action_effect, "read_only"),
            "execution_receipt",
            "agency:role=action",
            action_scale,
            action_cadence,
            null,
            &.{"photon:claim=effect_execution"},
            optionalInteger(action, "timeout_ms", 120000),
        );
        try appendLiteral(allocator, &out, ",");
        const sensor_source = try std.fmt.allocPrint(allocator, "{s}.result", .{action_key});
        defer allocator.free(sensor_source);
        const sensor_scale = try std.fmt.allocPrint(allocator, "agency:scale={s}", .{scale});
        defer allocator.free(sensor_scale);
        const sensor_cadence = try std.fmt.allocPrint(allocator, "agency:cadence={s}", .{cadence});
        defer allocator.free(sensor_cadence);
        const policy_tag = try std.fmt.allocPrint(allocator, "agency:evidence-policy={s}", .{evidence_policy});
        defer allocator.free(policy_tag);
        try appendNode(
            allocator,
            &out,
            sensor_key,
            try requiredString(sensor, "prompt"),
            optionalString(sensor, "worker", "host"),
            action_key,
            "action_receipt",
            sensor_source,
            "read_only",
            true,
            true,
            false,
            "observation",
            "agency:role=sensor",
            sensor_scale,
            sensor_cadence,
            policy_tag,
            profile.sensor,
            optionalInteger(sensor, "timeout_ms", 120000),
        );
        try appendLiteral(allocator, &out, ",");
        const evaluator_source = try std.fmt.allocPrint(allocator, "{s}.result", .{sensor_key});
        defer allocator.free(evaluator_source);
        try appendNode(
            allocator,
            &out,
            evaluator_key,
            try requiredString(evaluator, "prompt"),
            optionalString(evaluator, "worker", "aiko"),
            sensor_key,
            "sensor_evidence",
            evaluator_source,
            "read_only",
            true,
            true,
            false,
            "verdict",
            "agency:role=evaluator",
            sensor_scale,
            sensor_cadence,
            policy_tag,
            profile.evaluator,
            optionalInteger(evaluator, "timeout_ms", 120000),
        );
    }
    try appendLiteral(allocator, &out, "],\"examples\":[]}");
    return out.toOwnedSlice(allocator) catch return InternalSystemError.OutOfMemory;
}

pub const Verdict = enum {
    pending_action,
    waiting_sensor,
    waiting_evaluator,
    satisfied,
    vetoed,
    stale,
    contradicted,
};

pub const GroundedWorkflow = struct {
    trace_id: []const u8,
    purpose_id: []const u8,
    action_node: agency.NodeEnvelope,
    sensor_node: agency.NodeEnvelope,
    evaluator_node: agency.NodeEnvelope,
    reach: governance.ReachDeclaration,
    sensor: governance.ConsequenceSensor,
    anchor_value: ?anchor.RealityAnchor = null,
    verdict: Verdict = .pending_action,

    pub fn validateTopology(self: GroundedWorkflow) !void {
        if (self.action_node.role != .action or self.sensor_node.role != .sensor or self.evaluator_node.role != .evaluator)
            return error.InvalidRoleTopology;
        if (!std.mem.eql(u8, self.purpose_id, self.action_node.purpose_id) or
            !std.mem.eql(u8, self.purpose_id, self.sensor_node.purpose_id) or
            !std.mem.eql(u8, self.purpose_id, self.evaluator_node.purpose_id))
            return error.PurposeMismatch;
        try agency.validateEdge(.sensor, .action, .observes);
        try agency.validateEdge(.evaluator, .sensor, .evaluates);
        if (!std.mem.eql(u8, self.sensor.id, self.sensor_node.authority_pointer))
            return error.SensorIdentityMismatch;
    }

    pub fn authorizeAction(self: *GroundedWorkflow) governance.ReachDecision {
        self.validateTopology() catch {
            self.verdict = .vetoed;
            return .{ .allowed = false, .reason = .no_consequence_sensor };
        };
        const decision = governance.evaluateReach(self.reach);
        if (decision.allowed) {
            self.verdict = .waiting_sensor;
        } else {
            self.verdict = if (decision.reason == .stale_consequence_sensor) .stale else .vetoed;
        }
        return decision;
    }

    pub fn observe(self: *GroundedWorkflow, value: anchor.RealityAnchor, now_ms: i64) !void {
        if (self.verdict != .waiting_sensor) return error.ActionNotAuthorized;
        try anchor.requireFresh(value, now_ms);
        if (!std.mem.eql(u8, value.id, self.sensor.anchor_id))
            return error.UnexpectedAnchor;
        self.anchor_value = value;
        self.verdict = .waiting_evaluator;
    }

    pub fn evaluate(self: *GroundedWorkflow, counter: anchor.RealityAnchor, now_ms: i64) !Verdict {
        if (self.verdict != .waiting_evaluator) return error.NoObservation;
        const primary = self.anchor_value orelse return error.NoObservation;
        try anchor.requireFresh(counter, now_ms);
        if (!anchor.independent(primary, counter)) {
            self.verdict = .vetoed;
            return error.NonIndependentEvaluator;
        }
        if (!std.mem.eql(u8, primary.claim_id, counter.claim_id)) {
            self.verdict = .contradicted;
            return self.verdict;
        }
        self.verdict = .satisfied;
        return self.verdict;
    }

    pub fn event(self: GroundedWorkflow, event_id: []const u8, parent_id: ?[]const u8, timestamp_ms: i64) event_schema.CausalEvent {
        const selected = switch (self.verdict) {
            .pending_action => .{ event_schema.EventKind.declared, event_schema.EventState.working, "action" },
            .waiting_sensor => .{ event_schema.EventKind.started, event_schema.EventState.waiting_evidence, "sensor" },
            .waiting_evaluator => .{ event_schema.EventKind.evidence_collected, event_schema.EventState.working, "evaluator" },
            .satisfied => .{ event_schema.EventKind.completed, event_schema.EventState.satisfied, "evaluator" },
            .vetoed => .{ event_schema.EventKind.vetoed, event_schema.EventState.veto, "evaluator" },
            .stale => .{ event_schema.EventKind.vetoed, event_schema.EventState.stale, "sensor" },
            .contradicted => .{ event_schema.EventKind.vetoed, event_schema.EventState.contradicted, "evaluator" },
        };
        return .{
            .event_id = event_id,
            .trace_id = self.trace_id,
            .node_id = switch (self.verdict) {
                .pending_action => self.action_node.authority_pointer,
                .waiting_sensor, .stale => self.sensor_node.authority_pointer,
                else => self.evaluator_node.authority_pointer,
            },
            .parent_event_id = parent_id,
            .purpose_id = self.purpose_id,
            .role = selected[2],
            .kind = selected[0],
            .state = selected[1],
            .timestamp_ms = timestamp_ms,
            .anchor_id = if (self.anchor_value) |v| v.id else null,
        };
    }
};

fn node(role: agency.NodeRole, id: []const u8, scope: agency.EffectScope) agency.NodeEnvelope {
    return .{
        .role = role,
        .authority_pointer = id,
        .purpose_id = "purpose-1",
        .cadence_class = .operational,
        .effect_scope = scope,
        .evidence_policy_id = "policy-1",
        .valid_from = 0,
        .valid_until = 10_000,
    };
}

fn reality(id: []const u8, claim: []const u8, source: []const u8, domain: []const u8, hash: []const u8) anchor.RealityAnchor {
    return .{
        .id = id,
        .claim_id = claim,
        .kind = .executed_test,
        .content_hash = hash,
        .source_identity = source,
        .collection_method = "executed",
        .observed_at = 100,
        .expires_at = 1000,
        .failure_domain = domain,
        .payload_pointer = "file-digest:test-results",
        .status = .active,
    };
}

fn workflow() GroundedWorkflow {
    const sensors = &[_]governance.ConsequenceSensor{.{
        .id = "sensor-1",
        .action_id = "action-1",
        .anchor_id = "anchor-1",
        .observed_scope = .deployment,
        .fresh = true,
    }};
    return .{
        .trace_id = "trace-1",
        .purpose_id = "purpose-1",
        .action_node = node(.action, "action-1", .deployment),
        .sensor_node = node(.sensor, "sensor-1", .local_read),
        .evaluator_node = node(.evaluator, "evaluator-1", .local_read),
        .sensor = sensors[0],
        .reach = .{
            .action_id = "action-1",
            .effect_scope = .deployment,
            .capability_scope = .deployment,
            .approval_id = "approval-1",
            .sensors = sensors,
        },
    };
}

test "grounded workflow cannot satisfy before an independent reality check" {
    var w = workflow();
    try std.testing.expect(w.authorizeAction().allowed);
    try w.observe(reality("anchor-1", "claim-1", "ci-a", "runner-a", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), 200);
    try std.testing.expectError(error.NonIndependentEvaluator, w.evaluate(
        reality("anchor-2", "claim-1", "ci-a", "runner-a", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        200,
    ));
    try std.testing.expectEqual(Verdict.vetoed, w.verdict);
}

test "independent matching anchor satisfies and disagreement contradicts" {
    var good = workflow();
    _ = good.authorizeAction();
    try good.observe(reality("anchor-1", "claim-1", "ci-a", "runner-a", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), 200);
    try std.testing.expectEqual(Verdict.satisfied, try good.evaluate(
        reality("anchor-2", "claim-1", "ci-b", "runner-b", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
        200,
    ));
    try good.event("evt-4", "evt-3", 200).validate();

    var bad = workflow();
    _ = bad.authorizeAction();
    try bad.observe(reality("anchor-1", "claim-1", "ci-a", "runner-a", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), 200);
    try std.testing.expectEqual(Verdict.contradicted, try bad.evaluate(
        reality("anchor-2", "claim-2", "ci-b", "runner-b", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
        200,
    ));
}

test "internal system compiler makes bounded multiscale flywheels and funnels" {
    const spec =
        \\{
        \\  "id": "learning-organism",
        \\  "purpose": "improve from independently observed outcomes",
        \\  "authority": "authority://operator",
        \\  "evidence_policy": "policy://independent-outcomes",
        \\  "recurrence": {"trigger": "evaluator verdict", "max_occurrences": 8},
        \\  "loops": [
        \\    {"scale":"micro","action":{"prompt":"act"},"sensor":{"prompt":"observe"},"evaluator":{"prompt":"judge"}},
        \\    {"scale":"meso","action":{"prompt":"adapt"},"sensor":{"prompt":"measure"},"evaluator":{"prompt":"review"}},
        \\    {"scale":"macro","action":{"prompt":"allocate"},"sensor":{"prompt":"audit"},"evaluator":{"prompt":"govern"}},
        \\    {"scale":"global","action":{"prompt":"align"},"sensor":{"prompt":"sample"},"evaluator":{"prompt":"settle"}}
        \\  ]
        \\}
    ;
    const encoded = try compileInternalSystem(std.testing.allocator, spec);
    defer std.testing.allocator.free(encoded);
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, encoded, .{});
    defer parsed.deinit();

    const root = parsed.value.object;
    try std.testing.expectEqual(@as(usize, 12), root.get("nodes").?.array.items.len);
    const system = root.get("output_schema").?.object.get("x-contract-system").?.object;
    try std.testing.expectEqual(@as(usize, 4), system.get("feedback_loops").?.array.items.len);
    try std.testing.expectEqual(@as(usize, 3), system.get("funnels").?.array.items.len);
    try std.testing.expect(!system.get("occurrence_policy").?.object.get("graph_reentry").?.bool);

    const nodes = root.get("nodes").?.array.items;
    try std.testing.expectEqual(@as(usize, 0), nodes[0].object.get("depends_on").?.array.items.len);
    try std.testing.expectEqualStrings(
        "micro-evaluator",
        nodes[3].object.get("depends_on").?.array.items[0].string,
    );
    try std.testing.expectEqualStrings(
        "micro-evaluator.result",
        nodes[3].object.get("input_bindings").?.object.get("lower_scale_evidence").?.string,
    );
    const micro = system.get("feedback_loops").?.array.items[0].object;
    try std.testing.expectEqualStrings("local_write", micro.get("effect").?.string);
    try std.testing.expectEqualStrings(
        "declared_authority",
        micro.get("antiparticle").?.object.get("approval_class").?.string,
    );
    try std.testing.expectEqual(
        @as(usize, 2),
        micro.get("antiparticle").?.object.get("sensor_evidence").?.array.items.len,
    );
    try std.testing.expectEqualStrings(
        "positron:sensor=postcondition_snapshot",
        nodes[1].object.get("evidence").?.array.items[5].string,
    );
}

test "internal system compiler fails closed on authority recurrence and scale gaps" {
    const missing_authority =
        \\{"purpose":"p","evidence_policy":"e","recurrence":{"trigger":"v","max_occurrences":1},"loops":[{"scale":"micro","action":{"prompt":"a"},"sensor":{"prompt":"s"},"evaluator":{"prompt":"e"}}]}
    ;
    try std.testing.expectError(
        InternalSystemError.MissingAuthority,
        compileInternalSystem(std.testing.allocator, missing_authority),
    );

    const unbounded =
        \\{"purpose":"p","authority":"a","evidence_policy":"e","recurrence":{"trigger":"v","max_occurrences":0},"loops":[{"scale":"micro","action":{"prompt":"a"},"sensor":{"prompt":"s"},"evaluator":{"prompt":"e"}}]}
    ;
    try std.testing.expectError(
        InternalSystemError.InvalidRecurrence,
        compileInternalSystem(std.testing.allocator, unbounded),
    );

    const scale_gap =
        \\{"purpose":"p","authority":"a","evidence_policy":"e","recurrence":{"trigger":"v","max_occurrences":1},"loops":[{"scale":"global","action":{"prompt":"a"},"sensor":{"prompt":"s"},"evaluator":{"prompt":"e"}}]}
    ;
    try std.testing.expectError(
        InternalSystemError.InvalidScale,
        compileInternalSystem(std.testing.allocator, scale_gap),
    );

    const unknown_effect =
        \\{"purpose":"p","authority":"a","evidence_policy":"e","recurrence":{"trigger":"v","max_occurrences":1},"loops":[{"scale":"micro","action":{"prompt":"a","effect":"magic"},"sensor":{"prompt":"s"},"evaluator":{"prompt":"e"}}]}
    ;
    try std.testing.expectError(
        InternalSystemError.InvalidEffect,
        compileInternalSystem(std.testing.allocator, unknown_effect),
    );
}

test "effect profiles derive domain antiparticles including messages and processes" {
    const cases = [_]struct {
        effect: []const u8,
        sensor: []const u8,
        evaluator: []const u8,
        approval: []const u8,
    }{
        .{
            .effect = "external_message",
            .sensor = "positron:sensor=provider_acknowledgement",
            .evaluator = "positron:evaluator=delivery_not_goal_progress",
            .approval = "outbound_message",
        },
        .{
            .effect = "process_spawn",
            .sensor = "positron:sensor=lease_state",
            .evaluator = "positron:evaluator=bounded_child_tree",
            .approval = "process",
        },
        .{
            .effect = "purchase",
            .sensor = "positron:sensor=order_or_balance_state",
            .evaluator = "positron:evaluator=refund_or_dispute_path",
            .approval = "payment",
        },
    };
    for (cases) |case| {
        const spec = try std.fmt.allocPrint(
            std.testing.allocator,
            "{{\"purpose\":\"p\",\"authority\":\"a\",\"evidence_policy\":\"e\",\"recurrence\":{{\"trigger\":\"v\",\"max_occurrences\":1}},\"loops\":[{{\"scale\":\"micro\",\"action\":{{\"prompt\":\"a\",\"effect\":\"{s}\"}},\"sensor\":{{\"prompt\":\"s\"}},\"evaluator\":{{\"prompt\":\"e\"}}}}]}}",
            .{case.effect},
        );
        defer std.testing.allocator.free(spec);
        const encoded = try compileInternalSystem(std.testing.allocator, spec);
        defer std.testing.allocator.free(encoded);
        try std.testing.expect(std.mem.indexOf(u8, encoded, case.sensor) != null);
        try std.testing.expect(std.mem.indexOf(u8, encoded, case.evaluator) != null);
        try std.testing.expect(std.mem.indexOf(u8, encoded, case.approval) != null);
    }
}

test "effect settlement evidence fails closed when one antiparticle is missing" {
    const complete =
        \\{"effect":"external_message","approval_class":"outbound_message","sensor_evidence":["positron:sensor=provider_acknowledgement","positron:sensor=message_identity","positron:sensor=delivery_state"],"evaluator_evidence":["positron:evaluator=intended_recipient","positron:evaluator=intended_payload","positron:evaluator=delivery_not_goal_progress"]}
    ;
    try validateEffectEvidenceJson(std.testing.allocator, complete);

    const missing_delivery =
        \\{"effect":"external_message","approval_class":"outbound_message","sensor_evidence":["positron:sensor=provider_acknowledgement","positron:sensor=message_identity"],"evaluator_evidence":["positron:evaluator=intended_recipient","positron:evaluator=intended_payload","positron:evaluator=delivery_not_goal_progress"]}
    ;
    try std.testing.expectError(
        InternalSystemError.MissingAntiparticle,
        validateEffectEvidenceJson(std.testing.allocator, missing_delivery),
    );

    const wrong_approval =
        \\{"effect":"purchase","approval_class":"outbound_message","sensor_evidence":[],"evaluator_evidence":[]}
    ;
    try std.testing.expectError(
        InternalSystemError.ApprovalMismatch,
        validateEffectEvidenceJson(std.testing.allocator, wrong_approval),
    );
}
