const std = @import("std");
const types = @import("types.zig");
const caps_mod = @import("caps.zig");
const neuron_mod = @import("neuron.zig");

/// The mechanical cage for fallible decision logic (§6/§7 middleware).
///
/// An LLM-backed child is asked for exactly one thing: a text payload (its
/// terminate result). Everything that must ALWAYS happen — the send target,
/// the evidence provenance, the compare-and-swap chain, the payload bound —
/// is constructed mechanically by this wrapper from the stimulus and a data
/// policy. The child cannot:
///
///   - redirect an effect (targets derive from the stimulus, never from the
///     payload; an injection string is transported as inert data);
///   - invent evidence (the wrapper builds provenance from the firing's
///     recorded read-set and discards the child's);
///   - emit an unbounded or empty payload (fail-closed validation);
///   - choose an unsupported control shape (terminate-only children).
///
/// The wrapped decision is deterministic given (child payload, stimulus,
/// policy), so a content-addressed cache hit replays it without calling the
/// child at all (§25): the model writes once, mechanism replays forever.
pub const Policy = struct {
    effect: union(enum) {
        /// Send the payload back to whoever delivered the stimulus message.
        reply_to_sender: []const u8, // message schema for the reply
        /// Write the payload as a named artifact, CAS-chained to the pinned
        /// read when one is present (mechanical history chaining, §22).
        write_artifact: struct { id: []const u8, schema: []const u8 },
        /// No effects; the payload is the terminate result.
        terminate_only,
    },
    /// Static evidence wording; sources are always derived, never child input.
    claim: []const u8,
    method: []const u8,
    max_payload: usize = 4096,
};

pub const Middleware = struct {
    child: neuron_mod.Neuron,
    policy: Policy,
    effects: []types.Effect,
    evidence: []types.Evidence,
    sources: [][]const u8,

    pub fn fire(self: *const Middleware, stimulus: types.Stimulus, caps: caps_mod.Caps) !types.Decision {
        if (self.effects.len < 1 or self.evidence.len < 1 or self.sources.len < 1)
            return error.BufferTooSmall;
        const raw = try self.child.fire(stimulus, caps);
        const payload = switch (raw.control) {
            .terminate => |result| result,
            else => return error.UnsupportedChildControl,
        };
        if (payload.len == 0) return error.InvalidPayload;
        if (payload.len > self.policy.max_payload) return error.PayloadTooLarge;

        self.sources[0] = "stimulus";
        var source_count: usize = 1;
        for (stimulus.reads) |read| {
            if (source_count >= self.sources.len) break;
            self.sources[source_count] = read.id;
            source_count += 1;
        }
        self.evidence[0] = .{
            .claim = self.policy.claim,
            .sources = self.sources[0..source_count],
            .method = self.policy.method,
        };

        switch (self.policy.effect) {
            .reply_to_sender => |schema| {
                if (stimulus.messages.len == 0) return error.NoMessage;
                self.effects[0] = .{ .send = .{
                    .to = stimulus.messages[0].to,
                    .schema = schema,
                    .payload = payload,
                } };
                return .{
                    .control = .{ .terminate = "handled" },
                    .effects = self.effects[0..1],
                    .evidence = self.evidence[0..1],
                };
            },
            .write_artifact => |target| {
                self.effects[0] = .{ .write = .{
                    .id = target.id,
                    .schema = target.schema,
                    .bytes = payload,
                    .expected_prior = if (stimulus.reads.len > 0) stimulus.reads[0].digest else null,
                } };
                return .{
                    .control = .{ .terminate = "handled" },
                    .effects = self.effects[0..1],
                    .evidence = self.evidence[0..1],
                };
            },
            .terminate_only => return .{
                .control = .{ .terminate = payload },
                .evidence = self.evidence[0..1],
            },
        }
    }
};

pub fn bind(child: neuron_mod.Neuron, policy: Policy, middleware: *Middleware) neuron_mod.Neuron {
    middleware.child = child;
    middleware.policy = policy;
    return neuron_mod.bind(Middleware, middleware, child.identity, child.version);
}
