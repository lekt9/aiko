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

const Allocator = std.mem.Allocator;

pub const MANIFEST_SCHEMA = "neuron.agent-manifest/v1";
pub const SNAPSHOT_SCHEMA = "neuron.agent-snapshot/v1";
pub const ACTIVE_SCHEMA = "neuron.agent-active/v1";
pub const GOAL_SCHEMA = "neuron.agent-goal/v1";
pub const RESULT_SCHEMA = "neuron.agent-result/v1";
pub const VERDICT_SCHEMA = "neuron.agent-verdict/v1";
pub const CONTEXT_SCHEMA = "neuron.agent-context/v1";

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
            if (self.expected_digest) |expected| {
                if (!std.mem.eql(u8, &pinned.digest, &expected)) return .{
                    .control = .{ .terminate = self.terminate_alt },
                    .effects = self.effects_alt,
                    .evidence = self.evidence,
                };
            }
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

const SnapshotView = struct {
    id: []const u8,
    seq: usize,
    status: []const u8,
    workflow: []const u8,
    result_digest: []const u8,
};

fn loadActiveSnapshot(a: Allocator, substrate: *substrate_mod.Substrate, agent: []const u8) !SnapshotView {
    const active_id = try agentPath(a, agent, "active");
    const active = substrate.artifacts.get(active_id) orelse return error.CorruptAgentState;
    const snapshot = substrate.artifacts.get(active.bytes) orelse return error.CorruptAgentState;
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, a, snapshot.bytes, .{}) catch
        return error.CorruptAgentState;
    const seq = parsed.object.get("seq") orelse return error.CorruptAgentState;
    const status = parsed.object.get("status") orelse return error.CorruptAgentState;
    return .{
        .id = active.bytes,
        .seq = @intCast(seq.integer),
        .status = status.string,
        .workflow = if (parsed.object.get("workflow")) |value| value.string else "",
        .result_digest = if (parsed.object.get("result_digest")) |value| value.string else "",
    };
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

pub fn workflowId(a: Allocator, agent: []const u8, goal: []const u8) ![]u8 {
    const digest_hex = std.fmt.bytesToHex(types.digest(goal), .lower);
    return std.fmt.allocPrint(a, "agent/{s}/goal/{s}", .{ agent, digest_hex[0..16] });
}

/// Drive one typed goal to settlement through the composed stage network.
/// Deterministic reference profile: the worker resolves the goal to
/// `sha256("resolve:" ++ goal)`; the verifier recomputes it independently and
/// compares digests through pinned reads, never through the producer's claim.
pub fn runGoalCore(
    a: Allocator,
    substrate: *substrate_mod.Substrate,
    agent: []const u8,
    goal: []const u8,
    budget: usize,
) !RunResult {
    if (!validAgentId(agent)) return error.InvalidAgentId;
    if (goal.len == 0) return error.EmptyGoal;
    const manifest_id = try agentPath(a, agent, "manifest");
    if (!substrate.artifacts.contains(manifest_id)) return error.AgentNotInitialized;
    const current = try loadActiveSnapshot(a, substrate, agent);
    if (std.mem.eql(u8, current.status, "retired")) return error.AgentRetired;

    const goal_digest = types.digest(goal);
    const goal_hex = std.fmt.bytesToHex(goal_digest, .lower);
    const short = goal_hex[0..16];
    const workflow = try std.fmt.allocPrint(a, "agent/{s}/goal/{s}", .{ agent, short });
    const intake_firing = try std.fmt.allocPrint(a, "{s}/intake", .{workflow});
    if (substrate.firings.get(intake_firing)) |record| {
        if (record.status == .cancelled) return error.WorkflowCancelled;
    }

    const goal_id = try std.fmt.allocPrint(a, "agents/{s}/goals/{s}", .{ agent, short });
    const result_id = try std.fmt.allocPrint(a, "agents/{s}/work/{s}/result", .{ agent, short });
    const verdict_id = try std.fmt.allocPrint(a, "agents/{s}/work/{s}/verdict", .{ agent, short });
    const active_id = try agentPath(a, agent, "active");
    const context_prefix = try agentPath(a, agent, "context/");

    const resolved = try std.fmt.allocPrint(a, "resolve:{s}", .{goal});
    const result_digest = types.digest(resolved);
    const result_hex = std.fmt.bytesToHex(result_digest, .lower);

    const goal_bytes = try std.json.Stringify.valueAlloc(a, .{
        .schema = GOAL_SCHEMA,
        .agent = agent,
        .workflow = workflow,
        .goal = goal,
    }, .{});
    const result_bytes = try std.json.Stringify.valueAlloc(a, .{
        .schema = RESULT_SCHEMA,
        .workflow = workflow,
        .goal_digest = goal_hex[0..],
        .result_digest = result_hex[0..],
    }, .{});
    const verdict_ok_bytes = try std.json.Stringify.valueAlloc(a, .{
        .schema = VERDICT_SCHEMA,
        .workflow = workflow,
        .ok = true,
        .result_digest = result_hex[0..],
    }, .{});
    const verdict_bad_bytes = try std.json.Stringify.valueAlloc(a, .{
        .schema = VERDICT_SCHEMA,
        .workflow = workflow,
        .ok = false,
        .result_digest = "",
    }, .{});

    // Canonical reuse (SMP-12): an identical settled goal returns the
    // recorded result and commits nothing new — replay without duplicate
    // effects, decided by verdict content identity rather than resemblance.
    if (substrate.artifacts.get(verdict_id)) |verdict| {
        if (!std.mem.eql(u8, &verdict.digest, &types.digest(verdict_ok_bytes)))
            return error.WorkflowFailedPreviously;
        return .{
            .status = .replayed,
            .workflow = workflow,
            .goal_digest = goal_hex,
            .result_digest = result_hex,
            .snapshot_id = current.id,
            .snapshot_seq = current.seq,
            .beats = countPrefix(substrate, context_prefix),
            .steps = 0,
            .pending = 0,
        };
    }

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
    const worker_effects = try a.alloc(types.Effect, 1);
    worker_effects[0] = .{ .write = .{
        .id = result_id,
        .schema = RESULT_SCHEMA,
        .bytes = result_bytes,
        .expected_prior = if (substrate.artifacts.get(result_id)) |prior| prior.digest else null,
    } };
    const verifier_ok_effects = try a.alloc(types.Effect, 1);
    verifier_ok_effects[0] = .{ .write = .{ .id = verdict_id, .schema = VERDICT_SCHEMA, .bytes = verdict_ok_bytes } };
    const verifier_bad_effects = try a.alloc(types.Effect, 1);
    verifier_bad_effects[0] = .{ .write = .{ .id = verdict_id, .schema = VERDICT_SCHEMA, .bytes = verdict_bad_bytes } };
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

    const goal_source = try a.alloc([]const u8, 1);
    goal_source[0] = goal_id;
    const result_source = try a.alloc([]const u8, 1);
    result_source[0] = result_id;
    const verdict_source = try a.alloc([]const u8, 1);
    verdict_source[0] = verdict_id;
    const intake_source = try a.alloc([]const u8, 2);
    intake_source[0] = "stimulus";
    intake_source[1] = active_id;

    const intake: StageNeuron = .{
        .effects = intake_effects,
        .evidence = try singleEvidence(a, "typed goal normalized into a durable goal artifact", "goal-intake", intake_source),
        .terminate = "accepted",
    };
    const worker: StageNeuron = .{
        .wake_id = goal_id,
        .effects = worker_effects,
        .evidence = try singleEvidence(a, "goal resolved deterministically from the pinned goal artifact", "sha256-resolve", goal_source),
        .terminate = "worked",
    };
    const verifier: StageNeuron = .{
        .wake_id = result_id,
        .expected_digest = types.digest(result_bytes),
        .effects = verifier_ok_effects,
        .effects_alt = verifier_bad_effects,
        .evidence = try singleEvidence(a, "result independently recomputed and compared by content digest", "independent-digest-compare", result_source),
        .terminate = "verified",
        .terminate_alt = "rejected",
    };
    const settler: StageNeuron = .{
        .wake_id = verdict_id,
        .expected_digest = types.digest(verdict_ok_bytes),
        .effects = settler_ok_effects,
        .effects_alt = settler_bad_effects,
        .evidence = try singleEvidence(a, "verified verdict advanced the active snapshot by compare-and-swap", "cas-snapshot-advance", verdict_source),
        .terminate = "settled",
        .terminate_alt = "failed",
    };
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
    try scheduler.register(neuron_mod.bind(StageNeuron, &worker, worker_ref, "1.0.0"));
    try scheduler.register(neuron_mod.bind(StageNeuron, &verifier, verifier_ref, "1.0.0"));
    try scheduler.register(neuron_mod.bind(StageNeuron, &settler, settler_ref, "1.0.0"));
    try scheduler.register(neuron_mod.bind(GrounderNeuron, &grounder, grounder_ref, "1.0.0"));

    var pump = pump_mod.Pump.init(a, &scheduler);
    defer pump.deinit();
    pump.max_steps = budget;
    pump.firing_prefix = try std.fmt.allocPrint(a, "{s}/step", .{workflow});
    // The hook: every committed firing's durable settlement event re-fires
    // the grounder, so context accrues from real settlements, iteratively,
    // for the whole run — not from a privileged host observer.
    try pump.subscribe("neuron.firing-settled/v1", grounder_ref, try agentCaps(a, agent, "context/"), &.{});

    const intake_caps = try agentCaps(a, agent, "goals/");
    const work_caps = try agentCaps(a, agent, "work/");
    const settle_caps = try agentCaps(a, agent, "");

    var steps: usize = 0;
    var quiescent = true;
    // Park the downstream stages as waiters on their typed predicates. If a
    // prior interrupted attempt already produced an upstream artifact, the
    // waiter wakes immediately and the workflow resumes instead of forking.
    const parks = [_]struct { ref: []const u8, caps: caps_mod.Caps, tag: []const u8 }{
        .{ .ref = settler_ref, .caps = settle_caps, .tag = "park-settler" },
        .{ .ref = verifier_ref, .caps = work_caps, .tag = "park-verifier" },
        .{ .ref = worker_ref, .caps = work_caps, .tag = "park-worker" },
    };
    for (parks) |park| {
        const outcome = try pump.run(park.ref, .{
            .firing_id = try std.fmt.allocPrint(a, "{s}/{s}", .{ workflow, park.tag }),
            .receptor_schema = "neuron.agent-park/v1",
        }, park.caps);
        steps += outcome.steps;
        quiescent = quiescent and outcome.quiescent;
    }

    // Normalize the goal into the typed receptor stimulus, grounded in the
    // reconstructed context: the active pointer and snapshot are pinned by
    // digest so intake's evidence cites the state it actually resumed from.
    const messages = try a.alloc(types.Message, 1);
    messages[0] = .{
        .to = try std.fmt.allocPrint(a, "neuron/{s}", .{intake_ref}),
        .schema = GOAL_SCHEMA,
        .payload = goal_bytes,
        .durable = false,
    };
    const snapshot_artifact = substrate.artifacts.get(current.id) orelse return error.CorruptAgentState;
    const permitted = try a.alloc([]const u8, 2);
    permitted[0] = active_id;
    permitted[1] = current.id;
    const reads = try a.alloc(types.ArtifactRef, 2);
    reads[0] = .{ .id = active_id, .digest = active_artifact.digest };
    reads[1] = .{ .id = current.id, .digest = snapshot_artifact.digest };

    const outcome = try pump.run(intake_ref, .{
        .firing_id = intake_firing,
        .receptor_schema = GOAL_SCHEMA,
        .permitted_reads = permitted,
        .reads = reads,
        .messages = messages,
    }, intake_caps);
    steps += outcome.steps;
    quiescent = quiescent and outcome.quiescent;
    if (!quiescent) return error.BudgetExhausted;

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
        .pending = outcome.pending,
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
    json_out: bool,
) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var substrate = try openNodeSubstrate(a, io, node_dir);
    defer substrate.deinit();
    const result = try runGoalCore(a, &substrate, agent, goal, budget);
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
    var writer = std.Io.File.stdout().writer(io, &buffer);
    try writer.interface.writeAll(bytes);
    try writer.interface.flush();
}
