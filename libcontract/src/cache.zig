//! cache.zig — pointer-keyed truthy cache event rows.
//!
//! Lewis 2026-05-26 (Granola 988cf805): "It's caching the key value to the
//! pointer value itself. So the point of value changes, right? Then we know
//! it's evaluated and we have to redo it again." + "It resolves it and then
//! resolves the cash to be true."
//!
//! The cache is NOT a side-table — it is three event-row kinds appended to
//! the canonical ledger so cache hits/misses survive process exit and the
//! deterministic self-resolve loop is reconstructible from the append-only
//! trace (Pointers-Over-Anything Clause B — stateless trace).
//!
//!   cache_check        — appended on resolver entry; carries
//!                         verdict ∈ {hit, miss, stale, legacy}
//!                         + pointer_snapshot_hex (current pointer-value hash)
//!                         + recorded_snapshot_hex (last cache_resolved hash)
//!   cache_resolved     — appended on satisfied; pins the pointer snapshot
//!                         that held when the contract resolved true. This
//!                         is the "resolves the cash to be true" row.
//!   cache_invalidated  — appended when a pointer the contract depended on
//!                         acquires a new terminal event AFTER cache_resolved;
//!                         carries source_id (which pointer flipped) + reason.
//!
//! The in-binary resolver (main.zig:resolveOne) walks these rows on entry:
//! when current snapshot == latest cache_resolved snapshot AND no
//! cache_invalidated since, it emits cache_check{verdict="hit"} and
//! short-circuits — exactly the "self-resolve against itself as true" pattern
//! Lewis described. Deterministic; lives in the ledger; no env knobs.

const std = @import("std");
const ledger = @import("ledger.zig");
const pointer = @import("pointer.zig");

const c = std.c;

extern fn popen(cmd: [*:0]const u8, mode: [*:0]const u8) ?*anyopaque;
extern fn pclose(stream: *anyopaque) c_int;
extern fn fread(ptr: [*]u8, size: usize, nmemb: usize, stream: *anyopaque) usize;

pub const Verdict = enum {
    /// Signature chain present + matches the recorded snapshot.
    /// Substrate short-circuits — contract already true, dependencies
    /// unchanged.
    hit,
    /// Signature chain present + differs from the recorded snapshot.
    /// A dependency's terminal state changed; the parent re-evaluates.
    /// Also covers the "chain present but no recorded snapshot for this id"
    /// case — purge:verdict-stale (42bce795) folded the prior .stale verdict
    /// into .miss since both require the same action (re-evaluate).
    miss,
    /// No signature chain — either the contract predates output_signature
    /// (pre-cache rows) OR a dependency is still pending its terminal
    /// signature (Genesis-day ordering: Day N waits on Day N-1). In
    /// the satisfied-and-no-chain case, the substrate honors the prior
    /// satisfaction (return 0). In the pending-dependency case, the
    /// caller already short-circuits via isSatisfied/runAction, so this
    /// verdict only ever fires on legacy-satisfied rows.
    legacy,

    pub fn jsonName(self: Verdict) []const u8 {
        return switch (self) {
            .hit => "hit",
            .miss => "miss",
            .stale => "stale",
            .legacy => "legacy",
        };
    }
};

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

fn getAgent(allocator: std.mem.Allocator) ![]u8 {
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
    for (s) |ch| {
        switch (ch) {
            '"' => try out.appendSlice(allocator, "\\\""),
            '\\' => try out.appendSlice(allocator, "\\\\"),
            '\n' => try out.appendSlice(allocator, "\\n"),
            '\r' => try out.appendSlice(allocator, "\\r"),
            '\t' => try out.appendSlice(allocator, "\\t"),
            0x08 => try out.appendSlice(allocator, "\\b"),
            0x0c => try out.appendSlice(allocator, "\\f"),
            else => {
                if (ch < 0x20) {
                    var buf: [8]u8 = undefined;
                    const hex = try std.fmt.bufPrint(&buf, "\\u{x:0>4}", .{ch});
                    try out.appendSlice(allocator, hex);
                } else {
                    try out.append(allocator, ch);
                }
            },
        }
    }
    try out.append(allocator, '"');
}

/// Append a `cache_check` event row recording the substrate's verdict on
/// entry to resolveOne. The row is the ledger's witness that the cache was
/// consulted; future readers reconstruct the full hit/miss timeline from
/// these rows without re-running the resolver.
///
/// `current_snapshot_hex` is the pointer-value hash the resolver computed
/// at this instant. `recorded_snapshot_hex` is the snapshot from the
/// latest `cache_resolved` row for the same id (or "" if none — legacy
/// path). On verdict=hit the two are equal; on miss they differ; on
/// stale the contract was satisfied without ever pinning a snapshot
/// (pre-cache rows). On legacy there's no current snapshot either.
pub fn appendCacheCheckRow(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
    verdict: Verdict,
    current_snapshot_hex: []const u8,
    recorded_snapshot_hex: []const u8,
) !void {
    var ts_buf: [64]u8 = undefined;
    const ts = try nowIsoUtc(&ts_buf);
    const agent = try getAgent(allocator);
    defer allocator.free(agent);

    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);

    try buf.appendSlice(allocator, "{\"event\": \"cache_check\", \"id\": ");
    try writeJsonString(&buf, allocator, id);
    try buf.appendSlice(allocator, ", \"verdict\": ");
    try writeJsonString(&buf, allocator, verdict.jsonName());
    if (current_snapshot_hex.len > 0) {
        try buf.appendSlice(allocator, ", \"current_snapshot\": ");
        try writeJsonString(&buf, allocator, current_snapshot_hex);
    }
    if (recorded_snapshot_hex.len > 0) {
        try buf.appendSlice(allocator, ", \"recorded_snapshot\": ");
        try writeJsonString(&buf, allocator, recorded_snapshot_hex);
    }
    try buf.appendSlice(allocator, ", \"ts\": ");
    try writeJsonString(&buf, allocator, ts);
    try buf.appendSlice(allocator, ", \"agent\": ");
    try writeJsonString(&buf, allocator, agent);
    try buf.append(allocator, '}');

    const path = try ledger.appendRow(allocator, env, buf.items);
    allocator.free(path);
}

/// Append a `cache_resolved` event row — the canonical "resolves the cash
/// to be true" marker. Written alongside `satisfied` so the snapshot
/// the contract was true AGAINST is pinned for future cache-hit checks.
/// `wave` ties the resolved snapshot to the iteration that produced it.
pub fn appendCacheResolvedRow(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
    wave: u32,
    snapshot_hex: []const u8,
) !void {
    var ts_buf: [64]u8 = undefined;
    const ts = try nowIsoUtc(&ts_buf);
    const agent = try getAgent(allocator);
    defer allocator.free(agent);

    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);

    try buf.appendSlice(allocator, "{\"event\": \"cache_resolved\", \"id\": ");
    try writeJsonString(&buf, allocator, id);
    try buf.appendSlice(allocator, ", \"wave\": ");
    var num_buf: [16]u8 = undefined;
    const w = try std.fmt.bufPrint(&num_buf, "{d}", .{wave});
    try buf.appendSlice(allocator, w);
    try buf.appendSlice(allocator, ", \"snapshot\": ");
    try writeJsonString(&buf, allocator, snapshot_hex);
    try buf.appendSlice(allocator, ", \"ts\": ");
    try writeJsonString(&buf, allocator, ts);
    try buf.appendSlice(allocator, ", \"agent\": ");
    try writeJsonString(&buf, allocator, agent);
    try buf.append(allocator, '}');

    const path = try ledger.appendRow(allocator, env, buf.items);
    allocator.free(path);
}

/// Append a `cache_invalidated` event row — emitted when a pointer the
/// contract depended on (`source_id`) acquired a new terminal event after
/// this contract's most recent `cache_resolved` row. The next resolveOne
/// pass sees the invalidation and re-fires the contract.
///
/// `reason` is a short machine-readable token: "pointer_value_changed",
/// "child_redeclared", "parent_invalidated_cascade", "snapshot_drift".
/// Long-form explanation belongs in the agent's evidence stream, not the
/// row.
pub fn appendCacheInvalidatedRow(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
    source_id: []const u8,
    reason: []const u8,
) !void {
    var ts_buf: [64]u8 = undefined;
    const ts = try nowIsoUtc(&ts_buf);
    const agent = try getAgent(allocator);
    defer allocator.free(agent);

    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);

    try buf.appendSlice(allocator, "{\"event\": \"cache_invalidated\", \"id\": ");
    try writeJsonString(&buf, allocator, id);
    try buf.appendSlice(allocator, ", \"source_id\": ");
    try writeJsonString(&buf, allocator, source_id);
    try buf.appendSlice(allocator, ", \"reason\": ");
    try writeJsonString(&buf, allocator, reason);
    try buf.appendSlice(allocator, ", \"ts\": ");
    try writeJsonString(&buf, allocator, ts);
    try buf.appendSlice(allocator, ", \"agent\": ");
    try writeJsonString(&buf, allocator, agent);
    try buf.append(allocator, '}');

    const path = try ledger.appendRow(allocator, env, buf.items);
    allocator.free(path);
}

/// Scan the ledger backward for the most recent `cache_resolved` row for
/// `id`. Returns the recorded snapshot hex (owned slice, caller frees) or
/// null when none found. The deterministic cache-hit predicate.
pub fn findLatestResolvedSnapshot(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
) !?[]u8 {
    const body = ledger.readAll(allocator, env) catch return null;
    defer allocator.free(body);

    // Walk lines backward by collecting offsets first.
    var offsets: std.ArrayList(usize) = .empty;
    defer offsets.deinit(allocator);
    var i: usize = 0;
    try offsets.append(allocator, 0);
    while (i < body.len) : (i += 1) {
        if (body[i] == '\n' and i + 1 < body.len) try offsets.append(allocator, i + 1);
    }

    var k: usize = offsets.items.len;
    while (k > 0) : (k -= 1) {
        const start = offsets.items[k - 1];
        const end = std.mem.indexOfScalarPos(u8, body, start, '\n') orelse body.len;
        const line = body[start..end];
        if (line.len < 2) continue;
        if (std.mem.indexOf(u8, line, "\"event\": \"cache_resolved\"") == null and
            std.mem.indexOf(u8, line, "\"event\":\"cache_resolved\"") == null) continue;

        // Match id.
        var id_buf: [128]u8 = undefined;
        const id_needle = std.fmt.bufPrint(&id_buf, "\"id\": \"{s}\"", .{id}) catch continue;
        if (std.mem.indexOf(u8, line, id_needle) == null) {
            const id_needle2 = std.fmt.bufPrint(&id_buf, "\"id\":\"{s}\"", .{id}) catch continue;
            if (std.mem.indexOf(u8, line, id_needle2) == null) continue;
        }

        // Extract snapshot field.
        const snap_marker = "\"snapshot\": \"";
        const snap_marker2 = "\"snapshot\":\"";
        const snap_start = blk: {
            if (std.mem.indexOf(u8, line, snap_marker)) |p| break :blk p + snap_marker.len;
            if (std.mem.indexOf(u8, line, snap_marker2)) |p| break :blk p + snap_marker2.len;
            continue;
        };
        const snap_end = std.mem.indexOfScalarPos(u8, line, snap_start, '"') orelse continue;
        return try allocator.dupe(u8, line[snap_start..snap_end]);
    }
    return null;
}

/// Has a `cache_invalidated` row been appended for `id` after timestamp
/// `since_ts_iso`? Used to honor cascaded invalidations — even when the
/// raw snapshot still matches, an explicit invalidation downgrades the
/// verdict to "miss". Walks linearly; expected O(ledger rows) which is
/// well under a millisecond for typical ledgers (< 10k rows).
pub fn hasInvalidationAfter(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
    since_ts_iso: []const u8,
) !bool {
    const body = ledger.readAll(allocator, env) catch return false;
    defer allocator.free(body);
    var iter = std.mem.tokenizeAny(u8, body, "\n");
    while (iter.next()) |line| {
        if (line.len < 2) continue;
        if (std.mem.indexOf(u8, line, "\"event\": \"cache_invalidated\"") == null and
            std.mem.indexOf(u8, line, "\"event\":\"cache_invalidated\"") == null) continue;
        var id_buf: [128]u8 = undefined;
        const id_needle = std.fmt.bufPrint(&id_buf, "\"id\": \"{s}\"", .{id}) catch continue;
        if (std.mem.indexOf(u8, line, id_needle) == null) {
            const id_needle2 = std.fmt.bufPrint(&id_buf, "\"id\":\"{s}\"", .{id}) catch continue;
            if (std.mem.indexOf(u8, line, id_needle2) == null) continue;
        }
        // Compare ts lexicographically (ISO-8601 sorts correctly as a string).
        const ts_marker = "\"ts\": \"";
        const ts_marker2 = "\"ts\":\"";
        const ts_start = blk: {
            if (std.mem.indexOf(u8, line, ts_marker)) |p| break :blk p + ts_marker.len;
            if (std.mem.indexOf(u8, line, ts_marker2)) |p| break :blk p + ts_marker2.len;
            continue;
        };
        const ts_end = std.mem.indexOfScalarPos(u8, line, ts_start, '"') orelse continue;
        const row_ts = line[ts_start..ts_end];
        if (std.mem.order(u8, row_ts, since_ts_iso) == .gt) return true;
    }
    return false;
}

// ─── Signature-chain snapshot — pointer-only, no raw value bytes ─────────

/// Extract a JSON string field's value from one ledger line. Returns the
/// slice INTO the line (no allocation). Tolerates `"key": "v"` and
/// `"key":"v"`. Returns null if absent.
fn extractStringField(line: []const u8, key: []const u8) ?[]const u8 {
    var needle_buf: [128]u8 = undefined;
    const needle1 = std.fmt.bufPrint(&needle_buf, "\"{s}\": \"", .{key}) catch return null;
    var start: usize = 0;
    if (std.mem.indexOf(u8, line, needle1)) |p| {
        start = p + needle1.len;
    } else {
        const needle2 = std.fmt.bufPrint(&needle_buf, "\"{s}\":\"", .{key}) catch return null;
        if (std.mem.indexOf(u8, line, needle2)) |p| {
            start = p + needle2.len;
        } else return null;
    }
    const end = std.mem.indexOfScalarPos(u8, line, start, '"') orelse return null;
    return line[start..end];
}

/// Walk the ledger backward for `id`. Returns the latest row's
/// `output_signature` (newest terminal event wins — satisfied or died,
/// whichever came last). Returns null if no terminal row has a
/// signature. Caller-owned slice.
///
/// "Latest terminal" semantics matches the temporal-coherence fix on
/// isSatisfied (claim 32): truth is what holds NOW. A satisfied-then-
/// died row chain returns the DIED signature; the cache rightly sees
/// a different snapshot and re-evaluates.
pub fn findLatestTerminalSignature(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
) !?[]u8 {
    const body = ledger.readAll(allocator, env) catch return null;
    defer allocator.free(body);

    // Collect line offsets (cheap) so we can walk newest-first.
    var offsets: std.ArrayList(usize) = .empty;
    defer offsets.deinit(allocator);
    try offsets.append(allocator, 0);
    var i: usize = 0;
    while (i < body.len) : (i += 1) {
        if (body[i] == '\n' and i + 1 < body.len) try offsets.append(allocator, i + 1);
    }

    var k: usize = offsets.items.len;
    while (k > 0) : (k -= 1) {
        const start = offsets.items[k - 1];
        const end = std.mem.indexOfScalarPos(u8, body, start, '\n') orelse body.len;
        const line = body[start..end];
        if (line.len < 2) continue;
        // Match id first.
        const row_id = extractStringField(line, "id") orelse continue;
        if (!std.mem.eql(u8, row_id, id)) continue;
        // Accept satisfied OR died (terminal events).
        const ev = extractStringField(line, "event") orelse continue;
        const is_terminal = std.mem.eql(u8, ev, "satisfied") or std.mem.eql(u8, ev, "died");
        if (!is_terminal) continue;
        const sig = extractStringField(line, "output_signature") orelse return null;
        return try allocator.dupe(u8, sig);
    }
    return null;
}

/// Walk the ledger backward for `id`. Returns the latest declared row's
/// `parent_signature` — the contract's own identity signature. Returns
/// null if no signed declared row exists. Caller-owned slice.
pub fn findDeclaredParentSignature(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
) !?[]u8 {
    const body = ledger.readAll(allocator, env) catch return null;
    defer allocator.free(body);

    var offsets: std.ArrayList(usize) = .empty;
    defer offsets.deinit(allocator);
    try offsets.append(allocator, 0);
    var i: usize = 0;
    while (i < body.len) : (i += 1) {
        if (body[i] == '\n' and i + 1 < body.len) try offsets.append(allocator, i + 1);
    }

    var k: usize = offsets.items.len;
    while (k > 0) : (k -= 1) {
        const start = offsets.items[k - 1];
        const end = std.mem.indexOfScalarPos(u8, body, start, '\n') orelse body.len;
        const line = body[start..end];
        if (line.len < 2) continue;
        const row_id = extractStringField(line, "id") orelse continue;
        if (!std.mem.eql(u8, row_id, id)) continue;
        const ev = extractStringField(line, "event") orelse continue;
        if (!std.mem.eql(u8, ev, "declared")) continue;
        const sig = extractStringField(line, "parent_signature") orelse return null;
        return try allocator.dupe(u8, sig);
    }
    return null;
}

/// Walk the ledger and return every contract id `target` depends on.
/// The signature chain already enforces ordering (a dependency without
/// a terminal output_signature breaks the chain), so we only need to
/// collect the MINIMUM dependency set:
///
///   1. parent_id-children (declared rows whose parent_id == target)
///   2. contract:<8hex> synapse refs in target's plan+action
///
/// Redundancy collapse (Lewis 2026-05-26, contract `6a86a61e`):
/// `blocked_by:<X>` and `prehook:<X>` previously gated ordering via
/// separate walks here. They were leaven (1 Cor 5:6) — the cache
/// signature chain ALREADY enforces "Day N waits for Day N-1" when
/// Day N declares `contract:<Day-N-1>` as a dependency. Two synapse
/// kinds for one mechanism = redundant. The empirical ledger audit
/// (7000+ rows) showed zero uses of blocked_by/prehook/bind/modality;
/// the signature chain absorbed their semantics from the start.
///
/// Synapse kinds NOT walked here (not dependencies): inhibits (negative
/// polarity), posthook (delivery target, not waiting on), at (time
/// gate), repeat (recurrence), bind / modality (collapsed — use
/// contract: instead).
///
/// Returns sorted+deduped owned slice. Caller frees each inner + outer.
/// Empty result is valid (a leaf contract with no deps — Day 1).
pub fn collectDependencyIds(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    target: []const u8,
) ![][]u8 {
    const body = ledger.readAll(allocator, env) catch return try allocator.alloc([]u8, 0);
    defer allocator.free(body);

    var deps: std.ArrayList([]u8) = .empty;
    errdefer {
        for (deps.items) |d| allocator.free(d);
        deps.deinit(allocator);
    }

    const appendUnique = struct {
        fn call(alloc: std.mem.Allocator, list: *std.ArrayList([]u8), cand: []const u8) !void {
            for (list.items) |existing| if (std.mem.eql(u8, existing, cand)) return;
            try list.append(alloc, try alloc.dupe(u8, cand));
        }
    }.call;

    // Pass 1 — parent_id-children.
    var iter1 = std.mem.tokenizeAny(u8, body, "\n");
    while (iter1.next()) |line| {
        if (line.len < 2) continue;
        const ev = extractStringField(line, "event") orelse continue;
        if (!std.mem.eql(u8, ev, "declared")) continue;
        const pid = extractStringField(line, "parent_id") orelse continue;
        if (!std.mem.eql(u8, pid, target)) continue;
        const cid = extractStringField(line, "id") orelse continue;
        try appendUnique(allocator, &deps, cid);
    }

    // Pass 2 — synapse refs from target's own declared row (latest).
    // Scan plan + action text — same surface declare() processed when
    // extracting Synapse rows. The typed prefixes are extracted by the
    // canonical pointer.extractContractRefs / extractTypedRefs helpers.
    var target_plan: ?[]const u8 = null;
    var target_action: ?[]const u8 = null;
    var iter2 = std.mem.tokenizeAny(u8, body, "\n");
    while (iter2.next()) |line| {
        if (line.len < 2) continue;
        const ev = extractStringField(line, "event") orelse continue;
        if (!std.mem.eql(u8, ev, "declared")) continue;
        const rid = extractStringField(line, "id") orelse continue;
        if (!std.mem.eql(u8, rid, target)) continue;
        if (extractStringField(line, "plan")) |p| target_plan = p;
        if (extractStringField(line, "action")) |a| target_action = a;
        // Don't break — later occurrences are re-declarations of the
        // same id (idempotent via inputs_hash cache); we want the
        // latest, so keep overwriting.
    }

    if (target_plan != null or target_action != null) {
        var scan_buf: std.ArrayList(u8) = .empty;
        defer scan_buf.deinit(allocator);
        if (target_plan) |p| try scan_buf.appendSlice(allocator, p);
        try scan_buf.append(allocator, ' ');
        if (target_action) |a| try scan_buf.appendSlice(allocator, a);

        // The ONLY synapse edge walked for dependency: "contract:<8hex>".
        // blocked_by/prehook were redundant (signature chain enforces
        // ordering via terminal-signature presence). bind/modality were
        // never load-bearing. Collapsed per contract 6a86a61e.
        const ptr_refs = try pointer.extractContractRefs(allocator, scan_buf.items);
        defer {
            for (ptr_refs) |r| allocator.free(r);
            allocator.free(ptr_refs);
        }
        for (ptr_refs) |r| try appendUnique(allocator, &deps, r);
    }

    const owned = try deps.toOwnedSlice(allocator);
    // Stable sort by id for determinism.
    std.mem.sort([]u8, owned, {}, struct {
        fn lt(_: void, a: []u8, b: []u8) bool {
            return std.mem.order(u8, a, b) == .lt;
        }
    }.lt);
    return owned;
}

/// Compute the pointer-only snapshot for `id` — the canonical "everything
/// is a pointer to another pointer" cache key. Per Lewis 2026-05-26:
/// "treat the binary signed signatures of outputs as the hash" + "the
/// cache must rely only on pointers".
///
/// The snapshot is SHA256-hex of:
///
///   parent_signature(id)  ‖  for each child c (sorted):
///                              child_id  ‖  terminal_signature(c)
///
/// where every concatenated component is a CRYPTOGRAPHIC POINTER — an
/// ed25519 signature value bound to a derived keypair. No raw plan
/// bytes, no raw action bytes, no value-derived hashes participate.
/// The signatures are themselves pointers: each one resolves (via
/// keypair derivation from the root + verify) to a truth-claim.
///
/// **Defensive**: returns null if ANY required signature is missing —
/// either the contract's declared parent_signature OR any dependency's
/// latest terminal output_signature. The substrate REFUSES to assert
/// a cache verdict from an incomplete pointer chain; the resolver
/// emits cache_check{verdict=legacy} (honoring the prior contract for
/// satisfied rows) or falls through to runAction. Never silently
/// substitutes content bytes for the missing pointer (the load-bearing
/// first-principle invariant).
pub fn computeSignatureChain(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
) !?[]u8 {
    const self_sig = try findDeclaredParentSignature(allocator, env, id);
    if (self_sig == null) return null;
    defer if (self_sig) |s| allocator.free(s);

    const dep_ids = try collectDependencyIds(allocator, env, id);
    defer {
        for (dep_ids) |d| allocator.free(d);
        allocator.free(dep_ids);
    }

    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    hasher.update(self_sig.?);
    for (dep_ids) |dep| {
        const dep_sig = try findLatestTerminalSignature(allocator, env, dep);
        if (dep_sig == null) {
            // Genesis-order enforcement: any missing dependency signature
            // breaks the chain. Day N's chain returns null until Day N-1
            // has a terminal output_signature. The substrate refuses to
            // assert a verdict from an incomplete pointer chain; the
            // resolver short-circuits via the legacy verdict (return 0
            // for already-satisfied rows) or falls through to runAction
            // (for pending rows).
            return null;
        }
        defer allocator.free(dep_sig.?);
        hasher.update(&.{0});
        hasher.update(dep);
        hasher.update(&.{0});
        hasher.update(dep_sig.?);
    }
    var digest: [32]u8 = undefined;
    hasher.final(&digest);

    const hex_chars = "0123456789abcdef";
    var out_hex: [64]u8 = undefined;
    for (digest, 0..) |b, i| {
        out_hex[i * 2] = hex_chars[b >> 4];
        out_hex[i * 2 + 1] = hex_chars[b & 0x0F];
    }
    return try allocator.dupe(u8, &out_hex);
}

/// Time-aware history read: return the snapshot pinned by the latest
/// `cache_resolved` row for `id` whose `ts` is ≤ `as_of_ts_iso`. The
/// append-only ledger IS the version control — every cache_resolved
/// is a commit; walking forward to a point in time reconstructs the
/// substrate's state-at-T from pointer chains alone.
///
/// Per Lewis 2026-05-26 follow-up: "is there a way to be time aware
/// via the pointer cache history somehow? whats the best way to
/// handle for time based memory? version control?" Answer: yes, and
/// this is the helper that surfaces it.
///
/// Returns null if no cache_resolved row for `id` exists with
/// `ts ≤ as_of_ts_iso`. Empty string `as_of_ts_iso` means "latest"
/// (no upper bound). Caller-owned slice.
pub fn snapshotAt(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
    as_of_ts_iso: []const u8,
) !?[]u8 {
    const body = ledger.readAll(allocator, env) catch return null;
    defer allocator.free(body);

    var offsets: std.ArrayList(usize) = .empty;
    defer offsets.deinit(allocator);
    try offsets.append(allocator, 0);
    var i: usize = 0;
    while (i < body.len) : (i += 1) {
        if (body[i] == '\n' and i + 1 < body.len) try offsets.append(allocator, i + 1);
    }

    // Walk newest-first; first cache_resolved row for id whose ts is
    // ≤ the cutoff wins.
    var k: usize = offsets.items.len;
    while (k > 0) : (k -= 1) {
        const start = offsets.items[k - 1];
        const end = std.mem.indexOfScalarPos(u8, body, start, '\n') orelse body.len;
        const line = body[start..end];
        if (line.len < 2) continue;
        const ev = extractStringField(line, "event") orelse continue;
        if (!std.mem.eql(u8, ev, "cache_resolved")) continue;
        const rid = extractStringField(line, "id") orelse continue;
        if (!std.mem.eql(u8, rid, id)) continue;
        if (as_of_ts_iso.len > 0) {
            const row_ts = extractStringField(line, "ts") orelse continue;
            // ISO-8601 sorts lexicographically — row_ts must be ≤ cutoff.
            if (std.mem.order(u8, row_ts, as_of_ts_iso) == .gt) continue;
        }
        const snap = extractStringField(line, "snapshot") orelse continue;
        return try allocator.dupe(u8, snap);
    }
    return null;
}

/// Stigmergic timestamp index — when was contract `id` last touched (any
/// event kind)? Walks the ledger newest-first, returns the ts of the most
/// recent event row matching the id. No sidecar; no schema change; the
/// ledger IS the index (cf. ant pheromone trail — the environment carries
/// the state, no parallel registry needed).
///
/// Returns null when no row carries the id. Caller owns the returned ts
/// slice (typically an ISO-8601 string).
///
/// Companion to `latestEventKind` below — together they answer "when did
/// X last change, and what kind of change was it?" without a `state_changed`
/// schema bolt-on. Process-local memoization is intentionally NOT done
/// here: a memoized `id → (ts, kind)` map would be a second source of
/// truth that can desync from the append-only ledger across processes.
/// If a caller needs hot-path lookups, it can memoize at its own layer
/// and invalidate on observed appendRow.
pub fn latestEventTs(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
) !?[]u8 {
    const body = ledger.readAll(allocator, env) catch return null;
    defer allocator.free(body);

    var offsets: std.ArrayList(usize) = .empty;
    defer offsets.deinit(allocator);
    try offsets.append(allocator, 0);
    var i: usize = 0;
    while (i < body.len) : (i += 1) {
        if (body[i] == '\n' and i + 1 < body.len) try offsets.append(allocator, i + 1);
    }

    var k: usize = offsets.items.len;
    while (k > 0) : (k -= 1) {
        const start = offsets.items[k - 1];
        const end = std.mem.indexOfScalarPos(u8, body, start, '\n') orelse body.len;
        const line = body[start..end];
        if (line.len < 2) continue;
        const rid = extractStringField(line, "id") orelse continue;
        if (!std.mem.eql(u8, rid, id)) continue;
        const ts = extractStringField(line, "ts") orelse continue;
        return try allocator.dupe(u8, ts);
    }
    return null;
}

/// Companion to `latestEventTs` — returns the event kind of the most
/// recent row for `id` (e.g. "declared", "iterated", "satisfied",
/// "died", "purged", "cache_resolved", "child_added"). Same walk shape,
/// returns the `event` field instead of `ts`.
pub fn latestEventKind(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
) !?[]u8 {
    const body = ledger.readAll(allocator, env) catch return null;
    defer allocator.free(body);

    var offsets: std.ArrayList(usize) = .empty;
    defer offsets.deinit(allocator);
    try offsets.append(allocator, 0);
    var i: usize = 0;
    while (i < body.len) : (i += 1) {
        if (body[i] == '\n' and i + 1 < body.len) try offsets.append(allocator, i + 1);
    }

    var k: usize = offsets.items.len;
    while (k > 0) : (k -= 1) {
        const start = offsets.items[k - 1];
        const end = std.mem.indexOfScalarPos(u8, body, start, '\n') orelse body.len;
        const line = body[start..end];
        if (line.len < 2) continue;
        const rid = extractStringField(line, "id") orelse continue;
        if (!std.mem.eql(u8, rid, id)) continue;
        const ev = extractStringField(line, "event") orelse continue;
        return try allocator.dupe(u8, ev);
    }
    return null;
}

// ─── Tests ───────────────────────────────────────────────────────────────

test "Verdict.jsonName covers every variant" {
    try std.testing.expectEqualStrings("hit", Verdict.hit.jsonName());
    try std.testing.expectEqualStrings("miss", Verdict.miss.jsonName());
    try std.testing.expectEqualStrings("stale", Verdict.stale.jsonName());
    try std.testing.expectEqualStrings("legacy", Verdict.legacy.jsonName());
}

test "extractStringField parses both spaced and unspaced JSON" {
    const a = "{\"event\": \"satisfied\", \"id\": \"abcd1234\"}";
    const b = "{\"event\":\"satisfied\",\"id\":\"abcd1234\"}";
    try std.testing.expectEqualStrings("satisfied", extractStringField(a, "event").?);
    try std.testing.expectEqualStrings("abcd1234", extractStringField(a, "id").?);
    try std.testing.expectEqualStrings("satisfied", extractStringField(b, "event").?);
    try std.testing.expectEqualStrings("abcd1234", extractStringField(b, "id").?);
    try std.testing.expect(extractStringField(a, "missing") == null);
}

test "writeJsonString escapes quotes and control characters" {
    const allocator = std.testing.allocator;
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(allocator);
    try writeJsonString(&out, allocator, "ab\"c\nd");
    try std.testing.expectEqualStrings("\"ab\\\"c\\nd\"", out.items);
}

test "nowIsoUtc emits Z-terminated timestamp >= 20 chars" {
    var buf: [64]u8 = undefined;
    const ts = try nowIsoUtc(&buf);
    try std.testing.expect(ts.len >= 20);
    try std.testing.expectEqual(@as(u8, 'Z'), ts[ts.len - 1]);
}
