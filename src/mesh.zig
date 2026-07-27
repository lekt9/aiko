//! The neuron-native mesh: signed `neuron.wire/v1` envelopes between
//! symmetric nodes. Every node is both client and server — it can stimulate
//! neurons on a peer and have its own neurons stimulated. A remote firing is
//! a typed message admitted under an account-delegated capability proof,
//! never an RPC (§10): the proof is verified at admission (§20 step 1), the
//! message lands in the local substrate as an ordinary durable message, and
//! the neuron fires locally under the delegated caps through the same
//! validate → commit boundary as any local firing. At-least-once delivery is
//! absorbed by firing-id dedupe in the runtime (§21); the wire carries no
//! authority of its own (§24).

const std = @import("std");
const builtin = @import("builtin");
const posix = std.posix;
const types = @import("types.zig");
const caps_mod = @import("caps.zig");
const substrate_mod = @import("substrate.zig");
const runtime_mod = @import("runtime.zig");
const neuron_mod = @import("neuron.zig");
const identity = @import("identity.zig");
const script_mod = @import("script.zig");

const Allocator = std.mem.Allocator;
const Caps = caps_mod.Caps;
pub const NodeId = identity.NodeId;

pub const envelope_schema = "neuron.wire/v1";
pub const frame_max: u32 = 1 << 20;

/// One signed cross-node message. The signature covers the canonical field
/// layout below and is produced by the sender's device key; the delegation
/// proves that device may act for the account root with these caps.
pub const Envelope = struct {
    from: NodeId,
    to: NodeId,
    ref: []const u8,
    firing_id: []const u8,
    schema: []const u8,
    payload: []const u8,
    durable: bool,
    delegation: identity.Delegation,
    nonce: u64,
    signature: identity.SignatureBytes,

    /// Canonical bytes: from ‖ to ‖ lp(ref) ‖ lp(firing_id) ‖ lp(schema) ‖
    /// lp(payload) ‖ durable ‖ delegation-canonical ‖ nonce (BE u64).
    pub fn canonicalBytes(self: *const Envelope, allocator: Allocator) ![]u8 {
        var bytes: std.ArrayList(u8) = .empty;
        errdefer bytes.deinit(allocator);
        try bytes.appendSlice(allocator, &self.from);
        try bytes.appendSlice(allocator, &self.to);
        for ([_][]const u8{ self.ref, self.firing_id, self.schema, self.payload }) |field| {
            var len: [4]u8 = undefined;
            std.mem.writeInt(u32, &len, @intCast(field.len), .big);
            try bytes.appendSlice(allocator, &len);
            try bytes.appendSlice(allocator, field);
        }
        try bytes.append(allocator, if (self.durable) 1 else 0);
        var delegation_bytes: [104]u8 = undefined;
        try bytes.appendSlice(allocator, self.delegation.canonicalBytes(&delegation_bytes));
        var nonce: [8]u8 = undefined;
        std.mem.writeInt(u64, &nonce, self.nonce, .big);
        try bytes.appendSlice(allocator, &nonce);
        return bytes.toOwnedSlice(allocator);
    }
};

fn signEnvelope(
    device_keys: *const identity.Ed25519.KeyPair,
    envelope: *Envelope,
    allocator: Allocator,
) !void {
    const canonical = try envelope.canonicalBytes(allocator);
    defer allocator.free(canonical);
    const signature = try device_keys.sign(canonical, null);
    envelope.signature = signature.toBytes();
}

fn verifyEnvelope(envelope: *const Envelope, allocator: Allocator) !void {
    const canonical = try envelope.canonicalBytes(allocator);
    defer allocator.free(canonical);
    const public_key = try identity.Ed25519.PublicKey.fromBytes(envelope.from);
    const signature = identity.Ed25519.Signature.fromBytes(envelope.signature);
    try signature.verify(canonical, public_key);
}

/// A symmetric mesh node: client and server in one. It owns its device
/// keypair, the account trust ceilings it honors, the local neuron registry
/// peers may stimulate, and the substrate those firings commit into.
pub const Node = struct {
    allocator: Allocator,
    keys: identity.Ed25519.KeyPair,
    substrate: *substrate_mod.Substrate,
    runtime: runtime_mod.Runtime,
    registry: std.StringHashMap(neuron_mod.Neuron),
    accounts: std.AutoHashMap(NodeId, Caps),

    pub fn init(
        allocator: Allocator,
        keys: identity.Ed25519.KeyPair,
        substrate: *substrate_mod.Substrate,
    ) Node {
        return .{
            .allocator = allocator,
            .keys = keys,
            .substrate = substrate,
            .runtime = .{ .substrate = substrate },
            .registry = std.StringHashMap(neuron_mod.Neuron).init(allocator),
            .accounts = std.AutoHashMap(NodeId, Caps).init(allocator),
        };
    }

    pub fn deinit(self: *Node) void {
        self.registry.deinit();
        self.accounts.deinit();
    }

    pub fn id(self: *const Node) NodeId {
        return identity.publicKeyId(&self.keys);
    }

    /// Pin the maximum authority this node will ever honor for one account
    /// root. Deny by default: an unknown root's envelopes are dropped.
    pub fn trustAccount(self: *Node, root: NodeId, ceiling: Caps) !void {
        try self.accounts.put(root, ceiling);
    }

    pub fn register(self: *Node, neuron: neuron_mod.Neuron) !void {
        try self.registry.put(neuron.identity, neuron);
    }

    /// Build, sign, and serialize an envelope to a peer. The delegation is
    /// the caller's proof that its device may exercise these caps for the
    /// account; the receiver will re-verify and clamp it (§24).
    pub fn send(
        self: *Node,
        to: NodeId,
        ref: []const u8,
        msg_schema: []const u8,
        payload: []const u8,
        durable: bool,
        delegation: identity.Delegation,
        firing_id: []const u8,
        nonce: u64,
    ) ![]u8 {
        var envelope: Envelope = .{
            .from = self.id(),
            .to = to,
            .ref = ref,
            .firing_id = firing_id,
            .schema = msg_schema,
            .payload = payload,
            .durable = durable,
            .delegation = delegation,
            .nonce = nonce,
            .signature = undefined,
        };
        try signEnvelope(&self.keys, &envelope, self.allocator);
        return try envelopeJson(self.allocator, &envelope);
    }

    /// Admit one serialized envelope. Every failure mode is closed: nothing
    /// is deposited, nothing fires, the error is typed (§27).
    pub fn receive(self: *Node, bytes: []const u8, now_ms: u64) !ReceiveResult {
        // The parsed document, the envelope, and every string it lends to
        // validation die with the firing — the substrate stages its own
        // copies of anything it commits.
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const envelope = try parseEnvelope(arena.allocator(), bytes, true);
        if (!std.mem.eql(u8, &envelope.to, &self.id())) return error.WrongRecipient;
        const ceiling = self.accounts.get(envelope.delegation.account) orelse
            return error.UnknownAccount;
        try identity.verifyDelegation(&envelope.delegation, now_ms);
        if (!caps_mod.allowsDelegation(ceiling, envelope.delegation.caps))
            return error.AttenuationDenied;
        if (!std.mem.eql(u8, &envelope.delegation.device, &envelope.from))
            return error.DeviceMismatch;
        try verifyEnvelope(envelope, self.allocator);
        const neuron = self.registry.get(envelope.ref) orelse return error.UnknownNeuron;

        const messages = [_]types.Message{.{
            .to = envelope.ref,
            .schema = envelope.schema,
            .payload = envelope.payload,
            .durable = envelope.durable,
        }};
        const stimulus: types.Stimulus = .{
            .firing_id = envelope.firing_id,
            .receptor_schema = envelope_schema,
            .messages = &messages,
            .now_ms = now_ms,
        };
        const commit = try self.runtime.fire(neuron, stimulus, envelope.delegation.caps);
        return .{ .commit = commit, .from = envelope.from };
    }

    /// Admit one envelope over a transport that already authenticated the
    /// peer (e.g. a tailnet pipe — tailnet.zig). The envelope's own proof
    /// fields are IGNORED: capability comes solely from the ceiling the
    /// operator pinned for this peer, so nothing the peer sends can widen
    /// its authority (§24). The recipient check still applies, and the
    /// firing still passes the full validate → commit boundary.
    pub fn receiveTrusted(self: *Node, bytes: []const u8, now_ms: u64, ceiling: Caps) !ReceiveResult {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const envelope = try parseEnvelope(arena.allocator(), bytes, false);
        // A zeroed recipient is a wildcard: on a transport that already
        // chose and authenticated this node, "whoever answered" is exact.
        // The signed path stays strict — no wildcards off trusted pipes.
        const wildcard: NodeId = @splat(0);
        if (!std.mem.eql(u8, &envelope.to, &self.id()) and
            !std.mem.eql(u8, &envelope.to, &wildcard)) return error.WrongRecipient;
        const neuron = self.registry.get(envelope.ref) orelse return error.UnknownNeuron;
        const messages = [_]types.Message{.{
            .to = envelope.ref,
            .schema = envelope.schema,
            .payload = envelope.payload,
            .durable = envelope.durable,
        }};
        const stimulus: types.Stimulus = .{
            .firing_id = envelope.firing_id,
            .receptor_schema = envelope_schema,
            .messages = &messages,
            .now_ms = now_ms,
        };
        const commit = try self.runtime.fire(neuron, stimulus, ceiling);
        return .{ .commit = commit, .from = envelope.from };
    }
};

pub const ReceiveResult = struct {
    commit: runtime_mod.CommitResult,
    from: NodeId,
};

// --- JSON codec (signatures ride over the canonical binary form, so key
// order here is irrelevant to verification) ---

fn writeCapsJson(allocator: Allocator, w: *std.Io.Writer, caps: Caps) !void {
    try w.print("{{\"allow_write\":{},\"allow_send\":{},\"allow_spawn\":{}", .{
        caps.allow_write, caps.allow_send, caps.allow_spawn,
    });
    try writeJsonField(allocator, w, "write_prefix", caps.write_prefix);
    try writeJsonField(allocator, w, "send_prefix", caps.send_prefix);
    try writeJsonField(allocator, w, "spawn_prefix", caps.spawn_prefix);
    try w.print(",\"budget\":{{\"max_effects\":{},\"max_writes\":{},\"max_messages\":{},\"max_spawns\":{},\"max_bytes\":{},\"max_depth\":{}}}}}", .{
        caps.budget.max_effects, caps.budget.max_writes, caps.budget.max_messages,
        caps.budget.max_spawns,  caps.budget.max_bytes,  caps.budget.max_depth,
    });
}

/// Encode one raw string as a JSON string literal (quotes and escapes).
fn jsonEncodeString(allocator: Allocator, raw: []const u8) ![]u8 {
    return std.json.Stringify.valueAlloc(allocator, raw, .{});
}

fn writeHexField(
    w: *std.Io.Writer,
    comptime n: usize,
    key: []const u8,
    bytes: *const [n]u8,
) !void {
    const hex = std.fmt.bytesToHex(bytes.*, .lower);
    try w.print(",\"{s}\":\"", .{key});
    try w.writeAll(&hex);
    try w.writeAll("\"");
}

fn writeJsonField(allocator: Allocator, w: *std.Io.Writer, key: []const u8, raw: []const u8) !void {
    const encoded = try jsonEncodeString(allocator, raw);
    defer allocator.free(encoded);
    try w.print(",\"{s}\":{s}", .{ key, encoded });
}

fn envelopeJson(allocator: Allocator, envelope: *const Envelope) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(allocator);
    errdefer out.deinit();
    const w = &out.writer;
    try w.print("{{\"schema\":\"{s}\"", .{envelope_schema});
    try writeHexField(w, 32, "from", &envelope.from);
    try writeHexField(w, 32, "to", &envelope.to);
    try writeJsonField(allocator, w, "ref", envelope.ref);
    try writeJsonField(allocator, w, "firing_id", envelope.firing_id);
    try w.writeAll(",\"message\":{");
    {
        const encoded_schema = try jsonEncodeString(allocator, envelope.schema);
        defer allocator.free(encoded_schema);
        const encoded_payload = try jsonEncodeString(allocator, envelope.payload);
        defer allocator.free(encoded_payload);
        try w.print("\"schema\":{s},\"payload\":{s},\"durable\":{}", .{
            encoded_schema, encoded_payload, envelope.durable,
        });
    }
    try w.writeAll("}");
    try w.writeAll(",\"delegation\":{");
    {
        try w.writeAll("\"account\":\"");
        const account_hex = std.fmt.bytesToHex(envelope.delegation.account, .lower);
        try w.writeAll(&account_hex);
        try w.writeAll("\",\"device\":\"");
        const device_hex = std.fmt.bytesToHex(envelope.delegation.device, .lower);
        try w.writeAll(&device_hex);
        try w.writeAll("\",\"caps\":");
        try writeCapsJson(allocator, w, envelope.delegation.caps);
        try w.print(",\"expires_ms\":{},\"signature\":\"", .{envelope.delegation.expires_ms});
        const delegation_hex = std.fmt.bytesToHex(envelope.delegation.signature, .lower);
        try w.writeAll(&delegation_hex);
        try w.writeAll("\"}");
    }
    try w.print(",\"nonce\":{},\"signature\":\"", .{envelope.nonce});
    const signature_hex = std.fmt.bytesToHex(envelope.signature, .lower);
    try w.writeAll(&signature_hex);
    try w.writeAll("\"}");
    return out.toOwnedSlice();
}

fn getString(object: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const value = object.get(key) orelse return null;
    return switch (value) {
        .string => |text| text,
        else => null,
    };
}

fn getHex(comptime n: usize, object: std.json.ObjectMap, key: []const u8) ![n]u8 {
    const text = getString(object, key) orelse return error.InvalidEnvelope;
    if (text.len != n * 2) return error.InvalidEnvelope;
    var out: [n]u8 = undefined;
    _ = try std.fmt.hexToBytes(&out, text);
    return out;
}

fn parseEnvelope(allocator: Allocator, bytes: []const u8, require_proof: bool) !*Envelope {
    const parsed = try std.json.parseFromSliceLeaky(std.json.Value, allocator, bytes, .{});
    if (parsed != .object) return error.InvalidEnvelope;
    const root = parsed.object;
    const schema = getString(root, "schema") orelse return error.InvalidEnvelope;
    if (!std.mem.eql(u8, schema, envelope_schema)) return error.InvalidEnvelope;
    const message = root.get("message") orelse return error.InvalidEnvelope;
    if (message != .object) return error.InvalidEnvelope;
    const nonce = root.get("nonce") orelse return error.InvalidEnvelope;
    if (nonce != .integer or nonce.integer < 0) return error.InvalidEnvelope;

    const envelope = try allocator.create(Envelope);
    errdefer allocator.destroy(envelope);
    envelope.* = .{
        .from = try getHex(32, root, "from"),
        .to = try getHex(32, root, "to"),
        .ref = try allocator.dupe(u8, getString(root, "ref") orelse return error.InvalidEnvelope),
        .firing_id = try allocator.dupe(u8, getString(root, "firing_id") orelse return error.InvalidEnvelope),
        .schema = try allocator.dupe(u8, getString(message.object, "schema") orelse return error.InvalidEnvelope),
        .payload = try allocator.dupe(u8, getString(message.object, "payload") orelse return error.InvalidEnvelope),
        .durable = if (message.object.get("durable")) |value| switch (value) {
            .bool => |flag| flag,
            else => return error.InvalidEnvelope,
        } else true,
        .delegation = .{
            .account = @splat(0),
            .device = @splat(0),
            .caps = .{},
            .expires_ms = 0,
            .signature = @splat(0),
        },
        .nonce = @intCast(nonce.integer),
        .signature = @splat(0),
    };
    if (root.get("delegation")) |delegation| {
        if (delegation != .object) return error.InvalidEnvelope;
        const caps_value = delegation.object.get("caps") orelse return error.InvalidEnvelope;
        const expires = delegation.object.get("expires_ms") orelse return error.InvalidEnvelope;
        if (expires != .integer or expires.integer < 0) return error.InvalidEnvelope;
        envelope.delegation = .{
            .account = try getHex(32, delegation.object, "account"),
            .device = try getHex(32, delegation.object, "device"),
            .caps = try script_mod.capsFromJson(caps_value),
            .expires_ms = @intCast(expires.integer),
            .signature = try getHex(64, delegation.object, "signature"),
        };
    } else if (require_proof) return error.InvalidEnvelope;
    if (require_proof) {
        if (root.get("signature") == null) return error.InvalidEnvelope;
        envelope.signature = try getHex(64, root, "signature");
    }
    return envelope;
}

/// Serialize an envelope with no proof material for an already-authenticated
/// transport (tailnet pipe, local MCP edge). `receiveTrusted` ignores proof
/// fields entirely; they are zeroed here so nothing forged can ride along.
pub fn unsignedEnvelopeJson(
    allocator: Allocator,
    to: NodeId,
    ref: []const u8,
    msg_schema: []const u8,
    payload: []const u8,
    durable: bool,
    firing_id: []const u8,
    nonce: u64,
) ![]u8 {
    var envelope: Envelope = .{
        .from = @splat(0),
        .to = to,
        .ref = ref,
        .firing_id = firing_id,
        .schema = msg_schema,
        .payload = payload,
        .durable = durable,
        .delegation = .{
            .account = @splat(0),
            .device = @splat(0),
            .caps = .{},
            .expires_ms = 0,
            .signature = @splat(0),
        },
        .nonce = nonce,
        .signature = @splat(0),
    };
    return envelopeJson(allocator, &envelope);
}

/// A standard bridge neuron: the wire payload directs the write. Format is
/// "<artifact-id>\n<bytes>". This is exactly the shape an injected peer
/// would abuse, which is why it only ever runs under a pinned ceiling —
/// the validate → commit boundary rejects anything outside it (§24/§27).
pub const ProxyNeuron = struct {
    scratch: *[1024]u8,
    fx: *[1]types.Effect,
    ev: *[1]types.Evidence,
    src: *[1][]const u8,

    pub fn fire(self: *const ProxyNeuron, stim: types.Stimulus, _: Caps) !types.Decision {
        const payload = if (stim.messages.len > 0) stim.messages[0].payload else "";
        const split = std.mem.indexOfScalar(u8, payload, '\n') orelse return error.InvalidPayload;
        const id = payload[0..split];
        const bytes = payload[split + 1 ..];
        if (id.len == 0) return error.InvalidPayload;
        self.fx[0] = .{ .write = .{ .id = id, .schema = stim.messages[0].schema, .bytes = bytes } };
        self.src[0] = "stimulus";
        self.ev[0] = .{
            .claim = "proxied the wire payload into the substrate",
            .sources = self.src[0..1],
            .method = "payload-directed write",
        };
        return .{
            .control = .{ .terminate = "proxied" },
            .effects = self.fx[0..1],
            .evidence = self.ev[0..1],
        };
    }
};

// --- Transport: 4-byte BE length-prefixed frames over any Io byte stream.
// The wire is dumb by design; all authority decisions happen in receive().

pub const net = std.Io.net;

pub fn writeFrame(writer: *std.Io.Writer, bytes: []const u8) !void {
    if (bytes.len > frame_max) return error.FrameTooLarge;
    var header: [4]u8 = undefined;
    std.mem.writeInt(u32, &header, @intCast(bytes.len), .big);
    try writer.writeAll(&header);
    try writer.writeAll(bytes);
    try writer.flush();
}

pub fn readFrame(allocator: Allocator, reader: *std.Io.Reader) !?[]u8 {
    const header = reader.take(4) catch |err| switch (err) {
        error.EndOfStream => return null,
        else => return err,
    };
    const len = std.mem.readInt(u32, header[0..4], .big);
    if (len > frame_max) return error.FrameTooLarge;
    return try reader.readAlloc(allocator, len);
}

/// Serve one connection until the peer closes it: every frame is admitted
/// through receive(). Returns the number of envelopes admitted.
pub fn serveConnection(node: *Node, reader: *std.Io.Reader, now_ms: u64) !usize {
    var received: usize = 0;
    while (try readFrame(node.allocator, reader)) |bytes| {
        defer node.allocator.free(bytes);
        _ = try node.receive(bytes, now_ms);
        received += 1;
    }
    return received;
}

/// Accept exactly one connection on the listener and serve it to EOF.
pub fn acceptOnce(
    node: *Node,
    server: *net.Server,
    io: std.Io,
    now_ms: u64,
    buffer: []u8,
) !usize {
    const stream = try server.accept(io);
    defer stream.close(io);
    var reader = stream.reader(io, buffer);
    return serveConnection(node, &reader.interface, now_ms);
}

/// Connect to a peer, write one framed envelope, and close. Symmetric with
/// acceptOnce: every node runs both sides.
pub fn dialSend(
    address: *const net.IpAddress,
    io: std.Io,
    bytes: []const u8,
    buffer: []u8,
) !void {
    const stream = try address.connect(io, .{ .mode = .stream });
    defer stream.close(io);
    var writer = stream.writer(io, buffer);
    try writeFrame(&writer.interface, bytes);
}

/// A dial bounded by a deadline (§20). This toolchain's Threaded Io
/// backend panics on connect timeouts, so the bounded path drives the fd
/// directly: non-blocking connect, poll for writable, SO_ERROR for the
/// verdict, then back to blocking for the framed exchange above. The
/// deadline converts a dead or silent peer into typed errors — Timeout,
/// ConnectionRefused, NetworkUnreachable — instead of an unbounded hang.
/// Windows keeps the unbounded Io connect until the backend grows support.
pub fn connectBounded(address: *const net.IpAddress, io: std.Io, timeout_ms: u32) !net.Stream {
    if (builtin.os.tag == .windows) {
        return try address.connect(io, .{ .mode = .stream });
    }
    var storage: [@sizeOf(posix.sockaddr.in6)]u8 align(@alignOf(posix.sockaddr.in6)) = undefined;
    var salen: posix.socklen_t = undefined;
    const family: u32 = switch (address.*) {
        .ip4 => |ip4| blk: {
            const sa: *posix.sockaddr.in = @ptrCast(&storage);
            sa.* = .{
                .port = std.mem.nativeToBig(u16, ip4.port),
                .addr = @bitCast(ip4.bytes),
            };
            salen = @sizeOf(posix.sockaddr.in);
            break :blk posix.AF.INET;
        },
        .ip6 => |ip6| blk: {
            const sa: *posix.sockaddr.in6 = @ptrCast(&storage);
            sa.* = .{
                .port = std.mem.nativeToBig(u16, ip6.port),
                .flowinfo = ip6.flow,
                .addr = ip6.bytes,
                .scope_id = 0,
            };
            salen = @sizeOf(posix.sockaddr.in6);
            break :blk posix.AF.INET6;
        },
    };
    const fd = std.c.socket(family, posix.SOCK.STREAM, 0);
    if (fd == -1) return error.SocketFailed;
    errdefer _ = std.c.close(fd);
    const nonblock_bits: c_int = @bitCast(posix.O{ .NONBLOCK = true });
    const flags = std.c.fcntl(fd, posix.F.GETFL);
    if (flags == -1) return error.FcntlFailed;
    if (std.c.fcntl(fd, posix.F.SETFL, flags | nonblock_bits) == -1) return error.FcntlFailed;
    const rc = std.c.connect(fd, @ptrCast(&storage), salen);
    if (rc != 0) {
        switch (posix.errno(rc)) {
            .INPROGRESS => {}, // expected: the deadline below decides
            .CONNREFUSED => return error.ConnectionRefused,
            .NETUNREACH, .HOSTUNREACH => return error.NetworkUnreachable,
            .TIMEDOUT => return error.Timeout,
            else => return error.ConnectFailed,
        }
    }
    var pfd = [_]posix.pollfd{.{ .fd = fd, .events = posix.POLL.OUT, .revents = 0 }};
    if (try posix.poll(&pfd, @intCast(timeout_ms)) == 0) return error.Timeout;
    var so_err: c_int = 0;
    var so_len: posix.socklen_t = @sizeOf(c_int);
    if (std.c.getsockopt(fd, posix.SOL.SOCKET, posix.SO.ERROR, &so_err, &so_len) == -1)
        return error.ConnectFailed;
    if (so_err != 0) {
        return switch (@as(posix.E, @enumFromInt(so_err))) {
            .CONNREFUSED => error.ConnectionRefused,
            .TIMEDOUT => error.Timeout,
            .NETUNREACH, .HOSTUNREACH => error.NetworkUnreachable,
            else => error.ConnectFailed,
        };
    }
    // Connected: restore blocking semantics for the framed exchange above.
    // The address field mirrors what accept() fills on the receive side:
    // the peer this stream talks to.
    if (std.c.fcntl(fd, posix.F.SETFL, flags & ~nonblock_bits) == -1) return error.FcntlFailed;
    return .{ .socket = .{ .handle = fd, .address = address.* } };
}

/// Connect, write one framed envelope, and read the peer's framed result
/// (commit summary or typed error). The response is validated only as JSON
/// shape by callers — it is information, never authority. `timeout_ms`
/// bounds the dial (§20); null waits indefinitely like dialSend.
pub fn dialExchange(
    allocator: Allocator,
    address: *const net.IpAddress,
    io: std.Io,
    bytes: []const u8,
    buffer: []u8,
    timeout_ms: ?u32,
) ![]u8 {
    const stream = if (timeout_ms) |ms|
        try connectBounded(address, io, ms)
    else
        try address.connect(io, .{ .mode = .stream });
    defer stream.close(io);
    var writer = stream.writer(io, buffer);
    try writeFrame(&writer.interface, bytes);
    var reader = stream.reader(io, buffer);
    const response = try readFrame(allocator, &reader.interface);
    return response orelse error.NoResponse;
}
