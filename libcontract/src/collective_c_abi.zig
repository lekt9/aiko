//! Portable shared-library surface for the deterministic Aiko Collective.
//! This intentionally imports no ledger, filesystem, environment, or network
//! module, so the same trust kernel can be built for Windows, macOS, and Linux.

const std = @import("std");
const object = @import("collective_object.zig");
const rank = @import("collective_rank.zig");
const checkpoint = @import("collective_checkpoint.zig");
const admission = @import("collective_admission.zig");
const state = @import("collective_state.zig");

const gpa = std.heap.c_allocator;

export fn contract_abi_version() u32 {
    return 3;
}

fn cstr(pointer: [*:0]const u8) []const u8 {
    return std.mem.span(pointer);
}

fn returned(value: []const u8) ?[*:0]u8 {
    const output = gpa.allocSentinel(u8, value.len, 0) catch return null;
    @memcpy(output, value);
    return output.ptr;
}

fn appendJsonString(output: *std.ArrayList(u8), value: []const u8) !void {
    try output.append(gpa, '"');
    for (value) |byte| switch (byte) {
        '"' => try output.appendSlice(gpa, "\\\""),
        '\\' => try output.appendSlice(gpa, "\\\\"),
        '\n' => try output.appendSlice(gpa, "\\n"),
        '\r' => try output.appendSlice(gpa, "\\r"),
        '\t' => try output.appendSlice(gpa, "\\t"),
        else => if (byte >= 0x20) try output.append(gpa, byte),
    };
    try output.append(gpa, '"');
}

fn failure(err: anyerror) ?[*:0]u8 {
    var output: std.ArrayList(u8) = .empty;
    defer output.deinit(gpa);
    output.appendSlice(gpa, "{\"verdict\":\"reject\",\"reason_codes\":[") catch return null;
    appendJsonString(&output, @errorName(err)) catch return null;
    output.appendSlice(gpa, "]}") catch return null;
    return returned(output.items);
}

fn appendIdentity(output: *std.ArrayList(u8), result: object.Result) !void {
    try output.appendSlice(gpa, "\"object_id\":");
    try appendJsonString(output, &result.object_id);
    try output.appendSlice(gpa, ",\"schema_version\":1");
}

export fn contract_collective_canonicalize(candidate: [*:0]const u8) ?[*:0]u8 {
    const result = object.canonicalize(gpa, cstr(candidate)) catch |err| return failure(err);
    defer result.deinit(gpa);
    var output: std.ArrayList(u8) = .empty;
    defer output.deinit(gpa);
    output.append(gpa, '{') catch return null;
    appendIdentity(&output, result) catch return null;
    output.appendSlice(gpa, ",\"canonical\":") catch return null;
    output.appendSlice(gpa, result.canonical) catch return null;
    output.appendSlice(gpa, ",\"verdict\":\"valid\"}") catch return null;
    return returned(output.items);
}

export fn contract_collective_publication_verdict(candidate: [*:0]const u8) ?[*:0]u8 {
    const result = object.canonicalize(gpa, cstr(candidate)) catch |err| return failure(err);
    defer result.deinit(gpa);
    const decision = object.publicationDecision(cstr(candidate), gpa) catch |err| return failure(err);
    var output: std.ArrayList(u8) = .empty;
    defer output.deinit(gpa);
    output.appendSlice(gpa, "{\"verdict\":") catch return null;
    appendJsonString(&output, @tagName(decision.verdict)) catch return null;
    output.appendSlice(gpa, ",\"classification\":") catch return null;
    appendJsonString(&output, @tagName(decision.classification)) catch return null;
    output.appendSlice(gpa, ",\"reason_codes\":[") catch return null;
    appendJsonString(&output, decision.reason_code) catch return null;
    output.appendSlice(gpa, "],") catch return null;
    appendIdentity(&output, result) catch return null;
    output.appendSlice(gpa, ",\"sanitized_descriptor\":") catch return null;
    output.appendSlice(gpa, result.canonical) catch return null;
    output.append(gpa, '}') catch return null;
    return returned(output.items);
}

export fn contract_collective_signing_payload(candidate: [*:0]const u8) ?[*:0]u8 {
    const result = object.canonicalize(gpa, cstr(candidate)) catch |err| return failure(err);
    defer result.deinit(gpa);
    const digest = object.signingDigest(object.objectDigest(result.canonical));
    var digest_hex: [64]u8 = undefined;
    _ = std.fmt.bufPrint(&digest_hex, "{x}", .{digest}) catch return null;
    var output: std.ArrayList(u8) = .empty;
    defer output.deinit(gpa);
    output.append(gpa, '{') catch return null;
    appendIdentity(&output, result) catch return null;
    output.appendSlice(gpa, ",\"domain\":") catch return null;
    appendJsonString(&output, object.SIGNING_DOMAIN[0 .. object.SIGNING_DOMAIN.len - 1]) catch return null;
    output.appendSlice(gpa, ",\"payload_encoding\":\"hex\",\"payload_hex\":") catch return null;
    appendJsonString(&output, &digest_hex) catch return null;
    output.append(gpa, '}') catch return null;
    return returned(output.items);
}

export fn contract_collective_verify(candidate: [*:0]const u8, claimed_id: [*:0]const u8, signature: [*:0]const u8, publisher_key: [*:0]const u8, now: [*:0]const u8) ?[*:0]u8 {
    const result = object.verify(gpa, cstr(candidate), cstr(claimed_id), cstr(signature), cstr(publisher_key), cstr(now)) catch |err| return failure(err);
    defer result.deinit(gpa);
    var output: std.ArrayList(u8) = .empty;
    defer output.deinit(gpa);
    output.appendSlice(gpa, "{\"verdict\":\"verified\",\"reason_codes\":[\"signature_valid\",\"object_id_valid\",\"time_valid\"],") catch return null;
    appendIdentity(&output, result) catch return null;
    output.append(gpa, '}') catch return null;
    return returned(output.items);
}

export fn contract_collective_rank(candidates: [*:0]const u8, limit: u32) ?[*:0]u8 {
    const result = rank.rank(gpa, cstr(candidates), @min(limit, 100)) catch |err| return failure(err);
    defer gpa.free(result);
    return returned(result);
}

export fn contract_collective_checkpoint(ids: [*:0]const u8) ?[*:0]u8 {
    const result = checkpoint.rootForIds(gpa, cstr(ids)) catch |err| return failure(err);
    defer gpa.free(result);
    return returned(result);
}

export fn contract_collective_inclusion_proof(ids: [*:0]const u8, target: [*:0]const u8) ?[*:0]u8 {
    const result = checkpoint.proofForId(gpa, cstr(ids), cstr(target)) catch |err| return failure(err);
    defer gpa.free(result);
    return returned(result);
}

export fn contract_collective_verify_inclusion_proof(proof: [*:0]const u8) ?[*:0]u8 {
    const valid = checkpoint.verifyProof(gpa, cstr(proof)) catch |err| return failure(err);
    return returned(if (valid)
        "{\"verdict\":\"verified\",\"reason_codes\":[\"inclusion_valid\"]}"
    else
        "{\"verdict\":\"rejected\",\"reason_codes\":[\"inclusion_invalid\"]}");
}

export fn contract_collective_admit(envelope: [*:0]const u8, source_peer: [*:0]const u8, received_at: [*:0]const u8) ?[*:0]u8 {
    const result = admission.admit(gpa, cstr(envelope), cstr(source_peer), cstr(received_at)) catch |err| return failure(err);
    defer result.deinit(gpa);
    var output: std.ArrayList(u8) = .empty;
    defer output.deinit(gpa);
    output.appendSlice(gpa, "{\"verdict\":\"admitted\",\"reason_codes\":[\"signature_valid\",\"publication_policy_valid\"],\"object_id\":") catch return null;
    appendJsonString(&output, &result.result.object_id) catch return null;
    output.appendSlice(gpa, ",\"kind\":") catch return null;
    appendJsonString(&output, result.kind) catch return null;
    output.appendSlice(gpa, ",\"ledger_effects\":[") catch return null;
    appendJsonString(&output, result.ledger_effect) catch return null;
    output.appendSlice(gpa, "]}") catch return null;
    return returned(output.items);
}

export fn contract_collective_merge(metadata: [*:0]const u8) ?[*:0]u8 {
    const result = state.merge(gpa, cstr(metadata)) catch |err| return failure(err);
    defer gpa.free(result);
    return returned(result);
}

export fn contract_collective_apply_revocations(envelopes: [*:0]const u8, now: [*:0]const u8) ?[*:0]u8 {
    const result = state.applyRevocations(gpa, cstr(envelopes), cstr(now)) catch |err| return failure(err);
    defer gpa.free(result);
    return returned(result);
}

export fn contract_free(pointer: ?[*:0]u8) void {
    if (pointer) |value| {
        const slice = std.mem.span(value);
        gpa.free(value[0 .. slice.len + 1]);
    }
}
