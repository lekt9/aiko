//! governance.zig — effect reach, consequence coverage, target ownership,
//! and bad-news priority for agency graphs.

const std = @import("std");
const agency = @import("agency.zig");

pub const ConsequenceSensor = struct {
    id: []const u8,
    action_id: []const u8,
    observed_scope: agency.EffectScope,
    anchor_id: []const u8,
    fresh: bool,
    contradiction: bool = false,
};

pub const ReachDeclaration = struct {
    action_id: []const u8,
    effect_scope: agency.EffectScope,
    capability_scope: agency.EffectScope,
    approval_id: ?[]const u8 = null,
    sensors: []const ConsequenceSensor = &.{},
};

pub const ReachReason = enum {
    covered,
    no_consequence_sensor,
    stale_consequence_sensor,
    scope_not_observed,
    capability_too_narrow,
    approval_required,
    contradictory_consequence,
};

pub const ReachDecision = struct {
    allowed: bool,
    reason: ReachReason,
};

fn scopeRank(scope: agency.EffectScope) u8 {
    return switch (scope) {
        .none => 0,
        .local_read => 1,
        .local_write => 2,
        .network_read => 3,
        .network_mutation => 4,
        .message => 5,
        .deployment => 6,
        .human_impact => 7,
        .payment => 8,
        .onchain => 9,
    };
}

pub fn evaluateReach(declaration: ReachDeclaration) ReachDecision {
    if (scopeRank(declaration.capability_scope) < scopeRank(declaration.effect_scope))
        return .{ .allowed = false, .reason = .capability_too_narrow };
    if (declaration.effect_scope.requiresExplicitApproval() and
        (declaration.approval_id == null or declaration.approval_id.?.len == 0))
        return .{ .allowed = false, .reason = .approval_required };
    if (!declaration.effect_scope.requiresConsequenceSensor())
        return .{ .allowed = true, .reason = .covered };
    if (declaration.sensors.len == 0)
        return .{ .allowed = false, .reason = .no_consequence_sensor };

    var found_scope = false;
    var found_fresh = false;
    for (declaration.sensors) |sensor| {
        if (!std.mem.eql(u8, sensor.action_id, declaration.action_id)) continue;
        if (scopeRank(sensor.observed_scope) < scopeRank(declaration.effect_scope)) continue;
        found_scope = true;
        if (!sensor.fresh or sensor.anchor_id.len == 0) continue;
        found_fresh = true;
        if (sensor.contradiction)
            return .{ .allowed = false, .reason = .contradictory_consequence };
        return .{ .allowed = true, .reason = .covered };
    }
    if (!found_scope) return .{ .allowed = false, .reason = .scope_not_observed };
    if (!found_fresh) return .{ .allowed = false, .reason = .stale_consequence_sensor };
    return .{ .allowed = false, .reason = .no_consequence_sensor };
}

pub const TargetOwnership = struct {
    target_id: []const u8,
    purpose_id: []const u8,
    owner_id: []const u8,
    owner_authority: []const u8,
    owner_cadence: agency.CadenceClass,
    frozen: bool,
};

pub const TargetMutation = struct {
    target_id: []const u8,
    actor_id: []const u8,
    actor_authority: []const u8,
    actor_role: agency.NodeRole,
    actor_cadence: agency.CadenceClass,
    purpose_id: []const u8,
    reason: []const u8,
};

pub const GovernanceError = error{
    WrongTarget,
    WrongPurpose,
    OwnerRequired,
    SlowLoopRequired,
    FrozenTarget,
    MissingReason,
    ConflictUnresolved,
};

/// A target has exactly one owner. Non-owners may propose a change but cannot
/// apply it through this function. Frozen targets require the owner itself.
pub fn authorizeTargetMutation(
    ownership: TargetOwnership,
    mutation: TargetMutation,
) GovernanceError!void {
    if (!std.mem.eql(u8, ownership.target_id, mutation.target_id))
        return GovernanceError.WrongTarget;
    if (!std.mem.eql(u8, ownership.purpose_id, mutation.purpose_id))
        return GovernanceError.WrongPurpose;
    if (mutation.reason.len == 0) return GovernanceError.MissingReason;
    if (mutation.actor_role != .governor and mutation.actor_role != .purpose)
        return GovernanceError.OwnerRequired;
    if (mutation.actor_cadence.rank() < ownership.owner_cadence.rank())
        return GovernanceError.SlowLoopRequired;
    if (!std.mem.eql(u8, ownership.owner_id, mutation.actor_id) or
        !std.mem.eql(u8, ownership.owner_authority, mutation.actor_authority))
        return if (ownership.frozen) GovernanceError.FrozenTarget else GovernanceError.OwnerRequired;
}

pub const LoopConflict = struct {
    id: []const u8,
    purpose_id: []const u8,
    left_action_id: []const u8,
    right_action_id: []const u8,
    tradeoff: []const u8,
};

pub const Arbitration = struct {
    conflict_id: []const u8,
    governor_id: []const u8,
    governor_role: agency.NodeRole,
    governor_cadence: agency.CadenceClass,
    purpose_id: []const u8,
    selected_action_id: ?[]const u8,
    reason: []const u8,
    effective_at_ms: i64,
};

pub fn authorizeArbitration(conflict: LoopConflict, decision: Arbitration) GovernanceError!void {
    if (!std.mem.eql(u8, conflict.id, decision.conflict_id) or
        !std.mem.eql(u8, conflict.purpose_id, decision.purpose_id))
        return GovernanceError.WrongPurpose;
    if (decision.governor_role != .governor or
        decision.governor_cadence.rank() < agency.CadenceClass.management.rank())
        return GovernanceError.SlowLoopRequired;
    const selected = decision.selected_action_id orelse return GovernanceError.ConflictUnresolved;
    if (!(std.mem.eql(u8, selected, conflict.left_action_id) or
        std.mem.eql(u8, selected, conflict.right_action_id)))
        return GovernanceError.WrongTarget;
    if (decision.reason.len == 0) return GovernanceError.MissingReason;
}

pub const TargetRevision = struct {
    target_id: []const u8,
    author_id: []const u8,
    reason: []const u8,
    evidence_id: []const u8,
    effective_at_ms: i64,
    previous_revision_id: ?[]const u8,
    revision_id: []const u8,
};

pub fn validateRevision(previous: ?TargetRevision, revision: TargetRevision) GovernanceError!void {
    if (revision.target_id.len == 0 or revision.author_id.len == 0 or revision.reason.len == 0 or
        revision.evidence_id.len == 0 or revision.revision_id.len == 0)
        return GovernanceError.MissingReason;
    if (previous) |prior| {
        if (!std.mem.eql(u8, prior.target_id, revision.target_id)) return GovernanceError.WrongTarget;
        const pointer = revision.previous_revision_id orelse return GovernanceError.WrongTarget;
        if (!std.mem.eql(u8, pointer, prior.revision_id) or revision.effective_at_ms <= prior.effective_at_ms)
            return GovernanceError.WrongTarget;
    } else if (revision.previous_revision_id != null) return GovernanceError.WrongTarget;
}

pub const FailureKind = enum {
    action_failed,
    contradiction,
    sensor_lost,
    anchor_expired,
    capability_breach,
    evidence_compromised,
};

pub const FailureEvent = struct {
    id: []const u8,
    kind: FailureKind,
    source_id: []const u8,
    owner_id: []const u8,
    cause_id: []const u8,
    observed_at: i64,
};

/// Negative evidence always bypasses positive-result cache reuse.
pub fn bypassPositiveCache(event: FailureEvent) bool {
    _ = event;
    return true;
}

test "high-risk reach needs approval and a fresh same-reach sensor" {
    const missing = evaluateReach(.{
        .action_id = "deploy-1",
        .effect_scope = .deployment,
        .capability_scope = .deployment,
    });
    try std.testing.expectEqual(ReachReason.approval_required, missing.reason);

    const sensors = [_]ConsequenceSensor{.{
        .id = "sensor-1",
        .action_id = "deploy-1",
        .observed_scope = .deployment,
        .anchor_id = "anchor-1",
        .fresh = true,
    }};
    const covered = evaluateReach(.{
        .action_id = "deploy-1",
        .effect_scope = .deployment,
        .capability_scope = .deployment,
        .approval_id = "approval:human",
        .sensors = &sensors,
    });
    try std.testing.expect(covered.allowed);
}

test "capability cannot widen and contradiction vetoes success" {
    const narrow = evaluateReach(.{
        .action_id = "mutation-1",
        .effect_scope = .network_mutation,
        .capability_scope = .network_read,
        .approval_id = "approval:human",
    });
    try std.testing.expectEqual(ReachReason.capability_too_narrow, narrow.reason);

    const sensors = [_]ConsequenceSensor{.{
        .id = "sensor-1",
        .action_id = "mutation-1",
        .observed_scope = .network_mutation,
        .anchor_id = "anchor-1",
        .fresh = true,
        .contradiction = true,
    }};
    const contradicted = evaluateReach(.{
        .action_id = "mutation-1",
        .effect_scope = .network_mutation,
        .capability_scope = .network_mutation,
        .approval_id = "approval:human",
        .sensors = &sensors,
    });
    try std.testing.expectEqual(ReachReason.contradictory_consequence, contradicted.reason);
}

test "only the slow authoritative owner mutates a frozen target" {
    const ownership = TargetOwnership{
        .target_id = "target:error-rate",
        .purpose_id = "purpose:root",
        .owner_id = "governor:safety",
        .owner_authority = "identity:human",
        .owner_cadence = .audit,
        .frozen = true,
    };
    try std.testing.expectError(GovernanceError.OwnerRequired, authorizeTargetMutation(ownership, .{
        .target_id = ownership.target_id,
        .actor_id = "action:optimizer",
        .actor_authority = "identity:worker",
        .actor_role = .action,
        .actor_cadence = .operational,
        .purpose_id = ownership.purpose_id,
        .reason = "make the check easier",
    }));
    try authorizeTargetMutation(ownership, .{
        .target_id = ownership.target_id,
        .actor_id = ownership.owner_id,
        .actor_authority = ownership.owner_authority,
        .actor_role = .governor,
        .actor_cadence = .audit,
        .purpose_id = ownership.purpose_id,
        .reason = "fresh independent evidence supports a revision",
    });
}

test "bad news always bypasses positive cache" {
    try std.testing.expect(bypassPositiveCache(.{
        .id = "failure-1",
        .kind = .contradiction,
        .source_id = "sensor-1",
        .owner_id = "governor-1",
        .cause_id = "anchor-1",
        .observed_at = 100,
    }));
}

test "conflicting loops remain blocked until a slow governor arbitrates" {
    const conflict = LoopConflict{
        .id = "conflict-1",
        .purpose_id = "purpose-1",
        .left_action_id = "fast-response",
        .right_action_id = "safe-response",
        .tradeoff = "speed-versus-error-rate",
    };
    var decision = Arbitration{
        .conflict_id = "conflict-1",
        .governor_id = "governor-1",
        .governor_role = .action,
        .governor_cadence = .operational,
        .purpose_id = "purpose-1",
        .selected_action_id = null,
        .reason = "",
        .effective_at_ms = 100,
    };
    try std.testing.expectError(GovernanceError.SlowLoopRequired, authorizeArbitration(conflict, decision));
    decision.governor_role = .governor;
    decision.governor_cadence = .management;
    try std.testing.expectError(GovernanceError.ConflictUnresolved, authorizeArbitration(conflict, decision));
    decision.selected_action_id = "safe-response";
    decision.reason = "error-rate veto outranks speed";
    try authorizeArbitration(conflict, decision);
}

test "target revision history is causally reconstructable" {
    const first = TargetRevision{
        .target_id = "target-1",
        .author_id = "governor-1",
        .reason = "initial",
        .evidence_id = "evidence-1",
        .effective_at_ms = 10,
        .previous_revision_id = null,
        .revision_id = "revision-1",
    };
    try validateRevision(null, first);
    const second = TargetRevision{
        .target_id = "target-1",
        .author_id = "governor-1",
        .reason = "counter-metric changed",
        .evidence_id = "evidence-2",
        .effective_at_ms = 20,
        .previous_revision_id = "revision-1",
        .revision_id = "revision-2",
    };
    try validateRevision(first, second);
}
