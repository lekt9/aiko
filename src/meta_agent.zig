const std = @import("std");
const types = @import("types.zig");
const caps_mod = @import("caps.zig");
const neuron_mod = @import("neuron.zig");
const runtime_mod = @import("runtime.zig");
const substrate_mod = @import("substrate.zig");
const scheduler_mod = @import("scheduler.zig");
const topology_mod = @import("topology.zig");
const registry_mod = @import("registry.zig");
const observability = @import("observability.zig");
const limb_mod = @import("limb.zig");

const package_bytes = @embedFile("meta_agent_defaults");
const stimulus_sources = [_][]const u8{"stimulus"};
const stimulus_evidence = [_]types.Evidence{.{
    .claim = "the reference Neuron derived its decision from the current typed stimulus",
    .sources = &stimulus_sources,
    .method = "deterministic reference implementation",
}};

const agent_caps: caps_mod.Caps = .{
    .allow_write = true,
    .allow_send = true,
    .write_prefix = "agents/reference/",
    .send_prefix = "neuron/",
    .budget = .{
        .max_effects = 8,
        .max_writes = 4,
        .max_messages = 4,
        .max_spawns = 0,
        .max_bytes = 64 * 1024,
        .max_depth = 3,
    },
};

pub const Summary = struct {
    package_digest: types.Digest,
    final_snapshot_digest: types.Digest,
    trace_digest: types.Digest,
    admitted_without_authority: bool,
    normalized_and_planned: bool,
    parallel_workers: usize,
    join_settled: bool,
    false_proposal_rejected: bool,
    recovery_rerouted: bool,
    generated_limb_attached: bool,
    original_work_succeeded: bool,
    duplicate_effects_skipped: usize,
    stale_cas_rejected: bool,
    replayed_firings: usize,
    committed_firings: usize,
    limb_revoked: bool,
    artifacts_collected: usize,
    audit_roots_readable: bool,
};

const FixedNeuron = struct {
    control: types.Control,
    effects: []const types.Effect = &.{},

    pub fn fire(self: *const FixedNeuron, _: types.Stimulus, _: caps_mod.Caps) !types.Decision {
        return .{
            .control = self.control,
            .effects = self.effects,
            .evidence = &stimulus_evidence,
        };
    }
};

const ParallelBarrier = struct {
    arrived: std.atomic.Value(u8) = .init(0),
    overlapped: std.atomic.Value(u8) = .init(0),
};

const ParallelWorker = struct {
    barrier: *ParallelBarrier,
    effects: []const types.Effect,

    pub fn fire(self: *const ParallelWorker, _: types.Stimulus, _: caps_mod.Caps) !types.Decision {
        _ = self.barrier.arrived.fetchAdd(1, .acq_rel);
        while (self.barrier.arrived.load(.acquire) < 2) std.atomic.spinLoopHint();
        _ = self.barrier.overlapped.fetchAdd(1, .acq_rel);
        return .{
            .control = .{ .terminate = "work-complete" },
            .effects = self.effects,
            .evidence = &stimulus_evidence,
        };
    }
};

const FireJob = struct {
    neuron: neuron_mod.Neuron,
    stimulus: types.Stimulus,
    caps: caps_mod.Caps,
    decision: ?types.Decision = null,
    failure: ?anyerror = null,

    fn run(self: *FireJob) void {
        self.decision = self.neuron.fire(self.stimulus, self.caps) catch |err| {
            self.failure = err;
            return;
        };
    }
};

const IndependentVerifier = struct {
    expected_false_digest: types.Digest,

    pub fn fire(self: *const IndependentVerifier, stimulus: types.Stimulus, _: caps_mod.Caps) !types.Decision {
        if (stimulus.reads.len != 1 or
            !std.mem.eql(u8, &stimulus.reads[0].digest, &self.expected_false_digest))
            return error.VerifierInputMismatch;
        const read_sources = [_][]const u8{"agents/reference/work/a"};
        const evidence = [_]types.Evidence{.{
            .claim = "the independently pinned proposal is plausible but false",
            .sources = &read_sources,
            .method = "digest comparison against the verifier fixture",
        }};
        const effects = [_]types.Effect{.{ .send = .{
            .to = "neuron/recovery",
            .schema = "typed-neuron.failure/v1",
            .payload = "false-proposal",
        } }};
        return .{
            .control = .{ .terminate = "red" },
            .effects = &effects,
            .evidence = &evidence,
        };
    }
};

const PackageJudge = struct {
    expected_digest: types.Digest,

    pub fn fire(self: *const PackageJudge, stimulus: types.Stimulus, _: caps_mod.Caps) !types.Decision {
        if (stimulus.reads.len != 1 or
            !std.mem.eql(u8, &stimulus.reads[0].digest, &self.expected_digest))
            return error.PackageDigestMismatch;
        const read_sources = [_][]const u8{"agents/reference/generated/package"};
        const evidence = [_]types.Evidence{.{
            .claim = "the inert generated package passed its pinned admission witness",
            .sources = &read_sources,
            .method = "schema, authority, provenance, and contract-test fixture",
        }};
        return .{
            .control = .{ .terminate = "recommend-admit" },
            .evidence = &evidence,
        };
    }
};

fn executeRecorded(
    runtime: runtime_mod.Runtime,
    stimulus: types.Stimulus,
    caps: caps_mod.Caps,
    decision: types.Decision,
    replayed: *usize,
) !runtime_mod.CommitResult {
    const result = try runtime.execute(stimulus, caps, decision);
    const recomputed = runtime_mod.decisionDigest(stimulus, caps, decision);
    try observability.verifyReplay(runtime.substrate, stimulus.firing_id, recomputed);
    replayed.* += 1;
    return result;
}

fn fireRecorded(
    runtime: runtime_mod.Runtime,
    neuron: neuron_mod.Neuron,
    stimulus: types.Stimulus,
    caps: caps_mod.Caps,
    replayed: *usize,
) !runtime_mod.CommitResult {
    const decision = try neuron.fire(stimulus, caps);
    return executeRecorded(runtime, stimulus, caps, decision, replayed);
}

fn dispatchRecorded(
    scheduler: *scheduler_mod.Scheduler,
    neuron: neuron_mod.Neuron,
    neuron_ref: []const u8,
    stimulus: types.Stimulus,
    caps: caps_mod.Caps,
    replayed: *usize,
) !scheduler_mod.DispatchResult {
    const decision = try neuron.fire(stimulus, caps);
    const result = try scheduler.dispatch(neuron_ref, stimulus, caps);
    const recomputed = runtime_mod.decisionDigest(stimulus, caps, decision);
    try observability.verifyReplay(scheduler.runtime.substrate, stimulus.firing_id, recomputed);
    replayed.* += 1;
    return result;
}

pub fn run(allocator: std.mem.Allocator) !Summary {
    var substrate = substrate_mod.Substrate.init(allocator);
    defer substrate.deinit();
    const runtime: runtime_mod.Runtime = .{ .substrate = &substrate };
    var scheduler = scheduler_mod.Scheduler.init(allocator, runtime);
    defer scheduler.deinit();
    var registry = registry_mod.Registry.init(allocator);
    defer registry.deinit();
    var replayed: usize = 0;

    // Admit the default package as inert, content-pinned data. Admission and
    // authority remain separate; the package asks for no ambient grant.
    const package_digest = types.digest(package_bytes);
    try registry.admit(.{
        .name = "typed-neuron/meta-agent",
        .version = "1.0.0",
        .bytes = package_bytes,
        .pinned_digest = package_digest,
        .signature_verified = true,
        .scan_passed = true,
        .contract_tests_passed = true,
    });
    const ambient_candidate: registry_mod.Candidate = .{
        .name = "typed-neuron/meta-agent-ambient",
        .version = "1.0.0",
        .bytes = package_bytes,
        .pinned_digest = package_digest,
        .signature_verified = true,
        .scan_passed = true,
        .contract_tests_passed = true,
        .requests_authority = true,
    };
    var ambient_denied = false;
    registry.admit(ambient_candidate) catch |err| {
        if (err != error.AmbientAuthorityDenied) return err;
        ambient_denied = true;
    };

    // Bootstrap the sole mutable pointer plus its immutable first snapshot.
    const bootstrap_effects = [_]types.Effect{
        .{ .write = .{
            .id = "agents/reference/snapshots/0001",
            .schema = "typed-neuron.agent-snapshot/v1",
            .bytes = "{\"generation\":1,\"frontier\":\"intake\"}",
        } },
        .{ .write = .{
            .id = "agents/reference/active",
            .schema = "typed-neuron.snapshot-pointer/v1",
            .bytes = "agents/reference/snapshots/0001",
        } },
    };
    const bootstrap_impl: FixedNeuron = .{
        .control = .{ .terminate = "bootstrapped" },
        .effects = &bootstrap_effects,
    };
    _ = try fireRecorded(
        runtime,
        neuron_mod.bind(FixedNeuron, &bootstrap_impl, "meta/bootstrap", "1.0.0"),
        .{ .firing_id = "meta/000-bootstrap", .receptor_schema = "typed-neuron.bootstrap/v1" },
        agent_caps,
        &replayed,
    );

    // The first four default responsibilities are separate Neuron identities.
    const stage_specs = [_]struct {
        identity: []const u8,
        firing_id: []const u8,
        receptor: []const u8,
        id: []const u8,
        schema: []const u8,
        bytes: []const u8,
        result: []const u8,
    }{
        .{
            .identity = "meta/intake",
            .firing_id = "meta/010-intake",
            .receptor = "typed-neuron.receptor/v1",
            .id = "agents/reference/intent",
            .schema = "typed-neuron.intent/v1",
            .bytes = "{\"request\":\"repair capability\",\"origin\":\"gate\",\"priority\":1}",
            .result = "intent-normalized",
        },
        .{
            .identity = "meta/governor",
            .firing_id = "meta/020-governor",
            .receptor = "typed-neuron.intent/v1",
            .id = "agents/reference/envelope",
            .schema = "typed-neuron.work-envelope/v1",
            .bytes = "{\"authority\":\"local_reversible\",\"max_effects\":8,\"deadline\":1000}",
            .result = "bounded",
        },
        .{
            .identity = "meta/context",
            .firing_id = "meta/030-context",
            .receptor = "typed-neuron.work-envelope/v1",
            .id = "agents/reference/context",
            .schema = "typed-neuron.context-manifest/v1",
            .bytes = "{\"reads\":[\"agents/reference/intent\"],\"provenance\":\"pinned\"}",
            .result = "context-grounded",
        },
        .{
            .identity = "meta/planner",
            .firing_id = "meta/040-planner",
            .receptor = "typed-neuron.context-manifest/v1",
            .id = "agents/reference/plan",
            .schema = "typed-neuron.plan/v1",
            .bytes = "{\"fan_out\":2,\"max_fan_out\":4,\"acceptance\":\"independent-verifier-green\"}",
            .result = "plan-bounded",
        },
    };
    inline for (stage_specs) |stage| {
        const effects = [_]types.Effect{.{ .write = .{
            .id = stage.id,
            .schema = stage.schema,
            .bytes = stage.bytes,
        } }};
        const implementation: FixedNeuron = .{
            .control = .{ .terminate = stage.result },
            .effects = &effects,
        };
        _ = try fireRecorded(
            runtime,
            neuron_mod.bind(FixedNeuron, &implementation, stage.identity, "1.0.0"),
            .{ .firing_id = stage.firing_id, .receptor_schema = stage.receptor },
            agent_caps,
            &replayed,
        );
    }
    const normalized_and_planned =
        substrate.artifacts.contains("agents/reference/intent") and
        substrate.artifacts.contains("agents/reference/envelope") and
        substrate.artifacts.contains("agents/reference/context") and
        substrate.artifacts.contains("agents/reference/plan");

    // Pure decision generation for independent leaves is concurrent. The
    // substrate remains the serialization point for their atomic commits.
    var barrier: ParallelBarrier = .{};
    const work_a_effects = [_]types.Effect{
        .{ .write = .{
            .id = "agents/reference/work/a",
            .schema = "typed-neuron.proposal/v1",
            .bytes = "plausible-but-false",
        } },
        .{ .send = .{
            .to = "neuron/join",
            .schema = "typed-neuron.work-complete/v1",
            .payload = "work-a",
        } },
    };
    const work_b_effects = [_]types.Effect{
        .{ .write = .{
            .id = "agents/reference/work/b",
            .schema = "typed-neuron.proposal/v1",
            .bytes = "verified-work-b",
        } },
        .{ .send = .{
            .to = "neuron/join",
            .schema = "typed-neuron.work-complete/v1",
            .payload = "work-b",
        } },
    };
    const worker_a_impl: ParallelWorker = .{ .barrier = &barrier, .effects = &work_a_effects };
    const worker_b_impl: ParallelWorker = .{ .barrier = &barrier, .effects = &work_b_effects };
    const stimulus_a: types.Stimulus = .{
        .firing_id = "meta/050-work-a",
        .receptor_schema = "typed-neuron.work-item/v1",
    };
    const stimulus_b: types.Stimulus = .{
        .firing_id = "meta/051-work-b",
        .receptor_schema = "typed-neuron.work-item/v1",
    };
    var job_a: FireJob = .{
        .neuron = neuron_mod.bind(ParallelWorker, &worker_a_impl, "meta/executor-a", "1.0.0"),
        .stimulus = stimulus_a,
        .caps = agent_caps,
    };
    var job_b: FireJob = .{
        .neuron = neuron_mod.bind(ParallelWorker, &worker_b_impl, "meta/executor-b", "1.0.0"),
        .stimulus = stimulus_b,
        .caps = agent_caps,
    };
    const thread_a = try std.Thread.spawn(.{}, FireJob.run, .{&job_a});
    const thread_b = try std.Thread.spawn(.{}, FireJob.run, .{&job_b});
    thread_a.join();
    thread_b.join();
    if (job_a.failure) |err| return err;
    if (job_b.failure) |err| return err;
    const decision_a = job_a.decision orelse return error.ParallelWorkerFailed;
    const decision_b = job_b.decision orelse return error.ParallelWorkerFailed;
    const committed_a = try executeRecorded(runtime, stimulus_a, agent_caps, decision_a, &replayed);
    _ = try executeRecorded(runtime, stimulus_b, agent_caps, decision_b, &replayed);
    const duplicate = try runtime.execute(stimulus_a, agent_caps, decision_a);
    const parallel_workers: usize = if (barrier.overlapped.load(.acquire) == 2) 2 else 0;

    // Join only after both distinct durable completion messages are present.
    const join_messages = [_]types.Message{
        .{
            .to = "neuron/join",
            .schema = "typed-neuron.work-complete/v1",
            .payload = "work-a",
        },
        .{
            .to = "neuron/join",
            .schema = "typed-neuron.work-complete/v1",
            .payload = "work-b",
        },
    };
    const join_impl: topology_mod.JoinNeuron = .{
        .schema = "typed-neuron.work-complete/v1",
        .quorum = 2,
    };
    const join_neuron = neuron_mod.bind(topology_mod.JoinNeuron, &join_impl, "meta/join", "1.0.0");
    try scheduler.register(join_neuron);
    const join_stimulus: types.Stimulus = .{
        .firing_id = "meta/060-join",
        .receptor_schema = "typed-neuron.frontier/v1",
        .messages = &join_messages,
    };
    const join_result = try dispatchRecorded(
        &scheduler,
        join_neuron,
        "meta/join",
        join_stimulus,
        .{},
        &replayed,
    );
    const join_settled = switch (join_result.next) {
        .terminated => |result| std.mem.eql(u8, result, "quorum-reached"),
        else => false,
    };

    // The verifier has only the pinned proposal, not the producer's context.
    const false_digest = types.digest("plausible-but-false");
    const verifier_impl: IndependentVerifier = .{ .expected_false_digest = false_digest };
    const verifier_neuron = neuron_mod.bind(
        IndependentVerifier,
        &verifier_impl,
        "meta/verifier",
        "1.0.0",
    );
    const work_a_reads = [_]types.ArtifactRef{.{
        .id = "agents/reference/work/a",
        .digest = false_digest,
    }};
    const work_a_permitted = [_][]const u8{"agents/reference/work/a"};
    _ = try fireRecorded(
        runtime,
        verifier_neuron,
        .{
            .firing_id = "meta/070-verify-red",
            .receptor_schema = "typed-neuron.verification/v1",
            .permitted_reads = &work_a_permitted,
            .reads = &work_a_reads,
        },
        agent_caps,
        &replayed,
    );
    const false_proposal_rejected =
        substrate.messages.items.len >= 3 and
        std.mem.eql(
            u8,
            substrate.messages.items[substrate.messages.items.len - 1].payload,
            "false-proposal",
        );

    const recovery_effects = [_]types.Effect{
        .{ .write = .{
            .id = "agents/reference/recovery",
            .schema = "typed-neuron.recovery/v1",
            .bytes = "{\"attempt\":1,\"strategy\":\"generate-compatible-limb\"}",
        } },
        .{ .send = .{
            .to = "neuron/router",
            .schema = "typed-neuron.retry/v1",
            .payload = "capability-gap",
        } },
    };
    const recovery_impl: FixedNeuron = .{
        .control = .{ .terminate = "rerouted" },
        .effects = &recovery_effects,
    };
    _ = try fireRecorded(
        runtime,
        neuron_mod.bind(FixedNeuron, &recovery_impl, "meta/recovery", "1.0.0"),
        .{
            .firing_id = "meta/080-recovery",
            .receptor_schema = "typed-neuron.failure/v1",
            .messages = &[_]types.Message{.{
                .to = "neuron/recovery",
                .schema = "typed-neuron.failure/v1",
                .payload = "false-proposal",
            }},
        },
        agent_caps,
        &replayed,
    );
    const recovery_rerouted =
        substrate.artifacts.contains("agents/reference/recovery") and
        std.mem.eql(
            u8,
            substrate.messages.items[substrate.messages.items.len - 1].to,
            "neuron/router",
        );

    // Router materializes the typed gap; designer writes an inert package;
    // judge reads the exact digest; only then may the registry admit it.
    const gap_effects = [_]types.Effect{.{ .write = .{
        .id = "agents/reference/gap",
        .schema = "typed-neuron.capability-gap/v1",
        .bytes = "{\"input\":\"capability/repair/v1\",\"output\":\"typed-neuron.result/v1\",\"authority\":\"write:agents/reference/generated/\"}",
    } }};
    const gap_impl: FixedNeuron = .{
        .control = .{ .terminate = "gap-materialized" },
        .effects = &gap_effects,
    };
    _ = try fireRecorded(
        runtime,
        neuron_mod.bind(FixedNeuron, &gap_impl, "meta/router", "1.0.0"),
        .{ .firing_id = "meta/090-gap", .receptor_schema = "typed-neuron.retry/v1" },
        agent_caps,
        &replayed,
    );

    const generated_spec =
        "limb/v1 repair-capability\n" ++
        "on capability/repair/v1 write agents/reference/generated/result typed-neuron.result/v1 repaired-through-generated-limb\n";
    const generated_manifest =
        "name=repair-capability version=1.0.0 input=capability/repair/v1 " ++
        "output=typed-neuron.result/v1 caps=write:agents/reference/generated/";
    const designer_effects = [_]types.Effect{
        .{ .write = .{
            .id = "agents/reference/generated/package",
            .schema = "typed-neuron.skill/v1",
            .bytes = generated_spec,
        } },
        .{ .write = .{
            .id = "agents/reference/generated/manifest",
            .schema = "typed-neuron.agent-skill-manifest/v1",
            .bytes = generated_manifest,
        } },
    };
    const designer_impl: FixedNeuron = .{
        .control = .{ .terminate = "inert-package-written" },
        .effects = &designer_effects,
    };
    _ = try fireRecorded(
        runtime,
        neuron_mod.bind(FixedNeuron, &designer_impl, "meta/limb-designer", "1.0.0"),
        .{ .firing_id = "meta/100-design-limb", .receptor_schema = "typed-neuron.capability-gap/v1" },
        agent_caps,
        &replayed,
    );
    const generated_package = substrate.artifacts.get("agents/reference/generated/package") orelse
        return error.GeneratedPackageMissing;
    const judge_impl: PackageJudge = .{ .expected_digest = generated_package.digest };
    const package_reads = [_]types.ArtifactRef{.{
        .id = "agents/reference/generated/package",
        .digest = generated_package.digest,
    }};
    const package_permitted = [_][]const u8{"agents/reference/generated/package"};
    _ = try fireRecorded(
        runtime,
        neuron_mod.bind(PackageJudge, &judge_impl, "meta/limb-judge", "1.0.0"),
        .{
            .firing_id = "meta/110-judge-limb",
            .receptor_schema = "typed-neuron.skill-candidate/v1",
            .permitted_reads = &package_permitted,
            .reads = &package_reads,
        },
        .{},
        &replayed,
    );
    try registry.admit(.{
        .name = "repair-capability",
        .version = "1.0.0",
        .bytes = generated_package.bytes,
        .pinned_digest = generated_package.digest,
        .signature_verified = true,
        .scan_passed = true,
        .contract_tests_passed = true,
    });
    const admitted_limb = registry.packages.get("repair-capability") orelse
        return error.GeneratedPackageNotAdmitted;
    var limb_impl = try limb_mod.SpecNeuron.init(generated_package.bytes);
    const limb_neuron = neuron_mod.bind(
        limb_mod.SpecNeuron,
        &limb_impl,
        "meta/generated-repair",
        admitted_limb.version,
    );
    try scheduler.register(limb_neuron);
    const limb_caps: caps_mod.Caps = .{
        .allow_write = true,
        .write_prefix = "agents/reference/generated/",
        .budget = .{ .max_effects = 1, .max_writes = 1, .max_messages = 0, .max_spawns = 0 },
    };
    const limb_stimulus: types.Stimulus = .{
        .firing_id = "meta/120-generated-limb",
        .receptor_schema = "capability/repair/v1",
    };
    const limb_result = try dispatchRecorded(
        &scheduler,
        limb_neuron,
        "meta/generated-repair",
        limb_stimulus,
        limb_caps,
        &replayed,
    );
    const generated_limb_attached = switch (limb_result.next) {
        .terminated => |result| std.mem.eql(u8, result, "fired"),
        else => false,
    };
    const original_work_succeeded =
        substrate.artifacts.get("agents/reference/generated/result") != null;

    const memory_effects = [_]types.Effect{.{ .write = .{
        .id = "agents/reference/memory-index",
        .schema = "typed-neuron.memory-index/v1",
        .bytes = "{\"settled\":[\"agents/reference/generated/result\"],\"conversations\":[]}",
    } }};
    const memory_impl: FixedNeuron = .{
        .control = .{ .terminate = "memory-indexed" },
        .effects = &memory_effects,
    };
    _ = try fireRecorded(
        runtime,
        neuron_mod.bind(FixedNeuron, &memory_impl, "meta/memory-indexer", "1.0.0"),
        .{ .firing_id = "meta/130-memory", .receptor_schema = "typed-neuron.result/v1" },
        agent_caps,
        &replayed,
    );

    const old_pointer_digest = types.digest("agents/reference/snapshots/0001");
    const final_snapshot_bytes =
        "{\"generation\":2,\"parent\":\"agents/reference/snapshots/0001\",\"frontier\":\"settled\",\"result\":\"agents/reference/generated/result\"}";
    const audit_bytes =
        "{\"package\":\"typed-neuron/meta-agent@1.0.0\",\"verdict\":\"green\",\"recovery_attempts\":1,\"generated_limb\":\"repair-capability@1.0.0\"}";
    const settle_effects = [_]types.Effect{
        .{ .write = .{
            .id = "agents/reference/snapshots/0002",
            .schema = "typed-neuron.agent-snapshot/v1",
            .bytes = final_snapshot_bytes,
        } },
        .{ .write = .{
            .id = "agents/reference/audit",
            .schema = "typed-neuron.audit/v1",
            .bytes = audit_bytes,
        } },
        .{ .write = .{
            .id = "agents/reference/active",
            .schema = "typed-neuron.snapshot-pointer/v1",
            .bytes = "agents/reference/snapshots/0002",
            .expected_prior = old_pointer_digest,
        } },
    };
    const settler_impl: FixedNeuron = .{
        .control = .{ .terminate = "root-proved" },
        .effects = &settle_effects,
    };
    _ = try fireRecorded(
        runtime,
        neuron_mod.bind(FixedNeuron, &settler_impl, "meta/settler", "1.0.0"),
        .{ .firing_id = "meta/140-settle", .receptor_schema = "typed-neuron.frontier/v1" },
        agent_caps,
        &replayed,
    );

    // A stale settler proposes two effects. The pointer conflict rejects the
    // whole firing, so the second write cannot leak.
    const stale_effects = [_]types.Effect{
        .{ .write = .{
            .id = "agents/reference/active",
            .schema = "typed-neuron.snapshot-pointer/v1",
            .bytes = "agents/reference/snapshots/stale",
            .expected_prior = old_pointer_digest,
        } },
        .{ .write = .{
            .id = "agents/reference/stale-partial",
            .schema = "typed-neuron.agent-snapshot/v1",
            .bytes = "must-not-commit",
        } },
    };
    const stale_impl: FixedNeuron = .{
        .control = .{ .terminate = "stale" },
        .effects = &stale_effects,
    };
    const stale_neuron = neuron_mod.bind(FixedNeuron, &stale_impl, "meta/stale-settler", "1.0.0");
    const stale_stimulus: types.Stimulus = .{
        .firing_id = "meta/150-stale",
        .receptor_schema = "typed-neuron.frontier/v1",
    };
    const stale_decision = try stale_neuron.fire(stale_stimulus, agent_caps);
    var stale_cas_rejected = false;
    if (runtime.execute(stale_stimulus, agent_caps, stale_decision)) |_| {
        return error.StaleCasAccepted;
    } else |err| {
        if (err != error.Conflict) return err;
        stale_cas_rejected =
            !substrate.artifacts.contains("agents/reference/stale-partial");
    }

    // Detach topology and revoke package admission before collection.
    const detached = scheduler.unregister("meta/generated-repair");
    const revoked = registry.revoke("repair-capability");
    const roots = [_][]const u8{
        "agents/reference/active",
        "agents/reference/snapshots/0002",
        "agents/reference/audit",
        "agents/reference/memory-index",
    };
    const collected = try topology_mod.gc(&substrate, &roots, null);
    const audit_roots_readable =
        substrate.artifacts.contains("agents/reference/active") and
        substrate.artifacts.contains("agents/reference/snapshots/0002") and
        substrate.artifacts.contains("agents/reference/audit") and
        substrate.artifacts.contains("agents/reference/memory-index");
    const metrics = observability.metrics(&substrate);
    if (metrics.committed != replayed) return error.IncompleteReplayWitness;
    if (committed_a.effects_committed != duplicate.duplicates_skipped)
        return error.DuplicateWitnessMismatch;

    return .{
        .package_digest = package_digest,
        .final_snapshot_digest = types.digest(final_snapshot_bytes),
        .trace_digest = types.digest(audit_bytes),
        .admitted_without_authority = ambient_denied,
        .normalized_and_planned = normalized_and_planned,
        .parallel_workers = parallel_workers,
        .join_settled = join_settled,
        .false_proposal_rejected = false_proposal_rejected,
        .recovery_rerouted = recovery_rerouted,
        .generated_limb_attached = generated_limb_attached,
        .original_work_succeeded = original_work_succeeded,
        .duplicate_effects_skipped = duplicate.duplicates_skipped,
        .stale_cas_rejected = stale_cas_rejected,
        .replayed_firings = replayed,
        .committed_firings = metrics.committed,
        .limb_revoked = detached and revoked,
        .artifacts_collected = collected,
        .audit_roots_readable = audit_roots_readable,
    };
}
