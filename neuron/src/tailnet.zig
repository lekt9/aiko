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
/// `now_ms` is the accept-time clock: classification is time-dependent
/// (whois cache TTL), so time is an input, never ambient state. The context
/// is mutable because classification may record cache state.
pub const PeerClassifier = struct {
    context: *anyopaque,
    classify: *const fn (context: *anyopaque, peer: IpAddress, now_ms: u64) ?caps_mod.Caps,

    pub fn call(self: PeerClassifier, peer: IpAddress, now_ms: u64) ?caps_mod.Caps {
        return self.classify(self.context, peer, now_ms);
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

/// The single-ceiling classifier: any tailnet peer fires under the one
/// pinned ceiling the operator configured; anything else is denied. The
/// ceiling is OWNED — Caps is a small value struct, so the classifier
/// holds a copy and there is no borrowed pointer whose lifetime could be
/// documented, violated, or dangled. This remains the fallback
/// configuration; `TableClassifier` refines it to per-peer ceilings via
/// `tailscale whois`.
pub const SingleCeiling = struct {
    ceiling: caps_mod.Caps,

    pub fn classifier(self: *SingleCeiling) PeerClassifier {
        return .{
            .context = self,
            .classify = struct {
                fn classify(context: *anyopaque, peer: IpAddress, _: u64) ?caps_mod.Caps {
                    const owner: *SingleCeiling = @ptrCast(@alignCast(context));
                    return if (isTailnetAddress(peer)) owner.ceiling else null;
                }
            }.classify,
        };
    }
};

// --- per-peer ceilings (classifier v2) ---

/// Whois resolution can only fail one way at this boundary: no identity,
/// no admission. Spawn, exit, timeout, and parse failures all collapse to
/// WhoisFailed so the classifier fails closed (§24, §27).
pub const WhoisError = error{WhoisFailed};

/// Resolves a tailnet peer address to its node identity (allocated,
/// caller-owned). Injected so tests never shell out.
pub const WhoisAdapter = struct {
    context: *anyopaque,
    lookup: *const fn (context: *anyopaque, allocator: std.mem.Allocator, io: std.Io, peer: IpAddress) WhoisError![]const u8,

    pub fn call(self: WhoisAdapter, allocator: std.mem.Allocator, io: std.Io, peer: IpAddress) WhoisError![]const u8 {
        return self.lookup(self.context, allocator, io, peer);
    }
};

/// Bound on the whois shell-out: a hung or slow tailscaled denies the peer
/// instead of wedging the accept loop.
pub const whois_timeout_ms: i64 = 2_000;

/// The production adapter: `tailscale whois --json <ip>`, bounded by
/// timeout and output limits. The returned identity is `Node.Name` with
/// the trailing root dot stripped — table identities match that form.
pub fn tailscaleWhois() WhoisAdapter {
    return .{
        .context = undefined,
        .lookup = struct {
            fn lookup(_: *anyopaque, allocator: std.mem.Allocator, io: std.Io, peer: IpAddress) WhoisError![]const u8 {
                var key_buf: [64]u8 = undefined;
                const ip = ipKey(&key_buf, peer) orelse return error.WhoisFailed;
                const result = std.process.run(allocator, io, .{
                    .argv = &.{ "tailscale", "whois", "--json", ip },
                    .timeout = .{ .duration = .{ .raw = .fromMilliseconds(whois_timeout_ms), .clock = .awake } },
                    .stdout_limit = .limited(64 * 1024),
                    .stderr_limit = .limited(4 * 1024),
                }) catch return error.WhoisFailed;
                defer allocator.free(result.stdout);
                defer allocator.free(result.stderr);
                switch (result.term) {
                    .exited => |code| if (code != 0) return error.WhoisFailed,
                    else => return error.WhoisFailed,
                }
                var arena = std.heap.ArenaAllocator.init(allocator);
                defer arena.deinit();
                const WhoisJ = struct { Node: ?struct { Name: []const u8 = "" } = null };
                const parsed = std.json.parseFromSliceLeaky(WhoisJ, arena.allocator(), result.stdout, .{ .ignore_unknown_fields = true }) catch return error.WhoisFailed;
                const node = parsed.Node orelse return error.WhoisFailed;
                if (node.Name.len == 0) return error.WhoisFailed;
                const trimmed = std.mem.trimEnd(u8, node.Name, ".");
                return allocator.dupe(u8, trimmed) catch return error.WhoisFailed;
            }
        }.lookup,
    };
}

/// Schema tag for the operator ceiling table.
pub const ceilings_schema = "neuron.tailnet-ceilings/v1";

/// The operator-configured ceiling table: tailnet node identity → pinned
/// ceiling, deny-by-default for unlisted identities. Parsed strictly —
/// unknown fields, a wrong schema tag, or a duplicate identity are
/// InvalidTable, never silently ignored (§19, §27).
pub const CeilingTable = struct {
    arena: std.heap.ArenaAllocator,
    map: std.StringHashMap(caps_mod.Caps),

    pub const ParseError = error{ OutOfMemory, InvalidTable };

    pub fn parse(gpa: std.mem.Allocator, bytes: []const u8) ParseError!CeilingTable {
        const BudgetJ = struct {
            max_effects: usize = 32,
            max_writes: usize = 8,
            max_messages: usize = 16,
            max_spawns: usize = 8,
            max_bytes: usize = 1024 * 1024,
            max_depth: u8 = 8,
        };
        const CapsJ = struct {
            allow_write: bool = false,
            allow_send: bool = false,
            allow_spawn: bool = false,
            write_prefix: []const u8 = "",
            send_prefix: []const u8 = "",
            spawn_prefix: []const u8 = "",
            budget: BudgetJ = .{},
        };
        const PeerJ = struct {
            identity: []const u8,
            ceiling: CapsJ = .{},
        };
        const TableJ = struct {
            schema: []const u8,
            peers: []const PeerJ = &.{},
        };
        var arena = std.heap.ArenaAllocator.init(gpa);
        errdefer arena.deinit();
        const parsed = std.json.parseFromSliceLeaky(TableJ, arena.allocator(), bytes, .{}) catch return error.InvalidTable;
        if (!std.mem.eql(u8, parsed.schema, ceilings_schema)) return error.InvalidTable;
        var map = std.StringHashMap(caps_mod.Caps).init(arena.allocator());
        for (parsed.peers) |peer| {
            if (peer.identity.len == 0) return error.InvalidTable;
            const jc = peer.ceiling;
            const ceiling: caps_mod.Caps = .{
                .allow_write = jc.allow_write,
                .allow_send = jc.allow_send,
                .allow_spawn = jc.allow_spawn,
                .write_prefix = jc.write_prefix,
                .send_prefix = jc.send_prefix,
                .spawn_prefix = jc.spawn_prefix,
                .budget = .{
                    .max_effects = jc.budget.max_effects,
                    .max_writes = jc.budget.max_writes,
                    .max_messages = jc.budget.max_messages,
                    .max_spawns = jc.budget.max_spawns,
                    .max_bytes = jc.budget.max_bytes,
                    .max_depth = jc.budget.max_depth,
                },
            };
            if (map.contains(peer.identity)) return error.InvalidTable;
            map.put(peer.identity, ceiling) catch return error.OutOfMemory;
        }
        return .{ .arena = arena, .map = map };
    }

    /// The ceiling pinned for an identity, or null — deny by default.
    pub fn lookup(self: *const CeilingTable, identity: []const u8) ?caps_mod.Caps {
        return self.map.get(identity);
    }

    pub fn deinit(self: *CeilingTable) void {
        self.arena.deinit();
    }
};

/// Classifier v2: peer IP → whois identity → per-peer ceiling. Whois
/// results are cached per IP with a TTL; a whois failure denies before a
/// single byte is read, and an unlisted identity denies at the table.
/// The daemon loop is single-threaded, so the cache needs no locking.
pub const TableClassifier = struct {
    gpa: std.mem.Allocator,
    io: std.Io,
    table: CeilingTable,
    adapter: WhoisAdapter,
    ttl_ms: u64,
    cache: std.StringHashMap(CacheEntry),

    pub const max_cache_entries = 256;

    const CacheEntry = struct {
        identity: []const u8,
        expires_at_ms: u64,
    };

    pub fn init(gpa: std.mem.Allocator, io: std.Io, table: CeilingTable, adapter: WhoisAdapter, ttl_ms: u64) TableClassifier {
        return .{
            .gpa = gpa,
            .io = io,
            .table = table,
            .adapter = adapter,
            .ttl_ms = ttl_ms,
            .cache = std.StringHashMap(CacheEntry).init(gpa),
        };
    }

    pub fn deinit(self: *TableClassifier) void {
        var it = self.cache.iterator();
        while (it.next()) |entry| {
            self.gpa.free(entry.key_ptr.*);
            self.gpa.free(entry.value_ptr.identity);
        }
        self.cache.deinit();
        self.table.deinit();
    }

    pub fn classifier(self: *TableClassifier) PeerClassifier {
        return .{
            .context = self,
            .classify = struct {
                fn classify(context: *anyopaque, peer: IpAddress, now_ms: u64) ?caps_mod.Caps {
                    const tc: *TableClassifier = @ptrCast(@alignCast(context));
                    return tc.classifyPeer(peer, now_ms);
                }
            }.classify,
        };
    }

    /// CGNAT gate → TTL cache → adapter → table. Any failure along the
    /// chain denies; a full cache degrades to pass-through, never a deny.
    fn classifyPeer(self: *TableClassifier, peer: IpAddress, now_ms: u64) ?caps_mod.Caps {
        if (!isTailnetAddress(peer)) return null;
        var key_buf: [64]u8 = undefined;
        const key = ipKey(&key_buf, peer) orelse return null;
        if (self.cache.getPtr(key)) |entry| {
            if (now_ms < entry.expires_at_ms) return self.table.lookup(entry.identity);
            // Expired: evict before the fresh lookup replaces it.
            const kv = self.cache.fetchRemove(key).?;
            self.gpa.free(kv.key);
            self.gpa.free(kv.value.identity);
        }
        const fresh = self.adapter.call(self.gpa, self.io, peer) catch return null;
        var owned_by_cache = false;
        if (self.cache.count() < max_cache_entries) {
            if (self.gpa.dupe(u8, key)) |owned_key| {
                if (self.cache.put(owned_key, .{ .identity = fresh, .expires_at_ms = now_ms +| self.ttl_ms })) {
                    owned_by_cache = true;
                } else |_| {
                    self.gpa.free(owned_key);
                }
            } else |_| {}
        }
        // The ceiling is a value; its slices borrow the table arena, never
        // the identity string, so an uncached identity is freed after use.
        defer if (!owned_by_cache) self.gpa.free(fresh);
        return self.table.lookup(fresh);
    }
};

/// The cache/argv key for a peer: the dotted-quad of its v4 (or mapped-v4)
/// bytes, without the ephemeral source port. Non-v4 peers have no key —
/// they fail the CGNAT gate anyway.
fn ipKey(buf: []u8, peer: IpAddress) ?[]const u8 {
    const bytes: [4]u8 = switch (peer) {
        .ip4 => |a| a.bytes,
        .ip6 => |a| blk: {
            if (!std.mem.eql(u8, a.bytes[0..12], &.{ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff }))
                return null;
            break :blk a.bytes[12..].*;
        },
    };
    return std.fmt.bufPrint(buf, "{}.{}.{}.{}", .{ bytes[0], bytes[1], bytes[2], bytes[3] }) catch null;
}

/// The framed result for one admitted envelope over a trusted pipe: the
/// same shape the signed path answers, built by the same helpers — one
/// protocol, one semantics (mesh.commitResultJson / errorResultJson).
fn responseJson(node: *mesh_mod.Node, bytes: []const u8, now_ms: u64, ceiling: caps_mod.Caps) ![]u8 {
    if (node.receiveTrusted(bytes, now_ms, ceiling)) |result| {
        // A read ref answers with its value; everything else keeps the
        // unchanged commit summary. Both paths encode identically, so the
        // trusted pipe and the signed pipe still have one semantics.
        if (node.reply) |value| {
            return try mesh_mod.replyResultJson(node.allocator, result.commit, value);
        }
        return try mesh_mod.commitResultJson(node.allocator, result.commit);
    } else |err| {
        return try mesh_mod.errorResultJson(node.allocator, err);
    }
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
    const ceiling = classify.call(stream.socket.address, now_ms) orelse return null;
    var reader = stream.reader(io, read_buffer);
    var writer = stream.writer(io, write_buffer);
    return try serveConnection(node, &reader.interface, &writer.interface, now_ms, ceiling);
}

pub const ServeOptions = struct {
    /// Maximum connections served concurrently; peers beyond the cap are
    /// closed unread — fail closed under load, the kernel backlog is the
    /// queue (§26 budgets).
    max_connections: usize = 64,
    /// One absolute monotonic budget per connection, shared by every read
    /// and write it performs: a trickling (slow-loris) or non-reading peer
    /// is cut at the deadline instead of holding a server slot forever.
    connection_budget_ms: u32 = 30_000,
    /// Set to stop the daemon: the accept loop exits after the next accept
    /// (connect once to wake a blocked accept) and in-flight connections
    /// drain within one connection budget.
    stop: ?*const std.atomic.Value(bool) = null,
};

/// In-flight connection accounting: one mutex-guarded count serves both
/// the concurrency cap and shutdown draining (the 0.16 stdlib has no
/// WaitGroup; this is exactly one).
const Drain = struct {
    mutex: std.Io.Mutex = .init,
    cond: std.Io.Condition = .init,
    in_flight: usize = 0,

    fn begin(self: *Drain, io: std.Io) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        self.in_flight += 1;
    }

    fn end(self: *Drain, io: std.Io) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        self.in_flight -= 1;
        if (self.in_flight == 0) self.cond.signal(io);
    }

    fn count(self: *Drain, io: std.Io) usize {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        return self.in_flight;
    }

    /// Block until every in-flight connection ends; bounded by one
    /// connection budget because each dies at its own deadline.
    fn wait(self: *Drain, io: std.Io) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        while (self.in_flight != 0) self.cond.waitUncancelable(io, &self.mutex);
    }
};

/// One accepted connection's serving context. The stream moves into the
/// task by value; the task closes it exactly once, on every exit path.
const ConnectionTask = struct {
    node: *mesh_mod.Node,
    stream: mesh_mod.net.Stream,
    io: std.Io,
    now_ms: u64,
    deadline_ms: u64,
    ceiling: caps_mod.Caps,
    commit_mutex: *std.Io.Mutex,
    drain: *Drain,

    fn run(task: ConnectionTask) void {
        defer task.drain.end(task.io);
        defer task.stream.close(task.io);
        _ = mesh_mod.serveConnectionBounded(
            task.node,
            task.stream,
            task.io,
            task.now_ms,
            task.deadline_ms,
            task,
            respond,
        ) catch {};
    }

    fn respond(task: ConnectionTask, node: *mesh_mod.Node, bytes: []const u8, now_ms: u64) ![]u8 {
        // The substrate is single-writer: commits serialize here even
        // though reads and response writes run concurrently (§22).
        task.commit_mutex.lockUncancelable(task.io);
        defer task.commit_mutex.unlock(task.io);
        return responseJson(node, bytes, now_ms, task.ceiling);
    }
};

/// The daemon: accept connections forever, each classified on arrival and
/// served on its own thread under a per-connection monotonic deadline, so
/// one slow peer can never wedge the rest. A null `now_ms` reads the wall
/// clock at accept time — the production posture, so delegation expiry and
/// whois cache TTLs are live. Tests pass a fixed clock.
pub fn serve(
    node: *mesh_mod.Node,
    server: *std.Io.net.Server,
    io: std.Io,
    classify: PeerClassifier,
    now_ms: ?u64,
    options: ServeOptions,
) !void {
    var commit_mutex: std.Io.Mutex = .init;
    var drain: Drain = .{};
    // Every return path drains in-flight connections; each dies at its own
    // deadline, so the wait is bounded by one connection budget.
    defer drain.wait(io);
    while (true) {
        if (options.stop) |stop| if (stop.load(.acquire)) return;
        const stream = try server.accept(io);
        if (options.stop) |stop| if (stop.load(.acquire)) {
            stream.close(io);
            return;
        };
        const now = now_ms orelse mesh_mod.wallNowMs(io);
        const ceiling = classify.call(stream.socket.address, now) orelse {
            stream.close(io);
            continue;
        };
        if (drain.count(io) >= options.max_connections) {
            // Fail closed under load: no reads, no application queue — the
            // kernel backlog holds pending peers and the rest retry (§27).
            stream.close(io);
            continue;
        }
        const task: ConnectionTask = .{
            .node = node,
            .stream = stream,
            .io = io,
            .now_ms = now,
            .deadline_ms = mesh_mod.monoNowMs(io) +| options.connection_budget_ms,
            .ceiling = ceiling,
            .commit_mutex = &commit_mutex,
            .drain = &drain,
        };
        drain.begin(io);
        const thread = std.Thread.spawn(.{}, ConnectionTask.run, .{task}) catch {
            // Spawn failure fails closed: the peer is dropped, the daemon
            // keeps serving (§27 typed degradation, never a wedged accept).
            drain.end(io);
            stream.close(io);
            continue;
        };
        thread.detach();
    }
}
