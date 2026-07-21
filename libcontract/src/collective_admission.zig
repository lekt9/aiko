//! Signed-envelope admission for hostile collective bytes.
//!
//! This is deliberately a verdict engine, not a database. It verifies an
//! envelope and describes the projection Aiko must append to Contract's
//! existing semantic ledger after admission.

const std = @import("std");
const object = @import("collective_object.zig");

pub const Error = object.Error || error{ InvalidEnvelope, InvalidSourcePeer };

pub const Admission = struct {
    result: object.Result,
    kind: []u8,
    ledger_effect: []const u8,

    pub fn deinit(self: Admission, allocator: std.mem.Allocator) void {
        self.result.deinit(allocator);
        allocator.free(self.kind);
    }
};

fn jsonBytes(allocator: std.mem.Allocator, value: std.json.Value) Error![]u8 {
    var allocating: std.Io.Writer.Allocating = .init(allocator);
    defer allocating.deinit();
    var stringify = std.json.Stringify{ .writer = &allocating.writer };
    stringify.write(value) catch return Error.InvalidEnvelope;
    return allocator.dupe(u8, allocating.writer.buffered()) catch return Error.OutOfMemory;
}

fn validPeer(peer: []const u8) bool {
    if (std.mem.eql(u8, peer, "local")) return true;
    if (peer.len != 72 or !std.mem.startsWith(u8, peer, "ed25519:")) return false;
    for (peer[8..]) |ch| if (!std.ascii.isHex(ch) or (ch >= 'A' and ch <= 'F')) return false;
    return true;
}

pub fn admit(
    allocator: std.mem.Allocator,
    envelope_bytes: []const u8,
    source_peer: []const u8,
    received_at: []const u8,
) Error!Admission {
    if (!validPeer(source_peer)) return Error.InvalidSourcePeer;
    if (envelope_bytes.len == 0 or envelope_bytes.len > object.MAX_OBJECT_BYTES + 1024)
        return Error.InputTooLarge;
    try object.validateNoDuplicateKeys(allocator, envelope_bytes);
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, envelope_bytes, .{
        .max_value_len = object.MAX_OBJECT_BYTES + 1024,
        .allocate = .alloc_always,
    }) catch return Error.InvalidJson;
    defer parsed.deinit();
    const root = switch (parsed.value) {
        .object => |map| map,
        else => return Error.InvalidEnvelope,
    };
    if (root.count() != 4 or !root.contains("protocol") or !root.contains("object_id") or
        !root.contains("unsigned") or !root.contains("signature")) return Error.InvalidEnvelope;
    const protocol = switch (root.get("protocol").?) { .string => |v| v, else => return Error.InvalidEnvelope };
    if (!std.mem.eql(u8, protocol, object.PROTOCOL)) return Error.UnsupportedProtocol;
    const object_id = switch (root.get("object_id").?) { .string => |v| v, else => return Error.InvalidObjectId };
    const signature = switch (root.get("signature").?) { .string => |v| v, else => return Error.InvalidSignature };
    if (signature.len != 136 or !std.mem.startsWith(u8, signature, "ed25519:")) return Error.InvalidSignature;
    const unsigned_value = root.get("unsigned").?;
    const unsigned_root = switch (unsigned_value) { .object => |map| map, else => return Error.InvalidEnvelope };
    const publisher = switch (unsigned_root.get("publisher") orelse return Error.InvalidEnvelope) {
        .string => |v| v,
        else => return Error.InvalidPublisher,
    };
    if (publisher.len != 72 or !std.mem.startsWith(u8, publisher, "ed25519:")) return Error.InvalidPublisher;
    const kind_source = switch (unsigned_root.get("kind") orelse return Error.InvalidEnvelope) {
        .string => |v| v,
        else => return Error.InvalidEnvelope,
    };
    const unsigned = try jsonBytes(allocator, unsigned_value);
    defer allocator.free(unsigned);
    const verified = try object.verify(allocator, unsigned, object_id, signature[8..], publisher[8..], received_at);
    errdefer verified.deinit(allocator);
    const decision = try object.publicationDecision(verified.canonical, allocator);
    if (decision.verdict == .admit_private) return Error.PrivateOrigin;

    const effect = if (std.mem.eql(u8, kind_source, "attestation"))
        "append_existing_outcome_evidence"
    else if (std.mem.eql(u8, kind_source, "revocation"))
        "append_existing_trust_revocation"
    else if (std.mem.eql(u8, kind_source, "checkpoint"))
        "append_existing_transparency_evidence"
    else
        "catalog_only";
    return .{
        .result = verified,
        .kind = allocator.dupe(u8, kind_source) catch return Error.OutOfMemory,
        .ledger_effect = effect,
    };
}

test "admission verifies signed envelope and describes existing-ledger projection" {
    const Ed25519 = std.crypto.sign.Ed25519;
    const seed: [32]u8 = [_]u8{9} ** 32;
    const pair = try Ed25519.KeyPair.generateDeterministic(seed);
    var pub_hex: [64]u8 = undefined;
    _ = std.fmt.bufPrint(&pub_hex, "{x}", .{pair.public_key.bytes}) catch unreachable;
    const base = @embedFile("fixtures/collective-valid-capability.json");
    const candidate = try std.mem.replaceOwned(u8, std.testing.allocator, base,
        "0000000000000000000000000000000000000000000000000000000000000000", &pub_hex);
    defer std.testing.allocator.free(candidate);
    const canonical = try object.canonicalize(std.testing.allocator, candidate);
    defer canonical.deinit(std.testing.allocator);
    const signature = try pair.sign(&object.signingDigest(object.objectDigest(canonical.canonical)), null);
    var sig_hex: [128]u8 = undefined;
    _ = std.fmt.bufPrint(&sig_hex, "{x}", .{signature.toBytes()}) catch unreachable;
    const envelope = try std.fmt.allocPrint(std.testing.allocator,
        "{{\"protocol\":\"aiko-collective/1\",\"object_id\":\"{s}\",\"unsigned\":{s},\"signature\":\"ed25519:{s}\"}}",
        .{ &canonical.object_id, canonical.canonical, &sig_hex });
    defer std.testing.allocator.free(envelope);
    const accepted = try admit(std.testing.allocator, envelope, "local", "2026-08-01T00:00:00Z");
    defer accepted.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("capability", accepted.kind);
    try std.testing.expectEqualStrings("catalog_only", accepted.ledger_effect);
}
