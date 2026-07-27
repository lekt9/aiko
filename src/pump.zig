const std = @import("std");
const types = @import("types.zig");
const caps_mod = @import("caps.zig");
const neuron_mod = @import("neuron.zig");
const scheduler_mod = @import("scheduler.zig");
const substrate_mod = @import("substrate.zig");

/// The walk engine (§32): turns one external stimulus into as many firings as
/// the network needs to go quiet again. Neurons stay one-shot and stateless —
/// the pump is what makes the *network* agentic:
///
///   - a `continue` decision parks the neuron as a waiter on its predicate;
///     when the predicate artifact gains evidence, the pump re-fires the
///     neuron with that evidence pinned into its read-set (§20);
///   - a `send` to `neuron/<identity>` is delivered as the target's next
///     stimulus (§10), so one firing can cascade into many;
///   - a `branch` re-enters the worklist under the same logical invocation.
///
/// Agency is bounded by policy: the cycle guard rejects evidence-free
/// re-entry, a step budget caps total firings per run, and a neuron that
/// waits on evidence that never arrives is *surfaced* as pending instead of
/// spinning forever (§26 — "continue forever" is not a settlement rule).
pub const PumpResult = struct {
    /// Successful dispatches (one neuron firing each).
    steps: usize,
    /// Terminate results, in settlement order. Borrows neuron memory.
    settled: []const []const u8,
    /// Waiters still parked when the worklist emptied.
    pending: usize,
    /// Evidence-free re-entries rejected by the cycle guard.
    cycles: usize,
    /// False only when the step budget cut the run short with work remaining.
    quiescent: bool,
};

const Waiter = struct {
    predicate: []const u8,
    caps: caps_mod.Caps,
    receptor_schema: []const u8,
    depth: u8,
};

/// An archetype constructor for spawned neurons. A spawn effect records only
/// data (id, kind, grant, depth); the factory is what admits an instance of
/// that kind into the scheduler, with exactly the recorded grant — unknown
/// kinds stay inert (§29: no authority before admission).
pub const Factory = struct {
    context: *anyopaque,
    construct: *const fn (
        context: *anyopaque,
        allocator: std.mem.Allocator,
        id: []const u8,
        spawned: substrate_mod.SpawnedNeuron,
    ) anyerror!neuron_mod.Neuron,
};

const WorkItem = struct {
    ref: []const u8,
    stimulus: types.Stimulus,
    caps: caps_mod.Caps,
};

pub const Pump = struct {
    scheduler: *scheduler_mod.Scheduler,
    arena: std.heap.ArenaAllocator,
    waiters: std.StringHashMap(Waiter),
    factories: std.StringHashMap(Factory),
    /// Grants of neurons attached from spawn records, keyed by identity.
    attached: std.StringHashMap(caps_mod.Caps),
    counter: usize = 0,
    /// Grant used for firings stimulated by inter-neuron messages. Deny by
    /// default; the operator configures the harness policy explicitly.
    default_caps: caps_mod.Caps = .{},
    /// Maximum firings per run (§26 cumulative budget).
    max_steps: usize = 64,

    pub fn init(allocator: std.mem.Allocator, scheduler: *scheduler_mod.Scheduler) Pump {
        return .{
            .scheduler = scheduler,
            .arena = std.heap.ArenaAllocator.init(allocator),
            .waiters = std.StringHashMap(Waiter).init(allocator),
            .factories = std.StringHashMap(Factory).init(allocator),
            .attached = std.StringHashMap(caps_mod.Caps).init(allocator),
        };
    }

    pub fn deinit(self: *Pump) void {
        self.attached.deinit();
        self.factories.deinit();
        self.waiters.deinit();
        self.arena.deinit();
    }

    /// Register an archetype: spawned neurons of this kind attach as real,
    /// firable instances built by the factory (§30 attach step).
    pub fn registerFactory(self: *Pump, kind: []const u8, factory: Factory) !void {
        try self.factories.put(kind, factory);
    }

    /// Drive the network from one seed stimulus until the worklist empties,
    /// the step budget is exhausted, or every remaining neuron is parked.
    /// The result borrows the pump's arena; it is valid until deinit.
    pub fn run(
        self: *Pump,
        start_ref: []const u8,
        stimulus: types.Stimulus,
        caps: caps_mod.Caps,
    ) !PumpResult {
        const allocator = self.arena.allocator();
        var worklist: std.ArrayList(WorkItem) = .empty;
        var settled: std.ArrayList([]const u8) = .empty;
        var steps: usize = 0;
        var cycles: usize = 0;
        var quiescent = true;
        try worklist.append(allocator, .{ .ref = start_ref, .stimulus = stimulus, .caps = caps });
        while (worklist.pop()) |item| {
            if (steps >= self.max_steps) {
                quiescent = false;
                break;
            }
            const outcome = self.scheduler.dispatch(item.ref, item.stimulus, item.caps) catch |err| switch (err) {
                error.CycleWithoutProgress => {
                    cycles += 1;
                    continue;
                },
                else => return err,
            };
            steps += 1;
            switch (outcome.next) {
                .terminated => |result| {
                    _ = self.waiters.remove(item.ref);
                    try settled.append(allocator, result);
                },
                .waiting => |predicate| try self.waiters.put(item.ref, .{
                    .predicate = predicate,
                    .caps = item.caps,
                    .receptor_schema = item.stimulus.receptor_schema,
                    .depth = item.stimulus.depth,
                }),
                .branch => |target| try worklist.append(allocator, .{
                    .ref = target,
                    .stimulus = .{
                        .firing_id = try self.firingId(),
                        .receptor_schema = item.stimulus.receptor_schema,
                    },
                    .caps = item.caps,
                }),
            }
            try self.attachSpawned(allocator);
            try self.wakeReadyWaiters(allocator, &worklist);
            try self.deliverNeuronMessages(allocator, &worklist);
        }
        return .{
            .steps = steps,
            .settled = settled.items,
            .pending = self.waiters.count(),
            .cycles = cycles,
            .quiescent = quiescent,
        };
    }

    /// Attach step for self-growing networks (§13/§30): every committed spawn
    /// record whose kind has a registered factory becomes a live neuron in
    /// the scheduler, carrying exactly the grant and depth recorded at the
    /// commit boundary. Spawns of unknown kinds stay inert data.
    fn attachSpawned(self: *Pump, allocator: std.mem.Allocator) !void {
        const substrate = self.scheduler.runtime.substrate;
        var iterator = substrate.neurons.iterator();
        while (iterator.next()) |entry| {
            const id = entry.key_ptr.*;
            if (self.scheduler.registry.contains(id)) continue;
            const spawned = entry.value_ptr;
            const factory = self.factories.get(spawned.kind) orelse continue;
            const neuron = try factory.construct(factory.context, allocator, id, spawned.*);
            try self.scheduler.register(neuron);
            const grant: caps_mod.Caps = if (spawned.grant) |*owned| owned.toCaps() else .{};
            try self.attached.put(id, grant);
        }
    }

    /// A waiter wakes exactly when its predicate artifact exists; the wake
    /// stimulus pins the artifact digest into the read-set so the neuron's
    /// new claims are grounded in the evidence that satisfied it (§20/§23).
    fn wakeReadyWaiters(self: *Pump, allocator: std.mem.Allocator, worklist: *std.ArrayList(WorkItem)) !void {
        const substrate = self.scheduler.runtime.substrate;
        var woken: std.ArrayList([]const u8) = .empty;
        var iterator = self.waiters.iterator();
        while (iterator.next()) |entry| {
            const artifact = substrate.artifacts.get(entry.value_ptr.predicate) orelse continue;
            const permitted = try allocator.alloc([]const u8, 1);
            permitted[0] = entry.value_ptr.predicate;
            const reads = try allocator.alloc(types.ArtifactRef, 1);
            reads[0] = .{ .id = entry.value_ptr.predicate, .digest = artifact.digest };
            try worklist.append(allocator, .{
                .ref = entry.key_ptr.*,
                .stimulus = .{
                    .firing_id = try self.firingId(),
                    .receptor_schema = entry.value_ptr.receptor_schema,
                    .permitted_reads = permitted,
                    .reads = reads,
                    .depth = entry.value_ptr.depth,
                },
                .caps = entry.value_ptr.caps,
            });
            try woken.append(allocator, entry.key_ptr.*);
        }
        for (woken.items) |identity| _ = self.waiters.remove(identity);
    }

    /// Receiving a message simply appears as part of the next stimulus (§10).
    /// Messages addressed to `neuron/<identity>` are delivered once, to a
    /// registered neuron, and acknowledged at that point.
    fn deliverNeuronMessages(self: *Pump, allocator: std.mem.Allocator, worklist: *std.ArrayList(WorkItem)) !void {
        const substrate = self.scheduler.runtime.substrate;
        for (substrate.messages.items) |*message| {
            if (message.status != .queued) continue;
            if (!std.mem.startsWith(u8, message.to, "neuron/")) continue;
            const ref = message.to["neuron/".len..];
            if (!self.scheduler.registry.contains(ref)) continue;
            const envelope = try allocator.alloc(types.Message, 1);
            envelope[0] = .{
                .to = message.to,
                .schema = message.schema,
                .payload = message.payload,
                .durable = message.durable,
            };
            message.status = .acknowledged;
            const caps = self.attached.get(ref) orelse self.default_caps;
            const depth: u8 = if (substrate.neurons.get(ref)) |spawned| spawned.depth else 0;
            try worklist.append(allocator, .{
                .ref = ref,
                .stimulus = .{
                    .firing_id = try self.firingId(),
                    .receptor_schema = message.schema,
                    .messages = envelope,
                    .depth = depth,
                },
                .caps = caps,
            });
        }
    }

    fn firingId(self: *Pump) ![]const u8 {
        self.counter += 1;
        return std.fmt.allocPrint(self.arena.allocator(), "pump/{d}", .{self.counter});
    }
};
