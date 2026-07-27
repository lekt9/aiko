const std = @import("std");
const substrate_mod = @import("substrate.zig");
const types = @import("types.zig");

pub const Metrics = struct {
    committed: usize = 0,
    rejected: usize = 0,
    failed: usize = 0,
    timed_out: usize = 0,
    cancelled: usize = 0,
    queued_messages: usize = 0,
    acknowledged_messages: usize = 0,
    dead_letters: usize = 0,
    reconciling: usize = 0,
};

pub fn metrics(substrate: *const substrate_mod.Substrate) Metrics {
    var result: Metrics = .{};
    var firings = substrate.firings.valueIterator();
    while (firings.next()) |firing| switch (firing.status) {
        .committed => result.committed += 1,
        .rejected => result.rejected += 1,
        .failed => result.failed += 1,
        .timed_out => result.timed_out += 1,
        .cancelled => result.cancelled += 1,
    };
    for (substrate.messages.items) |message| switch (message.status) {
        .queued => result.queued_messages += 1,
        .acknowledged => result.acknowledged_messages += 1,
        .dead_letter => result.dead_letters += 1,
        .reconciliation_required => result.reconciling += 1,
    };
    return result;
}

/// Independent replay witness: compare a recomputed decision identity with the
/// immutable committed record while effects remain disabled.
pub fn verifyReplay(
    substrate: *const substrate_mod.Substrate,
    firing_id: []const u8,
    recomputed: types.Digest,
) !void {
    const record = substrate.firings.get(firing_id) orelse return error.UnknownFiring;
    if (record.status != .committed) return error.NotReplayable;
    if (!std.mem.eql(u8, &record.decision_digest, &recomputed)) return error.ReplayMismatch;
}
