const std = @import("std");
const types = @import("types.zig");
const caps_mod = @import("caps.zig");
const substrate_mod = @import("substrate.zig");
const cache_mod = @import("cache.zig");

/// A join fires only when its declared quorum is satisfied by the typed
/// messages delivered in its stimulus; until then it suspends on a wait
/// predicate. Duplicate deliveries are counted once by payload identity,
/// honoring the declared duplicate policy (§26).
pub const JoinNeuron = struct {
    schema: []const u8,
    quorum: usize,

    pub fn fire(self: *const JoinNeuron, stimulus: types.Stimulus, _: caps_mod.Caps) !types.Decision {
        if (self.schema.len == 0 or self.quorum == 0) return error.InvalidJoin;
        var seen: usize = 0;
        for (stimulus.messages, 0..) |message, index| {
            if (!std.mem.eql(u8, message.schema, self.schema)) continue;
            var duplicate = false;
            for (stimulus.messages[0..index]) |prior| {
                if (std.mem.eql(u8, prior.schema, message.schema) and
                    std.mem.eql(u8, prior.payload, message.payload))
                {
                    duplicate = true;
                    break;
                }
            }
            if (!duplicate) seen += 1;
        }
        const source = [_][]const u8{"stimulus"};
        const evidence = [_]types.Evidence{.{
            .claim = "join quorum evaluated against delivered messages",
            .sources = &source,
            .method = "quorum count over stimulus.messages",
        }};
        if (seen >= self.quorum) {
            return .{ .control = .{ .terminate = "quorum-reached" }, .evidence = &evidence };
        }
        return .{ .control = .{ .continue_wait = self.schema }, .evidence = &evidence };
    }
};

/// Collects artifacts not reachable from a retention root or an admitted
/// cache entry's recorded read-set (§22). Returns the number collected.
pub fn gc(
    substrate: *substrate_mod.Substrate,
    roots: []const []const u8,
    cache: ?*const cache_mod.Cache,
) !usize {
    const allocator = substrate.allocator;
    var garbage: std.ArrayList([]const u8) = .empty;
    defer garbage.deinit(allocator);
    var iterator = substrate.artifacts.iterator();
    while (iterator.next()) |entry| {
        if (rooted(roots, entry.key_ptr.*)) continue;
        if (cache) |live| {
            if (cacheRetains(live, entry.value_ptr.digest)) continue;
        }
        try garbage.append(allocator, entry.key_ptr.*);
    }
    for (garbage.items) |id| {
        const entry = substrate.artifacts.fetchRemove(id) orelse continue;
        allocator.free(entry.key);
        allocator.free(entry.value.schema);
        allocator.free(entry.value.bytes);
        allocator.free(entry.value.produced_by);
    }
    return garbage.items.len;
}

fn rooted(roots: []const []const u8, id: []const u8) bool {
    for (roots) |root| if (std.mem.eql(u8, root, id)) return true;
    return false;
}

fn cacheRetains(cache: *const cache_mod.Cache, digest: types.Digest) bool {
    var entries = cache.entries.valueIterator();
    while (entries.next()) |entry| {
        for (entry.read_digests) |read| {
            if (std.mem.eql(u8, &read, &digest)) return true;
        }
    }
    return false;
}
