//! mcp_server.zig — JSON-RPC 2.0 MCP stdio server for the /contract substrate.
//!
//! Hand-rolled over stdin/stdout (no SDK) so the wallet binary can serve agents
//! directly as `aiko mcp`. Tool semantics are delegated via `DispatchFn` — the
//! server owns the wire protocol only; main.zig owns substrate dispatch.

const std = @import("std");

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

pub const ToolSpec = struct {
    name: []const u8,
    description: []const u8,
    schema: []const u8,
};

/// MCP tool catalog — aligned with unbrowse contract-mcp-bridge.ts plus
/// contract-and-find-skills (find_skills) and Truth Seek symlinks.
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
        const n = std.c.write(std.c.STDOUT_FILENO, bytes[off..].ptr, bytes.len - off);
        if (n <= 0) return error.WriteFailed;
        off += @intCast(n);
    }
}

fn writeLine(allocator: std.mem.Allocator, line: []const u8) !void {
    var buf = try allocator.alloc(u8, line.len + 1);
    defer allocator.free(buf);
    @memcpy(buf[0..line.len], line);
    buf[line.len] = '\n';
    try writeAllStdout(buf);
}

fn writeError(allocator: std.mem.Allocator, id: Value, code: i64, message: []const u8) !void {
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
    try writeLine(allocator, aw.writer.buffered());
}

fn writeInitialize(allocator: std.mem.Allocator, id: Value) !void {
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
    try s.write("contract");
    try s.objectField("title");
    try s.write("Contract");
    try s.objectField("version");
    try s.write("0.1.0");
    try s.objectField("description");
    try s.write("Native /contract MCP — declare/iterate/search/find_skills/symlink on the wallet ledger.");
    try s.endObject();
    try s.endObject();
    try s.endObject();
    try writeLine(allocator, aw.writer.buffered());
}

fn writeToolsList(allocator: std.mem.Allocator, arena: std.mem.Allocator, id: Value) !void {
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
    for (TOOLS) |t| {
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
    try writeLine(allocator, aw.writer.buffered());
}

fn writeToolResult(allocator: std.mem.Allocator, id: Value, result: ToolResult) !void {
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
    try writeLine(allocator, aw.writer.buffered());
}

fn specFor(name: []const u8) ?ToolSpec {
    for (TOOLS) |t| {
        if (std.mem.eql(u8, t.name, name)) return t;
    }
    return null;
}

fn handleToolsCall(
    allocator: std.mem.Allocator,
    id: Value,
    params: Value,
    env: std.process.Environ,
    dispatch: DispatchFn,
) !void {
    if (params != .object) {
        try writeError(allocator, id, -32602, "Invalid params");
        return;
    }
    const name_val = params.object.get("name") orelse {
        try writeError(allocator, id, -32602, "Missing tool name");
        return;
    };
    if (name_val != .string) {
        try writeError(allocator, id, -32602, "Tool name must be a string");
        return;
    }
    const tool_name = name_val.string;
    if (specFor(tool_name) == null) {
        try writeError(allocator, id, -32601, "Tool not found");
        return;
    }
    const args_val = params.object.get("arguments") orelse Value{ .object = .empty };
    const output = dispatch(allocator, env, tool_name, args_val) catch |e| {
        const msg = try std.fmt.allocPrint(allocator, "dispatch error: {s}", .{@errorName(e)});
        defer allocator.free(msg);
        try writeToolResult(allocator, id, .{ .text = msg, .is_error = true });
        return;
    };
    defer allocator.free(output.text);
    try writeToolResult(allocator, id, output);
}

fn readStdinLine(allocator: std.mem.Allocator) !?[]u8 {
    var buf: std.ArrayList(u8) = .empty;
    errdefer buf.deinit(allocator);
    var chunk: [1]u8 = undefined;
    while (true) {
        const n = std.c.read(std.c.STDIN_FILENO, &chunk, 1);
        if (n <= 0) {
            if (buf.items.len == 0) return null;
            return try buf.toOwnedSlice(allocator);
        }
        if (chunk[0] == '\n') break;
        if (chunk[0] != '\r') try buf.append(allocator, chunk[0]);
    }
    return try buf.toOwnedSlice(allocator);
}

/// Run the MCP stdio loop until stdin closes.
pub fn runStdio(allocator: std.mem.Allocator, env: std.process.Environ, dispatch: DispatchFn) !void {
    var initialized = false;

    while (true) {
        const line_owned = try readStdinLine(allocator);
        if (line_owned == null) break;
        defer allocator.free(line_owned.?);
        const trimmed = std.mem.trim(u8, line_owned.?, " \t\r\n");
        if (trimmed.len == 0) continue;

        var arena_state = std.heap.ArenaAllocator.init(allocator);
        defer arena_state.deinit();
        const arena = arena_state.allocator();

        const parsed = std.json.parseFromSliceLeaky(Value, arena, trimmed, .{ .allocate = .alloc_always }) catch {
            try writeError(allocator, .null, -32700, "Parse error");
            continue;
        };

        if (parsed != .object) {
            try writeError(allocator, .null, -32600, "Invalid Request");
            continue;
        }

        const jsonrpc = parsed.object.get("jsonrpc") orelse {
            try writeError(allocator, .null, -32600, "Invalid Request");
            continue;
        };
        if (jsonrpc != .string or !std.mem.eql(u8, jsonrpc.string, "2.0")) {
            try writeError(allocator, .null, -32600, "Invalid Request");
            continue;
        }

        const id = parsed.object.get("id") orelse .null;
        const method_val = parsed.object.get("method") orelse {
            if (id != .null) try writeError(allocator, id, -32600, "Invalid Request");
            continue;
        };
        if (method_val != .string) {
            if (id != .null) try writeError(allocator, id, -32600, "Invalid Request");
            continue;
        }
        const method = method_val.string;
        const params = parsed.object.get("params") orelse .null;

        if (std.mem.eql(u8, method, "initialize")) {
            initialized = true;
            try writeInitialize(allocator, id);
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
                try writeLine(allocator, aw.writer.buffered());
            }
        } else if (!initialized) {
            if (id != .null) try writeError(allocator, id, -32002, "Server not initialized");
        } else if (std.mem.eql(u8, method, "tools/list")) {
            try writeToolsList(allocator, arena, id);
        } else if (std.mem.eql(u8, method, "tools/call")) {
            try handleToolsCall(allocator, id, params, env, dispatch);
        } else {
            if (id != .null) try writeError(allocator, id, -32601, "Method not found");
        }
    }
}
