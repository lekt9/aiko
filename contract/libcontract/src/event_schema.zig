//! Stable, redacted causal event schema for Contract observability.
//! Events describe control flow and evidence state; they never contain secrets,
//! prompts, payloads, credentials, or environment values.

const std = @import("std");

pub const SCHEMA_VERSION: u16 = 1;

pub const EventKind = enum {
    declared,
    started,
    evidence_collected,
    evaluated,
    approval_requested,
    approved,
    vetoed,
    retry_scheduled,
    invalidated,
    sensor_lost,
    anchor_expired,
    capability_breach,
    evidence_compromised,
    topology_proposed,
    topology_applied,
    rollback_started,
    rolled_back,
    recovered,
    completed,
    failed,
};

pub const EventState = enum {
    working,
    waiting_evidence,
    waiting_approval,
    veto,
    stale,
    contradicted,
    rollback,
    recovered,
    unresolved,
    satisfied,
};

pub const CausalEvent = struct {
    event_id: []const u8,
    trace_id: []const u8,
    node_id: []const u8,
    parent_event_id: ?[]const u8 = null,
    contract_id: ?[]const u8 = null,
    purpose_id: []const u8,
    role: []const u8,
    owner_id: ?[]const u8 = null,
    cadence: ?[]const u8 = null,
    kind: EventKind,
    state: EventState,
    timestamp_ms: i64,
    duration_ms: ?u64 = null,
    evidence_id: ?[]const u8 = null,
    anchor_id: ?[]const u8 = null,
    reason_code: ?[]const u8 = null,
    edge_from: ?[]const u8 = null,
    edge_to: ?[]const u8 = null,
    independence_class: ?[]const u8 = null,
    counter_metric_id: ?[]const u8 = null,
    effect_scope: ?[]const u8 = null,
    blocker: ?[]const u8 = null,
    schema_version: u16 = SCHEMA_VERSION,

    pub fn validate(self: CausalEvent) !void {
        if (self.schema_version != SCHEMA_VERSION) return error.UnsupportedSchema;
        try requireId(self.event_id);
        try requireId(self.trace_id);
        try requireId(self.node_id);
        try requireId(self.purpose_id);
        try requireToken(self.role);
        if (self.owner_id) |v| try requireId(v);
        if (self.cadence) |v| try requireToken(v);
        if (self.parent_event_id) |v| try requireId(v);
        if (self.contract_id) |v| try requireId(v);
        if (self.evidence_id) |v| try requireId(v);
        if (self.anchor_id) |v| try requireId(v);
        if (self.reason_code) |v| try requireToken(v);
        if (self.edge_from) |v| try requireId(v);
        if (self.edge_to) |v| try requireId(v);
        if (self.independence_class) |v| try requireId(v);
        if (self.counter_metric_id) |v| try requireId(v);
        if (self.effect_scope) |v| try requireToken(v);
        if (self.blocker) |v| try requireToken(v);
        if (self.timestamp_ms < 0) return error.InvalidTimestamp;
    }
};

fn requireId(value: []const u8) !void {
    if (value.len == 0 or value.len > 128) return error.InvalidId;
    if (secretShaped(value)) return error.SecretShapedValue;
    for (value) |c| {
        if (!(std.ascii.isAlphanumeric(c) or c == '-' or c == '_' or c == '.' or c == ':'))
            return error.InvalidId;
    }
}

fn requireToken(value: []const u8) !void {
    if (value.len == 0 or value.len > 64) return error.InvalidToken;
    if (secretShaped(value)) return error.SecretShapedValue;
    for (value) |c| {
        if (!(std.ascii.isAlphanumeric(c) or c == '-' or c == '_' or c == '.'))
            return error.InvalidToken;
    }
}

fn secretShaped(value: []const u8) bool {
    var lower_buf: [128]u8 = undefined;
    const n = @min(value.len, lower_buf.len);
    for (value[0..n], 0..) |c, i| lower_buf[i] = std.ascii.toLower(c);
    const lower = lower_buf[0..n];
    return std.mem.indexOf(u8, lower, "password") != null or
        std.mem.indexOf(u8, lower, "private_key") != null or
        std.mem.indexOf(u8, lower, "api_key") != null or
        std.mem.indexOf(u8, lower, "bearer") != null or
        std.mem.startsWith(u8, lower, "sk-");
}

/// Canonical JSONL record. Field order is stable so traces can be hashed,
/// diffed, and rendered deterministically.
pub fn encode(writer: anytype, event: CausalEvent) !void {
    try event.validate();
    try writer.writeAll("{\"schema_version\":");
    try writer.print("{d}", .{event.schema_version});
    try field(writer, "event_id", event.event_id);
    try field(writer, "trace_id", event.trace_id);
    try field(writer, "node_id", event.node_id);
    try optionalField(writer, "parent_event_id", event.parent_event_id);
    try optionalField(writer, "contract_id", event.contract_id);
    try field(writer, "purpose_id", event.purpose_id);
    try field(writer, "role", event.role);
    try optionalField(writer, "owner_id", event.owner_id);
    try optionalField(writer, "cadence", event.cadence);
    try field(writer, "kind", @tagName(event.kind));
    try field(writer, "state", @tagName(event.state));
    try writer.print(",\"timestamp_ms\":{d}", .{event.timestamp_ms});
    if (event.duration_ms) |v| try writer.print(",\"duration_ms\":{d}", .{v}) else try writer.writeAll(",\"duration_ms\":null");
    try optionalField(writer, "evidence_id", event.evidence_id);
    try optionalField(writer, "anchor_id", event.anchor_id);
    try optionalField(writer, "reason_code", event.reason_code);
    try optionalField(writer, "edge_from", event.edge_from);
    try optionalField(writer, "edge_to", event.edge_to);
    try optionalField(writer, "independence_class", event.independence_class);
    try optionalField(writer, "counter_metric_id", event.counter_metric_id);
    try optionalField(writer, "effect_scope", event.effect_scope);
    try optionalField(writer, "blocker", event.blocker);
    try writer.writeAll("}\n");
}

fn field(writer: anytype, name: []const u8, value: []const u8) !void {
    try writer.print(",\"{s}\":\"{s}\"", .{ name, value });
}

fn optionalField(writer: anytype, name: []const u8, value: ?[]const u8) !void {
    if (value) |v|
        try field(writer, name, v)
    else
        try writer.print(",\"{s}\":null", .{name});
}

test "causal event encoding is stable and rejects payload-shaped values" {
    var out: [1024]u8 = undefined;
    var writer = std.Io.Writer.fixed(&out);
    try encode(&writer, .{
        .event_id = "evt-1",
        .trace_id = "trace-1",
        .node_id = "sensor-1",
        .parent_event_id = "evt-0",
        .contract_id = "contract-1",
        .purpose_id = "purpose-1",
        .role = "sensor",
        .kind = .evidence_collected,
        .state = .satisfied,
        .timestamp_ms = 42,
        .duration_ms = 7,
        .evidence_id = "evidence-1",
        .anchor_id = "anchor-1",
    });
    const encoded = writer.buffered();
    try std.testing.expect(std.mem.startsWith(u8, encoded, "{\"schema_version\":1,\"event_id\":\"evt-1\""));
    try std.testing.expect(std.mem.endsWith(u8, encoded, "\"blocker\":null}\n"));

    var bad = CausalEvent{
        .event_id = "evt\nsecret",
        .trace_id = "trace-1",
        .node_id = "node-1",
        .purpose_id = "purpose-1",
        .role = "action",
        .kind = .started,
        .state = .working,
        .timestamp_ms = 1,
    };
    try std.testing.expectError(error.InvalidId, bad.validate());
    bad.event_id = "sk-plantedfixture123456";
    try std.testing.expectError(error.SecretShapedValue, bad.validate());
}

test "every renderer lifecycle state has a valid event representation" {
    const states = [_]EventState{
        .working,
        .waiting_evidence,
        .waiting_approval,
        .veto,
        .stale,
        .contradicted,
        .rollback,
        .recovered,
        .unresolved,
        .satisfied,
    };
    for (states, 0..) |state, i| {
        var id_buf: [32]u8 = undefined;
        const id = try std.fmt.bufPrint(&id_buf, "event-{d}", .{i});
        var out: [2048]u8 = undefined;
        var writer = std.Io.Writer.fixed(&out);
        try encode(&writer, .{
            .event_id = id,
            .trace_id = "trace-states",
            .node_id = "node-1",
            .purpose_id = "purpose-1",
            .role = "evaluator",
            .kind = .evaluated,
            .state = state,
            .timestamp_ms = 1,
        });
    }
}
