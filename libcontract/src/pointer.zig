//! Native pointer-type inference + contract:<id> ref extraction.
const std = @import("std");

/// Infer the native pointer type from an action string. Only mechanically
/// implemented composition shapes receive a distinct type; everything else is
/// a cell unless it is plainly a URL/API action.
pub fn inferPointerType(action: []const u8) []const u8 {
    if (std.mem.eql(u8, action, "neuron")) return "neuron";
    if (std.mem.eql(u8, action, "children-satisfy") or std.mem.eql(u8, action, "funnel")) return "funnel";
    if (std.mem.eql(u8, action, "funnel-first")) return "funnel-first";
    if (std.mem.eql(u8, action, "sequence")) return "sequence";
    if (std.mem.startsWith(u8, action, "quorum:")) return "quorum";
    if (std.mem.startsWith(u8, action, "contract:")) return "contract-ref";
    if (std.mem.startsWith(u8, action, "loop-until:")) return "loop";
    if (std.mem.startsWith(u8, action, "harness:")) return "harness";
    if (std.mem.startsWith(u8, action, "webhook:")) return "webhook";
    if (std.mem.startsWith(u8, action, "wallet:")) return "wallet";
    if (std.mem.startsWith(u8, action, "embedding:")) return "embedding";
    if (std.mem.startsWith(u8, action, "tunnel:")) return "tunnel";
    if (std.mem.startsWith(u8, action, "x402:")) return "x402";
    if (std.mem.startsWith(u8, action, "agent:")) return "agent";
    if (std.mem.startsWith(u8, action, "machine:")) return "machine";
    if (std.mem.startsWith(u8, action, "inhibits:")) return "inhibits";
    if (std.mem.startsWith(u8, action, "bind:")) return "bind";
    if (std.mem.startsWith(u8, action, "posthook:")) return "posthook";
    if (std.mem.startsWith(u8, action, "prehook:")) return "prehook";
    if (std.mem.startsWith(u8, action, "blocked_by:")) return "blocked_by";
    if (std.mem.startsWith(u8, action, "curl ") or
        std.mem.startsWith(u8, action, "http://") or
        std.mem.startsWith(u8, action, "https://") or
        std.mem.startsWith(u8, action, "wget ")) return "api";
    return "cli";
}

/// Native layer inference for the minimal shape catalog.
/// Layer convention (contract:d10b3dbb): 1=system, 2=cell, 3=graph,
/// 4=transport, 5=value, 6=operator.
pub fn inferLayer(action: []const u8) i32 {
    const pt = inferPointerType(action);
    if (std.mem.eql(u8, pt, "cli") and std.mem.indexOf(u8, action, "wait-for-event") != null) return 4;
    if (std.mem.eql(u8, pt, "funnel")) return 3;
    if (std.mem.eql(u8, pt, "neuron")) return 3;
    if (std.mem.eql(u8, pt, "funnel-first")) return 3;
    if (std.mem.eql(u8, pt, "sequence")) return 3;
    if (std.mem.eql(u8, pt, "quorum")) return 3;
    if (std.mem.eql(u8, pt, "contract-ref")) return 3;
    if (std.mem.eql(u8, pt, "inhibits")) return 3;
    if (std.mem.eql(u8, pt, "bind")) return 3;
    if (std.mem.eql(u8, pt, "blocked_by")) return 3;
    if (std.mem.eql(u8, pt, "posthook")) return 4;
    if (std.mem.eql(u8, pt, "prehook")) return 4;
    if (std.mem.eql(u8, pt, "embedding")) return 3;
    if (std.mem.eql(u8, pt, "webhook")) return 4;
    if (std.mem.eql(u8, pt, "tunnel")) return 4;
    if (std.mem.eql(u8, pt, "wallet")) return 5;
    if (std.mem.eql(u8, pt, "x402")) return 5;
    if (std.mem.eql(u8, pt, "agent")) return 6;
    if (std.mem.eql(u8, pt, "machine")) return 1;
    if (std.mem.eql(u8, pt, "cli")) return 2;
    if (std.mem.eql(u8, pt, "api")) return 2;
    if (std.mem.eql(u8, pt, "harness")) return 2;
    if (std.mem.eql(u8, pt, "loop")) return 2;
    return 2;
}

/// Extract every `contract:<8hex>` reference id from `action`. Returns a list
/// of owned slices (each 8 chars). Caller owns the outer slice and each
/// inner slice — free each then free the slice.
pub fn extractContractRefs(allocator: std.mem.Allocator, action: []const u8) ![][]u8 {
    var refs: std.ArrayList([]u8) = .empty;
    errdefer {
        for (refs.items) |r| allocator.free(r);
        refs.deinit(allocator);
    }
    const needle = "contract:";
    var i: usize = 0;
    while (i + needle.len <= action.len) {
        if (std.mem.startsWith(u8, action[i..], needle)) {
            const start = i + needle.len;
            if (start + 8 <= action.len) {
                const candidate = action[start .. start + 8];
                var ok = true;
                for (candidate) |c| {
                    const is_hex = (c >= '0' and c <= '9') or (c >= 'a' and c <= 'f');
                    if (!is_hex) {
                        ok = false;
                        break;
                    }
                }
                if (ok) {
                    const copy = try allocator.dupe(u8, candidate);
                    try refs.append(allocator, copy);
                    i = start + 8;
                    continue;
                }
            }
        }
        i += 1;
    }
    return try refs.toOwnedSlice(allocator);
}

/// Extract every typed contract id reference matching `prefix:<8hex>` from
/// `text`. Used for `inhibits:`, `bind:`, `blocked_by:`, etc.
pub fn extractTypedRefs(allocator: std.mem.Allocator, text: []const u8, prefix: []const u8) ![][]u8 {
    var refs: std.ArrayList([]u8) = .empty;
    errdefer {
        for (refs.items) |r| allocator.free(r);
        refs.deinit(allocator);
    }
    var i: usize = 0;
    while (i + prefix.len <= text.len) {
        if (std.mem.startsWith(u8, text[i..], prefix)) {
            const start = i + prefix.len;
            if (start + 8 <= text.len) {
                const candidate = text[start .. start + 8];
                var ok = true;
                for (candidate) |c| {
                    const is_hex = (c >= '0' and c <= '9') or (c >= 'a' and c <= 'f');
                    if (!is_hex) {
                        ok = false;
                        break;
                    }
                }
                if (ok) {
                    const copy = try allocator.dupe(u8, candidate);
                    try refs.append(allocator, copy);
                    i = start + 8;
                    continue;
                }
            }
        }
        i += 1;
    }
    return try refs.toOwnedSlice(allocator);
}

test "inferPointerType exposes only native shapes plus cell/api" {
    try std.testing.expectEqualStrings("funnel", inferPointerType("funnel"));
    try std.testing.expectEqualStrings("neuron", inferPointerType("neuron"));
    try std.testing.expectEqualStrings("funnel", inferPointerType("children-satisfy"));
    try std.testing.expectEqualStrings("contract-ref", inferPointerType("contract:deadbeef"));
    try std.testing.expectEqualStrings("quorum", inferPointerType("quorum:foo"));
    try std.testing.expectEqualStrings("loop", inferPointerType("loop-until:true"));
    try std.testing.expectEqualStrings("cli", inferPointerType("loop"));
    try std.testing.expectEqualStrings("api", inferPointerType("https://example.com"));
    try std.testing.expectEqualStrings("cli", inferPointerType("ls -la"));
    try std.testing.expectEqualStrings("webhook", inferPointerType("webhook:https://hooks.local/x"));
    try std.testing.expectEqualStrings("wallet", inferPointerType("wallet:abc"));
    try std.testing.expectEqualStrings("embedding", inferPointerType("embedding:deadbeef"));
    try std.testing.expectEqualStrings("tunnel", inferPointerType("tunnel:wg0"));
    try std.testing.expectEqualStrings("x402", inferPointerType("x402:/v1/credits/debit"));
    try std.testing.expectEqualStrings("agent", inferPointerType("agent:lewis"));
    try std.testing.expectEqualStrings("machine", inferPointerType("machine:mlx"));
    try std.testing.expectEqualStrings("inhibits", inferPointerType("inhibits:deadbeef"));
    try std.testing.expectEqualStrings("bind", inferPointerType("bind:deadbeef"));
}

test "inferLayer matches contract d10b3dbb convention" {
    try std.testing.expectEqual(@as(i32, 3), inferLayer("neuron"));
    try std.testing.expectEqual(@as(i32, 3), inferLayer("contract:deadbeef"));
    try std.testing.expectEqual(@as(i32, 3), inferLayer("inhibits:deadbeef"));
    try std.testing.expectEqual(@as(i32, 4), inferLayer("webhook:https://x"));
    try std.testing.expectEqual(@as(i32, 5), inferLayer("wallet:abc"));
    try std.testing.expectEqual(@as(i32, 1), inferLayer("machine:mlx"));
    try std.testing.expectEqual(@as(i32, 6), inferLayer("agent:lewis"));
}

test "extractTypedRefs picks ids by prefix" {
    const allocator = std.testing.allocator;
    const refs = try extractTypedRefs(allocator, "inhibits:deadbeef and inhibits:c0ffee99 plus contract:f00dbabe", "inhibits:");
    defer {
        for (refs) |r| allocator.free(r);
        allocator.free(refs);
    }
    try std.testing.expectEqual(@as(usize, 2), refs.len);
    try std.testing.expectEqualStrings("deadbeef", refs[0]);
    try std.testing.expectEqualStrings("c0ffee99", refs[1]);
}

test "extractContractRefs picks ids" {
    const allocator = std.testing.allocator;
    const refs = try extractContractRefs(allocator, "see contract:deadbeef and contract:c0ffee99");
    defer {
        for (refs) |r| allocator.free(r);
        allocator.free(refs);
    }
    try std.testing.expectEqual(@as(usize, 2), refs.len);
    try std.testing.expectEqualStrings("deadbeef", refs[0]);
    try std.testing.expectEqualStrings("c0ffee99", refs[1]);
}
