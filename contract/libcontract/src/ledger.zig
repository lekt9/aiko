//! Ledger row append + path discovery via libc (Zig 0.16 std no longer
//! exposes plain posix write/open/mkdir at the top level).
//!
//! Discovery:
//!   1. <cwd>/.claude/contracts.jsonl if <cwd>/.claude/ is a directory
//!   2. ~/.contracts/contracts.jsonl global fallback
const std = @import("std");
const builtin = @import("builtin");

/// Contract-owned reachability/checkpoint kernel used by ledger storage adapters.
pub const retention = @import("cross_journal_retention.zig");

const c = std.c;
const is_windows = builtin.os.tag == .windows;

extern fn _open(path: [*:0]const u8, flags: c_int, ...) c_int;
extern fn _close(fd: c_int) c_int;
extern fn _read(fd: c_int, buffer: [*]u8, count: c_uint) c_int;
extern fn _write(fd: c_int, buffer: [*]const u8, count: c_uint) c_int;
extern fn _lseek(fd: c_int, offset: c_long, origin: c_int) c_long;
extern fn _mkdir(path: [*:0]const u8) c_int;
extern fn _access(path: [*:0]const u8, mode: c_int) c_int;
extern fn _getcwd(buffer: [*]u8, max_len: c_int) ?[*]u8;
extern fn _locking(fd: c_int, mode: c_int, bytes: c_long) c_int;

const O_RDONLY: c_int = 0x0000;
const O_WRONLY: c_int = 0x0001;
const O_RDWR: c_int = 0x0002;
const O_APPEND: c_int = 0x0008;
const O_CREAT: c_int = 0x0100;
const O_BINARY: c_int = 0x8000;

fn closeFd(fd: c_int) void {
    _ = if (is_windows) _close(fd) else c.close(fd);
}

fn readFd(fd: c_int, buffer: []u8) isize {
    if (is_windows) return _read(fd, buffer.ptr, @intCast(@min(buffer.len, std.math.maxInt(c_uint))));
    return c.read(fd, buffer.ptr, buffer.len);
}

fn seekEnd(fd: c_int) i64 {
    if (is_windows) return _lseek(fd, 0, 2);
    return c.lseek(fd, 0, c.SEEK.END);
}

/// Resolve the ledger path. Returns an owned slice the caller must free.
pub fn resolvePath(allocator: std.mem.Allocator, env: std.process.Environ) ![]u8 {
    var cwd_buf: [4096]u8 = undefined;
    const cwd_ptr = if (is_windows)
        _getcwd(&cwd_buf, @intCast(cwd_buf.len))
    else
        c.getcwd(&cwd_buf, cwd_buf.len);
    if (cwd_ptr == null) return error.CwdFailed;
    const cwd: []const u8 = std.mem.span(@as([*:0]const u8, @ptrCast(cwd_ptr.?)));

    const project_dir = try std.fs.path.join(allocator, &.{ cwd, ".claude" });
    defer allocator.free(project_dir);

    if (isDirectory(allocator, project_dir)) {
        return try std.fs.path.join(allocator, &.{ cwd, ".claude", "contracts.jsonl" });
    }

    if (is_windows) {
        const home = env.getAlloc(allocator, "USERPROFILE") catch return error.NoHome;
        defer allocator.free(home);
        return try std.fs.path.join(allocator, &.{ home, ".contracts", "contracts.jsonl" });
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
    if (is_windows) return _access(path_z.ptr, 0) == 0;
    const d = opendir(path_z.ptr);
    if (d == null) return false;
    _ = closedir(d.?);
    return true;
}

fn makePath(allocator: std.mem.Allocator, path: []const u8) !void {
    // mkdir each component recursively, ignoring "already exists".
    var i: usize = 0;
    while (i < path.len) : (i += 1) {
        if ((path[i] == '/' or (is_windows and path[i] == '\\')) and i > 0) {
            const partial = try allocator.dupeZ(u8, path[0..i]);
            defer allocator.free(partial);
            _ = if (is_windows) _mkdir(partial.ptr) else c.mkdir(partial.ptr, 0o755);
        }
    }
    const full = try allocator.dupeZ(u8, path);
    defer allocator.free(full);
    _ = if (is_windows) _mkdir(full.ptr) else c.mkdir(full.ptr, 0o755);
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

    const fd: c_int = if (is_windows) blk: {
        break :blk _open(path_z.ptr, O_WRONLY | O_CREAT | O_APPEND | O_BINARY, @as(c_int, 0o644));
    } else blk: {
        var flags: c.O = .{};
        flags.ACCMODE = .WRONLY;
        flags.CREAT = true;
        flags.APPEND = true;
        break :blk c.open(path_z.ptr, flags, @as(c_uint, 0o644));
    };
    if (fd < 0) return error.OpenFailed;
    defer closeFd(fd);

    // One writev so the row+newline land as a single syscall.
    const iovecs = [_]c.iovec_const{
        .{ .base = row_json.ptr, .len = row_json.len },
        .{ .base = "\n", .len = 1 },
    };
    if (is_windows) {
        if (_write(fd, row_json.ptr, @intCast(row_json.len)) < 0 or _write(fd, "\n", 1) < 0)
            return error.WriteFailed;
    } else if (c.writev(fd, &iovecs, iovecs.len) < 0) return error.WriteFailed;

    return path;
}

/// Publish several already-encoded JSON events as one JSONL transaction row.
/// A torn tail is not valid JSON and is ignored by replay; a valid row exposes
/// the complete event array. The caller owns the higher-level transaction lock.
pub fn appendRowsAtomic(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    rows: []const []const u8,
) ![]u8 {
    if (rows.len == 0) return error.EmptyBatch;
    var batch: std.ArrayList(u8) = .empty;
    defer batch.deinit(allocator);
    var total: usize = 64;
    for (rows) |row| {
        if (row.len == 0 or std.mem.indexOfScalar(u8, row, '\n') != null)
            return error.InvalidRow;
        total = std.math.add(usize, total, row.len) catch return error.BatchTooLarge;
        total = std.math.add(usize, total, 1) catch return error.BatchTooLarge;
    }
    if (total > 1024 * 1024) return error.BatchTooLarge;
    try batch.ensureTotalCapacity(allocator, total);
    batch.appendSliceAssumeCapacity("{\"event\":\"neuron_transaction\",\"version\":1,\"rows\":[");
    for (rows, 0..) |row, index| {
        if (index > 0) batch.appendAssumeCapacity(',');
        batch.appendSliceAssumeCapacity(row);
    }
    batch.appendSliceAssumeCapacity("]}");
    return appendRow(allocator, env, batch.items);
}

// flock primitive — POSIX-ish but BSD-derived. macOS and Linux both
// expose it via libc. LOCK_EX = 2 (exclusive, blocking); LOCK_UN = 8.
extern fn flock(fd: c_int, op: c_int) c_int;
const LOCK_EX: c_int = 2;
const LOCK_UN: c_int = 8;

/// Homeostasis trigger shared by every lock-acquiring writer. Compaction used
/// to run only from the CLI tick, so FFI-only writers (runtime session
/// ledgers) grew unbounded until readAll's 16 MiB cap wedged every read verb
/// (observed 2026-07-29: a 23k-row session ledger HOLDed all consequential
/// tools). Check the size before taking the lock and compact inline past
/// COMPACT_THRESHOLD. The atomic flag makes the nested acquireExclusive
/// inside compactIfOversized skip the re-check (no recursion) and dedupes
/// concurrent triggers. Compaction failure is swallowed deliberately: the
/// next lock acquisition retries, and blocking the writer would be worse
/// than deferring the counter-breath.
var compaction_active: std.atomic.Value(bool) = std.atomic.Value(bool).init(false);
var last_compact_size: std.atomic.Value(u64) = std.atomic.Value(u64).init(0);

fn maybeCompact(allocator: std.mem.Allocator, env: std.process.Environ) void {
    const size = currentSize(allocator, env);
    if (size <= COMPACT_THRESHOLD) {
        // Store shrank (rotation, or a compaction that won) — re-arm so the
        // next crossing compacts promptly.
        last_compact_size.store(0, .release);
        return;
    }
    // Hysteresis: a keep-row-heavy store may not shrink below the threshold
    // when compacted, so without a growth floor every lock acquisition would
    // rewrite the whole store. Re-attempt at most once per MiB of growth.
    if (size -| last_compact_size.load(.acquire) < 1024 * 1024) return;
    if (compaction_active.swap(true, .acq_rel)) return;
    defer _ = compaction_active.store(false, .release);
    last_compact_size.store(size, .release);
    _ = compactIfOversized(allocator, env) catch {};
}

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
    maybeCompact(allocator, env);
    const path = try resolvePath(allocator, env);
    defer allocator.free(path);

    if (std.fs.path.dirname(path)) |parent| {
        try makePath(allocator, parent);
    }

    const lock_path = try std.fmt.allocPrint(allocator, "{s}.lock", .{path});
    defer allocator.free(lock_path);
    const lock_path_z = try allocator.dupeZ(u8, lock_path);
    defer allocator.free(lock_path_z);

    const fd: c_int = if (is_windows) blk: {
        break :blk _open(lock_path_z.ptr, O_RDWR | O_CREAT | O_BINARY, @as(c_int, 0o644));
    } else blk: {
        var flags: c.O = .{};
        flags.ACCMODE = .RDWR;
        flags.CREAT = true;
        break :blk c.open(lock_path_z.ptr, flags, @as(c_uint, 0o644));
    };
    if (fd < 0) return error.OpenFailed;
    errdefer closeFd(fd);

    // Blocking exclusive lock. Returns 0 on success; -1 on signal interrupt
    // (which we retry, since callers want serialized semantics).
    while (true) {
        const r = if (is_windows) _locking(fd, 1, 1) else flock(fd, LOCK_EX);
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
    _ = if (is_windows) _locking(fd, 0, 1) else flock(fd, LOCK_UN);
    closeFd(fd);
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

/// Look up the parent_id of the declared row for `id`. Returns an
/// owned slice on hit; null if the row is a root (parent_id absent
/// or null) OR if the row is unknown. Used by the prune authority
/// check — refuses to mark died unless the caller is the legitimate
/// parent (or self, for apoptosed cases).
pub fn findParentIdForId(
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
        // Found the row. Pull parent_id; "null" or absent → root.
        const p_marker = "\"parent_id\": \"";
        const p_marker2 = "\"parent_id\":\"";
        const p_start = blk: {
            if (std.mem.indexOf(u8, line, p_marker)) |p| break :blk p + p_marker.len;
            if (std.mem.indexOf(u8, line, p_marker2)) |p| break :blk p + p_marker2.len;
            return null; // declared row with no parent_id field → treat as root
        };
        // Value is a JSON string; walk until closing quote.
        var i: usize = p_start;
        while (i < line.len) : (i += 1) {
            if (line[i] == '\\') {
                i += 1;
                continue;
            }
            if (line[i] == '"') return try allocator.dupe(u8, line[p_start..i]);
        }
        return null;
    }
    return null;
}

/// Byte size of the resolved ledger (0 when absent). Append-only file ⇒
/// size is a sound within-process cache-invalidation key.
pub fn currentSize(allocator: std.mem.Allocator, env: std.process.Environ) u64 {
    const path = resolvePath(allocator, env) catch return 0;
    defer allocator.free(path);
    const path_z = allocator.dupeZ(u8, path) catch return 0;
    defer allocator.free(path_z);
    const fd: c_int = if (is_windows) _open(path_z.ptr, O_RDONLY | O_BINARY) else blk: {
        var flags: c.O = .{};
        flags.ACCMODE = .RDONLY;
        break :blk c.open(path_z.ptr, flags, @as(c_uint, 0));
    };
    if (fd < 0) return 0;
    defer closeFd(fd);
    const off = seekEnd(fd);
    return if (off < 0) 0 else @intCast(off);
}

// Within-process whole-ledger read cache (bench finding, docs/journal.md
// 2026-06-11): the cache layer's per-id walks re-slurped the full ledger
// once per call — at resolver scale that is hundreds of reads per
// invocation, each leaked. Size-keyed memo; old buffers leak bounded by
// APPENDS, not reads. Single-threaded CLI — plain globals are safe.
var read_cache_size: u64 = 0;
var read_cache_buf: ?[]u8 = null;

/// Memoized whole-ledger read. The returned slice is CACHE-OWNED — the
/// caller must NOT free it. Re-reads only when the file size changed.
pub fn readAllShared(allocator: std.mem.Allocator, env: std.process.Environ) ![]const u8 {
    const size = currentSize(allocator, env);
    if (read_cache_buf) |b| {
        if (size != 0 and size == read_cache_size) return b;
    }
    const buf = try readAll(allocator, env);
    read_cache_buf = buf;
    read_cache_size = size;
    return buf;
}

pub const READ_ALL_MAX_BYTES: usize = 16 * 1024 * 1024;

/// Slurp the entire resolved ledger file. Returns an owned []u8 (empty when
/// the file doesn't exist). Whole-buffer callers are bounded; replay and
/// deduplication over larger ledgers must use forEachLine instead.
pub fn readAll(allocator: std.mem.Allocator, env: std.process.Environ) ![]u8 {
    const path = try resolvePath(allocator, env);
    defer allocator.free(path);

    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);

    const fd: c_int = if (is_windows) _open(path_z.ptr, O_RDONLY | O_BINARY) else blk: {
        var flags: c.O = .{};
        flags.ACCMODE = .RDONLY;
        break :blk c.open(path_z.ptr, flags, @as(c_uint, 0));
    };
    if (fd < 0) {
        // Missing ledger is a normal bootstrap state — return empty.
        return try allocator.alloc(u8, 0);
    }
    defer closeFd(fd);

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);

    var chunk: [8192]u8 = undefined;
    while (true) {
        const n = readFd(fd, &chunk);
        if (n <= 0) break;
        try out.appendSlice(allocator, chunk[0..@intCast(n)]);
        if (out.items.len > READ_ALL_MAX_BYTES) return error.LedgerTooLarge;
    }
    return try out.toOwnedSlice(allocator);
}

/// Stream the resolved ledger line-by-line, invoking `callback` for each
/// non-empty line. Does NOT slurp the whole file, so replay works on stores
/// larger than readAll's 16 MiB cap (the cap stays as a guard for callers that
/// need the whole buffer; replay only needs one line at a time). A single line
/// larger than 4 MiB is rejected as pathologically malformed. Missing ledger
/// is a normal bootstrap state and returns silently.
pub fn forEachLine(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    ctx: *anyopaque,
    callback: *const fn (ctx: *anyopaque, line: []const u8) void,
) !void {
    const path = try resolvePath(allocator, env);
    defer allocator.free(path);
    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);

    const fd: c_int = if (is_windows) _open(path_z.ptr, O_RDONLY | O_BINARY) else blk: {
        var flags: c.O = .{};
        flags.ACCMODE = .RDONLY;
        break :blk c.open(path_z.ptr, flags, @as(c_uint, 0));
    };
    if (fd < 0) return;
    defer closeFd(fd);

    var carry: std.ArrayList(u8) = .empty;
    defer carry.deinit(allocator);
    var chunk: [16384]u8 = undefined;
    while (true) {
        const n = readFd(fd, &chunk);
        if (n <= 0) break;
        const data = chunk[0..@intCast(n)];
        var start: usize = 0;
        while (std.mem.indexOfScalarPos(u8, data, start, '\n')) |nl| {
            if (carry.items.len > 0) {
                try carry.appendSlice(allocator, data[start..nl]);
                callback(ctx, carry.items);
                carry.clearRetainingCapacity();
            } else {
                const line = data[start..nl];
                if (line.len > 0) callback(ctx, line);
            }
            start = nl + 1;
        }
        if (start < data.len) {
            try carry.appendSlice(allocator, data[start..]);
            if (carry.items.len > 4 * 1024 * 1024) return error.LineTooLong;
        }
    }
    if (carry.items.len > 0) callback(ctx, carry.items);
}

// ────────── compaction — homeostasis for the append-only store ──────────
//
// The resolver exhales exhaust rows (`iterated`, cache probes, guards) at
// a rate that eventually pushes the store past readAll's bounded whole-buffer
// cap and every read verb starts failing (observed 2026-07-18: 78k rows, 43 MB,
// 51k of them `iterated` + 19k orphaned `ebm_proto`). Compaction is the
// counter-breath: exhaust rows whose contract is already terminal — plus
// rows no code reads at all — move to `<store>.archive.jsonl` (append-only,
// nothing is destroyed), and the store keeps the truth skeleton: declared /
// terminal events / containment edges, and FULL history for still-open ids.

/// Compact before the store reaches readAll's 16 MiB hard cap so lock-time
/// housekeeping runs before whole-buffer readers can wedge.
pub const COMPACT_THRESHOLD: u64 = 12 * 1024 * 1024;

/// Uncapped slurp — compaction must be able to read a store that is
/// already too big for the capped readAll. Private on purpose.
fn readAllUncapped(allocator: std.mem.Allocator, path_z: [*:0]const u8) ![]u8 {
    const fd: c_int = if (is_windows) _open(path_z, O_RDONLY | O_BINARY) else blk: {
        var flags: c.O = .{};
        flags.ACCMODE = .RDONLY;
        break :blk c.open(path_z, flags, @as(c_uint, 0));
    };
    if (fd < 0) return try allocator.alloc(u8, 0);
    defer closeFd(fd);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    var chunk: [65536]u8 = undefined;
    while (true) {
        const n = readFd(fd, &chunk);
        if (n <= 0) break;
        try out.appendSlice(allocator, chunk[0..@intCast(n)]);
    }
    return try out.toOwnedSlice(allocator);
}

/// Minimal string-field extractor tolerant of both `"k": "v"` and `"k":"v"`.
/// Ledger `event` / `id` values never contain escapes, so no unescaping.
fn fieldString(line: []const u8, comptime key: []const u8) ?[]const u8 {
    const kq = "\"" ++ key ++ "\"";
    const at = std.mem.indexOf(u8, line, kq) orelse return null;
    var i = at + kq.len;
    while (i < line.len and (line[i] == ' ' or line[i] == '\t')) i += 1;
    if (i >= line.len or line[i] != ':') return null;
    i += 1;
    while (i < line.len and (line[i] == ' ' or line[i] == '\t')) i += 1;
    if (i >= line.len or line[i] != '"') return null;
    i += 1;
    const vstart = i;
    while (i < line.len and line[i] != '"') i += 1;
    return line[vstart..i];
}

fn isTerminalEvent(ev: []const u8) bool {
    return std.mem.eql(u8, ev, "satisfied") or
        std.mem.eql(u8, ev, "died") or
        std.mem.eql(u8, ev, "purged");
}

/// Rows nothing replays for closed contracts — resolver exhaust.
fn isExhaustEvent(ev: []const u8) bool {
    return std.mem.eql(u8, ev, "iterated") or
        std.mem.eql(u8, ev, "cache_check") or
        std.mem.eql(u8, ev, "cache_resolved") or
        std.mem.eql(u8, ev, "cache_invalidated") or
        std.mem.eql(u8, ev, "evidence") or
        std.mem.eql(u8, ev, "guard") or
        std.mem.eql(u8, ev, "triggered") or
        std.mem.eql(u8, ev, "muscle_observed") or
        std.mem.eql(u8, ev, "neuron_fired") or
        std.mem.eql(u8, ev, "neuron_effect_settled") or
        std.mem.eql(u8, ev, "neuron_skill_graph_admitted") or
        std.mem.eql(u8, ev, "pattern") or
        std.mem.eql(u8, ev, "offload_surface") or
        std.mem.eql(u8, ev, "state_surface");
}

/// Rows nothing reads at all — fossils of deleted modules (ebm_store).
fn isFossilEvent(ev: []const u8) bool {
    return std.mem.eql(u8, ev, "ebm_proto");
}

fn writeAllFd(fd: c_int, bytes: []const u8) !void {
    var off: usize = 0;
    while (off < bytes.len) {
        const n = if (is_windows)
            _write(fd, bytes.ptr + off, @intCast(@min(bytes.len - off, std.math.maxInt(c_uint))))
        else
            c.write(fd, bytes.ptr + off, bytes.len - off);
        if (n <= 0) return error.WriteFailed;
        off += @intCast(n);
    }
}

/// Compact the resolved store if it has outgrown COMPACT_THRESHOLD.
/// Returns true when a compaction ran. Safe under the sidecar lock;
/// archive is append-only so repeated compactions accumulate history.
pub fn compactIfOversized(allocator: std.mem.Allocator, env: std.process.Environ) !bool {
    if (currentSize(allocator, env) <= COMPACT_THRESHOLD) return false;

    const path = try resolvePath(allocator, env);
    defer allocator.free(path);
    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);

    const lock_fd = try acquireExclusive(allocator, env);
    defer releaseExclusive(lock_fd);

    const data = try readAllUncapped(allocator, path_z.ptr);
    defer allocator.free(data);

    // Pass 1: which contracts are terminal.
    var terminal_ids = std.StringHashMap(void).init(allocator);
    defer terminal_ids.deinit();
    var it1 = std.mem.splitScalar(u8, data, '\n');
    while (it1.next()) |line| {
        if (line.len == 0) continue;
        const ev = fieldString(line, "event") orelse continue;
        if (!isTerminalEvent(ev)) continue;
        const id = fieldString(line, "id") orelse continue;
        try terminal_ids.put(id, {});
    }

    // Pass 2: split keep / archive.
    var keep: std.ArrayList(u8) = .empty;
    defer keep.deinit(allocator);
    var arch: std.ArrayList(u8) = .empty;
    defer arch.deinit(allocator);
    var it2 = std.mem.splitScalar(u8, data, '\n');
    while (it2.next()) |line| {
        if (line.len == 0) continue;
        const ev = fieldString(line, "event") orelse "";
        // id retained for display only - GC now unconditional on exhaust, no per-id gate
        const to_archive = isFossilEvent(ev) or isExhaustEvent(ev); // unconditional: iterated/muscle/neuron/evidence are exhaust regardless of id (transient ids never become terminal)
        const dst = if (to_archive) &arch else &keep;
        try dst.appendSlice(allocator, line);
        try dst.append(allocator, '\n');
    }

    // Archive first (append-only), then atomically replace the store.
    const arch_path_z = try std.fmt.allocPrintSentinel(allocator, "{s}.archive.jsonl", .{path}, 0);
    defer allocator.free(arch_path_z);
    {
        const fd: c_int = if (is_windows) _open(arch_path_z.ptr, O_WRONLY | O_CREAT | O_APPEND | O_BINARY, @as(c_int, 0o644)) else blk: {
            var flags: c.O = .{};
            flags.ACCMODE = .WRONLY;
            flags.CREAT = true;
            flags.APPEND = true;
            break :blk c.open(arch_path_z.ptr, flags, @as(c_uint, 0o644));
        };
        if (fd < 0) return error.OpenFailed;
        defer closeFd(fd);
        try writeAllFd(fd, arch.items);
    }
    const tmp_path_z = try std.fmt.allocPrintSentinel(allocator, "{s}.compact.tmp", .{path}, 0);
    defer allocator.free(tmp_path_z);
    {
        const fd: c_int = if (is_windows) _open(tmp_path_z.ptr, O_WRONLY | O_CREAT | 0x0200 | O_BINARY, @as(c_int, 0o644)) else blk: {
            var flags: c.O = .{};
            flags.ACCMODE = .WRONLY;
            flags.CREAT = true;
            flags.TRUNC = true;
            break :blk c.open(tmp_path_z.ptr, flags, @as(c_uint, 0o644));
        };
        if (fd < 0) return error.OpenFailed;
        defer closeFd(fd);
        try writeAllFd(fd, keep.items);
    }
    if (c.rename(tmp_path_z.ptr, path_z.ptr) != 0) return error.RenameFailed;

    // Drop the size-keyed read memo — the file shrank, size-match must miss.
    read_cache_buf = null;
    read_cache_size = 0;
    return true;
}

test "fieldString tolerates both spacings and skips near-miss keys" {
    try std.testing.expectEqualStrings("iterated", fieldString("{\"event\": \"iterated\", \"id\": \"abc\"}", "event").?);
    try std.testing.expectEqualStrings("ebm_proto", fieldString("{\"event\":\"ebm_proto\",\"id\":\"x\"}", "event").?);
    try std.testing.expectEqualStrings("abc12345", fieldString("{\"parent_id\": \"zz\", \"id\": \"abc12345\"}", "id").?);
    try std.testing.expect(fieldString("{\"parent_id\": \"zz\"}", "id") == null);
}

test "compaction policy: fossils always archive, exhaust only when terminal" {
    try std.testing.expect(isFossilEvent("ebm_proto"));
    try std.testing.expect(isExhaustEvent("iterated"));
    try std.testing.expect(!isExhaustEvent("declared"));
    try std.testing.expect(!isExhaustEvent("child_added"));
    try std.testing.expect(isTerminalEvent("satisfied") and isTerminalEvent("died") and isTerminalEvent("purged"));
    try std.testing.expect(!isTerminalEvent("declared"));
}
