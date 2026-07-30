//! Multi-machine interface swarm (entrypoint plan Phase 7).
//!
//! Nodes stay independently governed. This module adds exactly three things on
//! top of the existing framed `neuron.wire/v1` federation:
//!
//!   1. **NodeClaims** — a node advertises which admitted interface digests it
//!      is willing to expose, and what it will honour for a peer.
//!   2. **EdgeContracts** — a local agent negotiates a *leased*, capability-
//!      bounded edge to one of those digests on one peer.
//!   3. **Hard eligibility** — routing across machines checks membership,
//!      lease, and caps as a gate. An ineligible peer is excluded outright, not
//!      ranked lower: energy and cost only ever order what is already allowed.
//!
//! What it deliberately does *not* add is a global memory. A contract records
//! what this node observed of a peer at a moment; it never asserts the peer's
//! state. Reconciliation is therefore explicit — re-ask, compare, and record
//! the drift — which is the only honest thing to do across a partition.

const std = @import("std");
const types = @import("types.zig");
const caps_mod = @import("caps.zig");

const Allocator = std.mem.Allocator;

pub const CLAIM_SCHEMA = "neuron.node-claim/v1";
pub const CONTRACT_SCHEMA = "neuron.edge-contract/v1";
pub const RECONCILE_SCHEMA = "neuron.edge-reconciliation/v1";
pub const REMOTE_CALL_SCHEMA = "neuron.remote-interface-call/v1";

pub const CLAIM_REF = "mesh/claims";
pub const CALL_REF = "mesh/interface-call";

pub const CONTRACT_PREFIX = "swarm/contracts/";
pub const OBSERVED_PREFIX = "swarm/observed/";

pub const MAX_ADVERTISED = 64;

pub const Error = error{
    InvalidNodeClaim,
    InvalidEdgeContract,
    /// The digest is not in the peer's current claim. Membership is checked
    /// before anything is ranked or spent.
    PeerInterfaceNotAdvertised,
    /// The contract's lease has no uses left.
    EdgeLeaseExpired,
    EdgeContractNotFound,
    EdgeContractRevoked,
    /// The requested grant exceeds what the peer advertised it will honour, or
    /// what the local ceiling permits. A widened edge is refused, never
    /// silently narrowed — narrowing would hide the disagreement.
    EdgeCapsWidened,
    /// The peer no longer advertises what the contract was negotiated against.
    EdgeTopologyDrifted,
    RemoteCallFailed,
};

/// One advertised boundary. Only the digest, kind, and mode cross the wire —
/// never the locator, which is the peer's business and would leak its layout.
pub const Advertised = struct {
    interface: []const u8,
    kind: []const u8,
    mode: []const u8,
    id: []const u8,
};

/// What a node says it exposes, and the most authority it will honour for a
/// peer edge. The claim is an assertion by the node about itself; a caller
/// treats it as untrusted input and re-checks it against its own ceiling.
pub const NodeClaim = struct {
    node: []const u8,
    interfaces: []const Advertised,
    /// The peer's own ceiling for edges into it.
    max_writes: u32,
    max_bytes: u64,

    pub fn parse(a: Allocator, bytes: []const u8) !NodeClaim {
        const root = std.json.parseFromSliceLeaky(std.json.Value, a, bytes, .{}) catch
            return Error.InvalidNodeClaim;
        if (root != .object) return Error.InvalidNodeClaim;
        const schema = str(root, "schema") orelse return Error.InvalidNodeClaim;
        if (!std.mem.eql(u8, schema, CLAIM_SCHEMA)) return Error.InvalidNodeClaim;

        const list = root.object.get("interfaces") orelse return Error.InvalidNodeClaim;
        if (list != .array) return Error.InvalidNodeClaim;
        if (list.array.items.len > MAX_ADVERTISED) return Error.InvalidNodeClaim;
        var out: std.ArrayList(Advertised) = .empty;
        for (list.array.items) |item| {
            if (item != .object) return Error.InvalidNodeClaim;
            const digest = str(item, "interface") orelse return Error.InvalidNodeClaim;
            if (digest.len != 64) return Error.InvalidNodeClaim;
            try out.append(a, .{
                .interface = digest,
                .kind = str(item, "kind") orelse return Error.InvalidNodeClaim,
                .mode = str(item, "mode") orelse return Error.InvalidNodeClaim,
                .id = str(item, "id") orelse "",
            });
        }
        return .{
            .node = str(root, "node") orelse return Error.InvalidNodeClaim,
            .interfaces = try out.toOwnedSlice(a),
            .max_writes = @intCast(@max(0, int(root, "max_writes") orelse 0)),
            .max_bytes = @intCast(@max(0, int(root, "max_bytes") orelse 0)),
        };
    }

    /// Membership, as a plain predicate. This is the *hard* part of eligibility:
    /// it answers yes or no and never contributes a score.
    pub fn advertises(self: *const NodeClaim, interface_hex: []const u8) ?Advertised {
        for (self.interfaces) |item| {
            if (std.mem.eql(u8, item.interface, interface_hex)) return item;
        }
        return null;
    }
};

/// A leased, capability-bounded edge from a local agent to one interface on one
/// peer. The lease is counted in *uses* rather than wall time: a node that was
/// partitioned for an hour has not spent anything, and a clock it does not
/// control should not be able to extend or shorten its authority.
pub const EdgeContract = struct {
    id: []const u8,
    agent: []const u8,
    peer_node: []const u8,
    peer_address: []const u8,
    interface: []const u8,
    kind: []const u8,
    max_writes: u32,
    max_bytes: u64,
    uses_granted: u32,
    uses_spent: u32,
    revoked: bool,

    pub fn parse(a: Allocator, bytes: []const u8) !EdgeContract {
        const root = std.json.parseFromSliceLeaky(std.json.Value, a, bytes, .{}) catch
            return Error.InvalidEdgeContract;
        if (root != .object) return Error.InvalidEdgeContract;
        const schema = str(root, "schema") orelse return Error.InvalidEdgeContract;
        if (!std.mem.eql(u8, schema, CONTRACT_SCHEMA)) return Error.InvalidEdgeContract;
        return .{
            .id = str(root, "id") orelse return Error.InvalidEdgeContract,
            .agent = str(root, "agent") orelse return Error.InvalidEdgeContract,
            .peer_node = str(root, "peer_node") orelse return Error.InvalidEdgeContract,
            .peer_address = str(root, "peer_address") orelse return Error.InvalidEdgeContract,
            .interface = str(root, "interface") orelse return Error.InvalidEdgeContract,
            .kind = str(root, "kind") orelse "",
            .max_writes = @intCast(@max(0, int(root, "max_writes") orelse 0)),
            .max_bytes = @intCast(@max(0, int(root, "max_bytes") orelse 0)),
            .uses_granted = @intCast(@max(0, int(root, "uses_granted") orelse 0)),
            .uses_spent = @intCast(@max(0, int(root, "uses_spent") orelse 0)),
            .revoked = boolean(root, "revoked", false),
        };
    }

    pub fn remaining(self: *const EdgeContract) u32 {
        return if (self.uses_spent >= self.uses_granted)
            0
        else
            self.uses_granted - self.uses_spent;
    }

    pub fn encode(self: *const EdgeContract, a: Allocator) ![]u8 {
        return std.json.Stringify.valueAlloc(a, .{
            .schema = CONTRACT_SCHEMA,
            .id = self.id,
            .agent = self.agent,
            .peer_node = self.peer_node,
            .peer_address = self.peer_address,
            .interface = self.interface,
            .kind = self.kind,
            .max_writes = self.max_writes,
            .max_bytes = self.max_bytes,
            .uses_granted = self.uses_granted,
            .uses_spent = self.uses_spent,
            .revoked = self.revoked,
        }, .{});
    }
};

/// Negotiate a grant: the strongest edge that is inside *both* the local
/// ceiling and what the peer says it will honour.
///
/// A request beyond either is refused rather than clamped. Silently narrowing
/// would let a caller believe it holds authority it does not, which is the
/// failure mode a negotiated edge exists to prevent.
pub fn negotiate(
    local_ceiling: caps_mod.Caps,
    claim: *const NodeClaim,
    interface_hex: []const u8,
    requested_writes: u32,
    requested_bytes: u64,
) !Advertised {
    const advertised = claim.advertises(interface_hex) orelse
        return Error.PeerInterfaceNotAdvertised;
    if (requested_writes > claim.max_writes or requested_bytes > claim.max_bytes)
        return Error.EdgeCapsWidened;
    if (requested_writes > local_ceiling.budget.max_writes or
        requested_bytes > local_ceiling.budget.max_bytes)
        return Error.EdgeCapsWidened;
    return advertised;
}

/// Hard eligibility, evaluated before anything is ranked, spent, or sent.
///
/// The order is the property: membership and lease are gates. A peer that fails
/// either is not a low-ranked candidate — it is not a candidate. Energy and
/// cost may only reorder what has already passed through here.
pub fn eligible(
    contract: *const EdgeContract,
    claim: *const NodeClaim,
) !Advertised {
    if (contract.revoked) return Error.EdgeContractRevoked;
    if (contract.remaining() == 0) return Error.EdgeLeaseExpired;
    // The peer must still advertise what the contract was negotiated against.
    // A contract is a record of an observation, not a claim on the peer's
    // present state, so this is re-checked on every route.
    const advertised = claim.advertises(contract.interface) orelse
        return Error.EdgeTopologyDrifted;
    if (!std.mem.eql(u8, advertised.kind, contract.kind)) return Error.EdgeTopologyDrifted;
    if (contract.max_writes > claim.max_writes or contract.max_bytes > claim.max_bytes)
        return Error.EdgeCapsWidened;
    return advertised;
}

// --- Wire helpers ----------------------------------------------------------

/// Pull the `reply` out of a framed node answer, or fail typed. A response that
/// carried no reply is not an empty answer — it is a ref that does not read.
pub fn replyOf(a: Allocator, response: []const u8) ![]const u8 {
    const root = std.json.parseFromSliceLeaky(std.json.Value, a, response, .{}) catch
        return Error.RemoteCallFailed;
    if (root != .object) return Error.RemoteCallFailed;
    const status = str(root, "status") orelse return Error.RemoteCallFailed;
    if (!std.mem.eql(u8, status, "committed")) return Error.RemoteCallFailed;
    return str(root, "reply") orelse Error.RemoteCallFailed;
}

/// The output of a remote interface call, with the digest the peer reported.
pub const RemoteOutcome = struct {
    output: []const u8,
    output_digest: []const u8,
    served_by: []const u8,
};

pub fn parseRemoteOutcome(a: Allocator, reply: []const u8) !RemoteOutcome {
    const root = std.json.parseFromSliceLeaky(std.json.Value, a, reply, .{}) catch
        return Error.RemoteCallFailed;
    if (root != .object) return Error.RemoteCallFailed;
    const schema = str(root, "schema") orelse return Error.RemoteCallFailed;
    if (!std.mem.eql(u8, schema, REMOTE_CALL_SCHEMA)) return Error.RemoteCallFailed;
    return .{
        .output = str(root, "output") orelse return Error.RemoteCallFailed,
        .output_digest = str(root, "output_digest") orelse return Error.RemoteCallFailed,
        .served_by = str(root, "served_by") orelse return Error.RemoteCallFailed,
    };
}

/// The peer's reported digest is *its* claim about its own work. It becomes
/// evidence here only by being recomputed locally over the bytes actually
/// received — which is the whole reason the output travels with it.
pub fn digestAgrees(reply_output: []const u8, reported_hex: []const u8) bool {
    const local = std.fmt.bytesToHex(types.digest(reply_output), .lower);
    return std.mem.eql(u8, &local, reported_hex);
}

// --- JSON helpers ----------------------------------------------------------

fn str(value: std.json.Value, key: []const u8) ?[]const u8 {
    if (value != .object) return null;
    const field = value.object.get(key) orelse return null;
    return switch (field) {
        .string => |text| text,
        else => null,
    };
}

fn int(value: std.json.Value, key: []const u8) ?i64 {
    if (value != .object) return null;
    const field = value.object.get(key) orelse return null;
    return switch (field) {
        .integer => |number| number,
        else => null,
    };
}

fn boolean(value: std.json.Value, key: []const u8, default: bool) bool {
    if (value != .object) return default;
    const field = value.object.get(key) orelse return default;
    return switch (field) {
        .bool => |flag| flag,
        else => default,
    };
}

test "eligibility is a gate, not a ranking" {
    const a = std.testing.allocator;
    const claim_bytes =
        \\{"schema":"neuron.node-claim/v1","node":"peer","max_writes":4,"max_bytes":65536,
        \\ "interfaces":[{"interface":"aa11223344556677889900aabbccddeeff00112233445566778899aabbccddee",
        \\ "kind":"process","mode":"read","id":"process/upper"}]}
    ;
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const claim = try NodeClaim.parse(arena.allocator(), claim_bytes);

    var contract: EdgeContract = .{
        .id = "c1",
        .agent = "alpha",
        .peer_node = "peer",
        .peer_address = "127.0.0.1:1",
        .interface = "aa11223344556677889900aabbccddeeff00112233445566778899aabbccddee",
        .kind = "process",
        .max_writes = 2,
        .max_bytes = 1024,
        .uses_granted = 1,
        .uses_spent = 0,
        .revoked = false,
    };
    _ = try eligible(&contract, &claim);

    // A spent lease is not a worse route; it is no route.
    contract.uses_spent = 1;
    try std.testing.expectError(Error.EdgeLeaseExpired, eligible(&contract, &claim));

    contract.uses_spent = 0;
    contract.revoked = true;
    try std.testing.expectError(Error.EdgeContractRevoked, eligible(&contract, &claim));

    contract.revoked = false;
    contract.interface = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    try std.testing.expectError(Error.EdgeTopologyDrifted, eligible(&contract, &claim));
}

test "a widened edge is refused rather than clamped" {
    const a = std.testing.allocator;
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const claim = try NodeClaim.parse(arena.allocator(),
        \\{"schema":"neuron.node-claim/v1","node":"peer","max_writes":2,"max_bytes":1024,
        \\ "interfaces":[{"interface":"aa11223344556677889900aabbccddeeff00112233445566778899aabbccddee",
        \\ "kind":"process","mode":"read","id":"process/upper"}]}
    );
    const local: caps_mod.Caps = .{ .budget = .{ .max_writes = 8, .max_bytes = 1 << 20 } };
    const hex = "aa11223344556677889900aabbccddeeff00112233445566778899aabbccddee";
    _ = try negotiate(local, &claim, hex, 2, 1024);
    try std.testing.expectError(Error.EdgeCapsWidened, negotiate(local, &claim, hex, 3, 1024));
    try std.testing.expectError(Error.EdgeCapsWidened, negotiate(local, &claim, hex, 2, 4096));
    try std.testing.expectError(
        Error.PeerInterfaceNotAdvertised,
        negotiate(local, &claim, "ff11223344556677889900aabbccddeeff00112233445566778899aabbccddee", 1, 512),
    );
}
