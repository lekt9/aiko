//! Compatibility bridge from legacy single-loop rows to governed agency rows.

const std = @import("std");
const agency = @import("agency.zig");

pub const Classification = enum {
    legacy_ungoverned,
    typed_valid,
    typed_invalid,
};

pub const ShadowVerdict = enum {
    same,
    stricter,
    incompatible,
};

pub const BridgeResult = struct {
    classification: Classification,
    shadow: ShadowVerdict,
    legacy_allowed: bool,
    agency_allowed: bool,
    reason: []const u8,
};

/// Missing typed data is explicitly legacy, never guessed. Present malformed
/// data is invalid, never silently downgraded to legacy.
pub fn classify(allocator: std.mem.Allocator, encoded: ?[]const u8) BridgeResult {
    const bytes = encoded orelse return .{
        .classification = .legacy_ungoverned,
        .shadow = .same,
        .legacy_allowed = true,
        .agency_allowed = true,
        .reason = "legacy-row-no-agency-envelope",
    };
    var parsed = agency.decodeEnvelope(allocator, bytes) catch return .{
        .classification = .typed_invalid,
        .shadow = .incompatible,
        .legacy_allowed = true,
        .agency_allowed = false,
        .reason = "typed-envelope-invalid-fail-closed",
    };
    parsed.deinit();
    return .{
        .classification = .typed_valid,
        .shadow = .same,
        .legacy_allowed = true,
        .agency_allowed = true,
        .reason = "typed-envelope-valid",
    };
}

pub fn compare(legacy_allowed: bool, agency_allowed: bool) ShadowVerdict {
    if (legacy_allowed == agency_allowed) return .same;
    if (legacy_allowed and !agency_allowed) return .stricter;
    return .incompatible;
}

pub const AbsorptionRequest = struct {
    legacy_id: []const u8,
    proposed_role: agency.NodeRole,
    authority_pointer: []const u8,
    purpose_id: []const u8,
    cadence_class: agency.CadenceClass,
    effect_scope: agency.EffectScope,
    evidence_policy_id: ?[]const u8,
    valid_from: i64,
    valid_until: i64,
    interpretation_unambiguous: bool,
};

/// Legacy meaning is upgraded only after an explicit, unambiguous absorption
/// request. There is no inference from action strings or historical success.
pub fn absorbLegacy(request: AbsorptionRequest) !agency.NodeEnvelope {
    if (request.legacy_id.len == 0 or !request.interpretation_unambiguous)
        return error.AmbiguousLegacyRole;
    if (!(request.proposed_role == .action or request.proposed_role == .evaluator))
        return error.UnsupportedLegacyRole;
    const envelope = agency.NodeEnvelope{
        .role = request.proposed_role,
        .authority_pointer = request.authority_pointer,
        .purpose_id = request.purpose_id,
        .cadence_class = request.cadence_class,
        .effect_scope = request.effect_scope,
        .evidence_policy_id = request.evidence_policy_id,
        .valid_from = request.valid_from,
        .valid_until = request.valid_until,
        .supersedes = request.legacy_id,
    };
    try agency.validateEnvelope(envelope);
    return envelope;
}

test "bridge never guesses roles or downgrades malformed typed rows" {
    const allocator = std.testing.allocator;
    const legacy = classify(allocator, null);
    try std.testing.expectEqual(Classification.legacy_ungoverned, legacy.classification);
    const malformed = classify(allocator, "{\"role\":\"action\"}");
    try std.testing.expectEqual(Classification.typed_invalid, malformed.classification);
    try std.testing.expectEqual(ShadowVerdict.incompatible, malformed.shadow);
}

test "shadow verdict distinguishes stricter policy from semantic widening" {
    try std.testing.expectEqual(ShadowVerdict.same, compare(true, true));
    try std.testing.expectEqual(ShadowVerdict.stricter, compare(true, false));
    try std.testing.expectEqual(ShadowVerdict.incompatible, compare(false, true));
}

test "legacy absorption requires explicit unambiguous action or evaluator semantics" {
    var request = AbsorptionRequest{
        .legacy_id = "legacy-1",
        .proposed_role = .action,
        .authority_pointer = "governor-1",
        .purpose_id = "purpose-1",
        .cadence_class = .operational,
        .effect_scope = .local_write,
        .evidence_policy_id = "policy-1",
        .valid_from = 0,
        .valid_until = 100,
        .interpretation_unambiguous = false,
    };
    try std.testing.expectError(error.AmbiguousLegacyRole, absorbLegacy(request));
    request.interpretation_unambiguous = true;
    const envelope = try absorbLegacy(request);
    try std.testing.expectEqual(agency.NodeRole.action, envelope.role);
    try std.testing.expectEqualStrings("legacy-1", envelope.supersedes.?);
    request.proposed_role = .sensor;
    try std.testing.expectError(error.UnsupportedLegacyRole, absorbLegacy(request));
}
