//! w6h.zig — the six interrogatives as a hard compiled type.
//!
//! Gap 55006079 (parent a549e18c): the W6H table in the superpattern
//! translation (CONTRACT.md) was prose. This module is the mechanism:
//! a declared row IS who/what/when/where/why/how, and a row that cannot
//! project into all six is refused at the appendRow chokepoint with the
//! unanswered interrogative NAMED — not a generic shape error.
//!
//! Field binding (doctrine = SKILL.md node atom; Zachman/W6H):
//!   who   = env_pubkey (signing identity) + agent narrative
//!   what  = plan (the truth claim; empty claim = no claim)
//!   when  = ts (declare timestamp; at:/repeat: synapses refine)
//!   where = cwd + parent containment (absent parent = root, typed, not null)
//!   why   = parent_signature (the signed reason-for-being: children are
//!           parent-signed, roots self-signed against the root key)
//!   how   = action + layer 0..8 + pointer_type (the verb)
//!
//! Hard-typing rule: NO optionals. Every legal absence is a NAMED union
//! case (`.root`, `.unsigned`) so the degraded lineage tier stays visible
//! (fallbacks are visible, never silent) instead of hiding inside a `?`.
//! A malformed answer counts as a missing answer: it projects to the
//! interrogative's Missing* error.

const std = @import("std");

pub const W6HError = error{
    MissingWho,
    MissingWhat,
    MissingWhen,
    MissingWhere,
    MissingWhy,
    MissingHow,
    NotDeclared,
    BadJson,
    OutOfMemory,
};

/// The signing identity. `.unsigned` is the writer's documented soft-emit
/// branch (no root key resolvable, e.g. NoHome) — a named degraded tier,
/// never a silent null.
pub const Signer = union(enum) {
    pubkey: []const u8, // 64-hex ed25519 public key
    unsigned: void,
};

pub const Who = struct {
    signer: Signer,
    agent: []const u8, // may be "" — the pubkey is the identity, agent is narrative
};

/// Containment. A root row has no parent BY TYPE, not by null.
pub const Parent = union(enum) {
    id: []const u8, // 8-hex parent contract id
    root: void,
};

pub const Where = struct {
    cwd: []const u8,
    parent: Parent,
};

/// The signed reason-for-being. Children carry the parent key's signature
/// (why = the parent willed it); roots carry a self-signature against the
/// root key (why = anchored at the truth-root). `.unsigned` mirrors the
/// degraded lineage tier and stays visible.
pub const Why = union(enum) {
    parent_signed: []const u8, // 128-hex ed25519 signature by parent key
    self_signed: []const u8, // 128-hex ed25519 signature by own key (root row)
    unsigned: void,
};

pub const How = struct {
    action: []const u8, // non-empty verb string
    layer: i32, // 0..8 enforced
    pointer_type: []const u8,
};

/// The six interrogatives, all required. Exactly six fields, in canonical
/// order — enforced at compile time below: the binary refuses to compile
/// if an interrogative is added, dropped, or reordered (pattern.zig style).
pub const W6H = struct {
    who: Who,
    what: []const u8,
    when: []const u8,
    where: Where,
    why: Why,
    how: How,
};

comptime {
    const fields = @typeInfo(W6H).@"struct".fields;
    if (fields.len != 6) @compileError("W6H must carry exactly six interrogatives");
    const names = [_][]const u8{ "who", "what", "when", "where", "why", "how" };
    for (fields, names) |f, n| {
        if (!std.mem.eql(u8, f.name, n))
            @compileError("W6H field order must be who/what/when/where/why/how");
    }
}

/// Wraps the parsed JSON tree plus the projected W6H view over it.
/// String slices borrow from `parsed`; call `deinit` exactly once.
pub const ParsedW6H = struct {
    parsed: std.json.Parsed(std.json.Value),
    w6h: W6H,

    pub fn deinit(self: *ParsedW6H) void {
        self.parsed.deinit();
    }
};

fn getString(obj: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const v = obj.get(key) orelse return null;
    if (v != .string) return null;
    return v.string;
}

/// Project a declared row's JSON bytes into the hard W6H type. Refuses
/// with the unanswered interrogative named. Tautological for the current
/// writer; load-bearing against writer drift — a dropped field fails the
/// WRITE, not a downstream reader.
pub fn fromDeclaredRow(
    allocator: std.mem.Allocator,
    json_bytes: []const u8,
) W6HError!ParsedW6H {
    var parsed = std.json.parseFromSlice(
        std.json.Value,
        allocator,
        json_bytes,
        .{},
    ) catch return W6HError.BadJson;
    errdefer parsed.deinit();
    const root = parsed.value;
    if (root != .object) return W6HError.BadJson;
    const obj = root.object;

    const event = getString(obj, "event") orelse return W6HError.BadJson;
    if (!std.mem.eql(u8, event, "declared")) return W6HError.NotDeclared;

    // who — pubkey when lineage fired; named .unsigned on the degraded tier.
    const agent = getString(obj, "agent") orelse return W6HError.MissingWho;
    const signer: Signer = if (getString(obj, "env_pubkey")) |pk|
        .{ .pubkey = pk }
    else
        .unsigned;

    // what — a present, non-empty truth claim. An empty claim is no claim.
    const plan = getString(obj, "plan") orelse return W6HError.MissingWhat;
    if (plan.len == 0) return W6HError.MissingWhat;

    // when — the declare timestamp.
    const ts = getString(obj, "ts") orelse return W6HError.MissingWhen;
    if (ts.len == 0) return W6HError.MissingWhen;

    // where — cwd is required; parent is typed root when null/absent.
    const cwd = getString(obj, "cwd") orelse return W6HError.MissingWhere;
    const parent: Parent = blk: {
        const pv = obj.get("parent_id") orelse break :blk .root;
        if (pv == .null) break :blk .root;
        if (pv != .string) return W6HError.MissingWhere;
        break :blk .{ .id = pv.string };
    };

    // why — parent-signed for children, self-signed for roots, named
    // .unsigned when the lineage tier degraded. A signature present
    // alongside a missing signer is incoherent: refused.
    const why: Why = blk: {
        const sig = getString(obj, "parent_signature") orelse break :blk .unsigned;
        if (signer == .unsigned) return W6HError.MissingWhy;
        break :blk switch (parent) {
            .id => .{ .parent_signed = sig },
            .root => .{ .self_signed = sig },
        };
    };

    // how — non-empty action, layer 0..8, pointer_type present.
    const action = getString(obj, "action") orelse return W6HError.MissingHow;
    if (action.len == 0) return W6HError.MissingHow;
    const layer_v = obj.get("layer") orelse return W6HError.MissingHow;
    if (layer_v != .integer) return W6HError.MissingHow;
    if (layer_v.integer < 0 or layer_v.integer > 8) return W6HError.MissingHow;
    const ptype = getString(obj, "pointer_type") orelse return W6HError.MissingHow;

    return .{
        .parsed = parsed,
        .w6h = .{
            .who = .{ .signer = signer, .agent = agent },
            .what = plan,
            .when = ts,
            .where = .{ .cwd = cwd, .parent = parent },
            .why = why,
            .how = .{
                .action = action,
                .layer = @as(i32, @intCast(layer_v.integer)),
                .pointer_type = ptype,
            },
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────
// Tests — Σ27 binding: failure mode AND pass mode for every interrogative.

const full_row =
    \\{"event": "declared", "id": "deadbeef", "plan": "answer the user", "action": "neuron:user", "pointer_type": "cell", "layer": 3, "cwd": "/tmp", "parent_id": "cafebabe", "env_pubkey": "aa11", "parent_signature": "bb22", "ts": "2026-06-11T00:00:00Z", "agent": "tester"}
;

test "full child row projects: parent-signed why, parented where" {
    const allocator = std.testing.allocator;
    var pw = try fromDeclaredRow(allocator, full_row);
    defer pw.deinit();
    try std.testing.expectEqualStrings("aa11", pw.w6h.who.signer.pubkey);
    try std.testing.expectEqualStrings("answer the user", pw.w6h.what);
    try std.testing.expectEqualStrings("2026-06-11T00:00:00Z", pw.w6h.when);
    try std.testing.expectEqualStrings("cafebabe", pw.w6h.where.parent.id);
    try std.testing.expectEqualStrings("bb22", pw.w6h.why.parent_signed);
    try std.testing.expectEqual(@as(i32, 3), pw.w6h.how.layer);
}

test "root row projects: self-signed why, root where" {
    const allocator = std.testing.allocator;
    const row =
        \\{"event": "declared", "plan": "x", "action": "neuron", "pointer_type": "cell", "layer": 3, "cwd": "/", "parent_id": null, "env_pubkey": "aa", "parent_signature": "cc", "ts": "t", "agent": ""}
    ;
    var pw = try fromDeclaredRow(allocator, row);
    defer pw.deinit();
    try std.testing.expect(pw.w6h.where.parent == .root);
    try std.testing.expectEqualStrings("cc", pw.w6h.why.self_signed);
}

test "degraded lineage tier projects as NAMED unsigned, never null" {
    const allocator = std.testing.allocator;
    const row =
        \\{"event": "declared", "plan": "x", "action": "neuron", "pointer_type": "cell", "layer": 3, "cwd": "/", "ts": "t", "agent": ""}
    ;
    var pw = try fromDeclaredRow(allocator, row);
    defer pw.deinit();
    try std.testing.expect(pw.w6h.who.signer == .unsigned);
    try std.testing.expect(pw.w6h.why == .unsigned);
}

test "signature without signer is incoherent: MissingWhy" {
    const allocator = std.testing.allocator;
    const row =
        \\{"event": "declared", "plan": "x", "action": "neuron", "pointer_type": "cell", "layer": 3, "cwd": "/", "parent_signature": "cc", "ts": "t", "agent": ""}
    ;
    try std.testing.expectError(W6HError.MissingWhy, fromDeclaredRow(allocator, row));
}

test "missing agent: MissingWho" {
    const allocator = std.testing.allocator;
    const row =
        \\{"event": "declared", "plan": "x", "action": "neuron", "pointer_type": "cell", "layer": 3, "cwd": "/", "ts": "t"}
    ;
    try std.testing.expectError(W6HError.MissingWho, fromDeclaredRow(allocator, row));
}

test "empty plan is no claim: MissingWhat" {
    const allocator = std.testing.allocator;
    const row =
        \\{"event": "declared", "plan": "", "action": "neuron", "pointer_type": "cell", "layer": 3, "cwd": "/", "ts": "t", "agent": ""}
    ;
    try std.testing.expectError(W6HError.MissingWhat, fromDeclaredRow(allocator, row));
}

test "missing ts: MissingWhen" {
    const allocator = std.testing.allocator;
    const row =
        \\{"event": "declared", "plan": "x", "action": "neuron", "pointer_type": "cell", "layer": 3, "cwd": "/", "agent": ""}
    ;
    try std.testing.expectError(W6HError.MissingWhen, fromDeclaredRow(allocator, row));
}

test "missing cwd: MissingWhere" {
    const allocator = std.testing.allocator;
    const row =
        \\{"event": "declared", "plan": "x", "action": "neuron", "pointer_type": "cell", "layer": 3, "ts": "t", "agent": ""}
    ;
    try std.testing.expectError(W6HError.MissingWhere, fromDeclaredRow(allocator, row));
}

test "layer out of 0..8 is an unanswered how: MissingHow" {
    const allocator = std.testing.allocator;
    const row =
        \\{"event": "declared", "plan": "x", "action": "neuron", "pointer_type": "cell", "layer": 99, "cwd": "/", "ts": "t", "agent": ""}
    ;
    try std.testing.expectError(W6HError.MissingHow, fromDeclaredRow(allocator, row));
}

test "missing pointer_type: MissingHow" {
    const allocator = std.testing.allocator;
    const row =
        \\{"event": "declared", "plan": "x", "action": "neuron", "layer": 3, "cwd": "/", "ts": "t", "agent": ""}
    ;
    try std.testing.expectError(W6HError.MissingHow, fromDeclaredRow(allocator, row));
}

test "cloud-mirror row shape projects (gap 587d12fe parity)" {
    const allocator = std.testing.allocator;
    // Mirrors writeCloudMirrorRow's emission order exactly: source tag,
    // derived pointer_type/layer, real cwd, empty agent narrative,
    // lineage pair, ts.
    const row =
        \\{"event": "declared", "source": "cloud-mirror", "id": "deadbeef", "plan": "mirrored claim", "action": "neuron", "pointer_type": "cell", "layer": 3, "cwd": "/tmp", "agent": "", "parent_id": "cafebabe", "ts": "t", "env_pubkey": "aa", "parent_signature": "bb"}
    ;
    var pw = try fromDeclaredRow(allocator, row);
    defer pw.deinit();
    try std.testing.expectEqualStrings("aa", pw.w6h.who.signer.pubkey);
    try std.testing.expectEqualStrings("/tmp", pw.w6h.where.cwd);
    try std.testing.expectEqualStrings("bb", pw.w6h.why.parent_signed);
}

test "non-declared event refused: NotDeclared" {
    const allocator = std.testing.allocator;
    const row =
        \\{"event": "satisfied", "id": "deadbeef"}
    ;
    try std.testing.expectError(W6HError.NotDeclared, fromDeclaredRow(allocator, row));
}
