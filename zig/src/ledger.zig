//! Ledger row append + path discovery via libc (Zig 0.16 std no longer
//! exposes plain posix write/open/mkdir at the top level).
//!
//! Discovery:
//!   1. <cwd>/.claude/contracts.jsonl if <cwd>/.claude/ is a directory
//!   2. ~/.contracts/contracts.jsonl global fallback
const std = @import("std");

const c = std.c;

/// Resolve the ledger path. Returns an owned slice the caller must free.
pub fn resolvePath(allocator: std.mem.Allocator, env: std.process.Environ) ![]u8 {
    var cwd_buf: [4096]u8 = undefined;
    const cwd_ptr = c.getcwd(&cwd_buf, cwd_buf.len);
    if (cwd_ptr == null) return error.CwdFailed;
    const cwd: []const u8 = std.mem.span(@as([*:0]const u8, @ptrCast(cwd_ptr.?)));

    const project_dir = try std.fs.path.join(allocator, &.{ cwd, ".claude" });
    defer allocator.free(project_dir);

    if (isDirectory(allocator, project_dir)) {
        return try std.fs.path.join(allocator, &.{ cwd, ".claude", "contracts.jsonl" });
    }

    const home = env.getPosix("HOME") orelse return error.NoHome;
    return try std.fs.path.join(allocator, &.{ home, ".contracts", "contracts.jsonl" });
}

// std.c.stat isn't wired on macOS in Zig 0.16; use libc opendir/closedir.
extern fn opendir(name: [*:0]const u8) ?*anyopaque;
extern fn closedir(dirp: *anyopaque) c_int;

fn isDirectory(allocator: std.mem.Allocator, path: []const u8) bool {
    const path_z = allocator.dupeZ(u8, path) catch return false;
    defer allocator.free(path_z);
    const d = opendir(path_z.ptr);
    if (d == null) return false;
    _ = closedir(d.?);
    return true;
}

fn makePath(allocator: std.mem.Allocator, path: []const u8) !void {
    // mkdir each component recursively, ignoring "already exists".
    var i: usize = 0;
    while (i < path.len) : (i += 1) {
        if (path[i] == '/' and i > 0) {
            const partial = try allocator.dupeZ(u8, path[0..i]);
            defer allocator.free(partial);
            _ = c.mkdir(partial.ptr, 0o755);
        }
    }
    const full = try allocator.dupeZ(u8, path);
    defer allocator.free(full);
    _ = c.mkdir(full.ptr, 0o755);
}

/// Append one JSON row (no trailing newline expected) followed by '\n'.
/// Creates the file + parent directory as needed. O_APPEND + single
/// writev syscall keeps row atomicity vs concurrent writers (POSIX
/// guarantees up to PIPE_BUF, plenty for ledger rows).
pub fn appendRow(allocator: std.mem.Allocator, env: std.process.Environ, row_json: []const u8) ![]u8 {
    const path = try resolvePath(allocator, env);
    errdefer allocator.free(path);

    if (std.fs.path.dirname(path)) |parent| {
        try makePath(allocator, parent);
    }

    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);

    var flags: c.O = .{};
    flags.ACCMODE = .WRONLY;
    flags.CREAT = true;
    flags.APPEND = true;
    const fd: c_int = c.open(path_z.ptr, flags, @as(c_uint, 0o644));
    if (fd < 0) return error.OpenFailed;
    defer _ = c.close(fd);

    // One writev so the row+newline land as a single syscall.
    const iovecs = [_]c.iovec_const{
        .{ .base = row_json.ptr, .len = row_json.len },
        .{ .base = "\n", .len = 1 },
    };
    const n = c.writev(fd, &iovecs, iovecs.len);
    if (n < 0) return error.WriteFailed;

    return path;
}

/// Slurp the entire resolved ledger file. Returns an owned []u8; missing
/// ledger is an empty bootstrap state.
pub fn readAll(allocator: std.mem.Allocator, env: std.process.Environ) ![]u8 {
    const path = try resolvePath(allocator, env);
    defer allocator.free(path);

    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);

    var flags: c.O = .{};
    flags.ACCMODE = .RDONLY;
    const fd: c_int = c.open(path_z.ptr, flags, @as(c_uint, 0));
    if (fd < 0) return try allocator.alloc(u8, 0);
    defer _ = c.close(fd);

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    var chunk: [8192]u8 = undefined;
    while (true) {
        const n = c.read(fd, &chunk, chunk.len);
        if (n <= 0) break;
        try out.appendSlice(allocator, chunk[0..@intCast(n)]);
        if (out.items.len > 64 * 1024 * 1024) return error.LedgerTooLarge;
    }
    return try out.toOwnedSlice(allocator);
}
