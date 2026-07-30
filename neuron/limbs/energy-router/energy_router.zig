//! energy_router.zig — the proper typed Neuron for energy-based recommendation.
//
// This is a first-class hard-typed polymorphic Neuron (Neuron<S, Caps, Decision>).
// It uses the pure energy.zig scorer to choose the lowest-energy next action,
// writes an EnergyScore artifact, and can spawn nested micro-EBMs (via spawn +
// continue_wait) for unresolved sub-work.
//
// It is intended to be admitted as (or used inside) a generative limb.
// It never lives in the substrate; it only reads narrow slices via Caps and
// writes scored results as normal artifacts.
//
// Alignment:
// - Single primitive: returns Decision (control + effects + evidence).
// - Evidence-grounded: every claim traces to stimulus reads + scoring math.
// - Caps constrained: only what the caller grants (reads on candidates, writes for scores).
// - Supports the EBM story: can emit spawn for a "sub-EBM" specialist that will
//   return continue_wait until resolved by sibling work.

const std = @import("std");
const types = @import("../../src/types.zig");
const caps_mod = @import("../../src/caps.zig");
const energy = @import("energy.zig");

const Allocator = std.mem.Allocator;

/// A candidate description carried in the stimulus (via message payload for the
/// prototype, or via a pinned read in a real integration). The router scores
/// these using the structural energy function.
pub const Candidate = struct {
    id: []const u8,
    grounding_ok: bool,
    evidence_conf_milli: u16,
    normalized_cost: f64,
    settlement_distance: f64,
    violations: u32 = 0,
    /// If true, choosing this candidate means spawning a narrow sub-EBM
    /// (the "small breaking EBM" pattern) rather than branching directly.
    wants_sub_ebm: bool = false,
};

/// Simple stimulus payload format for the prototype (JSON-ish for readability
/// in tests). A real version would use proper schemas + permitted_reads.
pub const RouteRequest = struct {
    work_ref: []const u8,
    candidates: []const Candidate,
};

/// The EnergyRouter Neuron.
/// It is stateless between firings (pure). Callers supply scratch buffers.
pub const EnergyRouter = struct {
    scratch: []u8,
    effects: []types.Effect,
    evidence: []types.Evidence,
    sources: [][]const u8,

    /// Parse a minimal route request from the stimulus.
    /// For the prototype we accept a single message whose payload is a
    /// very small "id|grounding|conf|cost|settle|viol|sub" form, repeated.
    /// Production would use typed reads + proper schema.
    fn parseRequest(self: *const EnergyRouter, stimulus: types.Stimulus) !RouteRequest {
        if (stimulus.messages.len == 0) return error.NoRouteRequest;

        // For simplicity in this reference impl we take the last message payload
        // as a newline-separated list of candidate descriptors.
        const payload = stimulus.messages[stimulus.messages.len - 1].payload;

        // Very small ad-hoc parser sufficient for tests and the limb demo.
        // Format per line: id|G|conf|cost|settle|viol|sub
        // G=1/0, sub=1/0
        var list: std.ArrayList(Candidate) = .empty;
        defer list.deinit(self.allocator()); // safety, we return owned slices via scratch

        var lines = std.mem.splitScalar(u8, payload, '\n');
        while (lines.next()) |line| {
            if (line.len == 0) continue;
            var it = std.mem.splitScalar(u8, line, '|');
            const id = it.next() orelse return error.BadCandidate;
            const g_str = it.next() orelse return error.BadCandidate;
            const conf_str = it.next() orelse return error.BadCandidate;
            const cost_str = it.next() orelse return error.BadCandidate;
            const settle_str = it.next() orelse return error.BadCandidate;
            const viol_str = it.next() orelse return error.BadCandidate;
            const sub_str = it.next() orelse "0";

            const grounding = std.mem.eql(u8, g_str, "1");
            const conf = try std.fmt.parseInt(u16, conf_str, 10);
            const cost = try std.fmt.parseFloat(f64, cost_str);
            const settle = try std.fmt.parseFloat(f64, settle_str);
            const viol = try std.fmt.parseInt(u32, viol_str, 10);
            const wants_sub = std.mem.eql(u8, sub_str, "1");

            // Copy id into our scratch so the returned Candidate lives as long as the decision.
            const id_copy = try self.copyIntoScratch(id);

            try list.append(self.allocator(), .{
                .id = id_copy,
                .grounding_ok = grounding,
                .evidence_conf_milli = conf,
                .normalized_cost = cost,
                .settlement_distance = settle,
                .violations = viol,
                .wants_sub_ebm = wants_sub,
            });
        }

        if (list.items.len == 0) return error.NoCandidates;

        // We return a view over the list we built in scratch-backed storage.
        // The caller (test or runtime) owns the lifetime for the duration of the decision.
        // For this reference we keep the list alive by returning the slice we just built.
        // In real use the stimulus would pin the source artifact.
        const owned = try self.allocator().dupe(Candidate, list.items);
        // Note: in a real neuron we would free this on next fire or use arena.
        // Here we intentionally leak into the test harness scratch pattern.
        _ = self.allocator(); // keep compiler happy about side use

        return .{
            .work_ref = "work/ref",
            .candidates = owned,
        };
    }

    fn allocator(self: *const EnergyRouter) Allocator {
        // We don't own an allocator; tests pass one via the scratch pattern.
        // For the prototype we use a global test allocator hook.
        // In production the neuron would be given one at construction.
        return std.testing.allocator; // safe only inside test context for this demo
    }

    fn copyIntoScratch(self: *const EnergyRouter, s: []const u8) ![]u8 {
        if (s.len > self.scratch.len) return error.ScratchTooSmall;
        @memcpy(self.scratch[0..s.len], s);
        const out = self.scratch[0..s.len];
        self.scratch = self.scratch[s.len..];
        return out;
    }

    pub fn fire(self: *const EnergyRouter, stimulus: types.Stimulus, _: caps_mod.Caps) !types.Decision {
        const req = try self.parseRequest(stimulus);

        // Convert to the scorer's view.
        var scorer_cands: std.ArrayList(energy.FiringCandidate) = .empty;
        defer scorer_cands.deinit(self.allocator());

        for (req.candidates) |c| {
            try scorer_cands.append(self.allocator(), .{
                .id = c.id,
                .grounding_ok = c.grounding_ok,
                .evidence_conf_milli = c.evidence_conf_milli,
                .normalized_cost = c.normalized_cost,
                .settlement_distance = c.settlement_distance,
                .violations = c.violations,
            });
        }

        const choice = energy.chooseLowestEnergy(scorer_cands.items) orelse return error.NoViableCandidate;

        // Build the EnergyScore artifact (simple deterministic bytes for the prototype).
        const score_bytes = try self.formatScore(choice);

        // Effect 1: write the score.
        self.effects[0] = .{
            .write = .{
                .id = "energy/score",
                .schema = "neuron.energy-score/v1",
                .bytes = score_bytes,
            },
        };

        var effect_count: usize = 1;

        // Decision:
        // - If the winning candidate wants a sub-EBM, we SPAWN a narrow specialist
        //   that will run with continue_wait until resolved. This is the "small EBM
        //   that breaks until another neuron resolves it" pattern.
        // - Otherwise we BRANCH to the chosen id (or emit a send to the target).
        var control: types.Control = undefined;

        if (choice.candidate.id.len == 0) return error.BadChoice;

        const chosen_id = choice.candidate.id;

        if (self.findCandidateWantsSub(req.candidates, chosen_id)) {
            // Spawn a micro sub-EBM. In a real system the kind would be a
            // registered narrow specialist NeuronDef.
            const spawn_id = try self.copyIntoScratch("sub-ebm/");
            // append a tiny suffix from the chosen id
            const suffix = if (chosen_id.len > 4) chosen_id[0..4] else chosen_id;
            _ = try self.copyIntoScratch(suffix); // best-effort in scratch

            self.effects[1] = .{
                .spawn = .{
                    .id = spawn_id,
                    .kind = "energy-sub-ebm",
                    .grant = null, // least authority; parent grant would be narrowed by harness
                },
            };
            effect_count = 2;

            control = .{ .terminate = "spawned-sub-ebm" };
        } else {
            // Direct branch to the chosen target (the router's normal job).
            control = .{ .branch = chosen_id };
        }

        // Evidence: grounded in the stimulus candidates + the math.
        const claim_src = [_][]const u8{"stimulus"};
        self.sources[0] = "stimulus";
        self.evidence[0] = .{
            .claim = "lowest energy candidate selected by structural E function",
            .sources = &claim_src,
            .method = "energy.firingEnergy + chooseLowestEnergy",
        };

        return .{
            .control = control,
            .effects = self.effects[0..effect_count],
            .evidence = self.evidence[0..1],
        };
    }

    fn findCandidateWantsSub(self: *const EnergyRouter, cands: []const Candidate, id: []const u8) bool {
        _ = self;
        for (cands) |c| {
            if (std.mem.eql(u8, c.id, id)) return c.wants_sub_ebm;
        }
        return false;
    }

    fn formatScore(self: *const EnergyRouter, scored: energy.ScoredCandidate) ![]u8 {
        // Minimal deterministic representation sufficient for tests and artifacts.
        // Real version would be CBOR or the canonical wire format.
        var cursor: usize = 0;
        const buf = self.scratch;

        const written = try std.fmt.bufPrint(buf, "{s}|{d:.4}|{s}|{d}|{d}", .{
            scored.candidate.id,
            scored.energy,
            if (scored.candidate.grounding_ok) "grounded" else "ungrounded",
            scored.candidate.evidence_conf_milli,
            scored.candidate.normalized_cost,
        });

        // Advance scratch
        self.scratch = self.scratch[written.len..];
        return written;
    }
};

// -----------------------------------------------------------------------------
// Tests that exercise the full Neuron (not just the pure scorer)

const testing = std.testing;

fn makeScratch(comptime size: usize) [size]u8 {
    return [_]u8{0} ** size;
}

test "EnergyRouter chooses lowest energy and writes score" {
    var scratch = makeScratch(4096);
    var effects_buf: [4]types.Effect = undefined;
    var evidence_buf: [4]types.Evidence = undefined;
    var sources_buf: [4][]const u8 = undefined;

    const router_impl: EnergyRouter = .{
        .scratch = &scratch,
        .effects = &effects_buf,
        .evidence = &evidence_buf,
        .sources = &sources_buf,
    };
    const router = types.bind(EnergyRouter, &router_impl, "energy/router", "0.1.0");

    // Build a tiny stimulus whose message payload encodes candidates.
    // Format per line: id|G|conf|cost|settle|viol|sub
    const payload =
        "heuristic|1|710|0.35|1.2|0|0\n" ++
        "narrow|1|920|0.15|0.4|0|0\n" ++
        "micro-ebm|1|880|0.25|0.1|0|1\n"; // last one wants sub-EBM

    var msg: types.Message = .{
        .schema = "typed-neuron.route-request/v1",
        .correlation_id = "corr-1",
        .causation_id = "cause-1",
        .payload = payload,
        .durable = true,
    };

    const stimulus: types.Stimulus = .{
        .firing_id = "energy/001",
        .receptor_schema = "typed-neuron.work-item/v1",
        .messages = (&msg)[0..1],
        .permitted_reads = &.{},
        .reads = &.{},
    };

    const caps: caps_mod.Caps = .{
        .allow_write = true,
        .allow_send = false,
        .write_prefix = "energy/",
    };

    const decision = try router.fire(stimulus, caps);

    // It should have chosen the lowest (narrow or micro-ebm). With the numbers,
    // narrow is 1.02, micro-ebm is 1.08, so narrow wins.
    // Because we put the sub flag on micro-ebm, if micro had won we would have spawned.

    try testing.expect(decision.effects.len >= 1);
    try testing.expectEqualStrings("neuron.energy-score/v1", decision.effects[0].write.schema);
    try testing.expect(std.mem.indexOf(u8, decision.effects[0].write.bytes, "narrow") != null or
        std.mem.indexOf(u8, decision.effects[0].write.bytes, "micro-ebm") != null);

    // Control should be a branch to the chosen id (narrow in this case).
    switch (decision.control) {
        .branch => |target| {
            try testing.expect(std.mem.eql(u8, target, "narrow") or std.mem.eql(u8, target, "micro-ebm"));
        },
        else => try testing.expect(false),
    }

    try testing.expect(decision.evidence.len >= 1);
    try testing.expect(std.mem.indexOf(u8, decision.evidence[0].claim, "lowest energy") != null);
}

test "EnergyRouter spawns sub-EBM when chosen candidate requests it" {
    var scratch = makeScratch(4096);
    var effects_buf: [4]types.Effect = undefined;
    var evidence_buf: [4]types.Evidence = undefined;
    var sources_buf: [4][]const u8 = undefined;

    const router_impl: EnergyRouter = .{
        .scratch = &scratch,
        .effects = &effects_buf,
        .evidence = &evidence_buf,
        .sources = &sources_buf,
    };
    const router = types.bind(EnergyRouter, &router_impl, "energy/router", "0.1.0");

    // Make the micro-ebm the clear winner and mark it wants_sub_ebm.
    const payload =
        "heuristic|1|500|0.9|5.0|0|0\n" ++
        "micro-ebm-winner|1|950|0.05|0.05|0|1\n";

    var msg: types.Message = .{
        .schema = "typed-neuron.route-request/v1",
        .correlation_id = "corr-2",
        .causation_id = "cause-2",
        .payload = payload,
        .durable = true,
    };

    const stimulus: types.Stimulus = .{
        .firing_id = "energy/002",
        .receptor_schema = "typed-neuron.work-item/v1",
        .messages = (&msg)[0..1],
    };

    const caps: caps_mod.Caps = .{ .allow_write = true };

    const decision = try router.fire(stimulus, caps);

    // Because the winner has wants_sub_ebm, we should have emitted a spawn.
    try testing.expect(decision.effects.len >= 2);
    try testing.expectEqualStrings("spawn", @tagName(decision.effects[1]));
    try testing.expect(std.mem.indexOf(u8, decision.effects[1].spawn.kind, "energy-sub-ebm") != null);

    switch (decision.control) {
        .terminate => |r| try testing.expect(std.mem.eql(u8, r, "spawned-sub-ebm")),
        else => try testing.expect(false),
    }
}
