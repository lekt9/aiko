const std = @import("std");
const types = @import("typed_neuron");
const caps_mod = @import("caps.zig");

pub fn firingEnergy(g_ok: bool, conf: u16, cost: f64, settle: f64, viol: u32) f64 {
    var e: f64 = 0.0;
    e += if (g_ok) 0.0 else 3.0;
    e += @max(0.0, (1000.0 - @as(f64, @floatFromInt(conf))) / 250.0);
    e += cost * 2.0;
    e += settle;
    e += @as(f64, @floatFromInt(viol)) * 2.5;
    return e;
}

pub const Candidate = struct {
    id: []const u8,
    grounding_ok: bool,
    evidence_conf_milli: u16,
    normalized_cost: f64,
    settlement_distance: f64,
    violations: u32 = 0,
    wants_sub_ebm: bool = false,
};

pub const EnergyRouterNeuron = struct {
    scratch: []u8,
    effects: []types.Effect,
    evidence: []types.Evidence,
    sources: [][]const u8,

    fn parse(self: *const EnergyRouterNeuron, stimulus: types.Stimulus) ![]Candidate {
        if (stimulus.messages.len == 0) return error.NoCandidates;
        const payload = stimulus.messages[stimulus.messages.len - 1].payload;
        var list: std.ArrayList(Candidate) = .empty;
        var lines = std.mem.splitScalar(u8, payload, '\n');
        while (lines.next()) |line| {
            if (line.len == 0) continue;
            var f = std.mem.splitScalar(u8, line, '|');
            const id = f.next() orelse return error.Bad;
            const g = f.next() orelse return error.Bad;
            const cf = f.next() orelse return error.Bad;
            const co = f.next() orelse return error.Bad;
            const se = f.next() orelse return error.Bad;
            const vi = f.next() orelse return error.Bad;
            const su = f.next() orelse "0";
            const idc = try self.dup(id);
            try list.append(self.allocator(), .{
                .id = idc,
                .grounding_ok = std.mem.eql(u8, g, "1"),
                .evidence_conf_milli = try std.fmt.parseInt(u16, cf, 10),
                .normalized_cost = try std.fmt.parseFloat(f64, co),
                .settlement_distance = try std.fmt.parseFloat(f64, se),
                .violations = try std.fmt.parseInt(u32, vi, 10),
                .wants_sub_ebm = std.mem.eql(u8, su, "1"),
            });
        }
        return list.toOwnedSlice(self.allocator());
    }

    fn allocator(_: *const EnergyRouterNeuron) std.mem.Allocator {
        return std.testing.allocator;
    }
    fn dup(_: *const EnergyRouterNeuron, s: []const u8) ![]u8 {
        const b = try std.testing.allocator.alloc(u8, s.len);
        @memcpy(b, s);
        return b;
    }

    pub fn fire(self: *const EnergyRouterNeuron, stimulus: types.Stimulus, _: caps_mod.Caps) !types.Decision {
        const cands = try self.parse(stimulus);
        defer std.testing.allocator.free(cands);

        var bi: usize = 0;
        var be = firingEnergy(cands[0].grounding_ok, cands[0].evidence_conf_milli, cands[0].normalized_cost, cands[0].settlement_distance, cands[0].violations);
        for (cands[1..], 1..) |c, i| {
            const e = firingEnergy(c.grounding_ok, c.evidence_conf_milli, c.normalized_cost, c.settlement_distance, c.violations);
            if (e < be) {
                be = e;
                bi = i;
            }
        }
        const ch = cands[bi];

        const sc = try std.fmt.allocPrint(std.testing.allocator, "{s}|{d:.4}", .{ ch.id, be });
        defer std.testing.allocator.free(sc);

        self.effects[0] = .{ .write = .{ .id = "energy/score", .schema = "neuron.energy-score/v1", .bytes = sc } };
        var ne: usize = 1;
        var ctrl: types.Control = undefined;

        if (ch.wants_sub_ebm) {
            const sid = try std.fmt.allocPrint(std.testing.allocator, "sub-ebm/{s}", .{ch.id});
            defer std.testing.allocator.free(sid);
            self.effects[1] = .{ .spawn = .{ .id = sid, .kind = "energy-sub-ebm", .grant = null } };
            ne = 2;
            ctrl = .{ .terminate = "spawned-sub-ebm" };
        } else {
            ctrl = .{ .branch = ch.id };
        }

        const src = [_][]const u8{"stimulus"};
        self.sources[0] = "stimulus";
        self.evidence[0] = .{ .claim = "lowest energy via firingEnergy", .sources = &src, .method = "energy_router" };

        return .{ .control = ctrl, .effects = self.effects[0..ne], .evidence = self.evidence[0..1] };
    }
};

const testing = std.testing;
fn mk(n: usize) []u8 {
    return testing.allocator.alloc(u8, n) catch unreachable;
}

test "proper energy router: score + branch" {
    var s = mk(2048);
    defer testing.allocator.free(s);
    var ef: [4]types.Effect = undefined;
    var ev: [4]types.Evidence = undefined;
    var so: [4][]const u8 = undefined;
    const r = EnergyRouterNeuron{ .scratch = s, .effects = &ef, .evidence = &ev, .sources = &so };
    const p = "h|1|400|0.9|3|0|0\nbest|1|950|0.1|0.1|0|0\n";
    var m: types.Message = .{ .schema = "r", .correlation_id = "c", .causation_id = "p", .payload = p, .durable = true };
    const st: types.Stimulus = .{ .firing_id = "e1", .receptor_schema = "w", .messages = (&m)[0..1] };
    const d = try r.fire(st, .{ .allow_write = true });
    try testing.expect(d.effects.len >= 1);
    try testing.expectEqualStrings("neuron.energy-score/v1", d.effects[0].write.schema);
    switch (d.control) {
        .branch => |t| try testing.expectEqualStrings("best", t),
        else => try testing.expect(false),
    }
}

test "proper energy router: spawns sub-ebm" {
    var s = mk(2048);
    defer testing.allocator.free(s);
    var ef: [4]types.Effect = undefined;
    var ev: [4]types.Evidence = undefined;
    var so: [4][]const u8 = undefined;
    const r = EnergyRouterNeuron{ .scratch = s, .effects = &ef, .evidence = &ev, .sources = &so };
    const p = "w|1|980|0.05|0.05|0|1\n";
    var m: types.Message = .{ .schema = "r", .correlation_id = "c", .causation_id = "p", .payload = p, .durable = true };
    const st: types.Stimulus = .{ .firing_id = "e2", .receptor_schema = "w", .messages = (&m)[0..1] };
    const d = try r.fire(st, .{ .allow_write = true, .allow_spawn = true });
    try testing.expect(d.effects.len >= 2);
    try testing.expectEqualStrings("spawn", @tagName(d.effects[1]));
    switch (d.control) {
        .terminate => |rr| try testing.expectEqualStrings("spawned-sub-ebm", rr),
        else => try testing.expect(false),
    }
}
