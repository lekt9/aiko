//! contract-zig — native core for the /contract substrate.
//!
//! This binary owns the load-bearing loop behind a small public surface:
//! declare, inspect, discover, search, and self. Manual stepping and manual
//! satisfaction are internal mechanics, not user-facing escape hatches.
const std = @import("std");
const contract = @import("contract");
const client = @import("contract_client");
const build_options = @import("build_options");
const pointer = @import("pointer.zig");
const ledger = @import("ledger.zig");

const VERSION = "0.4.0-guarded-native-shape";
const BINARY_NAME = build_options.binary_name;
const AIKO_DECLARE_ONLY = std.mem.eql(u8, BINARY_NAME, "aiko");

const Row = struct {
    id: []const u8 = "",
    event: []const u8 = "",
    plan: []const u8 = "",
    action: []const u8 = "",
    cwd: []const u8 = "",
    parent_id: ?[]const u8 = null,
    child_id: []const u8 = "",
    action_result: []const u8 = "",
    action_exit: i32 = 0,
    wave: u32 = 0,
    satisfied: bool = false,
    env_pubkey: []const u8 = "",
    parent_signature: []const u8 = "",
};

fn writeFd(fd: c_int, bytes: []const u8) void {
    var rem = bytes;
    while (rem.len > 0) {
        const n = std.c.write(fd, rem.ptr, rem.len);
        if (n <= 0) return;
        rem = rem[@intCast(n)..];
    }
}

fn out(bytes: []const u8) void {
    writeFd(std.c.STDOUT_FILENO, bytes);
}

fn err(bytes: []const u8) void {
    writeFd(std.c.STDERR_FILENO, bytes);
}

fn outPrint(comptime fmt: []const u8, args: anytype) void {
    var buf: [8192]u8 = undefined;
    const s = std.fmt.bufPrint(&buf, fmt, args) catch return;
    out(s);
}

fn errPrint(comptime fmt: []const u8, args: anytype) void {
    var buf: [8192]u8 = undefined;
    const s = std.fmt.bufPrint(&buf, fmt, args) catch return;
    err(s);
}

fn evidence(bytes: []const u8) void {
    err(bytes);
}

fn evidencePrint(comptime fmt: []const u8, args: anytype) void {
    errPrint(fmt, args);
}

fn usage() void {
    errPrint("{s} {s}\n\nUsage:\n", .{ BINARY_NAME, VERSION });
    if (AIKO_DECLARE_ONLY) {
        errPrint(
            \\  {s} "<truth claim>"
            \\
            \\Dimension resolves from the environment. Set UNBROWSE_BASE /
            \\AIKO_X_PAYMENT / X_PAYMENT to route to Unbrowse; else the local
            \\ledger receives the Word and walks 9 days (Genesis-shaped).
            \\
            \\Overrides (rarely needed):
            \\  {s} "<truth>" --remote     route to Unbrowse explicitly
            \\  {s} "<truth>" --local      one-shot local lifecycle (no day walk)
            \\  {s} "<truth>" --genesis    force 9-day Fib walk on local ledger
            \\  {s} declare "<truth>"      compat alias
            \\
            \\Empathic translation:
            \\  {s} "<truth>" --user <user-aiko-id>
            \\    Bind the spawn against the user's context aiko so the Word's
            \\    compiler shapes output against what the user has already
            \\    satisfied / encountered / declared as audience level.
            \\
        , .{ BINARY_NAME, BINARY_NAME, BINARY_NAME, BINARY_NAME, BINARY_NAME, BINARY_NAME });
        return;
    }
    errPrint(
        \\  {s} declare <truth-claim>
        \\
    , .{BINARY_NAME});
    if (!AIKO_DECLARE_ONLY) {
        errPrint(
            \\  {s} status [<id>]
            \\  {s} discover [--scope all|project|global]
            \\  {s} search --context <text>
            \\  {s} self [--json]
            \\
        , .{ BINARY_NAME, BINARY_NAME, BINARY_NAME, BINARY_NAME });
    }
}

fn jsonString(line: []const u8, key: []const u8) ?[]const u8 {
    var needle_buf: [128]u8 = undefined;
    const needle = std.fmt.bufPrint(&needle_buf, "\"{s}\":", .{key}) catch return null;
    const at = std.mem.indexOf(u8, line, needle) orelse return null;
    var start = at + needle.len;
    while (start < line.len and (line[start] == ' ' or line[start] == '\t')) : (start += 1) {}
    if (start >= line.len or line[start] != '"') return null;
    start += 1;
    var i = start;
    while (i < line.len) : (i += 1) {
        if (line[i] == '\\') {
            i += 1;
            continue;
        }
        if (line[i] == '"') return line[start..i];
    }
    return null;
}

fn jsonInt(line: []const u8, key: []const u8) ?i32 {
    var needle_buf: [128]u8 = undefined;
    const needle = std.fmt.bufPrint(&needle_buf, "\"{s}\": ", .{key}) catch return null;
    const at = std.mem.indexOf(u8, line, needle) orelse return null;
    const start = at + needle.len;
    var end = start;
    while (end < line.len and ((line[end] >= '0' and line[end] <= '9') or line[end] == '-')) : (end += 1) {}
    if (end == start) return null;
    return std.fmt.parseInt(i32, line[start..end], 10) catch null;
}

fn jsonNullableString(line: []const u8, key: []const u8) ?[]const u8 {
    if (jsonString(line, key)) |s| return s;
    return null;
}

fn parseRows(allocator: std.mem.Allocator, env: std.process.Environ) ![]Row {
    const data = try ledger.readAll(allocator, env);
    // Rows intentionally borrow slices from `data`. The native CLI is a
    // short-lived process, so keeping the ledger buffer alive until process
    // exit is simpler and safer than duplicating every field.

    var rows: std.ArrayList(Row) = .empty;
    errdefer rows.deinit(allocator);
    var it = std.mem.splitScalar(u8, data, '\n');
    while (it.next()) |line| {
        if (line.len == 0) continue;
        var r = Row{};
        r.id = jsonString(line, "id") orelse "";
        r.event = jsonString(line, "event") orelse "";
        r.plan = jsonString(line, "plan") orelse "";
        r.action = jsonString(line, "action") orelse "";
        r.cwd = jsonString(line, "cwd") orelse "";
        r.parent_id = jsonNullableString(line, "parent_id");
        r.child_id = jsonString(line, "child_id") orelse "";
        r.action_result = jsonString(line, "action_result") orelse "";
        r.action_exit = jsonInt(line, "action_exit") orelse 0;
        r.wave = @intCast(jsonInt(line, "wave") orelse 0);
        r.satisfied = std.mem.eql(u8, r.event, "satisfied");
        r.env_pubkey = jsonString(line, "env_pubkey") orelse "";
        r.parent_signature = jsonString(line, "parent_signature") orelse "";
        try rows.append(allocator, r);
    }
    return try rows.toOwnedSlice(allocator);
}

fn latestDeclared(rows: []const Row, id: []const u8) ?Row {
    var found: ?Row = null;
    for (rows) |r| {
        if (std.mem.eql(u8, r.event, "declared") and std.mem.eql(u8, r.id, id)) found = r;
    }
    return found;
}

fn isSatisfied(rows: []const Row, id: []const u8) bool {
    for (rows) |r| {
        if (std.mem.eql(u8, r.event, "satisfied") and std.mem.eql(u8, r.id, id)) return true;
    }
    return false;
}

fn latestWave(rows: []const Row, id: []const u8) u32 {
    var w: u32 = 0;
    for (rows) |r| {
        if (std.mem.eql(u8, r.id, id) and std.mem.eql(u8, r.event, "iterated")) {
            if (r.wave > w) w = r.wave;
        }
    }
    return w;
}

fn appendUnique(ids: *std.ArrayList([]const u8), allocator: std.mem.Allocator, id: []const u8) !void {
    for (ids.items) |existing| {
        if (std.mem.eql(u8, existing, id)) return;
    }
    try ids.append(allocator, id);
}

fn childIds(allocator: std.mem.Allocator, rows: []const Row, parent_id: []const u8) ![][]const u8 {
    var ids: std.ArrayList([]const u8) = .empty;
    errdefer ids.deinit(allocator);
    for (rows) |r| {
        if (std.mem.eql(u8, r.event, "declared")) {
            if (r.parent_id) |p| {
                if (std.mem.eql(u8, p, parent_id)) try ids.append(allocator, r.id);
            }
        }
    }
    return try ids.toOwnedSlice(allocator);
}

fn dependentIds(allocator: std.mem.Allocator, rows: []const Row, target_id: []const u8) ![][]const u8 {
    var ids: std.ArrayList([]const u8) = .empty;
    errdefer ids.deinit(allocator);
    var needle_buf: [32]u8 = undefined;
    const needle = std.fmt.bufPrint(&needle_buf, "contract:{s}", .{target_id}) catch return try ids.toOwnedSlice(allocator);
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        if (std.mem.indexOf(u8, r.action, needle) != null) try appendUnique(&ids, allocator, r.id);
    }
    return try ids.toOwnedSlice(allocator);
}

fn hookId(env: std.process.Environ, primary: []const u8, secondary: []const u8) ?[]const u8 {
    if (env.getPosix(primary)) |v| {
        if (v.len > 0) return v;
    }
    if (env.getPosix(secondary)) |v| {
        if (v.len > 0) return v;
    }
    return null;
}

extern fn system(command: [*:0]const u8) c_int;

fn runShell(allocator: std.mem.Allocator, action: []const u8, cwd: []const u8) !i32 {
    const cmd_plain = if (cwd.len > 0)
        try std.fmt.allocPrint(allocator, "cd \"{s}\" && {s}", .{ cwd, action })
    else
        try allocator.dupe(u8, action);
    defer allocator.free(cmd_plain);
    const cmd = try allocator.dupeZ(u8, cmd_plain);
    defer allocator.free(cmd);
    const rc = system(cmd.ptr);
    if (rc == -1) return 127;
    if ((rc & 0xff) == 0) return @intCast((rc >> 8) & 0xff);
    return 1;
}

fn runAction(allocator: std.mem.Allocator, env: std.process.Environ, rows: []const Row, r: Row) !struct { rc: i32, result: []const u8 } {
    _ = env;
    const action = r.action;
    const ptype = pointer.inferPointerType(action);

    if (std.mem.eql(u8, ptype, "neuron")) {
        const ids = try childIds(allocator, rows, r.id);
        defer allocator.free(ids);
        if (ids.len == 0) {
            evidence("  result: HOLD — neuron has no fired child evidence\n");
            return .{ .rc = 1, .result = "hold" };
        }
        for (ids) |cid| {
            if (!isSatisfied(rows, cid)) {
                evidencePrint("  result: HOLD — child neuron pending: {s}\n", .{cid});
                return .{ .rc = 1, .result = "hold" };
            }
        }
        evidence("  result: FIRE — neuron integrated all child evidence\n");
        return .{ .rc = 0, .result = "fire" };
    }

    if (std.mem.eql(u8, ptype, "funnel") or std.mem.eql(u8, ptype, "sequence")) {
        const ids = try childIds(allocator, rows, r.id);
        defer allocator.free(ids);
        if (ids.len == 0) {
            evidence("  result: FAIL — no children declared\n");
            return .{ .rc = 1, .result = "fail" };
        }
        for (ids) |cid| {
            if (!isSatisfied(rows, cid)) {
                evidencePrint("  result: FAIL — current stage: {s} (pending)\n", .{cid});
                return .{ .rc = 1, .result = "fail" };
            }
        }
        evidence("  result: PASS — every stage satisfied, in order\n");
        return .{ .rc = 0, .result = "pass" };
    }

    if (std.mem.eql(u8, ptype, "funnel-first")) {
        const ids = try childIds(allocator, rows, r.id);
        defer allocator.free(ids);
        if (ids.len == 0) {
            evidence("  result: FAIL — no children declared\n");
            return .{ .rc = 1, .result = "fail" };
        }
        for (ids) |cid| {
            if (isSatisfied(rows, cid)) {
                evidencePrint("  result: PASS — child satisfied: {s}\n", .{cid});
                return .{ .rc = 0, .result = "pass" };
            }
        }
        evidence("  result: FAIL — no child satisfied\n");
        return .{ .rc = 1, .result = "fail" };
    }

    if (std.mem.eql(u8, ptype, "quorum")) {
        const k_txt = action["quorum:".len..];
        const need = std.fmt.parseInt(usize, k_txt, 10) catch 1;
        const ids = try childIds(allocator, rows, r.id);
        defer allocator.free(ids);
        if (ids.len == 0) {
            evidence("  result: FAIL — no children declared\n");
            return .{ .rc = 1, .result = "fail" };
        }
        var got: usize = 0;
        for (ids) |cid| {
            if (isSatisfied(rows, cid)) got += 1;
        }
        if (got >= need) {
            evidencePrint("  result: PASS — quorum {d}/{d}\n", .{ got, need });
            return .{ .rc = 0, .result = "pass" };
        }
        evidencePrint("  result: FAIL — quorum {d}/{d}\n", .{ got, need });
        return .{ .rc = 1, .result = "fail" };
    }

    if (std.mem.eql(u8, ptype, "contract-ref")) {
        const ref = action["contract:".len..];
        const target = if (ref.len >= 8) ref[0..8] else ref;
        if (isSatisfied(rows, target)) {
            evidencePrint("  result: PASS — contract:{s} satisfied\n", .{target});
            return .{ .rc = 0, .result = "pass" };
        }
        evidencePrint("  result: FAIL — contract:{s} not satisfied\n", .{target});
        return .{ .rc = 1, .result = "fail" };
    }

    var body = action;
    if (std.mem.startsWith(u8, action, "loop-until:")) body = action["loop-until:".len..];
    if (std.mem.startsWith(u8, action, "harness:")) {
        const hdir = action["harness:".len..];
        body = try std.fmt.allocPrint(allocator, "\"{s}/verify.sh\"", .{hdir});
    }
    const rc = try runShell(allocator, body, r.cwd);
    if (rc == 0) {
        evidence("  result: PASS (exit 0)\n");
        return .{ .rc = 0, .result = "pass" };
    }
    evidencePrint("  result: FAIL (exit {d})\n", .{rc});
    return .{ .rc = rc, .result = "fail" };
}

const DeclareArgs = struct { plan: []const u8 };

fn parseDeclare(args: []const []const u8) !DeclareArgs {
    if (args.len == 0) return error.MissingPlan;
    if (args.len != 1) return error.UnknownFlag;
    return .{ .plan = args[0] };
}

const AikoMode = enum {
    /// Default — resolved at call time from environment. Speak the truth and
    /// let the substrate choose the dimension. Becomes .remote if any of
    /// `UNBROWSE_BASE` / `AIKO_X_PAYMENT` / `X_PAYMENT` / `AIKO_REMOTE` is set
    /// in the env; else .genesis.
    auto,
    remote,
    local,
    /// 9-day Fib-shaped walk over the ledger. Each invocation projects current
    /// day from the ledger (no local state), advances if previous day's
    /// Fibonacci workers all satisfied, spawns next day's children.
    genesis,
};

const AikoArgs = struct {
    plan: []u8,
    mode: AikoMode,
    /// Optional caller-supplied user context aiko id (8-hex contract id).
    /// When set, the remote LLM body carries `user_context_id` so the Word's
    /// compiler can bind translation against the user's own aiko — read their
    /// satisfied claims, preferred audience level, and prior context to shape
    /// output empathically. Stays null in pure local mode.
    user_context_id: ?[]const u8 = null,
};

fn parseAikoArgs(allocator: std.mem.Allocator, args: []const []const u8) !AikoArgs {
    if (args.len == 0) return error.MissingPlan;
    var mode: ?AikoMode = null;
    var user_context_id: ?[]const u8 = null;
    var parts: std.ArrayList([]const u8) = .empty;
    defer parts.deinit(allocator);
    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        const arg = args[i];
        if (std.mem.eql(u8, arg, "--remote")) {
            if (mode != null) return error.DuplicateMode;
            mode = .remote;
        } else if (std.mem.eql(u8, arg, "--local")) {
            if (mode != null) return error.DuplicateMode;
            mode = .local;
        } else if (std.mem.eql(u8, arg, "--genesis")) {
            if (mode != null) return error.DuplicateMode;
            mode = .genesis;
        } else if (std.mem.eql(u8, arg, "--user")) {
            if (i + 1 >= args.len) return error.MissingUserArg;
            user_context_id = args[i + 1];
            i += 1;
        } else if (std.mem.startsWith(u8, arg, "--user=")) {
            user_context_id = arg["--user=".len..];
        } else if (std.mem.startsWith(u8, arg, "--")) {
            return error.UnknownFlag;
        } else {
            try parts.append(allocator, arg);
        }
    }
    if (parts.items.len == 0) return error.MissingPlan;
    const plan = try std.mem.join(allocator, " ", parts.items);
    // Mode is optional. Default is .auto — the substrate resolves the
    // dimension at call time from environment, so the public form collapses
    // to `aiko "<truth>"`.
    return .{
        .plan = plan,
        .mode = mode orelse .auto,
        .user_context_id = user_context_id,
    };
}

/// Resolve `.auto` against the environment. The Word doesn't choose its
/// dimension; the dimension is given by where it is being spoken into.
fn resolveAutoMode(env: std.process.Environ) AikoMode {
    if (env.getPosix("UNBROWSE_BASE")) |v| if (v.len > 0) return .remote;
    if (env.getPosix("AIKO_X_PAYMENT")) |v| if (v.len > 0) return .remote;
    if (env.getPosix("X_PAYMENT")) |v| if (v.len > 0) return .remote;
    if (env.getPosix("AIKO_REMOTE")) |v| {
        if (v.len > 0 and !std.mem.eql(u8, v, "0") and !std.mem.eql(u8, v, "false")) return .remote;
    }
    return .genesis;
}

fn isPathToken(tok: []const u8) bool {
    return std.mem.startsWith(u8, tok, "/Users/") or
        std.mem.startsWith(u8, tok, "/home/") or
        std.mem.startsWith(u8, tok, "~/");
}

fn isEmailToken(tok: []const u8) bool {
    const at = std.mem.indexOfScalar(u8, tok, '@') orelse return false;
    if (at == 0 or at + 1 >= tok.len) return false;
    return std.mem.indexOfScalar(u8, tok[at + 1 ..], '.') != null;
}

fn isSecretLikeToken(tok: []const u8) bool {
    if (tok.len < 32) return false;
    var alnum: usize = 0;
    var symbol: usize = 0;
    for (tok) |c| {
        if (std.ascii.isAlphanumeric(c)) {
            alnum += 1;
        } else if (c == '_' or c == '-' or c == '.' or c == ':' or c == '/' or c == '+' or c == '=') {
            symbol += 1;
        } else {
            return false;
        }
    }
    return alnum >= 24 and symbol > 0;
}

fn appendSanitizedToken(out_buf: *std.ArrayList(u8), allocator: std.mem.Allocator, tok: []const u8) !void {
    if (isPathToken(tok)) {
        try out_buf.appendSlice(allocator, "[local-path-pattern]");
    } else if (isEmailToken(tok)) {
        try out_buf.appendSlice(allocator, "[email-pattern]");
    } else if (isSecretLikeToken(tok)) {
        try out_buf.appendSlice(allocator, "[secret-pointer-pattern]");
    } else {
        try out_buf.appendSlice(allocator, tok);
    }
}

fn redactAikoPlan(allocator: std.mem.Allocator, plan: []const u8) ![]u8 {
    var buf: std.ArrayList(u8) = .empty;
    errdefer buf.deinit(allocator);
    var start: usize = 0;
    var i: usize = 0;
    while (i < plan.len) : (i += 1) {
        const c = plan[i];
        if (std.ascii.isWhitespace(c)) {
            if (start < i) try appendSanitizedToken(&buf, allocator, plan[start..i]);
            try buf.append(allocator, c);
            start = i + 1;
        }
    }
    if (start < plan.len) try appendSanitizedToken(&buf, allocator, plan[start..]);
    return buf.toOwnedSlice(allocator);
}

fn ambientParent(env: std.process.Environ) ?[]const u8 {
    if (env.getPosix("CONTRACT_PARENT_ID")) |v| {
        if (v.len > 0) return v;
    }
    if (env.getPosix("CONTRACT_PARENT")) |v| {
        if (v.len > 0) return v;
    }
    return null;
}

fn ambientAction(env: std.process.Environ) []const u8 {
    if (env.getPosix("CONTRACT_NEURON_ACTION")) |v| {
        if (v.len > 0) return v;
    }
    if (env.getPosix("CONTRACT_INTERNAL_ACTION")) |v| {
        if (v.len > 0) return v;
    }
    return "neuron";
}

fn ambientAdapter(env: std.process.Environ) ?[]const u8 {
    if (env.getPosix("CONTRACT_ADAPTER_ID")) |v| {
        if (v.len > 0) return v;
    }
    if (env.getPosix("CONTRACT_ADAPTER")) |v| {
        if (v.len > 0) return v;
    }
    return null;
}

fn ambientAdapterKind(env: std.process.Environ) ?[]const u8 {
    if (env.getPosix("CONTRACT_ADAPTER_KIND")) |v| {
        if (v.len > 0) return v;
    }
    if (env.getPosix("CONTRACT_ENVIRONMENT_KIND")) |v| {
        if (v.len > 0) return v;
    }
    return null;
}

fn ambientEventBus(env: std.process.Environ) ?[]const u8 {
    if (env.getPosix("CONTRACT_EVENT_BUS_ID")) |v| {
        if (v.len > 0) return v;
    }
    if (env.getPosix("CONTRACT_EVENT_BUS")) |v| {
        if (v.len > 0) return v;
    }
    return null;
}

fn ambientPretoolEvent(env: std.process.Environ) ?[]const u8 {
    if (env.getPosix("CONTRACT_PRETOOL_EVENT_ID")) |v| {
        if (v.len > 0) return v;
    }
    if (env.getPosix("CONTRACT_PRETOOL_EVENT")) |v| {
        if (v.len > 0) return v;
    }
    return null;
}

fn ambientEventKind(env: std.process.Environ) ?[]const u8 {
    if (env.getPosix("CONTRACT_EVENT_KIND")) |v| {
        if (v.len > 0) return v;
    }
    if (env.getPosix("CONTRACT_PRETOOL_KIND")) |v| {
        if (v.len > 0) return v;
    }
    return null;
}

fn enqueueOwned(allocator: std.mem.Allocator, queue: *std.ArrayList([]u8), id: []const u8) !void {
    for (queue.items) |existing| {
        if (std.mem.eql(u8, existing, id)) return;
    }
    const copy = try allocator.dupe(u8, id);
    errdefer allocator.free(copy);
    try queue.append(allocator, copy);
}

fn resolveOne(allocator: std.mem.Allocator, env: std.process.Environ, id: []const u8) !u8 {
    const rows = try parseRows(allocator, env);
    defer allocator.free(rows);
    if (isSatisfied(rows, id)) {
        evidencePrint("{s} already resolved\n", .{id});
        return 0;
    }
    const r = latestDeclared(rows, id) orelse {
        errPrint("contract not found: {s}\n", .{id});
        return 1;
    };
    const wave = latestWave(rows, id) + 1;
    const rr = try runAction(allocator, env, rows, r);
    try contract.recordIteration(allocator, env, id, wave, rr.rc, rr.result);
    if (rr.rc != 0) return 1;
    try contract.markSatisfied(allocator, env, id, wave, "native resolver reached mechanical true");
    evidencePrint("{s} -> resolved\n", .{id});
    return 0;
}

fn enqueueAffected(allocator: std.mem.Allocator, rows: []const Row, queue: *std.ArrayList([]u8), id: []const u8) !void {
    if (latestDeclared(rows, id)) |r| {
        if (r.parent_id) |parent| {
            try enqueueOwned(allocator, queue, parent);
        }
    }
    const children = try childIds(allocator, rows, id);
    defer allocator.free(children);
    for (children) |child| try enqueueOwned(allocator, queue, child);

    const dependents = try dependentIds(allocator, rows, id);
    defer allocator.free(dependents);
    for (dependents) |dep| {
        if (std.mem.eql(u8, dep, id)) continue;
        try enqueueOwned(allocator, queue, dep);
    }
}

fn resolveLineage(allocator: std.mem.Allocator, env: std.process.Environ, id: []const u8) !u8 {
    const declared_rc = try resolveOne(allocator, env, id);
    var queue: std.ArrayList([]u8) = .empty;
    defer {
        for (queue.items) |item| allocator.free(item);
        queue.deinit(allocator);
    }
    {
        const rows = try parseRows(allocator, env);
        defer allocator.free(rows);
        try enqueueAffected(allocator, rows, &queue, id);
    }
    var index: usize = 0;
    while (index < queue.items.len and index < 256) : (index += 1) {
        const current = queue.items[index];
        const rc = try resolveOne(allocator, env, current);
        if (rc == 0) {
            const rows = try parseRows(allocator, env);
            defer allocator.free(rows);
            try enqueueAffected(allocator, rows, &queue, current);
        }
    }
    return declared_rc;
}

fn cmdDeclare(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    const d = parseDeclare(args) catch |e| {
        errPrint("declare argument error: {s}\n", .{@errorName(e)});
        return 2;
    };
    if (!client.isRemoteMode(env)) {
        if (hookId(env, "CONTRACT_PREHOOK_ID", "CONTRACT_PREHOOK")) |prehook| {
            const pre_rc = try resolveOne(allocator, env, prehook);
            if (pre_rc != 0) return pre_rc;
        }
    }
    const action = ambientAction(env);
    const parent = ambientParent(env);
    const adapter = ambientAdapter(env);
    const adapter_kind = ambientAdapterKind(env);
    const event_bus = ambientEventBus(env);
    const pretool_event = ambientPretoolEvent(env);
    const event_kind = ambientEventKind(env);
    if (AIKO_DECLARE_ONLY) {
        const safe_plan = redactAikoPlan(allocator, d.plan) catch |e| {
            errPrint("aiko privacy guard failed: {s}\n", .{@errorName(e)});
            return 2;
        };
        defer allocator.free(safe_plan);
        const body = client.declareRemoteAiko(allocator, env, safe_plan, action, parent, adapter, adapter_kind, event_bus, pretool_event, event_kind, null, null) catch |e| {
            errPrint("aiko declare failed against Unbrowse: {s}\n", .{@errorName(e)});
            return 2;
        };
        defer allocator.free(body);
        const id = jsonString(body, "id") orelse {
            err("remote declare response missing id\n");
            return 2;
        };
        outPrint("{s}\n", .{id});
        return 0;
    }
    if (client.isRemoteMode(env)) {
        const body = client.declareRemote(allocator, env, d.plan, action, parent, adapter, adapter_kind, event_bus, pretool_event, event_kind, null) catch |e| {
            errPrint("remote declare failed: {s}\n", .{@errorName(e)});
            return 2;
        };
        defer allocator.free(body);
        const id = jsonString(body, "id") orelse {
            err("remote declare response missing id\n");
            return 2;
        };
        outPrint("{s}\n", .{id});
        return 0;
    }
    const cid = try contract.declare(allocator, env, d.plan, action, .{ .parent_id = parent });
    defer allocator.free(cid);
    outPrint("{s}\n", .{cid});
    const rc = try resolveLineage(allocator, env, cid);
    if (rc == 0) {
        if (hookId(env, "CONTRACT_POSTHOOK_ID", "CONTRACT_POSTHOOK")) |posthook| {
            _ = try resolveLineage(allocator, env, posthook);
        }
    }
    return if (rc == 0) 0 else 1;
}

/// The nine days of creation, Fibonacci-scaled. Hardcoded so the substrate has
/// no JSON dependency at runtime and the rubric is part of the binary. Fib
/// pattern 1·1·2·3·5·8 across the six creation days, single-thread sabbath
/// verdict, 13 cold auditors for the books, single emergence — Genesis 1–2 +
/// Revelation 20:12 + 21:1.
const GenesisDay = struct {
    n: u8,
    fib: u8,
    name: []const u8,
    ref: []const u8,
    label: []const u8,
};

const days_table = [_]GenesisDay{
    .{ .n = 1, .fib = 1, .name = "light", .ref = "Gen 1:3", .label = "inventory — what exists" },
    .{ .n = 2, .fib = 1, .name = "firmament", .ref = "Gen 1:6", .label = "separate — what divides" },
    .{ .n = 3, .fib = 2, .name = "land", .ref = "Gen 1:11", .label = "seed — what produces" },
    .{ .n = 4, .fib = 3, .name = "luminaries", .ref = "Gen 1:14", .label = "test — what signals" },
    .{ .n = 5, .fib = 5, .name = "creatures", .ref = "Gen 1:20", .label = "run — what moves" },
    .{ .n = 6, .fib = 8, .name = "dominion", .ref = "Gen 1:26", .label = "integrate — what rules" },
    .{ .n = 7, .fib = 1, .name = "sabbath", .ref = "Gen 2:2", .label = "verdict — PROMOTE/HOLD/REJECT" },
    .{ .n = 8, .fib = 13, .name = "books", .ref = "Rev 20:12", .label = "audit — cold re-read of artifact" },
    .{ .n = 9, .fib = 1, .name = "emergence", .ref = "Rev 21:1", .label = "publish — make all things new" },
};

/// Find the latest unsatisfied root contract whose plan exactly matches `plan`.
/// Last-writer wins by ledger order (chronological).
fn findSessionByPlan(rows: []const Row, plan: []const u8) ?[]const u8 {
    var latest: ?[]const u8 = null;
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        if (r.parent_id) |p| {
            if (p.len > 0) continue; // skip non-roots
        }
        if (!std.mem.eql(u8, r.plan, plan)) continue;
        if (isSatisfied(rows, r.id)) continue;
        latest = r.id;
    }
    return latest;
}

/// Project current day from the ledger: max N across child plans that start
/// with `jl-day N`. 0 = pre-Day-1 (session created, no day spawned yet).
fn currentDay(rows: []const Row, session_id: []const u8) u8 {
    var max: u8 = 0;
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        const p = r.parent_id orelse continue;
        if (!std.mem.eql(u8, p, session_id)) continue;
        if (!std.mem.startsWith(u8, r.plan, "jl-day ")) continue;
        const after = r.plan[7..];
        var i: usize = 0;
        while (i < after.len and std.ascii.isDigit(after[i])) : (i += 1) {}
        if (i == 0) continue;
        const n = std.fmt.parseInt(u8, after[0..i], 10) catch continue;
        if (n > max) max = n;
    }
    return max;
}

/// Count {spawned, satisfied} children of `session_id` whose plan starts with
/// `jl-day <day> `. Used to gate day advancement: a day completes only when
/// every Fib worker is satisfied.
const DayCount = struct { spawned: u8, satisfied: u8 };
fn countDayChildren(rows: []const Row, session_id: []const u8, day: u8) DayCount {
    var prefix_buf: [32]u8 = undefined;
    const prefix = std.fmt.bufPrint(&prefix_buf, "jl-day {d} ", .{day}) catch return .{ .spawned = 0, .satisfied = 0 };
    var dc = DayCount{ .spawned = 0, .satisfied = 0 };
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        const p = r.parent_id orelse continue;
        if (!std.mem.eql(u8, p, session_id)) continue;
        if (!std.mem.startsWith(u8, r.plan, prefix)) continue;
        dc.spawned += 1;
        if (isSatisfied(rows, r.id)) dc.satisfied += 1;
    }
    return dc;
}

/// cmdGenesis — stateless 9-day projection walker.
///
/// Each invocation reads the ledger, computes the session's current day, and
/// either (a) spawns the next day's Fib(N) workers and exits, or (b) reports
/// HOLD with the count of unsatisfied workers from the prior day.
///
/// State is the ledger; no local file is created. Re-running `aiko "<truth>"
/// --genesis` with the same plan resumes the same session.
fn cmdGenesis(allocator: std.mem.Allocator, env: std.process.Environ, plan: []const u8) !u8 {
    const rows = try parseRows(allocator, env);
    defer allocator.free(rows);

    // Project session id (find latest unsatisfied root with matching plan, else create).
    var owned_sid: ?[]u8 = null;
    defer if (owned_sid) |s| allocator.free(s);
    const session_id: []const u8 = blk: {
        if (findSessionByPlan(rows, plan)) |existing| break :blk existing;
        const new_id = try contract.declare(allocator, env, plan, "neuron", .{ .parent_id = ambientParent(env) });
        owned_sid = new_id;
        outPrint("session opened: {s}\n", .{new_id});
        break :blk new_id;
    };

    // Re-read rows if we just declared (so currentDay sees the new root).
    // Cheap: parseRows is a single file slurp.
    const rows2 = if (owned_sid == null) rows else try parseRows(allocator, env);
    defer if (owned_sid != null) allocator.free(rows2);

    const cur = currentDay(rows2, session_id);

    if (cur >= 9) {
        outPrint("session {s}: day 9 emerged — all things made new\n", .{session_id});
        return 0;
    }

    // Gate: previous day's Fib workers must all be satisfied before advancing.
    if (cur > 0) {
        const day_prev = days_table[cur - 1];
        const dc = countDayChildren(rows2, session_id, cur);
        if (dc.satisfied < day_prev.fib) {
            outPrint(
                "session {s}: day {d} ({s}) HOLD — {d}/{d} workers satisfied\n" ++
                    "  satisfy the remaining workers (`contract _mark <id> satisfied`) then re-fire\n",
                .{ session_id, cur, day_prev.name, dc.satisfied, day_prev.fib },
            );
            return 1;
        }
    }

    // Advance: spawn next day's Fib workers.
    const day = days_table[cur];
    outPrint(
        "session {s}: day {d} ({s}) — {s}\n  {s}\n  spawning {d} worker{s}:\n",
        .{ session_id, day.n, day.name, day.ref, day.label, day.fib, if (day.fib == 1) "" else "s" },
    );

    var i: u8 = 0;
    while (i < day.fib) : (i += 1) {
        const child_plan = try std.fmt.allocPrint(
            allocator,
            "jl-day {d} ({s}) worker {d}/{d}: {s} — bind:{s}",
            .{ day.n, day.name, i + 1, day.fib, day.label, session_id },
        );
        defer allocator.free(child_plan);
        const child_id = try contract.declare(allocator, env, child_plan, "neuron", .{ .parent_id = session_id });
        defer allocator.free(child_id);
        outPrint("    {s}\n", .{child_id});
    }
    return 0;
}

/// cmdSpeak — the single Word.
///
/// The binary invocation IS the verb. Speaking a truth claim deterministically
/// walks seven phases (Genesis 1–2: God speaks → the Word becomes flesh → the
/// substrate rests). No phase is optional; no caller chooses a phase. Each
/// phase is idempotent against the append-only ledger.
///
///   Day 1  Word      — `declared` row appended (the speech is the act).
///   Day 2  Firmament — `child_added` per parent_id (containment edge).
///   Day 3  Earth     — synapse dispatch by kind (cross-dimension edges).
///   Day 4  Lights    — gate on `blocked_by` / `inhibits` / external metrics.
///   Day 5  Life      — corroborate child evidence per `aggregation`.
///   Day 6  Image     — `satisfied` row appended iff Days 4-5 ratified.
///   Day 7  Sabbath   — `called` rows per `posthook:` synapse — the word
///                      propagates and the wavefront seals.
///
/// Days 1-3 always fire. Days 4-7 are conditional on truth holding. A held day
/// returns exit 1; the row stays pending until a future speech ratifies it.
fn cmdSpeak(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    const parsed = parseAikoArgs(allocator, args) catch |e| {
        errPrint("aiko argument error: {s}\n", .{@errorName(e)});
        usage();
        return 2;
    };
    defer allocator.free(parsed.plan);
    const safe_plan = redactAikoPlan(allocator, parsed.plan) catch |e| {
        errPrint("aiko privacy guard failed: {s}\n", .{@errorName(e)});
        return 2;
    };
    defer allocator.free(safe_plan);

    const action = ambientAction(env);
    const parent = ambientParent(env);
    const adapter = ambientAdapter(env);
    const adapter_kind = ambientAdapterKind(env);
    const event_bus = ambientEventBus(env);
    const pretool_event = ambientPretoolEvent(env);
    const event_kind = ambientEventKind(env);

    const effective_mode: AikoMode = switch (parsed.mode) {
        .auto => resolveAutoMode(env),
        else => parsed.mode,
    };

    switch (effective_mode) {
        .auto => unreachable, // resolved above
        .genesis => {
            // Stateless 9-day Fib walker — projects state from the ledger,
            // spawns next day's workers, exits. Re-fire to advance.
            return try cmdGenesis(allocator, env, safe_plan);
        },
        .remote => {
            // Remote target: Unbrowse compiles all seven days server-side.
            // GATE — only signed/attested binaries may invoke the LLM compiler.
            if (!assertBinaryIntegrityForLlm(allocator, env)) return 2;
            const body = client.declareRemoteAiko(allocator, env, safe_plan, action, parent, adapter, adapter_kind, event_bus, pretool_event, event_kind, null, parsed.user_context_id) catch |e| {
                errPrint("aiko remote failed against Unbrowse: {s}\n", .{@errorName(e)});
                return 2;
            };
            defer allocator.free(body);
            const id = jsonString(body, "id") orelse {
                err("remote declare response missing id\n");
                return 2;
            };
            outPrint("{s}\n", .{id});
            return 0;
        },
        .local => {
            // Optional prehook from env (legacy single-hook surface; the graph
            // form of prehook lives in `synapses[].kind=prehook`).
            if (hookId(env, "CONTRACT_PREHOOK_ID", "CONTRACT_PREHOOK")) |prehook| {
                const pre_rc = try resolveOne(allocator, env, prehook);
                if (pre_rc != 0) return pre_rc;
            }

            // Day 1 — Word. The speech becomes a row.
            const cid = try contract.declare(allocator, env, safe_plan, action, .{ .parent_id = parent });
            defer allocator.free(cid);
            outPrint("{s}\n", .{cid});

            // Days 2-6 — Firmament, Earth, Lights, Life, Image. The resolver
            // walks the lineage: child_added edges are already written by
            // declare; the resolver iterates, judges per evidence rules, and
            // markSatisfied fires when truth holds.
            const rc = try resolveLineage(allocator, env, cid);

            // Day 7 — Sabbath. The word propagates: for each posthook synapse
            // on the just-spoken row, append a typed `called` row recording
            // the dispatch. Graph-bound; replaces the env-var single posthook
            // shape (which stays as legacy compat for one more release).
            if (rc == 0) {
                const rows = try parseRows(allocator, env);
                defer allocator.free(rows);
                for (rows) |r| {
                    if (!std.mem.eql(u8, r.event, "declared")) continue;
                    if (!std.mem.eql(u8, r.id, cid)) continue;
                    const targets = try pointer.extractTypedRefs(allocator, r.plan, "posthook:");
                    defer {
                        for (targets) |t| allocator.free(t);
                        allocator.free(targets);
                    }
                    for (targets) |target| {
                        var ptr_buf: [32]u8 = undefined;
                        const target_pointer = try std.fmt.bufPrint(&ptr_buf, "contract:{s}", .{target});
                        try contract.appendCalledRow(allocator, env, cid, target_pointer, "posthook");
                        outPrint("called: posthook -> {s}\n", .{target});
                    }
                    break;
                }

                // Legacy single-env-var posthook (deprecated; graph form above wins).
                if (hookId(env, "CONTRACT_POSTHOOK_ID", "CONTRACT_POSTHOOK")) |posthook| {
                    _ = try resolveLineage(allocator, env, posthook);
                }
            }
            return if (rc == 0) 0 else 1;
        },
    }
}

/// Backward-compat alias. `aiko ...` and `contract <claim>` both route here.
const cmdAikoGoal = cmdSpeak;

fn cmdList(allocator: std.mem.Allocator, env: std.process.Environ) !u8 {
    const rows = try parseRows(allocator, env);
    defer allocator.free(rows);
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        const status = if (isSatisfied(rows, r.id)) "satisfied" else "pending";
        outPrint("[{s}] {s} ({s}) — \"{s}\"\n", .{ status, r.id, pointer.inferPointerType(r.action), r.plan });
    }
    return 0;
}

/// Resolve the absolute path of the currently-running binary. macOS uses
/// `_NSGetExecutablePath`; we shim it via libc.
extern fn _NSGetExecutablePath(buf: [*]u8, size: *u32) c_int;

fn ownBinaryPath(allocator: std.mem.Allocator) ![]u8 {
    var buf: [4096]u8 = undefined;
    var size: u32 = buf.len;
    if (_NSGetExecutablePath(&buf, &size) != 0) return error.PathTooLong;
    // size on success holds the strlen+1; trim the trailing NUL if present.
    var end: usize = 0;
    while (end < buf.len and buf[end] != 0) end += 1;
    return try allocator.dupe(u8, buf[0..end]);
}

/// Compat verb: `sign-binary <path>` — signs `<path>` with the binary-signing
/// keypair derived from the root secret. Writes `<path>.sig` alongside.
/// Used by build.sh after each `zig build` so newly-installed binaries pass
/// self-attestation on next invocation.
fn cmdSignBinary(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    if (args.len < 1) {
        errPrint("sign-binary requires: <path>\n", .{});
        return 2;
    }
    contract.Lineage.signBinary(allocator, env, args[0]) catch |e| {
        errPrint("sign-binary failed: {s}\n", .{@errorName(e)});
        return 1;
    };
    outPrint("signed: {s}.sig\n", .{args[0]});
    return 0;
}

/// Compat verb: `verify-self` — verify the running binary's own integrity.
/// Returns 0 if signature valid; 1 otherwise.
fn cmdVerifySelf(allocator: std.mem.Allocator, env: std.process.Environ) !u8 {
    const path = try ownBinaryPath(allocator);
    defer allocator.free(path);
    contract.Lineage.verifyBinary(allocator, env, path) catch |e| {
        outPrint("verify-self: FAIL ({s})\n  binary: {s}\n", .{ @errorName(e), path });
        return 1;
    };
    outPrint("verify-self: OK\n  binary: {s}\n", .{path});
    return 0;
}

/// Compat verb: `verify-binary <path>` — verify any binary by path against
/// its sidecar `<path>.sig`. Lets one binary attest another (used by build.sh
/// to attest both aiko and contract from one invocation).
fn cmdVerifyBinary(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    if (args.len < 1) {
        errPrint("verify-binary requires: <path>\n", .{});
        return 2;
    }
    contract.Lineage.verifyBinary(allocator, env, args[0]) catch |e| {
        outPrint("verify-binary: FAIL ({s})\n  binary: {s}\n", .{ @errorName(e), args[0] });
        return 1;
    };
    outPrint("verify-binary: OK\n  binary: {s}\n", .{args[0]});
    return 0;
}

/// Refusal gate for LLM-bound operations. Run before any path that POSTs to
/// the canonical Unbrowse endpoint. Tampered or unsigned binaries cannot
/// invoke the LLM compiler — purely-local ledger operations remain available
/// (the gate is per-surface, not per-process).
///
/// Failure-mode: prints a clear refusal to stderr and returns false so the
/// caller exits with code 2 (refused) rather than running an LLM call from
/// an unverified binary.
fn assertBinaryIntegrityForLlm(allocator: std.mem.Allocator, env: std.process.Environ) bool {
    const path = ownBinaryPath(allocator) catch return false;
    defer allocator.free(path);
    contract.Lineage.verifyBinary(allocator, env, path) catch |e| {
        errPrint(
            \\REFUSED: binary failed self-attestation ({s}).
            \\  binary: {s}
            \\
            \\The LLM-compile (Unbrowse word→contract-tree expansion) path is
            \\hardcoded to require a signed binary so that the Word's compiler
            \\cannot be silently repointed or tampered. Run `contract sign-binary
            \\{s}` to (re)sign after rebuilding, then retry.
            \\
        , .{ @errorName(e), path, path });
        return false;
    };
    return true;
}

/// Compat verb: `verify-lineage <id>` — walk parent_id chain from `id` back to
/// the root sentinel, recomputing each row's signing digest and verifying
/// every parent_signature against the parent's env_pubkey. Root rows are
/// self-signed (signer == own pubkey).
///
/// Reports per-link PASS / FAIL and an overall verdict. Exits 0 only when
/// every link verifies and the chain reaches a root.
fn cmdVerifyLineage(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    if (args.len < 1) {
        errPrint("verify-lineage requires: <id>\n", .{});
        return 2;
    }
    const target = args[0];
    const rows = try parseRows(allocator, env);
    defer allocator.free(rows);

    var chain: std.ArrayList(Row) = .empty;
    defer chain.deinit(allocator);

    // Walk parent_id from target backward.
    var cur: []const u8 = target;
    var seen_root = false;
    while (true) {
        var found: ?Row = null;
        for (rows) |r| {
            if (!std.mem.eql(u8, r.event, "declared")) continue;
            if (std.mem.eql(u8, r.id, cur)) {
                found = r;
                break;
            }
        }
        const row = found orelse {
            errPrint("verify-lineage: no declared row for {s}\n", .{cur});
            return 1;
        };
        try chain.append(allocator, row);
        if (row.parent_id) |p| {
            if (p.len == 0) {
                seen_root = true;
                break;
            }
            cur = p;
        } else {
            seen_root = true;
            break;
        }
    }
    if (!seen_root) {
        errPrint("verify-lineage: chain did not terminate at root\n", .{});
        return 1;
    }

    // Build a pubkey lookup for signer resolution.
    var pubkey_for_id: std.StringHashMap([]const u8) = .init(allocator);
    defer pubkey_for_id.deinit();
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        if (r.env_pubkey.len == 0) continue;
        try pubkey_for_id.put(r.id, r.env_pubkey);
    }

    outPrint("verify-lineage {s}:\n", .{target});
    // Iterate chain leaf -> root and verify each row's parent_signature.
    var all_ok = true;
    var i: usize = 0;
    while (i < chain.items.len) : (i += 1) {
        const r = chain.items[i];
        if (r.env_pubkey.len == 0 or r.parent_signature.len == 0) {
            outPrint("  [SKIP] {s} — row predates lineage signing\n", .{r.id});
            continue;
        }
        const parent_or_root: []const u8 = if (r.parent_id) |p|
            (if (p.len > 0) p else "root")
        else
            "root";
        // Resolve signer's pubkey: parent's env_pubkey, or self for root.
        const signer_pubkey: []const u8 = blk: {
            if (r.parent_id) |p| {
                if (p.len > 0) {
                    if (pubkey_for_id.get(p)) |pk| break :blk pk;
                    break :blk ""; // missing parent row
                }
            }
            break :blk r.env_pubkey; // self-signed root
        };
        if (signer_pubkey.len == 0) {
            outPrint("  [FAIL] {s} — parent's env_pubkey unavailable\n", .{r.id});
            all_ok = false;
            continue;
        }
        var digest: [32]u8 = undefined;
        @import("contract").Lineage.signingDigest(r.id, r.env_pubkey, r.plan, parent_or_root, &digest);
        @import("contract").Lineage.verifyDigest(r.parent_signature, signer_pubkey, digest) catch {
            outPrint("  [FAIL] {s} — signature verification failed (signer={s}...)\n", .{ r.id, signer_pubkey[0..16] });
            all_ok = false;
            continue;
        };
        const role = if (r.parent_id == null or r.parent_id.?.len == 0) "root (self-signed)" else "child (signed by parent)";
        outPrint("  [ OK ] {s} {s}\n", .{ r.id, role });
    }
    if (all_ok) {
        outPrint("verdict: chain authentic ({d} links)\n", .{chain.items.len});
        return 0;
    } else {
        outPrint("verdict: chain INVALID\n", .{});
        return 1;
    }
}

/// Compat verb: `_mark <id> satisfied [--proof <text>]`. Appends a `satisfied`
/// row via libcontract.markSatisfied so externally-verified contracts can be
/// driven to satisfaction without round-tripping through the resolver. This
/// is the only honest path to "mark" a contract whose evidence lives outside
/// the substrate (e.g. a passing test, a deployed surface, an observed metric).
fn cmdMark(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    if (args.len < 2) {
        errPrint("_mark requires: <id> satisfied [--proof <text>]\n", .{});
        usage();
        return 2;
    }
    const id = args[0];
    const state = args[1];
    if (!std.mem.eql(u8, state, "satisfied")) {
        errPrint("_mark only supports state=satisfied (got: {s})\n", .{state});
        return 2;
    }
    var proof: ?[]const u8 = null;
    var i: usize = 2;
    while (i < args.len) : (i += 1) {
        if (std.mem.eql(u8, args[i], "--proof") and i + 1 < args.len) {
            proof = args[i + 1];
            i += 1;
        } else if (std.mem.eql(u8, args[i], "--proof-skip") and i + 1 < args.len) {
            proof = args[i + 1];
            i += 1;
        }
    }
    if (id.len != 8) {
        errPrint("_mark: id must be 8 hex chars (got: {s})\n", .{id});
        return 2;
    }
    // Honest guard: refuse to mark an id with no prior declared row.
    const rows = try parseRows(allocator, env);
    defer allocator.free(rows);
    var found = false;
    for (rows) |r| {
        if (std.mem.eql(u8, r.event, "declared") and std.mem.eql(u8, r.id, id)) {
            found = true;
            break;
        }
    }
    if (!found) {
        errPrint("_mark: no declared row found for id {s}\n", .{id});
        return 1;
    }
    try contract.markSatisfied(allocator, env, id, 1, proof);
    outPrint("satisfied: {s}\n", .{id});

    // Posthook dispatch: scan the declared row's plan for posthook:<id> refs
    // and append a `called` row per target. This is the second half of the
    // dispatcher contract d8a30a14 — the graph itself records that the
    // upstream contract fired its successors. Target action execution
    // (cli shell-out / webhook POST / etc.) is deferred to the resolveLineage
    // loop; cmdMark only emits the called edge so the chain is observable.
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        if (!std.mem.eql(u8, r.id, id)) continue;
        const targets = try pointer.extractTypedRefs(allocator, r.plan, "posthook:");
        defer {
            for (targets) |t| allocator.free(t);
            allocator.free(targets);
        }
        for (targets) |target| {
            var ptr_buf: [32]u8 = undefined;
            const target_pointer = try std.fmt.bufPrint(&ptr_buf, "contract:{s}", .{target});
            try contract.appendCalledRow(allocator, env, id, target_pointer, "posthook");
            outPrint("called: posthook -> {s}\n", .{target});
        }
        break;
    }
    return 0;
}

fn cmdStatus(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    if (args.len > 1) {
        err("status accepts zero args or exactly <id>\n");
        return 2;
    }
    if (client.isRemoteMode(env)) {
        if (args.len != 1) {
            err("remote status requires <id>\n");
            return 2;
        }
        const body = client.statusRemote(allocator, env, args[0]) catch |e| {
            errPrint("remote status failed: {s}\n", .{@errorName(e)});
            return 2;
        };
        defer allocator.free(body);
        out(body);
        out("\n");
        return 0;
    }
    const rows = try parseRows(allocator, env);
    defer allocator.free(rows);
    if (args.len == 0) return cmdList(allocator, env);
    const id = args[0];
    const r = latestDeclared(rows, id) orelse {
        errPrint("contract not found: {s}\n", .{id});
        return 1;
    };
    const status = if (isSatisfied(rows, id)) "satisfied" else "pending";
    outPrint("[{s}] {s} ({s})\n  plan:   {s}\n  action: {s}\n", .{ status, id, pointer.inferPointerType(r.action), r.plan, r.action });
    const ids = try childIds(allocator, rows, id);
    defer allocator.free(ids);
    for (ids) |cid| {
        if (latestDeclared(rows, cid)) |c| {
            const cs = if (isSatisfied(rows, cid)) "satisfied" else "pending";
            outPrint("  [{s}] {s} ({s}) — {s}\n", .{ cs, cid, pointer.inferPointerType(c.action), c.plan });
        }
    }
    return 0;
}

fn score(query: []const u8, plan: []const u8) u32 {
    var qbuf: [2048]u8 = undefined;
    var pbuf: [4096]u8 = undefined;
    const q = std.ascii.lowerString(qbuf[0..@min(qbuf.len, query.len)], query[0..@min(qbuf.len, query.len)]);
    const p = std.ascii.lowerString(pbuf[0..@min(pbuf.len, plan.len)], plan[0..@min(pbuf.len, plan.len)]);
    var total: u32 = 0;
    var it = std.mem.tokenizeAny(u8, q, " \t\r\n.,:;()[]{}\"'");
    while (it.next()) |tok| {
        if (tok.len < 3) continue;
        if (std.mem.indexOf(u8, p, tok) != null) total += 1;
    }
    return total;
}

fn cmdSearch(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    var ctx: []const u8 = "";
    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        if (std.mem.eql(u8, args[i], "--context")) {
            i += 1;
            if (i >= args.len) {
                err("search --context requires a value\n");
                return 2;
            }
            ctx = args[i];
        } else {
            errPrint("search unknown flag: {s}\n", .{args[i]});
            return 2;
        }
    }
    const rows = try parseRows(allocator, env);
    defer allocator.free(rows);
    out("RELATED CONTRACTS (native lexical score):\n\n");
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        const s = score(ctx, r.plan);
        if (s == 0) continue;
        const status = if (isSatisfied(rows, r.id)) "satisfied" else "pending";
        outPrint("  [+] score={d} id={s} status={s}\n      plan: {s}\n", .{ s, r.id, status, r.plan });
    }
    return 0;
}

fn cmdDiscover(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        if (std.mem.eql(u8, args[i], "--scope")) {
            i += 1;
            if (i >= args.len) {
                err("discover --scope requires all, project, or global\n");
                return 2;
            }
            if (!std.mem.eql(u8, args[i], "all") and
                !std.mem.eql(u8, args[i], "project") and
                !std.mem.eql(u8, args[i], "global"))
            {
                err("discover --scope requires all, project, or global\n");
                return 2;
            }
        } else {
            errPrint("discover unknown flag: {s}\n", .{args[i]});
            return 2;
        }
    }
    const rows = try parseRows(allocator, env);
    defer allocator.free(rows);
    var shown: usize = 0;
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        const status = if (isSatisfied(rows, r.id)) "satisfied" else "pending";
        outPrint("[native]  {s} ({s}/{s}) — \"{s}\"\n", .{ r.id, pointer.inferPointerType(r.action), status, r.plan });
        shown += 1;
        if (shown >= 80) break;
    }
    return 0;
}

fn cmdSelf(args: []const []const u8) u8 {
    if (args.len > 1 or (args.len == 1 and !std.mem.eql(u8, args[0], "--json"))) {
        err("self accepts no args or --json\n");
        return 2;
    }
    out(
        "{ \"binary\": \"" ++ BINARY_NAME ++ "\", \"implementation\": \"zig\", \"version\": \"" ++ VERSION ++
            "\", \"public_shape\": \"<binary-name> \\\"<truth claim>\\\"\", \"mode_resolution\": \"auto (env-driven: UNBROWSE_BASE -> remote, else genesis); explicit override flags --remote/--local/--genesis\", \"public_verbs\": [\"the-word\"], \"the_word_phases\": [\"word\",\"firmament\",\"earth\",\"lights\",\"life\",\"image\",\"sabbath\"], \"compat_verbs\": [\"declare\", \"_mark\", \"verify-lineage\", \"sign-binary\", \"verify-self\"], \"unbrowse_base\": \"https://beta-api.unbrowse.ai\", \"llm_compiler_binding\": \"hardcoded\", \"binary_self_attestation\": true, \"empathic_translation_flag\": \"--user <user-aiko-id>\", \"context_verbs\": [\"status\",\"discover\",\"search\",\"self\"], \"shapes\": [\"neuron\"], \"internal_shapes\": [\"cell\",\"funnel\",\"funnel-first\",\"sequence\",\"quorum\",\"loop\",\"harness\",\"contract-ref\"], \"containment_edge\": \"parent_id\", \"cross_edges\": [\"contract-ref\"], \"environment_lineage\": [\"CONTRACT_PARENT_ID\",\"CONTRACT_PARENT\"], \"hook_edges\": {\"pre\": [\"CONTRACT_PREHOOK_ID\",\"CONTRACT_PREHOOK\"], \"post\": [\"CONTRACT_POSTHOOK_ID\",\"CONTRACT_POSTHOOK\"]}, \"adapter_edge\": [\"CONTRACT_ADAPTER_ID\",\"CONTRACT_ADAPTER\"], \"adapter_kind\": [\"CONTRACT_ADAPTER_KIND\",\"CONTRACT_ENVIRONMENT_KIND\"], \"pretool_event_bus\": [\"CONTRACT_EVENT_BUS_ID\",\"CONTRACT_EVENT_BUS\"], \"pretool_event_edge\": [\"CONTRACT_PRETOOL_EVENT_ID\",\"CONTRACT_PRETOOL_EVENT\"], \"event_kind\": [\"CONTRACT_EVENT_KIND\",\"CONTRACT_PRETOOL_KIND\"], \"pretool_contracts_are_ledger_events\": true, \"server_event_bus_stateless\": true, \"adapters_are_server_contracts\": true, \"prompt_compiler\": \"unbrowse-llm\", \"prompt_to_contract_graph\": true, \"prompt_text_is_root_declaration\": true, \"server_integrator\": \"unbrowse-llm\", \"core_loop_native\": true, \"scripts_required_for_core\": false, \"manual_resolution_verbs\": false, \"recursive_firing\": true, \"recursive_children\": true, \"breakpoints\": true, \"fractal_environment_layers\": true, \"multidimensional_dag\": true }\n",
    );
    return 0;
}

pub fn main(init: std.process.Init.Minimal) !u8 {
    const allocator = std.heap.page_allocator;
    var arena: std.heap.ArenaAllocator = .init(allocator);
    defer arena.deinit();
    const argv_z = try init.args.toSlice(arena.allocator());
    if (argv_z.len < 2) {
        usage();
        return 2;
    }
    const verb = argv_z[1];
    var rest = try arena.allocator().alloc([]const u8, argv_z.len - 2);
    for (argv_z[2..], 0..) |a, i| rest[i] = a;

    if (std.mem.eql(u8, verb, "declare")) {
        if (AIKO_DECLARE_ONLY) return try cmdAikoGoal(allocator, init.environ, rest);
        return try cmdDeclare(allocator, init.environ, rest);
    }
    if (AIKO_DECLARE_ONLY) {
        return try cmdAikoGoal(allocator, init.environ, argv_z[1..]);
    }
    if (std.mem.eql(u8, verb, "status")) return try cmdStatus(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "discover")) return try cmdDiscover(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "search")) return try cmdSearch(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "self")) return cmdSelf(rest);
    if (std.mem.eql(u8, verb, "_mark")) return try cmdMark(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "verify-lineage")) return try cmdVerifyLineage(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "sign-binary")) return try cmdSignBinary(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "verify-self")) return try cmdVerifySelf(allocator, init.environ);
    if (std.mem.eql(u8, verb, "verify-binary")) return try cmdVerifyBinary(allocator, init.environ, rest);

    errPrint("unknown native verb: {s}\n", .{verb});
    usage();
    return 2;
}
