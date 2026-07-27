const std = @import("std");
const types = @import("types.zig");
const caps_mod = @import("caps.zig");
const substrate_mod = @import("substrate.zig");
const runtime_mod = @import("runtime.zig");
const neuron_mod = @import("neuron.zig");
const script_mod = @import("script.zig");

const Allocator = std.mem.Allocator;

pub const Summary = struct {
    firing_id: []const u8,
    neuron_id: []const u8,
    effects_committed: usize,
    duplicates_skipped: usize,
    artifacts: usize,
    messages: usize,
    neurons: usize,
    digest: types.Digest,
    /// Narrow read surface over the post-commit substrate (§22): only
    /// populated when the caller passes --dump. Lets drivers compose
    /// firings (outbox draining, chained limbs) without a second authority.
    dump: ?*const substrate_mod.Substrate = null,
    /// Owns every allocation the summary (and dump) points into: parsed
    /// manifest/stimulus JSON, staged artifacts, and the substrate itself.
    arena: ?*std.heap.ArenaAllocator = null,

    /// Reclaim the whole firing in one shot. Call after printSummary; safe
    /// to call on a zero-value summary.
    pub fn deinit(self: *Summary, allocator: Allocator) void {
        if (self.arena) |arena| {
            arena.deinit();
            allocator.destroy(arena);
            self.arena = null;
            self.dump = null;
        }
    }
};

/// `neuron run` — fire one external script-neuron through the full harness
/// lifecycle (§20): authenticate the stimulus, pin every read against its
/// declared digest, stage the substrate, execute the untrusted script,
/// validate the decision (grounding, budgets, capability prefixes, CAS), and
/// commit atomically — or commit nothing.
///
///   neuron run --def <manifest.json> --neuron <id> --stimulus <file|-> [--json]
///
/// The manifest's per-neuron `caps_request` becomes the firing's immutable
/// grant; invoking this command is the local operator's capability approval
/// (§29 step 6 for local operation).
pub fn run(allocator: Allocator, io: std.Io, args: []const []const u8) !Summary {
    var def_path: ?[]const u8 = null;
    var neuron_id: ?[]const u8 = null;
    var stimulus_path: ?[]const u8 = null;
    var index: usize = 0;
    while (index < args.len) : (index += 1) {
        const arg = args[index];
        if (std.mem.eql(u8, arg, "--json") or std.mem.eql(u8, arg, "--dump")) continue;
        if (index + 1 >= args.len) return error.MissingArgumentValue;
        if (std.mem.eql(u8, arg, "--def")) {
            def_path = args[index + 1];
            index += 1;
        } else if (std.mem.eql(u8, arg, "--neuron")) {
            neuron_id = args[index + 1];
            index += 1;
        } else if (std.mem.eql(u8, arg, "--stimulus")) {
            stimulus_path = args[index + 1];
            index += 1;
        } else {
            return error.UnknownArgument;
        }
    }
    const manifest_path = def_path orelse return error.MissingDef;
    const wanted_id = neuron_id orelse return error.MissingNeuron;
    const stim_path = stimulus_path orelse return error.MissingStimulus;

    // One arena owns the firing end to end: parsed JSON, staged artifacts,
    // the substrate, and the strings Summary points into. Freed by
    // Summary.deinit after printSummary — no leak noise, no use-after-free.
    const arena = try allocator.create(std.heap.ArenaAllocator);
    errdefer allocator.destroy(arena);
    arena.* = std.heap.ArenaAllocator.init(allocator);
    errdefer arena.deinit();
    const a = arena.allocator();

    const cwd = std.Io.Dir.cwd();
    const manifest_bytes = try cwd.readFileAlloc(io, manifest_path, a, .limited(1 << 20));
    const manifest = try std.json.parseFromSliceLeaky(std.json.Value, a, manifest_bytes, .{});
    if (manifest != .object) return error.InvalidManifest;

    var argv: std.ArrayList([]const u8) = .empty;
    var caps: caps_mod.Caps = .{};
    const neurons = manifest.object.get("neurons") orelse return error.InvalidManifest;
    if (neurons != .array) return error.InvalidManifest;
    const manifest_dir = std.fs.path.dirname(manifest_path) orelse ".";
    var found = false;
    for (neurons.array.items) |entry| {
        if (entry != .object) continue;
        const id = jsonString(entry, "id") orelse continue;
        if (!std.mem.eql(u8, id, wanted_id)) continue;
        found = true;
        const argv_json = entry.object.get("argv") orelse return error.InvalidManifest;
        if (argv_json != .array) return error.InvalidManifest;
        for (argv_json.array.items) |item| {
            const part = switch (item) {
                .string => |str| str,
                else => return error.InvalidManifest,
            };
            // Resolve relative script paths against the manifest directory so
            // the firing works from any working directory.
            if (part.len > 0 and part[0] != '/' and std.mem.indexOfScalar(u8, part, '/') != null) {
                try argv.append(a, try std.fs.path.join(a, &.{ manifest_dir, part }));
            } else {
                try argv.append(a, part);
            }
        }
        if (entry.object.get("caps_request")) |requested| {
            caps = try script_mod.capsFromJson(requested);
        }
        break;
    }
    if (!found) return error.NeuronNotInManifest;
    if (argv.items.len == 0) return error.InvalidManifest;

    const stimulus_bytes = if (std.mem.eql(u8, stim_path, "-"))
        try readStdin(a, io)
    else
        try cwd.readFileAlloc(io, stim_path, a, .limited(1 << 20));
    const stimulus_json = try std.json.parseFromSliceLeaky(std.json.Value, a, stimulus_bytes, .{});
    if (stimulus_json != .object) return error.InvalidStimulus;

    var dump = false;
    for (args) |arg| {
        if (std.mem.eql(u8, arg, "--dump")) dump = true;
    }
    const substrate = try a.create(substrate_mod.Substrate);
    substrate.* = substrate_mod.Substrate.init(a);
    const stimulus = try stageStimulus(a, stimulus_json, substrate);

    var implementation: script_mod.ScriptNeuron = .{
        .allocator = a,
        .io = io,
        .argv = argv.items,
        .substrate = substrate,
    };
    // Manifest-level fallback deadline (budgets.deadline_ms_per_firing); a
    // stimulus deadline always wins over it (§20 step 4).
    if (manifest.object.get("budgets")) |budgets| {
        if (budgets == .object) {
            if (jsonInt(budgets, "deadline_ms_per_firing")) |ms| {
                if (ms > 0) implementation.default_timeout = .{ .duration = .{ .raw = .{
                    .nanoseconds = @as(i96, @intCast(ms)) * std.time.ns_per_ms,
                }, .clock = .boot } };
            }
        }
    }
    const version = jsonString(manifest.object.get("package") orelse return error.InvalidManifest, "version") orelse "0.0.0";
    const neuron = neuron_mod.bind(script_mod.ScriptNeuron, &implementation, wanted_id, version);
    const result = try (runtime_mod.Runtime{ .substrate = substrate }).fire(neuron, stimulus, caps);
    return .{
        .firing_id = stimulus.firing_id,
        .neuron_id = wanted_id,
        .effects_committed = result.effects_committed,
        .duplicates_skipped = result.duplicates_skipped,
        .artifacts = substrate.artifacts.count(),
        .messages = substrate.messages.items.len,
        .neurons = substrate.neurons.count(),
        .digest = result.decision_digest,
        .dump = if (dump) substrate else null,
        .arena = arena,
    };
}

/// Build the hard-typed Stimulus from JSON, staging every read's bytes into
/// the substrate only after verifying the declared digest — reads are
/// digest-pinned before the neuron ever sees them (§20 step 3).
pub fn stageStimulus(allocator: Allocator, root: std.json.Value, substrate: *substrate_mod.Substrate) !types.Stimulus {
    const schema = jsonString(root, "schema") orelse return error.InvalidStimulus;
    if (!std.mem.eql(u8, schema, "neuron.stimulus/v1")) return error.InvalidStimulus;

    var stimulus: types.Stimulus = .{
        .firing_id = jsonString(root, "firing_id") orelse return error.InvalidStimulus,
        .receptor_schema = jsonString(root, "receptor_schema") orelse return error.InvalidStimulus,
    };
    if (jsonInt(root, "now_ms")) |v| stimulus.now_ms = @intCast(v);
    if (root.object.get("deadline_ms")) |v| {
        if (v == .integer) stimulus.deadline_ms = @intCast(v.integer);
    }
    if (jsonInt(root, "depth")) |v| stimulus.depth = @intCast(v);

    var permitted: std.ArrayList([]const u8) = .empty;
    if (root.object.get("permitted_reads")) |value| {
        if (value != .array) return error.InvalidStimulus;
        for (value.array.items) |item| {
            switch (item) {
                .string => |str| try permitted.append(allocator, str),
                else => return error.InvalidStimulus,
            }
        }
    }
    stimulus.permitted_reads = permitted.items;

    var reads: std.ArrayList(types.ArtifactRef) = .empty;
    if (root.object.get("reads")) |value| {
        if (value != .array) return error.InvalidStimulus;
        for (value.array.items) |item| {
            if (item != .object) return error.InvalidStimulus;
            const id = jsonString(item, "id") orelse return error.InvalidStimulus;
            const digest = try script_mod.digestFromHex(jsonString(item, "digest") orelse return error.InvalidStimulus);
            const bytes = jsonString(item, "bytes") orelse return error.InvalidStimulus;
            const artifact_schema = jsonString(item, "schema") orelse return error.InvalidStimulus;
            // Digest-pinning: the declared digest must match the content.
            if (!std.mem.eql(u8, &types.digest(bytes), &digest)) return error.PinMismatch;
            try substrate.artifacts.put(try allocator.dupe(u8, id), .{
                .schema = try allocator.dupe(u8, artifact_schema),
                .bytes = try allocator.dupe(u8, bytes),
                .digest = digest,
                .produced_by = try allocator.dupe(u8, "stimulus"),
            });
            try reads.append(allocator, .{ .id = id, .digest = digest });
        }
    }
    stimulus.reads = reads.items;

    var messages: std.ArrayList(types.Message) = .empty;
    if (root.object.get("messages")) |value| {
        if (value != .array) return error.InvalidStimulus;
        for (value.array.items) |item| {
            if (item != .object) return error.InvalidStimulus;
            try messages.append(allocator, .{
                .to = jsonString(item, "to") orelse return error.InvalidStimulus,
                .schema = jsonString(item, "schema") orelse return error.InvalidStimulus,
                .payload = jsonString(item, "payload") orelse return error.InvalidStimulus,
                .durable = if (item.object.get("durable")) |v| v == .bool and v.bool else true,
            });
        }
    }
    stimulus.messages = messages.items;
    return stimulus;
}

/// Resolve the argv list for one neuron in a parsed manifest. Relative
/// script paths are joined against the manifest directory so the firing
/// works from any working directory. Returns the fully resolved argv
/// and the neuron's caps_request (admission's source of truth for caps).
/// The caller owns the returned slices (they live in the arena).
pub fn resolveNeuronArgv(
    allocator: Allocator,
    manifest: std.json.Value,
    manifest_dir: []const u8,
    wanted_id: []const u8,
) !struct { argv: []const []const u8, caps: caps_mod.Caps } {
    if (manifest != .object) return error.InvalidManifest;
    const neurons = manifest.object.get("neurons") orelse return error.InvalidManifest;
    if (neurons != .array) return error.InvalidManifest;
    var argv_list: std.ArrayList([]const u8) = .empty;
    var caps: caps_mod.Caps = .{};
    var found = false;
    for (neurons.array.items) |entry| {
        if (entry != .object) continue;
        const id = jsonString(entry, "id") orelse continue;
        if (!std.mem.eql(u8, id, wanted_id)) continue;
        found = true;
        const argv_json = entry.object.get("argv") orelse return error.InvalidManifest;
        if (argv_json != .array) return error.InvalidManifest;
        for (argv_json.array.items) |item| {
            const part = switch (item) {
                .string => |str| str,
                else => return error.InvalidManifest,
            };
            if (part.len > 0 and part[0] != '/' and std.mem.indexOfScalar(u8, part, '/') != null) {
                try argv_list.append(allocator, try std.fs.path.join(allocator, &.{ manifest_dir, part }));
            } else {
                try argv_list.append(allocator, part);
            }
        }
        if (entry.object.get("caps_request")) |requested| {
            caps = try script_mod.capsFromJson(requested);
        }
        break;
    }
    if (!found) return error.NeuronNotInManifest;
    if (argv_list.items.len == 0) return error.InvalidManifest;
    return .{ .argv = argv_list.items, .caps = caps };
}

fn jsonString(value: std.json.Value, key: []const u8) ?[]const u8 {
    if (value != .object) return null;
    const field = value.object.get(key) orelse return null;
    return switch (field) {
        .string => |str| str,
        else => null,
    };
}

fn jsonInt(value: std.json.Value, key: []const u8) ?i64 {
    if (value != .object) return null;
    const field = value.object.get(key) orelse return null;
    return switch (field) {
        .integer => |int| int,
        else => null,
    };
}

fn readStdin(allocator: Allocator, io: std.Io) ![]u8 {
    var buffer: [4096]u8 = undefined;
    var reader = std.Io.File.stdin().reader(io, &buffer);
    return reader.interface.allocRemaining(allocator, .limited(1 << 20));
}

pub fn printSummary(summary: Summary, json: bool, io: std.Io) !void {
    var out_buffer: [1024]u8 = undefined;
    var writer = std.Io.File.stdout().writer(io, &out_buffer);
    if (json) {
        try writer.interface.print(
            "{{\"status\":\"committed\",\"firing_id\":\"{s}\",\"neuron\":\"{s}\",\"effects_committed\":{d},\"duplicates_skipped\":{d},\"artifacts\":{d},\"messages\":{d},\"neurons\":{d},\"digest\":\"{x}\"",
            .{
                summary.firing_id,
                summary.neuron_id,
                summary.effects_committed,
                summary.duplicates_skipped,
                summary.artifacts,
                summary.messages,
                summary.neurons,
                summary.digest,
            },
        );
        if (summary.dump) |substrate| {
            try writer.interface.writeAll(",\"dump\":{\"artifacts\":[");
            var artifact_it = substrate.artifacts.iterator();
            var first = true;
            while (artifact_it.next()) |entry| {
                if (!first) try writer.interface.writeAll(",");
                first = false;
                try writer.interface.writeAll("{\"id\":");
                try std.json.Stringify.encodeJsonString(entry.key_ptr.*, .{}, &writer.interface);
                try writer.interface.writeAll(",\"schema\":");
                try std.json.Stringify.encodeJsonString(entry.value_ptr.schema, .{}, &writer.interface);
                try writer.interface.writeAll(",\"bytes\":");
                try std.json.Stringify.encodeJsonString(entry.value_ptr.bytes, .{}, &writer.interface);
                try writer.interface.print(",\"digest\":\"{x}\"}}", .{entry.value_ptr.digest});
            }
            try writer.interface.writeAll("],\"messages\":[");
            for (substrate.messages.items, 0..) |message, i| {
                if (i > 0) try writer.interface.writeAll(",");
                try writer.interface.writeAll("{\"firing_id\":");
                try std.json.Stringify.encodeJsonString(message.firing_id, .{}, &writer.interface);
                try writer.interface.writeAll(",\"to\":");
                try std.json.Stringify.encodeJsonString(message.to, .{}, &writer.interface);
                try writer.interface.writeAll(",\"schema\":");
                try std.json.Stringify.encodeJsonString(message.schema, .{}, &writer.interface);
                try writer.interface.writeAll(",\"payload\":");
                try std.json.Stringify.encodeJsonString(message.payload, .{}, &writer.interface);
                try writer.interface.print(",\"durable\":{},\"status\":\"{s}\"}}", .{ message.durable, @tagName(message.status) });
            }
            try writer.interface.writeAll("]}");
        }
        try writer.interface.writeAll("}\n");
    } else {
        try writer.interface.print(
            "✓ firing {s} committed via {s}\n  {d} effects · {d} artifacts · {d} messages · {d} neurons\n  decision {x}\n",
            .{
                summary.firing_id,
                summary.neuron_id,
                summary.effects_committed,
                summary.artifacts,
                summary.messages,
                summary.neurons,
                summary.digest,
            },
        );
    }
    try writer.interface.flush();
}
