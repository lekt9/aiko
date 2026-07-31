//! The aiko MCP surface — the single API any agent calls.
//!
//! This is the object Hermes mounts. It is one door onto the whole harness:
//! contract's durable ledger on one side, neuron's ports, gaps and reactive
//! pass on the other, exposed as one tool catalog so an agent needs no
//! per-workflow infrastructure.
//!
//! WHY THE PROTOCOL IS BORROWED AND THE CATALOG IS NOT
//!
//! `contract.mcp_server` owns the JSON-RPC wire protocol and states that the
//! host owns substrate dispatch. Its catalog was hardcoded anyway, so a host
//! with verbs of its own had two bad options: edit contract (putting ports and
//! capability gaps into a module that should not know about them), or
//! reimplement the loop (a second protocol to drift from the first). The
//! catalog is now a parameter for the same reason `dispatch` already was. This
//! file supplies both halves and adds no wire code.
//!
//! WHY NEURON VERBS ARE INVOKED, NOT LINKED
//!
//! contract publishes an importable module, so its tools are direct calls.
//! neuron publishes only `typed_neuron` (the wire types) — `serve`, `redrive`
//! and `morphogenesis` are reachable through its CLI, not as a library. That
//! is not an oversight to route around: neuron's standalone CLI is the surface
//! its own gates drive, so invoking it means this door exercises exactly the
//! path the witnesses cover. Reaching into its internals would create a second
//! entry point that no gate tests.

const std = @import("std");
const contract = @import("contract");

const ToolSpec = contract.mcp_server.ToolSpec;
const ToolResult = contract.mcp_server.ToolResult;

/// The catalog. Every entry is backed by something already gated: ports by
/// published-interface-gate, gaps by authored-gap-gate and
/// interface-morphogenesis-gate, redrive by redrive-gate, bridge by
/// bridge-gate. Nothing is exposed here that is not witnessed somewhere.
pub const TOOLS = [_]ToolSpec{
    .{
        .name = "aiko.ledger.read",
        .description = "Read the durable contract ledger: one row by id, or all rows. Every row answers who/what/when/where/why/how or it was refused at write time.",
        .schema =
        \\{"type":"object","properties":{"id":{"type":"string","description":"Contract id; omit to list all"}}}
        ,
    },
    .{
        .name = "aiko.port.publish",
        .description = "Admit a neuron.published-interface/v1 document — the inbound direction. Outbound-only fields are refused on presence, never ignored.",
        .schema =
        \\{"type":"object","properties":{"node":{"type":"string"},"document":{"type":"string","description":"Path to the published interface JSON"}},"required":["node","document"]}
        ,
    },
    .{
        .name = "aiko.port.attach",
        .description = "Bind an admitted contract to an admitted handler limb at /agents/<agent><bind.path>, under a grant derived from (agent, manifest) alone.",
        .schema =
        \\{"type":"object","properties":{"node":{"type":"string"},"agent":{"type":"string"},"published":{"type":"string"},"handler":{"type":"string"}},"required":["node","agent","published","handler"]}
        ,
    },
    .{
        .name = "aiko.gap.resolve",
        .description = "Close a capability gap: reuse an admitted boundary, discover one, or AUTHOR a handler that existed nowhere. Retained only on a verified real-path success.",
        .schema =
        \\{"type":"object","properties":{"node":{"type":"string"},"agent":{"type":"string"},"gap":{"type":"string","description":"Path to a neuron.capability-gap/v1 document"}},"required":["node","agent","gap"]}
        ,
    },
    .{
        .name = "aiko.redrive",
        .description = "The reactive pass. Classifies every stale derivation: re-derivable re-fires under a new firing id; unsettleable escalates to an agent; ALREADY-SENT emits a compensation gap and is never re-fired.",
        .schema =
        \\{"type":"object","properties":{"state_dir":{"type":"string"},"dry_run":{"type":"boolean"}},"required":["state_dir"]}
        ,
    },
    .{
        .name = "aiko.bridge",
        .description = "Mirror committed neuron firings into the contract ledger as W6H-gated rows. Idempotent: contract's own cache resolves a repeat to one row.",
        .schema =
        \\{"type":"object","properties":{"state_dir":{"type":"string"},"agent":{"type":"string"}},"required":["state_dir"]}
        ,
    },
};

fn str(args: std.json.Value, key: []const u8) ?[]const u8 {
    if (args != .object) return null;
    const v = args.object.get(key) orelse return null;
    return if (v == .string) v.string else null;
}

fn missing(a: std.mem.Allocator, field: []const u8) !ToolResult {
    // Name the field. An agent composing a call unattended cannot act on
    // "invalid arguments", which is the whole premise of a single API surface.
    return .{ .text = try std.fmt.allocPrint(a, "missing required argument: {s}", .{field}), .is_error = true };
}

/// The Io this server was started with.
///
/// `DispatchFn` is `(allocator, env, tool_name, args)` — it carries no Io, and
/// `std.process.spawn` needs one. Rather than widen contract's protocol a
/// second time for a purely host-side need, `serve` records it here before the
/// loop starts. Safe because the stdio server is one process handling one
/// request at a time; if that ever stops being true this must become a
/// parameter, not a lock.
var host_io: ?std.Io = null;

/// Run one aiko CLI verb and return its output as the tool result.
///
/// The exit code is the verdict, not the text: every one of these verbs fails
/// closed with a typed error, so a non-zero exit IS the refusal and is reported
/// as one rather than flattened into prose an agent would have to parse.
fn invokeAiko(a: std.mem.Allocator, argv: []const []const u8) !ToolResult {
    const io = host_io orelse return .{
        .text = "no io: the mcp server was not started through serve()",
        .is_error = true,
    };
    var child = std.process.spawn(io, .{
        .argv = argv,
        .stdout = .pipe,
        .stderr = .pipe,
    }) catch |err| return .{
        .text = try std.fmt.allocPrint(a, "could not invoke {s}: {t}", .{ argv[0], err }),
        .is_error = true,
    };
    defer child.kill(io);

    var buf: std.Io.File.MultiReader.Buffer(2) = undefined;
    var mr: std.Io.File.MultiReader = undefined;
    mr.init(a, io, buf.toStreams(), &.{ child.stdout.?, child.stderr.? });
    defer mr.deinit();
    // Bounded like every other boundary crossing here: a CLI verb that hangs
    // must not wedge the door Hermes mounts. Same shape script.zig uses.
    const timeout: std.Io.Timeout = .{ .duration = .{
        .raw = .{ .nanoseconds = 30 * std.time.ns_per_s },
        .clock = .boot,
    } };
    while (mr.fill(64, timeout)) |_| {} else |_| {}

    const out = mr.reader(0).buffered();
    const err_out = mr.reader(1).buffered();
    const term = child.wait(io) catch return .{
        .text = try std.fmt.allocPrint(a, "{s} did not terminate cleanly", .{argv[0]}),
        .is_error = true,
    };
    const ok = term == .exited and term.exited == 0;
    const body = if (out.len > 0) out else err_out;
    return .{ .text = try a.dupe(u8, body), .is_error = !ok };
}

/// The one dispatch. contract tools are direct calls; neuron tools invoke the
/// CLI its own gates drive.
pub fn dispatch(
    a: std.mem.Allocator,
    env: std.process.Environ,
    tool_name: []const u8,
    args: std.json.Value,
) anyerror!ToolResult {
    const exe = "aiko";

    if (std.mem.eql(u8, tool_name, "aiko.ledger.read")) {
        if (str(args, "id")) |id| {
            const blob = contract.get(a, env, id) catch |err| return .{
                .text = try std.fmt.allocPrint(a, "{t}", .{err}),
                .is_error = true,
            };
            return .{ .text = blob, .is_error = false };
        }
        const blob = contract.listAll(a, env) catch |err| return .{
            .text = try std.fmt.allocPrint(a, "{t}", .{err}),
            .is_error = true,
        };
        return .{ .text = blob, .is_error = false };
    }

    if (std.mem.eql(u8, tool_name, "aiko.port.publish")) {
        const node = str(args, "node") orelse return missing(a, "node");
        const doc = str(args, "document") orelse return missing(a, "document");
        return invokeAiko(a, &.{ exe, "port", "publish", node, doc, "--json" });
    }

    if (std.mem.eql(u8, tool_name, "aiko.port.attach")) {
        const node = str(args, "node") orelse return missing(a, "node");
        const agent = str(args, "agent") orelse return missing(a, "agent");
        const pub_hex = str(args, "published") orelse return missing(a, "published");
        const handler = str(args, "handler") orelse return missing(a, "handler");
        return invokeAiko(a, &.{ exe, "port", "attach", node, agent, "--published", pub_hex, "--handler", handler, "--json" });
    }

    if (std.mem.eql(u8, tool_name, "aiko.gap.resolve")) {
        const node = str(args, "node") orelse return missing(a, "node");
        const agent = str(args, "agent") orelse return missing(a, "agent");
        const gap = str(args, "gap") orelse return missing(a, "gap");
        return invokeAiko(a, &.{ exe, "interface", "resolve-gap", node, agent, "--gap", gap, "--json" });
    }

    if (std.mem.eql(u8, tool_name, "aiko.redrive")) {
        const dir = str(args, "state_dir") orelse return missing(a, "state_dir");
        const dry = if (args == .object) args.object.get("dry_run") else null;
        if (dry != null and dry.? == .bool and dry.?.bool)
            return invokeAiko(a, &.{ exe, "redrive", dir, "--dry-run", "--json" });
        return invokeAiko(a, &.{ exe, "redrive", dir, "--json" });
    }

    if (std.mem.eql(u8, tool_name, "aiko.bridge")) {
        const dir = str(args, "state_dir") orelse return missing(a, "state_dir");
        const agent = str(args, "agent") orelse "aiko-bridge";
        return invokeAiko(a, &.{ "aiko-doctor", "bridge", dir, "--agent", agent });
    }

    return .{
        .text = try std.fmt.allocPrint(a, "unknown tool: {s}", .{tool_name}),
        .is_error = true,
    };
}

/// Serve the catalog over stdio. The protocol is contract's; the catalog and
/// the semantics are this file's.
pub fn serve(a: std.mem.Allocator, io: std.Io, env: std.process.Environ) !void {
    host_io = io;
    try contract.mcp_server.runStdio(a, env, .{
        .name = "aiko",
        .title = "Aiko",
        .version = "0.1.0",
        .description = "Meta-fractal harness: durable ledger, served ports, capability gaps, and the reactive pass — one surface.",
    }, &TOOLS, dispatch);
}
