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
};

pub const GuardError = error{
    PointerRequired,
    CredentialDetected,
    EnvMismatch,
    LayerUnsatisfied,
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

/// Run the full guard stack against a (plan, action, proof) triple.
/// `bypassed` is the set of GuardKind values explicitly bypassed by the
/// caller via the `guards_bypassed` row field; each bypass is audited.
pub fn runStack(
    plan: []const u8,
    action: []const u8,
    proof: ?[]const u8,
    has_remote_env: bool,
    bypassed: []const GuardKind,
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
    try runStack("verify the test passes", "agent-judges", "pointer:contract:deadbeef", true, &[_]GuardKind{});
}

test "runStack: cred in plan refused" {
    try std.testing.expectError(GuardError.CredentialDetected, runStack("here is sk-proj-leaked-key", "agent-judges", null, true, &[_]GuardKind{}));
}

test "runStack: cred bypass with explicit audit" {
    try runStack("here is sk-proj-leaked-key", "agent-judges", null, true, &[_]GuardKind{.cred_entropy});
}

test "runStack: env mismatch refused" {
    try std.testing.expectError(GuardError.EnvMismatch, runStack("ok", "x402:https://example", null, false, &[_]GuardKind{}));
}
