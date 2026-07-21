//! Pure set-state projections for the collective protocol.
//!
//! Aiko stores bytes; Contract deterministically merges admitted identities
//! and projects signed revocations. No second mutable evidence ledger lives
//! here.

const std = @import("std");
const object = @import("collective_object.zig");
const admission = @import("collective_admission.zig");

pub const Error = error{
    InputTooLarge,
    InvalidJson,
    InvalidRoot,
    InvalidRecord,
    TooManyRecords,
    OutOfMemory,
};

const MAX_RECORDS: usize = 16384;

const Record = struct {
    object_id: []const u8,
    publisher: []const u8,
    kind: []const u8,
    sequence: u64,
    conflict: bool = false,
};

fn string(map: std.json.ObjectMap, key: []const u8) Error![]const u8 {
    return switch (map.get(key) orelse return Error.InvalidRecord) {
        .string => |value| value,
        else => Error.InvalidRecord,
    };
}

fn lessRecord(_: void, a: Record, b: Record) bool {
    const publisher_order = std.mem.order(u8, a.publisher, b.publisher);
    if (publisher_order != .eq) return publisher_order == .lt;
    const kind_order = std.mem.order(u8, a.kind, b.kind);
    if (kind_order != .eq) return kind_order == .lt;
    if (a.sequence != b.sequence) return a.sequence < b.sequence;
    return std.mem.order(u8, a.object_id, b.object_id) == .lt;
}

fn appendJsonString(allocator: std.mem.Allocator, out: *std.ArrayList(u8), value: []const u8) Error!void {
    var allocating: std.Io.Writer.Allocating = .init(allocator);
    defer allocating.deinit();
    var stringify = std.json.Stringify{ .writer = &allocating.writer };
    stringify.write(value) catch return Error.InvalidRecord;
    out.appendSlice(allocator, allocating.writer.buffered()) catch return Error.OutOfMemory;
}

/// Merge already-admitted metadata. Equal object IDs are idempotent. Distinct
/// objects claiming the same publisher/kind/sequence are all quarantined as
/// equivocation, independently of input order.
pub fn merge(allocator: std.mem.Allocator, input: []const u8) Error![]u8 {
    if (input.len == 0 or input.len > 4 * 1024 * 1024) return Error.InputTooLarge;
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, input, .{
        .max_value_len = 4 * 1024 * 1024,
        .allocate = .alloc_always,
    }) catch return Error.InvalidJson;
    defer parsed.deinit();
    const values = switch (parsed.value) {
        .array => |v| v,
        else => return Error.InvalidRoot,
    };
    if (values.items.len > MAX_RECORDS) return Error.TooManyRecords;
    var records: std.ArrayList(Record) = .empty;
    defer records.deinit(allocator);
    for (values.items) |value| {
        const map = switch (value) {
            .object => |v| v,
            else => return Error.InvalidRecord,
        };
        if (map.count() != 4) return Error.InvalidRecord;
        const id = try string(map, "object_id");
        const publisher = try string(map, "publisher");
        const kind = try string(map, "kind");
        const sequence_i = switch (map.get("sequence") orelse return Error.InvalidRecord) {
            .integer => |v| v,
            else => return Error.InvalidRecord,
        };
        if (!object.isObjectId(id) or publisher.len != 72 or
            !std.mem.startsWith(u8, publisher, "ed25519:") or kind.len == 0 or kind.len > 32 or sequence_i < 0)
            return Error.InvalidRecord;
        try records.append(allocator, .{ .object_id = id, .publisher = publisher, .kind = kind, .sequence = @intCast(sequence_i) });
    }
    std.mem.sort(Record, records.items, {}, lessRecord);
    var i: usize = 0;
    while (i < records.items.len) {
        var end = i + 1;
        while (end < records.items.len and
            std.mem.eql(u8, records.items[i].publisher, records.items[end].publisher) and
            std.mem.eql(u8, records.items[i].kind, records.items[end].kind) and
            records.items[i].sequence == records.items[end].sequence) : (end += 1)
        {}
        var distinct: usize = 1;
        var j = i + 1;
        while (j < end) : (j += 1) if (!std.mem.eql(u8, records.items[j - 1].object_id, records.items[j].object_id)) {
            distinct += 1;
        };
        if (distinct > 1) {
            for (records.items[i..end]) |*record| record.conflict = true;
        }
        i = end;
    }

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.appendSlice(allocator, "{\"schema_version\":1,\"admitted\":[");
    var written: usize = 0;
    var previous: ?[]const u8 = null;
    for (records.items) |record| if (!record.conflict and (previous == null or !std.mem.eql(u8, previous.?, record.object_id))) {
        if (written != 0) try out.append(allocator, ',');
        try appendJsonString(allocator, &out, record.object_id);
        previous = record.object_id;
        written += 1;
    };
    try out.appendSlice(allocator, "],\"quarantined_equivocations\":[");
    written = 0;
    previous = null;
    for (records.items) |record| if (record.conflict and (previous == null or !std.mem.eql(u8, previous.?, record.object_id))) {
        if (written != 0) try out.append(allocator, ',');
        try appendJsonString(allocator, &out, record.object_id);
        previous = record.object_id;
        written += 1;
    };
    try out.appendSlice(allocator, "]}");
    return out.toOwnedSlice(allocator) catch Error.OutOfMemory;
}

fn jsonBytes(allocator: std.mem.Allocator, value: std.json.Value) Error![]u8 {
    var allocating: std.Io.Writer.Allocating = .init(allocator);
    defer allocating.deinit();
    var stringify = std.json.Stringify{ .writer = &allocating.writer };
    stringify.write(value) catch return Error.InvalidRecord;
    return allocator.dupe(u8, allocating.writer.buffered()) catch return Error.OutOfMemory;
}

/// Verify signed revocation envelopes and return only effective, typed targets.
/// Invalid entries are counted but can never contribute to the projection.
pub fn applyRevocations(allocator: std.mem.Allocator, input: []const u8, now: []const u8) Error![]u8 {
    if (input.len == 0 or input.len > 8 * 1024 * 1024) return Error.InputTooLarge;
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, input, .{
        .max_value_len = 8 * 1024 * 1024,
        .allocate = .alloc_always,
    }) catch return Error.InvalidJson;
    defer parsed.deinit();
    const values = switch (parsed.value) {
        .array => |v| v,
        else => return Error.InvalidRoot,
    };
    if (values.items.len > MAX_RECORDS) return Error.TooManyRecords;
    var targets: std.ArrayList([]u8) = .empty;
    defer {
        for (targets.items) |target| allocator.free(target);
        targets.deinit(allocator);
    }
    var rejected: usize = 0;
    for (values.items) |value| {
        // Object identifiers do not encode ownership. Callers therefore pass
        // the already-admitted target publisher beside the signed envelope;
        // Contract binds that owner to the signer before a revocation can
        // affect projection. A bare envelope remains accepted only for a
        // publisher revoking itself.
        const outer = switch (value) {
            .object => |v| v,
            else => {
                rejected += 1;
                continue;
            },
        };
        var envelope_value = value;
        var target_publisher: ?[]const u8 = null;
        if (outer.get("envelope")) |wrapped| {
            if (outer.count() != 2) {
                rejected += 1;
                continue;
            }
            envelope_value = wrapped;
            target_publisher = switch (outer.get("target_publisher") orelse {
                rejected += 1;
                continue;
            }) {
                .string => |publisher| publisher,
                else => {
                    rejected += 1;
                    continue;
                },
            };
        }
        const envelope = jsonBytes(allocator, envelope_value) catch {
            rejected += 1;
            continue;
        };
        defer allocator.free(envelope);
        const admitted = admission.admit(allocator, envelope, "local", now) catch {
            rejected += 1;
            continue;
        };
        defer admitted.deinit(allocator);
        if (!std.mem.eql(u8, admitted.kind, "revocation")) {
            rejected += 1;
            continue;
        }
        var unsigned = std.json.parseFromSlice(std.json.Value, allocator, admitted.result.canonical, .{}) catch {
            rejected += 1;
            continue;
        };
        defer unsigned.deinit();
        const payload = unsigned.value.object.get("payload").?.object;
        const signer = unsigned.value.object.get("publisher").?.string;
        const effective = payload.get("effective_at").?.string;
        if (std.mem.order(u8, effective, now) == .gt) continue;
        const target_kind = payload.get("target_kind").?.string;
        const target = payload.get("target").?.string;
        const authorized = if (std.mem.eql(u8, target_kind, "publisher"))
            std.mem.eql(u8, target, signer)
        else if (std.mem.eql(u8, target_kind, "object") or std.mem.eql(u8, target_kind, "delegation"))
            target_publisher != null and std.mem.eql(u8, target_publisher.?, signer)
        else
            false;
        if (!authorized) {
            rejected += 1;
            continue;
        }
        targets.append(allocator, std.fmt.allocPrint(allocator, "{s}:{s}", .{ target_kind, target }) catch return Error.OutOfMemory) catch return Error.OutOfMemory;
    }
    std.mem.sort([]u8, targets.items, {}, struct {
        fn less(_: void, a: []u8, b: []u8) bool {
            return std.mem.order(u8, a, b) == .lt;
        }
    }.less);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.print(allocator, "{{\"schema_version\":1,\"accepted\":{d},\"rejected\":{d},\"effective_projection\":[", .{ targets.items.len, rejected });
    for (targets.items, 0..) |target, index| {
        if (index != 0) try out.append(allocator, ',');
        try appendJsonString(allocator, &out, target);
    }
    try out.appendSlice(allocator, "]}");
    return out.toOwnedSlice(allocator) catch Error.OutOfMemory;
}

test "merge is idempotent and quarantines equivocation independent of order" {
    const a = "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const b = "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const publisher = "ed25519:1111111111111111111111111111111111111111111111111111111111111111";
    const input = "[{\"object_id\":\"" ++ a ++ "\",\"publisher\":\"" ++ publisher ++ "\",\"kind\":\"capability\",\"sequence\":1},{\"object_id\":\"" ++ a ++ "\",\"publisher\":\"" ++ publisher ++ "\",\"kind\":\"capability\",\"sequence\":1},{\"object_id\":\"" ++ b ++ "\",\"publisher\":\"" ++ publisher ++ "\",\"kind\":\"capability\",\"sequence\":1}]";
    const result = try merge(std.testing.allocator, input);
    defer std.testing.allocator.free(result);
    try std.testing.expect(std.mem.indexOf(u8, result, "\"admitted\":[]") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, a) != null);
    try std.testing.expect(std.mem.indexOf(u8, result, b) != null);
}

test "revocation projection admits only signed effective revocations" {
    const Ed25519 = std.crypto.sign.Ed25519;
    const seed: [32]u8 = [_]u8{5} ** 32;
    const pair = try Ed25519.KeyPair.generateDeterministic(seed);
    var pub_hex: [64]u8 = undefined;
    _ = std.fmt.bufPrint(&pub_hex, "{x}", .{pair.public_key.bytes}) catch unreachable;
    const target = "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const candidate = try std.fmt.allocPrint(std.testing.allocator, "{{\"protocol\":\"aiko-collective/1\",\"kind\":\"revocation\",\"publisher\":\"ed25519:{s}\",\"sequence\":2,\"created_at\":\"2026-07-21T00:00:00Z\",\"expires_at\":\"2027-07-21T00:00:00Z\",\"payload\":{{\"target_kind\":\"object\",\"target\":\"{s}\",\"reason\":\"compromised\",\"effective_at\":\"2026-07-22T00:00:00Z\"}}}}", .{ &pub_hex, target });
    defer std.testing.allocator.free(candidate);
    const canonical = try object.canonicalize(std.testing.allocator, candidate);
    defer canonical.deinit(std.testing.allocator);
    const signature = try pair.sign(&object.signingDigest(object.objectDigest(canonical.canonical)), null);
    var sig_hex: [128]u8 = undefined;
    _ = std.fmt.bufPrint(&sig_hex, "{x}", .{signature.toBytes()}) catch unreachable;
    const envelope = try std.fmt.allocPrint(std.testing.allocator, "[{{\"target_publisher\":\"ed25519:{s}\",\"envelope\":{{\"protocol\":\"aiko-collective/1\",\"object_id\":\"{s}\",\"unsigned\":{s},\"signature\":\"ed25519:{s}\"}}}},{{\"target_publisher\":\"ed25519:2222222222222222222222222222222222222222222222222222222222222222\",\"envelope\":{{\"protocol\":\"aiko-collective/1\",\"object_id\":\"{s}\",\"unsigned\":{s},\"signature\":\"ed25519:{s}\"}}}},{{\"broken\":true}}]", .{ &pub_hex, &canonical.object_id, canonical.canonical, &sig_hex, &canonical.object_id, canonical.canonical, &sig_hex });
    defer std.testing.allocator.free(envelope);
    const projection = try applyRevocations(std.testing.allocator, envelope, "2026-08-01T00:00:00Z");
    defer std.testing.allocator.free(projection);
    try std.testing.expect(std.mem.indexOf(u8, projection, "\"accepted\":1,\"rejected\":2") != null);
    try std.testing.expect(std.mem.indexOf(u8, projection, "object:blake3:aaaaaaaa") != null);
}
