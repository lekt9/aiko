//! Standalone `neuron agent` lifecycle (R9 / entrypoint plan Phase 1).
//!
//! The agent is not a privileged loop: init, run, and retire are ordinary
//! Neuron firings through the same Runtime valve and Pump walk engine every
//! limb uses. A goal becomes a typed receptor stimulus; intake, worker,
//! verifier, and settler are stateless stage neurons wired through waiter
//! predicates; and a grounder neuron subscribed to `neuron.firing-settled/v1`
//! re-grounds every committed beat into durable context artifacts. The only
//! mutable root is `agents/<id>/active`, advanced by compare-and-swap.

const std = @import("std");
const types = @import("types.zig");
const caps_mod = @import("caps.zig");
const neuron_mod = @import("neuron.zig");
const runtime_mod = @import("runtime.zig");
const scheduler_mod = @import("scheduler.zig");
const substrate_mod = @import("substrate.zig");
const pump_mod = @import("pump.zig");
const membrane = @import("membrane.zig");
const membrane_ops = @import("membrane_ops.zig");

const Allocator = std.mem.Allocator;

pub const MANIFEST_SCHEMA = "neuron.agent-manifest/v1";
pub const SNAPSHOT_SCHEMA = "neuron.agent-snapshot/v1";
pub const ACTIVE_SCHEMA = "neuron.agent-active/v1";
pub const GOAL_SCHEMA = "neuron.agent-goal/v1";
pub const RESULT_SCHEMA = "neuron.agent-result/v1";
pub const VERDICT_SCHEMA = "neuron.agent-verdict/v1";
pub const CONTEXT_SCHEMA = "neuron.agent-context/v1";
/// Written only after a committed effector command has crossed its boundary
/// and been independently read back. Its content identity is what lets the
/// settler require reconciliation without reading any bytes itself.
pub const ACK_SCHEMA = "neuron.agent-effect-ack/v1";

const stimulus_sources = [_][]const u8{"stimulus"};
const park_evidence = [_]types.Evidence{.{
    .claim = "stage parked on its typed predicate artifact",
    .sources = &stimulus_sources,
    .method = "waiter-predicate",
}};

pub const RunStatus = enum { settled, replayed, failed };

pub const RunResult = struct {
    status: RunStatus,
    workflow: []const u8,
    goal_digest: [64]u8,
    result_digest: [64]u8,
    snapshot_id: []const u8,
    snapshot_seq: usize,
    /// Context artifacts committed by the grounder hook, cumulative.
    beats: usize,
    steps: usize,
    pending: usize,
};

/// One replaceable stage of the default agent limb. When `wake_id` is set the
/// stage parks as a waiter until that artifact exists; the wake stimulus pins
/// the artifact digest, which both grounds the stage's evidence and lets it
/// verify the upstream product without trusting the producer.
const StageNeuron = struct {
    wake_id: ?[]const u8 = null,
    /// When set, the primary path requires the pinned wake artifact digest
    /// to equal this value; otherwise the alternate path settles typed.
    expected_digest: ?types.Digest = null,
    /// Take the alternate path unconditionally once the predicate is
    /// satisfied. Set when the harness already established that the work was
    /// performed but judged bad, so the rejection settles durably through the
    /// ordinary failure plumbing instead of aborting the run.
    force_alt: bool = false,
    effects: []const types.Effect = &.{},
    effects_alt: []const types.Effect = &.{},
    evidence: []const types.Evidence,
    terminate: []const u8,
    terminate_alt: []const u8 = "failed",

    pub fn fire(self: *const StageNeuron, stimulus: types.Stimulus, _: caps_mod.Caps) !types.Decision {
        if (self.wake_id) |id| {
            const pinned = findRead(stimulus, id) orelse return .{
                .control = .{ .continue_wait = id },
                .evidence = &park_evidence,
            };
            const mismatch = if (self.expected_digest) |expected|
                !std.mem.eql(u8, &pinned.digest, &expected)
            else
                false;
            if (mismatch or self.force_alt) return .{
                .control = .{ .terminate = self.terminate_alt },
                .effects = self.effects_alt,
                .evidence = self.evidence,
            };
        }
        return .{
            .control = .{ .terminate = self.terminate },
            .effects = self.effects,
            .evidence = self.evidence,
        };
    }
};

const EventJ = struct {
    firing_id: []const u8,
    decision_digest: []const u8,
    status: []const u8,
};

/// The iterative grounding hook: every durable `neuron.firing-settled/v1`
/// event re-fires this neuron, which decodes the event payload and writes an
/// immutable per-beat context artifact under `agents/<id>/context/`. Later
/// runs pin the accumulated context back into their seed stimulus, so the
/// agent's working context is reconstructed from its own settled history.
const GrounderNeuron = struct {
    allocator: Allocator,
    agent: []const u8,

    pub fn fire(self: *const GrounderNeuron, stimulus: types.Stimulus, _: caps_mod.Caps) !types.Decision {
        if (stimulus.messages.len == 0) return error.MissingSettlementEvent;
        const payload = stimulus.messages[0].payload;
        const event = std.json.parseFromSliceLeaky(
            EventJ,
            self.allocator,
            payload,
            .{ .ignore_unknown_fields = true },
        ) catch return error.InvalidSettlementEvent;
        const sanitized = try self.allocator.dupe(u8, event.firing_id);
        for (sanitized) |*char| {
            if (char.* == '/') char.* = '-';
        }
        const id = try std.fmt.allocPrint(
            self.allocator,
            "agents/{s}/context/{s}",
            .{ self.agent, sanitized },
        );
        const bytes = try std.json.Stringify.valueAlloc(self.allocator, .{
            .schema = CONTEXT_SCHEMA,
            .agent = self.agent,
            .firing_id = event.firing_id,
            .decision_digest = event.decision_digest,
            .status = event.status,
        }, .{});
        const effects = try self.allocator.alloc(types.Effect, 1);
        effects[0] = .{ .write = .{ .id = id, .schema = CONTEXT_SCHEMA, .bytes = bytes } };
        const evidence = try self.allocator.alloc(types.Evidence, 1);
        evidence[0] = .{
            .claim = "committed beat re-grounded into durable agent context",
            .sources = &stimulus_sources,
            .method = "settlement-event-decode",
        };
        return .{
            .control = .{ .terminate = "grounded" },
            .effects = effects,
            .evidence = evidence,
        };
    }
};

fn findRead(stimulus: types.Stimulus, id: []const u8) ?types.ArtifactRef {
    for (stimulus.reads) |read| {
        if (std.mem.eql(u8, read.id, id)) return read;
    }
    return null;
}

fn validAgentId(agent: []const u8) bool {
    if (agent.len == 0 or agent.len > 64) return false;
    for (agent) |char| switch (char) {
        'a'...'z', '0'...'9', '-' => {},
        else => return false,
    };
    return true;
}

fn agentPath(a: Allocator, agent: []const u8, comptime suffix: []const u8) ![]u8 {
    return std.fmt.allocPrint(a, "agents/{s}/" ++ suffix, .{agent});
}

fn agentCaps(a: Allocator, agent: []const u8, comptime suffix: []const u8) !caps_mod.Caps {
    return .{
        .allow_write = true,
        .write_prefix = try std.fmt.allocPrint(a, "agents/{s}/" ++ suffix, .{agent}),
    };
}

fn singleEvidence(a: Allocator, claim: []const u8, method: []const u8, source_ids: []const []const u8) ![]types.Evidence {
    const evidence = try a.alloc(types.Evidence, 1);
    evidence[0] = .{ .claim = claim, .sources = source_ids, .method = method };
    return evidence;
}

fn snapshotBytes(
    a: Allocator,
    agent: []const u8,
    seq: usize,
    status: []const u8,
    workflow: []const u8,
    goal_digest: []const u8,
    result_digest: []const u8,
) ![]u8 {
    return std.json.Stringify.valueAlloc(a, .{
        .schema = SNAPSHOT_SCHEMA,
        .agent = agent,
        .seq = seq,
        .status = status,
        .workflow = workflow,
        .goal_digest = goal_digest,
        .result_digest = result_digest,
    }, .{});
}

/// The one place a verdict record's shape is defined. Both the verifier that
/// writes it and every party that checks it by content identity build it here,
/// so the settler's gate cannot drift away from the verifier's output.
fn verdictBytes(a: Allocator, workflow: []const u8, ok: bool, result_hex: []const u8) ![]u8 {
    return std.json.Stringify.valueAlloc(a, .{
        .schema = VERDICT_SCHEMA,
        .workflow = workflow,
        .ok = ok,
        .result_digest = result_hex,
    }, .{});
}

/// The product digest a settled workflow recorded for itself. Replay reads it
/// rather than recomputing, so a non-deterministic boundary is never re-invoked
/// merely to confirm it already succeeded.
fn recordedResultDigest(
    a: Allocator,
    substrate: *substrate_mod.Substrate,
    result_id: []const u8,
) ?[]const u8 {
    const artifact = substrate.artifacts.get(result_id) orelse return null;
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, a, artifact.bytes, .{}) catch return null;
    if (parsed != .object) return null;
    const value = parsed.object.get("result_digest") orelse return null;
    if (value != .string or value.string.len != 64) return null;
    return a.dupe(u8, value.string) catch null;
}

const SnapshotView = struct {
    id: []const u8,
    seq: usize,
    status: []const u8,
    workflow: []const u8,
    result_digest: []const u8,
};

/// The returned view owns copies of every string: artifact bytes belong to
/// the substrate and are freed when a CAS overwrite replaces them, so a view
/// held across further firings must never borrow them.
fn loadActiveSnapshot(a: Allocator, substrate: *substrate_mod.Substrate, agent: []const u8) !SnapshotView {
    const active_id = try agentPath(a, agent, "active");
    const active = substrate.artifacts.get(active_id) orelse return error.CorruptAgentState;
    const snapshot = substrate.artifacts.get(active.bytes) orelse return error.CorruptAgentState;
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, a, snapshot.bytes, .{}) catch
        return error.CorruptAgentState;
    const seq = parsed.object.get("seq") orelse return error.CorruptAgentState;
    const status = parsed.object.get("status") orelse return error.CorruptAgentState;
    return .{
        .id = try a.dupe(u8, active.bytes),
        .seq = @intCast(seq.integer),
        .status = try a.dupe(u8, status.string),
        .workflow = if (parsed.object.get("workflow")) |value| try a.dupe(u8, value.string) else "",
        .result_digest = if (parsed.object.get("result_digest")) |value| try a.dupe(u8, value.string) else "",
    };
}

/// Number of the next free attempt scope for a workflow: 0 when no firing of
/// the workflow was ever recorded, otherwise one past the highest recorded
/// attempt (bare-scope firings count as attempt 0).
fn countAttempts(substrate: *substrate_mod.Substrate, workflow: []const u8) usize {
    var next: usize = 0;
    var iterator = substrate.firings.iterator();
    while (iterator.next()) |entry| {
        const id = entry.key_ptr.*;
        if (!std.mem.startsWith(u8, id, workflow) or id.len <= workflow.len or id[workflow.len] != '/')
            continue;
        var attempt: usize = 0;
        const rest = id[workflow.len + 1 ..];
        if (rest.len > 1 and rest[0] == 'a') {
            if (std.mem.indexOfScalar(u8, rest, '/')) |slash| {
                attempt = std.fmt.parseInt(usize, rest[1..slash], 10) catch 0;
            }
        }
        if (attempt + 1 > next) next = attempt + 1;
    }
    return next;
}

fn countPrefix(substrate: *substrate_mod.Substrate, prefix: []const u8) usize {
    var count: usize = 0;
    var iterator = substrate.artifacts.iterator();
    while (iterator.next()) |entry| {
        if (std.mem.startsWith(u8, entry.key_ptr.*, prefix)) count += 1;
    }
    return count;
}

/// Genesis: one atomic firing writes the manifest, snapshot 0000, and the
/// active pointer. A second init on the same substrate fails closed.
pub fn initAgentCore(a: Allocator, substrate: *substrate_mod.Substrate, agent: []const u8) !void {
    if (!validAgentId(agent)) return error.InvalidAgentId;
    const manifest_id = try agentPath(a, agent, "manifest");
    if (substrate.artifacts.contains(manifest_id)) return error.AgentAlreadyInitialized;

    const snapshot_id = try std.fmt.allocPrint(a, "agents/{s}/snapshots/0000", .{agent});
    const manifest_bytes = try std.json.Stringify.valueAlloc(a, .{
        .schema = MANIFEST_SCHEMA,
        .agent = agent,
        .profile = "reference/default",
    }, .{});
    const snapshot_bytes = try snapshotBytes(a, agent, 0, "idle", "", "", "");

    const effects = try a.alloc(types.Effect, 3);
    effects[0] = .{ .write = .{ .id = manifest_id, .schema = MANIFEST_SCHEMA, .bytes = manifest_bytes } };
    effects[1] = .{ .write = .{ .id = snapshot_id, .schema = SNAPSHOT_SCHEMA, .bytes = snapshot_bytes } };
    effects[2] = .{ .write = .{
        .id = try agentPath(a, agent, "active"),
        .schema = ACTIVE_SCHEMA,
        .bytes = snapshot_id,
    } };

    const genesis: StageNeuron = .{
        .effects = effects,
        .evidence = try singleEvidence(
            a,
            "agent genesis: manifest, snapshot 0000, and active pointer",
            "deterministic-genesis",
            &stimulus_sources,
        ),
        .terminate = "initialized",
    };
    const runtime: runtime_mod.Runtime = .{ .substrate = substrate };
    const neuron = neuron_mod.bind(StageNeuron, &genesis, try std.fmt.allocPrint(a, "agent/{s}/genesis", .{agent}), "1.0.0");
    _ = try runtime.fire(neuron, .{
        .firing_id = try std.fmt.allocPrint(a, "agent/{s}/init", .{agent}),
        .receptor_schema = "neuron.agent-init/v1",
    }, try agentCaps(a, agent, ""));
}

/// What actually performs this goal's work, resolved from durable topology.
///
/// With no attached worker interface the agent falls back to the deterministic
/// reference resolution (`sha256("resolve:" ++ goal)`) — a self-contained
/// witness of the stage network, not a claim to have done anything in the
/// world. With one attached, the goal crosses a real pinned boundary and the
/// product is whatever that boundary returned.
///
/// The pin is part of the work identity: the same goal through a different
/// interface, or under a different acceptance predicate, is different work and
/// gets its own workflow rather than replaying a stale result.
pub const Hop = struct {
    manifest: membrane.Manifest,
    hex: []const u8,
    /// This hop's product. Filled in by `performWork`, in order.
    output: []const u8 = "",
};

pub const WorkPlan = struct {
    /// The ordered chain that performs the work. Empty means the deterministic
    /// reference resolution; one hop is the single-boundary case; more is a
    /// pipeline where each hop's product is the next hop's input.
    hops: []Hop = &.{},
    effector: ?membrane.Manifest = null,
    effector_hex: []const u8 = "",
    acceptance: ?membrane.Acceptance = null,
    acceptance_hex: []const u8 = "",
    /// Composite identity of everything that shapes the product. Empty on the
    /// pure reference path, which keeps its historical workflow identities.
    pin: []const u8 = "",

    /// The work product, and how it was judged.
    output: []const u8 = "",
    /// True when an independent second invocation reproduced the product, or
    /// when the declared acceptance predicate held. False means the work was
    /// performed and judged bad: it settles failed, durably.
    judged_ok: bool = true,
    judgement: []const u8 = "deterministic reference resolution recomputed by the verifier",
};

fn resolveRole(
    a: Allocator,
    io: std.Io,
    substrate: *substrate_mod.Substrate,
    agent: []const u8,
    role: membrane_ops.Role,
    step: usize,
) !?struct { manifest: membrane.Manifest, hex: []const u8 } {
    const live = (try membrane_ops.liveAttachment(a, substrate, agent, role, step)) orelse return null;
    if (!live.attached) return null;
    const hex = try a.dupe(u8, &live.interface_hex);
    const manifest = try membrane_ops.resolveAdmitted(a, substrate, hex);
    // Re-pin before the boundary is used for anything: an interface whose
    // implementation moved since admission is not the admitted interface.
    try membrane.verifyImplementation(a, io, &manifest);
    return .{ .manifest = manifest, .hex = hex };
}

/// Public because re-derivation has to ask the topology a question before it
/// re-fires anything: *can this producer claim determinism?* A boundary that
/// cannot re-derives a different answer, invalidates its own dependents, and
/// never reaches a fixpoint — so determinism is R10's termination proof, not a
/// safety preference. Resolution alone crosses nothing: `performWork` is the
/// step that invokes, and it stays private.
pub fn resolveWorkPlan(
    a: Allocator,
    io: std.Io,
    substrate: *substrate_mod.Substrate,
    agent: []const u8,
    acceptance_bytes: ?[]const u8,
) !WorkPlan {
    var plan: WorkPlan = .{};
    const chain = try membrane_ops.liveChain(a, substrate, agent, .worker);
    var hops: std.ArrayList(Hop) = .empty;
    for (chain, 0..) |_, step| {
        const resolved = (try resolveRole(a, io, substrate, agent, .worker, step)) orelse break;
        try hops.append(a, .{ .manifest = resolved.manifest, .hex = resolved.hex });
    }
    plan.hops = try hops.toOwnedSlice(a);
    if (try resolveRole(a, io, substrate, agent, .effector, 0)) |resolved| {
        plan.effector = resolved.manifest;
        plan.effector_hex = resolved.hex;
    }
    if (acceptance_bytes) |bytes| {
        plan.acceptance = try membrane.Acceptance.parse(a, bytes);
        plan.acceptance_hex = try a.dupe(u8, &std.fmt.bytesToHex(types.digest(bytes), .lower));
    }
    if (plan.hops.len > 0 or plan.effector_hex.len > 0 or plan.acceptance_hex.len > 0) {
        // The whole chain is part of the work identity: inserting, removing, or
        // reordering a hop is different work, not a replay of the old work.
        var pin: std.ArrayList(u8) = .empty;
        for (plan.hops, 0..) |hop, step| {
            try pin.appendSlice(a, try std.fmt.allocPrint(a, "hop{d}={s}\n", .{ step, hop.hex }));
        }
        try pin.appendSlice(a, try std.fmt.allocPrint(a, "effector={s}\nacceptance={s}", .{
            plan.effector_hex,
            plan.acceptance_hex,
        }));
        plan.pin = try pin.toOwnedSlice(a);
    }

    return plan;
}

/// Cross the boundary and judge the product. Deliberately separate from
/// topology resolution: a replayed or cancelled workflow must never invoke
/// anything, and for a non-deterministic boundary a needless invocation would
/// produce a product that disagrees with the recorded one.
fn performWork(a: Allocator, io: std.Io, plan: *WorkPlan, goal: []const u8) !void {
    if (plan.hops.len > 0) {
        // Walk the chain. Every hop is the same contract as a single boundary:
        // typed input, one pinned interface identity, its own deadline and
        // output ceiling, a typed product or a typed failure. The previous
        // hop's product is the next hop's input, so causation is the data.
        var carried: []const u8 = goal;
        var deterministic_chain = true;
        for (plan.hops) |*hop| {
            const first = try membrane.invokeRead(a, io, &hop.manifest, carried);
            hop.output = first.output;
            if (hop.manifest.invocation.deterministic) {
                // Independent recomputation, per hop: a chain is only
                // reproducible if every link is, and the weakest link decides.
                const second = try membrane.invokeRead(a, io, &hop.manifest, carried);
                if (!std.mem.eql(u8, &first.output_digest, &second.output_digest)) {
                    plan.judged_ok = false;
                    plan.judgement = "a hop declared deterministic returned two different products";
                    return;
                }
            } else {
                deterministic_chain = false;
            }
            carried = hop.output;
        }
        plan.output = carried;
        if (deterministic_chain) {
            plan.judgement = if (plan.hops.len == 1)
                "product reproduced by an independent second invocation of the pinned boundary"
            else
                "every hop of the chain reproduced by an independent second invocation";
        } else {
            // A chain containing a non-deterministic hop cannot be verified by
            // repetition, so it must be judged against an explicit predicate.
            if (plan.acceptance == null) return error.AcceptancePredicateRequired;
            plan.judgement = "non-deterministic chain judged against the caller's acceptance predicate";
        }
        if (plan.acceptance) |*predicate| {
            plan.judged_ok = predicate.holds(plan.output);
            if (!plan.judged_ok) plan.judgement = "acceptance predicate did not hold on the real output";
        }
    } else if (plan.acceptance) |*predicate| {
        // The reference path still honours an explicit predicate, judged
        // against the bytes it actually produced.
        const hex = try referenceProductHex(a, goal);
        plan.judged_ok = predicate.holds(hex);
        if (!plan.judged_ok) plan.judgement = "acceptance predicate did not hold on the reference resolution";
    }
}

pub fn workflowId(a: Allocator, agent: []const u8, goal: []const u8) ![]u8 {
    const digest_hex = std.fmt.bytesToHex(types.digest(goal), .lower);
    return std.fmt.allocPrint(a, "agent/{s}/goal/{s}", .{ agent, digest_hex[0..16] });
}

/// The deterministic reference profile's product for a goal, in one place.
///
/// The producer and the verifier both compute this — that pair is deliberate,
/// because the verifier recomputing independently is what makes the comparison
/// meaningful. What is NOT deliberate is a third copy in a consumer: this
/// module owns the reference profile, so a caller outside it that re-derives
/// the formula by hand keeps emitting the old digest the moment the profile
/// changes, internally consistent and silently wrong.
pub fn referenceProductHex(a: Allocator, goal: []const u8) ![]const u8 {
    const resolved = try std.fmt.allocPrint(a, "resolve:{s}", .{goal});
    return a.dupe(u8, &std.fmt.bytesToHex(types.digest(resolved), .lower));
}

/// Drive one typed goal to settlement through the composed stage network.
/// Deterministic reference profile: the worker resolves the goal to
/// `sha256("resolve:" ++ goal)`; the verifier recomputes it independently and
/// compares digests through pinned reads, never through the producer's claim.
pub fn runGoalCore(
    a: Allocator,
    io: std.Io,
    substrate: *substrate_mod.Substrate,
    agent: []const u8,
    goal: []const u8,
    budget: usize,
    /// An explicit `neuron.acceptance-predicate/v1` document, when the caller
    /// declared one. Required for a non-deterministic worker interface, whose
    /// product cannot be verified by repetition.
    acceptance_bytes: ?[]const u8,
) !RunResult {
    if (!validAgentId(agent)) return error.InvalidAgentId;
    if (goal.len == 0) return error.EmptyGoal;
    const manifest_id = try agentPath(a, agent, "manifest");
    if (!substrate.artifacts.contains(manifest_id)) return error.AgentNotInitialized;
    const current = try loadActiveSnapshot(a, substrate, agent);
    if (std.mem.eql(u8, current.status, "retired")) return error.AgentRetired;

    const goal_digest = types.digest(goal);
    const goal_hex = std.fmt.bytesToHex(goal_digest, .lower);

    // Topology first, invocation later: the work identity must be known before
    // deciding whether this workflow needs to run at all.
    var plan = try resolveWorkPlan(a, io, substrate, agent, acceptance_bytes);
    const work_hex = if (plan.pin.len == 0) goal_hex else blk: {
        const composite = try std.fmt.allocPrint(a, "{s}\n{s}", .{ goal, plan.pin });
        break :blk std.fmt.bytesToHex(types.digest(composite), .lower);
    };
    const short = work_hex[0..16];
    const workflow = try std.fmt.allocPrint(a, "agent/{s}/goal/{s}", .{ agent, short });
    if (substrate.firings.get(try std.fmt.allocPrint(a, "{s}/intake", .{workflow}))) |record| {
        if (record.status == .cancelled) return error.WorkflowCancelled;
    }

    // Attempt namespace: the first attempt owns the bare workflow ids; a
    // resume after interruption gets a fresh `a<n>` scope so its firings
    // never collide with the interrupted attempt's recorded identities,
    // while durable artifacts still carry the workflow forward by CAS.
    const attempt = countAttempts(substrate, workflow);
    const scope = if (attempt == 0)
        workflow
    else
        try std.fmt.allocPrint(a, "{s}/a{d}", .{ workflow, attempt });
    const intake_firing = try std.fmt.allocPrint(a, "{s}/intake", .{scope});

    const goal_id = try std.fmt.allocPrint(a, "agents/{s}/goals/{s}", .{ agent, short });
    const result_id = try std.fmt.allocPrint(a, "agents/{s}/work/{s}/result", .{ agent, short });
    const output_id = try std.fmt.allocPrint(a, "agents/{s}/work/{s}/output", .{ agent, short });
    const verdict_id = try std.fmt.allocPrint(a, "agents/{s}/work/{s}/verdict", .{ agent, short });
    const ack_id = try std.fmt.allocPrint(a, "agents/{s}/work/{s}/ack", .{ agent, short });
    const active_id = try agentPath(a, agent, "active");
    const context_prefix = try agentPath(a, agent, "context/");

    // Canonical reuse (SMP-12), decided before anything is invoked: a settled
    // goal replays from its recorded artifacts. The recorded result names its
    // own product digest, so a non-deterministic boundary is never re-invoked
    // just to discover it already succeeded.
    //
    // A verdict alone is not settlement when an effector is attached — the
    // consequential leg may still be unreconciled — so that case falls through
    // and resumes instead of reporting a replay that never landed.
    if (substrate.artifacts.get(verdict_id)) |verdict| {
        const recorded_hex = recordedResultDigest(a, substrate, result_id) orelse
            return error.CorruptAgentState;
        const recorded_ok = try verdictBytes(a, workflow, true, recorded_hex);
        if (!std.mem.eql(u8, &verdict.digest, &types.digest(recorded_ok)))
            return error.WorkflowFailedPreviously;
        if (plan.effector == null or substrate.artifacts.contains(ack_id)) {
            var replay_hex: [64]u8 = undefined;
            @memcpy(&replay_hex, recorded_hex[0..64]);
            return .{
                .status = .replayed,
                .workflow = workflow,
                .goal_digest = goal_hex,
                .result_digest = replay_hex,
                .snapshot_id = current.id,
                .snapshot_seq = current.seq,
                .beats = countPrefix(substrate, context_prefix),
                .steps = 0,
                .pending = 0,
            };
        }
    }

    // Only now, with the workflow identified, uncancelled, and not already
    // settled, is the boundary crossed.
    try performWork(a, io, &plan, goal);

    const result_hex = if (plan.hops.len == 0)
        (try referenceProductHex(a, goal))[0..64].*
    else
        std.fmt.bytesToHex(types.digest(plan.output), .lower);

    const goal_bytes = try std.json.Stringify.valueAlloc(a, .{
        .schema = GOAL_SCHEMA,
        .agent = agent,
        .workflow = workflow,
        .goal = goal,
    }, .{});
    // The reference path keeps its historical four-field result record so its
    // recorded identities stay stable; an interface result additionally names
    // the exact boundary and implementation that produced it.
    const result_bytes = if (plan.hops.len > 0) blk: {
        const last = &plan.hops[plan.hops.len - 1];
        // The envelope names the whole chain, in order, so the product's
        // provenance is the sequence of boundaries that actually produced it.
        var chain_json = std.json.Array.init(a);
        for (plan.hops) |hop| {
            var entry: std.json.ObjectMap = .empty;
            try entry.put(a, "interface", .{ .string = hop.hex });
            try entry.put(a, "interface_id", .{ .string = hop.manifest.id });
            try entry.put(a, "kind", .{ .string = hop.manifest.kind.name() });
            try entry.put(a, "implementation_digest", .{
                .string = try a.dupe(u8, &hop.manifest.implementationHex()),
            });
            try entry.put(a, "output_digest", .{
                .string = try a.dupe(u8, &std.fmt.bytesToHex(types.digest(hop.output), .lower)),
            });
            try chain_json.append(.{ .object = entry });
        }
        var envelope: std.json.ObjectMap = .empty;
        try envelope.put(a, "schema", .{ .string = RESULT_SCHEMA });
        try envelope.put(a, "workflow", .{ .string = workflow });
        try envelope.put(a, "goal_digest", .{ .string = try a.dupe(u8, goal_hex[0..]) });
        try envelope.put(a, "result_digest", .{ .string = try a.dupe(u8, result_hex[0..]) });
        try envelope.put(a, "interface", .{ .string = last.hex });
        try envelope.put(a, "interface_id", .{ .string = last.manifest.id });
        try envelope.put(a, "implementation_digest", .{
            .string = try a.dupe(u8, &last.manifest.implementationHex()),
        });
        try envelope.put(a, "output", .{ .string = output_id });
        try envelope.put(a, "chain", .{ .array = chain_json });
        try envelope.put(a, "judgement", .{ .string = plan.judgement });
        break :blk try std.json.Stringify.valueAlloc(a, std.json.Value{ .object = envelope }, .{});
    } else try std.json.Stringify.valueAlloc(a, .{
        .schema = RESULT_SCHEMA,
        .workflow = workflow,
        .goal_digest = goal_hex[0..],
        .result_digest = result_hex[0..],
    }, .{});
    const verdict_ok_bytes = try verdictBytes(a, workflow, true, result_hex[0..]);
    const verdict_bad_bytes = try verdictBytes(a, workflow, false, "");

    const seq_new = current.seq + 1;
    const snapshot_new_id = try std.fmt.allocPrint(a, "agents/{s}/snapshots/{d:0>4}", .{ agent, seq_new });
    const snapshot_settled = try snapshotBytes(a, agent, seq_new, "settled", workflow, goal_hex[0..], result_hex[0..]);
    const snapshot_failed = try snapshotBytes(a, agent, seq_new, "failed", workflow, goal_hex[0..], "");
    const active_artifact = substrate.artifacts.get(active_id) orelse return error.CorruptAgentState;

    // Stage effects. Prior artifacts from an interrupted attempt are advanced
    // by CAS on their recorded digests, never blindly overwritten.
    const intake_effects = try a.alloc(types.Effect, 1);
    intake_effects[0] = .{ .write = .{
        .id = goal_id,
        .schema = GOAL_SCHEMA,
        .bytes = goal_bytes,
        .expected_prior = if (substrate.artifacts.get(goal_id)) |prior| prior.digest else null,
    } };
    // On the interface path the raw product is written as its own artifact:
    // downstream stages and later goals get the actual bytes, and the result
    // record stays a small typed provenance envelope over them.
    const worker_effects = try a.alloc(types.Effect, if (plan.hops.len == 0) 1 else 2);
    worker_effects[0] = .{ .write = .{
        .id = result_id,
        .schema = RESULT_SCHEMA,
        .bytes = result_bytes,
        .expected_prior = if (substrate.artifacts.get(result_id)) |prior| prior.digest else null,
    } };
    if (plan.hops.len > 0) worker_effects[1] = .{ .write = .{
        .id = output_id,
        .schema = membrane.RESULT_SCHEMA,
        .bytes = plan.output,
        .expected_prior = if (substrate.artifacts.get(output_id)) |prior| prior.digest else null,
    } };

    // The consequential step is the verifier's, not the worker's: an effector
    // command is committed to the outbox only on the path where the product has
    // already been judged. Nothing crosses the boundary before judgement, and
    // the record names the product by content so dispatch is idempotent.
    const verifier_ok_effects = try a.alloc(types.Effect, if (plan.effector == null) 1 else 2);
    verifier_ok_effects[0] = .{ .write = .{ .id = verdict_id, .schema = VERDICT_SCHEMA, .bytes = verdict_ok_bytes } };
    if (plan.effector != null) {
        const envelope = try std.json.Stringify.valueAlloc(a, .{
            .schema = membrane.CALL_SCHEMA,
            .interface = plan.effector_hex,
            .content = output_id,
            .content_digest = result_hex[0..],
            .idempotency_key = result_hex[0..],
        }, .{});
        verifier_ok_effects[1] = .{ .send = .{
            .to = try std.fmt.allocPrint(a, membrane_ops.OUTBOX_PREFIX ++ "{s}/{s}", .{
                plan.effector_hex,
                result_hex[0..],
            }),
            .schema = membrane.CALL_SCHEMA,
            .payload = envelope,
            .durable = true,
        } };
    }
    // The rejection path must satisfy the same predicate the settler waits on,
    // or a judged-bad goal would leave the settler parked forever with nothing
    // durable recorded. So with an effector attached the rejection also writes
    // the acknowledgement artifact — carrying `reconciled: false`, which is a
    // different content identity and therefore settles the goal as failed.
    const verifier_bad_effects = try a.alloc(types.Effect, if (plan.effector == null) 1 else 2);
    verifier_bad_effects[0] = .{ .write = .{ .id = verdict_id, .schema = VERDICT_SCHEMA, .bytes = verdict_bad_bytes } };
    if (plan.effector != null) verifier_bad_effects[1] = .{ .write = .{
        .id = ack_id,
        .schema = ACK_SCHEMA,
        .bytes = try std.json.Stringify.valueAlloc(a, .{
            .schema = ACK_SCHEMA,
            .workflow = workflow,
            .interface = plan.effector_hex,
            .content_digest = "",
            .reconciled = false,
        }, .{}),
        .expected_prior = if (substrate.artifacts.get(ack_id)) |prior| prior.digest else null,
    } };
    const settler_ok_effects = try a.alloc(types.Effect, 2);
    settler_ok_effects[0] = .{ .write = .{ .id = snapshot_new_id, .schema = SNAPSHOT_SCHEMA, .bytes = snapshot_settled } };
    settler_ok_effects[1] = .{ .write = .{
        .id = active_id,
        .schema = ACTIVE_SCHEMA,
        .bytes = snapshot_new_id,
        .expected_prior = active_artifact.digest,
    } };
    const settler_bad_effects = try a.alloc(types.Effect, 2);
    settler_bad_effects[0] = .{ .write = .{ .id = snapshot_new_id, .schema = SNAPSHOT_SCHEMA, .bytes = snapshot_failed } };
    settler_bad_effects[1] = .{ .write = .{
        .id = active_id,
        .schema = ACTIVE_SCHEMA,
        .bytes = snapshot_new_id,
        .expected_prior = active_artifact.digest,
    } };

    // One artifact per intermediate hop: the chain's causation is durable data,
    // not an inference from the final product.
    const hop_ids = try a.alloc([]const u8, plan.hops.len);
    for (hop_ids, 0..) |*id, step| {
        id.* = try std.fmt.allocPrint(a, "agents/{s}/work/{s}/hop/{d:0>2}", .{ agent, short, step });
    }
    const goal_source = try a.alloc([]const u8, 1);
    goal_source[0] = goal_id;
    // The final stage wakes on the last intermediate hop when there is one, and
    // on the goal itself for a single-boundary chain.
    const last_wake_id: []const u8 = if (plan.hops.len > 1) hop_ids[plan.hops.len - 2] else goal_id;
    const last_hop_source = try a.alloc([]const u8, 1);
    last_hop_source[0] = last_wake_id;
    const result_source = try a.alloc([]const u8, 1);
    result_source[0] = result_id;
    const verdict_source = try a.alloc([]const u8, 1);
    verdict_source[0] = verdict_id;
    // The settler cites whatever actually woke it. With an effector attached
    // that is the reconciliation acknowledgement, which is the only artifact
    // the pump pins into its read-set — evidence must name the evidence it got.
    const settle_source = try a.alloc([]const u8, 1);
    settle_source[0] = if (plan.effector == null) verdict_id else ack_id;
    const intake_source = try a.alloc([]const u8, 2);
    intake_source[0] = "stimulus";
    intake_source[1] = active_id;

    const intake: StageNeuron = .{
        .effects = intake_effects,
        .evidence = try singleEvidence(a, "typed goal normalized into a durable goal artifact", "goal-intake", intake_source),
        .terminate = "accepted",
    };
    const worker: StageNeuron = .{
        .wake_id = last_wake_id,
        .effects = worker_effects,
        .evidence = if (plan.hops.len > 0)
            try singleEvidence(
                a,
                plan.hops[plan.hops.len - 1].manifest.evidence_claim,
                plan.hops[plan.hops.len - 1].manifest.evidence_method,
                last_hop_source,
            )
        else
            try singleEvidence(a, "goal resolved deterministically from the pinned goal artifact", "sha256-resolve", goal_source),
        .terminate = "worked",
    };
    const verifier: StageNeuron = .{
        .wake_id = result_id,
        .expected_digest = types.digest(result_bytes),
        // Work that was performed but judged bad settles through the ordinary
        // rejection path, so the failure is durable and inspectable rather
        // than an aborted run with nothing recorded.
        .force_alt = !plan.judged_ok,
        .effects = verifier_ok_effects,
        .effects_alt = verifier_bad_effects,
        .evidence = try singleEvidence(a, plan.judgement, "independent-digest-compare", result_source),
        .terminate = "verified",
        .terminate_alt = "rejected",
    };
    // With an effector attached the settler waits on the reconciliation
    // acknowledgement, not merely on the verdict: the agent does not call the
    // goal settled until the external consequence has been read back.
    const ack_bytes = try std.json.Stringify.valueAlloc(a, .{
        .schema = ACK_SCHEMA,
        .workflow = workflow,
        .interface = plan.effector_hex,
        .content_digest = result_hex[0..],
        .reconciled = true,
    }, .{});
    const settler: StageNeuron = .{
        .wake_id = if (plan.effector == null) verdict_id else ack_id,
        .expected_digest = if (plan.effector == null)
            types.digest(verdict_ok_bytes)
        else
            types.digest(ack_bytes),
        .effects = settler_ok_effects,
        .effects_alt = settler_bad_effects,
        .evidence = try singleEvidence(
            a,
            if (plan.effector == null)
                "verified verdict advanced the active snapshot by compare-and-swap"
            else
                "reconciled external effect advanced the active snapshot by compare-and-swap",
            "cas-snapshot-advance",
            settle_source,
        ),
        .terminate = "settled",
        .terminate_alt = "failed",
    };
    // Intermediate hops: stages 0..n-2. The final hop is the `worker` stage
    // above, so a single-boundary chain has no intermediate stages at all and
    // keeps exactly the shape it had before chains existed.
    const intermediate = if (plan.hops.len > 1) plan.hops.len - 1 else 0;
    const hop_stages = try a.alloc(StageNeuron, intermediate);
    const hop_refs = try a.alloc([]const u8, intermediate);
    for (hop_stages, 0..) |*stage, step| {
        const wake: []const u8 = if (step == 0) goal_id else hop_ids[step - 1];
        const source = try a.alloc([]const u8, 1);
        source[0] = wake;
        const effects = try a.alloc(types.Effect, 1);
        effects[0] = .{ .write = .{
            .id = hop_ids[step],
            .schema = membrane.RESULT_SCHEMA,
            .bytes = plan.hops[step].output,
            .expected_prior = if (substrate.artifacts.get(hop_ids[step])) |prior| prior.digest else null,
        } };
        stage.* = .{
            .wake_id = wake,
            .effects = effects,
            .evidence = try singleEvidence(
                a,
                plan.hops[step].manifest.evidence_claim,
                plan.hops[step].manifest.evidence_method,
                source,
            ),
            .terminate = "hopped",
        };
        hop_refs[step] = try std.fmt.allocPrint(a, "agent/{s}/hop/{d:0>2}", .{ agent, step });
    }

    const grounder: GrounderNeuron = .{ .allocator = a, .agent = agent };

    const intake_ref = try std.fmt.allocPrint(a, "agent/{s}/intake", .{agent});
    const worker_ref = try std.fmt.allocPrint(a, "agent/{s}/worker", .{agent});
    const verifier_ref = try std.fmt.allocPrint(a, "agent/{s}/verifier", .{agent});
    const settler_ref = try std.fmt.allocPrint(a, "agent/{s}/settler", .{agent});
    const grounder_ref = try std.fmt.allocPrint(a, "agent/{s}/grounder", .{agent});

    const runtime: runtime_mod.Runtime = .{ .substrate = substrate };
    var scheduler = scheduler_mod.Scheduler.init(a, runtime);
    defer scheduler.deinit();
    try scheduler.register(neuron_mod.bind(StageNeuron, &intake, intake_ref, "1.0.0"));
    for (hop_stages, hop_refs) |*stage, ref| {
        try scheduler.register(neuron_mod.bind(StageNeuron, stage, ref, "1.0.0"));
    }
    try scheduler.register(neuron_mod.bind(StageNeuron, &worker, worker_ref, "1.0.0"));
    try scheduler.register(neuron_mod.bind(StageNeuron, &verifier, verifier_ref, "1.0.0"));
    try scheduler.register(neuron_mod.bind(StageNeuron, &settler, settler_ref, "1.0.0"));
    try scheduler.register(neuron_mod.bind(GrounderNeuron, &grounder, grounder_ref, "1.0.0"));

    var pump = pump_mod.Pump.init(a, &scheduler);
    defer pump.deinit();
    pump.max_steps = budget;
    pump.firing_prefix = try std.fmt.allocPrint(a, "{s}/step", .{scope});
    // The hook: every committed firing's durable settlement event re-fires
    // the grounder, so context accrues from real settlements, iteratively,
    // for the whole run — not from a privileged host observer.
    try pump.subscribe("neuron.firing-settled/v1", grounder_ref, try agentCaps(a, agent, "context/"), &.{});

    const intake_caps = try agentCaps(a, agent, "goals/");
    const work_caps = try agentCaps(a, agent, "work/");
    const settle_caps = try agentCaps(a, agent, "");
    // The verifier is the only stage that may queue a consequential command,
    // and only into the interface outbox namespace. Every other stage keeps a
    // write-only grant.
    var verify_caps = work_caps;
    if (plan.effector != null) {
        verify_caps.allow_send = true;
        verify_caps.send_prefix = membrane_ops.OUTBOX_PREFIX;
    }

    var steps: usize = 0;
    var quiescent = true;
    // Park the downstream stages as waiters on their typed predicates. If a
    // prior interrupted attempt already produced an upstream artifact, the
    // waiter wakes immediately and the workflow resumes instead of forking.
    const Park = struct { ref: []const u8, caps: caps_mod.Caps, tag: []const u8 };
    var parks: std.ArrayList(Park) = .empty;
    try parks.append(a, .{ .ref = settler_ref, .caps = settle_caps, .tag = "park-settler" });
    try parks.append(a, .{ .ref = verifier_ref, .caps = verify_caps, .tag = "park-verifier" });
    try parks.append(a, .{ .ref = worker_ref, .caps = work_caps, .tag = "park-worker" });
    var back = intermediate;
    while (back > 0) {
        back -= 1;
        try parks.append(a, .{
            .ref = hop_refs[back],
            .caps = work_caps,
            .tag = try std.fmt.allocPrint(a, "park-hop-{d:0>2}", .{back}),
        });
    }
    for (parks.items) |park| {
        const outcome = try pump.run(park.ref, .{
            .firing_id = try std.fmt.allocPrint(a, "{s}/{s}", .{ scope, park.tag }),
            .receptor_schema = "neuron.agent-park/v1",
        }, park.caps);
        steps += outcome.steps;
        quiescent = quiescent and outcome.quiescent;
    }

    // A resumed workflow may complete entirely during the parks: the waiters
    // wake from the interrupted attempt's durable artifacts and carry it to
    // settlement. Reload the view before seeding intake — the pre-park view
    // is stale the moment the settler advances the active pointer.
    var pending: usize = 0;
    const live = try loadActiveSnapshot(a, substrate, agent);
    if (!std.mem.eql(u8, live.workflow, workflow)) {
        // Normalize the goal into the typed receptor stimulus, grounded in
        // the reconstructed context: the active pointer and snapshot are
        // pinned by digest so intake's evidence cites the state it actually
        // resumed from.
        const messages = try a.alloc(types.Message, 1);
        messages[0] = .{
            .to = try std.fmt.allocPrint(a, "neuron/{s}", .{intake_ref}),
            .schema = GOAL_SCHEMA,
            .payload = goal_bytes,
            .durable = false,
        };
        const live_active = substrate.artifacts.get(active_id) orelse return error.CorruptAgentState;
        const live_snapshot = substrate.artifacts.get(live.id) orelse return error.CorruptAgentState;
        const permitted = try a.alloc([]const u8, 2);
        permitted[0] = active_id;
        permitted[1] = live.id;
        const reads = try a.alloc(types.ArtifactRef, 2);
        reads[0] = .{ .id = active_id, .digest = live_active.digest };
        reads[1] = .{ .id = live.id, .digest = live_snapshot.digest };

        const outcome = try pump.run(intake_ref, .{
            .firing_id = intake_firing,
            .receptor_schema = GOAL_SCHEMA,
            .permitted_reads = permitted,
            .reads = reads,
            .messages = messages,
        }, intake_caps);
        steps += outcome.steps;
        quiescent = quiescent and outcome.quiescent;
        pending = outcome.pending;
    }
    if (!quiescent) return error.BudgetExhausted;

    // The consequential leg. The verifier's ok path committed an outbox record
    // but nothing has crossed the boundary yet: dispatch it, reconcile it
    // independently, and only then write the acknowledgement the settler is
    // parked on. A crash anywhere in here leaves a queued record that a later
    // run — or `neuron interface dispatch` — drains, because the record and its
    // content are both durable and content-addressed.
    if (plan.effector != null and !substrate.artifacts.contains(ack_id)) {
        if (substrate.artifacts.get(verdict_id)) |verdict| {
            if (std.mem.eql(u8, &verdict.digest, &types.digest(verdict_ok_bytes))) {
                var reconciled = false;
                while (try membrane_ops.dispatchOneCore(a, io, substrate)) |dispatched| {
                    if (dispatched.reconciled) reconciled = true;
                    if (dispatched.status != .acknowledged) break;
                }
                if (!reconciled) return error.EffectNotReconciled;
                const ack_effects = try a.alloc(types.Effect, 1);
                ack_effects[0] = .{ .write = .{ .id = ack_id, .schema = ACK_SCHEMA, .bytes = ack_bytes } };
                // The acknowledgement is grounded in what it followed: the
                // verdict that authorized the command and the product bytes
                // that crossed, both pinned by digest.
                const ack_permitted = try a.alloc([]const u8, 2);
                ack_permitted[0] = verdict_id;
                ack_permitted[1] = output_id;
                var ack_reads: std.ArrayList(types.ArtifactRef) = .empty;
                for (ack_permitted) |id| {
                    if (substrate.artifacts.get(id)) |artifact|
                        try ack_reads.append(a, .{ .id = id, .digest = artifact.digest });
                }
                _ = runtime.execute(.{
                    .firing_id = try std.fmt.allocPrint(a, "{s}/effect-ack", .{scope}),
                    .receptor_schema = ACK_SCHEMA,
                    .permitted_reads = ack_permitted,
                    .reads = ack_reads.items,
                }, work_caps, .{
                    .control = .{ .terminate = "reconciled" },
                    .effects = ack_effects,
                    .evidence = try singleEvidence(
                        a,
                        "committed effector command crossed its boundary and was read back by content digest",
                        "outbox-dispatch-reconcile",
                        verdict_source,
                    ),
                }) catch |err| switch (err) {
                    error.FiringAlreadySettled, error.FiringMismatch => {},
                    else => return err,
                };
                // Wake the parked settler through the ordinary waiter path: the
                // acknowledgement is now evidence, so the pump re-fires it with
                // that artifact pinned into its read-set.
                const outcome = try pump.resumeWaiters();
                steps += outcome.steps;
                pending = outcome.pending;
                if (!outcome.quiescent) return error.BudgetExhausted;
            }
        }
    }

    const after = try loadActiveSnapshot(a, substrate, agent);
    if (!std.mem.eql(u8, after.workflow, workflow)) return error.SettlementIncomplete;
    const status: RunStatus = if (std.mem.eql(u8, after.status, "settled"))
        .settled
    else if (std.mem.eql(u8, after.status, "failed"))
        .failed
    else
        return error.SettlementIncomplete;
    return .{
        .status = status,
        .workflow = workflow,
        .goal_digest = goal_hex,
        .result_digest = result_hex,
        .snapshot_id = after.id,
        .snapshot_seq = after.seq,
        .beats = countPrefix(substrate, context_prefix),
        .steps = steps,
        .pending = pending,
    };
}

/// Cancel a workflow that has not fired yet: its deterministic intake firing
/// settles as cancelled, and a later `agent run` for the same goal fails
/// closed as WorkflowCancelled instead of silently re-running.
pub fn cancelCore(
    a: Allocator,
    substrate: *substrate_mod.Substrate,
    agent: []const u8,
    workflow_or_goal: []const u8,
) ![]const u8 {
    if (!validAgentId(agent)) return error.InvalidAgentId;
    const workflow = if (std.mem.startsWith(u8, workflow_or_goal, "agent/"))
        try a.dupe(u8, workflow_or_goal)
    else
        try workflowId(a, agent, workflow_or_goal);
    const intake_firing = try std.fmt.allocPrint(a, "{s}/intake", .{workflow});
    const runtime: runtime_mod.Runtime = .{ .substrate = substrate };
    try runtime.cancel(intake_firing);
    return workflow;
}

/// Retirement is a firing like any other: a successor snapshot with status
/// `retired` plus a CAS advance of the active pointer. Audit roots remain.
pub fn retireCore(a: Allocator, substrate: *substrate_mod.Substrate, agent: []const u8) !void {
    if (!validAgentId(agent)) return error.InvalidAgentId;
    const manifest_id = try agentPath(a, agent, "manifest");
    if (!substrate.artifacts.contains(manifest_id)) return error.AgentNotInitialized;
    const current = try loadActiveSnapshot(a, substrate, agent);
    if (std.mem.eql(u8, current.status, "retired")) return error.AgentRetired;

    const active_id = try agentPath(a, agent, "active");
    const active_artifact = substrate.artifacts.get(active_id) orelse return error.CorruptAgentState;
    const seq_new = current.seq + 1;
    const snapshot_new_id = try std.fmt.allocPrint(a, "agents/{s}/snapshots/{d:0>4}", .{ agent, seq_new });
    const effects = try a.alloc(types.Effect, 2);
    effects[0] = .{ .write = .{
        .id = snapshot_new_id,
        .schema = SNAPSHOT_SCHEMA,
        .bytes = try snapshotBytes(a, agent, seq_new, "retired", "", "", ""),
    } };
    effects[1] = .{ .write = .{
        .id = active_id,
        .schema = ACTIVE_SCHEMA,
        .bytes = snapshot_new_id,
        .expected_prior = active_artifact.digest,
    } };

    const retirer: StageNeuron = .{
        .effects = effects,
        .evidence = try singleEvidence(a, "agent retired by CAS snapshot advance", "cas-snapshot-advance", &stimulus_sources),
        .terminate = "retired",
    };
    const runtime: runtime_mod.Runtime = .{ .substrate = substrate };
    const neuron = neuron_mod.bind(StageNeuron, &retirer, try std.fmt.allocPrint(a, "agent/{s}/retirer", .{agent}), "1.0.0");
    _ = try runtime.fire(neuron, .{
        .firing_id = try std.fmt.allocPrint(a, "agent/{s}/retire/{d:0>4}", .{ agent, seq_new }),
        .receptor_schema = "neuron.agent-retire/v1",
    }, try agentCaps(a, agent, ""));
}

pub const InspectView = struct {
    agent: []const u8,
    status: []const u8,
    snapshot_id: []const u8,
    snapshot_seq: usize,
    workflow: []const u8,
    result_digest: []const u8,
    goals: usize,
    beats: usize,
    committed: usize,
    cancelled: usize,
};

pub fn inspectCore(a: Allocator, substrate: *substrate_mod.Substrate, agent: []const u8) !InspectView {
    if (!validAgentId(agent)) return error.InvalidAgentId;
    const manifest_id = try agentPath(a, agent, "manifest");
    if (!substrate.artifacts.contains(manifest_id)) return error.AgentNotInitialized;
    const current = try loadActiveSnapshot(a, substrate, agent);
    var committed: usize = 0;
    var cancelled: usize = 0;
    var iterator = substrate.firings.iterator();
    while (iterator.next()) |entry| switch (entry.value_ptr.status) {
        .committed => committed += 1,
        .cancelled => cancelled += 1,
        else => {},
    };
    return .{
        .agent = agent,
        .status = current.status,
        .snapshot_id = current.id,
        .snapshot_seq = current.seq,
        .workflow = current.workflow,
        .result_digest = current.result_digest,
        .goals = countPrefix(substrate, try agentPath(a, agent, "goals/")),
        .beats = countPrefix(substrate, try agentPath(a, agent, "context/")),
        .committed = committed,
        .cancelled = cancelled,
    };
}

// ---------------------------------------------------------------------------
// CLI wrappers: open the durable node substrate, run the core, print, close.
// ---------------------------------------------------------------------------

fn openNodeSubstrate(a: Allocator, io: std.Io, node_dir: []const u8) !substrate_mod.Substrate {
    const state_path = try std.fs.path.join(a, &.{ node_dir, "state" });
    return substrate_mod.Substrate.initDir(a, io, std.Io.Dir.cwd(), state_path);
}

pub fn initAgent(allocator: Allocator, io: std.Io, node_dir: []const u8, agent: []const u8) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var substrate = try openNodeSubstrate(a, io, node_dir);
    defer substrate.deinit();
    try initAgentCore(a, &substrate, agent);
}

pub fn runGoal(
    allocator: Allocator,
    io: std.Io,
    node_dir: []const u8,
    agent: []const u8,
    goal: []const u8,
    budget: usize,
    acceptance_path: ?[]const u8,
    json_out: bool,
) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const acceptance_bytes: ?[]const u8 = if (acceptance_path) |path|
        try std.Io.Dir.cwd().readFileAlloc(io, path, a, .limited(1 << 16))
    else
        null;
    var substrate = try openNodeSubstrate(a, io, node_dir);
    defer substrate.deinit();
    const result = try runGoalCore(a, io, &substrate, agent, goal, budget, acceptance_bytes);
    const line = if (json_out)
        try std.fmt.allocPrint(
            a,
            "{{\"status\":\"{s}\",\"agent\":\"{s}\",\"workflow\":\"{s}\",\"goal_digest\":\"{s}\",\"result_digest\":\"{s}\",\"snapshot\":\"{s}\",\"seq\":{d},\"beats\":{d},\"steps\":{d},\"pending\":{d}}}\n",
            .{ @tagName(result.status), agent, result.workflow, result.goal_digest, result.result_digest, result.snapshot_id, result.snapshot_seq, result.beats, result.steps, result.pending },
        )
    else
        try std.fmt.allocPrint(
            a,
            "✓ goal {s} · snapshot {s} · result {s} · {d} grounded beats\n",
            .{ @tagName(result.status), result.snapshot_id, result.result_digest[0..16], result.beats },
        );
    try writeStdout(io, line);
    if (result.status == .failed) return error.WorkflowFailed;
}

pub fn cancelGoal(
    allocator: Allocator,
    io: std.Io,
    node_dir: []const u8,
    agent: []const u8,
    workflow_or_goal: []const u8,
) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var substrate = try openNodeSubstrate(a, io, node_dir);
    defer substrate.deinit();
    const workflow = try cancelCore(a, &substrate, agent, workflow_or_goal);
    const line = try std.fmt.allocPrint(a, "✓ workflow cancelled · {s}\n", .{workflow});
    try writeStdout(io, line);
}

pub fn retire(allocator: Allocator, io: std.Io, node_dir: []const u8, agent: []const u8) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var substrate = try openNodeSubstrate(a, io, node_dir);
    defer substrate.deinit();
    try retireCore(a, &substrate, agent);
    const line = try std.fmt.allocPrint(a, "✓ agent retired · {s}\n", .{agent});
    try writeStdout(io, line);
}

pub fn inspect(
    allocator: Allocator,
    io: std.Io,
    node_dir: []const u8,
    agent: []const u8,
    json_out: bool,
) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var substrate = try openNodeSubstrate(a, io, node_dir);
    defer substrate.deinit();
    const view = try inspectCore(a, &substrate, agent);
    const line = if (json_out)
        try std.fmt.allocPrint(
            a,
            "{{\"agent\":\"{s}\",\"status\":\"{s}\",\"snapshot\":\"{s}\",\"seq\":{d},\"workflow\":\"{s}\",\"result_digest\":\"{s}\",\"goals\":{d},\"beats\":{d},\"firings\":{{\"committed\":{d},\"cancelled\":{d}}}}}\n",
            .{ view.agent, view.status, view.snapshot_id, view.snapshot_seq, view.workflow, view.result_digest, view.goals, view.beats, view.committed, view.cancelled },
        )
    else
        try std.fmt.allocPrint(
            a,
            "agent {s} · {s} · snapshot {s} (seq {d}) · {d} goals · {d} grounded beats\n",
            .{ view.agent, view.status, view.snapshot_id, view.snapshot_seq, view.goals, view.beats },
        );
    try writeStdout(io, line);
}

fn writeStdout(io: std.Io, bytes: []const u8) !void {
    var buffer: [1024]u8 = undefined;
    var writer = std.Io.File.stdout().writerStreaming(io, &buffer);
    try writer.interface.writeAll(bytes);
    try writer.interface.flush();
}
