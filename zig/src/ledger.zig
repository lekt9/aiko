//! Ledger row append + path discovery.
//!
//! Discovery (mirrors contract_core._resolve_ledger()):
//!   1. $CONTRACTS_STORE — explicit override
//!   2. <cwd>/.claude/contracts.jsonl if <cwd>/.claude/ is a directory
//!   3. ~/.contracts/contracts.jsonl global fallback
const std = @import("std");

/// Resolve the ledger path. Returns an owned slice the caller must free.
pub fn resolvePath(allocator: std.mem.Allocator) ![]u8 {
    if (std.process.getEnvVarOwned(allocator, "CONTRACTS_STORE")) |env_val| {
        return env_val;
    } else |err| switch (err) {
        error.EnvironmentVariableNotFound => {},
        else => return err,
    }

    var cwd_buf: [std.fs.max_path_bytes]u8 = undefined;
    const cwd = try std.process.getCwd(&cwd_buf);

    const project_dir = try std.fs.path.join(allocator, &.{ cwd, ".claude" });
    defer allocator.free(project_dir);

    var dir_stat = std.fs.cwd().openDir(project_dir, .{}) catch null;
    if (dir_stat) |*d| {
        d.close();
        return try std.fs.path.join(allocator, &.{ cwd, ".claude", "contracts.jsonl" });
    }

    const home = std.process.getEnvVarOwned(allocator, "HOME") catch return error.NoHome;
    defer allocator.free(home);
    return try std.fs.path.join(allocator, &.{ home, ".contracts", "contracts.jsonl" });
}

/// Append one JSON row (no trailing newline expected) followed by '\n'.
/// Creates the file + parent directory as needed. O_APPEND for atomicity at
/// the single-write level (kernel guarantees on POSIX for small writes).
pub fn appendRow(allocator: std.mem.Allocator, row_json: []const u8) ![]u8 {
    const path = try resolvePath(allocator);
    errdefer allocator.free(path);

    if (std.fs.path.dirname(path)) |parent| {
        std.fs.cwd().makePath(parent) catch |err| switch (err) {
            error.PathAlreadyExists => {},
            else => return err,
        };
    }

    var file = try std.fs.cwd().createFile(path, .{
        .truncate = false,
        .read = false,
    });
    defer file.close();

    try file.seekFromEnd(0);

    // One writev so the row+newline land as a single syscall (no interleave
    // between concurrent writers up to PIPE_BUF, which is plenty for our rows).
    const iovecs = [_]std.posix.iovec_const{
        .{ .base = row_json.ptr, .len = row_json.len },
        .{ .base = "\n".ptr, .len = 1 },
    };
    _ = try std.posix.writev(file.handle, &iovecs);

    return path;
}
