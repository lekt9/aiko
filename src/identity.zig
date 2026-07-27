//! Node identity and account delegation for the neuron-native mesh.
//!
//! An account IS a root Ed25519 keypair — there is no password database.
//! Every machine in the mesh holds a device keypair, and the account root
//! issues signed, attenuated delegations to its devices (§24: delegation may
//! only narrow). A cross-node envelope is honored only when its proof chain
//! verifies: account root → device key → this firing's capabilities. The
//! receiving node additionally clamps the proof against the trust ceiling it
//! has pinned locally for that account root, so a stolen or over-broad proof
//! fails closed at admission (§20 step 1).

const std = @import("std");
const caps_mod = @import("caps.zig");

const Allocator = std.mem.Allocator;

pub const Ed25519 = std.crypto.sign.Ed25519;

/// A node id is the raw Ed25519 public key. Nodes are addressed as
/// `node/<hex>`; there is no other identity registry.
pub const NodeId = [32]u8;
pub const SignatureBytes = [64]u8;

pub fn generateKeyPair(io: std.Io) Ed25519.KeyPair {
    return Ed25519.KeyPair.generate(io);
}

pub fn keyPairFromSeed(seed: [32]u8) !Ed25519.KeyPair {
    return Ed25519.KeyPair.generateDeterministic(seed);
}

pub fn publicKeyId(keys: *const Ed25519.KeyPair) NodeId {
    return keys.public_key.toBytes();
}

pub fn nodeIdHex(id: NodeId, out: *[64]u8) []const u8 {
    const hex = std.fmt.bytesToHex(id, .lower);
    @memcpy(out, &hex);
    return out[0..64];
}

pub fn nodeIdFromHex(text: []const u8) !NodeId {
    if (text.len != 64) return error.InvalidNodeId;
    var out: NodeId = undefined;
    _ = try std.fmt.hexToBytes(&out, text);
    return out;
}

/// A signed capability grant from an account root to one device key.
/// Canonical bytes: account ‖ device ‖ caps fingerprint ‖ expires (BE u64).
/// The signature is by the account root secret key; attenuation against the
/// receiver's local trust ceiling is checked at admission, not here.
pub const Delegation = struct {
    account: NodeId,
    device: NodeId,
    caps: caps_mod.Caps,
    expires_ms: u64,
    signature: SignatureBytes,

    pub fn canonicalBytes(self: *const Delegation, out: *[96 + 8]u8) []const u8 {
        @memcpy(out[0..32], &self.account);
        @memcpy(out[32..64], &self.device);
        @memcpy(out[64..96], &caps_mod.fingerprint(self.caps));
        std.mem.writeInt(u64, out[96..104], self.expires_ms, .big);
        return out[0..104];
    }
};

/// The account root issues a narrowed grant to a device. Callers SHOULD pass
/// caps already attenuated relative to what the account itself may do;
/// receivers enforce their own ceiling regardless (§24).
pub fn issueDelegation(
    account_keys: *const Ed25519.KeyPair,
    device: NodeId,
    caps: caps_mod.Caps,
    expires_ms: u64,
) !Delegation {
    var delegation: Delegation = .{
        .account = publicKeyId(account_keys),
        .device = device,
        .caps = caps,
        .expires_ms = expires_ms,
        .signature = undefined,
    };
    var canonical: [104]u8 = undefined;
    const bytes = delegation.canonicalBytes(&canonical);
    const signature = try account_keys.sign(bytes, null);
    delegation.signature = signature.toBytes();
    return delegation;
}

/// Verify the proof chain link: the account root really signed this grant to
/// this device, and the grant is still inside its validity window.
pub fn verifyDelegation(delegation: *const Delegation, now_ms: u64) !void {
    if (now_ms > delegation.expires_ms) return error.ExpiredDelegation;
    var canonical: [104]u8 = undefined;
    const bytes = delegation.canonicalBytes(&canonical);
    const public_key = try Ed25519.PublicKey.fromBytes(delegation.account);
    const signature = Ed25519.Signature.fromBytes(delegation.signature);
    try signature.verify(bytes, public_key);
}
