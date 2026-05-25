//! contract-zig — Stage 1 binary for the /contract substrate.
//!
//! Σ18 bootstrap floor (declare, iterate, _mark, self). Γ1 no stubs:
//! iterate and _mark exit 1 with an explicit STAGE 2 PENDING block
//! pointing at gap aa1176c4. Stage 1 ships ONLY declare + self.
const std = @import("std");
const id = @import("id.zig");
const pointer = @import("pointer.zig");
const ledger = @import("ledger.zig");

const VERSION = "0.0.1-stage1";
const STAGE2_GAP = "aa1176c4";

fn printUsage(w: anytype) !void {
    try w.print(
        \\contract-zig {s} — Stage 1 (declare + self only)
        \\
        \\Usage:
        \\  contract-zig declare <plan> [--action <a>] [--parent <id>]
        \\  contract-zig self
        \\  contract-zig iterate <id>          (Stage 2 — gap {s})
        \\  contract-zig _mark <id> <status>   (Stage 2 — gap {s})
        \\
    , .{ VERSION, STAGE2_GAP, STAGE2_GAP });
}

fn writeStdout(bytes: []const u8) !void {
    const stdout_file = std.fs.File.stdout();
    try stdout_file.writeAll(bytes);
}

fn writeStderr(bytes: []const u8) !void {
    const stderr_file = std.fs.File.stderr();
    try stderr_file.writeAll(bytes);
}

const StderrPrinter = struct {
    pub fn print(self: @This(), comptime fmt: []const u8, args: anytype) !void {
        _ = self;
        var buf: [4096]u8 = undefined;
        const s = try std.fmt.bufPrint(&buf, fmt, args);
        try writeStderr(s);
    }
    pub fn writeAll(self: @This(), bytes: []const u8) !void {
        _ = self;
        try writeStderr(bytes);
    }
};

fn nowIsoUtc(buf: []u8) ![]u8 {
    // Python emits "YYYY-MM-DDTHH:MM:SS.ffffffZ" (microsecond precision).
    // We emit microsecond precision using std.time.microTimestamp.
    const us_total: i64 = std.time.microTimestamp();
    const secs_total: i64 = @divFloor(us_total, std.time.us_per_s);
    const us_remainder: i64 = @mod(us_total, std.time.us_per_s);

    const epoch_secs = std.time.epoch.EpochSeconds{ .secs = @intCast(secs_total) };
    const epoch_day = epoch_secs.getEpochDay();
    const year_day = epoch_day.calculateYearDay();
    const month_day = year_day.calculateMonthDay();
    const day_secs = epoch_secs.getDaySeconds();

    return try std.fmt.bufPrint(buf, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.{d:0>6}Z", .{
        year_day.year,
        month_day.month.numeric(),
        month_day.day_index + 1,
        day_secs.getHoursIntoDay(),
        day_secs.getMinutesIntoHour(),
        day_secs.getSecondsIntoMinute(),
        @as(u64, @intCast(us_remainder)),
    });
}

fn getAgent(allocator: std.mem.Allocator) ![]u8 {
    // CONTRACT_AGENT > git config user.email > empty.
    if (std.process.getEnvVarOwned(allocator, "CONTRACT_AGENT")) |v| {
        const trimmed = std.mem.trim(u8, v, " \t\r\n");
        if (trimmed.len > 0) {
            const out = try allocator.dupe(u8, trimmed);
            allocator.free(v);
            return out;
        }
        allocator.free(v);
    } else |err| switch (err) {
        error.EnvironmentVariableNotFound => {},
        else => return err,
    }

    var child = std.process.Child.init(&.{ "git", "config", "user.email" }, allocator);
    child.stdin_behavior = .Ignore;
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Ignore;
    child.spawn() catch return try allocator.dupe(u8, "");
    var stdout: std.ArrayList(u8) = .empty;
    defer stdout.deinit(allocator);
    var stderr_buf: std.ArrayList(u8) = .empty;
    defer stderr_buf.deinit(allocator);
    child.collectOutput(allocator, &stdout, &stderr_buf, 4096) catch {
        _ = child.wait() catch {};
        return try allocator.dupe(u8, "");
    };
    _ = child.wait() catch {};
    const out = std.mem.trim(u8, stdout.items, " \t\r\n");
    return try allocator.dupe(u8, out);
}

/// Append a single JSON object field. Strings only — values are JSON-escaped.
fn writeJsonString(out: *std.ArrayList(u8), allocator: std.mem.Allocator, s: []const u8) !void {
    try out.append(allocator, '"');
    for (s) |c| {
        switch (c) {
            '"' => try out.appendSlice(allocator, "\\\""),
            '\\' => try out.appendSlice(allocator, "\\\\"),
            '\n' => try out.appendSlice(allocator, "\\n"),
            '\r' => try out.appendSlice(allocator, "\\r"),
            '\t' => try out.appendSlice(allocator, "\\t"),
            0x08 => try out.appendSlice(allocator, "\\b"),
            0x0c => try out.appendSlice(allocator, "\\f"),
            else => {
                if (c < 0x20) {
                    var buf: [8]u8 = undefined;
                    const hex = try std.fmt.bufPrint(&buf, "\\u{x:0>4}", .{c});
                    try out.appendSlice(allocator, hex);
                } else {
                    try out.append(allocator, c);
                }
            },
        }
    }
    try out.append(allocator, '"');
}

const DeclareArgs = struct {
    plan: []const u8,
    action: []const u8 = "agent-judges",
    parent: ?[]const u8 = null,
};

fn parseDeclareArgs(args: [][]const u8) !DeclareArgs {
    if (args.len < 1) return error.MissingPlan;
    var out = DeclareArgs{ .plan = args[0] };
    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        const a = args[i];
        if (std.mem.eql(u8, a, "--action")) {
            i += 1;
            if (i >= args.len) return error.MissingValue;
            out.action = args[i];
        } else if (std.mem.eql(u8, a, "--parent")) {
            i += 1;
            if (i >= args.len) return error.MissingValue;
            out.parent = args[i];
        } else {
            return error.UnknownFlag;
        }
    }
    return out;
}

fn cmdDeclare(allocator: std.mem.Allocator, args: [][]const u8) !u8 {
    const dargs = parseDeclareArgs(args) catch |e| {
        try StderrPrinter.print(.{}, "contract-zig declare: argument error ({s})\n", .{@errorName(e)});
        try printUsage(StderrPrinter{});
        return 2;
    };

    const cid = try id.generateId(allocator);
    defer allocator.free(cid);

    const ptype = pointer.inferPointerType(dargs.action);
    const layer = pointer.inferLayer(dargs.action);

    var ts_buf: [64]u8 = undefined;
    const ts = try nowIsoUtc(&ts_buf);

    var cwd_buf: [std.fs.max_path_bytes]u8 = undefined;
    const cwd = try std.process.getCwd(&cwd_buf);

    const agent = try getAgent(allocator);
    defer allocator.free(agent);

    const refs = try pointer.extractContractRefs(allocator, dargs.action);
    defer {
        for (refs) |r| allocator.free(r);
        allocator.free(refs);
    }

    // Build the row manually to control key order & match Python's json.dumps
    // (key insertion order from declare() in contract_core.py).
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);

    try buf.appendSlice(allocator, "{\"event\": \"declared\", \"id\": ");
    try writeJsonString(&buf, allocator, cid);
    try buf.appendSlice(allocator, ", \"plan\": ");
    try writeJsonString(&buf, allocator, dargs.plan);
    try buf.appendSlice(allocator, ", \"action\": ");
    try writeJsonString(&buf, allocator, dargs.action);
    try buf.appendSlice(allocator, ", \"pointer_type\": ");
    try writeJsonString(&buf, allocator, ptype);
    try buf.appendSlice(allocator, ", \"layer\": ");
    var layer_buf: [16]u8 = undefined;
    const layer_str = try std.fmt.bufPrint(&layer_buf, "{d}", .{layer});
    try buf.appendSlice(allocator, layer_str);
    try buf.appendSlice(allocator, ", \"cwd\": ");
    try writeJsonString(&buf, allocator, cwd);
    try buf.appendSlice(allocator, ", \"parent_id\": ");
    if (dargs.parent) |p| {
        try writeJsonString(&buf, allocator, p);
    } else {
        try buf.appendSlice(allocator, "null");
    }
    try buf.appendSlice(allocator, ", \"pointers\": [");
    for (refs, 0..) |r, idx| {
        if (idx > 0) try buf.appendSlice(allocator, ", ");
        try writeJsonString(&buf, allocator, r);
    }
    try buf.appendSlice(allocator, "], \"ts\": ");
    try writeJsonString(&buf, allocator, ts);
    try buf.appendSlice(allocator, ", \"agent\": ");
    try writeJsonString(&buf, allocator, agent);
    try buf.append(allocator, '}');

    const path = try ledger.appendRow(allocator, buf.items);
    defer allocator.free(path);

    // child_added event when parent is set, mirroring contract_core.declare().
    if (dargs.parent) |p| {
        var child_buf: std.ArrayList(u8) = .empty;
        defer child_buf.deinit(allocator);
        try child_buf.appendSlice(allocator, "{\"event\": \"child_added\", \"id\": ");
        try writeJsonString(&child_buf, allocator, p);
        try child_buf.appendSlice(allocator, ", \"child_id\": ");
        try writeJsonString(&child_buf, allocator, cid);
        try child_buf.appendSlice(allocator, ", \"ts\": ");
        var ts2_buf: [64]u8 = undefined;
        const ts2 = try nowIsoUtc(&ts2_buf);
        try writeJsonString(&child_buf, allocator, ts2);
        try child_buf.appendSlice(allocator, ", \"agent\": ");
        try writeJsonString(&child_buf, allocator, agent);
        try child_buf.append(allocator, '}');
        const p2 = try ledger.appendRow(allocator, child_buf.items);
        allocator.free(p2);
    }

    // Print just the id to stdout — matches contract_core.declare() return.
    var out_buf: [16]u8 = undefined;
    const out_line = try std.fmt.bufPrint(&out_buf, "{s}\n", .{cid});
    try writeStdout(out_line);
    return 0;
}

fn cmdSelf() !u8 {
    const payload =
        "{\"binary\":\"contract-zig\", \"version\":\"" ++ VERSION ++ "\", " ++
        "\"verbs\":[\"declare\",\"self\"], \"stage2_pending\":\"" ++ STAGE2_GAP ++ "\"}\n";
    try writeStdout(payload);
    return 0;
}

fn cmdStage2Pending(verb: []const u8) !u8 {
    var buf: [512]u8 = undefined;
    const msg = try std.fmt.bufPrint(&buf,
        \\=== STAGE 2 PENDING (gap {s}) ===
        \\verb '{s}' is declared on this binary but NOT YET IMPLEMENTED in
        \\Stage 1. The remote-delegation path (UNBROWSE_BASE → POST
        \\/v1/contract/invoke) plus local-required fallback is the Stage 2
        \\scope. See: contract status {s}
        \\Refusing to fake-pass per Γ1 no-stubs.
        \\
    , .{ STAGE2_GAP, verb, STAGE2_GAP });
    try writeStderr(msg);
    return 1;
}

pub fn main() !u8 {
    var gpa: std.heap.DebugAllocator(.{}) = .init;
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);

    if (args.len < 2) {
        try printUsage(StderrPrinter{});
        return 2;
    }

    const verb = args[1];
    const rest = args[2..];

    if (std.mem.eql(u8, verb, "declare")) {
        return try cmdDeclare(allocator, rest);
    } else if (std.mem.eql(u8, verb, "self")) {
        return try cmdSelf();
    } else if (std.mem.eql(u8, verb, "iterate")) {
        return try cmdStage2Pending("iterate");
    } else if (std.mem.eql(u8, verb, "_mark")) {
        return try cmdStage2Pending("_mark");
    } else {
        try StderrPrinter.print(.{}, "contract-zig: unknown verb '{s}'\n\n", .{verb});
        try printUsage(StderrPrinter{});
        return 2;
    }
}
