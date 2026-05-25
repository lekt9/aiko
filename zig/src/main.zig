//! contract-zig — native core for the /contract substrate.
//!
//! This binary owns the load-bearing loop behind a small public surface:
//! declare, inspect, discover, search, and self. Manual stepping and manual
//! satisfaction are internal mechanics, not user-facing escape hatches.
const std = @import("std");
const contract = @import("contract");
const client = @import("contract_client");
const build_options = @import("build_options");
const pointer = @import("pointer.zig");
const ledger = @import("ledger.zig");

const VERSION = "0.4.0-guarded-native-shape";
const lineage_lib = @import("contract").Lineage;
const HkdfSha256 = std.crypto.kdf.hkdf.HkdfSha256;
const X25519 = std.crypto.dh.X25519;
const ChaCha20Poly1305 = std.crypto.aead.chacha_poly.ChaCha20Poly1305;
const BINARY_NAME = build_options.binary_name;
const AIKO_DECLARE_ONLY = std.mem.eql(u8, BINARY_NAME, "aiko");

const Row = struct {
    id: []const u8 = "",
    event: []const u8 = "",
    plan: []const u8 = "",
    action: []const u8 = "",
    cwd: []const u8 = "",
    parent_id: ?[]const u8 = null,
    child_id: []const u8 = "",
    action_result: []const u8 = "",
    action_exit: i32 = 0,
    wave: u32 = 0,
    satisfied: bool = false,
    env_pubkey: []const u8 = "",
    parent_signature: []const u8 = "",
    input_hash: []const u8 = "",
    /// Layer per contract:d10b3dbb convention (1=system, 2=cell, 3=graph,
    /// 4=transport, 5=value, 6=operator). Inferred at declare from
    /// pointer.zig's inferLayer; persisted on the row.
    layer: u8 = 0,
};

fn writeFd(fd: c_int, bytes: []const u8) void {
    var rem = bytes;
    while (rem.len > 0) {
        const n = std.c.write(fd, rem.ptr, rem.len);
        if (n <= 0) return;
        rem = rem[@intCast(n)..];
    }
}

fn out(bytes: []const u8) void {
    writeFd(std.c.STDOUT_FILENO, bytes);
}

fn err(bytes: []const u8) void {
    writeFd(std.c.STDERR_FILENO, bytes);
}

fn outPrint(comptime fmt: []const u8, args: anytype) void {
    var buf: [8192]u8 = undefined;
    const s = std.fmt.bufPrint(&buf, fmt, args) catch return;
    out(s);
}

fn errPrint(comptime fmt: []const u8, args: anytype) void {
    var buf: [8192]u8 = undefined;
    const s = std.fmt.bufPrint(&buf, fmt, args) catch return;
    err(s);
}

fn evidence(bytes: []const u8) void {
    err(bytes);
}

fn evidencePrint(comptime fmt: []const u8, args: anytype) void {
    errPrint(fmt, args);
}

fn usage() void {
    errPrint("{s} {s}\n\nUsage:\n", .{ BINARY_NAME, VERSION });
    if (AIKO_DECLARE_ONLY) {
        errPrint(
            \\  {s} "<truth claim>"
            \\
            \\Dimension resolves from the environment. Set UNBROWSE_BASE /
            \\AIKO_X_PAYMENT / X_PAYMENT to route to Unbrowse; else the local
            \\ledger receives the Word and walks 9 days (Genesis-shaped).
            \\
            \\Overrides (rarely needed):
            \\  {s} "<truth>" --remote     route to Unbrowse explicitly
            \\  {s} "<truth>" --local      one-shot local lifecycle (no day walk)
            \\  {s} "<truth>" --genesis    force 9-day Fib walk on local ledger
            \\  {s} declare "<truth>"      compat alias
            \\
            \\Empathic translation:
            \\  {s} "<truth>" --user <user-aiko-id>
            \\    Bind the spawn against the user's context aiko so the Word's
            \\    compiler shapes output against what the user has already
            \\    satisfied / encountered / declared as audience level.
            \\
        , .{ BINARY_NAME, BINARY_NAME, BINARY_NAME, BINARY_NAME, BINARY_NAME, BINARY_NAME });
        return;
    }
    errPrint(
        \\  {s} declare <truth-claim>
        \\
    , .{BINARY_NAME});
    if (!AIKO_DECLARE_ONLY) {
        errPrint(
            \\  {s} status [<id>]
            \\  {s} discover [--scope all|project|global]
            \\  {s} search --context <text>
            \\  {s} self [--json]
            \\
        , .{ BINARY_NAME, BINARY_NAME, BINARY_NAME, BINARY_NAME });
    }
}

fn jsonString(line: []const u8, key: []const u8) ?[]const u8 {
    var needle_buf: [128]u8 = undefined;
    const needle = std.fmt.bufPrint(&needle_buf, "\"{s}\":", .{key}) catch return null;
    const at = std.mem.indexOf(u8, line, needle) orelse return null;
    var start = at + needle.len;
    while (start < line.len and (line[start] == ' ' or line[start] == '\t')) : (start += 1) {}
    if (start >= line.len or line[start] != '"') return null;
    start += 1;
    var i = start;
    while (i < line.len) : (i += 1) {
        if (line[i] == '\\') {
            i += 1;
            continue;
        }
        if (line[i] == '"') return line[start..i];
    }
    return null;
}

fn jsonInt(line: []const u8, key: []const u8) ?i32 {
    var needle_buf: [128]u8 = undefined;
    const needle = std.fmt.bufPrint(&needle_buf, "\"{s}\": ", .{key}) catch return null;
    const at = std.mem.indexOf(u8, line, needle) orelse return null;
    const start = at + needle.len;
    var end = start;
    while (end < line.len and ((line[end] >= '0' and line[end] <= '9') or line[end] == '-')) : (end += 1) {}
    if (end == start) return null;
    return std.fmt.parseInt(i32, line[start..end], 10) catch null;
}

fn jsonNullableString(line: []const u8, key: []const u8) ?[]const u8 {
    if (jsonString(line, key)) |s| return s;
    return null;
}

fn parseRows(allocator: std.mem.Allocator, env: std.process.Environ) ![]Row {
    const data = try ledger.readAll(allocator, env);
    // Rows intentionally borrow slices from `data`. The native CLI is a
    // short-lived process, so keeping the ledger buffer alive until process
    // exit is simpler and safer than duplicating every field.

    var rows: std.ArrayList(Row) = .empty;
    errdefer rows.deinit(allocator);
    var it = std.mem.splitScalar(u8, data, '\n');
    while (it.next()) |line| {
        if (line.len == 0) continue;
        var r = Row{};
        r.id = jsonString(line, "id") orelse "";
        r.event = jsonString(line, "event") orelse "";
        r.plan = jsonString(line, "plan") orelse "";
        r.action = jsonString(line, "action") orelse "";
        r.cwd = jsonString(line, "cwd") orelse "";
        r.parent_id = jsonNullableString(line, "parent_id");
        r.child_id = jsonString(line, "child_id") orelse "";
        r.action_result = jsonString(line, "action_result") orelse "";
        r.action_exit = jsonInt(line, "action_exit") orelse 0;
        r.wave = @intCast(jsonInt(line, "wave") orelse 0);
        r.satisfied = std.mem.eql(u8, r.event, "satisfied");
        r.env_pubkey = jsonString(line, "env_pubkey") orelse "";
        r.input_hash = jsonString(line, "input_hash") orelse "";
        r.parent_signature = jsonString(line, "parent_signature") orelse "";
        r.layer = @intCast(jsonInt(line, "layer") orelse 0);
        try rows.append(allocator, r);
    }
    return try rows.toOwnedSlice(allocator);
}

fn latestDeclared(rows: []const Row, id: []const u8) ?Row {
    var found: ?Row = null;
    for (rows) |r| {
        if (std.mem.eql(u8, r.event, "declared") and std.mem.eql(u8, r.id, id)) found = r;
    }
    return found;
}

fn isSatisfied(rows: []const Row, id: []const u8) bool {
    for (rows) |r| {
        if (std.mem.eql(u8, r.event, "satisfied") and std.mem.eql(u8, r.id, id)) return true;
    }
    return false;
}

/// Natural-selection projection: has a `died` event been appended for this id?
/// Append-only — once dead, stays dead (Hebrews 9:27, appointed once to die).
fn isDead(rows: []const Row, id: []const u8) bool {
    for (rows) |r| {
        if (std.mem.eql(u8, r.event, "died") and std.mem.eql(u8, r.id, id)) return true;
    }
    return false;
}

fn latestWave(rows: []const Row, id: []const u8) u32 {
    var w: u32 = 0;
    for (rows) |r| {
        if (std.mem.eql(u8, r.id, id) and std.mem.eql(u8, r.event, "iterated")) {
            if (r.wave > w) w = r.wave;
        }
    }
    return w;
}

fn appendUnique(ids: *std.ArrayList([]const u8), allocator: std.mem.Allocator, id: []const u8) !void {
    for (ids.items) |existing| {
        if (std.mem.eql(u8, existing, id)) return;
    }
    try ids.append(allocator, id);
}

fn childIds(allocator: std.mem.Allocator, rows: []const Row, parent_id: []const u8) ![][]const u8 {
    var ids: std.ArrayList([]const u8) = .empty;
    errdefer ids.deinit(allocator);
    for (rows) |r| {
        if (std.mem.eql(u8, r.event, "declared")) {
            if (r.parent_id) |p| {
                if (std.mem.eql(u8, p, parent_id)) try ids.append(allocator, r.id);
            }
        }
    }
    return try ids.toOwnedSlice(allocator);
}

fn dependentIds(allocator: std.mem.Allocator, rows: []const Row, target_id: []const u8) ![][]const u8 {
    var ids: std.ArrayList([]const u8) = .empty;
    errdefer ids.deinit(allocator);
    var needle_buf: [32]u8 = undefined;
    const needle = std.fmt.bufPrint(&needle_buf, "contract:{s}", .{target_id}) catch return try ids.toOwnedSlice(allocator);
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        if (std.mem.indexOf(u8, r.action, needle) != null) try appendUnique(&ids, allocator, r.id);
    }
    return try ids.toOwnedSlice(allocator);
}

fn hookId(env: std.process.Environ, primary: []const u8, secondary: []const u8) ?[]const u8 {
    if (env.getPosix(primary)) |v| {
        if (v.len > 0) return v;
    }
    if (env.getPosix(secondary)) |v| {
        if (v.len > 0) return v;
    }
    return null;
}

extern fn system(command: [*:0]const u8) c_int;
extern fn popen(command: [*:0]const u8, mode: [*:0]const u8) ?*anyopaque;
extern fn pclose(stream: *anyopaque) c_int;
extern fn fread(ptr: [*]u8, size: usize, nmemb: usize, stream: *anyopaque) usize;
extern fn feof(stream: *anyopaque) c_int;
extern fn setenv(name: [*:0]const u8, value: [*:0]const u8, overwrite: c_int) c_int;
extern fn unsetenv(name: [*:0]const u8) c_int;
extern fn getentropy(buf: [*]u8, len: usize) c_int;
// macOS stat: we only need st_mode (u16 on Darwin) — declare a minimal stat
// struct in C ABI. Use _DARWIN_FEATURE_64_BIT_INODE via stat$INODE64 on
// older Darwin; the default symbol on arm64 macOS 11+ is already 64-bit.
const c_stat = extern struct {
    st_dev: i32 = 0,
    st_mode: u16 = 0,
    st_nlink: u16 = 0,
    st_ino: u64 = 0,
    st_uid: u32 = 0,
    st_gid: u32 = 0,
    st_rdev: i32 = 0,
    st_atimespec: extern struct { tv_sec: i64 = 0, tv_nsec: i64 = 0 } = .{},
    st_mtimespec: extern struct { tv_sec: i64 = 0, tv_nsec: i64 = 0 } = .{},
    st_ctimespec: extern struct { tv_sec: i64 = 0, tv_nsec: i64 = 0 } = .{},
    st_birthtimespec: extern struct { tv_sec: i64 = 0, tv_nsec: i64 = 0 } = .{},
    st_size: i64 = 0,
    st_blocks: i64 = 0,
    st_blksize: i32 = 0,
    st_flags: u32 = 0,
    st_gen: u32 = 0,
    st_lspare: i32 = 0,
    st_qspare: [2]i64 = .{ 0, 0 },
};
extern fn stat(path: [*:0]const u8, st: *c_stat) c_int;

/// Look up the latest non-empty action_result for `cid` in the in-memory rows.
/// Used to propagate context up the tree as a posthook payload env var.
fn latestActionResult(rows: []const Row, cid: []const u8) ?[]const u8 {
    var i: usize = rows.len;
    while (i > 0) : (i -= 1) {
        const r = rows[i - 1];
        if (!std.mem.eql(u8, r.id, cid)) continue;
        if (r.action_result.len == 0) continue;
        return r.action_result;
    }
    return null;
}

/// Content-addressed input hash for a contract row: blake2s(
///   plan || NUL || action || NUL || child_id_sorted || child_hash || ...
/// ). Recursive — a child's contribution is its own current input_hash,
/// so any change to a leaf invalidates every ancestor automatically.
/// This is the Bazel/Nix-style propagation key: when this hash differs
/// from the input_hash recorded on the latest `iterated` row, the cache
/// is stale and the resolver re-runs.
const Blake2s256 = std.crypto.hash.blake2.Blake2s256;
const INPUT_HASH_HEX_LEN: usize = 64;

fn lastInputHash(rows: []const Row, cid: []const u8) ?[]const u8 {
    var i: usize = rows.len;
    while (i > 0) : (i -= 1) {
        const r = rows[i - 1];
        if (!std.mem.eql(u8, r.id, cid)) continue;
        if (!std.mem.eql(u8, r.event, "iterated")) continue;
        if (r.input_hash.len == 0) continue;
        return r.input_hash;
    }
    return null;
}

fn declaredRow(rows: []const Row, cid: []const u8) ?Row {
    var i: usize = rows.len;
    while (i > 0) : (i -= 1) {
        const r = rows[i - 1];
        if (!std.mem.eql(u8, r.id, cid)) continue;
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        return r;
    }
    return null;
}

fn computeInputHash(allocator: std.mem.Allocator, rows: []const Row, cid: []const u8, depth: u8) ![INPUT_HASH_HEX_LEN]u8 {
    var out_hex: [INPUT_HASH_HEX_LEN]u8 = undefined;
    if (depth > 32) {
        // Cycle guard. Hash just the id deterministically.
        var h: [32]u8 = undefined;
        Blake2s256.hash(cid, &h, .{});
        lineage_lib.bytesToHex(&h, &out_hex);
        return out_hex;
    }
    var hasher = Blake2s256.init(.{});
    const r = declaredRow(rows, cid) orelse {
        // Unknown contract — hash the bare id; treat it as a stable leaf.
        var h: [32]u8 = undefined;
        Blake2s256.hash(cid, &h, .{});
        lineage_lib.bytesToHex(&h, &out_hex);
        return out_hex;
    };
    hasher.update(r.plan);
    hasher.update(&.{0});
    hasher.update(r.action);
    hasher.update(&.{0});

    // Collect direct child ids, sort them so the hash is determinate
    // regardless of declaration order.
    const child_ids = try childIds(allocator, rows, cid);
    defer allocator.free(child_ids);
    var sorted = try allocator.alloc([]const u8, child_ids.len);
    defer allocator.free(sorted);
    for (child_ids, 0..) |c, i| sorted[i] = c;
    std.mem.sort([]const u8, sorted, {}, struct {
        fn lt(_: void, a: []const u8, b: []const u8) bool {
            return std.mem.order(u8, a, b) == .lt;
        }
    }.lt);
    for (sorted) |child| {
        const child_hex = try computeInputHash(allocator, rows, child, depth + 1);
        hasher.update(child);
        hasher.update(&.{0});
        hasher.update(&child_hex);
        hasher.update(&.{0});
    }
    var digest: [32]u8 = undefined;
    hasher.final(&digest);
    lineage_lib.bytesToHex(&digest, &out_hex);
    return out_hex;
}

/// Check if `cid` appears anywhere in the local ledger as a declared row.
/// Used to decide whether a posthook target is local (env+popen path) or
/// remote (lineage-mesh encrypted hook envelope path).
fn isLocalContract(rows: []const Row, cid: []const u8) bool {
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        if (std.mem.eql(u8, r.id, cid)) return true;
    }
    return false;
}

/// Find the declared row for `cid` (latest) so we can read its parent_id.
fn declaredParentOf(rows: []const Row, cid: []const u8) ?[]const u8 {
    var i: usize = rows.len;
    while (i > 0) : (i -= 1) {
        const r = rows[i - 1];
        if (!std.mem.eql(u8, r.id, cid)) continue;
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        return r.parent_id;
    }
    return null;
}

/// JSON-escape a string into buf with the minimum set: \, ", control chars.
fn appendJsonEscaped(allocator: std.mem.Allocator, buf: *std.ArrayList(u8), s: []const u8) !void {
    try buf.append(allocator, '"');
    for (s) |c| switch (c) {
        '"' => try buf.appendSlice(allocator, "\\\""),
        '\\' => try buf.appendSlice(allocator, "\\\\"),
        '\n' => try buf.appendSlice(allocator, "\\n"),
        '\r' => try buf.appendSlice(allocator, "\\r"),
        '\t' => try buf.appendSlice(allocator, "\\t"),
        0...8, 11, 12, 14...31 => {
            var hex: [7]u8 = undefined;
            const x = try std.fmt.bufPrint(&hex, "\\u{x:0>4}", .{c});
            try buf.appendSlice(allocator, x);
        },
        else => try buf.append(allocator, c),
    };
    try buf.append(allocator, '"');
}

/// Lineage-mesh primitives (canonical zig port of the python aiko-mesh.py
/// scaffold — replaces it). Implements contract:1a808634 in-binary:
/// deterministic x25519 keypair per (root, peer) derived from the user's
/// wallet seed via HKDF-SHA256, X25519 ECDH + ChaCha20-Poly1305 to encrypt
/// hook payloads to a remote peer's mesh pubkey. No persistent state, no
/// wireguard kernel module, no user setup.
fn meshDeriveX25519(root_seed: [32]u8, root_id: []const u8, peer_id: []const u8, out_key: *[32]u8) !void {
    var info_buf: [128]u8 = undefined;
    const info = try std.fmt.bufPrint(&info_buf, "aiko-mesh/v1/{s}/{s}", .{ root_id, peer_id });
    const prk = HkdfSha256.extract(&[_]u8{}, &root_seed);
    HkdfSha256.expand(out_key[0..], info, prk);
    // x25519 clamping per RFC 7748.
    out_key[0] &= 248;
    out_key[31] &= 127;
    out_key[31] |= 64;
}

fn meshPublicKey(priv: [32]u8) ![32]u8 {
    return try X25519.recoverPublicKey(priv);
}

const MeshEnvelope = struct {
    nonce: [ChaCha20Poly1305.nonce_length]u8,
    tag: [ChaCha20Poly1305.tag_length]u8,
    ciphertext: []u8,
};

fn meshEncryptHook(allocator: std.mem.Allocator, local_priv: [32]u8, peer_pub: [32]u8, payload: []const u8, info: []const u8) !MeshEnvelope {
    const shared = try X25519.scalarmult(local_priv, peer_pub);
    var sym: [32]u8 = undefined;
    const prk = HkdfSha256.extract(&[_]u8{}, &shared);
    HkdfSha256.expand(&sym, info, prk);
    var nonce: [ChaCha20Poly1305.nonce_length]u8 = undefined;
    if (getentropy(&nonce, nonce.len) != 0) return error.RandomFailed;
    const ct = try allocator.alloc(u8, payload.len);
    var tag: [ChaCha20Poly1305.tag_length]u8 = undefined;
    ChaCha20Poly1305.encrypt(ct, &tag, payload, &[_]u8{}, nonce, sym);
    return .{ .nonce = nonce, .tag = tag, .ciphertext = ct };
}

/// Encrypt a hook payload to a remote posthook target and emit the envelope
/// as ledger evidence + a called-row with transport=wireguard-lineage-mesh.
/// root_id for the derivation is the firing contract id (cid) — the firing
/// node IS the root of its own ephemeral hook mesh.
fn meshEmitRemoteHook(allocator: std.mem.Allocator, env: std.process.Environ, cid: []const u8, posthook: []const u8, tree_payload: []const u8) !void {
    const root_seed = try lineage_lib.loadOrInitRootKey(allocator, env);
    var local_priv: [32]u8 = undefined;
    var peer_priv: [32]u8 = undefined;
    try meshDeriveX25519(root_seed, cid, cid, &local_priv);
    try meshDeriveX25519(root_seed, cid, posthook, &peer_priv);
    const peer_pub = try meshPublicKey(peer_priv);
    var info_buf: [128]u8 = undefined;
    const info = try std.fmt.bufPrint(&info_buf, "aiko-mesh/hook/{s}/{s}->{s}", .{ cid, cid, posthook });
    const env_pkt = try meshEncryptHook(allocator, local_priv, peer_pub, tree_payload, info);
    defer allocator.free(env_pkt.ciphertext);

    // Hex-encode peer pubkey + nonce + tag + ciphertext for the called row's
    // target_pointer body. Bounded by 16KB so the ledger row stays sane.
    const hex_max: usize = @min(env_pkt.ciphertext.len, 8 * 1024);
    var hex_buf: std.ArrayList(u8) = .empty;
    defer hex_buf.deinit(allocator);
    try hex_buf.appendSlice(allocator, "wireguard-lineage-mesh:peer=");
    var pub_hex: [64]u8 = undefined;
    lineage_lib.bytesToHex(&peer_pub, &pub_hex);
    try hex_buf.appendSlice(allocator, &pub_hex);
    try hex_buf.appendSlice(allocator, ",nonce=");
    var nonce_hex: [24]u8 = undefined;
    lineage_lib.bytesToHex(&env_pkt.nonce, &nonce_hex);
    try hex_buf.appendSlice(allocator, &nonce_hex);
    try hex_buf.appendSlice(allocator, ",tag=");
    var tag_hex: [32]u8 = undefined;
    lineage_lib.bytesToHex(&env_pkt.tag, &tag_hex);
    try hex_buf.appendSlice(allocator, &tag_hex);
    try hex_buf.appendSlice(allocator, ",ct=");
    const ct_hex = try allocator.alloc(u8, hex_max * 2);
    defer allocator.free(ct_hex);
    lineage_lib.bytesToHex(env_pkt.ciphertext[0..hex_max], ct_hex);
    try hex_buf.appendSlice(allocator, ct_hex);
    const target_pointer = try hex_buf.toOwnedSlice(allocator);
    defer allocator.free(target_pointer);

    try contract.appendCalledRow(allocator, env, cid, target_pointer, "posthook-mesh");
    evidencePrint("mesh hook encrypted: {s} -> {s} ct_bytes={d} nonce={s}\n", .{ cid, posthook, env_pkt.ciphertext.len, nonce_hex[0..16] });
}

/// Walk the parent_id chain from `cid` up to root and emit a JSON array of
/// {id, action_result} entries — child-first ordering so posthooks can read
/// the recursive ancestor stack at every layer. Caps depth at 32 and per-
/// entry result size at 4KB to keep the env payload bounded.
fn buildAncestorTree(allocator: std.mem.Allocator, rows: []const Row, cid: []const u8) ![]u8 {
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);
    try buf.append(allocator, '[');
    var current: ?[]const u8 = cid;
    var depth: usize = 0;
    var first = true;
    while (current != null and depth < 32) : (depth += 1) {
        const this_id = current.?;
        if (!first) try buf.append(allocator, ',');
        first = false;
        try buf.appendSlice(allocator, "{\"id\":");
        try appendJsonEscaped(allocator, &buf, this_id);
        try buf.appendSlice(allocator, ",\"result\":");
        const res = latestActionResult(rows, this_id) orelse "";
        const capped = res[0..@min(res.len, 4096)];
        try appendJsonEscaped(allocator, &buf, capped);
        try buf.append(allocator, '}');
        current = declaredParentOf(rows, this_id);
    }
    try buf.append(allocator, ']');
    return try buf.toOwnedSlice(allocator);
}

fn runShell(allocator: std.mem.Allocator, action: []const u8, cwd: []const u8) !i32 {
    const cmd_plain = if (cwd.len > 0)
        try std.fmt.allocPrint(allocator, "cd \"{s}\" && {s}", .{ cwd, action })
    else
        try allocator.dupe(u8, action);
    defer allocator.free(cmd_plain);
    const cmd = try allocator.dupeZ(u8, cmd_plain);
    defer allocator.free(cmd);
    const rc = system(cmd.ptr);
    if (rc == -1) return 127;
    if ((rc & 0xff) == 0) return @intCast((rc >> 8) & 0xff);
    return 1;
}

/// Run a shell command and capture combined stdout+stderr as a string, plus
/// the exit code. Used by neuron resolvers so the parent neuron's `result`
/// field carries the actual body output, not just a status label — that's
/// the recursive context-aggregation channel.
const ShellOutput = struct { rc: i32, output: []u8 };

/// In strict mode (CONTRACT_SHELL_STRICT=1) reject actions containing the
/// metacharacters that enable command chaining, substitution, or piping out
/// of the declared body. The default is OFF for back-compat — existing
/// contracts intentionally compose with `;` / `&&` / `|`. When enabled this
/// gate fails closed with a NAMED cause; it never silently drops execution.
/// Drill B — wallet permission gate. The 32-byte root secret at
/// ~/.contracts/root.key must not be group/world-readable. If the file
/// exists and st_mode & 077 != 0 we refuse with a NAMED cause; cleaning up
/// is a manual step (chmod 600). Honored in strict mode by default, and
/// always when CONTRACT_WALLET_STRICT=1.
fn walletPermissionReject(allocator: std.mem.Allocator, env: std.process.Environ) ?[]const u8 {
    const strict = blk: {
        const f = env.getPosix("CONTRACT_WALLET_STRICT") orelse break :blk true;
        break :blk std.mem.eql(u8, f, "1") or std.mem.eql(u8, f, "on");
    };
    if (!strict) return null;
    const home = env.getPosix("HOME") orelse return null;
    const path = std.fs.path.join(allocator, &.{ home, ".contracts", "root.key" }) catch return null;
    defer allocator.free(path);
    const path_z = allocator.dupeZ(u8, path) catch return null;
    defer allocator.free(path_z);
    var st: c_stat = .{};
    if (stat(path_z.ptr, &st) != 0) return null; // missing is fine; loadOrInitRootKey will create
    const mode: u16 = st.st_mode;
    if ((mode & 0o077) != 0) {
        const msg = std.fmt.allocPrint(allocator, "wallet-strict: ~/.contracts/root.key mode 0{o} is group/world-readable; chmod 600", .{mode & 0o777}) catch return "wallet-strict: root.key permissions too open";
        return msg;
    }
    return null;
}

/// Drill C — runtime self-attest before ledger mutation. When
/// CONTRACT_REQUIRE_SIGNED=1 (opt-in for now; will flip default later) every
/// declare verifies the running binary's own SHA-256 against the lineage
/// signing key before any ledger row is appended. Tampered binaries are
/// refused with a NAMED cause; without the env var we emit an evidence
/// line only.
fn binaryAttestReject(allocator: std.mem.Allocator, env: std.process.Environ) ?[]const u8 {
    var require = false;
    if (env.getPosix("CONTRACT_REQUIRE_SIGNED")) |f| {
        if (std.mem.eql(u8, f, "1") or std.mem.eql(u8, f, "on")) require = true;
    }
    var exe_buf: [4096]u8 = undefined;
    var buf_size: u32 = exe_buf.len;
    if (_NSGetExecutablePath(&exe_buf, &buf_size) != 0) return null;
    const exe_len = std.mem.indexOfScalar(u8, &exe_buf, 0) orelse exe_buf.len;
    const exe_path = exe_buf[0..exe_len];
    lineage_lib.verifyBinary(allocator, env, exe_path) catch |e| {
        if (require) {
            const msg = std.fmt.allocPrint(allocator, "binary-attest: self-verify failed ({s}); refusing declare", .{@errorName(e)}) catch return "binary-attest: self-verify failed";
            return msg;
        }
        evidencePrint("binary-attest: WARN self-verify failed ({s}); set CONTRACT_REQUIRE_SIGNED=1 to enforce\n", .{@errorName(e)});
        return null;
    };
    return null;
}

fn shellStrictReject(action: []const u8, env: std.process.Environ) ?[]const u8 {
    const flag = env.getPosix("CONTRACT_SHELL_STRICT") orelse return null;
    if (!std.mem.eql(u8, flag, "1") and !std.mem.eql(u8, flag, "on")) return null;
    // Conservative blocklist: shell metacharacters that change control flow.
    for (action) |c| switch (c) {
        ';', '|', '&', '`', '$', '<', '>' => return "shell-strict: action contains metacharacter (; | & ` $ < >)",
        else => {},
    };
    if (std.mem.indexOf(u8, action, "$(") != null) return "shell-strict: action contains $( command substitution)";
    if (std.mem.indexOf(u8, action, "${") != null) return "shell-strict: action contains ${ var expansion}";
    return null;
}

fn runShellCapture(allocator: std.mem.Allocator, action: []const u8, cwd: []const u8) !ShellOutput {
    // Build "cd <cwd> && <action> 2>&1" so combined stdout+stderr are captured.
    const cmd_plain = if (cwd.len > 0)
        try std.fmt.allocPrint(allocator, "cd \"{s}\" && {s} 2>&1", .{ cwd, action })
    else
        try std.fmt.allocPrint(allocator, "{s} 2>&1", .{action});
    defer allocator.free(cmd_plain);
    const cmd = try allocator.dupeZ(u8, cmd_plain);
    defer allocator.free(cmd);
    const mode: [*:0]const u8 = "r";
    const fp = popen(cmd.ptr, mode) orelse return .{ .rc = 127, .output = try allocator.dupe(u8, "") };
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);
    var chunk: [4096]u8 = undefined;
    while (true) {
        const n = fread(&chunk, 1, chunk.len, fp);
        if (n == 0) break;
        try buf.appendSlice(allocator, chunk[0..n]);
        if (buf.items.len > 64 * 1024) break; // cap evidence at 64KB
    }
    const status = pclose(fp);
    const rc: i32 = if (status == -1) 127 else if ((status & 0xff) == 0) @intCast((status >> 8) & 0xff) else 1;
    return .{ .rc = rc, .output = try buf.toOwnedSlice(allocator) };
}

/// Gather the latest `result` text of each direct child of `parent_id` and
/// concatenate them, prefixed by child id. This becomes the parent's evidence
/// when its neuron-aggregator fires — children's stdout flows up the tree.
fn aggregateChildOutputs(allocator: std.mem.Allocator, rows: []const Row, parent_id: []const u8) ![]u8 {
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);
    const ids = try childIds(allocator, rows, parent_id);
    defer allocator.free(ids);
    for (ids) |cid| {
        // Find latest iteration row with a result for this child.
        var i: usize = rows.len;
        while (i > 0) : (i -= 1) {
            const r = rows[i - 1];
            if (!std.mem.eql(u8, r.id, cid)) continue;
            if (r.action_result.len == 0) continue;
            const line = try std.fmt.allocPrint(allocator, "[{s}] {s}\n", .{ cid, r.action_result });
            defer allocator.free(line);
            try buf.appendSlice(allocator, line);
            break;
        }
    }
    return try buf.toOwnedSlice(allocator);
}

fn runAction(allocator: std.mem.Allocator, env: std.process.Environ, rows: []const Row, r: Row) !struct { rc: i32, result: []const u8 } {
    const action = r.action;
    const ptype = pointer.inferPointerType(action);

    if (std.mem.eql(u8, ptype, "neuron")) {
        const ids = try childIds(allocator, rows, r.id);
        defer allocator.free(ids);
        if (ids.len == 0) {
            evidence("  result: HOLD — neuron has no fired child evidence\n");
            return .{ .rc = 1, .result = "hold" };
        }
        for (ids) |cid| {
            if (!isSatisfied(rows, cid)) {
                evidencePrint("  result: HOLD — child neuron pending: {s}\n", .{cid});
                return .{ .rc = 1, .result = "hold" };
            }
        }
        // FIRE — every child satisfied. Aggregate children's stdout into the
        // parent's result so context flows up the tree on each layer.
        const aggregated = aggregateChildOutputs(allocator, rows, r.id) catch "";
        if (aggregated.len > 0) {
            evidencePrint("  result: FIRE — neuron integrated {d} bytes of child evidence\n", .{aggregated.len});
            return .{ .rc = 0, .result = aggregated };
        }
        evidence("  result: FIRE — neuron integrated all child evidence\n");
        return .{ .rc = 0, .result = "fire" };
    }

    if (std.mem.eql(u8, ptype, "funnel") or std.mem.eql(u8, ptype, "sequence")) {
        const ids = try childIds(allocator, rows, r.id);
        defer allocator.free(ids);
        if (ids.len == 0) {
            evidence("  result: FAIL — no children declared\n");
            return .{ .rc = 1, .result = "fail" };
        }
        for (ids) |cid| {
            if (!isSatisfied(rows, cid)) {
                evidencePrint("  result: FAIL — current stage: {s} (pending)\n", .{cid});
                return .{ .rc = 1, .result = "fail" };
            }
        }
        evidence("  result: PASS — every stage satisfied, in order\n");
        return .{ .rc = 0, .result = "pass" };
    }

    if (std.mem.eql(u8, ptype, "funnel-first")) {
        const ids = try childIds(allocator, rows, r.id);
        defer allocator.free(ids);
        if (ids.len == 0) {
            evidence("  result: FAIL — no children declared\n");
            return .{ .rc = 1, .result = "fail" };
        }
        for (ids) |cid| {
            if (isSatisfied(rows, cid)) {
                evidencePrint("  result: PASS — child satisfied: {s}\n", .{cid});
                return .{ .rc = 0, .result = "pass" };
            }
        }
        evidence("  result: FAIL — no child satisfied\n");
        return .{ .rc = 1, .result = "fail" };
    }

    if (std.mem.eql(u8, ptype, "quorum")) {
        const k_txt = action["quorum:".len..];
        const need = std.fmt.parseInt(usize, k_txt, 10) catch 1;
        const ids = try childIds(allocator, rows, r.id);
        defer allocator.free(ids);
        if (ids.len == 0) {
            evidence("  result: FAIL — no children declared\n");
            return .{ .rc = 1, .result = "fail" };
        }
        var got: usize = 0;
        for (ids) |cid| {
            if (isSatisfied(rows, cid)) got += 1;
        }
        if (got >= need) {
            evidencePrint("  result: PASS — quorum {d}/{d}\n", .{ got, need });
            return .{ .rc = 0, .result = "pass" };
        }
        evidencePrint("  result: FAIL — quorum {d}/{d}\n", .{ got, need });
        return .{ .rc = 1, .result = "fail" };
    }

    if (std.mem.eql(u8, ptype, "contract-ref")) {
        const ref = action["contract:".len..];
        const target = if (ref.len >= 8) ref[0..8] else ref;
        if (isSatisfied(rows, target)) {
            evidencePrint("  result: PASS — contract:{s} satisfied\n", .{target});
            return .{ .rc = 0, .result = "pass" };
        }
        evidencePrint("  result: FAIL — contract:{s} not satisfied\n", .{target});
        return .{ .rc = 1, .result = "fail" };
    }

    var body = action;
    if (std.mem.startsWith(u8, action, "loop-until:")) body = action["loop-until:".len..];
    if (std.mem.startsWith(u8, action, "harness:")) {
        const hdir = action["harness:".len..];
        body = try std.fmt.allocPrint(allocator, "\"{s}/verify.sh\"", .{hdir});
    }
    // Capture stdout+stderr so the parent layer sees child context, not
    // just an exit code. This is the recursive context-aggregation channel.
    // Drill A — shell strict gate: refuse meta-shell when CONTRACT_SHELL_STRICT=1.
    // Policy comes from the action's environment; rejection is HOLD with a
    // named cause, never silent execution.
    if (shellStrictReject(body, env)) |cause| {
        evidencePrint("  result: HOLD — {s}\n", .{cause});
        return .{ .rc = 1, .result = try allocator.dupe(u8, cause) };
    }
    const out_capture = try runShellCapture(allocator, body, r.cwd);
    if (out_capture.rc == 0) {
        evidence("  result: PASS (exit 0)\n");
        if (out_capture.output.len > 0) return .{ .rc = 0, .result = out_capture.output };
        return .{ .rc = 0, .result = "pass" };
    }
    evidencePrint("  result: FAIL (exit {d})\n", .{out_capture.rc});
    if (out_capture.output.len > 0) return .{ .rc = out_capture.rc, .result = out_capture.output };
    return .{ .rc = out_capture.rc, .result = "fail" };
}

const DeclareArgs = struct { plan: []const u8 };

fn parseDeclare(args: []const []const u8) !DeclareArgs {
    if (args.len == 0) return error.MissingPlan;
    if (args.len != 1) return error.UnknownFlag;
    return .{ .plan = args[0] };
}

const AikoMode = enum {
    /// Default — resolved at call time from environment. Speak the truth and
    /// let the substrate choose the dimension. Becomes .remote if any of
    /// `UNBROWSE_BASE` / `AIKO_X_PAYMENT` / `X_PAYMENT` / `AIKO_REMOTE` is set
    /// in the env; else .genesis.
    auto,
    remote,
    local,
    /// 9-day Fib-shaped walk over the ledger. Each invocation projects current
    /// day from the ledger (no local state), advances if previous day's
    /// Fibonacci workers all satisfied, spawns next day's children.
    genesis,
};

const AikoArgs = struct {
    plan: []u8,
    mode: AikoMode,
    /// Optional caller-supplied user context aiko id (8-hex contract id).
    /// When set, the remote LLM body carries `user_context_id` so the Word's
    /// compiler can bind translation against the user's own aiko — read their
    /// satisfied claims, preferred audience level, and prior context to shape
    /// output empathically. Stays null in pure local mode.
    user_context_id: ?[]const u8 = null,
};

fn parseAikoArgs(allocator: std.mem.Allocator, args: []const []const u8) !AikoArgs {
    if (args.len == 0) return error.MissingPlan;
    var mode: ?AikoMode = null;
    var user_context_id: ?[]const u8 = null;
    var parts: std.ArrayList([]const u8) = .empty;
    defer parts.deinit(allocator);
    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        const arg = args[i];
        if (std.mem.eql(u8, arg, "--remote")) {
            if (mode != null) return error.DuplicateMode;
            mode = .remote;
        } else if (std.mem.eql(u8, arg, "--local")) {
            if (mode != null) return error.DuplicateMode;
            mode = .local;
        } else if (std.mem.eql(u8, arg, "--genesis")) {
            if (mode != null) return error.DuplicateMode;
            mode = .genesis;
        } else if (std.mem.eql(u8, arg, "--user")) {
            if (i + 1 >= args.len) return error.MissingUserArg;
            user_context_id = args[i + 1];
            i += 1;
        } else if (std.mem.startsWith(u8, arg, "--user=")) {
            user_context_id = arg["--user=".len..];
        } else if (std.mem.startsWith(u8, arg, "--")) {
            return error.UnknownFlag;
        } else {
            try parts.append(allocator, arg);
        }
    }
    if (parts.items.len == 0) return error.MissingPlan;
    const plan = try std.mem.join(allocator, " ", parts.items);
    // Mode is optional. Default is .auto — the substrate resolves the
    // dimension at call time from environment, so the public form collapses
    // to `aiko "<truth>"`.
    return .{
        .plan = plan,
        .mode = mode orelse .auto,
        .user_context_id = user_context_id,
    };
}

/// Resolve `.auto` against the environment. The Word doesn't choose its
/// dimension; the dimension is given by where it is being spoken into.
fn resolveAutoMode(env: std.process.Environ) AikoMode {
    if (env.getPosix("UNBROWSE_BASE")) |v| if (v.len > 0) return .remote;
    if (env.getPosix("AIKO_X_PAYMENT")) |v| if (v.len > 0) return .remote;
    if (env.getPosix("X_PAYMENT")) |v| if (v.len > 0) return .remote;
    if (env.getPosix("AIKO_REMOTE")) |v| {
        if (v.len > 0 and !std.mem.eql(u8, v, "0") and !std.mem.eql(u8, v, "false")) return .remote;
    }
    return .genesis;
}

fn isPathToken(tok: []const u8) bool {
    return std.mem.startsWith(u8, tok, "/Users/") or
        std.mem.startsWith(u8, tok, "/home/") or
        std.mem.startsWith(u8, tok, "~/");
}

fn isEmailToken(tok: []const u8) bool {
    const at = std.mem.indexOfScalar(u8, tok, '@') orelse return false;
    if (at == 0 or at + 1 >= tok.len) return false;
    return std.mem.indexOfScalar(u8, tok[at + 1 ..], '.') != null;
}

fn isSecretLikeToken(tok: []const u8) bool {
    if (tok.len < 32) return false;
    var alnum: usize = 0;
    var symbol: usize = 0;
    for (tok) |c| {
        if (std.ascii.isAlphanumeric(c)) {
            alnum += 1;
        } else if (c == '_' or c == '-' or c == '.' or c == ':' or c == '/' or c == '+' or c == '=') {
            symbol += 1;
        } else {
            return false;
        }
    }
    return alnum >= 24 and symbol > 0;
}

fn appendSanitizedToken(out_buf: *std.ArrayList(u8), allocator: std.mem.Allocator, tok: []const u8) !void {
    if (isPathToken(tok)) {
        try out_buf.appendSlice(allocator, "[local-path-pattern]");
    } else if (isEmailToken(tok)) {
        try out_buf.appendSlice(allocator, "[email-pattern]");
    } else if (isSecretLikeToken(tok)) {
        try out_buf.appendSlice(allocator, "[secret-pointer-pattern]");
    } else {
        try out_buf.appendSlice(allocator, tok);
    }
}

fn redactAikoPlan(allocator: std.mem.Allocator, plan: []const u8) ![]u8 {
    var buf: std.ArrayList(u8) = .empty;
    errdefer buf.deinit(allocator);
    var start: usize = 0;
    var i: usize = 0;
    while (i < plan.len) : (i += 1) {
        const c = plan[i];
        if (std.ascii.isWhitespace(c)) {
            if (start < i) try appendSanitizedToken(&buf, allocator, plan[start..i]);
            try buf.append(allocator, c);
            start = i + 1;
        }
    }
    if (start < plan.len) try appendSanitizedToken(&buf, allocator, plan[start..]);
    return buf.toOwnedSlice(allocator);
}

fn ambientParent(env: std.process.Environ) ?[]const u8 {
    if (env.getPosix("CONTRACT_PARENT_ID")) |v| {
        if (v.len > 0) return v;
    }
    if (env.getPosix("CONTRACT_PARENT")) |v| {
        if (v.len > 0) return v;
    }
    return null;
}

fn ambientAction(env: std.process.Environ) []const u8 {
    if (env.getPosix("CONTRACT_NEURON_ACTION")) |v| {
        if (v.len > 0) return v;
    }
    if (env.getPosix("CONTRACT_INTERNAL_ACTION")) |v| {
        if (v.len > 0) return v;
    }
    return "neuron";
}

fn ambientAdapter(env: std.process.Environ) ?[]const u8 {
    if (env.getPosix("CONTRACT_ADAPTER_ID")) |v| {
        if (v.len > 0) return v;
    }
    if (env.getPosix("CONTRACT_ADAPTER")) |v| {
        if (v.len > 0) return v;
    }
    return null;
}

fn ambientAdapterKind(env: std.process.Environ) ?[]const u8 {
    if (env.getPosix("CONTRACT_ADAPTER_KIND")) |v| {
        if (v.len > 0) return v;
    }
    if (env.getPosix("CONTRACT_ENVIRONMENT_KIND")) |v| {
        if (v.len > 0) return v;
    }
    return null;
}

fn ambientEventBus(env: std.process.Environ) ?[]const u8 {
    if (env.getPosix("CONTRACT_EVENT_BUS_ID")) |v| {
        if (v.len > 0) return v;
    }
    if (env.getPosix("CONTRACT_EVENT_BUS")) |v| {
        if (v.len > 0) return v;
    }
    return null;
}

fn ambientPretoolEvent(env: std.process.Environ) ?[]const u8 {
    if (env.getPosix("CONTRACT_PRETOOL_EVENT_ID")) |v| {
        if (v.len > 0) return v;
    }
    if (env.getPosix("CONTRACT_PRETOOL_EVENT")) |v| {
        if (v.len > 0) return v;
    }
    return null;
}

fn ambientEventKind(env: std.process.Environ) ?[]const u8 {
    if (env.getPosix("CONTRACT_EVENT_KIND")) |v| {
        if (v.len > 0) return v;
    }
    if (env.getPosix("CONTRACT_PRETOOL_KIND")) |v| {
        if (v.len > 0) return v;
    }
    return null;
}

fn enqueueOwned(allocator: std.mem.Allocator, queue: *std.ArrayList([]u8), id: []const u8) !void {
    for (queue.items) |existing| {
        if (std.mem.eql(u8, existing, id)) return;
    }
    const copy = try allocator.dupe(u8, id);
    errdefer allocator.free(copy);
    try queue.append(allocator, copy);
}

fn resolveOne(allocator: std.mem.Allocator, env: std.process.Environ, id: []const u8) !u8 {
    const rows = try parseRows(allocator, env);
    defer allocator.free(rows);
    if (isSatisfied(rows, id)) {
        evidencePrint("{s} already resolved\n", .{id});
        return 0;
    }
    const r = latestDeclared(rows, id) orelse {
        errPrint("contract not found: {s}\n", .{id});
        return 1;
    };
    const wave = latestWave(rows, id) + 1;
    const rr = try runAction(allocator, env, rows, r);
    try contract.recordIteration(allocator, env, id, wave, rr.rc, rr.result);
    if (rr.rc != 0) return 1;
    try contract.markSatisfied(allocator, env, id, wave, "native resolver reached mechanical true");
    evidencePrint("{s} -> resolved\n", .{id});
    return 0;
}

fn enqueueAffected(allocator: std.mem.Allocator, rows: []const Row, queue: *std.ArrayList([]u8), id: []const u8) !void {
    if (latestDeclared(rows, id)) |r| {
        if (r.parent_id) |parent| {
            try enqueueOwned(allocator, queue, parent);
        }
    }
    const children = try childIds(allocator, rows, id);
    defer allocator.free(children);
    for (children) |child| try enqueueOwned(allocator, queue, child);

    const dependents = try dependentIds(allocator, rows, id);
    defer allocator.free(dependents);
    for (dependents) |dep| {
        if (std.mem.eql(u8, dep, id)) continue;
        try enqueueOwned(allocator, queue, dep);
    }
}

fn resolveLineage(allocator: std.mem.Allocator, env: std.process.Environ, id: []const u8) !u8 {
    // Fixed-point loop: keep walking the affected-lineage queue until a full
    // pass yields zero new satisfies (the DAG settled) or budget exhausts.
    // The declared id is re-attempted on each pass so a parent that HOLDs
    // because of pending children fires once those children later resolve.
    var max_passes: u32 = 8;
    if (env.getPosix("CONTRACT_RESOLVE_PASSES")) |s| {
        max_passes = std.fmt.parseInt(u32, s, 10) catch 8;
        if (max_passes == 0) max_passes = 1;
        if (max_passes > 64) max_passes = 64;
    }
    var declared_rc: u8 = 1;
    var pass: u32 = 0;
    while (pass < max_passes) : (pass += 1) {
        var progressed = false;
        const rc_root = try resolveOne(allocator, env, id);
        if (pass == 0) declared_rc = rc_root;
        if (rc_root == 0 and declared_rc != 0) {
            declared_rc = 0;
            progressed = true;
        }

        var queue: std.ArrayList([]u8) = .empty;
        defer {
            for (queue.items) |item| allocator.free(item);
            queue.deinit(allocator);
        }
        {
            const rows = try parseRows(allocator, env);
            defer allocator.free(rows);
            try enqueueAffected(allocator, rows, &queue, id);
        }
        var index: usize = 0;
        while (index < queue.items.len and index < 256) : (index += 1) {
            const current = queue.items[index];
            const before = blk: {
                const rows = try parseRows(allocator, env);
                defer allocator.free(rows);
                break :blk isSatisfied(rows, current);
            };
            const rc = try resolveOne(allocator, env, current);
            if (rc == 0) {
                if (!before) progressed = true;
                const rows = try parseRows(allocator, env);
                defer allocator.free(rows);
                try enqueueAffected(allocator, rows, &queue, current);
            }
        }
        if (!progressed) break; // DAG settled.
    }
    if (declared_rc == 0) {
        evidencePrint("lineage: settled after {d} pass(es)\n", .{pass + 1});
    }
    return declared_rc;
}

/// Walk the entire ledger and attempt to resolve every contract that is
/// neither satisfied nor dead. Mechanical, deterministic, idempotent: a row
/// that resolves stays resolved; a row that fails stays pending. Budget is
/// controlled by CONTRACT_BACKFILL_BUDGET (default 64, max 1024). Skip the
/// id passed in `skip_id` (the one we just declared, already resolved).
///
/// This is the in-binary realisation of contract:3600ca96 + contract:410bceea:
/// every declaration sweeps the un-backfilled tail so accumulated learnings
/// catch up to the live frontier without a separate script.
fn backfillUnresolved(allocator: std.mem.Allocator, env: std.process.Environ, skip_id: []const u8) !void {
    var budget: u32 = 64;
    if (env.getPosix("CONTRACT_BACKFILL_BUDGET")) |s| {
        budget = std.fmt.parseInt(u32, s, 10) catch 64;
        if (budget > 1024) budget = 1024;
        if (budget == 0) return;
    }
    if (env.getPosix("CONTRACT_BACKFILL")) |flag| {
        if (std.mem.eql(u8, flag, "0") or std.mem.eql(u8, flag, "off")) return;
    }
    var max_passes: u32 = 8;
    if (env.getPosix("CONTRACT_BACKFILL_PASSES")) |s| {
        max_passes = std.fmt.parseInt(u32, s, 10) catch 8;
        if (max_passes == 0) max_passes = 1;
        if (max_passes > 64) max_passes = 64;
    }
    // Fixed-point loop: keep sweeping until a full pass yields zero new
    // satisfies (whole ledger settled) or budget exhausts. Each pass takes
    // the newest-first slice of still-unresolved rows.
    var pass: u32 = 0;
    while (pass < max_passes) : (pass += 1) {
        const rows = try parseRows(allocator, env);
        defer allocator.free(rows);
        var seen: std.StringHashMap(void) = .init(allocator);
        defer seen.deinit();
        var candidates: std.ArrayList([]const u8) = .empty;
        defer candidates.deinit(allocator);
        var i: usize = rows.len;
        while (i > 0) : (i -= 1) {
            const r = rows[i - 1];
            if (std.mem.eql(u8, r.id, skip_id)) continue;
            if (seen.contains(r.id)) continue;
            try seen.put(r.id, {});
            if (isSatisfied(rows, r.id)) continue;
            if (isDead(rows, r.id)) continue;
            try candidates.append(allocator, r.id);
            if (candidates.items.len >= budget) break;
        }
        if (candidates.items.len == 0) {
            if (pass > 0) evidencePrint("backfill: ledger settled after {d} pass(es)\n", .{pass});
            return;
        }
        evidencePrint("backfill pass {d}: {d} unresolved row(s) within budget {d}\n", .{ pass + 1, candidates.items.len, budget });
        var progressed = false;
        for (candidates.items) |cid| {
            const rc = resolveOne(allocator, env, cid) catch continue;
            if (rc == 0) progressed = true;
        }
        if (!progressed) {
            evidencePrint("backfill: no progress on pass {d} — frontier stuck\n", .{pass + 1});
            return;
        }
    }
    evidencePrint("backfill: passes exhausted at {d}\n", .{max_passes});
}

fn cmdDeclare(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    const d = parseDeclare(args) catch |e| {
        errPrint("declare argument error: {s}\n", .{@errorName(e)});
        return 2;
    };
    // Drills B + C — preflight: wallet permission and binary self-attest.
    // Both fail-closed only when their strict env flag is set; otherwise emit
    // a WARN evidence line so the caller sees the gap without breaking flow.
    if (walletPermissionReject(allocator, env)) |cause| {
        errPrint("declare refused: {s}\n", .{cause});
        return 2;
    }
    if (binaryAttestReject(allocator, env)) |cause| {
        errPrint("declare refused: {s}\n", .{cause});
        return 2;
    }
    if (!client.isRemoteMode(env)) {
        if (hookId(env, "CONTRACT_PREHOOK_ID", "CONTRACT_PREHOOK")) |prehook| {
            const pre_rc = try resolveOne(allocator, env, prehook);
            if (pre_rc != 0) return pre_rc;
        }
    }
    const action = ambientAction(env);
    const parent = ambientParent(env);
    const adapter = ambientAdapter(env);
    const adapter_kind = ambientAdapterKind(env);
    const event_bus = ambientEventBus(env);
    const pretool_event = ambientPretoolEvent(env);
    const event_kind = ambientEventKind(env);
    if (AIKO_DECLARE_ONLY) {
        const safe_plan = redactAikoPlan(allocator, d.plan) catch |e| {
            errPrint("aiko privacy guard failed: {s}\n", .{@errorName(e)});
            return 2;
        };
        defer allocator.free(safe_plan);
        const body = client.declareRemoteAiko(allocator, env, safe_plan, action, parent, adapter, adapter_kind, event_bus, pretool_event, event_kind, null, null) catch |e| {
            errPrint("aiko declare failed against Unbrowse: {s}\n", .{@errorName(e)});
            return 2;
        };
        defer allocator.free(body);
        const id = jsonString(body, "id") orelse {
            err("remote declare response missing id\n");
            return 2;
        };
        outPrint("{s}\n", .{id});
        backfillUnresolved(allocator, env, id) catch |e| {
            errPrint("backfill skipped: {s}\n", .{@errorName(e)});
        };
        return 0;
    }
    if (client.isRemoteMode(env)) {
        const body = client.declareRemote(allocator, env, d.plan, action, parent, adapter, adapter_kind, event_bus, pretool_event, event_kind, null) catch |e| {
            errPrint("remote declare failed: {s}\n", .{@errorName(e)});
            return 2;
        };
        defer allocator.free(body);
        const id = jsonString(body, "id") orelse {
            err("remote declare response missing id\n");
            return 2;
        };
        outPrint("{s}\n", .{id});
        backfillUnresolved(allocator, env, id) catch |e| {
            errPrint("backfill skipped: {s}\n", .{@errorName(e)});
        };
        return 0;
    }
    const cid = try contract.declare(allocator, env, d.plan, action, .{ .parent_id = parent });
    defer allocator.free(cid);
    outPrint("{s}\n", .{cid});
    const rc = try resolveLineage(allocator, env, cid);
    if (rc == 0) {
        if (hookId(env, "CONTRACT_POSTHOOK_ID", "CONTRACT_POSTHOOK")) |posthook| {
            const rows2 = try parseRows(allocator, env);
            defer allocator.free(rows2);
            if (isLocalContract(rows2, posthook)) {
                if (latestActionResult(rows2, cid)) |payload| {
                    const payload_z = try allocator.dupeZ(u8, payload[0..@min(payload.len, 32 * 1024)]);
                    defer allocator.free(payload_z);
                    const cid_z = try allocator.dupeZ(u8, cid);
                    defer allocator.free(cid_z);
                    _ = setenv("CONTRACT_PARENT_RESULT", payload_z.ptr, 1);
                    _ = setenv("CONTRACT_PARENT_ID", cid_z.ptr, 1);
                    const tree = buildAncestorTree(allocator, rows2, cid) catch "";
                    defer if (tree.len > 0) allocator.free(tree);
                    if (tree.len > 0) {
                        const tree_z = try allocator.dupeZ(u8, tree[0..@min(tree.len, 64 * 1024)]);
                        defer allocator.free(tree_z);
                        _ = setenv("CONTRACT_PARENT_RESULT_TREE", tree_z.ptr, 1);
                    }
                    evidencePrint("posthook payload propagated: parent={s} len={d} tree_bytes={d}\n", .{ cid, payload.len, tree.len });
                }
                _ = try resolveLineage(allocator, env, posthook);
                _ = unsetenv("CONTRACT_PARENT_RESULT");
                _ = unsetenv("CONTRACT_PARENT_ID");
                _ = unsetenv("CONTRACT_PARENT_RESULT_TREE");
            } else {
                // Remote posthook: route via lineage-mesh encrypted envelope.
                const tree = buildAncestorTree(allocator, rows2, cid) catch try allocator.dupe(u8, "[]");
                defer allocator.free(tree);
                meshEmitRemoteHook(allocator, env, cid, posthook, tree) catch |e| {
                    errPrint("mesh hook skipped: {s}\n", .{@errorName(e)});
                };
            }
        }
    }
    // Backfill: every declare sweeps the un-resolved tail of the ledger.
    backfillUnresolved(allocator, env, cid) catch |e| {
        errPrint("backfill skipped: {s}\n", .{@errorName(e)});
    };
    return if (rc == 0) 0 else 1;
}

/// The nine days of creation, Fibonacci-scaled. Hardcoded so the substrate has
/// no JSON dependency at runtime and the rubric is part of the binary. Fib
/// pattern 1·1·2·3·5·8 across the six creation days, single-thread sabbath
/// verdict, 13 cold auditors for the books, single emergence — Genesis 1–2 +
/// Revelation 20:12 + 21:1.
const GenesisDay = struct {
    n: u8,
    fib: u8,
    name: []const u8,
    ref: []const u8,
    label: []const u8,
};

const days_table = [_]GenesisDay{
    .{ .n = 1, .fib = 1, .name = "light", .ref = "Gen 1:3", .label = "inventory — what exists" },
    .{ .n = 2, .fib = 1, .name = "firmament", .ref = "Gen 1:6", .label = "separate — what divides" },
    .{ .n = 3, .fib = 2, .name = "land", .ref = "Gen 1:11", .label = "seed — what produces" },
    .{ .n = 4, .fib = 3, .name = "luminaries", .ref = "Gen 1:14", .label = "test — what signals" },
    .{ .n = 5, .fib = 5, .name = "creatures", .ref = "Gen 1:20", .label = "run — what moves" },
    .{ .n = 6, .fib = 8, .name = "dominion", .ref = "Gen 1:26", .label = "integrate — what rules" },
    .{ .n = 7, .fib = 1, .name = "sabbath", .ref = "Gen 2:2", .label = "verdict — PROMOTE/HOLD/REJECT" },
    .{ .n = 8, .fib = 13, .name = "books", .ref = "Rev 20:12", .label = "audit — cold re-read of artifact" },
    .{ .n = 9, .fib = 1, .name = "emergence", .ref = "Rev 21:1", .label = "publish — make all things new" },
};

/// Find the latest unsatisfied root contract whose plan exactly matches `plan`.
/// Last-writer wins by ledger order (chronological).
fn findSessionByPlan(rows: []const Row, plan: []const u8) ?[]const u8 {
    var latest: ?[]const u8 = null;
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        if (r.parent_id) |p| {
            if (p.len > 0) continue; // skip non-roots
        }
        if (!std.mem.eql(u8, r.plan, plan)) continue;
        if (isSatisfied(rows, r.id)) continue;
        latest = r.id;
    }
    return latest;
}

/// Project current day from the ledger: max N across child plans that start
/// with `jl-day N`. 0 = pre-Day-1 (session created, no day spawned yet).
fn currentDay(rows: []const Row, session_id: []const u8) u8 {
    var max: u8 = 0;
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        const p = r.parent_id orelse continue;
        if (!std.mem.eql(u8, p, session_id)) continue;
        if (!std.mem.startsWith(u8, r.plan, "jl-day ")) continue;
        const after = r.plan[7..];
        var i: usize = 0;
        while (i < after.len and std.ascii.isDigit(after[i])) : (i += 1) {}
        if (i == 0) continue;
        const n = std.fmt.parseInt(u8, after[0..i], 10) catch continue;
        if (n > max) max = n;
    }
    return max;
}

/// Count {spawned, satisfied} children of `session_id` whose plan starts with
/// `jl-day <day> `. Used to gate day advancement: a day completes only when
/// every Fib worker is satisfied.
const DayCount = struct { spawned: u8, satisfied: u8 };
fn countDayChildren(rows: []const Row, session_id: []const u8, day: u8) DayCount {
    var prefix_buf: [32]u8 = undefined;
    const prefix = std.fmt.bufPrint(&prefix_buf, "jl-day {d} ", .{day}) catch return .{ .spawned = 0, .satisfied = 0 };
    var dc = DayCount{ .spawned = 0, .satisfied = 0 };
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        const p = r.parent_id orelse continue;
        if (!std.mem.eql(u8, p, session_id)) continue;
        if (!std.mem.startsWith(u8, r.plan, prefix)) continue;
        dc.spawned += 1;
        if (isSatisfied(rows, r.id)) dc.satisfied += 1;
    }
    return dc;
}

/// cmdGenesis — stateless 9-day projection walker.
///
/// Each invocation reads the ledger, computes the session's current day, and
/// either (a) spawns the next day's Fib(N) workers and exits, or (b) reports
/// HOLD with the count of unsatisfied workers from the prior day.
///
/// State is the ledger; no local file is created. Re-running `aiko "<truth>"
/// --genesis` with the same plan resumes the same session.
fn cmdGenesis(allocator: std.mem.Allocator, env: std.process.Environ, plan: []const u8) !u8 {
    const rows = try parseRows(allocator, env);
    defer allocator.free(rows);

    // Project session id (find latest unsatisfied root with matching plan, else create).
    var owned_sid: ?[]u8 = null;
    defer if (owned_sid) |s| allocator.free(s);
    const session_id: []const u8 = blk: {
        if (findSessionByPlan(rows, plan)) |existing| break :blk existing;
        const new_id = try contract.declare(allocator, env, plan, "neuron", .{ .parent_id = ambientParent(env) });
        owned_sid = new_id;
        outPrint("session opened: {s}\n", .{new_id});
        break :blk new_id;
    };

    // Re-read rows if we just declared (so currentDay sees the new root).
    // Cheap: parseRows is a single file slurp.
    const rows2 = if (owned_sid == null) rows else try parseRows(allocator, env);
    defer if (owned_sid != null) allocator.free(rows2);

    const cur = currentDay(rows2, session_id);

    if (cur >= 9) {
        outPrint("session {s}: day 9 emerged — all things made new\n", .{session_id});
        return 0;
    }

    // Gate: previous day's Fib workers must all be satisfied before advancing.
    if (cur > 0) {
        const day_prev = days_table[cur - 1];
        const dc = countDayChildren(rows2, session_id, cur);
        if (dc.satisfied < day_prev.fib) {
            outPrint(
                "session {s}: day {d} ({s}) HOLD — {d}/{d} workers satisfied\n" ++
                    "  satisfy the remaining workers (`contract _mark <id> satisfied`) then re-fire\n",
                .{ session_id, cur, day_prev.name, dc.satisfied, day_prev.fib },
            );
            return 1;
        }
    }

    // Advance: spawn next day's Fib workers.
    const day = days_table[cur];
    outPrint(
        "session {s}: day {d} ({s}) — {s}\n  {s}\n  spawning {d} worker{s}:\n",
        .{ session_id, day.n, day.name, day.ref, day.label, day.fib, if (day.fib == 1) "" else "s" },
    );

    var i: u8 = 0;
    while (i < day.fib) : (i += 1) {
        const child_plan = try std.fmt.allocPrint(
            allocator,
            "jl-day {d} ({s}) worker {d}/{d}: {s} — bind:{s}",
            .{ day.n, day.name, i + 1, day.fib, day.label, session_id },
        );
        defer allocator.free(child_plan);
        const child_id = try contract.declare(allocator, env, child_plan, "neuron", .{ .parent_id = session_id });
        defer allocator.free(child_id);
        outPrint("    {s}\n", .{child_id});
    }
    return 0;
}

/// cmdSpeak — the single Word.
///
/// The binary invocation IS the verb. Speaking a truth claim deterministically
/// walks seven phases (Genesis 1–2: God speaks → the Word becomes flesh → the
/// substrate rests). No phase is optional; no caller chooses a phase. Each
/// phase is idempotent against the append-only ledger.
///
///   Day 1  Word      — `declared` row appended (the speech is the act).
///   Day 2  Firmament — `child_added` per parent_id (containment edge).
///   Day 3  Earth     — synapse dispatch by kind (cross-dimension edges).
///   Day 4  Lights    — gate on `blocked_by` / `inhibits` / external metrics.
///   Day 5  Life      — corroborate child evidence per `aggregation`.
///   Day 6  Image     — `satisfied` row appended iff Days 4-5 ratified.
///   Day 7  Sabbath   — `called` rows per `posthook:` synapse — the word
///                      propagates and the wavefront seals.
///
/// Days 1-3 always fire. Days 4-7 are conditional on truth holding. A held day
/// returns exit 1; the row stays pending until a future speech ratifies it.
fn cmdSpeak(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    const parsed = parseAikoArgs(allocator, args) catch |e| {
        errPrint("aiko argument error: {s}\n", .{@errorName(e)});
        usage();
        return 2;
    };
    defer allocator.free(parsed.plan);
    const safe_plan = redactAikoPlan(allocator, parsed.plan) catch |e| {
        errPrint("aiko privacy guard failed: {s}\n", .{@errorName(e)});
        return 2;
    };
    defer allocator.free(safe_plan);

    // Drills B + C — preflight: wallet permission and binary self-attest.
    if (walletPermissionReject(allocator, env)) |cause| {
        errPrint("aiko refused: {s}\n", .{cause});
        return 2;
    }
    if (binaryAttestReject(allocator, env)) |cause| {
        errPrint("aiko refused: {s}\n", .{cause});
        return 2;
    }

    const action = ambientAction(env);
    const parent = ambientParent(env);
    const adapter = ambientAdapter(env);
    const adapter_kind = ambientAdapterKind(env);
    const event_bus = ambientEventBus(env);
    const pretool_event = ambientPretoolEvent(env);
    const event_kind = ambientEventKind(env);

    const effective_mode: AikoMode = switch (parsed.mode) {
        .auto => resolveAutoMode(env),
        else => parsed.mode,
    };

    switch (effective_mode) {
        .auto => unreachable, // resolved above
        .genesis => {
            // Stateless 9-day Fib walker — projects state from the ledger,
            // spawns next day's workers, exits. Re-fire to advance.
            return try cmdGenesis(allocator, env, safe_plan);
        },
        .remote => {
            // Remote target: Unbrowse compiles all seven days server-side.
            // GATE — only signed/attested binaries may invoke the LLM compiler.
            if (!assertBinaryIntegrityForLlm(allocator, env)) return 2;
            const body = client.declareRemoteAiko(allocator, env, safe_plan, action, parent, adapter, adapter_kind, event_bus, pretool_event, event_kind, null, parsed.user_context_id) catch |e| {
                errPrint("aiko remote failed against Unbrowse: {s}\n", .{@errorName(e)});
                return 2;
            };
            defer allocator.free(body);
            const id = jsonString(body, "id") orelse {
                err("remote declare response missing id\n");
                return 2;
            };
            outPrint("{s}\n", .{id});
            backfillUnresolved(allocator, env, id) catch |e| {
                errPrint("backfill skipped: {s}\n", .{@errorName(e)});
            };
            return 0;
        },
        .local => {
            // Optional prehook from env (legacy single-hook surface; the graph
            // form of prehook lives in `synapses[].kind=prehook`).
            if (hookId(env, "CONTRACT_PREHOOK_ID", "CONTRACT_PREHOOK")) |prehook| {
                const pre_rc = try resolveOne(allocator, env, prehook);
                if (pre_rc != 0) return pre_rc;
            }

            // Day 1 — Word. The speech becomes a row.
            const cid = try contract.declare(allocator, env, safe_plan, action, .{ .parent_id = parent });
            defer allocator.free(cid);
            outPrint("{s}\n", .{cid});

            // Days 2-6 — Firmament, Earth, Lights, Life, Image. The resolver
            // walks the lineage: child_added edges are already written by
            // declare; the resolver iterates, judges per evidence rules, and
            // markSatisfied fires when truth holds.
            const rc = try resolveLineage(allocator, env, cid);

            // Day 7 — Sabbath. The word propagates: for each posthook synapse
            // on the just-spoken row, append a typed `called` row recording
            // the dispatch. Graph-bound; replaces the env-var single posthook
            // shape (which stays as legacy compat for one more release).
            if (rc == 0) {
                const rows = try parseRows(allocator, env);
                defer allocator.free(rows);
                for (rows) |r| {
                    if (!std.mem.eql(u8, r.event, "declared")) continue;
                    if (!std.mem.eql(u8, r.id, cid)) continue;
                    const targets = try pointer.extractTypedRefs(allocator, r.plan, "posthook:");
                    defer {
                        for (targets) |t| allocator.free(t);
                        allocator.free(targets);
                    }
                    for (targets) |target| {
                        var ptr_buf: [32]u8 = undefined;
                        const target_pointer = try std.fmt.bufPrint(&ptr_buf, "contract:{s}", .{target});
                        try contract.appendCalledRow(allocator, env, cid, target_pointer, "posthook");
                        outPrint("called: posthook -> {s}\n", .{target});
                    }
                    break;
                }

                // Legacy single-env-var posthook (deprecated; graph form above wins).
                if (hookId(env, "CONTRACT_POSTHOOK_ID", "CONTRACT_POSTHOOK")) |posthook| {
                    // Propagate aggregated parent context up the tree: the
                    // posthook body can read CONTRACT_PARENT_RESULT.
                    const rows2 = try parseRows(allocator, env);
                    defer allocator.free(rows2);
                    if (latestActionResult(rows2, cid)) |payload| {
                        const payload_z = try allocator.dupeZ(u8, payload[0..@min(payload.len, 32 * 1024)]);
                        defer allocator.free(payload_z);
                        const cid_z = try allocator.dupeZ(u8, cid);
                        defer allocator.free(cid_z);
                        _ = setenv("CONTRACT_PARENT_RESULT", payload_z.ptr, 1);
                        _ = setenv("CONTRACT_PARENT_ID", cid_z.ptr, 1);
                        const tree = buildAncestorTree(allocator, rows2, cid) catch "";
                        defer if (tree.len > 0) allocator.free(tree);
                        if (tree.len > 0) {
                            const tree_z = try allocator.dupeZ(u8, tree[0..@min(tree.len, 64 * 1024)]);
                            defer allocator.free(tree_z);
                            _ = setenv("CONTRACT_PARENT_RESULT_TREE", tree_z.ptr, 1);
                        }
                        evidencePrint("posthook payload propagated: parent={s} len={d} tree_bytes={d}\n", .{ cid, payload.len, tree.len });
                    } else {
                        evidencePrint("posthook payload: no action_result found for parent {s}\n", .{cid});
                    }
                    _ = try resolveLineage(allocator, env, posthook);
                    _ = unsetenv("CONTRACT_PARENT_RESULT");
                    _ = unsetenv("CONTRACT_PARENT_ID");
                    _ = unsetenv("CONTRACT_PARENT_RESULT_TREE");
                }
            }
            // Backfill: sweep un-resolved tail every time the Word is spoken locally.
            backfillUnresolved(allocator, env, cid) catch |e| {
                errPrint("backfill skipped: {s}\n", .{@errorName(e)});
            };
            return if (rc == 0) 0 else 1;
        },
    }
}

/// Backward-compat alias. `aiko ...` and `contract <claim>` both route here.
const cmdAikoGoal = cmdSpeak;

fn cmdList(allocator: std.mem.Allocator, env: std.process.Environ) !u8 {
    const rows = try parseRows(allocator, env);
    defer allocator.free(rows);
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        const status: []const u8 = if (isSatisfied(rows, r.id))
            "satisfied"
        else if (isDead(rows, r.id))
            "dead"
        else
            "pending";
        outPrint("[{s}] {s} ({s}) — \"{s}\"\n", .{ status, r.id, pointer.inferPointerType(r.action), r.plan });
    }
    return 0;
}

/// Compat verb: `kill <id> --cause <type> [--by <id>] [--reason <text>]`
///
/// Natural-selection death for the contract DAG. Appends a `died` row with
/// typed cause (superseded | contradicts | stale | apoptosed) so the
/// substrate's projection can distinguish "terminated" from "pending".
///
/// Per biblical canon:
///   superseded — John 12:24, the seed dies that fruit may come (by_id req'd)
///   contradicts — Romans 6:23, the wages of contradiction is death (by_id req'd)
///   stale       — Genesis 3:19, dust thou art, unto dust shalt thou return
///   apoptosed   — programmed shutdown; purpose served
///
/// Hebrews 9:27 — appointed once to die. Refuses to re-kill an already-dead id.
fn cmdKill(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    if (args.len < 1) {
        errPrint("kill requires: <id> --cause <superseded|contradicts|stale|apoptosed> [--by <id>] [--reason <text>]\n", .{});
        return 2;
    }
    const id = args[0];
    if (id.len != 8) {
        errPrint("kill: id must be 8 hex chars (got: {s})\n", .{id});
        return 2;
    }

    var cause_str: ?[]const u8 = null;
    var by_id: ?[]const u8 = null;
    var reason: ?[]const u8 = null;
    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        if (std.mem.eql(u8, args[i], "--cause") and i + 1 < args.len) {
            cause_str = args[i + 1];
            i += 1;
        } else if (std.mem.eql(u8, args[i], "--by") and i + 1 < args.len) {
            by_id = args[i + 1];
            i += 1;
        } else if (std.mem.eql(u8, args[i], "--reason") and i + 1 < args.len) {
            reason = args[i + 1];
            i += 1;
        }
    }

    const cause = cause_str orelse {
        errPrint("kill: --cause is required (superseded|contradicts|stale|apoptosed)\n", .{});
        return 2;
    };

    const parsed_cause: contract.DeathCause = blk: {
        if (std.mem.eql(u8, cause, "superseded")) break :blk .superseded;
        if (std.mem.eql(u8, cause, "contradicts")) break :blk .contradicts;
        if (std.mem.eql(u8, cause, "stale")) break :blk .stale;
        if (std.mem.eql(u8, cause, "apoptosed")) break :blk .apoptosed;
        errPrint("kill: unknown cause '{s}' (allowed: superseded|contradicts|stale|apoptosed)\n", .{cause});
        return 2;
    };

    // .superseded / .contradicts require by_id — death must name its agent.
    if ((parsed_cause == .superseded or parsed_cause == .contradicts) and (by_id == null or by_id.?.len == 0)) {
        errPrint("kill: --by <id> is required for cause '{s}' (death must name its agent)\n", .{cause});
        return 2;
    }

    // Refuse to kill a non-declared id or re-kill an already-dead id.
    const rows = try parseRows(allocator, env);
    defer allocator.free(rows);
    var found_declared = false;
    for (rows) |r| {
        if (std.mem.eql(u8, r.event, "declared") and std.mem.eql(u8, r.id, id)) {
            found_declared = true;
            break;
        }
    }
    if (!found_declared) {
        errPrint("kill: no declared row for {s}\n", .{id});
        return 1;
    }
    if (isDead(rows, id)) {
        errPrint("kill: {s} is already dead (appointed once to die — Hebrews 9:27)\n", .{id});
        return 1;
    }

    try contract.markDied(allocator, env, id, parsed_cause, by_id, reason);
    if (by_id) |b| {
        outPrint("died: {s} cause={s} by={s}\n", .{ id, cause, b });
    } else {
        outPrint("died: {s} cause={s}\n", .{ id, cause });
    }
    return 0;
}

/// Compat verb: `layer <id>` — return the contract's layer (1-6) per
/// contract:d10b3dbb (1=system, 2=cell, 3=graph, 4=transport, 5=value,
/// 6=operator). The Word's compiler reads this to choose translators when
/// crossing layer boundaries. Stdout = bare integer; stderr names the row.
fn cmdLayer(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    if (args.len < 1) {
        errPrint("layer requires: <id>\n", .{});
        return 2;
    }
    const target = args[0];
    const rows = try parseRows(allocator, env);
    defer allocator.free(rows);
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        if (!std.mem.eql(u8, r.id, target)) continue;
        outPrint("{d}\n", .{r.layer});
        return 0;
    }
    errPrint("layer: no declared row for {s}\n", .{target});
    return 1;
}

/// Resolve the absolute path of the currently-running binary. macOS uses
/// `_NSGetExecutablePath`; we shim it via libc.
extern fn _NSGetExecutablePath(buf: [*]u8, size: *u32) c_int;

fn ownBinaryPath(allocator: std.mem.Allocator) ![]u8 {
    var buf: [4096]u8 = undefined;
    var size: u32 = buf.len;
    if (_NSGetExecutablePath(&buf, &size) != 0) return error.PathTooLong;
    // size on success holds the strlen+1; trim the trailing NUL if present.
    var end: usize = 0;
    while (end < buf.len and buf[end] != 0) end += 1;
    return try allocator.dupe(u8, buf[0..end]);
}

/// Compat verb: `sign-binary <path>` — signs `<path>` with the binary-signing
/// keypair derived from the root secret. Writes `<path>.sig` alongside.
/// Used by build.sh after each `zig build` so newly-installed binaries pass
/// self-attestation on next invocation.
fn cmdSignBinary(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    if (args.len < 1) {
        errPrint("sign-binary requires: <path>\n", .{});
        return 2;
    }
    contract.Lineage.signBinary(allocator, env, args[0]) catch |e| {
        errPrint("sign-binary failed: {s}\n", .{@errorName(e)});
        return 1;
    };
    outPrint("signed: {s}.sig\n", .{args[0]});
    return 0;
}

/// Compat verb: `verify-self` — verify the running binary's own integrity.
/// Returns 0 if signature valid; 1 otherwise.
fn cmdVerifySelf(allocator: std.mem.Allocator, env: std.process.Environ) !u8 {
    const path = try ownBinaryPath(allocator);
    defer allocator.free(path);
    contract.Lineage.verifyBinary(allocator, env, path) catch |e| {
        outPrint("verify-self: FAIL ({s})\n  binary: {s}\n", .{ @errorName(e), path });
        return 1;
    };
    outPrint("verify-self: OK\n  binary: {s}\n", .{path});
    return 0;
}

/// Compat verb: `verify-binary <path>` — verify any binary by path against
/// its sidecar `<path>.sig`. Lets one binary attest another (used by build.sh
/// to attest both aiko and contract from one invocation).
fn cmdVerifyBinary(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    if (args.len < 1) {
        errPrint("verify-binary requires: <path>\n", .{});
        return 2;
    }
    contract.Lineage.verifyBinary(allocator, env, args[0]) catch |e| {
        outPrint("verify-binary: FAIL ({s})\n  binary: {s}\n", .{ @errorName(e), args[0] });
        return 1;
    };
    outPrint("verify-binary: OK\n  binary: {s}\n", .{args[0]});
    return 0;
}

/// Refusal gate for LLM-bound operations. Run before any path that POSTs to
/// the canonical Unbrowse endpoint. Tampered or unsigned binaries cannot
/// invoke the LLM compiler — purely-local ledger operations remain available
/// (the gate is per-surface, not per-process).
///
/// Failure-mode: prints a clear refusal to stderr and returns false so the
/// caller exits with code 2 (refused) rather than running an LLM call from
/// an unverified binary.
fn assertBinaryIntegrityForLlm(allocator: std.mem.Allocator, env: std.process.Environ) bool {
    const path = ownBinaryPath(allocator) catch return false;
    defer allocator.free(path);
    contract.Lineage.verifyBinary(allocator, env, path) catch |e| {
        errPrint(
            \\REFUSED: binary failed self-attestation ({s}).
            \\  binary: {s}
            \\
            \\The LLM-compile (Unbrowse word→contract-tree expansion) path is
            \\hardcoded to require a signed binary so that the Word's compiler
            \\cannot be silently repointed or tampered. Run `contract sign-binary
            \\{s}` to (re)sign after rebuilding, then retry.
            \\
        , .{ @errorName(e), path, path });
        return false;
    };
    return true;
}

/// Compat verb: `verify-lineage <id>` — walk parent_id chain from `id` back to
/// the root sentinel, recomputing each row's signing digest and verifying
/// every parent_signature against the parent's env_pubkey. Root rows are
/// self-signed (signer == own pubkey).
///
/// Reports per-link PASS / FAIL and an overall verdict. Exits 0 only when
/// every link verifies and the chain reaches a root.
fn cmdVerifyLineage(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    if (args.len < 1) {
        errPrint("verify-lineage requires: <id>\n", .{});
        return 2;
    }
    const target = args[0];
    const rows = try parseRows(allocator, env);
    defer allocator.free(rows);

    var chain: std.ArrayList(Row) = .empty;
    defer chain.deinit(allocator);

    // Walk parent_id from target backward.
    var cur: []const u8 = target;
    var seen_root = false;
    while (true) {
        var found: ?Row = null;
        for (rows) |r| {
            if (!std.mem.eql(u8, r.event, "declared")) continue;
            if (std.mem.eql(u8, r.id, cur)) {
                found = r;
                break;
            }
        }
        const row = found orelse {
            errPrint("verify-lineage: no declared row for {s}\n", .{cur});
            return 1;
        };
        try chain.append(allocator, row);
        if (row.parent_id) |p| {
            if (p.len == 0) {
                seen_root = true;
                break;
            }
            cur = p;
        } else {
            seen_root = true;
            break;
        }
    }
    if (!seen_root) {
        errPrint("verify-lineage: chain did not terminate at root\n", .{});
        return 1;
    }

    // Build a pubkey lookup for signer resolution.
    var pubkey_for_id: std.StringHashMap([]const u8) = .init(allocator);
    defer pubkey_for_id.deinit();
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        if (r.env_pubkey.len == 0) continue;
        try pubkey_for_id.put(r.id, r.env_pubkey);
    }

    outPrint("verify-lineage {s}:\n", .{target});
    // Iterate chain leaf -> root and verify each row's parent_signature.
    var all_ok = true;
    var i: usize = 0;
    while (i < chain.items.len) : (i += 1) {
        const r = chain.items[i];
        if (r.env_pubkey.len == 0 or r.parent_signature.len == 0) {
            outPrint("  [SKIP] {s} — row predates lineage signing\n", .{r.id});
            continue;
        }
        const parent_or_root: []const u8 = if (r.parent_id) |p|
            (if (p.len > 0) p else "root")
        else
            "root";
        // Resolve signer's pubkey: parent's env_pubkey, or self for root.
        const signer_pubkey: []const u8 = blk: {
            if (r.parent_id) |p| {
                if (p.len > 0) {
                    if (pubkey_for_id.get(p)) |pk| break :blk pk;
                    break :blk ""; // missing parent row
                }
            }
            break :blk r.env_pubkey; // self-signed root
        };
        if (signer_pubkey.len == 0) {
            outPrint("  [FAIL] {s} — parent's env_pubkey unavailable\n", .{r.id});
            all_ok = false;
            continue;
        }
        var digest: [32]u8 = undefined;
        @import("contract").Lineage.signingDigest(r.id, r.env_pubkey, r.plan, parent_or_root, &digest);
        @import("contract").Lineage.verifyDigest(r.parent_signature, signer_pubkey, digest) catch {
            outPrint("  [FAIL] {s} — signature verification failed (signer={s}...)\n", .{ r.id, signer_pubkey[0..16] });
            all_ok = false;
            continue;
        };
        const role = if (r.parent_id == null or r.parent_id.?.len == 0) "root (self-signed)" else "child (signed by parent)";
        outPrint("  [ OK ] {s} {s}\n", .{ r.id, role });
    }
    if (all_ok) {
        outPrint("verdict: chain authentic ({d} links)\n", .{chain.items.len});
        return 0;
    } else {
        outPrint("verdict: chain INVALID\n", .{});
        return 1;
    }
}

/// Compat verb: `_mark <id> satisfied [--proof <text>]`. Appends a `satisfied`
/// row via libcontract.markSatisfied so externally-verified contracts can be
/// driven to satisfaction without round-tripping through the resolver. This
/// is the only honest path to "mark" a contract whose evidence lives outside
/// the substrate (e.g. a passing test, a deployed surface, an observed metric).
fn cmdMark(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    if (args.len < 2) {
        errPrint("_mark requires: <id> satisfied [--proof <text>]\n", .{});
        usage();
        return 2;
    }
    const id = args[0];
    const state = args[1];
    if (!std.mem.eql(u8, state, "satisfied")) {
        errPrint("_mark only supports state=satisfied (got: {s})\n", .{state});
        return 2;
    }
    var proof: ?[]const u8 = null;
    var i: usize = 2;
    while (i < args.len) : (i += 1) {
        if (std.mem.eql(u8, args[i], "--proof") and i + 1 < args.len) {
            proof = args[i + 1];
            i += 1;
        } else if (std.mem.eql(u8, args[i], "--proof-skip") and i + 1 < args.len) {
            proof = args[i + 1];
            i += 1;
        }
    }
    if (id.len != 8) {
        errPrint("_mark: id must be 8 hex chars (got: {s})\n", .{id});
        return 2;
    }
    // Honest guard: refuse to mark an id with no prior declared row.
    const rows = try parseRows(allocator, env);
    defer allocator.free(rows);
    var found = false;
    for (rows) |r| {
        if (std.mem.eql(u8, r.event, "declared") and std.mem.eql(u8, r.id, id)) {
            found = true;
            break;
        }
    }
    if (!found) {
        errPrint("_mark: no declared row found for id {s}\n", .{id});
        return 1;
    }
    try contract.markSatisfied(allocator, env, id, 1, proof);
    outPrint("satisfied: {s}\n", .{id});

    // Posthook dispatch: scan the declared row's plan for posthook:<id> refs
    // and append a `called` row per target. This is the second half of the
    // dispatcher contract d8a30a14 — the graph itself records that the
    // upstream contract fired its successors. Target action execution
    // (cli shell-out / webhook POST / etc.) is deferred to the resolveLineage
    // loop; cmdMark only emits the called edge so the chain is observable.
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        if (!std.mem.eql(u8, r.id, id)) continue;
        const targets = try pointer.extractTypedRefs(allocator, r.plan, "posthook:");
        defer {
            for (targets) |t| allocator.free(t);
            allocator.free(targets);
        }
        for (targets) |target| {
            var ptr_buf: [32]u8 = undefined;
            const target_pointer = try std.fmt.bufPrint(&ptr_buf, "contract:{s}", .{target});
            try contract.appendCalledRow(allocator, env, id, target_pointer, "posthook");
            outPrint("called: posthook -> {s}\n", .{target});
        }
        break;
    }
    return 0;
}

fn cmdStatus(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    if (args.len > 1) {
        err("status accepts zero args or exactly <id>\n");
        return 2;
    }
    if (client.isRemoteMode(env)) {
        if (args.len != 1) {
            err("remote status requires <id>\n");
            return 2;
        }
        const body = client.statusRemote(allocator, env, args[0]) catch |e| {
            errPrint("remote status failed: {s}\n", .{@errorName(e)});
            return 2;
        };
        defer allocator.free(body);
        out(body);
        out("\n");
        return 0;
    }
    const rows = try parseRows(allocator, env);
    defer allocator.free(rows);
    if (args.len == 0) return cmdList(allocator, env);
    const id = args[0];
    const r = latestDeclared(rows, id) orelse {
        errPrint("contract not found: {s}\n", .{id});
        return 1;
    };
    const status: []const u8 = if (isSatisfied(rows, id))
        "satisfied"
    else if (isDead(rows, id))
        "dead"
    else
        "pending";
    outPrint("[{s}] {s} ({s})\n  plan:   {s}\n  action: {s}\n", .{ status, id, pointer.inferPointerType(r.action), r.plan, r.action });
    const ids = try childIds(allocator, rows, id);
    defer allocator.free(ids);
    for (ids) |cid| {
        if (latestDeclared(rows, cid)) |c| {
            const cs: []const u8 = if (isSatisfied(rows, cid))
                "satisfied"
            else if (isDead(rows, cid))
                "dead"
            else
                "pending";
            outPrint("  [{s}] {s} ({s}) — {s}\n", .{ cs, cid, pointer.inferPointerType(c.action), c.plan });
        }
    }
    return 0;
}

fn score(query: []const u8, plan: []const u8) u32 {
    var qbuf: [2048]u8 = undefined;
    var pbuf: [4096]u8 = undefined;
    const q = std.ascii.lowerString(qbuf[0..@min(qbuf.len, query.len)], query[0..@min(qbuf.len, query.len)]);
    const p = std.ascii.lowerString(pbuf[0..@min(pbuf.len, plan.len)], plan[0..@min(pbuf.len, plan.len)]);
    var total: u32 = 0;
    var it = std.mem.tokenizeAny(u8, q, " \t\r\n.,:;()[]{}\"'");
    while (it.next()) |tok| {
        if (tok.len < 3) continue;
        if (std.mem.indexOf(u8, p, tok) != null) total += 1;
    }
    return total;
}

fn cmdSearch(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    var ctx: []const u8 = "";
    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        if (std.mem.eql(u8, args[i], "--context")) {
            i += 1;
            if (i >= args.len) {
                err("search --context requires a value\n");
                return 2;
            }
            ctx = args[i];
        } else {
            errPrint("search unknown flag: {s}\n", .{args[i]});
            return 2;
        }
    }
    const rows = try parseRows(allocator, env);
    defer allocator.free(rows);
    out("RELATED CONTRACTS (native lexical score):\n\n");
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        const s = score(ctx, r.plan);
        if (s == 0) continue;
        const status = if (isSatisfied(rows, r.id)) "satisfied" else "pending";
        outPrint("  [+] score={d} id={s} status={s}\n      plan: {s}\n", .{ s, r.id, status, r.plan });
    }
    return 0;
}

fn cmdDiscover(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        if (std.mem.eql(u8, args[i], "--scope")) {
            i += 1;
            if (i >= args.len) {
                err("discover --scope requires all, project, or global\n");
                return 2;
            }
            if (!std.mem.eql(u8, args[i], "all") and
                !std.mem.eql(u8, args[i], "project") and
                !std.mem.eql(u8, args[i], "global"))
            {
                err("discover --scope requires all, project, or global\n");
                return 2;
            }
        } else {
            errPrint("discover unknown flag: {s}\n", .{args[i]});
            return 2;
        }
    }
    const rows = try parseRows(allocator, env);
    defer allocator.free(rows);
    var shown: usize = 0;
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        const status = if (isSatisfied(rows, r.id)) "satisfied" else "pending";
        outPrint("[native]  {s} ({s}/{s}) — \"{s}\"\n", .{ r.id, pointer.inferPointerType(r.action), status, r.plan });
        shown += 1;
        if (shown >= 80) break;
    }
    return 0;
}

fn cmdSelf(args: []const []const u8) u8 {
    if (args.len > 1 or (args.len == 1 and !std.mem.eql(u8, args[0], "--json"))) {
        err("self accepts no args or --json\n");
        return 2;
    }
    out(
        "{ \"binary\": \"" ++ BINARY_NAME ++ "\", \"implementation\": \"zig\", \"version\": \"" ++ VERSION ++
            "\", \"public_shape\": \"<binary-name> \\\"<truth claim>\\\"\", \"mode_resolution\": \"auto (env-driven: UNBROWSE_BASE -> remote, else genesis); explicit override flags --remote/--local/--genesis\", \"public_verbs\": [\"the-word\"], \"the_word_phases\": [\"word\",\"firmament\",\"earth\",\"lights\",\"life\",\"image\",\"sabbath\"], \"compat_verbs\": [\"declare\", \"_mark\", \"verify-lineage\", \"sign-binary\", \"verify-self\", \"verify-binary\", \"layer\", \"kill\"], \"death_causes\": [\"superseded\",\"contradicts\",\"stale\",\"apoptosed\"], \"unbrowse_base\": \"https://beta-api.unbrowse.ai\", \"llm_compiler_binding\": \"hardcoded\", \"binary_self_attestation\": true, \"empathic_translation_flag\": \"--user <user-aiko-id>\", \"context_verbs\": [\"status\",\"discover\",\"search\",\"self\"], \"shapes\": [\"neuron\"], \"internal_shapes\": [\"cell\",\"funnel\",\"funnel-first\",\"sequence\",\"quorum\",\"loop\",\"harness\",\"contract-ref\"], \"containment_edge\": \"parent_id\", \"cross_edges\": [\"contract-ref\"], \"environment_lineage\": [\"CONTRACT_PARENT_ID\",\"CONTRACT_PARENT\"], \"hook_edges\": {\"pre\": [\"CONTRACT_PREHOOK_ID\",\"CONTRACT_PREHOOK\"], \"post\": [\"CONTRACT_POSTHOOK_ID\",\"CONTRACT_POSTHOOK\"]}, \"adapter_edge\": [\"CONTRACT_ADAPTER_ID\",\"CONTRACT_ADAPTER\"], \"adapter_kind\": [\"CONTRACT_ADAPTER_KIND\",\"CONTRACT_ENVIRONMENT_KIND\"], \"pretool_event_bus\": [\"CONTRACT_EVENT_BUS_ID\",\"CONTRACT_EVENT_BUS\"], \"pretool_event_edge\": [\"CONTRACT_PRETOOL_EVENT_ID\",\"CONTRACT_PRETOOL_EVENT\"], \"event_kind\": [\"CONTRACT_EVENT_KIND\",\"CONTRACT_PRETOOL_KIND\"], \"pretool_contracts_are_ledger_events\": true, \"server_event_bus_stateless\": true, \"adapters_are_server_contracts\": true, \"prompt_compiler\": \"unbrowse-llm\", \"prompt_to_contract_graph\": true, \"prompt_text_is_root_declaration\": true, \"server_integrator\": \"unbrowse-llm\", \"core_loop_native\": true, \"scripts_required_for_core\": false, \"manual_resolution_verbs\": false, \"recursive_firing\": true, \"recursive_children\": true, \"breakpoints\": true, \"fractal_environment_layers\": true, \"multidimensional_dag\": true }\n",
    );
    return 0;
}

pub fn main(init: std.process.Init.Minimal) !u8 {
    const allocator = std.heap.page_allocator;
    var arena: std.heap.ArenaAllocator = .init(allocator);
    defer arena.deinit();
    const argv_z = try init.args.toSlice(arena.allocator());
    if (argv_z.len < 2) {
        usage();
        return 2;
    }
    const verb = argv_z[1];
    var rest = try arena.allocator().alloc([]const u8, argv_z.len - 2);
    for (argv_z[2..], 0..) |a, i| rest[i] = a;

    if (std.mem.eql(u8, verb, "declare")) {
        if (AIKO_DECLARE_ONLY) return try cmdAikoGoal(allocator, init.environ, rest);
        return try cmdDeclare(allocator, init.environ, rest);
    }
    if (AIKO_DECLARE_ONLY) {
        return try cmdAikoGoal(allocator, init.environ, argv_z[1..]);
    }
    if (std.mem.eql(u8, verb, "status")) return try cmdStatus(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "discover")) return try cmdDiscover(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "search")) return try cmdSearch(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "self")) return cmdSelf(rest);
    if (std.mem.eql(u8, verb, "_mark")) return try cmdMark(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "verify-lineage")) return try cmdVerifyLineage(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "sign-binary")) return try cmdSignBinary(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "verify-self")) return try cmdVerifySelf(allocator, init.environ);
    if (std.mem.eql(u8, verb, "verify-binary")) return try cmdVerifyBinary(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "layer")) return try cmdLayer(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "kill")) return try cmdKill(allocator, init.environ, rest);

    errPrint("unknown native verb: {s}\n", .{verb});
    usage();
    return 2;
}
