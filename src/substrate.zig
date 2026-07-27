const std = @import("std");
const types = @import("types.zig");

const Allocator = std.mem.Allocator;

pub const OwnedArtifact = struct {
    schema: []u8,
    bytes: []u8,
    digest: types.Digest,
    produced_by: []u8,
};

pub const StoredMessage = struct {
    firing_id: []u8,
    to: []u8,
    schema: []u8,
    payload: []u8,
    durable: bool,
    status: DeliveryStatus = .queued,
    attempts: u8 = 0,
    max_attempts: u8 = 3,

    pub fn deinit(self: StoredMessage, allocator: Allocator) void {
        allocator.free(self.firing_id);
        allocator.free(self.to);
        allocator.free(self.schema);
        allocator.free(self.payload);
    }
};

pub const DeliveryStatus = enum { queued, acknowledged, dead_letter, reconciliation_required };

const caps_mod = @import("caps.zig");

/// An owned copy of a delegated grant, recorded at the commit boundary so a
/// spawned neuron can later be attached with exactly this authority — never
/// more (§24). `null` on the parent record means deny-all.
pub const OwnedCaps = struct {
    allow_write: bool,
    allow_send: bool,
    allow_spawn: bool,
    write_prefix: []u8,
    send_prefix: []u8,
    spawn_prefix: []u8,
    budget: caps_mod.Budget,

    /// Borrows the owned prefixes; valid while the record lives.
    pub fn toCaps(self: *const OwnedCaps) caps_mod.Caps {
        return .{
            .allow_write = self.allow_write,
            .allow_send = self.allow_send,
            .allow_spawn = self.allow_spawn,
            .write_prefix = self.write_prefix,
            .send_prefix = self.send_prefix,
            .spawn_prefix = self.spawn_prefix,
            .budget = self.budget,
        };
    }

    pub fn deinit(self: OwnedCaps, allocator: Allocator) void {
        allocator.free(self.write_prefix);
        allocator.free(self.send_prefix);
        allocator.free(self.spawn_prefix);
    }
};

pub const SpawnedNeuron = struct {
    firing_id: []u8,
    kind: []u8,
    /// Generation of this neuron within its workflow (parent depth + 1, §26).
    depth: u8,
    /// Fingerprint of the authority actually delegated to the child. A spawn
    /// with no explicit grant records the deny-all fingerprint (§24).
    caps_digest: types.Digest,
    /// The delegated grant itself, kept so the harness can attach the neuron
    /// later with precisely this authority.
    grant: ?OwnedCaps,

    pub fn deinit(self: SpawnedNeuron, allocator: Allocator) void {
        allocator.free(self.firing_id);
        allocator.free(self.kind);
        if (self.grant) |grant| grant.deinit(allocator);
    }
};

pub const FiringStatus = enum { committed, rejected, failed, timed_out, cancelled };

pub const FiringRecord = struct {
    decision_digest: types.Digest,
    effects_committed: usize,
    status: FiringStatus,
};

/// One staged commit item: owned copies ready to move into the substrate.
/// Staged by the runtime, journaled by the substrate, then applied — in
/// that order, so the log is always ahead of memory (WAL).
pub const Pending = union(enum) {
    write: struct { id: []u8, schema: []u8, bytes: []u8, digest: types.Digest, produced_by: []u8 },
    send: StoredMessage,
    spawn: struct { id: []u8, value: SpawnedNeuron },

    pub fn deinit(self: Pending, allocator: Allocator) void {
        switch (self) {
            .write => |write| {
                allocator.free(write.id);
                allocator.free(write.schema);
                allocator.free(write.bytes);
                allocator.free(write.produced_by);
            },
            .send => |message| message.deinit(allocator),
            .spawn => |spawn| {
                allocator.free(spawn.id);
                spawn.value.deinit(allocator);
            },
        }
    }
};

pub const Substrate = struct {
    allocator: Allocator,
    artifacts: std.StringHashMap(OwnedArtifact),
    messages: std.ArrayList(StoredMessage) = .empty,
    neurons: std.StringHashMap(SpawnedNeuron),
    firings: std.StringHashMap(FiringRecord),
    /// The durable commit journal: null means process-local (init). When
    /// present, every mutation is appended and synced BEFORE the in-memory
    /// maps change, so the log is always ahead of memory and replay
    /// rebuilds the exact committed state (§9, §22).
    journal: ?Journal = null,

    pub const Journal = struct {
        file: std.Io.File,
        io: std.Io,
        offset: u64,
    };

    pub fn init(allocator: Allocator) Substrate {
        return .{
            .allocator = allocator,
            .artifacts = std.StringHashMap(OwnedArtifact).init(allocator),
            .neurons = std.StringHashMap(SpawnedNeuron).init(allocator),
            .firings = std.StringHashMap(FiringRecord).init(allocator),
        };
    }

    /// A durable substrate rooted at `<dir>/<sub_path>/substrate.log`: the
    /// log is replayed before anything new is admitted, then held open
    /// under an exclusive advisory lock (a second opener fails closed as
    /// error.SubstrateLocked rather than clobbering the log). A corrupt or
    /// torn tail fails construction as error.CorruptLog — never silently
    /// partial state (§27). Tail repair and compaction are operator
    /// follow-up, not automatic recovery.
    pub fn initDir(allocator: Allocator, io: std.Io, dir: std.Io.Dir, sub_path: []const u8) !Substrate {
        var self = init(allocator);
        errdefer self.deinit();
        try dir.createDirPath(io, sub_path);
        const log_path = try std.fmt.allocPrint(allocator, "{s}/substrate.log", .{sub_path});
        defer allocator.free(log_path);
        const file = dir.createFile(io, log_path, .{
            .read = true,
            .truncate = false,
            .lock = .exclusive,
            .lock_nonblocking = true,
        }) catch |err| switch (err) {
            error.WouldBlock => return error.SubstrateLocked,
            else => return err,
        };
        errdefer file.close(io);
        const size = (try file.stat(io)).size;
        if (size > 0) {
            const bytes = try allocator.alloc(u8, @intCast(size));
            defer allocator.free(bytes);
            const n = try file.readPositionalAll(io, bytes, 0);
            try self.replay(bytes[0..n]);
        }
        self.journal = .{ .file = file, .io = io, .offset = size };
        return self;
    }

    /// Append one framed record and sync before returning. The caller
    /// applies the in-memory mutation only after this succeeds, so a
    /// failed append commits nothing anywhere (§20 commit boundary).
    fn appendLine(self: *Substrate, line: []const u8) !void {
        if (self.journal == null) return;
        const journal = &self.journal.?;
        try journal.file.writePositionalAll(journal.io, line, journal.offset);
        journal.offset += line.len;
        try journal.file.sync(journal.io);
    }

    /// Journal one atomic firing commit: every effect and the firing
    /// record in a single line, so replay never sees half a commit (§20).
    pub fn journalCommit(self: *Substrate, firing_id: []const u8, digest: types.Digest, effects_committed: usize, pending: []const Pending) !void {
        if (self.journal == null) return;
        var out: std.Io.Writer.Allocating = .init(self.allocator);
        defer out.deinit();
        const w = &out.writer;
        const digest_hex = std.fmt.bytesToHex(digest, .lower);
        try w.writeAll("{\"schema\":\"neuron.substrate/v1\",\"op\":\"commit\",\"firing_id\":");
        try writeJsonString(w, self.allocator, firing_id);
        try w.print(",\"digest\":\"{s}\",\"status\":\"committed\",\"effects_committed\":{}", .{ &digest_hex, effects_committed });
        try w.writeAll(",\"artifacts\":[");
        var first = true;
        for (pending) |item| switch (item) {
            .write => |write| {
                if (!first) try w.writeAll(",");
                first = false;
                try w.writeAll("{\"id\":");
                try writeJsonString(w, self.allocator, write.id);
                try w.writeAll(",\"schema\":");
                try writeJsonString(w, self.allocator, write.schema);
                try w.writeAll(",\"bytes\":");
                try writeHexString(w, write.bytes);
                try w.writeAll(",\"produced_by\":");
                try writeJsonString(w, self.allocator, write.produced_by);
                try w.writeAll("}");
            },
            else => {},
        };
        try w.writeAll("],\"messages\":[");
        first = true;
        for (pending) |item| switch (item) {
            .send => |message| {
                if (!first) try w.writeAll(",");
                first = false;
                try w.writeAll("{\"firing_id\":");
                try writeJsonString(w, self.allocator, message.firing_id);
                try w.writeAll(",\"to\":");
                try writeJsonString(w, self.allocator, message.to);
                try w.writeAll(",\"msg_schema\":");
                try writeJsonString(w, self.allocator, message.schema);
                try w.writeAll(",\"payload\":");
                try writeHexString(w, message.payload);
                try w.print(",\"durable\":{}}}", .{message.durable});
            },
            else => {},
        };
        try w.writeAll("],\"neurons\":[");
        first = true;
        for (pending) |item| switch (item) {
            .spawn => |spawn| {
                if (!first) try w.writeAll(",");
                first = false;
                const caps_hex = std.fmt.bytesToHex(spawn.value.caps_digest, .lower);
                try w.writeAll("{\"id\":");
                try writeJsonString(w, self.allocator, spawn.id);
                try w.writeAll(",\"firing_id\":");
                try writeJsonString(w, self.allocator, spawn.value.firing_id);
                try w.writeAll(",\"kind\":");
                try writeJsonString(w, self.allocator, spawn.value.kind);
                try w.print(",\"depth\":{},\"caps_digest\":\"{s}\",\"grant\":", .{ spawn.value.depth, &caps_hex });
                try writeGrantJson(w, self.allocator, spawn.value.grant);
                try w.writeAll("}");
            },
            else => {},
        };
        try w.writeAll("]}\n");
        try self.appendLine(out.writer.buffered());
    }

    /// Journal a non-commit firing settlement (cancel, reject, timeout).
    pub fn journalFiring(self: *Substrate, firing_id: []const u8, digest: types.Digest, status: FiringStatus) !void {
        if (self.journal == null) return;
        var out: std.Io.Writer.Allocating = .init(self.allocator);
        defer out.deinit();
        const w = &out.writer;
        const digest_hex = std.fmt.bytesToHex(digest, .lower);
        try w.writeAll("{\"schema\":\"neuron.substrate/v1\",\"op\":\"firing\",\"firing_id\":");
        try writeJsonString(w, self.allocator, firing_id);
        try w.print(",\"digest\":\"{s}\",\"status\":\"{s}\"}}\n", .{ &digest_hex, @tagName(status) });
        try self.appendLine(out.writer.buffered());
    }

    /// Journal a delivery-state transition for the message at `index`.
    /// Indices are stable across replay because commit order is log order.
    pub fn journalDelivery(self: *Substrate, index: usize, status: DeliveryStatus, attempts: u8) !void {
        if (self.journal == null) return;
        var out: std.Io.Writer.Allocating = .init(self.allocator);
        defer out.deinit();
        const w = &out.writer;
        try w.print("{{\"schema\":\"neuron.substrate/v1\",\"op\":\"delivery\",\"index\":{},\"status\":\"{s}\",\"attempts\":{}}}\n", .{ index, @tagName(status), attempts });
        try self.appendLine(out.writer.buffered());
    }

    /// Rebuild the committed state from the journal, strictly in record
    /// order. Any malformed record — bad JSON, wrong schema, bad hex, an
    /// out-of-range delivery index, a duplicate firing id, or a torn final
    /// line — fails closed as error.CorruptLog (§27).
    fn replay(self: *Substrate, bytes: []const u8) !void {
        if (bytes.len == 0) return;
        if (bytes[bytes.len - 1] != '\n') return error.CorruptLog;
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        var lines = std.mem.splitScalar(u8, bytes, '\n');
        while (lines.next()) |line| {
            if (line.len == 0) continue;
            try self.replayLine(arena.allocator(), line);
            _ = arena.reset(.retain_capacity);
        }
    }

    fn replayLine(self: *Substrate, allocator: Allocator, line: []const u8) !void {
        const record = std.json.parseFromSliceLeaky(RecordJ, allocator, line, .{ .ignore_unknown_fields = true }) catch
            return error.CorruptLog;
        if (!std.mem.eql(u8, record.schema, "neuron.substrate/v1")) return error.CorruptLog;
        if (std.mem.eql(u8, record.op, "commit")) return self.replayCommit(record);
        if (std.mem.eql(u8, record.op, "firing")) return self.replayFiring(record);
        if (std.mem.eql(u8, record.op, "delivery")) return self.replayDelivery(record);
        return error.CorruptLog;
    }

    fn replayCommit(self: *Substrate, record: RecordJ) !void {
        for (record.artifacts) |artifact| try self.replayArtifact(artifact);
        for (record.messages) |message| try self.replayMessage(message);
        for (record.neurons) |neuron| try self.replayNeuron(neuron);
        try self.replayFiringRecord(record.firing_id, record.digest, "committed", record.effects_committed);
    }

    fn replayFiring(self: *Substrate, record: RecordJ) !void {
        try self.replayFiringRecord(record.firing_id, record.digest, record.status, 0);
    }

    fn replayFiringRecord(self: *Substrate, firing_id: []const u8, digest_hex_text: []const u8, status_text: []const u8, effects_committed: usize) !void {
        if (firing_id.len == 0) return error.CorruptLog;
        const status = std.meta.stringToEnum(FiringStatus, status_text) orelse return error.CorruptLog;
        const digest = try digestFromHex(digest_hex_text);
        const owned = try self.allocator.dupe(u8, firing_id);
        errdefer self.allocator.free(owned);
        self.firings.putNoClobber(owned, .{
            .decision_digest = digest,
            .effects_committed = effects_committed,
            .status = status,
        }) catch return error.CorruptLog;
    }

    fn replayArtifact(self: *Substrate, artifact: ArtifactJ) !void {
        const id = try self.allocator.dupe(u8, artifact.id);
        errdefer self.allocator.free(id);
        const schema = try self.allocator.dupe(u8, artifact.schema);
        errdefer self.allocator.free(schema);
        const bytes = try hexAlloc(self.allocator, artifact.bytes);
        errdefer self.allocator.free(bytes);
        const produced_by = try self.allocator.dupe(u8, artifact.produced_by);
        errdefer self.allocator.free(produced_by);
        const old = try self.artifacts.fetchPut(id, .{
            .schema = schema,
            .bytes = bytes,
            .digest = types.digest(bytes),
            .produced_by = produced_by,
        });
        if (old) |prior| {
            // HashMap retains the existing key when replacing a value.
            self.allocator.free(id);
            self.allocator.free(prior.value.schema);
            self.allocator.free(prior.value.bytes);
            self.allocator.free(prior.value.produced_by);
        }
    }

    fn replayMessage(self: *Substrate, message: MessageJ) !void {
        const firing_id = try self.allocator.dupe(u8, message.firing_id);
        errdefer self.allocator.free(firing_id);
        const to = try self.allocator.dupe(u8, message.to);
        errdefer self.allocator.free(to);
        const schema = try self.allocator.dupe(u8, message.msg_schema);
        errdefer self.allocator.free(schema);
        const payload = try hexAlloc(self.allocator, message.payload);
        errdefer self.allocator.free(payload);
        try self.messages.append(self.allocator, .{
            .firing_id = firing_id,
            .to = to,
            .schema = schema,
            .payload = payload,
            .durable = message.durable,
        });
    }

    fn replayNeuron(self: *Substrate, neuron: NeuronJ) !void {
        const id = try self.allocator.dupe(u8, neuron.id);
        errdefer self.allocator.free(id);
        const firing_id = try self.allocator.dupe(u8, neuron.firing_id);
        errdefer self.allocator.free(firing_id);
        const kind = try self.allocator.dupe(u8, neuron.kind);
        errdefer self.allocator.free(kind);
        const caps_digest = try digestFromHex(neuron.caps_digest);
        const grant: ?OwnedCaps = if (neuron.grant) |grant| blk: {
            const write_prefix = try self.allocator.dupe(u8, grant.write_prefix);
            errdefer self.allocator.free(write_prefix);
            const send_prefix = try self.allocator.dupe(u8, grant.send_prefix);
            errdefer self.allocator.free(send_prefix);
            const spawn_prefix = try self.allocator.dupe(u8, grant.spawn_prefix);
            errdefer self.allocator.free(spawn_prefix);
            break :blk .{
                .allow_write = grant.allow_write,
                .allow_send = grant.allow_send,
                .allow_spawn = grant.allow_spawn,
                .write_prefix = write_prefix,
                .send_prefix = send_prefix,
                .spawn_prefix = spawn_prefix,
                .budget = .{
                    .max_effects = grant.max_effects,
                    .max_writes = grant.max_writes,
                    .max_messages = grant.max_messages,
                    .max_spawns = grant.max_spawns,
                    .max_bytes = grant.max_bytes,
                    .max_depth = grant.max_depth,
                },
            };
        } else null;
        self.neurons.putNoClobber(id, .{
            .firing_id = firing_id,
            .kind = kind,
            .depth = neuron.depth,
            .caps_digest = caps_digest,
            .grant = grant,
        }) catch return error.CorruptLog;
    }

    fn replayDelivery(self: *Substrate, record: RecordJ) !void {
        const status = std.meta.stringToEnum(DeliveryStatus, record.status) orelse return error.CorruptLog;
        if (record.index >= self.messages.items.len) return error.CorruptLog;
        self.messages.items[record.index].status = status;
        self.messages.items[record.index].attempts = record.attempts;
    }

    pub fn deinit(self: *Substrate) void {
        if (self.journal) |*journal| journal.file.close(journal.io);
        var firing_it = self.firings.keyIterator();
        while (firing_it.next()) |key| self.allocator.free(key.*);
        self.firings.deinit();

        var neuron_it = self.neurons.iterator();
        while (neuron_it.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
            entry.value_ptr.deinit(self.allocator);
        }
        self.neurons.deinit();

        for (self.messages.items) |message| message.deinit(self.allocator);
        self.messages.deinit(self.allocator);

        var artifact_it = self.artifacts.iterator();
        while (artifact_it.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
            self.allocator.free(entry.value_ptr.schema);
            self.allocator.free(entry.value_ptr.bytes);
            self.allocator.free(entry.value_ptr.produced_by);
        }
        self.artifacts.deinit();
    }
};

// --- Journal codec: one JSON object per line, schema neuron.substrate/v1.
// Binary fields are hex; digest fields recompute or validate on replay. ---

const RecordJ = struct {
    schema: []const u8 = "",
    op: []const u8 = "",
    firing_id: []const u8 = "",
    digest: []const u8 = "",
    status: []const u8 = "",
    effects_committed: usize = 0,
    index: usize = 0,
    attempts: u8 = 0,
    artifacts: []const ArtifactJ = &.{},
    messages: []const MessageJ = &.{},
    neurons: []const NeuronJ = &.{},
};

const ArtifactJ = struct {
    id: []const u8 = "",
    schema: []const u8 = "",
    bytes: []const u8 = "",
    produced_by: []const u8 = "",
};

const MessageJ = struct {
    firing_id: []const u8 = "",
    to: []const u8 = "",
    msg_schema: []const u8 = "",
    payload: []const u8 = "",
    durable: bool = true,
};

const GrantJ = struct {
    allow_write: bool = false,
    allow_send: bool = false,
    allow_spawn: bool = false,
    write_prefix: []const u8 = "",
    send_prefix: []const u8 = "",
    spawn_prefix: []const u8 = "",
    max_effects: usize = 0,
    max_writes: usize = 0,
    max_messages: usize = 0,
    max_spawns: usize = 0,
    max_bytes: usize = 0,
    max_depth: u8 = 0,
};

const NeuronJ = struct {
    id: []const u8 = "",
    firing_id: []const u8 = "",
    kind: []const u8 = "",
    depth: u8 = 0,
    caps_digest: []const u8 = "",
    grant: ?GrantJ = null,
};

fn writeJsonString(w: *std.Io.Writer, allocator: Allocator, raw: []const u8) !void {
    const encoded = try std.json.Stringify.valueAlloc(allocator, raw, .{});
    defer allocator.free(encoded);
    try w.writeAll(encoded);
}

fn writeHexString(w: *std.Io.Writer, bytes: []const u8) !void {
    try w.writeAll("\"");
    for (bytes) |b| try w.print("{x:0>2}", .{b});
    try w.writeAll("\"");
}

fn writeGrantJson(w: *std.Io.Writer, allocator: Allocator, grant: ?OwnedCaps) !void {
    const owned = grant orelse {
        try w.writeAll("null");
        return;
    };
    try w.print("{{\"allow_write\":{},\"allow_send\":{},\"allow_spawn\":{},\"write_prefix\":", .{
        owned.allow_write, owned.allow_send, owned.allow_spawn,
    });
    try writeJsonString(w, allocator, owned.write_prefix);
    try w.writeAll(",\"send_prefix\":");
    try writeJsonString(w, allocator, owned.send_prefix);
    try w.writeAll(",\"spawn_prefix\":");
    try writeJsonString(w, allocator, owned.spawn_prefix);
    try w.print(",\"max_effects\":{},\"max_writes\":{},\"max_messages\":{},\"max_spawns\":{},\"max_bytes\":{},\"max_depth\":{}}}", .{
        owned.budget.max_effects, owned.budget.max_writes, owned.budget.max_messages,
        owned.budget.max_spawns,  owned.budget.max_bytes,  owned.budget.max_depth,
    });
}

fn hexAlloc(allocator: Allocator, hex: []const u8) ![]u8 {
    if (hex.len % 2 != 0) return error.CorruptLog;
    const out = try allocator.alloc(u8, hex.len / 2);
    errdefer allocator.free(out);
    _ = std.fmt.hexToBytes(out, hex) catch return error.CorruptLog;
    return out;
}

fn digestFromHex(hex: []const u8) !types.Digest {
    if (hex.len != 64) return error.CorruptLog;
    var out: types.Digest = undefined;
    _ = std.fmt.hexToBytes(&out, hex) catch return error.CorruptLog;
    return out;
}
