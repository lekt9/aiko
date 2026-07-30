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

/// The reserved predicate namespace for conversations: a neuron that returns
/// `continue` on `reply/<correlation>` is not waiting for an artifact, it is
/// waiting for an answer. The pump wakes it with the reply itself pinned into
/// the stimulus, and holds unrelated traffic meanwhile so one conversation
/// cannot be interrupted by another (§10).
pub const REPLY_PREDICATE_PREFIX = "reply/";

const Waiter = struct {
    predicate: []const u8,
    caps: caps_mod.Caps,
    receptor_schema: []const u8,
    depth: u8,

    /// The correlation this waiter is parked on, or null for an ordinary
    /// artifact predicate.
    fn awaitedCorrelation(self: Waiter) ?[]const u8 {
        if (!std.mem.startsWith(u8, self.predicate, REPLY_PREDICATE_PREFIX)) return null;
        return self.predicate[REPLY_PREDICATE_PREFIX.len..];
    }
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
    /// When this firing was stimulated by a durable message, acknowledge the
    /// message only after the consumer has committed.
    source_message_index: ?usize = null,
};

const EventRoute = struct {
    schema: []const u8,
    ref: []const u8,
    caps: caps_mod.Caps,
    read_ids: []const []const u8,
};

pub const Pump = struct {
    scheduler: *scheduler_mod.Scheduler,
    arena: std.heap.ArenaAllocator,
    waiters: std.StringHashMap(Waiter),
    factories: std.StringHashMap(Factory),
    event_routes: std.ArrayList(EventRoute),
    /// Grants of neurons attached from spawn records, keyed by identity.
    attached: std.StringHashMap(caps_mod.Caps),
    counter: usize = 0,
    /// Grant used for firings stimulated by inter-neuron messages. Deny by
    /// default; the operator configures the harness policy explicitly.
    default_caps: caps_mod.Caps = .{},
    /// Maximum firings per run (§26 cumulative budget).
    max_steps: usize = 64,
    /// Namespace for pump-generated firing identities. A caller driving a
    /// durable substrate scopes this per workflow so firings from distinct
    /// workflows never collide, while an identical resumed workflow replays
    /// deterministically into the same identities (§21 dedupe).
    firing_prefix: []const u8 = "pump",

    pub fn init(allocator: std.mem.Allocator, scheduler: *scheduler_mod.Scheduler) Pump {
        // A running network observes its own ordinary settlements. Direct
        // Runtime users retain the conservative opt-in default.
        scheduler.runtime.emit_settlement_events = true;
        return .{
            .scheduler = scheduler,
            .arena = std.heap.ArenaAllocator.init(allocator),
            .waiters = std.StringHashMap(Waiter).init(allocator),
            .factories = std.StringHashMap(Factory).init(allocator),
            .event_routes = .empty,
            .attached = std.StringHashMap(caps_mod.Caps).init(allocator),
        };
    }

    pub fn deinit(self: *Pump) void {
        self.event_routes.deinit(self.scheduler.runtime.substrate.allocator);
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

    /// Subscribe an admitted neuron to a durable lifecycle schema. Optional
    /// read ids are resolved and digest-pinned at delivery time, allowing a
    /// stateless observer to reconstruct its narrow state with every event.
    pub fn subscribe(
        self: *Pump,
        schema: []const u8,
        ref: []const u8,
        caps: caps_mod.Caps,
        read_ids: []const []const u8,
    ) !void {
        const allocator = self.arena.allocator();
        const owned_reads = try allocator.alloc([]const u8, read_ids.len);
        for (read_ids, 0..) |id, i| owned_reads[i] = try allocator.dupe(u8, id);
        try self.event_routes.append(self.scheduler.runtime.substrate.allocator, .{
            .schema = try allocator.dupe(u8, schema),
            .ref = try allocator.dupe(u8, ref),
            .caps = caps,
            .read_ids = owned_reads,
        });
    }

    /// Dispatch through a router using the current committed topology. The
    /// schema projection is rebuilt for every call, so an edge attached by a
    /// previous firing is live on the next stimulus without a host restart.
    /// Every selected artifact is digest-pinned into the firing provenance.
    pub fn runRouted(
        self: *Pump,
        router_ref: []const u8,
        stimulus: types.Stimulus,
        caps: caps_mod.Caps,
    ) !PumpResult {
        const allocator = self.arena.allocator();
        var permitted: std.ArrayList([]const u8) = .empty;
        var reads: std.ArrayList(types.ArtifactRef) = .empty;
        try permitted.appendSlice(allocator, stimulus.permitted_reads);
        try reads.appendSlice(allocator, stimulus.reads);

        var iterator = self.scheduler.runtime.substrate.artifacts.iterator();
        while (iterator.next()) |entry| {
            if (!std.mem.eql(u8, entry.value_ptr.schema, "neuron.edge-manifest/v1")) continue;
            try permitted.append(allocator, entry.key_ptr.*);
            try reads.append(allocator, .{
                .id = entry.key_ptr.*,
                .digest = entry.value_ptr.digest,
            });
        }
        var routed = stimulus;
        routed.permitted_reads = permitted.items;
        routed.reads = reads.items;
        return self.run(router_ref, routed, caps);
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
        var seed = stimulus;
        if (seed.self_ref.len == 0) seed.self_ref = try self.selfRef(start_ref);
        return self.drive(.{ .ref = start_ref, .stimulus = seed, .caps = caps });
    }

    /// Re-check parked predicates with no new seed stimulus.
    ///
    /// A waiter is woken by evidence, and evidence can appear from outside this
    /// pump — a harness that dispatched a committed outbox record, another
    /// process, a restart. Re-seeding the parked neuron to make it notice would
    /// be an evidence-free re-entry, which the cycle guard rightly rejects; so
    /// the pump exposes the wake pass itself instead (§26).
    pub fn resumeWaiters(self: *Pump) !PumpResult {
        return self.drive(null);
    }

    fn drive(self: *Pump, seed: ?WorkItem) !PumpResult {
        const allocator = self.arena.allocator();
        var worklist: std.ArrayList(WorkItem) = .empty;
        var settled: std.ArrayList([]const u8) = .empty;
        var steps: usize = 0;
        var cycles: usize = 0;
        var quiescent = true;
        var inflight = std.AutoHashMap(usize, void).init(self.scheduler.runtime.substrate.allocator);
        defer inflight.deinit();
        if (seed) |item| {
            try worklist.append(allocator, item);
        } else {
            try self.wakeReadyWaiters(allocator, &worklist);
            try self.deliverMessages(allocator, &worklist, &inflight);
        }
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
            if (item.source_message_index) |index| {
                try self.acknowledgeMessage(index);
                _ = inflight.remove(index);
            }
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
                        .self_ref = try self.selfRef(target),
                    },
                    .caps = item.caps,
                }),
            }
            try self.attachSpawned(allocator);
            try self.wakeReadyWaiters(allocator, &worklist);
            try self.deliverMessages(allocator, &worklist, &inflight);
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
            // Conversation waiters are woken by their reply, never by an
            // artifact that happens to share the reserved name.
            if (entry.value_ptr.awaitedCorrelation() != null) continue;
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
                    .self_ref = try self.selfRef(entry.key_ptr.*),
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
    /// Both direct neuron messages and subscribed lifecycle events use the
    /// same durable queue. They remain queued until the consumer commits.
    fn deliverMessages(
        self: *Pump,
        allocator: std.mem.Allocator,
        worklist: *std.ArrayList(WorkItem),
        inflight: *std.AutoHashMap(usize, void),
    ) !void {
        const substrate = self.scheduler.runtime.substrate;
        for (substrate.messages.items, 0..) |*message, index| {
            if (message.status != .queued) continue;
            if (inflight.contains(index)) continue;
            var ref: []const u8 = undefined;
            var caps: caps_mod.Caps = undefined;
            var read_ids: []const []const u8 = &.{};
            if (std.mem.startsWith(u8, message.to, "neuron/")) {
                ref = message.to["neuron/".len..];
                if (!self.scheduler.registry.contains(ref)) continue;
                // A neuron parked on a conversation takes its own reply and
                // nothing else: other traffic stays queued until it unparks,
                // so an unrelated message cannot silently discard the park.
                if (self.waiters.get(ref)) |waiter| {
                    if (waiter.awaitedCorrelation()) |awaited| {
                        if (!std.mem.eql(u8, awaited, message.correlation)) continue;
                        _ = self.waiters.remove(ref);
                    }
                }
                caps = self.attached.get(ref) orelse self.default_caps;
            } else if (std.mem.startsWith(u8, message.to, "event/")) {
                const route = self.findEventRoute(message.schema) orelse continue;
                ref = route.ref;
                if (!self.scheduler.registry.contains(ref)) continue;
                caps = route.caps;
                read_ids = route.read_ids;
            } else continue;

            const envelope = try allocator.alloc(types.Message, 1);
            envelope[0] = .{
                .to = message.to,
                .schema = message.schema,
                .payload = message.payload,
                .durable = message.durable,
                // The attested envelope travels with the message: this is what
                // lets the recipient answer without knowing the sender in
                // advance, and what the valve checks a reply against.
                .from = message.from,
                .correlation = message.correlation,
                .reply_to = message.reply_to,
                .turn = message.turn,
            };
            var permitted: std.ArrayList([]const u8) = .empty;
            var reads: std.ArrayList(types.ArtifactRef) = .empty;
            for (read_ids) |id| {
                const artifact = substrate.artifacts.get(id) orelse continue;
                try permitted.append(allocator, id);
                try reads.append(allocator, .{ .id = id, .digest = artifact.digest });
            }
            const depth: u8 = if (substrate.neurons.get(ref)) |spawned| spawned.depth else 0;
            try worklist.append(allocator, .{
                .ref = ref,
                .stimulus = .{
                    .firing_id = try self.firingId(),
                    .receptor_schema = message.schema,
                    .self_ref = try self.selfRef(ref),
                    .permitted_reads = permitted.items,
                    .reads = reads.items,
                    .messages = envelope,
                    .depth = depth,
                },
                .caps = caps,
                .source_message_index = index,
            });
            try inflight.put(index, {});
        }
    }

    /// The address a firing is stamped with and answered on. Every neuron the
    /// pump dispatches is addressable, so any message it sends can be replied
    /// to — bidirectionality is a property of the network, not an opt-in.
    fn selfRef(self: *Pump, ref: []const u8) ![]const u8 {
        return std.fmt.allocPrint(self.arena.allocator(), "neuron/{s}", .{ref});
    }

    fn findEventRoute(self: *const Pump, schema: []const u8) ?EventRoute {
        for (self.event_routes.items) |route| {
            if (std.mem.eql(u8, route.schema, schema)) return route;
        }
        return null;
    }

    fn acknowledgeMessage(self: *Pump, index: usize) !void {
        const substrate = self.scheduler.runtime.substrate;
        if (index >= substrate.messages.items.len) return error.MessageIndexInvalid;
        const message = &substrate.messages.items[index];
        const attempts = message.attempts +| 1;
        try substrate.journalDelivery(index, .acknowledged, attempts);
        message.attempts = attempts;
        message.status = .acknowledged;
    }

    fn firingId(self: *Pump) ![]const u8 {
        self.counter += 1;
        return std.fmt.allocPrint(self.arena.allocator(), "{s}/{d}", .{ self.firing_prefix, self.counter });
    }
};
