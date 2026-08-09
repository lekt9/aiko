//! mcp_server.zig — JSON-RPC 2.0 MCP stdio server for the /contract substrate.
//!
//! Hand-rolled over stdin/stdout (no SDK) so the wallet binary can serve agents
//! directly as `aiko mcp`. Tool semantics are delegated via `DispatchFn` — the
//! server owns the wire protocol only; main.zig owns substrate dispatch.

const std = @import("std");
const builtin = @import("builtin");
const is_windows = builtin.os.tag == .windows;

extern fn _read(fd: c_int, buffer: [*]u8, count: c_uint) c_int;
extern fn _write(fd: c_int, buffer: [*]const u8, count: c_uint) c_int;
extern fn _setmode(fd: c_int, mode: c_int) c_int;

fn readStdin(bytes: []u8) isize {
    if (is_windows) return @intCast(_read(0, bytes.ptr, @intCast(bytes.len)));
    return std.c.read(std.c.STDIN_FILENO, bytes.ptr, bytes.len);
}

fn writeStdout(bytes: []const u8) isize {
    if (is_windows) return @intCast(_write(1, bytes.ptr, @intCast(bytes.len)));
    return std.c.write(std.c.STDOUT_FILENO, bytes.ptr, bytes.len);
}

pub const ToolResult = struct {
    text: []const u8,
    is_error: bool,
};

pub const DispatchFn = *const fn (
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    tool_name: []const u8,
    args: std.json.Value,
) anyerror!ToolResult;

/// Who this server says it is. Hardcoding it made the door announce
/// "contract" while serving a host's own catalog — a name that no longer
/// described what was behind it. Identity travels with the catalog.
pub const ServerInfo = struct {
    name: []const u8 = "contract",
    title: []const u8 = "Contract",
    version: []const u8 = "0.1.0",
    description: []const u8 = "Native /contract MCP — declare/iterate/search/find_skills/symlink on the wallet ledger.",
};

pub const ToolSpec = struct {
    name: []const u8,
    description: []const u8,
    schema: []const u8,
};

/// The default catalog: contract's own verbs, aligned with unbrowse
/// contract-mcp-bridge.ts plus contract-and-find-skills (find_skills) and
/// Truth Seek symlinks.
///
/// It is a DEFAULT, not the catalog. This module's contract is that it owns the
/// wire protocol and the host owns substrate dispatch — but the catalog was
/// hardcoded here, which contradicted that: a host could supply its own tool
/// semantics and could not supply its own tool list, so any host with verbs of
/// its own had to either edit this file (putting foreign concerns into
/// contract) or reimplement the JSON-RPC loop (a second protocol to drift).
/// `runStdio` now takes the catalog for the same reason it already takes
/// `dispatch`.
pub const TOOLS = [_]ToolSpec{
    .{
        .name = "declare",
        .description = "Declare a contract truth claim with a mechanical check (plan + action).",
        .schema =
        \\{"type":"object","properties":{"plan":{"type":"string"},"action":{"type":"string"},"parent":{"type":"string"},"scope":{"type":"string","enum":["project","global"]},"fast":{"type":"boolean"}},"required":["plan","action"]}
        ,
    },
    .{
        .name = "iterate",
        .description = "Run one iteration wave on an existing contract id.",
        .schema =
        \\{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}
        ,
    },
    .{
        .name = "status",
        .description = "Tree view of one contract or the whole ledger summary.",
        .schema =
        \\{"type":"object","properties":{"id":{"type":"string"}}}
        ,
    },
    .{
        .name = "list",
        .description = "List contracts; optional scope filter via discover.",
        .schema =
        \\{"type":"object","properties":{"show_merged":{"type":"boolean"},"scope":{"type":"string","enum":["project","global","all"]}}}
        ,
    },
    .{
        .name = "search",
        .description = "BM25+embed energy-ranked contract search for a context string.",
        .schema =
        \\{"type":"object","properties":{"context":{"type":"string"},"scope":{"type":"string","enum":["project","global"]}},"required":["context"]}
        ,
    },
    .{
        .name = "find_skills",
        .description = "Rank ~/.claude/skills and harnesses for a gap (contract-and-find-skills discover step).",
        .schema =
        \\{"type":"object","properties":{"gap":{"type":"string"},"top":{"type":"integer"}},"required":["gap"]}
        ,
    },
    .{
        .name = "symlink_list",
        .description = "List canonical Truth Seek semantic symlinks (~> / ↝).",
        .schema = "{\"type\":\"object\",\"properties\":{}}",
    },
    .{
        .name = "symlink_resolve",
        .description = "Resolve one semantic symlink surface to its verse anchor JSON.",
        .schema =
        \\{"type":"object","properties":{"surface":{"type":"string"}},"required":["surface"]}
        ,
    },
    .{
        .name = "trust_evaluate",
        .description = "Replay the local append-only trust ledger and evaluate one governed claim.",
        .schema =
        \\{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}
        ,
    },
    .{
        .name = "agency_validate",
        .description = "Validate a canonical six-role agency envelope without touching the ledger or signing path.",
        .schema =
        \\{"type":"object","properties":{"envelope":{"type":"string"}},"required":["envelope"]}
        ,
    },
};

const Value = std.json.Value;
const PROTOCOL = "2024-11-05";

fn writeAllStdout(bytes: []const u8) !void {
    var off: usize = 0;
    while (off < bytes.len) {
        const n = writeStdout(bytes[off..]);
        if (n <= 0) return error.WriteFailed;
        off += @intCast(n);
    }
}

/// NDJSON response (legacy / Claude-friendly).
fn writeLine(allocator: std.mem.Allocator, line: []const u8) !void {
    var buf = try allocator.alloc(u8, line.len + 1);
    defer allocator.free(buf);
    @memcpy(buf[0..line.len], line);
    buf[line.len] = '\n';
    try writeAllStdout(buf);
}

/// Content-Length framed response (MCP / LSP standard).
fn writeContentLength(body: []const u8) !void {
    var hdr_buf: [64]u8 = undefined;
    const hdr = try std.fmt.bufPrint(&hdr_buf, "Content-Length: {d}\r\n\r\n", .{body.len});
    try writeAllStdout(hdr);
    try writeAllStdout(body);
}

/// Reply in the framing the client used on the last request.
fn writeMessage(allocator: std.mem.Allocator, line: []const u8, content_length: bool) !void {
    if (content_length) {
        try writeContentLength(line);
    } else {
        try writeLine(allocator, line);
    }
}

fn writeError(allocator: std.mem.Allocator, id: Value, code: i64, message: []const u8, content_length: bool) !void {
    var aw: std.Io.Writer.Allocating = .init(allocator);
    defer aw.deinit();
    var s = std.json.Stringify{ .writer = &aw.writer };
    try s.beginObject();
    try s.objectField("jsonrpc");
    try s.write("2.0");
    try s.objectField("id");
    try s.write(id);
    try s.objectField("error");
    try s.beginObject();
    try s.objectField("code");
    try s.write(code);
    try s.objectField("message");
    try s.write(message);
    try s.endObject();
    try s.endObject();
    try writeMessage(allocator, aw.writer.buffered(), content_length);
}

fn writeInitialize(allocator: std.mem.Allocator, id: Value, info: ServerInfo, content_length: bool) !void {
    var aw: std.Io.Writer.Allocating = .init(allocator);
    defer aw.deinit();
    var s = std.json.Stringify{ .writer = &aw.writer };
    try s.beginObject();
    try s.objectField("jsonrpc");
    try s.write("2.0");
    try s.objectField("id");
    try s.write(id);
    try s.objectField("result");
    try s.beginObject();
    try s.objectField("protocolVersion");
    try s.write(PROTOCOL);
    try s.objectField("capabilities");
    try s.beginObject();
    try s.objectField("tools");
    try s.beginObject();
    try s.objectField("listChanged");
    try s.write(false);
    try s.endObject();
    try s.endObject();
    try s.objectField("serverInfo");
    try s.beginObject();
    try s.objectField("name");
    try s.write(info.name);
    try s.objectField("title");
    try s.write(info.title);
    try s.objectField("version");
    try s.write(info.version);
    try s.objectField("description");
    try s.write(info.description);
    try s.endObject();
    try s.endObject();
    try s.endObject();
    try writeMessage(allocator, aw.writer.buffered(), content_length);
}

fn writeToolsList(allocator: std.mem.Allocator, arena: std.mem.Allocator, id: Value, tools: []const ToolSpec, content_length: bool) !void {
    var aw: std.Io.Writer.Allocating = .init(allocator);
    defer aw.deinit();
    var s = std.json.Stringify{ .writer = &aw.writer };
    try s.beginObject();
    try s.objectField("jsonrpc");
    try s.write("2.0");
    try s.objectField("id");
    try s.write(id);
    try s.objectField("result");
    try s.beginObject();
    try s.objectField("tools");
    try s.beginArray();
    for (tools) |t| {
        try s.beginObject();
        try s.objectField("name");
        try s.write(t.name);
        try s.objectField("description");
        try s.write(t.description);
        try s.objectField("inputSchema");
        const parsed = try std.json.parseFromSliceLeaky(Value, arena, t.schema, .{ .allocate = .alloc_always });
        try s.write(parsed);
        try s.endObject();
    }
    try s.endArray();
    try s.endObject();
    try s.endObject();
    try writeMessage(allocator, aw.writer.buffered(), content_length);
}

fn writeToolResult(allocator: std.mem.Allocator, id: Value, result: ToolResult, content_length: bool) !void {
    var aw: std.Io.Writer.Allocating = .init(allocator);
    defer aw.deinit();
    var s = std.json.Stringify{ .writer = &aw.writer };
    try s.beginObject();
    try s.objectField("jsonrpc");
    try s.write("2.0");
    try s.objectField("id");
    try s.write(id);
    try s.objectField("result");
    try s.beginObject();
    try s.objectField("content");
    try s.beginArray();
    try s.beginObject();
    try s.objectField("type");
    try s.write("text");
    try s.objectField("text");
    try s.write(result.text);
    try s.endObject();
    try s.endArray();
    try s.objectField("isError");
    try s.write(result.is_error);
    try s.endObject();
    try s.endObject();
    try writeMessage(allocator, aw.writer.buffered(), content_length);
}

fn specFor(tools: []const ToolSpec, name: []const u8) ?ToolSpec {
    for (tools) |t| {
        if (std.mem.eql(u8, t.name, name)) return t;
    }
    return null;
}

fn handleToolsCall(
    allocator: std.mem.Allocator,
    id: Value,
    params: Value,
    env: std.process.Environ,
    tools: []const ToolSpec,
    dispatch: DispatchFn,
    content_length: bool,
) !void {
    if (params != .object) {
        try writeError(allocator, id, -32602, "Invalid params", content_length);
        return;
    }
    const name_val = params.object.get("name") orelse {
        try writeError(allocator, id, -32602, "Missing tool name", content_length);
        return;
    };
    if (name_val != .string) {
        try writeError(allocator, id, -32602, "Tool name must be a string", content_length);
        return;
    }
    const tool_name = name_val.string;
    if (specFor(tools, tool_name) == null) {
        try writeError(allocator, id, -32601, "Tool not found", content_length);
        return;
    }
    const args_val = params.object.get("arguments") orelse Value{ .object = .empty };
    const output = dispatch(allocator, env, tool_name, args_val) catch |e| {
        const msg = try std.fmt.allocPrint(allocator, "dispatch error: {s}", .{@errorName(e)});
        defer allocator.free(msg);
        try writeToolResult(allocator, id, .{ .text = msg, .is_error = true }, content_length);
        return;
    };
    defer allocator.free(output.text);
    try writeToolResult(allocator, id, output, content_length);
}

fn readStdinLine(allocator: std.mem.Allocator) !?[]u8 {
    var buf: std.ArrayList(u8) = .empty;
    errdefer buf.deinit(allocator);
    var chunk: [1]u8 = undefined;
    while (true) {
        const n = readStdin(&chunk);
        if (n <= 0) {
            if (buf.items.len == 0) return null;
            return try buf.toOwnedSlice(allocator);
        }
        if (chunk[0] == '\n') break;
        if (chunk[0] != '\r') try buf.append(allocator, chunk[0]);
    }
    return try buf.toOwnedSlice(allocator);
}

/// Read one MCP message. Supports:
///   · NDJSON (one JSON object per line) — historical Aiko/Claude path
///   · Content-Length framing (MCP/LSP) — Grok and most SDK clients
/// Sets `content_length_out` so replies can mirror the request framing.
fn readStdinMessage(allocator: std.mem.Allocator, content_length_out: *bool) !?[]u8 {
    const first = try readStdinLine(allocator) orelse return null;
    const trimmed = std.mem.trim(u8, first, " \t\r\n");

    // Content-Length: N\r\n ... \r\n\r\n <body>
    if (std.mem.startsWith(u8, trimmed, "Content-Length:") or std.mem.startsWith(u8, trimmed, "content-length:")) {
        content_length_out.* = true;
        const colon = std.mem.indexOfScalar(u8, trimmed, ':') orelse {
            allocator.free(first);
            return error.InvalidFraming;
        };
        const len_str = std.mem.trim(u8, trimmed[colon + 1 ..], " \t");
        const content_len = std.fmt.parseInt(usize, len_str, 10) catch {
            allocator.free(first);
            return error.InvalidFraming;
        };
        allocator.free(first);
        // Consume remaining headers until blank line
        while (true) {
            const h = try readStdinLine(allocator) orelse return null;
            const ht = std.mem.trim(u8, h, " \t\r\n");
            const blank = ht.len == 0;
            allocator.free(h);
            if (blank) break;
        }
        if (content_len == 0) return try allocator.dupe(u8, "");
        const body = try allocator.alloc(u8, content_len);
        errdefer allocator.free(body);
        var off: usize = 0;
        while (off < content_len) {
            const n = readStdin(body[off..]);
            if (n <= 0) {
                allocator.free(body);
                return null;
            }
            off += @intCast(n);
        }
        return body;
    }

    content_length_out.* = false;
    // NDJSON: the first line *is* the message. Transfer ownership of `first`
    // only when we keep it; if trim changed length, re-dupe the trimmed view.
    if (trimmed.len == first.len and trimmed.ptr == first.ptr) {
        return first;
    }
    defer allocator.free(first);
    return try allocator.dupe(u8, trimmed);
}

/// Run the MCP stdio loop until stdin closes.
pub fn runStdio(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    info: ServerInfo,
    tools: []const ToolSpec,
    dispatch: DispatchFn,
) !void {
    // The Windows CRT defaults stdio to text mode, which rewrites CRLF and
    // would make Content-Length count bytes that the server never receives.
    if (is_windows) {
        const binary_mode = 0x8000;
        if (_setmode(0, binary_mode) == -1 or _setmode(1, binary_mode) == -1)
            return error.StdioModeFailed;
    }

    var initialized = false;
    var reply_cl = false;

    while (true) {
        const line_owned = readStdinMessage(allocator, &reply_cl) catch |e| {
            if (e == error.InvalidFraming) {
                try writeError(allocator, .null, -32700, "Parse error", false);
                continue;
            }
            return e;
        };
        if (line_owned == null) break;
        defer allocator.free(line_owned.?);
        const trimmed = std.mem.trim(u8, line_owned.?, " \t\r\n");
        if (trimmed.len == 0) continue;

        var arena_state = std.heap.ArenaAllocator.init(allocator);
        defer arena_state.deinit();
        const arena = arena_state.allocator();

        const parsed = std.json.parseFromSliceLeaky(Value, arena, trimmed, .{ .allocate = .alloc_always }) catch {
            try writeError(allocator, .null, -32700, "Parse error", reply_cl);
            continue;
        };

        if (parsed != .object) {
            try writeError(allocator, .null, -32600, "Invalid Request", reply_cl);
            continue;
        }

        const jsonrpc = parsed.object.get("jsonrpc") orelse {
            try writeError(allocator, .null, -32600, "Invalid Request", reply_cl);
            continue;
        };
        if (jsonrpc != .string or !std.mem.eql(u8, jsonrpc.string, "2.0")) {
            try writeError(allocator, .null, -32600, "Invalid Request", reply_cl);
            continue;
        }

        const id = parsed.object.get("id") orelse .null;
        const method_val = parsed.object.get("method") orelse {
            if (id != .null) try writeError(allocator, id, -32600, "Invalid Request", reply_cl);
            continue;
        };
        if (method_val != .string) {
            if (id != .null) try writeError(allocator, id, -32600, "Invalid Request", reply_cl);
            continue;
        }
        const method = method_val.string;
        const params = parsed.object.get("params") orelse .null;

        if (std.mem.eql(u8, method, "initialize")) {
            initialized = true;
            try writeInitialize(allocator, id, info, reply_cl);
        } else if (std.mem.eql(u8, method, "notifications/initialized")) {
            // no response
        } else if (std.mem.eql(u8, method, "ping")) {
            if (id != .null) {
                var aw: std.Io.Writer.Allocating = .init(allocator);
                defer aw.deinit();
                var s = std.json.Stringify{ .writer = &aw.writer };
                try s.beginObject();
                try s.objectField("jsonrpc");
                try s.write("2.0");
                try s.objectField("id");
                try s.write(id);
                try s.objectField("result");
                try s.beginObject();
                try s.endObject();
                try s.endObject();
                try writeMessage(allocator, aw.writer.buffered(), reply_cl);
            }
        } else if (!initialized) {
            if (id != .null) try writeError(allocator, id, -32002, "Server not initialized", reply_cl);
        } else if (std.mem.eql(u8, method, "tools/list")) {
            try writeToolsList(allocator, arena, id, tools, reply_cl);
        } else if (std.mem.eql(u8, method, "tools/call")) {
            try handleToolsCall(allocator, id, params, env, tools, dispatch, reply_cl);
        } else {
            if (id != .null) try writeError(allocator, id, -32601, "Method not found", reply_cl);
        }
    }
}
