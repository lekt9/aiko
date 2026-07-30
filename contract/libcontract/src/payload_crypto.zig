//! payload_crypto.zig — per-row payload encryption for ledger confidentiality.
//!
//! Lewis 2026-05-26 (contracts 8fb3e7fe → 896f0abd): the ledger is publicly
//! readable by design (Pointers-Over-Anything Clause B — stateless trace),
//! but `plan` / `action` field bytes can carry PII or secrets the operator
//! never granted to readers. This module seals those bytes per row, so the
//! ledger stays a public DAG of pointers while the values are decryptable
//! only by the deployer wallet (or any descendant pulling a matching grant
//! per the capability-inheritance rule).
//!
//! Identity: per-row 32-byte key = HKDF-SHA256(
//!     salt = "aiko-payload-encrypt-v1",
//!     ikm  = deployer_root,
//!     info = contract_id || "\x00payload",
//! )
//! Same HKDF substrate as lineage.deriveKeyPair — one root key, infinite
//! derived keys, none of them stored.
//!
//! AEAD: XChaCha20-Poly1305 with a 24-byte random nonce (CSPRNG via
//! arc4random_buf, same source the wallet uses). 24-byte nonces are
//! safe at scale without a counter. The nonce is stored alongside the
//! ciphertext+tag; the AAD binds the row's identity (contract_id +
//! event_kind) so a sealed payload cannot be replayed onto a different
//! row.
//!
//! The signature chain (cache.computeSignatureChain) is orthogonal — it
//! signs the canonical pre-encryption digest, so cache hits and parent
//! verification work without the decryption key. Encryption gates VALUE
//! access; the substrate's truth-resolution does not depend on values.

const std = @import("std");
const hkdf = std.crypto.kdf.hkdf.HkdfSha256;
const xchacha = std.crypto.aead.chacha_poly.XChaCha20Poly1305;

extern fn arc4random_buf(buf: [*]u8, len: usize) void;

pub const KEY_LEN: usize = 32;
pub const NONCE_LEN: usize = xchacha.nonce_length; // 24
pub const TAG_LEN: usize = xchacha.tag_length; // 16

pub const HKDF_SALT: []const u8 = "aiko-payload-encrypt-v1";

/// Derive the 32-byte AEAD key for a specific (root, contract_id) pair.
/// Deterministic — same inputs always yield the same key. The deployer
/// root never leaves the wallet; this function takes a copy by value
/// because the caller is already holding the loaded root for one operation.
pub fn deriveRowKey(root: [32]u8, contract_id: []const u8) [KEY_LEN]u8 {
    const prk = hkdf.extract(HKDF_SALT, &root);
    // info string binds the derivation to the payload-encrypt purpose,
    // disjoint from lineage.deriveKeyPair's "aiko-lineage-v1" salt so the
    // two keyspaces cannot collide.
    var info_buf: [256]u8 = undefined;
    const info_len = contract_id.len + "\x00payload".len;
    std.debug.assert(info_len <= info_buf.len);
    @memcpy(info_buf[0..contract_id.len], contract_id);
    @memcpy(info_buf[contract_id.len..info_len], "\x00payload");
    var key: [KEY_LEN]u8 = undefined;
    hkdf.expand(&key, info_buf[0..info_len], prk);
    return key;
}

/// Sealed-payload wire shape:
///   nonce (24B) || ciphertext (N) || tag (16B)
/// Total length = NONCE_LEN + plaintext.len + TAG_LEN.
/// The caller owns the returned slice and must free it.
pub fn seal(
    allocator: std.mem.Allocator,
    key: [KEY_LEN]u8,
    plaintext: []const u8,
    aad: []const u8,
) ![]u8 {
    const out = try allocator.alloc(u8, NONCE_LEN + plaintext.len + TAG_LEN);
    errdefer allocator.free(out);

    // CSPRNG nonce — 24-byte XChaCha nonces are wide enough that random
    // selection collides with negligible probability at any realistic
    // ledger volume.
    arc4random_buf(out.ptr, NONCE_LEN);
    const nonce = out[0..NONCE_LEN];
    const ciphertext = out[NONCE_LEN .. NONCE_LEN + plaintext.len];
    const tag = out[NONCE_LEN + plaintext.len ..][0..TAG_LEN];

    xchacha.encrypt(ciphertext, tag, plaintext, aad, nonce.*, key);
    return out;
}

/// Open a sealed payload. Returns the decrypted plaintext (caller owns).
/// AAD MUST match what was passed to seal() — typically the row's
/// contract_id || event_kind binding. Mismatch = AuthenticationFailed.
pub fn open(
    allocator: std.mem.Allocator,
    key: [KEY_LEN]u8,
    sealed: []const u8,
    aad: []const u8,
) ![]u8 {
    if (sealed.len < NONCE_LEN + TAG_LEN) return error.SealedTooShort;
    const ct_len = sealed.len - NONCE_LEN - TAG_LEN;

    const nonce = sealed[0..NONCE_LEN];
    const ciphertext = sealed[NONCE_LEN .. NONCE_LEN + ct_len];
    const tag_slice = sealed[NONCE_LEN + ct_len ..][0..TAG_LEN];

    const out = try allocator.alloc(u8, ct_len);
    errdefer allocator.free(out);

    var nonce_arr: [NONCE_LEN]u8 = undefined;
    @memcpy(&nonce_arr, nonce);
    var tag_arr: [TAG_LEN]u8 = undefined;
    @memcpy(&tag_arr, tag_slice);

    try xchacha.decrypt(out, ciphertext, tag_arr, aad, nonce_arr, key);
    return out;
}

/// Bind AAD to a row's identity so a sealed payload cannot be replayed
/// onto a different (id, event_kind) row. Caller passes the returned
/// slice as `aad` to seal/open.
///
/// Shape: contract_id || "\x00" || event_kind  (e.g. "abc123\x00declared")
pub fn buildAad(
    allocator: std.mem.Allocator,
    contract_id: []const u8,
    event_kind: []const u8,
) ![]u8 {
    var buf = try allocator.alloc(u8, contract_id.len + 1 + event_kind.len);
    @memcpy(buf[0..contract_id.len], contract_id);
    buf[contract_id.len] = 0;
    @memcpy(buf[contract_id.len + 1 ..], event_kind);
    return buf;
}

// ──────────────────────────────────────────────────────────────────
// Tests — round-trip seal/open under real keys, AAD mismatch refusal.
// ──────────────────────────────────────────────────────────────────

test "deriveRowKey is deterministic" {
    const root = [_]u8{0x42} ** 32;
    const k1 = deriveRowKey(root, "contract-id-abc");
    const k2 = deriveRowKey(root, "contract-id-abc");
    try std.testing.expectEqualSlices(u8, &k1, &k2);
}

test "deriveRowKey separates by contract_id" {
    const root = [_]u8{0x42} ** 32;
    const k1 = deriveRowKey(root, "contract-id-abc");
    const k2 = deriveRowKey(root, "contract-id-xyz");
    try std.testing.expect(!std.mem.eql(u8, &k1, &k2));
}

test "deriveRowKey separates by root" {
    const r1 = [_]u8{0x11} ** 32;
    const r2 = [_]u8{0x22} ** 32;
    const k1 = deriveRowKey(r1, "same-id");
    const k2 = deriveRowKey(r2, "same-id");
    try std.testing.expect(!std.mem.eql(u8, &k1, &k2));
}

test "seal then open round-trips" {
    const allocator = std.testing.allocator;
    const root = [_]u8{0xa5} ** 32;
    const key = deriveRowKey(root, "abc123");
    const aad = try buildAad(allocator, "abc123", "declared");
    defer allocator.free(aad);

    const plaintext = "decalogue:purge:1 my secret truth claim";
    const sealed = try seal(allocator, key, plaintext, aad);
    defer allocator.free(sealed);

    try std.testing.expect(sealed.len == NONCE_LEN + plaintext.len + TAG_LEN);

    const opened = try open(allocator, key, sealed, aad);
    defer allocator.free(opened);
    try std.testing.expectEqualStrings(plaintext, opened);
}

test "open refuses AAD mismatch (replay across rows)" {
    const allocator = std.testing.allocator;
    const root = [_]u8{0xa5} ** 32;
    const key = deriveRowKey(root, "abc123");
    const aad_seal = try buildAad(allocator, "abc123", "declared");
    defer allocator.free(aad_seal);
    const aad_open = try buildAad(allocator, "abc123", "satisfied");
    defer allocator.free(aad_open);

    const plaintext = "row payload";
    const sealed = try seal(allocator, key, plaintext, aad_seal);
    defer allocator.free(sealed);

    try std.testing.expectError(error.AuthenticationFailed, open(allocator, key, sealed, aad_open));
}

test "open refuses wrong key" {
    const allocator = std.testing.allocator;
    const root_a = [_]u8{0xa5} ** 32;
    const root_b = [_]u8{0xb6} ** 32;
    const key_a = deriveRowKey(root_a, "abc123");
    const key_b = deriveRowKey(root_b, "abc123");
    const aad = try buildAad(allocator, "abc123", "declared");
    defer allocator.free(aad);

    const sealed = try seal(allocator, key_a, "row payload", aad);
    defer allocator.free(sealed);

    try std.testing.expectError(error.AuthenticationFailed, open(allocator, key_b, sealed, aad));
}

test "open refuses tampered ciphertext" {
    const allocator = std.testing.allocator;
    const root = [_]u8{0xa5} ** 32;
    const key = deriveRowKey(root, "abc123");
    const aad = try buildAad(allocator, "abc123", "declared");
    defer allocator.free(aad);

    const sealed = try seal(allocator, key, "row payload", aad);
    defer allocator.free(sealed);

    // Flip one ciphertext byte (just past the nonce).
    sealed[NONCE_LEN] ^= 0x01;
    try std.testing.expectError(error.AuthenticationFailed, open(allocator, key, sealed, aad));
}

test "open refuses sealed-too-short" {
    const allocator = std.testing.allocator;
    const key = [_]u8{0} ** KEY_LEN;
    const aad = "abc";
    var tiny: [10]u8 = undefined;
    try std.testing.expectError(error.SealedTooShort, open(allocator, key, tiny[0..], aad));
}
