//! cfile.zig — portable file-descriptor I/O shim.
//!
//! Zig 0.16's `std.c` exposes the POSIX fd model (`open`/`read`/`write`/
//! `writev`/`close`/`lseek` over an integer `fd_t`, with the `O` open-flag
//! struct) only on POSIX targets. On Windows `std.c.O` is `void` and
//! `std.c.fd_t` is a `HANDLE`, so the project's libc file calls do not
//! compile for `*-windows`.
//!
//! This module gives every other source file ONE portable surface for that
//! handful of primitives:
//!   • POSIX  → forwards straight to `std.c` (zero behaviour change).
//!   • Windows → forwards to the UCRT low-level I/O (`_open`/`_read`/
//!     `_write`/`_close`/`_lseek`) which is REAL integer-fd file I/O, with
//!     the `_O_*` flag constants. `_O_BINARY` is forced so writes are byte-
//!     exact (no CRLF translation) — the ledger/keystore/sig files are
//!     binary-faithful on every platform.
//!
//! Only the fd-model calls live here. `mkdir`/`stat`/`rename`/`unlink`/
//! `getcwd`/`getpid`/`getenv`/`gettimeofday` already resolve on Windows via
//! `std.c`, so those stay on `std.c` at their call sites.

const std = @import("std");
const builtin = @import("builtin");

const is_windows = builtin.os.tag == .windows;

/// Portable open-flags. Field names mirror the subset of `std.c.O` the
/// project uses (ACCMODE/CREAT/TRUNC/APPEND), so call sites are unchanged.
pub const ACCMODE = enum { RDONLY, WRONLY, RDWR };

pub const O = struct {
    ACCMODE: ACCMODE = .RDONLY,
    CREAT: bool = false,
    TRUNC: bool = false,
    APPEND: bool = false,
};

pub const STDOUT_FILENO: c_int = 1;
pub const STDERR_FILENO: c_int = 2;

pub const SEEK = struct {
    pub const SET: c_int = 0;
    pub const CUR: c_int = 1;
    pub const END: c_int = 2;
};

/// iovec for the single-syscall row append (ledger.zig). On Windows there is
/// no `writev`; `writeAll`'s caller loops the segments instead.
pub const iovec_const = extern struct {
    base: [*]const u8,
    len: usize,
};

// ── Windows UCRT low-level I/O ───────────────────────────────────────────
// These are the real CRT entry points (underscore-prefixed). `link_libc`
// pulls in UCRT, which exports them.
const win = if (is_windows) struct {
    // _O_* bit values are stable in the UCRT headers.
    const _O_RDONLY: c_int = 0x0000;
    const _O_WRONLY: c_int = 0x0001;
    const _O_RDWR: c_int = 0x0002;
    const _O_APPEND: c_int = 0x0008;
    const _O_CREAT: c_int = 0x0100;
    const _O_TRUNC: c_int = 0x0200;
    const _O_BINARY: c_int = 0x8000;
    // _S_IREAD | _S_IWRITE permission bits for _open's pmode.
    const _S_IWRITE: c_int = 0x0080;
    const _S_IREAD: c_int = 0x0100;

    extern "c" fn _open(filename: [*:0]const u8, oflag: c_int, ...) c_int;
    extern "c" fn _read(fd: c_int, buf: [*]u8, count: c_uint) c_int;
    extern "c" fn _write(fd: c_int, buf: [*]const u8, count: c_uint) c_int;
    extern "c" fn _close(fd: c_int) c_int;
    extern "c" fn _lseek(fd: c_int, offset: c_long, origin: c_int) c_long;
    // CRT fd → Win32 HANDLE, so we can take a real range lock on the file.
    const w = std.os.windows;
    const OVERLAPPED = extern struct {
        Internal: usize = 0,
        InternalHigh: usize = 0,
        DUMMYUNIONNAME: extern union {
            DUMMYSTRUCTNAME: extern struct { Offset: w.DWORD, OffsetHigh: w.DWORD },
            Pointer: ?*anyopaque,
        } = .{ .Pointer = null },
        hEvent: ?w.HANDLE = null,
    };
    const LOCKFILE_EXCLUSIVE_LOCK: w.DWORD = 0x2;
    extern "c" fn _get_osfhandle(fd: c_int) w.HANDLE;
    extern "kernel32" fn LockFileEx(
        hFile: w.HANDLE,
        dwFlags: w.DWORD,
        dwReserved: w.DWORD,
        nNumberOfBytesToLockLow: w.DWORD,
        nNumberOfBytesToLockHigh: w.DWORD,
        lpOverlapped: *OVERLAPPED,
    ) callconv(.winapi) w.BOOL;
    extern "kernel32" fn UnlockFileEx(
        hFile: w.HANDLE,
        dwReserved: w.DWORD,
        nNumberOfBytesToUnlockLow: w.DWORD,
        nNumberOfBytesToUnlockHigh: w.DWORD,
        lpOverlapped: *OVERLAPPED,
    ) callconv(.winapi) w.BOOL;
} else struct {};

// POSIX advisory lock (BSD flock). macOS + Linux both expose it via libc.
const LOCK_EX: c_int = 2;
const LOCK_UN: c_int = 8;
extern fn flock(fd: c_int, op: c_int) c_int;

fn winFlags(flags: O) c_int {
    var f: c_int = switch (flags.ACCMODE) {
        .RDONLY => win._O_RDONLY,
        .WRONLY => win._O_WRONLY,
        .RDWR => win._O_RDWR,
    };
    if (flags.CREAT) f |= win._O_CREAT;
    if (flags.TRUNC) f |= win._O_TRUNC;
    if (flags.APPEND) f |= win._O_APPEND;
    f |= win._O_BINARY;
    return f;
}

/// Open `path` with `flags`; `mode` is the create permission (ignored on
/// Windows beyond read/write). Returns an integer fd, or < 0 on failure.
pub fn open(path: [*:0]const u8, flags: O, mode: c_uint) c_int {
    if (is_windows) {
        const pmode: c_int = win._S_IREAD | win._S_IWRITE;
        return win._open(path, winFlags(flags), pmode);
    }
    var posix_flags: std.c.O = .{};
    posix_flags.ACCMODE = switch (flags.ACCMODE) {
        .RDONLY => .RDONLY,
        .WRONLY => .WRONLY,
        .RDWR => .RDWR,
    };
    posix_flags.CREAT = flags.CREAT;
    posix_flags.TRUNC = flags.TRUNC;
    posix_flags.APPEND = flags.APPEND;
    return std.c.open(path, posix_flags, mode);
}

/// Read up to `buf.len` bytes. Returns count read, 0 at EOF, < 0 on error.
pub fn read(fd: c_int, buf: [*]u8, count: usize) isize {
    if (is_windows) return @intCast(win._read(fd, buf, @intCast(count)));
    return std.c.read(fd, buf, count);
}

/// Write `count` bytes. Returns count written, < 0 on error.
pub fn write(fd: c_int, buf: [*]const u8, count: usize) isize {
    if (is_windows) return @intCast(win._write(fd, buf, @intCast(count)));
    return std.c.write(fd, buf, count);
}

/// Gathered write of `iovecs`. On POSIX this is one `writev` syscall; on
/// Windows it loops `_write` over each segment (no `writev` in the CRT).
/// Returns total bytes written, or < 0 if any segment errors.
pub fn writev(fd: c_int, iovecs: []const iovec_const) isize {
    if (is_windows) {
        var total: isize = 0;
        for (iovecs) |iov| {
            var off: usize = 0;
            while (off < iov.len) {
                const n = write(fd, iov.base + off, iov.len - off);
                if (n <= 0) return if (total > 0) total else n;
                off += @intCast(n);
                total += n;
            }
        }
        return total;
    }
    const posix_iovs: [*]const std.c.iovec_const = @ptrCast(iovecs.ptr);
    return std.c.writev(fd, posix_iovs, @intCast(iovecs.len));
}

pub fn close(fd: c_int) c_int {
    if (is_windows) return win._close(fd);
    return std.c.close(fd);
}

/// Current process id, as a plain integer on every platform. On Windows
/// `std.c.getpid` is typed as `HANDLE`, so callers that format it with `{d}`
/// (temp-file names) need this instead.
pub fn getpid() u32 {
    if (is_windows) return std.os.windows.GetCurrentProcessId();
    return @intCast(std.c.getpid());
}

pub fn lseek(fd: c_int, offset: i64, whence: c_int) i64 {
    if (is_windows) return win._lseek(fd, @intCast(offset), whence);
    return std.c.lseek(fd, @intCast(offset), whence);
}

pub const LockError = error{LockFailed};

/// Acquire a blocking exclusive lock on the open fd. POSIX → `flock(LOCK_EX)`
/// (EINTR-retried); Windows → `LockFileEx` over the whole file via the fd's
/// underlying HANDLE. Real mutual exclusion on both, not a no-op.
pub fn lockExclusive(fd: c_int) LockError!void {
    if (is_windows) {
        const handle = win._get_osfhandle(fd);
        var overlapped: win.OVERLAPPED = .{};
        if (!win.LockFileEx(
            handle,
            win.LOCKFILE_EXCLUSIVE_LOCK,
            0,
            0xffff_ffff,
            0xffff_ffff,
            &overlapped,
        ).toBool()) return error.LockFailed;
        return;
    }
    while (true) {
        if (flock(fd, LOCK_EX) == 0) return;
        const errno = std.c._errno().*;
        if (errno == 4) continue; // EINTR — retry
        return error.LockFailed;
    }
}

/// Release a lock taken with `lockExclusive`. Closing the fd also releases it;
/// this makes the unlock explicit/visible first.
pub fn unlock(fd: c_int) void {
    if (is_windows) {
        const handle = win._get_osfhandle(fd);
        var overlapped: win.OVERLAPPED = .{};
        _ = win.UnlockFileEx(handle, 0, 0xffff_ffff, 0xffff_ffff, &overlapped);
        return;
    }
    _ = flock(fd, LOCK_UN);
}
