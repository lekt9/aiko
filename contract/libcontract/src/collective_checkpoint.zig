//! Deterministic Merkle checkpoints for admitted collective object IDs.
//!
//! The tree follows the Certificate Transparency shape: leaves and interior
//! nodes use distinct domains, odd nodes are promoted unchanged, and input is
//! sorted/deduplicated so receipt order cannot change the checkpoint.

const std = @import("std");
const object = @import("collective_object.zig");

const Blake3 = std.crypto.hash.Blake3;
const LEAF_DOMAIN = "aiko.collective.checkpoint.leaf.v1\x00";
const NODE_DOMAIN = "aiko.collective.checkpoint.node.v1\x00";
pub const MAX_LEAVES: usize = 65536;

pub const Error = error{
    InputTooLarge,
    InvalidJson,
    InvalidRoot,
    InvalidObjectId,
    TooManyLeaves,
    OutOfMemory,
    TargetNotFound,
    InvalidProof,
};

fn hash(parts: []const []const u8) [32]u8 {
    var h = Blake3.init(.{});
    for (parts) |part| h.update(part);
    var out: [32]u8 = undefined;
    h.final(&out);
    return out;
}

fn less(_: void, a: []const u8, b: []const u8) bool {
    return std.mem.order(u8, a, b) == .lt;
}

fn hex(bytes: [32]u8, out: *[64]u8) void {
    const alphabet = "0123456789abcdef";
    for (bytes, 0..) |byte, i| {
        out[i * 2] = alphabet[byte >> 4];
        out[i * 2 + 1] = alphabet[byte & 15];
    }
}

fn decodeHex32(value: []const u8) Error![32]u8 {
    if (value.len != 64) return Error.InvalidProof;
    var out: [32]u8 = undefined;
    for (0..32) |i| {
        const pair = value[i * 2 .. i * 2 + 2];
        out[i] = std.fmt.parseInt(u8, pair, 16) catch return Error.InvalidProof;
    }
    return out;
}

pub fn rootForIds(allocator: std.mem.Allocator, input: []const u8) Error![]u8 {
    if (input.len == 0 or input.len > 8 * 1024 * 1024) return Error.InputTooLarge;
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, input, .{
        .max_value_len = 8 * 1024 * 1024,
        .allocate = .alloc_always,
    }) catch return Error.InvalidJson;
    defer parsed.deinit();
    const values = switch (parsed.value) {
        .array => |items| items,
        else => return Error.InvalidRoot,
    };
    if (values.items.len > MAX_LEAVES) return Error.TooManyLeaves;

    var ids = allocator.alloc([]const u8, values.items.len) catch return Error.OutOfMemory;
    defer allocator.free(ids);
    for (values.items, 0..) |value, i| {
        ids[i] = switch (value) {
            .string => |id| id,
            else => return Error.InvalidObjectId,
        };
        if (!object.isObjectId(ids[i])) return Error.InvalidObjectId;
    }
    std.mem.sort([]const u8, ids, {}, less);

    var unique_count: usize = 0;
    for (ids) |id| {
        if (unique_count == 0 or !std.mem.eql(u8, ids[unique_count - 1], id)) {
            ids[unique_count] = id;
            unique_count += 1;
        }
    }

    var level = allocator.alloc([32]u8, @max(unique_count, 1)) catch return Error.OutOfMemory;
    defer allocator.free(level);
    if (unique_count == 0) {
        level[0] = hash(&.{LEAF_DOMAIN});
    } else {
        for (ids[0..unique_count], 0..) |id, i| level[i] = hash(&.{ LEAF_DOMAIN, id });
    }
    var level_len: usize = @max(unique_count, 1);
    while (level_len > 1) {
        var write: usize = 0;
        var read: usize = 0;
        while (read < level_len) : (write += 1) {
            if (read + 1 == level_len) {
                level[write] = level[read];
                read += 1;
            } else {
                const left = level[read];
                const right = level[read + 1];
                level[write] = hash(&.{ NODE_DOMAIN, &left, &right });
                read += 2;
            }
        }
        level_len = write;
    }

    var root_hex: [64]u8 = undefined;
    hex(level[0], &root_hex);
    return std.fmt.allocPrint(allocator, "{{\"schema_version\":1,\"tree_size\":{d},\"root_hash\":\"{s}\",\"ordering\":\"object_id_lexicographic_unique\"}}", .{ unique_count, &root_hex }) catch return Error.OutOfMemory;
}

/// Produce a logarithmic inclusion proof for one admitted object ID. The
/// object list uses exactly the same lexicographic/deduplicated tree as
/// `rootForIds`; callers therefore do not need to trust the node constructing
/// the proof. Odd nodes are promoted unchanged and consequently add no path
/// element at that level.
pub fn proofForId(
    allocator: std.mem.Allocator,
    input: []const u8,
    target: []const u8,
) Error![]u8 {
    if (input.len == 0 or input.len > 8 * 1024 * 1024) return Error.InputTooLarge;
    if (!object.isObjectId(target)) return Error.InvalidObjectId;
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, input, .{
        .max_value_len = 8 * 1024 * 1024,
        .allocate = .alloc_always,
    }) catch return Error.InvalidJson;
    defer parsed.deinit();
    const values = switch (parsed.value) {
        .array => |items| items,
        else => return Error.InvalidRoot,
    };
    if (values.items.len > MAX_LEAVES) return Error.TooManyLeaves;

    var ids = allocator.alloc([]const u8, values.items.len) catch return Error.OutOfMemory;
    defer allocator.free(ids);
    for (values.items, 0..) |value, i| {
        ids[i] = switch (value) {
            .string => |id| id,
            else => return Error.InvalidObjectId,
        };
        if (!object.isObjectId(ids[i])) return Error.InvalidObjectId;
    }
    std.mem.sort([]const u8, ids, {}, less);
    var unique_count: usize = 0;
    for (ids) |id| {
        if (unique_count == 0 or !std.mem.eql(u8, ids[unique_count - 1], id)) {
            ids[unique_count] = id;
            unique_count += 1;
        }
    }
    if (unique_count == 0) return Error.TargetNotFound;

    var target_index: ?usize = null;
    var level = allocator.alloc([32]u8, unique_count) catch return Error.OutOfMemory;
    defer allocator.free(level);
    for (ids[0..unique_count], 0..) |id, i| {
        level[i] = hash(&.{ LEAF_DOMAIN, id });
        if (std.mem.eql(u8, id, target)) target_index = i;
    }
    var index = target_index orelse return Error.TargetNotFound;
    const leaf_index = index;
    var level_len = unique_count;
    var path: std.ArrayList(u8) = .empty;
    defer path.deinit(allocator);
    path.append(allocator, '[') catch return Error.OutOfMemory;
    var first = true;
    while (level_len > 1) {
        const sibling: ?usize = if (index % 2 == 1)
            index - 1
        else if (index + 1 < level_len)
            index + 1
        else
            null;
        if (sibling) |sibling_index| {
            var sibling_hex: [64]u8 = undefined;
            hex(level[sibling_index], &sibling_hex);
            if (!first) path.append(allocator, ',') catch return Error.OutOfMemory;
            first = false;
            const entry = std.fmt.allocPrint(
                allocator,
                "{{\"side\":\"{s}\",\"hash\":\"{s}\"}}",
                .{ if (sibling_index < index) "left" else "right", &sibling_hex },
            ) catch return Error.OutOfMemory;
            defer allocator.free(entry);
            path.appendSlice(allocator, entry) catch return Error.OutOfMemory;
        }

        var write: usize = 0;
        var read: usize = 0;
        while (read < level_len) : (write += 1) {
            if (read + 1 == level_len) {
                level[write] = level[read];
                read += 1;
            } else {
                const left = level[read];
                const right = level[read + 1];
                level[write] = hash(&.{ NODE_DOMAIN, &left, &right });
                read += 2;
            }
        }
        level_len = write;
        index /= 2;
    }
    path.append(allocator, ']') catch return Error.OutOfMemory;

    var root_hex: [64]u8 = undefined;
    hex(level[0], &root_hex);
    return std.fmt.allocPrint(
        allocator,
        "{{\"schema_version\":1,\"tree_size\":{d},\"root_hash\":\"{s}\",\"ordering\":\"object_id_lexicographic_unique\",\"object_id\":\"{s}\",\"leaf_index\":{d},\"audit_path\":{s}}}",
        .{ unique_count, &root_hex, target, leaf_index, path.items },
    ) catch return Error.OutOfMemory;
}

/// Verify a self-contained proof using the same odd-node promotion rules as
/// checkpoint construction. The verifier also checks path shape against tree
/// size and leaf index, so a root match cannot hide surplus or omitted steps.
pub fn verifyProof(allocator: std.mem.Allocator, input: []const u8) Error!bool {
    if (input.len == 0 or input.len > 64 * 1024) return Error.InputTooLarge;
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, input, .{
        .max_value_len = 64 * 1024,
        .allocate = .alloc_always,
    }) catch return Error.InvalidJson;
    defer parsed.deinit();
    const root = switch (parsed.value) {
        .object => |map| map,
        else => return Error.InvalidProof,
    };
    if (root.count() != 7) return Error.InvalidProof;
    if (root.get("schema_version") == null or root.get("schema_version").? != .integer or root.get("schema_version").?.integer != 1) return Error.InvalidProof;
    const tree_size_i = if (root.get("tree_size")) |value| switch (value) {
        .integer => |integer| integer,
        else => return Error.InvalidProof,
    } else return Error.InvalidProof;
    const leaf_index_i = if (root.get("leaf_index")) |value| switch (value) {
        .integer => |integer| integer,
        else => return Error.InvalidProof,
    } else return Error.InvalidProof;
    if (tree_size_i <= 0 or tree_size_i > MAX_LEAVES or leaf_index_i < 0 or leaf_index_i >= tree_size_i) return Error.InvalidProof;
    const ordering = if (root.get("ordering")) |value| switch (value) {
        .string => |string| string,
        else => return Error.InvalidProof,
    } else return Error.InvalidProof;
    if (!std.mem.eql(u8, ordering, "object_id_lexicographic_unique")) return Error.InvalidProof;
    const object_id = if (root.get("object_id")) |value| switch (value) {
        .string => |string| string,
        else => return Error.InvalidProof,
    } else return Error.InvalidProof;
    if (!object.isObjectId(object_id)) return Error.InvalidProof;
    const expected_root = if (root.get("root_hash")) |value| switch (value) {
        .string => |string| try decodeHex32(string),
        else => return Error.InvalidProof,
    } else return Error.InvalidProof;
    const audit_path = if (root.get("audit_path")) |value| switch (value) {
        .array => |array| array.items,
        else => return Error.InvalidProof,
    } else return Error.InvalidProof;
    if (audit_path.len > 16) return Error.InvalidProof;

    var current = hash(&.{ LEAF_DOMAIN, object_id });
    var level_len: usize = @intCast(tree_size_i);
    var index: usize = @intCast(leaf_index_i);
    var consumed: usize = 0;
    while (level_len > 1) {
        const has_sibling = index % 2 == 1 or index + 1 < level_len;
        if (has_sibling) {
            if (consumed >= audit_path.len) return Error.InvalidProof;
            const entry = switch (audit_path[consumed]) {
                .object => |map| map,
                else => return Error.InvalidProof,
            };
            if (entry.count() != 2) return Error.InvalidProof;
            const side = if (entry.get("side")) |value| switch (value) {
                .string => |string| string,
                else => return Error.InvalidProof,
            } else return Error.InvalidProof;
            const sibling = if (entry.get("hash")) |value| switch (value) {
                .string => |string| try decodeHex32(string),
                else => return Error.InvalidProof,
            } else return Error.InvalidProof;
            if (index % 2 == 1) {
                if (!std.mem.eql(u8, side, "left")) return Error.InvalidProof;
                current = hash(&.{ NODE_DOMAIN, &sibling, &current });
            } else {
                if (!std.mem.eql(u8, side, "right")) return Error.InvalidProof;
                current = hash(&.{ NODE_DOMAIN, &current, &sibling });
            }
            consumed += 1;
        }
        level_len = (level_len + 1) / 2;
        index /= 2;
    }
    return consumed == audit_path.len and std.mem.eql(u8, &current, &expected_root);
}

test "checkpoint is order-independent duplicate-safe and domain-separated" {
    const a = "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const b = "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const first = try rootForIds(std.testing.allocator, "[\"" ++ b ++ "\",\"" ++ a ++ "\",\"" ++ a ++ "\"]");
    defer std.testing.allocator.free(first);
    const second = try rootForIds(std.testing.allocator, "[\"" ++ a ++ "\",\"" ++ b ++ "\"]");
    defer std.testing.allocator.free(second);
    try std.testing.expectEqualStrings(first, second);
    try std.testing.expect(std.mem.indexOf(u8, first, "\"tree_size\":2") != null);
}

test "targeted inclusion proof uses the checkpoint root and logarithmic path" {
    const a = "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const b = "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const c = "blake3:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const ids = "[\"" ++ c ++ "\",\"" ++ a ++ "\",\"" ++ b ++ "\"]";
    const root = try rootForIds(std.testing.allocator, ids);
    defer std.testing.allocator.free(root);
    const proof = try proofForId(std.testing.allocator, ids, c);
    defer std.testing.allocator.free(proof);

    var root_json = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, root, .{});
    defer root_json.deinit();
    var proof_json = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, proof, .{});
    defer proof_json.deinit();
    try std.testing.expectEqualStrings(
        root_json.value.object.get("root_hash").?.string,
        proof_json.value.object.get("root_hash").?.string,
    );
    try std.testing.expectEqual(@as(i64, 2), proof_json.value.object.get("leaf_index").?.integer);
    try std.testing.expectEqual(@as(usize, 1), proof_json.value.object.get("audit_path").?.array.items.len);
    try std.testing.expect(try verifyProof(std.testing.allocator, proof));
    const tampered = try std.testing.allocator.dupe(u8, proof);
    defer std.testing.allocator.free(tampered);
    const root_marker = std.mem.indexOf(u8, tampered, "\"root_hash\":\"").? + 13;
    tampered[root_marker] = if (tampered[root_marker] == '0') '1' else '0';
    try std.testing.expect(!(try verifyProof(std.testing.allocator, tampered)));
    try std.testing.expectError(Error.TargetNotFound, proofForId(std.testing.allocator, ids, "blake3:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"));
}
