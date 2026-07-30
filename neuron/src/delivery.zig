const std = @import("std");
const substrate_mod = @import("substrate.zig");

pub const AdapterResult = enum { acknowledged, retryable, permanent_failure, uncertain };

/// A delivery adapter is bound the way a Neuron is: immutable context plus a
/// function pointer. The context is what lets a real adapter carry an
/// allocator, an `Io`, and the admitted interface it dispatches through —
/// without the outbox state machine knowing anything about any of them.
///
/// `to_prefix` scopes which queued addresses this adapter is willing to
/// deliver. An empty prefix accepts every address; a drainer for one
/// destination class sets its own. Scoping is the adapter's declared reach,
/// not a hint: the state machine will not hand it an address it did not claim.
pub const Adapter = struct {
    context: *const anyopaque,
    call_fn: *const fn (
        context: *const anyopaque,
        message: *const substrate_mod.StoredMessage,
    ) AdapterResult,
    to_prefix: []const u8 = "",

    pub fn call(self: Adapter, message: *const substrate_mod.StoredMessage) AdapterResult {
        return self.call_fn(self.context, message);
    }
};

/// Bind a stateful adapter: `T` must expose
/// `deliver(*const T, *const StoredMessage) AdapterResult`.
pub fn bind(comptime T: type, implementation: *const T, to_prefix: []const u8) Adapter {
    const Bound = struct {
        fn call(context: *const anyopaque, message: *const substrate_mod.StoredMessage) AdapterResult {
            const typed: *const T = @ptrCast(@alignCast(context));
            return typed.deliver(message);
        }
    };
    return .{ .context = implementation, .call_fn = Bound.call, .to_prefix = to_prefix };
}

/// Bind a stateless adapter — a bare function with no context to carry.
pub fn bindFn(
    comptime call_fn: fn (message: *const substrate_mod.StoredMessage) AdapterResult,
) Adapter {
    const Bound = struct {
        fn call(_: *const anyopaque, message: *const substrate_mod.StoredMessage) AdapterResult {
            return call_fn(message);
        }
    };
    return .{ .context = undefined, .call_fn = Bound.call };
}

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
        if (!std.mem.startsWith(u8, message.to, adapter.to_prefix)) continue;
        // The adapter observes the bumped attempt count, exactly as before;
        // the stored record moves only after the journal append succeeds.
        var bumped = message.*;
        bumped.attempts +|= 1;
        const next: substrate_mod.DeliveryStatus = switch (adapter.call(&bumped)) {
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
