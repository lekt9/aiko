const std = @import("std");
const build_options = @import("build_options");
const demo = @import("demo.zig");
const run_mod = @import("run.zig");
const meta_agent = @import("meta_agent.zig");
const identity = @import("identity.zig");
const mesh_mod = @import("mesh.zig");
const tailnet_mod = @import("tailnet.zig");
const node_mod = @import("node.zig");
const mcp_mod = @import("mcp.zig");
const substrate_mod = @import("substrate.zig");
const limb_ops = @import("limb_ops.zig");
const observe_mod = @import("observe.zig");
const agent_ops = @import("agent_ops.zig");
const membrane = @import("membrane.zig");
const membrane_ops = @import("membrane_ops.zig");
const swarm_ops = @import("swarm_ops.zig");
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
    \\  neuron node init <node_dir> [--listen <ip:port>]
    \\         [--write-prefix <prefix>] [--transport <tailnet|loopback>]
    \\                         create an idempotent node configuration and
    \\                         private stable Ed25519 device identity
    \\  neuron node serve <node_dir>
    \\                         run the configured persistent swarm node
    \\  neuron node id <node_dir> [--json]
    \\                         print its stable public node identity
    \\  neuron node fire <ip:port> --ref <id> --schema <schema>
    \\         --payload <json> --firing <id> [--nonce <u64>]
    \\         [--allow-loopback]
    \\                         deliver one bounded neuron.wire/v1 stimulus;
    \\                         tailnet-only unless loopback is explicit
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
    \\  neuron telemetry trace <state_dir> [--json]
    \\                         per-firing view from the journal: when each
    \\                         firing settled, what it cited, what it wrote
    \\  neuron telemetry serve <state_dir> [--listen <ip:port>]
    \\                         live read-only web view: tails the journal and
    \\                         streams each committed firing over SSE. Loopback
    \\                         only unless --allow-public. Artifact payloads are
    \\                         never streamed - ids, sizes, and citations only
    \\  neuron telemetry stale <state_dir> [--json]
    \\                         artifacts whose cited sources have since been
    \\                         rewritten, and whether each is safely redrivable
    \\                         (writes-only firings are; boundary crossings are not)
    \\  neuron telemetry project <state_dir> [--json]
    \\                         project firing records into a deterministic
    \\                         rollup (firing counts, effects, artifacts)
    \\  neuron agent init <node_dir> <agent_id>
    \\                         genesis firing: manifest, snapshot 0000, and
    \\                         CAS-rooted active pointer in the node substrate
    \\  neuron agent run <node_dir> <agent_id> --goal <text>
    \\         [--acceptance <predicate.json>] [--budget <steps>] [--json]
    \\                         drive one typed goal through the composed stage
    \\                         network (intake→worker→verifier→settler) with
    \\                         settlement-event grounding; replay-safe. Work
    \\                         crosses an attached worker interface when one is
    \\                         attached, else the reference resolution
    \\  neuron agent inspect <node_dir> <agent_id> [--json]
    \\                         reconstruct the agent view from durable state
    \\  neuron agent cancel <node_dir> <agent_id> <workflow|goal-text>
    \\                         settle a not-yet-fired workflow as cancelled
    \\  neuron agent retire <node_dir> <agent_id>
    \\                         CAS-advance the active snapshot to retired
    \\  neuron interface discover <target> [--json]
    \\                         inspect a boundary and report an inert candidate;
    \\                         a read that admits nothing and grants nothing
    \\  neuron interface describe <target> [--kind <k>] [--mode read|command]
    \\         [--id <id>] [--target-template <t>] [--input-channel <c>]
    \\         [--deterministic] [--output <file>]
    \\         remote kinds: [--method <m>] [--url-template <u>] [--tool <t>]
    \\         [--response-encoding raw|json] [--response-field <f>]
    \\         [--non-mutating] [--reconcile-url-template <u>]
    \\                         emit a draft InterfaceManifest with the
    \\                         implementation pinned by digest (inert data)
    \\  neuron interface test <interface.json> [--json]
    \\                         run the contract + adversarial battery without
    \\                         admitting anything
    \\  neuron interface admit <node_dir> <interface.json> [--json]
    \\                         re-pin, re-run the battery, and publish the
    \\                         immutable admission record (the authority step)
    \\  neuron interface list <node_dir> [--json]
    \\  neuron interface attach <node_dir> <agent_id> --interface <digest>
    \\         [--role worker|effector] [--step <n>] [--replace] [--json]
    \\                         wire an admitted interface into an agent role
    \\                         under a derived least-authority grant. Worker
    \\                         steps form an ordered chain: each hop's product
    \\                         is the next hop's input
    \\  neuron interface detach <node_dir> <agent_id> [--role <role>] [--step <n>]
    \\  neuron interface revoke <node_dir> --interface <digest>
    \\  neuron interface call <node_dir> --interface <digest> --input <text>
    \\                         reads invoke now; commands only commit to the
    \\                         outbox and cross the boundary on dispatch
    \\  neuron interface dispatch <node_dir> [--json]
    \\                         drain one outbox record: dispatch, independently
    \\                         reconcile, acknowledge, receipt
    \\  neuron --version       print the build version
    \\  neuron --help          show this help
    \\
;

const swarm_usage =
    \\error: usage: neuron swarm <negotiate|route|reconcile|revoke> <node_dir> ...
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
    if (std.mem.eql(u8, args.items[1], "node")) {
        if (args.items.len < 4) {
            try writeStderr(init.io, "error: usage: neuron node <init|serve|id|fire> ...\n");
            std.process.exit(2);
        }
        const sub = args.items[2];
        if (std.mem.eql(u8, sub, "init")) {
            const node_dir = args.items[3];
            var listen: []const u8 = "0.0.0.0:7331";
            var write_prefix: []const u8 = "artifact/swarm/";
            var transport: node_mod.Transport = .tailnet;
            var i: usize = 4;
            while (i < args.items.len) : (i += 1) {
                if (i + 1 >= args.items.len) {
                    try writeStderr(init.io, "error: node init option needs a value\n");
                    std.process.exit(2);
                }
                const value = args.items[i + 1];
                if (std.mem.eql(u8, args.items[i], "--listen")) {
                    listen = value;
                } else if (std.mem.eql(u8, args.items[i], "--write-prefix")) {
                    write_prefix = value;
                } else if (std.mem.eql(u8, args.items[i], "--transport")) {
                    transport = std.meta.stringToEnum(node_mod.Transport, value) orelse {
                        try writeStderr(init.io, "error: transport must be tailnet or loopback\n");
                        std.process.exit(2);
                    };
                } else {
                    try writeStderr(init.io, "error: unknown node init option\n");
                    std.process.exit(2);
                }
                i += 1;
            }
            node_mod.initNode(allocator, init.io, node_dir, listen, write_prefix, transport) catch |err| {
                var buffer: [192]u8 = undefined;
                const line = std.fmt.bufPrint(&buffer, "error: node init failed closed: {s}\n", .{@errorName(err)}) catch "error: node init failed closed\n";
                try writeStderr(init.io, line);
                std.process.exit(1);
            };
            const id = try node_mod.nodeId(allocator, init.io, node_dir);
            var id_hex: [64]u8 = undefined;
            const line = try std.fmt.allocPrint(
                allocator,
                "{{\"schema\":\"neuron.node/v1\",\"status\":\"ready\",\"node\":\"{s}\",\"dir\":\"{s}\"}}\n",
                .{ identity.nodeIdHex(id, &id_hex), node_dir },
            );
            defer allocator.free(line);
            try writeStdout(init.io, line);
            return;
        }
        if (std.mem.eql(u8, sub, "serve")) {
            node_mod.serve(allocator, init.io, args.items[3]) catch |err| {
                var buffer: [192]u8 = undefined;
                const line = std.fmt.bufPrint(&buffer, "error: node stopped: {s}\n", .{@errorName(err)}) catch "error: node stopped\n";
                try writeStderr(init.io, line);
                std.process.exit(1);
            };
            return;
        }
        if (std.mem.eql(u8, sub, "id")) {
            const id = node_mod.nodeId(allocator, init.io, args.items[3]) catch |err| {
                var buffer: [192]u8 = undefined;
                const line = std.fmt.bufPrint(&buffer, "error: node identity unavailable: {s}\n", .{@errorName(err)}) catch "error: node identity unavailable\n";
                try writeStderr(init.io, line);
                std.process.exit(1);
            };
            var id_hex: [64]u8 = undefined;
            var buffer: [128]u8 = undefined;
            const json_out = args.items.len > 4 and std.mem.eql(u8, args.items[4], "--json");
            const line = if (json_out)
                try std.fmt.bufPrint(&buffer, "{{\"schema\":\"neuron.node-id/v1\",\"node\":\"{s}\"}}\n", .{identity.nodeIdHex(id, &id_hex)})
            else
                try std.fmt.bufPrint(&buffer, "{s}\n", .{identity.nodeIdHex(id, &id_hex)});
            try writeStdout(init.io, line);
            return;
        }
        if (std.mem.eql(u8, sub, "fire")) {
            const address = args.items[3];
            var neuron_ref: ?[]const u8 = null;
            var schema: ?[]const u8 = null;
            var payload: ?[]const u8 = null;
            var firing: ?[]const u8 = null;
            var nonce: ?u64 = null;
            var correlation: []const u8 = "";
            var allow_loopback = false;
            var i: usize = 4;
            while (i < args.items.len) : (i += 1) {
                if (std.mem.eql(u8, args.items[i], "--allow-loopback")) {
                    allow_loopback = true;
                    continue;
                }
                if (i + 1 >= args.items.len) break;
                const value = args.items[i + 1];
                if (std.mem.eql(u8, args.items[i], "--ref")) {
                    neuron_ref = value;
                } else if (std.mem.eql(u8, args.items[i], "--schema")) {
                    schema = value;
                } else if (std.mem.eql(u8, args.items[i], "--payload")) {
                    payload = value;
                } else if (std.mem.eql(u8, args.items[i], "--firing")) {
                    firing = value;
                } else if (std.mem.eql(u8, args.items[i], "--correlation")) {
                    correlation = value;
                } else if (std.mem.eql(u8, args.items[i], "--nonce")) {
                    nonce = std.fmt.parseInt(u64, value, 10) catch {
                        try writeStderr(init.io, "error: nonce must be an unsigned integer\n");
                        std.process.exit(2);
                    };
                } else {
                    try writeStderr(init.io, "error: unknown node fire option\n");
                    std.process.exit(2);
                }
                i += 1;
            }
            const response = node_mod.fireRemote(
                allocator,
                init.io,
                address,
                neuron_ref orelse return error.MissingNeuron,
                schema orelse return error.InvalidSchema,
                payload orelse return error.MissingPayload,
                firing orelse return error.InvalidFiringId,
                nonce,
                allow_loopback,
                correlation,
            ) catch |err| {
                var buffer: [192]u8 = undefined;
                const line = std.fmt.bufPrint(&buffer, "error: remote firing failed closed: {s}\n", .{@errorName(err)}) catch "error: remote firing failed closed\n";
                try writeStderr(init.io, line);
                std.process.exit(1);
            };
            defer allocator.free(response);
            try writeStdout(init.io, response);
            try writeStdout(init.io, "\n");
            return;
        }
        try writeStderr(init.io, "error: unknown node subcommand\n");
        std.process.exit(2);
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
        var writer = std.Io.File.stdout().writerStreaming(init.io, &write_buffer);
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
    if (std.mem.eql(u8, args.items[1], "agent")) {
        if (args.items.len < 5) {
            try writeStderr(init.io, "error: usage: neuron agent <init|run|inspect|cancel|retire> <node_dir> <agent_id> ...\n");
            std.process.exit(2);
        }
        const sub = args.items[2];
        const node_dir = args.items[3];
        const agent_id = args.items[4];
        if (std.mem.eql(u8, sub, "init")) {
            agent_ops.initAgent(allocator, init.io, node_dir, agent_id) catch |err| {
                try failClosed(init.io, "agent init", err);
            };
            var buffer: [192]u8 = undefined;
            const line = try std.fmt.bufPrint(&buffer, "✓ agent initialized · agents/{s}/snapshots/0000\n", .{agent_id});
            try writeStdout(init.io, line);
            return;
        }
        if (std.mem.eql(u8, sub, "run")) {
            var goal: ?[]const u8 = null;
            var acceptance: ?[]const u8 = null;
            var budget: usize = 32;
            var json = false;
            var i: usize = 5;
            while (i < args.items.len) : (i += 1) {
                if (std.mem.eql(u8, args.items[i], "--json")) {
                    json = true;
                    continue;
                }
                if (i + 1 >= args.items.len) break;
                if (std.mem.eql(u8, args.items[i], "--goal")) {
                    goal = args.items[i + 1];
                    i += 1;
                } else if (std.mem.eql(u8, args.items[i], "--acceptance")) {
                    acceptance = args.items[i + 1];
                    i += 1;
                } else if (std.mem.eql(u8, args.items[i], "--budget")) {
                    budget = std.fmt.parseInt(usize, args.items[i + 1], 10) catch {
                        try writeStderr(init.io, "error: --budget must be a positive integer\n");
                        std.process.exit(2);
                    };
                    i += 1;
                }
            }
            const goal_text = goal orelse {
                try writeStderr(init.io, "error: usage: neuron agent run <node_dir> <agent_id> --goal <text> [--acceptance <predicate.json>] [--budget <steps>] [--json]\n");
                std.process.exit(2);
            };
            agent_ops.runGoal(allocator, init.io, node_dir, agent_id, goal_text, budget, acceptance, json) catch |err| {
                try failClosed(init.io, "agent run", err);
            };
            return;
        }
        if (std.mem.eql(u8, sub, "inspect")) {
            const json = args.items.len > 5 and std.mem.eql(u8, args.items[5], "--json");
            agent_ops.inspect(allocator, init.io, node_dir, agent_id, json) catch |err| {
                try failClosed(init.io, "agent inspect", err);
            };
            return;
        }
        if (std.mem.eql(u8, sub, "cancel")) {
            if (args.items.len < 6) {
                try writeStderr(init.io, "error: usage: neuron agent cancel <node_dir> <agent_id> <workflow|goal-text>\n");
                std.process.exit(2);
            }
            agent_ops.cancelGoal(allocator, init.io, node_dir, agent_id, args.items[5]) catch |err| {
                try failClosed(init.io, "agent cancel", err);
            };
            return;
        }
        if (std.mem.eql(u8, sub, "retire")) {
            agent_ops.retire(allocator, init.io, node_dir, agent_id) catch |err| {
                try failClosed(init.io, "agent retire", err);
            };
            return;
        }
        try writeStderr(init.io, "error: unknown agent subcommand\n");
        std.process.exit(2);
    }
    if (std.mem.eql(u8, args.items[1], "swarm")) {
        if (args.items.len < 3) {
            try writeStderr(init.io, swarm_usage);
            std.process.exit(2);
        }
        const sub = args.items[2];
        var flags = try parseFlags(allocator, args.items[3..]);
        defer flags.deinit(allocator);
        const node_dir = flags.positional(0) orelse {
            try writeStderr(init.io, swarm_usage);
            std.process.exit(2);
        };
        if (std.mem.eql(u8, sub, "negotiate")) {
            const agent = flags.positional(1) orelse {
                try writeStderr(init.io, "error: usage: neuron swarm negotiate <node_dir> <agent> --peer <addr> --interface <hex> [--uses N] [--max-writes W] [--max-bytes B]\n");
                std.process.exit(2);
            };
            const peer = flags.value("--peer") orelse {
                try writeStderr(init.io, "error: --peer <host:port> is required\n");
                std.process.exit(2);
            };
            const interface_hex = flags.value("--interface") orelse {
                try writeStderr(init.io, "error: --interface <hex> is required\n");
                std.process.exit(2);
            };
            const uses = if (flags.value("--uses")) |t| std.fmt.parseInt(u32, t, 10) catch 1 else 1;
            const max_writes = if (flags.value("--max-writes")) |t| std.fmt.parseInt(u32, t, 10) catch 1 else 1;
            const max_bytes = if (flags.value("--max-bytes")) |t| std.fmt.parseInt(u64, t, 10) catch 1024 else 1024;
            swarm_ops.negotiate(allocator, init.io, node_dir, agent, peer, interface_hex, uses, max_writes, max_bytes, flags.has("--json")) catch |err| {
                try failClosed(init.io, "swarm negotiate", err);
            };
            return;
        }
        if (std.mem.eql(u8, sub, "route")) {
            const contract_id = flags.value("--contract") orelse {
                try writeStderr(init.io, "error: --contract <id> is required\n");
                std.process.exit(2);
            };
            swarm_ops.route(allocator, init.io, node_dir, contract_id, flags.value("--input") orelse "", flags.has("--json")) catch |err| {
                try failClosed(init.io, "swarm route", err);
            };
            return;
        }
        if (std.mem.eql(u8, sub, "reconcile")) {
            swarm_ops.reconcile(allocator, init.io, node_dir, flags.has("--json")) catch |err| {
                try failClosed(init.io, "swarm reconcile", err);
            };
            return;
        }
        if (std.mem.eql(u8, sub, "revoke")) {
            const contract_id = flags.value("--contract") orelse {
                try writeStderr(init.io, "error: --contract <id> is required\n");
                std.process.exit(2);
            };
            swarm_ops.revoke(allocator, init.io, node_dir, contract_id) catch |err| {
                try failClosed(init.io, "swarm revoke", err);
            };
            return;
        }
        try writeStderr(init.io, swarm_usage);
        std.process.exit(2);
    }
    if (std.mem.eql(u8, args.items[1], "interface")) {
        if (args.items.len < 3) {
            try writeStderr(init.io, interface_usage);
            std.process.exit(2);
        }
        const sub = args.items[2];
        var flags = try parseFlags(allocator, args.items[3..]);
        defer flags.deinit(allocator);

        // Discovery and description are reads: neither opens a substrate.
        if (std.mem.eql(u8, sub, "discover")) {
            const target = flags.positional(0) orelse {
                try writeStderr(init.io, "error: usage: neuron interface discover <target> [--json]\n");
                std.process.exit(2);
            };
            membrane_ops.discover(allocator, init.io, target, flags.has("--json")) catch |err| {
                try failClosed(init.io, "interface discover", err);
            };
            return;
        }
        if (std.mem.eql(u8, sub, "describe")) {
            const target = flags.positional(0) orelse {
                try writeStderr(init.io, "error: usage: neuron interface describe <target> [--kind <kind>] [--id <id>] [--mode read|command] [--target-template <t>] [--output <file>]\n");
                std.process.exit(2);
            };
            var options: membrane.DescribeOptions = .{};
            if (flags.value("--kind")) |text| {
                options.kind = membrane.Kind.parse(text) orelse {
                    try writeStderr(init.io, "error: --kind must be function, process, filesystem, http, mcp, model, device, or human\n");
                    std.process.exit(2);
                };
            }
            if (flags.value("--id")) |text| options.id = text;
            if (flags.value("--mode")) |text| options.mode = membrane.Mode.parse(text);
            if (flags.value("--target-template")) |text| options.target_template = text;
            if (flags.value("--input-channel")) |text| {
                options.input_channel = membrane.InputChannel.parse(text) orelse {
                    try writeStderr(init.io, "error: --input-channel must be none, argv, or stdin\n");
                    std.process.exit(2);
                };
            }
            options.deterministic = flags.has("--deterministic");
            // A remote boundary's identity is its declared contract, so these
            // are declarations by the author, never discoveries.
            if (flags.value("--method")) |text| {
                options.method = membrane.Method.parse(text) orelse {
                    try writeStderr(init.io, "error: --method must be GET, HEAD, POST, PUT, PATCH, or DELETE\n");
                    std.process.exit(2);
                };
            }
            if (flags.value("--url-template")) |text| options.url_template = text;
            if (flags.value("--response-encoding")) |text| {
                options.response_encoding = membrane.ResponseEncoding.parse(text) orelse {
                    try writeStderr(init.io, "error: --response-encoding must be raw or json\n");
                    std.process.exit(2);
                };
            }
            if (flags.value("--response-field")) |text| options.response_field = text;
            if (flags.value("--reconcile-url-template")) |text| options.reconcile_url_template = text;
            if (flags.value("--reconcile-encoding")) |text| {
                options.reconcile_encoding = membrane.ResponseEncoding.parse(text) orelse {
                    try writeStderr(init.io, "error: --reconcile-encoding must be raw or json\n");
                    std.process.exit(2);
                };
            }
            if (flags.value("--reconcile-field")) |text| options.reconcile_field = text;
            if (flags.value("--tool")) |text| options.tool = text;
            // Phase 4: a nondeterministic boundary must declare what produced
            // its answer, and an actuator must name the gate that permits it.
            if (flags.value("--provider")) |text| options.provider = text;
            if (flags.value("--model-name")) |text| options.model_name = text;
            if (flags.value("--protocol")) |text| options.protocol = text;
            if (flags.value("--cost-micros")) |text| {
                options.cost_micros = std.fmt.parseInt(u64, text, 10) catch {
                    try writeStderr(init.io, "error: --cost-micros must be a non-negative integer\n");
                    std.process.exit(2);
                };
            }
            if (flags.value("--device-role")) |text| {
                options.device_role = membrane.DeviceRole.parse(text) orelse {
                    try writeStderr(init.io, "error: --device-role must be sensor or actuator\n");
                    std.process.exit(2);
                };
            }
            if (flags.value("--device-state-template")) |text| options.device_state_template = text;
            if (flags.value("--human-interaction")) |text| {
                options.human_interaction = membrane.HumanInteraction.parse(text) orelse {
                    try writeStderr(init.io, "error: --human-interaction must be approval, review, or annotation\n");
                    std.process.exit(2);
                };
            }
            if (flags.value("--approval-interface")) |text| options.approval_interface = text;
            // Phase 5: economics is an optional profile over an ordinary
            // interface — omitted means `none`, so it can never be enabled by
            // accident.
            if (flags.value("--economics")) |text| {
                options.economics = membrane.Economics.parse(text) orelse {
                    try writeStderr(init.io, "error: --economics must be none or x402\n");
                    std.process.exit(2);
                };
            }
            if (flags.value("--payment-adapter")) |text| options.payment_adapter = text;
            if (flags.value("--payment-approval-interface")) |text|
                options.payment_approval_interface = text;
            if (flags.value("--payment-response-field")) |text| options.payment_response_field = text;
            options.non_mutating = flags.has("--non-mutating");
            if (flags.value("--timeout-ms")) |text| {
                options.timeout_ms = std.fmt.parseInt(u32, text, 10) catch {
                    try writeStderr(init.io, "error: --timeout-ms must be a positive integer\n");
                    std.process.exit(2);
                };
            }
            membrane_ops.describe(allocator, init.io, target, options, flags.value("--output")) catch |err| {
                try failClosed(init.io, "interface describe", err);
            };
            return;
        }
        if (std.mem.eql(u8, sub, "test")) {
            const path = flags.positional(0) orelse {
                try writeStderr(init.io, "error: usage: neuron interface test <interface.json> [--json]\n");
                std.process.exit(2);
            };
            membrane_ops.testInterface(allocator, init.io, path, flags.has("--json")) catch |err| {
                try failClosed(init.io, "interface test", err);
            };
            return;
        }

        // The remaining verbs are writes against a node substrate.
        const node_dir = flags.positional(0) orelse {
            try writeStderr(init.io, interface_usage);
            std.process.exit(2);
        };
        if (std.mem.eql(u8, sub, "resolve-gap")) {
            const agent = flags.positional(1) orelse {
                try writeStderr(init.io, "error: usage: neuron interface resolve-gap <node_dir> <agent> --gap <gap.json> [--role worker|effector] [--step N] [--json]\n");
                std.process.exit(2);
            };
            const gap_path = flags.value("--gap") orelse {
                try writeStderr(init.io, "error: usage: neuron interface resolve-gap <node_dir> <agent> --gap <gap.json>\n");
                std.process.exit(2);
            };
            var gap_role: membrane_ops.Role = .worker;
            if (flags.value("--role")) |text| {
                gap_role = membrane_ops.Role.parse(text) orelse {
                    try writeStderr(init.io, "error: --role must be worker or effector\n");
                    std.process.exit(2);
                };
            }
            var gap_step: usize = 0;
            if (flags.value("--step")) |text| {
                gap_step = std.fmt.parseInt(usize, text, 10) catch {
                    try writeStderr(init.io, "error: --step must be a non-negative integer\n");
                    std.process.exit(2);
                };
            }
            membrane_ops.resolveGap(
                allocator,
                init.io,
                node_dir,
                agent,
                gap_path,
                gap_role,
                gap_step,
                flags.has("--json"),
            ) catch |err| {
                try failClosed(init.io, "interface resolve-gap", err);
            };
            return;
        }
        if (std.mem.eql(u8, sub, "policy")) {
            const path = flags.positional(1) orelse {
                try writeStderr(init.io, "error: usage: neuron interface policy <node_dir> <spending-policy.json> [--json]\n");
                std.process.exit(2);
            };
            membrane_ops.policy(allocator, init.io, node_dir, path, flags.has("--json")) catch |err| {
                try failClosed(init.io, "interface policy", err);
            };
            return;
        }
        if (std.mem.eql(u8, sub, "admit")) {
            const path = flags.positional(1) orelse {
                try writeStderr(init.io, "error: usage: neuron interface admit <node_dir> <interface.json> [--json]\n");
                std.process.exit(2);
            };
            membrane_ops.admit(allocator, init.io, node_dir, path, flags.has("--json")) catch |err| {
                try failClosed(init.io, "interface admit", err);
            };
            return;
        }
        if (std.mem.eql(u8, sub, "list")) {
            membrane_ops.list(allocator, init.io, node_dir, flags.has("--json")) catch |err| {
                try failClosed(init.io, "interface list", err);
            };
            return;
        }
        if (std.mem.eql(u8, sub, "dispatch")) {
            membrane_ops.dispatch(allocator, init.io, node_dir, flags.has("--json")) catch |err| {
                try failClosed(init.io, "interface dispatch", err);
            };
            return;
        }
        if (std.mem.eql(u8, sub, "revoke")) {
            const digest = flags.value("--interface") orelse {
                try writeStderr(init.io, "error: usage: neuron interface revoke <node_dir> --interface <digest>\n");
                std.process.exit(2);
            };
            membrane_ops.revoke(allocator, init.io, node_dir, digest) catch |err| {
                try failClosed(init.io, "interface revoke", err);
            };
            return;
        }
        if (std.mem.eql(u8, sub, "call")) {
            const digest = flags.value("--interface") orelse {
                try writeStderr(init.io, "error: usage: neuron interface call <node_dir> --interface <digest> --input <text> [--json]\n");
                std.process.exit(2);
            };
            const input = flags.value("--input") orelse {
                try writeStderr(init.io, "error: usage: neuron interface call <node_dir> --interface <digest> --input <text> [--json]\n");
                std.process.exit(2);
            };
            membrane_ops.call(allocator, init.io, node_dir, digest, input, flags.has("--json")) catch |err| {
                try failClosed(init.io, "interface call", err);
            };
            return;
        }
        if (std.mem.eql(u8, sub, "attach") or std.mem.eql(u8, sub, "detach")) {
            const agent_id = flags.positional(1) orelse {
                try writeStderr(init.io, "error: usage: neuron interface <attach|detach> <node_dir> <agent_id> [--role worker|effector] ...\n");
                std.process.exit(2);
            };
            const role = membrane_ops.Role.parse(flags.value("--role") orelse "worker") orelse {
                try writeStderr(init.io, "error: --role must be worker or effector\n");
                std.process.exit(2);
            };
            var step: usize = 0;
            if (flags.value("--step")) |text| {
                step = std.fmt.parseInt(usize, text, 10) catch {
                    try writeStderr(init.io, "error: --step must be a non-negative integer\n");
                    std.process.exit(2);
                };
            }
            if (std.mem.eql(u8, sub, "detach")) {
                membrane_ops.detach(allocator, init.io, node_dir, agent_id, role, step) catch |err| {
                    try failClosed(init.io, "interface detach", err);
                };
                return;
            }
            const digest = flags.value("--interface") orelse {
                try writeStderr(init.io, "error: usage: neuron interface attach <node_dir> <agent_id> --interface <digest> [--role worker|effector] [--replace]\n");
                std.process.exit(2);
            };
            membrane_ops.attach(
                allocator,
                init.io,
                node_dir,
                agent_id,
                role,
                step,
                digest,
                flags.has("--replace"),
                flags.has("--json"),
            ) catch |err| {
                try failClosed(init.io, "interface attach", err);
            };
            return;
        }
        try writeStderr(init.io, interface_usage);
        std.process.exit(2);
    }
    if (std.mem.eql(u8, args.items[1], "telemetry")) {
        const is_project = args.items.len >= 3 and std.mem.eql(u8, args.items[2], "project");
        const is_trace = args.items.len >= 3 and std.mem.eql(u8, args.items[2], "trace");
        const is_stale = args.items.len >= 3 and std.mem.eql(u8, args.items[2], "stale");
        const is_serve = args.items.len >= 3 and std.mem.eql(u8, args.items[2], "serve");
        if (!is_project and !is_trace and !is_stale and !is_serve) {
            try writeStderr(init.io, "error: usage: neuron telemetry <project|trace|stale|serve> <state_dir> [--json]\n");
            std.process.exit(2);
        }
        if (args.items.len < 4) {
            try writeStderr(init.io, "error: missing state_dir\n");
            std.process.exit(2);
        }
        if (is_serve) {
            var listen: []const u8 = "127.0.0.1:8787";
            var allow_public = false;
            var i: usize = 4;
            while (i < args.items.len) : (i += 1) {
                if (std.mem.eql(u8, args.items[i], "--listen") and i + 1 < args.items.len) {
                    i += 1;
                    listen = args.items[i];
                } else if (std.mem.eql(u8, args.items[i], "--allow-public")) allow_public = true;
            }
            observe_mod.serve(allocator, init.io, args.items[3], listen, allow_public) catch |err| {
                var eb: [200]u8 = undefined;
                const l = std.fmt.bufPrint(&eb, "error: observe failed: {s}\n", .{@errorName(err)}) catch "error: observe failed\n";
                writeStderr(init.io, l) catch {};
                std.process.exit(1);
            };
            return;
        }
        const json_out = args.items.len > 4 and std.mem.eql(u8, args.items[4], "--json");
        const result = if (is_trace)
            limb_ops.telemetryTrace(allocator, init.io, args.items[3], json_out)
        else if (is_stale)
            limb_ops.telemetryStale(allocator, init.io, args.items[3], json_out)
        else
            limb_ops.telemetryProject(allocator, init.io, args.items[3], json_out);
        result catch |err| {
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

const interface_usage =
    \\error: usage: neuron interface <verb> ...
    \\  discover <target> [--json]
    \\  describe <target> [--kind function|process|filesystem] [--id <id>]
    \\           [--mode read|command] [--target-template <t>] [--output <file>]
    \\  test     <interface.json> [--json]
    \\  admit    <node_dir> <interface.json> [--json]
    \\  list     <node_dir> [--json]
    \\  attach   <node_dir> <agent_id> --interface <digest>
    \\           [--role worker|effector] [--replace] [--json]
    \\  detach   <node_dir> <agent_id> [--role worker|effector]
    \\  revoke   <node_dir> --interface <digest>
    \\  call     <node_dir> --interface <digest> --input <text> [--json]
    \\  dispatch <node_dir> [--json]
    \\
;

/// Flag parsing for the interface verbs: `--key value` pairs, standalone
/// boolean switches, and bare positionals, in any order.
const Flags = struct {
    positionals: std.ArrayList([]const u8),
    keys: std.ArrayList([]const u8),
    values: std.ArrayList([]const u8),
    switches: std.ArrayList([]const u8),

    fn has(self: *const Flags, name: []const u8) bool {
        for (self.switches.items) |item| {
            if (std.mem.eql(u8, item, name)) return true;
        }
        return false;
    }

    fn value(self: *const Flags, name: []const u8) ?[]const u8 {
        for (self.keys.items, self.values.items) |key, item| {
            if (std.mem.eql(u8, key, name)) return item;
        }
        return null;
    }

    fn positional(self: *const Flags, index: usize) ?[]const u8 {
        if (index >= self.positionals.items.len) return null;
        return self.positionals.items[index];
    }

    fn deinit(self: *Flags, allocator: std.mem.Allocator) void {
        self.positionals.deinit(allocator);
        self.keys.deinit(allocator);
        self.values.deinit(allocator);
        self.switches.deinit(allocator);
    }
};

fn parseFlags(allocator: std.mem.Allocator, args: []const []const u8) !Flags {
    const boolean_switches = [_][]const u8{ "--json", "--replace", "--sandbox", "--dump", "--deterministic", "--non-mutating" };
    var flags: Flags = .{
        .positionals = .empty,
        .keys = .empty,
        .values = .empty,
        .switches = .empty,
    };
    var index: usize = 0;
    while (index < args.len) : (index += 1) {
        const arg = args[index];
        if (!std.mem.startsWith(u8, arg, "--")) {
            try flags.positionals.append(allocator, arg);
            continue;
        }
        var is_switch = false;
        for (boolean_switches) |name| {
            if (std.mem.eql(u8, arg, name)) is_switch = true;
        }
        if (is_switch) {
            try flags.switches.append(allocator, arg);
            continue;
        }
        // A trailing `--key` with no value is recorded as a switch so the
        // verb can report a precise usage error rather than reading past the end.
        if (index + 1 >= args.len) {
            try flags.switches.append(allocator, arg);
            continue;
        }
        try flags.keys.append(allocator, arg);
        try flags.values.append(allocator, args[index + 1]);
        index += 1;
    }
    return flags;
}

/// In-memory by default; journaled under `<dir>/substrate.log` when a state
/// dir is given — restart then replays the exact committed state (§9/§22).
fn openState(allocator: std.mem.Allocator, io: std.Io, state_dir: ?[]const u8) !substrate_mod.Substrate {
    if (state_dir) |dir| return substrate_mod.Substrate.initDir(allocator, io, std.Io.Dir.cwd(), dir);
    return substrate_mod.Substrate.init(allocator);
}

fn failClosed(io: std.Io, verb: []const u8, err: anyerror) !noreturn {
    var buffer: [192]u8 = undefined;
    const line = std.fmt.bufPrint(&buffer, "error: {s} failed closed: {s}\n", .{ verb, @errorName(err) }) catch "error: failed closed\n";
    writeStderr(io, line) catch {};
    std.process.exit(1);
}

fn writeStdout(io: std.Io, bytes: []const u8) !void {
    var buffer: [1024]u8 = undefined;
    var writer = std.Io.File.stdout().writerStreaming(io, &buffer);
    try writer.interface.writeAll(bytes);
    try writer.interface.flush();
}

fn writeStderr(io: std.Io, bytes: []const u8) !void {
    var buffer: [512]u8 = undefined;
    var writer = std.Io.File.stderr().writerStreaming(io, &buffer);
    try writer.interface.writeAll(bytes);
    try writer.interface.flush();
}
