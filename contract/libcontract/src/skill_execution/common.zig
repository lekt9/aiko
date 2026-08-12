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
    cell_digest: ?[]const u8,
    witness_id: ?[]const u8,
    witness_digest: ?[]const u8,
    judge_digest: ?[]const u8,
};

pub const GraphHarnessIdentity = struct {
    api_version: []const u8,
    state: []const u8,
    subject_digest: []const u8,
    transitive_digest: []const u8,
    adapter: []const u8,
    bundle_ref: []const u8,
    evaluation_policy: []const u8,
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
    return admitGraphWithIdentity(allocator, env, root_id, graph_digest, node_count, null);
}

pub fn admitGraphWithIdentity(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    root_id: []const u8,
    graph_digest: []const u8,
    node_count: usize,
    identity: ?GraphHarnessIdentity,
) Error!void {
    if (!safeToken(root_id) or !artifact.validDigest(graph_digest) or
        node_count == 0 or node_count > MAX_NODES) return Error.InvalidRequest;
    if (identity) |value| {
        if (!std.mem.eql(u8, value.api_version, "graph-harness/v1") or
            !artifact.validDigest(value.subject_digest) or
            !artifact.validDigest(value.transitive_digest) or
            !safeToken(value.adapter) or !safeToken(value.evaluation_policy) or
            !std.mem.startsWith(u8, value.bundle_ref, "cas:") or
            !artifact.validDigest(value.bundle_ref[4..]) or
            !(std.mem.eql(u8, value.state, "prepared") or
                std.mem.eql(u8, value.state, "evaluated"))) return Error.InvalidRequest;
    }
    const lock = ledger.acquireExclusive(allocator, env) catch return Error.LedgerFailure;
    defer ledger.releaseExclusive(lock);
    const prior = latestGraphDigestStreaming(allocator, env, root_id) catch
        return Error.LedgerFailure;
    defer if (prior) |digest| allocator.free(digest);
    if (prior) |digest| if (std.mem.eql(u8, digest, graph_digest)) return;
    const row = if (identity) |value|
        std.fmt.allocPrint(
            allocator,
            "{{\"event\":\"neuron_skill_graph_admitted\",\"root_id\":\"{s}\"," ++
                "\"graph_digest\":\"{s}\",\"node_count\":{d}," ++
                "\"graph_harness\":{{\"api_version\":\"{s}\",\"state\":\"{s}\"," ++
                "\"subject_digest\":\"{s}\",\"transitive_digest\":\"{s}\"," ++
                "\"adapter\":\"{s}\",\"bundle_ref\":\"{s}\"," ++
                "\"evaluation_policy\":\"{s}\"}}}}",
            .{ root_id, graph_digest, node_count, value.api_version, value.state, value.subject_digest, value.transitive_digest, value.adapter, value.bundle_ref, value.evaluation_policy },
        )
    else
        std.fmt.allocPrint(
            allocator,
            "{{\"event\":\"neuron_skill_graph_admitted\",\"root_id\":\"{s}\"," ++
                "\"graph_digest\":\"{s}\",\"node_count\":{d}}}",
            .{ root_id, graph_digest, node_count },
        );
    const owned = row catch return Error.OutOfMemory;
    defer allocator.free(owned);
    const path = ledger.appendRow(allocator, env, owned) catch return Error.LedgerFailure;
    allocator.free(path);
}

const GraphDigestScan = struct {
    allocator: std.mem.Allocator,
    root_id: []const u8,
    result: ?[]u8 = null,
};

const GraphHarnessIdentityScan = struct {
    allocator: std.mem.Allocator,
    root_id: []const u8,
    graph_digest: []const u8,
    found: bool = false,
    result: ?GraphHarnessIdentity = null,
    err: ?Error = null,
};

fn validGraphHarnessIdentity(value: GraphHarnessIdentity) bool {
    return std.mem.eql(u8, value.api_version, "graph-harness/v1") and
        artifact.validDigest(value.subject_digest) and
        artifact.validDigest(value.transitive_digest) and
        safeToken(value.adapter) and safeToken(value.evaluation_policy) and
        std.mem.startsWith(u8, value.bundle_ref, "cas:") and
        artifact.validDigest(value.bundle_ref[4..]) and
        (std.mem.eql(u8, value.state, "prepared") or
            std.mem.eql(u8, value.state, "evaluated"));
}

fn latestGraphDigestLine(opaque_ctx: *anyopaque, line: []const u8) void {
    const ctx: *GraphDigestScan = @ptrCast(@alignCast(opaque_ctx));
    if (std.mem.indexOf(u8, line, "\"neuron_skill_graph_admitted\"") == null) return;
    var parsed = std.json.parseFromSlice(std.json.Value, std.heap.page_allocator, line, .{}) catch return;
    defer parsed.deinit();
    if (parsed.value != .object) return;
    const object = parsed.value.object;
    if (!std.mem.eql(u8, objectString(object, "root_id") orelse "", ctx.root_id)) return;
    const value = objectString(object, "graph_digest") orelse return;
    const owned = ctx.allocator.dupe(u8, value) catch return;
    if (ctx.result) |old| ctx.allocator.free(old);
    ctx.result = owned;
}

/// Streaming dedupe projection: replays the ledger line-by-line instead of
/// slurping via readAll, whose 16 MiB cap wedged graph admission on long-lived
/// session stores (observed 2026-07-29: a 23k-row session ledger HOLDed every
/// consequential tool through this path). The last matching row wins, same as
/// the retired body scan. Caller owns the returned slice.
pub fn latestGraphDigestStreaming(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    root_id: []const u8,
) Error!?[]u8 {
    var ctx: GraphDigestScan = .{ .allocator = allocator, .root_id = root_id };
    ledger.forEachLine(allocator, env, &ctx, latestGraphDigestLine) catch
        return Error.LedgerFailure;
    return ctx.result;
}

fn graphHarnessIdentityLine(opaque_ctx: *anyopaque, line: []const u8) void {
    const ctx: *GraphHarnessIdentityScan = @ptrCast(@alignCast(opaque_ctx));
    // The first admission for an exact root + graph digest is its immutable
    // identity. A later raw ledger append must not be able to retarget already
    // admitted execution material.
    if (ctx.found or ctx.err != null or
        std.mem.indexOf(u8, line, "\"neuron_skill_graph_admitted\"") == null) return;
    var parsed = std.json.parseFromSlice(std.json.Value, std.heap.page_allocator, line, .{}) catch return;
    defer parsed.deinit();
    if (parsed.value != .object) return;
    const object = parsed.value.object;
    if (!std.mem.eql(u8, objectString(object, "event") orelse "", "neuron_skill_graph_admitted") or
        !std.mem.eql(u8, objectString(object, "root_id") orelse "", ctx.root_id) or
        !std.mem.eql(u8, objectString(object, "graph_digest") orelse "", ctx.graph_digest)) return;
    ctx.found = true;
    const harness_value = object.get("graph_harness") orelse return;
    if (harness_value != .object) {
        ctx.err = Error.InvalidJson;
        return;
    }
    const harness = harness_value.object;
    if (harness.count() != 7) {
        ctx.err = Error.InvalidJson;
        return;
    }
    const borrowed: GraphHarnessIdentity = .{
        .api_version = objectString(harness, "api_version") orelse {
            ctx.err = Error.InvalidJson;
            return;
        },
        .state = objectString(harness, "state") orelse {
            ctx.err = Error.InvalidJson;
            return;
        },
        .subject_digest = objectString(harness, "subject_digest") orelse {
            ctx.err = Error.InvalidJson;
            return;
        },
        .transitive_digest = objectString(harness, "transitive_digest") orelse {
            ctx.err = Error.InvalidJson;
            return;
        },
        .adapter = objectString(harness, "adapter") orelse {
            ctx.err = Error.InvalidJson;
            return;
        },
        .bundle_ref = objectString(harness, "bundle_ref") orelse {
            ctx.err = Error.InvalidJson;
            return;
        },
        .evaluation_policy = objectString(harness, "evaluation_policy") orelse {
            ctx.err = Error.InvalidJson;
            return;
        },
    };
    if (!validGraphHarnessIdentity(borrowed)) {
        ctx.err = Error.InvalidJson;
        return;
    }
    ctx.result = .{
        .api_version = ctx.allocator.dupe(u8, borrowed.api_version) catch {
            ctx.err = Error.OutOfMemory;
            return;
        },
        .state = ctx.allocator.dupe(u8, borrowed.state) catch {
            ctx.err = Error.OutOfMemory;
            return;
        },
        .subject_digest = ctx.allocator.dupe(u8, borrowed.subject_digest) catch {
            ctx.err = Error.OutOfMemory;
            return;
        },
        .transitive_digest = ctx.allocator.dupe(u8, borrowed.transitive_digest) catch {
            ctx.err = Error.OutOfMemory;
            return;
        },
        .adapter = ctx.allocator.dupe(u8, borrowed.adapter) catch {
            ctx.err = Error.OutOfMemory;
            return;
        },
        .bundle_ref = ctx.allocator.dupe(u8, borrowed.bundle_ref) catch {
            ctx.err = Error.OutOfMemory;
            return;
        },
        .evaluation_policy = ctx.allocator.dupe(u8, borrowed.evaluation_policy) catch {
            ctx.err = Error.OutOfMemory;
            return;
        },
    };
}

/// Project the immutable GraphHarness root identity from the admission row for
/// this exact graph. Legacy admissions deliberately return null.
pub fn loadGraphHarnessIdentityStreaming(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    root_id: []const u8,
    graph_digest: []const u8,
) Error!?GraphHarnessIdentity {
    var ctx: GraphHarnessIdentityScan = .{
        .allocator = allocator,
        .root_id = root_id,
        .graph_digest = graph_digest,
    };
    ledger.forEachLine(allocator, env, &ctx, graphHarnessIdentityLine) catch
        return Error.LedgerFailure;
    if (ctx.err) |err| return err;
    return ctx.result;
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

const LoadNodesScan = struct {
    allocator: std.mem.Allocator,
    root_id: []const u8,
    graph_digest: []const u8,
    nodes: std.ArrayList(Node) = .empty,
    err: ?Error = null,
};

fn loadNodesLine(opaque_ctx: *anyopaque, line: []const u8) void {
    const ctx: *LoadNodesScan = @ptrCast(@alignCast(opaque_ctx));
    if (ctx.err != null) return;
    loadNodesLineChecked(ctx, line) catch |err| {
        ctx.err = err;
    };
}

fn loadNodesLineChecked(ctx: *LoadNodesScan, line: []const u8) Error!void {
    if (std.mem.indexOf(u8, line, "\"typed_neuron_skill_node\"") == null) return;
    // alloc_always with no deinit: node fields reference this parse's strings,
    // which must outlive the line buffer forEachLine reuses. Callers pass an
    // arena, so per-line parses are reclaimed en masse.
    const parsed = std.json.parseFromSlice(std.json.Value, ctx.allocator, line, .{
        .allocate = .alloc_always,
    }) catch return;
    if (parsed.value != .object) return;
    const object = parsed.value.object;
    if (!std.mem.eql(u8, objectString(object, "event") orelse "", "declared") or
        !std.mem.eql(u8, objectString(object, "parent_id") orelse "", ctx.root_id) or
        !std.mem.eql(u8, objectString(object, "graph_digest") orelse "", ctx.graph_digest)) return;
    if (ctx.nodes.items.len >= MAX_NODES) return Error.InvalidRequest;
    const timeout = std.fmt.parseInt(
        u64,
        objectString(object, "timeout_ms") orelse return Error.InvalidJson,
        10,
    ) catch return Error.InvalidJson;
    try ctx.nodes.append(ctx.allocator, .{
        .id = objectString(object, "id") orelse return Error.InvalidJson,
        .key = objectString(object, "graph_key") orelse return Error.InvalidJson,
        .plan = objectString(object, "plan") orelse return Error.InvalidJson,
        .action = objectString(object, "action") orelse return Error.InvalidJson,
        .depends_on = try parseStringArray(
            ctx.allocator,
            objectString(object, "depends_on") orelse return Error.InvalidJson,
        ),
        .bindings = try parseBindings(
            ctx.allocator,
            objectString(object, "input_bindings") orelse return Error.InvalidJson,
        ),
        .evidence = try parseStringArray(
            ctx.allocator,
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
        .cell_digest = optionalObjectString(object, "cell_digest"),
        .witness_id = optionalObjectString(object, "witness_id"),
        .witness_digest = optionalObjectString(object, "witness_digest"),
        .judge_digest = optionalObjectString(object, "judge_digest"),
    });
    const loaded = ctx.nodes.items[ctx.nodes.items.len - 1];
    const implementation_valid =
        (std.mem.eql(u8, loaded.worker, "aiko") and
            (loaded.adapter == null or std.mem.eql(u8, loaded.adapter.?, "aiko.graph-harness-edge-model/v1")) and
            loaded.script == null and loaded.script_digest == null) or
        (std.mem.eql(u8, loaded.worker, "host") and loaded.adapter != null and
            loaded.script == null and loaded.script_digest == null) or
        (std.mem.eql(u8, loaded.worker, "script") and loaded.adapter != null and
            loaded.script != null and loaded.script_digest != null and
            artifact.validDigest(loaded.script_digest.?));
    if (!implementation_valid) return Error.InvalidJson;
}

/// Streaming node projection — the same selection and validation rules as the
/// retired body scan, replayed line-by-line so claim/settle work on stores
/// past readAll's 16 MiB cap.
pub fn loadNodesStreaming(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    root_id: []const u8,
    graph_digest: []const u8,
) Error![]const Node {
    var ctx: LoadNodesScan = .{
        .allocator = allocator,
        .root_id = root_id,
        .graph_digest = graph_digest,
    };
    defer ctx.nodes.deinit(allocator);
    ledger.forEachLine(allocator, env, &ctx, loadNodesLine) catch return Error.LedgerFailure;
    if (ctx.err) |err| return err;
    if (ctx.nodes.items.len == 0) return Error.GraphMissing;
    return ctx.nodes.toOwnedSlice(allocator) catch Error.OutOfMemory;
}

fn graphHarnessAdapterAllowed(node: Node) bool {
    const adapter = node.adapter orelse return false;
    if (std.mem.eql(u8, adapter, "aiko.graph-harness-cell-v0/v1")) return std.mem.eql(u8, node.worker, "host");
    if (std.mem.eql(u8, adapter, "aiko.graph-harness-edge-model/v1")) {
        const read_only = node.read_only and std.mem.eql(u8, node.effect_scope, "read_only");
        const workspace = !node.read_only and node.reversible and std.mem.eql(u8, node.effect_scope, "local_reversible");
        return std.mem.eql(u8, node.worker, "aiko") and node.script == null and node.script_digest == null and (read_only or workspace);
    }
    const host = std.mem.eql(u8, node.worker, "host") and node.read_only and
        std.mem.eql(u8, node.effect_scope, "read_only") and node.script == null and
        node.script_digest == null and std.mem.eql(u8, node.skill_id, "aiko-meta-agent") and
        std.mem.eql(u8, node.skill_version, "1.0.0");
    return host and ((std.mem.eql(u8, node.key, "aiko-meta-agent--observe") and std.mem.eql(u8, adapter, "aiko.meta.observe/v1")) or
        (std.mem.eql(u8, node.key, "aiko-meta-agent--recall") and std.mem.eql(u8, adapter, "aiko.meta.recall/v1")) or
        (std.mem.eql(u8, node.key, "aiko-meta-agent--route") and std.mem.eql(u8, adapter, "aiko.meta.route/v1")) or
        (std.mem.eql(u8, node.key, "aiko-meta-agent--capture") and std.mem.eql(u8, adapter, "aiko.meta.capture/v1")) or
        (std.mem.eql(u8, node.key, "aiko-meta-agent--settle") and std.mem.eql(u8, adapter, "aiko.meta.settle/v1")));
}

pub fn validGraphHarnessNodePins(node: Node, identity: GraphHarnessIdentity) bool {
    return node.cell_digest != null and artifact.validDigest(node.cell_digest.?) and
        node.witness_id != null and safeToken(node.witness_id.?) and
        node.witness_digest != null and artifact.validDigest(node.witness_digest.?) and
        node.judge_digest != null and artifact.validDigest(node.judge_digest.?) and
        !std.mem.eql(u8, node.witness_digest.?, node.judge_digest.?) and
        // Root identity names the pure GraphHarness→Contract adapter; leased
        // children name the only executable adapter admitted by v1. Equating
        // them makes every honest GraphHarness claim unclaimable.
        std.mem.eql(u8, identity.adapter, "aiko.graph-harness-contract/v1") and
        node.adapter != null and graphHarnessAdapterAllowed(node);
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

const ScanStatesCtx = struct {
    execution_ids: []const [64]u8,
    states: []NodeState,
};

fn scanStatesLine(opaque_ctx: *anyopaque, line: []const u8) void {
    const ctx: *ScanStatesCtx = @ptrCast(@alignCast(opaque_ctx));
    if (std.mem.indexOf(u8, line, "\"neuron_skill_node_") == null) return;
    var parsed = std.json.parseFromSlice(std.json.Value, std.heap.page_allocator, line, .{}) catch return;
    defer parsed.deinit();
    scanStateValue(parsed.value, ctx.execution_ids, ctx.states);
}

/// Streaming state fold — the same fold as scanStates, replayed line-by-line
/// so claim/settle work on stores past readAll's 16 MiB cap.
pub fn scanStatesStreaming(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    execution_ids: []const [64]u8,
    states: []NodeState,
) Error!void {
    var ctx: ScanStatesCtx = .{ .execution_ids = execution_ids, .states = states };
    ledger.forEachLine(allocator, env, &ctx, scanStatesLine) catch return Error.LedgerFailure;
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


pub fn appendOptionalJsonString(
    out: *std.ArrayList(u8),
    allocator: std.mem.Allocator,
    value: ?[]const u8,
) !void {
    if (value) |present| {
        try appendJsonString(out, allocator, present);
    } else {
        try out.appendSlice(allocator, "null");
    }
}

pub fn appendGraphHarnessIdentity(
    out: *std.ArrayList(u8),
    allocator: std.mem.Allocator,
    identity: ?GraphHarnessIdentity,
) !void {
    const value = identity orelse {
        try out.appendSlice(allocator, "null");
        return;
    };
    try out.appendSlice(allocator, "{\"api_version\":");
    try appendJsonString(out, allocator, value.api_version);
    for ([_]struct { label: []const u8, field: []const u8 }{
        .{ .label = "state", .field = value.state },
        .{ .label = "subject_digest", .field = value.subject_digest },
        .{ .label = "transitive_digest", .field = value.transitive_digest },
        .{ .label = "adapter", .field = value.adapter },
        .{ .label = "bundle_ref", .field = value.bundle_ref },
        .{ .label = "evaluation_policy", .field = value.evaluation_policy },
    }) |field| {
        try out.print(allocator, ",\"{s}\":", .{field.label});
        try appendJsonString(out, allocator, field.field);
    }
    try out.append(allocator, '}');
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

test "latestGraphDigestLine keeps the last matching digest for the root" {
    const digest_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const digest_b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    var ctx: GraphDigestScan = .{
        .allocator = std.testing.allocator,
        .root_id = "root-abc",
    };
    defer if (ctx.result) |r| std.testing.allocator.free(r);

    // Unrelated events and other roots are ignored.
    latestGraphDigestLine(&ctx, "{\"event\":\"declared\",\"root_id\":\"root-abc\"}");
    try std.testing.expect(ctx.result == null);
    latestGraphDigestLine(&ctx, "{\"event\":\"neuron_skill_graph_admitted\",\"root_id\":\"other\",\"graph_digest\":\"" ++ digest_b ++ "\"}");
    try std.testing.expect(ctx.result == null);

    // First matching row lands; malformed rows never shadow a valid prior.
    latestGraphDigestLine(&ctx, "{\"event\":\"neuron_skill_graph_admitted\",\"root_id\":\"root-abc\",\"graph_digest\":\"" ++ digest_a ++ "\"}");
    try std.testing.expectEqualStrings(digest_a, ctx.result.?);
    latestGraphDigestLine(&ctx, "{not json");
    try std.testing.expectEqualStrings(digest_a, ctx.result.?);
    latestGraphDigestLine(&ctx, "{\"event\":\"neuron_skill_graph_admitted\",\"root_id\":\"root-abc\"}");
    try std.testing.expectEqualStrings(digest_a, ctx.result.?);

    // The last matching row wins, same as the retired body scan.
    latestGraphDigestLine(&ctx, "{\"event\":\"neuron_skill_graph_admitted\",\"root_id\":\"root-abc\",\"graph_digest\":\"" ++ digest_b ++ "\"}");
    try std.testing.expectEqualStrings(digest_b, ctx.result.?);
}


test "GraphHarness admission identity is first-write immutable and legacy-null" {
    const a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const c = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var ctx: GraphHarnessIdentityScan = .{
        .allocator = arena.allocator(),
        .root_id = "root-gh",
        .graph_digest = a,
    };
    graphHarnessIdentityLine(&ctx,
        "{\"event\":\"neuron_skill_graph_admitted\",\"root_id\":\"root-gh\",\"graph_digest\":\"" ++ a ++
        "\",\"node_count\":1,\"graph_harness\":{\"api_version\":\"graph-harness/v1\",\"state\":\"prepared\",\"subject_digest\":\"" ++ b ++
        "\",\"transitive_digest\":\"" ++ c ++ "\",\"adapter\":\"adapter/v1\",\"bundle_ref\":\"cas:" ++ a ++
        "\",\"evaluation_policy\":\"policy/v1\"}}"
    );
    try std.testing.expect(ctx.err == null);
    try std.testing.expectEqualStrings(b, ctx.result.?.subject_digest);
    // A forged later row for the same exact graph cannot change its pins.
    graphHarnessIdentityLine(&ctx,
        "{\"event\":\"neuron_skill_graph_admitted\",\"root_id\":\"root-gh\",\"graph_digest\":\"" ++ a ++
        "\",\"graph_harness\":{\"api_version\":\"graph-harness/v1\",\"state\":\"prepared\",\"subject_digest\":\"" ++ c ++
        "\",\"transitive_digest\":\"" ++ b ++ "\",\"adapter\":\"adapter/v1\",\"bundle_ref\":\"cas:" ++ a ++
        "\",\"evaluation_policy\":\"policy/v1\"}}"
    );
    try std.testing.expectEqualStrings(b, ctx.result.?.subject_digest);

    var legacy: GraphHarnessIdentityScan = .{
        .allocator = arena.allocator(),
        .root_id = "root-legacy",
        .graph_digest = a,
    };
    graphHarnessIdentityLine(&legacy,
        "{\"event\":\"neuron_skill_graph_admitted\",\"root_id\":\"root-legacy\",\"graph_digest\":\"" ++ a ++ "\",\"node_count\":1}"
    );
    try std.testing.expect(legacy.found);
    try std.testing.expect(legacy.result == null);
    try std.testing.expect(legacy.err == null);
}

// POSIX process environ for tests that resolve the real ledger path; same
// PosixBlock pattern as c_abi.extEnv. Windows skips the file-backed test.
extern var environ: [*:null]const ?[*:0]const u8;

fn testEnv() std.process.Environ {
    if (@import("builtin").os.tag == .windows) return .{ .block = .global };
    var count: usize = 0;
    while (environ[count] != null) : (count += 1) {}
    const ptr: [*:null]const ?[*:0]const u8 = @ptrCast(environ);
    return .{ .block = .{ .slice = ptr[0..count :null] } };
}

const AdmittedCount = struct { count: usize = 0 };

fn countAdmittedLine(opaque_ctx: *anyopaque, line: []const u8) void {
    const ctx: *AdmittedCount = @ptrCast(@alignCast(opaque_ctx));
    if (std.mem.indexOf(u8, line, "\"neuron_skill_graph_admitted\"") != null) ctx.count += 1;
}

test "admitGraph streams dedupe past readAll's 16 MiB cap" {
    if (@import("builtin").os.tag == .windows) return error.SkipZigTest;
    const allocator = std.testing.allocator;
    const env = testEnv();

    const io = std.testing.io;
    var seed: [8]u8 = undefined;
    io.random(&seed);
    const abs = try std.fmt.allocPrint(allocator, "/tmp/libcontract-admit-{x}", .{seed});
    defer allocator.free(abs);
    const claude_dir = try std.fs.path.join(allocator, &.{ abs, ".claude" });
    defer allocator.free(claude_dir);
    const store_path = try std.fs.path.join(allocator, &.{ claude_dir, "contracts.jsonl" });
    defer allocator.free(store_path);
    try std.Io.Dir.createDirAbsolute(io, abs, .default_dir);
    try std.Io.Dir.createDirAbsolute(io, claude_dir, .default_dir);
    defer {
        var tmp_root = std.Io.Dir.openDirAbsolute(io, "/tmp", .{}) catch unreachable;
        defer tmp_root.close(io);
        tmp_root.deleteTree(io, std.fs.path.basename(abs)) catch {};
    }

    // 17 MiB of inert filler rows: past readAll's 16 MiB hard cap, and past
    // COMPACT_THRESHOLD so the lock-time compaction path runs too (filler is
    // a keep-row, so the store stays oversized and hysteresis must dedupe it).
    {
        const store = try std.Io.Dir.createFileAbsolute(io, store_path, .{});
        defer store.close(io);
        var block: [4096]u8 = undefined;
        const line = "{\"event\":\"filler\",\"pad\":\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"}\n";
        var off: usize = 0;
        while (off + line.len <= block.len) : (off += line.len)
            @memcpy(block[off .. off + line.len], line);
        var written: usize = 0;
        while (written < 17 * 1024 * 1024) : (written += off)
            try store.writeStreamingAll(io, block[0..off]);
    }

    var cwd_buf: [4096]u8 = undefined;
    const cwd_ptr = std.c.getcwd(&cwd_buf, cwd_buf.len) orelse return error.CwdFailed;
    const cwd_z = try allocator.dupeZ(u8, std.mem.span(@as([*:0]const u8, @ptrCast(cwd_ptr))));
    defer allocator.free(cwd_z);
    const abs_z = try allocator.dupeZ(u8, abs);
    defer allocator.free(abs_z);
    if (std.c.chdir(abs_z.ptr) != 0) return error.ChdirFailed;
    defer _ = std.c.chdir(cwd_z.ptr);

    const root = "root-16mib-witness";
    const digest_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const digest_b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    // The cap still rejects slurps — this test proves the admission hot path
    // no longer depends on one.
    try std.testing.expectError(error.LedgerTooLarge, ledger.readAll(allocator, env));

    // First admission appends; the exact same admission dedupes; a changed
    // graph for the same root supersedes. All streaming past the cap.
    try admitGraph(allocator, env, root, digest_a, 2);
    try admitGraph(allocator, env, root, digest_a, 2);
    var counter: AdmittedCount = .{};
    try ledger.forEachLine(allocator, env, &counter, countAdmittedLine);
    try std.testing.expectEqual(@as(usize, 1), counter.count);

    try admitGraph(allocator, env, root, digest_b, 3);
    counter.count = 0;
    try ledger.forEachLine(allocator, env, &counter, countAdmittedLine);
    try std.testing.expectEqual(@as(usize, 2), counter.count);

    // The streaming digest scan sees the latest digest for this root only.
    const latest = (try latestGraphDigestStreaming(allocator, env, root)).?;
    defer allocator.free(latest);
    try std.testing.expectEqualStrings(digest_b, latest);
    try std.testing.expect((try latestGraphDigestStreaming(allocator, env, "other-root")) == null);
}


test "GraphHarness node pins accept only exact Cell edge and builtin host adapters" {
    const a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const c = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const identity: GraphHarnessIdentity = .{ .api_version = "graph-harness/v1", .state = "prepared", .subject_digest = a, .transitive_digest = b, .adapter = "aiko.graph-harness-contract/v1", .bundle_ref = "cas:x", .evaluation_policy = "isolated-local-workspace-sandboxed-neuron/v1" };
    var node: Node = .{ .id = "node", .key = "aiko-meta-agent--act", .plan = "act", .action = "skill:x", .depends_on = &.{}, .bindings = &.{}, .evidence = &.{"action_result"}, .worker = "aiko", .adapter = "aiko.graph-harness-edge-model/v1", .script = null, .script_digest = null, .effect_scope = "local_reversible", .read_only = false, .reversible = true, .timeout_ms = 1, .skill_id = "aiko-meta-agent", .skill_version = "1.0.0", .authorization = "approved", .cell_digest = a, .witness_id = "act-witness", .witness_digest = b, .judge_digest = c };
    try std.testing.expect(validGraphHarnessNodePins(node, identity));
    node.worker = "host";
    try std.testing.expect(!validGraphHarnessNodePins(node, identity));
    node.key = "aiko-meta-agent--observe"; node.adapter = "aiko.meta.observe/v1"; node.effect_scope = "read_only"; node.read_only = true; node.reversible = false;
    try std.testing.expect(validGraphHarnessNodePins(node, identity));
    node.adapter = "aiko.meta.unknown/v1";
    try std.testing.expect(!validGraphHarnessNodePins(node, identity));
    node.adapter = "aiko.graph-harness-cell-v0/v1";
    try std.testing.expect(validGraphHarnessNodePins(node, identity));
}
