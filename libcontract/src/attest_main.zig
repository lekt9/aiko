//! attest_main.zig — standalone LLM-judge binary that lands signed
//! attestations into `.contract-spirit-attest.jsonl`.
//!
//! For each source file in `spirit.SOURCE_FILES`:
//!   1. Read the file's bytes; compute sha256.
//!   2. POST a chat-completion request to the configured OpenAI-
//!      compatible endpoint (default: Nebius Studio). The prompt asks
//!      the LLM to judge whether the file's structure parallels the
//!      10 commandments (order) and the 7 fruits of the spirit, and
//!      to respond with strict JSON `{"verdict": "PASS"|"FAIL",
//!      "reasoning": "..."}`.
//!   3. Sign the canonical digest `attest|<path>|<sha>|<verdict>`
//!      with the root /contract wallet (lineage.zig).
//!   4. Append a `spirit_attested` row to the attestation ledger.
//!
//! Environment:
//!   NEBIUS_API_KEY       (REQUIRED) — bearer token for the LLM API.
//!   NEBIUS_MODEL         (optional) — model id; default Kimi-K2.
//!   NEBIUS_URL           (optional) — chat-completions URL.
//!
//! Exit codes:
//!   0  every source attested (PASS).
//!   1  one or more files attested as FAIL.
//!   2  LLM/network/config error.
//!
//! This binary is built WITHOUT the spirit-check gate so it can run
//! on a fresh repo where no attestations exist yet. It is the only
//! such ungated binary in the build graph.

const std = @import("std");
const spirit = @import("spirit.zig");
const ledger = @import("ledger.zig");
const lineage = @import("lineage.zig");
const http = @import("http.zig");

const DEFAULT_MODEL: []const u8 = "moonshotai/Kimi-K2-Instruct";
const DEFAULT_URL: []const u8 = "https://api.studio.nebius.com/v1/chat/completions";
const MAX_SOURCE_BYTES: usize = 18 * 1024; // truncate huge files for prompt size

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

fn nowIsoUtc(buf: []u8) ![]u8 {
    var tv: std.c.timeval = undefined;
    _ = std.c.gettimeofday(&tv, null);
    const epoch_secs = std.time.epoch.EpochSeconds{ .secs = @intCast(tv.sec) };
    const epoch_day = epoch_secs.getEpochDay();
    const year_day = epoch_day.calculateYearDay();
    const month_day = year_day.calculateMonthDay();
    const day_secs = epoch_secs.getDaySeconds();
    return try std.fmt.bufPrint(buf, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}Z", .{
        year_day.year,
        month_day.month.numeric(),
        month_day.day_index + 1,
        day_secs.getHoursIntoDay(),
        day_secs.getMinutesIntoHour(),
        day_secs.getSecondsIntoMinute(),
    });
}

fn readFileTruncated(allocator: std.mem.Allocator, abs_path: []const u8) ![]u8 {
    const path_z = try allocator.dupeZ(u8, abs_path);
    defer allocator.free(path_z);
    var flags: std.c.O = .{};
    flags.ACCMODE = .RDONLY;
    const fd: c_int = std.c.open(path_z.ptr, flags, @as(c_uint, 0));
    if (fd < 0) return error.SourceUnreadable;
    defer _ = std.c.close(fd);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    var buf: [4096]u8 = undefined;
    while (out.items.len < MAX_SOURCE_BYTES) {
        const n = std.c.read(fd, &buf, buf.len);
        if (n <= 0) break;
        try out.appendSlice(allocator, buf[0..@intCast(n)]);
    }
    return try out.toOwnedSlice(allocator);
}

fn buildPrompt(allocator: std.mem.Allocator, file_path: []const u8, source: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.appendSlice(allocator,
        \\You are evaluating a Zig source file against two doctrinal axes:
        \\
        \\ORDER — the 10 Commandments (Exodus 20). The file MUST NOT violate any:
        \\
    );
    for (spirit.COMMANDMENTS, 0..) |c, i| {
        try out.writer(allocator).print("  {d}. {s}\n", .{ i + 1, c });
    }
    try out.appendSlice(allocator,
        \\
        \\SPIRIT — 7 fruits of the spirit (Galatians 5:22-23). The file SHOULD embody:
        \\
    );
    for (spirit.FRUITS, 0..) |f, i| {
        try out.writer(allocator).print("  {d}. {s}\n", .{ i + 1, f });
    }
    try out.appendSlice(allocator,
        \\
        \\Read the source below. Respond with STRICT JSON on a SINGLE LINE — no prose
        \\outside the JSON, no markdown fences:
        \\
        \\  {"verdict":"PASS","reasoning":"<one sentence>"}
        \\  {"verdict":"FAIL","reasoning":"<one sentence naming the violation>"}
        \\
        \\PASS = no commandment violated AND at least some fruits present.
        \\FAIL = a commandment violated OR no fruits present.
        \\
        \\File:
    );
    try out.appendSlice(allocator, file_path);
    try out.appendSlice(allocator, "\nSource:\n<<<\n");
    try out.appendSlice(allocator, source);
    try out.appendSlice(allocator, "\n>>>\n");
    return try out.toOwnedSlice(allocator);
}

fn buildChatRequest(allocator: std.mem.Allocator, model: []const u8, prompt: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.appendSlice(allocator, "{\"model\": ");
    try writeJsonString(&out, allocator, model);
    try out.appendSlice(allocator, ", \"temperature\": 0.1, \"messages\": [{\"role\": \"user\", \"content\": ");
    try writeJsonString(&out, allocator, prompt);
    try out.appendSlice(allocator, "}]}");
    return try out.toOwnedSlice(allocator);
}

/// Find the chat completion's `content` field in a strict JSON
/// response — naive walk; matches "content": "...". Returns slice
/// into input.
fn extractContent(body: []const u8) ?[]const u8 {
    const needle = "\"content\":";
    const at = std.mem.indexOf(u8, body, needle) orelse return null;
    var i = at + needle.len;
    while (i < body.len and (body[i] == ' ' or body[i] == '\t')) : (i += 1) {}
    if (i >= body.len or body[i] != '"') return null;
    i += 1;
    const start = i;
    while (i < body.len) : (i += 1) {
        if (body[i] == '\\') {
            i += 1;
            continue;
        }
        if (body[i] == '"') return body[start..i];
    }
    return null;
}

/// Decode JSON-escaped backslash sequences into a fresh slice. Only
/// handles \n \" \\ since that's what LLM output uses.
fn decodeJsonEscapes(allocator: std.mem.Allocator, raw: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    var i: usize = 0;
    while (i < raw.len) : (i += 1) {
        if (raw[i] == '\\' and i + 1 < raw.len) {
            const c = raw[i + 1];
            switch (c) {
                'n' => try out.append(allocator, '\n'),
                't' => try out.append(allocator, '\t'),
                '"' => try out.append(allocator, '"'),
                '\\' => try out.append(allocator, '\\'),
                '/' => try out.append(allocator, '/'),
                else => try out.append(allocator, c),
            }
            i += 1;
        } else try out.append(allocator, raw[i]);
    }
    return try out.toOwnedSlice(allocator);
}

const Verdict = struct {
    verdict: []const u8,
    reasoning: []const u8,
};

fn parseVerdict(content: []const u8) ?Verdict {
    const v_marker = "\"verdict\":";
    const v_at = std.mem.indexOf(u8, content, v_marker) orelse return null;
    var i = v_at + v_marker.len;
    while (i < content.len and (content[i] == ' ' or content[i] == '"')) : (i += 1) {}
    const v_start = i;
    while (i < content.len and content[i] != '"') : (i += 1) {}
    const v_end = i;
    const verdict_str = content[v_start..v_end];

    const r_marker = "\"reasoning\":";
    const r_at = std.mem.indexOf(u8, content, r_marker) orelse return null;
    var j = r_at + r_marker.len;
    while (j < content.len and (content[j] == ' ' or content[j] == '"')) : (j += 1) {}
    const r_start = j;
    while (j < content.len) : (j += 1) {
        if (content[j] == '\\') {
            j += 1;
            continue;
        }
        if (content[j] == '"') break;
    }
    return .{ .verdict = verdict_str, .reasoning = content[r_start..j] };
}

pub fn main(init: std.process.Init.Minimal) !u8 {
    var arena: std.heap.ArenaAllocator = .init(std.heap.page_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const env = init.environ;

    const api_key = env.getPosix("NEBIUS_API_KEY") orelse {
        std.debug.print(
            "aiko-attest: NEBIUS_API_KEY env not set.\n" ++
                "  Export NEBIUS_API_KEY (or any OpenAI-compatible bearer) and re-run.\n",
            .{},
        );
        return 2;
    };
    const model = env.getPosix("NEBIUS_MODEL") orelse DEFAULT_MODEL;
    const url = env.getPosix("NEBIUS_URL") orelse DEFAULT_URL;

    const ledger_path = spirit.attestationLedgerPath(allocator) catch |e| {
        std.debug.print("aiko-attest: cannot resolve attestation ledger path: {s}\n", .{@errorName(e)});
        return 2;
    };
    std.debug.print("aiko-attest: ledger {s}\n", .{ledger_path});
    const repo_root = std.fs.path.dirname(ledger_path) orelse {
        std.debug.print("aiko-attest: ledger path has no parent dir\n", .{});
        return 2;
    };

    const root_key = lineage.loadOrInitRootKey(allocator, env) catch |e| {
        std.debug.print("aiko-attest: root wallet unreachable: {s}\n", .{@errorName(e)});
        return 2;
    };
    const root_kp = lineage.deriveKeyPair(root_key, "") catch |e| {
        std.debug.print("aiko-attest: deriveKeyPair failed: {s}\n", .{@errorName(e)});
        return 2;
    };
    var pubkey_hex: [lineage.PUBKEY_HEX_LEN]u8 = undefined;
    lineage.bytesToHex(&root_kp.public_key.bytes, &pubkey_hex);

    var any_fail = false;
    for (spirit.SOURCE_FILES) |rel_path| {
        const abs_path = try std.fs.path.join(allocator, &.{ repo_root, rel_path });
        defer allocator.free(abs_path);

        std.debug.print("aiko-attest: judging {s} ... ", .{rel_path});

        const source = readFileTruncated(allocator, abs_path) catch |e| {
            std.debug.print("READ_ERR ({s})\n", .{@errorName(e)});
            any_fail = true;
            continue;
        };
        defer allocator.free(source);

        const sha = try spirit.sourceSha256(allocator, abs_path);
        defer allocator.free(sha);

        const prompt = try buildPrompt(allocator, rel_path, source);
        defer allocator.free(prompt);

        const body = try buildChatRequest(allocator, model, prompt);
        defer allocator.free(body);

        const resp = http.postJson(allocator, url, body, api_key) catch |e| {
            std.debug.print("HTTP_ERR ({s})\n", .{@errorName(e)});
            any_fail = true;
            continue;
        };
        defer allocator.free(resp.body);
        if (resp.status < 200 or resp.status >= 300) {
            std.debug.print("HTTP {d}\n", .{resp.status});
            any_fail = true;
            continue;
        }

        const content_raw = extractContent(resp.body) orelse {
            std.debug.print("NO_CONTENT_IN_RESPONSE\n", .{});
            any_fail = true;
            continue;
        };
        const content = try decodeJsonEscapes(allocator, content_raw);
        defer allocator.free(content);

        const v = parseVerdict(content) orelse {
            std.debug.print("UNPARSED_VERDICT\n", .{});
            any_fail = true;
            continue;
        };

        // Canonical digest for the signature.
        var canonical: std.ArrayList(u8) = .empty;
        defer canonical.deinit(allocator);
        try canonical.appendSlice(allocator, "attest|");
        try canonical.appendSlice(allocator, rel_path);
        try canonical.append(allocator, '|');
        try canonical.appendSlice(allocator, sha);
        try canonical.append(allocator, '|');
        try canonical.appendSlice(allocator, v.verdict);
        var digest: [32]u8 = undefined;
        var h = std.crypto.hash.sha2.Sha256.init(.{});
        h.update(canonical.items);
        h.final(&digest);
        var sig_hex: [lineage.SIG_HEX_LEN]u8 = undefined;
        try lineage.signDigest(root_kp, digest, &sig_hex);

        // Build the row.
        var ts_buf: [64]u8 = undefined;
        const ts = try nowIsoUtc(&ts_buf);
        var row: std.ArrayList(u8) = .empty;
        defer row.deinit(allocator);
        try row.appendSlice(allocator, "{\"event\": \"spirit_attested\", \"file\": ");
        try writeJsonString(&row, allocator, rel_path);
        try row.appendSlice(allocator, ", \"source_sha256\": ");
        try writeJsonString(&row, allocator, sha);
        try row.appendSlice(allocator, ", \"verdict\": ");
        try writeJsonString(&row, allocator, v.verdict);
        try row.appendSlice(allocator, ", \"reasoning\": ");
        try writeJsonString(&row, allocator, v.reasoning);
        try row.appendSlice(allocator, ", \"model\": ");
        try writeJsonString(&row, allocator, model);
        try row.appendSlice(allocator, ", \"signature\": ");
        try writeJsonString(&row, allocator, &sig_hex);
        try row.appendSlice(allocator, ", \"signer_pubkey\": ");
        try writeJsonString(&row, allocator, &pubkey_hex);
        try row.appendSlice(allocator, ", \"ts\": ");
        try writeJsonString(&row, allocator, ts);
        try row.append(allocator, '}');

        // Append to the attestation ledger directly (NOT through
        // ledger.appendRow which resolves to .claude/contracts.jsonl;
        // we want the dedicated spirit attest file at repo root).
        try appendToFile(allocator, ledger_path, row.items);

        std.debug.print("{s}\n", .{v.verdict});
        if (!std.mem.eql(u8, v.verdict, "PASS")) any_fail = true;
    }

    if (any_fail) return 1;
    return 0;
}

fn appendToFile(allocator: std.mem.Allocator, path: []const u8, row: []const u8) !void {
    _ = allocator;
    var path_buf: [4096]u8 = undefined;
    if (path.len >= path_buf.len) return error.PathTooLong;
    @memcpy(path_buf[0..path.len], path);
    path_buf[path.len] = 0;
    const path_z: [*:0]const u8 = @ptrCast(&path_buf);
    var flags: std.c.O = .{};
    flags.ACCMODE = .WRONLY;
    flags.CREAT = true;
    flags.APPEND = true;
    const fd: c_int = std.c.open(path_z, flags, @as(c_uint, 0o644));
    if (fd < 0) return error.LedgerWriteFailed;
    defer _ = std.c.close(fd);
    const iov = [_]std.c.iovec_const{
        .{ .base = row.ptr, .len = row.len },
        .{ .base = "\n", .len = 1 },
    };
    const n = std.c.writev(fd, &iov, iov.len);
    if (n < 0) return error.LedgerWriteFailed;
}
