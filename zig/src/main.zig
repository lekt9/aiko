//! contract-zig — Stage 1 binary for the /contract substrate.
//!
//! Σ18 bootstrap floor (declare, iterate, _mark, self). Γ1 no stubs:
//! iterate and _mark exit 1 with an explicit STAGE 2 PENDING block
//! pointing at gap aa1176c4. Stage 1 ships ONLY declare + self.
//!
//! Zig 0.16: main takes std.process.Init.Minimal so we have args + environ
//! without going through the Io vtable for trivial argv parsing. All real
//! I/O (file writes, stdout/stderr) uses std.c.* libc calls — macOS-first,
//! works on every POSIX target that links libc.
const std = @import("std");
const id = @import("id.zig");
const pointer = @import("pointer.zig");
const ledger = @import("ledger.zig");

const VERSION = "0.0.1-stage1";
const STAGE2_GAP = "aa1176c4";

// ── tiny POSIX I/O helpers (no Io vtable needed for stdout/stderr) ─────────
fn writeFd(fd: c_int, bytes: []const u8) void {
    var rem = bytes;
    while (rem.len > 0) {
        const n = std.c.write(fd, rem.ptr, rem.len);
        if (n <= 0) return;
        rem = rem[@intCast(n)..];
    }
}

fn stdoutWrite(bytes: []const u8) void {
    writeFd(std.c.STDOUT_FILENO, bytes);
}

fn stderrWrite(bytes: []const u8) void {
    writeFd(std.c.STDERR_FILENO, bytes);
}

fn stderrPrint(comptime fmt: []const u8, args: anytype) void {
    var buf: [4096]u8 = undefined;
    const s = std.fmt.bufPrint(&buf, fmt, args) catch return;
    stderrWrite(s);
}

fn printUsageStderr() void {
    stderrPrint(
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

fn nowIsoUtc(buf: []u8) ![]u8 {
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

fn getAgent(allocator: std.mem.Allocator, env: std.process.Environ) ![]u8 {
    // CONTRACT_AGENT > git config user.email > empty.
    if (env.getPosix("CONTRACT_AGENT")) |v| {
        const trimmed = std.mem.trim(u8, v, " \t\r\n");
        if (trimmed.len > 0) return try allocator.dupe(u8, trimmed);
    }

    // Shell out to git via libc system()? Simpler: read git config from
    // ~/.gitconfig manually OR shell out via std.c.popen. The Python uses
    // `git config user.email`; we mirror it via popen for parity.
    var pipe_buf: [256]u8 = undefined;
    const cmd: [*:0]const u8 = "git config user.email 2>/dev/null";
    const f = std.c.popen(cmd, "r");
    if (f == null) return try allocator.dupe(u8, "");
    defer _ = std.c.pclose(f.?);
    var total: usize = 0;
    while (total < pipe_buf.len - 1) {
        const got = std.c.fread(pipe_buf[total..].ptr, 1, pipe_buf.len - 1 - total, f.?);
        if (got == 0) break;
        total += got;
    }
    const out = std.mem.trim(u8, pipe_buf[0..total], " \t\r\n");
    return try allocator.dupe(u8, out);
}

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

fn parseDeclareArgs(args: []const []const u8) !DeclareArgs {
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

fn cmdDeclare(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    args: []const []const u8,
) !u8 {
    const dargs = parseDeclareArgs(args) catch |e| {
        stderrPrint("contract-zig declare: argument error ({s})\n", .{@errorName(e)});
        printUsageStderr();
        return 2;
    };

    const cid = try id.generateId(allocator);
    defer allocator.free(cid);

    const ptype = pointer.inferPointerType(dargs.action);
    const layer = pointer.inferLayer(dargs.action);

    var ts_buf: [64]u8 = undefined;
    const ts = try nowIsoUtc(&ts_buf);

    // cwd via libc getcwd
    var cwd_buf: [4096]u8 = undefined;
    const cwd_ptr = std.c.getcwd(&cwd_buf, cwd_buf.len);
    const cwd: []const u8 = if (cwd_ptr == null) "" else std.mem.span(@as([*:0]const u8, @ptrCast(cwd_ptr.?)));

    const agent = try getAgent(allocator, env);
    defer allocator.free(agent);

    const refs = try pointer.extractContractRefs(allocator, dargs.action);
    defer {
        for (refs) |r| allocator.free(r);
        allocator.free(refs);
    }

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

    const path = try ledger.appendRow(allocator, env, buf.items);
    defer allocator.free(path);

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
        const p2 = try ledger.appendRow(allocator, env, child_buf.items);
        allocator.free(p2);
    }

    var out_buf: [16]u8 = undefined;
    const out_line = try std.fmt.bufPrint(&out_buf, "{s}\n", .{cid});
    stdoutWrite(out_line);
    return 0;
}

fn cmdSelf() u8 {
    const payload =
        "{\"binary\":\"contract-zig\", \"version\":\"" ++ VERSION ++ "\", " ++
        "\"verbs\":[\"declare\",\"self\"], \"stage2_pending\":\"" ++ STAGE2_GAP ++ "\"}\n";
    stdoutWrite(payload);
    return 0;
}

fn cmdStage2Pending(verb: []const u8) u8 {
    stderrPrint(
        \\=== STAGE 2 PENDING (gap {s}) ===
        \\verb '{s}' is declared on this binary but NOT YET IMPLEMENTED in
        \\Stage 1. The remote-delegation path (UNBROWSE_BASE → POST
        \\/v1/contract/invoke) plus local-required fallback is the Stage 2
        \\scope. See: contract status {s}
        \\Refusing to fake-pass per Γ1 no-stubs.
        \\
    , .{ STAGE2_GAP, verb, STAGE2_GAP });
    return 1;
}

pub fn main(init: std.process.Init.Minimal) !u8 {
    var gpa: std.heap.DebugAllocator(.{}) = .init;
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    // Materialize argv as a slice of []const u8 (drop nul-termination).
    var arena: std.heap.ArenaAllocator = .init(allocator);
    defer arena.deinit();
    const arena_alloc = arena.allocator();
    const argv_z = try init.args.toSlice(arena_alloc);

    if (argv_z.len < 2) {
        printUsageStderr();
        return 2;
    }

    const verb: []const u8 = argv_z[1];
    // Build a flat []const []const u8 for the dispatcher.
    var rest = try arena_alloc.alloc([]const u8, argv_z.len - 2);
    for (argv_z[2..], 0..) |a, i| rest[i] = a;

    if (std.mem.eql(u8, verb, "declare")) {
        return try cmdDeclare(allocator, init.environ, rest);
    } else if (std.mem.eql(u8, verb, "self")) {
        return cmdSelf();
    } else if (std.mem.eql(u8, verb, "iterate")) {
        return cmdStage2Pending("iterate");
    } else if (std.mem.eql(u8, verb, "_mark")) {
        return cmdStage2Pending("_mark");
    } else {
        stderrPrint("contract-zig: unknown verb '{s}'\n\n", .{verb});
        printUsageStderr();
        return 2;
    }
}
