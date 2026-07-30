//! Swarm lifecycle against a durable node substrate (entrypoint plan Phase 7):
//!
//!   peer → negotiate → route → reconcile → revoke
//!
//! Each verb is an ordinary firing through the same Runtime and WAL as any
//! other. Nothing here asserts a peer's state: a contract records what this
//! node *observed* of a peer, and every route re-checks that observation
//! against the peer's current claim before anything crosses.

const std = @import("std");
const types = @import("types.zig");
const caps_mod = @import("caps.zig");
const substrate_mod = @import("substrate.zig");
const runtime_mod = @import("runtime.zig");
const node_mod = @import("node.zig");
const swarm = @import("swarm.zig");

const Allocator = std.mem.Allocator;

const sources = [_][]const u8{"stimulus"};

fn evidence(a: Allocator, claim: []const u8, method: []const u8) ![]types.Evidence {
    const items = try a.alloc(types.Evidence, 1);
    items[0] = .{ .claim = claim, .sources = &sources, .method = method };
    return items;
}

fn swarmCaps(prefix: []const u8) caps_mod.Caps {
    return .{
        .allow_write = true,
        .write_prefix = prefix,
        .allow_send = true,
        .send_prefix = "event/",
        .budget = .{ .max_effects = 8, .max_writes = 4, .max_messages = 4 },
    };
}

fn openNode(a: Allocator, io: std.Io, node_dir: []const u8) !substrate_mod.Substrate {
    const state_path = try std.fs.path.join(a, &.{ node_dir, "state" });
    return substrate_mod.Substrate.initDir(a, io, std.Io.Dir.cwd(), state_path);
}

fn emit(a: Allocator, io: std.Io, text: []const u8) !void {
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(a, text);
    if (out.items.len == 0 or out.items[out.items.len - 1] != '\n') try out.append(a, '\n');
    var buffer: [4096]u8 = undefined;
    var writer = std.Io.File.stdout().writerStreaming(io, &buffer);
    try writer.interface.writeAll(out.items);
    try writer.interface.flush();
}

fn contractId(a: Allocator, agent: []const u8, interface_hex: []const u8) ![]const u8 {
    return std.fmt.allocPrint(a, "{s}/{s}", .{ agent, interface_hex[0..16] });
}

fn contractArtifact(a: Allocator, id: []const u8) ![]const u8 {
    return std.fmt.allocPrint(a, swarm.CONTRACT_PREFIX ++ "{s}", .{id});
}

/// Ask a peer what it advertises, right now. Always a live read: a cached claim
/// would be exactly the global-memory assumption this design refuses.
fn fetchClaim(
    a: Allocator,
    io: std.Io,
    address: []const u8,
    firing: []const u8,
) ![]const u8 {
    const response = try node_mod.fireRemote(
        a,
        io,
        address,
        swarm.CLAIM_REF,
        swarm.CLAIM_SCHEMA,
        "{}",
        firing,
        null,
        true,
        "",
    );
    return swarm.replyOf(a, response);
}

fn commit(
    a: Allocator,
    substrate: *substrate_mod.Substrate,
    firing_id: []const u8,
    artifact_id: []const u8,
    schema: []const u8,
    bytes: []const u8,
    prefix: []const u8,
    claim: []const u8,
    method: []const u8,
) !void {
    const prior = substrate.artifacts.get(artifact_id);
    var fx = [_]types.Effect{
        .{ .write = .{
            .id = artifact_id,
            .schema = schema,
            .bytes = bytes,
            .expected_prior = if (prior) |p| p.digest else null,
        } },
    };
    const runtime: runtime_mod.Runtime = .{ .substrate = substrate };
    _ = runtime.execute(.{
        .firing_id = firing_id,
        .receptor_schema = schema,
    }, swarmCaps(prefix), .{
        .control = .{ .terminate = "recorded" },
        .effects = &fx,
        .evidence = try evidence(a, claim, method),
    }) catch |err| switch (err) {
        error.FiringAlreadySettled, error.FiringMismatch => {},
        else => return err,
    };
}

/// `neuron swarm negotiate` — fetch the peer's live claim and record a leased,
/// capability-bounded edge to one advertised interface.
pub fn negotiate(
    allocator: Allocator,
    io: std.Io,
    node_dir: []const u8,
    agent: []const u8,
    address: []const u8,
    interface_hex: []const u8,
    uses: u32,
    max_writes: u32,
    max_bytes: u64,
    json_out: bool,
) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const claim_bytes = try fetchClaim(a, io, address, "swarm-claim-negotiate");
    const claim = try swarm.NodeClaim.parse(a, claim_bytes);

    // The local ceiling is the interface membrane's, so a swarm edge can never
    // exceed what a local interface could hold.
    const advertised = try swarm.negotiate(
        @import("membrane.zig").CAPS_CEILING,
        &claim,
        interface_hex,
        max_writes,
        max_bytes,
    );

    var substrate = try openNode(a, io, node_dir);
    defer substrate.deinit();

    const id = try contractId(a, agent, interface_hex);
    const contract: swarm.EdgeContract = .{
        .id = id,
        .agent = agent,
        .peer_node = claim.node,
        .peer_address = address,
        .interface = interface_hex,
        .kind = advertised.kind,
        .max_writes = max_writes,
        .max_bytes = max_bytes,
        .uses_granted = uses,
        .uses_spent = 0,
        .revoked = false,
    };
    const artifact = try contractArtifact(a, id);
    const encoded = try contract.encode(a);
    // The firing names the *transition*, not the contract id. Renegotiating an
    // edge — after a peer restart, or to take a fresh lease — is a legitimate
    // second act on the same id; keying the firing on the id alone made it
    // collide with the first negotiation's settled firing and be skipped while
    // the caller was told it succeeded.
    const prior = substrate.artifacts.get(artifact);
    try commit(
        a,
        &substrate,
        try std.fmt.allocPrint(a, "swarm/negotiate/{s}/{s}", .{
            if (prior) |p| std.fmt.bytesToHex(p.digest, .lower)[0..] else "genesis",
            std.fmt.bytesToHex(types.digest(encoded), .lower)[0..],
        }),
        artifact,
        swarm.CONTRACT_SCHEMA,
        encoded,
        swarm.CONTRACT_PREFIX,
        "a leased edge to one interface advertised by one peer",
        "peer claim fetched live and negotiated against the local ceiling",
    );

    if (json_out) {
        try emit(a, io, try std.json.Stringify.valueAlloc(a, .{
            .schema = swarm.CONTRACT_SCHEMA,
            .contract = id,
            .peer_node = claim.node,
            .interface = interface_hex,
            .kind = advertised.kind,
            .uses_granted = uses,
            .max_writes = max_writes,
            .max_bytes = max_bytes,
        }, .{}));
    } else {
        try emit(a, io, try std.fmt.allocPrint(
            a,
            "✓ edge contract negotiated · {s} · {s} · {d} use(s)",
            .{ id, advertised.kind, uses },
        ));
    }
}

fn loadContract(
    a: Allocator,
    substrate: *substrate_mod.Substrate,
    id: []const u8,
) !swarm.EdgeContract {
    const artifact_id = try contractArtifact(a, id);
    const artifact = substrate.artifacts.get(artifact_id) orelse
        return swarm.Error.EdgeContractNotFound;
    return swarm.EdgeContract.parse(a, artifact.bytes);
}

/// `neuron swarm route` — route one call across machines.
///
/// Hard eligibility first: the peer must still advertise the digest, the lease
/// must have a use left, and the contract's caps must still be inside what the
/// peer honours. Only then does anything cross the wire.
pub fn route(
    allocator: Allocator,
    io: std.Io,
    node_dir: []const u8,
    contract_id: []const u8,
    input: []const u8,
    json_out: bool,
) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var substrate = try openNode(a, io, node_dir);
    defer substrate.deinit();
    var contract = try loadContract(a, &substrate, contract_id);

    // The peer's *current* claim, not the one recorded at negotiation. A
    // contract is a record of an observation; this is where it is re-tested.
    const claim_bytes = try fetchClaim(a, io, contract.peer_address, "swarm-claim-route");
    const claim = try swarm.NodeClaim.parse(a, claim_bytes);
    _ = try swarm.eligible(&contract, &claim);

    const payload = try std.json.Stringify.valueAlloc(a, .{
        .interface = contract.interface,
        .input = input,
    }, .{});
    const response = try node_mod.fireRemote(
        a,
        io,
        contract.peer_address,
        swarm.CALL_REF,
        swarm.REMOTE_CALL_SCHEMA,
        payload,
        try std.fmt.allocPrint(a, "swarm-route/{s}/{s}", .{
            contract_id,
            std.fmt.bytesToHex(types.digest(input), .lower)[0..16],
        }),
        null,
        true,
        "",
    );
    const reply = try swarm.replyOf(a, response);
    const outcome = try swarm.parseRemoteOutcome(a, reply);
    // The peer's digest becomes evidence only by agreeing with a digest this
    // node computes over the bytes it actually received.
    if (!swarm.digestAgrees(outcome.output, outcome.output_digest))
        return swarm.Error.RemoteCallFailed;

    contract.uses_spent += 1;
    const artifact = try contractArtifact(a, contract_id);
    try commit(
        a,
        &substrate,
        try std.fmt.allocPrint(a, "swarm/route/{s}/{d}", .{ contract_id, contract.uses_spent }),
        artifact,
        swarm.CONTRACT_SCHEMA,
        try contract.encode(a),
        swarm.CONTRACT_PREFIX,
        "one lease use was spent routing across a machine boundary",
        "hard eligibility checked against the peer's live claim before the call",
    );

    if (json_out) {
        try emit(a, io, try std.json.Stringify.valueAlloc(a, .{
            .schema = swarm.REMOTE_CALL_SCHEMA,
            .contract = contract_id,
            .served_by = outcome.served_by,
            .output = outcome.output,
            .output_digest = outcome.output_digest,
            .uses_spent = contract.uses_spent,
            .uses_remaining = contract.remaining(),
        }, .{}));
    } else {
        try emit(a, io, outcome.output);
    }
}

/// `neuron swarm reconcile` — re-ask every peer and record what changed.
///
/// Explicit, and never automatic: after a partition the honest thing is to
/// compare a live claim against the recorded observation and say plainly which
/// edges no longer hold. Nothing is repaired silently.
pub fn reconcile(
    allocator: Allocator,
    io: std.Io,
    node_dir: []const u8,
    json_out: bool,
) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var substrate = try openNode(a, io, node_dir);
    defer substrate.deinit();

    var ids: std.ArrayList([]const u8) = .empty;
    var iterator = substrate.artifacts.iterator();
    while (iterator.next()) |entry| {
        const key = entry.key_ptr.*;
        if (!std.mem.startsWith(u8, key, swarm.CONTRACT_PREFIX)) continue;
        try ids.append(a, try a.dupe(u8, key[swarm.CONTRACT_PREFIX.len..]));
    }
    std.mem.sort([]const u8, ids.items, {}, struct {
        fn lessThan(_: void, l: []const u8, r: []const u8) bool {
            return std.mem.lessThan(u8, l, r);
        }
    }.lessThan);

    var entries = std.json.Array.init(a);
    var holding: usize = 0;
    var broken: usize = 0;
    for (ids.items) |id| {
        const contract = loadContract(a, &substrate, id) catch continue;
        var status: []const u8 = "holds";
        if (fetchClaim(a, io, contract.peer_address, "swarm-claim-reconcile")) |claim_bytes| {
            if (swarm.NodeClaim.parse(a, claim_bytes)) |claim| {
                if (swarm.eligible(&contract, &claim)) |_| {
                    status = "holds";
                } else |err| {
                    status = @errorName(err);
                }
            } else |err| {
                status = @errorName(err);
            }
        } else |err| {
            // Unreachable is a state, not a failure to hide: the edge is
            // recorded as unreconciled rather than quietly assumed good.
            status = @errorName(err);
        }
        if (std.mem.eql(u8, status, "holds")) holding += 1 else broken += 1;

        var obj: std.json.ObjectMap = .empty;
        try obj.put(a, "contract", .{ .string = id });
        try obj.put(a, "peer", .{ .string = contract.peer_address });
        try obj.put(a, "interface", .{ .string = contract.interface });
        try obj.put(a, "uses_remaining", .{ .integer = contract.remaining() });
        try obj.put(a, "status", .{ .string = status });
        try entries.append(.{ .object = obj });
    }

    const record = try std.json.Stringify.valueAlloc(a, .{
        .schema = swarm.RECONCILE_SCHEMA,
        .holding = holding,
        .broken = broken,
        .contracts = ids.items.len,
    }, .{});
    try commit(
        a,
        &substrate,
        try std.fmt.allocPrint(a, "swarm/reconcile/{s}", .{
            std.fmt.bytesToHex(types.digest(record), .lower)[0..16],
        }),
        try std.fmt.allocPrint(a, swarm.OBSERVED_PREFIX ++ "{s}", .{
            std.fmt.bytesToHex(types.digest(record), .lower)[0..16],
        }),
        swarm.RECONCILE_SCHEMA,
        record,
        swarm.OBSERVED_PREFIX,
        "each recorded edge was re-tested against its peer's live claim",
        "explicit reconciliation; no global memory is assumed",
    );

    if (json_out) {
        var root: std.json.ObjectMap = .empty;
        try root.put(a, "schema", .{ .string = swarm.RECONCILE_SCHEMA });
        try root.put(a, "holding", .{ .integer = @intCast(holding) });
        try root.put(a, "broken", .{ .integer = @intCast(broken) });
        try root.put(a, "edges", .{ .array = entries });
        try emit(a, io, try std.json.Stringify.valueAlloc(a, std.json.Value{ .object = root }, .{}));
    } else {
        try emit(a, io, try std.fmt.allocPrint(
            a,
            "✓ reconciled {d} edge(s) · {d} holding · {d} broken",
            .{ ids.items.len, holding, broken },
        ));
    }
}

/// `neuron swarm revoke` — withdraw an edge. The record stays; the authority
/// does not.
pub fn revoke(
    allocator: Allocator,
    io: std.Io,
    node_dir: []const u8,
    contract_id: []const u8,
) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var substrate = try openNode(a, io, node_dir);
    defer substrate.deinit();

    var contract = try loadContract(a, &substrate, contract_id);
    contract.revoked = true;
    try commit(
        a,
        &substrate,
        try std.fmt.allocPrint(a, "swarm/revoke/{s}", .{contract_id}),
        try contractArtifact(a, contract_id),
        swarm.CONTRACT_SCHEMA,
        try contract.encode(a),
        swarm.CONTRACT_PREFIX,
        "an edge contract was withdrawn",
        "explicit revocation; the audit record is preserved",
    );
    try emit(a, io, try std.fmt.allocPrint(
        a,
        "✓ edge contract revoked · {s} · audit preserved",
        .{contract_id},
    ));
}
