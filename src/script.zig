const std = @import("std");
const types = @import("types.zig");
const caps_mod = @import("caps.zig");
const substrate_mod = @import("substrate.zig");

const Allocator = std.mem.Allocator;

/// Binding: a Neuron whose decision logic lives in an external script.
///
/// The harness serializes the Stimulus — with each read enriched by the
/// digest-pinned artifact bytes from the substrate (a recorded capability
/// read, §3) — onto the child's stdin. The child writes one JSON document to
/// stdout: either `neuron.decision/v1` or `neuron.rejection/v1`. The child is
/// untrusted decision logic (§18): it holds no authority, and Runtime still
/// validates and commits every returned effect. Returning `send` delivers
/// nothing (§20).
///
/// Lifecycle note: `allocator` should be an arena owned by the caller and
/// discarded after Runtime.execute; parsed decisions borrow from it.
pub const ScriptNeuron = struct {
    allocator: Allocator,
    io: std.Io,
    argv: []const []const u8,
    substrate: *const substrate_mod.Substrate,
    max_stdout: usize = 1 << 20,
    /// Fallback execution deadline when the stimulus declares none. The
    /// stimulus deadline always wins when present (§20 step 4).
    default_timeout: std.Io.Timeout = .none,

    pub fn fire(self: *const ScriptNeuron, stimulus: types.Stimulus, caps: caps_mod.Caps) !types.Decision {
        const input = try stimulusJson(self.allocator, stimulus, caps, self.substrate);
        const timeout = timeoutFor(stimulus, self.default_timeout);

        var child = try std.process.spawn(self.io, .{
            .argv = self.argv,
            .stdin = .pipe,
            .stdout = .pipe,
            .stderr = .pipe,
        });
        defer child.kill(self.io); // no-op once wait succeeds; reaps on timeout

        // The child is expected to drain stdin eagerly (our script-neurons
        // read all of stdin before deciding). A child that never reads can
        // block this write at the OS pipe buffer; the execution timeout
        // below covers the post-EOF phase, which is where hangs occur.
        var stdin_buffer: [4096]u8 = undefined;
        var stdin_writer = child.stdin.?.writer(self.io, &stdin_buffer);
        try stdin_writer.interface.writeAll(input);
        try stdin_writer.interface.flush();
        child.stdin.?.close(self.io);
        child.stdin = null;

        var mr_buffer: std.Io.File.MultiReader.Buffer(2) = undefined;
        var multi_reader: std.Io.File.MultiReader = undefined;
        multi_reader.init(self.allocator, self.io, mr_buffer.toStreams(), &.{ child.stdout.?, child.stderr.? });
        defer multi_reader.deinit();

        // Resource enforcement is kernel duty (§30): the untrusted child
        // cannot evade its deadline. On expiry the child is killed and the
        // firing fails typed as ScriptTimeout -> recorded .timed_out (§27).
        while (multi_reader.fill(64, timeout)) |_| {
            if (multi_reader.reader(0).buffered().len > self.max_stdout) return error.StreamTooLong;
        } else |err| switch (err) {
            error.EndOfStream => {},
            error.Timeout => return error.ScriptTimeout,
            else => |e| return e,
        }
        try multi_reader.checkAnyError();

        const term = try child.wait(self.io);
        const output = try multi_reader.toOwnedSlice(0);
        const errors = try multi_reader.toOwnedSlice(1);
        const parsed = std.json.parseFromSlice(std.json.Value, self.allocator, output, .{}) catch {
            if (term == .exited and term.exited != 0) return error.ScriptCrashed;
            return error.ScriptOutputInvalid;
        };
        const root = parsed.value;
        if (root != .object) return error.ScriptOutputInvalid;

        const schema = getString(root, "schema") orelse return error.ScriptOutputInvalid;
        if (std.mem.eql(u8, schema, "neuron.rejection/v1")) {
            _ = errors;
            return rejectionError(getString(root, "failure") orelse "internal");
        }
        if (!std.mem.eql(u8, schema, "neuron.decision/v1")) return error.ScriptOutputInvalid;
        if (term == .exited and term.exited != 0) return error.ScriptCrashed;
        return parseDecision(self.allocator, root);
    }
};

/// Per-firing execution deadline: the stimulus deadline (converted to a
/// duration from its recorded clock) wins over the configured default.
pub fn timeoutFor(stimulus: types.Stimulus, default: std.Io.Timeout) std.Io.Timeout {
    const deadline = stimulus.deadline_ms orelse return default;
    if (deadline <= stimulus.now_ms) return .{ .duration = .{ .raw = .{ .nanoseconds = 0 }, .clock = .boot } };
    const ms = deadline - stimulus.now_ms;
    return .{ .duration = .{ .raw = .{ .nanoseconds = @as(i96, @intCast(ms)) * std.time.ns_per_ms }, .clock = .boot } };
}

fn rejectionError(failure: []const u8) error{
    ScriptValidation,
    ScriptCapabilityDenied,
    ScriptBudgetExceeded,
    ScriptDependency,
    ScriptTimeout,
    ScriptConflict,
    ScriptPoisonedInput,
    ScriptInvariantViolation,
    ScriptInsufficientEvidence,
    ScriptFailed,
} {
    const map = .{
        .{ "validation", error.ScriptValidation },
        .{ "capability_denied", error.ScriptCapabilityDenied },
        .{ "budget_exhausted", error.ScriptBudgetExceeded },
        .{ "dependency", error.ScriptDependency },
        .{ "timeout", error.ScriptTimeout },
        .{ "conflict", error.ScriptConflict },
        .{ "poisoned_input", error.ScriptPoisonedInput },
        .{ "invariant_violation", error.ScriptInvariantViolation },
        .{ "insufficient_evidence", error.ScriptInsufficientEvidence },
    };
    inline for (map) |entry| {
        if (std.mem.eql(u8, failure, entry[0])) return entry[1];
    }
    return error.ScriptFailed;
}

fn getString(value: std.json.Value, key: []const u8) ?[]const u8 {
    const obj = switch (value) {
        .object => |obj| obj,
        else => return null,
    };
    const field = obj.get(key) orelse return null;
    return switch (field) {
        .string => |str| str,
        else => null,
    };
}

fn getInt(value: std.json.Value, key: []const u8) ?i64 {
    const obj = switch (value) {
        .object => |obj| obj,
        else => return null,
    };
    const field = obj.get(key) orelse return null;
    return switch (field) {
        .integer => |int| int,
        else => null,
    };
}

fn getBool(value: std.json.Value, key: []const u8, default: bool) bool {
    const obj = switch (value) {
        .object => |obj| obj,
        else => return default,
    };
    const field = obj.get(key) orelse return default;
    return switch (field) {
        .bool => |flag| flag,
        else => default,
    };
}

fn hexDigest(allocator: Allocator, digest: types.Digest) ![]const u8 {
    const hex = "0123456789abcdef";
    const out = try allocator.alloc(u8, 64);
    for (digest, 0..) |byte, i| {
        out[i * 2] = hex[byte >> 4];
        out[i * 2 + 1] = hex[byte & 0xf];
    }
    return out;
}

pub fn digestFromHex(hex: []const u8) !types.Digest {
    if (hex.len != 64) return error.InvalidDigest;
    var out: types.Digest = undefined;
    _ = std.fmt.hexToBytes(&out, hex) catch return error.InvalidDigest;
    return out;
}

/// Serialize the stimulus exactly as script-neurons expect it, enriching each
/// pinned read with schema and bytes from the substrate and attaching the
/// firing's capability grant and budget (§19).
pub fn stimulusJson(
    allocator: Allocator,
    stimulus: types.Stimulus,
    caps: caps_mod.Caps,
    substrate: *const substrate_mod.Substrate,
) ![]u8 {
    var root: std.json.ObjectMap = .empty;
    try root.put(allocator, "schema", .{ .string = "neuron.stimulus/v1" });
    try root.put(allocator, "firing_id", .{ .string = stimulus.firing_id });
    try root.put(allocator, "receptor_schema", .{ .string = stimulus.receptor_schema });
    // The script neuron's own attested address: what it will be recorded as
    // having sent from, and what a peer answers on (§19).
    try root.put(allocator, "self_ref", .{ .string = stimulus.self_ref });
    try root.put(allocator, "now_ms", .{ .integer = @intCast(stimulus.now_ms) });
    if (stimulus.deadline_ms) |deadline| {
        try root.put(allocator, "deadline_ms", .{ .integer = @intCast(deadline) });
    } else {
        try root.put(allocator, "deadline_ms", .null);
    }
    try root.put(allocator, "depth", .{ .integer = stimulus.depth });
    if (stimulus.random) |random| {
        try root.put(allocator, "random", .{ .string = try hexDigest(allocator, random) });
    } else {
        try root.put(allocator, "random", .null);
    }

    var permitted = std.json.Array.init(allocator);
    for (stimulus.permitted_reads) |id| try permitted.append(.{ .string = id });
    try root.put(allocator, "permitted_reads", .{ .array = permitted });

    var reads = std.json.Array.init(allocator);
    for (stimulus.reads) |read| {
        const artifact = substrate.artifacts.get(read.id) orelse return error.ReadNotInSubstrate;
        if (!std.mem.eql(u8, &artifact.digest, &read.digest)) return error.ReadDigestMismatch;
        var entry: std.json.ObjectMap = .empty;
        try entry.put(allocator, "id", .{ .string = read.id });
        try entry.put(allocator, "schema", .{ .string = artifact.schema });
        try entry.put(allocator, "bytes", .{ .string = artifact.bytes });
        try entry.put(allocator, "digest", .{ .string = try hexDigest(allocator, read.digest) });
        try reads.append(.{ .object = entry });
    }
    try root.put(allocator, "reads", .{ .array = reads });

    var messages = std.json.Array.init(allocator);
    for (stimulus.messages) |message| {
        var entry: std.json.ObjectMap = .empty;
        try entry.put(allocator, "to", .{ .string = message.to });
        try entry.put(allocator, "schema", .{ .string = message.schema });
        try entry.put(allocator, "payload", .{ .string = message.payload });
        try entry.put(allocator, "durable", .{ .bool = message.durable });
        // The attested envelope, so a script neuron can answer a request it
        // did not anticipate — it reads the return address off the message
        // rather than being configured with its peers in advance.
        try entry.put(allocator, "from", .{ .string = message.from });
        try entry.put(allocator, "correlation", .{ .string = message.correlation });
        try entry.put(allocator, "reply_to", .{ .string = message.reply_to });
        try entry.put(allocator, "turn", .{ .integer = message.turn });
        try messages.append(.{ .object = entry });
    }
    try root.put(allocator, "messages", .{ .array = messages });
    try root.put(allocator, "caps", try capsJson(allocator, caps));
    try root.put(allocator, "budget", try budgetJson(allocator, caps.budget));
    return std.json.Stringify.valueAlloc(allocator, std.json.Value{ .object = root }, .{});
}

fn budgetJson(allocator: Allocator, budget: caps_mod.Budget) !std.json.Value {
    var obj: std.json.ObjectMap = .empty;
    try obj.put(allocator, "max_effects", .{ .integer = @intCast(budget.max_effects) });
    try obj.put(allocator, "max_writes", .{ .integer = @intCast(budget.max_writes) });
    try obj.put(allocator, "max_messages", .{ .integer = @intCast(budget.max_messages) });
    try obj.put(allocator, "max_spawns", .{ .integer = @intCast(budget.max_spawns) });
    try obj.put(allocator, "max_bytes", .{ .integer = @intCast(budget.max_bytes) });
    try obj.put(allocator, "max_depth", .{ .integer = budget.max_depth });
    try obj.put(allocator, "max_turns", .{ .integer = budget.max_turns });
    return .{ .object = obj };
}

fn capsJson(allocator: Allocator, caps: caps_mod.Caps) !std.json.Value {
    var obj: std.json.ObjectMap = .empty;
    try obj.put(allocator, "allow_write", .{ .bool = caps.allow_write });
    try obj.put(allocator, "write_prefix", .{ .string = caps.write_prefix });
    try obj.put(allocator, "allow_send", .{ .bool = caps.allow_send });
    try obj.put(allocator, "send_prefix", .{ .string = caps.send_prefix });
    try obj.put(allocator, "allow_spawn", .{ .bool = caps.allow_spawn });
    try obj.put(allocator, "spawn_prefix", .{ .string = caps.spawn_prefix });
    try obj.put(allocator, "budget", try budgetJson(allocator, caps.budget));
    return .{ .object = obj };
}

/// Parse a capability grant from JSON. Unset budget fields take the caps.zig
/// defaults, exactly as a partially materialized Zig Budget would (§24).
pub fn capsFromJson(value: std.json.Value) !caps_mod.Caps {
    if (value != .object) return error.InvalidCaps;
    var caps: caps_mod.Caps = .{
        .allow_write = getBool(value, "allow_write", false),
        .allow_send = getBool(value, "allow_send", false),
        .allow_spawn = getBool(value, "allow_spawn", false),
        .write_prefix = getString(value, "write_prefix") orelse "",
        .send_prefix = getString(value, "send_prefix") orelse "",
        .spawn_prefix = getString(value, "spawn_prefix") orelse "",
    };
    if (value.object.get("budget")) |budget| {
        if (budget != .object) return error.InvalidCaps;
        if (getInt(budget, "max_effects")) |v| caps.budget.max_effects = @intCast(v);
        if (getInt(budget, "max_writes")) |v| caps.budget.max_writes = @intCast(v);
        if (getInt(budget, "max_messages")) |v| caps.budget.max_messages = @intCast(v);
        if (getInt(budget, "max_spawns")) |v| caps.budget.max_spawns = @intCast(v);
        if (getInt(budget, "max_bytes")) |v| caps.budget.max_bytes = @intCast(v);
        if (getInt(budget, "max_depth")) |v| caps.budget.max_depth = @intCast(v);
        if (getInt(budget, "max_turns")) |v| caps.budget.max_turns = @intCast(v);
    }
    return caps;
}

/// Parse a neuron.decision/v1 document into the hard-typed Decision. Any
/// deviation from the canonical shape is a validation failure (§19).
pub fn parseDecision(allocator: Allocator, root: std.json.Value) !types.Decision {
    if (root != .object) return error.InvalidDecision;
    const control_value = root.object.get("control") orelse return error.InvalidDecision;
    const kind = getString(control_value, "kind") orelse return error.InvalidDecision;
    var control: types.Control = undefined;
    if (std.mem.eql(u8, kind, "continue")) {
        control = .{ .continue_wait = getString(control_value, "wait_for") };
    } else if (std.mem.eql(u8, kind, "terminate")) {
        control = .{ .terminate = getString(control_value, "result") orelse return error.InvalidDecision };
    } else if (std.mem.eql(u8, kind, "branch")) {
        control = .{ .branch = getString(control_value, "next") orelse return error.InvalidDecision };
    } else {
        return error.InvalidDecision;
    }

    var effects: std.ArrayList(types.Effect) = .empty;
    if (root.object.get("effects")) |effects_value| {
        if (effects_value != .array) return error.InvalidDecision;
        for (effects_value.array.items) |effect_value| {
            try effects.append(allocator, try parseEffect(allocator, effect_value));
        }
    }

    var evidence_list: std.ArrayList(types.Evidence) = .empty;
    const evidence_value = root.object.get("evidence") orelse return error.InvalidDecision;
    if (evidence_value != .array) return error.InvalidDecision;
    for (evidence_value.array.items) |item| {
        const claim = getString(item, "claim") orelse return error.InvalidDecision;
        const method = getString(item, "method") orelse return error.InvalidDecision;
        const sources_value = item.object.get("sources") orelse return error.InvalidDecision;
        if (sources_value != .array) return error.InvalidDecision;
        var sources: std.ArrayList([]const u8) = .empty;
        for (sources_value.array.items) |source| {
            switch (source) {
                .string => |str| try sources.append(allocator, str),
                else => return error.InvalidDecision,
            }
        }
        try evidence_list.append(allocator, .{
            .claim = claim,
            .method = method,
            .sources = sources.items,
        });
    }

    return .{
        .control = control,
        .effects = effects.items,
        .evidence = evidence_list.items,
    };
}

fn parseEffect(allocator: Allocator, value: std.json.Value) !types.Effect {
    if (value != .object) return error.InvalidDecision;
    const kind = getString(value, "kind") orelse return error.InvalidDecision;
    if (std.mem.eql(u8, kind, "write")) {
        const artifact = value.object.get("artifact") orelse return error.InvalidDecision;
        var write: types.ArtifactWrite = .{
            .id = getString(artifact, "id") orelse return error.InvalidDecision,
            .schema = getString(artifact, "schema") orelse return error.InvalidDecision,
            .bytes = getString(artifact, "bytes") orelse return error.InvalidDecision,
        };
        if (getString(artifact, "expected_prior")) |hex| {
            write.expected_prior = try digestFromHex(hex);
        }
        return .{ .write = write };
    }
    if (std.mem.eql(u8, kind, "send")) {
        const message = value.object.get("message") orelse return error.InvalidDecision;
        // `correlation` is the one envelope field a neuron may choose: it
        // opens a conversation or answers one. Interpreter-owned fields are
        // parsed as presented rather than stripped, so a script that forges
        // its own sender is rejected by the valve instead of silently
        // succeeding with different provenance than it asked for.
        return .{ .send = .{
            .to = getString(message, "to") orelse return error.InvalidDecision,
            .schema = getString(message, "schema") orelse return error.InvalidDecision,
            .payload = getString(message, "payload") orelse return error.InvalidDecision,
            .durable = getBool(message, "durable", true),
            .correlation = getString(message, "correlation") orelse "",
            .from = getString(message, "from") orelse "",
            .reply_to = getString(message, "reply_to") orelse "",
            .turn = if (getInt(message, "turn")) |v| @intCast(v) else 0,
        } };
    }
    if (std.mem.eql(u8, kind, "spawn")) {
        const neuron = value.object.get("neuron") orelse return error.InvalidDecision;
        var spawn: types.Spawn = .{
            .id = getString(neuron, "id") orelse return error.InvalidDecision,
            .kind = getString(neuron, "kind") orelse return error.InvalidDecision,
        };
        if (neuron.object.get("grant")) |grant| {
            if (grant != .null) spawn.grant = try capsFromJson(grant);
        }
        _ = allocator;
        return .{ .spawn = spawn };
    }
    return error.InvalidDecision;
}

test "capsFromJson honors defaults and explicit budgets" {
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"allow_send": true, "send_prefix": "channel/", "budget": {"max_effects": 1}}
    , .{});
    defer parsed.deinit();
    const caps = try capsFromJson(parsed.value);
    try std.testing.expect(caps.allow_send);
    try std.testing.expect(!caps.allow_write);
    try std.testing.expectEqualStrings("channel/", caps.send_prefix);
    try std.testing.expectEqual(@as(usize, 1), caps.budget.max_effects);
    try std.testing.expectEqual(@as(usize, 8), caps.budget.max_writes); // caps.zig default
}

test "parseDecision round-trips the canonical decision shape" {
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"schema":"neuron.decision/v1",
        \\ "control":{"kind":"continue","wait_for":"provider_ack"},
        \\ "effects":[
        \\   {"kind":"write","artifact":{"id":"artifact/t/x","schema":"t/v1","bytes":"hi"}},
        \\   {"kind":"send","message":{"to":"channel/t","schema":"t/v1","payload":"p","durable":true}}
        \\ ],
        \\ "evidence":[{"claim":"c","sources":["stimulus"],"method":"m"}]}
    , .{});
    defer parsed.deinit();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const decision = try parseDecision(arena.allocator(), parsed.value);
    try std.testing.expectEqualStrings("provider_ack", decision.control.continue_wait.?);
    try std.testing.expectEqual(@as(usize, 2), decision.effects.len);
    try std.testing.expectEqualStrings("artifact/t/x", decision.effects[0].write.id);
    try std.testing.expect(decision.effects[1].send.durable);
    try std.testing.expectEqual(@as(usize, 1), decision.evidence.len);
}

test "parseDecision rejects malformed shapes" {
    const no_control = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"control":{"kind":"vanish"},"evidence":[]}
    , .{});
    defer no_control.deinit();
    try std.testing.expectError(error.InvalidDecision, parseDecision(std.testing.allocator, no_control.value));
}

test "script neuron fires through the real runtime validate+commit boundary" {
    var substrate = substrate_mod.Substrate.init(std.testing.allocator);
    defer substrate.deinit();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const script =
        "cat >/dev/null; printf '%s' '" ++
        "{\"schema\":\"neuron.decision/v1\"," ++
        "\"control\":{\"kind\":\"terminate\",\"result\":\"ok\"}," ++
        "\"effects\":[{\"kind\":\"write\",\"artifact\":{\"id\":\"artifact/t/x\",\"schema\":\"t/v1\",\"bytes\":\"hi\"}}]," ++
        "\"evidence\":[{\"claim\":\"c\",\"sources\":[\"stimulus\"],\"method\":\"m\"}]}'";
    const argv = [_][]const u8{ "/bin/sh", "-c", script };
    const implementation: ScriptNeuron = .{
        .allocator = arena.allocator(),
        .io = std.testing.io,
        .argv = &argv,
        .substrate = &substrate,
    };
    const neuron = @import("neuron.zig").bind(ScriptNeuron, &implementation, "test/script", "1.0.0");
    const runtime = @import("runtime.zig").Runtime{ .substrate = &substrate };
    const result = try runtime.fire(neuron, .{
        .firing_id = "script-test-1",
        .receptor_schema = "test/v1",
    }, .{ .allow_write = true, .write_prefix = "artifact/" });
    try std.testing.expectEqual(@as(usize, 1), result.effects_committed);
    try std.testing.expectEqual(@as(usize, 1), substrate.artifacts.count());
}

test "script rejection maps to a typed error and commits nothing" {
    var substrate = substrate_mod.Substrate.init(std.testing.allocator);
    defer substrate.deinit();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const script =
        "cat >/dev/null; printf '%s' '" ++
        "{\"schema\":\"neuron.rejection/v1\",\"failure\":\"capability_denied\",\"detail\":\"held\",\"effects\":[]}'; exit 1";
    const argv = [_][]const u8{ "/bin/sh", "-c", script };
    const implementation: ScriptNeuron = .{
        .allocator = arena.allocator(),
        .io = std.testing.io,
        .argv = &argv,
        .substrate = &substrate,
    };
    const neuron = @import("neuron.zig").bind(ScriptNeuron, &implementation, "test/script", "1.0.0");
    const runtime = @import("runtime.zig").Runtime{ .substrate = &substrate };
    try std.testing.expectError(error.ScriptCapabilityDenied, runtime.fire(neuron, .{
        .firing_id = "script-test-2",
        .receptor_schema = "test/v1",
    }, .{ .allow_write = true, .write_prefix = "artifact/" }));
    try std.testing.expectEqual(@as(usize, 0), substrate.artifacts.count());
}

test "timeout kills a hung child and settles the firing timed_out (§27)" {
    var substrate = substrate_mod.Substrate.init(std.testing.allocator);
    defer substrate.deinit();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const argv = [_][]const u8{ "/bin/sh", "-c", "cat >/dev/null; sleep 5" };
    const implementation: ScriptNeuron = .{
        .allocator = arena.allocator(),
        .io = std.testing.io,
        .argv = &argv,
        .substrate = &substrate,
    };
    const neuron = @import("neuron.zig").bind(ScriptNeuron, &implementation, "test/sleeper", "1.0.0");
    const runtime = @import("runtime.zig").Runtime{ .substrate = &substrate };
    try std.testing.expectError(error.ScriptTimeout, runtime.fire(neuron, .{
        .firing_id = "script-timeout-1",
        .receptor_schema = "test/v1",
        .now_ms = 1000,
        .deadline_ms = 1050, // 50ms execution budget against a 5s sleep
    }, .{ .allow_write = true, .write_prefix = "artifact/" }));
    const record = substrate.firings.get("script-timeout-1").?;
    try std.testing.expectEqual(substrate_mod.FiringStatus.timed_out, record.status);
    try std.testing.expectEqual(@as(usize, 0), substrate.artifacts.count());
}

test "a child answering within its deadline commits normally" {
    var substrate = substrate_mod.Substrate.init(std.testing.allocator);
    defer substrate.deinit();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const script =
        "cat >/dev/null; printf '%s' '" ++
        "{\"schema\":\"neuron.decision/v1\"," ++
        "\"control\":{\"kind\":\"terminate\",\"result\":\"ok\"}," ++
        "\"effects\":[{\"kind\":\"write\",\"artifact\":{\"id\":\"artifact/t/y\",\"schema\":\"t/v1\",\"bytes\":\"hi\"}}]," ++
        "\"evidence\":[{\"claim\":\"c\",\"sources\":[\"stimulus\"],\"method\":\"m\"}]}'";
    const argv = [_][]const u8{ "/bin/sh", "-c", script };
    const implementation: ScriptNeuron = .{
        .allocator = arena.allocator(),
        .io = std.testing.io,
        .argv = &argv,
        .substrate = &substrate,
    };
    const neuron = @import("neuron.zig").bind(ScriptNeuron, &implementation, "test/script", "1.0.0");
    const runtime = @import("runtime.zig").Runtime{ .substrate = &substrate };
    const result = try runtime.fire(neuron, .{
        .firing_id = "script-deadline-ok",
        .receptor_schema = "test/v1",
        .now_ms = 1000,
        .deadline_ms = 11000,
    }, .{ .allow_write = true, .write_prefix = "artifact/" });
    try std.testing.expectEqual(@as(usize, 1), result.effects_committed);
}

test "timeoutFor: stimulus deadline wins, default applies otherwise" {
    const fallback = std.Io.Timeout{ .duration = .{ .raw = .{ .nanoseconds = 99 * std.time.ns_per_ms }, .clock = .boot } };
    const with_deadline = timeoutFor(.{
        .firing_id = "f",
        .receptor_schema = "t/v1",
        .now_ms = 1000,
        .deadline_ms = 1060,
    }, fallback);
    try std.testing.expectEqual(@as(i96, 60 * std.time.ns_per_ms), with_deadline.duration.raw.nanoseconds);
    const no_deadline = timeoutFor(.{ .firing_id = "f", .receptor_schema = "t/v1" }, fallback);
    try std.testing.expectEqual(@as(i96, 99 * std.time.ns_per_ms), no_deadline.duration.raw.nanoseconds);
    const expired = timeoutFor(.{
        .firing_id = "f",
        .receptor_schema = "t/v1",
        .now_ms = 2000,
        .deadline_ms = 1000,
    }, fallback);
    try std.testing.expectEqual(@as(i96, 0), expired.duration.raw.nanoseconds);
}

test "a crashed child with stderr fails typed and commits nothing" {
    var substrate = substrate_mod.Substrate.init(std.testing.allocator);
    defer substrate.deinit();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const argv = [_][]const u8{ "/bin/sh", "-c", "cat >/dev/null; echo boom >&2; echo garbage; exit 3" };
    const implementation: ScriptNeuron = .{
        .allocator = arena.allocator(),
        .io = std.testing.io,
        .argv = &argv,
        .substrate = &substrate,
    };
    const neuron = @import("neuron.zig").bind(ScriptNeuron, &implementation, "test/crasher", "1.0.0");
    const runtime = @import("runtime.zig").Runtime{ .substrate = &substrate };
    try std.testing.expectError(error.ScriptCrashed, runtime.fire(neuron, .{
        .firing_id = "script-crash-1",
        .receptor_schema = "test/v1",
        .now_ms = 1000,
        .deadline_ms = 11000,
    }, .{ .allow_write = true, .write_prefix = "artifact/" }));
    try std.testing.expectEqual(@as(usize, 0), substrate.artifacts.count());
}

test "stimulusJson enriches reads from the substrate and attaches the grant" {
    var substrate = substrate_mod.Substrate.init(std.testing.allocator);
    defer substrate.deinit();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const bytes = "{\"hello\":\"world\"}";
    const artifact_digest = types.digest(bytes);
    // The substrate frees its entries with its own allocator on deinit, so
    // staged artifacts must be allocated with std.testing.allocator here —
    // never from the per-firing arena.
    try substrate.artifacts.put(try std.testing.allocator.dupe(u8, "artifact/t/x"), .{
        .schema = try std.testing.allocator.dupe(u8, "t/v1"),
        .bytes = try std.testing.allocator.dupe(u8, bytes),
        .digest = artifact_digest,
        .produced_by = try std.testing.allocator.dupe(u8, "test"),
    });
    const reads = [_]types.ArtifactRef{.{ .id = "artifact/t/x", .digest = artifact_digest }};
    const permitted = [_][]const u8{"artifact/t/x"};
    const out = try stimulusJson(allocator, .{
        .firing_id = "f-1",
        .receptor_schema = "t/v1",
        .permitted_reads = &permitted,
        .reads = &reads,
        .now_ms = 42,
    }, .{
        .allow_write = true,
        .write_prefix = "artifact/",
        .budget = .{ .max_writes = 2 },
    }, &substrate);
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, out, .{});
    defer parsed.deinit();
    const stim = parsed.value;
    try std.testing.expectEqualStrings("neuron.stimulus/v1", getString(stim, "schema").?);
    try std.testing.expectEqual(@as(i64, 42), getInt(stim, "now_ms").?);
    const read0 = stim.object.get("reads").?.array.items[0];
    try std.testing.expectEqualStrings(bytes, getString(read0, "bytes").?);
    const caps = stim.object.get("caps").?;
    try std.testing.expect(getBool(caps, "allow_write", false));
    const budget = caps.object.get("budget").?;
    try std.testing.expectEqual(@as(i64, 2), getInt(budget, "max_writes").?);
}
