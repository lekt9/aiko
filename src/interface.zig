const std = @import("std");
const types = @import("types.zig");
const caps_mod = @import("caps.zig");

const Allocator = std.mem.Allocator;

/// Provider-neutral channel update. Telegram is the reference example, not a
/// special case: any event-driven interface (Discord, Slack, email, web chat)
/// normalizes into the same typed stimulus shape through a receptor.
pub const ChannelUpdate = struct {
    provider: []const u8,
    update_id: []const u8,
    chat_id: []const u8,
    user_id: []const u8,
    text: []const u8,
};

pub const Address = struct {
    provider: []const u8,
    chat: []const u8,
};

/// Channel addresses are typed strings: "interface/<provider>/<chat_id>".
pub fn parseAddress(to: []const u8) ?Address {
    if (!std.mem.startsWith(u8, to, "interface/")) return null;
    var parts = std.mem.splitScalar(u8, to["interface/".len..], '/');
    const provider = parts.next() orelse return null;
    const chat = parts.next() orelse return null;
    if (provider.len == 0 or chat.len == 0) return null;
    return .{ .provider = provider, .chat = chat };
}

/// A normalized update: the external event becomes a typed stimulus whose
/// firing id is derived from the provider update id, so redelivery by the
/// channel is idempotent under the runtime's dedupe (§21). Owns its strings.
pub const Normalized = struct {
    stimulus: types.Stimulus,
    message: types.Message,
    firing_id: []u8,
    schema: []u8,
    to: []u8,
    payload: []u8,

    /// Links the delivered message into the stimulus. Call once the value is
    /// at its final address.
    pub fn seal(self: *Normalized) void {
        self.stimulus.messages = (&self.message)[0..1];
    }

    pub fn deinit(self: *const Normalized, allocator: Allocator) void {
        allocator.free(self.firing_id);
        allocator.free(self.schema);
        allocator.free(self.to);
        allocator.free(self.payload);
    }
};

/// Receptor: external update -> typed stimulus (§8/§19). No effect authority
/// is involved; a receptor only observes and shapes data.
pub fn normalize(allocator: Allocator, update: ChannelUpdate) !Normalized {
    if (update.provider.len == 0 or update.update_id.len == 0 or update.chat_id.len == 0)
        return error.InvalidUpdate;
    const firing_id = try std.fmt.allocPrint(allocator, "interface/{s}/{s}", .{ update.provider, update.update_id });
    errdefer allocator.free(firing_id);
    const schema = try std.fmt.allocPrint(allocator, "interface/{s}.message/v1", .{update.provider});
    errdefer allocator.free(schema);
    const to = try std.fmt.allocPrint(allocator, "interface/{s}/{s}", .{ update.provider, update.chat_id });
    errdefer allocator.free(to);
    const payload = try allocator.dupe(u8, update.text);
    errdefer allocator.free(payload);
    return .{
        .stimulus = .{
            .firing_id = firing_id,
            .receptor_schema = schema,
        },
        .message = .{
            .to = to,
            .schema = schema,
            .payload = payload,
            .durable = true,
        },
        .firing_id = firing_id,
        .schema = schema,
        .to = to,
        .payload = payload,
    };
}

/// Scoped capability grant for one chat: writes land only in this chat's
/// state namespace, sends only in this chat's channel namespace. Multi-user
/// isolation is a Caps fact, not a policy hope (§24). Owns its prefixes.
pub const ScopedCaps = struct {
    caps: caps_mod.Caps,
    write_prefix: []u8,
    send_prefix: []u8,

    pub fn deinit(self: *const ScopedCaps, allocator: Allocator) void {
        allocator.free(self.write_prefix);
        allocator.free(self.send_prefix);
    }
};

pub fn scopedCaps(allocator: Allocator, provider: []const u8, chat: []const u8) !ScopedCaps {
    if (provider.len == 0 or chat.len == 0) return error.InvalidUpdate;
    const write_prefix = try std.fmt.allocPrint(allocator, "state/{s}/{s}/", .{ provider, chat });
    errdefer allocator.free(write_prefix);
    const send_prefix = try std.fmt.allocPrint(allocator, "interface/{s}/{s}/", .{ provider, chat });
    errdefer allocator.free(send_prefix);
    return .{
        .caps = .{
            .allow_write = true,
            .allow_send = true,
            .write_prefix = write_prefix,
            .send_prefix = send_prefix,
        },
        .write_prefix = write_prefix,
        .send_prefix = send_prefix,
    };
}

/// Self-wiring neuron: on (first) contact with a chat it decides to spawn a
/// conversation worker whose grant is narrowed to exactly that chat's
/// namespaces. The harness validates the delegation; the child receives no
/// ambient authority (§24/§26). No outer controller hard-codes the wiring.
pub const RouterNeuron = struct {
    scratch: []u8,
    effects: []types.Effect,
    evidence: []types.Evidence,
    sources: [][]const u8,

    pub fn fire(self: *const RouterNeuron, stimulus: types.Stimulus, _: caps_mod.Caps) !types.Decision {
        if (stimulus.messages.len == 0) return error.NoMessage;
        if (self.effects.len < 1 or self.evidence.len < 1 or self.sources.len < 1)
            return error.BufferTooSmall;
        const address = parseAddress(stimulus.messages[0].to) orelse return error.UnknownChannel;
        var cursor: usize = 0;
        const spawn_id = try printInto(self.scratch, &cursor, "worker/interface/{s}/{s}", .{ address.provider, address.chat });
        const write_prefix = try printInto(self.scratch, &cursor, "state/{s}/{s}/", .{ address.provider, address.chat });
        const send_prefix = try printInto(self.scratch, &cursor, "interface/{s}/{s}/", .{ address.provider, address.chat });
        self.effects[0] = .{ .spawn = .{
            .id = spawn_id,
            .kind = "conversation",
            .grant = .{
                .allow_write = true,
                .allow_send = true,
                .write_prefix = write_prefix,
                .send_prefix = send_prefix,
                .budget = .{ .max_writes = 4, .max_depth = 0 },
            },
        } };
        self.sources[0] = "stimulus";
        self.evidence[0] = .{
            .claim = "contact with this chat wires a conversation worker scoped to it",
            .sources = self.sources[0..1],
            .method = "interface router neuron",
        };
        return .{
            .control = .{ .terminate = "wired" },
            .effects = self.effects[0..1],
            .evidence = self.evidence[0..1],
        };
    }
};

/// Conversation neuron: grounds its reply in the delivered message and the
/// chat's prior history artifact, then returns two declarative effects —
/// write the next history entry (compare-and-swap chained to the prior
/// digest) and send the reply into this chat's channel. State continuity is
/// self-written persistence (§9), not a hidden side band.
pub const ConversationNeuron = struct {
    scratch: []u8,
    effects: []types.Effect,
    evidence: []types.Evidence,
    sources: [][]const u8,

    pub fn fire(self: *const ConversationNeuron, stimulus: types.Stimulus, caps: caps_mod.Caps) !types.Decision {
        if (stimulus.messages.len == 0) return error.NoMessage;
        if (self.effects.len < 2 or self.evidence.len < 1 or self.sources.len < 2)
            return error.BufferTooSmall;
        var cursor: usize = 0;
        const inbound = stimulus.messages[0];
        const history_id = try printInto(self.scratch, &cursor, "{s}history", .{caps.write_prefix});
        const prior = if (stimulus.reads.len > 0)
            try printInto(self.scratch, &cursor, "{x}", .{stimulus.reads[0].digest[0..4]})
        else
            "none";
        const bytes = try printInto(self.scratch, &cursor, "said: {s} | prior={s}", .{ inbound.payload, prior });
        const reply_to = try printInto(self.scratch, &cursor, "{s}reply", .{caps.send_prefix});
        self.effects[0] = .{ .write = .{
            .id = history_id,
            .schema = "state/history/v1",
            .bytes = bytes,
            .expected_prior = if (stimulus.reads.len > 0) stimulus.reads[0].digest else null,
        } };
        self.effects[1] = .{ .send = .{
            .to = reply_to,
            .schema = "interface.reply/v1",
            .payload = inbound.payload,
        } };
        self.sources[0] = "stimulus";
        const source_count: usize = if (stimulus.reads.len > 0) blk: {
            self.sources[1] = history_id;
            break :blk 2;
        } else 1;
        self.evidence[0] = .{
            .claim = "reply grounded in the delivered message and prior history",
            .sources = self.sources[0..source_count],
            .method = "interface conversation neuron",
        };
        return .{
            .control = .{ .terminate = "replied" },
            .effects = self.effects[0..2],
            .evidence = self.evidence[0..1],
        };
    }
};

fn printInto(scratch: []u8, cursor: *usize, comptime fmt: []const u8, args: anytype) ![]const u8 {
    const out = try std.fmt.bufPrint(scratch[cursor.*..], fmt, args);
    cursor.* += out.len;
    return out;
}

test "receptor rejects malformed updates and parses typed addresses" {
    try std.testing.expectError(error.InvalidUpdate, normalize(std.testing.allocator, .{
        .provider = "",
        .update_id = "1",
        .chat_id = "c",
        .user_id = "u",
        .text = "hi",
    }));
    const address = parseAddress("interface/telegram/123").?;
    try std.testing.expectEqualStrings("telegram", address.provider);
    try std.testing.expectEqualStrings("123", address.chat);
    try std.testing.expect(parseAddress("interface/") == null);
    try std.testing.expect(parseAddress("elsewhere/telegram/123") == null);
}
