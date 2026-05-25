//! contract.zig — public Zig API for libcontract.
//!
//! Owns the append-only row writer for the native contract binary. The public
//! API is deliberately small: declare, record_iteration, mark_satisfied,
//! list_all, and get.
const std = @import("std");
const id_mod = @import("id.zig");
const pointer = @import("pointer.zig");
const ledger = @import("ledger.zig");

pub const DeclareOptions = struct {
    /// Optional parent id; null = root-level contract.
    parent_id: ?[]const u8 = null,
    /// Optional agent override; null = CONTRACT_AGENT env / git config / "".
    agent: ?[]const u8 = null,
    /// Optional cwd override; null = libc getcwd().
    cwd: ?[]const u8 = null,
    // ---- Merged neural-substrate fields (composes contract:d10b3dbb,
    // contract:f93f7205, contract:495babae, contract:15b7a67c). All optional;
    // emitted only when set so legacy callers stay unaffected.
    /// Aiko role on the stateless compiler graph: "goal" | "eval" |
    /// "posthook" | "optimizer".
    aiko_role: ?[]const u8 = null,
    /// "all" | "any" | "quorum:n" | "weighted_sum:t" — promotion aggregator.
    aggregation: ?[]const u8 = null,
    /// "private" | "team" | "public" — projects to graph_namespaces.
    audience: ?[]const u8 = null,
    /// Wallet identity that owns this contract environment.
    wallet_identity: ?[]const u8 = null,
    /// Wallet identity inherited from parent — used for posthook signing.
    parent_wallet_identity: ?[]const u8 = null,
    /// Source contract id this row replicates from (paid out-of-lineage copy).
    replicated_from_contract_id: ?[]const u8 = null,
    /// `embedding:<id>` pointer — vector lives in pgvector, ledger holds pointer.
    embedding_pointer: ?[]const u8 = null,
    /// For eval-role rows: external metric assertion.
    metric_source: ?[]const u8 = null,
    metric_pointer: ?[]const u8 = null,
    metric_assertion: ?[]const u8 = null,
};

extern fn popen(cmd: [*:0]const u8, mode: [*:0]const u8) ?*anyopaque;
extern fn pclose(stream: *anyopaque) c_int;
extern fn fread(ptr: [*]u8, size: usize, nmemb: usize, stream: *anyopaque) usize;

fn nowIsoUtc(buf: []u8) ![]u8 {
    var tv: std.c.timeval = undefined;
    _ = std.c.gettimeofday(&tv, null);
    const secs_total: i64 = @intCast(tv.sec);
    const us_remainder: i64 = @intCast(tv.usec);
    const epoch_secs = std.time.epoch.EpochSeconds{ .secs = @intCast(secs_total) };
    const epoch_day = epoch_secs.getEpochDay();
    const year_day = epoch_day.calculateYearDay();
    const month_day = year_day.calculateMonthDay();
    const day_secs = epoch_secs.getDaySeconds();
    return try std.fmt.bufPrint(buf, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.{d:0>6}Z", .{
        year_day.year,
        month_day.month.numeric(),
        month_day.day_index + 1,
        day_secs.getHoursIntoDay(),
        day_secs.getMinutesIntoHour(),
        day_secs.getSecondsIntoMinute(),
        @as(u64, @intCast(us_remainder)),
    });
}

fn getAgent(allocator: std.mem.Allocator, env: std.process.Environ) ![]u8 {
    if (env.getPosix("CONTRACT_AGENT")) |v| {
        const trimmed = std.mem.trim(u8, v, " \t\r\n");
        if (trimmed.len > 0) return try allocator.dupe(u8, trimmed);
    }
    var pipe_buf: [256]u8 = undefined;
    const cmd: [*:0]const u8 = "git config user.email 2>/dev/null";
    const f = popen(cmd, "r");
    if (f == null) return try allocator.dupe(u8, "");
    defer _ = pclose(f.?);
    var total: usize = 0;
    while (total < pipe_buf.len - 1) {
        const got = fread(pipe_buf[total..].ptr, 1, pipe_buf.len - 1 - total, f.?);
        if (got == 0) break;
        total += got;
    }
    const out = std.mem.trim(u8, pipe_buf[0..total], " \t\r\n");
    return try allocator.dupe(u8, out);
}

fn writeJsonString(out: *std.ArrayList(u8), allocator: std.mem.Allocator, s: []const u8) !void {
    try out.append(allocator, '"');
    for (s) |c| {
        switch (c) {
            '"' => try out.appendSlice(allocator, "\\\""),
            '\\' => try out.appendSlice(allocator, "\\\\"),
            '\n' => try out.appendSlice(allocator, "\\n"),
            '\r' => try out.appendSlice(allocator, "\\r"),
            '\t' => try out.appendSlice(allocator, "\\t"),
            0x08 => try out.appendSlice(allocator, "\\b"),
            0x0c => try out.appendSlice(allocator, "\\f"),
            else => {
                if (c < 0x20) {
                    var buf: [8]u8 = undefined;
                    const hex = try std.fmt.bufPrint(&buf, "\\u{x:0>4}", .{c});
                    try out.appendSlice(allocator, hex);
                } else {
                    try out.append(allocator, c);
                }
            },
        }
    }
    try out.append(allocator, '"');
}

/// Declare a contract. Returns an owned 8-hex id slice; caller frees.
///
/// Write a `declared` row. If parent_id is set, a follow-on `child_added` row
/// is appended.
pub fn declare(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    plan: []const u8,
    action: []const u8,
    opts: DeclareOptions,
) ![]u8 {
    const cid = try id_mod.generateId(allocator);
    errdefer allocator.free(cid);

    const ptype = pointer.inferPointerType(action);
    const layer = pointer.inferLayer(action);

    var ts_buf: [64]u8 = undefined;
    const ts = try nowIsoUtc(&ts_buf);

    var cwd_buf: [4096]u8 = undefined;
    const cwd: []const u8 = blk: {
        if (opts.cwd) |c| break :blk c;
        const cwd_ptr = std.c.getcwd(&cwd_buf, cwd_buf.len);
        if (cwd_ptr == null) break :blk "";
        break :blk std.mem.span(@as([*:0]const u8, @ptrCast(cwd_ptr.?)));
    };

    var owned_agent: ?[]u8 = null;
    defer if (owned_agent) |a| allocator.free(a);
    const agent: []const u8 = blk: {
        if (opts.agent) |a| break :blk a;
        owned_agent = try getAgent(allocator, env);
        break :blk owned_agent.?;
    };

    const refs = try pointer.extractContractRefs(allocator, action);
    defer {
        for (refs) |r| allocator.free(r);
        allocator.free(refs);
    }

    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);

    try buf.appendSlice(allocator, "{\"event\": \"declared\", \"id\": ");
    try writeJsonString(&buf, allocator, cid);
    try buf.appendSlice(allocator, ", \"plan\": ");
    try writeJsonString(&buf, allocator, plan);
    try buf.appendSlice(allocator, ", \"action\": ");
    try writeJsonString(&buf, allocator, action);
    try buf.appendSlice(allocator, ", \"pointer_type\": ");
    try writeJsonString(&buf, allocator, ptype);
    try buf.appendSlice(allocator, ", \"layer\": ");
    var layer_buf: [16]u8 = undefined;
    const layer_str = try std.fmt.bufPrint(&layer_buf, "{d}", .{layer});
    try buf.appendSlice(allocator, layer_str);
    try buf.appendSlice(allocator, ", \"cwd\": ");
    try writeJsonString(&buf, allocator, cwd);
    try buf.appendSlice(allocator, ", \"parent_id\": ");
    if (opts.parent_id) |p| {
        try writeJsonString(&buf, allocator, p);
    } else {
        try buf.appendSlice(allocator, "null");
    }
    try buf.appendSlice(allocator, ", \"pointers\": [");
    for (refs, 0..) |r, idx| {
        if (idx > 0) try buf.appendSlice(allocator, ", ");
        try writeJsonString(&buf, allocator, r);
    }
    try buf.appendSlice(allocator, "], \"ts\": ");
    try writeJsonString(&buf, allocator, ts);
    try buf.appendSlice(allocator, ", \"agent\": ");
    try writeJsonString(&buf, allocator, agent);
    try buf.append(allocator, '}');

    const path = try ledger.appendRow(allocator, env, buf.items);
    allocator.free(path);

    if (opts.parent_id) |p| {
        var child_buf: std.ArrayList(u8) = .empty;
        defer child_buf.deinit(allocator);
        try child_buf.appendSlice(allocator, "{\"event\": \"child_added\", \"id\": ");
        try writeJsonString(&child_buf, allocator, p);
        try child_buf.appendSlice(allocator, ", \"child_id\": ");
        try writeJsonString(&child_buf, allocator, cid);
        try child_buf.appendSlice(allocator, ", \"ts\": ");
        var ts2_buf: [64]u8 = undefined;
        const ts2 = try nowIsoUtc(&ts2_buf);
        try writeJsonString(&child_buf, allocator, ts2);
        try child_buf.appendSlice(allocator, ", \"agent\": ");
        try writeJsonString(&child_buf, allocator, agent);
        try child_buf.append(allocator, '}');
        const p2 = try ledger.appendRow(allocator, env, child_buf.items);
        allocator.free(p2);
    }

    return cid;
}

/// Append an `iterated` event row.
pub fn recordIteration(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
    wave: u32,
    action_exit: i32,
    action_result: []const u8,
) !void {
    var ts_buf: [64]u8 = undefined;
    const ts = try nowIsoUtc(&ts_buf);

    const agent = try getAgent(allocator, env);
    defer allocator.free(agent);

    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);

    try buf.appendSlice(allocator, "{\"event\": \"iterated\", \"id\": ");
    try writeJsonString(&buf, allocator, id);
    try buf.appendSlice(allocator, ", \"wave\": ");
    var num_buf: [16]u8 = undefined;
    const w = try std.fmt.bufPrint(&num_buf, "{d}", .{wave});
    try buf.appendSlice(allocator, w);
    try buf.appendSlice(allocator, ", \"action_exit\": ");
    var num_buf2: [16]u8 = undefined;
    const e = try std.fmt.bufPrint(&num_buf2, "{d}", .{action_exit});
    try buf.appendSlice(allocator, e);
    try buf.appendSlice(allocator, ", \"action_result\": ");
    try writeJsonString(&buf, allocator, action_result);
    try buf.appendSlice(allocator, ", \"agent_verdict\": null, \"children_spawned\": [], \"log_path\": \"\", \"ts\": ");
    try writeJsonString(&buf, allocator, ts);
    try buf.appendSlice(allocator, ", \"agent\": ");
    try writeJsonString(&buf, allocator, agent);
    try buf.append(allocator, '}');

    const path = try ledger.appendRow(allocator, env, buf.items);
    allocator.free(path);
}

/// Append a `satisfied` event row.
pub fn markSatisfied(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
    wave: u32,
    proof: ?[]const u8,
) !void {
    var ts_buf: [64]u8 = undefined;
    const ts = try nowIsoUtc(&ts_buf);

    const agent = try getAgent(allocator, env);
    defer allocator.free(agent);

    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);

    try buf.appendSlice(allocator, "{\"event\": \"satisfied\", \"id\": ");
    try writeJsonString(&buf, allocator, id);
    try buf.appendSlice(allocator, ", \"wave\": ");
    var num_buf: [16]u8 = undefined;
    const w = try std.fmt.bufPrint(&num_buf, "{d}", .{wave});
    try buf.appendSlice(allocator, w);
    try buf.appendSlice(allocator, ", \"ts\": ");
    try writeJsonString(&buf, allocator, ts);
    if (proof) |p| {
        try buf.appendSlice(allocator, ", \"proof\": ");
        try writeJsonString(&buf, allocator, p);
    }
    try buf.appendSlice(allocator, ", \"agent\": ");
    try writeJsonString(&buf, allocator, agent);
    try buf.append(allocator, '}');

    const path = try ledger.appendRow(allocator, env, buf.items);
    allocator.free(path);
}

/// Return the raw JSONL bytes of the resolved ledger (or empty when missing).
/// Caller owns the returned slice.
pub fn readAll(allocator: std.mem.Allocator, env: std.process.Environ) ![]u8 {
    return ledger.readAll(allocator, env);
}

/// Return all raw rows whose `id` field equals `target`, concatenated as
/// newline-terminated JSONL bytes. Caller owns the returned slice.
pub fn get(allocator: std.mem.Allocator, env: std.process.Environ, target: []const u8) ![]u8 {
    const data = try readAll(allocator, env);
    defer allocator.free(data);

    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(allocator);

    var it = std.mem.splitScalar(u8, data, '\n');
    while (it.next()) |line| {
        if (line.len == 0) continue;
        // Naive substring match on "\"id\": \"<target>\"" — every row writes
        // id as the second key, so this is unambiguous for the bootstrap.
        const needle_part1 = "\"id\": \"";
        if (std.mem.indexOf(u8, line, needle_part1)) |idx| {
            const start = idx + needle_part1.len;
            if (start + target.len + 1 <= line.len and
                std.mem.startsWith(u8, line[start..], target) and
                line[start + target.len] == '"')
            {
                try out.appendSlice(allocator, line);
                try out.append(allocator, '\n');
            }
        }
    }
    return try out.toOwnedSlice(allocator);
}

/// Return `<id>\t<plan>\n` lines, one per `declared` row in the ledger.
/// Caller owns the slice. Plan is parsed naively from the JSON string after
/// the `"plan": "` marker; embedded escapes are surfaced unescaped. Callers
/// re-parse the ledger if richer access is needed.
pub fn listAll(allocator: std.mem.Allocator, env: std.process.Environ) ![]u8 {
    const data = try readAll(allocator, env);
    defer allocator.free(data);

    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(allocator);

    var it = std.mem.splitScalar(u8, data, '\n');
    while (it.next()) |line| {
        if (line.len == 0) continue;
        if (std.mem.indexOf(u8, line, "\"event\": \"declared\"") == null) continue;
        const id_marker = "\"id\": \"";
        const plan_marker = "\"plan\": \"";
        const id_at = std.mem.indexOf(u8, line, id_marker) orelse continue;
        const id_start = id_at + id_marker.len;
        if (id_start + 8 > line.len) continue;
        const id_slice = line[id_start .. id_start + 8];
        // plan starts after plan_marker; ends at the next unescaped quote.
        const plan_at = std.mem.indexOf(u8, line, plan_marker) orelse continue;
        const plan_start = plan_at + plan_marker.len;
        var i: usize = plan_start;
        while (i < line.len) : (i += 1) {
            if (line[i] == '\\') {
                i += 1;
                continue;
            }
            if (line[i] == '"') break;
        }
        const plan_slice = line[plan_start..i];
        try out.appendSlice(allocator, id_slice);
        try out.append(allocator, '\t');
        try out.appendSlice(allocator, plan_slice);
        try out.append(allocator, '\n');
    }
    return try out.toOwnedSlice(allocator);
}

test "nowIsoUtc emits Z-terminated ISO-8601 timestamp" {
    var buf_ts: [64]u8 = undefined;
    const ts = try nowIsoUtc(&buf_ts);
    try std.testing.expect(ts.len >= 20);
    try std.testing.expectEqual(@as(u8, 'Z'), ts[ts.len - 1]);
}
