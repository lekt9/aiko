//! Lease dependency-ready firings from the current admitted Skill graph.

const std = @import("std");
const common = @import("common.zig");
const ledger = @import("../ledger.zig");
const neuron = @import("../neuron.zig");

pub const CLAIM_SCHEMA = "contract.neuron-skill-node.claim/v1";
pub const CLAIM_RESULT_SCHEMA = "contract.neuron-skill-node.claim-result/v1";

/// The kernel sandbox profile a claimed node's executor must run under.
///
/// This used to be `if (node.read_only) "read-only" else "strict"` — a function
/// of one boolean that ignored the node's declared `effect_scope` entirely.
/// Both of those profiles deny the network, so a node declared
/// `local_reversible` (the acting node of every skill graph — the one whose
/// whole job is to change something) was handed a network-denied sandbox and
/// could not run installs, fetches, or any API-backed step. The node kept its
/// authority on paper and lost it in the kernel, which surfaces as an
/// orchestration that plans work and then completes none of it.
///
/// The scope a node declared is the scope it gets:
///   - `read_only`                       → `read-only`  (no writes, no network)
///   - `local_reversible` / `local_write` → `workspace` (workspace writes, no network)
///   - anything reaching outside this machine (`external_message`, `publish`,
///     `account_mutation`, `permission_change`, `network_*`) → `devbox`, which
///     permits the egress those effects are by definition made of.
/// An unrecognised scope keeps the old conservative `strict`.
fn sandboxProfile(node: anytype) []const u8 {
    if (node.read_only or std.mem.eql(u8, node.effect_scope, "read_only")) {
        return "read-only";
    }
    if (std.mem.eql(u8, node.effect_scope, "local_reversible") or
        std.mem.eql(u8, node.effect_scope, "local_write"))
    {
        return "workspace";
    }
    if (std.mem.eql(u8, node.effect_scope, "external_message") or
        std.mem.eql(u8, node.effect_scope, "publish") or
        std.mem.eql(u8, node.effect_scope, "account_mutation") or
        std.mem.eql(u8, node.effect_scope, "permission_change") or
        std.mem.eql(u8, node.effect_scope, "network_read") or
        std.mem.eql(u8, node.effect_scope, "network_mutation"))
    {
        return "devbox";
    }
    return "strict";
}

const ClaimRequest = struct {
    schema: []const u8,
    root_id: []const u8,
    root_occurrence: []const u8,
    owner: []const u8,
    now_ms: u64,
    lease_ms: u64,
    max_nodes: usize,
};

pub fn claimJson(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    request_json: []const u8,
) common.Error![]u8 {
    var parsed = std.json.parseFromSlice(ClaimRequest, allocator, request_json, .{
        .ignore_unknown_fields = false,
    }) catch return common.Error.InvalidJson;
    defer parsed.deinit();
    const request = parsed.value;
    if (!std.mem.eql(u8, request.schema, CLAIM_SCHEMA)) return common.Error.UnsupportedSchema;
    if (!common.safeToken(request.root_id) or !common.safeToken(request.root_occurrence) or
        !common.safeToken(request.owner) or request.now_ms == 0 or request.lease_ms == 0 or
        request.max_nodes == 0 or request.max_nodes > common.MAX_NODES)
        return common.Error.InvalidRequest;

    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const scratch = arena.allocator();
    const lock = ledger.acquireExclusive(allocator, env) catch return common.Error.LedgerFailure;
    defer ledger.releaseExclusive(lock);
    const graph_digest = (common.latestGraphDigestStreaming(scratch, env, request.root_id) catch
        return common.Error.LedgerFailure) orelse return common.Error.GraphMissing;
    const nodes = try common.loadNodesStreaming(scratch, env, request.root_id, graph_digest);
    const execution_ids = scratch.alloc([64]u8, nodes.len) catch
        return common.Error.OutOfMemory;
    for (nodes, 0..) |node, index| {
        execution_ids[index] = common.executionId(
            request.root_id,
            request.root_occurrence,
            graph_digest,
            node.id,
        );
    }
    const states = scratch.alloc(common.NodeState, nodes.len) catch
        return common.Error.OutOfMemory;
    @memset(states, .{});
    try common.scanStatesStreaming(scratch, env, execution_ids, states);

    var eligible: [common.MAX_NODES]usize = undefined;
    var eligible_count: usize = 0;
    var all_satisfied = true;
    var failed = false;
    var held = false;
    for (nodes, states, 0..) |node, state, index| {
        if (state.outcome != .satisfied) all_satisfied = false;
        if (state.outcome == .died or
            (state.outcome == .retry and state.attempt >= common.MAX_ATTEMPTS)) failed = true;
        if (!std.mem.eql(u8, node.authorization, "approved")) {
            if (state.outcome != .satisfied) held = true;
            continue;
        }
        if (state.outcome == .satisfied or state.outcome == .died or
            state.attempt >= common.MAX_ATTEMPTS or state.lease_until_ms > request.now_ms or
            !common.dependenciesSatisfied(nodes, states, node)) continue;
        if (eligible_count < request.max_nodes) {
            eligible[eligible_count] = index;
            eligible_count += 1;
        }
    }

    const status = if (all_satisfied) "complete" else if (failed) "failed" else if (eligible_count > 0)
        "wave"
    else if (held)
        "held"
    else
        "waiting";
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    out.print(
        allocator,
        "{{\"schema\":\"{s}\",\"abi_version\":{d},\"status\":\"{s}\",\"root_id\":",
        .{ CLAIM_RESULT_SCHEMA, neuron.ABI_VERSION, status },
    ) catch return common.Error.OutOfMemory;
    common.appendJsonString(&out, allocator, request.root_id) catch
        return common.Error.OutOfMemory;
    out.appendSlice(allocator, ",\"graph_digest\":") catch return common.Error.OutOfMemory;
    common.appendJsonString(&out, allocator, graph_digest) catch
        return common.Error.OutOfMemory;
    out.appendSlice(allocator, ",\"terminal_evidence\":") catch
        return common.Error.OutOfMemory;
    if (all_satisfied) {
        try common.appendTerminalEvidence(&out, allocator, env, nodes, states);
    } else {
        out.appendSlice(allocator, "null") catch return common.Error.OutOfMemory;
    }
    out.appendSlice(allocator, ",\"nodes\":[") catch return common.Error.OutOfMemory;
    const lease_until = std.math.add(u64, request.now_ms, request.lease_ms) catch
        std.math.maxInt(u64);
    const owner_digest = common.hashFields(&.{
        "contract.neuron-skill-node.owner/v1",
        request.owner,
    });
    for (eligible[0..eligible_count], 0..) |node_index, output_index| {
        const node = nodes[node_index];
        const attempt = states[node_index].attempt + 1;
        const row = std.fmt.allocPrint(
            scratch,
            "{{\"event\":\"neuron_skill_node_claimed\",\"execution_id\":\"{s}\"," ++
                "\"root_id\":\"{s}\",\"graph_digest\":\"{s}\",\"node_id\":\"{s}\"," ++
                "\"attempt\":{d},\"owner_digest\":\"{s}\",\"lease_until_ms\":{d}}}",
            .{
                &execution_ids[node_index],
                request.root_id,
                graph_digest,
                node.id,
                attempt,
                &owner_digest,
                lease_until,
            },
        ) catch return common.Error.OutOfMemory;
        const path = ledger.appendRow(allocator, env, row) catch
            return common.Error.LedgerFailure;
        allocator.free(path);
        if (output_index > 0) out.append(allocator, ',') catch
            return common.Error.OutOfMemory;
        out.appendSlice(allocator, "{\"execution_id\":") catch
            return common.Error.OutOfMemory;
        common.appendJsonString(&out, allocator, &execution_ids[node_index]) catch
            return common.Error.OutOfMemory;
        out.print(allocator, ",\"attempt\":{d},\"node_id\":", .{attempt}) catch
            return common.Error.OutOfMemory;
        common.appendJsonString(&out, allocator, node.id) catch
            return common.Error.OutOfMemory;
        for ([_]struct { label: []const u8, value: []const u8 }{
            .{ .label = "key", .value = node.key },
            .{ .label = "plan", .value = node.plan },
            .{ .label = "action", .value = node.action },
            .{ .label = "worker", .value = node.worker },
            .{ .label = "effect_scope", .value = node.effect_scope },
            .{ .label = "skill_id", .value = node.skill_id },
            .{ .label = "skill_version", .value = node.skill_version },
        }) |field| {
            out.print(allocator, ",\"{s}\":", .{field.label}) catch
                return common.Error.OutOfMemory;
            common.appendJsonString(&out, allocator, field.value) catch
                return common.Error.OutOfMemory;
        }
        out.appendSlice(allocator, ",\"adapter\":") catch return common.Error.OutOfMemory;
        if (node.adapter) |adapter| {
            common.appendJsonString(&out, allocator, adapter) catch
                return common.Error.OutOfMemory;
        } else {
            out.appendSlice(allocator, "null") catch return common.Error.OutOfMemory;
        }
        out.appendSlice(allocator, ",\"script\":") catch return common.Error.OutOfMemory;
        if (node.script) |script| {
            common.appendJsonString(&out, allocator, script) catch
                return common.Error.OutOfMemory;
        } else {
            out.appendSlice(allocator, "null") catch return common.Error.OutOfMemory;
        }
        out.appendSlice(allocator, ",\"script_digest\":") catch
            return common.Error.OutOfMemory;
        if (node.script_digest) |digest| {
            common.appendJsonString(&out, allocator, digest) catch
                return common.Error.OutOfMemory;
        } else {
            out.appendSlice(allocator, "null") catch return common.Error.OutOfMemory;
        }
        out.print(
            allocator,
            ",\"read_only\":{s},\"reversible\":{s},\"timeout_ms\":{d},\"sandbox\":\"{s}\",\"inputs\":",
            .{
                if (node.read_only) "true" else "false",
                if (node.reversible) "true" else "false",
                node.timeout_ms,
                sandboxProfile(node),
            },
        ) catch return common.Error.OutOfMemory;
        try common.appendInputs(&out, allocator, env, node, nodes, states);
        out.appendSlice(allocator, ",\"evidence_requirements\":[") catch
            return common.Error.OutOfMemory;
        for (node.evidence, 0..) |requirement, evidence_index| {
            if (evidence_index > 0) out.append(allocator, ',') catch
                return common.Error.OutOfMemory;
            common.appendJsonString(&out, allocator, requirement) catch
                return common.Error.OutOfMemory;
        }
        out.appendSlice(allocator, "]}") catch return common.Error.OutOfMemory;
    }
    out.appendSlice(allocator, "]}") catch return common.Error.OutOfMemory;
    return out.toOwnedSlice(allocator) catch common.Error.OutOfMemory;
}
