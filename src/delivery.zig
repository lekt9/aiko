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
/// dead-letter state instead of spinning forever.
pub fn deliverNext(substrate: *substrate_mod.Substrate, adapter: Adapter) ?DeliveryResult {
    for (substrate.messages.items, 0..) |*message, index| {
        if (message.status != .queued) continue;
        message.attempts +|= 1;
        switch (adapter(message)) {
            .acknowledged => message.status = .acknowledged,
            .permanent_failure => message.status = .dead_letter,
            .retryable => if (message.attempts >= message.max_attempts) {
                message.status = .dead_letter;
            },
            // An uncertain external effect is never silently retried: it
            // parks until explicit reconciliation settles it (§27).
            .uncertain => message.status = .reconciliation_required,
        }
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
    message.status = switch (outcome) {
        .acknowledged => .acknowledged,
        .dead_letter => .dead_letter,
    };
}
