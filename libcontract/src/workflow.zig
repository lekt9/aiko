//! Grounded action → consequence sensor → evaluator workflow.

const std = @import("std");
const agency = @import("agency.zig");
const anchor = @import("anchor.zig");
const event_schema = @import("event_schema.zig");
const governance = @import("governance.zig");

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
