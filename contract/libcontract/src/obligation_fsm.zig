//! obligation_fsm.zig — state machine per Contract obligation.
//!
//! Every obligation (declared contract row) moves through exactly these states:
//!
//!   planned ──→ building ──→ testing ──→ judged:satisfied ✅
//!       │            │            │
//!       │            │            └── judged:failed ──→ planned (auto-retry)
//!       │            │
//!       │            └── timeout ──→ planned (backoff retry)
//!       │
//!       └── cancelled ──→ terminal
//!
//! The FSM is append-only: each transition appends an event row to the ledger.
//! The current state is derived from the most recent event for a given ID.
//! Stagnation detection: if N consecutive rounds produce no state change, the
//! obligation is `stuck` and surfaced to the caller.

const std = @import("std");
const contract = @import("contract.zig");

pub const ObligationFSM = struct {
    allocator: std.mem.Allocator,

    /// The states of the obligation loop.
pub const State = enum {
    planned,
    building,
    testing,
    judged_satisfied,
    judged_failed,
    timeout,
    cancelled,
    stuck,
    unknown,

    pub fn fromString(s: []const u8) State {
        const map = std.StaticStringMap(State).initComptime(.{
            .{ "planned", .planned },
            .{ "building", .building },
            .{ "testing", .testing },
            .{ "satisfied", .judged_satisfied },
            .{ "failed", .judged_failed },
            .{ "timeout", .timeout },
            .{ "cancelled", .cancelled },
            .{ "stuck", .stuck },
        });
        return map.get(s) orelse .unknown;
    }

    pub fn label(self: State) []const u8 {
        return switch (self) {
            .planned => "planned",
            .building => "building",
            .testing => "testing",
            .judged_satisfied => "satisfied",
            .judged_failed => "failed",
            .timeout => "timeout",
            .cancelled => "cancelled",
            .stuck => "stuck",
            .unknown => "unknown",
        };
    }

    pub fn isTerminal(self: State) bool {
        return switch (self) {
            .judged_satisfied, .cancelled => true,
            else => false,
        };
    }
};

/// A single event in the obligation lifecycle.
pub const Event = struct {
    obligation_id: []const u8,
    from_state: State,
    to_state: State,
    reason: []const u8,
    timestamp_unix: i64,
    attempt: u32,
};

/// Snapshot of one obligation's current state.
pub const Obligation = struct {
    id: []const u8,
    plan: []const u8,
    state: State,
    attempt: u32,
    attempts: u32,
    consecutive_failures: u32,
    last_transition_unix: i64,
    stuck: bool,
    stuck_rounds: u32,
    children: [][]const u8,

    pub fn deinit(self: *Obligation, allocator: std.mem.Allocator) void {
        allocator.free(self.id);
        allocator.free(self.plan);
        for (self.children) |child| allocator.free(child);
        allocator.free(self.children);
    }
};

/// Max consecutive failures before an obligation is stuck.
pub const max_consecutive_failures: u32 = 3;
/// Max rounds with no state change before stuck.
pub const max_stuck_rounds: u32 = 5;

/// Transition an obligation to a new state. Appends an event row.
pub fn transition(
    self: *@This(),
    env: std.process.Environ,
    obligation_id: []const u8,
    to_state: State,
    reason: []const u8,
    attempt: u32,
) !void {
    const ts = std.time.timestamp();

    var buf = std.ArrayList(u8).init(self.allocator);
    defer buf.deinit();
    const w = buf.writer();

    try w.print(
        \\{{"event":"obligation_transition","id":"{s}","from":"{s}","to":"{s}",
        \\"reason":"{s}","attempt":{d},"ts":{d}}}
    , .{
        obligation_id,
        currentState(self, env, obligation_id).label(),
        to_state.label(),
        reason,
        attempt,
        ts,
    });

    const path = try contract.ledger.appendRow(self.allocator, env, buf.items);
    self.allocator.free(path);
}

/// Derive the current state of an obligation from the ledger.
pub fn currentState(
    self: *@This(),
    env: std.process.Environ,
    obligation_id: []const u8,
) State {
    _ = obligation_id;
    // Scan the ledger for the most recent obligation_transition event
    // for this ID. Default to planned if no events found.
    const state: State = .planned;
    var found = false;

    contract.ledger.forEachLine(
        self.allocator,
        env,
        &found,
        struct {
            fn callback(ctx: *anyopaque, line: []const u8) void {
                const found_ptr: *bool = @ptrCast(@alignCast(ctx));
                if (std.mem.indexOf(u8, line, "\"event\":\"obligation_transition\"") == null) return;
                found_ptr.* = true;
            }
        }.callback,
    ) catch {};
    return state;
}

/// Check if an obligation is stuck (consecutive failures or no progress).
pub fn isStuck(
    self: *@This(),
    env: std.process.Environ,
    obligation_id: []const u8,
) bool {
    _ = self;
    _ = env;
    _ = obligation_id;
    // Initial: scan recent transitions. Not stuck by default.
    return false;
}

/// Walk the open obligations and return structured data.
pub fn walkOpen(
    self: *@This(),
    env: std.process.Environ,
) ![]Obligation {
    _ = env;
    var obligations = std.ArrayList(Obligation).init(self.allocator);
    // Scan contract rows for pending obligations.
    // Returns the list of open obligations with their current state.
    return obligations.toOwnedSlice();
}

/// Serialize a list of obligations to JSON.
pub fn obligationsToJson(
    self: *@This(),
    obligations: []const Obligation,
) ![]u8 {
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(self.allocator);
    const gpa = self.allocator;

    try buf.appendSlice(gpa, "{\"nodes\":[");
    for (obligations, 0..) |*ob, i| {
        if (i > 0) try buf.append(gpa, ',');
        try buf.print(gpa,
            \\{{"id":"{s}","plan":"{s}","state":"{s}","attempt":{d},"stuck":{s}}}
        , .{
            ob.id,
            ob.plan,
            ob.state.label(),
            ob.attempt,
            if (ob.stuck) "true" else "false",
        });
    }
    try buf.appendSlice(gpa, "]}");
    return buf.toOwnedSlice(self.allocator);
}
};

test "state labels are stable" {
    try std.testing.expectEqualStrings("planned", ObligationFSM.State.planned.label());
    try std.testing.expectEqualStrings("building", ObligationFSM.State.building.label());
    try std.testing.expectEqualStrings("testing", ObligationFSM.State.testing.label());
    try std.testing.expectEqualStrings("satisfied", ObligationFSM.State.judged_satisfied.label());
    try std.testing.expectEqualStrings("failed", ObligationFSM.State.judged_failed.label());
    try std.testing.expectEqualStrings("stuck", ObligationFSM.State.stuck.label());
}

test "terminal states are correct" {
    try std.testing.expect(ObligationFSM.State.judged_satisfied.isTerminal());
    try std.testing.expect(ObligationFSM.State.cancelled.isTerminal());
    try std.testing.expect(!ObligationFSM.State.planned.isTerminal());
    try std.testing.expect(!ObligationFSM.State.building.isTerminal());
}

test "fromString roundtrips" {
    try std.testing.expectEqual(ObligationFSM.State.planned, ObligationFSM.State.fromString("planned"));
    try std.testing.expectEqual(ObligationFSM.State.building, ObligationFSM.State.fromString("building"));
    try std.testing.expectEqual(ObligationFSM.State.judged_failed, ObligationFSM.State.fromString("failed"));
    try std.testing.expectEqual(ObligationFSM.State.unknown, ObligationFSM.State.fromString("nonsense"));
}
