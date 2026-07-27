const std = @import("std");
const types = @import("types.zig");
const cap_mod = @import("caps.zig");
const substrate_mod = @import("substrate.zig");
const neuron_mod = @import("neuron.zig");

const Allocator = std.mem.Allocator;
const Caps = cap_mod.Caps;
const Decision = types.Decision;
const Effect = types.Effect;
const Stimulus = types.Stimulus;
const Substrate = substrate_mod.Substrate;

pub const CommitResult = struct {
    effects_committed: usize,
    duplicates_skipped: usize,
    decision_digest: types.Digest,
};

const Pending = union(enum) {
    write: struct { id: []u8, schema: []u8, bytes: []u8, digest: types.Digest, produced_by: []u8 },
    send: substrate_mod.StoredMessage,
    spawn: struct { id: []u8, value: substrate_mod.SpawnedNeuron },

    fn deinit(self: Pending, allocator: Allocator) void {
        switch (self) {
            .write => |write| {
                allocator.free(write.id);
                allocator.free(write.schema);
                allocator.free(write.bytes);
                allocator.free(write.produced_by);
            },
            .send => |message| message.deinit(allocator),
            .spawn => |spawn| {
                allocator.free(spawn.id);
                spawn.value.deinit(allocator);
            },
        }
    }
};

pub const Runtime = struct {
    substrate: *Substrate,

    pub fn fire(self: Runtime, neuron: neuron_mod.Neuron, stimulus: Stimulus, caps: Caps) !CommitResult {
        const decision = neuron.fire(stimulus, caps) catch |err| {
            // A firing that dies to its own deadline settles typed as
            // timed_out (§27): observable via metrics, never silent.
            if (err == error.ScriptTimeout or err == error.DeadlineExceeded) {
                self.recordFailure(stimulus.firing_id, types.digest(@errorName(err)), .timed_out);
            }
            return err;
        };
        return self.execute(stimulus, caps, decision);
    }

    pub fn execute(self: Runtime, stimulus: Stimulus, caps: Caps, decision: Decision) !CommitResult {
        const identity = runtimeDecisionDigest(stimulus, caps, decision);
        // At-least-once delivery (§21): settle duplicates by firing identity
        // BEFORE validating against current substrate state. A redelivered
        // firing must not be re-validated against artifacts its own first
        // delivery committed — that would misreport the duplicate as a CAS
        // conflict and reject it.
        if (self.substrate.firings.get(stimulus.firing_id)) |prior| {
            if (prior.status != .committed) return error.FiringAlreadySettled;
            if (!std.mem.eql(u8, &identity, &prior.decision_digest)) return error.FiringMismatch;
            return .{
                .effects_committed = 0,
                .duplicates_skipped = prior.effects_committed,
                .decision_digest = identity,
            };
        }
        validate(stimulus, caps, decision, self.substrate) catch |err| {
            self.recordFailure(stimulus.firing_id, identity, if (err == error.DeadlineExceeded) .timed_out else .rejected);
            return err;
        };

        var pending: std.ArrayList(Pending) = .empty;
        defer pending.deinit(self.substrate.allocator);
        errdefer for (pending.items) |item| item.deinit(self.substrate.allocator);
        try stage(self.substrate.allocator, stimulus.firing_id, stimulus.depth, decision.effects, &pending);

        var writes: usize = 0;
        var sends: usize = 0;
        var spawns: usize = 0;
        for (pending.items) |item| switch (item) {
            .write => writes += 1,
            .send => sends += 1,
            .spawn => spawns += 1,
        };
        try self.substrate.artifacts.ensureUnusedCapacity(@intCast(writes));
        try self.substrate.messages.ensureUnusedCapacity(self.substrate.allocator, sends);
        try self.substrate.neurons.ensureUnusedCapacity(@intCast(spawns));
        try self.substrate.firings.ensureUnusedCapacity(1);
        const firing_key = try self.substrate.allocator.dupe(u8, stimulus.firing_id);
        errdefer self.substrate.allocator.free(firing_key);

        // From here through the firing record insertion, all allocations are
        // complete. The commit path is infallible and therefore atomic in-memory.
        for (pending.items) |item| switch (item) {
            .write => |write| {
                const old = self.substrate.artifacts.fetchPutAssumeCapacity(write.id, .{
                    .schema = write.schema,
                    .bytes = write.bytes,
                    .digest = write.digest,
                    .produced_by = write.produced_by,
                });
                if (old) |prior| {
                    // HashMap retains the existing key when replacing a value.
                    self.substrate.allocator.free(write.id);
                    self.substrate.allocator.free(prior.value.schema);
                    self.substrate.allocator.free(prior.value.bytes);
                    self.substrate.allocator.free(prior.value.produced_by);
                }
            },
            .send => |message| self.substrate.messages.appendAssumeCapacity(message),
            .spawn => |spawn| self.substrate.neurons.putAssumeCapacity(spawn.id, spawn.value),
        };
        self.substrate.firings.putAssumeCapacity(firing_key, .{
            .decision_digest = identity,
            .effects_committed = decision.effects.len,
            .status = .committed,
        });
        pending.clearRetainingCapacity(); // ownership moved into the substrate
        return .{
            .effects_committed = decision.effects.len,
            .duplicates_skipped = 0,
            .decision_digest = identity,
        };
    }

    pub fn cancel(self: Runtime, firing_id: []const u8) !void {
        if (firing_id.len == 0) return error.InvalidFiringId;
        if (self.substrate.firings.contains(firing_id)) return error.FiringAlreadySettled;
        const owned = try self.substrate.allocator.dupe(u8, firing_id);
        errdefer self.substrate.allocator.free(owned);
        try self.substrate.firings.put(owned, .{
            .decision_digest = types.digest("cancelled"),
            .effects_committed = 0,
            .status = .cancelled,
        });
    }

    fn recordFailure(self: Runtime, firing_id: []const u8, identity: types.Digest, status: substrate_mod.FiringStatus) void {
        if (firing_id.len == 0 or self.substrate.firings.contains(firing_id)) return;
        const owned = self.substrate.allocator.dupe(u8, firing_id) catch return;
        self.substrate.firings.put(owned, .{
            .decision_digest = identity,
            .effects_committed = 0,
            .status = status,
        }) catch {
            self.substrate.allocator.free(owned);
        };
    }
};

fn dupeGrant(allocator: Allocator, grant: Caps) !substrate_mod.OwnedCaps {
    const write_prefix = try allocator.dupe(u8, grant.write_prefix);
    errdefer allocator.free(write_prefix);
    const send_prefix = try allocator.dupe(u8, grant.send_prefix);
    errdefer allocator.free(send_prefix);
    const spawn_prefix = try allocator.dupe(u8, grant.spawn_prefix);
    errdefer allocator.free(spawn_prefix);
    return .{
        .allow_write = grant.allow_write,
        .allow_send = grant.allow_send,
        .allow_spawn = grant.allow_spawn,
        .write_prefix = write_prefix,
        .send_prefix = send_prefix,
        .spawn_prefix = spawn_prefix,
        .budget = grant.budget,
    };
}

fn stage(allocator: Allocator, firing_id: []const u8, depth: u8, effects: []const Effect, pending: *std.ArrayList(Pending)) !void {
    try pending.ensureTotalCapacity(allocator, effects.len);
    for (effects) |effect| {
        const item: Pending = switch (effect) {
            .write => |write| .{ .write = .{
                .id = try allocator.dupe(u8, write.id),
                .schema = try allocator.dupe(u8, write.schema),
                .bytes = try allocator.dupe(u8, write.bytes),
                .digest = types.digest(write.bytes),
                .produced_by = try allocator.dupe(u8, firing_id),
            } },
            .send => |message| .{ .send = .{
                .firing_id = try allocator.dupe(u8, firing_id),
                .to = try allocator.dupe(u8, message.to),
                .schema = try allocator.dupe(u8, message.schema),
                .payload = try allocator.dupe(u8, message.payload),
                .durable = message.durable,
            } },
            .spawn => |spawn| .{
                .spawn = .{
                    .id = try allocator.dupe(u8, spawn.id),
                    .value = .{
                        .firing_id = try allocator.dupe(u8, firing_id),
                        .kind = try allocator.dupe(u8, spawn.kind),
                        // Children fire one generation deeper than their parent.
                        .depth = depth + 1,
                        .caps_digest = cap_mod.fingerprint(spawn.grant orelse cap_mod.Caps{}),
                        .grant = if (spawn.grant) |grant| try dupeGrant(allocator, grant) else null,
                    },
                },
            },
        };
        pending.appendAssumeCapacity(item);
    }
}

fn validate(stimulus: Stimulus, caps: Caps, decision: Decision, substrate: *const Substrate) !void {
    if (stimulus.firing_id.len == 0) return error.InvalidFiringId;
    if (stimulus.receptor_schema.len == 0) return error.InvalidSchema;
    if (stimulus.deadline_ms) |deadline| if (stimulus.now_ms >= deadline) return error.DeadlineExceeded;
    // Admission-time read authorization: every declared read must be inside
    // the permitted read set, and the firing must be within its depth budget.
    if (stimulus.depth > caps.budget.max_depth) return error.BudgetExceeded;
    for (stimulus.reads) |read| {
        if (!contains(stimulus.permitted_reads, read.id)) return error.ReadDenied;
    }
    if (decision.evidence.len == 0) return error.MissingEvidence;
    if (decision.effects.len > caps.budget.max_effects) return error.BudgetExceeded;
    for (decision.evidence) |evidence| {
        if (evidence.claim.len == 0 or evidence.method.len == 0) return error.InvalidEvidence;
        for (evidence.sources) |source| {
            if (!groundedRead(stimulus, substrate, source) and !std.mem.eql(u8, source, "stimulus"))
                return error.UngroundedEvidence;
        }
    }

    var writes: usize = 0;
    var sends: usize = 0;
    var spawns: usize = 0;
    var bytes: usize = 0;
    for (decision.effects) |effect| switch (effect) {
        .write => |write| {
            if (!caps.allow_write or !std.mem.startsWith(u8, write.id, caps.write_prefix))
                return error.CapabilityDenied;
            if (write.id.len == 0 or write.schema.len == 0) return error.InvalidEffect;
            if (substrate.artifacts.get(write.id)) |prior| {
                if (write.expected_prior == null or
                    !std.mem.eql(u8, &write.expected_prior.?, &prior.digest)) return error.Conflict;
            } else if (write.expected_prior != null) return error.Conflict;
            writes += 1;
            bytes = std.math.add(usize, bytes, write.bytes.len) catch return error.BudgetExceeded;
        },
        .send => |message| {
            if (!caps.allow_send or !std.mem.startsWith(u8, message.to, caps.send_prefix))
                return error.CapabilityDenied;
            if (message.to.len == 0 or message.schema.len == 0) return error.InvalidEffect;
            sends += 1;
            bytes = std.math.add(usize, bytes, message.payload.len) catch return error.BudgetExceeded;
        },
        .spawn => |spawn| {
            if (!caps.allow_spawn or !std.mem.startsWith(u8, spawn.id, caps.spawn_prefix))
                return error.CapabilityDenied;
            if (spawn.id.len == 0 or spawn.kind.len == 0 or substrate.neurons.contains(spawn.id))
                return error.InvalidEffect;
            // Children would fire at depth + 1; spawning at the ceiling fails
            // closed, and a requested grant may only narrow the parent's (§24/§26).
            if (stimulus.depth >= caps.budget.max_depth) return error.SpawnDepthExceeded;
            if (spawn.grant) |grant| {
                if (!cap_mod.allowsDelegation(caps, grant)) return error.CapabilityDenied;
            }
            spawns += 1;
        },
    };
    if (writes > caps.budget.max_writes or sends > caps.budget.max_messages or
        spawns > caps.budget.max_spawns or bytes > caps.budget.max_bytes)
        return error.BudgetExceeded;
}

fn contains(items: []const []const u8, wanted: []const u8) bool {
    for (items) |item| if (std.mem.eql(u8, item, wanted)) return true;
    return false;
}

fn groundedRead(stimulus: Stimulus, substrate: *const Substrate, wanted: []const u8) bool {
    if (!contains(stimulus.permitted_reads, wanted)) return false;
    for (stimulus.reads) |read| {
        if (!std.mem.eql(u8, read.id, wanted)) continue;
        const artifact = substrate.artifacts.get(read.id) orelse return false;
        return std.mem.eql(u8, &artifact.digest, &read.digest);
    }
    return false;
}

pub const runtimeDecisionDigest = @import("typed_neuron").runtimeDecisionDigest;
pub const decisionDigest = runtimeDecisionDigest;
pub const stimulusDigest = @import("typed_neuron").runtimeStimulusDigest;
