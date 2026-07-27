const substrate_mod = @import("substrate.zig");

pub const AdapterResult = enum { acknowledged, retryable, permanent_failure, uncertain };
pub const Adapter = *const fn (message: *const substrate_mod.StoredMessage) AdapterResult;

pub const DeliveryResult = struct {
    index: usize,
    status: substrate_mod.DeliveryStatus,
    attempts: u8,
};

/// Delivers the next queued message. Acknowledgement occurs only after the
/// adapter returns success. Retryable failures are bounded and settle in the
/// dead-letter state instead of spinning forever. On a durable substrate the
/// transition is journaled before the in-memory state moves, and a failed
/// append leaves the message untouched — the log and memory never diverge.
pub fn deliverNext(substrate: *substrate_mod.Substrate, adapter: Adapter) !?DeliveryResult {
    for (substrate.messages.items, 0..) |*message, index| {
        if (message.status != .queued) continue;
        // The adapter observes the bumped attempt count, exactly as before;
        // the stored record moves only after the journal append succeeds.
        var bumped = message.*;
        bumped.attempts +|= 1;
        const next: substrate_mod.DeliveryStatus = switch (adapter(&bumped)) {
            .acknowledged => .acknowledged,
            .permanent_failure => .dead_letter,
            .retryable => if (bumped.attempts >= bumped.max_attempts) .dead_letter else .queued,
            // An uncertain external effect is never silently retried: it
            // parks until explicit reconciliation settles it (§27).
            .uncertain => .reconciliation_required,
        };
        try substrate.journalDelivery(index, next, bumped.attempts);
        message.attempts = bumped.attempts;
        message.status = next;
        return .{ .index = index, .status = message.status, .attempts = message.attempts };
    }
    return null;
}

pub const ReconcileOutcome = enum { acknowledged, dead_letter };

/// Settles a parked external effect from fresh evidence. Attempts and the
/// prior state stay recorded, so the audit trail is preserved (§27/§28).
pub fn reconcile(
    substrate: *substrate_mod.Substrate,
    index: usize,
    outcome: ReconcileOutcome,
) !void {
    if (index >= substrate.messages.items.len) return error.UnknownMessage;
    const message = &substrate.messages.items[index];
    if (message.status != .reconciliation_required) return error.NotReconciling;
    const next: substrate_mod.DeliveryStatus = switch (outcome) {
        .acknowledged => .acknowledged,
        .dead_letter => .dead_letter,
    };
    try substrate.journalDelivery(index, next, message.attempts);
    message.status = next;
}
