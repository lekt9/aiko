const std = @import("std");
const types = @import("types.zig");
const caps_mod = @import("caps.zig");
const runtime_mod = @import("runtime.zig");
const neuron_mod = @import("neuron.zig");

const Allocator = std.mem.Allocator;
const Caps = caps_mod.Caps;
const Stimulus = types.Stimulus;

/// Bumped whenever the interpreter semantics change; part of every key (§25).
pub const interpreter_version = "neuron-kernel/0.2.0";

pub const Entry = struct {
    decision_digest: types.Digest,
    effects_committed: usize,
    /// Digests of the exact read-set, retained so garbage collection can
    /// preserve anything an admitted cache entry still points at (§22/§25).
    read_digests: []types.Digest,
};

/// The complete cache key: neuron identity and code version, canonical
/// stimulus (clock, deadline, depth, recorded randomness, permitted and
/// pinned reads, delivered messages), capability fingerprint, adapter
/// version, and interpreter version (§25).
pub fn key(
    neuron: neuron_mod.Neuron,
    stimulus: Stimulus,
    caps: Caps,
    adapter_version: []const u8,
) types.Digest {
    var hash = std.crypto.hash.sha2.Sha256.init(.{});
    hashField(&hash, neuron.identity);
    hashField(&hash, neuron.version);
    hash.update(&runtime_mod.stimulusDigest(stimulus));
    hash.update(&caps_mod.fingerprint(caps));
    hashField(&hash, adapter_version);
    hashField(&hash, interpreter_version);
    var out: types.Digest = undefined;
    hash.final(&out);
    return out;
}

/// Docker-style layer cache for firings. A hit returns the recorded decision
/// identity without re-executing the neuron and — critically — without
/// replaying any external effect (§14/§25).
pub const Cache = struct {
    allocator: Allocator,
    entries: std.AutoHashMap(types.Digest, Entry),

    pub fn init(allocator: Allocator) Cache {
        return .{
            .allocator = allocator,
            .entries = std.AutoHashMap(types.Digest, Entry).init(allocator),
        };
    }

    pub fn deinit(self: *Cache) void {
        var iterator = self.entries.valueIterator();
        while (iterator.next()) |entry| self.allocator.free(entry.read_digests);
        self.entries.deinit();
    }

    pub fn lookup(self: *const Cache, cache_key: types.Digest) ?Entry {
        return self.entries.get(cache_key);
    }

    pub fn record(
        self: *Cache,
        cache_key: types.Digest,
        result: runtime_mod.CommitResult,
        stimulus: Stimulus,
    ) !void {
        if (self.entries.contains(cache_key)) return;
        const read_digests = try self.allocator.alloc(types.Digest, stimulus.reads.len);
        errdefer self.allocator.free(read_digests);
        for (stimulus.reads, 0..) |read, index| read_digests[index] = read.digest;
        try self.entries.put(cache_key, .{
            .decision_digest = result.decision_digest,
            .effects_committed = result.effects_committed,
            .read_digests = read_digests,
        });
    }

    pub fn count(self: *const Cache) usize {
        return self.entries.count();
    }
};

/// Fire through the cache: a hit replays the decision identity with zero
/// effects committed; a miss executes, commits, and records (§25).
pub fn fireCached(
    runtime: runtime_mod.Runtime,
    cache: *Cache,
    neuron: neuron_mod.Neuron,
    stimulus: Stimulus,
    caps: Caps,
    adapter_version: []const u8,
) !runtime_mod.CommitResult {
    const cache_key = key(neuron, stimulus, caps, adapter_version);
    if (cache.lookup(cache_key)) |entry| {
        return .{
            .effects_committed = 0,
            .duplicates_skipped = entry.effects_committed,
            .decision_digest = entry.decision_digest,
        };
    }
    const result = try runtime.fire(neuron, stimulus, caps);
    try cache.record(cache_key, result, stimulus);
    return result;
}

fn hashField(hash: *std.crypto.hash.sha2.Sha256, bytes: []const u8) void {
    hash.update(std.mem.asBytes(&bytes.len));
    hash.update(bytes);
}

test "cache key changes for code stimulus reads caps adapter clock and randomness" {
    const testing = std.testing;
    const neuron: neuron_mod.Neuron = .{
        .context = undefined,
        .identity = "worker/a",
        .version = "1",
        .fire_fn = struct {
            fn fire(_: *const anyopaque, _: Stimulus, _: Caps) anyerror!types.Decision {
                unreachable;
            }
        }.fire,
    };
    const ids = [_][]const u8{"artifact/source"};
    const reads = [_]types.ArtifactRef{.{ .id = "artifact/source", .digest = types.digest("truth") }};
    const base: Stimulus = .{
        .firing_id = "fire-cache",
        .receptor_schema = "test/v1",
        .permitted_reads = &ids,
        .reads = &reads,
        .now_ms = 7,
        .random = types.digest("seed-1"),
    };
    const caps: Caps = .{ .allow_write = true, .write_prefix = "artifact/" };
    const base_key = key(neuron, base, caps, "adapter/1");

    var other = base;
    other.now_ms = 8; // recorded clock
    try testing.expect(!std.mem.eql(u8, &base_key, &key(neuron, other, caps, "adapter/1")));
    other = base;
    other.random = types.digest("seed-2"); // recorded randomness
    try testing.expect(!std.mem.eql(u8, &base_key, &key(neuron, other, caps, "adapter/1")));
    other = base;
    other.depth = 1; // spawn depth
    try testing.expect(!std.mem.eql(u8, &base_key, &key(neuron, other, caps, "adapter/1")));
    other = base;
    other.receptor_schema = "test/v2"; // schema version
    try testing.expect(!std.mem.eql(u8, &base_key, &key(neuron, other, caps, "adapter/1")));

    const stale_reads = [_]types.ArtifactRef{.{ .id = "artifact/source", .digest = types.digest("moved") }};
    other = base;
    other.reads = &stale_reads; // read-set digest
    try testing.expect(!std.mem.eql(u8, &base_key, &key(neuron, other, caps, "adapter/1")));

    var other_caps = caps;
    other_caps.budget.max_writes = 1; // capability fingerprint
    try testing.expect(!std.mem.eql(u8, &base_key, &key(neuron, base, other_caps, "adapter/1")));
    try testing.expect(!std.mem.eql(u8, &base_key, &key(neuron, base, caps, "adapter/2"))); // adapter version

    var other_neuron = neuron;
    other_neuron.version = "2"; // code version
    try testing.expect(!std.mem.eql(u8, &base_key, &key(other_neuron, base, caps, "adapter/1")));
    other_neuron = neuron;
    other_neuron.identity = "worker/b"; // code identity
    try testing.expect(!std.mem.eql(u8, &base_key, &key(other_neuron, base, caps, "adapter/1")));
}
