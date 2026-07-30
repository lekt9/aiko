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

const Pending = substrate_mod.Pending;

pub const Runtime = struct {
    substrate: *Substrate,
    /// When enabled, every ordinary committed firing atomically appends a
    /// durable lifecycle event to the same WAL record as its declared
    /// effects. Observation firings themselves are excluded so subscribing
    /// to the event cannot create an evidence-free reflex loop.
    emit_settlement_events: bool = false,

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
        try stage(self.substrate.allocator, stimulus, decision.effects, &pending);
        if (self.emit_settlement_events and
            !std.mem.eql(u8, stimulus.receptor_schema, "neuron.firing-settled/v1"))
        {
            try stageSettlementEvent(
                self.substrate.allocator,
                stimulus.firing_id,
                identity,
                decision.effects.len,
                &pending,
            );
        }

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
        // WAL: the commit record hits the journal BEFORE the in-memory maps
        // change. A failed append commits nothing anywhere; replay rebuilds
        // exactly what the log holds (§20 commit boundary, §22).
        try self.substrate.journalCommit(
            stimulus.firing_id,
            identity,
            decision.effects.len,
            pending.items,
            stimulus.now_ms,
            decision.evidence,
        );
        const firing_key = try self.substrate.allocator.dupe(u8, stimulus.firing_id);
        errdefer self.substrate.allocator.free(firing_key);
        // Retained so compaction can carry the derivation graph past the point
        // where per-commit records are folded away (§28.4). Duplicated *here*,
        // above the infallible section, because a failed allocation must leave
        // the substrate untouched.
        const retained_evidence = try substrate_mod.dupeEvidence(self.substrate.allocator, decision.evidence);
        errdefer {
            for (retained_evidence) |item| item.deinit(self.substrate.allocator);
            self.substrate.allocator.free(retained_evidence);
        }

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
        const seq = self.substrate.next_firing_seq;
        self.substrate.next_firing_seq = seq + 1;
        self.substrate.firings.putAssumeCapacity(firing_key, .{
            .decision_digest = identity,
            .effects_committed = decision.effects.len,
            .status = .committed,
            .seq = seq,
            .evidence = retained_evidence,
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
        try self.substrate.journalFiring(firing_id, types.digest("cancelled"), .cancelled);
        try self.substrate.firings.put(owned, .{
            .decision_digest = types.digest("cancelled"),
            .effects_committed = 0,
            .status = .cancelled,
        });
    }

    fn recordFailure(self: Runtime, firing_id: []const u8, identity: types.Digest, status: substrate_mod.FiringStatus) void {
        if (firing_id.len == 0 or self.substrate.firings.contains(firing_id)) return;
        // Memory mirrors the log: if the settlement cannot be journaled it
        // is not recorded here either.
        self.substrate.journalFiring(firing_id, identity, status) catch return;
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

fn stage(allocator: Allocator, stimulus: Stimulus, effects: []const Effect, pending: *std.ArrayList(Pending)) !void {
    const firing_id = stimulus.firing_id;
    const depth = stimulus.depth;
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
            // Stamp the attested envelope: the sender is this firing's own
            // address, the return address is the same, and the turn advances
            // from the request being answered (1 when this opens a
            // conversation). A neuron cannot influence any of the three.
            .send => |message| blk: {
                const correlated = message.correlation.len > 0;
                const turn: u8 = if (answeredRequest(stimulus, message)) |request|
                    request.turn + 1
                else if (correlated) 1 else 0;
                break :blk .{ .send = .{
                    .firing_id = try allocator.dupe(u8, firing_id),
                    .to = try allocator.dupe(u8, message.to),
                    .schema = try allocator.dupe(u8, message.schema),
                    .payload = try allocator.dupe(u8, message.payload),
                    .durable = message.durable,
                    .from = try allocator.dupe(u8, stimulus.self_ref),
                    .correlation = try allocator.dupe(u8, message.correlation),
                    .reply_to = try allocator.dupe(u8, if (correlated) stimulus.self_ref else ""),
                    .turn = turn,
                } };
            },
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

fn stageSettlementEvent(
    allocator: Allocator,
    firing_id: []const u8,
    decision_digest: types.Digest,
    effects_committed: usize,
    pending: *std.ArrayList(Pending),
) !void {
    const digest_hex = std.fmt.bytesToHex(decision_digest, .lower);
    const payload = try std.json.Stringify.valueAlloc(allocator, .{
        .schema = "neuron.firing-settled/v1",
        .firing_id = firing_id,
        .decision_digest = digest_hex[0..],
        .effects_committed = effects_committed,
        .status = "committed",
    }, .{});
    errdefer allocator.free(payload);
    const owned_firing = try allocator.dupe(u8, firing_id);
    errdefer allocator.free(owned_firing);
    const to = try allocator.dupe(u8, "event/neuron.firing-settled/v1");
    errdefer allocator.free(to);
    const schema = try allocator.dupe(u8, "neuron.firing-settled/v1");
    errdefer allocator.free(schema);
    // A lifecycle event is an announcement, not a conversation: it is
    // uncorrelated, so no observer gains reply authority over the firing.
    try pending.append(allocator, .{ .send = .{
        .firing_id = owned_firing,
        .to = to,
        .schema = schema,
        .payload = payload,
        .durable = true,
        .from = try allocator.dupe(u8, "runtime"),
        .correlation = try allocator.dupe(u8, ""),
        .reply_to = try allocator.dupe(u8, ""),
        .turn = 0,
    } });
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
    for (decision.effects, 0..) |effect, index| switch (effect) {
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
            if (message.to.len == 0 or message.schema.len == 0) return error.InvalidEffect;
            // Provenance is interpreter-owned. A neuron that presents its own
            // sender, return address, or turn count is claiming authority it
            // cannot verify about itself (§20).
            if (message.from.len != 0 or message.reply_to.len != 0 or message.turn != 0)
                return error.ForgedSender;
            if (message.correlation.len != 0 and stimulus.self_ref.len == 0)
                return error.UnaddressableSender;
            if (answeredRequest(stimulus, message)) |request| {
                // Reply authority is conferred by possession of the request:
                // it reaches exactly the attested requester on exactly that
                // correlation, so it can never widen to a third party and
                // needs no prearranged send grant. Everything else about the
                // effect — budget, bytes, evidence — is unchanged.
                if (request.turn >= caps.budget.max_turns) return error.ConversationTurnsExceeded;
                if (priorReplies(decision.effects, index, message) > 0) return error.DuplicateReply;
            } else if (!caps.allow_send or !std.mem.startsWith(u8, message.to, caps.send_prefix)) {
                return error.CapabilityDenied;
            }
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

/// The inbound request a send answers, if any: an outgoing message is a reply
/// exactly when it targets the return address of a request pinned into this
/// firing's own stimulus, on that request's correlation. The stimulus is
/// covered by the firing identity, so this authority cannot be fabricated
/// after the fact (§20/§23 — the same grounding rule evidence obeys).
pub fn answeredRequest(stimulus: Stimulus, message: types.Message) ?types.Message {
    if (message.correlation.len == 0) return null;
    for (stimulus.messages) |inbound| {
        if (inbound.reply_to.len == 0 or inbound.correlation.len == 0) continue;
        if (!std.mem.eql(u8, inbound.reply_to, message.to)) continue;
        if (!std.mem.eql(u8, inbound.correlation, message.correlation)) continue;
        return inbound;
    }
    return null;
}

/// How many earlier effects in the same decision already answer this exact
/// conversation. One firing settles a conversation turn once.
fn priorReplies(effects: []const Effect, index: usize, message: types.Message) usize {
    var count: usize = 0;
    for (effects[0..index]) |earlier| switch (earlier) {
        .send => |prior| {
            if (std.mem.eql(u8, prior.correlation, message.correlation) and
                std.mem.eql(u8, prior.to, message.to)) count += 1;
        },
        else => {},
    };
    return count;
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
