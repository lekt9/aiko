//! Contract substrate adapter for the canonical Typed Neuron wire core.
//!
//! The pure types, validation rules, and firing/decision identities are
//! imported from the sibling `typed_neuron` package. This file owns only JSON
//! ingress plus Contract's durable commit/replay boundary.

const std = @import("std");
const ledger = @import("ledger.zig");
const core = @import("typed_neuron");

pub const FIRE_SCHEMA = core.FIRE_SCHEMA;
pub const RESULT_SCHEMA = core.RESULT_SCHEMA;
pub const EFFECT_SETTLE_SCHEMA = "neuron.effect-settle/v1";
pub const EFFECT_SETTLE_RESULT_SCHEMA = "neuron.effect-settle-result/v1";
pub const ABI_VERSION: u32 = 12;

pub const Error = core.Error || error{
    FiringConflict,
    OutOfMemory,
    LedgerFailure,
    EffectNotFound,
    EffectConflict,
};

pub const NeuronIdentity = core.WireNeuronIdentity;
pub const Stimulus = core.WireStimulus;
pub const Caps = core.WireCaps;
pub const Control = core.WireControl;
pub const Effect = core.WireEffect;
pub const Evidence = core.Evidence;
pub const Decision = core.WireDecision;
pub const FireRequest = core.FireRequest;

pub const FireResult = struct {
    status: enum { committed, replayed },
    firing_id: [64]u8,
    decision_digest: [64]u8,
    effects_admitted: u64,
};

pub const Prepared = struct {
    result: FireResult,
    row: ?[]u8,
};

pub const EffectSettleRequest = struct {
    schema: []const u8,
    firing_id: []const u8,
    effect_index: u64,
    idempotency_key: []const u8,
    outcome: enum { committed, failed, reconciliation_required },
    evidence_digest: []const u8,
    observed_at_ms: u64,
};

const PriorScan = struct {
    firing_needle: []const u8,
    result: ?[64]u8 = null,
};

fn findPriorLine(opaque_ctx: *anyopaque, line: []const u8) void {
    const ctx: *PriorScan = @ptrCast(@alignCast(opaque_ctx));
    if (ctx.result != null) return;
    if (std.mem.indexOf(u8, line, "\"event\":\"neuron_fired\"") == null or
        std.mem.indexOf(u8, line, ctx.firing_needle) == null) return;
    const marker = "\"decision_digest\":\"";
    const start = (std.mem.indexOf(u8, line, marker) orelse return) + marker.len;
    const end = std.mem.indexOfScalarPos(u8, line, start, '"') orelse return;
    if (end - start != 64) return;
    var digest: [64]u8 = undefined;
    @memcpy(&digest, line[start..end]);
    ctx.result = digest;
}

pub fn prepare(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    request: FireRequest,
) Error!Prepared {
    try validate(request);
    const firing_id = firingId(request);
    const decision_digest = decisionDigest(request);
    var needle_buf: [96]u8 = undefined;
    const needle = std.fmt.bufPrint(
        &needle_buf,
        "\"firing_id\":\"{s}\"",
        .{&firing_id},
    ) catch return Error.OutOfMemory;
    var scan: PriorScan = .{ .firing_needle = needle };
    ledger.forEachLine(allocator, env, &scan, findPriorLine) catch
        return Error.LedgerFailure;
    if (scan.result) |prior| {
        if (!std.mem.eql(u8, &prior, &decision_digest)) return Error.FiringConflict;
        return .{
            .result = .{
                .status = .replayed,
                .firing_id = firing_id,
                .decision_digest = decision_digest,
                .effects_admitted = @intCast(request.decision.effects.len),
            },
            .row = null,
        };
    }
    return .{
        .result = .{
            .status = .committed,
            .firing_id = firing_id,
            .decision_digest = decision_digest,
            .effects_admitted = @intCast(request.decision.effects.len),
        },
        .row = encodeLedgerRow(allocator, request, &firing_id, &decision_digest) catch
            return Error.OutOfMemory,
    };
}

pub fn fireJson(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    request_json: []const u8,
) Error![]u8 {
    var parsed = std.json.parseFromSlice(FireRequest, allocator, request_json, .{
        .ignore_unknown_fields = false,
    }) catch return Error.InvalidJson;
    defer parsed.deinit();
    const lock = ledger.acquireExclusive(allocator, env) catch return Error.LedgerFailure;
    defer ledger.releaseExclusive(lock);
    const prepared = try prepare(allocator, env, parsed.value);
    if (prepared.row) |row| {
        defer allocator.free(row);
        const path = ledger.appendRow(allocator, env, row) catch return Error.LedgerFailure;
        allocator.free(path);
    }
    return encodeResult(allocator, prepared.result);
}

pub fn settleEffectJson(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    request_json: []const u8,
) Error![]u8 {
    var parsed = std.json.parseFromSlice(EffectSettleRequest, allocator, request_json, .{
        .ignore_unknown_fields = false,
    }) catch return Error.InvalidJson;
    defer parsed.deinit();
    const request = parsed.value;
    if (!std.mem.eql(u8, request.schema, EFFECT_SETTLE_SCHEMA) or
        !isDigest(request.firing_id) or
        !isDigest(request.evidence_digest) or
        request.idempotency_key.len == 0 or request.idempotency_key.len > 256 or
        request.observed_at_ms == 0) return Error.InvalidEffect;

    var firing_buf: [96]u8 = undefined;
    const firing = std.fmt.bufPrint(
        &firing_buf,
        "\"firing_id\":\"{s}\"",
        .{request.firing_id},
    ) catch return Error.InvalidEffect;
    var key_buf: [320]u8 = undefined;
    const key = std.fmt.bufPrint(
        &key_buf,
        "\"idempotency_key\":\"{s}\"",
        .{request.idempotency_key},
    ) catch return Error.InvalidEffect;
    var index_buf: [64]u8 = undefined;
    const index = std.fmt.bufPrint(
        &index_buf,
        "\"effect_index\":{d}",
        .{request.effect_index},
    ) catch return Error.InvalidEffect;

    const lock = ledger.acquireExclusive(allocator, env) catch return Error.LedgerFailure;
    defer ledger.releaseExclusive(lock);
    var scan: EffectSettleScan = .{ .firing = firing, .key = key, .index = index };
    ledger.forEachLine(allocator, env, &scan, effectSettleLine) catch
        return Error.LedgerFailure;
    if (!scan.admitted) return Error.EffectNotFound;
    const status: []const u8 = if (scan.outcome()) |prior|
        if (std.mem.eql(u8, prior, @tagName(request.outcome))) "replayed" else return Error.EffectConflict
    else blk: {
        const row = encodeEffectSettlement(allocator, request) catch return Error.OutOfMemory;
        defer allocator.free(row);
        const path = ledger.appendRow(allocator, env, row) catch return Error.LedgerFailure;
        allocator.free(path);
        break :blk "committed";
    };
    return std.fmt.allocPrint(
        allocator,
        "{{\"schema\":\"{s}\",\"abi_version\":{d},\"status\":\"{s}\"," ++
            "\"firing_id\":\"{s}\",\"effect_index\":{d},\"outcome\":\"{s}\"}}",
        .{
            EFFECT_SETTLE_RESULT_SCHEMA,
            ABI_VERSION,
            status,
            request.firing_id,
            request.effect_index,
            @tagName(request.outcome),
        },
    ) catch Error.OutOfMemory;
}

pub const validate = core.validate;
pub const firingId = core.firingId;
pub const decisionDigest = core.decisionDigest;

fn isDigest(value: []const u8) bool {
    if (value.len != 64) return false;
    for (value) |byte| if (!std.ascii.isHex(byte)) return false;
    return true;
}

const EffectSettleScan = struct {
    firing: []const u8,
    key: []const u8,
    index: []const u8,
    admitted: bool = false,
    outcome_buf: [32]u8 = undefined,
    outcome_len: usize = 0,

    fn outcome(self: *const EffectSettleScan) ?[]const u8 {
        if (self.outcome_len == 0) return null;
        return self.outcome_buf[0..self.outcome_len];
    }
};

fn effectSettleLine(opaque_ctx: *anyopaque, line: []const u8) void {
    const ctx: *EffectSettleScan = @ptrCast(@alignCast(opaque_ctx));
    if (std.mem.indexOf(u8, line, "\"event\":\"neuron_fired\"") != null and
        std.mem.indexOf(u8, line, ctx.firing) != null and
        std.mem.indexOf(u8, line, ctx.key) != null and
        std.mem.indexOf(u8, line, ctx.index) != null) ctx.admitted = true;
    if (ctx.outcome_len == 0 and
        std.mem.indexOf(u8, line, "\"event\":\"neuron_effect_settled\"") != null and
        std.mem.indexOf(u8, line, ctx.firing) != null and
        std.mem.indexOf(u8, line, ctx.index) != null)
    {
        const marker = "\"outcome\":\"";
        const start = (std.mem.indexOf(u8, line, marker) orelse return) + marker.len;
        const end = std.mem.indexOfScalarPos(u8, line, start, '"') orelse return;
        if (end - start > ctx.outcome_buf.len) return;
        @memcpy(ctx.outcome_buf[0 .. end - start], line[start..end]);
        ctx.outcome_len = end - start;
    }
}

fn encodeEffectSettlement(
    allocator: std.mem.Allocator,
    request: EffectSettleRequest,
) ![]u8 {
    var allocating: std.Io.Writer.Allocating = .init(allocator);
    errdefer allocating.deinit();
    var out = std.json.Stringify{ .writer = &allocating.writer };
    try out.beginObject();
    try out.objectField("event");
    try out.write("neuron_effect_settled");
    try out.objectField("schema");
    try out.write(EFFECT_SETTLE_SCHEMA);
    try out.objectField("firing_id");
    try out.write(request.firing_id);
    try out.objectField("effect_index");
    try out.write(request.effect_index);
    try out.objectField("idempotency_key");
    try out.write(request.idempotency_key);
    try out.objectField("outcome");
    try out.write(@tagName(request.outcome));
    try out.objectField("evidence_digest");
    try out.write(request.evidence_digest);
    try out.objectField("observed_at_ms");
    try out.write(request.observed_at_ms);
    try out.endObject();
    return allocating.toOwnedSlice();
}

fn encodeLedgerRow(
    allocator: std.mem.Allocator,
    request: FireRequest,
    firing_id: []const u8,
    decision_digest: []const u8,
) ![]u8 {
    var allocating: std.Io.Writer.Allocating = .init(allocator);
    errdefer allocating.deinit();
    var out = std.json.Stringify{ .writer = &allocating.writer };
    try out.beginObject();
    try out.objectField("event");
    try out.write("neuron_fired");
    try out.objectField("schema");
    try out.write(FIRE_SCHEMA);
    try out.objectField("firing_id");
    try out.write(firing_id);
    try out.objectField("decision_digest");
    try out.write(decision_digest);
    try out.objectField("neuron_id");
    try out.write(request.neuron.id);
    try out.objectField("neuron_version");
    try out.write(request.neuron.version);
    try out.objectField("neuron_digest");
    try out.write(request.neuron.digest);
    try out.objectField("stimulus_id");
    try out.write(request.stimulus.id);
    try out.objectField("stimulus_schema");
    try out.write(request.stimulus.schema);
    try out.objectField("stimulus_digest");
    try out.write(request.stimulus.payload_digest);
    try out.objectField("caps_fingerprint");
    try out.write(request.caps.fingerprint);
    try out.objectField("control");
    try out.write(request.decision.control.kind);
    try out.objectField("effects_admitted");
    try out.write(request.decision.effects.len);
    try out.objectField("evidence_count");
    try out.write(request.decision.evidence.len);
    try out.objectField("effect_outbox");
    try out.beginArray();
    for (request.decision.effects, 0..) |effect, index| {
        try out.beginObject();
        try out.objectField("effect_index");
        try out.write(index);
        try out.objectField("kind");
        try out.write(effect.kind);
        try out.objectField("target");
        try out.write(effect.target);
        try out.objectField("schema");
        try out.write(effect.schema);
        try out.objectField("payload_digest");
        try out.write(effect.payload_digest);
        try out.objectField("bytes");
        try out.write(effect.bytes);
        try out.objectField("idempotency_key");
        try out.write(effect.idempotency_key);
        try out.objectField("status");
        try out.write("pending");
        try out.endObject();
    }
    try out.endArray();
    try out.endObject();
    return allocating.toOwnedSlice();
}

fn encodeResult(allocator: std.mem.Allocator, result: FireResult) Error![]u8 {
    return std.fmt.allocPrint(
        allocator,
        "{{\"schema\":\"{s}\",\"abi_version\":{d},\"status\":\"{s}\"," ++
            "\"firing_id\":\"{s}\",\"decision_digest\":\"{s}\",\"effects_admitted\":{d}}}",
        .{
            RESULT_SCHEMA,
            ABI_VERSION,
            @tagName(result.status),
            &result.firing_id,
            &result.decision_digest,
            result.effects_admitted,
        },
    ) catch return Error.OutOfMemory;
}

test "Contract adapter imports the canonical typed-neuron wire core" {
    try std.testing.expectEqualStrings("typed-neuron/2", core.CORE_VERSION);
    try std.testing.expectEqualStrings("deterministic-cbor-sha256/1", core.HASH_PROFILE);
    try std.testing.expectEqualStrings(core.FIRE_SCHEMA, FIRE_SCHEMA);
    try std.testing.expect(FireRequest == core.FireRequest);
    try std.testing.expect(Evidence == core.Evidence);
}

test "outbox acknowledgements bind to one admitted effect and replay outcome" {
    const request: EffectSettleRequest = .{
        .schema = EFFECT_SETTLE_SCHEMA,
        .firing_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        .effect_index = 0,
        .idempotency_key = "tool-call-1",
        .outcome = .committed,
        .evidence_digest = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        .observed_at_ms = 1,
    };
    const firing_line =
        "{\"event\":\"neuron_fired\",\"firing_id\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"," ++
        "\"effect_outbox\":[{\"effect_index\":0,\"idempotency_key\":\"tool-call-1\",\"status\":\"pending\"}]}";
    var scan: EffectSettleScan = .{
        .firing = "\"firing_id\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"",
        .key = "\"idempotency_key\":\"tool-call-1\"",
        .index = "\"effect_index\":0",
    };
    effectSettleLine(&scan, firing_line);
    try std.testing.expect(scan.admitted);

    var wrong: EffectSettleScan = .{
        .firing = scan.firing,
        .key = scan.key,
        .index = "\"effect_index\":1",
    };
    effectSettleLine(&wrong, firing_line);
    try std.testing.expect(!wrong.admitted);

    const row = try encodeEffectSettlement(std.testing.allocator, request);
    defer std.testing.allocator.free(row);
    effectSettleLine(&scan, row);
    try std.testing.expectEqualStrings("committed", scan.outcome().?);
}
