const std = @import("std");
const types = @import("types.zig");

const Allocator = std.mem.Allocator;

pub const OwnedArtifact = struct {
    schema: []u8,
    bytes: []u8,
    digest: types.Digest,
    produced_by: []u8,
};

pub const StoredMessage = struct {
    firing_id: []u8,
    to: []u8,
    schema: []u8,
    payload: []u8,
    durable: bool,
    status: DeliveryStatus = .queued,
    attempts: u8 = 0,
    max_attempts: u8 = 3,

    pub fn deinit(self: StoredMessage, allocator: Allocator) void {
        allocator.free(self.firing_id);
        allocator.free(self.to);
        allocator.free(self.schema);
        allocator.free(self.payload);
    }
};

pub const DeliveryStatus = enum { queued, acknowledged, dead_letter, reconciliation_required };

const caps_mod = @import("caps.zig");

/// An owned copy of a delegated grant, recorded at the commit boundary so a
/// spawned neuron can later be attached with exactly this authority — never
/// more (§24). `null` on the parent record means deny-all.
pub const OwnedCaps = struct {
    allow_write: bool,
    allow_send: bool,
    allow_spawn: bool,
    write_prefix: []u8,
    send_prefix: []u8,
    spawn_prefix: []u8,
    budget: caps_mod.Budget,

    /// Borrows the owned prefixes; valid while the record lives.
    pub fn toCaps(self: *const OwnedCaps) caps_mod.Caps {
        return .{
            .allow_write = self.allow_write,
            .allow_send = self.allow_send,
            .allow_spawn = self.allow_spawn,
            .write_prefix = self.write_prefix,
            .send_prefix = self.send_prefix,
            .spawn_prefix = self.spawn_prefix,
            .budget = self.budget,
        };
    }

    pub fn deinit(self: OwnedCaps, allocator: Allocator) void {
        allocator.free(self.write_prefix);
        allocator.free(self.send_prefix);
        allocator.free(self.spawn_prefix);
    }
};

pub const SpawnedNeuron = struct {
    firing_id: []u8,
    kind: []u8,
    /// Generation of this neuron within its workflow (parent depth + 1, §26).
    depth: u8,
    /// Fingerprint of the authority actually delegated to the child. A spawn
    /// with no explicit grant records the deny-all fingerprint (§24).
    caps_digest: types.Digest,
    /// The delegated grant itself, kept so the harness can attach the neuron
    /// later with precisely this authority.
    grant: ?OwnedCaps,

    pub fn deinit(self: SpawnedNeuron, allocator: Allocator) void {
        allocator.free(self.firing_id);
        allocator.free(self.kind);
        if (self.grant) |grant| grant.deinit(allocator);
    }
};

pub const FiringStatus = enum { committed, rejected, failed, timed_out, cancelled };

pub const FiringRecord = struct {
    decision_digest: types.Digest,
    effects_committed: usize,
    status: FiringStatus,
};

pub const Substrate = struct {
    allocator: Allocator,
    artifacts: std.StringHashMap(OwnedArtifact),
    messages: std.ArrayList(StoredMessage) = .empty,
    neurons: std.StringHashMap(SpawnedNeuron),
    firings: std.StringHashMap(FiringRecord),

    pub fn init(allocator: Allocator) Substrate {
        return .{
            .allocator = allocator,
            .artifacts = std.StringHashMap(OwnedArtifact).init(allocator),
            .neurons = std.StringHashMap(SpawnedNeuron).init(allocator),
            .firings = std.StringHashMap(FiringRecord).init(allocator),
        };
    }

    pub fn deinit(self: *Substrate) void {
        var firing_it = self.firings.keyIterator();
        while (firing_it.next()) |key| self.allocator.free(key.*);
        self.firings.deinit();

        var neuron_it = self.neurons.iterator();
        while (neuron_it.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
            entry.value_ptr.deinit(self.allocator);
        }
        self.neurons.deinit();

        for (self.messages.items) |message| message.deinit(self.allocator);
        self.messages.deinit(self.allocator);

        var artifact_it = self.artifacts.iterator();
        while (artifact_it.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
            self.allocator.free(entry.value_ptr.schema);
            self.allocator.free(entry.value_ptr.bytes);
            self.allocator.free(entry.value_ptr.produced_by);
        }
        self.artifacts.deinit();
    }
};
