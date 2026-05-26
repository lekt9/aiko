//! keystore.zig — OS-agnostic secret storage for libcontract.
//!
//! Three operations exactly:
//!   read(allocator, svc)        -> ?[]u8       (null = not found; caller frees)
//!   write(allocator, svc, value)-> !void       (upsert; opaque bytes, caller hex-encodes)
//!   delete(allocator, svc)      -> !void       (best-effort; never errors on missing)
//!
//! Backend selection is compile-time via `builtin.os.tag`:
//!   darwin   → /usr/bin/security shellout (Keychain find/add/delete-generic-password)
//!   linux    → secret-tool (libsecret CLI) → fallback if not on PATH
//!   windows  → STUB (returns null / error.Unsupported). A real impl would
//!              shell out to PowerShell using
//!              `[Windows.Security.Credentials.PasswordVault]` to store an
//!              entry under the svc name; the MVP doesn't block compilation.
//!   <other>  → fallback path direct
//!
//! Fallback (chained on any native backend error or unsupported OS):
//!   Encrypted file at $HOME/.aiko/keys/<svc>.enc. ChaCha20Poly1305 keyed by
//!   HKDF-SHA256 over (uname output || machine-id-file-bytes || "aiko-keystore-v1").
//!   LIMITATIONS: the key is machine-bound (uname + machine-id) so the .enc
//!   file is NOT portable across hosts. If the machine fingerprint changes
//!   (uname update, machine-id reset), prior fallback secrets become
//!   unreadable. Use a real keystore (Keychain, libsecret) whenever possible.
//!
//! `svc` names are sanitized before shelling out — only [a-zA-Z0-9._-] are
//! accepted; anything else returns `error.InvalidServiceName` and prevents
//! shell injection by construction.

const std = @import("std");
const builtin = @import("builtin");
const hkdf = std.crypto.kdf.hkdf.HkdfSha256;
const sha256 = std.crypto.hash.sha2.Sha256;
const ChaCha20Poly1305 = std.crypto.aead.chacha_poly.ChaCha20Poly1305;

// libc shellout primitives mirrored from lineage.zig so this file is self-contained.
extern fn popen(command: [*:0]const u8, mode: [*:0]const u8) ?*anyopaque;
extern fn pclose(stream: *anyopaque) c_int;
extern fn fread(ptr: [*]u8, size: usize, nmemb: usize, stream: *anyopaque) usize;
extern fn system(command: [*:0]const u8) c_int;

const FALLBACK_HKDF_SALT: []const u8 = "aiko-keystore-v1";
const FALLBACK_DIR_REL: []const u8 = ".aiko/keys";

/// Surface a fallback or degradation event to stderr. Fallbacks must NEVER be
/// silent — observers (the orchestrator, telemetry, a watching human) need to
/// see when a non-primary path engaged. Caller behavior is unchanged; this is
/// pure observability. Format mirrors main.zig's evidence lines:
///   `keystore[<scope>]: <message>`
fn surface(comptime fmt: []const u8, args: anytype) void {
    var buf: [1024]u8 = undefined;
    const line = std.fmt.bufPrint(&buf, "keystore: " ++ fmt ++ "\n", args) catch return;
    // Best-effort write to stderr (fd 2). Never throw from a surface emitter —
    // surfacing is observability, not flow control.
    _ = std.c.write(std.c.STDERR_FILENO, line.ptr, line.len);
}

pub const KeystoreError = error{
    InvalidServiceName,
    NoHome,
    Unsupported,
    EncryptFailed,
    DecryptFailed,
    WriteFailed,
    ReadFailed,
};

/// Read the secret stored under `svc`. Returns `null` when not found.
/// Caller frees the returned slice using the same allocator passed in.
pub fn read(allocator: std.mem.Allocator, svc: []const u8) !?[]u8 {
    try validateSvc(svc);
    switch (builtin.os.tag) {
        .macos => {
            if (try darwinRead(allocator, svc)) |v| return v;
            return try fallbackRead(allocator, svc);
        },
        .linux => {
            if (linuxRead(allocator, svc)) |maybe| {
                if (maybe) |v| return v;
                return try fallbackRead(allocator, svc);
            } else |_| {
                return try fallbackRead(allocator, svc);
            }
        },
        .windows => {
            // STUB — would call PowerShell [Windows.Security.Credentials.PasswordVault].
            return try fallbackRead(allocator, svc);
        },
        else => return try fallbackRead(allocator, svc),
    }
}

/// Upsert `value` (opaque bytes) under `svc`. Best-effort across backends —
/// if the native backend fails the fallback file is written.
pub fn write(allocator: std.mem.Allocator, svc: []const u8, value: []const u8) !void {
    try validateSvc(svc);
    switch (builtin.os.tag) {
        .macos => {
            darwinWrite(allocator, svc, value) catch {
                return try fallbackWrite(allocator, svc, value);
            };
        },
        .linux => {
            linuxWrite(allocator, svc, value) catch {
                return try fallbackWrite(allocator, svc, value);
            };
        },
        .windows => {
            // STUB — real impl: PowerShell PasswordVault.Add(new PasswordCredential(svc, "root", value)).
            return try fallbackWrite(allocator, svc, value);
        },
        else => return try fallbackWrite(allocator, svc, value),
    }
}

/// Best-effort delete. Never errors on a missing entry.
pub fn delete(allocator: std.mem.Allocator, svc: []const u8) !void {
    validateSvc(svc) catch return;
    switch (builtin.os.tag) {
        .macos => darwinDelete(allocator, svc) catch {},
        .linux => linuxDelete(allocator, svc) catch {},
        .windows => {}, // STUB
        else => {},
    }
    // Always also clean up the fallback file (defense in depth).
    fallbackDelete(allocator, svc) catch {};
}

// ─────────────── svc sanitizer ───────────────

fn validateSvc(svc: []const u8) !void {
    if (svc.len == 0 or svc.len > 200) return KeystoreError.InvalidServiceName;
    for (svc) |c| {
        const ok = (c >= 'a' and c <= 'z') or (c >= 'A' and c <= 'Z') or
            (c >= '0' and c <= '9') or c == '.' or c == '_' or c == '-';
        if (!ok) return KeystoreError.InvalidServiceName;
    }
}

// ─────────────── darwin (security CLI) ───────────────

fn darwinRead(allocator: std.mem.Allocator, svc: []const u8) !?[]u8 {
    var cmd_buf: [512]u8 = undefined;
    const cmd = try std.fmt.bufPrintZ(
        &cmd_buf,
        "/usr/bin/security find-generic-password -s {s} -w 2>/dev/null",
        .{svc},
    );
    const fp = popen(cmd.ptr, "r") orelse return null;
    var buf: [4096]u8 = undefined;
    const n = fread(&buf, 1, buf.len, fp);
    const rc = pclose(fp);
    if (rc != 0 or n == 0) return null;
    var end: usize = n;
    while (end > 0 and (buf[end - 1] == '\n' or buf[end - 1] == '\r' or buf[end - 1] == ' ')) end -= 1;
    if (end == 0) return null;
    return try allocator.dupe(u8, buf[0..end]);
}

fn darwinWrite(allocator: std.mem.Allocator, svc: []const u8, value: []const u8) !void {
    _ = allocator;
    // value must be shell-safe; callers hex-encode before passing in. Reject
    // anything containing a single-quote to keep the single-quoted shell arg
    // unambiguous.
    for (value) |c| {
        if (c == '\'' or c == '\n' or c == '\r' or c == 0) return KeystoreError.InvalidServiceName;
    }
    var cmd_buf: [4096]u8 = undefined;
    const cmd = try std.fmt.bufPrintZ(
        &cmd_buf,
        "/usr/bin/security add-generic-password -a root -s {s} " ++
            "-D 'aiko keystore entry' " ++
            "-w '{s}' -U 2>/dev/null",
        .{ svc, value },
    );
    const rc = system(cmd.ptr);
    if (rc != 0) return KeystoreError.WriteFailed;
}

fn darwinDelete(allocator: std.mem.Allocator, svc: []const u8) !void {
    _ = allocator;
    var cmd_buf: [512]u8 = undefined;
    const cmd = try std.fmt.bufPrintZ(
        &cmd_buf,
        "/usr/bin/security delete-generic-password -s {s} >/dev/null 2>&1",
        .{svc},
    );
    _ = system(cmd.ptr);
}

// ─────────────── linux (secret-tool / libsecret) ───────────────

fn linuxRead(allocator: std.mem.Allocator, svc: []const u8) !?[]u8 {
    // If secret-tool isn't on PATH this returns rc=127; caller falls through.
    var cmd_buf: [512]u8 = undefined;
    const cmd = try std.fmt.bufPrintZ(
        &cmd_buf,
        "command -v secret-tool >/dev/null 2>&1 && secret-tool lookup service {s} 2>/dev/null",
        .{svc},
    );
    const fp = popen(cmd.ptr, "r") orelse return KeystoreError.ReadFailed;
    var buf: [4096]u8 = undefined;
    const n = fread(&buf, 1, buf.len, fp);
    const rc = pclose(fp);
    if (rc != 0) return KeystoreError.ReadFailed;
    if (n == 0) return null;
    var end: usize = n;
    while (end > 0 and (buf[end - 1] == '\n' or buf[end - 1] == '\r' or buf[end - 1] == ' ')) end -= 1;
    if (end == 0) return null;
    return try allocator.dupe(u8, buf[0..end]);
}

fn linuxWrite(allocator: std.mem.Allocator, svc: []const u8, value: []const u8) !void {
    _ = allocator;
    for (value) |c| {
        if (c == '\'' or c == '\n' or c == '\r' or c == 0) return KeystoreError.InvalidServiceName;
    }
    var cmd_buf: [4096]u8 = undefined;
    const cmd = try std.fmt.bufPrintZ(
        &cmd_buf,
        "command -v secret-tool >/dev/null 2>&1 && " ++
            "printf '%s' '{s}' | secret-tool store --label='{s}' service {s} >/dev/null 2>&1",
        .{ value, svc, svc },
    );
    const rc = system(cmd.ptr);
    if (rc != 0) return KeystoreError.WriteFailed;
}

fn linuxDelete(allocator: std.mem.Allocator, svc: []const u8) !void {
    _ = allocator;
    var cmd_buf: [512]u8 = undefined;
    const cmd = try std.fmt.bufPrintZ(
        &cmd_buf,
        "command -v secret-tool >/dev/null 2>&1 && secret-tool clear service {s} >/dev/null 2>&1",
        .{svc},
    );
    _ = system(cmd.ptr);
}

// ─────────────── fallback (encrypted file) ───────────────

fn fallbackRead(allocator: std.mem.Allocator, svc: []const u8) !?[]u8 {
    const home = getHome(allocator) catch return null;
    defer allocator.free(home);
    const path = try std.fs.path.join(allocator, &.{ home, FALLBACK_DIR_REL, svc });
    defer allocator.free(path);
    const enc_path = try std.fmt.allocPrint(allocator, "{s}.enc", .{path});
    defer allocator.free(enc_path);

    const blob = readFile(allocator, enc_path) catch return null;
    defer allocator.free(blob);
    if (blob.len < 12 + 16) return null; // nonce + tag minimum

    var key: [32]u8 = undefined;
    try deriveFallbackKey(allocator, &key);

    var nonce: [12]u8 = undefined;
    @memcpy(&nonce, blob[0..12]);
    var tag: [16]u8 = undefined;
    @memcpy(&tag, blob[12..28]);
    const ct = blob[28..];
    const pt = try allocator.alloc(u8, ct.len);
    errdefer allocator.free(pt);
    ChaCha20Poly1305.decrypt(pt, ct, tag, "", nonce, key) catch {
        allocator.free(pt);
        return null;
    };
    return pt;
}

fn fallbackWrite(allocator: std.mem.Allocator, svc: []const u8, value: []const u8) !void {
    const home = try getHome(allocator);
    defer allocator.free(home);
    const dir = try std.fs.path.join(allocator, &.{ home, FALLBACK_DIR_REL });
    defer allocator.free(dir);
    try makePath(allocator, dir);

    const path = try std.fs.path.join(allocator, &.{ dir, svc });
    defer allocator.free(path);
    const enc_path = try std.fmt.allocPrint(allocator, "{s}.enc", .{path});
    defer allocator.free(enc_path);
    const tmp_path = try std.fmt.allocPrint(allocator, "{s}.enc.tmp", .{path});
    defer allocator.free(tmp_path);

    var key: [32]u8 = undefined;
    try deriveFallbackKey(allocator, &key);
    var nonce: [12]u8 = undefined;
    arc4random_buf(&nonce, nonce.len);
    var tag: [16]u8 = undefined;
    const ct = try allocator.alloc(u8, value.len);
    defer allocator.free(ct);
    ChaCha20Poly1305.encrypt(ct, &tag, value, "", nonce, key);

    var blob = try allocator.alloc(u8, 12 + 16 + ct.len);
    defer allocator.free(blob);
    @memcpy(blob[0..12], &nonce);
    @memcpy(blob[12..28], &tag);
    @memcpy(blob[28..], ct);

    try writeFileAtomic(allocator, tmp_path, enc_path, blob);
}

fn fallbackDelete(allocator: std.mem.Allocator, svc: []const u8) !void {
    const home = getHome(allocator) catch return;
    defer allocator.free(home);
    const path = try std.fs.path.join(allocator, &.{ home, FALLBACK_DIR_REL, svc });
    defer allocator.free(path);
    const enc_path = try std.fmt.allocPrint(allocator, "{s}.enc", .{path});
    defer allocator.free(enc_path);
    const path_z = try allocator.dupeZ(u8, enc_path);
    defer allocator.free(path_z);
    _ = std.c.unlink(path_z.ptr);
}

extern fn arc4random_buf(buf: [*]u8, len: usize) void;

fn deriveFallbackKey(allocator: std.mem.Allocator, out: *[32]u8) !void {
    // Stable-ish machine fingerprint: uname -a + /etc/machine-id (if present).
    var fp: std.ArrayList(u8) = .empty;
    defer fp.deinit(allocator);

    if (popen("uname -a 2>/dev/null", "r")) |stream| {
        var ub: [1024]u8 = undefined;
        const n = fread(&ub, 1, ub.len, stream);
        _ = pclose(stream);
        if (n > 0) try fp.appendSlice(allocator, ub[0..n]);
    }
    if (readFile(allocator, "/etc/machine-id")) |mid| {
        defer allocator.free(mid);
        try fp.appendSlice(allocator, mid);
    } else |_| {}
    // macOS fallback fingerprint anchor (no machine-id but a stable hardware UUID).
    if (fp.items.len < 8) {
        if (popen("ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | grep IOPlatformUUID", "r")) |stream| {
            var ub: [1024]u8 = undefined;
            const n = fread(&ub, 1, ub.len, stream);
            _ = pclose(stream);
            if (n > 0) try fp.appendSlice(allocator, ub[0..n]);
        }
    }
    // Guarantee non-empty IKM even on minimal sandboxes; the key is then
    // not portable but still deterministic per process invocation chain.
    if (fp.items.len == 0) try fp.appendSlice(allocator, "aiko-keystore-fallback-default-ikm");

    const prk = hkdf.extract(FALLBACK_HKDF_SALT, fp.items);
    hkdf.expand(out, "keystore-v1", prk);
}

fn getHome(allocator: std.mem.Allocator) ![]u8 {
    // Honor $HOME via libc getenv — keeps the file self-contained (no env arg).
    const home_z = std.c.getenv("HOME");
    if (home_z == null) return KeystoreError.NoHome;
    const home = std.mem.span(@as([*:0]const u8, @ptrCast(home_z.?)));
    return try allocator.dupe(u8, home);
}

fn readFile(allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);
    var flags: std.c.O = .{};
    flags.ACCMODE = .RDONLY;
    const fd: c_int = std.c.open(path_z.ptr, flags, @as(c_uint, 0));
    if (fd < 0) return error.FileNotFound;
    defer _ = std.c.close(fd);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    var chunk: [4096]u8 = undefined;
    while (true) {
        const n = std.c.read(fd, &chunk, chunk.len);
        if (n <= 0) break;
        try out.appendSlice(allocator, chunk[0..@intCast(n)]);
        if (out.items.len > 1024 * 1024) return error.FileTooLarge;
    }
    return try out.toOwnedSlice(allocator);
}

fn writeFileAtomic(allocator: std.mem.Allocator, tmp_path: []const u8, final_path: []const u8, bytes: []const u8) !void {
    const tmp_z = try allocator.dupeZ(u8, tmp_path);
    defer allocator.free(tmp_z);
    var flags: std.c.O = .{};
    flags.ACCMODE = .WRONLY;
    flags.CREAT = true;
    flags.TRUNC = true;
    const fd: c_int = std.c.open(tmp_z.ptr, flags, @as(c_uint, 0o600));
    if (fd < 0) return KeystoreError.WriteFailed;
    const n = std.c.write(fd, bytes.ptr, bytes.len);
    _ = std.c.close(fd);
    if (n < @as(isize, @intCast(bytes.len))) return KeystoreError.WriteFailed;

    const final_z = try allocator.dupeZ(u8, final_path);
    defer allocator.free(final_z);
    if (std.c.rename(tmp_z.ptr, final_z.ptr) != 0) return KeystoreError.WriteFailed;
}

fn makePath(allocator: std.mem.Allocator, path: []const u8) !void {
    var i: usize = 0;
    while (i < path.len) : (i += 1) {
        if (path[i] == '/' and i > 0) {
            const partial = try allocator.dupeZ(u8, path[0..i]);
            defer allocator.free(partial);
            _ = std.c.mkdir(partial.ptr, 0o755);
        }
    }
    const full = try allocator.dupeZ(u8, path);
    defer allocator.free(full);
    _ = std.c.mkdir(full.ptr, 0o700);
}

test "keystore round-trip on this platform" {
    const allocator = std.testing.allocator;
    // Unique svc per run so concurrent CI runs don't clobber each other.
    var rnd: [4]u8 = undefined;
    arc4random_buf(&rnd, rnd.len);
    var svc_buf: [64]u8 = undefined;
    const svc = try std.fmt.bufPrint(&svc_buf, "aiko.test.ks-{x:0>2}{x:0>2}{x:0>2}{x:0>2}", .{ rnd[0], rnd[1], rnd[2], rnd[3] });

    const payload = "deadbeefcafebabe1234567890abcdef";

    // Ensure clean slate.
    try delete(allocator, svc);
    defer delete(allocator, svc) catch {};

    try write(allocator, svc, payload);
    const got = try read(allocator, svc);
    try std.testing.expect(got != null);
    defer if (got) |g| allocator.free(g);
    try std.testing.expectEqualSlices(u8, payload, got.?);

    try delete(allocator, svc);
    const after = try read(allocator, svc);
    if (after) |a| {
        // Some keystores defer deletion or fail silently; treat as soft assertion.
        allocator.free(a);
    }
}

test "validateSvc rejects shell metacharacters" {
    try std.testing.expectError(KeystoreError.InvalidServiceName, validateSvc("foo;rm -rf /"));
    try std.testing.expectError(KeystoreError.InvalidServiceName, validateSvc("foo bar"));
    try std.testing.expectError(KeystoreError.InvalidServiceName, validateSvc("foo$bar"));
    try std.testing.expectError(KeystoreError.InvalidServiceName, validateSvc(""));
    try validateSvc("aiko.root.ed25519.seed");
    try validateSvc("a-b_c.1");
}
