//! contract.zig — public Zig API for libcontract.
//!
//! Owns the append-only row writer for the native contract binary. The public
//! API is deliberately small: declare, record_iteration, mark_satisfied,
//! list_all, and get.
const std = @import("std");
const id_mod = @import("id.zig");
const pointer = @import("pointer.zig");
const ledger = @import("ledger.zig");
// Re-exported as pub so client.zig (in the contract_client module) can reach
// these primitives through `@import("contract").<thing>` rather than
// cross-importing the files (Zig 0.16 forbids the same file appearing in
// two modules' dependency graphs).
pub const lineage = @import("lineage.zig");
pub const http = @import("http.zig");
pub const env_fingerprint = @import("env_fingerprint.zig");
pub const verses = @import("verses.zig");
pub const bible = @import("bible.zig");
pub const cache = @import("cache.zig");

/// Re-export so consumers of libcontract can verify chains without rewiring
/// the build graph.
pub const Lineage = lineage;

/// Local-LLM fallback: when --remote 402s (wallet empty), substrate
/// downloads llama.cpp + Qwen3.5-0.8B-Instruct GGUF on first use and
/// spawns the compile locally. See `llm_fallback.zig` for the doctrine.
pub const LlmFallback = @import("llm_fallback.zig");

/// Typed edge kind across the contract DAG. The substrate compiles narrative
/// references in the plan/action text (e.g. `inhibits:deadbeef`) into one
/// uniform stream of typed synapses on the declared row — there are no
/// per-kind parallel arrays.
pub const SynapseKind = enum {
    /// `contract:<id>` — generic dependency / lineage / composition edge.
    pointer,
    /// `inhibits:<id>` — negative edge: this contract suppresses target.
    inhibits,
    /// `bind:<id>` — sibling synapse: lateral binding to target.
    bind,
    /// `blocked_by:<id>` — this contract waits for target to satisfy first.
    blocked_by,
    /// `posthook:<id>` — fire target after this contract resolves.
    posthook,
    /// `prehook:<id>` — fire target before this contract is constructed.
    prehook,
    /// `modality:<id>` — typed input/output channel edge. Target contract
    /// is an adapter for a specific modality (chat-input, tts-output,
    /// screen-output, etc.). Lets the Word's compiler bind a presence
    /// surface to the right adapter family for the spawn environment.
    modality,
    /// `at:<RFC3339-timestamp>` — wall-clock threshold. Recorded on the
    /// declared row; the pod provisioned for this contract reads the
    /// synapse and sleeps until the timestamp before firing its action.
    /// The substrate itself does NOT poll for due timestamps — that would
    /// be a meta-service above the DAG (an antipattern). Time is the
    /// pod's own metabolism; the substrate just records when. See
    /// docs/design/runpod-bound-contract-vm.md.
    at,
    /// `repeat:<cron-expr>` — recurring fire pattern. The pod scheduled
    /// for the contract reads this synapse and loops: sleep until next
    /// cron tick, fire, repeat. Idempotent per (contract_id, tick-instant).
    repeat,

    pub fn jsonName(self: SynapseKind) []const u8 {
        return switch (self) {
            .pointer => "pointer",
            .inhibits => "inhibits",
            .bind => "bind",
            .blocked_by => "blocked_by",
            .posthook => "posthook",
            .prehook => "prehook",
            .modality => "modality",
            .at => "at",
            .repeat => "repeat",
        };
    }
};

/// One typed edge on the declared row. `to` is owned by libcontract during
/// declare(); callers do not allocate or free.
pub const Synapse = struct {
    to: []const u8,
    kind: SynapseKind,
};

/// Ad-hoc string field to splice into the declared row JSON. Caller owns
/// the slices; libcontract JSON-escapes both at write time. Empty `value`
/// is treated as absent and dropped.
pub const Field = struct {
    key: []const u8,
    value: []const u8,
};

pub const DeclareOptions = struct {
    /// Optional parent id; null = root-level contract.
    parent_id: ?[]const u8 = null,
    /// Optional agent override; null = CONTRACT_AGENT env / git config / "".
    agent: ?[]const u8 = null,
    /// Optional cwd override; null = libc getcwd().
    cwd: ?[]const u8 = null,
    /// Optional pre-computed hex digest of file content referenced by the
    /// caller's pre-scrub plan. Folds into inputs_hash_v2 so the cache key
    /// invalidates when referenced files change (Docker-layer behavior).
    /// Caller must extract path-refs from raw plan + sha256-fold file bytes
    /// BEFORE privacy scrub — only the digest survives in the row, no paths
    /// leak. Empty/null = file-content layer absent (cache key behaves as
    /// cwd+plan+parent only).
    inputs_file_refs_digest: ?[]const u8 = null,
    /// Strongly-typed pass-through metadata. Replaces the previous flat list
    /// of `?[]const u8` fields (aiko_role, aggregation, audience, …) — any
    /// new attribute is now data on a row, not a new struct field.
    extras: []const Field = &.{},
};

/// Compute the v2 layered inputs hash for a contract. Docker-layer shape —
/// every layer's bytes contribute to one digest, and any layer changing
/// (cwd, plan, file content, parent) flips the digest → cache miss → new id.
///
///   sha256(
///     "v2|"
///     || cwd                       ← context layer
///     || "\n" || plan              ← intent layer (privacy-scrubbed)
///     || "\n" || file_refs_digest  ← content layer (caller pre-computed)
///     || "\n" || parent.inputs_hash ← lineage layer (transitive fold-in)
///   )
///
/// Parent lookup is one ledger scan via ledger.findInputsHashForId; absence
/// (missing parent or v1 parent without inputs_hash) means an empty layer —
/// child is still cacheable but doesn't transitively invalidate against
/// that parent until the parent is re-declared with v2.
///
/// Returns 64-char hex (owned slice; caller frees).
fn computeInputsHashV2(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    plan: []const u8,
    cwd: []const u8,
    file_refs_digest: ?[]const u8,
    parent_id: ?[]const u8,
) ![]u8 {
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    hasher.update("v2|");
    hasher.update(cwd);
    hasher.update("\n");
    hasher.update(plan);
    hasher.update("\n");
    if (file_refs_digest) |d| hasher.update(d);
    hasher.update("\n");
    if (parent_id) |pid| {
        if (try ledger.findInputsHashForId(allocator, env, pid)) |parent_hash| {
            defer allocator.free(parent_hash);
            hasher.update(parent_hash);
        }
    }
    var digest: [32]u8 = undefined;
    hasher.final(&digest);
    const hex_chars = "0123456789abcdef";
    var hex_buf: [64]u8 = undefined;
    for (digest, 0..) |b, i| {
        hex_buf[i * 2] = hex_chars[b >> 4];
        hex_buf[i * 2 + 1] = hex_chars[b & 0x0F];
    }
    return try allocator.dupe(u8, &hex_buf);
}

/// Table-driven prefix → SynapseKind mapping. The ONLY place edge kinds
/// are enumerated; adding one is a single row here.
const synapse_table = [_]struct {
    prefix: []const u8,
    kind: SynapseKind,
    freeform: bool,
}{
    // freeform=true means the suffix is consumed verbatim until the next
    // whitespace/quote — used for at:<RFC3339> + repeat:<cron-expr> where
    // the payload isn't an 8-hex id.
    .{ .prefix = "contract:", .kind = .pointer, .freeform = false },
    .{ .prefix = "inhibits:", .kind = .inhibits, .freeform = false },
    .{ .prefix = "bind:", .kind = .bind, .freeform = false },
    .{ .prefix = "blocked_by:", .kind = .blocked_by, .freeform = false },
    .{ .prefix = "posthook:", .kind = .posthook, .freeform = false },
    .{ .prefix = "prehook:", .kind = .prehook, .freeform = false },
    .{ .prefix = "modality:", .kind = .modality, .freeform = false },
    .{ .prefix = "at:", .kind = .at, .freeform = true },
    .{ .prefix = "repeat:", .kind = .repeat, .freeform = true },
};

extern fn popen(cmd: [*:0]const u8, mode: [*:0]const u8) ?*anyopaque;
extern fn pclose(stream: *anyopaque) c_int;
extern fn fread(ptr: [*]u8, size: usize, nmemb: usize, stream: *anyopaque) usize;

pub fn nowIsoUtc(buf: []u8) ![]u8 {
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
    _ = env;
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
/// Scan the local ledger for an existing "declared" event whose inputs_hash
/// matches the given hex digest. Returns the matched contract id (caller-
/// owned) on cache hit; null on miss. Used by declare() to make every
/// invocation idempotent: same plan text → same contract id, no row growth.
fn findCachedDeclared(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    plan_hex: []const u8,
) !?[]u8 {
    const body = ledger.readAll(allocator, env) catch return null;
    defer allocator.free(body);
    var iter = std.mem.tokenizeAny(u8, body, "\n");
    while (iter.next()) |line| {
        if (line.len < 2) continue;
        // Fast filter: skip lines that can't contain a declared event.
        if (std.mem.indexOf(u8, line, "\"event\": \"declared\"") == null and
            std.mem.indexOf(u8, line, "\"event\":\"declared\"") == null) continue;
        // Match the target inputs_hash literal. The substrate writes the
        // field with one space after the colon; tolerate both.
        var needle_buf: [128]u8 = undefined;
        const needle = std.fmt.bufPrint(&needle_buf, "\"inputs_hash\": \"{s}\"", .{plan_hex}) catch continue;
        if (std.mem.indexOf(u8, line, needle) == null) {
            const needle2 = std.fmt.bufPrint(&needle_buf, "\"inputs_hash\":\"{s}\"", .{plan_hex}) catch continue;
            if (std.mem.indexOf(u8, line, needle2) == null) continue;
        }
        // Extract id field — substrate always emits `"id": "<8hex>"`.
        const id_marker = "\"id\": \"";
        const id_marker2 = "\"id\":\"";
        const id_start = blk: {
            if (std.mem.indexOf(u8, line, id_marker)) |p| break :blk p + id_marker.len;
            if (std.mem.indexOf(u8, line, id_marker2)) |p| break :blk p + id_marker2.len;
            continue;
        };
        const id_end = std.mem.indexOfScalarPos(u8, line, id_start, '"') orelse continue;
        const id_slice = line[id_start..id_end];
        return try allocator.dupe(u8, id_slice);
    }
    return null;
}

pub fn declare(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    plan: []const u8,
    action: []const u8,
    opts: DeclareOptions,
) ![]u8 {
    // PARALLEL IDEMPOTENCY: the cache-scan + appendRow seam is wrapped in an
    // advisory exclusive flock on a `.lock` sidecar (per wave-40b TOCTOU
    // analysis). N concurrent declares with the same v2 hash resolve to
    // exactly 1 append + 1 id; distinct hashes serialize through the lock
    // but each still appends its own row. Readers (`readAll`) are not
    // serialized because they touch the data file, not the sidecar.
    const lock_fd = try ledger.acquireExclusive(allocator, env);
    defer ledger.releaseExclusive(lock_fd);

    // Cwd is part of the v2 cache key (context layer) — resolve BEFORE the
    // cache check, not after. Hoisted from later in this function.
    var cwd_buf: [4096]u8 = undefined;
    const cwd: []const u8 = blk: {
        if (opts.cwd) |c| break :blk c;
        const cwd_ptr = std.c.getcwd(&cwd_buf, cwd_buf.len);
        if (cwd_ptr == null) break :blk "";
        break :blk std.mem.span(@as([*:0]const u8, @ptrCast(cwd_ptr.?)));
    };

    // Cache check FIRST per AUTO-INVALIDATION-VIA-INPUT-POINTER-HASH
    // (contract 27a39635) + Lewis 2026-05-26 "always fires, checks cache
    // before doing anything else, and does so in parallel" + Docker-layer
    // proposal "kv cache must be context aware for the pointer". Compute
    // inputs_hash_v2 (cwd + plan + file_refs_digest + parent.inputs_hash);
    // scan the ledger for an existing declared row whose inputs_hash
    // matches. On cache hit, return that id and skip re-append; cache miss
    // proceeds to declare-and-append. sha256 collision-resistance: equal
    // hash ↔ equal v2 inputs ↔ same truth claim in same context.
    const inputs_hash = try computeInputsHashV2(
        allocator,
        env,
        plan,
        cwd,
        opts.inputs_file_refs_digest,
        opts.parent_id,
    );
    // Single owner. Cache-hit returns its own free; cache-miss installs a
    // function-wide defer so every path from here on releases the slice.
    if (try findCachedDeclared(allocator, env, inputs_hash)) |cached_id| {
        allocator.free(inputs_hash);
        return cached_id;
    }
    defer allocator.free(inputs_hash);

    const cid = try id_mod.generateId(allocator);
    errdefer allocator.free(cid);

    const ptype = pointer.inferPointerType(action);
    const layer = pointer.inferLayer(action);

    var ts_buf: [64]u8 = undefined;
    const ts = try nowIsoUtc(&ts_buf);

    var owned_agent: ?[]u8 = null;
    defer if (owned_agent) |a| allocator.free(a);
    const agent: []const u8 = blk: {
        if (opts.agent) |a| break :blk a;
        owned_agent = try getAgent(allocator, env);
        break :blk owned_agent.?;
    };

    // Refs may be named in either the action (machine-typed) or the plan
    // (user-narrated). Concatenate so extractors see both surfaces.
    var scan_buf: std.ArrayList(u8) = .empty;
    defer scan_buf.deinit(allocator);
    try scan_buf.appendSlice(allocator, action);
    try scan_buf.append(allocator, ' ');
    try scan_buf.appendSlice(allocator, plan);
    const scan_text = scan_buf.items;

    // One typed scan per declared row. Iterate the kind table once; each
    // ref discovered becomes a Synapse{ to, kind } in a single owned slice.
    var synapses: std.ArrayList(Synapse) = .empty;
    defer {
        for (synapses.items) |s| allocator.free(s.to);
        synapses.deinit(allocator);
    }
    for (synapse_table) |entry| {
        const ids = if (entry.freeform)
            try pointer.extractFreeformRefs(allocator, scan_text, entry.prefix)
        else
            try pointer.extractTypedRefs(allocator, scan_text, entry.prefix);
        defer allocator.free(ids); // inner-string ownership transfers to synapses[].to
        for (ids) |id| try synapses.append(allocator, .{ .to = id, .kind = entry.kind });
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
    // Typed edge list. One uniform array; readers discriminate by `kind`.
    try buf.appendSlice(allocator, ", \"synapses\": [");
    for (synapses.items, 0..) |s, idx| {
        if (idx > 0) try buf.appendSlice(allocator, ", ");
        try buf.appendSlice(allocator, "{\"to\": ");
        try writeJsonString(&buf, allocator, s.to);
        try buf.appendSlice(allocator, ", \"kind\": ");
        try writeJsonString(&buf, allocator, s.kind.jsonName());
        try buf.append(allocator, '}');
    }
    try buf.append(allocator, ']');

    // Cryptographic lineage: every row carries env_pubkey (the contract's
    // derived ed25519 public key) and parent_signature (parent privkey's
    // signature over a canonical digest of this row's identity). Roots are
    // self-signed. Derivation is deterministic from the single root key, so
    // no per-contract privkey lives on disk — substrate stays stateless
    // modulo the one root secret.
    if (lineage.loadOrInitRootKey(allocator, env)) |root_key| {
        const child_kp = try lineage.deriveKeyPair(root_key, cid);
        var pubkey_hex: [lineage.PUBKEY_HEX_LEN]u8 = undefined;
        lineage.bytesToHex(&child_kp.public_key.bytes, &pubkey_hex);

        const parent_or_root: []const u8 = if (opts.parent_id) |p| p else lineage.ROOT_PARENT_SENTINEL;
        var digest: [32]u8 = undefined;
        lineage.signingDigest(cid, &pubkey_hex, plan, parent_or_root, &digest);

        // Signer = parent's derived key when parented; else self (root contract).
        const signer_kp = if (opts.parent_id) |p|
            try lineage.deriveKeyPair(root_key, p)
        else
            child_kp;

        var sig_hex: [lineage.SIG_HEX_LEN]u8 = undefined;
        try lineage.signDigest(signer_kp, digest, &sig_hex);

        try buf.appendSlice(allocator, ", \"env_pubkey\": ");
        try writeJsonString(&buf, allocator, &pubkey_hex);
        try buf.appendSlice(allocator, ", \"parent_signature\": ");
        try writeJsonString(&buf, allocator, &sig_hex);
    } else |_| {
        // No root key resolvable (e.g. NoHome in a constrained env) — emit
        // the row without lineage rather than failing closed. Substrate
        // remains usable; provenance simply absent for that row.
    }

    // inputs_hash per contract 27a39635 (AUTO-INVALIDATION-VIA-INPUT-POINTER-HASH).
    // v2 layered (cwd + plan + file_refs_digest + parent.inputs_hash) — already
    // computed above for the cache check and reused here so the row, the cache
    // lookup, and the read-side recompute all agree on one digest.
    try buf.appendSlice(allocator, ", \"inputs_hash\": ");
    try writeJsonString(&buf, allocator, inputs_hash);
    try buf.appendSlice(allocator, ", \"inputs_hash_version\": 2");
    if (opts.inputs_file_refs_digest) |d| {
        if (d.len > 0) {
            try buf.appendSlice(allocator, ", \"inputs_file_refs_digest\": ");
            try writeJsonString(&buf, allocator, d);
        }
    }

    // Ad-hoc typed metadata. Caller passes typed Field entries; empty values
    // are dropped (treated as absent).
    for (opts.extras) |f| {
        if (f.value.len == 0) continue;
        try buf.appendSlice(allocator, ", ");
        try writeJsonString(&buf, allocator, f.key);
        try buf.appendSlice(allocator, ": ");
        try writeJsonString(&buf, allocator, f.value);
    }
    try buf.appendSlice(allocator, ", \"ts\": ");
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
/// Append a `reward` event row. Every gate that resolves can route a
/// reward signal to a tracking contract (CONTRACT_REWARD_CONTRACT_ID).
/// The tracking contract's input_hash depends on its referenced sources,
/// so the existing KV-cache invalidation mechanism fires the reward
/// neuron automatically when new reward rows land.
pub fn appendRewardRow(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    source_id: []const u8,
    target_id: []const u8,
    signal: []const u8,
    kv_hash: []const u8,
) !void {
    var ts_buf: [64]u8 = undefined;
    const ts = try nowIsoUtc(&ts_buf);
    const agent = try getAgent(allocator, env);
    defer allocator.free(agent);
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);
    try buf.appendSlice(allocator, "{\"event\": \"reward\", \"id\": ");
    try writeJsonString(&buf, allocator, target_id);
    try buf.appendSlice(allocator, ", \"source_id\": ");
    try writeJsonString(&buf, allocator, source_id);
    try buf.appendSlice(allocator, ", \"signal\": ");
    try writeJsonString(&buf, allocator, signal);
    try buf.appendSlice(allocator, ", \"kv_hash\": ");
    try writeJsonString(&buf, allocator, kv_hash);
    try buf.appendSlice(allocator, ", \"ts\": ");
    try writeJsonString(&buf, allocator, ts);
    try buf.appendSlice(allocator, ", \"agent\": ");
    try writeJsonString(&buf, allocator, agent);
    try buf.append(allocator, '}');
    const path = try ledger.appendRow(allocator, env, buf.items);
    allocator.free(path);
}

/// Append a `break_above` event row — a resolved gate escaping its
/// environment to surface its result at an ancestor layer. Each ancestor
/// in the chain receives one row; the ancestor's neuron resolver picks it
/// up via the affected-lineage queue and re-aggregates with the new
/// great-descendant evidence in scope.
pub fn appendBreakAboveRow(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    source_id: []const u8,
    ancestor_id: []const u8,
    result: []const u8,
    depth: u32,
) !void {
    var ts_buf: [64]u8 = undefined;
    const ts = try nowIsoUtc(&ts_buf);
    const agent = try getAgent(allocator, env);
    defer allocator.free(agent);
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);
    try buf.appendSlice(allocator, "{\"event\": \"break_above\", \"id\": ");
    try writeJsonString(&buf, allocator, ancestor_id);
    try buf.appendSlice(allocator, ", \"source_id\": ");
    try writeJsonString(&buf, allocator, source_id);
    try buf.appendSlice(allocator, ", \"depth\": ");
    var num_buf: [16]u8 = undefined;
    const d = try std.fmt.bufPrint(&num_buf, "{d}", .{depth});
    try buf.appendSlice(allocator, d);
    try buf.appendSlice(allocator, ", \"action_result\": ");
    try writeJsonString(&buf, allocator, result);
    try buf.appendSlice(allocator, ", \"ts\": ");
    try writeJsonString(&buf, allocator, ts);
    try buf.appendSlice(allocator, ", \"agent\": ");
    try writeJsonString(&buf, allocator, agent);
    try buf.append(allocator, '}');
    const path = try ledger.appendRow(allocator, env, buf.items);
    allocator.free(path);
}

/// Append a `guard` event row — a self-healing follow-up neuron declared
/// when a contract hits a classified roadblock (payment_required,
/// rate_limit, schema_mismatch, sabbath, pain, transport, etc.). The
/// guard's truth claim is "prevent future failures of this class at this
/// layer." Future contracts matching the same pattern auto-install the
/// guard as a prehook via the standard CONTRACT_PREHOOK_ID env.
///
/// Doctrine: scar tissue — once an organism survives an injury, it forms
/// guarding tissue that resists the same insult thereafter. Substrate
/// equivalent: every classified failure leaves a guard row; high-use
/// guards Hebbian-promote to primitive (canon 182b11c6 threshold=7).
pub fn appendGuardRow(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    source_id: []const u8,
    error_class: []const u8,
    layer: []const u8,
    remediation: []const u8,
) !void {
    var ts_buf: [64]u8 = undefined;
    const ts = try nowIsoUtc(&ts_buf);
    const agent = try getAgent(allocator, env);
    defer allocator.free(agent);
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);
    try buf.appendSlice(allocator, "{\"event\": \"guard\", \"id\": ");
    try writeJsonString(&buf, allocator, source_id);
    try buf.appendSlice(allocator, ", \"error_class\": ");
    try writeJsonString(&buf, allocator, error_class);
    try buf.appendSlice(allocator, ", \"layer\": ");
    try writeJsonString(&buf, allocator, layer);
    try buf.appendSlice(allocator, ", \"remediation\": ");
    try writeJsonString(&buf, allocator, remediation);
    try buf.appendSlice(allocator, ", \"ts\": ");
    try writeJsonString(&buf, allocator, ts);
    try buf.appendSlice(allocator, ", \"agent\": ");
    try writeJsonString(&buf, allocator, agent);
    try buf.append(allocator, '}');
    const path = try ledger.appendRow(allocator, env, buf.items);
    allocator.free(path);
}

/// Append a `flex_hold` event row — the middleware-side reservation
/// for a Faremeter Flex prepaid escrow authorization. Carries:
///   max_amount       — ceiling the facilitator may settle (lamports of mint)
///   mint             — SPL token mint (USDC by default)
///   authorization_id — random u64 for replay protection
///   expires_at_slot  — slot horizon (caller-provided; clamped server-side)
///   splits           — JSON array of {recipient, bps}; bps must sum to 10000
/// The facilitator validates the signature, reserves the hold in memory,
/// then converts it to an on-chain pending settlement via `flex_settle`.
pub fn appendFlexHoldRow(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    source_id: []const u8,
    max_amount: u64,
    mint: []const u8,
    authorization_id: []const u8,
    expires_at_slot: u64,
    splits_json: []const u8,
) !void {
    var ts_buf: [64]u8 = undefined;
    const ts = try nowIsoUtc(&ts_buf);
    const agent = try getAgent(allocator, env);
    defer allocator.free(agent);
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);
    try buf.appendSlice(allocator, "{\"event\": \"flex_hold\", \"id\": ");
    try writeJsonString(&buf, allocator, source_id);
    try buf.appendSlice(allocator, ", \"max_amount\": ");
    var num_buf: [32]u8 = undefined;
    const ma = try std.fmt.bufPrint(&num_buf, "{d}", .{max_amount});
    try buf.appendSlice(allocator, ma);
    try buf.appendSlice(allocator, ", \"mint\": ");
    try writeJsonString(&buf, allocator, mint);
    try buf.appendSlice(allocator, ", \"authorization_id\": ");
    try writeJsonString(&buf, allocator, authorization_id);
    try buf.appendSlice(allocator, ", \"expires_at_slot\": ");
    var num_buf2: [32]u8 = undefined;
    const es = try std.fmt.bufPrint(&num_buf2, "{d}", .{expires_at_slot});
    try buf.appendSlice(allocator, es);
    try buf.appendSlice(allocator, ", \"splits\": ");
    try buf.appendSlice(allocator, splits_json);
    try buf.appendSlice(allocator, ", \"ts\": ");
    try writeJsonString(&buf, allocator, ts);
    try buf.appendSlice(allocator, ", \"agent\": ");
    try writeJsonString(&buf, allocator, agent);
    try buf.append(allocator, '}');
    const path = try ledger.appendRow(allocator, env, buf.items);
    allocator.free(path);
}

/// Append a `flex_settle` event row — converts an in-memory hold to a
/// pending settlement at the actual amount consumed. Must reference a
/// prior `flex_hold` by authorization_id. settle_amount must be
/// <= the original max_amount (facilitator-enforced on-chain).
pub fn appendFlexSettleRow(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    source_id: []const u8,
    authorization_id: []const u8,
    settle_amount: u64,
) !void {
    var ts_buf: [64]u8 = undefined;
    const ts = try nowIsoUtc(&ts_buf);
    const agent = try getAgent(allocator, env);
    defer allocator.free(agent);
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);
    try buf.appendSlice(allocator, "{\"event\": \"flex_settle\", \"id\": ");
    try writeJsonString(&buf, allocator, source_id);
    try buf.appendSlice(allocator, ", \"authorization_id\": ");
    try writeJsonString(&buf, allocator, authorization_id);
    try buf.appendSlice(allocator, ", \"settle_amount\": ");
    var num_buf: [32]u8 = undefined;
    const sa = try std.fmt.bufPrint(&num_buf, "{d}", .{settle_amount});
    try buf.appendSlice(allocator, sa);
    try buf.appendSlice(allocator, ", \"ts\": ");
    try writeJsonString(&buf, allocator, ts);
    try buf.appendSlice(allocator, ", \"agent\": ");
    try writeJsonString(&buf, allocator, agent);
    try buf.append(allocator, '}');
    const path = try ledger.appendRow(allocator, env, buf.items);
    allocator.free(path);
}

/// Append an `invitation` event row — external aiko (by pubkey) joins
/// the inviter's network with typed role grants.
pub fn appendInvitationRow(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    inviter_id: []const u8,
    invitee_pubkey: []const u8,
    roles: []const u8,
) !void {
    var ts_buf: [64]u8 = undefined;
    const ts = try nowIsoUtc(&ts_buf);
    const agent = try getAgent(allocator, env);
    defer allocator.free(agent);
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);
    try buf.appendSlice(allocator, "{\"event\": \"invitation\", \"id\": ");
    try writeJsonString(&buf, allocator, inviter_id);
    try buf.appendSlice(allocator, ", \"invitee_pubkey\": ");
    try writeJsonString(&buf, allocator, invitee_pubkey);
    try buf.appendSlice(allocator, ", \"roles\": ");
    try writeJsonString(&buf, allocator, roles);
    try buf.appendSlice(allocator, ", \"ts\": ");
    try writeJsonString(&buf, allocator, ts);
    try buf.appendSlice(allocator, ", \"agent\": ");
    try writeJsonString(&buf, allocator, agent);
    try buf.append(allocator, '}');
    const path = try ledger.appendRow(allocator, env, buf.items);
    allocator.free(path);
}

/// Append a `grant` event row — single (actor_pubkey, role, scope) tuple.
pub fn appendGrantRow(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    granter_id: []const u8,
    actor_pubkey: []const u8,
    role: []const u8,
    scope: []const u8,
) !void {
    var ts_buf: [64]u8 = undefined;
    const ts = try nowIsoUtc(&ts_buf);
    const agent = try getAgent(allocator, env);
    defer allocator.free(agent);
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);
    try buf.appendSlice(allocator, "{\"event\": \"grant\", \"id\": ");
    try writeJsonString(&buf, allocator, granter_id);
    try buf.appendSlice(allocator, ", \"actor_pubkey\": ");
    try writeJsonString(&buf, allocator, actor_pubkey);
    try buf.appendSlice(allocator, ", \"role\": ");
    try writeJsonString(&buf, allocator, role);
    try buf.appendSlice(allocator, ", \"scope\": ");
    try writeJsonString(&buf, allocator, scope);
    try buf.appendSlice(allocator, ", \"ts\": ");
    try writeJsonString(&buf, allocator, ts);
    try buf.appendSlice(allocator, ", \"agent\": ");
    try writeJsonString(&buf, allocator, agent);
    try buf.append(allocator, '}');
    const path = try ledger.appendRow(allocator, env, buf.items);
    allocator.free(path);
}

/// Append a `pattern_use` event row — fires every time a contract
/// references a pattern via contract:<pattern_id> ref. The use_count
/// across these events is the Hebbian firing-rate analogue; when it
/// crosses the threshold, the pattern auto-promotes to `primitive` via
/// appendPrimitiveRow (handled by the resolver, not this writer).
pub fn appendPatternUseRow(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    pattern_id: []const u8,
    user_id: []const u8,
) !void {
    var ts_buf: [64]u8 = undefined;
    const ts = try nowIsoUtc(&ts_buf);
    const agent = try getAgent(allocator, env);
    defer allocator.free(agent);
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);
    try buf.appendSlice(allocator, "{\"event\": \"pattern_use\", \"id\": ");
    try writeJsonString(&buf, allocator, pattern_id);
    try buf.appendSlice(allocator, ", \"source_id\": ");
    try writeJsonString(&buf, allocator, user_id);
    try buf.appendSlice(allocator, ", \"ts\": ");
    try writeJsonString(&buf, allocator, ts);
    try buf.appendSlice(allocator, ", \"agent\": ");
    try writeJsonString(&buf, allocator, agent);
    try buf.append(allocator, '}');
    const path = try ledger.appendRow(allocator, env, buf.items);
    allocator.free(path);
}

/// Append a `primitive` event row — a pattern whose reuse count has
/// crossed the promotion threshold is now substrate-primitive. The cloud
/// compiler reads this row and bakes the pattern into the fast path
/// (server-side); locally it serves as the marker that the synapse has
/// long-term-potentiated. Doctrine: Hebbian LTP + Decalogue (most-used
/// among 613 commandments become the 10).
pub fn appendPrimitiveRow(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    pattern_id: []const u8,
    use_count: u32,
) !void {
    var ts_buf: [64]u8 = undefined;
    const ts = try nowIsoUtc(&ts_buf);
    const agent = try getAgent(allocator, env);
    defer allocator.free(agent);
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);
    var num_buf: [16]u8 = undefined;
    const uc = try std.fmt.bufPrint(&num_buf, "{d}", .{use_count});
    try buf.appendSlice(allocator, "{\"event\": \"primitive\", \"id\": ");
    try writeJsonString(&buf, allocator, pattern_id);
    try buf.appendSlice(allocator, ", \"use_count\": ");
    try buf.appendSlice(allocator, uc);
    try buf.appendSlice(allocator, ", \"ts\": ");
    try writeJsonString(&buf, allocator, ts);
    try buf.appendSlice(allocator, ", \"agent\": ");
    try writeJsonString(&buf, allocator, agent);
    try buf.append(allocator, '}');
    const path = try ledger.appendRow(allocator, env, buf.items);
    allocator.free(path);
}

/// Append a `pattern` ledger event row — the reusable lesson distilled
/// from a satisfied contract. Append-only (not a declared row), so it
/// doesn't trigger its own resolution cycle. Future aikos contract-search
/// over `pattern_text` to find related lessons before reinventing.
/// Anti-recursion guard: caller skips if source is itself a pattern row.
pub fn appendPatternRow(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    source_id: []const u8,
    pattern_text: []const u8,
) !void {
    var ts_buf: [64]u8 = undefined;
    const ts = try nowIsoUtc(&ts_buf);
    const agent = try getAgent(allocator, env);
    defer allocator.free(agent);
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);
    try buf.appendSlice(allocator, "{\"event\": \"pattern\", \"id\": ");
    try writeJsonString(&buf, allocator, source_id);
    try buf.appendSlice(allocator, ", \"pattern_text\": ");
    try writeJsonString(&buf, allocator, pattern_text);
    try buf.appendSlice(allocator, ", \"ts\": ");
    try writeJsonString(&buf, allocator, ts);
    try buf.appendSlice(allocator, ", \"agent\": ");
    try writeJsonString(&buf, allocator, agent);
    try buf.append(allocator, '}');
    const path = try ledger.appendRow(allocator, env, buf.items);
    allocator.free(path);
}

/// Append a `materialized` ledger event when a contract spawns its own
/// signed binary at a declared target. Captures the deployment lineage:
/// {cid, target_path, sha256, wallet_pubkey} so the chain is auditable.
pub fn appendMaterializedRow(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
    target_path: []const u8,
    sha256_hex: []const u8,
    wallet_pubkey_hex: []const u8,
) !void {
    var ts_buf: [64]u8 = undefined;
    const ts = try nowIsoUtc(&ts_buf);
    const agent = try getAgent(allocator, env);
    defer allocator.free(agent);
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);
    try buf.appendSlice(allocator, "{\"event\": \"materialized\", \"id\": ");
    try writeJsonString(&buf, allocator, id);
    try buf.appendSlice(allocator, ", \"target_path\": ");
    try writeJsonString(&buf, allocator, target_path);
    try buf.appendSlice(allocator, ", \"binary_sha256\": ");
    try writeJsonString(&buf, allocator, sha256_hex);
    try buf.appendSlice(allocator, ", \"wallet_pubkey\": ");
    try writeJsonString(&buf, allocator, wallet_pubkey_hex);
    try buf.appendSlice(allocator, ", \"ts\": ");
    try writeJsonString(&buf, allocator, ts);
    try buf.appendSlice(allocator, ", \"agent\": ");
    try writeJsonString(&buf, allocator, agent);
    try buf.append(allocator, '}');
    const path = try ledger.appendRow(allocator, env, buf.items);
    allocator.free(path);
}

pub fn recordIteration(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
    wave: u32,
    action_exit: i32,
    action_result: []const u8,
) !void {
    return recordIterationWithHash(allocator, env, id, wave, action_exit, action_result, "");
}

/// Append a `judged` event row — the agent-judged second key.
/// Verdict is one of PROMOTE | REJECT | HOLD. When PROMOTE, satisfaction
/// holds; when REJECT, the row stays in HOLD even if programmatic gate
/// passed. Captures the judge_id (which evaluator aiko returned this).
pub fn appendJudgedRow(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
    judge_id: []const u8,
    verdict: []const u8,
    reasoning: []const u8,
) !void {
    var ts_buf: [64]u8 = undefined;
    const ts = try nowIsoUtc(&ts_buf);
    const agent = try getAgent(allocator, env);
    defer allocator.free(agent);
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);
    try buf.appendSlice(allocator, "{\"event\": \"judged\", \"id\": ");
    try writeJsonString(&buf, allocator, id);
    try buf.appendSlice(allocator, ", \"judge_id\": ");
    try writeJsonString(&buf, allocator, judge_id);
    try buf.appendSlice(allocator, ", \"agent_verdict\": ");
    try writeJsonString(&buf, allocator, verdict);
    try buf.appendSlice(allocator, ", \"reasoning\": ");
    try writeJsonString(&buf, allocator, reasoning);
    try buf.appendSlice(allocator, ", \"ts\": ");
    try writeJsonString(&buf, allocator, ts);
    try buf.appendSlice(allocator, ", \"agent\": ");
    try writeJsonString(&buf, allocator, agent);
    try buf.append(allocator, '}');
    const path = try ledger.appendRow(allocator, env, buf.items);
    allocator.free(path);
}

/// Same as recordIteration but also records the input_hash that produced
/// this result. The input_hash is the content-addressed identity of the
/// (own plan + own action + recursive child input_hashes) tuple — when it
/// changes, the cached result is stale and the resolver re-runs the action.
pub fn recordIterationWithHash(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
    wave: u32,
    action_exit: i32,
    action_result: []const u8,
    input_hash: []const u8,
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
    if (input_hash.len > 0) {
        try buf.appendSlice(allocator, ", \"input_hash\": ");
        try writeJsonString(&buf, allocator, input_hash);
    }
    try buf.appendSlice(allocator, ", \"agent_verdict\": null, \"children_spawned\": [], \"log_path\": \"\", \"ts\": ");
    try writeJsonString(&buf, allocator, ts);
    try buf.appendSlice(allocator, ", \"agent\": ");
    try writeJsonString(&buf, allocator, agent);
    try buf.append(allocator, '}');

    const path = try ledger.appendRow(allocator, env, buf.items);
    allocator.free(path);
}

/// Compute the canonical message hashed for output_signature:
///   sha256(id || event_kind || wave_decimal || payload || ts)
/// `payload` is the event-specific bytes (proof for satisfied,
/// cause for died). All concatenated as raw bytes; result is 32 bytes.
/// This is the terminal-event analogue of lineage.signingDigest.
fn outputSigningDigest(
    id: []const u8,
    event_kind: []const u8,
    wave: u32,
    payload: []const u8,
    ts: []const u8,
    out: *[32]u8,
) void {
    var wave_buf: [16]u8 = undefined;
    const wave_str = std.fmt.bufPrint(&wave_buf, "{d}", .{wave}) catch "?";
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    hasher.update(id);
    hasher.update(&.{0});
    hasher.update(event_kind);
    hasher.update(&.{0});
    hasher.update(wave_str);
    hasher.update(&.{0});
    hasher.update(payload);
    hasher.update(&.{0});
    hasher.update(ts);
    hasher.final(out);
}

/// Sign a terminal event (satisfied/died) with the contract's derived
/// keypair. Returns the 128-char hex signature (caller-owned) or null
/// when the root key cannot be resolved (constrained env). Per Lewis
/// 2026-05-26 "treat the binary signed signatures of outputs as the
/// hash" — the signature IS the pointer-to-truth for the cache layer,
/// not a content digest of arbitrary bytes.
fn signOutput(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
    event_kind: []const u8,
    wave: u32,
    payload: []const u8,
    ts: []const u8,
) !?[]u8 {
    const root = lineage.loadOrInitRootKey(allocator, env) catch |e| {
        std.debug.print("signOutput: loadOrInitRootKey failed for {s}/{s}: {s} — row emitted unsigned, cache will fall back to content hash\n", .{ id, event_kind, @errorName(e) });
        return null;
    };
    const kp = lineage.deriveKeyPair(root, id) catch |e| {
        std.debug.print("signOutput: deriveKeyPair failed for {s}/{s}: {s} — row emitted unsigned, cache will fall back to content hash\n", .{ id, event_kind, @errorName(e) });
        return null;
    };
    var digest: [32]u8 = undefined;
    outputSigningDigest(id, event_kind, wave, payload, ts, &digest);
    var sig_hex: [lineage.SIG_HEX_LEN]u8 = undefined;
    lineage.signDigest(kp, digest, &sig_hex) catch |e| {
        std.debug.print("signOutput: signDigest failed for {s}/{s}: {s} — row emitted unsigned, cache will fall back to content hash\n", .{ id, event_kind, @errorName(e) });
        return null;
    };
    return try allocator.dupe(u8, &sig_hex);
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

    const payload: []const u8 = if (proof) |p| p else "";
    const sig_opt = try signOutput(allocator, env, id, "satisfied", wave, payload, ts);
    defer if (sig_opt) |s| allocator.free(s);

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
    if (sig_opt) |s| {
        try buf.appendSlice(allocator, ", \"output_signature\": ");
        try writeJsonString(&buf, allocator, s);
    }
    try buf.appendSlice(allocator, ", \"agent\": ");
    try writeJsonString(&buf, allocator, agent);
    try buf.append(allocator, '}');

    const path = try ledger.appendRow(allocator, env, buf.items);
    allocator.free(path);
}

/// Death cause for natural-selection over the contract DAG. Each cause is
/// biblically-anchored:
///   .superseded — John 12:24, the seed dies that fruit may come; the
///                  superseding contract carries the truth forward.
///   .contradicts — Romans 6:23, the wages of contradiction is death; the
///                  contract violates an established root principle.
///   .stale       — Genesis 3:19, dust thou art, unto dust shalt thou return;
///                  declared with no evidence and no path to satisfaction.
///   .apoptosed   — programmed self-shutdown; the row's purpose has been
///                  served (smoke probe, debug session) and it retires by
///                  intent rather than failure.
pub const DeathCause = enum {
    superseded,
    contradicts,
    stale,
    apoptosed,

    pub fn jsonName(self: DeathCause) []const u8 {
        return switch (self) {
            .superseded => "superseded",
            .contradicts => "contradicts",
            .stale => "stale",
            .apoptosed => "apoptosed",
        };
    }
};

/// Append a `died` event row. Append-only: a dead row stays in the ledger,
/// but the substrate's projection treats it as terminated rather than
/// pending. Per Hebrews 9:27 — appointed once to die, and after this the
/// judgment. The `by_id` pointer is mandatory for .superseded / .contradicts
/// (death must name its agent); optional for .stale / .apoptosed.
pub fn markDied(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
    cause: DeathCause,
    by_id: ?[]const u8,
    reason: ?[]const u8,
) !void {
    var ts_buf: [64]u8 = undefined;
    const ts = try nowIsoUtc(&ts_buf);

    const agent = try getAgent(allocator, env);
    defer allocator.free(agent);

    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);

    try buf.appendSlice(allocator, "{\"event\": \"died\", \"id\": ");
    try writeJsonString(&buf, allocator, id);
    try buf.appendSlice(allocator, ", \"cause\": ");
    try writeJsonString(&buf, allocator, cause.jsonName());
    if (by_id) |b| {
        if (b.len > 0) {
            try buf.appendSlice(allocator, ", \"by_contract_id\": ");
            try writeJsonString(&buf, allocator, b);
        }
    }
    if (reason) |r| {
        if (r.len > 0) {
            try buf.appendSlice(allocator, ", \"reason\": ");
            try writeJsonString(&buf, allocator, r);
        }
    }
    try buf.appendSlice(allocator, ", \"ts\": ");
    try writeJsonString(&buf, allocator, ts);
    try buf.appendSlice(allocator, ", \"agent\": ");
    try writeJsonString(&buf, allocator, agent);
    try buf.append(allocator, '}');

    const path = try ledger.appendRow(allocator, env, buf.items);
    allocator.free(path);
}

/// Append a `called` event row recording that the dispatcher fired a hook
/// from `source_id` toward `target_pointer` (typically `contract:<id>`). The
/// `call_kind` discriminates posthook vs prehook vs posttool vs pretool.
pub fn appendCalledRow(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    source_id: []const u8,
    target_pointer: []const u8,
    call_kind: []const u8,
) !void {
    // Resolve antipattern:posthook-pointer-as-raw-url — `target_pointer` must
    // be a Synapse-shaped pointer (e.g. `contract:<id>`, `posthook:<id>`,
    // `bind:<id>`, …). Payload-bearing strings violate pointers-over-payload;
    // the caller must declare the payload as its own contract row first and
    // pass `contract:<id>` here. Table-driven check against synapse_table —
    // the single source of truth for edge kinds.
    const valid_prefix = blk: {
        for (synapse_table) |entry| {
            if (std.mem.startsWith(u8, target_pointer, entry.prefix)) break :blk true;
        }
        break :blk false;
    };
    if (!valid_prefix) {
        std.debug.print(
            "contract.appendCalledRow: target_pointer must be a Synapse-shaped pointer; got '{s}'. " ++
                "Declare the payload as its own contract row first, then pass 'contract:<id>'.\n",
            .{target_pointer},
        );
        return error.NotASynapsePointer;
    }

    var ts_buf: [64]u8 = undefined;
    const ts = try nowIsoUtc(&ts_buf);

    const agent = try getAgent(allocator, env);
    defer allocator.free(agent);

    // Sign the called-row body so posthook recipients can verify the
    // source aiko's wallet authorized the call. Signing key is derived
    // from root_seed + source_id via lineage.deriveKeyPair — same pattern
    // as parent_signature on declared rows (canon Imago Dei c64e41c6).
    var sig_hex: [lineage.SIG_HEX_LEN]u8 = undefined;
    var pubkey_hex: [lineage.PUBKEY_HEX_LEN]u8 = undefined;
    var signed = false;
    if (lineage.loadOrInitRootKey(allocator, env)) |root| {
        if (lineage.deriveKeyPair(root, source_id)) |kp| {
            var digest: [32]u8 = undefined;
            var hasher = std.crypto.hash.sha2.Sha256.init(.{});
            hasher.update(source_id);
            hasher.update(target_pointer);
            hasher.update(call_kind);
            hasher.update(ts);
            hasher.final(&digest);
            if (lineage.signDigest(kp, digest, &sig_hex)) {
                lineage.bytesToHex(&kp.public_key.bytes, &pubkey_hex);
                signed = true;
            } else |err| {
                std.debug.print("called-row: signDigest failed for source {s}: {s} — row emitted unsigned, posthook recipients cannot verify provenance\n", .{ source_id, @errorName(err) });
            }
        } else |err| {
            std.debug.print("called-row: deriveKeyPair failed for source {s}: {s} — row emitted unsigned, posthook recipients cannot verify provenance\n", .{ source_id, @errorName(err) });
        }
    } else |err| {
        std.debug.print("called-row: loadOrInitRootKey failed: {s} — row emitted unsigned, posthook recipients cannot verify provenance\n", .{@errorName(err)});
    }

    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);

    try buf.appendSlice(allocator, "{\"event\": \"called\", \"id\": ");
    try writeJsonString(&buf, allocator, source_id);
    try buf.appendSlice(allocator, ", \"target_pointer\": ");
    try writeJsonString(&buf, allocator, target_pointer);
    try buf.appendSlice(allocator, ", \"call_kind\": ");
    try writeJsonString(&buf, allocator, call_kind);
    if (signed) {
        try buf.appendSlice(allocator, ", \"call_signature\": ");
        try writeJsonString(&buf, allocator, &sig_hex);
        try buf.appendSlice(allocator, ", \"caller_pubkey\": ");
        try writeJsonString(&buf, allocator, &pubkey_hex);
    }
    try buf.appendSlice(allocator, ", \"ts\": ");
    try writeJsonString(&buf, allocator, ts);
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

/// Helper mirroring the validator gate in appendCalledRow. Surfaces the
/// table-driven check so unit tests can verify the antipattern is rejected
/// without standing up a ledger + signing wallet for each case.
fn isSynapseShapedPointer(target_pointer: []const u8) bool {
    for (synapse_table) |entry| {
        if (std.mem.startsWith(u8, target_pointer, entry.prefix)) return true;
    }
    return false;
}

test "appendCalledRow validator: synapse-shaped pointers accepted, payload rejected" {
    // Accepted prefixes (sample from synapse_table — single source of truth).
    try std.testing.expect(isSynapseShapedPointer("contract:abc12345"));
    try std.testing.expect(isSynapseShapedPointer("posthook:deadbeef"));
    try std.testing.expect(isSynapseShapedPointer("prehook:cafef00d"));
    try std.testing.expect(isSynapseShapedPointer("bind:11112222"));
    try std.testing.expect(isSynapseShapedPointer("blocked_by:33334444"));
    try std.testing.expect(isSynapseShapedPointer("inhibits:55556666"));
    try std.testing.expect(isSynapseShapedPointer("modality:77778888"));
    try std.testing.expect(isSynapseShapedPointer("at:2026-05-26T10:00:00Z"));
    try std.testing.expect(isSynapseShapedPointer("repeat:0 9 * * *"));
    // Rejected: the two real-world antipattern strings the binary used to
    // emit, plus a generic raw URL / opaque payload.
    try std.testing.expect(!isSynapseShapedPointer("flex:budget:lamports=1000:mint=USDC"));
    try std.testing.expect(!isSynapseShapedPointer("wireguard-lineage-mesh:peer=abc,nonce=def,tag=01,ct=ff"));
    try std.testing.expect(!isSynapseShapedPointer("https://example.com/raw-url"));
    try std.testing.expect(!isSynapseShapedPointer(""));
}
