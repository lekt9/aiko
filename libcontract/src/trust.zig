//! trust.zig — grounded evaluation primitives for contract graphs.
//!
//! Signatures prove authorship; this module decides whether the signed
//! evidence is sufficient to promote a claim.  The decision is deliberately
//! pure so every CLI/server surface can apply the same rules before appending
//! a verdict to the ledger.

const std = @import("std");

pub const SourceKind = enum {
    physical_observation,
    settled_transaction,
    executed_test,
    filesystem_observation,
    external_api,
    browser_state,
    human_attestation,
    adapter_measurement,
    ledger,
    derived_report,
    agent_judgment,
};

pub const MetricRole = enum {
    primary,
    counter,
    constraint,
};

pub const Comparison = enum {
    greater_or_equal,
    less_or_equal,
    equal,
};

pub const ArbitrationMode = enum {
    /// Primary improvement can never compensate for a failed counter-metric
    /// or safety constraint. The policy owner must amend the frozen policy to
    /// change the trade-off.
    counter_veto,
};

pub const EvidenceStatus = enum {
    active,
    revoked,
};

/// A typed observation. `source_id` names the actual system or instrument,
/// while `evaluator_identity` names who interpreted it. `failure_domain`
/// names shared infrastructure so two wallets reading the same broken API do
/// not masquerade as independent witnesses.
pub const EvidenceEnvelope = struct {
    id: []const u8,
    claim_id: []const u8,
    metric_id: []const u8,
    role: MetricRole,
    source_kind: SourceKind,
    source_id: []const u8,
    evaluator_identity: []const u8,
    failure_domain: []const u8,
    observed_at: i64,
    expires_at: i64,
    value: f64,
    derivation_ids: []const []const u8 = &.{},
    status: EvidenceStatus = .active,
    evaluator_signature: []const u8 = "",
};

pub const MetricRule = struct {
    metric_id: []const u8,
    role: MetricRole,
    comparison: Comparison,
    threshold: f64,
};

pub const EvaluationPolicy = struct {
    id: []const u8,
    claim_id: []const u8,
    owner_identity: []const u8,
    amendment_actor_identity: []const u8,
    builder_identity: []const u8,
    deployment_slot: []const u8,
    authority_signature: []const u8 = "",
    require_separate_evaluator: bool = true,
    arbitration: ArbitrationMode = .counter_veto,
    frozen: bool = true,
    version: u32 = 1,
    minimum_independent_witnesses: usize = 2,
    rules: []const MetricRule,
};

pub const PolicyAmendment = struct {
    policy_id: []const u8,
    from_version: u32,
    actor_identity: []const u8,
};

pub const DecisionReason = enum {
    promoted,
    missing_primary_metric,
    missing_counter_metric,
    missing_constraint_metric,
    insufficient_independence,
    stale_evidence,
    revoked_evidence,
    circular_provenance,
    metric_threshold_failed,
    evaluator_is_builder,
};

pub const Decision = struct {
    promote: bool,
    reason: DecisionReason,
};

pub const TrustError = error{
    EmptyEvidenceId,
    EmptyClaimId,
    EmptyMetricId,
    EmptySourceId,
    EmptyEvaluatorIdentity,
    EmptyFailureDomain,
    InvalidValidityWindow,
    PolicyIdMismatch,
    PolicyVersionMismatch,
    FrozenPolicyOwnerRequired,
    InvalidJson,
    UnknownTrustEvent,
    MissingTrustField,
    InvalidTrustField,
    InvalidPolicySignature,
    OutOfMemory,
};

pub const TrustEventKind = enum {
    trust_evidence,
    trust_policy,
    trust_promotion,
    trust_revocation,
    trust_activation,
    trust_rollback,
};

pub const RevocationEvent = struct {
    evidence_id: []const u8,
    claim_id: []const u8,
    actor_identity: []const u8,
    cause: []const u8,
    revoked_at: i64,
    authority_signature: []const u8 = "",
};

pub const PromotionEvent = struct {
    claim_id: []const u8,
    policy_id: []const u8,
    policy_version: u32,
    evidence_ids: []const []const u8,
    promoted_at: i64,
    signer_identity: []const u8 = "",
    authority_signature: []const u8 = "",
};

pub const ActivationEvent = struct {
    slot_id: []const u8,
    revision_id: []const u8,
    policy_id: []const u8,
    policy_version: u32,
    activated_at: i64,
    signer_identity: []const u8 = "",
    authority_signature: []const u8 = "",
};

pub const RollbackEvent = struct {
    slot_id: []const u8,
    failed_revision_id: []const u8,
    restored_revision_id: []const u8,
    policy_id: []const u8,
    policy_version: u32,
    rolled_back_at: i64,
    signer_identity: []const u8 = "",
    authority_signature: []const u8 = "",
};

fn writeJsonString(
    out: *std.ArrayList(u8),
    allocator: std.mem.Allocator,
    value: []const u8,
) TrustError!void {
    out.append(allocator, '"') catch return TrustError.OutOfMemory;
    for (value) |byte| {
        switch (byte) {
            '"' => out.appendSlice(allocator, "\\\"") catch return TrustError.OutOfMemory,
            '\\' => out.appendSlice(allocator, "\\\\") catch return TrustError.OutOfMemory,
            '\n' => out.appendSlice(allocator, "\\n") catch return TrustError.OutOfMemory,
            '\r' => out.appendSlice(allocator, "\\r") catch return TrustError.OutOfMemory,
            '\t' => out.appendSlice(allocator, "\\t") catch return TrustError.OutOfMemory,
            0...8, 11...12, 14...0x1f => {
                var escaped: [6]u8 = undefined;
                const encoded = std.fmt.bufPrint(&escaped, "\\u{x:0>4}", .{byte}) catch
                    return TrustError.OutOfMemory;
                out.appendSlice(allocator, encoded) catch return TrustError.OutOfMemory;
            },
            else => out.append(allocator, byte) catch return TrustError.OutOfMemory,
        }
    }
    out.append(allocator, '"') catch return TrustError.OutOfMemory;
}

fn writeInteger(
    out: *std.ArrayList(u8),
    allocator: std.mem.Allocator,
    value: anytype,
) TrustError!void {
    var buffer: [32]u8 = undefined;
    const encoded = std.fmt.bufPrint(&buffer, "{d}", .{value}) catch
        return TrustError.InvalidTrustField;
    out.appendSlice(allocator, encoded) catch return TrustError.OutOfMemory;
}

fn writeFloat(
    out: *std.ArrayList(u8),
    allocator: std.mem.Allocator,
    value: f64,
) TrustError!void {
    var buffer: [64]u8 = undefined;
    const encoded = std.fmt.bufPrint(&buffer, "{d}", .{value}) catch
        return TrustError.InvalidTrustField;
    out.appendSlice(allocator, encoded) catch return TrustError.OutOfMemory;
}

fn writeFieldPrefix(
    out: *std.ArrayList(u8),
    allocator: std.mem.Allocator,
    name: []const u8,
    first: bool,
) TrustError!void {
    out.appendSlice(allocator, if (first) "{" else ",") catch return TrustError.OutOfMemory;
    try writeJsonString(out, allocator, name);
    out.append(allocator, ':') catch return TrustError.OutOfMemory;
}

fn sourceKindName(value: SourceKind) []const u8 {
    return @tagName(value);
}

fn metricRoleName(value: MetricRole) []const u8 {
    return @tagName(value);
}

fn comparisonName(value: Comparison) []const u8 {
    return @tagName(value);
}

fn evidenceStatusName(value: EvidenceStatus) []const u8 {
    return @tagName(value);
}

fn bytesToHex(bytes: []const u8, out: []u8) void {
    const alphabet = "0123456789abcdef";
    for (bytes, 0..) |byte, i| {
        out[i * 2] = alphabet[byte >> 4];
        out[i * 2 + 1] = alphabet[byte & 0x0f];
    }
}

fn fromHex(char: u8) TrustError!u8 {
    return switch (char) {
        '0'...'9' => char - '0',
        'a'...'f' => char - 'a' + 10,
        'A'...'F' => char - 'A' + 10,
        else => TrustError.InvalidPolicySignature,
    };
}

fn parseHex(comptime size: usize, encoded: []const u8, out: *[size]u8) TrustError!void {
    if (encoded.len != size * 2) return TrustError.InvalidPolicySignature;
    for (out, 0..) |*byte, i|
        byte.* = (try fromHex(encoded[i * 2])) << 4 | try fromHex(encoded[i * 2 + 1]);
}

/// Canonical policy digest. Every field that can weaken evaluation is bound,
/// including ordered metric rules and their exact IEEE-754 threshold bits.
pub fn policyDigest(item: EvaluationPolicy, out: *[32]u8) void {
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    inline for (.{
        item.id,
        item.claim_id,
        item.owner_identity,
        item.amendment_actor_identity,
        item.builder_identity,
        item.deployment_slot,
        @tagName(item.arbitration),
    }) |field| {
        hasher.update(field);
        hasher.update(&.{0});
    }
    hasher.update(&.{@intFromBool(item.frozen)});
    hasher.update(&.{@intFromBool(item.require_separate_evaluator)});
    var numeric: [16]u8 = undefined;
    std.mem.writeInt(u32, numeric[0..4], item.version, .big);
    std.mem.writeInt(
        u64,
        numeric[4..12],
        @intCast(item.minimum_independent_witnesses),
        .big,
    );
    hasher.update(numeric[0..12]);
    for (item.rules) |rule| {
        hasher.update(rule.metric_id);
        hasher.update(&.{0});
        hasher.update(@tagName(rule.role));
        hasher.update(&.{0});
        hasher.update(@tagName(rule.comparison));
        hasher.update(&.{0});
        var threshold: [8]u8 = undefined;
        std.mem.writeInt(u64, &threshold, @bitCast(rule.threshold), .big);
        hasher.update(&threshold);
    }
    hasher.final(out);
}

pub fn verifyPolicySignature(item: EvaluationPolicy) TrustError!void {
    if (!std.mem.eql(u8, item.owner_identity, item.amendment_actor_identity) and
        item.frozen)
        return TrustError.FrozenPolicyOwnerRequired;
    var public_key_bytes: [32]u8 = undefined;
    var signature_bytes: [64]u8 = undefined;
    try parseHex(32, item.amendment_actor_identity, &public_key_bytes);
    try parseHex(64, item.authority_signature, &signature_bytes);
    const public_key = std.crypto.sign.Ed25519.PublicKey.fromBytes(public_key_bytes) catch
        return TrustError.InvalidPolicySignature;
    const signature = std.crypto.sign.Ed25519.Signature.fromBytes(signature_bytes);
    var digest: [32]u8 = undefined;
    policyDigest(item, &digest);
    signature.verify(&digest, public_key) catch return TrustError.InvalidPolicySignature;
}

pub fn evidenceDigest(item: EvidenceEnvelope, out: *[32]u8) void {
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    inline for (.{
        item.id,
        item.claim_id,
        item.metric_id,
        @tagName(item.role),
        @tagName(item.source_kind),
        item.source_id,
        item.evaluator_identity,
        item.failure_domain,
        @tagName(item.status),
    }) |field| {
        hasher.update(field);
        hasher.update(&.{0});
    }
    var numeric: [24]u8 = undefined;
    std.mem.writeInt(i64, numeric[0..8], item.observed_at, .big);
    std.mem.writeInt(i64, numeric[8..16], item.expires_at, .big);
    std.mem.writeInt(u64, numeric[16..24], @bitCast(item.value), .big);
    hasher.update(&numeric);
    for (item.derivation_ids) |id| {
        hasher.update(id);
        hasher.update(&.{0});
    }
    hasher.final(out);
}

pub fn verifyEvidenceSignature(item: EvidenceEnvelope) TrustError!void {
    var public_key_bytes: [32]u8 = undefined;
    var signature_bytes: [64]u8 = undefined;
    try parseHex(32, item.evaluator_identity, &public_key_bytes);
    try parseHex(64, item.evaluator_signature, &signature_bytes);
    const public_key = std.crypto.sign.Ed25519.PublicKey.fromBytes(public_key_bytes) catch
        return TrustError.InvalidPolicySignature;
    const signature = std.crypto.sign.Ed25519.Signature.fromBytes(signature_bytes);
    var digest: [32]u8 = undefined;
    evidenceDigest(item, &digest);
    signature.verify(&digest, public_key) catch return TrustError.InvalidPolicySignature;
}

pub fn revocationDigest(item: RevocationEvent, out: *[32]u8) void {
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    inline for (.{
        item.evidence_id,
        item.claim_id,
        item.actor_identity,
        item.cause,
    }) |field| {
        hasher.update(field);
        hasher.update(&.{0});
    }
    var timestamp: [8]u8 = undefined;
    std.mem.writeInt(i64, &timestamp, item.revoked_at, .big);
    hasher.update(&timestamp);
    hasher.final(out);
}

pub fn verifyRevocationSignature(item: RevocationEvent) TrustError!void {
    var public_key_bytes: [32]u8 = undefined;
    var signature_bytes: [64]u8 = undefined;
    try parseHex(32, item.actor_identity, &public_key_bytes);
    try parseHex(64, item.authority_signature, &signature_bytes);
    const public_key = std.crypto.sign.Ed25519.PublicKey.fromBytes(public_key_bytes) catch
        return TrustError.InvalidPolicySignature;
    const signature = std.crypto.sign.Ed25519.Signature.fromBytes(signature_bytes);
    var digest: [32]u8 = undefined;
    revocationDigest(item, &digest);
    signature.verify(&digest, public_key) catch return TrustError.InvalidPolicySignature;
}

fn verifyAuthorityDigest(
    signer_identity: []const u8,
    authority_signature: []const u8,
    digest: [32]u8,
) TrustError!void {
    var public_key_bytes: [32]u8 = undefined;
    var signature_bytes: [64]u8 = undefined;
    try parseHex(32, signer_identity, &public_key_bytes);
    try parseHex(64, authority_signature, &signature_bytes);
    const public_key = std.crypto.sign.Ed25519.PublicKey.fromBytes(public_key_bytes) catch
        return TrustError.InvalidPolicySignature;
    const signature = std.crypto.sign.Ed25519.Signature.fromBytes(signature_bytes);
    signature.verify(&digest, public_key) catch return TrustError.InvalidPolicySignature;
}

pub fn promotionDigest(item: PromotionEvent, out: *[32]u8) void {
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    inline for (.{ item.claim_id, item.policy_id, item.signer_identity }) |field| {
        hasher.update(field);
        hasher.update(&.{0});
    }
    var numeric: [12]u8 = undefined;
    std.mem.writeInt(u32, numeric[0..4], item.policy_version, .big);
    std.mem.writeInt(i64, numeric[4..12], item.promoted_at, .big);
    hasher.update(&numeric);
    for (item.evidence_ids) |id| {
        hasher.update(id);
        hasher.update(&.{0});
    }
    hasher.final(out);
}

pub fn activationDigest(item: ActivationEvent, out: *[32]u8) void {
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    inline for (.{
        item.slot_id,
        item.revision_id,
        item.policy_id,
        item.signer_identity,
    }) |field| {
        hasher.update(field);
        hasher.update(&.{0});
    }
    var numeric: [12]u8 = undefined;
    std.mem.writeInt(u32, numeric[0..4], item.policy_version, .big);
    std.mem.writeInt(i64, numeric[4..12], item.activated_at, .big);
    hasher.update(&numeric);
    hasher.final(out);
}

pub fn rollbackDigest(item: RollbackEvent, out: *[32]u8) void {
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    inline for (.{
        item.slot_id,
        item.failed_revision_id,
        item.restored_revision_id,
        item.policy_id,
        item.signer_identity,
    }) |field| {
        hasher.update(field);
        hasher.update(&.{0});
    }
    var numeric: [12]u8 = undefined;
    std.mem.writeInt(u32, numeric[0..4], item.policy_version, .big);
    std.mem.writeInt(i64, numeric[4..12], item.rolled_back_at, .big);
    hasher.update(&numeric);
    hasher.final(out);
}

pub fn verifyPromotionSignature(item: PromotionEvent) TrustError!void {
    var digest: [32]u8 = undefined;
    promotionDigest(item, &digest);
    try verifyAuthorityDigest(item.signer_identity, item.authority_signature, digest);
}

pub fn verifyActivationSignature(item: ActivationEvent) TrustError!void {
    var digest: [32]u8 = undefined;
    activationDigest(item, &digest);
    try verifyAuthorityDigest(item.signer_identity, item.authority_signature, digest);
}

pub fn verifyRollbackSignature(item: RollbackEvent) TrustError!void {
    var digest: [32]u8 = undefined;
    rollbackDigest(item, &digest);
    try verifyAuthorityDigest(item.signer_identity, item.authority_signature, digest);
}

pub fn encodeEvidence(
    allocator: std.mem.Allocator,
    item: EvidenceEnvelope,
) TrustError![]u8 {
    try validateEvidence(item);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);

    try writeFieldPrefix(&out, allocator, "event", true);
    try writeJsonString(&out, allocator, "trust_evidence");
    inline for (.{
        .{ "id", item.id },
        .{ "claim_id", item.claim_id },
        .{ "metric_id", item.metric_id },
        .{ "role", metricRoleName(item.role) },
        .{ "source_kind", sourceKindName(item.source_kind) },
        .{ "source_id", item.source_id },
        .{ "evaluator_identity", item.evaluator_identity },
        .{ "failure_domain", item.failure_domain },
        .{ "status", evidenceStatusName(item.status) },
        .{ "evaluator_signature", item.evaluator_signature },
    }) |field| {
        try writeFieldPrefix(&out, allocator, field[0], false);
        try writeJsonString(&out, allocator, field[1]);
    }
    try writeFieldPrefix(&out, allocator, "observed_at", false);
    try writeInteger(&out, allocator, item.observed_at);
    try writeFieldPrefix(&out, allocator, "expires_at", false);
    try writeInteger(&out, allocator, item.expires_at);
    try writeFieldPrefix(&out, allocator, "value", false);
    try writeFloat(&out, allocator, item.value);
    try writeFieldPrefix(&out, allocator, "derivation_ids", false);
    out.append(allocator, '[') catch return TrustError.OutOfMemory;
    for (item.derivation_ids, 0..) |id, i| {
        if (i > 0) out.append(allocator, ',') catch return TrustError.OutOfMemory;
        try writeJsonString(&out, allocator, id);
    }
    out.appendSlice(allocator, "]}") catch return TrustError.OutOfMemory;
    return out.toOwnedSlice(allocator) catch return TrustError.OutOfMemory;
}

pub fn encodePolicy(
    allocator: std.mem.Allocator,
    item: EvaluationPolicy,
) TrustError![]u8 {
    if (item.id.len == 0 or item.claim_id.len == 0 or
        item.owner_identity.len == 0 or item.amendment_actor_identity.len == 0 or
        item.builder_identity.len == 0 or item.deployment_slot.len == 0 or
        item.authority_signature.len == 0 or
        item.version == 0)
        return TrustError.InvalidTrustField;
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try writeFieldPrefix(&out, allocator, "event", true);
    try writeJsonString(&out, allocator, "trust_policy");
    inline for (.{
        .{ "id", item.id },
        .{ "claim_id", item.claim_id },
        .{ "owner_identity", item.owner_identity },
        .{ "amendment_actor_identity", item.amendment_actor_identity },
        .{ "builder_identity", item.builder_identity },
        .{ "deployment_slot", item.deployment_slot },
        .{ "authority_signature", item.authority_signature },
    }) |field| {
        try writeFieldPrefix(&out, allocator, field[0], false);
        try writeJsonString(&out, allocator, field[1]);
    }
    try writeFieldPrefix(&out, allocator, "frozen", false);
    out.appendSlice(allocator, if (item.frozen) "true" else "false") catch
        return TrustError.OutOfMemory;
    try writeFieldPrefix(&out, allocator, "require_separate_evaluator", false);
    out.appendSlice(
        allocator,
        if (item.require_separate_evaluator) "true" else "false",
    ) catch return TrustError.OutOfMemory;
    try writeFieldPrefix(&out, allocator, "arbitration", false);
    try writeJsonString(&out, allocator, @tagName(item.arbitration));
    try writeFieldPrefix(&out, allocator, "version", false);
    try writeInteger(&out, allocator, item.version);
    try writeFieldPrefix(&out, allocator, "minimum_independent_witnesses", false);
    try writeInteger(&out, allocator, item.minimum_independent_witnesses);
    try writeFieldPrefix(&out, allocator, "rules", false);
    out.append(allocator, '[') catch return TrustError.OutOfMemory;
    for (item.rules, 0..) |rule, i| {
        if (i > 0) out.append(allocator, ',') catch return TrustError.OutOfMemory;
        out.appendSlice(allocator, "{\"metric_id\":") catch return TrustError.OutOfMemory;
        try writeJsonString(&out, allocator, rule.metric_id);
        out.appendSlice(allocator, ",\"role\":") catch return TrustError.OutOfMemory;
        try writeJsonString(&out, allocator, metricRoleName(rule.role));
        out.appendSlice(allocator, ",\"comparison\":") catch return TrustError.OutOfMemory;
        try writeJsonString(&out, allocator, comparisonName(rule.comparison));
        out.appendSlice(allocator, ",\"threshold\":") catch return TrustError.OutOfMemory;
        try writeFloat(&out, allocator, rule.threshold);
        out.append(allocator, '}') catch return TrustError.OutOfMemory;
    }
    out.appendSlice(allocator, "]}") catch return TrustError.OutOfMemory;
    return out.toOwnedSlice(allocator) catch return TrustError.OutOfMemory;
}

pub fn encodePromotion(
    allocator: std.mem.Allocator,
    event: PromotionEvent,
) TrustError![]u8 {
    if (event.claim_id.len == 0 or event.policy_id.len == 0 or
        event.policy_version == 0 or event.evidence_ids.len == 0 or
        event.signer_identity.len == 0 or event.authority_signature.len == 0)
        return TrustError.InvalidTrustField;
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try writeFieldPrefix(&out, allocator, "event", true);
    try writeJsonString(&out, allocator, "trust_promotion");
    try writeFieldPrefix(&out, allocator, "claim_id", false);
    try writeJsonString(&out, allocator, event.claim_id);
    try writeFieldPrefix(&out, allocator, "policy_id", false);
    try writeJsonString(&out, allocator, event.policy_id);
    try writeFieldPrefix(&out, allocator, "signer_identity", false);
    try writeJsonString(&out, allocator, event.signer_identity);
    try writeFieldPrefix(&out, allocator, "authority_signature", false);
    try writeJsonString(&out, allocator, event.authority_signature);
    try writeFieldPrefix(&out, allocator, "policy_version", false);
    try writeInteger(&out, allocator, event.policy_version);
    try writeFieldPrefix(&out, allocator, "promoted_at", false);
    try writeInteger(&out, allocator, event.promoted_at);
    try writeFieldPrefix(&out, allocator, "evidence_ids", false);
    out.append(allocator, '[') catch return TrustError.OutOfMemory;
    for (event.evidence_ids, 0..) |id, i| {
        if (i > 0) out.append(allocator, ',') catch return TrustError.OutOfMemory;
        try writeJsonString(&out, allocator, id);
    }
    out.appendSlice(allocator, "]}") catch return TrustError.OutOfMemory;
    return out.toOwnedSlice(allocator) catch return TrustError.OutOfMemory;
}

pub fn encodeRevocation(
    allocator: std.mem.Allocator,
    event: RevocationEvent,
) TrustError![]u8 {
    if (event.evidence_id.len == 0 or event.claim_id.len == 0 or
        event.actor_identity.len == 0 or event.cause.len == 0)
        return TrustError.InvalidTrustField;
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try writeFieldPrefix(&out, allocator, "event", true);
    try writeJsonString(&out, allocator, "trust_revocation");
    inline for (.{
        .{ "evidence_id", event.evidence_id },
        .{ "claim_id", event.claim_id },
        .{ "actor_identity", event.actor_identity },
        .{ "cause", event.cause },
        .{ "authority_signature", event.authority_signature },
    }) |field| {
        try writeFieldPrefix(&out, allocator, field[0], false);
        try writeJsonString(&out, allocator, field[1]);
    }
    try writeFieldPrefix(&out, allocator, "revoked_at", false);
    try writeInteger(&out, allocator, event.revoked_at);
    out.append(allocator, '}') catch return TrustError.OutOfMemory;
    return out.toOwnedSlice(allocator) catch return TrustError.OutOfMemory;
}

pub fn encodeActivation(
    allocator: std.mem.Allocator,
    event: ActivationEvent,
) TrustError![]u8 {
    if (event.slot_id.len == 0 or event.revision_id.len == 0 or
        event.policy_id.len == 0 or event.policy_version == 0 or
        event.signer_identity.len == 0 or event.authority_signature.len == 0)
        return TrustError.InvalidTrustField;
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try writeFieldPrefix(&out, allocator, "event", true);
    try writeJsonString(&out, allocator, "trust_activation");
    inline for (.{
        .{ "slot_id", event.slot_id },
        .{ "revision_id", event.revision_id },
        .{ "policy_id", event.policy_id },
        .{ "signer_identity", event.signer_identity },
        .{ "authority_signature", event.authority_signature },
    }) |field| {
        try writeFieldPrefix(&out, allocator, field[0], false);
        try writeJsonString(&out, allocator, field[1]);
    }
    try writeFieldPrefix(&out, allocator, "policy_version", false);
    try writeInteger(&out, allocator, event.policy_version);
    try writeFieldPrefix(&out, allocator, "activated_at", false);
    try writeInteger(&out, allocator, event.activated_at);
    out.append(allocator, '}') catch return TrustError.OutOfMemory;
    return out.toOwnedSlice(allocator) catch return TrustError.OutOfMemory;
}

pub fn encodeRollback(
    allocator: std.mem.Allocator,
    event: RollbackEvent,
) TrustError![]u8 {
    if (event.slot_id.len == 0 or event.failed_revision_id.len == 0 or
        event.restored_revision_id.len == 0 or event.policy_id.len == 0 or
        event.policy_version == 0 or event.signer_identity.len == 0 or
        event.authority_signature.len == 0)
        return TrustError.InvalidTrustField;
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try writeFieldPrefix(&out, allocator, "event", true);
    try writeJsonString(&out, allocator, "trust_rollback");
    inline for (.{
        .{ "slot_id", event.slot_id },
        .{ "failed_revision_id", event.failed_revision_id },
        .{ "restored_revision_id", event.restored_revision_id },
        .{ "policy_id", event.policy_id },
        .{ "signer_identity", event.signer_identity },
        .{ "authority_signature", event.authority_signature },
    }) |field| {
        try writeFieldPrefix(&out, allocator, field[0], false);
        try writeJsonString(&out, allocator, field[1]);
    }
    try writeFieldPrefix(&out, allocator, "policy_version", false);
    try writeInteger(&out, allocator, event.policy_version);
    try writeFieldPrefix(&out, allocator, "rolled_back_at", false);
    try writeInteger(&out, allocator, event.rolled_back_at);
    out.append(allocator, '}') catch return TrustError.OutOfMemory;
    return out.toOwnedSlice(allocator) catch return TrustError.OutOfMemory;
}

fn requiredString(obj: std.json.ObjectMap, name: []const u8) TrustError![]const u8 {
    const value = obj.get(name) orelse return TrustError.MissingTrustField;
    if (value != .string or value.string.len == 0) return TrustError.InvalidTrustField;
    return value.string;
}

fn requiredInteger(obj: std.json.ObjectMap, name: []const u8) TrustError!i64 {
    const value = obj.get(name) orelse return TrustError.MissingTrustField;
    if (value != .integer) return TrustError.InvalidTrustField;
    return value.integer;
}

/// Validate a serialized trust row without mutating or normalizing it.
/// Unknown fields remain forward-compatible; required fields and their basic
/// types remain fail-closed.
pub fn validateTrustEvent(
    allocator: std.mem.Allocator,
    json: []const u8,
) TrustError!TrustEventKind {
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, json, .{}) catch
        return TrustError.InvalidJson;
    defer parsed.deinit();
    if (parsed.value != .object) return TrustError.InvalidJson;
    const obj = parsed.value.object;
    const event_name = try requiredString(obj, "event");
    const kind = std.meta.stringToEnum(TrustEventKind, event_name) orelse
        return TrustError.UnknownTrustEvent;
    switch (kind) {
        .trust_evidence => {
            _ = try requiredString(obj, "id");
            _ = try requiredString(obj, "claim_id");
            _ = try requiredString(obj, "metric_id");
            _ = try requiredString(obj, "role");
            _ = try requiredString(obj, "source_kind");
            _ = try requiredString(obj, "source_id");
            _ = try requiredString(obj, "evaluator_identity");
            _ = try requiredString(obj, "failure_domain");
            _ = try requiredString(obj, "status");
            _ = try requiredString(obj, "evaluator_signature");
            const observed = try requiredInteger(obj, "observed_at");
            const expires = try requiredInteger(obj, "expires_at");
            if (expires <= observed) return TrustError.InvalidTrustField;
            const value = obj.get("value") orelse return TrustError.MissingTrustField;
            if (value != .float and value != .integer) return TrustError.InvalidTrustField;
            const derivations = obj.get("derivation_ids") orelse
                return TrustError.MissingTrustField;
            if (derivations != .array) return TrustError.InvalidTrustField;
        },
        .trust_policy => {
            _ = try requiredString(obj, "id");
            _ = try requiredString(obj, "claim_id");
            _ = try requiredString(obj, "owner_identity");
            _ = try requiredString(obj, "amendment_actor_identity");
            _ = try requiredString(obj, "builder_identity");
            _ = try requiredString(obj, "deployment_slot");
            _ = try requiredString(obj, "authority_signature");
            const frozen = obj.get("frozen") orelse return TrustError.MissingTrustField;
            if (frozen != .bool) return TrustError.InvalidTrustField;
            const separate = obj.get("require_separate_evaluator") orelse
                return TrustError.MissingTrustField;
            if (separate != .bool) return TrustError.InvalidTrustField;
            _ = try enumField(ArbitrationMode, obj, "arbitration");
            if (try requiredInteger(obj, "version") < 1) return TrustError.InvalidTrustField;
            if (try requiredInteger(obj, "minimum_independent_witnesses") < 1)
                return TrustError.InvalidTrustField;
            const policy_rules = obj.get("rules") orelse return TrustError.MissingTrustField;
            if (policy_rules != .array or policy_rules.array.items.len == 0)
                return TrustError.InvalidTrustField;
        },
        .trust_promotion => {
            _ = try requiredString(obj, "claim_id");
            _ = try requiredString(obj, "policy_id");
            _ = try requiredString(obj, "signer_identity");
            _ = try requiredString(obj, "authority_signature");
            if (try requiredInteger(obj, "policy_version") < 1)
                return TrustError.InvalidTrustField;
            _ = try requiredInteger(obj, "promoted_at");
            const ids = obj.get("evidence_ids") orelse return TrustError.MissingTrustField;
            if (ids != .array or ids.array.items.len == 0)
                return TrustError.InvalidTrustField;
        },
        .trust_revocation => {
            _ = try requiredString(obj, "evidence_id");
            _ = try requiredString(obj, "claim_id");
            _ = try requiredString(obj, "actor_identity");
            _ = try requiredString(obj, "cause");
            _ = try requiredString(obj, "authority_signature");
            _ = try requiredInteger(obj, "revoked_at");
        },
        .trust_activation => {
            _ = try requiredString(obj, "slot_id");
            _ = try requiredString(obj, "revision_id");
            _ = try requiredString(obj, "policy_id");
            _ = try requiredString(obj, "signer_identity");
            _ = try requiredString(obj, "authority_signature");
            if (try requiredInteger(obj, "policy_version") < 1)
                return TrustError.InvalidTrustField;
            _ = try requiredInteger(obj, "activated_at");
        },
        .trust_rollback => {
            _ = try requiredString(obj, "slot_id");
            _ = try requiredString(obj, "failed_revision_id");
            _ = try requiredString(obj, "restored_revision_id");
            _ = try requiredString(obj, "policy_id");
            _ = try requiredString(obj, "signer_identity");
            _ = try requiredString(obj, "authority_signature");
            if (try requiredInteger(obj, "policy_version") < 1)
                return TrustError.InvalidTrustField;
            _ = try requiredInteger(obj, "rolled_back_at");
        },
    }
    return kind;
}

fn enumField(
    comptime T: type,
    obj: std.json.ObjectMap,
    name: []const u8,
) TrustError!T {
    const raw = try requiredString(obj, name);
    return std.meta.stringToEnum(T, raw) orelse TrustError.InvalidTrustField;
}

fn numberField(obj: std.json.ObjectMap, name: []const u8) TrustError!f64 {
    const value = obj.get(name) orelse return TrustError.MissingTrustField;
    return switch (value) {
        .float => value.float,
        .integer => @floatFromInt(value.integer),
        else => TrustError.InvalidTrustField,
    };
}

/// Reconstruct the latest governed state for one claim from an append-only
/// JSONL ledger and evaluate it. `null` means the claim has no trust policy
/// and remains legacy/un-governed. A malformed trust row or invalid policy
/// transition fails closed.
pub fn evaluateLedger(
    allocator: std.mem.Allocator,
    ledger_jsonl: []const u8,
    claim_id: []const u8,
    now: i64,
) TrustError!?Decision {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var observations: std.ArrayList(EvidenceEnvelope) = .empty;
    var revocations: std.ArrayList(RevocationEvent) = .empty;
    var current_policy: ?EvaluationPolicy = null;

    var lines = std.mem.tokenizeScalar(u8, ledger_jsonl, '\n');
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        var parsed = std.json.parseFromSlice(std.json.Value, arena, line, .{}) catch {
            // Non-trust legacy rows retain their historic permissive parser.
            if (std.mem.indexOf(u8, line, "\"event\":\"trust_") != null or
                std.mem.indexOf(u8, line, "\"event\": \"trust_") != null)
                return TrustError.InvalidJson;
            continue;
        };
        _ = &parsed; // arena owns the parsed tree for the duration of replay.
        if (parsed.value != .object) continue;
        const obj = parsed.value.object;
        const event_value = obj.get("event") orelse continue;
        if (event_value != .string) continue;
        const kind = std.meta.stringToEnum(TrustEventKind, event_value.string) orelse
            continue;
        _ = try validateTrustEvent(arena, line);

        switch (kind) {
            .trust_evidence => {
                if (!std.mem.eql(u8, try requiredString(obj, "claim_id"), claim_id))
                    continue;
                const derivation_values = obj.get("derivation_ids").?.array.items;
                var derivations: std.ArrayList([]const u8) = .empty;
                for (derivation_values) |value| {
                    if (value != .string or value.string.len == 0)
                        return TrustError.InvalidTrustField;
                    derivations.append(arena, value.string) catch return TrustError.OutOfMemory;
                }
                const observation = EvidenceEnvelope{
                    .id = try requiredString(obj, "id"),
                    .claim_id = try requiredString(obj, "claim_id"),
                    .metric_id = try requiredString(obj, "metric_id"),
                    .role = try enumField(MetricRole, obj, "role"),
                    .source_kind = try enumField(SourceKind, obj, "source_kind"),
                    .source_id = try requiredString(obj, "source_id"),
                    .evaluator_identity = try requiredString(obj, "evaluator_identity"),
                    .failure_domain = try requiredString(obj, "failure_domain"),
                    .observed_at = try requiredInteger(obj, "observed_at"),
                    .expires_at = try requiredInteger(obj, "expires_at"),
                    .value = try numberField(obj, "value"),
                    .derivation_ids = derivations.items,
                    .status = try enumField(EvidenceStatus, obj, "status"),
                    .evaluator_signature = try requiredString(obj, "evaluator_signature"),
                };
                try verifyEvidenceSignature(observation);
                observations.append(arena, observation) catch return TrustError.OutOfMemory;
            },
            .trust_revocation => {
                if (!std.mem.eql(u8, try requiredString(obj, "claim_id"), claim_id))
                    continue;
                const revocation = RevocationEvent{
                    .evidence_id = try requiredString(obj, "evidence_id"),
                    .claim_id = try requiredString(obj, "claim_id"),
                    .actor_identity = try requiredString(obj, "actor_identity"),
                    .cause = try requiredString(obj, "cause"),
                    .revoked_at = try requiredInteger(obj, "revoked_at"),
                    .authority_signature = try requiredString(obj, "authority_signature"),
                };
                try verifyRevocationSignature(revocation);
                revocations.append(arena, revocation) catch return TrustError.OutOfMemory;
            },
            .trust_policy => {
                if (!std.mem.eql(u8, try requiredString(obj, "claim_id"), claim_id))
                    continue;
                const rule_values = obj.get("rules").?.array.items;
                var parsed_rules: std.ArrayList(MetricRule) = .empty;
                for (rule_values) |rule_value| {
                    if (rule_value != .object) return TrustError.InvalidTrustField;
                    const rule_obj = rule_value.object;
                    parsed_rules.append(arena, .{
                        .metric_id = try requiredString(rule_obj, "metric_id"),
                        .role = try enumField(MetricRole, rule_obj, "role"),
                        .comparison = try enumField(Comparison, rule_obj, "comparison"),
                        .threshold = try numberField(rule_obj, "threshold"),
                    }) catch return TrustError.OutOfMemory;
                }
                const version_value = try requiredInteger(obj, "version");
                const witness_value = try requiredInteger(obj, "minimum_independent_witnesses");
                if (version_value < 1 or version_value > std.math.maxInt(u32) or
                    witness_value < 1)
                    return TrustError.InvalidTrustField;
                const candidate = EvaluationPolicy{
                    .id = try requiredString(obj, "id"),
                    .claim_id = try requiredString(obj, "claim_id"),
                    .owner_identity = try requiredString(obj, "owner_identity"),
                    .amendment_actor_identity = try requiredString(
                        obj,
                        "amendment_actor_identity",
                    ),
                    .builder_identity = try requiredString(obj, "builder_identity"),
                    .deployment_slot = try requiredString(obj, "deployment_slot"),
                    .authority_signature = try requiredString(obj, "authority_signature"),
                    .require_separate_evaluator = obj.get(
                        "require_separate_evaluator",
                    ).?.bool,
                    .arbitration = try enumField(ArbitrationMode, obj, "arbitration"),
                    .frozen = obj.get("frozen").?.bool,
                    .version = @intCast(version_value),
                    .minimum_independent_witnesses = @intCast(witness_value),
                    .rules = parsed_rules.items,
                };
                try verifyPolicySignature(candidate);
                if (current_policy) |current| {
                    if (!std.mem.eql(u8, current.id, candidate.id))
                        return TrustError.PolicyIdMismatch;
                    if (candidate.version != current.version + 1)
                        return TrustError.PolicyVersionMismatch;
                    try authorizeAmendment(current, .{
                        .policy_id = candidate.id,
                        .from_version = current.version,
                        .actor_identity = candidate.amendment_actor_identity,
                    });
                    if (!std.mem.eql(u8, current.owner_identity, candidate.owner_identity))
                        return TrustError.FrozenPolicyOwnerRequired;
                } else if (candidate.frozen and
                    !std.mem.eql(
                        u8,
                        candidate.owner_identity,
                        candidate.amendment_actor_identity,
                    ))
                {
                    return TrustError.FrozenPolicyOwnerRequired;
                }
                current_policy = candidate;
            },
            .trust_promotion, .trust_activation, .trust_rollback => {},
        }
    }

    const governed_policy = current_policy orelse return null;
    for (observations.items) |*observation| {
        for (revocations.items) |revocation| {
            if (std.mem.eql(u8, observation.id, revocation.evidence_id)) {
                if (!std.mem.eql(
                    u8,
                    observation.evaluator_identity,
                    revocation.actor_identity,
                ))
                    return TrustError.InvalidPolicySignature;
                observation.status = .revoked;
                break;
            }
        }
    }
    return try evaluate(arena, governed_policy, observations.items, now);
}

/// Select the newest prior activation that is compatible with the failed
/// revision's exact policy id and version and has not itself been revoked.
/// Returns an owned revision id. No candidate means the slot must remain HOLD.
pub fn selectRollbackFromLedger(
    allocator: std.mem.Allocator,
    ledger_jsonl: []const u8,
    slot_id: []const u8,
    failed_revision_id: []const u8,
    policy_id: []const u8,
    policy_version: u32,
    policy_owner_identity: []const u8,
) TrustError!?[]u8 {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var activations: std.ArrayList(ActivationEvent) = .empty;
    var revoked_revisions: std.ArrayList([]const u8) = .empty;
    var lines = std.mem.tokenizeScalar(u8, ledger_jsonl, '\n');
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        var parsed = std.json.parseFromSlice(std.json.Value, arena, line, .{}) catch continue;
        _ = &parsed;
        if (parsed.value != .object) continue;
        const obj = parsed.value.object;
        const event_value = obj.get("event") orelse continue;
        if (event_value != .string) continue;
        if (std.mem.eql(u8, event_value.string, "died")) {
            revoked_revisions.append(arena, try requiredString(obj, "id")) catch
                return TrustError.OutOfMemory;
            continue;
        }
        const kind = std.meta.stringToEnum(TrustEventKind, event_value.string) orelse continue;
        switch (kind) {
            .trust_activation => {
                _ = try validateTrustEvent(arena, line);
                const version = try requiredInteger(obj, "policy_version");
                if (version > std.math.maxInt(u32)) return TrustError.InvalidTrustField;
                const activation = ActivationEvent{
                    .slot_id = try requiredString(obj, "slot_id"),
                    .revision_id = try requiredString(obj, "revision_id"),
                    .policy_id = try requiredString(obj, "policy_id"),
                    .policy_version = @intCast(version),
                    .activated_at = try requiredInteger(obj, "activated_at"),
                    .signer_identity = try requiredString(obj, "signer_identity"),
                    .authority_signature = try requiredString(obj, "authority_signature"),
                };
                try verifyActivationSignature(activation);
                if (!std.mem.eql(
                    u8,
                    activation.signer_identity,
                    policy_owner_identity,
                ))
                    return TrustError.InvalidPolicySignature;
                activations.append(arena, activation) catch return TrustError.OutOfMemory;
            },
            else => {},
        }
    }

    var failed_at: ?i64 = null;
    for (activations.items) |activation| {
        if (std.mem.eql(u8, activation.slot_id, slot_id) and
            std.mem.eql(u8, activation.revision_id, failed_revision_id) and
            std.mem.eql(u8, activation.policy_id, policy_id) and
            activation.policy_version == policy_version)
            failed_at = activation.activated_at;
    }
    const cutoff = failed_at orelse return null;

    var best: ?ActivationEvent = null;
    for (activations.items) |activation| {
        if (!std.mem.eql(u8, activation.slot_id, slot_id)) continue;
        if (!std.mem.eql(u8, activation.policy_id, policy_id)) continue;
        if (activation.policy_version != policy_version) continue;
        if (activation.activated_at >= cutoff) continue;
        var revoked = false;
        for (revoked_revisions.items) |revision_id| {
            if (std.mem.eql(u8, activation.revision_id, revision_id)) {
                revoked = true;
                break;
            }
        }
        if (revoked) continue;
        if (best == null or activation.activated_at > best.?.activated_at)
            best = activation;
    }
    if (best) |candidate|
        return allocator.dupe(u8, candidate.revision_id) catch TrustError.OutOfMemory;
    return null;
}

pub const PromotionContext = struct {
    policy_id: []u8,
    policy_owner_identity: []u8,
    deployment_slot: []u8,
    policy_version: u32,
    evidence_ids: [][]u8,

    pub fn deinit(self: *PromotionContext, allocator: std.mem.Allocator) void {
        allocator.free(self.policy_id);
        allocator.free(self.policy_owner_identity);
        allocator.free(self.deployment_slot);
        for (self.evidence_ids) |id| allocator.free(id);
        allocator.free(self.evidence_ids);
        self.* = undefined;
    }
};

/// Extract the durable identifiers needed to record a successful promotion
/// and activation. Call only after evaluateLedger returned PROMOTE.
pub fn promotionContextFromLedger(
    allocator: std.mem.Allocator,
    ledger_jsonl: []const u8,
    claim_id: []const u8,
) TrustError!?PromotionContext {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var latest_policy_id: ?[]const u8 = null;
    var latest_policy_owner: ?[]const u8 = null;
    var latest_slot: ?[]const u8 = null;
    var latest_version: u32 = 0;
    var evidence_ids: std.ArrayList([]const u8) = .empty;
    var revoked_ids: std.ArrayList([]const u8) = .empty;

    var lines = std.mem.tokenizeScalar(u8, ledger_jsonl, '\n');
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        var parsed = std.json.parseFromSlice(std.json.Value, arena, line, .{}) catch continue;
        _ = &parsed;
        if (parsed.value != .object) continue;
        const obj = parsed.value.object;
        const event_value = obj.get("event") orelse continue;
        if (event_value != .string) continue;
        const kind = std.meta.stringToEnum(TrustEventKind, event_value.string) orelse continue;
        switch (kind) {
            .trust_policy => {
                if (!std.mem.eql(u8, try requiredString(obj, "claim_id"), claim_id))
                    continue;
                _ = try validateTrustEvent(arena, line);
                const version = try requiredInteger(obj, "version");
                if (version < 1 or version > std.math.maxInt(u32))
                    return TrustError.InvalidTrustField;
                latest_policy_id = try requiredString(obj, "id");
                latest_policy_owner = try requiredString(obj, "owner_identity");
                latest_slot = try requiredString(obj, "deployment_slot");
                latest_version = @intCast(version);
            },
            .trust_evidence => {
                if (!std.mem.eql(u8, try requiredString(obj, "claim_id"), claim_id))
                    continue;
                _ = try validateTrustEvent(arena, line);
                if ((try enumField(EvidenceStatus, obj, "status")) == .active)
                    evidence_ids.append(arena, try requiredString(obj, "id")) catch
                        return TrustError.OutOfMemory;
            },
            .trust_revocation => {
                if (!std.mem.eql(u8, try requiredString(obj, "claim_id"), claim_id))
                    continue;
                revoked_ids.append(arena, try requiredString(obj, "evidence_id")) catch
                    return TrustError.OutOfMemory;
            },
            else => {},
        }
    }
    const policy_id = latest_policy_id orelse return null;
    const policy_owner = latest_policy_owner orelse return TrustError.MissingTrustField;
    const slot = latest_slot orelse return TrustError.MissingTrustField;

    var active_ids: std.ArrayList([]u8) = .empty;
    errdefer {
        for (active_ids.items) |id| allocator.free(id);
        active_ids.deinit(allocator);
    }
    for (evidence_ids.items) |evidence_id| {
        var revoked = false;
        for (revoked_ids.items) |revoked_id| {
            if (std.mem.eql(u8, evidence_id, revoked_id)) {
                revoked = true;
                break;
            }
        }
        if (!revoked)
            active_ids.append(allocator, allocator.dupe(u8, evidence_id) catch
                return TrustError.OutOfMemory) catch return TrustError.OutOfMemory;
    }
    const owned_policy_id = allocator.dupe(u8, policy_id) catch return TrustError.OutOfMemory;
    errdefer allocator.free(owned_policy_id);
    const owned_policy_owner = allocator.dupe(u8, policy_owner) catch
        return TrustError.OutOfMemory;
    errdefer allocator.free(owned_policy_owner);
    const owned_slot = allocator.dupe(u8, slot) catch return TrustError.OutOfMemory;
    errdefer allocator.free(owned_slot);
    const owned_evidence = active_ids.toOwnedSlice(allocator) catch return TrustError.OutOfMemory;
    return .{
        .policy_id = owned_policy_id,
        .policy_owner_identity = owned_policy_owner,
        .deployment_slot = owned_slot,
        .policy_version = latest_version,
        .evidence_ids = owned_evidence,
    };
}

pub fn validateEvidence(evidence: EvidenceEnvelope) TrustError!void {
    if (evidence.id.len == 0) return TrustError.EmptyEvidenceId;
    if (evidence.claim_id.len == 0) return TrustError.EmptyClaimId;
    if (evidence.metric_id.len == 0) return TrustError.EmptyMetricId;
    if (evidence.source_id.len == 0) return TrustError.EmptySourceId;
    if (evidence.evaluator_identity.len == 0) return TrustError.EmptyEvaluatorIdentity;
    if (evidence.failure_domain.len == 0) return TrustError.EmptyFailureDomain;
    if (evidence.expires_at <= evidence.observed_at) return TrustError.InvalidValidityWindow;
}

/// Frozen policy changes require the current owner's authority. Non-frozen
/// policies still require monotonic versions and an exact policy id.
pub fn authorizeAmendment(
    current: EvaluationPolicy,
    amendment: PolicyAmendment,
) TrustError!void {
    if (!std.mem.eql(u8, current.id, amendment.policy_id))
        return TrustError.PolicyIdMismatch;
    if (amendment.from_version != current.version)
        return TrustError.PolicyVersionMismatch;
    if (current.frozen and
        !std.mem.eql(u8, current.owner_identity, amendment.actor_identity))
        return TrustError.FrozenPolicyOwnerRequired;
}

fn satisfies(value: f64, comparison: Comparison, threshold: f64) bool {
    return switch (comparison) {
        .greater_or_equal => value >= threshold,
        .less_or_equal => value <= threshold,
        .equal => value == threshold,
    };
}

fn findEvidenceById(
    evidence: []const EvidenceEnvelope,
    id: []const u8,
) ?usize {
    for (evidence, 0..) |item, i| {
        if (std.mem.eql(u8, item.id, id)) return i;
    }
    return null;
}

fn provenanceVisits(
    evidence: []const EvidenceEnvelope,
    index: usize,
    visiting: []bool,
    visited: []bool,
) bool {
    if (visiting[index]) return true;
    if (visited[index]) return false;
    visiting[index] = true;
    for (evidence[index].derivation_ids) |dependency_id| {
        if (findEvidenceById(evidence, dependency_id)) |dependency_index| {
            if (provenanceVisits(evidence, dependency_index, visiting, visited))
                return true;
        }
    }
    visiting[index] = false;
    visited[index] = true;
    return false;
}

/// Detect epistemic cycles in evidence derivation, independently of whether
/// the contract dependency graph itself is a DAG.
pub fn hasProvenanceCycle(
    allocator: std.mem.Allocator,
    evidence: []const EvidenceEnvelope,
) TrustError!bool {
    const visiting = try allocator.alloc(bool, evidence.len);
    defer allocator.free(visiting);
    const visited = try allocator.alloc(bool, evidence.len);
    defer allocator.free(visited);
    @memset(visiting, false);
    @memset(visited, false);
    for (evidence, 0..) |_, i| {
        if (provenanceVisits(evidence, i, visiting, visited)) return true;
    }
    return false;
}

fn roleMissing(policy: EvaluationPolicy, role: MetricRole) bool {
    for (policy.rules) |rule| if (rule.role == role) return false;
    return true;
}

fn independentWitnessCount(
    allocator: std.mem.Allocator,
    candidates: []const EvidenceEnvelope,
) TrustError!usize {
    var accepted: std.ArrayList(usize) = .empty;
    defer accepted.deinit(allocator);

    for (candidates, 0..) |candidate, candidate_index| {
        var independent = true;
        for (accepted.items) |accepted_index| {
            const prior = candidates[accepted_index];
            if (std.mem.eql(u8, candidate.evaluator_identity, prior.evaluator_identity) or
                std.mem.eql(u8, candidate.source_id, prior.source_id) or
                std.mem.eql(u8, candidate.failure_domain, prior.failure_domain))
            {
                independent = false;
                break;
            }
        }
        if (independent) try accepted.append(allocator, candidate_index);
    }
    return accepted.items.len;
}

/// Evaluate a claim using only active, fresh, acyclic evidence. Every metric
/// rule must pass and must independently meet the witness threshold.
pub fn evaluate(
    allocator: std.mem.Allocator,
    policy: EvaluationPolicy,
    evidence: []const EvidenceEnvelope,
    now: i64,
) TrustError!Decision {
    if (roleMissing(policy, .primary))
        return .{ .promote = false, .reason = .missing_primary_metric };
    if (roleMissing(policy, .counter))
        return .{ .promote = false, .reason = .missing_counter_metric };
    if (roleMissing(policy, .constraint))
        return .{ .promote = false, .reason = .missing_constraint_metric };
    if (try hasProvenanceCycle(allocator, evidence))
        return .{ .promote = false, .reason = .circular_provenance };

    for (policy.rules) |rule| {
        var matching: std.ArrayList(EvidenceEnvelope) = .empty;
        defer matching.deinit(allocator);
        for (evidence) |item| {
            try validateEvidence(item);
            if (!std.mem.eql(u8, item.claim_id, policy.claim_id)) continue;
            if (!std.mem.eql(u8, item.metric_id, rule.metric_id)) continue;
            if (item.role != rule.role) continue;
            if (policy.require_separate_evaluator and
                std.mem.eql(u8, item.evaluator_identity, policy.builder_identity))
                return .{ .promote = false, .reason = .evaluator_is_builder };
            if (item.status == .revoked)
                return .{ .promote = false, .reason = .revoked_evidence };
            if (now < item.observed_at or now >= item.expires_at)
                return .{ .promote = false, .reason = .stale_evidence };
            if (!satisfies(item.value, rule.comparison, rule.threshold))
                return .{ .promote = false, .reason = .metric_threshold_failed };
            try matching.append(allocator, item);
        }
        if (try independentWitnessCount(allocator, matching.items) <
            policy.minimum_independent_witnesses)
        {
            return .{ .promote = false, .reason = .insufficient_independence };
        }
    }
    return .{ .promote = true, .reason = .promoted };
}

pub const ClaimEdge = struct {
    consumer_id: []const u8,
    producer_id: []const u8,
};

/// Compute the transitive set of claims whose accepted verdict must be
/// revoked after `root_claim_id` loses a supporting observation.
pub fn revocationClosure(
    allocator: std.mem.Allocator,
    root_claim_id: []const u8,
    edges: []const ClaimEdge,
) TrustError![][]u8 {
    var result: std.ArrayList([]u8) = .empty;
    errdefer {
        for (result.items) |id| allocator.free(id);
        result.deinit(allocator);
    }
    try result.append(allocator, try allocator.dupe(u8, root_claim_id));

    var cursor: usize = 0;
    while (cursor < result.items.len) : (cursor += 1) {
        const revoked_id = result.items[cursor];
        for (edges) |edge| {
            if (!std.mem.eql(u8, edge.producer_id, revoked_id)) continue;
            var seen = false;
            for (result.items) |existing| {
                if (std.mem.eql(u8, existing, edge.consumer_id)) {
                    seen = true;
                    break;
                }
            }
            if (!seen)
                try result.append(allocator, try allocator.dupe(u8, edge.consumer_id));
        }
    }
    return try result.toOwnedSlice(allocator);
}

fn fixtureEvidence(
    id: []const u8,
    metric_id: []const u8,
    role: MetricRole,
    source: []const u8,
    evaluator: []const u8,
    domain: []const u8,
    value: f64,
) EvidenceEnvelope {
    return .{
        .id = id,
        .claim_id = "claim001",
        .metric_id = metric_id,
        .role = role,
        .source_kind = .external_api,
        .source_id = source,
        .evaluator_identity = evaluator,
        .failure_domain = domain,
        .observed_at = 100,
        .expires_at = 200,
        .value = value,
    };
}

const rules = [_]MetricRule{
    .{ .metric_id = "resolution", .role = .primary, .comparison = .greater_or_equal, .threshold = 0.8 },
    .{ .metric_id = "retention", .role = .counter, .comparison = .greater_or_equal, .threshold = 0.9 },
    .{ .metric_id = "reopens", .role = .constraint, .comparison = .less_or_equal, .threshold = 0.05 },
};

const test_policy = EvaluationPolicy{
    .id = "policy01",
    .claim_id = "claim001",
    .owner_identity = "governor",
    .amendment_actor_identity = "governor",
    .builder_identity = "builder",
    .deployment_slot = "support-bot",
    .minimum_independent_witnesses = 2,
    .rules = &rules,
};

fn signedFixturePolicy(
    base: EvaluationPolicy,
    seed_byte: u8,
    public_hex: *[64]u8,
    signature_hex: *[128]u8,
) !EvaluationPolicy {
    const seed = [_]u8{seed_byte} ** 32;
    const key_pair = try std.crypto.sign.Ed25519.KeyPair.generateDeterministic(seed);
    bytesToHex(&key_pair.public_key.bytes, public_hex);
    var signed = base;
    signed.owner_identity = public_hex;
    signed.amendment_actor_identity = public_hex;
    signed.authority_signature = "";
    var digest: [32]u8 = undefined;
    policyDigest(signed, &digest);
    const signature = try key_pair.sign(&digest, null);
    bytesToHex(&signature.toBytes(), signature_hex);
    signed.authority_signature = signature_hex;
    return signed;
}

fn signedFixtureEvidence(
    base: EvidenceEnvelope,
    seed_byte: u8,
    public_hex: *[64]u8,
    signature_hex: *[128]u8,
) !EvidenceEnvelope {
    const seed = [_]u8{seed_byte} ** 32;
    const key_pair = try std.crypto.sign.Ed25519.KeyPair.generateDeterministic(seed);
    bytesToHex(&key_pair.public_key.bytes, public_hex);
    var signed = base;
    signed.evaluator_identity = public_hex;
    signed.evaluator_signature = "";
    var digest: [32]u8 = undefined;
    evidenceDigest(signed, &digest);
    const signature = try key_pair.sign(&digest, null);
    bytesToHex(&signature.toBytes(), signature_hex);
    signed.evaluator_signature = signature_hex;
    return signed;
}

fn signedFixtureRevocation(
    base: RevocationEvent,
    seed_byte: u8,
    public_hex: *[64]u8,
    signature_hex: *[128]u8,
) !RevocationEvent {
    const seed = [_]u8{seed_byte} ** 32;
    const key_pair = try std.crypto.sign.Ed25519.KeyPair.generateDeterministic(seed);
    bytesToHex(&key_pair.public_key.bytes, public_hex);
    var signed = base;
    signed.actor_identity = public_hex;
    signed.authority_signature = "";
    var digest: [32]u8 = undefined;
    revocationDigest(signed, &digest);
    const signature = try key_pair.sign(&digest, null);
    bytesToHex(&signature.toBytes(), signature_hex);
    signed.authority_signature = signature_hex;
    return signed;
}

fn encodeSignedActivation(
    allocator: std.mem.Allocator,
    base: ActivationEvent,
    seed_byte: u8,
) ![]u8 {
    const seed = [_]u8{seed_byte} ** 32;
    const key_pair = try std.crypto.sign.Ed25519.KeyPair.generateDeterministic(seed);
    var public_hex: [64]u8 = undefined;
    bytesToHex(&key_pair.public_key.bytes, &public_hex);
    var signed = base;
    signed.signer_identity = &public_hex;
    signed.authority_signature = "";
    var digest: [32]u8 = undefined;
    activationDigest(signed, &digest);
    const signature = try key_pair.sign(&digest, null);
    var signature_hex: [128]u8 = undefined;
    bytesToHex(&signature.toBytes(), &signature_hex);
    signed.authority_signature = &signature_hex;
    return encodeActivation(allocator, signed);
}

fn encodeSignedPromotion(
    allocator: std.mem.Allocator,
    base: PromotionEvent,
    seed_byte: u8,
) ![]u8 {
    const seed = [_]u8{seed_byte} ** 32;
    const key_pair = try std.crypto.sign.Ed25519.KeyPair.generateDeterministic(seed);
    var public_hex: [64]u8 = undefined;
    bytesToHex(&key_pair.public_key.bytes, &public_hex);
    var signed = base;
    signed.signer_identity = &public_hex;
    signed.authority_signature = "";
    var digest: [32]u8 = undefined;
    promotionDigest(signed, &digest);
    const signature = try key_pair.sign(&digest, null);
    var signature_hex: [128]u8 = undefined;
    bytesToHex(&signature.toBytes(), &signature_hex);
    signed.authority_signature = &signature_hex;
    return encodePromotion(allocator, signed);
}

fn encodeSignedRollback(
    allocator: std.mem.Allocator,
    base: RollbackEvent,
    seed_byte: u8,
) ![]u8 {
    const seed = [_]u8{seed_byte} ** 32;
    const key_pair = try std.crypto.sign.Ed25519.KeyPair.generateDeterministic(seed);
    var public_hex: [64]u8 = undefined;
    bytesToHex(&key_pair.public_key.bytes, &public_hex);
    var signed = base;
    signed.signer_identity = &public_hex;
    signed.authority_signature = "";
    var digest: [32]u8 = undefined;
    rollbackDigest(signed, &digest);
    const signature = try key_pair.sign(&digest, null);
    var signature_hex: [128]u8 = undefined;
    bytesToHex(&signature.toBytes(), &signature_hex);
    signed.authority_signature = &signature_hex;
    return encodeRollback(allocator, signed);
}

test "independent grounded witnesses promote paired metrics" {
    const items = [_]EvidenceEnvelope{
        fixtureEvidence("e1", "resolution", .primary, "support-db", "eval-a", "prod-a", 0.9),
        fixtureEvidence("e2", "resolution", .primary, "survey", "eval-b", "vendor-b", 0.85),
        fixtureEvidence("e3", "retention", .counter, "bank", "eval-a", "prod-a", 0.95),
        fixtureEvidence("e4", "retention", .counter, "crm", "eval-b", "vendor-b", 0.94),
        fixtureEvidence("e5", "reopens", .constraint, "support-db", "eval-a", "prod-a", 0.02),
        fixtureEvidence("e6", "reopens", .constraint, "audit-export", "eval-b", "vendor-b", 0.03),
    };
    const decision = try evaluate(std.testing.allocator, test_policy, &items, 150);
    try std.testing.expect(decision.promote);
}

test "two wallets sharing one source are not independent" {
    const items = [_]EvidenceEnvelope{
        fixtureEvidence("e1", "resolution", .primary, "same-api", "eval-a", "same-host", 0.9),
        fixtureEvidence("e2", "resolution", .primary, "same-api", "eval-b", "same-host", 0.9),
    };
    const decision = try evaluate(std.testing.allocator, test_policy, &items, 150);
    try std.testing.expectEqual(DecisionReason.insufficient_independence, decision.reason);
}

test "builder cannot serve as its own evaluator" {
    const items = [_]EvidenceEnvelope{
        fixtureEvidence("e1", "resolution", .primary, "source-a", "builder", "domain-a", 0.9),
        fixtureEvidence("e2", "resolution", .primary, "source-b", "eval-b", "domain-b", 0.9),
    };
    const decision = try evaluate(std.testing.allocator, test_policy, &items, 150);
    try std.testing.expectEqual(DecisionReason.evaluator_is_builder, decision.reason);
}

test "counter metric prevents Goodhart promotion" {
    var items = [_]EvidenceEnvelope{
        fixtureEvidence("e1", "resolution", .primary, "a", "a", "a", 0.99),
        fixtureEvidence("e2", "resolution", .primary, "b", "b", "b", 0.99),
        fixtureEvidence("e3", "retention", .counter, "c", "c", "c", 0.60),
        fixtureEvidence("e4", "retention", .counter, "d", "d", "d", 0.60),
    };
    const decision = try evaluate(std.testing.allocator, test_policy, &items, 150);
    try std.testing.expectEqual(DecisionReason.metric_threshold_failed, decision.reason);
}

test "stale and revoked observations cannot promote" {
    var stale = fixtureEvidence("e1", "resolution", .primary, "a", "a", "a", 0.9);
    stale.expires_at = 120;
    const stale_decision = try evaluate(std.testing.allocator, test_policy, &.{stale}, 150);
    try std.testing.expectEqual(DecisionReason.stale_evidence, stale_decision.reason);

    var revoked = fixtureEvidence("e1", "resolution", .primary, "a", "a", "a", 0.9);
    revoked.status = .revoked;
    const revoked_decision = try evaluate(std.testing.allocator, test_policy, &.{revoked}, 150);
    try std.testing.expectEqual(DecisionReason.revoked_evidence, revoked_decision.reason);
}

test "derived evidence cycle is rejected" {
    var a = fixtureEvidence("a", "resolution", .primary, "a", "a", "a", 0.9);
    var b = fixtureEvidence("b", "resolution", .primary, "b", "b", "b", 0.9);
    a.derivation_ids = &.{"b"};
    b.derivation_ids = &.{"a"};
    const decision = try evaluate(std.testing.allocator, test_policy, &.{ a, b }, 150);
    try std.testing.expectEqual(DecisionReason.circular_provenance, decision.reason);
}

test "frozen policy rejects optimizer amendment" {
    try std.testing.expectError(
        TrustError.FrozenPolicyOwnerRequired,
        authorizeAmendment(test_policy, .{
            .policy_id = "policy01",
            .from_version = 1,
            .actor_identity = "optimizer",
        }),
    );
    try authorizeAmendment(test_policy, .{
        .policy_id = "policy01",
        .from_version = 1,
        .actor_identity = "governor",
    });
}

test "revocation propagates to every downstream consumer once" {
    const edges = [_]ClaimEdge{
        .{ .producer_id = "root", .consumer_id = "child-a" },
        .{ .producer_id = "root", .consumer_id = "child-b" },
        .{ .producer_id = "child-a", .consumer_id = "leaf" },
        .{ .producer_id = "child-b", .consumer_id = "leaf" },
    };
    const closure = try revocationClosure(std.testing.allocator, "root", &edges);
    defer {
        for (closure) |id| std.testing.allocator.free(id);
        std.testing.allocator.free(closure);
    }
    try std.testing.expectEqual(@as(usize, 4), closure.len);
    try std.testing.expectEqualStrings("root", closure[0]);
    try std.testing.expectEqualStrings("leaf", closure[3]);
}

test "trust ledger events encode as valid canonical rows" {
    const unsigned_item = fixtureEvidence(
        "e\"1",
        "resolution",
        .primary,
        "support-api",
        "evaluator-a",
        "prod-a",
        0.9,
    );
    var evidence_public: [64]u8 = undefined;
    var evidence_signature: [128]u8 = undefined;
    const item = try signedFixtureEvidence(
        unsigned_item,
        1,
        &evidence_public,
        &evidence_signature,
    );
    const encoded_evidence = try encodeEvidence(std.testing.allocator, item);
    defer std.testing.allocator.free(encoded_evidence);
    try std.testing.expectEqual(
        TrustEventKind.trust_evidence,
        try validateTrustEvent(std.testing.allocator, encoded_evidence),
    );
    try std.testing.expect(std.mem.indexOf(u8, encoded_evidence, "e\\\"1") != null);

    var public_hex: [64]u8 = undefined;
    var signature_hex: [128]u8 = undefined;
    const signed_policy = try signedFixturePolicy(
        test_policy,
        1,
        &public_hex,
        &signature_hex,
    );
    const encoded_policy = try encodePolicy(std.testing.allocator, signed_policy);
    defer std.testing.allocator.free(encoded_policy);
    try std.testing.expectEqual(
        TrustEventKind.trust_policy,
        try validateTrustEvent(std.testing.allocator, encoded_policy),
    );

    const encoded_promotion = try encodeSignedPromotion(std.testing.allocator, .{
        .claim_id = "claim001",
        .policy_id = "policy01",
        .policy_version = 1,
        .evidence_ids = &.{ "e1", "e2" },
        .promoted_at = 150,
    }, 1);
    defer std.testing.allocator.free(encoded_promotion);
    try std.testing.expectEqual(
        TrustEventKind.trust_promotion,
        try validateTrustEvent(std.testing.allocator, encoded_promotion),
    );

    var revocation_public: [64]u8 = undefined;
    var revocation_signature: [128]u8 = undefined;
    const signed_revocation = try signedFixtureRevocation(.{
        .evidence_id = "e1",
        .claim_id = "claim001",
        .actor_identity = "governor",
        .cause = "upstream correction",
        .revoked_at = 175,
    }, 1, &revocation_public, &revocation_signature);
    const encoded_revocation = try encodeRevocation(
        std.testing.allocator,
        signed_revocation,
    );
    defer std.testing.allocator.free(encoded_revocation);
    try std.testing.expectEqual(
        TrustEventKind.trust_revocation,
        try validateTrustEvent(std.testing.allocator, encoded_revocation),
    );

    const encoded_activation = try encodeSignedActivation(std.testing.allocator, .{
        .slot_id = "support-bot",
        .revision_id = "claim001",
        .policy_id = "policy01",
        .policy_version = 1,
        .activated_at = 150,
    }, 1);
    defer std.testing.allocator.free(encoded_activation);
    try std.testing.expectEqual(
        TrustEventKind.trust_activation,
        try validateTrustEvent(std.testing.allocator, encoded_activation),
    );

    const encoded_rollback = try encodeSignedRollback(std.testing.allocator, .{
        .slot_id = "support-bot",
        .failed_revision_id = "claim002",
        .restored_revision_id = "claim001",
        .policy_id = "policy01",
        .policy_version = 1,
        .rolled_back_at = 180,
    }, 1);
    defer std.testing.allocator.free(encoded_rollback);
    try std.testing.expectEqual(
        TrustEventKind.trust_rollback,
        try validateTrustEvent(std.testing.allocator, encoded_rollback),
    );
}

test "legacy and malformed rows cannot impersonate trust events" {
    try std.testing.expectError(
        TrustError.UnknownTrustEvent,
        validateTrustEvent(
            std.testing.allocator,
            "{\"event\":\"satisfied\",\"id\":\"claim001\"}",
        ),
    );
    try std.testing.expectError(
        TrustError.MissingTrustField,
        validateTrustEvent(
            std.testing.allocator,
            "{\"event\":\"trust_evidence\",\"id\":\"e1\"}",
        ),
    );
    try std.testing.expectError(
        TrustError.MissingTrustField,
        validateTrustEvent(
            std.testing.allocator,
            "{\"event\":\"trust_revocation\",\"evidence_id\":\"e1\",\"claim_id\":\"c\",\"actor_identity\":\"a\",\"cause\":\"x\",\"revoked_at\":\"now\"}",
        ),
    );
}

test "ledger replay reconstructs policy evidence and revocations" {
    var ledger: std.ArrayList(u8) = .empty;
    defer ledger.deinit(std.testing.allocator);

    var public_hex: [64]u8 = undefined;
    var signature_hex: [128]u8 = undefined;
    const signed_policy = try signedFixturePolicy(
        test_policy,
        1,
        &public_hex,
        &signature_hex,
    );
    const policy_row = try encodePolicy(std.testing.allocator, signed_policy);
    defer std.testing.allocator.free(policy_row);
    try ledger.appendSlice(std.testing.allocator, policy_row);
    try ledger.append(std.testing.allocator, '\n');

    const items = [_]EvidenceEnvelope{
        fixtureEvidence("e1", "resolution", .primary, "support-db", "eval-a", "prod-a", 0.9),
        fixtureEvidence("e2", "resolution", .primary, "survey", "eval-b", "vendor-b", 0.85),
        fixtureEvidence("e3", "retention", .counter, "bank", "eval-a", "prod-a", 0.95),
        fixtureEvidence("e4", "retention", .counter, "crm", "eval-b", "vendor-b", 0.94),
        fixtureEvidence("e5", "reopens", .constraint, "support-db", "eval-a", "prod-a", 0.02),
        fixtureEvidence("e6", "reopens", .constraint, "audit-export", "eval-b", "vendor-b", 0.03),
    };
    for (items) |item| {
        var evaluator_public: [64]u8 = undefined;
        var evaluator_signature: [128]u8 = undefined;
        const seed: u8 = if (std.mem.eql(u8, item.evaluator_identity, "eval-a")) 1 else 2;
        const signed_item = try signedFixtureEvidence(
            item,
            seed,
            &evaluator_public,
            &evaluator_signature,
        );
        const row = try encodeEvidence(std.testing.allocator, signed_item);
        defer std.testing.allocator.free(row);
        try ledger.appendSlice(std.testing.allocator, row);
        try ledger.append(std.testing.allocator, '\n');
    }

    const promoted = (try evaluateLedger(
        std.testing.allocator,
        ledger.items,
        "claim001",
        150,
    )).?;
    try std.testing.expect(promoted.promote);
    var context = (try promotionContextFromLedger(
        std.testing.allocator,
        ledger.items,
        "claim001",
    )).?;
    defer context.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("policy01", context.policy_id);
    try std.testing.expectEqualStrings("support-bot", context.deployment_slot);
    try std.testing.expectEqual(@as(usize, 6), context.evidence_ids.len);

    var revoker_public: [64]u8 = undefined;
    var revoker_signature: [128]u8 = undefined;
    const signed_revocation = try signedFixtureRevocation(.{
        .evidence_id = "e4",
        .claim_id = "claim001",
        .actor_identity = "governor",
        .cause = "source correction",
        .revoked_at = 160,
    }, 2, &revoker_public, &revoker_signature);
    const revocation_row = try encodeRevocation(
        std.testing.allocator,
        signed_revocation,
    );
    defer std.testing.allocator.free(revocation_row);
    try ledger.appendSlice(std.testing.allocator, revocation_row);
    try ledger.append(std.testing.allocator, '\n');

    const revoked = (try evaluateLedger(
        std.testing.allocator,
        ledger.items,
        "claim001",
        170,
    )).?;
    try std.testing.expectEqual(DecisionReason.revoked_evidence, revoked.reason);
}

test "ledger replay rejects frozen policy weakening" {
    var original_public: [64]u8 = undefined;
    var original_signature: [128]u8 = undefined;
    const original = try signedFixturePolicy(
        test_policy,
        1,
        &original_public,
        &original_signature,
    );
    var weakened = test_policy;
    weakened.version = 2;
    weakened.minimum_independent_witnesses = 1;
    var attacker_public: [64]u8 = undefined;
    var attacker_signature: [128]u8 = undefined;
    weakened = try signedFixturePolicy(
        weakened,
        2,
        &attacker_public,
        &attacker_signature,
    );

    const original_row = try encodePolicy(std.testing.allocator, original);
    defer std.testing.allocator.free(original_row);
    const weakened_row = try encodePolicy(std.testing.allocator, weakened);
    defer std.testing.allocator.free(weakened_row);
    const ledger = try std.fmt.allocPrint(
        std.testing.allocator,
        "{s}\n{s}\n",
        .{ original_row, weakened_row },
    );
    defer std.testing.allocator.free(ledger);

    try std.testing.expectError(
        TrustError.FrozenPolicyOwnerRequired,
        evaluateLedger(std.testing.allocator, ledger, "claim001", 150),
    );
}

test "ledger replay rejects policy fields changed after signing" {
    var public_hex: [64]u8 = undefined;
    var signature_hex: [128]u8 = undefined;
    var forged = try signedFixturePolicy(
        test_policy,
        1,
        &public_hex,
        &signature_hex,
    );
    forged.minimum_independent_witnesses = 1;
    const forged_row = try encodePolicy(std.testing.allocator, forged);
    defer std.testing.allocator.free(forged_row);
    try std.testing.expectError(
        TrustError.InvalidPolicySignature,
        evaluateLedger(std.testing.allocator, forged_row, "claim001", 150),
    );
}

test "ledger replay rejects evidence provenance changed after signing" {
    var policy_public: [64]u8 = undefined;
    var policy_signature: [128]u8 = undefined;
    const signed_policy = try signedFixturePolicy(
        test_policy,
        1,
        &policy_public,
        &policy_signature,
    );
    const policy_row = try encodePolicy(std.testing.allocator, signed_policy);
    defer std.testing.allocator.free(policy_row);

    var evidence_public: [64]u8 = undefined;
    var evidence_signature: [128]u8 = undefined;
    var forged = try signedFixtureEvidence(
        fixtureEvidence("e1", "resolution", .primary, "source-a", "eval", "domain-a", 0.9),
        2,
        &evidence_public,
        &evidence_signature,
    );
    forged.source_id = "source-b";
    const evidence_row = try encodeEvidence(std.testing.allocator, forged);
    defer std.testing.allocator.free(evidence_row);
    const ledger = try std.fmt.allocPrint(
        std.testing.allocator,
        "{s}\n{s}\n",
        .{ policy_row, evidence_row },
    );
    defer std.testing.allocator.free(ledger);
    try std.testing.expectError(
        TrustError.InvalidPolicySignature,
        evaluateLedger(std.testing.allocator, ledger, "claim001", 150),
    );
}

test "ledger replay rejects revocation signed by wrong evaluator" {
    var policy_public: [64]u8 = undefined;
    var policy_signature: [128]u8 = undefined;
    const signed_policy = try signedFixturePolicy(
        test_policy,
        1,
        &policy_public,
        &policy_signature,
    );
    const policy_row = try encodePolicy(std.testing.allocator, signed_policy);
    defer std.testing.allocator.free(policy_row);

    var evidence_public: [64]u8 = undefined;
    var evidence_signature: [128]u8 = undefined;
    const signed_evidence = try signedFixtureEvidence(
        fixtureEvidence("e1", "resolution", .primary, "source", "eval", "domain", 0.9),
        2,
        &evidence_public,
        &evidence_signature,
    );
    const evidence_row = try encodeEvidence(std.testing.allocator, signed_evidence);
    defer std.testing.allocator.free(evidence_row);

    var attacker_public: [64]u8 = undefined;
    var attacker_signature: [128]u8 = undefined;
    const forged_revocation = try signedFixtureRevocation(.{
        .evidence_id = "e1",
        .claim_id = "claim001",
        .actor_identity = "",
        .cause = "forged correction",
        .revoked_at = 140,
    }, 3, &attacker_public, &attacker_signature);
    const revocation_row = try encodeRevocation(std.testing.allocator, forged_revocation);
    defer std.testing.allocator.free(revocation_row);
    const ledger = try std.fmt.allocPrint(
        std.testing.allocator,
        "{s}\n{s}\n{s}\n",
        .{ policy_row, evidence_row, revocation_row },
    );
    defer std.testing.allocator.free(ledger);
    try std.testing.expectError(
        TrustError.InvalidPolicySignature,
        evaluateLedger(std.testing.allocator, ledger, "claim001", 150),
    );
}

test "ledger replay leaves legacy claims explicitly ungoverned" {
    const decision = try evaluateLedger(
        std.testing.allocator,
        "{\"event\":\"satisfied\",\"id\":\"legacy01\"}\n",
        "legacy01",
        150,
    );
    try std.testing.expect(decision == null);
}

test "rollback chooses only prior unrevoked policy-compatible champion" {
    var owner_public: [64]u8 = undefined;
    var owner_signature: [128]u8 = undefined;
    _ = try signedFixturePolicy(test_policy, 1, &owner_public, &owner_signature);
    const old = try encodeSignedActivation(std.testing.allocator, .{
        .slot_id = "support-bot",
        .revision_id = "revision-a",
        .policy_id = "policy01",
        .policy_version = 2,
        .activated_at = 100,
    }, 1);
    defer std.testing.allocator.free(old);
    const incompatible = try encodeSignedActivation(std.testing.allocator, .{
        .slot_id = "support-bot",
        .revision_id = "revision-b",
        .policy_id = "policy01",
        .policy_version = 1,
        .activated_at = 120,
    }, 1);
    defer std.testing.allocator.free(incompatible);
    const failed = try encodeSignedActivation(std.testing.allocator, .{
        .slot_id = "support-bot",
        .revision_id = "revision-c",
        .policy_id = "policy01",
        .policy_version = 2,
        .activated_at = 140,
    }, 1);
    defer std.testing.allocator.free(failed);
    const ledger = try std.fmt.allocPrint(
        std.testing.allocator,
        "{s}\n{s}\n{s}\n",
        .{ old, incompatible, failed },
    );
    defer std.testing.allocator.free(ledger);

    const selected = (try selectRollbackFromLedger(
        std.testing.allocator,
        ledger,
        "support-bot",
        "revision-c",
        "policy01",
        2,
        &owner_public,
    )).?;
    defer std.testing.allocator.free(selected);
    try std.testing.expectEqualStrings("revision-a", selected);
}

test "rollback refuses revoked or future champions" {
    var owner_public: [64]u8 = undefined;
    var owner_signature: [128]u8 = undefined;
    _ = try signedFixturePolicy(test_policy, 1, &owner_public, &owner_signature);
    const old = try encodeSignedActivation(std.testing.allocator, .{
        .slot_id = "slot",
        .revision_id = "old",
        .policy_id = "policy",
        .policy_version = 1,
        .activated_at = 100,
    }, 1);
    defer std.testing.allocator.free(old);
    const failed = try encodeSignedActivation(std.testing.allocator, .{
        .slot_id = "slot",
        .revision_id = "failed",
        .policy_id = "policy",
        .policy_version = 1,
        .activated_at = 120,
    }, 1);
    defer std.testing.allocator.free(failed);
    const future = try encodeSignedActivation(std.testing.allocator, .{
        .slot_id = "slot",
        .revision_id = "future",
        .policy_id = "policy",
        .policy_version = 1,
        .activated_at = 140,
    }, 1);
    defer std.testing.allocator.free(future);
    const ledger = try std.fmt.allocPrint(
        std.testing.allocator,
        "{s}\n{s}\n{s}\n{{\"event\":\"died\",\"id\":\"old\"}}\n",
        .{ old, failed, future },
    );
    defer std.testing.allocator.free(ledger);
    const selected = try selectRollbackFromLedger(
        std.testing.allocator,
        ledger,
        "slot",
        "failed",
        "policy",
        1,
        &owner_public,
    );
    try std.testing.expect(selected == null);
}

test "rollback rejects activation history changed after signing" {
    var owner_public: [64]u8 = undefined;
    var owner_signature: [128]u8 = undefined;
    _ = try signedFixturePolicy(test_policy, 1, &owner_public, &owner_signature);
    const signed = try encodeSignedActivation(std.testing.allocator, .{
        .slot_id = "slot",
        .revision_id = "revision-a",
        .policy_id = "policy",
        .policy_version = 1,
        .activated_at = 100,
    }, 1);
    defer std.testing.allocator.free(signed);
    const changed_at = std.mem.indexOf(u8, signed, "revision-a").?;
    signed[changed_at + "revision-".len] = 'x';
    try std.testing.expectError(
        TrustError.InvalidPolicySignature,
        selectRollbackFromLedger(
            std.testing.allocator,
            signed,
            "slot",
            "revision-x",
            "policy",
            1,
            &owner_public,
        ),
    );
}

test "rollback rejects activation signed by non-owner wallet" {
    var owner_public: [64]u8 = undefined;
    var owner_signature: [128]u8 = undefined;
    _ = try signedFixturePolicy(test_policy, 1, &owner_public, &owner_signature);
    const attacker_activation = try encodeSignedActivation(std.testing.allocator, .{
        .slot_id = "slot",
        .revision_id = "attacker",
        .policy_id = "policy",
        .policy_version = 1,
        .activated_at = 100,
    }, 2);
    defer std.testing.allocator.free(attacker_activation);
    try std.testing.expectError(
        TrustError.InvalidPolicySignature,
        selectRollbackFromLedger(
            std.testing.allocator,
            attacker_activation,
            "slot",
            "attacker",
            "policy",
            1,
            &owner_public,
        ),
    );
}
