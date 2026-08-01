// Invalidation-driven re-derivation (ROADMAP R10). `telemetry stale` already
// answers *which* derivations rest on a source that moved; this is the step
// that acts on that answer, and the only step in the tree that is allowed to.
//
// Detection stays a read (§28.3). Action is three outcomes and never more,
// because there are exactly three things a stale derivation can be:
//
//   1. mechanically re-derivable — re-fire it under a new firing id;
//   2. not mechanically settleable — open an agent, which is what an agent is
//      for ("not every neuron is a task; every neuron that cannot settle
//      mechanically is");
//   3. already across an external boundary — never re-fire, ever. Emit a
//      typed compensation gap instead and leave the repair to a human or an
//      agent. Re-firing a "notify 35 workers" step after an amendment
//      re-messages the 31 who did not change and still fails to tell the 4
//      who did, which is strictly worse than reporting the gap.
//
// Case 3 is the reason this command exists. `redrivable == false` because of
// an `outbox/` send is not a degraded case 1; it is a different obligation.

const std = @import("std");
const types = @import("types.zig");
const substrate_mod = @import("substrate.zig");
const runtime_mod = @import("runtime.zig");
const agent_ops = @import("agent_ops.zig");
const limb_ops = @import("limb_ops.zig");

const Allocator = std.mem.Allocator;

pub const VERB = "redrive";

pub const REPORT_SCHEMA = "neuron.redrive/v1";
pub const ACTION_SCHEMA = "neuron.redrive-action/v1";
pub const GAP_SCHEMA = "neuron.compensation-gap/v1";
pub const GENERATION_SCHEMA = "neuron.redrive-generation/v1";
pub const ESCALATION_SCHEMA = "neuron.redrive-escalation/v1";

pub const ACTION_PREFIX = "artifact/redrive/actions/";
pub const GAP_PREFIX = "artifact/redrive/gaps/";
pub const GENERATION_ID = "artifact/redrive/generation";
/// Every artifact this command can write. A stale row inside it is our own
/// output, and re-deriving our own output is the cascade R10 warns about.
pub const SELF_PREFIX = "artifact/redrive/";

/// Cascade bound. A re-derivation settles its goal, which advances the agent's
/// active snapshot, which invalidates the next derivation that cited it — so a
/// pass legitimately creates work for the next pass. Determinism guarantees
/// that sequence terminates; the counter is what makes the guarantee *checked*
/// rather than assumed, and it fails closed on a producer that lied about being
/// deterministic. At the bound, re-firing stops and the remaining rows escalate
/// to an agent, which is the only safe direction: an unfinished cascade handed
/// to a human is recoverable, an unbounded one is not.
pub const MAX_GENERATIONS: u64 = 8;

pub const Error = error{
    /// The state directory holds no journal, so there is nothing to project.
    NoJournal,
};

/// What a stale row is, once the topology has been asked about it.
pub const Case = enum {
    /// Mechanically re-derivable under a determinism claim.
    redrive,
    /// Cannot settle mechanically. An agent is opened.
    escalate,
    /// Already crossed an external boundary. Never re-fired.
    compensate,
};

const Verdict = struct {
    case: Case,
    /// Why this row landed in this case. Written into the durable record: an
    /// operator reading a compensation gap six months later needs the reason,
    /// not just the classification.
    reason: []const u8,
    /// Agent and goal recovered from the producing firing, when the producer
    /// is a re-derivable agent-goal derivation. Empty otherwise.
    agent: []const u8 = "",
    goal: []const u8 = "",
};

const Outcome = struct {
    row: limb_ops.StaleRow,
    verdict: Verdict,
    /// Durable id this row produced, empty under `--dry-run`.
    record: []const u8 = "",
    /// Case 1 only: whether the re-derivation actually moved the product.
    /// A deterministic producer that returns the same bytes has reached the
    /// fixpoint, which is the honest terminating outcome, not a failure.
    changed: bool = false,
    new_workflow: []const u8 = "",
};

pub fn dispatch(allocator: Allocator, io: std.Io, args: []const []const u8) !bool {
    if (args.len == 0 or !std.mem.eql(u8, args[0], VERB)) return false;
    if (args.len < 2) return error.MissingStateDir;
    const state_dir = args[1];
    var dry_run = false;
    var json_out = false;
    for (args[2..]) |arg| {
        if (std.mem.eql(u8, arg, "--dry-run")) {
            dry_run = true;
        } else if (std.mem.eql(u8, arg, "--json")) {
            json_out = true;
        } else return error.UnknownRedriveOption;
    }
    try run(allocator, io, state_dir, dry_run, json_out);
    return true;
}

pub fn run(
    allocator: Allocator,
    io: std.Io,
    state_dir: []const u8,
    dry_run: bool,
    json_out: bool,
) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    // The journal is read before the substrate is opened for writing: the
    // rows we act on must be the rows as they stood at the start of the pass,
    // or a re-derivation committed halfway through would be re-classified
    // against its own output.
    const journal = limb_ops.readJournal(a, io, state_dir) catch return Error.NoJournal;
    const rows = try limb_ops.collectStale(a, journal);

    var substrate = try substrate_mod.Substrate.initDir(allocator, io, std.Io.Dir.cwd(), state_dir);
    defer substrate.deinit();

    const generation = readGeneration(&substrate);
    const bounded = generation >= MAX_GENERATIONS;
    const offset = journalOffset(&substrate);

    var outcomes: std.ArrayList(Outcome) = .empty;
    var seen = std.StringHashMap(void).init(a);
    for (rows) |row| {
        // Our own records never re-derive: they are the report on a
        // derivation, not a derivation.
        if (std.mem.startsWith(u8, row.artifact, SELF_PREFIX)) continue;
        // One derivation edge, once per pass. The same artifact can be stale
        // against several sources; acting on each would re-fire the same
        // producer several times for one invalidation.
        const key = try std.fmt.allocPrint(a, "{s}\n{s}", .{ row.artifact, row.produced_by });
        if (seen.contains(key)) continue;
        try seen.put(key, {});

        const verdict = try classify(a, io, &substrate, row, bounded);
        var outcome: Outcome = .{ .row = row, .verdict = verdict };
        if (!dry_run) try act(a, io, &substrate, generation, &outcome);
        try outcomes.append(a, outcome);
    }

    // The generation advances only when the pass actually committed something.
    // A pass that re-classified the same facts and settled every action as a
    // replay has not consumed a generation, and charging it one would make the
    // bound expire on inspection rather than on work.
    if (!dry_run and committedSince(&substrate, offset)) try advanceGeneration(a, &substrate, generation);

    try report(io, outcomes.items, generation, bounded, dry_run, json_out);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

fn classify(
    a: Allocator,
    io: std.Io,
    substrate: *substrate_mod.Substrate,
    row: limb_ops.StaleRow,
    bounded: bool,
) !Verdict {
    // The boundary question is settled before anything else runs, and settled
    // by a function that touches neither the topology nor the clock — because
    // every branch below this point can end in a re-fire, and a row that
    // already crossed an external boundary may never reach one of them. Keeping
    // it separate is what makes "never twice" checkable rather than a property
    // of statement order that a later edit can quietly reverse.
    if (boundaryVerdict(row)) |verdict| return verdict;
    if (bounded) return .{
        .case = .escalate,
        .reason = "generation bound reached; the cascade is handed over rather than continued",
    };

    // Which producers can be re-derived at all. An agent-goal derivation can:
    // its goal is a durable artifact and the work identity is a digest over
    // (goal, topology pin), so re-running it against moved sources produces a
    // new firing id by construction rather than by a mutation. Nothing else in
    // the tree retains enough to recompute f, and inventing bytes for an
    // artifact we cannot recompute would be worse than escalating.
    const producer = parseGoalFiring(row.produced_by) orelse return .{
        .case = .escalate,
        .reason = "producer is not a re-derivable derivation: the journal does not retain what would recompute it",
    };
    const goal_id = try std.fmt.allocPrint(a, "agents/{s}/goals/{s}", .{ producer.agent, producer.short });
    const goal_artifact = substrate.artifacts.get(goal_id) orelse return .{
        .case = .escalate,
        .reason = "the producing goal artifact is gone, so the derivation's input can no longer be recovered",
    };
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, a, goal_artifact.bytes, .{}) catch return .{
        .case = .escalate,
        .reason = "the producing goal artifact does not parse",
    };
    const goal = if (parsed == .object) switch (parsed.object.get("goal") orelse std.json.Value{ .null = {} }) {
        .string => |s| s,
        else => "",
    } else "";
    if (goal.len == 0) return .{
        .case = .escalate,
        .reason = "the producing goal artifact names no goal",
    };

    // The termination proof. Resolution reads topology and pins
    // implementations; it invokes nothing.
    const plan = agent_ops.resolveWorkPlan(a, io, substrate, producer.agent, null) catch |err| return .{
        .case = .escalate,
        .reason = try std.fmt.allocPrint(a, "the producing boundary could not be resolved: {s}", .{@errorName(err)}),
        .agent = producer.agent,
        .goal = goal,
    };
    // An effector attached *now* means re-running this goal could queue a
    // consequential command, whatever the original firing did. The check is on
    // the topology as it stands, not as it stood: a boundary that was harmless
    // at derivation time and is consequential today must not be re-crossed.
    if (plan.effector != null) return .{
        .case = .escalate,
        .reason = "an effector is attached, so re-running this goal could cross an external boundary",
        .agent = producer.agent,
        .goal = goal,
    };
    for (plan.hops) |hop| {
        if (!hop.manifest.invocation.deterministic) return .{
            .case = .escalate,
            .reason = "a hop of the producing chain does not claim determinism, so re-derivation has no termination proof",
            .agent = producer.agent,
            .goal = goal,
        };
    }
    return .{
        .case = .redrive,
        .reason = if (plan.hops.len == 0)
            "producer is the boundary-free reference resolution, which is deterministic by construction"
        else
            "every hop of the producing chain declares determinism, which bounds the cascade",
        .agent = producer.agent,
        .goal = goal,
    };
}

/// The refusal, on its own: whether this row is disqualified from re-firing by
/// what its producing firing already did. Null means "not disqualified here",
/// never "safe" — the remaining gates still apply.
fn boundaryVerdict(row: limb_ops.StaleRow) ?Verdict {
    if (row.crossed.len > 0) return .{
        .case = .compensate,
        .reason = "the producing firing sent to an outbox address; re-firing would cross an external boundary a second time",
    };
    if (!row.redrivable) return .{
        .case = .escalate,
        // A folded firing kept no messages, so "did it cross a boundary" has
        // no answer here. Unknown is not the same as no, and the conservative
        // reading of unknown is a human, not a re-fire (§28.4).
        .reason = "whether the producing firing crossed a boundary is unknown; compaction did not retain its messages",
    };
    return null;
}

const GoalFiring = struct { agent: []const u8, short: []const u8 };

/// `agent/<agent>/goal/<short>/<stage>` → its parts. Anything else is not an
/// agent-goal derivation and gets no re-derivation.
fn parseGoalFiring(firing_id: []const u8) ?GoalFiring {
    if (!std.mem.startsWith(u8, firing_id, "agent/")) return null;
    const rest = firing_id["agent/".len..];
    const agent_end = std.mem.indexOfScalar(u8, rest, '/') orelse return null;
    const agent = rest[0..agent_end];
    const after = rest[agent_end + 1 ..];
    if (!std.mem.startsWith(u8, after, "goal/")) return null;
    const tail = after["goal/".len..];
    const short_end = std.mem.indexOfScalar(u8, tail, '/') orelse tail.len;
    if (short_end == 0) return null;
    return .{ .agent = agent, .short = tail[0..short_end] };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

fn act(
    a: Allocator,
    io: std.Io,
    substrate: *substrate_mod.Substrate,
    generation: u64,
    outcome: *Outcome,
) !void {
    switch (outcome.verdict.case) {
        .redrive => try actRedrive(a, io, substrate, generation, outcome),
        .escalate => try actEscalate(a, substrate, generation, outcome),
        .compensate => try actCompensate(a, io, substrate, generation, outcome),
    }
}

/// Case 1. Re-run the derivation against the moved sources.
///
/// The old firing is not touched. It cannot be: `now_ms` is `0` and the work
/// identity is `sha256(goal ++ topology pin)`, so re-derivation under moved
/// inputs lands on a different id for free and the superseded result stays in
/// the journal as history (§28.1). Nothing here rewrites a record.
fn actRedrive(
    a: Allocator,
    io: std.Io,
    substrate: *substrate_mod.Substrate,
    generation: u64,
    outcome: *Outcome,
) !void {
    const before = substrate.artifacts.get(outcome.row.artifact);
    const before_hex = if (before) |artifact|
        try a.dupe(u8, &std.fmt.bytesToHex(artifact.digest, .lower))
    else
        "";

    const result = agent_ops.runGoalCore(
        a,
        io,
        substrate,
        outcome.verdict.agent,
        outcome.verdict.goal,
        64,
        null,
    ) catch |err| {
        // A refusal from the goal path is a refusal, not a reason to try
        // harder: it becomes an escalation with the error named.
        outcome.verdict = .{
            .case = .escalate,
            .reason = try std.fmt.allocPrint(a, "re-derivation refused by the goal path: {s}", .{@errorName(err)}),
            .agent = outcome.verdict.agent,
            .goal = outcome.verdict.goal,
        };
        return actEscalate(a, substrate, generation, outcome);
    };

    outcome.new_workflow = try a.dupe(u8, result.workflow);
    outcome.changed = result.status == .settled;

    const record = try std.json.Stringify.valueAlloc(a, .{
        .schema = ACTION_SCHEMA,
        .generation = generation + 1,
        .artifact = outcome.row.artifact,
        .stale_source = outcome.row.stale_source,
        .derived_at = outcome.row.derived_at,
        .source_moved_at = outcome.row.source_moved_at,
        .superseded_by = outcome.row.produced_by,
        .agent = outcome.verdict.agent,
        .redriven_workflow = result.workflow,
        .status = @tagName(result.status),
        .product_before = before_hex,
        .product_after = result.result_digest[0..],
        .changed = outcome.changed,
        .reason = outcome.verdict.reason,
    }, .{});
    const identity = try std.fmt.allocPrint(a, "redrive-action\n{s}\n{s}\n{s}\n{d}\n{d}\n{s}\n{s}", .{
        outcome.row.artifact,
        outcome.row.produced_by,
        outcome.row.stale_source,
        outcome.row.derived_at,
        outcome.row.source_moved_at,
        before_hex,
        result.result_digest[0..],
    });
    outcome.record = try commit(a, substrate, ACTION_PREFIX, ACTION_SCHEMA, generation, identity, record, .{
        .claim = "stale derivation re-fired against its moved sources under a new firing id",
        .method = "journal staleness projection (§28.3) + deterministic re-derivation (R10)",
    });
}

/// Case 2. Open an agent.
///
/// R10 is explicit that this needs no new machinery: an agent is three writes,
/// so `initAgentCore` plus one goal artifact is the whole escalation. The
/// agent is not run — opening the task is the action, and resolving it is a
/// judgement this command is not entitled to make.
fn actEscalate(
    a: Allocator,
    substrate: *substrate_mod.Substrate,
    generation: u64,
    outcome: *Outcome,
) !void {
    const short = try shortDigest(a, outcome.row);
    const agent = try std.fmt.allocPrint(a, "redrive-{s}", .{short});
    agent_ops.initAgentCore(a, substrate, agent) catch |err| switch (err) {
        // A second pass over the same unresolved row must not fail the pass.
        error.AgentAlreadyInitialized => {},
        else => return err,
    };

    const goal_text = try std.fmt.allocPrint(
        a,
        "re-derive {s}: it was derived from {s}, which has since moved, and cannot settle mechanically ({s})",
        .{ outcome.row.artifact, outcome.row.stale_source, outcome.verdict.reason },
    );
    const goal_id = try std.fmt.allocPrint(a, "agents/{s}/goals/{s}", .{ agent, short });
    if (substrate.artifacts.contains(goal_id)) {
        outcome.record = goal_id;
        return;
    }
    const goal_bytes = try std.json.Stringify.valueAlloc(a, .{
        .schema = agent_ops.GOAL_SCHEMA,
        .agent = agent,
        .workflow = try agent_ops.workflowId(a, agent, goal_text),
        .goal = goal_text,
        .escalation = ESCALATION_SCHEMA,
        .generation = generation + 1,
        .artifact = outcome.row.artifact,
        .stale_source = outcome.row.stale_source,
        .produced_by = outcome.row.produced_by,
        .derived_at = outcome.row.derived_at,
        .source_moved_at = outcome.row.source_moved_at,
        .reason = outcome.verdict.reason,
    }, .{});

    var fx = [_]types.Effect{
        .{ .write = .{ .id = goal_id, .schema = agent_ops.GOAL_SCHEMA, .bytes = goal_bytes } },
    };
    const runtime: runtime_mod.Runtime = .{ .substrate = substrate };
    _ = runtime.execute(.{
        .firing_id = try std.fmt.allocPrint(a, "redrive/g{d}/escalate/{s}", .{ generation + 1, short }),
        .receptor_schema = ESCALATION_SCHEMA,
    }, .{
        .allow_write = true,
        .write_prefix = try std.fmt.allocPrint(a, "agents/{s}/goals/", .{agent}),
    }, .{
        .control = .{ .terminate = "escalated" },
        .effects = &fx,
        .evidence = try harnessEvidence(
            a,
            "a derivation that cannot settle mechanically was opened as an agent goal",
            "journal staleness projection (§28.3) + agent genesis (R10)",
        ),
    }) catch |err| switch (err) {
        error.FiringAlreadySettled, error.FiringMismatch => {},
        else => return err,
    };
    outcome.record = goal_id;
}

/// Case 3. The firing already told the world.
///
/// No effect here reaches outside the substrate, and that is the whole point:
/// the gap is a record, not a repair. What it must carry is enough for a human
/// or an agent to compose the *compensating* message — which is not the
/// original message again, but the difference between what was announced and
/// what is now true.
fn actCompensate(
    a: Allocator,
    io: std.Io,
    substrate: *substrate_mod.Substrate,
    generation: u64,
    outcome: *Outcome,
) !void {
    const row = outcome.row;
    const journal = try limb_ops.readJournal(a, io, journalDir(substrate));

    const superseded = substrate.artifacts.get(row.artifact);
    const superseded_hex = if (superseded) |artifact|
        try a.dupe(u8, &std.fmt.bytesToHex(artifact.digest, .lower))
    else
        "";

    // The delta the compensation actually needs: the source as the crossed
    // firing read it, against the source as it stands now.
    const before = try limb_ops.artifactVersionAt(a, journal, row.stale_source, row.derived_at);
    const after = substrate.artifacts.get(row.stale_source);
    const before_hex = if (before) |version|
        try a.dupe(u8, &std.fmt.bytesToHex(version.digest, .lower))
    else
        "";
    const after_hex = if (after) |artifact|
        try a.dupe(u8, &std.fmt.bytesToHex(artifact.digest, .lower))
    else
        "";
    var first_diff: i64 = -1;
    if (before != null and after != null) {
        const x = before.?.bytes;
        const y = after.?.bytes;
        const n = @min(x.len, y.len);
        var i: usize = 0;
        while (i < n and x[i] == y[i]) : (i += 1) {}
        if (i < n or x.len != y.len) first_diff = @intCast(i);
    }

    // The re-derived product. Reported only when it can be computed without
    // crossing anything; otherwise reported *absent with a reason*, because a
    // fabricated "new product" on a compensation record is exactly the lie
    // that would get the wrong message sent (§28.4: degradation is reported,
    // never fabricated).
    var new_known = false;
    var new_hex: []const u8 = "";
    var new_reason: []const u8 = "re-derivation is unavailable without crossing the boundary this firing already crossed";
    if (parseGoalFiring(row.produced_by)) |producer| {
        const plan = agent_ops.resolveWorkPlan(a, io, substrate, producer.agent, null) catch null;
        if (plan) |resolved| if (resolved.hops.len == 0) {
            const goal_id = try std.fmt.allocPrint(a, "agents/{s}/goals/{s}", .{ producer.agent, producer.short });
            if (substrate.artifacts.get(goal_id)) |goal_artifact| {
                const parsed = std.json.parseFromSliceLeaky(std.json.Value, a, goal_artifact.bytes, .{}) catch null;
                if (parsed) |value| if (value == .object) {
                    if (value.object.get("goal")) |goal| if (goal == .string) {
                        // One owner for the reference profile (agent_ops), never a
                        // third hand-rolled copy here: a consumer that re-derives
                        // the formula keeps emitting the old digest the moment the
                        // profile changes.
                        new_hex = try agent_ops.referenceProductHex(a, goal.string);
                        // NOT `known`. No firing produced this and no verifier
                        // recomputed it — it is what the reference profile PREDICTS
                        // the new product would be, not a product that exists. The
                        // substrate grounds evidence in a firing; a durable record
                        // asserting a product no firing committed is exactly the
                        // fabrication the compensation path exists to avoid.
                        new_known = false;
                        new_reason = "predicted by the boundary-free reference profile; " ++
                            "no firing has produced it and no verifier has recomputed it";
                    };
                };
            }
        };
    }

    const record = try std.json.Stringify.valueAlloc(a, .{
        .schema = GAP_SCHEMA,
        .generation = generation + 1,
        .artifact = row.artifact,
        .produced_by = row.produced_by,
        .crossed = row.crossed,
        .superseded_product = .{
            .id = row.artifact,
            .digest = superseded_hex,
            .bytes = if (superseded) |artifact| artifact.bytes.len else 0,
        },
        .new_product = .{
            .known = new_known,
            .digest = new_hex,
            .reason = new_reason,
        },
        .stale_source = row.stale_source,
        .derived_at = row.derived_at,
        .source_moved_at = row.source_moved_at,
        .delta = .{
            .source = row.stale_source,
            .before = .{
                .known = before != null,
                .digest = before_hex,
                .bytes = if (before) |version| version.bytes.len else 0,
                .at = if (before) |version| version.at else 0,
            },
            .after = .{
                .known = after != null,
                .digest = after_hex,
                .bytes = if (after) |artifact| artifact.bytes.len else 0,
                .at = row.source_moved_at,
            },
            .identical = before != null and after != null and first_diff < 0,
            .first_differing_offset = first_diff,
        },
        .resolution = "manual-compensation-required",
        .refusal = outcome.verdict.reason,
    }, .{});

    const identity = try std.fmt.allocPrint(a, "compensation-gap\n{s}\n{s}\n{s}\n{s}\n{s}\n{s}", .{
        row.artifact,
        row.produced_by,
        row.crossed,
        row.stale_source,
        before_hex,
        after_hex,
    });
    outcome.record = try commit(a, substrate, GAP_PREFIX, GAP_SCHEMA, generation, identity, record, .{
        .claim = "a derivation that already crossed an external boundary went stale; the gap is recorded and the boundary is not re-crossed",
        .method = "journal staleness projection (§28.3) + compensation gap (R10 case 3)",
    });
}

// ---------------------------------------------------------------------------
// Durable plumbing
// ---------------------------------------------------------------------------

const Claim = struct { claim: []const u8, method: []const u8 };

/// One write, under a firing id that is a digest of the *facts* it records —
/// which derivation edge, and what the re-derivation found — and deliberately
/// not of the pass that observed them. New facts yield a new id for free (§28.1:
/// `now_ms` is 0, so identity is content), while a pass that finds nothing new
/// settles as a replay rather than as a second record. Folding the generation
/// counter into the identity would make every pass produce a fresh record for
/// an unchanged world, and a loop that always writes is a loop that never
/// terminates.
fn commit(
    a: Allocator,
    substrate: *substrate_mod.Substrate,
    comptime prefix: []const u8,
    schema: []const u8,
    generation: u64,
    identity: []const u8,
    record: []const u8,
    claim: Claim,
) ![]const u8 {
    const hex = std.fmt.bytesToHex(types.digest(identity), .lower);
    const id = try std.fmt.allocPrint(a, prefix ++ "{s}", .{hex[0..32]});
    if (substrate.artifacts.contains(id)) return id;
    var fx = [_]types.Effect{
        .{ .write = .{ .id = id, .schema = schema, .bytes = record } },
    };
    const runtime: runtime_mod.Runtime = .{ .substrate = substrate };
    _ = runtime.execute(.{
        .firing_id = try std.fmt.allocPrint(a, "redrive/g{d}/{s}", .{ generation + 1, hex[0..32] }),
        .receptor_schema = schema,
    }, .{
        .allow_write = true,
        .write_prefix = prefix,
    }, .{
        .control = .{ .terminate = "recorded" },
        .effects = &fx,
        .evidence = try harnessEvidence(a, claim.claim, claim.method),
    }) catch |err| switch (err) {
        error.FiringAlreadySettled, error.FiringMismatch => {},
        else => return err,
    };
    return id;
}

fn harnessEvidence(a: Allocator, claim: []const u8, method: []const u8) ![]types.Evidence {
    const sources = try a.alloc([]const u8, 1);
    sources[0] = "stimulus";
    const items = try a.alloc(types.Evidence, 1);
    items[0] = .{ .claim = claim, .method = method, .sources = sources };
    return items;
}

fn readGeneration(substrate: *const substrate_mod.Substrate) u64 {
    const artifact = substrate.artifacts.get(GENERATION_ID) orelse return 0;
    return std.fmt.parseInt(u64, std.mem.trim(u8, artifact.bytes, " \n"), 10) catch 0;
}

/// The counter advances once per acting pass, by compare-and-swap so two
/// concurrent passes cannot both claim the same generation.
fn advanceGeneration(a: Allocator, substrate: *substrate_mod.Substrate, generation: u64) !void {
    const next = try std.fmt.allocPrint(a, "{d}", .{generation + 1});
    var fx = [_]types.Effect{
        .{ .write = .{
            .id = GENERATION_ID,
            .schema = GENERATION_SCHEMA,
            .bytes = next,
            .expected_prior = if (substrate.artifacts.get(GENERATION_ID)) |prior| prior.digest else null,
        } },
    };
    const runtime: runtime_mod.Runtime = .{ .substrate = substrate };
    _ = runtime.execute(.{
        .firing_id = try std.fmt.allocPrint(a, "redrive/generation/{d}", .{generation + 1}),
        .receptor_schema = GENERATION_SCHEMA,
    }, .{
        .allow_write = true,
        .write_prefix = SELF_PREFIX,
    }, .{
        .control = .{ .terminate = "advanced" },
        .effects = &fx,
        .evidence = try harnessEvidence(
            a,
            "one re-derivation generation completed; the cascade bound advanced",
            "generation bound (R10 termination)",
        ),
    }) catch |err| switch (err) {
        error.FiringAlreadySettled, error.FiringMismatch => {},
        else => return err,
    };
}

/// The directory the open substrate journals into, recovered from its own
/// journal handle so the compensation path re-reads exactly the log the rows
/// came from rather than a path passed down through five frames.
fn journalDir(substrate: *const substrate_mod.Substrate) []const u8 {
    const journal = substrate.journal orelse return ".";
    return journal.sub_path;
}

fn journalOffset(substrate: *const substrate_mod.Substrate) u64 {
    const journal = substrate.journal orelse return 0;
    return journal.offset;
}

/// Whether this pass appended anything. The WAL is the only witness that can
/// answer it: an action that settled as a replay returns the id it would have
/// written, which is indistinguishable from a fresh write at the caller.
fn committedSince(substrate: *const substrate_mod.Substrate, offset: u64) bool {
    return journalOffset(substrate) != offset;
}

fn shortDigest(a: Allocator, row: limb_ops.StaleRow) ![]const u8 {
    const key = try std.fmt.allocPrint(a, "{s}\n{s}\n{s}", .{
        row.artifact,
        row.produced_by,
        row.stale_source,
    });
    const hex = std.fmt.bytesToHex(types.digest(key), .lower);
    return a.dupe(u8, hex[0..16]);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

fn report(
    io: std.Io,
    outcomes: []const Outcome,
    generation: u64,
    bounded: bool,
    dry_run: bool,
    json_out: bool,
) !void {
    var counts = [_]usize{ 0, 0, 0 };
    for (outcomes) |outcome| counts[@intFromEnum(outcome.verdict.case)] += 1;

    var out_buffer: [8192]u8 = undefined;
    var writer = std.Io.File.stdout().writerStreaming(io, &out_buffer);
    const w = &writer.interface;

    if (json_out) {
        try w.print(
            \\{{"schema":"{s}","generation":{d},"bounded":{},"dry_run":{},"stale":{d},"redriven":{d},"escalated":{d},"compensation_gaps":{d},"rows":[
        , .{ REPORT_SCHEMA, generation, bounded, dry_run, outcomes.len, counts[0], counts[1], counts[2] });
        for (outcomes, 0..) |outcome, i| {
            if (i != 0) try w.writeAll(",");
            try w.writeAll("{\"artifact\":");
            try std.json.Stringify.value(outcome.row.artifact, .{}, w);
            try w.writeAll(",\"stale_source\":");
            try std.json.Stringify.value(outcome.row.stale_source, .{}, w);
            try w.writeAll(",\"produced_by\":");
            try std.json.Stringify.value(outcome.row.produced_by, .{}, w);
            try w.writeAll(",\"crossed\":");
            try std.json.Stringify.value(outcome.row.crossed, .{}, w);
            try w.print(",\"case\":\"{s}\",\"reason\":", .{@tagName(outcome.verdict.case)});
            try std.json.Stringify.value(outcome.verdict.reason, .{}, w);
            try w.writeAll(",\"record\":");
            try std.json.Stringify.value(outcome.record, .{}, w);
            try w.writeAll(",\"redriven_workflow\":");
            try std.json.Stringify.value(outcome.new_workflow, .{}, w);
            try w.print(",\"changed\":{}}}", .{outcome.changed});
        }
        try w.writeAll("]}\n");
    } else {
        try w.print("generation {d}{s}{s}\n\n", .{
            generation,
            if (bounded) "  (bound reached: re-firing stopped)" else "",
            if (dry_run) "  (dry run: nothing committed)" else "",
        });
        try w.writeAll("case          stale_artifact                                     record\n");
        for (outcomes) |outcome| {
            try w.print("{s: <13} {s: <50} {s}\n", .{
                @tagName(outcome.verdict.case),
                outcome.row.artifact,
                outcome.record,
            });
        }
        try w.print(
            "\n{d} stale derivation(s): {d} redriven, {d} escalated, {d} compensation gap(s)\n",
            .{ outcomes.len, counts[0], counts[1], counts[2] },
        );
    }
    try w.flush();
}

test "a goal firing id yields its agent and workflow short" {
    const parsed = parseGoalFiring("agent/alpha/goal/a7937b64b8caa58f/intake").?;
    try std.testing.expectEqualStrings("alpha", parsed.agent);
    try std.testing.expectEqualStrings("a7937b64b8caa58f", parsed.short);
}

test "a non-goal firing id is not re-derivable" {
    try std.testing.expect(parseGoalFiring("interface/command/abc/def") == null);
    try std.testing.expect(parseGoalFiring("agent/alpha/init") == null);
    try std.testing.expect(parseGoalFiring("limb/notify") == null);
}

test "an outbox crossing is never classified as re-derivable" {
    // The one classification that may never regress: a row carrying an outbox
    // address is a compensation gap regardless of anything else about it —
    // including a producer that would otherwise be perfectly re-derivable.
    const crossed = boundaryVerdict(.{
        .artifact = "artifact/notice/dispatch",
        .stale_source = "artifact/roster/workers",
        .produced_by = "agent/alpha/goal/a7937b64b8caa58f/step/6",
        .derived_at = 1,
        .source_moved_at = 2,
        .redrivable = false,
        .from_snapshot = false,
        .crossed = "outbox/notify/workers",
    }).?;
    try std.testing.expectEqual(Case.compensate, crossed.case);

    // A folded firing kept no messages: unknown is not absent, and unknown
    // routes to a human rather than to a re-fire.
    const folded = boundaryVerdict(.{
        .artifact = "agents/alpha/goals/x",
        .stale_source = "agents/alpha/active",
        .produced_by = "agent/alpha/goal/x/intake",
        .derived_at = 1,
        .source_moved_at = 2,
        .redrivable = false,
        .from_snapshot = true,
        .crossed = "",
    }).?;
    try std.testing.expectEqual(Case.escalate, folded.case);

    try std.testing.expect(boundaryVerdict(.{
        .artifact = "agents/alpha/goals/x",
        .stale_source = "agents/alpha/active",
        .produced_by = "agent/alpha/goal/x/intake",
        .derived_at = 1,
        .source_moved_at = 2,
        .redrivable = true,
        .from_snapshot = false,
        .crossed = "",
    }) == null);
}
