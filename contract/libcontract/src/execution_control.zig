//! Contract-owned execution control and fencing.
//!
//! This is the authority kernel for every leased execution.  Human-readable
//! owner labels are audit metadata only: mutation authority is the complete
//! lease token, minted from an owner incarnation and a monotonic fence.
const std = @import("std");

pub const MAX_CLAIM_BATCH: usize = 256;
pub const MAX_LEASE_MS: u64 = 86_400_000;
pub const MAX_ATTEMPTS: u32 = 64;

pub const Phase = enum { runnable, active, paused, cancelled, invalidated, settled };
pub const Outcome = enum { satisfied, timed_out_retryable, died };
pub const Control = enum { run, pause, cancel, invalidate };

pub const Version = struct { graph: u64, input: u64 };
pub const Token = struct {
    lease_id: [64]u8,
    incarnation: [64]u8,
    execution_id: [64]u8,
    attempt: u32,
    fence: u64,
    version: Version,
    commit_ordinal: u64,
};

pub const State = struct {
    phase: Phase = .runnable,
    version: Version,
    attempt: u32 = 0,
    fence: u64 = 0,
    lease_until_ms: u64 = 0,
    commit_ordinal: u64 = 0,
    token: ?Token = null,
    crossed: bool = false,
    effect_key: ?[]const u8 = null,
};

pub const Error = error{
    InvalidBound, NotRunnable, Paused, Cancelled, Invalidated, Settled,
    AttemptExhausted, LeaseExpired, LeaseMismatch, VersionMismatch,
    StaleFence, CommitOrder, EffectKeyBusy, CompensationRequired,
};

pub fn incarnation(owner: []const u8, boot_nonce: []const u8) [64]u8 {
    return digest(&.{ "contract.execution.incarnation/v1", owner, boot_nonce });
}

fn digest(fields: []const []const u8) [64]u8 {
    var hash = std.crypto.hash.sha2.Sha256.init(.{});
    for (fields) |field| { hash.update(std.mem.asBytes(&field.len)); hash.update(field); }
    var raw: [32]u8 = undefined;
    hash.final(&raw);
    return std.fmt.bytesToHex(raw, .lower);
}

pub fn claim(
    state: *State,
    execution_id: [64]u8,
    who: [64]u8,
    version: Version,
    now_ms: u64,
    lease_ms: u64,
    next_commit_ordinal: u64,
    effect_key: ?[]const u8,
) Error!Token {
    if (lease_ms == 0 or lease_ms > MAX_LEASE_MS) return Error.InvalidBound;
    if (next_commit_ordinal != state.commit_ordinal + 1) return Error.CommitOrder;
    switch (state.phase) {
        .paused => return Error.Paused,
        .cancelled => return Error.Cancelled,
        .invalidated => return Error.Invalidated,
        .settled => return Error.Settled,
        .active => if (state.lease_until_ms > now_ms) return Error.NotRunnable,
        .runnable => {},
    }
    if (state.token != null and (state.version.graph != version.graph or state.version.input != version.input))
        return Error.VersionMismatch;
    if (state.attempt >= MAX_ATTEMPTS) return Error.AttemptExhausted;
    if (state.effect_key != null and effect_key != null and !std.mem.eql(u8, state.effect_key.?, effect_key.?))
        return Error.EffectKeyBusy;
    const attempt = state.attempt + 1;
    const fence = state.fence + 1;
    var attempt_buf: [32]u8 = undefined; var fence_buf: [32]u8 = undefined; var ord_buf: [32]u8 = undefined;
    const lease_id = digest(&.{ "contract.execution.lease/v1", &execution_id, &who,
        std.fmt.bufPrint(&attempt_buf, "{d}", .{attempt}) catch unreachable,
        std.fmt.bufPrint(&fence_buf, "{d}", .{fence}) catch unreachable,
        std.fmt.bufPrint(&ord_buf, "{d}", .{next_commit_ordinal}) catch unreachable });
    const token: Token = .{ .lease_id = lease_id, .incarnation = who, .execution_id = execution_id,
        .attempt = attempt, .fence = fence, .version = version, .commit_ordinal = next_commit_ordinal };
    state.* = .{ .phase = .active, .version = version, .attempt = attempt, .fence = fence,
        .lease_until_ms = std.math.add(u64, now_ms, lease_ms) catch std.math.maxInt(u64),
        .commit_ordinal = next_commit_ordinal, .token = token, .crossed = state.crossed, .effect_key = effect_key };
    return token;
}

fn authorize(state: *const State, token: Token, now_ms: u64, next_commit_ordinal: u64) Error!void {
    switch (state.phase) { .paused => return Error.Paused, .cancelled => return Error.Cancelled,
        .invalidated => return Error.Invalidated, .settled => return Error.Settled,
        .runnable => return Error.LeaseMismatch, .active => {} }
    if (now_ms >= state.lease_until_ms) return Error.LeaseExpired;
    if (next_commit_ordinal != state.commit_ordinal + 1) return Error.CommitOrder;
    const current = state.token orelse return Error.LeaseMismatch;
    if (!std.mem.eql(u8, &current.lease_id, &token.lease_id) or
        !std.mem.eql(u8, &current.incarnation, &token.incarnation) or
        !std.mem.eql(u8, &current.execution_id, &token.execution_id) or
        current.attempt != token.attempt) return Error.LeaseMismatch;
    if (current.fence != token.fence or state.fence != token.fence) return Error.StaleFence;
    if (current.version.graph != token.version.graph or current.version.input != token.version.input)
        return Error.VersionMismatch;
}

pub fn renew(state: *State, token: Token, now_ms: u64, lease_ms: u64, next_commit_ordinal: u64) Error!void {
    if (lease_ms == 0 or lease_ms > MAX_LEASE_MS) return Error.InvalidBound;
    try authorize(state, token, now_ms, next_commit_ordinal);
    state.lease_until_ms = std.math.add(u64, now_ms, lease_ms) catch std.math.maxInt(u64);
    state.commit_ordinal = next_commit_ordinal;
}

pub fn settle(state: *State, token: Token, now_ms: u64, next_commit_ordinal: u64, outcome: Outcome) Error!void {
    try authorize(state, token, now_ms, next_commit_ordinal);
    if (state.crossed and outcome == .timed_out_retryable) return Error.CompensationRequired;
    state.phase = if (outcome == .timed_out_retryable) .runnable else .settled;
    state.lease_until_ms = 0; state.commit_ordinal = next_commit_ordinal;
}

pub fn control(state: *State, command: Control, next_commit_ordinal: u64) Error!void {
    if (next_commit_ordinal != state.commit_ordinal + 1) return Error.CommitOrder;
    if (state.phase == .settled) return Error.Settled;
    state.phase = switch (command) { .run => .runnable, .pause => .paused, .cancel => .cancelled, .invalidate => .invalidated };
    state.fence += 1; state.lease_until_ms = 0; state.commit_ordinal = next_commit_ordinal;
}

fn fixture() struct { state: State, id: [64]u8, a: [64]u8, b: [64]u8 } {
    return .{ .state = .{ .version = .{ .graph = 1, .input = 1 } },
        .id = digest(&.{"execution"}), .a = incarnation("same-label", "boot-a"), .b = incarnation("same-label", "boot-b") };
}

test "owner label reuse and expiry cannot mutate a reassigned lease" {
    var f = fixture(); const old = try claim(&f.state, f.id, f.a, f.state.version, 100, 10, 1, "effect:one");
    try std.testing.expectError(Error.LeaseExpired, settle(&f.state, old, 110, 2, .satisfied));
    const fresh = try claim(&f.state, f.id, f.b, f.state.version, 110, 10, 2, "effect:one");
    try std.testing.expectError(Error.LeaseMismatch, renew(&f.state, old, 111, 10, 3));
    try settle(&f.state, fresh, 111, 3, .satisfied);
}
test "cancel and invalidation fence late settlement" {
    var f = fixture(); const lease = try claim(&f.state, f.id, f.a, f.state.version, 1, 10, 1, null);
    try control(&f.state, .cancel, 2); try std.testing.expectError(Error.Cancelled, settle(&f.state, lease, 2, 3, .satisfied));
    var g = fixture(); const stale = try claim(&g.state, g.id, g.a, g.state.version, 1, 10, 1, null);
    try control(&g.state, .invalidate, 2); try std.testing.expectError(Error.Invalidated, renew(&g.state, stale, 2, 10, 3));
}
test "crossed retry requires compensation and controls are ordered" {
    var f = fixture(); const lease = try claim(&f.state, f.id, f.a, f.state.version, 1, 10, 1, null); f.state.crossed = true;
    try std.testing.expectError(Error.CompensationRequired, settle(&f.state, lease, 2, 2, .timed_out_retryable));
    try std.testing.expectError(Error.CommitOrder, control(&f.state, .pause, 9));
}
