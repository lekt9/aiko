//! aiko — the harness entry point.
//!
//! This binary is the first thing in the repository that links BOTH layers in
//! one process: `typed_neuron` (the firing primitive and its canonical types)
//! and `contract` (the durable ledger, W6H, occurrence invalidation). Until the
//! module export landed beside it, a Zig consumer could only reach contract
//! through the C ABI — marshalling a struct out to C and back to arrive at a
//! type both ends already agree on, since `contract.FireRequest` IS
//! `typed_neuron.FireRequest`.
//!
//! `doctor` exists to make that seam falsifiable rather than assumed: it calls
//! into each layer and reports what each one answers. If the link is not real,
//! this does not compile; if a layer's identity moves, the output changes.

const std = @import("std");
const neuron = @import("typed_neuron");
const contract = @import("contract");
const contract_graph_analyzer = @import("contract_graph_analyzer");

const bridge = @import("bridge.zig");
const mcp = @import("mcp.zig");
const workflow_binding = @import("workflow_binding.zig");

pub fn main(init: std.process.Init) !void {
    const a = init.arena.allocator();
    var it = try std.process.Args.Iterator.initAllocator(init.minimal.args, a);
    var argv: std.ArrayList([]const u8) = .empty;
    while (it.next()) |arg| try argv.append(a, arg);
    if (argv.items.len >= 2 and std.mem.eql(u8, argv.items[1], "graph-plan")) {
        return runGraphPlan(init, a, argv.items[2..]);
    }
    if (argv.items.len >= 2 and std.mem.eql(u8, argv.items[1], "bind-workflow")) {
        return runBindWorkflow(init, a, argv.items[2..]);
    }
    if (argv.items.len >= 2 and std.mem.eql(u8, argv.items[1], "workflow-control")) {
        return runWorkflowControl(init, a, argv.items[2..]);
    }
    if (argv.items.len >= 2 and std.mem.eql(u8, argv.items[1], "bridge")) {
        return runBridge(init, a, argv.items[2..]);
    }
    // The MCP surface: one door onto the whole harness, which is what Hermes
    // mounts. Protocol from contract, catalog and semantics from mcp.zig.
    if (argv.items.len >= 2 and std.mem.eql(u8, argv.items[1], "tick")) {
        return runTick(init, a, argv.items[2..]);
    }
    if (argv.items.len >= 2 and std.mem.eql(u8, argv.items[1], "mcp")) {
        return mcp.serve(a, init.io, init.minimal.environ);
    }

    var buf: [4096]u8 = undefined;
    var w = std.Io.File.stdout().writerStreaming(init.io, &buf);
    const out = &w.interface;

    // Proof the shared type is genuinely shared, checked at comptime: if these
    // ever diverge the build fails here rather than at a wire boundary during
    // a firing, which is the expensive place to find out.
    comptime std.debug.assert(contract.neuron.FireRequest == neuron.FireRequest);

    try out.print("aiko — meta-fractal harness (MCP surface for Hermes)\n\n", .{});
    try out.print("  bind-workflow <cell.yaml> [--plan]\n", .{});
    try out.print("  workflow-control <dir> bind|pause|resume|status|approve [--digest HEX]\n", .{});
    try out.print("  graph-plan <walk.json>\n\n", .{});
    try out.print("  neuron    core={s}\n", .{neuron.CORE_VERSION});
    try out.print("            hash_profile={s}\n", .{neuron.HASH_PROFILE});
    try out.print("            schema_digest={s}\n", .{neuron.SCHEMA_DIGEST});
    try out.print("  contract  w6h={s}\n", .{@typeName(contract.w6h.W6H)});
    try out.print("            FireRequest shared with neuron: yes (comptime-checked)\n", .{});
    try out.print("\nThe six interrogatives a contract row must answer or be refused:\n", .{});
    // Filter to the interrogatives themselves: W6HError also carries carrier
    // failures (OutOfMemory, BadJson, NotDeclared) which are not questions a
    // row failed to answer, and listing them under that heading would overstate
    // what the gate checks.
    inline for (@typeInfo(contract.w6h.W6HError).error_set.?) |e| {
        if (comptime std.mem.startsWith(u8, e.name, "Missing")) {
            try out.print("  {s}\n", .{e.name});
        }
    }
    try out.flush();
}


/// `aiko-doctor graph-plan <walk.json>`
///
/// Project a declared walk through Contract's analyzer and print its stable JSON
/// verdict. This is deliberately an observer, not another scheduler: Contract
/// owns Kahn frontiers and collision/refusal semantics; Cell and hosts consume
/// those frontiers through their own already-witnessed execution surfaces.
fn runGraphPlan(init: std.process.Init, a: std.mem.Allocator, rest: []const []const u8) !void {
    var buf: [4096]u8 = undefined;
    var w = std.Io.File.stdout().writerStreaming(init.io, &buf);
    const out = &w.interface;

    if (rest.len != 1) {
        try out.print("usage: aiko-doctor graph-plan <walk.json>\n", .{});
        try out.flush();
        std.process.exit(2);
    }
    const walk_json = std.Io.Dir.cwd().readFileAlloc(
        init.io,
        rest[0],
        a,
        .limited(16 << 20),
    ) catch {
        try out.print("{{\"error\":\"walk_unreadable\"}}\n", .{});
        try out.flush();
        std.process.exit(1);
    };

    var analyzer = contract_graph_analyzer.GraphPlan{ .allocator = a };
    var verdict = analyzer.analyze(walk_json) catch {
        try out.print("{{\"error\":\"invalid_walk\"}}\n", .{});
        try out.flush();
        std.process.exit(1);
    };
    defer verdict.deinit(a);
    const result = try analyzer.toJson(&verdict);
    try out.print("{s}\n", .{result});
    try out.flush();
}

/// `aiko-doctor bind-workflow <cell.yaml> [--plan]`
///
/// Ask Cell to canonicalize the workflow, project organelles/wiring into a
/// Contract walk, and optionally run graph-plan on that walk. Cell executes;
/// Contract analyzes; this command does not schedule.
fn runBindWorkflow(init: std.process.Init, a: std.mem.Allocator, rest: []const []const u8) !void {
    var buf: [4096]u8 = undefined;
    var w = std.Io.File.stdout().writerStreaming(init.io, &buf);
    const out = &w.interface;

    var cell_path: ?[]const u8 = null;
    var with_plan = false;
    for (rest) |arg| {
        if (std.mem.eql(u8, arg, "--plan")) {
            with_plan = true;
        } else if (cell_path == null) {
            cell_path = arg;
        }
    }
    if (cell_path == null) {
        try out.print("usage: aiko-doctor bind-workflow <cell.yaml> [--plan]\n", .{});
        try out.flush();
        std.process.exit(2);
    }

    const built = workflow_binding.buildCell(init, a, cell_path.?) catch |err| {
        try out.print("{{\"error\":\"{t}\"}}\n", .{err});
        try out.flush();
        std.process.exit(1);
    };
    const walk = workflow_binding.projectWalk(a, built.canonical, built.digest, cell_path.?) catch |err| {
        try out.print("{{\"error\":\"{t}\"}}\n", .{err});
        try out.flush();
        std.process.exit(1);
    };

    try out.print("{{\"cell\":{{\"path\":", .{});
    try writeJsonString(out, cell_path.?);
    try out.print(",\"digest\":", .{});
    try writeJsonString(out, built.digest);
    try out.print("}},\"walk\":{s}", .{walk});
    if (with_plan) {
        const plan = workflow_binding.planWalk(a, walk) catch |err| {
            try out.print(",\"error\":\"{t}\"}}\n", .{err});
            try out.flush();
            std.process.exit(1);
        };
        try out.print(",\"plan\":{s}", .{plan});
    }
    try out.print("}}\n", .{});
    try out.flush();
}

fn writeJsonString(out: anytype, s: []const u8) !void {
    try out.writeAll("\"");
    for (s) |c| {
        switch (c) {
            '"' => try out.writeAll("\\\""),
            '\\' => try out.writeAll("\\\\"),
            else => try out.writeAll(&.{c}),
        }
    }
    try out.writeAll("\"");
}

/// `aiko-doctor workflow-control <dir> bind|pause|resume|status|approve [--digest HEX]`
///
/// Durable pause/resume for a bound Cell revision. Survives process restart
/// because the record is a file, not memory. Does not choose the next organelle.
fn runWorkflowControl(init: std.process.Init, a: std.mem.Allocator, rest: []const []const u8) !void {
    var buf: [4096]u8 = undefined;
    var w = std.Io.File.stdout().writerStreaming(init.io, &buf);
    const out = &w.interface;

    var dir: ?[]const u8 = null;
    var op: ?[]const u8 = null;
    var digest: ?[]const u8 = null;
    var i: usize = 0;
    while (i < rest.len) : (i += 1) {
        if (std.mem.eql(u8, rest[i], "--digest") and i + 1 < rest.len) {
            i += 1;
            digest = rest[i];
            continue;
        }
        if (dir == null) {
            dir = rest[i];
        } else if (op == null) {
            op = rest[i];
        }
    }
    if (dir == null or op == null) {
        try out.print("usage: aiko-doctor workflow-control <dir> bind|pause|resume|status|approve [--digest HEX]\n", .{});
        try out.flush();
        std.process.exit(2);
    }
    const rec = workflow_binding.applyControl(init, a, dir.?, op.?, digest) catch |err| {
        try out.print("{{\"error\":\"{t}\"}}\n", .{err});
        try out.flush();
        std.process.exit(1);
    };
    try out.print("{s}", .{rec});
    try out.flush();
}

/// `aiko-doctor bridge <neuron_state_dir> [--agent <id>]`
///
/// Mirror every committed firing in a neuron journal into the contract ledger
/// as a W6H-gated row. Re-running is safe: contract's own cache resolves a
/// repeated (plan, action, cwd, parent) to one row, so the bridge keeps no
/// watermark of its own — a watermark would be a second source of truth about
/// what has already been mirrored, and the two would drift.
fn runBridge(init: std.process.Init, a: std.mem.Allocator, rest: []const []const u8) !void {
    var buf: [4096]u8 = undefined;
    var w = std.Io.File.stdout().writerStreaming(init.io, &buf);
    const out = &w.interface;

    if (rest.len == 0) {
        try out.print("usage: aiko-doctor bridge <neuron_state_dir> [--agent <id>]\n", .{});
        try out.flush();
        std.process.exit(2);
    }
    const state_dir = rest[0];
    var agent: []const u8 = "aiko-bridge";
    var i: usize = 1;
    while (i + 1 < rest.len) : (i += 2) {
        if (std.mem.eql(u8, rest[i], "--agent")) agent = rest[i + 1];
    }

    const firings = bridge.readFirings(a, init.io, state_dir) catch |err| {
        try out.print("error: {t} — no journal at {s}/substrate.log\n", .{ err, state_dir });
        try out.flush();
        std.process.exit(1);
    };

    const node_id = nodeIdFor(state_dir);

    var declared: usize = 0;
    for (firings) |f| {
        const id = bridge.declareFiring(a, init.minimal.environ, node_id, agent, f) catch |err| {
            // A refusal names the interrogative it could not answer. Surface it
            // and keep going: one unprojectable firing must not stop the rest
            // from being mirrored, and a swallowed refusal is worse than a
            // loud one.
            try out.print("  REFUSED firing={s} seq={d}: {t}\n", .{ f.firing_id, f.seq, err });
            continue;
        };
        declared += 1;
        try out.print("  contract={s} firing={s} seq={d}\n", .{ id, f.firing_id, f.seq });
    }
    try out.print("\nbridged {d}/{d} firings from {s}\n", .{ declared, firings.len, state_dir });
    try out.flush();
}

/// `aiko-doctor tick <neuron_state_dir> [--every <seconds>] [--agent <id>]`
///
/// One pass of the loop that makes the harness reactive, or resident with
/// `--every`. Named after `contract tick`, which is the same idea one layer
/// down: one resolver pass, or resident.
///
/// Until now both halves existed and neither ran on its own. `bridge` mirrored
/// firings into the ledger and `redrive` acted on stale derivations, but each
/// was a manual one-shot — so a system documented as event-driven still needed
/// a human to turn each crank. This is the crank.
///
/// ORDER IS LOAD-BEARING: bridge BEFORE redrive.
///
/// A firing that has not reached the ledger has no contract row, so nothing can
/// have invalidated it and redrive would find nothing to act on. Bridging first
/// means each pass evaluates staleness against a ledger that already knows
/// about everything committed since the last pass. Reversed, a firing would
/// always be judged one full pass late.
///
/// Both halves are idempotent — the bridge relies on contract's cache, redrive
/// on content-addressed firing identity — so a pass that finds nothing new
/// writes nothing, and a resident tick over a quiet substrate is free.
/// Name the node a substrate belongs to.
///
/// `basename` alone is wrong and shipped that way: `agent init <node> <agent>`
/// puts the substrate at `<node>/state`, so every node on earth was recorded as
/// "state" — a field that identified nothing while claiming to name `who`.
/// Caught by reading a bridged row back out of the ledger. Take the parent when
/// the leaf is the conventional `state`.
fn nodeIdFor(state_dir: []const u8) []const u8 {
    const leaf = std.fs.path.basename(state_dir);
    if (!std.mem.eql(u8, leaf, "state")) return leaf;
    const parent = std.fs.path.dirname(state_dir) orelse return leaf;
    const up = std.fs.path.basename(parent);
    return if (up.len == 0) leaf else up;
}

fn runTick(init: std.process.Init, a: std.mem.Allocator, rest: []const []const u8) !void {
    var buf: [4096]u8 = undefined;
    var w = std.Io.File.stdout().writerStreaming(init.io, &buf);
    const out = &w.interface;

    if (rest.len == 0) {
        try out.print("usage: aiko-doctor tick <neuron_state_dir> [--every <seconds>] [--agent <id>]\n", .{});
        try out.flush();
        std.process.exit(2);
    }
    const state_dir = rest[0];
    var agent: []const u8 = "aiko-tick";
    var every_s: ?u64 = null;
    var i: usize = 1;
    while (i + 1 < rest.len) : (i += 2) {
        if (std.mem.eql(u8, rest[i], "--agent")) agent = rest[i + 1];
        if (std.mem.eql(u8, rest[i], "--every"))
            every_s = std.fmt.parseInt(u64, rest[i + 1], 10) catch null;
    }

    const node_id = nodeIdFor(state_dir);
    var pass: u64 = 0;
    while (true) {
        pass += 1;
        var declared: usize = 0;
        var refused: usize = 0;

        // --- half one: every committed firing becomes a W6H-gated row -------
        const firings = bridge.readFirings(a, init.io, state_dir) catch |err| {
            try out.print("tick {d}: no journal at {s}: {t}\n", .{ pass, state_dir, err });
            try out.flush();
            std.process.exit(1);
        };
        for (firings) |f| {
            if (bridge.declareFiring(a, init.minimal.environ, node_id, agent, f)) |_| {
                declared += 1;
            } else |_| {
                // A firing that cannot project into all six interrogatives is
                // reported and skipped. One unprojectable firing must not stop
                // the pass; a swallowed refusal would be worse than a loud one.
                refused += 1;
            }
        }

        // --- half two: act on what the ledger now says has gone stale -------
        const redrove = runRedrive(init, a, state_dir) catch false;

        try out.print("tick {d}: bridged={d} refused={d} redrive={s}\n", .{
            pass, declared, refused, if (redrove) "ok" else "none",
        });
        try out.flush();

        const seconds = every_s orelse break;
        const nap: std.Io.Clock.Duration = .{
            .raw = .{ .nanoseconds = @as(i96, @intCast(seconds)) * std.time.ns_per_s },
            .clock = .boot,
        };
        nap.sleep(init.io) catch break;
    }
}

/// Run neuron's `redrive` over the same substrate.
///
/// Invoked rather than linked, for the reason `mcp.zig` states: neuron's CLI is
/// the surface its own gates drive, so going through it means this pass
/// exercises exactly the path `redrive-gate.sh` covers.
fn runRedrive(init: std.process.Init, a: std.mem.Allocator, state_dir: []const u8) !bool {
    var child = std.process.spawn(init.io, .{
        .argv = &.{ "aiko", "redrive", state_dir, "--json" },
        .stdout = .pipe,
        .stderr = .pipe,
    }) catch return false;
    defer child.kill(init.io);

    var mrbuf: std.Io.File.MultiReader.Buffer(2) = undefined;
    var mr: std.Io.File.MultiReader = undefined;
    mr.init(a, init.io, mrbuf.toStreams(), &.{ child.stdout.?, child.stderr.? });
    defer mr.deinit();
    const timeout: std.Io.Timeout = .{ .duration = .{
        .raw = .{ .nanoseconds = 60 * std.time.ns_per_s },
        .clock = .boot,
    } };
    while (mr.fill(64, timeout)) |_| {} else |_| {}

    const term = child.wait(init.io) catch return false;
    return term == .exited and term.exited == 0;
}
