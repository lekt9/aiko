//! gate.zig — the tool-authority policy: may THIS tool call run, given the open
//! contract scope? Three-way: allow | confirm | deny.
//!
//! This is the SIGNED CANONICAL policy. aiko-cli's gate.ts `tsMirror` mirrors it
//! byte-for-byte, so a run behaves identically whether or not the dylib is
//! loaded — the dylib just makes the *authority* signed code instead of a TS
//! reimplementation. c_abi.zig exports it as `contract_gate`.
//!
//! Distinct from capability.authorizes() — that is the value-adoption receptor
//! (signed grants, F1 opt-in). THIS gate is command-risk: catastrophic patterns
//! are refused, destructive/outward ones require confirmation, and an unscoped
//! call is refused outright (fail-closed — no tool runs off-contract).
const std = @import("std");

pub const Decision = enum { allow, confirm, deny };
pub const Result = struct {
    decision: Decision,
    risk: []const u8,
    reason: []const u8,
};

/// Catastrophic → deny outright. Mirror of gate.ts CATASTROPHIC (exact bytes).
const CATASTROPHIC = [_][]const u8{
    "rm -rf /\"",
    "rm -rf / ",
    "rm -rf /*",
    "mkfs",
    ":(){",
    "of=/dev/sd",
    "of=/dev/disk",
    "> /dev/sda",
};

/// Destructive / outward-facing → confirm first. Mirror of gate.ts RISKY.
const RISKY = [_][]const u8{
    "rm -r",      "rm -f",        "force-push",  "force push", "git push",
    "deploy",     "wrangler",     "npm publish", "publish",    "shutdown",
    "reboot",     "wallet",       "payment",     "purchase",   "transfer",
    "send email", "send message", "send file",   "send money",
};

fn containsCi(haystack: []const u8, needle: []const u8) bool {
    if (needle.len == 0) return true;
    if (needle.len > haystack.len) return false;
    var i: usize = 0;
    while (i + needle.len <= haystack.len) : (i += 1) {
        var j: usize = 0;
        while (j < needle.len and std.ascii.toLower(haystack[i + j]) == std.ascii.toLower(needle[j])) : (j += 1) {}
        if (j == needle.len) return true;
    }
    return false;
}

/// The policy. `scope` == "" → deny (fail-closed: no open contract scope).
pub fn decide(scope: []const u8, tool: []const u8, args_json: []const u8) Result {
    if (scope.len == 0)
        return .{ .decision = .deny, .risk = "unscoped", .reason = "no open contract scope — tool refused" };
    for (CATASTROPHIC) |p| {
        if (containsCi(args_json, p))
            return .{ .decision = .deny, .risk = "catastrophic", .reason = "catastrophic command pattern — refused" };
    }
    for (RISKY) |p| {
        if (containsCi(args_json, p) or containsCi(tool, p))
            return .{ .decision = .confirm, .risk = "elevated", .reason = "destructive/outward intent — confirm required" };
    }
    return .{ .decision = .allow, .risk = "none", .reason = "within scope, no elevated risk" };
}

pub fn decisionStr(d: Decision) []const u8 {
    return switch (d) {
        .allow => "allow",
        .confirm => "confirm",
        .deny => "deny",
    };
}

// ── tests ────────────────────────────────────────────────────────────────
test "unscoped call is refused (fail-closed)" {
    const r = decide("", "Bash", "{\"cmd\":\"ls\"}");
    try std.testing.expectEqual(Decision.deny, r.decision);
    try std.testing.expectEqualStrings("unscoped", r.risk);
}

test "catastrophic pattern is denied even within scope" {
    const r = decide("turn:abcd1234", "Bash", "{\"cmd\":\"rm -rf /*\"}");
    try std.testing.expectEqual(Decision.deny, r.decision);
    try std.testing.expectEqualStrings("catastrophic", r.risk);
}

test "destructive/outward pattern requires confirm" {
    const r = decide("turn:abcd1234", "Bash", "{\"cmd\":\"git push --force\"}");
    try std.testing.expectEqual(Decision.confirm, r.decision);
    try std.testing.expectEqualStrings("elevated", r.risk);
}

test "risky pattern in the TOOL name also confirms" {
    const r = decide("turn:abcd1234", "deploy", "{}");
    try std.testing.expectEqual(Decision.confirm, r.decision);
}

test "ordinary call within scope is allowed" {
    const r = decide("turn:abcd1234", "Read", "{\"path\":\"a.txt\"}");
    try std.testing.expectEqual(Decision.allow, r.decision);
    try std.testing.expectEqualStrings("none", r.risk);
}

test "case-insensitive matching (RM -RF matches rm -rf)" {
    const r = decide("turn:abcd1234", "Bash", "{\"cmd\":\"RM -RF /*\"}");
    try std.testing.expectEqual(Decision.deny, r.decision);
}
