//! scheduler.zig — deterministic wall-clock occurrence planning.
//!
//! Contract owns when a durable contract becomes runnable.  This module is
//! deliberately execution-agnostic: it derives stable occurrence keys from
//! the ledger, atomically materializes new occurrences, and reports the next
//! wall-clock deadline.  The CLI, native ABI, and host applications all call
//! this same kernel.

const std = @import("std");
const ledger = @import("ledger.zig");
const cache = @import("cache.zig");

pub const TriggerSpec = union(enum) {
    none,
    at_unix: i64,
    repeat_seconds: u64,
    dependency: []const u8,
    event_name: []const u8,
};

pub const Occurrence = struct {
    contract_id: []u8,
    key: []u8,
    due_unix: i64,
    was_satisfied: bool,

    pub fn deinit(self: *Occurrence, allocator: std.mem.Allocator) void {
        allocator.free(self.contract_id);
        allocator.free(self.key);
        self.* = undefined;
    }
};

pub const TickPlan = struct {
    occurrences: []Occurrence,
    next_wake_unix: ?i64,

    pub fn deinit(self: *TickPlan, allocator: std.mem.Allocator) void {
        for (self.occurrences) |*occurrence| occurrence.deinit(allocator);
        allocator.free(self.occurrences);
        self.* = undefined;
    }
};

pub const Claim = struct {
    contract_id: []u8,
    occurrence: []u8,
    prompt: []u8,
    cwd: []u8,
    due_unix: i64,
    lease_until_unix: i64,

    pub fn deinit(self: *Claim, allocator: std.mem.Allocator) void {
        allocator.free(self.contract_id);
        allocator.free(self.occurrence);
        allocator.free(self.prompt);
        allocator.free(self.cwd);
        self.* = undefined;
    }
};

pub const ClaimBatch = struct {
    claims: []Claim,
    next_wake_unix: ?i64,

    pub fn deinit(self: *ClaimBatch, allocator: std.mem.Allocator) void {
        for (self.claims) |*claim| claim.deinit(allocator);
        allocator.free(self.claims);
        self.* = undefined;
    }
};

pub const SettleOutcome = enum {
    satisfied,
    retry,
    died,
};

fn extractStringField(line: []const u8, key: []const u8) ?[]const u8 {
    var marker_buf: [96]u8 = undefined;
    const marker = std.fmt.bufPrint(&marker_buf, "\"{s}\"", .{key}) catch return null;
    const marker_at = std.mem.indexOf(u8, line, marker) orelse return null;
    var i = marker_at + marker.len;
    while (i < line.len and std.ascii.isWhitespace(line[i])) : (i += 1) {}
    if (i >= line.len or line[i] != ':') return null;
    i += 1;
    while (i < line.len and std.ascii.isWhitespace(line[i])) : (i += 1) {}
    if (i >= line.len or line[i] != '"') return null;
    i += 1;
    const start = i;
    while (i < line.len) : (i += 1) {
        if (line[i] == '\\') {
            i += 1;
            continue;
        }
        if (line[i] == '"') return line[start..i];
    }
    return null;
}

fn eventIs(line: []const u8, expected: []const u8) bool {
    const event = extractStringField(line, "event") orelse return false;
    return std.mem.eql(u8, event, expected);
}

fn triggerToken(text: []const u8, prefix: []const u8) ?[]const u8 {
    const at = std.mem.indexOf(u8, text, prefix) orelse return null;
    const start = at + prefix.len;
    var end = start;
    while (end < text.len and
        !std.ascii.isWhitespace(text[end]) and
        text[end] != ',' and
        text[end] != ']') : (end += 1)
    {}
    return if (end > start) text[start..end] else null;
}

fn notBefore(action: []const u8, plan: []const u8) ?i64 {
    const token = triggerToken(action, "not_before:") orelse
        triggerToken(plan, "not_before:") orelse return null;
    return std.fmt.parseInt(i64, token, 10) catch null;
}

/// Canonical syntax:
///   at:<unix-seconds>
///   repeat:<N>s | repeat:<N>m | repeat:<N>h
pub fn triggerForText(action: []const u8, plan: []const u8) TriggerSpec {
    if (triggerToken(action, "when:contract:") orelse
        triggerToken(plan, "when:contract:")) |id|
    {
        if (id.len == 8) {
            for (id) |ch| {
                if (!std.ascii.isHex(ch)) return .none;
            }
            return .{ .dependency = id };
        }
        return .none;
    }
    if (triggerToken(action, "when:event:") orelse triggerToken(plan, "when:event:")) |name| {
        if (name.len > 0 and name.len <= 128) return .{ .event_name = name };
        return .none;
    }
    if (triggerToken(action, "at:") orelse triggerToken(plan, "at:")) |token| {
        if (std.fmt.parseInt(i64, token, 10)) |unix| return .{ .at_unix = unix } else |_| {}
    }
    if (triggerToken(action, "repeat:") orelse triggerToken(plan, "repeat:")) |token| {
        if (std.mem.eql(u8, token, "always")) return .{ .repeat_seconds = 1 };
        if (token.len < 2) return .none;
        const multiplier: u64 = switch (token[token.len - 1]) {
            's' => 1,
            'm' => 60,
            'h' => 3600,
            else => return .none,
        };
        const count = std.fmt.parseInt(u64, token[0 .. token.len - 1], 10) catch return .none;
        if (count == 0 or count > @as(u64, @intCast(std.math.maxInt(i64))) / multiplier) return .none;
        return .{ .repeat_seconds = count * multiplier };
    }
    return .none;
}

fn latestSatisfiedLine(body: []const u8, id: []const u8) ?[]const u8 {
    var latest: ?[]const u8 = null;
    var latest_is_satisfied = false;
    var start: usize = 0;
    while (start < body.len) {
        const bounds = lineBounds(body, start);
        defer start = bounds.next;
        const row_id = extractStringField(bounds.line, "id") orelse continue;
        if (!std.mem.eql(u8, row_id, id)) continue;
        const event = extractStringField(bounds.line, "event") orelse continue;
        if (std.mem.eql(u8, event, "satisfied")) {
            latest = bounds.line;
            latest_is_satisfied = true;
        } else if (std.mem.eql(u8, event, "died") or std.mem.eql(u8, event, "purged")) {
            latest = null;
            latest_is_satisfied = false;
        }
    }
    return if (latest_is_satisfied) latest else null;
}

fn dependencyOccurrence(
    allocator: std.mem.Allocator,
    body: []const u8,
    dependency_id: []const u8,
) !?[]u8 {
    const satisfied_line = latestSatisfiedLine(body, dependency_id) orelse return null;
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(satisfied_line, &digest, .{});
    return try std.fmt.allocPrint(
        allocator,
        "dependency:{s}:{x}",
        .{ dependency_id, digest[0..8] },
    );
}

fn latestSignalLine(
    body: []const u8,
    name: []const u8,
    required_cwd: []const u8,
) ?[]const u8 {
    var latest: ?[]const u8 = null;
    var start: usize = 0;
    while (start < body.len) {
        const bounds = lineBounds(body, start);
        defer start = bounds.next;
        if (!eventIs(bounds.line, "signal")) continue;
        const row_name = extractStringField(bounds.line, "name") orelse continue;
        if (!std.mem.eql(u8, row_name, name)) continue;
        if (required_cwd.len > 0) {
            const row_cwd = extractStringField(bounds.line, "cwd") orelse continue;
            if (!std.mem.eql(u8, row_cwd, required_cwd)) continue;
        }
        latest = bounds.line;
    }
    return latest;
}

fn eventOccurrence(
    allocator: std.mem.Allocator,
    body: []const u8,
    name: []const u8,
    cwd: []const u8,
) !?[]u8 {
    const signal_line = latestSignalLine(body, name, cwd) orelse return null;
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(signal_line, &digest, .{});
    return try std.fmt.allocPrint(allocator, "event:{s}:{x}", .{ name, digest[0..8] });
}

fn lineBounds(body: []const u8, start: usize) struct { line: []const u8, next: usize } {
    const end = std.mem.indexOfScalarPos(u8, body, start, '\n') orelse body.len;
    return .{ .line = body[start..end], .next = if (end < body.len) end + 1 else body.len };
}

fn isDead(body: []const u8, id: []const u8) bool {
    var start: usize = 0;
    while (start < body.len) {
        const bounds = lineBounds(body, start);
        defer start = bounds.next;
        const row_id = extractStringField(bounds.line, "id") orelse continue;
        if (!std.mem.eql(u8, row_id, id)) continue;
        if (eventIs(bounds.line, "died") or eventIs(bounds.line, "purged")) return true;
    }
    return false;
}

fn latestOccurrence(body: []const u8, id: []const u8) ?[]const u8 {
    var result: ?[]const u8 = null;
    var start: usize = 0;
    while (start < body.len) {
        const bounds = lineBounds(body, start);
        defer start = bounds.next;
        if (!eventIs(bounds.line, "triggered")) continue;
        const row_id = extractStringField(bounds.line, "id") orelse continue;
        if (!std.mem.eql(u8, row_id, id)) continue;
        result = extractStringField(bounds.line, "occurrence");
    }
    return result;
}

fn latestTerminalIsSatisfied(body: []const u8, id: []const u8) bool {
    var satisfied = false;
    var found = false;
    var start: usize = 0;
    while (start < body.len) {
        const bounds = lineBounds(body, start);
        defer start = bounds.next;
        const row_id = extractStringField(bounds.line, "id") orelse continue;
        if (!std.mem.eql(u8, row_id, id)) continue;
        const event = extractStringField(bounds.line, "event") orelse continue;
        if (std.mem.eql(u8, event, "satisfied")) {
            satisfied = true;
            found = true;
        } else if (std.mem.eql(u8, event, "failed") or
            std.mem.eql(u8, event, "died") or
            std.mem.eql(u8, event, "purged"))
        {
            satisfied = false;
            found = true;
        }
    }
    return found and satisfied;
}

fn extractIntField(line: []const u8, key: []const u8) ?i64 {
    var marker_buf: [96]u8 = undefined;
    const marker = std.fmt.bufPrint(&marker_buf, "\"{s}\"", .{key}) catch return null;
    const marker_at = std.mem.indexOf(u8, line, marker) orelse return null;
    var i = marker_at + marker.len;
    while (i < line.len and (std.ascii.isWhitespace(line[i]) or line[i] == ':')) : (i += 1) {}
    const start = i;
    if (i < line.len and line[i] == '-') i += 1;
    while (i < line.len and std.ascii.isDigit(line[i])) : (i += 1) {}
    if (i == start) return null;
    return std.fmt.parseInt(i64, line[start..i], 10) catch null;
}

const ExecutionState = struct {
    settled: bool = false,
    claim_owner: ?[]const u8 = null,
    lease_until_unix: i64 = 0,
};

fn executionState(body: []const u8, id: []const u8, occurrence: []const u8) ExecutionState {
    var state: ExecutionState = .{};
    var start: usize = 0;
    while (start < body.len) {
        const bounds = lineBounds(body, start);
        defer start = bounds.next;
        const row_id = extractStringField(bounds.line, "id") orelse continue;
        if (!std.mem.eql(u8, row_id, id)) continue;
        const row_occurrence = extractStringField(bounds.line, "occurrence") orelse continue;
        if (!std.mem.eql(u8, row_occurrence, occurrence)) continue;
        if (eventIs(bounds.line, "execution_claimed")) {
            state.settled = false;
            state.claim_owner = extractStringField(bounds.line, "owner");
            state.lease_until_unix = extractIntField(bounds.line, "lease_until_unix") orelse 0;
        } else if (eventIs(bounds.line, "execution_released")) {
            state.settled = false;
            state.claim_owner = null;
            state.lease_until_unix = extractIntField(bounds.line, "retry_after_unix") orelse 0;
        } else if (eventIs(bounds.line, "execution_settled")) {
            state.settled = true;
            state.claim_owner = null;
            state.lease_until_unix = 0;
        }
    }
    return state;
}

fn retryCount(body: []const u8, id: []const u8, occurrence: []const u8) u32 {
    var count: u32 = 0;
    var start: usize = 0;
    while (start < body.len) {
        const bounds = lineBounds(body, start);
        defer start = bounds.next;
        if (!eventIs(bounds.line, "execution_released")) continue;
        const row_id = extractStringField(bounds.line, "id") orelse continue;
        const row_occurrence = extractStringField(bounds.line, "occurrence") orelse continue;
        if (std.mem.eql(u8, row_id, id) and std.mem.eql(u8, row_occurrence, occurrence)) {
            count +|= 1;
        }
    }
    return count;
}

fn minDeadline(current: ?i64, candidate: i64) i64 {
    return if (current) |value| @min(value, candidate) else candidate;
}

fn appendJsonString(out: *std.ArrayList(u8), allocator: std.mem.Allocator, value: []const u8) !void {
    try out.append(allocator, '"');
    for (value) |ch| switch (ch) {
        '"' => try out.appendSlice(allocator, "\\\""),
        '\\' => try out.appendSlice(allocator, "\\\\"),
        '\n' => try out.appendSlice(allocator, "\\n"),
        '\r' => try out.appendSlice(allocator, "\\r"),
        '\t' => try out.appendSlice(allocator, "\\t"),
        else => if (ch >= 0x20) try out.append(allocator, ch),
    };
    try out.append(allocator, '"');
}

fn appendExecutionEvent(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    event: []const u8,
    id: []const u8,
    occurrence: []const u8,
    owner: []const u8,
    now_unix: i64,
    lease_until_unix: ?i64,
    outcome: ?SettleOutcome,
    detail: ?[]const u8,
) !void {
    var row: std.ArrayList(u8) = .empty;
    defer row.deinit(allocator);
    try row.appendSlice(allocator, "{\"event\":");
    try appendJsonString(&row, allocator, event);
    try row.appendSlice(allocator, ",\"id\":");
    try appendJsonString(&row, allocator, id);
    try row.appendSlice(allocator, ",\"occurrence\":");
    try appendJsonString(&row, allocator, occurrence);
    try row.appendSlice(allocator, ",\"owner\":");
    try appendJsonString(&row, allocator, owner);
    try row.appendSlice(allocator, ",\"ts_unix\":");
    try row.print(allocator, "{d}", .{now_unix});
    if (lease_until_unix) |lease| {
        const deadline_key = if (std.mem.eql(u8, event, "execution_released"))
            ",\"retry_after_unix\":"
        else
            ",\"lease_until_unix\":";
        try row.appendSlice(allocator, deadline_key);
        try row.print(allocator, "{d}", .{lease});
    }
    if (outcome) |settled| {
        try row.appendSlice(allocator, ",\"outcome\":");
        try appendJsonString(&row, allocator, @tagName(settled));
    }
    if (detail) |text| {
        try row.appendSlice(allocator, ",\"detail\":");
        try appendJsonString(&row, allocator, text);
    }
    try row.append(allocator, '}');
    const path = try ledger.appendRow(allocator, env, row.items);
    allocator.free(path);
}

/// Pure planner over JSONL. It performs no I/O and is therefore suitable for
/// deterministic tests and for hosts that mirror a ledger.
pub fn planDueFromJson(
    allocator: std.mem.Allocator,
    body: []const u8,
    now_unix: i64,
    max_items: usize,
) !TickPlan {
    var offsets: std.ArrayList(usize) = .empty;
    defer offsets.deinit(allocator);
    if (body.len > 0) try offsets.append(allocator, 0);
    for (body, 0..) |ch, i| {
        if (ch == '\n' and i + 1 < body.len) try offsets.append(allocator, i + 1);
    }

    var seen: std.StringHashMap(void) = .init(allocator);
    defer seen.deinit();
    var due: std.ArrayList(Occurrence) = .empty;
    errdefer {
        for (due.items) |*occurrence| occurrence.deinit(allocator);
        due.deinit(allocator);
    }
    var next_wake: ?i64 = null;

    var index = offsets.items.len;
    while (index > 0) : (index -= 1) {
        const bounds = lineBounds(body, offsets.items[index - 1]);
        const line = bounds.line;
        if (!eventIs(line, "declared")) continue;
        const id = extractStringField(line, "id") orelse continue;
        if (seen.contains(id)) continue;
        try seen.put(id, {});
        if (isDead(body, id)) continue;

        const action = extractStringField(line, "action") orelse "";
        const plan = extractStringField(line, "plan") orelse "";
        const declared_cwd = extractStringField(line, "cwd") orelse "";
        var occurrence_key: ?[]u8 = null;
        var due_unix = now_unix;
        switch (triggerForText(action, plan)) {
            .none => continue,
            .at_unix => |at| {
                due_unix = at;
                if (now_unix < at) {
                    next_wake = minDeadline(next_wake, at);
                    continue;
                }
                occurrence_key = try std.fmt.allocPrint(allocator, "at:{d}", .{at});
            },
            .repeat_seconds => |period| {
                if (notBefore(action, plan)) |start_at| {
                    if (now_unix < start_at) {
                        next_wake = minDeadline(next_wake, start_at);
                        continue;
                    }
                }
                const period_i64: i64 = @intCast(period);
                const bucket = @divFloor(now_unix, period_i64);
                due_unix = bucket * period_i64;
                next_wake = minDeadline(next_wake, (bucket + 1) * period_i64);
                occurrence_key = try std.fmt.allocPrint(allocator, "repeat:{d}:{d}", .{ period, bucket });
            },
            .dependency => |dependency_id| {
                occurrence_key = try dependencyOccurrence(allocator, body, dependency_id) orelse continue;
            },
            .event_name => |name| {
                occurrence_key = try eventOccurrence(allocator, body, name, declared_cwd) orelse continue;
            },
        }
        const key = occurrence_key.?;
        const prior = latestOccurrence(body, id);
        if (prior != null and std.mem.eql(u8, prior.?, key)) {
            allocator.free(key);
            continue;
        }
        if (due.items.len >= max_items) {
            allocator.free(key);
            next_wake = minDeadline(next_wake, now_unix);
            continue;
        }
        try due.append(allocator, .{
            .contract_id = try allocator.dupe(u8, id),
            .key = key,
            .due_unix = due_unix,
            .was_satisfied = latestTerminalIsSatisfied(body, id),
        });
    }

    return .{
        .occurrences = try due.toOwnedSlice(allocator),
        .next_wake_unix = next_wake,
    };
}

/// Atomically plan and append all bounded due occurrences. The returned plan
/// owns its strings and remains valid after the ledger lock is released.
pub fn materializeDueTriggersAt(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    now_unix: i64,
    max_items: usize,
) !TickPlan {
    const lock_fd = try ledger.acquireExclusive(allocator, env);
    defer ledger.releaseExclusive(lock_fd);

    const body = try ledger.readAll(allocator, env);
    defer allocator.free(body);
    var plan = try planDueFromJson(allocator, body, now_unix, max_items);
    errdefer plan.deinit(allocator);
    for (plan.occurrences) |occurrence| {
        try cache.appendTriggeredRow(allocator, env, occurrence.contract_id, occurrence.key);
        if (occurrence.was_satisfied) {
            try cache.appendCacheInvalidatedRow(
                allocator,
                env,
                occurrence.contract_id,
                occurrence.contract_id,
                "trigger_occurrence_changed",
            );
        }
    }
    return plan;
}

/// Reconcile due wall-clock contracts and atomically lease runnable
/// occurrences to one host. Delivery is at-least-once: an un-settled claim
/// becomes runnable again after its lease expires.
pub fn claimDueAt(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    now_unix: i64,
    max_items: usize,
    owner: []const u8,
    lease_seconds: u32,
    scope_cwd: ?[]const u8,
) !ClaimBatch {
    if (owner.len == 0 or lease_seconds == 0) return error.InvalidClaim;
    const lock_fd = try ledger.acquireExclusive(allocator, env);
    defer ledger.releaseExclusive(lock_fd);
    const body = try ledger.readAll(allocator, env);
    defer allocator.free(body);

    var offsets: std.ArrayList(usize) = .empty;
    defer offsets.deinit(allocator);
    if (body.len > 0) try offsets.append(allocator, 0);
    for (body, 0..) |ch, i| {
        if (ch == '\n' and i + 1 < body.len) try offsets.append(allocator, i + 1);
    }
    var seen: std.StringHashMap(void) = .init(allocator);
    defer seen.deinit();
    var claims: std.ArrayList(Claim) = .empty;
    errdefer {
        for (claims.items) |*claim| claim.deinit(allocator);
        claims.deinit(allocator);
    }
    var next_wake: ?i64 = null;
    const lease_until = std.math.add(i64, now_unix, @as(i64, lease_seconds)) catch std.math.maxInt(i64);

    var index = offsets.items.len;
    while (index > 0) : (index -= 1) {
        const line = lineBounds(body, offsets.items[index - 1]).line;
        if (!eventIs(line, "declared")) continue;
        const id = extractStringField(line, "id") orelse continue;
        if (seen.contains(id)) continue;
        try seen.put(id, {});
        if (isDead(body, id)) continue;
        if (scope_cwd) |required_cwd| {
            const declared_cwd = extractStringField(line, "cwd") orelse continue;
            if (!std.mem.eql(u8, declared_cwd, required_cwd)) continue;
        }
        const action = extractStringField(line, "action") orelse "";
        const plan = extractStringField(line, "plan") orelse "";
        const declared_cwd = extractStringField(line, "cwd") orelse "";
        var due_unix = now_unix;
        var key: []u8 = undefined;
        switch (triggerForText(action, plan)) {
            .none => continue,
            .at_unix => |at| {
                if (now_unix < at) {
                    next_wake = minDeadline(next_wake, at);
                    continue;
                }
                due_unix = at;
                key = try std.fmt.allocPrint(allocator, "at:{d}", .{at});
            },
            .repeat_seconds => |period| {
                if (notBefore(action, plan)) |start_at| {
                    if (now_unix < start_at) {
                        next_wake = minDeadline(next_wake, start_at);
                        continue;
                    }
                }
                const period_i64: i64 = @intCast(period);
                const bucket = @divFloor(now_unix, period_i64);
                due_unix = bucket * period_i64;
                next_wake = minDeadline(next_wake, (bucket + 1) * period_i64);
                key = try std.fmt.allocPrint(allocator, "repeat:{d}:{d}", .{ period, bucket });
            },
            .dependency => |dependency_id| {
                key = try dependencyOccurrence(allocator, body, dependency_id) orelse continue;
            },
            .event_name => |name| {
                key = try eventOccurrence(allocator, body, name, declared_cwd) orelse continue;
            },
        }
        defer allocator.free(key);

        const prior = latestOccurrence(body, id);
        if (prior == null or !std.mem.eql(u8, prior.?, key)) {
            try cache.appendTriggeredRow(allocator, env, id, key);
            if (latestTerminalIsSatisfied(body, id)) {
                try cache.appendCacheInvalidatedRow(
                    allocator,
                    env,
                    id,
                    id,
                    "trigger_occurrence_changed",
                );
            }
        }

        const state = executionState(body, id, key);
        if (state.settled) continue;
        if (state.lease_until_unix > now_unix) {
            next_wake = minDeadline(next_wake, state.lease_until_unix);
            continue;
        }
        if (claims.items.len >= max_items) {
            next_wake = minDeadline(next_wake, now_unix);
            continue;
        }
        try appendExecutionEvent(
            allocator,
            env,
            "execution_claimed",
            id,
            key,
            owner,
            now_unix,
            lease_until,
            null,
            null,
        );
        try claims.append(allocator, .{
            .contract_id = try allocator.dupe(u8, id),
            .occurrence = try allocator.dupe(u8, key),
            .prompt = try allocator.dupe(u8, plan),
            .cwd = try allocator.dupe(u8, declared_cwd),
            .due_unix = due_unix,
            .lease_until_unix = lease_until,
        });
    }

    return .{
        .claims = try claims.toOwnedSlice(allocator),
        .next_wake_unix = next_wake,
    };
}

/// Close or release one leased occurrence. A late worker may settle only
/// while it is still the latest claimant, preventing an expired worker from
/// overwriting a newer execution.
pub fn settleExecutionAt(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    now_unix: i64,
    id: []const u8,
    occurrence: []const u8,
    owner: []const u8,
    outcome: SettleOutcome,
    detail: []const u8,
) !void {
    const lock_fd = try ledger.acquireExclusive(allocator, env);
    defer ledger.releaseExclusive(lock_fd);
    const body = try ledger.readAll(allocator, env);
    defer allocator.free(body);
    const state = executionState(body, id, occurrence);
    if (state.settled) return;
    const claimant = state.claim_owner orelse return error.NotClaimed;
    if (!std.mem.eql(u8, claimant, owner)) return error.StaleClaim;
    const event = if (outcome == .retry) "execution_released" else "execution_settled";
    const retry_after = if (outcome == .retry) blk: {
        const exponent = @min(retryCount(body, id, occurrence), 6);
        const backoff_seconds: i64 = @as(i64, 60) << @intCast(exponent);
        break :blk std.math.add(i64, now_unix, backoff_seconds) catch std.math.maxInt(i64);
    } else null;
    try appendExecutionEvent(
        allocator,
        env,
        event,
        id,
        occurrence,
        owner,
        now_unix,
        retry_after,
        outcome,
        detail,
    );
}

/// Extend an active lease owned by the same worker. Renewal is another
/// append-only claim row, so crash recovery requires no mutable side table.
pub fn renewExecutionAt(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    now_unix: i64,
    id: []const u8,
    occurrence: []const u8,
    owner: []const u8,
    lease_seconds: u32,
) !i64 {
    if (lease_seconds == 0) return error.InvalidClaim;
    const lock_fd = try ledger.acquireExclusive(allocator, env);
    defer ledger.releaseExclusive(lock_fd);
    const body = try ledger.readAll(allocator, env);
    defer allocator.free(body);
    const state = executionState(body, id, occurrence);
    if (state.settled) return error.AlreadySettled;
    const claimant = state.claim_owner orelse return error.NotClaimed;
    if (!std.mem.eql(u8, claimant, owner)) return error.StaleClaim;
    const lease_until =
        std.math.add(i64, now_unix, @as(i64, lease_seconds)) catch std.math.maxInt(i64);
    try appendExecutionEvent(
        allocator,
        env,
        "execution_claimed",
        id,
        occurrence,
        owner,
        now_unix,
        lease_until,
        null,
        "lease_renewed",
    );
    return lease_until;
}

/// Operator-directed retry of the latest occurrence for one contract.
pub fn forceRetryAt(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    now_unix: i64,
    id: []const u8,
) !void {
    const lock_fd = try ledger.acquireExclusive(allocator, env);
    defer ledger.releaseExclusive(lock_fd);
    const body = try ledger.readAll(allocator, env);
    defer allocator.free(body);
    const occurrence = latestOccurrence(body, id) orelse return error.NoOccurrence;
    try appendExecutionEvent(
        allocator,
        env,
        "execution_released",
        id,
        occurrence,
        "aiko-operator",
        now_unix,
        now_unix,
        .retry,
        "operator_retry",
    );
}

/// Redacted operational projection of durable scheduled contracts.
pub fn listScheduledJson(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
) ![]u8 {
    const body = try ledger.readAll(allocator, env);
    defer allocator.free(body);
    var offsets: std.ArrayList(usize) = .empty;
    defer offsets.deinit(allocator);
    if (body.len > 0) try offsets.append(allocator, 0);
    for (body, 0..) |ch, i| {
        if (ch == '\n' and i + 1 < body.len) try offsets.append(allocator, i + 1);
    }
    var seen: std.StringHashMap(void) = .init(allocator);
    defer seen.deinit();
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.append(allocator, '[');
    var count: usize = 0;
    var index = offsets.items.len;
    while (index > 0) : (index -= 1) {
        const line = lineBounds(body, offsets.items[index - 1]).line;
        if (!eventIs(line, "declared")) continue;
        const id = extractStringField(line, "id") orelse continue;
        if (seen.contains(id)) continue;
        try seen.put(id, {});
        if (isDead(body, id)) continue;
        const action = extractStringField(line, "action") orelse "";
        const plan = extractStringField(line, "plan") orelse "";
        switch (triggerForText(action, plan)) {
            .none => continue,
            else => {},
        }
        const cwd = extractStringField(line, "cwd") orelse "";
        const occurrence = latestOccurrence(body, id);
        const state = if (occurrence) |key| executionState(body, id, key) else ExecutionState{};
        const status: []const u8 = if (state.settled)
            "settled"
        else if (state.claim_owner != null)
            "leased"
        else if (state.lease_until_unix > 0)
            "retry_wait"
        else if (occurrence != null)
            "runnable"
        else
            "waiting";
        if (count > 0) try out.append(allocator, ',');
        count += 1;
        try out.appendSlice(allocator, "{\"id\":");
        try appendJsonString(&out, allocator, id);
        try out.appendSlice(allocator, ",\"prompt\":");
        try appendJsonString(&out, allocator, plan);
        try out.appendSlice(allocator, ",\"trigger\":");
        try appendJsonString(&out, allocator, action);
        try out.appendSlice(allocator, ",\"cwd\":");
        try appendJsonString(&out, allocator, cwd);
        try out.appendSlice(allocator, ",\"status\":");
        try appendJsonString(&out, allocator, status);
        try out.appendSlice(allocator, ",\"occurrence\":");
        if (occurrence) |key| try appendJsonString(&out, allocator, key) else try out.appendSlice(allocator, "null");
        try out.append(allocator, '}');
    }
    try out.append(allocator, ']');
    return try out.toOwnedSlice(allocator);
}

/// Append a named external signal. Event-triggered contracts bind to the
/// signal row's digest, so replaying the same ledger is deterministic and a
/// later signal creates a new occurrence.
pub fn emitSignalAt(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    now_unix: i64,
    name: []const u8,
    cwd: []const u8,
    detail: []const u8,
) !void {
    if (name.len == 0 or name.len > 128) return error.InvalidSignal;
    const lock_fd = try ledger.acquireExclusive(allocator, env);
    defer ledger.releaseExclusive(lock_fd);
    var row: std.ArrayList(u8) = .empty;
    defer row.deinit(allocator);
    try row.appendSlice(allocator, "{\"event\":\"signal\",\"name\":");
    try appendJsonString(&row, allocator, name);
    try row.appendSlice(allocator, ",\"cwd\":");
    try appendJsonString(&row, allocator, cwd);
    try row.appendSlice(allocator, ",\"detail\":");
    try appendJsonString(&row, allocator, detail);
    try row.appendSlice(allocator, ",\"ts_unix\":");
    try row.print(allocator, "{d}", .{now_unix});
    try row.append(allocator, '}');
    const path = try ledger.appendRow(allocator, env, row.items);
    allocator.free(path);
}

test "trigger syntax is canonical and bounded" {
    try std.testing.expectEqual(TriggerSpec{ .at_unix = 42 }, triggerForText("run at:42", ""));
    try std.testing.expectEqual(TriggerSpec{ .repeat_seconds = 300 }, triggerForText("", "repeat:5m"));
    try std.testing.expectEqual(TriggerSpec.none, triggerForText("repeat:0s", ""));
    try std.testing.expectEqual(TriggerSpec.none, triggerForText("cron:* * * * *", ""));
    try std.testing.expectEqualStrings(
        "a1b2c3d4",
        triggerForText("", "when:contract:a1b2c3d4").dependency,
    );
    try std.testing.expectEqualStrings(
        "build-finished",
        triggerForText("", "when:event:build-finished").event_name,
    );
}

test "named signal wakes only the matching workspace contract" {
    const body =
        \\{"event":"signal","name":"mail-arrived","cwd":"/one","detail":"first"}
        \\{"event":"declared","id":"mailjob","cwd":"/two","action":"neuron","plan":"when:event:mail-arrived summarize"}
        \\
    ;
    var wrong_workspace = try planDueFromJson(std.testing.allocator, body, 100, 8);
    defer wrong_workspace.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 0), wrong_workspace.occurrences.len);

    const matching =
        \\{"event":"signal","name":"mail-arrived","cwd":"/two","detail":"second"}
        \\{"event":"declared","id":"mailjob","cwd":"/two","action":"neuron","plan":"when:event:mail-arrived summarize"}
        \\
    ;
    var ready = try planDueFromJson(std.testing.allocator, matching, 100, 8);
    defer ready.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 1), ready.occurrences.len);
    try std.testing.expect(std.mem.startsWith(u8, ready.occurrences[0].key, "event:mail-arrived:"));
}

test "satisfied dependency materializes exactly once per terminal proof" {
    const pending =
        \\{"event":"declared","id":"a1b2c3d4","action":"neuron","plan":"source"}
        \\{"event":"declared","id":"dependent","action":"neuron","plan":"when:contract:a1b2c3d4 publish"}
        \\
    ;
    var before = try planDueFromJson(std.testing.allocator, pending, 100, 8);
    defer before.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 0), before.occurrences.len);

    const ready =
        \\{"event":"declared","id":"a1b2c3d4","action":"neuron","plan":"source"}
        \\{"event":"satisfied","id":"a1b2c3d4","proof":"verified"}
        \\{"event":"declared","id":"dependent","action":"neuron","plan":"when:contract:a1b2c3d4 publish"}
        \\
    ;
    var after = try planDueFromJson(std.testing.allocator, ready, 100, 8);
    defer after.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 1), after.occurrences.len);
    try std.testing.expect(std.mem.startsWith(
        u8,
        after.occurrences[0].key,
        "dependency:a1b2c3d4:",
    ));
}

test "one-shot occurrence waits, materializes once, and reports deadline" {
    const body =
        \\{"event":"declared","id":"wake","action":"at:100 send report","plan":""}
        \\
    ;
    var early = try planDueFromJson(std.testing.allocator, body, 99, 8);
    defer early.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 0), early.occurrences.len);
    try std.testing.expectEqual(@as(?i64, 100), early.next_wake_unix);

    var due = try planDueFromJson(std.testing.allocator, body, 100, 8);
    defer due.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 1), due.occurrences.len);
    try std.testing.expectEqualStrings("at:100", due.occurrences[0].key);

    const materialized =
        \\{"event":"declared","id":"wake","action":"at:100 send report","plan":""}
        \\{"event":"triggered","id":"wake","occurrence":"at:100"}
        \\
    ;
    var duplicate = try planDueFromJson(std.testing.allocator, materialized, 120, 8);
    defer duplicate.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 0), duplicate.occurrences.len);
}

test "recurring trigger honors its declaration not-before boundary" {
    const body =
        \\{"event":"declared","id":"later","action":"neuron repeat:60s not_before:300","plan":"poll"}
        \\
    ;
    var early = try planDueFromJson(std.testing.allocator, body, 299, 8);
    defer early.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 0), early.occurrences.len);
    try std.testing.expectEqual(@as(?i64, 300), early.next_wake_unix);
    var ready = try planDueFromJson(std.testing.allocator, body, 300, 8);
    defer ready.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 1), ready.occurrences.len);
    try std.testing.expectEqualStrings("repeat:60:5", ready.occurrences[0].key);
}

test "recurring occurrence is bucket-idempotent and dead contracts stay dead" {
    const body =
        \\{"event":"declared","id":"alive","action":"repeat:10s poll","plan":""}
        \\{"event":"triggered","id":"alive","occurrence":"repeat:10:4"}
        \\{"event":"declared","id":"dead","action":"repeat:10s poll","plan":""}
        \\{"event":"died","id":"dead"}
        \\
    ;
    var same_bucket = try planDueFromJson(std.testing.allocator, body, 49, 8);
    defer same_bucket.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 0), same_bucket.occurrences.len);
    try std.testing.expectEqual(@as(?i64, 50), same_bucket.next_wake_unix);

    var next_bucket = try planDueFromJson(std.testing.allocator, body, 50, 8);
    defer next_bucket.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 1), next_bucket.occurrences.len);
    try std.testing.expectEqualStrings("alive", next_bucket.occurrences[0].contract_id);
    try std.testing.expectEqualStrings("repeat:10:5", next_bucket.occurrences[0].key);
    try std.testing.expectEqual(@as(?i64, 60), next_bucket.next_wake_unix);
}

test "execution state releases retries and rejects settled occurrences" {
    const claimed =
        \\{"event":"execution_claimed","id":"job","occurrence":"at:10","owner":"aiko","lease_until_unix":20}
        \\
    ;
    const active = executionState(claimed, "job", "at:10");
    try std.testing.expectEqualStrings("aiko", active.claim_owner.?);
    try std.testing.expectEqual(@as(i64, 20), active.lease_until_unix);
    const released =
        \\{"event":"execution_claimed","id":"job","occurrence":"at:10","owner":"aiko","lease_until_unix":20}
        \\{"event":"execution_released","id":"job","occurrence":"at:10","owner":"aiko","retry_after_unix":80}
        \\
    ;
    const retrying = executionState(released, "job", "at:10");
    try std.testing.expect(retrying.claim_owner == null);
    try std.testing.expectEqual(@as(i64, 80), retrying.lease_until_unix);
    try std.testing.expectEqual(@as(u32, 1), retryCount(released, "job", "at:10"));
    const settled =
        \\{"event":"execution_claimed","id":"job","occurrence":"at:10","owner":"aiko","lease_until_unix":20}
        \\{"event":"execution_settled","id":"job","occurrence":"at:10","owner":"aiko","outcome":"satisfied"}
        \\
    ;
    try std.testing.expect(executionState(settled, "job", "at:10").settled);
}
