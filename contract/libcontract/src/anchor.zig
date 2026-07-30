//! anchor.zig — terminal observations that touch reality.
//!
//! An anchor records an observation, not an interpretation. Evaluators may
//! derive metrics from it, but a ledger row or derived report cannot declare
//! itself a terminal anchor.

const std = @import("std");
const trust = @import("trust.zig");

pub const AnchorKind = enum {
    executed_test,
    filesystem_observation,
    http_api_observation,
    browser_state,
    human_attestation,
    economic_receipt,
    physical_measurement,
    adapter_measurement,
};

pub const AnchorStatus = enum {
    active,
    revoked,
    compromised,
};

pub const RealityAnchor = struct {
    id: []const u8,
    claim_id: []const u8,
    kind: AnchorKind,
    content_hash: []const u8,
    source_identity: []const u8,
    collection_method: []const u8,
    observed_at: i64,
    expires_at: i64,
    failure_domain: []const u8,
    payload_pointer: ?[]const u8 = null,
    authority_scope: ?[]const u8 = null,
    adapter_id: ?[]const u8 = null,
    status: AnchorStatus = .active,
};

pub const AdapterContext = struct {
    claim_id: []const u8,
    observed_at: i64,
    expires_at: i64,
};

pub const SensorAdapter = struct {
    id: []const u8,
    kind: AnchorKind,
    context: ?*anyopaque,
    measureFn: *const fn (?*anyopaque, AdapterContext) anyerror!RealityAnchor,

    pub fn measure(self: SensorAdapter, request: AdapterContext) !RealityAnchor {
        const result = try self.measureFn(self.context, request);
        try validate(result);
        if (result.kind != self.kind) return AnchorError.MissingAdapter;
        if (self.kind == .adapter_measurement) {
            const adapter_id = result.adapter_id orelse return AnchorError.MissingAdapter;
            if (!std.mem.eql(u8, adapter_id, self.id)) return AnchorError.MissingAdapter;
        }
        return result;
    }
};

pub const AnchorError = error{
    EmptyId,
    EmptyClaim,
    InvalidContentHash,
    EmptySourceIdentity,
    SelfReferentialSource,
    EmptyCollectionMethod,
    EmptyFailureDomain,
    InvalidValidityWindow,
    InvalidPayloadPointer,
    MissingHumanAuthority,
    MissingAdapter,
    Stale,
    Revoked,
    Compromised,
};

fn isHex(value: []const u8) bool {
    if (value.len != 64) return false;
    for (value) |byte| {
        if (!std.ascii.isHex(byte)) return false;
    }
    return true;
}

fn isSelfReferential(value: []const u8) bool {
    return std.mem.startsWith(u8, value, "ledger:") or
        std.mem.startsWith(u8, value, "contract:") or
        std.mem.eql(u8, value, "self");
}

pub fn validate(anchor: RealityAnchor) AnchorError!void {
    if (anchor.id.len == 0) return AnchorError.EmptyId;
    if (anchor.claim_id.len == 0) return AnchorError.EmptyClaim;
    if (!isHex(anchor.content_hash)) return AnchorError.InvalidContentHash;
    if (anchor.source_identity.len == 0) return AnchorError.EmptySourceIdentity;
    if (isSelfReferential(anchor.source_identity)) return AnchorError.SelfReferentialSource;
    if (anchor.collection_method.len == 0) return AnchorError.EmptyCollectionMethod;
    if (anchor.failure_domain.len == 0) return AnchorError.EmptyFailureDomain;
    if (anchor.expires_at <= anchor.observed_at) return AnchorError.InvalidValidityWindow;
    if (anchor.payload_pointer) |pointer| {
        if (!(std.mem.startsWith(u8, pointer, "sha256:") or
            std.mem.startsWith(u8, pointer, "cas:") or
            std.mem.startsWith(u8, pointer, "file-digest:")))
            return AnchorError.InvalidPayloadPointer;
    }
    if (anchor.kind == .human_attestation and
        (anchor.authority_scope == null or anchor.authority_scope.?.len == 0))
        return AnchorError.MissingHumanAuthority;
    if (anchor.kind == .adapter_measurement and
        (anchor.adapter_id == null or anchor.adapter_id.?.len == 0))
        return AnchorError.MissingAdapter;
}

pub fn requireFresh(anchor: RealityAnchor, now: i64) AnchorError!void {
    try validate(anchor);
    switch (anchor.status) {
        .active => {},
        .revoked => return AnchorError.Revoked,
        .compromised => return AnchorError.Compromised,
    }
    if (now < anchor.observed_at or now >= anchor.expires_at) return AnchorError.Stale;
}

pub fn sourceKind(kind: AnchorKind) trust.SourceKind {
    return switch (kind) {
        .executed_test => .executed_test,
        .filesystem_observation => .filesystem_observation,
        .http_api_observation => .external_api,
        .browser_state => .browser_state,
        .human_attestation => .human_attestation,
        .economic_receipt => .settled_transaction,
        .physical_measurement => .physical_observation,
        .adapter_measurement => .adapter_measurement,
    };
}

/// Independent witnesses need distinct instruments/failure domains. Different
/// IDs, wallets, or copied payload hashes do not create independence.
pub fn independent(a: RealityAnchor, b: RealityAnchor) bool {
    if (std.mem.eql(u8, a.source_identity, b.source_identity)) return false;
    if (std.mem.eql(u8, a.failure_domain, b.failure_domain)) return false;
    if (std.mem.eql(u8, a.content_hash, b.content_hash)) return false;
    return true;
}

/// Convert a validated terminal observation into the existing trust envelope.
/// The evaluator remains distinct from the instrument that collected it.
pub fn toEvidence(
    anchor: RealityAnchor,
    metric_id: []const u8,
    role: trust.MetricRole,
    evaluator_identity: []const u8,
    value: f64,
) AnchorError!trust.EvidenceEnvelope {
    try validate(anchor);
    return .{
        .id = anchor.id,
        .claim_id = anchor.claim_id,
        .metric_id = metric_id,
        .role = role,
        .source_kind = sourceKind(anchor.kind),
        .source_id = anchor.source_identity,
        .evaluator_identity = evaluator_identity,
        .failure_domain = anchor.failure_domain,
        .observed_at = anchor.observed_at,
        .expires_at = anchor.expires_at,
        .value = value,
        .status = switch (anchor.status) {
            .active => .active,
            .revoked, .compromised => .revoked,
        },
    };
}

const HASH_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn fixture(kind: AnchorKind) RealityAnchor {
    return .{
        .id = "anchor-1",
        .claim_id = "claim-1",
        .kind = kind,
        .content_hash = HASH_A,
        .source_identity = "instrument:one",
        .collection_method = "native adapter v1",
        .observed_at = 100,
        .expires_at = 200,
        .failure_domain = "host:one",
        .authority_scope = if (kind == .human_attestation) "claim:review" else null,
        .adapter_id = if (kind == .adapter_measurement) "adapter:reference" else null,
    };
}

test "all terminal anchor classes validate and map to trust evidence" {
    const kinds = [_]AnchorKind{
        .executed_test,
        .filesystem_observation,
        .http_api_observation,
        .browser_state,
        .human_attestation,
        .economic_receipt,
        .physical_measurement,
        .adapter_measurement,
    };
    for (kinds) |kind| {
        const anchor = fixture(kind);
        try requireFresh(anchor, 150);
        const evidence = try toEvidence(anchor, "quality", .primary, "evaluator:independent", 1);
        try std.testing.expectEqualStrings(anchor.source_identity, evidence.source_id);
        try std.testing.expectEqual(sourceKind(kind), evidence.source_kind);
    }
}

test "ledger self-reference expiry revocation and tamper fail closed" {
    var anchor = fixture(.executed_test);
    anchor.source_identity = "ledger:claims";
    try std.testing.expectError(AnchorError.SelfReferentialSource, validate(anchor));
    anchor.source_identity = "runner:one";
    try std.testing.expectError(AnchorError.Stale, requireFresh(anchor, 200));
    anchor.status = .revoked;
    try std.testing.expectError(AnchorError.Revoked, requireFresh(anchor, 150));
    anchor.status = .active;
    anchor.content_hash = "not-a-digest";
    try std.testing.expectError(AnchorError.InvalidContentHash, validate(anchor));
}

test "copied or same-failure-domain anchors are one witness" {
    const a = fixture(.browser_state);
    var b = fixture(.http_api_observation);
    b.id = "anchor-2";
    b.source_identity = "instrument:two";
    try std.testing.expect(!independent(a, b));
    b.failure_domain = "host:two";
    try std.testing.expect(!independent(a, b));
    b.content_hash = HASH_B;
    try std.testing.expect(independent(a, b));
}

fn fixtureAdapter(_: ?*anyopaque, request: AdapterContext) !RealityAnchor {
    return .{
        .id = "adapter-anchor-1",
        .claim_id = request.claim_id,
        .kind = .adapter_measurement,
        .content_hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        .source_identity = "instrument-1",
        .collection_method = "native-adapter",
        .observed_at = request.observed_at,
        .expires_at = request.expires_at,
        .failure_domain = "instrument-domain-1",
        .payload_pointer = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        .adapter_id = "adapter-1",
    };
}

test "domain adapter produces a validated typed terminal anchor" {
    const adapter = SensorAdapter{
        .id = "adapter-1",
        .kind = .adapter_measurement,
        .context = null,
        .measureFn = fixtureAdapter,
    };
    const measured = try adapter.measure(.{ .claim_id = "claim-1", .observed_at = 10, .expires_at = 20 });
    try std.testing.expectEqual(AnchorKind.adapter_measurement, measured.kind);
}

test "independence is permutation invariant and duplicate injection never adds a witness" {
    const base = RealityAnchor{
        .id = "anchor-base",
        .claim_id = "claim-1",
        .kind = .executed_test,
        .content_hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        .source_identity = "source-a",
        .collection_method = "executed",
        .observed_at = 10,
        .expires_at = 20,
        .failure_domain = "domain-a",
    };
    var candidate = base;
    candidate.id = "anchor-candidate";
    const axes = [_]u3{ 0, 1, 2, 3, 4, 5, 6, 7 };
    for (axes) |mask| {
        candidate.source_identity = if (mask & 1 == 0) "source-a" else "source-b";
        candidate.failure_domain = if (mask & 2 == 0) "domain-a" else "domain-b";
        candidate.content_hash = if (mask & 4 == 0)
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        else
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        const expected = mask == 7;
        try std.testing.expectEqual(expected, independent(base, candidate));
        try std.testing.expectEqual(expected, independent(candidate, base));
    }
}
