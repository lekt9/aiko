//! Live observability edge (§28.3): tail the journal over HTTP so a frontend
//! can watch firings as they commit.
//!
//! This is a *read* surface and is built to stay one. Two refusals are
//! structural rather than advisory:
//!
//!   1. **It never opens the substrate.** It reads `substrate.log` directly and
//!      never takes the exclusive lock, so a running node is unaffected and
//!      cannot be blocked by an observer. That is the same property the
//!      `telemetry` projections rely on.
//!   2. **Artifact payloads never cross the wire.** A firing's ids, sizes,
//!      citations, and claims are streamed; `bytes` are not. An artifact can
//!      hold anything the workload put there — a screenshot, a token, a
//!      key — and an observability port is the wrong place to learn that.
//!      Ids and sizes answer "what happened"; payloads answer something else.
//!
//! Binding is loopback-only unless the caller explicitly opts out, because the
//! stream still reveals the shape of a workload to anyone who can reach it.
//!
//! The journal is append-only, so tailing is the whole implementation: every
//! committed firing is exactly one appended record. There is no separate event
//! bus to fall out of sync with what actually committed.

const std = @import("std");
const mesh_mod = @import("mesh.zig");

const Allocator = std.mem.Allocator;

const PAGE = @embedFile("observe.html");
const POLL_NS: i96 = 120 * std.time.ns_per_ms;

pub const Error = error{
    ObserveAddressNotLoopback,
    InvalidListenAddress,
};

/// One committed firing, reduced to what an observer may see.
const Record = struct {
    schema: []const u8 = "",
    op: []const u8 = "",
    firing_id: []const u8 = "",
    artifacts: []const struct {
        id: []const u8 = "",
        schema: []const u8 = "",
        bytes: []const u8 = "",
        produced_by: []const u8 = "",
    } = &.{},
    messages: []const struct { to: []const u8 = "" } = &.{},
    evidence: []const struct {
        claim: []const u8 = "",
        method: []const u8 = "",
        sources: []const []const u8 = &.{},
    } = &.{},
};

fn isLoopback(address: mesh_mod.net.IpAddress) bool {
    return switch (address) {
        .ip4 => |v4| v4.bytes[0] == 127,
        .ip6 => |v6| std.mem.eql(u8, &v6.bytes, &([_]u8{0} ** 15 ++ [_]u8{1})),
    };
}

/// Project one journal line into the observer's view. Returns null for records
/// that are not committed firings — a snapshot's folded table is served by the
/// `/graph` bootstrap instead, so the stream stays one-record-per-firing.
fn lineToEvent(a: Allocator, line: []const u8, seq: usize) !?[]u8 {
    const rec = std.json.parseFromSliceLeaky(Record, a, line, .{
        .ignore_unknown_fields = true,
    }) catch return null;
    if (!std.mem.eql(u8, rec.op, "commit")) return null;

    var out: std.Io.Writer.Allocating = .init(a);
    const w = &out.writer;
    try w.writeAll("{\"id\":");
    try std.json.Stringify.value(rec.firing_id, .{}, w);
    try w.print(",\"seq\":{},\"w\":[", .{seq});
    for (rec.artifacts, 0..) |artifact, i| {
        if (i != 0) try w.writeAll(",");
        try w.writeAll("{\"id\":");
        try std.json.Stringify.value(artifact.id, .{}, w);
        try w.writeAll(",\"sch\":");
        try std.json.Stringify.value(artifact.schema, .{}, w);
        // Size, never content: hex is two chars per byte.
        try w.print(",\"n\":{}}}", .{artifact.bytes.len / 2});
    }
    try w.writeAll("],\"s\":[");
    for (rec.messages, 0..) |message, i| {
        if (i != 0) try w.writeAll(",");
        try std.json.Stringify.value(message.to, .{}, w);
    }
    try w.writeAll("],\"cites\":[");
    var n: usize = 0;
    for (rec.evidence) |item| for (item.sources) |source| {
        if (n != 0) try w.writeAll(",");
        n += 1;
        try std.json.Stringify.value(source, .{}, w);
    };
    try w.writeAll("],\"ev\":[");
    for (rec.evidence, 0..) |item, i| {
        if (i != 0) try w.writeAll(",");
        try w.writeAll("{\"c\":");
        try std.json.Stringify.value(item.claim, .{}, w);
        try w.writeAll(",\"m\":");
        try std.json.Stringify.value(item.method, .{}, w);
        try w.writeAll("}");
    }
    try w.writeAll("]}");
    return try out.toOwnedSlice();
}

fn readAll(a: Allocator, io: std.Io, path: []const u8, from: u64) !struct { bytes: []u8, size: u64 } {
    const file = std.Io.Dir.cwd().openFile(io, path, .{}) catch
        return .{ .bytes = try a.alloc(u8, 0), .size = from };
    defer file.close(io);
    const size = (try file.stat(io)).size;
    if (size <= from) return .{ .bytes = try a.alloc(u8, 0), .size = size };
    const want: usize = @intCast(size - from);
    const buf = try a.alloc(u8, want);
    const got = try file.readPositionalAll(io, buf, from);
    return .{ .bytes = buf[0..got], .size = from + got };
}

/// Serve the page, a bootstrap of everything already committed, and an SSE
/// stream of everything that commits from here on.
pub fn serve(
    allocator: Allocator,
    io: std.Io,
    state_dir: []const u8,
    listen: []const u8,
    allow_public: bool,
) !void {
    const address = mesh_mod.net.IpAddress.parseLiteral(listen) catch return Error.InvalidListenAddress;
    if (!allow_public and !isLoopback(address)) return Error.ObserveAddressNotLoopback;

    const log_path = try std.fmt.allocPrint(allocator, "{s}/substrate.log", .{state_dir});
    defer allocator.free(log_path);

    var server = try address.listen(io, .{ .reuse_address = true });
    defer server.deinit(io);

    var banner: [160]u8 = undefined;
    const line = try std.fmt.bufPrint(&banner, "neuron observe: http://{s}/ (read-only, loopback={})\n", .{
        listen, isLoopback(address),
    });
    var out_buf: [256]u8 = undefined;
    var stdout = std.Io.File.stdout().writerStreaming(io, &out_buf);
    try stdout.interface.writeAll(line);
    try stdout.interface.flush();

    while (true) {
        const stream = server.accept(io) catch continue;
        handle(allocator, io, stream, log_path) catch {};
        stream.close(io);
    }
}

fn handle(allocator: Allocator, io: std.Io, stream: std.Io.net.Stream, log_path: []const u8) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var in_buf: [4096]u8 = undefined;
    var reader = stream.reader(io, &in_buf);
    var out_buf: [16384]u8 = undefined;
    var writer = stream.writer(io, &out_buf);
    const w = &writer.interface;

    const head = reader.interface.takeDelimiterExclusive('\n') catch return;
    const path = routeOf(head);

    if (std.mem.eql(u8, path, "/events")) return stream_events(a, io, w, log_path);

    if (std.mem.eql(u8, path, "/graph")) {
        const read = try readAll(a, io, log_path, 0);
        var body: std.Io.Writer.Allocating = .init(a);
        const b = &body.writer;
        try b.writeAll("{\"firings\":[");
        var lines = std.mem.splitScalar(u8, read.bytes, '\n');
        var seq: usize = 0;
        var first = true;
        while (lines.next()) |l| {
            if (l.len == 0) continue;
            const event = (try lineToEvent(a, l, seq)) orelse continue;
            if (!first) try b.writeAll(",");
            first = false;
            try b.writeAll(event);
            seq += 1;
        }
        try b.writeAll("]}");
        const bytes = body.writer.buffered();
        try w.print("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", .{bytes.len});
        try w.writeAll(bytes);
        return w.flush();
    }

    try w.print("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", .{PAGE.len});
    try w.writeAll(PAGE);
    try w.flush();
}

fn routeOf(request_line: []const u8) []const u8 {
    var parts = std.mem.splitScalar(u8, request_line, ' ');
    _ = parts.next() orelse return "/";
    const target = parts.next() orelse return "/";
    return std.mem.trimEnd(u8, target, "\r");
}

/// Tail the journal forever, emitting one SSE event per committed firing.
/// Everything already present is replayed first so a late observer still sees
/// the whole graph, then the loop polls for growth.
fn stream_events(a: Allocator, io: std.Io, w: *std.Io.Writer, log_path: []const u8) !void {
    try w.writeAll("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n\r\n");
    try w.flush();

    var offset: u64 = 0;
    var seq: usize = 0;
    while (true) {
        var frame = std.heap.ArenaAllocator.init(a);
        defer frame.deinit();
        const fa = frame.allocator();
        const read = try readAll(fa, io, log_path, offset);
        if (read.bytes.len > 0) {
            var consumed: usize = 0;
            var lines = std.mem.splitScalar(u8, read.bytes, '\n');
            while (lines.next()) |l| {
                // A record is only complete once its newline has landed; a
                // torn tail is left for the next poll rather than parsed.
                if (consumed + l.len >= read.bytes.len) break;
                consumed += l.len + 1;
                if (l.len == 0) continue;
                if (try lineToEvent(fa, l, seq)) |event| {
                    try w.writeAll("data: ");
                    try w.writeAll(event);
                    try w.writeAll("\n\n");
                    seq += 1;
                }
            }
            offset += consumed;
            try w.flush();
        }
        std.Io.sleep(io, .{ .nanoseconds = POLL_NS }, .boot) catch return;
        // A comment frame keeps intermediaries from closing an idle stream and
        // surfaces a dead client as a write error rather than a silent stall.
        w.writeAll(": ping\n\n") catch return;
        w.flush() catch return;
    }
}
