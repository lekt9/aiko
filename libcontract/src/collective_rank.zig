//! Deterministic public-candidate ranking for the Aiko Collective.
//!
//! Aiko retrieves candidates and computes bounded semantic affinity features.
//! Contract combines those features with public evidence using integer-only
//! arithmetic. Private task text, credentials, and execution remain outside.

const std = @import("std");
const collective_object = @import("collective_object.zig");

pub const Error = error{
    InputTooLarge,
    InvalidJson,
    InvalidRoot,
    InvalidCandidate,
    TooManyCandidates,
    OutOfMemory,
};

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_CANDIDATES = 4096;

const Ranked = struct {
    object_id: []const u8,
    score_bps: u16,
    status: enum { ranked, unavailable, revoked },
    semantic_score_bps: u16,
    reliability_bps: u16,
    independence_bps: u16,
    freshness_bps: u16,
    latency_penalty_bps: u16,
    version_match: bool,
};

fn int(object: std.json.ObjectMap, key: []const u8, max: u64) Error!u64 {
    const value = object.get(key) orelse return Error.InvalidCandidate;
    const raw = switch (value) {
        .integer => |number| number,
        else => return Error.InvalidCandidate,
    };
    if (raw < 0 or raw > @as(i64, @intCast(max))) return Error.InvalidCandidate;
    return @intCast(raw);
}

fn boolean(object: std.json.ObjectMap, key: []const u8) Error!bool {
    const value = object.get(key) orelse return Error.InvalidCandidate;
    return switch (value) {
        .bool => |flag| flag,
        else => Error.InvalidCandidate,
    };
}

fn string(object: std.json.ObjectMap, key: []const u8) Error![]const u8 {
    const value = object.get(key) orelse return Error.InvalidCandidate;
    return switch (value) {
        .string => |text| text,
        else => Error.InvalidCandidate,
    };
}

fn reliability(success: u64, failure: u64) u16 {
    const total = success + failure;
    if (total == 0) return 5000;
    return @intCast(@min(@as(u64, 10000), (success * 10000) / total));
}

fn freshness(age_seconds: u64) u16 {
    if (age_seconds <= 86400) return 10000;
    if (age_seconds <= 7 * 86400) return 7000;
    if (age_seconds <= 30 * 86400) return 3000;
    return 0;
}

fn latencyPenalty(latency_ms: u64) u16 {
    if (latency_ms <= 100) return 0;
    return @intCast(@min(@as(u64, 1000), (latency_ms - 100) / 10));
}

fn lessThan(_: void, lhs: Ranked, rhs: Ranked) bool {
    if (lhs.score_bps != rhs.score_bps) return lhs.score_bps > rhs.score_bps;
    return std.mem.order(u8, lhs.object_id, rhs.object_id) == .lt;
}

fn appendString(allocator: std.mem.Allocator, out: *std.ArrayList(u8), value: []const u8) Error!void {
    var allocating: std.Io.Writer.Allocating = .init(allocator);
    defer allocating.deinit();
    var stringify = std.json.Stringify{ .writer = &allocating.writer };
    stringify.write(value) catch return Error.InvalidCandidate;
    out.appendSlice(allocator, allocating.writer.buffered()) catch return Error.OutOfMemory;
}

pub fn rank(allocator: std.mem.Allocator, candidates_json: []const u8, limit: usize) Error![]u8 {
    if (candidates_json.len == 0 or candidates_json.len > MAX_INPUT_BYTES) return Error.InputTooLarge;
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, candidates_json, .{
        .max_value_len = MAX_INPUT_BYTES,
        .allocate = .alloc_always,
    }) catch return Error.InvalidJson;
    defer parsed.deinit();
    const candidates = switch (parsed.value) {
        .array => |array| array,
        else => return Error.InvalidRoot,
    };
    if (candidates.items.len > MAX_CANDIDATES) return Error.TooManyCandidates;
    var ranked: std.ArrayList(Ranked) = .empty;
    defer ranked.deinit(allocator);
    for (candidates.items) |candidate_value| {
        const candidate = switch (candidate_value) {
            .object => |object| object,
            else => return Error.InvalidCandidate,
        };
        if (candidate.count() != 11) return Error.InvalidCandidate;
        const object_id = try string(candidate, "object_id");
        if (!collective_object.isObjectId(object_id)) return Error.InvalidCandidate;
        const semantic: u16 = @intCast(try int(candidate, "semantic_score_bps", 10000));
        const capability_version = try string(candidate, "capability_version");
        const evidence_version = try string(candidate, "evidence_version");
        if (capability_version.len == 0 or capability_version.len > 64 or evidence_version.len == 0 or evidence_version.len > 64)
            return Error.InvalidCandidate;
        const successes = try int(candidate, "success_count", 1000000000);
        const failures = try int(candidate, "failure_count", 1000000000);
        const publishers = try int(candidate, "independent_publishers", 1000000);
        const age = try int(candidate, "freshness_seconds", 3155760000);
        const latency = try int(candidate, "latency_bucket_ms", 60000);
        const revoked = try boolean(candidate, "revoked");
        const available = try boolean(candidate, "available");
        const version_match = std.mem.eql(u8, capability_version, evidence_version);
        const reliability_bps = if (version_match) reliability(successes, failures) else 0;
        const independence_bps: u16 = @intCast(@min(@as(u64, 10000), publishers * 2000));
        const freshness_bps = freshness(age);
        const latency_penalty_bps = latencyPenalty(latency);
        const weighted: u64 = @as(u64, semantic) * 60 + @as(u64, reliability_bps) * 25 +
            @as(u64, independence_bps) * 10 + @as(u64, freshness_bps) * 5;
        const before_penalty: u64 = weighted / 100;
        const score: u16 = if (revoked or !available)
            0
        else
            @intCast(before_penalty -| latency_penalty_bps);
        try ranked.append(allocator, .{
            .object_id = object_id,
            .score_bps = score,
            .status = if (revoked) .revoked else if (!available) .unavailable else .ranked,
            .semantic_score_bps = semantic,
            .reliability_bps = reliability_bps,
            .independence_bps = independence_bps,
            .freshness_bps = freshness_bps,
            .latency_penalty_bps = latency_penalty_bps,
            .version_match = version_match,
        });
    }
    std.mem.sort(Ranked, ranked.items, {}, lessThan);
    const take = @min(limit, ranked.items.len);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.appendSlice(allocator, "{\"schema_version\":1,\"candidates\":[");
    for (ranked.items[0..take], 0..) |candidate, i| {
        if (i != 0) try out.append(allocator, ',');
        try out.appendSlice(allocator, "{\"object_id\":");
        try appendString(allocator, &out, candidate.object_id);
        try out.print(allocator, ",\"score_bps\":{d},\"status\":", .{candidate.score_bps});
        try appendString(allocator, &out, @tagName(candidate.status));
        try out.print(allocator, ",\"features\":{{\"semantic_score_bps\":{d},\"reliability_bps\":{d},\"independence_bps\":{d},\"freshness_bps\":{d},\"latency_penalty_bps\":{d},\"version_match\":{}}},\"reason_codes\":[", .{
            candidate.semantic_score_bps,
            candidate.reliability_bps,
            candidate.independence_bps,
            candidate.freshness_bps,
            candidate.latency_penalty_bps,
            candidate.version_match,
        });
        try appendString(allocator, &out, if (candidate.status == .ranked and !candidate.version_match) "version_mismatch_evidence_ignored" else if (candidate.status == .ranked) "public_evidence_ranked" else if (candidate.status == .revoked) "revoked" else "unavailable");
        try out.appendSlice(allocator, "]}");
    }
    try out.appendSlice(allocator, "]}");
    return out.toOwnedSlice(allocator);
}

test "ranking is deterministic evidence weighted and fail closed" {
    const input =
        \\[
        \\ {"object_id":"blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","capability_version":"2","evidence_version":"1","semantic_score_bps":8000,"success_count":8,"failure_count":2,"independent_publishers":3,"freshness_seconds":100,"latency_bucket_ms":100,"revoked":false,"available":true},
        \\ {"object_id":"blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","capability_version":"1","evidence_version":"1","semantic_score_bps":9000,"success_count":100,"failure_count":0,"independent_publishers":5,"freshness_seconds":100,"latency_bucket_ms":10,"revoked":true,"available":true}
        \\]
    ;
    const output = try rank(std.testing.allocator, input, 2);
    defer std.testing.allocator.free(output);
    try std.testing.expect(std.mem.indexOf(u8, output, "\"score_bps\":0,\"status\":\"revoked\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "version_mismatch_evidence_ignored") != null);
    const a = std.mem.indexOf(u8, output, "blake3:aaaaaaaa").?;
    const b = std.mem.indexOf(u8, output, "blake3:bbbbbbbb").?;
    try std.testing.expect(a < b);
}
