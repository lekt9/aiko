//! Standalone, network-free verifier for Aiko Collective golden vectors.

const std = @import("std");
const collective = @import("collective_object.zig");

fn readBounded(allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);
    const fd = std.c.open(path_z.ptr, .{ .ACCMODE = .RDONLY }, @as(c_uint, 0));
    if (fd < 0) return error.OpenFailed;
    defer _ = std.c.close(fd);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    var chunk: [8192]u8 = undefined;
    while (out.items.len <= 1024 * 1024) {
        const n = std.c.read(fd, &chunk, chunk.len);
        if (n < 0) return error.ReadFailed;
        if (n == 0) return out.toOwnedSlice(allocator);
        try out.appendSlice(allocator, chunk[0..@intCast(n)]);
    }
    return error.InputTooLarge;
}

fn stringifyValue(allocator: std.mem.Allocator, value: std.json.Value) ![]u8 {
    var allocating: std.Io.Writer.Allocating = .init(allocator);
    defer allocating.deinit();
    var stringify = std.json.Stringify{ .writer = &allocating.writer };
    try stringify.write(value);
    return allocator.dupe(u8, allocating.writer.buffered());
}

fn fail(comptime fmt: []const u8, args: anytype) u8 {
    std.debug.print("collective-conformance: " ++ fmt ++ "\n", args);
    return 1;
}

pub fn main(init: std.process.Init.Minimal) !u8 {
    const allocator = std.heap.page_allocator;
    const args = try init.args.toSlice(allocator);
    if (args.len != 2) return fail("usage: collective-conformance <golden-vectors.json>", .{});
    const bytes = readBounded(allocator, args[1]) catch |err| return fail("read failed: {s}", .{@errorName(err)});
    defer allocator.free(bytes);
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, bytes, .{
        .max_value_len = 1024 * 1024,
        .allocate = .alloc_always,
    }) catch |err| return fail("fixture parse failed: {s}", .{@errorName(err)});
    defer parsed.deinit();
    const root = switch (parsed.value) {
        .object => |object| object,
        else => return fail("fixture root is not an object", .{}),
    };
    const vectors = switch (root.get("vectors") orelse return fail("vectors missing", .{})) {
        .array => |array| array,
        else => return fail("vectors is not an array", .{}),
    };
    if (vectors.items.len == 0) return fail("no vectors", .{});
    for (vectors.items, 0..) |vector_value, index| {
        const vector = switch (vector_value) {
            .object => |object| object,
            else => return fail("vector {d} is not an object", .{index}),
        };
        const name = switch (vector.get("name") orelse return fail("vector {d} name missing", .{index})) {
            .string => |string| string,
            else => return fail("vector {d} name invalid", .{index}),
        };
        const input = vector.get("input_unsigned") orelse return fail("{s}: input missing", .{name});
        const input_json = stringifyValue(allocator, input) catch |err| return fail("{s}: stringify {s}", .{ name, @errorName(err) });
        defer allocator.free(input_json);
        const result = collective.canonicalize(allocator, input_json) catch |err| return fail("{s}: canonicalize {s}", .{ name, @errorName(err) });
        defer result.deinit(allocator);
        const expected_canonical = switch (vector.get("canonical_unsigned") orelse return fail("{s}: canonical missing", .{name})) {
            .string => |string| string,
            else => return fail("{s}: canonical invalid", .{name}),
        };
        if (!std.mem.eql(u8, result.canonical, expected_canonical))
            return fail("{s}: canonical mismatch\nexpected={s}\nactual={s}", .{ name, expected_canonical, result.canonical });
        const expected_id = switch (vector.get("expected_object_id") orelse return fail("{s}: id missing", .{name})) {
            .string => |string| string,
            else => return fail("{s}: id invalid", .{name}),
        };
        if (!std.mem.eql(u8, &result.object_id, expected_id))
            return fail("{s}: object id mismatch expected={s} actual={s}", .{ name, expected_id, &result.object_id });
    }
    std.debug.print("collective-conformance: {d} vectors verified\n", .{vectors.items.len});
    return 0;
}
