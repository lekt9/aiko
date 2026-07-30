//! Installable swarm-node lifecycle over the canonical mesh and tailnet
//! transport. This module adds configuration and stable device identity; it
//! does not create a second wire protocol.

const std = @import("std");
const caps_mod = @import("caps.zig");
const identity = @import("identity.zig");
const mesh_mod = @import("mesh.zig");
const neuron_mod = @import("neuron.zig");
const substrate_mod = @import("substrate.zig");
const tailnet_mod = @import("tailnet.zig");
const types = @import("types.zig");
const membrane = @import("membrane.zig");
const membrane_ops = @import("membrane_ops.zig");
const swarm_mod = @import("swarm.zig");

const Allocator = std.mem.Allocator;

pub const config_schema = "neuron.node/v1";
pub const config_name = "node.json";
pub const seed_name = "device.seed";
pub const state_name = "state";

pub const Transport = enum { tailnet, loopback };

pub const Config = struct {
    arena: std.heap.ArenaAllocator,
    node_dir: []const u8,
    listen: []const u8,
    transport: Transport,
    write_prefix: []const u8,
    ceilings_file: ?[]const u8,
    max_connections: usize,
    connection_budget_ms: u32,

    pub fn deinit(self: *Config) void {
        self.arena.deinit();
    }

    pub fn seedPath(self: *const Config, allocator: Allocator) ![]u8 {
        return std.fs.path.join(allocator, &.{ self.node_dir, seed_name });
    }

    pub fn statePath(self: *const Config, allocator: Allocator) ![]u8 {
        return std.fs.path.join(allocator, &.{ self.node_dir, state_name });
    }
};

const ConfigJson = struct {
    schema: []const u8,
    listen: []const u8,
    transport: []const u8,
    write_prefix: []const u8,
    ceilings_file: ?[]const u8 = null,
    max_connections: usize = 64,
    connection_budget_ms: u32 = 30_000,
};

pub fn initNode(
    allocator: Allocator,
    io: std.Io,
    node_dir: []const u8,
    listen: []const u8,
    write_prefix: []const u8,
    transport: Transport,
) !void {
    if (node_dir.len == 0 or write_prefix.len == 0) return error.InvalidNodeConfig;
    _ = mesh_mod.net.IpAddress.parseLiteral(listen) catch return error.InvalidListenAddress;

    const cwd = std.Io.Dir.cwd();
    try cwd.createDirPath(io, node_dir);
    const seed_path = try std.fs.path.join(allocator, &.{ node_dir, seed_name });
    defer allocator.free(seed_path);
    const config_path = try std.fs.path.join(allocator, &.{ node_dir, config_name });
    defer allocator.free(config_path);

    const seed_exists = fileExists(io, cwd, seed_path);
    const config_exists = fileExists(io, cwd, config_path);
    if (seed_exists != config_exists) return error.PartialNodeState;
    if (seed_exists) {
        var existing = try loadConfig(allocator, io, node_dir);
        defer existing.deinit();
        _ = try loadKeys(allocator, io, &existing);
        if (!std.mem.eql(u8, existing.listen, listen) or
            !std.mem.eql(u8, existing.write_prefix, write_prefix) or
            existing.transport != transport)
            return error.NodeConfigMismatch;
        return;
    }

    const keys = identity.generateKeyPair(io);
    const seed = keys.secret_key.seed();
    const seed_hex = std.fmt.bytesToHex(seed, .lower);
    const seed_file = try cwd.createFile(io, seed_path, .{
        .exclusive = true,
        .permissions = @enumFromInt(0o600),
    });
    errdefer cwd.deleteFile(io, seed_path) catch {};
    defer seed_file.close(io);
    try seed_file.writePositionalAll(io, &seed_hex, 0);
    try seed_file.sync(io);

    const listen_json = try std.json.Stringify.valueAlloc(allocator, listen, .{});
    defer allocator.free(listen_json);
    const prefix_json = try std.json.Stringify.valueAlloc(allocator, write_prefix, .{});
    defer allocator.free(prefix_json);
    const config_bytes = try std.fmt.allocPrint(
        allocator,
        "{{\"schema\":\"{s}\",\"listen\":{s},\"transport\":\"{s}\",\"write_prefix\":{s},\"ceilings_file\":null,\"max_connections\":64,\"connection_budget_ms\":30000}}\n",
        .{ config_schema, listen_json, @tagName(transport), prefix_json },
    );
    defer allocator.free(config_bytes);
    const config_file = try cwd.createFile(io, config_path, .{
        .exclusive = true,
        .permissions = @enumFromInt(0o600),
    });
    errdefer cwd.deleteFile(io, config_path) catch {};
    defer config_file.close(io);
    try config_file.writePositionalAll(io, config_bytes, 0);
    try config_file.sync(io);
}

pub fn loadConfig(allocator: Allocator, io: std.Io, node_dir: []const u8) !Config {
    var arena = std.heap.ArenaAllocator.init(allocator);
    errdefer arena.deinit();
    const a = arena.allocator();
    const owned_dir = try a.dupe(u8, node_dir);
    const config_path = try std.fs.path.join(a, &.{ node_dir, config_name });
    const bytes = try std.Io.Dir.cwd().readFileAlloc(io, config_path, a, .limited(256 * 1024));
    const parsed = std.json.parseFromSliceLeaky(ConfigJson, a, bytes, .{}) catch return error.InvalidNodeConfig;
    if (!std.mem.eql(u8, parsed.schema, config_schema) or
        parsed.listen.len == 0 or parsed.write_prefix.len == 0 or
        parsed.max_connections == 0 or parsed.connection_budget_ms == 0)
        return error.InvalidNodeConfig;
    _ = mesh_mod.net.IpAddress.parseLiteral(parsed.listen) catch return error.InvalidListenAddress;
    const transport = std.meta.stringToEnum(Transport, parsed.transport) orelse return error.InvalidTransport;
    if (transport == .loopback) {
        const address = mesh_mod.net.IpAddress.parseLiteral(parsed.listen) catch unreachable;
        if (!isLoopback(address)) return error.LoopbackTransportRequiresLoopbackListen;
        if (parsed.ceilings_file != null) return error.InvalidNodeConfig;
    }
    return .{
        .arena = arena,
        .node_dir = owned_dir,
        .listen = parsed.listen,
        .transport = transport,
        .write_prefix = parsed.write_prefix,
        .ceilings_file = if (parsed.ceilings_file) |path|
            try std.fs.path.join(a, &.{ node_dir, path })
        else
            null,
        .max_connections = parsed.max_connections,
        .connection_budget_ms = parsed.connection_budget_ms,
    };
}

pub fn loadKeys(allocator: Allocator, io: std.Io, config: *const Config) !identity.Ed25519.KeyPair {
    const path = try config.seedPath(allocator);
    defer allocator.free(path);
    const raw = try std.Io.Dir.cwd().readFileAlloc(io, path, allocator, .limited(256));
    defer allocator.free(raw);
    const text = std.mem.trim(u8, raw, " \t\r\n");
    if (text.len != 64) return error.InvalidDeviceSeed;
    var seed: [32]u8 = undefined;
    _ = std.fmt.hexToBytes(&seed, text) catch return error.InvalidDeviceSeed;
    return identity.keyPairFromSeed(seed);
}

pub fn nodeId(allocator: Allocator, io: std.Io, node_dir: []const u8) !identity.NodeId {
    var config = try loadConfig(allocator, io, node_dir);
    defer config.deinit();
    const keys = try loadKeys(allocator, io, &config);
    return identity.publicKeyId(&keys);
}

const health_sources = [_][]const u8{"stimulus"};
const health_evidence = [_]types.Evidence{.{
    .claim = "the installed node admitted a health stimulus through its canonical runtime",
    .sources = &health_sources,
    .method = "mesh health neuron",
}};

const HealthNeuron = struct {
    pub fn fire(_: *const HealthNeuron, _: types.Stimulus, _: caps_mod.Caps) !types.Decision {
        return .{
            .control = .{ .terminate = "healthy" },
            .evidence = &health_evidence,
        };
    }
};

const swarm_evidence = [_]types.Evidence{.{
    .claim = "this node's own advertised interface set",
    .sources = &[_][]const u8{"stimulus"},
    .method = "read of the local admitted-interface records",
}};

const remote_call_evidence = [_]types.Evidence{.{
    .claim = "an admitted local interface was invoked on behalf of a peer edge",
    .sources = &[_][]const u8{"stimulus"},
    .method = "capability read through the local membrane",
}};

/// `mesh/claims` — advertise which admitted interface digests this node exposes.
///
/// A read: it commits nothing and answers with the claim. Only the digest,
/// kind, and mode cross the wire; the locator stays local, because a peer needs
/// to know *what* is offered, never where it lives on this machine.
const ClaimNeuron = struct {
    arena: *std.heap.ArenaAllocator,
    substrate: *substrate_mod.Substrate,
    node: *mesh_mod.Node,
    write_prefix: []const u8,

    pub fn fire(self: *const ClaimNeuron, _: types.Stimulus, _: caps_mod.Caps) !types.Decision {
        // The previous answer has already been written to the wire, so its
        // memory is reclaimable here. Without this a long-lived node would grow
        // by one reply per request, forever.
        _ = self.arena.reset(.retain_capacity);
        const a = self.arena.allocator();
        var items: std.ArrayList(std.json.Value) = .empty;
        var iterator = self.substrate.artifacts.iterator();
        while (iterator.next()) |entry| {
            const id = entry.key_ptr.*;
            if (!std.mem.startsWith(u8, id, membrane_ops.ADMITTED_PREFIX)) continue;
            const hex = id[membrane_ops.ADMITTED_PREFIX.len..];
            if (hex.len != 64) continue;
            // A revoked interface resolves as an error, so retired boundaries
            // simply stop being advertised.
            const manifest = membrane_ops.resolveAdmitted(a, self.substrate, hex) catch continue;
            // Only capability reads are offered across a machine boundary: a
            // remote command would need this node's outbox and reconciliation,
            // which an edge contract does not confer.
            if (manifest.invocation.mode != .read) continue;
            var obj: std.json.ObjectMap = .empty;
            try obj.put(a, "interface", .{ .string = try a.dupe(u8, hex) });
            try obj.put(a, "kind", .{ .string = manifest.kind.name() });
            try obj.put(a, "mode", .{ .string = manifest.invocation.mode.name() });
            try obj.put(a, "id", .{ .string = manifest.id });
            try items.append(a, .{ .object = obj });
            if (items.items.len >= swarm_mod.MAX_ADVERTISED) break;
        }
        var array = std.json.Array.init(a);
        array.items = items.items;
        array.capacity = items.capacity;

        var root: std.json.ObjectMap = .empty;
        try root.put(a, "schema", .{ .string = swarm_mod.CLAIM_SCHEMA });
        try root.put(a, "node", .{ .string = try mesh_mod.nodeAddress(a, self.node.id()) });
        try root.put(a, "interfaces", .{ .array = array });
        try root.put(a, "max_writes", .{ .integer = 4 });
        try root.put(a, "max_bytes", .{ .integer = 64 * 1024 });
        try root.put(a, "write_prefix", .{ .string = self.write_prefix });

        self.node.reply = try std.json.Stringify.valueAlloc(a, std.json.Value{ .object = root }, .{});
        return .{ .control = .{ .terminate = "claimed" }, .evidence = &swarm_evidence };
    }
};

/// `mesh/interface-call` — invoke one admitted local interface for a peer.
///
/// The interface must be admitted here and must be a read, so a peer edge can
/// never reach this node's outbox. The answer is the interface's real output;
/// nothing about the caller's state is assumed or asserted.
const RemoteCallNeuron = struct {
    arena: *std.heap.ArenaAllocator,
    substrate: *substrate_mod.Substrate,
    node: *mesh_mod.Node,
    io: std.Io,

    pub fn fire(self: *const RemoteCallNeuron, stim: types.Stimulus, _: caps_mod.Caps) !types.Decision {
        _ = self.arena.reset(.retain_capacity);
        const a = self.arena.allocator();
        if (stim.messages.len == 0) return error.InvalidRemoteCall;
        const payload = stim.messages[stim.messages.len - 1].payload;
        const root = std.json.parseFromSliceLeaky(std.json.Value, a, payload, .{}) catch
            return error.InvalidRemoteCall;
        if (root != .object) return error.InvalidRemoteCall;
        const interface = switch (root.object.get("interface") orelse return error.InvalidRemoteCall) {
            .string => |text| text,
            else => return error.InvalidRemoteCall,
        };
        const input = switch (root.object.get("input") orelse return error.InvalidRemoteCall) {
            .string => |text| text,
            else => return error.InvalidRemoteCall,
        };
        const manifest = membrane_ops.resolveAdmitted(a, self.substrate, interface) catch
            return error.InterfaceNotAdmitted;
        if (manifest.invocation.mode != .read) return error.UnverifiableCommand;
        const outcome = membrane.invokeRead(a, self.io, &manifest, input) catch
            return error.InterfaceCallFailed;

        var reply: std.json.ObjectMap = .empty;
        try reply.put(a, "schema", .{ .string = swarm_mod.REMOTE_CALL_SCHEMA });
        try reply.put(a, "interface", .{ .string = interface });
        try reply.put(a, "output", .{ .string = outcome.output });
        try reply.put(a, "output_digest", .{
            .string = try a.dupe(u8, &std.fmt.bytesToHex(outcome.output_digest, .lower)),
        });
        try reply.put(a, "served_by", .{ .string = try mesh_mod.nodeAddress(a, self.node.id()) });
        self.node.reply = try std.json.Stringify.valueAlloc(a, std.json.Value{ .object = reply }, .{});
        return .{ .control = .{ .terminate = "served" }, .evidence = &remote_call_evidence };
    }
};

pub fn serve(allocator: Allocator, io: std.Io, node_dir: []const u8) !void {
    var config = try loadConfig(allocator, io, node_dir);
    defer config.deinit();
    const keys = try loadKeys(allocator, io, &config);
    const state_path = try config.statePath(allocator);
    defer allocator.free(state_path);
    var substrate = try substrate_mod.Substrate.initDir(allocator, io, std.Io.Dir.cwd(), state_path);
    defer substrate.deinit();
    var node = mesh_mod.Node.init(allocator, keys, &substrate);
    defer node.deinit();

    var proxy_arena = std.heap.ArenaAllocator.init(allocator);
    defer proxy_arena.deinit();
    var proxy_fx: [1]types.Effect = undefined;
    var proxy_ev: [1]types.Evidence = undefined;
    var proxy_src: [1][]const u8 = undefined;
    const proxy: mesh_mod.ProxyNeuron = .{
        .arena = &proxy_arena,
        .fx = &proxy_fx,
        .ev = &proxy_ev,
        .src = &proxy_src,
    };
    const health: HealthNeuron = .{};
    try node.register(neuron_mod.bind(mesh_mod.ProxyNeuron, &proxy, "mesh/proxy", "1"));
    try node.register(neuron_mod.bind(HealthNeuron, &health, "mesh/health", "1"));

    // The swarm read refs. Both answer with a value and commit nothing, so a
    // peer can learn what this node offers, and use it, without ever gaining
    // authority over this node's substrate.
    var swarm_arena = std.heap.ArenaAllocator.init(allocator);
    defer swarm_arena.deinit();
    const claims: ClaimNeuron = .{
        .arena = &swarm_arena,
        .substrate = &substrate,
        .node = &node,
        .write_prefix = config.write_prefix,
    };
    const remote_call: RemoteCallNeuron = .{
        .arena = &swarm_arena,
        .substrate = &substrate,
        .node = &node,
        .io = io,
    };
    try node.register(neuron_mod.bind(ClaimNeuron, &claims, swarm_mod.CLAIM_REF, "1"));
    try node.register(neuron_mod.bind(RemoteCallNeuron, &remote_call, swarm_mod.CALL_REF, "1"));

    const address = mesh_mod.net.IpAddress.parseLiteral(config.listen) catch return error.InvalidListenAddress;
    var server = try address.listen(io, .{ .reuse_address = true });
    defer server.deinit(io);
    try printReady(allocator, io, &node, &config);

    const ceiling: caps_mod.Caps = .{
        .allow_write = true,
        .write_prefix = config.write_prefix,
    };
    const options: tailnet_mod.ServeOptions = .{
        .max_connections = config.max_connections,
        .connection_budget_ms = config.connection_budget_ms,
    };
    if (config.transport == .loopback) {
        var loopback: LoopbackCeiling = .{ .ceiling = ceiling };
        return tailnet_mod.serve(&node, &server, io, loopback.classifier(), null, options);
    }
    if (config.ceilings_file) |ceilings_path| {
        const bytes = try std.Io.Dir.cwd().readFileAlloc(io, ceilings_path, allocator, .limited(256 * 1024));
        defer allocator.free(bytes);
        const table = try tailnet_mod.CeilingTable.parse(allocator, bytes);
        var per_peer = tailnet_mod.TableClassifier.init(
            allocator,
            io,
            table,
            tailnet_mod.tailscaleWhois(),
            300_000,
        );
        defer per_peer.deinit();
        return tailnet_mod.serve(&node, &server, io, per_peer.classifier(), null, options);
    }
    var single: tailnet_mod.SingleCeiling = .{ .ceiling = ceiling };
    return tailnet_mod.serve(&node, &server, io, single.classifier(), null, options);
}

pub fn fireRemote(
    allocator: Allocator,
    io: std.Io,
    address_text: []const u8,
    neuron_ref: []const u8,
    msg_schema: []const u8,
    payload: []const u8,
    firing_id: []const u8,
    nonce: ?u64,
    allow_loopback: bool,
    /// Non-empty opens a conversation the remote neuron may answer; empty
    /// keeps the CLI's original one-way posture.
    correlation: []const u8,
) ![]u8 {
    if (neuron_ref.len == 0 or msg_schema.len == 0 or firing_id.len == 0)
        return error.InvalidRemoteFire;
    const address = mesh_mod.net.IpAddress.parseLiteral(address_text) catch return error.InvalidListenAddress;
    if (!tailnet_mod.isTailnetAddress(address) and !(allow_loopback and isLoopback(address)))
        return error.EgressDenied;
    const wildcard: mesh_mod.NodeId = @splat(0);
    const envelope = try mesh_mod.unsignedEnvelopeJson(
        allocator,
        wildcard,
        neuron_ref,
        msg_schema,
        payload,
        true,
        firing_id,
        nonce orelse mesh_mod.nonceForFiring(firing_id),
        if (correlation.len > 0) mesh_mod.Conversation.open(correlation) else .one_way,
    );
    defer allocator.free(envelope);
    var buffer: [16 * 1024]u8 = undefined;
    return mesh_mod.dialExchange(allocator, &address, io, envelope, &buffer, 5_000);
}

fn fileExists(io: std.Io, dir: std.Io.Dir, path: []const u8) bool {
    _ = dir.statFile(io, path, .{}) catch return false;
    return true;
}

fn isLoopback(address: mesh_mod.net.IpAddress) bool {
    return switch (address) {
        .ip4 => |ip4| ip4.bytes[0] == 127,
        .ip6 => |ip6| std.mem.eql(u8, &ip6.bytes, &([_]u8{0} ** 15 ++ [_]u8{1})),
    };
}

const LoopbackCeiling = struct {
    ceiling: caps_mod.Caps,

    fn classifier(self: *LoopbackCeiling) tailnet_mod.PeerClassifier {
        return .{
            .context = self,
            .classify = struct {
                fn classify(context: *anyopaque, peer: tailnet_mod.IpAddress, _: u64) ?caps_mod.Caps {
                    const owner: *LoopbackCeiling = @ptrCast(@alignCast(context));
                    return if (isLoopback(peer)) owner.ceiling else null;
                }
            }.classify,
        };
    }
};

/// Announce what this node actually serves. The ref list is enumerated from the
/// live registry and sorted, rather than written out by hand: a readiness line
/// that names a fixed set would drift the moment a ref is added, and an
/// advertisement nobody maintains is worse than none.
fn printReady(
    allocator: Allocator,
    io: std.Io,
    node: *const mesh_mod.Node,
    config: *const Config,
) !void {
    var refs: std.ArrayList([]const u8) = .empty;
    defer refs.deinit(allocator);
    var iterator = node.registry.keyIterator();
    while (iterator.next()) |key| try refs.append(allocator, key.*);
    std.mem.sort([]const u8, refs.items, {}, struct {
        fn lessThan(_: void, left: []const u8, right: []const u8) bool {
            return std.mem.lessThan(u8, left, right);
        }
    }.lessThan);

    var line: std.ArrayList(u8) = .empty;
    defer line.deinit(allocator);
    var id_hex: [64]u8 = undefined;
    try line.appendSlice(allocator, try std.fmt.allocPrint(
        allocator,
        "{{\"schema\":\"neuron.node-ready/v1\",\"node\":\"{s}\",\"listen\":\"{s}\",\"transport\":\"{s}\",\"neurons\":[",
        .{ identity.nodeIdHex(node.id(), &id_hex), config.listen, @tagName(config.transport) },
    ));
    for (refs.items, 0..) |ref, index| {
        if (index != 0) try line.append(allocator, ',');
        try line.appendSlice(allocator, try std.json.Stringify.valueAlloc(allocator, ref, .{}));
    }
    try line.appendSlice(allocator, "]}\n");

    var out_buffer: [1024]u8 = undefined;
    var writer = std.Io.File.stdout().writerStreaming(io, &out_buffer);
    try writer.interface.writeAll(line.items);
    try writer.interface.flush();
}
