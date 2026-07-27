//! Tailnet transport authentication for the mesh daemon.
//!
//! Inside a Tailscale tailnet the transport already proves machine identity
//! (WireGuard keys, tailnet admission, encrypted pipes), so envelope-level
//! signatures are redundant there (§8 receptors: the transport limb is where
//! provider identity ends). What the tailnet does NOT decide is capability:
//! a peer being "in the network" authorizes nothing by itself. This module
//! maps an authenticated peer to a pinned capability ceiling — deny by
//! default, shaped on admission (§24). The neuron then fires under that
//! ceiling through the ordinary validate → commit boundary, so an injected
//! or compromised peer can never exceed what the operator pinned.

const std = @import("std");
const caps_mod = @import("caps.zig");
const mesh_mod = @import("mesh.zig");

pub const IpAddress = std.Io.net.IpAddress;

/// A peer classifier answers one question: given the authenticated transport
/// peer, which capability ceiling — if any — does this node honor for it?
/// null means deny: the connection is dropped before any byte is admitted.
pub const PeerClassifier = struct {
    context: *const anyopaque,
    classify: *const fn (context: *const anyopaque, peer: IpAddress) ?caps_mod.Caps,

    pub fn call(self: PeerClassifier, peer: IpAddress) ?caps_mod.Caps {
        return self.classify(self.context, peer);
    }
};

/// Tailscale assigns nodes from the carrier-grade NAT range
/// 100.64.0.0/10 (and only ever routes tailnet peers from it).
/// (std.Io.net.Ip4Address.fromAny has a broken return type in this
/// toolchain, so the mapped-v6 case is unfolded by hand.)
pub fn isTailnetAddress(peer: IpAddress) bool {
    const bytes: [4]u8 = switch (peer) {
        .ip4 => |ip4| ip4.bytes,
        .ip6 => |ip6| blk: {
            if (!std.mem.eql(u8, ip6.bytes[0..12], &.{ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff }))
                return false;
            break :blk ip6.bytes[12..].*;
        },
    };
    return bytes[0] == 100 and (bytes[1] & 0xC0) == 0x40;
}

/// The production classifier: any tailnet peer fires under the one pinned
/// ceiling the operator configured; anything else is denied. The ceiling is
/// borrowed — the caller keeps it alive. v1.5 refines this to per-peer
/// ceilings via `tailscale whois`.
pub fn tailnetClassifier(ceiling: *const caps_mod.Caps) PeerClassifier {
    return .{
        .context = ceiling,
        .classify = struct {
            fn classify(context: *const anyopaque, peer: IpAddress) ?caps_mod.Caps {
                const pinned: *const caps_mod.Caps = @ptrCast(@alignCast(context));
                return if (isTailnetAddress(peer)) pinned.* else null;
            }
        }.classify,
    };
}

/// The framed result for one admitted envelope: a commit summary on
/// success, a typed error name on rejection. The response is information
/// for the peer — it carries no authority: the commit already happened
/// under this node's own pinned ceiling, or nothing happened at all (§27).
fn responseJson(node: *mesh_mod.Node, bytes: []const u8, now_ms: u64, ceiling: caps_mod.Caps) ![]u8 {
    const result = node.receiveTrusted(bytes, now_ms, ceiling) catch |err| {
        return try std.fmt.allocPrint(node.allocator, "{{\"status\":\"error\",\"error\":\"{s}\"}}", .{@errorName(err)});
    };
    return try std.fmt.allocPrint(node.allocator, "{{\"status\":\"committed\",\"effects_committed\":{},\"duplicates_skipped\":{}}}", .{ result.commit.effects_committed, result.commit.duplicates_skipped });
}

/// Serve one already-accepted connection under a classified ceiling. Every
/// well-formed frame gets a framed result back — commit summary or typed
/// error — so gateways can report remote outcomes (§27 typed failures, no
/// silent retries: a rejected envelope commits nothing and the connection
/// keeps serving). Fire-and-forget peers close after writing; a broken
/// response pipe ends the connection without undoing anything committed.
pub fn serveConnection(
    node: *mesh_mod.Node,
    reader: *std.Io.Reader,
    writer: *std.Io.Writer,
    now_ms: u64,
    ceiling: caps_mod.Caps,
) !usize {
    var admitted: usize = 0;
    while (true) {
        const maybe = mesh_mod.readFrame(node.allocator, reader) catch |err| switch (err) {
            // A fire-and-forget peer's close can surface as a reset once
            // the response is written: same as EOF — the peer is gone and
            // everything already committed stays committed (§27).
            error.ReadFailed => break,
            else => return err,
        };
        const bytes = maybe orelse break;
        defer node.allocator.free(bytes);
        const response = try responseJson(node, bytes, now_ms, ceiling);
        defer node.allocator.free(response);
        admitted += 1;
        mesh_mod.writeFrame(writer, response) catch return admitted;
    }
    return admitted;
}

/// Accept exactly one connection, classify its peer, and serve it — or drop
/// it before a single byte is read when the classifier denies. Returns null
/// for a denied peer (fail-closed: nothing was admitted, nothing fired).
/// Read and write buffers stay separate so a pipelined frame buffered by
/// the reader is never clobbered by an outgoing response.
pub fn acceptOnce(
    node: *mesh_mod.Node,
    server: *std.Io.net.Server,
    io: std.Io,
    classify: PeerClassifier,
    now_ms: u64,
    read_buffer: []u8,
    write_buffer: []u8,
) !?usize {
    const stream = try server.accept(io);
    defer stream.close(io);
    const ceiling = classify.call(stream.socket.address) orelse return null;
    var reader = stream.reader(io, read_buffer);
    var writer = stream.writer(io, write_buffer);
    return try serveConnection(node, &reader.interface, &writer.interface, now_ms, ceiling);
}

/// The daemon: accept connections forever, each classified on arrival.
pub fn serve(
    node: *mesh_mod.Node,
    server: *std.Io.net.Server,
    io: std.Io,
    classify: PeerClassifier,
    now_ms: u64,
) !void {
    var read_buffer: [64 * 1024]u8 = undefined;
    var write_buffer: [64 * 1024]u8 = undefined;
    while (true) {
        _ = try acceptOnce(node, server, io, classify, now_ms, &read_buffer, &write_buffer);
    }
}
