//! Contract-owned durable execution recovery.
//!
//! The ledger is the state machine.  Every decision below is reconstructed
//! from append-only rows; process memory, sender acknowledgements, and queue
//! hints are never authority.  Callers supply Contract's recorded time and
//! commit ordinal -- this module never reads a wall clock or random source.
const std = @import("std");
const ledger = @import("ledger.zig");

pub const MAX_ATTEMPTS: u32 = 64;
pub const MAX_DELAY_MS: u64 = 86_400_000;
pub const MAX_DELAY_COMMITS: u64 = 1_024;
pub const MAX_CLAIM_MS: u64 = 3_600_000;

pub const FailureClass = enum { retryable, permanent, uncertain_crossed };
pub const ReadBack = enum { effect_present, effect_absent, indeterminate };
pub const Action = enum { claim_attempt, wait, reconcile_read_back, refuse_permanent, refuse_budget, settled };

pub const Identity = struct {
    tenant: []const u8,
    root: []const u8,
    execution: []const u8,
    effect: []const u8,

    pub fn valid(self: Identity) bool {
        return self.tenant.len > 0 and self.root.len > 0 and self.execution.len > 0 and self.effect.len > 0;
    }
};

pub const ContractTime = struct { unix_ms: u64, commit_ordinal: u64 };
pub const Limits = struct {
    max_attempts: u32 = 5,
    base_delay_ms: u64 = 250,
    max_delay_ms: u64 = 30_000,
    max_delay_commits: u64 = 64,
    claim_ms: u64 = 30_000,

    pub fn validate(self: Limits) Error!void {
        if (self.max_attempts == 0 or self.max_attempts > MAX_ATTEMPTS or self.base_delay_ms == 0 or
            self.max_delay_ms < self.base_delay_ms or self.max_delay_ms > MAX_DELAY_MS or
            self.max_delay_commits == 0 or self.max_delay_commits > MAX_DELAY_COMMITS or
            self.claim_ms == 0 or self.claim_ms > MAX_CLAIM_MS) return Error.InvalidBound;
    }
};

pub const Claim = struct {
    id: [64]u8,
    attempt: u32,
    fence: u64,
    lease_until_ms: u64,
    commit_ordinal: u64,
};

pub const Snapshot = struct {
    attempt: u32 = 0,
    fence: u64 = 0,
    last_commit_ordinal: u64 = 0,
    eligible_at_ms: u64 = 0,
    eligible_commit_ordinal: u64 = 0,
    failure: ?FailureClass = null,
    claim: ?Claim = null,
    // Prepared is written before an effector may cross its boundary.  A crash
    // after this row is uncertain by construction and can only be read back.
    effect_prepared: bool = false,
    terminal: bool = false,
    permanent: bool = false,
    exhausted: bool = false,
};

pub const Decision = struct { action: Action, attempt: u32 = 0, eligible_at_ms: u64 = 0, eligible_commit_ordinal: u64 = 0 };

pub const Error = error{
    InvalidIdentity, InvalidBound, CommitOrder, AttemptOrder, AttemptBudget,
    NotEligible, NotClaimed, LeaseExpired, LeaseMismatch, StaleFence,
    PermanentFailure, ReconciliationRequired, ReadBackIndeterminate, Settled,
};

fn hashFields(fields: []const []const u8) [32]u8 {
    var h = std.crypto.hash.sha2.Sha256.init(.{});
    for (fields) |field| { h.update(std.mem.asBytes(&field.len)); h.update(field); }
    var out: [32]u8 = undefined; h.final(&out); return out;
}

fn attemptDigest(identity: Identity, attempt: u32) [32]u8 {
    var buf: [16]u8 = undefined;
    const number = std.fmt.bufPrint(&buf, "{d}", .{attempt}) catch unreachable;
    return hashFields(&.{ "contract.execution.recovery.attempt/v1", identity.tenant, identity.root, identity.execution, identity.effect, number });
}

pub fn claimId(identity: Identity, attempt: u32, fence: u64, ordinal: u64) [64]u8 {
    var a: [16]u8 = undefined; var f: [24]u8 = undefined; var o: [24]u8 = undefined;
    const raw = hashFields(&.{ "contract.execution.recovery.claim/v1", identity.tenant, identity.root,
        identity.execution, identity.effect, std.fmt.bufPrint(&a, "{d}", .{attempt}) catch unreachable,
        std.fmt.bufPrint(&f, "{d}", .{fence}) catch unreachable,
        std.fmt.bufPrint(&o, "{d}", .{ordinal}) catch unreachable });
    return std.fmt.bytesToHex(raw, .lower);
}

/// Deterministic capped delay.  The spread is derived from immutable identity,
/// not entropy, so every replay computes identical eligibility.
pub fn eligibility(identity: Identity, attempt: u32, at: ContractTime, limits: Limits) Error!struct { at_ms: u64, at_ordinal: u64 } {
    if (!identity.valid()) return Error.InvalidIdentity;
    try limits.validate();
    if (attempt == 0 or attempt > MAX_ATTEMPTS) return Error.AttemptOrder;
    const exponent: u6 = @intCast(@min(attempt - 1, 30));
    const shifted = std.math.mul(u64, limits.base_delay_ms, @as(u64, 1) << exponent) catch std.math.maxInt(u64);
    const cap = @min(shifted, limits.max_delay_ms);
    const floor = cap / 2;
    const digest = attemptDigest(identity, attempt);
    const spread = cap - floor;
    const delay = floor + (std.mem.readInt(u64, digest[0..8], .big) % (spread + 1));
    const ordinal_delta = 1 + (std.mem.readInt(u64, digest[8..16], .big) % limits.max_delay_commits);
    return .{
        .at_ms = std.math.add(u64, at.unix_ms, delay) catch std.math.maxInt(u64),
        .at_ordinal = std.math.add(u64, at.commit_ordinal, ordinal_delta) catch std.math.maxInt(u64),
    };
}

pub fn decide(state: Snapshot, now: ContractTime, limits: Limits) Error!Decision {
    try limits.validate();
    if (state.terminal) return .{ .action = .settled };
    if (state.permanent) return .{ .action = .refuse_permanent };
    if (state.exhausted or state.attempt >= limits.max_attempts) return .{ .action = .refuse_budget };
    if (state.effect_prepared or state.failure == .uncertain_crossed)
        return .{ .action = .reconcile_read_back, .attempt = state.attempt };
    if (state.claim) |active_claim| {
        // An un-settled expired claim is not evidence that nothing crossed.
        // Fail closed to read-back; never silently lease it to another sender.
        if (now.unix_ms >= active_claim.lease_until_ms) return .{ .action = .reconcile_read_back, .attempt = active_claim.attempt };
        return .{ .action = .wait, .attempt = active_claim.attempt };
    }
    if (now.unix_ms < state.eligible_at_ms or now.commit_ordinal < state.eligible_commit_ordinal)
        return .{ .action = .wait, .attempt = state.attempt + 1, .eligible_at_ms = state.eligible_at_ms, .eligible_commit_ordinal = state.eligible_commit_ordinal };
    return .{ .action = .claim_attempt, .attempt = state.attempt + 1 };
}

fn requireNext(state: Snapshot, at: ContractTime) Error!void {
    if (at.commit_ordinal != state.last_commit_ordinal + 1) return Error.CommitOrder;
}

pub fn classify(state: Snapshot, identity: Identity, token: Claim, class: FailureClass, at: ContractTime, limits: Limits) Error!Snapshot {
    if (!identity.valid()) return Error.InvalidIdentity;
    try limits.validate();
    if (state.terminal) return Error.Settled;
    try authorize(state, token, at);
    var next = state; next.last_commit_ordinal = at.commit_ordinal; next.failure = class; next.claim = null;
    switch (class) {
        .permanent => next.permanent = true,
        .uncertain_crossed => next.effect_prepared = true,
        .retryable => {
            if (state.effect_prepared) return Error.ReconciliationRequired;
            if (state.attempt >= limits.max_attempts) next.exhausted = true else {
                const due = try eligibility(identity, state.attempt + 1, at, limits);
                next.eligible_at_ms = due.at_ms; next.eligible_commit_ordinal = due.at_ordinal;
            }
        },
    }
    return next;
}

pub fn claim(state: Snapshot, identity: Identity, at: ContractTime, limits: Limits) Error!struct { state: Snapshot, token: Claim } {
    if (!identity.valid()) return Error.InvalidIdentity;
    try limits.validate(); try requireNext(state, at);
    const decision = try decide(state, at, limits);
    if (decision.action != .claim_attempt) return switch (decision.action) {
        .refuse_budget => Error.AttemptBudget, .refuse_permanent => Error.PermanentFailure,
        .reconcile_read_back => Error.ReconciliationRequired, .settled => Error.Settled,
        else => Error.NotEligible,
    };
    const attempt = state.attempt + 1; const fence = state.fence + 1;
    const token: Claim = .{ .id = claimId(identity, attempt, fence, at.commit_ordinal), .attempt = attempt,
        .fence = fence, .lease_until_ms = std.math.add(u64, at.unix_ms, limits.claim_ms) catch std.math.maxInt(u64),
        .commit_ordinal = at.commit_ordinal };
    var next = state; next.attempt = attempt; next.fence = fence; next.claim = token; next.failure = null;
    next.last_commit_ordinal = at.commit_ordinal; next.eligible_at_ms = 0; next.eligible_commit_ordinal = 0;
    return .{ .state = next, .token = token };
}

fn authorize(state: Snapshot, token: Claim, at: ContractTime) Error!void {
    try requireNext(state, at);
    const current = state.claim orelse return Error.NotClaimed;
    if (!std.mem.eql(u8, &current.id, &token.id) or current.attempt != token.attempt) return Error.LeaseMismatch;
    if (current.fence != token.fence or state.fence != token.fence) return Error.StaleFence;
    if (at.unix_ms >= current.lease_until_ms) return Error.LeaseExpired;
}

/// Must be durably appended before invoking an external effector.  Once this
/// row exists, no sender acknowledgement can convert the attempt into a retry.
pub fn prepareEffect(state: Snapshot, token: Claim, at: ContractTime) Error!Snapshot {
    try authorize(state, token, at);
    var next = state; next.effect_prepared = true; next.failure = .uncertain_crossed; next.last_commit_ordinal = at.commit_ordinal;
    return next;
}

pub fn settle(state: Snapshot, token: Claim, at: ContractTime) Error!Snapshot {
    try authorize(state, token, at);
    var next = state; next.terminal = true; next.claim = null; next.last_commit_ordinal = at.commit_ordinal;
    return next;
}

/// A crossed/expired attempt may only be resolved by an independently obtained
/// provider read-back.  ACKs and scheduler hints are intentionally not inputs.
pub fn reconcile(state: Snapshot, identity: Identity, result: ReadBack, at: ContractTime, limits: Limits) Error!Snapshot {
    if (!identity.valid()) return Error.InvalidIdentity;
    try limits.validate(); try requireNext(state, at);
    if (state.terminal) return Error.Settled;
    if (!state.effect_prepared and state.claim == null) return Error.ReconciliationRequired;
    if (result == .indeterminate) return Error.ReadBackIndeterminate;
    var next = state; next.last_commit_ordinal = at.commit_ordinal; next.claim = null;
    if (result == .effect_present) { next.terminal = true; return next; }
    next.effect_prepared = false; next.failure = .retryable;
    if (next.attempt >= limits.max_attempts) next.exhausted = true else {
        const due = try eligibility(identity, next.attempt + 1, at, limits);
        next.eligible_at_ms = due.at_ms; next.eligible_commit_ordinal = due.at_ordinal;
    }
    return next;
}

fn appendString(out: *std.ArrayList(u8), allocator: std.mem.Allocator, value: []const u8) !void {
    try out.append(allocator, '"');
    for (value) |ch| switch (ch) { '"' => try out.appendSlice(allocator, "\\\""), '\\' => try out.appendSlice(allocator, "\\\\"),
        '\n' => try out.appendSlice(allocator, "\\n"), '\r' => try out.appendSlice(allocator, "\\r"), '\t' => try out.appendSlice(allocator, "\\t"),
        else => if (ch >= 0x20) try out.append(allocator, ch) };
    try out.append(allocator, '"');
}

/// Production ledger seam.  Callers append the row before using the returned
/// in-memory state.  Recovery always replays these rows rather than trusting it.
pub fn appendRow(allocator: std.mem.Allocator, env: std.process.Environ, event: []const u8, identity: Identity, state: Snapshot, class: ?FailureClass) ![]u8 {
    if (!identity.valid()) return Error.InvalidIdentity;
    var row: std.ArrayList(u8) = .empty; defer row.deinit(allocator);
    try row.appendSlice(allocator, "{\"event\":"); try appendString(&row, allocator, event);
    for ([_]struct { key: []const u8, value: []const u8 }{ .{ .key="tenant", .value=identity.tenant }, .{ .key="root", .value=identity.root },
        .{ .key="execution", .value=identity.execution }, .{ .key="effect", .value=identity.effect } }) |field| {
        try row.print(allocator, ",\"{s}\":", .{field.key}); try appendString(&row, allocator, field.value);
    }
    try row.print(allocator, ",\"attempt\":{d},\"fence\":{d},\"commit_ordinal\":{d},\"eligible_at_ms\":{d},\"eligible_commit_ordinal\":{d},\"effect_prepared\":{},\"terminal\":{},\"permanent\":{},\"exhausted\":{}",
        .{ state.attempt, state.fence, state.last_commit_ordinal, state.eligible_at_ms, state.eligible_commit_ordinal,
           state.effect_prepared, state.terminal, state.permanent, state.exhausted });
    if (class) |value| { try row.appendSlice(allocator, ",\"failure_class\":"); try appendString(&row, allocator, @tagName(value)); }
    if (state.claim) |token| { try row.print(allocator, ",\"claim_id\":\"{s}\",\"lease_until_ms\":{d}", .{ token.id, token.lease_until_ms }); }
    try row.append(allocator, '}');
    return ledger.appendRow(allocator, env, row.items);
}

pub fn appendAttempt(allocator: std.mem.Allocator, env: std.process.Environ, identity: Identity, state: Snapshot) ![]u8 {
    return appendRow(allocator, env, "execution_recovery_attempt_claimed", identity, state, null);
}
pub fn appendClassification(allocator: std.mem.Allocator, env: std.process.Environ, identity: Identity, state: Snapshot, class: FailureClass) ![]u8 {
    return appendRow(allocator, env, "execution_recovery_failure_classified", identity, state, class);
}
pub fn appendEffectPrepared(allocator: std.mem.Allocator, env: std.process.Environ, identity: Identity, state: Snapshot) ![]u8 {
    return appendRow(allocator, env, "execution_recovery_effect_prepared", identity, state, .uncertain_crossed);
}
pub fn appendSettlement(allocator: std.mem.Allocator, env: std.process.Environ, identity: Identity, state: Snapshot) ![]u8 {
    return appendRow(allocator, env, "execution_recovery_settled", identity, state, state.failure);
}
pub fn appendReconciliation(allocator: std.mem.Allocator, env: std.process.Environ, identity: Identity, state: Snapshot) ![]u8 {
    return appendRow(allocator, env, "execution_recovery_read_back", identity, state, state.failure);
}

fn stringField(line: []const u8, key: []const u8) ?[]const u8 {
    var marker_buf: [96]u8 = undefined; const marker = std.fmt.bufPrint(&marker_buf, "\"{s}\":\"", .{key}) catch return null;
    const at = std.mem.indexOf(u8, line, marker) orelse return null; const start = at + marker.len;
    const end = std.mem.indexOfScalarPos(u8, line, start, '"') orelse return null; return line[start..end];
}
fn uintField(line: []const u8, key: []const u8) ?u64 {
    var marker_buf: [96]u8 = undefined; const marker = std.fmt.bufPrint(&marker_buf, "\"{s}\":", .{key}) catch return null;
    var i = (std.mem.indexOf(u8, line, marker) orelse return null) + marker.len; const start = i;
    while (i < line.len and std.ascii.isDigit(line[i])) : (i += 1) {}
    return if (i == start) null else std.fmt.parseInt(u64, line[start..i], 10) catch null;
}
fn boolField(line: []const u8, key: []const u8) bool {
    var marker_buf: [96]u8 = undefined; const marker = std.fmt.bufPrint(&marker_buf, "\"{s}\":true", .{key}) catch return false;
    return std.mem.indexOf(u8, line, marker) != null;
}

/// Fold only this execution's Contract rows.  Later valid commit ordinals win;
/// duplicate/stale rows are ignored, making crash replay deterministic.
pub fn replay(body: []const u8, identity: Identity) Error!Snapshot {
    if (!identity.valid()) return Error.InvalidIdentity;
    var state: Snapshot = .{}; var lines = std.mem.tokenizeScalar(u8, body, '\n');
    while (lines.next()) |line| {
        const execution = stringField(line, "execution") orelse continue;
        const effect = stringField(line, "effect") orelse continue;
        const tenant = stringField(line, "tenant") orelse continue; const root = stringField(line, "root") orelse continue;
        if (!std.mem.eql(u8, execution, identity.execution) or !std.mem.eql(u8, effect, identity.effect) or
            !std.mem.eql(u8, tenant, identity.tenant) or !std.mem.eql(u8, root, identity.root)) continue;
        const ordinal = uintField(line, "commit_ordinal") orelse continue;
        if (ordinal <= state.last_commit_ordinal) continue;
        state.last_commit_ordinal = ordinal; state.attempt = @intCast(@min(uintField(line, "attempt") orelse 0, MAX_ATTEMPTS));
        state.fence = uintField(line, "fence") orelse 0; state.eligible_at_ms = uintField(line, "eligible_at_ms") orelse 0;
        state.eligible_commit_ordinal = uintField(line, "eligible_commit_ordinal") orelse 0;
        state.effect_prepared = boolField(line, "effect_prepared"); state.terminal = boolField(line, "terminal");
        state.permanent = boolField(line, "permanent"); state.exhausted = boolField(line, "exhausted");
        if (stringField(line, "failure_class")) |value| state.failure = std.meta.stringToEnum(FailureClass, value);
        if (stringField(line, "claim_id")) |id| {
            if (id.len == 64) {
                var token: Claim = .{ .id = undefined, .attempt = state.attempt, .fence = state.fence,
                    .lease_until_ms = uintField(line, "lease_until_ms") orelse 0, .commit_ordinal = ordinal };
                @memcpy(&token.id, id); state.claim = token;
            } else state.claim = null;
        } else state.claim = null;
    }
    return state;
}

const test_identity: Identity = .{ .tenant="tenant-a", .root="root-a", .execution="exec-a", .effect="provider:item-a" };
const test_limits: Limits = .{ .max_attempts=3, .base_delay_ms=10, .max_delay_ms=100, .max_delay_commits=4, .claim_ms=50 };

test "eligibility is capped and immutable-identity deterministic" {
    const a = try eligibility(test_identity, 2, .{ .unix_ms=1000, .commit_ordinal=7 }, test_limits);
    const b = try eligibility(test_identity, 2, .{ .unix_ms=1000, .commit_ordinal=7 }, test_limits);
    try std.testing.expectEqual(a.at_ms, b.at_ms); try std.testing.expectEqual(a.at_ordinal, b.at_ordinal);
    try std.testing.expect(a.at_ms >= 1010 and a.at_ms <= 1020); try std.testing.expect(a.at_ordinal > 7 and a.at_ordinal <= 11);
}

test "attempt budget permanent refusal and fenced claims fail closed" {
    var state: Snapshot = .{};
    const first = try claim(state, test_identity, .{ .unix_ms=1, .commit_ordinal=1 }, test_limits); state = first.state;
    var stale = first.token; stale.fence += 1;
    try std.testing.expectError(Error.StaleFence, prepareEffect(state, stale, .{ .unix_ms=2, .commit_ordinal=2 }));
    state = try classify(state, test_identity, first.token, .permanent, .{ .unix_ms=2, .commit_ordinal=2 }, test_limits);
    try std.testing.expectEqual(Action.refuse_permanent, (try decide(state, .{ .unix_ms=999, .commit_ordinal=99 }, test_limits)).action);
}

test "commit ordinal is the only transition order" {
    const claimed = try claim(.{}, test_identity, .{ .unix_ms=1, .commit_ordinal=1 }, test_limits);
    try std.testing.expectError(Error.CommitOrder, prepareEffect(claimed.state, claimed.token, .{ .unix_ms=2, .commit_ordinal=3 }));
}

test "attempt budget is a permanent recovery refusal" {
    const state: Snapshot = .{ .attempt=3, .fence=3, .last_commit_ordinal=3 };
    try std.testing.expectEqual(Action.refuse_budget, (try decide(state, .{ .unix_ms=100, .commit_ordinal=4 }, test_limits)).action);
    try std.testing.expectError(Error.AttemptBudget, claim(state, test_identity, .{ .unix_ms=100, .commit_ordinal=4 }, test_limits));
}

test "crash before claim is reconstructed as the same eligible attempt" {
    const before = try replay("", test_identity);
    const a = try decide(before, .{ .unix_ms=10, .commit_ordinal=1 }, test_limits);
    const b = try decide(before, .{ .unix_ms=10, .commit_ordinal=1 }, test_limits);
    try std.testing.expectEqual(Action.claim_attempt, a.action);
    try std.testing.expectEqual(a.attempt, b.attempt);
}

test "crash after claim or prepared effect recovers to read-back only" {
    var state = (try claim(.{}, test_identity, .{ .unix_ms=10, .commit_ordinal=1 }, test_limits)).state;
    try std.testing.expectEqual(Action.reconcile_read_back, (try decide(state, .{ .unix_ms=60, .commit_ordinal=2 }, test_limits)).action);
    // Replay after the durable prepare row has the same verdict.  No ACK input exists.
    state = try prepareEffect(state, state.claim.?, .{ .unix_ms=11, .commit_ordinal=2 });
    var row: std.ArrayList(u8) = .empty; defer row.deinit(std.testing.allocator);
    // Exercise the parser with the exact durable schema without filesystem I/O.
    try row.print(std.testing.allocator, "{{\"event\":\"execution_recovery_effect_prepared\",\"tenant\":\"tenant-a\",\"root\":\"root-a\",\"execution\":\"exec-a\",\"effect\":\"provider:item-a\",\"attempt\":1,\"fence\":1,\"commit_ordinal\":2,\"eligible_at_ms\":0,\"eligible_commit_ordinal\":0,\"effect_prepared\":true,\"terminal\":false,\"permanent\":false,\"exhausted\":false,\"failure_class\":\"uncertain_crossed\",\"claim_id\":\"{s}\",\"lease_until_ms\":60}}", .{state.claim.?.id});
    const recovered = try replay(row.items, test_identity);
    try std.testing.expectEqual(Action.reconcile_read_back, (try decide(recovered, .{ .unix_ms=12, .commit_ordinal=3 }, test_limits)).action);
    try std.testing.expectError(Error.ReadBackIndeterminate, reconcile(recovered, test_identity, .indeterminate, .{ .unix_ms=12, .commit_ordinal=3 }, test_limits));
    const absent = try reconcile(recovered, test_identity, .effect_absent, .{ .unix_ms=12, .commit_ordinal=3 }, test_limits);
    try std.testing.expect(!absent.effect_prepared and absent.eligible_at_ms > 12);
}

test "settlement replay is terminal and stale rows cannot resurrect it" {
    const claimed = try claim(.{}, test_identity, .{ .unix_ms=1, .commit_ordinal=1 }, test_limits);
    const done = try settle(claimed.state, claimed.token, .{ .unix_ms=2, .commit_ordinal=2 });
    const body =
        "{\"event\":\"execution_recovery_attempt_claimed\",\"tenant\":\"tenant-a\",\"root\":\"root-a\",\"execution\":\"exec-a\",\"effect\":\"provider:item-a\",\"attempt\":1,\"fence\":1,\"commit_ordinal\":1,\"eligible_at_ms\":0,\"eligible_commit_ordinal\":0,\"effect_prepared\":false,\"terminal\":false,\"permanent\":false,\"exhausted\":false}\n" ++
        "{\"event\":\"execution_recovery_settled\",\"tenant\":\"tenant-a\",\"root\":\"root-a\",\"execution\":\"exec-a\",\"effect\":\"provider:item-a\",\"attempt\":1,\"fence\":1,\"commit_ordinal\":2,\"eligible_at_ms\":0,\"eligible_commit_ordinal\":0,\"effect_prepared\":false,\"terminal\":true,\"permanent\":false,\"exhausted\":false}\n" ++
        // Stale sender output after settlement cannot win over ordinal 2.
        "{\"event\":\"execution_recovery_failure_classified\",\"tenant\":\"tenant-a\",\"root\":\"root-a\",\"execution\":\"exec-a\",\"effect\":\"provider:item-a\",\"attempt\":1,\"fence\":1,\"commit_ordinal\":1,\"eligible_at_ms\":9,\"eligible_commit_ordinal\":9,\"effect_prepared\":false,\"terminal\":false,\"permanent\":false,\"exhausted\":false,\"failure_class\":\"retryable\"}";
    const recovered = try replay(body, test_identity);
    try std.testing.expectEqual(Action.settled, (try decide(recovered, .{ .unix_ms=3, .commit_ordinal=3 }, test_limits)).action);
    try std.testing.expectError(Error.Settled, classify(done, test_identity, claimed.token, .retryable, .{ .unix_ms=3, .commit_ordinal=3 }, test_limits));
}
