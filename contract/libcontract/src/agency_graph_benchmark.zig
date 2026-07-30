const std = @import("std");
const development = @import("development.zig");

fn nowNs() i128 {
    var ts: std.c.timespec = undefined;
    _ = std.c.clock_gettime(std.c.CLOCK.MONOTONIC, &ts);
    return @as(i128, ts.sec) * 1_000_000_000 + ts.nsec;
}

pub fn main() !void {
    const allocator = std.heap.page_allocator;
    const sizes = [_]usize{ 1, 100, 1000, 10_000 };
    var stdout_buf: [4096]u8 = undefined;
    var stdout_writer = std.Io.Writer.fixed(&stdout_buf);
    const out = &stdout_writer;
    try out.writeAll("{\"schema_version\":1,\"benchmark\":\"agency_graph_audit\",\"samples\":[");
    for (sizes, 0..) |size, sample_index| {
        const nodes = try allocator.alloc(development.NodeRecord, size);
        defer allocator.free(nodes);
        const ids = try allocator.alloc([24]u8, size);
        defer allocator.free(ids);
        for (nodes, 0..) |*item, i| {
            const id = try std.fmt.bufPrint(&ids[i], "sensor-{d}", .{i});
            item.* = .{ .id = id, .role = .sensor, .cadence = .operational, .owner = "governor-1" };
        }
        var samples: [11]u64 = undefined;
        for (&samples) |*sample| {
            const started = nowNs();
            try development.validateSnapshotFast(allocator, .{ .version = 1, .nodes = nodes, .edges = &.{} });
            sample.* = @intCast(nowNs() - started);
        }
        std.mem.sort(u64, &samples, {}, std.sort.asc(u64));
        const elapsed = samples[samples.len / 2];
        if (sample_index != 0) try out.writeByte(',');
        try out.print("{{\"nodes\":{d},\"median_ns\":{d},\"rounds\":11}}", .{ size, elapsed });
    }
    try out.writeAll("]}\n");
    const written = out.buffered();
    _ = std.c.write(std.c.STDOUT_FILENO, written.ptr, written.len);
}
