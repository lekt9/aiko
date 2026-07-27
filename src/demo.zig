const std = @import("std");
const types = @import("types.zig");
const caps_mod = @import("caps.zig");
const substrate_mod = @import("substrate.zig");
const runtime_mod = @import("runtime.zig");
const neuron_mod = @import("neuron.zig");

pub const Summary = struct {
    committed: usize,
    artifacts: usize,
    messages: usize,
    neurons: usize,
    digest: types.Digest,
};

const DemoNeuron = struct {
    effects: []const types.Effect,
    evidence: []const types.Evidence,

    pub fn fire(self: *const DemoNeuron, _: types.Stimulus, _: caps_mod.Caps) !types.Decision {
        return .{
            .control = .{ .terminate = "demo-complete" },
            .effects = self.effects,
            .evidence = self.evidence,
        };
    }
};

pub fn run(allocator: std.mem.Allocator) !Summary {
    var substrate = substrate_mod.Substrate.init(allocator);
    defer substrate.deinit();

    const effects = [_]types.Effect{
        .{ .write = .{
            .id = "workspace/plan",
            .schema = "neuron.plan/v1",
            .bytes = "build,test,judge",
        } },
        .{ .send = .{
            .to = "channel/review",
            .schema = "neuron.review/v1",
            .payload = "plan-ready",
        } },
        .{ .spawn = .{
            .id = "worker/verifier",
            .kind = "deterministic-verifier",
        } },
    };
    const source = [_][]const u8{"stimulus"};
    const evidence = [_]types.Evidence{.{
        .claim = "the plan is ready for independent review",
        .sources = &source,
        .method = "deterministic demo fixture",
    }};
    const implementation: DemoNeuron = .{
        .effects = &effects,
        .evidence = &evidence,
    };
    const neuron = neuron_mod.bind(DemoNeuron, &implementation, "demo/planner", "1.0.0");
    const result = try (runtime_mod.Runtime{ .substrate = &substrate }).fire(neuron, .{
        .firing_id = "demo-001",
        .receptor_schema = "neuron.demo/v1",
    }, .{
        .allow_write = true,
        .allow_send = true,
        .allow_spawn = true,
        .write_prefix = "workspace/",
        .send_prefix = "channel/",
        .spawn_prefix = "worker/",
    });
    return .{
        .committed = result.effects_committed,
        .artifacts = substrate.artifacts.count(),
        .messages = substrate.messages.items.len,
        .neurons = substrate.neurons.count(),
        .digest = result.decision_digest,
    };
}
