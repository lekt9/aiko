//! MCP stdio edge: newline-delimited JSON-RPC 2.0 for foreign harnesses.
//!
//! Aiko and any other MCP client — anything that speaks MCP — launches this as a
//! stdio server and gains two tools: `neuron.info` (who is this node, what
//! may I ask) and `neuron.fire` (stimulate a neuron). The edge is a limb
//! with no ambient authority (§30): every tool call becomes an unsigned
//! envelope admitted through `receiveTrusted` under the tightest ceiling the
//! operator pinned for this edge (§24). The harness never sees envelopes,
//! keys, or caps — it sees tools, commit results, and typed errors like
//! `CapabilityDenied`. Firing ids are honored verbatim so a retried tool
//! call is absorbed by the runtime's identity dedupe (§21).
//!
//! The edge is also the tailnet gateway: `neuron.fire` with an `address`
//! argument dials that mesh peer over the tailnet and returns its framed
//! commit result. Egress is restricted to the tailnet CGNAT range by the
//! same predicate that guards the receive side — without it the edge
//! would be an SSRF proxy that speaks envelopes. There is no authority
//! amplification: the local ceiling governs local fires, and the remote
//! node's own classifier and pinned ceiling govern remote ones.

const std = @import("std");
const caps_mod = @import("caps.zig");
const mesh_mod = @import("mesh.zig");
const tailnet_mod = @import("tailnet.zig");
const identity = @import("identity.zig");

const Allocator = std.mem.Allocator;

pub const protocol_version = "2025-06-18";
pub const server_name = "neuron-mcp";
pub const server_version = "0.1.0";
/// §20 deadline on remote dials: an offline or dead tailnet peer must
/// surface as a typed error, not wedge the edge. Ten seconds is generous
/// for tailnet RTTs and short enough to keep a stdio server lively.
pub const dial_timeout_ms: u32 = 10_000;

pub const Server = struct {
    allocator: Allocator,
    node: *mesh_mod.Node,
    ceiling: caps_mod.Caps,
    /// Fixed admission clock for deterministic tests; null reads the wall
    /// clock at fire time, which is what production edges do. The envelope
    /// carries a separate stable logical clock for firing identity.
    now_ms: ?u64,
    io: std.Io,
    /// Egress guard for remote fires: the edge may only dial addresses
    /// this predicate honors. Production pins it to the tailnet CGNAT
    /// range; tests inject loopback. Deny-by-default is the whole point.
    egress_allow: *const fn (mesh_mod.net.IpAddress) bool = tailnet_mod.isTailnetAddress,
    nonce: u64 = 0,

    /// Serve NDJSON RPC until EOF. One JSON-RPC message per line in each
    /// direction; notifications (messages without an id) get no response.
    pub fn serve(self: *Server, reader: *std.Io.Reader, writer: *std.Io.Writer) !void {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        while (true) {
            const maybe = reader.takeDelimiter('\n') catch |err| switch (err) {
                error.StreamTooLong => continue,
                error.ReadFailed => return err,
            };
            const line = maybe orelse break;
            _ = arena.reset(.{ .retain_with_limit = 1 << 16 });
            if (std.mem.trim(u8, line, " \t\r").len == 0) continue;
            if (try self.handleLine(arena.allocator(), line)) |text| {
                try writer.writeAll(text);
                try writer.writeAll("\n");
                try writer.flush();
            }
        }
    }

    /// Handle one JSON-RPC message. Returns null for notifications.
    pub fn handleLine(self: *Server, allocator: Allocator, line: []const u8) !?[]u8 {
        const parsed = try std.json.parseFromSliceLeaky(std.json.Value, allocator, line, .{});
        if (parsed != .object) return error.InvalidRequest;
        const root = parsed.object;
        const method = switch (root.get("method") orelse return error.InvalidRequest) {
            .string => |text| text,
            else => return error.InvalidRequest,
        };
        const id: ?std.json.Value = root.get("id");
        if (std.mem.eql(u8, method, "initialize")) {
            return try respond(allocator, id, initialize_result_json);
        }
        if (std.mem.startsWith(u8, method, "notifications/")) return null;
        if (std.mem.eql(u8, method, "ping")) {
            return try respond(allocator, id, "{}");
        }
        if (std.mem.eql(u8, method, "tools/list")) {
            return try respond(allocator, id, tools_list_json);
        }
        if (std.mem.eql(u8, method, "tools/call")) {
            const params = root.get("params") orelse return error.InvalidParams;
            if (params != .object) return error.InvalidParams;
            const name = switch (params.object.get("name") orelse return error.InvalidParams) {
                .string => |text| text,
                else => return error.InvalidParams,
            };
            const arguments = params.object.get("arguments") orelse
                (std.json.Value{ .object = .empty });
            if (std.mem.eql(u8, name, "neuron.info")) {
                return try respond(allocator, id, try self.toolInfo(allocator));
            }
            if (std.mem.eql(u8, name, "neuron.fire")) {
                const result_json = self.toolFire(allocator, arguments) catch |err| {
                    return try respondError(allocator, id, -32000, @errorName(err));
                };
                return try respond(allocator, id, result_json);
            }
            return try respondError(allocator, id, -32602, "unknown tool");
        }
        return try respondError(allocator, id, -32601, "method not found");
    }

    /// {"content":[{"type":"text","text":"<json>"}]} with the payload JSON
    /// transported as text, per MCP tool-result convention.
    fn toolInfo(self: *Server, allocator: Allocator) ![]u8 {
        var id_hex: [64]u8 = undefined;
        var inner: std.Io.Writer.Allocating = .init(allocator);
        const iw = &inner.writer;
        try iw.writeAll("{\"node\":\"");
        try iw.writeAll(identity.nodeIdHex(self.node.id(), &id_hex));
        try iw.writeAll("\",\"edge\":\"mcp-stdio\",\"neurons\":[");
        var first = true;
        var it = self.node.registry.keyIterator();
        while (it.next()) |key| {
            if (!first) try iw.writeAll(",");
            first = false;
            try writeJsonString(iw, allocator, key.*);
        }
        try iw.print("],\"ceiling\":{{\"allow_write\":{},\"allow_send\":{},\"allow_spawn\":{},\"write_prefix\":", .{
            self.ceiling.allow_write, self.ceiling.allow_send, self.ceiling.allow_spawn,
        });
        try writeJsonString(iw, allocator, self.ceiling.write_prefix);
        try iw.writeAll("}}}");
        return try toolResult(allocator, try inner.toOwnedSlice());
    }

    fn toolFire(self: *Server, allocator: Allocator, arguments: std.json.Value) ![]u8 {
        if (arguments != .object) return error.InvalidParams;
        const args = arguments.object;
        const ref = try argString(args, "ref");
        const payload = try argString(args, "payload");
        const msg_schema = if (args.get("schema")) |value| switch (value) {
            .string => |text| text,
            else => return error.InvalidParams,
        } else "mcp.fire/v1";
        self.nonce +%= 1;
        var firing_buf: [96]u8 = undefined;
        const firing_id = if (args.get("firing_id")) |value| switch (value) {
            .string => |text| text,
            else => return error.InvalidParams,
        } else try std.fmt.bufPrint(&firing_buf, "mcp/{d}", .{self.nonce});
        if (args.get("address")) |value| {
            return try self.toolFireRemote(allocator, value, ref, payload, msg_schema, firing_id);
        }
        const bytes = try mesh_mod.unsignedEnvelopeJson(
            allocator,
            self.node.id(),
            ref,
            msg_schema,
            payload,
            true,
            firing_id,
            mesh_mod.nonceForFiring(firing_id),
            // Same posture as the remote path: a tool call is not a
            // conversation the local neuron can answer back into.
            .one_way,
        );
        const now = self.now_ms orelse mesh_mod.wallNowMs(self.io);
        const result = try self.node.receiveTrusted(bytes, now, self.ceiling);
        var inner: std.Io.Writer.Allocating = .init(allocator);
        const iw = &inner.writer;
        try iw.writeAll("{\"status\":\"committed\",\"firing_id\":");
        try writeJsonString(iw, allocator, firing_id);
        try iw.print(",\"effects_committed\":{},\"duplicates_skipped\":{}}}", .{
            result.commit.effects_committed, result.commit.duplicates_skipped,
        });
        return try toolResult(allocator, try inner.toOwnedSlice());
    }

    /// Remote fire: dial a tailnet mesh peer and return its framed result
    /// verbatim — commit summary or the peer's own typed error. The
    /// wildcard recipient is sound here because the transport chose the
    /// node (§10). The peer's response is information for the caller; it
    /// carries no authority on this side, and this side's ceiling is not
    /// consulted — the remote node's own classifier and ceiling govern.
    fn toolFireRemote(
        self: *Server,
        allocator: Allocator,
        address_value: std.json.Value,
        ref: []const u8,
        payload: []const u8,
        msg_schema: []const u8,
        firing_id: []const u8,
    ) ![]u8 {
        const text = switch (address_value) {
            .string => |raw| raw,
            else => return error.InvalidParams,
        };
        const address = mesh_mod.net.IpAddress.parseLiteral(text) catch return error.InvalidParams;
        if (!self.egress_allow(address)) return error.EgressDenied;
        const wildcard_to: mesh_mod.NodeId = @splat(0);
        const bytes = try mesh_mod.unsignedEnvelopeJson(
            allocator,
            wildcard_to,
            ref,
            msg_schema,
            payload,
            true,
            firing_id,
            mesh_mod.nonceForFiring(firing_id),
            // The MCP edge is a one-shot tool call with no durable inbox to
            // answer on, so it opens no conversation.
            .one_way,
        );
        var io_buffer: [16 * 1024]u8 = undefined;
        const response = try mesh_mod.dialExchange(allocator, &address, self.io, bytes, &io_buffer, dial_timeout_ms);
        return try toolResult(allocator, response);
    }
};

fn writeJsonString(w: *std.Io.Writer, allocator: Allocator, raw: []const u8) !void {
    const encoded = try std.json.Stringify.valueAlloc(allocator, raw, .{});
    try w.writeAll(encoded);
}

fn toolResult(allocator: Allocator, inner_json: []const u8) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(allocator);
    const w = &out.writer;
    try w.writeAll("{\"content\":[{\"type\":\"text\",\"text\":");
    try writeJsonString(w, allocator, inner_json);
    try w.writeAll("}]}");
    return out.toOwnedSlice();
}

fn argString(args: std.json.ObjectMap, key: []const u8) ![]const u8 {
    const value = args.get(key) orelse return error.InvalidParams;
    return switch (value) {
        .string => |text| text,
        else => error.InvalidParams,
    };
}

fn idText(allocator: Allocator, id: std.json.Value) ![]u8 {
    return switch (id) {
        .integer => |number| try std.fmt.allocPrint(allocator, "{}", .{number}),
        .string => |text| try std.json.Stringify.valueAlloc(allocator, text, .{}),
        else => error.InvalidRequest,
    };
}

fn respond(allocator: Allocator, id: ?std.json.Value, result_json: []const u8) !?[]u8 {
    const rpc_id = id orelse return null;
    return try std.fmt.allocPrint(allocator, "{{\"jsonrpc\":\"2.0\",\"id\":{s},\"result\":{s}}}", .{
        try idText(allocator, rpc_id), result_json,
    });
}

fn respondError(allocator: Allocator, id: ?std.json.Value, code: i64, message: []const u8) !?[]u8 {
    const rpc_id = id orelse return null;
    var out: std.Io.Writer.Allocating = .init(allocator);
    const w = &out.writer;
    try w.print("{{\"jsonrpc\":\"2.0\",\"id\":{s},\"error\":{{\"code\":{},\"message\":", .{
        try idText(allocator, rpc_id), code,
    });
    try writeJsonString(w, allocator, message);
    try w.writeAll("}}}");
    return try out.toOwnedSlice();
}

const initialize_result_json =
    \\{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"neuron-mcp","version":"0.1.0"}}
;

const tools_list_json =
    \\{"tools":[{"name":"neuron.info","description":"Who is this neuron node and what may I ask of it: node id, registered neuron refs, and the capability ceiling this edge enforces.","inputSchema":{"type":"object","properties":{}}},{"name":"neuron.fire","description":"Stimulate a neuron on this node, or on a tailnet mesh peer when address is given. The firing is admitted under the governing node's pinned capability ceiling and committed atomically, or not at all; pass a stable firing_id to make retries idempotent. Remote fires dial only tailnet (100.64.0.0/10) peers and return the peer's framed commit result.","inputSchema":{"type":"object","required":["ref","payload"],"properties":{"ref":{"type":"string","description":"Registered neuron id to stimulate, e.g. mesh/proxy"},"payload":{"type":"string","description":"Typed message payload; for mesh/proxy: a mesh.proxy/v2 JSON object — {\"schema\":\"mesh.proxy/v2\",\"artifact_id\":\"...\",\"bytes\":\"...\"}"},"schema":{"type":"string","description":"Message schema, default mcp.fire/v1"},"firing_id":{"type":"string","description":"Stable id for idempotent retries"},"address":{"type":"string","description":"Optional tailnet mesh peer as ip:port (100.64.0.0/10 only); the fire is relayed there and the peer's framed result returned"}}}}]}
;
