const std = @import("std");
const types = @import("types.zig");
const caps_mod = @import("caps.zig");
const neuron_mod = @import("neuron.zig");
const runtime_mod = @import("runtime.zig");

pub const Next = union(enum) {
    terminated: []const u8,
    waiting: []const u8,
    branch: []const u8,
};

pub const DispatchResult = struct {
    commit: runtime_mod.CommitResult,
    next: Next,
};

/// A typed registry and dispatch boundary. It validates control decisions
/// before any effects commit, so an invalid branch/wait cannot leak writes.
/// Re-entering a neuron with no new evidence is a cycle without a progress
/// measure and fails closed (§26).
pub const Scheduler = struct {
    registry: std.StringHashMap(neuron_mod.Neuron),
    progress: std.StringHashMap(types.Digest),
    runtime: runtime_mod.Runtime,

    pub fn init(allocator: std.mem.Allocator, runtime: runtime_mod.Runtime) Scheduler {
        return .{
            .registry = std.StringHashMap(neuron_mod.Neuron).init(allocator),
            .progress = std.StringHashMap(types.Digest).init(allocator),
            .runtime = runtime,
        };
    }

    pub fn deinit(self: *Scheduler) void {
        var keys = self.progress.keyIterator();
        while (keys.next()) |key| self.runtime.substrate.allocator.free(key.*);
        self.progress.deinit();
        self.registry.deinit();
    }

    pub fn register(self: *Scheduler, neuron: neuron_mod.Neuron) !void {
        if (neuron.identity.len == 0 or neuron.version.len == 0) return error.InvalidNeuron;
        if (self.registry.contains(neuron.identity)) return error.DuplicateNeuron;
        try self.registry.put(neuron.identity, neuron);
    }

    /// Rewiring is ordinary topology data: detach an identity so a new
    /// definition can attach under it. Dispatch to a detached identity fails
    /// closed with UnknownNeuron (§26/§30 retire step).
    pub fn unregister(self: *Scheduler, identity: []const u8) bool {
        if (self.progress.fetchRemove(identity)) |entry| self.runtime.substrate.allocator.free(entry.key);
        return self.registry.remove(identity);
    }

    pub fn dispatch(
        self: *Scheduler,
        neuron_ref: []const u8,
        stimulus: types.Stimulus,
        caps: caps_mod.Caps,
    ) !DispatchResult {
        const neuron = self.registry.get(neuron_ref) orelse return error.UnknownNeuron;
        // Cycle policy: re-entry requires a monotonic progress measure — new
        // messages, reads, depth, or receptor evidence. A clock tick or a
        // fresh firing id alone is not progress (§26).
        const measure = progressDigest(stimulus);
        if (self.progress.get(neuron.identity)) |previous| {
            if (std.mem.eql(u8, &previous, &measure)) return error.CycleWithoutProgress;
        }
        const decision = try neuron.fire(stimulus, caps);
        const next: Next = switch (decision.control) {
            .terminate => |result| if (result.len > 0)
                .{ .terminated = result }
            else
                return error.InvalidControl,
            .continue_wait => |predicate| if (predicate) |value|
                if (value.len > 0) .{ .waiting = value } else return error.InvalidControl
            else
                return error.InvalidControl,
            .branch => |target| if (self.registry.contains(target))
                .{ .branch = target }
            else
                return error.UnknownBranch,
        };
        const commit = try self.runtime.execute(stimulus, caps, decision);
        if (self.progress.getPtr(neuron.identity)) |previous| {
            previous.* = measure;
        } else {
            const owned = try self.runtime.substrate.allocator.dupe(u8, neuron.identity);
            errdefer self.runtime.substrate.allocator.free(owned);
            try self.progress.put(owned, measure);
        }
        return .{
            .commit = commit,
            .next = next,
        };
    }
};

/// The progress measure excludes the firing id and the recorded clock: only
/// new receptor evidence, delivered messages, reads, or depth can re-enter a
/// neuron legitimately (§26).
fn progressDigest(stimulus: types.Stimulus) types.Digest {
    var hash = std.crypto.hash.sha2.Sha256.init(.{});
    hashField(&hash, stimulus.receptor_schema);
    hash.update(std.mem.asBytes(&stimulus.depth));
    for (stimulus.permitted_reads) |read| hashField(&hash, read);
    for (stimulus.reads) |read| {
        hashField(&hash, read.id);
        hash.update(&read.digest);
    }
    for (stimulus.messages) |message| {
        hashField(&hash, message.to);
        hashField(&hash, message.schema);
        hashField(&hash, message.payload);
        hash.update(std.mem.asBytes(&message.durable));
    }
    var out: types.Digest = undefined;
    hash.final(&out);
    return out;
}

fn hashField(hash: *std.crypto.hash.sha2.Sha256, bytes: []const u8) void {
    hash.update(std.mem.asBytes(&bytes.len));
    hash.update(bytes);
}
