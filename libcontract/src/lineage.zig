//! lineage.zig — cryptographic provenance for the contract DAG.
//!
//! Every declared row carries an `env_pubkey` (the contract's own ed25519
//! public key) and a `parent_signature` over the tuple
//!   sha256(child_id || env_pubkey || sha256(plan) || parent_id_or_root)
//! produced by the parent contract's derived private key. Root contracts
//! (no parent) self-sign with their own derived private key — provenance
//! still grounds in the user's single root key.
//!
//! Private keys are NEVER stored per-contract. They are derived on demand
//! from one root secret using HKDF-SHA256(salt="aiko-lineage-v1", ikm=root,
//! info=contract_id). Statelessness preserved: the only persistent secret
//! is the single root key.

const std = @import("std");
const ed = std.crypto.sign.Ed25519;
const hkdf = std.crypto.kdf.hkdf.HkdfSha256;
const sha256 = std.crypto.hash.sha2.Sha256;
const keystore = @import("keystore.zig");
const ledger = @import("ledger.zig");

// libc arc4random_buf is the cleanest cross-Apple-platform CSPRNG and ships
// in libSystem; Zig 0.16's std.posix.getrandom isn't wired on macOS targets.
extern fn arc4random_buf(buf: [*]u8, len: usize) void;

pub const PUBKEY_HEX_LEN: usize = 64; // 32 bytes * 2
pub const SIG_HEX_LEN: usize = 128; // 64 bytes * 2
pub const ROOT_KEY_HEX_LEN: usize = 64; // 32 bytes * 2

/// Sentinel used in place of parent_id for root contracts when computing the
/// signing tuple. Picked to be unmistakable in audit and human-readable.
pub const ROOT_PARENT_SENTINEL: []const u8 = "root";

/// Three-tier wallet bootstrap. Resolution order on every aiko invocation:
///   1. `$HOME/.contracts/root.key`             (canonical file, mode 600)
///   2. `$HOME/.aiko/keys/root.key`             (mirror file, mode 600)
///   3. macOS Keychain `aiko.root.ed25519.seed` (security CLI shellout)
///   4. generate fresh + persist to all three (atomic three-way mirror)
///
/// Idempotent: after first successful read from ANY tier, the missing tiers
/// are silently back-filled so the next invocation has all three mirrors
/// populated. Generation only happens when ALL THREE tiers miss (true
/// first-run on a clean machine).
pub fn loadOrInitRootKey(allocator: std.mem.Allocator, env: std.process.Environ) ![32]u8 {
    const home = env.getPosix("HOME") orelse return error.NoHome;
    const canonical = try std.fs.path.join(allocator, &.{ home, ".contracts", "root.key" });
    defer allocator.free(canonical);
    const mirror = try std.fs.path.join(allocator, &.{ home, ".aiko", "keys", "root.key" });
    defer allocator.free(mirror);

    // Tier 1: canonical file
    if (readHexFile(canonical)) |existing| {
        backfillMirrors(allocator, &existing, canonical, mirror) catch {};
        return existing;
    } else |err| if (err != error.FileNotFound) return err;

    // Tier 2: ~/.aiko/keys/root.key mirror
    if (readHexFile(mirror)) |existing| {
        backfillMirrors(allocator, &existing, canonical, mirror) catch {};
        return existing;
    } else |err| if (err != error.FileNotFound) return err;

    // Tier 3: macOS Keychain
    if (readKeychainSeed(allocator)) |existing| {
        backfillMirrors(allocator, &existing, canonical, mirror) catch {};
        return existing;
    } else |err| if (err != error.NotFound) return err;

    // Tier 4: fresh generation, write to all three.
    var fresh: [32]u8 = undefined;
    arc4random_buf(&fresh, fresh.len);
    try writeHexFile(allocator, canonical, &fresh);
    backfillMirrors(allocator, &fresh, canonical, mirror) catch {};
    return fresh;
}

/// Best-effort back-fill: ensure the mirror file and Keychain both carry the
/// same seed as the canonical file. Failures here are non-fatal; the caller
/// has a valid seed in hand. Run after every successful read so the substrate
/// self-heals when one tier is wiped or never populated.
fn backfillMirrors(
    allocator: std.mem.Allocator,
    seed: *const [32]u8,
    canonical_path: []const u8,
    mirror_path: []const u8,
) !void {
    // Canonical may be missing (we just read from mirror or keychain).
    if (readHexFile(canonical_path)) |_| {} else |err| switch (err) {
        error.FileNotFound => writeHexFile(allocator, canonical_path, seed) catch {},
        else => {},
    }
    // Mirror file.
    if (readHexFile(mirror_path)) |_| {} else |err| switch (err) {
        error.FileNotFound => writeHexFile(allocator, mirror_path, seed) catch {},
        else => {},
    }
    // Keychain.
    if (readKeychainSeed(allocator)) |_| {} else |err| switch (err) {
        error.NotFound => writeKeychainSeed(allocator, seed) catch {},
        else => {},
    }
}

// ────────── OS keystore (delegates to keystore.zig) ──────────
//
// Lineage no longer carries platform-specific shellouts — `keystore.zig`
// owns the per-OS backend dispatch (darwin Keychain, linux libsecret,
// windows stub, fallback ChaCha20Poly1305 file). This keeps lineage focused
// on the cryptographic primitives and lets new platforms land by adding
// one backend to the keystore module rather than touching lineage.

const KEYCHAIN_SVC: []const u8 = "aiko.root.ed25519.seed";

fn readKeychainSeed(allocator: std.mem.Allocator) ![32]u8 {
    const stored = (try keystore.read(allocator, KEYCHAIN_SVC)) orelse return error.NotFound;
    defer std.heap.page_allocator.free(stored); // matches keystore.read's alloc

    // Trim any trailing whitespace just in case (keystore already trims, but
    // legacy keychain entries from before this refactor may carry newlines).
    var end: usize = stored.len;
    while (end > 0 and (stored[end - 1] == '\n' or stored[end - 1] == '\r' or stored[end - 1] == ' ')) end -= 1;
    if (end < ROOT_KEY_HEX_LEN) return error.NotFound;
    var out: [32]u8 = undefined;
    parseHex(stored[0..ROOT_KEY_HEX_LEN], &out) catch return error.NotFound;
    return out;
}

fn writeKeychainSeed(allocator: std.mem.Allocator, seed: *const [32]u8) !void {
    var hex: [ROOT_KEY_HEX_LEN]u8 = undefined;
    bytesToHex(seed, &hex);
    try keystore.write(allocator, KEYCHAIN_SVC, &hex);
}

/// HKDF-derive a 32-byte private seed, then build the ed25519 keypair.
pub fn deriveKeyPair(root: [32]u8, contract_id: []const u8) !ed.KeyPair {
    const prk = hkdf.extract("aiko-lineage-v1", &root);
    var seed: [32]u8 = undefined;
    hkdf.expand(&seed, contract_id, prk);
    return try ed.KeyPair.generateDeterministic(seed);
}

/// Compute the canonical message hashed for parent_signature:
///   sha256(child_id || env_pubkey_hex || sha256(plan)_hex || parent_or_root)
/// All concatenated as raw bytes; result is 32 bytes.
pub fn signingDigest(
    child_id: []const u8,
    env_pubkey_hex: []const u8,
    plan: []const u8,
    parent_or_root: []const u8,
    out: *[32]u8,
) void {
    var plan_digest: [32]u8 = undefined;
    sha256.hash(plan, &plan_digest, .{});
    var plan_hex: [64]u8 = undefined;
    bytesToHex(&plan_digest, &plan_hex);

    var hasher = sha256.init(.{});
    hasher.update(child_id);
    hasher.update(env_pubkey_hex);
    hasher.update(&plan_hex);
    hasher.update(parent_or_root);
    hasher.final(out);
}

/// Sign the digest with `signer_kp`. Returns 128-char hex of the 64-byte sig.
pub fn signDigest(signer_kp: ed.KeyPair, digest: [32]u8, out: *[SIG_HEX_LEN]u8) !void {
    const sig = try signer_kp.sign(&digest, null);
    bytesToHex(&sig.toBytes(), out);
}

/// Verify a hex-encoded signature against a hex-encoded pubkey + digest.
pub fn verifyDigest(
    sig_hex: []const u8,
    pubkey_hex: []const u8,
    digest: [32]u8,
) !void {
    if (sig_hex.len != SIG_HEX_LEN) return error.MalformedSignature;
    if (pubkey_hex.len != PUBKEY_HEX_LEN) return error.MalformedPubkey;
    var sig_bytes: [64]u8 = undefined;
    var pk_bytes: [32]u8 = undefined;
    try parseHex(sig_hex, &sig_bytes);
    try parseHex(pubkey_hex, &pk_bytes);
    const sig = ed.Signature.fromBytes(sig_bytes);
    const pk = try ed.PublicKey.fromBytes(pk_bytes);
    try sig.verify(&digest, pk);
}

/// Salt used when deriving the binary-signing key from the root secret.
/// Distinct from the lineage signing salt so binary integrity and contract
/// lineage are cryptographically independent.
pub const BINARY_SIGNING_SALT: []const u8 = "aiko-binary-signing-v1";

/// Derive the keypair used to sign aiko binaries themselves.
pub fn deriveBinarySigningKeyPair(root: [32]u8) !ed.KeyPair {
    const prk = hkdf.extract(BINARY_SIGNING_SALT, &root);
    var seed: [32]u8 = undefined;
    hkdf.expand(&seed, "binary", prk);
    return try ed.KeyPair.generateDeterministic(seed);
}

/// SHA-256 a file at `path`. Returns the 32-byte digest. Caller-provided.
pub fn fileSha256(allocator: std.mem.Allocator, path: []const u8, out: *[32]u8) !void {
    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);

    var flags: std.c.O = .{};
    flags.ACCMODE = .RDONLY;
    const fd: c_int = std.c.open(path_z.ptr, flags, @as(c_uint, 0));
    if (fd < 0) return error.FileNotFound;
    defer _ = std.c.close(fd);

    var hasher = sha256.init(.{});
    var chunk: [16384]u8 = undefined;
    while (true) {
        const n = std.c.read(fd, &chunk, chunk.len);
        if (n <= 0) break;
        hasher.update(chunk[0..@intCast(n)]);
    }
    hasher.final(out);
}

/// Sign the contents of `binary_path`: compute SHA-256, sign the digest with
/// the binary-signing keypair, write `<binary_path>.sig` as 128-char hex.
pub fn signBinary(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    binary_path: []const u8,
) !void {
    const root = try loadOrInitRootKey(allocator, env);
    const kp = try deriveBinarySigningKeyPair(root);
    var digest: [32]u8 = undefined;
    try fileSha256(allocator, binary_path, &digest);
    var sig_hex: [SIG_HEX_LEN]u8 = undefined;
    try signDigest(kp, digest, &sig_hex);

    const sig_path = try std.fmt.allocPrint(allocator, "{s}.sig", .{binary_path});
    defer allocator.free(sig_path);
    const sig_path_z = try allocator.dupeZ(u8, sig_path);
    defer allocator.free(sig_path_z);

    var flags: std.c.O = .{};
    flags.ACCMODE = .WRONLY;
    flags.CREAT = true;
    flags.TRUNC = true;
    const fd: c_int = std.c.open(sig_path_z.ptr, flags, @as(c_uint, 0o644));
    if (fd < 0) return error.OpenFailed;
    defer _ = std.c.close(fd);

    var with_nl: [SIG_HEX_LEN + 1]u8 = undefined;
    @memcpy(with_nl[0..SIG_HEX_LEN], &sig_hex);
    with_nl[SIG_HEX_LEN] = '\n';
    const n = std.c.write(fd, &with_nl, with_nl.len);
    if (n < @as(isize, with_nl.len)) return error.WriteFailed;
}

/// Verify the binary at `binary_path` against `<binary_path>.sig` using the
/// binary-signing key derived from the root secret. Returns void on success,
/// errors on any mismatch / missing input.
pub fn verifyBinary(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    binary_path: []const u8,
) !void {
    const root = try loadOrInitRootKey(allocator, env);
    const kp = try deriveBinarySigningKeyPair(root);
    var pubkey_hex: [PUBKEY_HEX_LEN]u8 = undefined;
    bytesToHex(&kp.public_key.bytes, &pubkey_hex);

    var digest: [32]u8 = undefined;
    try fileSha256(allocator, binary_path, &digest);

    const sig_path = try std.fmt.allocPrint(allocator, "{s}.sig", .{binary_path});
    defer allocator.free(sig_path);

    const sig_path_z = try allocator.dupeZ(u8, sig_path);
    defer allocator.free(sig_path_z);
    var flags: std.c.O = .{};
    flags.ACCMODE = .RDONLY;
    const fd: c_int = std.c.open(sig_path_z.ptr, flags, @as(c_uint, 0));
    if (fd < 0) return error.SignatureMissing;
    defer _ = std.c.close(fd);

    var buf: [SIG_HEX_LEN + 8]u8 = undefined;
    const n = std.c.read(fd, &buf, buf.len);
    if (n < @as(isize, SIG_HEX_LEN)) return error.SignatureTruncated;
    try verifyDigest(buf[0..SIG_HEX_LEN], &pubkey_hex, digest);
}

pub fn bytesToHex(in: []const u8, out: []u8) void {
    const alpha = "0123456789abcdef";
    var i: usize = 0;
    while (i < in.len) : (i += 1) {
        out[i * 2] = alpha[in[i] >> 4];
        out[i * 2 + 1] = alpha[in[i] & 0x0f];
    }
}

fn parseHex(hex: []const u8, out: []u8) !void {
    if (hex.len != out.len * 2) return error.InvalidHexLength;
    var i: usize = 0;
    while (i < out.len) : (i += 1) {
        const hi: u8 = try hexNibble(hex[i * 2]);
        const lo: u8 = try hexNibble(hex[i * 2 + 1]);
        out[i] = (hi << 4) | lo;
    }
}

fn hexNibble(c: u8) !u8 {
    return switch (c) {
        '0'...'9' => c - '0',
        'a'...'f' => c - 'a' + 10,
        'A'...'F' => c - 'A' + 10,
        else => error.InvalidHexChar,
    };
}

fn readHexFile(path: []const u8) ![32]u8 {
    var path_buf: [4096]u8 = undefined;
    @memcpy(path_buf[0..path.len], path);
    path_buf[path.len] = 0;
    const path_z: [*:0]const u8 = @ptrCast(&path_buf);

    var flags: std.c.O = .{};
    flags.ACCMODE = .RDONLY;
    const fd: c_int = std.c.open(path_z, flags, @as(c_uint, 0));
    if (fd < 0) return error.FileNotFound;
    defer _ = std.c.close(fd);

    var buf: [128]u8 = undefined;
    const n = std.c.read(fd, &buf, buf.len);
    if (n < @as(isize, ROOT_KEY_HEX_LEN)) return error.RootKeyTooShort;
    // Strip trailing whitespace (newline).
    var end: usize = @intCast(n);
    while (end > 0 and (buf[end - 1] == '\n' or buf[end - 1] == '\r' or buf[end - 1] == ' ')) end -= 1;
    if (end < ROOT_KEY_HEX_LEN) return error.RootKeyTooShort;
    var out: [32]u8 = undefined;
    try parseHex(buf[0..ROOT_KEY_HEX_LEN], &out);
    return out;
}

fn writeHexFile(allocator: std.mem.Allocator, path: []const u8, bytes: *const [32]u8) !void {
    // Make parent dir
    if (std.fs.path.dirname(path)) |parent| {
        var i: usize = 0;
        while (i < parent.len) : (i += 1) {
            if (parent[i] == '/' and i > 0) {
                const partial = try allocator.dupeZ(u8, parent[0..i]);
                defer allocator.free(partial);
                _ = std.c.mkdir(partial.ptr, 0o755);
            }
        }
        const full_parent = try allocator.dupeZ(u8, parent);
        defer allocator.free(full_parent);
        _ = std.c.mkdir(full_parent.ptr, 0o755);
    }

    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);

    var flags: std.c.O = .{};
    flags.ACCMODE = .WRONLY;
    flags.CREAT = true;
    flags.TRUNC = true;
    const fd: c_int = std.c.open(path_z.ptr, flags, @as(c_uint, 0o600));
    if (fd < 0) return error.OpenFailed;
    defer _ = std.c.close(fd);

    var hex: [ROOT_KEY_HEX_LEN]u8 = undefined;
    bytesToHex(bytes, &hex);
    var with_nl: [ROOT_KEY_HEX_LEN + 1]u8 = undefined;
    @memcpy(with_nl[0..ROOT_KEY_HEX_LEN], &hex);
    with_nl[ROOT_KEY_HEX_LEN] = '\n';
    const n = std.c.write(fd, &with_nl, with_nl.len);
    if (n < @as(isize, with_nl.len)) return error.WriteFailed;
}

// ────────── identity keypair (root-wallet identity, distinct from per-contract derivation) ──────────

/// Salt used to derive the ROOT wallet's identity keypair — the keypair
/// whose pubkey IS the wallet identity advertised on the wire. Distinct
/// from BINARY_SIGNING_SALT and from the per-contract HKDF salt so the
/// three derivations are cryptographically independent.
pub const IDENTITY_SALT: []const u8 = "aiko-root-identity-v1";

pub fn deriveIdentityKeyPair(root: [32]u8) !ed.KeyPair {
    const prk = hkdf.extract(IDENTITY_SALT, &root);
    var seed: [32]u8 = undefined;
    hkdf.expand(&seed, "identity", prk);
    return try ed.KeyPair.generateDeterministic(seed);
}

// ────────── wallet rotation ──────────

pub const RotationResult = struct {
    old_pubkey_hex: [PUBKEY_HEX_LEN]u8,
    new_pubkey_hex: [PUBKEY_HEX_LEN]u8,
    /// Signature by the OLD identity keypair over the successor message —
    /// proves the rotation was authorized by whoever held the prior root.
    successor_sig_hex: [SIG_HEX_LEN]u8,
    rotated_at: i64,
};

/// Rotate the wallet's root key. Atomic-as-possible three-way write
/// (canonical file is authoritative; mirror and keystore are best-effort
/// back-fills, same shape as `loadOrInitRootKey`). Archives the prior
/// canonical seed under `$HOME/.aiko/keys/.archived-rotated-<ts>/root.key`.
/// Emits a signed `wallet_rotated` row to the local ledger so the chain of
/// custody is auditable.
pub fn rotateRootKey(allocator: std.mem.Allocator, env: std.process.Environ) !RotationResult {
    const home = env.getPosix("HOME") orelse return error.NoHome;
    const canonical = try std.fs.path.join(allocator, &.{ home, ".contracts", "root.key" });
    defer allocator.free(canonical);
    const mirror = try std.fs.path.join(allocator, &.{ home, ".aiko", "keys", "root.key" });
    defer allocator.free(mirror);

    // 1. Read the current root. We do NOT generate here — if the keystore
    //    really is empty, loadOrInitRootKey would generate a fresh seed and
    //    we'd be rotating a key the caller never had. Detect that by
    //    checking the canonical tier exists BEFORE the call.
    const had_canonical = if (readHexFile(canonical)) |_| true else |err| switch (err) {
        error.FileNotFound => false,
        else => false,
    };
    const had_mirror = if (readHexFile(mirror)) |_| true else |err| switch (err) {
        error.FileNotFound => false,
        else => false,
    };
    if (!had_canonical and !had_mirror) {
        // Keystore tier may still have it; only fail if all three miss.
        if (readKeychainSeed(allocator)) |_| {} else |_| return error.NoPriorRoot;
    }
    const old_root = try loadOrInitRootKey(allocator, env);

    // 2-3. Derive OLD identity + pubkey hex.
    const old_kp = try deriveIdentityKeyPair(old_root);
    var old_pubkey_hex: [PUBKEY_HEX_LEN]u8 = undefined;
    bytesToHex(&old_kp.public_key.bytes, &old_pubkey_hex);

    // 4-5. Generate NEW seed + derive NEW identity.
    var new_root: [32]u8 = undefined;
    arc4random_buf(&new_root, new_root.len);
    const new_kp = try deriveIdentityKeyPair(new_root);
    var new_pubkey_hex: [PUBKEY_HEX_LEN]u8 = undefined;
    bytesToHex(&new_kp.public_key.bytes, &new_pubkey_hex);

    // 6. Successor message digest:
    //    sha256("wallet_rotated|" || old_pubkey_hex || new_pubkey_hex || ts_ascii)
    var tv: std.c.timeval = undefined;
    _ = std.c.gettimeofday(&tv, null);
    const rotated_at: i64 = @intCast(tv.sec);
    var ts_buf: [32]u8 = undefined;
    const ts_str = try std.fmt.bufPrint(&ts_buf, "{d}", .{rotated_at});

    var hasher = sha256.init(.{});
    hasher.update("wallet_rotated|");
    hasher.update(&old_pubkey_hex);
    hasher.update(&new_pubkey_hex);
    hasher.update(ts_str);
    var digest: [32]u8 = undefined;
    hasher.final(&digest);

    // 7. Sign with OLD identity.
    var sig_hex: [SIG_HEX_LEN]u8 = undefined;
    try signDigest(old_kp, digest, &sig_hex);

    // 8. Archive prior canonical seed (best-effort).
    archiveRoot(allocator, home, canonical, rotated_at) catch {};

    // 9. Atomic three-way write: canonical FIRST (authoritative). Mirror +
    //    keystore are best-effort. If canonical write fails, we leave the
    //    prior root in place across all three tiers — no half-rotated state.
    try writeHexFile(allocator, canonical, &new_root);
    backfillMirrors(allocator, &new_root, canonical, mirror) catch {};

    // 10. Append wallet_rotated ledger row (signed by OLD identity sig).
    appendWalletRotatedRow(allocator, env, &old_pubkey_hex, &new_pubkey_hex, &sig_hex, rotated_at) catch {};

    return .{
        .old_pubkey_hex = old_pubkey_hex,
        .new_pubkey_hex = new_pubkey_hex,
        .successor_sig_hex = sig_hex,
        .rotated_at = rotated_at,
    };
}

fn archiveRoot(allocator: std.mem.Allocator, home: []const u8, canonical: []const u8, ts: i64) !void {
    var ts_buf: [32]u8 = undefined;
    const ts_str = try std.fmt.bufPrint(&ts_buf, "{d}", .{ts});
    const dir = try std.fmt.allocPrint(
        allocator,
        "{s}/.aiko/keys/.archived-rotated-{s}",
        .{ home, ts_str },
    );
    defer allocator.free(dir);
    // mkdir -p
    var i: usize = 0;
    while (i < dir.len) : (i += 1) {
        if (dir[i] == '/' and i > 0) {
            const partial = try allocator.dupeZ(u8, dir[0..i]);
            defer allocator.free(partial);
            _ = std.c.mkdir(partial.ptr, 0o755);
        }
    }
    const full = try allocator.dupeZ(u8, dir);
    defer allocator.free(full);
    _ = std.c.mkdir(full.ptr, 0o700);

    const dst = try std.fs.path.join(allocator, &.{ dir, "root.key" });
    defer allocator.free(dst);

    const src_z = try allocator.dupeZ(u8, canonical);
    defer allocator.free(src_z);
    var rflags: std.c.O = .{};
    rflags.ACCMODE = .RDONLY;
    const src_fd = std.c.open(src_z.ptr, rflags, @as(c_uint, 0));
    if (src_fd < 0) return; // nothing to archive
    defer _ = std.c.close(src_fd);
    var buf: [256]u8 = undefined;
    const n = std.c.read(src_fd, &buf, buf.len);
    if (n <= 0) return;

    const dst_z = try allocator.dupeZ(u8, dst);
    defer allocator.free(dst_z);
    var wflags: std.c.O = .{};
    wflags.ACCMODE = .WRONLY;
    wflags.CREAT = true;
    wflags.TRUNC = true;
    const dst_fd = std.c.open(dst_z.ptr, wflags, @as(c_uint, 0o600));
    if (dst_fd < 0) return;
    defer _ = std.c.close(dst_fd);
    _ = std.c.write(dst_fd, &buf, @intCast(n));
}

fn appendWalletRotatedRow(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    old_pubkey_hex: []const u8,
    new_pubkey_hex: []const u8,
    sig_hex: []const u8,
    rotated_at: i64,
) !void {
    // 8-hex event id from CSPRNG.
    var idr: [4]u8 = undefined;
    arc4random_buf(&idr, idr.len);
    var event_id: [8]u8 = undefined;
    const alpha = "0123456789abcdef";
    for (idr, 0..) |b, i| {
        event_id[i * 2] = alpha[b >> 4];
        event_id[i * 2 + 1] = alpha[b & 0x0f];
    }
    var iso_buf: [64]u8 = undefined;
    const iso = try nowIsoUtc(&iso_buf);

    const row = try std.fmt.allocPrint(
        allocator,
        "{{\"event\": \"wallet_rotated\", \"id\": \"{s}\", \"old_pubkey\": \"{s}\", \"new_pubkey\": \"{s}\", \"successor_signature\": \"{s}\", \"rotated_at\": {d}, \"ts\": \"{s}\"}}",
        .{ event_id, old_pubkey_hex, new_pubkey_hex, sig_hex, rotated_at, iso },
    );
    defer allocator.free(row);
    const path = try ledger.appendRow(allocator, env, row);
    allocator.free(path);
}

fn nowIsoUtc(buf: []u8) ![]u8 {
    var tv: std.c.timeval = undefined;
    _ = std.c.gettimeofday(&tv, null);
    const secs_total: i64 = @intCast(tv.sec);
    const us_remainder: i64 = @intCast(tv.usec);
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

// ────────── lineage re-sign walker ──────────

/// Walk every `declared` row carrying env_pubkey/parent_signature whose
/// signature was produced by a keypair derived from `old_root + contract_id`.
/// For each match, append a `resigned` event row carrying the NEW pubkey +
/// NEW parent_signature. Original `declared` rows are NEVER mutated —
/// verifiers prefer the latest `resigned` row over the original.
///
/// Returns the count of rows re-signed. Rows missing either field are skipped
/// silently (function returns 0 cleanly on a ledger without signed rows).
pub fn rotateAllSignedRowsByLineage(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    old_root: [32]u8,
    new_root: [32]u8,
    ledger_path: []const u8,
    rotated_by_event_id: []const u8,
) !u32 {
    _ = env;
    const body = readFileAll(allocator, ledger_path) catch return 0;
    defer allocator.free(body);

    var count: u32 = 0;
    var iter = std.mem.tokenizeAny(u8, body, "\n");
    while (iter.next()) |line| {
        if (line.len < 2) continue;
        if (std.mem.indexOf(u8, line, "\"event\": \"declared\"") == null and
            std.mem.indexOf(u8, line, "\"event\":\"declared\"") == null) continue;

        const id = (try extractJsonStringField(allocator, line, "id")) orelse continue;
        defer allocator.free(id);
        const env_pubkey = (try extractJsonStringField(allocator, line, "env_pubkey")) orelse continue;
        defer allocator.free(env_pubkey);
        const parent_sig = (try extractJsonStringField(allocator, line, "parent_signature")) orelse continue;
        defer allocator.free(parent_sig);
        const plan = (try extractJsonStringField(allocator, line, "plan")) orelse continue;
        defer allocator.free(plan);
        const parent_id_opt = try extractJsonStringField(allocator, line, "parent_id");
        defer if (parent_id_opt) |p| allocator.free(p);
        const parent_or_root: []const u8 = if (parent_id_opt) |p| p else ROOT_PARENT_SENTINEL;

        // Is this row's env_pubkey what we'd derive from old_root + id?
        const expected_old_kp = deriveKeyPair(old_root, id) catch continue;
        var expected_old_hex: [PUBKEY_HEX_LEN]u8 = undefined;
        bytesToHex(&expected_old_kp.public_key.bytes, &expected_old_hex);
        if (!std.mem.eql(u8, env_pubkey, &expected_old_hex)) continue;

        // Derive NEW keypair, recompute digest with NEW pubkey, sign.
        const new_kp = deriveKeyPair(new_root, id) catch continue;
        var new_pubkey_hex: [PUBKEY_HEX_LEN]u8 = undefined;
        bytesToHex(&new_kp.public_key.bytes, &new_pubkey_hex);
        var digest: [32]u8 = undefined;
        signingDigest(id, &new_pubkey_hex, plan, parent_or_root, &digest);
        var new_sig_hex: [SIG_HEX_LEN]u8 = undefined;
        signDigest(new_kp, digest, &new_sig_hex) catch continue;

        var iso_buf: [64]u8 = undefined;
        const iso = try nowIsoUtc(&iso_buf);
        const row = try std.fmt.allocPrint(
            allocator,
            "{{\"event\": \"resigned\", \"id\": \"{s}\", \"new_env_pubkey\": \"{s}\", \"new_parent_signature\": \"{s}\", \"rotated_by\": \"{s}\", \"ts\": \"{s}\"}}\n",
            .{ id, new_pubkey_hex, new_sig_hex, rotated_by_event_id, iso },
        );
        defer allocator.free(row);
        // Append directly to the named ledger path (function takes an
        // explicit path so a test or migration tool can drive any file).
        try appendBytesToFile(allocator, ledger_path, row);
        count += 1;
    }
    return count;
}

fn readFileAll(allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);
    var flags: std.c.O = .{};
    flags.ACCMODE = .RDONLY;
    const fd: c_int = std.c.open(path_z.ptr, flags, @as(c_uint, 0));
    if (fd < 0) return error.FileNotFound;
    defer _ = std.c.close(fd);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    var chunk: [8192]u8 = undefined;
    while (true) {
        const n = std.c.read(fd, &chunk, chunk.len);
        if (n <= 0) break;
        try out.appendSlice(allocator, chunk[0..@intCast(n)]);
        if (out.items.len > 32 * 1024 * 1024) return error.LedgerTooLarge;
    }
    return try out.toOwnedSlice(allocator);
}

fn appendBytesToFile(allocator: std.mem.Allocator, path: []const u8, bytes: []const u8) !void {
    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);
    var flags: std.c.O = .{};
    flags.ACCMODE = .WRONLY;
    flags.CREAT = true;
    flags.APPEND = true;
    const fd: c_int = std.c.open(path_z.ptr, flags, @as(c_uint, 0o644));
    if (fd < 0) return error.OpenFailed;
    defer _ = std.c.close(fd);
    const n = std.c.write(fd, bytes.ptr, bytes.len);
    if (n < @as(isize, @intCast(bytes.len))) return error.WriteFailed;
}

/// Tolerant extractor: matches `"key": "value"` or `"key":"value"`. Returns
/// null when the key is absent OR when its value is JSON `null`. Caller frees
/// the returned slice using `alloc`.
fn extractJsonStringField(alloc: std.mem.Allocator, line: []const u8, key: []const u8) !?[]u8 {
    var key_buf: [128]u8 = undefined;
    const k1 = try std.fmt.bufPrint(&key_buf, "\"{s}\": \"", .{key});
    const k1_len = k1.len;
    const start = blk: {
        if (std.mem.indexOf(u8, line, k1)) |p| break :blk p + k1_len;
        const k2 = try std.fmt.bufPrint(&key_buf, "\"{s}\":\"", .{key});
        if (std.mem.indexOf(u8, line, k2)) |p| break :blk p + k2.len;
        return null;
    };
    var i: usize = start;
    while (i < line.len) : (i += 1) {
        if (line[i] == '\\' and i + 1 < line.len) {
            i += 1;
            continue;
        }
        if (line[i] == '"') break;
    }
    if (i >= line.len) return null;
    return try alloc.dupe(u8, line[start..i]);
}

test "deterministic derivation + sign + verify round-trip" {
    const root: [32]u8 = .{0xab} ** 32;
    const kp1 = try deriveKeyPair(root, "deadbeef");
    const kp2 = try deriveKeyPair(root, "deadbeef");
    // Same root + id → same key.
    try std.testing.expectEqualSlices(u8, &kp1.public_key.bytes, &kp2.public_key.bytes);
    // Different id → different key.
    const kp3 = try deriveKeyPair(root, "c0ffee99");
    try std.testing.expect(!std.mem.eql(u8, &kp1.public_key.bytes, &kp3.public_key.bytes));
    // Sign + verify path.
    var pubkey_hex: [PUBKEY_HEX_LEN]u8 = undefined;
    bytesToHex(&kp1.public_key.bytes, &pubkey_hex);
    var digest: [32]u8 = undefined;
    signingDigest("deadbeef", &pubkey_hex, "plan body", "root", &digest);
    var sig_hex: [SIG_HEX_LEN]u8 = undefined;
    try signDigest(kp1, digest, &sig_hex);
    try verifyDigest(&sig_hex, &pubkey_hex, digest);
}
