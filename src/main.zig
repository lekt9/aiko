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

const bridge = @import("bridge.zig");
const mcp = @import("mcp.zig");

pub fn main(init: std.process.Init) !void {
    const a = init.arena.allocator();
    var it = try std.process.Args.Iterator.initAllocator(init.minimal.args, a);
    var argv: std.ArrayList([]const u8) = .empty;
    while (it.next()) |arg| try argv.append(a, arg);
    if (argv.items.len >= 2 and std.mem.eql(u8, argv.items[1], "bridge")) {
        return runBridge(init, a, argv.items[2..]);
    }
    // The MCP surface: one door onto the whole harness, which is what Hermes
    // mounts. Protocol from contract, catalog and semantics from mcp.zig.
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

    // The node identity is `who`. Taken from the substrate directory being
    // mirrored, so a row names the node that actually committed the firing
    // rather than the host that happened to run the bridge.
    const node_id = std.fs.path.basename(state_dir);

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
