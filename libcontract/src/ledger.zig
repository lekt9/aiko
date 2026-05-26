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

// flock primitive — POSIX-ish but BSD-derived. macOS and Linux both
// expose it via libc. LOCK_EX = 2 (exclusive, blocking); LOCK_UN = 8.
extern fn flock(fd: c_int, op: c_int) c_int;
const LOCK_EX: c_int = 2;
const LOCK_UN: c_int = 8;

/// Acquire an exclusive advisory lock on the ledger's sidecar `.lock` file.
/// Blocks until the lock is granted. Returns the fd holding the lock; the
/// caller MUST close it (via `releaseExclusive` or `c.close`) to release.
///
/// Locking the sidecar (not contracts.jsonl itself) keeps `readAll` non-
/// blocking under contention — readers see the append-only ledger without
/// serialization, and only the cache-check+append seam in declare() pays
/// the serialization cost. Used by contract.declare() to make the
/// findCachedDeclared+appendRow seam atomic against concurrent declares.
pub fn acquireExclusive(allocator: std.mem.Allocator, env: std.process.Environ) !c_int {
    const path = try resolvePath(allocator, env);
    defer allocator.free(path);

    if (std.fs.path.dirname(path)) |parent| {
        try makePath(allocator, parent);
    }

    const lock_path = try std.fmt.allocPrint(allocator, "{s}.lock", .{path});
    defer allocator.free(lock_path);
    const lock_path_z = try allocator.dupeZ(u8, lock_path);
    defer allocator.free(lock_path_z);

    var flags: c.O = .{};
    flags.ACCMODE = .RDWR;
    flags.CREAT = true;
    const fd: c_int = c.open(lock_path_z.ptr, flags, @as(c_uint, 0o644));
    if (fd < 0) return error.OpenFailed;
    errdefer _ = c.close(fd);

    // Blocking exclusive lock. Returns 0 on success; -1 on signal interrupt
    // (which we retry, since callers want serialized semantics).
    while (true) {
        const r = flock(fd, LOCK_EX);
        if (r == 0) break;
        // EINTR retry — any other error is fatal.
        const errno = std.c._errno().*;
        if (errno == 4) continue; // EINTR
        return error.LockFailed;
    }
    return fd;
}

/// Release a lock previously acquired via `acquireExclusive`. Closing the
/// fd implicitly releases the flock; we still call LOCK_UN explicitly so
/// the unlock is visible even if some BSD variant defers fd-close cleanup.
pub fn releaseExclusive(fd: c_int) void {
    _ = flock(fd, LOCK_UN);
    _ = c.close(fd);
}

/// Scan the resolved ledger for a `declared` row with the given contract id
/// and return that row's `inputs_hash` (owned slice; caller frees). Returns
/// null if no row found or no inputs_hash field present (v1 rows had no
/// inputs_hash before contract 27a39635).
///
/// Used by contract.declare() to fold parent.inputs_hash into the child's
/// v2 hash — Docker-layer behavior: when the parent's content changes, the
/// child's cache key invalidates transitively. The lookup is O(ledger
/// rows); for large ledgers (>10k rows) this is the hot path of cache
/// computation, but still well under a millisecond on disk-cached files.
pub fn findInputsHashForId(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
) !?[]u8 {
    const body = readAll(allocator, env) catch return null;
    defer allocator.free(body);
    var iter = std.mem.tokenizeAny(u8, body, "\n");
    while (iter.next()) |line| {
        if (line.len < 2) continue;
        if (std.mem.indexOf(u8, line, "\"event\": \"declared\"") == null and
            std.mem.indexOf(u8, line, "\"event\":\"declared\"") == null) continue;
        // Match the target id.
        var id_needle_buf: [128]u8 = undefined;
        const id_needle = std.fmt.bufPrint(&id_needle_buf, "\"id\": \"{s}\"", .{id}) catch continue;
        if (std.mem.indexOf(u8, line, id_needle) == null) {
            const id_needle2 = std.fmt.bufPrint(&id_needle_buf, "\"id\":\"{s}\"", .{id}) catch continue;
            if (std.mem.indexOf(u8, line, id_needle2) == null) continue;
        }
        // Extract the inputs_hash field value.
        const ih_marker = "\"inputs_hash\": \"";
        const ih_marker2 = "\"inputs_hash\":\"";
        const ih_start = blk: {
            if (std.mem.indexOf(u8, line, ih_marker)) |p| break :blk p + ih_marker.len;
            if (std.mem.indexOf(u8, line, ih_marker2)) |p| break :blk p + ih_marker2.len;
            return null; // Found declared row but no inputs_hash (v1 row).
        };
        const ih_end = std.mem.indexOfScalarPos(u8, line, ih_start, '"') orelse return null;
        return try allocator.dupe(u8, line[ih_start..ih_end]);
    }
    return null;
}

/// Look up the `action` field of the `declared` row for the given id.
/// Returns owned slice on hit; null when the id has no declared row or
/// the row is malformed. Used by the L7→L8 synthesizer in markSatisfied
/// so the cascade can branch on action shape (validate: → signed:).
pub fn findActionForId(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
) !?[]u8 {
    const body = readAll(allocator, env) catch return null;
    defer allocator.free(body);
    var iter = std.mem.tokenizeAny(u8, body, "\n");
    while (iter.next()) |line| {
        if (line.len < 2) continue;
        if (std.mem.indexOf(u8, line, "\"event\": \"declared\"") == null and
            std.mem.indexOf(u8, line, "\"event\":\"declared\"") == null) continue;
        var id_needle_buf: [128]u8 = undefined;
        const id_needle = std.fmt.bufPrint(&id_needle_buf, "\"id\": \"{s}\"", .{id}) catch continue;
        if (std.mem.indexOf(u8, line, id_needle) == null) {
            const id_needle2 = std.fmt.bufPrint(&id_needle_buf, "\"id\":\"{s}\"", .{id}) catch continue;
            if (std.mem.indexOf(u8, line, id_needle2) == null) continue;
        }
        const a_marker = "\"action\": \"";
        const a_marker2 = "\"action\":\"";
        const a_start = blk: {
            if (std.mem.indexOf(u8, line, a_marker)) |p| break :blk p + a_marker.len;
            if (std.mem.indexOf(u8, line, a_marker2)) |p| break :blk p + a_marker2.len;
            return null;
        };
        // Action value is a JSON-escaped string; walk until unescaped closing quote.
        var i: usize = a_start;
        while (i < line.len) : (i += 1) {
            if (line[i] == '\\') {
                i += 1;
                continue;
            }
            if (line[i] == '"') return try allocator.dupe(u8, line[a_start..i]);
        }
        return null;
    }
    return null;
}

/// Slurp the entire resolved ledger file. Returns an owned []u8 (empty when
/// the file doesn't exist). 16 MiB cap is way above the largest ledger ever
/// observed (the global ledger is ~3 MB after months of use).
pub fn readAll(allocator: std.mem.Allocator, env: std.process.Environ) ![]u8 {
    const path = try resolvePath(allocator, env);
    defer allocator.free(path);

    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);

    var flags: c.O = .{};
    flags.ACCMODE = .RDONLY;
    const fd: c_int = c.open(path_z.ptr, flags, @as(c_uint, 0));
    if (fd < 0) {
        // Missing ledger is a normal bootstrap state — return empty.
        return try allocator.alloc(u8, 0);
    }
    defer _ = c.close(fd);

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);

    var chunk: [8192]u8 = undefined;
    while (true) {
        const n = c.read(fd, &chunk, chunk.len);
        if (n <= 0) break;
        try out.appendSlice(allocator, chunk[0..@intCast(n)]);
        if (out.items.len > 16 * 1024 * 1024) return error.LedgerTooLarge;
    }
    return try out.toOwnedSlice(allocator);
}
