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
    /// Conversation identity across the mesh. Non-empty means the sender
    /// invites an answer; the receiver's neuron sees the peer node as its
    /// attested return address. Signed like every other field, so a relay
    /// cannot retarget a reply by rewriting the correlation.
    correlation: []const u8 = "",
    /// Position of the message in its conversation, as attested by the peer.
    /// Clamped by the receiver's own turn ceiling at the valve.
    turn: u8 = 0,
    delegation: identity.Delegation,
    nonce: u64,
    signature: identity.SignatureBytes,

    /// Canonical bytes: from ‖ to ‖ lp(ref) ‖ lp(firing_id) ‖ lp(schema) ‖
    /// lp(payload) ‖ lp(correlation) ‖ durable ‖ turn ‖ delegation-canonical ‖
    /// nonce (BE u64).
    pub fn canonicalBytes(self: *const Envelope, allocator: Allocator) ![]u8 {
        var bytes: std.ArrayList(u8) = .empty;
        errdefer bytes.deinit(allocator);
        try bytes.appendSlice(allocator, &self.from);
        try bytes.appendSlice(allocator, &self.to);
        for ([_][]const u8{ self.ref, self.firing_id, self.schema, self.payload, self.correlation }) |field| {
            var len: [4]u8 = undefined;
            std.mem.writeInt(u32, &len, @intCast(field.len), .big);
            try bytes.appendSlice(allocator, &len);
            try bytes.appendSlice(allocator, field);
        }
        try bytes.append(allocator, if (self.durable) 1 else 0);
        try bytes.append(allocator, self.turn);
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

/// The conversation an outbound envelope belongs to. `.one_way` is the
/// default posture: it confers no return path, so the recipient's neuron
/// cannot answer. A correlated envelope invites exactly one answer per turn.
pub const Conversation = struct {
    correlation: []const u8 = "",
    turn: u8 = 0,

    pub const one_way: Conversation = .{};

    /// Open a conversation the peer may answer.
    pub fn open(correlation: []const u8) Conversation {
        return .{ .correlation = correlation, .turn = 1 };
    }
};

/// The address of a peer node's inbox, as stamped on an inbound message's
/// return path. A local reply to this address is an ordinary committed
/// outbox message; carrying it back over the wire is the drainer adapter's
/// job, not the valve's.
pub fn nodeAddress(allocator: Allocator, node: NodeId) ![]u8 {
    const hex = std.fmt.bytesToHex(node, .lower);
    return std.fmt.allocPrint(allocator, "node/{s}", .{&hex});
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
    /// A read answer for the frame currently being served.
    ///
    /// Most refs commit effects and answer with a commit summary; a *read* ref
    /// — "what interfaces do you advertise", "what did that interface return" —
    /// has nothing to commit and a value to return. Registered neurons are
    /// constructed by this binary, so a locally owned slot is how they hand one
    /// back without the wire growing a second protocol. It is cleared before
    /// every receive, so a stale answer can never be served for a later frame.
    reply: ?[]const u8 = null,

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
        conversation: Conversation,
    ) ![]u8 {
        var envelope: Envelope = .{
            .from = self.id(),
            .to = to,
            .ref = ref,
            .firing_id = firing_id,
            .schema = msg_schema,
            .payload = payload,
            .durable = durable,
            .correlation = conversation.correlation,
            .turn = conversation.turn,
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
        // A read answer belongs to exactly one frame: clear it before this one
        // fires so a previous frame's value can never be served again.
        self.reply = null;
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

        // The peer's verified device key is the attested sender — the same
        // authority that admitted the envelope also names who may be answered,
        // so a cross-node reply cannot be aimed anywhere the proof did not
        // reach. A correlated envelope confers a return path; an uncorrelated
        // one is one-way.
        const peer = try nodeAddress(arena.allocator(), envelope.from);
        const local = try nodeAddress(arena.allocator(), self.id());
        const messages = [_]types.Message{.{
            .to = envelope.ref,
            .schema = envelope.schema,
            .payload = envelope.payload,
            .durable = envelope.durable,
            .from = peer,
            .correlation = envelope.correlation,
            .reply_to = if (envelope.correlation.len > 0) peer else "",
            .turn = envelope.turn,
        }};
        const stimulus: types.Stimulus = .{
            .firing_id = envelope.firing_id,
            .receptor_schema = envelope_schema,
            .self_ref = local,
            .messages = &messages,
            // The signed envelope nonce is the firing's recorded logical
            // clock. Admission still uses the receiver's live `now_ms` for
            // delegation expiry, but an at-least-once redelivery must
            // reconstruct byte-identical stimulus identity even when it
            // reaches the receiver later.
            .now_ms = envelope.nonce,
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
    pub fn receiveTrusted(self: *Node, bytes: []const u8, _: u64, ceiling: Caps) !ReceiveResult {
        // As on the signed path: a read answer belongs to one frame only.
        self.reply = null;
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
        // On a trusted pipe the envelope's own `from` is unproven, so the
        // return path is the transport-authenticated peer the operator pinned
        // this ceiling for — never a self-declared identity in the frame.
        const peer = try nodeAddress(arena.allocator(), envelope.from);
        const local = try nodeAddress(arena.allocator(), self.id());
        const messages = [_]types.Message{.{
            .to = envelope.ref,
            .schema = envelope.schema,
            .payload = envelope.payload,
            .durable = envelope.durable,
            .from = peer,
            .correlation = envelope.correlation,
            .reply_to = if (envelope.correlation.len > 0) peer else "",
            .turn = envelope.turn,
        }};
        const stimulus: types.Stimulus = .{
            .firing_id = envelope.firing_id,
            .receptor_schema = envelope_schema,
            .self_ref = local,
            .messages = &messages,
            // See the signed path above: transport redelivery reuses the
            // original envelope nonce while peer admission uses live time.
            .now_ms = envelope.nonce,
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
        const encoded_correlation = try jsonEncodeString(allocator, envelope.correlation);
        defer allocator.free(encoded_correlation);
        try w.print("\"schema\":{s},\"payload\":{s},\"durable\":{},\"correlation\":{s},\"turn\":{}", .{
            encoded_schema, encoded_payload, envelope.durable, encoded_correlation, envelope.turn,
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
        .correlation = try allocator.dupe(u8, getString(message.object, "correlation") orelse ""),
        .turn = if (message.object.get("turn")) |value| switch (value) {
            .integer => |n| if (n < 0 or n > std.math.maxInt(u8)) return error.InvalidEnvelope else @intCast(n),
            else => return error.InvalidEnvelope,
        } else 0,
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
    conversation: Conversation,
) ![]u8 {
    var envelope: Envelope = .{
        .from = @splat(0),
        .to = to,
        .ref = ref,
        .firing_id = firing_id,
        .schema = msg_schema,
        .payload = payload,
        .durable = durable,
        .correlation = conversation.correlation,
        .turn = conversation.turn,
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

/// Stable logical clock for clients that reconstruct a firing instead of
/// retaining its serialized envelope. The firing id is already required to
/// be unique within a workflow, so deriving the nonce from it gives retries
/// the same canonical stimulus without relying on arrival time.
pub fn nonceForFiring(firing_id: []const u8) u64 {
    const digest = types.digest(firing_id);
    // JSON's interoperable integer representation in the current wire
    // decoder is signed i64, so keep the derived value in that domain.
    return std.mem.readInt(u64, digest[0..8], .big) & std.math.maxInt(i64);
}

/// A standard bridge neuron: the wire payload directs the write. v2 is a
/// schema-versioned JSON object — {"schema":"mesh.proxy/v2",
/// "artifact_id":..., "bytes":...} — decoded strictly: wrong schema tag,
/// missing fields, unknown fields, or malformed JSON are InvalidPayload
/// before any effect exists (§19: opaque input plus explicit decode).
/// v1's raw "<id>\n<bytes>" form is deleted, not flagged: every producer
/// ships in this repo, so the migration window was zero. Decoded strings
/// live in the operator-owned arena, reset per firing — the same lifetime
/// discipline as the effect buffers: stable until the next firing, which
/// is safely past the commit boundary. This is exactly the shape an
/// injected peer would abuse, which is why it only ever runs under a
/// pinned ceiling — the validate → commit boundary rejects anything
/// outside it (§24/§27).
pub const ProxyNeuron = struct {
    arena: *std.heap.ArenaAllocator,
    fx: *[1]types.Effect,
    ev: *[1]types.Evidence,
    src: *[1][]const u8,

    pub const payload_schema = "mesh.proxy/v2";

    pub fn fire(self: *const ProxyNeuron, stim: types.Stimulus, _: Caps) !types.Decision {
        _ = self.arena.reset(.{ .retain_with_limit = 1 << 16 });
        const payload = if (stim.messages.len > 0) stim.messages[0].payload else "";
        const PayloadJ = struct {
            schema: []const u8,
            artifact_id: []const u8,
            bytes: []const u8,
        };
        const parsed = std.json.parseFromSliceLeaky(PayloadJ, self.arena.allocator(), payload, .{}) catch
            return error.InvalidPayload;
        if (!std.mem.eql(u8, parsed.schema, payload_schema)) return error.InvalidPayload;
        if (parsed.artifact_id.len == 0) return error.InvalidPayload;
        self.fx[0] = .{ .write = .{ .id = parsed.artifact_id, .schema = stim.messages[0].schema, .bytes = parsed.bytes } };
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

/// Build a mesh.proxy/v2 payload: explicit typed fields, so artifact ids
/// containing newlines (or any other byte) are unambiguous by
/// construction — the v1 flat "<id>\n<bytes>" form could not say that.
pub fn proxyPayloadV2(allocator: Allocator, artifact_id: []const u8, bytes: []const u8) ![]u8 {
    const id_json = try std.json.Stringify.valueAlloc(allocator, artifact_id, .{});
    defer allocator.free(id_json);
    const bytes_json = try std.json.Stringify.valueAlloc(allocator, bytes, .{});
    defer allocator.free(bytes_json);
    return try std.fmt.allocPrint(allocator, "{{\"schema\":\"{s}\",\"artifact_id\":{s},\"bytes\":{s}}}", .{ ProxyNeuron.payload_schema, id_json, bytes_json });
}

// --- Transport: 4-byte BE length-prefixed frames over any Io byte stream.
// The wire is dumb by design; all authority decisions happen in receive().

pub const net = std.Io.net;

/// The wall clock in milliseconds for daemon and edge paths: delegation
/// expiry and cache TTLs are only real if the clock is. Tests inject
/// fixed clocks instead — determinism is a test property, not a
/// deployment one (§8: the clock is a capability read, so it belongs in
/// the firing record).
pub fn wallNowMs(io: std.Io) u64 {
    const ms = std.Io.Clock.real.now(io).toMilliseconds();
    return if (ms < 0) 0 else @intCast(ms);
}

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

/// The framed result for one admitted envelope, shared by the signed and
/// transport-authenticated serving loops: one wire semantics, not two
/// (§7). The response is information for the peer — it carries no
/// authority: the commit already happened under this node's own ceiling,
/// or nothing happened at all (§27).
pub fn commitResultJson(allocator: Allocator, commit: runtime_mod.CommitResult) ![]u8 {
    return try std.fmt.allocPrint(allocator, "{{\"status\":\"committed\",\"effects_committed\":{},\"duplicates_skipped\":{}}}", .{ commit.effects_committed, commit.duplicates_skipped });
}

/// The answer for a read ref: the same commit summary plus the value, so one
/// response shape covers both and a caller can always read `status`.
pub fn replyResultJson(
    allocator: Allocator,
    commit: runtime_mod.CommitResult,
    reply: []const u8,
) ![]u8 {
    const encoded = try jsonEncodeString(allocator, reply);
    defer allocator.free(encoded);
    return std.fmt.allocPrint(
        allocator,
        "{{\"status\":\"committed\",\"effects_committed\":{},\"duplicates_skipped\":{},\"reply\":{s}}}",
        .{ commit.effects_committed, commit.duplicates_skipped, encoded },
    );
}

pub fn errorResultJson(allocator: Allocator, err: anyerror) ![]u8 {
    return try std.fmt.allocPrint(allocator, "{{\"status\":\"error\",\"error\":\"{s}\"}}", .{@errorName(err)});
}

/// Serve one connection until the peer closes it: every frame is admitted
/// through receive() and answered with a framed result — commit summary or
/// typed error — so one protocol has one semantics on both the signed and
/// transport-authenticated paths. A rejected envelope answers an error
/// frame and the connection keeps serving (§27 typed failures, no silent
/// retries). Fire-and-forget peers close after writing; a broken response
/// pipe ends the connection without undoing anything committed.
pub fn serveConnection(node: *Node, reader: *std.Io.Reader, writer: *std.Io.Writer, now_ms: u64) !usize {
    var received: usize = 0;
    while (true) {
        const maybe = readFrame(node.allocator, reader) catch |err| switch (err) {
            // A fire-and-forget peer's close can surface as a reset once
            // the response is written: same as EOF — the peer is gone and
            // everything already committed stays committed (§27).
            error.ReadFailed => break,
            else => return err,
        };
        const bytes = maybe orelse break;
        defer node.allocator.free(bytes);
        const response = if (node.receive(bytes, now_ms)) |result|
            // A ref that answered a read carries its value; everything else
            // keeps the unchanged commit summary, so adding read refs did not
            // change the shape of any existing answer.
            (if (node.reply) |value|
                try replyResultJson(node.allocator, result.commit, value)
            else
                try commitResultJson(node.allocator, result.commit))
        else |err|
            try errorResultJson(node.allocator, err);
        defer node.allocator.free(response);
        received += 1;
        writeFrame(writer, response) catch return received;
    }
    return received;
}

/// Accept exactly one connection on the listener and serve it to EOF.
/// Read and write buffers stay separate so a pipelined frame buffered by
/// the reader is never clobbered by an outgoing response.
pub fn acceptOnce(
    node: *Node,
    server: *net.Server,
    io: std.Io,
    now_ms: u64,
    read_buffer: []u8,
    write_buffer: []u8,
) !usize {
    const stream = try server.accept(io);
    defer stream.close(io);
    var reader = stream.reader(io, read_buffer);
    var writer = stream.writer(io, write_buffer);
    return serveConnection(node, &reader.interface, &writer.interface, now_ms);
}

/// Monotonic milliseconds for exchange deadlines: immune to wall-clock
/// jumps, so a peer cannot stall a deadline by adjusting the clock.
pub fn monoNowMs(io: std.Io) u64 {
    const ms = std.Io.Clock.awake.now(io).toMilliseconds();
    return if (ms < 0) 0 else @intCast(ms);
}

/// Poll until the fd is ready for `events` or the shared deadline passes.
fn pollWaitBounded(fd: posix.fd_t, events: i16, io: std.Io, deadline_ms: u64) !void {
    const remaining = deadline_ms -| monoNowMs(io);
    if (remaining == 0) return error.Timeout;
    var pfd = [_]posix.pollfd{.{ .fd = fd, .events = events, .revents = 0 }};
    if (try posix.poll(&pfd, @intCast(@min(remaining, @as(u64, std.math.maxInt(i32))))) == 0)
        return error.Timeout;
}

/// A dial bounded by an absolute monotonic deadline (§20). This toolchain's
/// Threaded Io backend panics on connect timeouts, so the bounded path
/// drives the fd directly: non-blocking connect, poll for writable,
/// SO_ERROR for the verdict. The fd STAYS non-blocking: dialExchange
/// reads the response through the same deadline, so a peer that accepts
/// and never answers is as bounded as a peer that never accepts.
/// The deadline converts a dead or silent peer into typed errors —
/// Timeout, ConnectionRefused, NetworkUnreachable — instead of an
/// unbounded hang. Windows keeps the unbounded Io connect until the
/// backend grows support.
pub fn connectBounded(address: *const net.IpAddress, io: std.Io, deadline_ms: u64) !net.Stream {
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
    try pollWaitBounded(fd, posix.POLL.OUT, io, deadline_ms);
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
    // Connected — and deliberately left non-blocking: the exchange above
    // shares this deadline through poll-gated reads and writes. The
    // address field mirrors what accept() fills on the receive side:
    // the peer this stream talks to.
    return .{ .socket = .{ .handle = fd, .address = address.* } };
}

/// Write all bytes to a non-blocking fd, poll-gating on the shared
/// deadline whenever the kernel would block.
fn writeAllBounded(fd: posix.fd_t, io: std.Io, bytes: []const u8, deadline_ms: u64) !void {
    var off: usize = 0;
    while (off < bytes.len) {
        const rc = std.c.write(fd, bytes.ptr + off, bytes.len - off);
        if (rc > 0) {
            off += @intCast(rc);
            continue;
        }
        if (rc == 0) return error.WriteFailed;
        switch (posix.errno(rc)) {
            .AGAIN => try pollWaitBounded(fd, posix.POLL.OUT, io, deadline_ms),
            .INTR => continue,
            .PIPE, .CONNRESET => return error.PeerClosed,
            else => return error.WriteFailed,
        }
    }
}

/// Read exactly buf.len bytes unless EOF arrives first; returns the byte
/// count. Resets surface as EOF: the peer is gone either way (§27).
fn readExactBounded(fd: posix.fd_t, io: std.Io, buf: []u8, deadline_ms: u64) !usize {
    var off: usize = 0;
    while (off < buf.len) {
        const rc = std.c.read(fd, buf.ptr + off, buf.len - off);
        if (rc > 0) {
            off += @intCast(rc);
            continue;
        }
        if (rc == 0) break;
        switch (posix.errno(rc)) {
            .AGAIN => try pollWaitBounded(fd, posix.POLL.IN, io, deadline_ms),
            .INTR => continue,
            .CONNRESET => break,
            else => return error.ReadFailed,
        }
    }
    return off;
}

/// Read one length-prefixed frame from a non-blocking fd under the shared
/// deadline. EOF before any header byte is NoResponse; EOF mid-frame is
/// TruncatedFrame — both typed, neither silent (§27).
fn readFrameBounded(allocator: Allocator, fd: posix.fd_t, io: std.Io, deadline_ms: u64) ![]u8 {
    var header: [4]u8 = undefined;
    const got = try readExactBounded(fd, io, &header, deadline_ms);
    if (got == 0) return error.NoResponse;
    if (got < 4) return error.TruncatedFrame;
    const len = std.mem.readInt(u32, &header, .big);
    if (len > frame_max) return error.FrameTooLarge;
    const payload = try allocator.alloc(u8, len);
    errdefer allocator.free(payload);
    if (try readExactBounded(fd, io, payload, deadline_ms) < len) return error.TruncatedFrame;
    return payload;
}

/// Serve one accepted connection on its raw fd with every read and write
/// gated by ONE absolute monotonic deadline — the accept-side mirror of
/// dialExchange's bounded path: a peer that trickles bytes (slow-loris) or
/// stops reading is cut at the deadline instead of holding a server slot
/// forever. The fd is switched to non-blocking and stays that way; the
/// caller owns closing it. `respond` is the policy hook — it computes the
/// framed response for each admitted payload (the tailnet daemon supplies
/// its ceiling-attributed variant) and MUST be safe under the caller's
/// concurrency model. Errors end the connection: a committed effect stays
/// committed, an unanswered frame commits nothing new (§20, §27).
pub fn serveConnectionBounded(
    node: *Node,
    fd: posix.fd_t,
    io: std.Io,
    now_ms: u64,
    deadline_ms: u64,
    ctx: anytype,
    comptime respond: fn (@TypeOf(ctx), *Node, []const u8, u64) anyerror![]u8,
) !usize {
    const nonblock_bits: c_int = @bitCast(posix.O{ .NONBLOCK = true });
    const flags = std.c.fcntl(fd, posix.F.GETFL);
    if (flags == -1) return error.FcntlFailed;
    if (std.c.fcntl(fd, posix.F.SETFL, flags | nonblock_bits) == -1) return error.FcntlFailed;
    var admitted: usize = 0;
    while (true) {
        const bytes = readFrameBounded(node.allocator, fd, io, deadline_ms) catch |err| switch (err) {
            // Clean close, or a peer that vanished mid-frame: everything
            // already committed stays committed (§27).
            error.NoResponse, error.TruncatedFrame => break,
            else => return err,
        };
        defer node.allocator.free(bytes);
        const response = try respond(ctx, node, bytes, now_ms);
        defer node.allocator.free(response);
        const frame = try node.allocator.alloc(u8, 4 + response.len);
        defer node.allocator.free(frame);
        std.mem.writeInt(u32, frame[0..4], @intCast(response.len), .big);
        @memcpy(frame[4..], response);
        admitted += 1;
        writeAllBounded(fd, io, frame, deadline_ms) catch return admitted;
    }
    return admitted;
}

/// Connect, write one framed envelope, and read the peer's framed result
/// (commit summary or typed error). The response is validated only as JSON
/// shape by callers — it is information, never authority. `timeout_ms`
/// is ONE deadline shared by dial, request write, and response read (§20):
/// a peer that accepts and never answers surfaces error.Timeout inside
/// the budget. Null waits indefinitely on the legacy blocking path, as
/// does Windows until the Io backend grows connect-timeout support.
/// This is the only client shape: fire-and-forget dials were deleted so
/// the wire has exactly one semantics — every frame is answered.
pub fn dialExchange(
    allocator: Allocator,
    address: *const net.IpAddress,
    io: std.Io,
    bytes: []const u8,
    buffer: []u8,
    timeout_ms: ?u32,
) ![]u8 {
    if (timeout_ms) |ms| {
        if (builtin.os.tag != .windows) {
            const deadline = monoNowMs(io) +| ms;
            const stream = try connectBounded(address, io, deadline);
            defer stream.close(io);
            if (bytes.len > frame_max) return error.FrameTooLarge;
            const frame = try allocator.alloc(u8, 4 + bytes.len);
            defer allocator.free(frame);
            std.mem.writeInt(u32, frame[0..4], @intCast(bytes.len), .big);
            @memcpy(frame[4..], bytes);
            try writeAllBounded(stream.socket.handle, io, frame, deadline);
            return try readFrameBounded(allocator, stream.socket.handle, io, deadline);
        }
    }
    const stream = try address.connect(io, .{ .mode = .stream });
    defer stream.close(io);
    var writer = stream.writer(io, buffer);
    try writeFrame(&writer.interface, bytes);
    var reader = stream.reader(io, buffer);
    const response = try readFrame(allocator, &reader.interface);
    return response orelse error.NoResponse;
}
