//! Mechanical reflex policy. Ranking proposes; this module alone decides
//! whether a learned action may fire, should only be prepared, or must hold.

const std = @import("std");

pub const Decision = enum { fire, prepare, hold };

pub const Request = struct {
    enabled: bool = true,
    capability_enabled: bool = false,
    successes: u32 = 0,
    failures: u32 = 0,
    confidence: f64 = 0,
    effect_scope: []const u8 = "unknown",
    authority: bool = false,
    reversible: bool = false,
    read_only: bool = false,
    estimated_cost: f64 = 0,
    max_cost: f64 = 0,
};

pub const Verdict = struct {
    decision: Decision,
    reason: []const u8,
};

fn consequential(scope: []const u8) bool {
    const scopes = [_][]const u8{
        "external_message",
        "purchase",
        "job_application",
        "credential_access",
        "delete",
        "publish",
        "permission_change",
        "account_mutation",
    };
    for (scopes) |candidate| if (std.mem.eql(u8, scope, candidate)) return true;
    return false;
}

pub fn decide(request: Request) Verdict {
    if (!request.enabled) return .{ .decision = .hold, .reason = "global_kill_switch" };
    if (!request.capability_enabled) return .{ .decision = .hold, .reason = "capability_disabled" };
    if (request.estimated_cost < 0 or request.max_cost < 0 or request.estimated_cost > request.max_cost)
        return .{ .decision = .hold, .reason = "cost_budget" };
    if (consequential(request.effect_scope) and !request.authority)
        return .{ .decision = .hold, .reason = "authority_required" };
    if (request.failures > 0)
        return .{ .decision = .prepare, .reason = "unresolved_failure" };
    if (request.successes < 3 or request.confidence < 0.9)
        return .{ .decision = .prepare, .reason = "insufficient_grounded_evidence" };
    if (!request.read_only and !request.reversible and !request.authority)
        return .{ .decision = .hold, .reason = "irreversible_without_authority" };
    return .{ .decision = .fire, .reason = "grounded_policy_match" };
}

test "safe reflex needs three grounded successes" {
    try std.testing.expectEqual(Decision.prepare, decide(.{
        .capability_enabled = true,
        .successes = 2,
        .confidence = 1,
        .read_only = true,
    }).decision);
    try std.testing.expectEqual(Decision.fire, decide(.{
        .capability_enabled = true,
        .successes = 3,
        .confidence = 1,
        .read_only = true,
    }).decision);
}

test "confidence never substitutes for consequential authority" {
    const verdict = decide(.{
        .capability_enabled = true,
        .successes = 100,
        .confidence = 1,
        .effect_scope = "external_message",
        .reversible = true,
    });
    try std.testing.expectEqual(Decision.hold, verdict.decision);
    try std.testing.expectEqualStrings("authority_required", verdict.reason);
}

test "kill switch failure and cost fail closed" {
    try std.testing.expectEqual(Decision.hold, decide(.{ .enabled = false }).decision);
    try std.testing.expectEqual(Decision.prepare, decide(.{
        .capability_enabled = true,
        .successes = 3,
        .failures = 1,
        .confidence = 1,
        .read_only = true,
    }).decision);
    try std.testing.expectEqual(Decision.hold, decide(.{
        .capability_enabled = true,
        .successes = 3,
        .confidence = 1,
        .read_only = true,
        .estimated_cost = 2,
        .max_cost = 1,
    }).decision);
}
