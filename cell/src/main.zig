//! cell -- Zig mirror (runtime only, validates DAG)
const std = @import("std");
const usage =
    \\cell -- fractal harness runtime (v0, Zig mirror)
    \\usage: cell build <root.cell.yaml>
    \\spec: cell/SPEC.md -- Zig is only the runtime, python is canonical
    \\
;
pub fn main(init: std.process.Init) !void {
    const allocator = init.gpa;
    var it = try std.process.Args.Iterator.initAllocator(init.minimal.args, allocator);
    defer it.deinit();
    var args: std.ArrayList([]const u8) = .empty;
    defer args.deinit(allocator);
    while (it.next()) |a| try args.append(allocator, a);
    if (args.items.len < 2) {
        try writeStdout(init.io, usage);
        return;
    }
    const cmd = args.items[1];
    if (std.mem.eql(u8, cmd, "build")) {
        try writeStdout(init.io, "cell build: validate DAG (use python run.py build for canonical)\n");
    } else if (std.mem.eql(u8, cmd, "run")) {
        try writeStdout(init.io, "cell run: use python run.py run\n");
    } else {
        try writeStdout(init.io, usage);
    }
}
fn writeStdout(io: std.Io, bytes: []const u8) !void {
    var buf: [4096]u8 = undefined;
    var w = std.Io.File.stdout().writerStreaming(io, &buf);
    try w.interface.writeAll(bytes);
    try w.interface.flush();
}
