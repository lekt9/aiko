const std = @import("std");
const build_options = @import("build_options");
const demo = @import("demo.zig");
const run_mod = @import("run.zig");
const meta_agent = @import("meta_agent.zig");
const identity = @import("identity.zig");
const mesh_mod = @import("mesh.zig");
const tailnet_mod = @import("tailnet.zig");
const mcp_mod = @import("mcp.zig");
const substrate_mod = @import("substrate.zig");
const limb_ops = @import("limb_ops.zig");
const neuron_mod = @import("neuron.zig");
const caps_mod = @import("caps.zig");

const usage =
    \\Typed Neuron — a fail-closed runtime for typed agent workflows
    \\
    \\Usage:
    \\  neuron demo [--json]   run an atomic write + send + spawn firing
    \\  neuron check           run a lightweight runtime self-check
    \\  neuron meta-agent-check [--json]
    \\                         run the complete reference Meta-Agent witness
    \\  neuron run --def <manifest.json> --neuron <id> --stimulus <file|-> [--json]
    \\                         fire an external script-neuron through the real
    \\                         validate + commit lifecycle
    \\  neuron serve <ip:port> <write_prefix> [state_dir] [ceilings.json]
    \\                         run the mesh daemon (see above)
    \\  neuron mcp <write_prefix> [state_dir]
    \\                         run the stdio MCP edge
    \\  neuron compact <state_dir>
    \\                         fold the journaled substrate's live state into a
    \\                         single snapshot record and truncate the WAL (§22)
    \\  neuron limb admit <package_dir> <state_dir>
    \\                         validate manifest, compute content digest, and
    \\                         write a durable admission record (§29/§30).
    \\                         Idempotent; prints the hex digest on stdout.
    \\  neuron limb run <state_dir> --package <dir> --neuron <id>
    \\         --stimulus <file> [--json] [--dump]
    \\                         fire one neuron through the admitted path:
    \\                         digest-pinned, admitted caps, journaled state
    \\  neuron limb revoke <state_dir> --package <dir>
    \\                         block all future limb run for this digest (§24)
    \\  neuron limb detach <state_dir> --package <dir>
    \\                         write detach record + GC limb scope (§22)
    \\  neuron limb inspect <state_dir> [--json]
    \\                         print lifecycle records + substrate counts
    \\  neuron telemetry project <state_dir> [--json]
    \\                         project firing records into a deterministic
    \\                         rollup (firing counts, effects, artifacts)
    \\  neuron --version       print the build version
    \\  neuron --help          show this help
    \\
;

pub fn main(init: std.process.Init) !void {
    const allocator = init.gpa;
    var iterator = try std.process.Args.Iterator.initAllocator(init.minimal.args, allocator);
    defer iterator.deinit();
    var args: std.ArrayList([]const u8) = .empty;
    defer args.deinit(allocator);
    while (iterator.next()) |arg| try args.append(allocator, arg);
    if (args.items.len < 2 or std.mem.eql(u8, args.items[1], "--help") or std.mem.eql(u8, args.items[1], "-h")) {
        try writeStdout(init.io, usage);
        return;
    }
    if (std.mem.eql(u8, args.items[1], "--version")) {
        var buffer: [128]u8 = undefined;
        const line = try std.fmt.bufPrint(&buffer, "neuron {s}  rev {s}\n", .{ build_options.version, build_options.source_revision });
        try writeStdout(init.io, line);
        return;
    }
    if (std.mem.eql(u8, args.items[1], "serve")) {
        if (args.items.len < 4) {
            try writeStderr(init.io, "error: usage: neuron serve <ip:port> <write_prefix>\n");
            std.process.exit(2);
        }
        const address = mesh_mod.net.IpAddress.parseLiteral(args.items[2]) catch {
            try writeStderr(init.io, "error: invalid listen address\n");
            std.process.exit(2);
        };
        const ceiling: caps_mod.Caps = .{ .allow_write = true, .write_prefix = args.items[3] };
        const keys = identity.generateKeyPair(init.io);
        var substrate = openState(allocator, init.io, if (args.items.len > 4) args.items[4] else null) catch |err| {
            var error_buffer: [192]u8 = undefined;
            const line = std.fmt.bufPrint(&error_buffer, "error: cannot open state dir: {s}\n", .{@errorName(err)}) catch "error: cannot open state dir\n";
            writeStderr(init.io, line) catch {};
            std.process.exit(1);
        };
        defer substrate.deinit();
        var node = mesh_mod.Node.init(allocator, keys, &substrate);
        defer node.deinit();
        var proxy_arena = std.heap.ArenaAllocator.init(allocator);
        defer proxy_arena.deinit();
        var proxy_fx: [1]@import("types.zig").Effect = undefined;
        var proxy_ev: [1]@import("types.zig").Evidence = undefined;
        var proxy_src: [1][]const u8 = undefined;
        const proxy_impl: mesh_mod.ProxyNeuron = .{
            .arena = &proxy_arena,
            .fx = &proxy_fx,
            .ev = &proxy_ev,
            .src = &proxy_src,
        };
        try node.register(neuron_mod.bind(mesh_mod.ProxyNeuron, &proxy_impl, "mesh/proxy", "1"));
        var server = try address.listen(init.io, .{ .reuse_address = true });
        defer server.deinit(init.io);
        var id_hex: [64]u8 = undefined;
        var line_buffer: [256]u8 = undefined;
        const line = try std.fmt.bufPrint(
            &line_buffer,
            "✓ neuron mesh daemon\n  node {s}\n  mesh/proxy ceiling write {s} — tailnet peers only (100.64.0.0/10)\n",
            .{ identity.nodeIdHex(node.id(), &id_hex), ceiling.write_prefix },
        );
        try writeStdout(init.io, line);
        // Live wall clock (null): expiry and whois cache TTLs are real in
        // the daemon; fixed clocks are for tests.
        if (args.items.len > 5) {
            const table_bytes = std.Io.Dir.cwd().readFileAlloc(init.io, args.items[5], allocator, .limited(256 * 1024)) catch |err| {
                var error_buffer: [192]u8 = undefined;
                const eline = std.fmt.bufPrint(&error_buffer, "error: cannot read ceilings file: {s}\n", .{@errorName(err)}) catch "error: cannot read ceilings file\n";
                writeStderr(init.io, eline) catch {};
                std.process.exit(1);
            };
            defer allocator.free(table_bytes);
            const table = tailnet_mod.CeilingTable.parse(allocator, table_bytes) catch |err| {
                var error_buffer: [192]u8 = undefined;
                const eline = std.fmt.bufPrint(&error_buffer, "error: invalid ceilings file: {s}\n", .{@errorName(err)}) catch "error: invalid ceilings file\n";
                writeStderr(init.io, eline) catch {};
                std.process.exit(1);
            };
            var per_peer = tailnet_mod.TableClassifier.init(allocator, init.io, table, tailnet_mod.tailscaleWhois(), 300_000);
            defer per_peer.deinit();
            try tailnet_mod.serve(&node, &server, init.io, per_peer.classifier(), null, .{});
            return;
        }
        var single = tailnet_mod.SingleCeiling{ .ceiling = ceiling };
        try tailnet_mod.serve(&node, &server, init.io, single.classifier(), null, .{});
        return;
    }
    if (std.mem.eql(u8, args.items[1], "mcp")) {
        if (args.items.len < 3) {
            try writeStderr(init.io, "error: usage: neuron mcp <write_prefix> [state_dir]\n");
            std.process.exit(2);
        }
        const keys = identity.generateKeyPair(init.io);
        var substrate = openState(allocator, init.io, if (args.items.len > 3) args.items[3] else null) catch |err| {
            var error_buffer: [192]u8 = undefined;
            const line = std.fmt.bufPrint(&error_buffer, "error: cannot open state dir: {s}\n", .{@errorName(err)}) catch "error: cannot open state dir\n";
            writeStderr(init.io, line) catch {};
            std.process.exit(1);
        };
        defer substrate.deinit();
        var node = mesh_mod.Node.init(allocator, keys, &substrate);
        defer node.deinit();
        var proxy_arena = std.heap.ArenaAllocator.init(allocator);
        defer proxy_arena.deinit();
        var proxy_fx: [1]@import("types.zig").Effect = undefined;
        var proxy_ev: [1]@import("types.zig").Evidence = undefined;
        var proxy_src: [1][]const u8 = undefined;
        const proxy_impl: mesh_mod.ProxyNeuron = .{
            .arena = &proxy_arena,
            .fx = &proxy_fx,
            .ev = &proxy_ev,
            .src = &proxy_src,
        };
        try node.register(neuron_mod.bind(mesh_mod.ProxyNeuron, &proxy_impl, "mesh/proxy", "1"));
        var server: mcp_mod.Server = .{
            .allocator = allocator,
            .node = &node,
            .ceiling = .{ .allow_write = true, .write_prefix = args.items[2] },
            .now_ms = null,
            .io = init.io,
        };
        var read_buffer: [64 * 1024]u8 = undefined;
        var write_buffer: [4096]u8 = undefined;
        var reader = std.Io.File.stdin().reader(init.io, &read_buffer);
        var writer = std.Io.File.stdout().writer(init.io, &write_buffer);
        try server.serve(&reader.interface, &writer.interface);
        return;
    }
    if (std.mem.eql(u8, args.items[1], "compact")) {
        if (args.items.len < 3) {
            try writeStderr(init.io, "error: usage: neuron compact <state_dir>\n");
            std.process.exit(2);
        }
        var substrate = openState(allocator, init.io, args.items[2]) catch |err| {
            var error_buffer: [192]u8 = undefined;
            const line = std.fmt.bufPrint(&error_buffer, "error: cannot open state dir: {s}\n", .{@errorName(err)}) catch "error: cannot open state dir\n";
            writeStderr(init.io, line) catch {};
            std.process.exit(1);
        };
        defer substrate.deinit();
        const result = substrate.compact() catch |err| {
            var error_buffer: [192]u8 = undefined;
            const line = std.fmt.bufPrint(&error_buffer, "error: compaction failed closed: {s}\n", .{@errorName(err)}) catch "error: compaction failed closed\n";
            writeStderr(init.io, line) catch {};
            std.process.exit(1);
        };
        var buffer: [160]u8 = undefined;
        const line = try std.fmt.bufPrint(
            &buffer,
            "✓ substrate compacted\n  journal {d} bytes → snapshot {d} bytes\n",
            .{ result.prior_size, result.new_size },
        );
        try writeStdout(init.io, line);
        return;
    }
    if (std.mem.eql(u8, args.items[1], "limb")) {
        if (args.items.len < 3) {
            try writeStderr(init.io, "error: usage: neuron limb <admit|run|revoke|detach|inspect>\n");
            std.process.exit(2);
        }
        const sub = args.items[2];
        if (std.mem.eql(u8, sub, "admit")) {
            if (args.items.len < 5) {
                try writeStderr(init.io, "error: usage: neuron limb admit <package_dir> <state_dir>\n");
                std.process.exit(2);
            }
            const result = limb_ops.admit(allocator, init.io, args.items[3], args.items[4]) catch |err| {
                var error_buffer: [192]u8 = undefined;
                const line = std.fmt.bufPrint(&error_buffer, "error: admission failed closed: {s}\n", .{@errorName(err)}) catch "error: admission failed closed\n";
                writeStderr(init.io, line) catch {};
                std.process.exit(1);
            };
            var buffer: [160]u8 = undefined;
            const line = try std.fmt.bufPrint(&buffer, "{s}{s}\n", .{ if (result.created) "" else "(already admitted) ", &result.digest });
            try writeStdout(init.io, line);
            return;
        }
        if (std.mem.eql(u8, sub, "run")) {
            if (args.items.len < 5) {
                try writeStderr(init.io, "error: usage: neuron limb run <state_dir> --package <dir> --neuron <id> --stimulus <file> [--json] [--dump]\n");
                std.process.exit(2);
            }
            const state_dir = args.items[3];
            var package_dir: ?[]const u8 = null;
            var neuron_id: ?[]const u8 = null;
            var stimulus_path: ?[]const u8 = null;
            var json = false;
            var dump = false;
            var i: usize = 4;
            while (i < args.items.len) : (i += 1) {
                if (std.mem.eql(u8, args.items[i], "--json")) {
                    json = true;
                    continue;
                }
                if (std.mem.eql(u8, args.items[i], "--dump")) {
                    dump = true;
                    continue;
                }
                if (i + 1 >= args.items.len) break;
                if (std.mem.eql(u8, args.items[i], "--package")) {
                    package_dir = args.items[i + 1];
                    i += 1;
                } else if (std.mem.eql(u8, args.items[i], "--neuron")) {
                    neuron_id = args.items[i + 1];
                    i += 1;
                } else if (std.mem.eql(u8, args.items[i], "--stimulus")) {
                    stimulus_path = args.items[i + 1];
                    i += 1;
                }
            }
            try limb_ops.limbRun(allocator, init.io, state_dir, package_dir orelse return error.MissingPackage, neuron_id orelse return error.MissingNeuron, stimulus_path orelse return error.MissingStimulus, json, dump);
            return;
        }
        if (std.mem.eql(u8, sub, "revoke")) {
            if (args.items.len < 5 or !std.mem.eql(u8, args.items[4], "--package") or args.items.len < 6) {
                try writeStderr(init.io, "error: usage: neuron limb revoke <state_dir> --package <dir>\n");
                std.process.exit(2);
            }
            limb_ops.revoke(allocator, init.io, args.items[5], args.items[3]) catch |err| {
                var error_buffer: [192]u8 = undefined;
                const line = std.fmt.bufPrint(&error_buffer, "error: revocation failed closed: {s}\n", .{@errorName(err)}) catch "error: revocation failed closed\n";
                writeStderr(init.io, line) catch {};
                std.process.exit(1);
            };
            try writeStdout(init.io, "✓ limb revoked\n");
            return;
        }
        if (std.mem.eql(u8, sub, "detach")) {
            if (args.items.len < 5 or !std.mem.eql(u8, args.items[4], "--package") or args.items.len < 6) {
                try writeStderr(init.io, "error: usage: neuron limb detach <state_dir> --package <dir>\n");
                std.process.exit(2);
            }
            const result = limb_ops.detach(allocator, init.io, args.items[5], args.items[3]) catch |err| {
                var error_buffer: [192]u8 = undefined;
                const line = std.fmt.bufPrint(&error_buffer, "error: detach failed closed: {s}\n", .{@errorName(err)}) catch "error: detach failed closed\n";
                writeStderr(init.io, line) catch {};
                std.process.exit(1);
            };
            var buffer: [128]u8 = undefined;
            const line = try std.fmt.bufPrint(&buffer, "✓ limb detached · {d} artifacts collected\n", .{result.collected});
            try writeStdout(init.io, line);
            return;
        }
        if (std.mem.eql(u8, sub, "inspect")) {
            if (args.items.len < 4) {
                try writeStderr(init.io, "error: usage: neuron limb inspect <state_dir> [--json]\n");
                std.process.exit(2);
            }
            const json_out = args.items.len > 4 and std.mem.eql(u8, args.items[4], "--json");
            try limb_ops.inspect(allocator, init.io, args.items[3], json_out);
            return;
        }
        try writeStderr(init.io, "error: unknown limb subcommand\n");
        std.process.exit(2);
    }
    if (std.mem.eql(u8, args.items[1], "telemetry")) {
        if (args.items.len < 3 or !std.mem.eql(u8, args.items[2], "project")) {
            try writeStderr(init.io, "error: usage: neuron telemetry project <state_dir> [--json]\n");
            std.process.exit(2);
        }
        if (args.items.len < 4) {
            try writeStderr(init.io, "error: missing state_dir\n");
            std.process.exit(2);
        }
        const json_out = args.items.len > 4 and std.mem.eql(u8, args.items[4], "--json");
        limb_ops.telemetryProject(allocator, init.io, args.items[3], json_out) catch |err| {
            var error_buffer: [192]u8 = undefined;
            const line = std.fmt.bufPrint(&error_buffer, "error: telemetry failed: {s}\n", .{@errorName(err)}) catch "error: telemetry failed\n";
            writeStderr(init.io, line) catch {};
            std.process.exit(1);
        };
        return;
    }
    if (std.mem.eql(u8, args.items[1], "run")) {
        var json = false;
        for (args.items[2..]) |arg| {
            if (std.mem.eql(u8, arg, "--json")) json = true;
        }
        var summary = run_mod.run(allocator, init.io, args.items[2..]) catch |err| {
            // A typed rejection is an expected fail-closed outcome, not a
            // crash: report the typed failure and exit 1 without an error
            // return trace.
            var buffer: [256]u8 = undefined;
            const line = std.fmt.bufPrint(&buffer, "error: firing failed closed: {s}\n", .{@errorName(err)}) catch "error: firing failed closed\n";
            writeStderr(init.io, line) catch {};
            std.process.exit(1);
        };
        defer summary.deinit(allocator);
        try run_mod.printSummary(summary, json, init.io);
        return;
    }
    const json = args.items.len > 2 and std.mem.eql(u8, args.items[2], "--json");
    if (std.mem.eql(u8, args.items[1], "meta-agent-check")) {
        const summary = meta_agent.run(allocator) catch |err| {
            var error_buffer: [256]u8 = undefined;
            const line = std.fmt.bufPrint(
                &error_buffer,
                "error: Meta-Agent witness failed closed: {s}\n",
                .{@errorName(err)},
            ) catch "error: Meta-Agent witness failed closed\n";
            try writeStderr(init.io, line);
            return error.MetaAgentCheckFailed;
        };
        var buffer: [4096]u8 = undefined;
        const line = if (json)
            try std.fmt.bufPrint(
                &buffer,
                "{{\"status\":\"ok\",\"package_digest\":\"{x}\",\"final_snapshot_digest\":\"{x}\",\"trace_digest\":\"{x}\",\"admitted_without_authority\":{},\"normalized_and_planned\":{},\"parallel_workers\":{d},\"join_settled\":{},\"false_proposal_rejected\":{},\"recovery_rerouted\":{},\"generated_limb_attached\":{},\"original_work_succeeded\":{},\"duplicate_effects_skipped\":{d},\"stale_cas_rejected\":{},\"replayed_firings\":{d},\"committed_firings\":{d},\"limb_revoked\":{},\"artifacts_collected\":{d},\"audit_roots_readable\":{}}}\n",
                .{
                    summary.package_digest,
                    summary.final_snapshot_digest,
                    summary.trace_digest,
                    summary.admitted_without_authority,
                    summary.normalized_and_planned,
                    summary.parallel_workers,
                    summary.join_settled,
                    summary.false_proposal_rejected,
                    summary.recovery_rerouted,
                    summary.generated_limb_attached,
                    summary.original_work_succeeded,
                    summary.duplicate_effects_skipped,
                    summary.stale_cas_rejected,
                    summary.replayed_firings,
                    summary.committed_firings,
                    summary.limb_revoked,
                    summary.artifacts_collected,
                    summary.audit_roots_readable,
                },
            )
        else
            try std.fmt.bufPrint(
                &buffer,
                "✓ reference Meta-Agent settled through typed Neurons\n  {d} concurrent workers · {d} replayed firings · {d} collected artifacts\n  snapshot {x}\n",
                .{
                    summary.parallel_workers,
                    summary.replayed_firings,
                    summary.artifacts_collected,
                    summary.final_snapshot_digest,
                },
            );
        try writeStdout(init.io, line);
        return;
    }
    if (std.mem.eql(u8, args.items[1], "demo") or std.mem.eql(u8, args.items[1], "check")) {
        const summary = try demo.run(allocator);
        var buffer: [512]u8 = undefined;
        const line = if (json)
            try std.fmt.bufPrint(&buffer, "{{\"status\":\"ok\",\"committed\":{d},\"artifacts\":{d},\"messages\":{d},\"neurons\":{d},\"digest\":\"{x}\"}}\n", .{ summary.committed, summary.artifacts, summary.messages, summary.neurons, summary.digest })
        else
            try std.fmt.bufPrint(&buffer, "✓ firing committed atomically\n  {d} artifact · {d} message · {d} spawned neuron\n  decision {x}\n", .{ summary.artifacts, summary.messages, summary.neurons, summary.digest });
        try writeStdout(init.io, line);
        return;
    }
    try writeStderr(init.io, "error: unknown command; run `neuron --help`\n");
    return error.InvalidCommand;
}

/// In-memory by default; journaled under `<dir>/substrate.log` when a state
/// dir is given — restart then replays the exact committed state (§9/§22).
fn openState(allocator: std.mem.Allocator, io: std.Io, state_dir: ?[]const u8) !substrate_mod.Substrate {
    if (state_dir) |dir| return substrate_mod.Substrate.initDir(allocator, io, std.Io.Dir.cwd(), dir);
    return substrate_mod.Substrate.init(allocator);
}

fn writeStdout(io: std.Io, bytes: []const u8) !void {
    var buffer: [1024]u8 = undefined;
    var writer = std.Io.File.stdout().writer(io, &buffer);
    try writer.interface.writeAll(bytes);
    try writer.interface.flush();
}

fn writeStderr(io: std.Io, bytes: []const u8) !void {
    var buffer: [512]u8 = undefined;
    var writer = std.Io.File.stderr().writer(io, &buffer);
    try writer.interface.writeAll(bytes);
    try writer.interface.flush();
}
