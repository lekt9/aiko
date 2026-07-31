//! Automatic interface morphogenesis (§9 / entrypoint plan Phase 6).
//!
//! A typed CapabilityGap goes in; an admitted, attached, and *verified* edge
//! comes out — or nothing does. The order is normative (§9):
//!
//! ```text
//! CapabilityGap
//!   → search admitted InterfaceManifests by schema compatibility
//!   → discover a candidate boundary at an authorized target
//!   → derive an explicit interface schema as an inert artifact
//!   → run contract + adversarial tests
//!   → independently admit the exact implementation + manifest digests
//!   → attach a least-authority edge
//!   → retry the original goal on the real path
//!   → judge the outcome
//!   → retain and rerank, or retire
//! ```
//!
//! Self-building here means self-describing, self-generating, self-testing, and
//! self-proposing *under an admission boundary*. Three refusals are structural
//! rather than advisory:
//!
//!   1. **Reuse is searched before discovery.** An admitted boundary that
//!      already satisfies the gap is used; discovery only runs when reuse
//!      genuinely fails. Generating an adapter for a capability the node
//!      already holds is a defect, not an optimization.
//!   2. **Nothing is retained on compilation alone.** A generated adapter that
//!      admits and attaches but does not satisfy the gap on the real path is
//!      revoked and detached — admission is not success.
//!   3. **Rankings are learned only from verified results.** A PatternRecord is
//!      written *after* the real-path retry succeeds, never before, so the
//!      ranking cannot be trained by an interface that never worked.
//!
//! "Generate" means deriving a complete, inert adapter manifest for a
//! discovered boundary and its declared schema — not synthesizing code. A
//! synthesized implementation could not be pinned to bytes that existed before
//! the pin, which is the property every admission depends on.

const std = @import("std");
const types = @import("types.zig");
const membrane = @import("membrane.zig");
const membrane_ops = @import("membrane_ops.zig");
const substrate_mod = @import("substrate.zig");
const runtime_mod = @import("runtime.zig");

const Allocator = std.mem.Allocator;

pub const GAP_SCHEMA = "neuron.capability-gap/v1";
pub const PATTERN_SCHEMA = "neuron.pattern-record/v1";
pub const RESULT_SCHEMA = "neuron.morphogenesis-result/v1";

pub const PATTERN_PREFIX = "interfaces/patterns/";

pub const Error = error{
    /// The document is not a `neuron.capability-gap/v1` object, or a required
    /// typed field is absent.
    InvalidCapabilityGap,
    /// Neither reuse nor discovery produced a boundary that satisfies the gap.
    CapabilityGapUnresolved,
    /// A candidate was admitted and attached but failed the gap on the real
    /// path. It has been retired; nothing is retained.
    GeneratedAdapterRetired,
};

/// What the agent needs but does not have. The gap declares both the shape it
/// requires *and* how to tell whether a candidate really satisfies it — a gap
/// with no acceptance could be "resolved" by anything that returned bytes.
pub const CapabilityGap = struct {
    id: []const u8,
    need: []const u8,
    accepts: []const []const u8,
    emits: []const []const u8,
    /// Where discovery is authorized to look. Discovery never roams: it
    /// inspects exactly this target and nothing else.
    discovery_target: []const u8,
    discovery_kind: membrane.Kind,
    /// The real-path probe and its acceptance. This is what "judge the outcome"
    /// judges, for both a reused and a generated boundary.
    probe_input: []const u8,
    expect_contains: []const u8,

    pub fn parse(a: Allocator, bytes: []const u8) !CapabilityGap {
        const root = std.json.parseFromSliceLeaky(std.json.Value, a, bytes, .{}) catch
            return Error.InvalidCapabilityGap;
        if (root != .object) return Error.InvalidCapabilityGap;
        const schema = str(root, "schema") orelse return Error.InvalidCapabilityGap;
        if (!std.mem.eql(u8, schema, GAP_SCHEMA)) return Error.InvalidCapabilityGap;

        const kind_text = str(root, "discovery_kind") orelse return Error.InvalidCapabilityGap;
        const gap: CapabilityGap = .{
            .id = str(root, "id") orelse return Error.InvalidCapabilityGap,
            .need = str(root, "need") orelse return Error.InvalidCapabilityGap,
            .accepts = try strings(a, root, "accepts"),
            .emits = try strings(a, root, "emits"),
            .discovery_target = str(root, "discovery_target") orelse return Error.InvalidCapabilityGap,
            .discovery_kind = membrane.Kind.parse(kind_text) orelse return Error.InvalidCapabilityGap,
            .probe_input = str(root, "probe_input") orelse return Error.InvalidCapabilityGap,
            .expect_contains = str(root, "expect_contains") orelse return Error.InvalidCapabilityGap,
        };
        if (gap.id.len == 0 or gap.accepts.len == 0 or gap.emits.len == 0)
            return Error.InvalidCapabilityGap;
        // An acceptance-free gap is unfalsifiable: anything returning bytes
        // would "satisfy" it. Refuse it rather than resolve it meaninglessly.
        if (gap.expect_contains.len == 0) return Error.InvalidCapabilityGap;
        return gap;
    }

    /// Stable, path-safe identity for the gap's durable pattern record.
    pub fn slug(self: *const CapabilityGap) [64]u8 {
        return std.fmt.bytesToHex(types.digest(self.id), .lower);
    }
};

pub const Route = enum {
    /// An already-admitted interface satisfied the gap.
    reused,
    /// No admitted interface did, so one was derived, tested, and admitted.
    generated,
    /// Nothing existed to discover, so a handler was WRITTEN inert from the
    /// bounded transform catalogue, then tested and admitted like any other.
    authored,

    pub fn name(self: Route) []const u8 {
        return @tagName(self);
    }
};

pub const Resolution = struct {
    route: Route,
    interface_hex: [64]u8,
    verified: bool,
    /// How many verified successes this pattern has accumulated. Only ever
    /// incremented by a real-path success.
    successes: u64,
    result_digest: [64]u8,
};

fn str(value: std.json.Value, key: []const u8) ?[]const u8 {
    if (value != .object) return null;
    const field = value.object.get(key) orelse return null;
    return switch (field) {
        .string => |text| text,
        else => null,
    };
}

fn strings(a: Allocator, value: std.json.Value, key: []const u8) ![]const []const u8 {
    if (value != .object) return &.{};
    const field = value.object.get(key) orelse return &.{};
    if (field != .array) return &.{};
    var out: std.ArrayList([]const u8) = .empty;
    for (field.array.items) |item| {
        if (item != .string) continue;
        try out.append(a, item.string);
    }
    return out.toOwnedSlice(a);
}

fn declares(haystack: []const []const u8, needle: []const u8) bool {
    for (haystack) |item| if (std.mem.eql(u8, item, needle)) return true;
    return false;
}

/// Schema compatibility: every schema the gap requires must be one the
/// candidate declares. Names alone never establish this — the manifest's own
/// typed surface does (§9, "never inventing schemas solely from names").
fn compatible(gap: *const CapabilityGap, manifest: *const membrane.Manifest) bool {
    if (manifest.invocation.mode != .read) return false;
    for (gap.accepts) |needed| if (!declares(manifest.accepts, needed)) return false;
    for (gap.emits) |needed| if (!declares(manifest.emits, needed)) return false;
    return true;
}

/// Does this boundary actually do the job? Invoked on the real path with the
/// gap's own probe, and judged against the gap's own acceptance. A candidate
/// that merely resolves, compiles, or type-checks has proven nothing.
fn satisfies(
    a: Allocator,
    io: std.Io,
    gap: *const CapabilityGap,
    manifest: *const membrane.Manifest,
    digest_out: ?*[64]u8,
) bool {
    const outcome = membrane.invokeRead(a, io, manifest, gap.probe_input) catch return false;
    if (digest_out) |slot| slot.* = std.fmt.bytesToHex(outcome.output_digest, .lower);
    return std.mem.indexOf(u8, outcome.output, gap.expect_contains) != null;
}

/// The admissible input shapes for a kind, in the order they are tried. This
/// is a *bounded* search over shapes the membrane already validates — never an
/// open-ended synthesis, so every candidate is a manifest the parser would have
/// accepted anyway.
fn channelVariants(kind: membrane.Kind) []const membrane.InputChannel {
    return switch (kind) {
        // A process may read its input as one whole argv element or on stdin;
        // which one is a property of the executable, discoverable only by
        // asking it.
        .process => &.{ .argv, .stdin },
        .function => &.{.stdin},
        .filesystem, .device, .human => &.{.argv},
        // A remote boundary carries its input inside the declared contract.
        .http, .mcp, .model => &.{.none},
    };
}

fn patternId(a: Allocator, gap: *const CapabilityGap) ![]const u8 {
    return std.fmt.allocPrint(a, PATTERN_PREFIX ++ "{s}", .{gap.slug()[0..]});
}

/// Read the accumulated verified-success count for this gap, if any.
fn patternSuccesses(
    a: Allocator,
    substrate: *const substrate_mod.Substrate,
    gap: *const CapabilityGap,
    interface_hex: []const u8,
) u64 {
    const id = patternId(a, gap) catch return 0;
    const artifact = substrate.artifacts.get(id) orelse return 0;
    const record = std.json.parseFromSliceLeaky(std.json.Value, a, artifact.bytes, .{}) catch return 0;
    if (record != .object) return 0;
    const iface = str(record, "interface") orelse return 0;
    // A pattern belongs to one interface. A different boundary starts its own
    // record rather than inheriting a ranking it never earned.
    if (!std.mem.eql(u8, iface, interface_hex)) return 0;
    const count = record.object.get("verified_successes") orelse return 0;
    if (count != .integer or count.integer < 0) return 0;
    return @intCast(count.integer);
}

/// Record a *verified* result. Called only after the real-path retry succeeded,
/// so the ranking can never be trained by a boundary that did not work.
fn recordPattern(
    a: Allocator,
    substrate: *substrate_mod.Substrate,
    gap: *const CapabilityGap,
    interface_hex: []const u8,
    result_digest: []const u8,
    successes: u64,
) !void {
    const id = try patternId(a, gap);
    const prior = substrate.artifacts.get(id);
    const record = try std.json.Stringify.valueAlloc(a, .{
        .schema = PATTERN_SCHEMA,
        .gap = gap.id,
        .need = gap.need,
        .interface = interface_hex,
        .verified_successes = successes,
        .last_result_digest = result_digest,
    }, .{});
    var fx = [_]types.Effect{
        .{ .write = .{
            .id = id,
            .schema = PATTERN_SCHEMA,
            .bytes = record,
            .expected_prior = if (prior) |p| p.digest else null,
        } },
    };
    // The firing names the transition, so a repeated success is a new firing
    // rather than a collision with the one that first recorded the pattern.
    const firing_id = try std.fmt.allocPrint(a, "interface/pattern/{s}/{d}", .{
        gap.slug()[0..],
        successes,
    });
    const runtime: runtime_mod.Runtime = .{ .substrate = substrate };
    _ = runtime.execute(.{
        .firing_id = firing_id,
        .receptor_schema = PATTERN_SCHEMA,
    }, patternCaps(), .{
        .control = .{ .terminate = "verified" },
        .effects = &fx,
        .evidence = try evidence(
            a,
            "an interface satisfied this capability gap on the real path",
            "gap probe invoked and judged against the gap's declared acceptance",
        ),
    }) catch |err| switch (err) {
        error.FiringAlreadySettled, error.FiringMismatch => {},
        else => return err,
    };
}

fn patternCaps() @import("caps.zig").Caps {
    return .{
        .allow_write = true,
        .write_prefix = PATTERN_PREFIX,
        .allow_send = true,
        .send_prefix = "event/",
        .budget = .{ .max_effects = 8, .max_writes = 4, .max_messages = 4 },
    };
}

const pattern_sources = [_][]const u8{"stimulus"};

fn evidence(a: Allocator, claim: []const u8, method: []const u8) ![]types.Evidence {
    const items = try a.alloc(types.Evidence, 1);
    items[0] = .{ .claim = claim, .sources = &pattern_sources, .method = method };
    return items;
}

/// Search the admitted interfaces for one that already satisfies the gap.
/// Ranked by accumulated verified successes, so a boundary that has actually
/// worked before is preferred over one that merely type-matches.
fn searchAdmitted(
    a: Allocator,
    io: std.Io,
    substrate: *substrate_mod.Substrate,
    gap: *const CapabilityGap,
    digest_out: *[64]u8,
) ?[64]u8 {
    var best: ?[64]u8 = null;
    var best_rank: u64 = 0;
    var best_digest: [64]u8 = @splat('0');

    var iterator = substrate.artifacts.iterator();
    while (iterator.next()) |entry| {
        const id = entry.key_ptr.*;
        if (!std.mem.startsWith(u8, id, membrane_ops.ADMITTED_PREFIX)) continue;
        const hex = id[membrane_ops.ADMITTED_PREFIX.len..];
        if (hex.len != 64) continue;
        // A revoked interface resolves as an error, so retired boundaries fall
        // out of the search without a separate check.
        const manifest = membrane_ops.resolveAdmitted(a, substrate, hex) catch continue;
        if (!compatible(gap, &manifest)) continue;

        var candidate_digest: [64]u8 = @splat('0');
        if (!satisfies(a, io, gap, &manifest, &candidate_digest)) continue;

        const rank = patternSuccesses(a, substrate, gap, hex);
        if (best == null or rank > best_rank) {
            var buf: [64]u8 = undefined;
            @memcpy(&buf, hex);
            best = buf;
            best_rank = rank;
            best_digest = candidate_digest;
        }
    }
    if (best) |_| digest_out.* = best_digest;
    return best;
}

/// Resolve one capability gap end to end.
///
/// Reuse first, then discovery. A generated adapter that admits and attaches
/// but fails the gap on the real path is revoked and detached before returning
/// — admission is never treated as success.
/// Where an authored handler's bytes land before they are pinned.
///
/// They are written to disk FIRST and admitted afterwards, which is the whole
/// reason authoring is allowed at all: admission pins bytes that existed before
/// the pin. Generation and admission are separate steps, so an authored handler
/// is evidence-bearing in exactly the way a discovered one is.
pub const AUTHORED_DIR = ".aiko/authored";

/// The bounded transform catalogue.
///
/// This is the load-bearing refusal of the whole authoring path, so it is worth
/// stating plainly: a handler is chosen from transforms written AHEAD OF TIME,
/// never synthesised from the gap's acceptance string.
///
/// The difference is not stylistic. A gap declares its acceptance as
/// `expect_contains`, so a handler synthesised to satisfy it could simply print
/// that string and pass — closing the gap while doing nothing. That is the
/// fabrication every other refusal in this substrate exists to prevent, and
/// authoring would be the one door left open.
///
/// So authoring is a bounded search over real transforms, exactly as
/// `channelVariants` is a bounded search over real input shapes (§9 forbids
/// inventing a contract from a name). Each entry computes something from its
/// input. None of them reads the gap. A candidate still has to pass the
/// battery and then satisfy the gap on the real path, so a transform that
/// happens not to fit is simply not chosen.
const Transform = struct {
    id: []const u8,
    /// A complete, self-contained script. It receives the probe input on argv
    /// and writes its product to stdout.
    body: []const u8,
};

const CATALOGUE = [_]Transform{
    .{ .id = "identity", .body = "import sys\nsys.stdout.write(sys.argv[1] if len(sys.argv)>1 else '')\n" },
    .{ .id = "upper", .body = "import sys\nsys.stdout.write((sys.argv[1] if len(sys.argv)>1 else '').upper())\n" },
    .{ .id = "lower", .body = "import sys\nsys.stdout.write((sys.argv[1] if len(sys.argv)>1 else '').lower())\n" },
    .{ .id = "trim", .body = "import sys\nsys.stdout.write((sys.argv[1] if len(sys.argv)>1 else '').strip())\n" },
    .{ .id = "collapse-ws", .body = "import sys\nsys.stdout.write(' '.join((sys.argv[1] if len(sys.argv)>1 else '').split()))\n" },
    .{ .id = "reverse", .body = "import sys\nsys.stdout.write((sys.argv[1] if len(sys.argv)>1 else '')[::-1])\n" },
    .{ .id = "sha256", .body = "import sys,hashlib\nsys.stdout.write(hashlib.sha256((sys.argv[1] if len(sys.argv)>1 else '').encode()).hexdigest())\n" },
    .{ .id = "json-compact", .body = "import sys,json\nsys.stdout.write(json.dumps(json.loads(sys.argv[1]),separators=(',',':')))\n" },
};

/// Write one catalogue transform to disk as an inert executable and return its
/// path. Inert means exactly that: bytes on disk that nothing has admitted, so
/// nothing may run them through the membrane until `admitCore` pins them.
fn authorCandidate(
    a: Allocator,
    io: std.Io,
    slug: []const u8,
    t: Transform,
) ![]const u8 {
    const dir = try std.fmt.allocPrint(a, "{s}/{s}", .{ AUTHORED_DIR, slug });
    std.Io.Dir.cwd().createDirPath(io, dir) catch {};

    // The locator MUST be absolute: `membrane.zig:726` refuses a relative one
    // with `InterfaceBoundaryUnusable`, because a manifest whose meaning
    // depends on the caller's working directory is not pinned to anything. This
    // Zig's std exposes no cwd accessor, so reach for libc the same way
    // `mesh.zig` does.
    var cwd_buf: [std.fs.max_path_bytes]u8 = undefined;
    if (std.c.getcwd(&cwd_buf, cwd_buf.len) == null) return Error.CapabilityGapUnresolved;
    const cwd_path = std.mem.sliceTo(&cwd_buf, 0);
    const path = try std.fmt.allocPrint(a, "{s}/{s}/{s}.py", .{ cwd_path, dir, t.id });

    const script = try std.fmt.allocPrint(a, "#!/usr/bin/env python3\n{s}", .{t.body});
    var file = try std.Io.Dir.cwd().createFile(io, path, .{});
    defer file.close(io);
    var wbuf: [4096]u8 = undefined;
    var fw = file.writerStreaming(io, &wbuf);
    try fw.interface.writeAll(script);
    try fw.interface.flush();
    // A process boundary is executed, so the authored bytes must carry the
    // executable bit or the membrane cannot invoke what it just pinned.
    file.setPermissions(io, .executable_file) catch {};
    return path;
}

/// Close a gap by WRITING a handler when there was nothing to discover.
///
/// This is the join between the substrate's two existing halves. Self-wiring
/// (discover a boundary that already declares a schema) and self-writing (write
/// a limb inert, admit it by digest) were both witnessed and never connected:
/// if nothing out there satisfied a gap, the loop retired it rather than
/// authoring what would close it.
///
/// The order is unchanged from the discovered path — draft inert, run the
/// battery, probe the real path — because an authored candidate earns
/// admission the same way or not at all.
fn authorHandler(
    a: Allocator,
    io: std.Io,
    gap: *const CapabilityGap,
    digest_out: *[64]u8,
) ?[]u8 {
    // Authoring produces a local executable, so it can only answer a gap whose
    // boundary is a process. Anything else would be authoring a manifest for a
    // boundary that does not exist — a pin over nothing.
    if (gap.discovery_kind != .process) return null;

    const slug = gap.slug();
    for (CATALOGUE) |t| {
        const path = authorCandidate(a, io, &slug, t) catch continue;
        for (channelVariants(.process)) |channel| {
            const draft = membrane.describe(a, io, path, .{
                .kind = .process,
                .mode = .read,
                .input_channel = channel,
            }) catch continue;
            const parsed = membrane.parseManifest(a, draft) catch continue;
            const checks = membrane_ops.runBattery(a, io, &parsed) catch continue;
            if (!membrane_ops.batteryPassed(checks)) continue;
            if (!satisfies(a, io, gap, &parsed, digest_out)) continue;
            return draft;
        }
    }
    return null;
}

pub fn resolveGap(
    a: Allocator,
    io: std.Io,
    substrate: *substrate_mod.Substrate,
    agent: []const u8,
    role: membrane_ops.Role,
    step: usize,
    gap: *const CapabilityGap,
) !Resolution {
    var result_digest: [64]u8 = @splat('0');

    // 1. Reuse before discovery.
    if (searchAdmitted(a, io, substrate, gap, &result_digest)) |hex| {
        _ = membrane_ops.attachCore(a, io, substrate, agent, role, step, &hex, true) catch |err| switch (err) {
            // Already wired for this role: the edge exists, which is the state
            // this step is trying to reach.
            membrane_ops.Error.InterfaceRoleOccupied => {},
            else => return err,
        };
        const successes = patternSuccesses(a, substrate, gap, &hex) + 1;
        try recordPattern(a, substrate, gap, &hex, &result_digest, successes);
        return .{
            .route = .reused,
            .interface_hex = hex,
            .verified = true,
            .successes = successes,
            .result_digest = result_digest,
        };
    }

    // 2. Discover exactly the authorized target — never roam. A target that
    //    does not exist is not fatal any more: it is the case authoring exists
    //    for, and it is handled after the draft loop.
    const discovered = membrane.discover(a, io, gap.discovery_target) catch null;

    // 3. Derive the explicit interface schema. How a boundary takes its input
    //    is part of its contract and cannot be read off its name (§9 forbids
    //    inventing schemas from names), so it is established by bounded
    //    experiment: draft each admissible shape as an inert artifact, and keep
    //    the one that both passes the battery and actually satisfies the gap.
    const variants = channelVariants(gap.discovery_kind);
    var chosen: ?[]u8 = null;
    var route: Route = .generated;
    if (discovered != null) for (variants) |channel| {
        const draft = membrane.describe(a, io, gap.discovery_target, .{
            .kind = gap.discovery_kind,
            .mode = .read,
            .input_channel = channel,
        }) catch continue;
        const parsed = membrane.parseManifest(a, draft) catch continue;
        // A draft that cannot pass its own contract + adversarial battery is
        // never a candidate, whatever it would have produced.
        const checks = membrane_ops.runBattery(a, io, &parsed) catch continue;
        if (!membrane_ops.batteryPassed(checks)) continue;
        if (!satisfies(a, io, gap, &parsed, &result_digest)) continue;
        chosen = draft;
        break;
    };

    // 3b. Nothing to discover, or nothing discovered satisfied the gap. AUTHOR
    //     one. This is the only path that creates a boundary which did not
    //     exist anywhere; everything after it is identical, because an authored
    //     handler earns admission exactly as a discovered one does.
    if (chosen == null) {
        chosen = authorHandler(a, io, gap, &result_digest);
        if (chosen != null) route = .authored;
    }
    const draft = chosen orelse return Error.CapabilityGapUnresolved;

    // 4/5. Test and admit. `admitCore` runs the battery again itself and
    //      refuses the manifest if it fails, so a candidate cannot reach
    //      attachment untested.
    const admitted = membrane_ops.admitCore(a, io, substrate, draft) catch
        return Error.CapabilityGapUnresolved;
    const hex = admitted.manifest_digest;

    // 6. Attach a least-authority edge. `attachCore` computes the grant; the
    //    adapter never names its own authority and never inherits the
    //    generator's.
    _ = membrane_ops.attachCore(a, io, substrate, agent, role, step, &hex, true) catch |err| switch (err) {
        membrane_ops.Error.InterfaceRoleOccupied => {},
        else => return err,
    };

    // 7/8. Retry the original goal on the real path and judge it.
    const manifest = try membrane_ops.resolveAdmitted(a, substrate, &hex);
    if (!satisfies(a, io, gap, &manifest, &result_digest)) {
        // 9. Retire. Nothing is retained on compilation alone: the edge is
        //    withdrawn and the interface revoked, and no pattern is recorded.
        _ = membrane_ops.detachCore(a, substrate, agent, role, step) catch {};
        membrane_ops.revokeCore(a, substrate, &hex) catch {};
        return Error.GeneratedAdapterRetired;
    }

    try recordPattern(a, substrate, gap, &hex, &result_digest, 1);
    return .{
        .route = route,
        .interface_hex = hex,
        .verified = true,
        .successes = 1,
        .result_digest = result_digest,
    };
}
