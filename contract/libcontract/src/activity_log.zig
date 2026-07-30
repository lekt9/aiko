//! activity_log.zig — local operational health log for /contract.
//!
//! This is deliberately separate from the signed semantic ledger. The ledger
//! records what contracts mean; this file records whether the executable ran
//! and which internal path it took. Callers must pass controlled metadata only:
//! never goals, proofs, payloads, environment values, keys, or credentials.

const std = @import("std");
const builtin = @import("builtin");
const event_schema = @import("event_schema.zig");
const is_windows = builtin.os.tag == .windows;

extern fn _open(path: [*:0]const u8, flags: c_int, ...) c_int;
extern fn _close(fd: c_int) c_int;
extern fn _write(fd: c_int, buffer: [*]const u8, count: c_uint) c_int;
extern fn _lseek(fd: c_int, offset: c_long, origin: c_int) c_long;
extern fn _mkdir(path: [*:0]const u8) c_int;
extern fn _access(path: [*:0]const u8, mode: c_int) c_int;
extern fn _getpid() c_int;
extern fn _time64(timer: ?*i64) i64;

const O_RDONLY: c_int = 0x0000;
const O_WRONLY: c_int = 0x0001;
const O_APPEND: c_int = 0x0008;
const O_CREAT: c_int = 0x0100;
const O_BINARY: c_int = 0x8000;

fn closeFd(fd: c_int) void {
    _ = if (is_windows) _close(fd) else std.c.close(fd);
}

const MAX_LOG_BYTES: i64 = 5 * 1024 * 1024;

fn sanitize(dst: []u8, src: []const u8) []const u8 {
    const n = @min(dst.len, src.len);
    for (src[0..n], 0..) |c, i| {
        dst[i] = if (c >= 0x20 and c <= 0x7e and c != '"' and c != '\\') c else '_';
    }
    return dst[0..n];
}

fn ensureDirAndPath(path_buf: []u8, dir_buf: []u8) ?[:0]u8 {
    // Prefer the project-local observability surface when the ledger is also
    // project-local. Agent sandboxes commonly allow cwd writes but deny HOME
    // writes; logging beside `.claude/contracts.jsonl` keeps those invocations
    // visible instead of silently dropping them.
    var cwd_buf: [4096]u8 = undefined;
    if (std.c.getcwd(&cwd_buf, cwd_buf.len)) |_| {
        const cwd_len = std.mem.indexOfScalar(u8, &cwd_buf, 0) orelse cwd_buf.len;
        const project_dir = std.fmt.bufPrintZ(dir_buf, "{s}/.claude", .{cwd_buf[0..cwd_len]}) catch return null;
        if ((if (is_windows) _access(project_dir.ptr, 0) else std.c.access(project_dir.ptr, 0)) == 0) {
            return std.fmt.bufPrintZ(path_buf, "{s}/activity.log", .{project_dir}) catch null;
        }
    }

    const home_z = std.c.getenv(if (is_windows) "USERPROFILE" else "HOME") orelse return null;
    const home = std.mem.span(@as([*:0]const u8, @ptrCast(home_z)));
    const dir = std.fmt.bufPrintZ(dir_buf, "{s}/.contracts", .{home}) catch return null;
    _ = if (is_windows) _mkdir(dir.ptr) else std.c.mkdir(dir.ptr, 0o700);
    return std.fmt.bufPrintZ(path_buf, "{s}/activity.log", .{dir}) catch null;
}

fn rotateIfNeeded(path: [:0]const u8, rotated_buf: []u8) void {
    const fd: c_int = if (is_windows) _open(path.ptr, O_RDONLY | O_BINARY) else blk: {
        var flags: std.c.O = .{};
        flags.ACCMODE = .RDONLY;
        break :blk std.c.open(path.ptr, flags, @as(c_uint, 0));
    };
    if (fd < 0) return;
    const size = if (is_windows) _lseek(fd, 0, 2) else std.c.lseek(fd, 0, std.c.SEEK.END);
    closeFd(fd);
    if (size < MAX_LOG_BYTES) return;
    const path_slice = std.mem.span(path.ptr);
    const rotated = std.fmt.bufPrintZ(rotated_buf, "{s}.1", .{path_slice}) catch return;
    _ = std.c.unlink(rotated.ptr);
    _ = std.c.rename(path.ptr, rotated.ptr);
}

/// Append one redacted operational event. Logging is best-effort and can never
/// block or fail the contract action it observes.
pub fn record(event: []const u8, detail: []const u8) void {
    var path_buf: [4096]u8 = undefined;
    var dir_buf: [4096]u8 = undefined;
    const path = ensureDirAndPath(&path_buf, &dir_buf) orelse return;

    var rotated_buf: [4096]u8 = undefined;
    rotateIfNeeded(path, &rotated_buf);

    const fd: c_int = if (is_windows) _open(path.ptr, O_WRONLY | O_CREAT | O_APPEND | O_BINARY, @as(c_int, 0o600)) else blk: {
        var flags: std.c.O = .{};
        flags.ACCMODE = .WRONLY;
        flags.CREAT = true;
        flags.APPEND = true;
        break :blk std.c.open(path.ptr, flags, @as(c_uint, 0o600));
    };
    if (fd < 0) return;
    defer closeFd(fd);
    if (!is_windows) _ = std.c.fchmod(fd, 0o600);

    var event_buf: [96]u8 = undefined;
    var detail_buf: [512]u8 = undefined;
    const safe_event = sanitize(&event_buf, event);
    const safe_detail = sanitize(&detail_buf, detail);

    var tv: std.c.timeval = undefined;
    if (is_windows) {
        tv.sec = @intCast(_time64(null));
        tv.usec = 0;
    } else _ = std.c.gettimeofday(&tv, null);
    var line_buf: [768]u8 = undefined;
    const line = std.fmt.bufPrint(
        &line_buf,
        "{d}.{d:0>6} pid={d} event={s} detail={s}\n",
        .{ tv.sec, tv.usec, if (is_windows) _getpid() else std.c.getpid(), safe_event, safe_detail },
    ) catch return;
    _ = if (is_windows) _write(fd, line.ptr, @intCast(line.len)) else std.c.write(fd, line.ptr, line.len);
}

/// Append a stable causal JSON event to `events.jsonl`. This path uses the
/// same local-directory resolution as the compatibility activity log and does
/// not resolve lineage, credentials, or Keychain state.
pub fn recordEvent(event: event_schema.CausalEvent) void {
    event.validate() catch return;

    var activity_path_buf: [4096]u8 = undefined;
    var dir_buf: [4096]u8 = undefined;
    _ = ensureDirAndPath(&activity_path_buf, &dir_buf) orelse return;
    const dir = std.mem.span(@as([*:0]const u8, @ptrCast(&dir_buf)));
    var path_buf: [4096]u8 = undefined;
    const path = std.fmt.bufPrintZ(&path_buf, "{s}/events.jsonl", .{dir}) catch return;

    var rotated_buf: [4096]u8 = undefined;
    rotateIfNeeded(path, &rotated_buf);
    const fd: c_int = if (is_windows) _open(path.ptr, O_WRONLY | O_CREAT | O_APPEND | O_BINARY, @as(c_int, 0o600)) else blk: {
        var flags: std.c.O = .{};
        flags.ACCMODE = .WRONLY;
        flags.CREAT = true;
        flags.APPEND = true;
        break :blk std.c.open(path.ptr, flags, @as(c_uint, 0o600));
    };
    if (fd < 0) return;
    defer closeFd(fd);
    if (!is_windows) _ = std.c.fchmod(fd, 0o600);

    var line_buf: [2048]u8 = undefined;
    var writer = std.Io.Writer.fixed(&line_buf);
    event_schema.encode(&writer, event) catch return;
    const line = writer.buffered();
    _ = if (is_windows) _write(fd, line.ptr, @intCast(line.len)) else std.c.write(fd, line.ptr, line.len);
}

test "sanitize keeps log records single-line and non-structural" {
    var buf: [32]u8 = undefined;
    try std.testing.expectEqualStrings("hello___world", sanitize(&buf, "hello\n\"\\world"));
}
