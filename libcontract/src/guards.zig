//! guards.zig — structural guard stack at the appendRow chokepoint.
//!
//! Per Σ27 (a4e162c8) "the-binary-IS-the-interface": these guards are
//! compiled-in zig primitives, not bash bolt-ons. Σ27 supersedes Σ25's
//! "temporary scaffolding" framing — there is no temporary, only un-shipped.
//!
//! Each guard returns either `ok` (write proceeds) or `refused` (write
//! refused with a specific reason). Per-call escape lives as the
//! `guards_bypassed: [kind...]` field on the row itself (audit-logged,
//! never silent) — that is the only way past, and it leaves a trace.
//!
//! Composes:
//!   Σ23  f51aa6b4  creds-stay-at-unbrowse   (cred entropy scan)
//!   Σ24  d850aa8e  pointer-only-always      (value-shape refusal)
//!   Π11  8edd53ef  env-guard local/remote   (action-vs-env classifier)
//!   Σ20  92d756ea  self-declaring-layer     (layer-keyword tokenizer)

const std = @import("std");
const pointer = @import("pointer.zig");

pub const GuardKind = enum {
    pointer_only,
    cred_entropy,
    env_mismatch,
    layer_unsatisfied,
    thin_proof,
    audience_jargon,
    destructive_without_consent,
};

pub const GuardError = error{
    PointerRequired,
    CredentialDetected,
    EnvMismatch,
    LayerUnsatisfied,
    ProofTooThin,
    AudienceJargonLeak,
    DestructiveWithoutConsent,
};

/// Σ24 pointer-only: a `proof` or other free-text field must either be
/// a short narrative OR a recognized pointer prefix. Long unstructured
/// blobs with no pointer prefix are refused.
///
/// Pointer prefixes that count as valid: file: contract: url: machine:
/// sha256: pointer: agent: x402: bridge:
pub fn pointerOnly(field_name: []const u8, value: []const u8) GuardError!void {
    _ = field_name;
    // Empty is fine.
    if (value.len == 0) return;
    // Short narrative (<500 chars) is fine — agent annotation, not transfer.
    if (value.len < 500) return;
    // Long values must lead with a pointer prefix.
    const prefixes = [_][]const u8{
        "file:",     "contract:", "url:",   "http://", "https://",
        "machine:",  "sha256:",   "agent:", "x402:",   "bridge:",
        "pointer:",  "ssh://",    "git+",   "ipfs://",
    };
    for (prefixes) |p| {
        if (std.mem.startsWith(u8, value, p)) return;
    }
    return GuardError.PointerRequired;
}

/// Σ23 cred-scan: a field value containing high-entropy substrings that
/// look like API keys / JWTs / private keys / AWS access ids is refused.
/// Heuristic only; never silent — refusal forces escape via guards_bypassed.
pub fn credEntropy(value: []const u8) GuardError!void {
    if (value.len == 0) return;
    const sentinels = [_][]const u8{
        "sk-",       // OpenAI / Anthropic style
        "eyJ",       // JWT header base64 start
        "AKIA",      // AWS access key
        "ASIA",      // AWS session key
        "github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_",
        "xoxb-",     // Slack bot
        "xoxp-",     // Slack user
        "AIza",      // Google API key
        "v0.",       // Anthropic API key family
        "v1.",       // Anthropic API key family
        "-----BEGIN", // PEM cert/key
    };
    for (sentinels) |s| {
        if (std.mem.indexOf(u8, value, s) != null) return GuardError.CredentialDetected;
    }
}

/// Π11 env-guard: classify a pointer-type as LOCAL-required vs REMOTE-capable
/// vs AGNOSTIC, and refuse on mismatch with the current env.
/// Detection: if `has_remote_env` is false (UNBROWSE_BASE unset) and the
/// pointer is REMOTE-required, refuse.
pub fn envGuard(ptype_str: []const u8, has_remote_env: bool) GuardError!void {
    const remote_required = std.mem.eql(u8, ptype_str, "x402") or
        std.mem.eql(u8, ptype_str, "api") or
        std.mem.eql(u8, ptype_str, "agent") or
        std.mem.eql(u8, ptype_str, "bridge");
    if (remote_required and !has_remote_env) return GuardError.EnvMismatch;
}

/// Σ20 layer-keyword: scan plan text for layer-declaration keywords
/// (deploy / render / sign / RBAC / payment / LLM / lineage / mirror)
/// and surface them so the caller can verify referenced layer-gates
/// are satisfied. Returns true when keywords present (caller must then
/// verify referenced layers); false when no layer claims in the plan.
pub fn hasLayerClaims(plan: []const u8) bool {
    const keywords = [_][]const u8{
        "deploy", "render", "sign", "RBAC", "payment",
        "LLM",    "lineage", "mirror",
    };
    for (keywords) |kw| {
        if (std.mem.indexOf(u8, plan, kw) != null) return true;
    }
    return false;
}

/// Fear-of-Lord (Prov 9:10) + Be-ye-perfect (Matt 5:48): refuse a `--proof`
/// shorter than MIN_PROOF_CHARS that doesn't lead with a recognized pointer
/// prefix. Trivial proofs ("ok", "done", "pass") indistinguishable from
/// rubber-stamping; the substrate forces either a substantive narrative OR
/// a pointer to evidence.
///
/// Empty proof is NOT this guard's concern — that path is governed by the
/// existing PROOF REQUIRED refusal in mark_satisfied.
pub const MIN_PROOF_CHARS: usize = 20;
pub fn thinProof(value: []const u8) GuardError!void {
    // Empty handled upstream by PROOF REQUIRED; not this guard's scope.
    if (value.len == 0) return;
    // Pointer-prefixed proofs accepted at any length — the pointer IS the evidence.
    const prefixes = [_][]const u8{
        "file:",     "contract:", "url:",   "http://", "https://",
        "machine:",  "sha256:",   "agent:", "x402:",   "bridge:",
        "pointer:",  "ssh://",    "git+",   "ipfs://",
    };
    for (prefixes) |p| {
        if (std.mem.startsWith(u8, value, p)) return;
    }
    // Otherwise enforce minimum narrative length.
    if (value.len < MIN_PROOF_CHARS) return GuardError.ProofTooThin;
}

/// Render-unto-Caesar (Matt 22:21) + Aiko-voice rule #3 (no substrate jargon
/// in public): refuse when audience == "public" and the content contains L1
/// substrate vocabulary that should never leak past the Σ2 boundary.
///
/// Caller passes audience as ?[]const u8; null means "not public, skip".
pub fn audienceJargon(content: []const u8, audience: ?[]const u8) GuardError!void {
    const tier = audience orelse return;
    if (!std.mem.eql(u8, tier, "public")) return;
    if (content.len == 0) return;
    const jargon = [_][]const u8{
        "cell-gate", "funnel-gate", "iterate ",  "_mark ",     "KEY 1", "KEY 2",
        "KEY 3",     "quorum:",     "wavefront", "refractory", " supersede ", "agent-judges",
        "funnel-first",
    };
    for (jargon) |kw| {
        if (std.mem.indexOf(u8, content, kw) != null) return GuardError.AudienceJargonLeak;
    }
}

/// Σ32a Peace (Galatians 5:22) + Aiko voice rule 4 (ask before irreversible):
/// refuse action strings containing destructive verbs unless `has_consent`
/// is true. Bytes-falsifiable substring scan: agent decides what nuance
/// stays in KEY 2 (e.g. "git stash drop" is destructive but routine).
/// Composes Σ31 binary-vs-doctrine + the existing audit-trail discipline.
pub fn peace(action: []const u8, has_consent: bool) GuardError!void {
    if (action.len == 0) return;
    if (has_consent) return; // explicit --consent or guards_bypassed: [destructive_without_consent]
    const destructive = [_][]const u8{
        "rm -rf",
        "rm -fr",
        " --force-with-lease",
        " --force ",
        " push --force",
        " push -f ",
        "DROP TABLE",
        "DROP DATABASE",
        "TRUNCATE TABLE",
        "DELETE FROM",
        "git reset --hard",
        "git clean -fd",
        "git branch -D",
        ":> /dev/", // accidental zero-out
        "shred ",
        "wipefs ",
        "mkfs.",
        "dd if=/dev/zero of=",
    };
    for (destructive) |d| {
        if (std.mem.indexOf(u8, action, d) != null) return GuardError.DestructiveWithoutConsent;
    }
}

/// Run the full guard stack against a (plan, action, proof, audience) tuple.
/// `bypassed` is the set of GuardKind values explicitly bypassed by the
/// caller via the `guards_bypassed` row field; each bypass is audited.
pub fn runStack(
    plan: []const u8,
    action: []const u8,
    proof: ?[]const u8,
    has_remote_env: bool,
    bypassed: []const GuardKind,
    audience: ?[]const u8,
) GuardError!void {
    const has = struct {
        fn check(needle: GuardKind, haystack: []const GuardKind) bool {
            for (haystack) |h| if (h == needle) return true;
            return false;
        }
    };

    // Σ23 cred-scan on plan, action, proof
    if (!has.check(.cred_entropy, bypassed)) {
        try credEntropy(plan);
        try credEntropy(action);
        if (proof) |p| try credEntropy(p);
    }
    // Σ24 pointer-only on proof
    if (!has.check(.pointer_only, bypassed)) {
        if (proof) |p| try pointerOnly("proof", p);
    }
    // Π11 env-guard on inferred ptype
    if (!has.check(.env_mismatch, bypassed)) {
        const ptype = pointer.inferPointerType(action);
        try envGuard(ptype, has_remote_env);
    }
    // Fear-of-Lord thin-proof refusal
    if (!has.check(.thin_proof, bypassed)) {
        if (proof) |p| try thinProof(p);
    }
    // Render-unto-Caesar audience-jargon refusal
    if (!has.check(.audience_jargon, bypassed)) {
        try audienceJargon(plan, audience);
        if (proof) |p| try audienceJargon(p, audience);
    }
    // Σ32a Peace — destructive op without consent; bypass via guards_bypassed
    // = [destructive_without_consent], which IS the explicit consent path.
    if (!has.check(.destructive_without_consent, bypassed)) {
        try peace(action, false);
    }
    // Σ20 layer-claims: surface only (caller decides on action). This guard
    // doesn't refuse on its own — it's an evidence emitter for the caller.
    _ = has.check(.layer_unsatisfied, bypassed);
}

// ─────────────────────────────────────────────────────────────────────────
// Tests — Σ27 binding: every guard has an inline test that proves the
// failure mode AND the bypass path. No external verb-gates/<name>/verify.sh
// folder needed. `zig build test` IS the verification surface.

test "pointerOnly: short narrative passes" {
    try pointerOnly("proof", "short narrative is fine");
}

test "pointerOnly: long value with pointer prefix passes" {
    var buf: [600]u8 = undefined;
    @memset(&buf, 'x');
    @memcpy(buf[0..9], "contract:");
    try pointerOnly("proof", buf[0..]);
}

test "pointerOnly: long value without pointer prefix refused" {
    var buf: [600]u8 = undefined;
    @memset(&buf, 'x');
    try std.testing.expectError(GuardError.PointerRequired, pointerOnly("proof", buf[0..]));
}

test "credEntropy: clean string passes" {
    try credEntropy("normal agent commentary about a contract");
}

test "credEntropy: sk- prefix refused" {
    try std.testing.expectError(GuardError.CredentialDetected, credEntropy("here is the key sk-proj-abc123def456"));
}

test "credEntropy: JWT-like substring refused" {
    try std.testing.expectError(GuardError.CredentialDetected, credEntropy("token eyJhbGciOiJIUzI1NiJ9 attached"));
}

test "credEntropy: AWS access key refused" {
    try std.testing.expectError(GuardError.CredentialDetected, credEntropy("AKIAIOSFODNN7EXAMPLE leaked"));
}

test "envGuard: x402 action in local-only env refused" {
    try std.testing.expectError(GuardError.EnvMismatch, envGuard("x402", false));
}

test "envGuard: x402 action with remote env passes" {
    try envGuard("x402", true);
}

test "envGuard: cli action passes regardless of env" {
    try envGuard("cli", false);
    try envGuard("cli", true);
}

test "hasLayerClaims: deploy keyword detected" {
    try std.testing.expect(hasLayerClaims("deploy the new gate to staging"));
}

test "hasLayerClaims: payment keyword detected" {
    try std.testing.expect(hasLayerClaims("monthly payment via x402"));
}

test "hasLayerClaims: clean plan returns false" {
    try std.testing.expect(!hasLayerClaims("verify the unit test passes"));
}

test "runStack: full clean triple passes" {
    try runStack("verify the test passes", "agent-judges", "pointer:contract:deadbeef", true, &[_]GuardKind{}, null);
}

test "runStack: cred in plan refused" {
    try std.testing.expectError(GuardError.CredentialDetected, runStack("here is sk-proj-leaked-key", "agent-judges", null, true, &[_]GuardKind{}, null));
}

test "runStack: cred bypass with explicit audit" {
    try runStack("here is sk-proj-leaked-key", "agent-judges", null, true, &[_]GuardKind{.cred_entropy}, null);
}

test "runStack: env mismatch refused" {
    try std.testing.expectError(GuardError.EnvMismatch, runStack("ok", "x402:https://example", null, false, &[_]GuardKind{}, null));
}

// ─── thinProof tests (Fear-of-Lord / Be-ye-perfect) ───

test "thinProof: empty proof passes (handled upstream)" {
    try thinProof("");
}

test "thinProof: substantive narrative passes" {
    try thinProof("served-surface verify exit 0 across 4 routes");
}

test "thinProof: trivial 'ok' refused" {
    try std.testing.expectError(GuardError.ProofTooThin, thinProof("ok"));
}

test "thinProof: trivial 'done' refused" {
    try std.testing.expectError(GuardError.ProofTooThin, thinProof("done"));
}

test "thinProof: short pointer-prefixed passes" {
    try thinProof("contract:abc12345");
}

test "thinProof: short sha256-prefixed passes" {
    try thinProof("sha256:04e7");
}

test "thinProof: 19-char narrative refused (boundary)" {
    try std.testing.expectError(GuardError.ProofTooThin, thinProof("nineteen-char-prfx!"));
}

test "thinProof: 20-char narrative passes (boundary)" {
    try thinProof("twenty-char-prefix-x");
}

// ─── audienceJargon tests (Render-unto-Caesar / Aiko-voice rule 3) ───

test "audienceJargon: null audience skipped" {
    try audienceJargon("KEY 2 in-thread judgment fired", null);
}

test "audienceJargon: team tier skipped" {
    try audienceJargon("KEY 2 in-thread judgment fired", "team");
}

test "audienceJargon: private tier skipped" {
    try audienceJargon("the funnel-first row resolved", "private");
}

test "audienceJargon: clean public content passes" {
    try audienceJargon("she finishes by tomorrow", "public");
}

test "audienceJargon: 'KEY 2' leak refused" {
    try std.testing.expectError(GuardError.AudienceJargonLeak, audienceJargon("KEY 2 judgment required", "public"));
}

test "audienceJargon: 'wavefront' leak refused" {
    try std.testing.expectError(GuardError.AudienceJargonLeak, audienceJargon("the wavefront fired", "public"));
}

test "audienceJargon: 'refractory' leak refused" {
    try std.testing.expectError(GuardError.AudienceJargonLeak, audienceJargon("refractory period before propagation", "public"));
}

// ─── runStack integration with new guards ───

test "runStack: thin proof refused via stack" {
    try std.testing.expectError(GuardError.ProofTooThin, runStack("the plan", "agent-judges", "ok", true, &[_]GuardKind{}, null));
}

test "runStack: thin proof bypass with explicit audit" {
    try runStack("the plan", "agent-judges", "ok", true, &[_]GuardKind{.thin_proof}, null);
}

test "runStack: audience jargon refused via stack" {
    try std.testing.expectError(GuardError.AudienceJargonLeak, runStack("KEY 2 in plan to public", "agent-judges", null, true, &[_]GuardKind{}, "public"));
}

test "runStack: audience jargon bypass with explicit audit" {
    try runStack("KEY 2 in plan to public", "agent-judges", null, true, &[_]GuardKind{.audience_jargon}, "public");
}

test "runStack: audience jargon in proof refused" {
    try std.testing.expectError(GuardError.AudienceJargonLeak, runStack("clean plan", "agent-judges", "the funnel-first row resolved", true, &[_]GuardKind{}, "public"));
}

test "peace: empty action passes" {
    try peace("", false);
}

test "peace: benign action passes" {
    try peace("npm test", false);
}

test "peace: rm -rf refused without consent" {
    try std.testing.expectError(GuardError.DestructiveWithoutConsent, peace("rm -rf /tmp/scratch", false));
}

test "peace: git push --force refused without consent" {
    try std.testing.expectError(GuardError.DestructiveWithoutConsent, peace("git push --force origin main", false));
}

test "peace: DROP TABLE refused without consent" {
    try std.testing.expectError(GuardError.DestructiveWithoutConsent, peace("psql -c 'DROP TABLE users'", false));
}

test "peace: explicit consent passes destructive" {
    try peace("rm -rf /tmp/scratch", true);
}

test "runStack: destructive action refused" {
    try std.testing.expectError(GuardError.DestructiveWithoutConsent, runStack("clear scratch dir", "rm -rf /tmp/scratch", null, true, &[_]GuardKind{}, null));
}

test "runStack: destructive bypass with explicit audit" {
    try runStack("clear scratch dir", "rm -rf /tmp/scratch", null, true, &[_]GuardKind{.destructive_without_consent}, null);
}
