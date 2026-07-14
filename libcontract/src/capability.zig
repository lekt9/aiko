//! capability.zig — the one receptor machinery for value adoption (F1).
//!
//! Biology: a cell responds to a ligand ONLY through a receptor it expresses.
//! Not by descent (a paracrine signal reaches an unrelated cell if the receptor
//! fits) and not by anyone-grabs (a receptor-blind cell simply does not respond).
//! Specificity is the receptor's shape, not lineage.
//!
//! Substrate: a consumer adopts a producer's value (contract:/fulfil:/value-of:)
//! ONLY through a signed capability grant — the receptor. No matching valid
//! grant ⇒ no adoption. A grant may name a non-descendant grantee, so
//! cross-lineage reuse survives when the producer explicitly grants it; but a
//! stranger who merely knows the producer's id can no longer adopt its value.
//!
//! This is the OCAP doctrine made real ("no grant = no read; no ambient
//! authority" — SKILL.md Capability inheritance). It is ONE authority, the way
//! terminal.zig is the one apoptosis machinery: every adoption decision routes
//! through `authorizes` here, never through an ad-hoc grant check.
//!
//! Scripture: 1 Corinthians 12:17 — "If the whole body were an eye, where were
//! the hearing?" (differentiated receptors, not one undifferentiated read
//! surface). John 10:3 — "to him the porter openeth; and the sheep hear his
//! voice" (only the recognized signal is admitted). The receptor is grounded in
//! the deployer root that signs FOR the Word (John 17:17), not in the id alone.

const std = @import("std");
const lineage = @import("lineage.zig");
const sha256 = std.crypto.hash.sha2.Sha256;

/// A capability grant, as the resolver views it (decoupled from any Row struct
/// so it is unit-testable without the ledger — the caller adapts its rows).
pub const Grant = struct {
    /// Who issued the grant (the authority: the producer, or an ancestor of it).
    granter_id: []const u8,
    /// Who may adopt: an exact contract id, a glob ("team:*"), or an ancestor
    /// id (a grant to an ancestor authorizes its whole descending line).
    grantee: []const u8,
    /// What may be adopted: an exact producer id, or a glob ("stripe:*").
    scope: []const u8,
    /// The granter's env_pubkey (64-hex) — verifies `authority_signature`.
    authority_pubkey: []const u8,
    /// ed25519 signature (128-hex) by the granter over `grantDigest`.
    authority_signature: []const u8,
};

/// Canonical bytes a grant's `authority_signature` signs over:
///   sha256(granter_id \0 grantee \0 scope)
/// NUL-framed so field boundaries cannot be shifted (a\0bc ≠ ab\0c).
pub fn grantDigest(
    granter_id: []const u8,
    grantee: []const u8,
    scope: []const u8,
    out: *[32]u8,
) void {
    var h = sha256.init(.{});
    h.update(granter_id);
    h.update(&[_]u8{0});
    h.update(grantee);
    h.update(&[_]u8{0});
    h.update(scope);
    h.final(out);
}

/// Sign a grant with the granter's derived keypair; writes 128-hex into `out`.
pub fn signGrant(
    granter_kp: std.crypto.sign.Ed25519.KeyPair,
    granter_id: []const u8,
    grantee: []const u8,
    scope: []const u8,
    out: *[lineage.SIG_HEX_LEN]u8,
) !void {
    var d: [32]u8 = undefined;
    grantDigest(granter_id, grantee, scope, &d);
    try lineage.signDigest(granter_kp, d, out);
}

/// Is the grant genuinely issued by its named authority? Verifies the
/// ed25519 signature over the canonical grant digest. A forged or tampered
/// grant (any of granter_id/grantee/scope/sig altered) fails closed.
pub fn grantSelfValid(g: Grant) bool {
    var d: [32]u8 = undefined;
    grantDigest(g.granter_id, g.grantee, g.scope, &d);
    lineage.verifyDigest(g.authority_signature, g.authority_pubkey, d) catch return false;
    return true;
}

/// Glob match: a `pattern` ending in '*' is a prefix wildcard ("stripe:*"
/// matches "stripe:charge"); otherwise it is an exact match. An empty pattern
/// matches nothing (a receptor with no shape binds no ligand). A lone "*"
/// matches anything (deliberately — a producer that grants "*" is public).
pub fn scopeMatch(pattern: []const u8, target: []const u8) bool {
    if (pattern.len == 0) return false;
    if (pattern[pattern.len - 1] == '*') {
        return std.mem.startsWith(u8, target, pattern[0 .. pattern.len - 1]);
    }
    return std.mem.eql(u8, pattern, target);
}

/// Ancestry view: (id, parent_id) pairs. parent_id "" means root. Decoupled
/// from Row so lineage matching is unit-testable in isolation.
pub const Ancestry = struct {
    pairs: []const [2][]const u8,

    pub fn parentOf(self: Ancestry, id: []const u8) ?[]const u8 {
        for (self.pairs) |p| {
            if (std.mem.eql(u8, p[0], id)) {
                return if (p[1].len == 0) null else p[1];
            }
        }
        return null;
    }
};

/// Does `consumer` satisfy the grantee spec? True if the grantee exactly
/// names it, a glob matches it, OR the consumer descends from the grantee
/// (a grant to an ancestor authorizes its line — the biological "this whole
/// tissue expresses the receptor"). Cycle-guarded.
pub fn granteeMatches(grantee: []const u8, consumer_id: []const u8, anc: Ancestry) bool {
    if (scopeMatch(grantee, consumer_id)) return true;
    var cur: ?[]const u8 = consumer_id;
    var hops: usize = 0;
    while (cur) |c| : (hops += 1) {
        if (hops > 4096) break; // malformed-cycle guard
        if (std.mem.eql(u8, c, grantee)) return true;
        cur = anc.parentOf(c);
    }
    return false;
}

/// THE receptor decision: may `consumer` adopt `producer`'s value?
/// Requires at least one grant whose scope matches the producer, whose grantee
/// matches the consumer (id / glob / lineage), AND whose authority signature
/// verifies. No such grant ⇒ false ⇒ the consumer HOLDs (no adoption).
/// This is the single gate every value-adoption path must route through.
pub fn authorizes(
    grants: []const Grant,
    consumer_id: []const u8,
    producer_id: []const u8,
    anc: Ancestry,
) bool {
    for (grants) |g| {
        if (!scopeMatch(g.scope, producer_id)) continue;
        if (!granteeMatches(g.grantee, consumer_id, anc)) continue;
        if (!grantSelfValid(g)) continue; // verify last: cheapest filters first
        return true;
    }
    return false;
}

/// OPT-IN receptor gate (F1). `producer_scoped_grants` is the set of adoption
/// grants whose scope matches the producer being adopted. If the producer has
/// declared NO restriction (empty set) adoption is OPEN — the substrate's
/// existing cross-lineage peer-reference model is preserved untouched. Once a
/// producer opts in (≥1 signed grant scoped to it), only a consumer that a
/// valid grant authorizes may adopt; all others are refused. Default-open is
/// what makes wiring this non-breaking: a cell with no expressed restriction
/// ligand is public until it differentiates.
pub fn adoptionAllowed(
    producer_scoped_grants: []const Grant,
    consumer_id: []const u8,
    producer_id: []const u8,
    anc: Ancestry,
) bool {
    if (producer_scoped_grants.len == 0) return true; // no receptor declared → open
    return authorizes(producer_scoped_grants, consumer_id, producer_id, anc);
}

// ── tests ────────────────────────────────────────────────────────────────

test "scopeMatch: exact, prefix-glob, empty, lone-star" {
    try std.testing.expect(scopeMatch("abc12345", "abc12345"));
    try std.testing.expect(!scopeMatch("abc12345", "abc12346"));
    try std.testing.expect(scopeMatch("stripe:*", "stripe:charge"));
    try std.testing.expect(scopeMatch("stripe:*", "stripe:")); // boundary
    try std.testing.expect(!scopeMatch("stripe:*", "strip")); // shorter than prefix
    try std.testing.expect(!scopeMatch("stripe:*", "paypal:x"));
    try std.testing.expect(!scopeMatch("", "anything")); // no-shape receptor binds nothing
    try std.testing.expect(scopeMatch("*", "literally-anything"));
}

test "granteeMatches: exact, glob, and lineage descent" {
    const anc = Ancestry{ .pairs = &.{
        .{ "grandchild", "child" },
        .{ "child", "root0000" },
        .{ "root0000", "" },
        .{ "stranger", "" },
    } };
    // exact
    try std.testing.expect(granteeMatches("child", "child", anc));
    // glob
    try std.testing.expect(granteeMatches("chi*", "child", anc));
    // lineage: grant to an ancestor authorizes a descendant
    try std.testing.expect(granteeMatches("root0000", "grandchild", anc));
    try std.testing.expect(granteeMatches("child", "grandchild", anc));
    // a lineage-stranger is NOT authorized by an ancestor grant
    try std.testing.expect(!granteeMatches("child", "stranger", anc));
    try std.testing.expect(!granteeMatches("root0000", "stranger", anc));
}

test "authorizes: a real signed grant admits, a forged/mismatched one does not" {
    // Deterministic root → derive the granter (producer's authority) keypair.
    const root = [_]u8{7} ** 32;
    const granter_id = "prod0001";
    const kp = try lineage.deriveKeyPair(root, granter_id);
    var pk_hex: [lineage.PUBKEY_HEX_LEN]u8 = undefined;
    lineage.bytesToHex(&kp.public_key.bytes, &pk_hex);

    const consumer_id = "cons0001";
    // Producer grants consumer_id the right to adopt producer prod0001's value.
    var sig_hex: [lineage.SIG_HEX_LEN]u8 = undefined;
    try signGrant(kp, granter_id, consumer_id, granter_id, &sig_hex);

    const good = Grant{
        .granter_id = granter_id,
        .grantee = consumer_id,
        .scope = granter_id, // scope = the producer id being adopted
        .authority_pubkey = &pk_hex,
        .authority_signature = &sig_hex,
    };
    const empty_anc = Ancestry{ .pairs = &.{} };

    // 1. valid grant → adoption authorized
    try std.testing.expect(authorizes(&.{good}, consumer_id, granter_id, empty_anc));

    // 2. no grant at all → HOLD
    try std.testing.expect(!authorizes(&.{}, consumer_id, granter_id, empty_anc));

    // 3. a DIFFERENT consumer (not the grantee, no lineage) → not authorized
    try std.testing.expect(!authorizes(&.{good}, "other001", granter_id, empty_anc));

    // 4. a DIFFERENT producer (scope mismatch) → not authorized
    try std.testing.expect(!authorizes(&.{good}, consumer_id, "prod9999", empty_anc));

    // 5. tampered signature (flip one hex char) → signature fails → not authorized
    var bad_sig = sig_hex;
    bad_sig[0] = if (bad_sig[0] == 'a') 'b' else 'a';
    const forged = Grant{
        .granter_id = granter_id,
        .grantee = consumer_id,
        .scope = granter_id,
        .authority_pubkey = &pk_hex,
        .authority_signature = &bad_sig,
    };
    try std.testing.expect(!authorizes(&.{forged}, consumer_id, granter_id, empty_anc));

    // 6. scope/grantee substituted under the SAME signature (field-shift forgery)
    //    → digest changes → signature no longer matches → not authorized.
    const shifted = Grant{
        .granter_id = granter_id,
        .grantee = "cons0002", // attacker rewrites the grantee to themselves
        .scope = granter_id,
        .authority_pubkey = &pk_hex,
        .authority_signature = &sig_hex,
    };
    try std.testing.expect(!authorizes(&.{shifted}, "cons0002", granter_id, empty_anc));
}

test "adoptionAllowed: OPEN when no restriction, gated once opted in" {
    const empty_anc = Ancestry{ .pairs = &.{} };
    const root = [_]u8{9} ** 32;
    const producer = "prodAAAA";
    const kp = try lineage.deriveKeyPair(root, producer);
    var pk_hex: [lineage.PUBKEY_HEX_LEN]u8 = undefined;
    lineage.bytesToHex(&kp.public_key.bytes, &pk_hex);

    // No restriction declared → any consumer may adopt (non-breaking default).
    try std.testing.expect(adoptionAllowed(&.{}, "anyone01", producer, empty_anc));
    try std.testing.expect(adoptionAllowed(&.{}, "stranger", producer, empty_anc));

    // Producer opts in: grants only "friend01" the right to adopt.
    var sig: [lineage.SIG_HEX_LEN]u8 = undefined;
    try signGrant(kp, producer, "friend01", producer, &sig);
    const g = Grant{
        .granter_id = producer,
        .grantee = "friend01",
        .scope = producer,
        .authority_pubkey = &pk_hex,
        .authority_signature = &sig,
    };
    // Now the receptor is expressed: the grantee adopts, a stranger is refused.
    try std.testing.expect(adoptionAllowed(&.{g}, "friend01", producer, empty_anc));
    try std.testing.expect(!adoptionAllowed(&.{g}, "stranger", producer, empty_anc));
}
