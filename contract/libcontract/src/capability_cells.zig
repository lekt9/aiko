//! Typed capability descriptors and cold-start routing priors.
//!
//! Descriptors state what is available; ledger outcomes state what is proven.
//! The two are deliberately separate so a new install can discover a primitive
//! without manufacturing a satisfied contract.

const std = @import("std");

pub const Cell = struct {
    id: []const u8,
    tool: []const u8,
    action: []const u8,
    description: []const u8,
    keywords: []const []const u8,
    read_only: bool,
    permission: []const u8,
    requires: []const []const u8,
    sequence: []const []const u8,
};

pub const CELLS = [_]Cell{
    .{ .id = "application.attach", .tool = "application_observe", .action = "attach", .description = "Attach directly to a running browser or Electron CDP target.", .keywords = &.{ "attach", "connect", "electron", "running app", "browser" }, .read_only = true, .permission = "read", .requires = &.{"cdp_target"}, .sequence = &.{"application.attach"} },
    .{ .id = "application.snapshot", .tool = "application_observe", .action = "snapshot", .description = "Retrieve the current accessibility tree and stable element references.", .keywords = &.{ "inspect", "screen", "snapshot", "current view", "what is open", "find button", "context" }, .read_only = true, .permission = "read", .requires = &.{"attached"}, .sequence = &.{ "application.attach", "application.snapshot" } },
    .{ .id = "application.url", .tool = "application_observe", .action = "url", .description = "Read the attached renderer's current URL.", .keywords = &.{ "current url", "address", "location" }, .read_only = true, .permission = "read", .requires = &.{"attached"}, .sequence = &.{ "application.attach", "application.url" } },
    .{ .id = "application.title", .tool = "application_observe", .action = "title", .description = "Read the attached renderer's current document title.", .keywords = &.{ "title", "page name", "window name" }, .read_only = true, .permission = "read", .requires = &.{"attached"}, .sequence = &.{ "application.attach", "application.title" } },
    .{ .id = "application.text", .tool = "application_observe", .action = "text", .description = "Read visible text from an application element.", .keywords = &.{ "read", "text", "label", "content", "what does" }, .read_only = true, .permission = "read", .requires = &.{"snapshot_ref"}, .sequence = &.{ "application.attach", "application.snapshot", "application.text" } },
    .{ .id = "application.attribute", .tool = "application_observe", .action = "attribute", .description = "Read one DOM or accessibility attribute from an element.", .keywords = &.{ "attribute", "property", "aria", "value of element" }, .read_only = true, .permission = "read", .requires = &.{ "snapshot_ref", "attribute" }, .sequence = &.{ "application.attach", "application.snapshot", "application.attribute" } },
    .{ .id = "application.tabs", .tool = "application_observe", .action = "tabs", .description = "List tabs and renderer targets in the attached application.", .keywords = &.{ "tabs", "open pages", "renderer targets" }, .read_only = true, .permission = "read", .requires = &.{"attached"}, .sequence = &.{ "application.attach", "application.tabs" } },
    .{ .id = "application.console", .tool = "application_observe", .action = "console", .description = "Read captured renderer console messages.", .keywords = &.{ "console", "console logs", "debug output" }, .read_only = true, .permission = "read", .requires = &.{"attached"}, .sequence = &.{ "application.attach", "application.console" } },
    .{ .id = "application.errors", .tool = "application_observe", .action = "errors", .description = "Read captured renderer errors.", .keywords = &.{ "errors", "exceptions", "renderer failure" }, .read_only = true, .permission = "read", .requires = &.{"attached"}, .sequence = &.{ "application.attach", "application.errors" } },
    .{ .id = "application.session_info", .tool = "application_observe", .action = "session_info", .description = "Inspect the embedded application's current attachment state.", .keywords = &.{ "session info", "attachment state", "connected target" }, .read_only = true, .permission = "read", .requires = &.{}, .sequence = &.{"application.session_info"} },
    .{ .id = "application.inspect", .tool = "application_observe", .action = "inspect", .description = "Inspect structural details for the current renderer.", .keywords = &.{ "inspect structure", "dom details", "element details" }, .read_only = true, .permission = "read", .requires = &.{"attached"}, .sequence = &.{ "application.attach", "application.inspect" } },
    .{ .id = "application.react_tree", .tool = "application_observe", .action = "react_tree", .description = "Read the renderer's React component tree when available.", .keywords = &.{ "react tree", "components", "react structure" }, .read_only = true, .permission = "read", .requires = &.{"attached"}, .sequence = &.{ "application.attach", "application.react_tree" } },
    .{ .id = "application.requests", .tool = "application_observe", .action = "requests", .description = "Inspect HTTP and API requests emitted by the attached renderer.", .keywords = &.{ "api", "request", "network", "endpoint", "fetch", "graphql" }, .read_only = true, .permission = "read", .requires = &.{"attached"}, .sequence = &.{ "application.attach", "application.requests" } },
    .{ .id = "application.request_detail", .tool = "application_observe", .action = "request_detail", .description = "Inspect one captured application request and its metadata.", .keywords = &.{ "request detail", "headers", "payload", "specific request" }, .read_only = true, .permission = "read", .requires = &.{"request_id"}, .sequence = &.{ "application.attach", "application.requests", "application.request_detail" } },
    .{ .id = "application.response_body", .tool = "application_observe", .action = "response_body", .description = "Retrieve the response body for a captured application request.", .keywords = &.{ "response", "response body", "api result", "network body" }, .read_only = true, .permission = "read", .requires = &.{"request_id"}, .sequence = &.{ "application.attach", "application.requests", "application.response_body" } },
    .{ .id = "application.launch", .tool = "application_act", .action = "launch", .description = "Launch a browser runtime or attach target through the embedded engine.", .keywords = &.{ "launch browser", "start browser", "open browser" }, .read_only = false, .permission = "write", .requires = &.{}, .sequence = &.{"application.launch"} },
    .{ .id = "application.click", .tool = "application_act", .action = "click", .description = "Click an application element using a stable accessibility reference.", .keywords = &.{ "click", "press button", "choose", "activate", "open menu" }, .read_only = false, .permission = "write", .requires = &.{"snapshot_ref"}, .sequence = &.{ "application.attach", "application.snapshot", "application.click" } },
    .{ .id = "application.double_click", .tool = "application_act", .action = "double_click", .description = "Double-click an application element.", .keywords = &.{ "double click", "open item", "double-click" }, .read_only = false, .permission = "write", .requires = &.{"snapshot_ref"}, .sequence = &.{ "application.attach", "application.snapshot", "application.double_click" } },
    .{ .id = "application.fill", .tool = "application_act", .action = "fill", .description = "Replace the value of an application form field.", .keywords = &.{ "fill", "replace value", "form", "field value" }, .read_only = false, .permission = "write", .requires = &.{ "snapshot_ref", "value" }, .sequence = &.{ "application.attach", "application.snapshot", "application.fill" } },
    .{ .id = "application.type", .tool = "application_act", .action = "type", .description = "Type text into the focused application element.", .keywords = &.{ "type", "write", "keyboard", "input text" }, .read_only = false, .permission = "write", .requires = &.{ "snapshot_ref", "value" }, .sequence = &.{ "application.attach", "application.snapshot", "application.type" } },
    .{ .id = "application.press", .tool = "application_act", .action = "press", .description = "Press a keyboard key in the attached application.", .keywords = &.{ "press key", "keyboard shortcut", "hit enter", "escape key" }, .read_only = false, .permission = "write", .requires = &.{"key"}, .sequence = &.{ "application.attach", "application.press" } },
    .{ .id = "application.hover", .tool = "application_act", .action = "hover", .description = "Hover over an application element.", .keywords = &.{ "hover", "mouse over", "reveal tooltip" }, .read_only = false, .permission = "write", .requires = &.{"snapshot_ref"}, .sequence = &.{ "application.attach", "application.snapshot", "application.hover" } },
    .{ .id = "application.scroll", .tool = "application_act", .action = "scroll", .description = "Scroll the attached application.", .keywords = &.{ "scroll", "move down", "move up", "page down" }, .read_only = false, .permission = "write", .requires = &.{"direction"}, .sequence = &.{ "application.attach", "application.scroll" } },
    .{ .id = "application.select", .tool = "application_act", .action = "select", .description = "Select an option in an application control.", .keywords = &.{ "select option", "dropdown", "choose option" }, .read_only = false, .permission = "write", .requires = &.{ "snapshot_ref", "value" }, .sequence = &.{ "application.attach", "application.snapshot", "application.select" } },
    .{ .id = "application.check", .tool = "application_act", .action = "check", .description = "Check a checkbox or toggle.", .keywords = &.{ "check box", "enable toggle", "turn on" }, .read_only = false, .permission = "write", .requires = &.{"snapshot_ref"}, .sequence = &.{ "application.attach", "application.snapshot", "application.check" } },
    .{ .id = "application.uncheck", .tool = "application_act", .action = "uncheck", .description = "Clear a checkbox or toggle.", .keywords = &.{ "uncheck", "disable toggle", "turn off" }, .read_only = false, .permission = "write", .requires = &.{"snapshot_ref"}, .sequence = &.{ "application.attach", "application.snapshot", "application.uncheck" } },
    .{ .id = "application.navigate", .tool = "application_act", .action = "navigate", .description = "Navigate the attached browser or Electron renderer.", .keywords = &.{ "navigate", "go to", "open url", "visit", "load page" }, .read_only = false, .permission = "write", .requires = &.{"url"}, .sequence = &.{ "application.attach", "application.navigate" } },
    .{ .id = "application.back", .tool = "application_act", .action = "back", .description = "Navigate back in renderer history.", .keywords = &.{ "go back", "previous page", "back navigation" }, .read_only = false, .permission = "write", .requires = &.{"attached"}, .sequence = &.{ "application.attach", "application.back" } },
    .{ .id = "application.forward", .tool = "application_act", .action = "forward", .description = "Navigate forward in renderer history.", .keywords = &.{ "go forward", "next page", "forward navigation" }, .read_only = false, .permission = "write", .requires = &.{"attached"}, .sequence = &.{ "application.attach", "application.forward" } },
    .{ .id = "application.reload", .tool = "application_act", .action = "reload", .description = "Reload the current renderer.", .keywords = &.{ "reload", "refresh page", "refresh app" }, .read_only = false, .permission = "write", .requires = &.{"attached"}, .sequence = &.{ "application.attach", "application.reload" } },
    .{ .id = "application.new_tab", .tool = "application_act", .action = "new_tab", .description = "Open a new browser tab.", .keywords = &.{ "new tab", "open tab", "another page" }, .read_only = false, .permission = "write", .requires = &.{"attached"}, .sequence = &.{ "application.attach", "application.new_tab" } },
    .{ .id = "application.switch_tab", .tool = "application_act", .action = "switch_tab", .description = "Switch to another renderer tab.", .keywords = &.{ "switch tab", "change tab", "activate tab" }, .read_only = false, .permission = "write", .requires = &.{"tab_id"}, .sequence = &.{ "application.attach", "application.tabs", "application.switch_tab" } },
    .{ .id = "application.close_tab", .tool = "application_act", .action = "close_tab", .description = "Close a renderer tab.", .keywords = &.{ "close tab", "remove tab" }, .read_only = false, .permission = "write", .requires = &.{"tab_id"}, .sequence = &.{ "application.attach", "application.tabs", "application.close_tab" } },
    .{ .id = "application.close", .tool = "application_act", .action = "close", .description = "Close the embedded browser session.", .keywords = &.{ "close browser", "end session", "shut browser" }, .read_only = false, .permission = "write", .requires = &.{"attached"}, .sequence = &.{ "application.attach", "application.close" } },
    .{ .id = "application.evaluate", .tool = "application_act", .action = "evaluate", .description = "Call a renderer API intentionally exposed through an Electron preload bridge.", .keywords = &.{ "evaluate", "preload", "renderer api", "invoke api", "javascript", "electron api" }, .read_only = false, .permission = "write", .requires = &.{"expression"}, .sequence = &.{ "application.attach", "application.evaluate" } },
};

/// Export Contract-owned application priors through the same strict FECH
/// descriptor shape as dynamic providers. Prerequisites are capability edges
/// derived from the cell's safe execution sequence (the terminal cell itself
/// is omitted).
pub fn descriptorsJson(allocator: std.mem.Allocator) ![]u8 {
    var aw: std.Io.Writer.Allocating = .init(allocator);
    errdefer aw.deinit();
    var out = std.json.Stringify{ .writer = &aw.writer };
    try out.beginArray();
    for (CELLS) |cell| {
        try out.beginObject();
        try out.objectField("schema_version");
        try out.write(1);
        try out.objectField("id");
        try out.write(cell.id);
        try out.objectField("capability_version");
        try out.write("1");
        try out.objectField("provider");
        try out.write("aiko_builtin");
        try out.objectField("tool");
        try out.write(cell.tool);
        try out.objectField("action");
        try out.write(cell.action);
        try out.objectField("description");
        try out.write(cell.description);
        try out.objectField("input_schema");
        try out.beginObject();
        try out.endObject();
        try out.objectField("output_schema");
        try out.beginObject();
        try out.endObject();
        try out.objectField("requires");
        try out.beginArray();
        for (cell.sequence) |step| {
            if (!std.mem.eql(u8, step, cell.id)) try out.write(step);
        }
        try out.endArray();
        try out.objectField("permission");
        try out.write(cell.permission);
        try out.objectField("effects");
        try out.beginArray();
        try out.write(if (cell.read_only) "read_only" else "local_write");
        try out.endArray();
        try out.objectField("available");
        try out.write(true);
        try out.endObject();
    }
    try out.endArray();
    return aw.toOwnedSlice();
}

const Ranked = struct {
    cell: Cell,
    score: f64,
    status: []const u8,
};

fn containsFold(haystack: []const u8, needle: []const u8) bool {
    if (needle.len == 0 or needle.len > haystack.len) return false;
    var i: usize = 0;
    while (i + needle.len <= haystack.len) : (i += 1) {
        if (std.ascii.eqlIgnoreCase(haystack[i .. i + needle.len], needle)) return true;
    }
    return false;
}

fn priorScore(cell: Cell, context: []const u8) f64 {
    var score: f64 = 0.05;
    for (cell.keywords) |keyword| {
        if (containsFold(context, keyword)) {
            score += if (std.mem.indexOfScalar(u8, keyword, ' ') == null) 0.42 else 0.55;
        }
    }
    if (containsFold(context, cell.action)) score += 0.45;
    return @min(score, 0.99);
}

fn jsonStringField(json: []const u8, key: []const u8) ?[]const u8 {
    var needle_buf: [80]u8 = undefined;
    const needle = std.fmt.bufPrint(&needle_buf, "\"{s}\":\"", .{key}) catch return null;
    const start = std.mem.indexOf(u8, json, needle) orelse return null;
    const value_start = start + needle.len;
    const end = std.mem.indexOfScalarPos(u8, json, value_start, '"') orelse return null;
    return json[value_start..end];
}

fn jsonFloatField(json: []const u8, key: []const u8) ?f64 {
    var needle_buf: [80]u8 = undefined;
    const needle = std.fmt.bufPrint(&needle_buf, "\"{s}\":", .{key}) catch return null;
    const start = std.mem.indexOf(u8, json, needle) orelse return null;
    var end = start + needle.len;
    while (end < json.len and (std.ascii.isDigit(json[end]) or json[end] == '-' or json[end] == '.' or json[end] == 'e')) : (end += 1) {}
    return std.fmt.parseFloat(f64, json[start + needle.len .. end]) catch null;
}

fn appendString(buf: *std.ArrayList(u8), allocator: std.mem.Allocator, value: []const u8) !void {
    try buf.append(allocator, '"');
    for (value) |c| switch (c) {
        '"' => try buf.appendSlice(allocator, "\\\""),
        '\\' => try buf.appendSlice(allocator, "\\\\"),
        '\n' => try buf.appendSlice(allocator, "\\n"),
        else => try buf.append(allocator, c),
    };
    try buf.append(allocator, '"');
}

fn appendStrings(buf: *std.ArrayList(u8), allocator: std.mem.Allocator, values: []const []const u8) !void {
    try buf.append(allocator, '[');
    for (values, 0..) |value, i| {
        if (i > 0) try buf.append(allocator, ',');
        try appendString(buf, allocator, value);
    }
    try buf.append(allocator, ']');
}

/// Return a typed shortlist. `learned_json` is the verified ledger route, if
/// one exists. `availability_json` is caller-supplied local evidence; an
/// explicit `"application_runtime":false` inhibits every application cell.
pub fn recommendJson(
    allocator: std.mem.Allocator,
    context: []const u8,
    learned_json: ?[]const u8,
    availability_json: []const u8,
    limit: usize,
) ![]u8 {
    const runtime_available = !containsFold(availability_json, "\"application_runtime\":false");
    const learned_id = if (learned_json) |json| jsonStringField(json, "binary") else null;
    const learned_score = if (learned_json) |json| jsonFloatField(json, "score") else null;
    const learned_freshness = if (learned_json) |json| jsonStringField(json, "freshness") else null;

    var ranked: std.ArrayList(Ranked) = .empty;
    defer ranked.deinit(allocator);
    for (CELLS) |cell| {
        var score = priorScore(cell, context);
        var status: []const u8 = "available_unverified";
        if (learned_id) |id| {
            if (std.mem.eql(u8, id, cell.id)) {
                score = @max(score, learned_score orelse 0.75);
                status = if (learned_freshness) |freshness|
                    if (std.mem.eql(u8, freshness, "stale")) "verified_stale" else "verified_fresh"
                else
                    "verified_stale";
            }
        }
        if (!runtime_available) {
            score = -1;
            status = "unavailable";
        }
        try ranked.append(allocator, .{ .cell = cell, .score = score, .status = status });
    }
    std.mem.sort(Ranked, ranked.items, {}, struct {
        fn lessThan(_: void, a: Ranked, b: Ranked) bool {
            return a.score > b.score;
        }
    }.lessThan);

    const count = @min(limit, ranked.items.len);
    const best = if (count > 0) ranked.items[0].score else -1;
    const second = if (count > 1) ranked.items[1].score else -1;
    const margin = best - second;
    const automatic = count > 0 and
        std.mem.eql(u8, ranked.items[0].status, "verified_fresh") and
        best >= 0.78 and margin >= 0.08;

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.appendSlice(allocator, "{\"version\":1,\"automatic\":");
    try out.appendSlice(allocator, if (automatic) "true" else "false");
    try out.appendSlice(allocator, ",\"confidence\":");
    var number: [32]u8 = undefined;
    try out.appendSlice(allocator, try std.fmt.bufPrint(&number, "{d:.3}", .{best}));
    try out.appendSlice(allocator, ",\"margin\":");
    try out.appendSlice(allocator, try std.fmt.bufPrint(&number, "{d:.3}", .{margin}));
    try out.appendSlice(allocator, ",\"cells\":[");
    for (ranked.items[0..count], 0..) |item, i| {
        if (i > 0) try out.append(allocator, ',');
        try out.appendSlice(allocator, "{\"id\":");
        try appendString(&out, allocator, item.cell.id);
        try out.appendSlice(allocator, ",\"tool\":");
        try appendString(&out, allocator, item.cell.tool);
        try out.appendSlice(allocator, ",\"action\":");
        try appendString(&out, allocator, item.cell.action);
        try out.appendSlice(allocator, ",\"description\":");
        try appendString(&out, allocator, item.cell.description);
        try out.appendSlice(allocator, ",\"status\":");
        try appendString(&out, allocator, item.status);
        try out.appendSlice(allocator, ",\"score\":");
        try out.appendSlice(allocator, try std.fmt.bufPrint(&number, "{d:.3}", .{item.score}));
        try out.appendSlice(allocator, ",\"read_only\":");
        try out.appendSlice(allocator, if (item.cell.read_only) "true" else "false");
        try out.appendSlice(allocator, ",\"permission\":");
        try appendString(&out, allocator, item.cell.permission);
        try out.appendSlice(allocator, ",\"requires\":");
        try appendStrings(&out, allocator, item.cell.requires);
        try out.appendSlice(allocator, ",\"sequence\":");
        try appendStrings(&out, allocator, item.cell.sequence);
        try out.append(allocator, '}');
    }
    try out.appendSlice(allocator, "]}");
    return out.toOwnedSlice(allocator);
}

test "cold click prior exposes attach snapshot click without claiming verification" {
    const a = std.testing.allocator;
    const json = try recommendJson(a, "click the login button in Electron", null, "{}", 3);
    defer a.free(json);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"id\":\"application.click\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"status\":\"available_unverified\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"sequence\":[\"application.attach\",\"application.snapshot\",\"application.click\"]") != null);
}

test "verified learned cell is labeled separately from cold priors" {
    const a = std.testing.allocator;
    const learned = "{\"binary\":\"application.snapshot\",\"example\":\"x\",\"score\":0.91,\"freshness\":\"fresh\"}";
    const json = try recommendJson(a, "inspect the Electron screen", learned, "{}", 3);
    defer a.free(json);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"status\":\"verified_fresh\"") != null);
}

test "old ledger evidence is explicitly stale and never automatic" {
    const a = std.testing.allocator;
    const learned = "{\"binary\":\"application.click\",\"example\":\"x\",\"score\":0.94,\"freshness\":\"stale\"}";
    const json = try recommendJson(a, "click the button", learned, "{}", 1);
    defer a.free(json);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"status\":\"verified_stale\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"automatic\":false") != null);
}

test "availability inhibits application cells" {
    const a = std.testing.allocator;
    const json = try recommendJson(a, "click login", null, "{\"application_runtime\":false}", 1);
    defer a.free(json);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"status\":\"unavailable\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"automatic\":false") != null);
}

test "typed cold routing intent corpus exceeds ninety percent top-one precision" {
    const a = std.testing.allocator;
    const cases = [_]struct { intent: []const u8, expected: []const u8 }{
        .{ .intent = "attach to the running Electron app", .expected = "application.attach" },
        .{ .intent = "snapshot the current view", .expected = "application.snapshot" },
        .{ .intent = "read the text label", .expected = "application.text" },
        .{ .intent = "inspect network requests", .expected = "application.requests" },
        .{ .intent = "get request detail for this id", .expected = "application.request_detail" },
        .{ .intent = "retrieve the response body", .expected = "application.response_body" },
        .{ .intent = "click the login button", .expected = "application.click" },
        .{ .intent = "fill the email form field", .expected = "application.fill" },
        .{ .intent = "type into the focused input", .expected = "application.type" },
        .{ .intent = "navigate to the dashboard url", .expected = "application.navigate" },
        .{ .intent = "invoke an Electron preload renderer api", .expected = "application.evaluate" },
    };
    var correct: usize = 0;
    for (cases) |case| {
        const json = try recommendJson(a, case.intent, null, "{}", 1);
        defer a.free(json);
        const top = jsonStringField(json, "id") orelse "";
        if (std.mem.eql(u8, top, case.expected)) {
            correct += 1;
        } else {
            std.debug.print("route miss: \"{s}\" expected {s}, got {s}\n", .{
                case.intent,
                case.expected,
                top,
            });
        }
    }
    // The no-route control has zero typed top-one decisions; the routed arm
    // must correctly ground at least 91% of this intent corpus.
    try std.testing.expect(correct * 100 >= cases.len * 91);
}

test "capability ABI has unique ids and permission-consistent cells" {
    var ids = std.StringHashMap(void).init(std.testing.allocator);
    defer ids.deinit();
    for (CELLS) |cell| {
        try std.testing.expect(!ids.contains(cell.id));
        try ids.put(cell.id, {});
        try std.testing.expect(std.mem.startsWith(u8, cell.id, "application."));
        try std.testing.expect(std.mem.eql(
            u8,
            cell.permission,
            if (cell.read_only) "read" else "write",
        ));
        try std.testing.expect(cell.sequence.len > 0);
        try std.testing.expectEqualStrings(cell.id, cell.sequence[cell.sequence.len - 1]);
    }
    try std.testing.expectEqual(@as(usize, 35), CELLS.len);
}
