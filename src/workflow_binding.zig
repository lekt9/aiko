//! Bind a Cell workflow into a Contract walk.
//!
//! Cell remains standalone: this module does not import it, and does not
//! reimplement its builder. It asks Cell for the canonical JSON (the same
//! `run.py build` path its own gates drive), then projects organelles and
//! wiring into the walk shape `graph-plan` already analyzes.
//!
//! This is an observer. It does not schedule, fire, or keep a second ledger.

const std = @import("std");
const contract_graph_analyzer = @import("contract_graph_analyzer");

const Allocator = std.mem.Allocator;

pub const BindError = error{
    CellRunnerMissing,
    CellBuildFailed,
    InvalidCell,
    ControlMissing,
};

fn fileExists(io: std.Io, path: []const u8) bool {
    _ = std.Io.Dir.cwd().statFile(io, path, .{}) catch return false;
    return true;
}

/// Locate Cell's canonical runner. Deployment may pin `AIKO_CELL_RUNNER`.
/// A source checkout may use `cell/run.py`. Never invent a second builder.
pub fn findCellRunner(io: std.Io, a: Allocator) ![]const u8 {
    if (std.c.getenv("AIKO_CELL_RUNNER")) |pinned_z| {
        const pinned = std.mem.span(pinned_z);
        if (pinned.len > 0) return try a.dupe(u8, pinned);
    }
    const candidates = [_][]const u8{
        "cell/run.py",
        "../cell/run.py",
        "../../cell/run.py",
    };
    for (candidates) |rel| {
        if (fileExists(io, rel)) return try a.dupe(u8, rel);
    }
    return error.CellRunnerMissing;
}

/// Run Cell's builder and return canonical JSON + definition digest.
pub fn buildCell(init: std.process.Init, a: Allocator, cell_path: []const u8) !struct { canonical: []u8, digest: []u8 } {
    const runner = findCellRunner(init.io, a) catch return error.CellRunnerMissing;
    const abs_cell = std.Io.Dir.cwd().realPathFileAlloc(init.io, cell_path, a) catch return error.InvalidCell;
    const argv = [_][]const u8{ "python3", runner, "build", abs_cell };
    var child = std.process.spawn(init.io, .{
        .argv = &argv,
        .stdout = .pipe,
        .stderr = .pipe,
    }) catch return error.CellBuildFailed;
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

    const out = mr.reader(0).buffered();
    const err_out = mr.reader(1).buffered();
    const term = child.wait(init.io) catch return error.CellBuildFailed;
    if (term != .exited or term.exited != 0) return error.CellBuildFailed;

    const canonical = std.mem.trim(u8, out, " \t\r\n");
    if (canonical.len == 0) return error.InvalidCell;
    const digest = digestFromBuild(a, err_out, canonical);
    return .{ .canonical = try a.dupe(u8, canonical), .digest = digest };
}

fn digestFromBuild(a: Allocator, stderr: []const u8, canonical: []const u8) []u8 {
    var it = std.mem.splitScalar(u8, stderr, '\n');
    while (it.next()) |line| {
        const needle = "# digest:";
        if (std.mem.indexOf(u8, line, needle)) |at| {
            const rest = std.mem.trim(u8, line[at + needle.len ..], " \t");
            var end: usize = 0;
            while (end < rest.len and std.ascii.isHex(rest[end])) end += 1;
            if (end >= 16) return a.dupe(u8, rest[0..end]) catch hashedDigest(a, canonical);
        }
    }
    return hashedDigest(a, canonical);
}

fn hashedDigest(a: Allocator, canonical: []const u8) []u8 {
    var h: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(canonical, &h, .{});
    const hex = a.alloc(u8, 64) catch return a.dupe(u8, "") catch "";
    const digits = "0123456789abcdef";
    for (h, 0..) |b, i| {
        hex[i * 2] = digits[b >> 4];
        hex[i * 2 + 1] = digits[b & 0xf];
    }
    return hex;
}

const Node = struct {
    id: []const u8,
    plan: []const u8,
    deps: std.ArrayList([]const u8),
};

/// Project a Cell's canonical JSON into a Contract walk. Organelles become
/// nodes; child→child wiring becomes depends_on. Membrane edges are ports,
/// not nodes. A leaf Cell is one node named after itself.
pub fn projectWalk(a: Allocator, canonical: []const u8, digest: []const u8, cell_path: []const u8) ![]u8 {
    _ = digest;
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, a, canonical, .{}) catch return error.InvalidCell;
    if (parsed != .object) return error.InvalidCell;
    const meta = parsed.object.get("metadata") orelse return error.InvalidCell;
    if (meta != .object) return error.InvalidCell;
    const name = str(meta, "name") orelse return error.InvalidCell;
    const description = str(meta, "description") orelse name;
    const spec = parsed.object.get("spec") orelse return error.InvalidCell;
    if (spec != .object) return error.InvalidCell;

    var nodes: std.ArrayList(Node) = .empty;
    if (spec.object.get("organelles")) |orgs| {
        if (orgs == .array) {
            for (orgs.array.items) |org| {
                if (org != .object) continue;
                const id = str(org, "name") orelse continue;
                const plan = str(org, "cell") orelse str(org, "description") orelse id;
                try nodes.append(a, .{ .id = id, .plan = plan, .deps = .empty });
            }
        }
    }
    if (nodes.items.len == 0) {
        try nodes.append(a, .{ .id = name, .plan = description, .deps = .empty });
    }

    if (spec.object.get("wiring")) |wiring| {
        if (wiring == .array) {
            for (wiring.array.items) |edge| {
                if (edge != .object) continue;
                const from = str(edge, "from") orelse continue;
                const to = str(edge, "to") orelse continue;
                const sn = nodeOf(from);
                const dn = nodeOf(to);
                if (indexOf(nodes.items, sn)) |_| {
                    if (indexOf(nodes.items, dn)) |di| {
                        if (!std.mem.eql(u8, sn, dn)) try addDep(&nodes.items[di].deps, a, sn);
                    }
                }
            }
        }
    }

    _ = cell_path;
    var buf: std.ArrayList(u8) = .empty;
    try buf.appendSlice(a, "{\"north_star\":");
    try jsonStr(&buf, a, description);
    try buf.appendSlice(a, ",\"nodes\":[");
    for (nodes.items, 0..) |n, i| {
        if (i != 0) try buf.appendSlice(a, ",");
        try buf.appendSlice(a, "{\"id\":");
        try jsonStr(&buf, a, n.id);
        try buf.appendSlice(a, ",\"plan\":");
        try jsonStr(&buf, a, n.plan);
        try buf.appendSlice(a, ",\"depends_on\":[");
        std.mem.sort([]const u8, n.deps.items, {}, struct {
            fn less(_: void, l: []const u8, r: []const u8) bool {
                return std.mem.lessThan(u8, l, r);
            }
        }.less);
        for (n.deps.items, 0..) |d, j| {
            if (j != 0) try buf.appendSlice(a, ",");
            try jsonStr(&buf, a, d);
        }
        try buf.appendSlice(a,
            \\],"status":"pending","reads":[],"writes":["out/
        );
        try buf.appendSlice(a, n.id);
        try buf.appendSlice(a,
            \\.json"],"invoke_skills":["cell"],"inspire_from":["src:cell"],"capability_gaps":[],"witness":"test -s out/
        );
        try buf.appendSlice(a, n.id);
        try buf.appendSlice(a, ".json\"}");
    }
    try buf.appendSlice(a, "]}");
    return buf.toOwnedSlice(a);
}

fn nodeOf(endpoint: []const u8) []const u8 {
    const dot = std.mem.indexOfScalar(u8, endpoint, '.') orelse return endpoint;
    return endpoint[0..dot];
}

fn indexOf(nodes: []const Node, id: []const u8) ?usize {
    for (nodes, 0..) |n, i| {
        if (std.mem.eql(u8, n.id, id)) return i;
    }
    return null;
}

fn addDep(deps: *std.ArrayList([]const u8), a: Allocator, id: []const u8) !void {
    for (deps.items) |d| if (std.mem.eql(u8, d, id)) return;
    try deps.append(a, id);
}

fn str(v: std.json.Value, key: []const u8) ?[]const u8 {
    if (v != .object) return null;
    const f = v.object.get(key) orelse return null;
    return if (f == .string) f.string else null;
}

fn jsonStr(buf: *std.ArrayList(u8), a: Allocator, s: []const u8) !void {
    try buf.append(a, '"');
    for (s) |c| {
        switch (c) {
            '"' => try buf.appendSlice(a, "\\\""),
            '\\' => try buf.appendSlice(a, "\\\\"),
            '\n' => try buf.appendSlice(a, "\\n"),
            '\r' => try buf.appendSlice(a, "\\r"),
            '\t' => try buf.appendSlice(a, "\\t"),
            else => try buf.append(a, c),
        }
    }
    try buf.append(a, '"');
}

/// Durable control record for a bound Cell revision. Pause/resume survive a
/// new process because the record lives in control_dir, not in memory.
/// `scheduler` is always false: this file does not pick the next organelle.
pub fn applyControl(init: std.process.Init, a: Allocator, control_dir: []const u8, op: []const u8, digest: ?[]const u8) ![]u8 {
    const path = try std.fs.path.join(a, &.{ control_dir, "control.json" });
    var rec_status: []const u8 = "running";
    var rec_digest: []const u8 = digest orelse "";
    var revision: u32 = 1;
    var approved = false;

    if (std.Io.Dir.cwd().readFileAlloc(init.io, path, a, .limited(16 << 10))) |bytes| {
        if (std.json.parseFromSliceLeaky(std.json.Value, a, bytes, .{})) |parsed| {
            if (parsed == .object) {
                rec_status = str(parsed, "status") orelse rec_status;
                rec_digest = str(parsed, "digest") orelse rec_digest;
                if (parsed.object.get("revision")) |r| if (r == .integer) {
                    revision = @intCast(@max(1, r.integer));
                };
                if (parsed.object.get("approved")) |ap| {
                    if (ap == .bool) approved = ap.bool;
                }
            }
        } else |_| {}
    } else |_| {
        if (!std.mem.eql(u8, op, "bind")) return error.ControlMissing;
    }

    if (std.mem.eql(u8, op, "bind")) {
        rec_status = "running";
        rec_digest = digest orelse rec_digest;
        revision = 1;
        approved = false;
    } else if (std.mem.eql(u8, op, "pause")) {
        rec_status = "paused";
    } else if (std.mem.eql(u8, op, "resume")) {
        rec_status = "running";
    } else if (std.mem.eql(u8, op, "approve")) {
        approved = true;
    } else if (std.mem.eql(u8, op, "status")) {
        // no mutation
    } else return error.InvalidCell;

    if (digest) |d| {
        if (rec_digest.len > 0 and !std.mem.eql(u8, rec_digest, d) and
            !std.mem.eql(u8, op, "bind") and !std.mem.eql(u8, op, "status"))
        {
            revision += 1;
            rec_digest = d;
            approved = false;
        }
    }

    var buf: std.ArrayList(u8) = .empty;
    try buf.appendSlice(a, "{\"status\":");
    try jsonStr(&buf, a, rec_status);
    try buf.appendSlice(a, ",\"digest\":");
    try jsonStr(&buf, a, rec_digest);
    try buf.appendSlice(a, ",\"revision\":");
    var rev_buf: [16]u8 = undefined;
    const rev_s = std.fmt.bufPrint(&rev_buf, "{d}", .{revision}) catch "1";
    try buf.appendSlice(a, rev_s);
    try buf.appendSlice(a, ",\"approved\":");
    try buf.appendSlice(a, if (approved) "true" else "false");
    try buf.appendSlice(a, ",\"scheduler\":false}\n");
    const out = try buf.toOwnedSlice(a);
    if (!std.mem.eql(u8, op, "status")) {
        const cwd = std.Io.Dir.cwd();
        cwd.deleteFile(init.io, path) catch {};
        const file = cwd.createFile(init.io, path, .{}) catch return error.ControlMissing;
        defer file.close(init.io);
        file.writePositionalAll(init.io, out, 0) catch return error.ControlMissing;
    }
    return out;
}

/// Optional: run Contract's analyzer on a projected walk. Still not a scheduler.
pub fn planWalk(a: Allocator, walk_json: []const u8) ![]u8 {
    var analyzer = contract_graph_analyzer.GraphPlan{ .allocator = a };
    var verdict = analyzer.analyze(walk_json) catch return error.InvalidCell;
    defer verdict.deinit(a);
    return analyzer.toJson(&verdict);
}
