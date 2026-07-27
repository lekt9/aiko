//! Shared types and projections for durable typed Skill execution.
//!
//! Claiming and settlement are separate interpreter limbs. This module owns
//! only their common graph vocabulary, identity rules, and ledger projection.

const std = @import("std");
const artifact = @import("../artifact.zig");
const ledger = @import("../ledger.zig");

pub const MAX_NODES: usize = 16;
pub const MAX_ATTEMPTS: u32 = 3;

pub const Error = error{
    InvalidJson,
    UnsupportedSchema,
    InvalidRequest,
    GraphMissing,
    NodeMissing,
    NotRunnable,
    LeaseConflict,
    EvidenceMismatch,
    FiringConflict,
    ArtifactFailure,
    LedgerFailure,
    OutOfMemory,
};

pub const Binding = struct {
    name: []const u8,
    dependency: []const u8,
    output: []const u8,
};

pub const Node = struct {
    id: []const u8,
    key: []const u8,
    plan: []const u8,
    action: []const u8,
    depends_on: []const []const u8,
    bindings: []const Binding,
    evidence: []const []const u8,
    worker: []const u8,
    adapter: ?[]const u8,
    script: ?[]const u8,
    script_digest: ?[]const u8,
    effect_scope: []const u8,
    read_only: bool,
    reversible: bool,
    timeout_ms: u64,
    skill_id: []const u8,
    skill_version: []const u8,
    authorization: []const u8,
};

pub const Outcome = enum { none, satisfied, retry, died };

pub const NodeState = struct {
    attempt: u32 = 0,
    lease_until_ms: u64 = 0,
    owner_digest: ?[64]u8 = null,
    outcome: Outcome = .none,
    evidence_digest: ?[64]u8 = null,
    firing_id: ?[64]u8 = null,
};

pub fn safeToken(value: []const u8) bool {
    if (value.len == 0 or value.len > 256) return false;
    for (value) |byte| {
        if (!std.ascii.isAlphanumeric(byte) and byte != '.' and byte != '_' and
            byte != '-' and byte != ':' and byte != '/') return false;
    }
    return true;
}

pub fn objectString(object: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    return switch (object.get(key) orelse return null) {
        .string => |value| value,
        else => null,
    };
}

pub fn objectInt(object: std.json.ObjectMap, key: []const u8) ?i64 {
    return switch (object.get(key) orelse return null) {
        .integer => |value| value,
        else => null,
    };
}

fn optionalObjectString(object: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const value = objectString(object, key) orelse return null;
    return if (value.len == 0) null else value;
}

pub fn hashFields(fields: []const []const u8) [64]u8 {
    var hash = std.crypto.hash.sha2.Sha256.init(.{});
    for (fields) |field| {
        hash.update(std.mem.asBytes(&field.len));
        hash.update(field);
    }
    var raw: [32]u8 = undefined;
    hash.final(&raw);
    return std.fmt.bytesToHex(raw, .lower);
}

pub fn graphDigest(request_json: []const u8) [64]u8 {
    return hashFields(&.{ "contract.neuron-skill.graph/v1", request_json });
}

pub fn executionId(
    root_id: []const u8,
    occurrence: []const u8,
    graph_digest: []const u8,
    node_id: []const u8,
) [64]u8 {
    return hashFields(&.{
        "contract.neuron-skill-node.execution/v1",
        root_id,
        occurrence,
        graph_digest,
        node_id,
    });
}

pub fn admitGraph(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    root_id: []const u8,
    graph_digest: []const u8,
    node_count: usize,
) Error!void {
    if (!safeToken(root_id) or !artifact.validDigest(graph_digest) or
        node_count == 0 or node_count > MAX_NODES) return Error.InvalidRequest;
    const lock = ledger.acquireExclusive(allocator, env) catch return Error.LedgerFailure;
    defer ledger.releaseExclusive(lock);
    const body = ledger.readAll(allocator, env) catch return Error.LedgerFailure;
    defer allocator.free(body);
    if (latestGraphDigest(body, root_id)) |prior| {
        if (std.mem.eql(u8, prior, graph_digest)) return;
    }
    const row = std.fmt.allocPrint(
        allocator,
        "{{\"event\":\"neuron_skill_graph_admitted\",\"root_id\":\"{s}\"," ++
            "\"graph_digest\":\"{s}\",\"node_count\":{d}}}",
        .{ root_id, graph_digest, node_count },
    ) catch return Error.OutOfMemory;
    defer allocator.free(row);
    const path = ledger.appendRow(allocator, env, row) catch return Error.LedgerFailure;
    allocator.free(path);
}

pub fn latestGraphDigest(body: []const u8, root_id: []const u8) ?[]const u8 {
    var result: ?[]const u8 = null;
    var lines = std.mem.tokenizeScalar(u8, body, '\n');
    while (lines.next()) |line| {
        if (std.mem.indexOf(u8, line, "\"neuron_skill_graph_admitted\"") == null) continue;
        var parsed = std.json.parseFromSlice(std.json.Value, std.heap.page_allocator, line, .{}) catch continue;
        defer parsed.deinit();
        if (parsed.value != .object) continue;
        const object = parsed.value.object;
        if (!std.mem.eql(u8, objectString(object, "root_id") orelse "", root_id)) continue;
        const value = objectString(object, "graph_digest") orelse continue;
        const start = std.mem.indexOf(u8, line, value) orelse continue;
        result = line[start .. start + value.len];
    }
    return result;
}

fn parseStringArray(
    allocator: std.mem.Allocator,
    encoded: []const u8,
) Error![]const []const u8 {
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, encoded, .{}) catch
        return Error.InvalidJson;
    defer parsed.deinit();
    if (parsed.value != .array) return Error.InvalidJson;
    const result = allocator.alloc([]const u8, parsed.value.array.items.len) catch
        return Error.OutOfMemory;
    for (parsed.value.array.items, 0..) |value, index| {
        result[index] = switch (value) {
            .string => |item| allocator.dupe(u8, item) catch return Error.OutOfMemory,
            else => return Error.InvalidJson,
        };
    }
    return result;
}

fn parseBindings(
    allocator: std.mem.Allocator,
    encoded: []const u8,
) Error![]const Binding {
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, encoded, .{}) catch
        return Error.InvalidJson;
    defer parsed.deinit();
    if (parsed.value != .object) return Error.InvalidJson;
    const result = allocator.alloc(Binding, parsed.value.object.count()) catch
        return Error.OutOfMemory;
    var iterator = parsed.value.object.iterator();
    var index: usize = 0;
    while (iterator.next()) |entry| : (index += 1) {
        const source = switch (entry.value_ptr.*) {
            .string => |value| value,
            else => return Error.InvalidJson,
        };
        const dot = std.mem.lastIndexOfScalar(u8, source, '.') orelse return Error.InvalidJson;
        result[index] = .{
            .name = allocator.dupe(u8, entry.key_ptr.*) catch return Error.OutOfMemory,
            .dependency = allocator.dupe(u8, source[0..dot]) catch return Error.OutOfMemory,
            .output = allocator.dupe(u8, source[dot + 1 ..]) catch return Error.OutOfMemory,
        };
    }
    return result;
}

pub fn loadNodes(
    allocator: std.mem.Allocator,
    body: []const u8,
    root_id: []const u8,
    graph_digest: []const u8,
) Error![]const Node {
    var nodes: std.ArrayList(Node) = .empty;
    var lines = std.mem.tokenizeScalar(u8, body, '\n');
    while (lines.next()) |line| {
        if (std.mem.indexOf(u8, line, "\"typed_neuron_skill_node\"") == null) continue;
        var parsed = std.json.parseFromSlice(std.json.Value, allocator, line, .{}) catch continue;
        defer parsed.deinit();
        if (parsed.value != .object) continue;
        const object = parsed.value.object;
        if (!std.mem.eql(u8, objectString(object, "event") orelse "", "declared") or
            !std.mem.eql(u8, objectString(object, "parent_id") orelse "", root_id) or
            !std.mem.eql(u8, objectString(object, "graph_digest") orelse "", graph_digest)) continue;
        if (nodes.items.len >= MAX_NODES) return Error.InvalidRequest;
        const timeout = std.fmt.parseInt(
            u64,
            objectString(object, "timeout_ms") orelse return Error.InvalidJson,
            10,
        ) catch return Error.InvalidJson;
        try nodes.append(allocator, .{
            .id = objectString(object, "id") orelse return Error.InvalidJson,
            .key = objectString(object, "graph_key") orelse return Error.InvalidJson,
            .plan = objectString(object, "plan") orelse return Error.InvalidJson,
            .action = objectString(object, "action") orelse return Error.InvalidJson,
            .depends_on = try parseStringArray(
                allocator,
                objectString(object, "depends_on") orelse return Error.InvalidJson,
            ),
            .bindings = try parseBindings(
                allocator,
                objectString(object, "input_bindings") orelse return Error.InvalidJson,
            ),
            .evidence = try parseStringArray(
                allocator,
                objectString(object, "evidence_requirements") orelse return Error.InvalidJson,
            ),
            .worker = objectString(object, "worker") orelse return Error.InvalidJson,
            .adapter = optionalObjectString(object, "adapter"),
            .script = optionalObjectString(object, "script"),
            .script_digest = optionalObjectString(object, "script_digest"),
            .effect_scope = objectString(object, "effect_scope") orelse return Error.InvalidJson,
            .read_only = std.mem.eql(u8, objectString(object, "read_only") orelse "", "true"),
            .reversible = std.mem.eql(u8, objectString(object, "reversible") orelse "", "true"),
            .timeout_ms = timeout,
            .skill_id = objectString(object, "skill_id") orelse return Error.InvalidJson,
            .skill_version = objectString(object, "skill_version") orelse return Error.InvalidJson,
            .authorization = objectString(object, "authorization") orelse "pending_authorization",
        });
        const loaded = nodes.items[nodes.items.len - 1];
        const implementation_valid =
            (std.mem.eql(u8, loaded.worker, "aiko") and loaded.adapter == null and
                loaded.script == null and loaded.script_digest == null) or
            (std.mem.eql(u8, loaded.worker, "host") and loaded.adapter != null and
                loaded.script == null and loaded.script_digest == null) or
            (std.mem.eql(u8, loaded.worker, "script") and loaded.adapter != null and
                loaded.script != null and loaded.script_digest != null and
                artifact.validDigest(loaded.script_digest.?));
        if (!implementation_valid) return Error.InvalidJson;
    }
    if (nodes.items.len == 0) return Error.GraphMissing;
    return nodes.toOwnedSlice(allocator) catch Error.OutOfMemory;
}

pub fn nodeIndex(nodes: []const Node, key: []const u8) ?usize {
    for (nodes, 0..) |node, index| if (std.mem.eql(u8, node.key, key)) return index;
    return null;
}

pub fn scanStates(
    body: []const u8,
    execution_ids: []const [64]u8,
    states: []NodeState,
) void {
    var lines = std.mem.tokenizeScalar(u8, body, '\n');
    while (lines.next()) |line| {
        if (std.mem.indexOf(u8, line, "\"neuron_skill_node_") == null) continue;
        var parsed = std.json.parseFromSlice(std.json.Value, std.heap.page_allocator, line, .{}) catch continue;
        defer parsed.deinit();
        scanStateValue(parsed.value, execution_ids, states);
    }
}

/// Atomic settlement publishes events inside one `neuron_transaction` row.
/// Replay must fold those nested rows exactly as it folded the former
/// top-level events, otherwise a restart forgets settlement and can commit a
/// duplicate firing.
fn scanStateValue(
    value: std.json.Value,
    execution_ids: []const [64]u8,
    states: []NodeState,
) void {
    if (value != .object) return;
    const object = value.object;
    const event = objectString(object, "event") orelse return;
    if (std.mem.eql(u8, event, "neuron_transaction")) {
        const rows = object.get("rows") orelse return;
        if (rows != .array) return;
        for (rows.array.items) |row| scanStateValue(row, execution_ids, states);
        return;
    }
    if (!std.mem.startsWith(u8, event, "neuron_skill_node_")) return;
    const id = objectString(object, "execution_id") orelse return;
    var index: ?usize = null;
    for (execution_ids, 0..) |candidate, candidate_index| {
        if (std.mem.eql(u8, &candidate, id)) {
            index = candidate_index;
            break;
        }
    }
    const state = if (index) |found| &states[found] else return;
    const attempt_raw = objectInt(object, "attempt") orelse return;
    if (attempt_raw <= 0 or attempt_raw > std.math.maxInt(u32)) return;
    const attempt: u32 = @intCast(attempt_raw);
    if (std.mem.eql(u8, event, "neuron_skill_node_claimed")) {
        if (attempt < state.attempt) return;
        state.* = .{
            .attempt = attempt,
            .lease_until_ms = @intCast(@max(0, objectInt(object, "lease_until_ms") orelse 0)),
            .owner_digest = copyDigest(objectString(object, "owner_digest") orelse ""),
        };
    } else if (std.mem.eql(u8, event, "neuron_skill_node_settled")) {
        if (attempt < state.attempt) return;
        state.attempt = attempt;
        state.lease_until_ms = 0;
        state.outcome = std.meta.stringToEnum(
            Outcome,
            objectString(object, "outcome") orelse "",
        ) orelse .none;
        state.evidence_digest = copyDigest(objectString(object, "evidence_digest") orelse "");
        state.firing_id = copyDigest(objectString(object, "firing_id") orelse "");
    }
}

fn copyDigest(value: []const u8) ?[64]u8 {
    if (!artifact.validDigest(value)) return null;
    var result: [64]u8 = undefined;
    @memcpy(&result, value);
    return result;
}

pub fn dependenciesSatisfied(
    nodes: []const Node,
    states: []const NodeState,
    node: Node,
) bool {
    for (node.depends_on) |dependency| {
        const index = nodeIndex(nodes, dependency) orelse return false;
        if (states[index].outcome != .satisfied) return false;
    }
    return true;
}

pub fn appendJsonString(
    out: *std.ArrayList(u8),
    allocator: std.mem.Allocator,
    value: []const u8,
) !void {
    var writer: std.Io.Writer.Allocating = .init(allocator);
    defer writer.deinit();
    var stringify = std.json.Stringify{ .writer = &writer.writer };
    try stringify.write(value);
    try out.appendSlice(allocator, writer.writer.buffered());
}

pub fn appendJsonValue(
    out: *std.ArrayList(u8),
    allocator: std.mem.Allocator,
    value: std.json.Value,
) !void {
    var writer: std.Io.Writer.Allocating = .init(allocator);
    defer writer.deinit();
    var stringify = std.json.Stringify{ .writer = &writer.writer };
    try stringify.write(value);
    try out.appendSlice(allocator, writer.writer.buffered());
}

pub fn appendInputs(
    out: *std.ArrayList(u8),
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    node: Node,
    nodes: []const Node,
    states: []const NodeState,
) Error!void {
    out.append(allocator, '{') catch return Error.OutOfMemory;
    for (node.bindings, 0..) |binding, index| {
        const dependency_index = nodeIndex(nodes, binding.dependency) orelse
            return Error.EvidenceMismatch;
        const digest_value = states[dependency_index].evidence_digest orelse
            return Error.EvidenceMismatch;
        const bytes = artifact.read(allocator, env, &digest_value) catch
            return Error.ArtifactFailure;
        defer allocator.free(bytes);
        var parsed = std.json.parseFromSlice(std.json.Value, allocator, bytes, .{}) catch
            return Error.ArtifactFailure;
        defer parsed.deinit();
        if (parsed.value != .object) return Error.ArtifactFailure;
        const value = parsed.value.object.get(binding.output) orelse
            return Error.EvidenceMismatch;
        if (index > 0) out.append(allocator, ',') catch return Error.OutOfMemory;
        appendJsonString(out, allocator, binding.name) catch return Error.OutOfMemory;
        out.append(allocator, ':') catch return Error.OutOfMemory;
        appendJsonValue(out, allocator, value) catch return Error.OutOfMemory;
    }
    out.append(allocator, '}') catch return Error.OutOfMemory;
}

pub fn appendTerminalEvidence(
    out: *std.ArrayList(u8),
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    nodes: []const Node,
    states: []const NodeState,
) Error!void {
    for (nodes, 0..) |node, index| {
        if (!std.mem.endsWith(u8, node.key, "--settle")) continue;
        const digest_value = states[index].evidence_digest orelse continue;
        const bytes = artifact.read(allocator, env, &digest_value) catch
            return Error.ArtifactFailure;
        defer allocator.free(bytes);
        out.appendSlice(allocator, bytes) catch return Error.OutOfMemory;
        return;
    }
    out.appendSlice(allocator, "{}") catch return Error.OutOfMemory;
}

test "graph and execution identities are deterministic and occurrence scoped" {
    const graph_a = graphDigest("{\"graph\":1}");
    const graph_b = graphDigest("{\"graph\":1}");
    try std.testing.expectEqualSlices(u8, &graph_a, &graph_b);
    const first = executionId("caf00d01", "repeat:1:2", &graph_a, "caf00d02");
    const second = executionId("caf00d01", "repeat:1:3", &graph_a, "caf00d02");
    try std.testing.expect(!std.mem.eql(u8, &first, &second));
}

test "state fold reads atomic neuron transaction rows" {
    const execution_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const evidence_digest = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const firing_id = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const owner_digest = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const body =
        "{\"event\":\"neuron_skill_node_claimed\",\"execution_id\":\"" ++ execution_id ++
        "\",\"attempt\":1,\"lease_until_ms\":50,\"owner_digest\":\"" ++ owner_digest ++ "\"}\n" ++
        "{\"event\":\"neuron_transaction\",\"version\":1,\"rows\":[" ++
        "{\"event\":\"neuron_fired\",\"firing_id\":\"" ++ firing_id ++ "\"}," ++
        "{\"event\":\"neuron_skill_node_settled\",\"execution_id\":\"" ++ execution_id ++
        "\",\"attempt\":1,\"outcome\":\"satisfied\",\"evidence_digest\":\"" ++
        evidence_digest ++ "\",\"firing_id\":\"" ++ firing_id ++ "\"}]}\n";
    const execution_ids = [_][64]u8{execution_id[0..64].*};
    var states = [_]NodeState{.{}};

    scanStates(body, &execution_ids, &states);

    try std.testing.expectEqual(@as(u32, 1), states[0].attempt);
    try std.testing.expectEqual(Outcome.satisfied, states[0].outcome);
    try std.testing.expectEqual(@as(u64, 0), states[0].lease_until_ms);
    try std.testing.expectEqualSlices(u8, evidence_digest, &states[0].evidence_digest.?);
    try std.testing.expectEqualSlices(u8, firing_id, &states[0].firing_id.?);
}
