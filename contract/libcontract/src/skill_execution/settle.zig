//! Validate and durably settle one leased typed Skill firing.

const std = @import("std");
const artifact = @import("../artifact.zig");
const common = @import("common.zig");
const ledger = @import("../ledger.zig");
const neuron = @import("../neuron.zig");

pub const SETTLE_SCHEMA = "contract.neuron-skill-node.settle/v1";
pub const SETTLE_RESULT_SCHEMA = "contract.neuron-skill-node.settle-result/v1";

fn canonicalEvidence(
    allocator: std.mem.Allocator,
    evidence: std.json.Value,
    requirements: []const []const u8,
    satisfied: bool,
) common.Error![]u8 {
    if (evidence != .object) return common.Error.EvidenceMismatch;
    if (!satisfied) return allocator.dupe(u8, "{}") catch common.Error.OutOfMemory;
    if (evidence.object.count() != requirements.len) return common.Error.EvidenceMismatch;
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    out.append(allocator, '{') catch return common.Error.OutOfMemory;
    for (requirements, 0..) |requirement, index| {
        const value = evidence.object.get(requirement) orelse
            return common.Error.EvidenceMismatch;
        if (index > 0) out.append(allocator, ',') catch return common.Error.OutOfMemory;
        common.appendJsonString(&out, allocator, requirement) catch
            return common.Error.OutOfMemory;
        out.append(allocator, ':') catch return common.Error.OutOfMemory;
        common.appendJsonValue(&out, allocator, value) catch return common.Error.OutOfMemory;
    }
    out.append(allocator, '}') catch return common.Error.OutOfMemory;
    return out.toOwnedSlice(allocator) catch common.Error.OutOfMemory;
}

fn appendEffect(
    effects: *[2]neuron.Effect,
    count: *usize,
    kind: []const u8,
    target: []const u8,
    payload_digest: []const u8,
    bytes: u64,
    idempotency_key: []const u8,
) void {
    effects[count.*] = .{
        .kind = kind,
        .target = target,
        .schema = "contract.neuron-skill-node-effect/v1",
        .payload_digest = payload_digest,
        .bytes = bytes,
        .idempotency_key = idempotency_key,
    };
    count.* += 1;
}

pub fn settleJson(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    request_json: []const u8,
) common.Error![]u8 {
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, request_json, .{}) catch
        return common.Error.InvalidJson;
    defer parsed.deinit();
    if (parsed.value != .object) return common.Error.InvalidJson;
    const request = parsed.value.object;
    if (!std.mem.eql(u8, common.objectString(request, "schema") orelse "", SETTLE_SCHEMA))
        return common.Error.UnsupportedSchema;
    const root_id = common.objectString(request, "root_id") orelse
        return common.Error.InvalidRequest;
    const occurrence = common.objectString(request, "root_occurrence") orelse
        return common.Error.InvalidRequest;
    const owner = common.objectString(request, "owner") orelse
        return common.Error.InvalidRequest;
    const execution_id = common.objectString(request, "execution_id") orelse
        return common.Error.InvalidRequest;
    const outcome_name = common.objectString(request, "outcome") orelse
        return common.Error.InvalidRequest;
    const outcome = std.meta.stringToEnum(common.Outcome, outcome_name) orelse
        return common.Error.InvalidRequest;
    const attempt_raw = common.objectInt(request, "attempt") orelse
        return common.Error.InvalidRequest;
    const now_raw = common.objectInt(request, "now_ms") orelse
        return common.Error.InvalidRequest;
    if (!common.safeToken(root_id) or !common.safeToken(occurrence) or
        !common.safeToken(owner) or !artifact.validDigest(execution_id) or
        attempt_raw <= 0 or attempt_raw > std.math.maxInt(u32) or now_raw <= 0 or
        outcome == .none) return common.Error.InvalidRequest;
    const attempt: u32 = @intCast(attempt_raw);
    const now_ms: u64 = @intCast(now_raw);
    const evidence_value = request.get("evidence") orelse
        return common.Error.EvidenceMismatch;
    const detail = common.objectString(request, "detail") orelse "";
    const decision_value = request.get("decision") orelse
        return common.Error.InvalidRequest;
    var parsed_decision = std.json.parseFromValue(
        neuron.Decision,
        allocator,
        decision_value,
        .{ .ignore_unknown_fields = false },
    ) catch return common.Error.InvalidJson;
    defer parsed_decision.deinit();

    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const scratch = arena.allocator();
    const lock = ledger.acquireExclusive(allocator, env) catch
        return common.Error.LedgerFailure;
    var lock_held = true;
    defer if (lock_held) ledger.releaseExclusive(lock);
    const graph_digest = (common.latestGraphDigestStreaming(scratch, env, root_id) catch
        return common.Error.LedgerFailure) orelse return common.Error.GraphMissing;
    const nodes = try common.loadNodesStreaming(scratch, env, root_id, graph_digest);
    const execution_ids = scratch.alloc([64]u8, nodes.len) catch
        return common.Error.OutOfMemory;
    var node_index: ?usize = null;
    for (nodes, 0..) |node, index| {
        execution_ids[index] = common.executionId(root_id, occurrence, graph_digest, node.id);
        if (std.mem.eql(u8, &execution_ids[index], execution_id)) node_index = index;
    }
    const index = node_index orelse return common.Error.NodeMissing;
    const states = scratch.alloc(common.NodeState, nodes.len) catch
        return common.Error.OutOfMemory;
    @memset(states, .{});
    try common.scanStatesStreaming(scratch, env, execution_ids, states);
    const state = states[index];
    const owner_digest = common.hashFields(&.{
        "contract.neuron-skill-node.owner/v1",
        owner,
    });
    const canonical = try canonicalEvidence(
        allocator,
        evidence_value,
        nodes[index].evidence,
        outcome == .satisfied,
    );
    defer allocator.free(canonical);
    if (canonical.len == 0 or canonical.len > artifact.MAX_BYTES or
        artifact.containsSensitiveMaterial(canonical)) return common.Error.ArtifactFailure;
    const evidence_digest = artifact.digest(canonical);
    if (state.outcome != .none) {
        if (state.attempt == attempt and state.outcome == outcome and
            state.evidence_digest != null and state.firing_id != null and
            std.mem.eql(u8, &state.evidence_digest.?, &evidence_digest))
            return encodeSettleResult(
                allocator,
                "replayed",
                execution_id,
                outcome_name,
                &evidence_digest,
                &state.firing_id.?,
            );
        return common.Error.FiringConflict;
    }
    if (state.attempt != attempt or state.owner_digest == null or
        !std.mem.eql(u8, &state.owner_digest.?, &owner_digest) or
        state.lease_until_ms <= now_ms) return common.Error.LeaseConflict;
    ledger.releaseExclusive(lock);
    lock_held = false;

    const read_digests = scratch.alloc([]const u8, nodes[index].depends_on.len) catch
        return common.Error.OutOfMemory;
    for (nodes[index].depends_on, 0..) |dependency, dep_index| {
        const dependency_index = common.nodeIndex(nodes, dependency) orelse
            return common.Error.EvidenceMismatch;
        read_digests[dep_index] = &(states[dependency_index].evidence_digest orelse
            return common.Error.EvidenceMismatch);
    }
    const neuron_digest = common.hashFields(&.{
        "contract.neuron-skill-node.identity/v1",
        graph_digest,
        nodes[index].action,
        nodes[index].id,
        nodes[index].adapter orelse "",
        nodes[index].script_digest orelse "",
    });
    const payload_digest = common.hashFields(&.{
        "contract.neuron-skill-node.stimulus/v1",
        execution_id,
        std.fmt.allocPrint(scratch, "{d}", .{attempt}) catch
            return common.Error.OutOfMemory,
    });
    const caps_fingerprint = common.hashFields(&.{
        "contract.neuron-skill-node.caps/v1",
        nodes[index].effect_scope,
        if (nodes[index].read_only) "read_only" else "effectful",
        if (nodes[index].reversible) "reversible" else "irreversible",
    });
    var effects: [2]neuron.Effect = undefined;
    var effect_count: usize = 0;
    appendEffect(
        &effects,
        &effect_count,
        "write",
        std.fmt.allocPrint(scratch, "artifact:{s}", .{&evidence_digest}) catch
            return common.Error.OutOfMemory,
        &evidence_digest,
        @intCast(canonical.len),
        std.fmt.allocPrint(
            scratch,
            "{s}/{d}/0",
            .{ execution_id, attempt },
        ) catch return common.Error.OutOfMemory,
    );
    if (outcome == .satisfied and !nodes[index].read_only) {
        const effect_kind = if (std.mem.eql(u8, nodes[index].effect_scope, "external_message") or
            std.mem.eql(u8, nodes[index].effect_scope, "publish"))
            "send"
        else if (std.mem.eql(u8, nodes[index].effect_scope, "process_spawn"))
            "spawn"
        else
            "write";
        appendEffect(
            &effects,
            &effect_count,
            effect_kind,
            std.fmt.allocPrint(scratch, "scope:{s}", .{nodes[index].effect_scope}) catch
                return common.Error.OutOfMemory,
            &evidence_digest,
            0,
            std.fmt.allocPrint(
                scratch,
                "{s}/{d}/1",
                .{ execution_id, attempt },
            ) catch return common.Error.OutOfMemory,
        );
    }
    var cap_kinds: [3][]const u8 = undefined;
    var cap_count: usize = 0;
    for (effects[0..effect_count]) |effect| {
        var seen = false;
        for (cap_kinds[0..cap_count]) |kind| {
            if (std.mem.eql(u8, kind, effect.kind)) {
                seen = true;
                break;
            }
        }
        if (!seen) {
            cap_kinds[cap_count] = effect.kind;
            cap_count += 1;
        }
    }
    const source = [_][]const u8{&payload_digest};
    const evidence = [_]neuron.Evidence{.{
        .claim = "typed Skill node returned its declared evidence shape",
        .sources = &source,
        .method = "Aiko Neuron execution adapter",
        .digest = &evidence_digest,
        .producer = std.fmt.allocPrint(
            scratch,
            "skill/{s}/{s}",
            .{ nodes[index].skill_id, nodes[index].key },
        ) catch return common.Error.OutOfMemory,
        .observed_at_ms = now_ms,
        .confidence_milli = if (outcome == .satisfied) 1000 else 0,
    }};
    const expected_decision: neuron.Decision = .{
        .control = .{ .kind = "continue", .value = outcome_name },
        .effects = effects[0..effect_count],
        .evidence = &evidence,
    };
    const fire_request: neuron.FireRequest = .{
        .schema = neuron.FIRE_SCHEMA,
        .neuron = .{
            .id = std.fmt.allocPrint(
                scratch,
                "skill/{s}/{s}",
                .{ nodes[index].skill_id, nodes[index].key },
            ) catch return common.Error.OutOfMemory,
            .version = nodes[index].skill_version,
            .digest = &neuron_digest,
        },
        .stimulus = .{
            .id = std.fmt.allocPrint(
                scratch,
                "node-{s}-{d}",
                .{ execution_id[0..16], attempt },
            ) catch return common.Error.OutOfMemory,
            .schema = "contract.neuron-skill-node/v1",
            .payload_digest = &payload_digest,
            .read_digests = read_digests,
            .now_ms = now_ms,
            .deadline_ms = state.lease_until_ms,
            .adapter_versions = &.{std.fmt.allocPrint(
                scratch,
                "aiko/{s}/{s}",
                .{ @import("typed_neuron").CORE_VERSION, @import("typed_neuron").SCHEMA_DIGEST },
            ) catch return common.Error.OutOfMemory},
        },
        .caps = .{
            .schema = @import("typed_neuron").CAPS_SCHEMA,
            .fingerprint = &caps_fingerprint,
            .effects = cap_kinds[0..cap_count],
            .max_effects = @intCast(effect_count),
            .max_bytes = artifact.MAX_BYTES,
        },
        .decision = parsed_decision.value,
    };
    var expected_request = fire_request;
    expected_request.decision = expected_decision;
    if (!std.mem.eql(
        u8,
        &neuron.decisionDigest(fire_request),
        &neuron.decisionDigest(expected_request),
    )) return common.Error.EvidenceMismatch;
    const firing_id = neuron.firingId(fire_request);

    const settle_lock = ledger.acquireExclusive(allocator, env) catch
        return common.Error.LedgerFailure;
    var settle_lock_held = true;
    defer if (settle_lock_held) ledger.releaseExclusive(settle_lock);
    @memset(states, .{});
    try common.scanStatesStreaming(scratch, env, execution_ids, states);
    if (states[index].outcome != .none) {
        if (states[index].attempt == attempt and states[index].outcome == outcome and
            states[index].evidence_digest != null and
            std.mem.eql(u8, &states[index].evidence_digest.?, &evidence_digest))
            return encodeSettleResult(
                allocator,
                "replayed",
                execution_id,
                outcome_name,
                &evidence_digest,
                &firing_id,
            );
        return common.Error.FiringConflict;
    }
    const prepared = neuron.prepare(allocator, env, fire_request) catch |err| switch (err) {
        error.FiringConflict => return common.Error.FiringConflict,
        else => return common.Error.InvalidRequest,
    };
    defer if (prepared.row) |fire_row| allocator.free(fire_row);
    if (!std.mem.eql(u8, &firing_id, &prepared.result.firing_id))
        return common.Error.FiringConflict;
    const detail_digest = artifact.digest(detail);
    const row = std.fmt.allocPrint(
        allocator,
        "{{\"event\":\"neuron_skill_node_settled\",\"execution_id\":\"{s}\"," ++
            "\"root_id\":\"{s}\",\"graph_digest\":\"{s}\",\"node_id\":\"{s}\"," ++
            "\"attempt\":{d},\"outcome\":\"{s}\",\"evidence_digest\":\"{s}\"," ++
            "\"evidence_bytes\":{d},\"evidence_payload\":{s}," ++
            "\"detail_digest\":\"{s}\",\"firing_id\":\"{s}\"}}",
        .{
            execution_id,
            root_id,
            graph_digest,
            nodes[index].id,
            attempt,
            outcome_name,
            &evidence_digest,
            canonical.len,
            canonical,
            &detail_digest,
            &firing_id,
        },
    ) catch return common.Error.OutOfMemory;
    defer allocator.free(row);
    var rows: [2][]const u8 = undefined;
    var row_count: usize = 0;
    if (prepared.row) |fire_row| {
        rows[row_count] = fire_row;
        row_count += 1;
    }
    rows[row_count] = row;
    row_count += 1;
    const path = ledger.appendRowsAtomic(allocator, env, rows[0..row_count]) catch
        return common.Error.LedgerFailure;
    allocator.free(path);
    ledger.releaseExclusive(settle_lock);
    settle_lock_held = false;
    // The transaction row is the authoritative artifact commit. This file is
    // only a content-addressed read cache; a crash here is repaired by
    // artifact.read reconstructing the bytes from the committed row.
    _ = artifact.put(allocator, env, canonical) catch {};
    return encodeSettleResult(
        allocator,
        "committed",
        execution_id,
        outcome_name,
        &evidence_digest,
        &firing_id,
    );
}

fn encodeSettleResult(
    allocator: std.mem.Allocator,
    status: []const u8,
    execution_id: []const u8,
    outcome: []const u8,
    evidence_digest: []const u8,
    firing_id: []const u8,
) common.Error![]u8 {
    return std.fmt.allocPrint(
        allocator,
        "{{\"schema\":\"{s}\",\"abi_version\":{d},\"status\":\"{s}\"," ++
            "\"execution_id\":\"{s}\",\"outcome\":\"{s}\",\"evidence_digest\":\"{s}\"," ++
            "\"firing_id\":\"{s}\"}}",
        .{
            SETTLE_RESULT_SCHEMA,
            neuron.ABI_VERSION,
            status,
            execution_id,
            outcome,
            evidence_digest,
            firing_id,
        },
    ) catch common.Error.OutOfMemory;
}

test "canonical evidence requires exactly the declared output names" {
    var parsed = try std.json.parseFromSlice(
        std.json.Value,
        std.testing.allocator,
        "{\"answer\":42}",
        .{},
    );
    defer parsed.deinit();
    const encoded = try canonicalEvidence(
        std.testing.allocator,
        parsed.value,
        &.{"answer"},
        true,
    );
    defer std.testing.allocator.free(encoded);
    try std.testing.expectEqualStrings("{\"answer\":42}", encoded);
    try std.testing.expectError(
        common.Error.EvidenceMismatch,
        canonicalEvidence(std.testing.allocator, parsed.value, &.{"missing"}, true),
    );
}
