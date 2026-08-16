//! Neuron-owned retention reachability projection.
//!
//! The commit journal remains authoritative for payloads.  This projection is
//! deliberately a *pin ledger*: it carries only immutable journal identity
//! (digest + ordinal + reference) and the lifecycle facts needed to prevent
//! unsafe collection.  Contract may consume this output without gaining a
//! second copy of a message, provider body, credential, or secret.
const std = @import("std");

pub const SCHEMA = "neuron.retention-projection/v1";
pub const DIGEST_HEX_LEN = 64;

pub const Kind = enum {
    firing,
    source_citation,
    package_generation,
    attachment_generation,
    revocation_generation,
    effect_outbox,
    provider_receipt,
    dlq_attempt,
    requeue_lineage,
    compensation_gap,
};

/// Only states that affect reachability occur here.  Content and provider
/// response bodies belong to the journals that produced their digests.
pub const State = enum {
    settled,
    revoked,
    redrive_pending,
    queued,
    crossed,
    uncertain_reconciliation,
    dead_letter,
    requeue_pending,
    compensation_pending,
};

pub const Pin = struct {
    /// Stable journal-local identifier, never message/provider content.
    reference: []const u8,
    commit_ordinal: u64,
    /// Lowercase SHA-256 hex of the immutable source record.
    digest: []const u8,
};

pub const Record = struct {
    kind: Kind,
    state: State = .settled,
    pin: Pin,
    /// Ownership edge: citation -> firing, attachment/revocation -> package,
    /// receipt/DLQ/requeue/compensation -> effect.
    parent: ?usize = null,
    /// Citation edge to the immutable source version it actually read.
    cites: ?usize = null,
};

pub const Verdict = enum { redrive, escalate, compensate };

pub const Entry = struct {
    kind: Kind,
    state: State,
    pin: Pin,
    parent: ?usize,
    cites: ?usize,
    retained: bool,
};

pub const Projection = struct {
    allocator: std.mem.Allocator,
    entries: []Entry,

    pub fn deinit(self: *Projection) void {
        self.allocator.free(self.entries);
        self.* = undefined;
    }

    /// The archive-safe redrive answer uses exactly the same lifecycle facts
    /// as the live journal classifier.  No payload is required or consulted.
    pub fn redriveVerdict(self: Projection, index: usize) Error!Verdict {
        if (index >= self.entries.len) return Error.InvalidReference;
        return verdict(self.entries[index].kind, self.entries[index].state);
    }

    pub fn requireCollectible(self: Projection, index: usize) Error!void {
        if (index >= self.entries.len) return Error.InvalidReference;
        if (self.entries[index].retained) return Error.LiveReference;
    }

    /// Emit the Contract-facing artifact. Its fixed field set is the data
    /// membrane: only references, ordinals, digests, kinds, states and edges.
    pub fn jsonAlloc(self: Projection, allocator: std.mem.Allocator) ![]u8 {
        return std.json.Stringify.valueAlloc(allocator, .{
            .schema = SCHEMA,
            .pins = self.entries,
        }, .{});
    }

};

pub const Error = error{
    InvalidReference,
    InvalidOrdinal,
    InvalidDigest,
    DuplicatePin,
    RawDataReference,
    InvalidLifecycle,
    LiveReference,
    OutOfMemory,
};

fn isReferenceByte(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or c == '.' or c == '_' or c == '-' or c == '/' or c == ':';
}

fn validatePin(pin: Pin) Error!void {
    if (pin.commit_ordinal == 0) return Error.InvalidOrdinal;
    if (pin.digest.len != DIGEST_HEX_LEN) return Error.InvalidDigest;
    for (pin.digest) |c| if (!std.ascii.isDigit(c) and !(c >= 'a' and c <= 'f')) return Error.InvalidDigest;
    // A bounded identifier alphabet excludes JSON, query strings, bearer
    // tokens and inline payloads.  Digests are the only content identity.
    if (pin.reference.len == 0 or pin.reference.len > 256) return Error.RawDataReference;
    for (pin.reference) |c| if (!isReferenceByte(c)) return Error.RawDataReference;
}

fn isLive(state: State) bool {
    return switch (state) {
        .redrive_pending, .uncertain_reconciliation, .dead_letter,
        .requeue_pending, .compensation_pending => true,
        else => false,
    };
}

fn validateLifecycle(r: Record) Error!void {
    switch (r.kind) {
        .source_citation => if (r.cites == null or r.parent == null) return Error.InvalidLifecycle,
        .attachment_generation, .revocation_generation, .provider_receipt,
        .dlq_attempt, .requeue_lineage, .compensation_gap => if (r.parent == null) return Error.InvalidLifecycle,
        .effect_outbox => switch (r.state) {
            .queued, .crossed, .uncertain_reconciliation, .dead_letter,
            .requeue_pending, .compensation_pending, .settled => {},
            else => return Error.InvalidLifecycle,
        },
        else => {},
    }
    switch (r.state) {
        .redrive_pending => if (r.kind != .firing and r.kind != .source_citation) return Error.InvalidLifecycle,
        .uncertain_reconciliation, .dead_letter, .requeue_pending => if (r.kind != .effect_outbox and r.kind != .provider_receipt and r.kind != .dlq_attempt and r.kind != .requeue_lineage) return Error.InvalidLifecycle,
        .compensation_pending => if (r.kind != .effect_outbox and r.kind != .compensation_gap) return Error.InvalidLifecycle,
        else => {},
    }
}

/// Construct the reachability closure.  Every live redrive/reconciliation/DLQ/
/// requeue/compensation row pins both ownership ancestry and citation targets.
pub fn project(allocator: std.mem.Allocator, records: []const Record) Error!Projection {
    const entries = allocator.alloc(Entry, records.len) catch return Error.OutOfMemory;
    errdefer allocator.free(entries);
    for (records, 0..) |r, i| {
        try validatePin(r.pin);
        try validateLifecycle(r);
        if (r.parent) |x| if (x >= records.len or x == i) return Error.InvalidReference;
        if (r.cites) |x| if (x >= records.len or x == i) return Error.InvalidReference;
        for (records[0..i]) |prior| if (prior.pin.commit_ordinal == r.pin.commit_ordinal or std.mem.eql(u8, prior.pin.digest, r.pin.digest)) return Error.DuplicatePin;
        entries[i] = .{ .kind = r.kind, .state = r.state, .pin = r.pin, .parent = r.parent, .cites = r.cites, .retained = isLive(r.state) or r.state == .queued };
    }
    // Walk both directions to a fixpoint: a live descendant pins its ancestors;
    // a pinned generation pins its descendants; citations pin their source.
    var changed = true;
    while (changed) {
        changed = false;
        for (entries, 0..) |e, i| {
            if (e.retained) {
                if (e.parent) |x| if (!entries[x].retained) { entries[x].retained = true; changed = true; };
                if (e.cites) |x| if (!entries[x].retained) { entries[x].retained = true; changed = true; };
            }
            if (e.parent) |x| if (entries[x].retained and !entries[i].retained) { entries[i].retained = true; changed = true; };
        }
    }
    return .{ .allocator = allocator, .entries = entries };
}

/// Shared live/archive classifier. Crossed effects always compensate; unknown
/// delivery requires escalation; only an explicitly settled deterministic row
/// is eligible for redrive.
pub fn verdict(kind: Kind, state: State) Verdict {
    if (kind == .compensation_gap or state == .crossed or state == .compensation_pending) return .compensate;
    if (state == .uncertain_reconciliation or state == .dead_letter or state == .requeue_pending or state == .queued) return .escalate;
    return .redrive;
}

const hex_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const hex_b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const hex_c = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const hex_d = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const hex_e = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const hex_f = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

fn fixture() [10]Record {
    return .{
        .{ .kind=.firing, .state=.redrive_pending, .pin=.{.reference="firing/42",.commit_ordinal=1,.digest=hex_a} },
        .{ .kind=.source_citation, .pin=.{.reference="citation/42/0",.commit_ordinal=2,.digest=hex_b}, .parent=0, .cites=2 },
        .{ .kind=.package_generation, .pin=.{.reference="source/order/g7",.commit_ordinal=3,.digest=hex_c} },
        .{ .kind=.attachment_generation, .pin=.{.reference="limb/webhook/attach/3",.commit_ordinal=4,.digest=hex_d}, .parent=2 },
        .{ .kind=.revocation_generation, .state=.revoked, .pin=.{.reference="limb/webhook/revoke/4",.commit_ordinal=5,.digest=hex_e}, .parent=2 },
        .{ .kind=.effect_outbox, .state=.crossed, .pin=.{.reference="outbox/effect/9",.commit_ordinal=6,.digest=hex_f}, .parent=0 },
        .{ .kind=.provider_receipt, .pin=.{.reference="provider/receipt/91",.commit_ordinal=7,.digest=hex_a}, .parent=5 },
        .{ .kind=.dlq_attempt, .state=.dead_letter, .pin=.{.reference="dlq/effect/9/attempt/3",.commit_ordinal=8,.digest=hex_b}, .parent=5 },
        .{ .kind=.requeue_lineage, .state=.requeue_pending, .pin=.{.reference="requeue/effect/9/1",.commit_ordinal=9,.digest=hex_c}, .parent=7 },
        .{ .kind=.compensation_gap, .state=.compensation_pending, .pin=.{.reference="compensation/effect/9",.commit_ordinal=10,.digest=hex_d}, .parent=5 },
    };
}

test "projection pins every retention family and contains no raw content field" {
    var records=fixture();
    // Digests must be unique even when fixtures span all record families.
    var generated:[10][64]u8=undefined;
    for (&generated,0..) |*d,i| { @memset(d,@intCast('0'+i)); records[i].pin.digest=d; }
    var p=try project(std.testing.allocator,&records); defer p.deinit();
    try std.testing.expectEqual(@as(usize,10),p.entries.len);
    for (p.entries) |e| try std.testing.expect(e.retained);
    const out=try p.jsonAlloc(std.testing.allocator); defer std.testing.allocator.free(out);
    try std.testing.expect(std.mem.indexOf(u8,out,"payload") == null);
    try std.testing.expect(std.mem.indexOf(u8,out,"secret") == null);
    try std.testing.expect(std.mem.indexOf(u8,out,"provider_receipt") != null);
    try std.testing.expect(std.mem.indexOf(u8,out,"compensation_gap") != null);
}

test "collection refuses every live obligation and its reachability closure" {
    const records=[_]Record{
        .{.kind=.package_generation,.pin=.{.reference="package/g1",.commit_ordinal=1,.digest=hex_a}},
        .{.kind=.attachment_generation,.pin=.{.reference="attachment/g2",.commit_ordinal=2,.digest=hex_b},.parent=0},
        .{.kind=.effect_outbox,.state=.uncertain_reconciliation,.pin=.{.reference="effect/3",.commit_ordinal=3,.digest=hex_c},.parent=1},
        .{.kind=.provider_receipt,.pin=.{.reference="receipt/4",.commit_ordinal=4,.digest=hex_d},.parent=2},
    };
    var p=try project(std.testing.allocator,&records); defer p.deinit();
    for (0..records.len) |i| try std.testing.expectError(Error.LiveReference,p.requireCollectible(i));
}

test "redrive verdict is identical from live facts and archived pins" {
    const records=[_]Record{
        .{.kind=.effect_outbox,.state=.crossed,.pin=.{.reference="effect/crossed",.commit_ordinal=1,.digest=hex_a}},
        .{.kind=.effect_outbox,.state=.uncertain_reconciliation,.pin=.{.reference="effect/uncertain",.commit_ordinal=2,.digest=hex_b}},
        .{.kind=.firing,.state=.settled,.pin=.{.reference="firing/settled",.commit_ordinal=3,.digest=hex_c}},
    };
    var p=try project(std.testing.allocator,&records); defer p.deinit();
    for (records,0..) |r,i| try std.testing.expectEqual(verdict(r.kind,r.state),try p.redriveVerdict(i));
    try std.testing.expectEqual(Verdict.compensate,try p.redriveVerdict(0));
    try std.testing.expectEqual(Verdict.escalate,try p.redriveVerdict(1));
    try std.testing.expectEqual(Verdict.redrive,try p.redriveVerdict(2));
}

test "projection rejects payload-shaped refs, invalid digests and dangling edges" {
    var bad=Record{.kind=.firing,.pin=.{.reference="Bearer secret",.commit_ordinal=1,.digest=hex_a}};
    try std.testing.expectError(Error.RawDataReference,project(std.testing.allocator,&.{bad}));
    bad.pin.reference="firing/1"; bad.pin.digest="abc";
    try std.testing.expectError(Error.InvalidDigest,project(std.testing.allocator,&.{bad}));
    bad.pin.digest=hex_a; bad.parent=9;
    try std.testing.expectError(Error.InvalidReference,project(std.testing.allocator,&.{bad}));
}
