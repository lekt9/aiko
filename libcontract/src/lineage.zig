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

// libc arc4random_buf is the cleanest cross-Apple-platform CSPRNG and ships
// in libSystem; Zig 0.16's std.posix.getrandom isn't wired on macOS targets.
extern fn arc4random_buf(buf: [*]u8, len: usize) void;

pub const PUBKEY_HEX_LEN: usize = 64; // 32 bytes * 2
pub const SIG_HEX_LEN: usize = 128; // 64 bytes * 2
pub const ROOT_KEY_HEX_LEN: usize = 64; // 32 bytes * 2

/// Sentinel used in place of parent_id for root contracts when computing the
/// signing tuple. Picked to be unmistakable in audit and human-readable.
pub const ROOT_PARENT_SENTINEL: []const u8 = "root";

/// Try to load the 32-byte root secret. Resolution order:
///   1. `$HOME/.contracts/root.key` (64-hex contents, mode 600)
///   2. generate fresh + persist to `$HOME/.contracts/root.key`
pub fn loadOrInitRootKey(allocator: std.mem.Allocator, env: std.process.Environ) ![32]u8 {
    const home = env.getPosix("HOME") orelse return error.NoHome;
    const path = try std.fs.path.join(allocator, &.{ home, ".contracts", "root.key" });
    defer allocator.free(path);

    if (readHexFile(path)) |existing| return existing else |err| {
        if (err != error.FileNotFound) return err;
    }

    // Generate + persist. Use libc CSPRNG (arc4random_buf on Apple platforms
    // is /dev/urandom-backed and always seeded).
    var fresh: [32]u8 = undefined;
    arc4random_buf(&fresh, fresh.len);
    try writeHexFile(allocator, path, &fresh);
    return fresh;
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
