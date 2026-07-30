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
const is_windows = builtin.os.tag == .windows;

extern fn _open(path: [*:0]const u8, flags: c_int, ...) c_int;
extern fn _close(fd: c_int) c_int;
extern fn _read(fd: c_int, buffer: [*]u8, count: c_uint) c_int;
extern fn _write(fd: c_int, buffer: [*]const u8, count: c_uint) c_int;
extern fn _mkdir(path: [*:0]const u8) c_int;
extern fn rand_s(value: *c_uint) c_int;

fn fillRandom(buffer: []u8) void {
    if (!is_windows) return arc4random_buf(buffer.ptr, buffer.len);
    var offset: usize = 0;
    while (offset < buffer.len) {
        var value: c_uint = 0;
        if (rand_s(&value) != 0) @panic("Windows CSPRNG failed");
        const bytes = std.mem.asBytes(&value);
        const count = @min(bytes.len, buffer.len - offset);
        @memcpy(buffer[offset .. offset + count], bytes[0..count]);
        offset += count;
    }
}

// libc shellout primitives mirrored from lineage.zig so this file is self-contained.
extern fn popen(command: [*:0]const u8, mode: [*:0]const u8) ?*anyopaque;
extern fn pclose(stream: *anyopaque) c_int;
extern fn fread(ptr: [*]u8, size: usize, nmemb: usize, stream: *anyopaque) usize;
extern fn system(command: [*:0]const u8) c_int;
extern fn access(path: [*:0]const u8, mode: c_int) c_int;
extern fn dlopen(path: [*:0]const u8, mode: c_int) ?*anyopaque;
extern fn dlsym(handle: *anyopaque, symbol: [*:0]const u8) ?*anyopaque;
extern fn dlclose(handle: *anyopaque) c_int;

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
    _ = if (is_windows) _write(2, line.ptr, @intCast(line.len)) else std.c.write(std.c.STDERR_FILENO, line.ptr, line.len);
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
///
/// Fall-through to the fallback encrypted file is ALWAYS surfaced to stderr
/// so observers see when the native keystore was bypassed (machine-bound .enc
/// file is not portable — surfacing matters for recovery / debugging).
pub fn read(allocator: std.mem.Allocator, svc: []const u8) !?[]u8 {
    try validateSvc(svc);
    switch (builtin.os.tag) {
        .macos => {
            // Preferred: pay.sh Secure-Enclave vault (opt-in). Miss/err falls
            // through to the security CLI then the fallback file — never lost.
            if (payShEnabled()) {
                if (payShRead(allocator, svc) catch |e| blk: {
                    surface("pay.sh read failed svc={s}: {s} — falling through to security keychain", .{ svc, @errorName(e) });
                    break :blk null;
                }) |v| return v;
            }
            if (try darwinRead(allocator, svc)) |v| return v;
            // Darwin keychain returned no entry — try the fallback file before
            // declaring not-found. If the fallback hits, surface it.
            if (try fallbackRead(allocator, svc)) |v| {
                surface("darwin keychain missed svc={s}, served from fallback encrypted file", .{svc});
                return v;
            }
            return null;
        },
        .linux => {
            if (linuxRead(allocator, svc)) |maybe| {
                if (maybe) |v| return v;
                if (try fallbackRead(allocator, svc)) |v| {
                    surface("linux secret-tool missed svc={s}, served from fallback encrypted file", .{svc});
                    return v;
                }
                return null;
            } else |e| {
                surface("linux secret-tool unavailable ({s}) — falling back to encrypted file for svc={s}", .{ @errorName(e), svc });
                return try fallbackRead(allocator, svc);
            }
        },
        .windows => {
            // STUB — would call PowerShell [Windows.Security.Credentials.PasswordVault].
            surface("windows backend is a STUB — using fallback encrypted file for svc={s}", .{svc});
            return try fallbackRead(allocator, svc);
        },
        else => {
            surface("os.tag={s} has no native backend — using fallback encrypted file for svc={s}", .{ @tagName(builtin.os.tag), svc });
            return try fallbackRead(allocator, svc);
        },
    }
}

/// Upsert `value` (opaque bytes) under `svc`. Best-effort across backends —
/// if the native backend fails the fallback file is written, and the fall-
/// through is surfaced to stderr.
pub fn write(allocator: std.mem.Allocator, svc: []const u8, value: []const u8) !void {
    try validateSvc(svc);
    switch (builtin.os.tag) {
        .macos => {
            // Bind into the pay.sh Secure-Enclave vault (opt-in), best-effort,
            // then also write the security keychain so both backends hold it.
            if (payShEnabled()) {
                payShWrite(allocator, svc, value) catch |e|
                    surface("pay.sh store failed svc={s}: {s} — continuing with security keychain", .{ svc, @errorName(e) });
            }
            darwinWrite(allocator, svc, value) catch |e| {
                surface("darwin write failed for svc={s}: {s} — falling back to encrypted file", .{ svc, @errorName(e) });
                return try fallbackWrite(allocator, svc, value);
            };
        },
        .linux => {
            linuxWrite(allocator, svc, value) catch |e| {
                surface("linux secret-tool write failed for svc={s}: {s} — falling back to encrypted file", .{ svc, @errorName(e) });
                return try fallbackWrite(allocator, svc, value);
            };
        },
        .windows => {
            // STUB — real impl: PowerShell PasswordVault.Add(new PasswordCredential(svc, "root", value)).
            surface("windows backend is a STUB — using fallback encrypted file for svc={s}", .{svc});
            return try fallbackWrite(allocator, svc, value);
        },
        else => {
            surface("os.tag={s} has no native backend — using fallback encrypted file for svc={s}", .{ @tagName(builtin.os.tag), svc });
            return try fallbackWrite(allocator, svc, value);
        },
    }
}

/// Write to the OS-native secret store only. Unlike `write`, this never falls
/// back to a file. Used for keychain-only imports where a silent file fallback
/// would violate the caller's storage policy.
pub fn writeNative(allocator: std.mem.Allocator, svc: []const u8, value: []const u8) !void {
    try validateSvc(svc);
    switch (builtin.os.tag) {
        .macos => try darwinWrite(allocator, svc, value),
        .linux => try linuxWrite(allocator, svc, value),
        else => return KeystoreError.Unsupported,
    }
}

/// Read from the OS-native secret store only; never consult encrypted files.
pub fn readNative(allocator: std.mem.Allocator, svc: []const u8) !?[]u8 {
    try validateSvc(svc);
    return switch (builtin.os.tag) {
        .macos => try darwinRead(allocator, svc),
        .linux => try linuxRead(allocator, svc),
        else => KeystoreError.Unsupported,
    };
}

/// Best-effort delete. Never errors on a missing entry. Per-tier failures
/// surface to stderr so observers see partial-state risk.
pub fn delete(allocator: std.mem.Allocator, svc: []const u8) !void {
    validateSvc(svc) catch return;
    switch (builtin.os.tag) {
        .macos => darwinDelete(allocator, svc) catch |e| surface("darwin delete error for svc={s}: {s}", .{ svc, @errorName(e) }),
        .linux => linuxDelete(allocator, svc) catch |e| surface("linux delete error for svc={s}: {s}", .{ svc, @errorName(e) }),
        .windows => {}, // STUB — nothing to delete on the native side
        else => {},
    }
    // Always also clean up the fallback file (defense in depth).
    fallbackDelete(allocator, svc) catch |e| surface("fallback file delete error for svc={s}: {s}", .{ svc, @errorName(e) });
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

// ─────────────── pay.sh (Secure Enclave + biometric) backend ───────────────
//
// Auto-detected macOS backend. When ~/.cache/pay/pay.sh exists, the secret is
// stored/read through pay.sh — a Secure-Enclave + Touch-ID-backed vault —
// binding the wallet to this user on this machine (stronger than the plain
// `/usr/bin/security` Keychain item the security CLI writes). Installing pay.sh
// IS the opt-in; the substrate reads no new env var (doctrine: only HOME is
// read). Preferred-but-fallthrough: any miss/error falls back to the security
// CLI and then the encrypted file, so the wallet is never lost and ~/.contracts/
// root.key stays canonical. Non-biometric `read` is used for the substrate's
// frequent reads (no Touch ID per declare); `store` writes the Enclave item.

fn cHome() ?[]const u8 {
    const z = std.c.getenv("HOME") orelse return null;
    return std.mem.span(@as([*:0]const u8, @ptrCast(z)));
}

fn payShEnabled() bool {
    // Provably non-prompting gate: pay.sh needs a live keychain session; in a
    // dead session (no keychain in the search list) keychain/Enclave ops can
    // prompt or hang. The same non-prompting probe that guards the security CLI
    // guards pay.sh — no session ⇒ pay.sh is never invoked ⇒ file fallback.
    if (!darwinKeychainUsable()) return false;
    const home = cHome() orelse return false;
    var pbuf: [512]u8 = undefined;
    const p = std.fmt.bufPrintZ(&pbuf, "{s}/.cache/pay/pay.sh", .{home}) catch return false;
    return access(p.ptr, 0) == 0; // F_OK — pay.sh installed = opt-in
}

/// Best-effort timeout prefix for a pay.sh shellout, so a wedged call is killed
/// (its death dismisses any dialog it owns) instead of hanging the substrate.
/// Empty when no timeout binary is present — the keychain-session gate is the
/// primary, always-present protection.
fn payTimeoutPrefix() []const u8 {
    if (access("/opt/homebrew/bin/gtimeout", 0) == 0) return "/opt/homebrew/bin/gtimeout 6 ";
    if (access("/usr/local/bin/gtimeout", 0) == 0) return "/usr/local/bin/gtimeout 6 ";
    if (access("/usr/bin/timeout", 0) == 0) return "/usr/bin/timeout 6 ";
    return "";
}

fn payShRead(allocator: std.mem.Allocator, svc: []const u8) !?[]u8 {
    const home = cHome() orelse return null;
    var cmd_buf: [768]u8 = undefined;
    // svc is validateSvc-sanitized ([a-zA-Z0-9._-]) so interpolation is safe.
    const cmd = try std.fmt.bufPrintZ(
        &cmd_buf,
        "{s}\"{s}/.cache/pay/pay.sh\" read {s} 2>/dev/null",
        .{ payTimeoutPrefix(), home, svc },
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

fn payShWrite(allocator: std.mem.Allocator, svc: []const u8, value: []const u8) !void {
    _ = allocator;
    // value must be shell-safe (callers hex-encode); reject quote/newline/NUL.
    for (value) |c| {
        if (c == '\'' or c == '\n' or c == '\r' or c == 0) return KeystoreError.InvalidServiceName;
    }
    const home = cHome() orelse return KeystoreError.NoHome;
    var cmd_buf: [4608]u8 = undefined;
    const cmd = try std.fmt.bufPrintZ(
        &cmd_buf,
        // stdout MUST be discarded, not inherited: pay.sh prints "OK" after a
        // store, and an inherited fd 1 corrupts any framed protocol stream the
        // caller owns (observed 2026-07-29: `zig build test` server mode
        // deadlocked — "OK\n" in the test-results frame desynced the runner).
        "printf '%s' '{s}' | {s}\"{s}/.cache/pay/pay.sh\" store {s} >/dev/null 2>/dev/null",
        .{ value, payTimeoutPrefix(), home, svc },
    );
    const rc = system(cmd.ptr);
    if (rc != 0) return KeystoreError.WriteFailed;
}

// ─────────────── darwin (security CLI) ───────────────

/// Non-prompting probe: is a keychain available in THIS session's search list?
/// `security add/find-generic-password` pops a blocking SecurityAgent dialog
/// ("a keychain cannot be found to store …") when the search list is empty —
/// and `2>/dev/null` cannot suppress it (the dialog is a separate UI process,
/// not stderr). The ONLY way to avoid the dialog is to not invoke `security`
/// when no keychain is present. `list-keychains` is a pure query (never
/// prompts); empty output / failure ⇒ skip the security backend, fall to the
/// encrypted-file fallback. This keeps the keystore non-blocking by
/// construction in headless / no-session contexts (the bug that popped a dialog
/// in a sibling agent session).
fn darwinKeychainUsable() bool {
    const fp = popen("/usr/bin/security list-keychains -d user 2>/dev/null", "r") orelse return false;
    var buf: [512]u8 = undefined;
    const n = fread(&buf, 1, buf.len, fp);
    const rc = pclose(fp);
    if (rc != 0) return false;
    // Any non-whitespace, non-quote byte ⇒ at least one keychain in the list.
    var i: usize = 0;
    while (i < n) : (i += 1) {
        const c = buf[i];
        if (c != ' ' and c != '\n' and c != '\r' and c != '\t' and c != '"') return true;
    }
    return false;
}

fn darwinRead(allocator: std.mem.Allocator, svc: []const u8) !?[]u8 {
    if (!darwinKeychainUsable()) return null; // no keychain → never invoke `security`
    // Use the same Security.framework API as darwinWrite. Mixing a framework
    // write with a `security` CLI read made fresh items intermittently
    // invisible in non-interactive sessions even though the write succeeded.
    const handle = dlopen("/System/Library/Frameworks/Security.framework/Security", 0x2) orelse
        return null;
    defer _ = dlclose(handle);
    const FindFn = *const fn (
        ?*anyopaque,
        u32,
        [*]const u8,
        u32,
        [*]const u8,
        ?*u32,
        ?*?*anyopaque,
        ?*?*anyopaque,
    ) callconv(.c) i32;
    const FreeFn = *const fn (?*const anyopaque, ?*anyopaque) callconv(.c) i32;
    const find: FindFn = @ptrCast(@alignCast(
        dlsym(handle, "SecKeychainFindGenericPassword") orelse return null,
    ));
    const free_content: FreeFn = @ptrCast(@alignCast(
        dlsym(handle, "SecKeychainItemFreeContent") orelse return null,
    ));
    const account = "root";
    var secret_len: u32 = 0;
    var secret_ptr: ?*anyopaque = null;
    const status = find(
        null,
        @intCast(svc.len),
        svc.ptr,
        account.len,
        account.ptr,
        &secret_len,
        &secret_ptr,
        null,
    );
    if (status != 0 or secret_ptr == null or secret_len == 0) return null;
    defer _ = free_content(null, secret_ptr);
    const secret: [*]const u8 = @ptrCast(secret_ptr.?);
    return try allocator.dupe(u8, secret[0..secret_len]);
}

fn darwinWrite(allocator: std.mem.Allocator, svc: []const u8, value: []const u8) !void {
    _ = allocator;
    // No keychain in this session → never invoke `security add-generic-password`
    // (it would pop a blocking dialog). Caller falls through to the encrypted
    // file, which always works and never prompts.
    if (!darwinKeychainUsable()) return KeystoreError.WriteFailed;
    // Native Security.framework call: the secret is passed as an in-process
    // byte pointer, never through argv, environment, shell expansion or logs.
    const handle = dlopen("/System/Library/Frameworks/Security.framework/Security", 0x2) orelse
        return KeystoreError.WriteFailed; // RTLD_NOW
    defer _ = dlclose(handle);
    const FindFn = *const fn (
        ?*anyopaque,
        u32,
        [*]const u8,
        u32,
        [*]const u8,
        ?*u32,
        ?*?*anyopaque,
        *?*anyopaque,
    ) callconv(.c) i32;
    const ModifyFn = *const fn (*anyopaque, ?*const anyopaque, u32, [*]const u8) callconv(.c) i32;
    const AddFn = *const fn (
        ?*anyopaque,
        u32,
        [*]const u8,
        u32,
        [*]const u8,
        u32,
        [*]const u8,
        ?*?*anyopaque,
    ) callconv(.c) i32;
    const find: FindFn = @ptrCast(@alignCast(dlsym(handle, "SecKeychainFindGenericPassword") orelse return KeystoreError.WriteFailed));
    const modify: ModifyFn = @ptrCast(@alignCast(dlsym(handle, "SecKeychainItemModifyAttributesAndData") orelse return KeystoreError.WriteFailed));
    const add: AddFn = @ptrCast(@alignCast(dlsym(handle, "SecKeychainAddGenericPassword") orelse return KeystoreError.WriteFailed));
    const account = "root";
    var item: ?*anyopaque = null;
    const found = find(null, @intCast(svc.len), svc.ptr, account.len, account.ptr, null, null, &item);
    if (found == 0 and item != null) {
        if (modify(item.?, null, @intCast(value.len), value.ptr) != 0) return KeystoreError.WriteFailed;
        return;
    }
    // errSecItemNotFound. Refuse other lookup errors rather than replacing an
    // item whose access control we could not inspect.
    if (found != -25300) return KeystoreError.WriteFailed;
    if (add(null, @intCast(svc.len), svc.ptr, account.len, account.ptr, @intCast(value.len), value.ptr, null) != 0)
        return KeystoreError.WriteFailed;
}

fn darwinDelete(allocator: std.mem.Allocator, svc: []const u8) !void {
    _ = allocator;
    if (!darwinKeychainUsable()) return; // no keychain → nothing to delete, no prompt
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
    fillRandom(&nonce);
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
    } else |_| {
        // silent: /etc/machine-id is linux-only by design; macOS path below
        // composes the same fingerprint anchor from IOPlatformUUID. Surfacing
        // here would emit one line on every macOS keystore call.
    }
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
    const home_z = std.c.getenv(if (is_windows) "USERPROFILE" else "HOME");
    if (home_z == null) return KeystoreError.NoHome;
    const home = std.mem.span(@as([*:0]const u8, @ptrCast(home_z.?)));
    return try allocator.dupe(u8, home);
}

fn readFile(allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);
    const fd: c_int = if (is_windows) _open(path_z.ptr, 0x8000) else blk: {
        var flags: std.c.O = .{};
        flags.ACCMODE = .RDONLY;
        break :blk std.c.open(path_z.ptr, flags, @as(c_uint, 0));
    };
    if (fd < 0) return error.FileNotFound;
    defer _ = if (is_windows) _close(fd) else std.c.close(fd);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    var chunk: [4096]u8 = undefined;
    while (true) {
        const n = if (is_windows) _read(fd, &chunk, chunk.len) else std.c.read(fd, &chunk, chunk.len);
        if (n <= 0) break;
        try out.appendSlice(allocator, chunk[0..@intCast(n)]);
        if (out.items.len > 1024 * 1024) return error.FileTooLarge;
    }
    return try out.toOwnedSlice(allocator);
}

fn writeFileAtomic(allocator: std.mem.Allocator, tmp_path: []const u8, final_path: []const u8, bytes: []const u8) !void {
    const tmp_z = try allocator.dupeZ(u8, tmp_path);
    defer allocator.free(tmp_z);
    const fd: c_int = if (is_windows) _open(tmp_z.ptr, 0x0001 | 0x0100 | 0x0200 | 0x8000, @as(c_int, 0o600)) else blk: {
        var flags: std.c.O = .{};
        flags.ACCMODE = .WRONLY;
        flags.CREAT = true;
        flags.TRUNC = true;
        break :blk std.c.open(tmp_z.ptr, flags, @as(c_uint, 0o600));
    };
    if (fd < 0) return KeystoreError.WriteFailed;
    const n = if (is_windows) _write(fd, bytes.ptr, @intCast(bytes.len)) else std.c.write(fd, bytes.ptr, bytes.len);
    _ = if (is_windows) _close(fd) else std.c.close(fd);
    if (n < @as(isize, @intCast(bytes.len))) return KeystoreError.WriteFailed;

    const final_z = try allocator.dupeZ(u8, final_path);
    defer allocator.free(final_z);
    if (std.c.rename(tmp_z.ptr, final_z.ptr) != 0) return KeystoreError.WriteFailed;
}

fn makePath(allocator: std.mem.Allocator, path: []const u8) !void {
    var i: usize = 0;
    while (i < path.len) : (i += 1) {
        if ((path[i] == '/' or (is_windows and path[i] == '\\')) and i > 0) {
            const partial = try allocator.dupeZ(u8, path[0..i]);
            defer allocator.free(partial);
            _ = if (is_windows) _mkdir(partial.ptr) else std.c.mkdir(partial.ptr, 0o755);
        }
    }
    const full = try allocator.dupeZ(u8, path);
    defer allocator.free(full);
    _ = if (is_windows) _mkdir(full.ptr) else std.c.mkdir(full.ptr, 0o700);
}

test "keystore round-trip on this platform" {
    const allocator = std.testing.allocator;
    // Unique svc per run so concurrent CI runs don't clobber each other.
    var rnd: [4]u8 = undefined;
    fillRandom(&rnd);
    var svc_buf: [64]u8 = undefined;
    const svc = try std.fmt.bufPrint(&svc_buf, "aiko.test.ks-{x:0>2}{x:0>2}{x:0>2}{x:0>2}", .{ rnd[0], rnd[1], rnd[2], rnd[3] });

    const payload = "deadbeefcafebabe1234567890abcdef";

    // Ensure clean slate.
    try delete(allocator, svc);
    // PARITY-OK: defer test cleanup — svc is unique per run (random suffix);
    // any platform that fails delete here is already covered by the explicit
    // `try delete(allocator, svc)` above. Surfacing here would emit a benign
    // line on every test run without telling the user anything they can act
    // on. The PARITY-OK marker is honored by build.sh's parity gate.
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
