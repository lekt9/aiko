//! Deterministic context read projection over Contract-owned facts.
//!
//! This module deliberately owns no storage.  Callers scan the existing ledger
//! and its archive, normalize eligible rows into `Fact`, then project them here.
//! Authority is closed over `VerifiedIngress` plus a previously issued
//! `Delegation`; fields copied from a hook payload never enter this API.
const std = @import("std");

pub const PROJECTION_VERSION = "contract.context-projection/v1";
pub const REQUIRED_SCOPE = "context.read";

pub const Error = error{
    InvalidAuthority,
    SourceMoved,
    ConflictingCitation,
    OutOfMemory,
};

/// Produced only by the transport authentication boundary.  Keeping this type
/// separate from a request DTO makes caller-supplied tenant/role hints useless.
pub const VerifiedIngress = struct {
    authenticated_subject: []const u8,
    verified_tenant: []const u8,
    audience: []const u8,
    granted_scopes: []const []const u8,
    credential_generation: []const u8,
};

/// Durable authority is issued by Contract, not inferred from ingress or text.
/// `source_version` pins the ledger+archive view scanned by the caller.
pub const Delegation = struct {
    authenticated_subject: []const u8,
    tenant: []const u8,
    role: []const u8,
    root_id: []const u8,
    purpose: []const u8,
    audience: []const u8,
    credential_generation: []const u8,
    source_version: u64,
    allowed_fields: []const []const u8,
};

pub const FactKind = enum {
    /// A graph input_binding whose producing settlement is cited.
    cited_input,
    /// A typed evidence citation retained in the live ledger.
    evidence_citation,
    /// The same citation read from the append-only archive after compaction.
    archived_citation,
    settlement,
    transcript,
    prompt,
    raw_tool_payload,
    credential,
};

pub const FactState = enum { active, stale, revoked, invalidated };
pub const Visibility = enum { delegated, sibling_private, private };

/// Normalized view of an existing Contract row. `value` is never persisted by
/// this module.  Citation identity remains resolvable across session compaction
/// through the stable digest and commit ordinal, not a transcript offset.
pub const Fact = struct {
    tenant: []const u8,
    root_id: []const u8,
    producer_role: []const u8,
    delegated_role: []const u8,
    purpose: []const u8,
    audience: []const u8,
    field: []const u8,
    value: []const u8,
    citation_digest: []const u8,
    commit_ordinal: u64,
    source_version: u64,
    kind: FactKind,
    state: FactState,
    visibility: Visibility,
    cited: bool,
    secret: bool,
};

pub const Item = struct {
    field: []const u8,
    value: []const u8,
    citation_digest: []const u8,
    commit_ordinal: u64,
    archived: bool,
};

pub const Projection = struct {
    allocator: std.mem.Allocator,
    version: []const u8 = PROJECTION_VERSION,
    source_version: u64,
    items: []Item,

    pub fn deinit(self: *Projection) void {
        self.allocator.free(self.items);
        self.* = undefined;
    }
};

fn contains(values: []const []const u8, wanted: []const u8) bool {
    for (values) |value| if (std.mem.eql(u8, value, wanted)) return true;
    return false;
}

fn validDigest(value: []const u8) bool {
    if (value.len != 64) return false;
    for (value) |byte| if (!std.ascii.isHex(byte)) return false;
    return true;
}

fn lessThan(_: void, a: Item, b: Item) bool {
    if (a.commit_ordinal != b.commit_ordinal)
        return a.commit_ordinal < b.commit_ordinal;
    const digest_order = std.mem.order(u8, a.citation_digest, b.citation_digest);
    if (digest_order != .eq) return digest_order == .lt;
    const field_order = std.mem.order(u8, a.field, b.field);
    if (field_order != .eq) return field_order == .lt;
    return std.mem.order(u8, a.value, b.value) == .lt;
}

fn authorityMatches(ingress: VerifiedIngress, delegation: Delegation) bool {
    return contains(ingress.granted_scopes, REQUIRED_SCOPE) and
        std.mem.eql(u8, ingress.authenticated_subject, delegation.authenticated_subject) and
        std.mem.eql(u8, ingress.verified_tenant, delegation.tenant) and
        std.mem.eql(u8, ingress.audience, delegation.audience) and
        std.mem.eql(u8, ingress.credential_generation, delegation.credential_generation) and
        delegation.role.len != 0 and delegation.root_id.len != 0 and
        delegation.purpose.len != 0 and delegation.audience.len != 0;
}

fn eligible(fact: Fact, delegation: Delegation) bool {
    const citation_kind = fact.kind == .cited_input or
        fact.kind == .evidence_citation or fact.kind == .archived_citation;
    return citation_kind and fact.cited and !fact.secret and
        fact.state == .active and fact.visibility == .delegated and
        fact.source_version == delegation.source_version and
        validDigest(fact.citation_digest) and fact.commit_ordinal != 0 and
        std.mem.eql(u8, fact.tenant, delegation.tenant) and
        std.mem.eql(u8, fact.root_id, delegation.root_id) and
        std.mem.eql(u8, fact.delegated_role, delegation.role) and
        std.mem.eql(u8, fact.purpose, delegation.purpose) and
        std.mem.eql(u8, fact.audience, delegation.audience) and
        contains(delegation.allowed_fields, fact.field);
}

/// Pure projection: no filesystem, environment, clock, database, or cache.
/// Any movement between authority issuance and the supplied scan fails closed.
pub fn project(
    allocator: std.mem.Allocator,
    ingress: VerifiedIngress,
    delegation: Delegation,
    scanned_source_version: u64,
    facts: []const Fact,
) Error!Projection {
    if (!authorityMatches(ingress, delegation)) return Error.InvalidAuthority;
    if (scanned_source_version != delegation.source_version) return Error.SourceMoved;

    var items: std.ArrayList(Item) = .empty;
    errdefer items.deinit(allocator);
    for (facts) |fact| {
        // A row claiming the pinned view but arriving from another view means
        // the scan was not an atomic ledger+archive snapshot.
        if (fact.source_version != scanned_source_version) return Error.SourceMoved;
        if (!eligible(fact, delegation)) continue;
        items.append(allocator, .{
            .field = fact.field,
            .value = fact.value,
            .citation_digest = fact.citation_digest,
            .commit_ordinal = fact.commit_ordinal,
            .archived = fact.kind == .archived_citation,
        }) catch return Error.OutOfMemory;
    }
    std.mem.sort(Item, items.items, {}, lessThan);

    // One citation/field denotes one fact. Different bytes under that identity
    // are ledger corruption or source movement, never "latest wins" context.
    if (items.items.len > 1) {
        for (items.items[1..], 1..) |item, index| {
            const previous = items.items[index - 1];
            if (item.commit_ordinal == previous.commit_ordinal and
                std.mem.eql(u8, item.citation_digest, previous.citation_digest) and
                std.mem.eql(u8, item.field, previous.field) and
                !std.mem.eql(u8, item.value, previous.value))
                return Error.ConflictingCitation;
        }
    }

    return .{
        .allocator = allocator,
        .source_version = scanned_source_version,
        .items = items.toOwnedSlice(allocator) catch return Error.OutOfMemory,
    };
}

const digest_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const digest_b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn baseFact() Fact {
    return .{
        .tenant = "tenant-a",
        .root_id = "root-a",
        .producer_role = "planner",
        .delegated_role = "worker",
        .purpose = "execute-node",
        .audience = "smithers",
        .field = "roster_digest",
        .value = "cas:roster",
        .citation_digest = digest_b,
        .commit_ordinal = 9,
        .source_version = 17,
        .kind = .cited_input,
        .state = .active,
        .visibility = .delegated,
        .cited = true,
        .secret = false,
    };
}

fn testIngress() VerifiedIngress {
    return .{
        .authenticated_subject = "principal-a",
        .verified_tenant = "tenant-a",
        .audience = "smithers",
        .granted_scopes = &.{REQUIRED_SCOPE},
        .credential_generation = "key-7",
    };
}

fn testDelegation() Delegation {
    return .{
        .authenticated_subject = "principal-a",
        .tenant = "tenant-a",
        .role = "worker",
        .root_id = "root-a",
        .purpose = "execute-node",
        .audience = "smithers",
        .credential_generation = "key-7",
        .source_version = 17,
        .allowed_fields = &.{"roster_digest"},
    };
}

test "projection is deterministic and preserves live and archived citations" {
    const later = baseFact();
    var earlier = baseFact();
    earlier.value = "cas:earlier";
    earlier.citation_digest = digest_a;
    earlier.commit_ordinal = 3;
    earlier.kind = .archived_citation;
    const input = [_]Fact{ later, earlier };
    var result = try project(std.testing.allocator, testIngress(), testDelegation(), 17, &input);
    defer result.deinit();
    try std.testing.expectEqualStrings(PROJECTION_VERSION, result.version);
    try std.testing.expectEqual(@as(usize, 2), result.items.len);
    try std.testing.expectEqual(@as(u64, 3), result.items[0].commit_ordinal);
    try std.testing.expect(result.items[0].archived);
    try std.testing.expectEqualStrings(digest_a, result.items[0].citation_digest);
}

test "tenant role sibling private purpose audience stale and secret facts are excluded" {
    const baseline = baseFact();
    var tenant = baseline; tenant.tenant = "tenant-b";
    var role = baseline; role.delegated_role = "other-worker";
    var sibling = baseline; sibling.visibility = .sibling_private;
    var private = baseline; private.visibility = .private;
    var purpose = baseline; purpose.purpose = "summarize";
    var audience = baseline; audience.audience = "other";
    var stale = baseline; stale.state = .stale;
    var revoked = baseline; revoked.state = .revoked;
    var invalidated = baseline; invalidated.state = .invalidated;
    var secret = baseline; secret.secret = true;
    const input = [_]Fact{ tenant, role, sibling, private, purpose, audience, stale, revoked, invalidated, secret };
    var result = try project(std.testing.allocator, testIngress(), testDelegation(), 17, &input);
    defer result.deinit();
    try std.testing.expectEqual(@as(usize, 0), result.items.len);
}

test "transcripts prompts raw tools credentials settlements and uncited rows never project" {
    const baseline = baseFact();
    var transcript = baseline; transcript.kind = .transcript;
    var prompt = baseline; prompt.kind = .prompt;
    var raw = baseline; raw.kind = .raw_tool_payload;
    var credential = baseline; credential.kind = .credential;
    var settlement = baseline; settlement.kind = .settlement;
    var uncited = baseline; uncited.cited = false;
    var unlisted = baseline; unlisted.field = "worker_secret_note";
    const input = [_]Fact{ transcript, prompt, raw, credential, settlement, uncited, unlisted };
    var result = try project(std.testing.allocator, testIngress(), testDelegation(), 17, &input);
    defer result.deinit();
    try std.testing.expectEqual(@as(usize, 0), result.items.len);
}

test "authority cannot be widened and source movement fails closed" {
    var ingress = testIngress();
    ingress.verified_tenant = "caller-claimed-tenant";
    try std.testing.expectError(Error.InvalidAuthority, project(std.testing.allocator, ingress, testDelegation(), 17, &.{}));
    try std.testing.expectError(Error.SourceMoved, project(std.testing.allocator, testIngress(), testDelegation(), 18, &.{}));
    var moved = baseFact(); moved.source_version = 18;
    try std.testing.expectError(Error.SourceMoved, project(std.testing.allocator, testIngress(), testDelegation(), 17, &.{moved}));
}

test "same ordinal citation and field cannot change bytes" {
    var changed = baseFact(); changed.value = "cas:changed";
    try std.testing.expectError(
        Error.ConflictingCitation,
        project(std.testing.allocator, testIngress(), testDelegation(), 17, &.{ baseFact(), changed }),
    );
}
