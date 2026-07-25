//! c_abi.zig — extern "C" wrappers exposing the Stage 1 verbs so non-Zig
//! callers (bash via libffi, future Python/Node bindings) can link
//! libcontract.a directly.
//!
//! Strings returned to C are NUL-terminated and must be released with
//! `contract_free`. All operations are synchronous and run on the libc
//! allocator (no caller-owned arena required).
const std = @import("std");
const contract = @import("contract.zig");
const route = @import("route.zig");
const gate = @import("gate.zig");
const fractal = @import("fractal.zig");
const capability_cells = @import("capability_cells.zig");
const capability_registry = @import("capability_registry.zig");
const collective_object = @import("collective_object.zig");
const collective_rank = @import("collective_rank.zig");
const collective_checkpoint = @import("collective_checkpoint.zig");
const collective_admission = @import("collective_admission.zig");
const collective_state = @import("collective_state.zig");
const agency = @import("agency.zig");
const muscle = @import("muscle.zig");
const ledger = @import("ledger.zig");
const reflex = @import("reflex.zig");
const workflow = @import("workflow.zig");

const gpa = std.heap.c_allocator;
pub const ABI_VERSION: u32 = 6;
extern fn time(timer: ?*i64) i64;

var registry_mutex: std.atomic.Mutex = .unlocked;
var registry_state: ?capability_registry.Registry = null;
var muscle_mutex: std.atomic.Mutex = .unlocked;
var muscle_state: muscle.Bank = .{};
var muscle_loaded = false;

fn ensureMuscleLoaded() void {
    if (muscle_loaded) return;
    muscle_loaded = true;
    const rows = ledger.readAll(gpa, extEnv()) catch return;
    defer gpa.free(rows);
    var lines = std.mem.splitScalar(u8, rows, '\n');
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        if (std.mem.indexOf(u8, line, "\"event\":\"muscle_observed\"") != null) {
            muscle_state.replayObservation(line) catch {};
        } else if (std.mem.indexOf(u8, line, "\"event\":\"muscle_deleted\"") != null) {
            var parsed = std.json.parseFromSlice(std.json.Value, gpa, line, .{}) catch continue;
            defer parsed.deinit();
            if (parsed.value != .object) continue;
            if (objectString(parsed.value.object, "binary")) |binary| _ = muscle_state.delete(binary);
        }
    }
}

fn lockRegistry() void {
    while (!registry_mutex.tryLock()) std.atomic.spinLoopHint();
}

fn registry() *capability_registry.Registry {
    if (registry_state == null) {
        var initialized = capability_registry.Registry.init(gpa);
        if (capability_cells.descriptorsJson(gpa)) |descriptors| {
            defer gpa.free(descriptors);
            _ = initialized.replaceSource("aiko_builtin", descriptors) catch {};
        } else |_| {}
        registry_state = initialized;
    }
    return &registry_state.?;
}

/// Stable compatibility handshake for independently-built Aiko runtimes.
export fn contract_abi_version() u32 {
    return ABI_VERSION;
}

/// Train binary muscle memory from a real sanitized invocation. Reward must
/// come from the caller's external evaluator; visual/activity change alone is
/// not success. The in-process JEPA weights update immediately, while the
/// existing capability-outcome ledger remains the durable context->binary memory.
export fn contract_muscle_observe(
    context: [*:0]const u8,
    binary: [*:0]const u8,
    before: [*:0]const u8,
    after: [*:0]const u8,
    reward: f64,
) bool {
    while (!muscle_mutex.tryLock()) std.atomic.spinLoopHint();
    defer muscle_mutex.unlock();
    ensureMuscleLoaded();
    const invocation: muscle.Invocation = .{
        .context = cstr(context),
        .binary = cstr(binary),
        .before = cstr(before),
        .after = cstr(after),
        .reward = reward,
    };
    const encoded = muscle.Bank.encodeObservation(gpa, invocation) catch return false;
    defer gpa.free(encoded);
    const ledger_path = ledger.appendRow(gpa, extEnv(), encoded) catch return false;
    gpa.free(ledger_path);
    muscle_state.observe(invocation) catch return false;
    return true;
}

/// Recall the binary whose grounded usage contexts best match this intent.
export fn contract_muscle_recall(context: [*:0]const u8) ?[*:0]u8 {
    while (!muscle_mutex.tryLock()) std.atomic.spinLoopHint();
    defer muscle_mutex.unlock();
    ensureMuscleLoaded();
    return returned(muscle_state.recall(cstr(context)) orelse return null);
}

/// JEPA plan toward a target machine-state descriptor using learned deltas.
export fn contract_muscle_predict(before: [*:0]const u8, target: [*:0]const u8) ?[*:0]u8 {
    while (!muscle_mutex.tryLock()) std.atomic.spinLoopHint();
    defer muscle_mutex.unlock();
    ensureMuscleLoaded();
    return returned(muscle_state.predict(cstr(before), cstr(target)) orelse return null);
}

/// Return an inspectable, energy-ordered candidate set. `before` and `target`
/// may be null for context-only ranking. Evidence readiness is not authority:
/// hosts must still pass the native action gate before firing anything.
export fn contract_muscle_rank_json(
    context: [*:0]const u8,
    before: ?[*:0]const u8,
    target: ?[*:0]const u8,
    limit_raw: u32,
) ?[*:0]u8 {
    while (!muscle_mutex.tryLock()) std.atomic.spinLoopHint();
    defer muscle_mutex.unlock();
    ensureMuscleLoaded();
    var ranked: [muscle.MAX_BINARIES]muscle.Bank.Candidate = undefined;
    const count = muscle_state.rank(
        cstr(context),
        if (before) |value| cstr(value) else null,
        if (target) |value| cstr(value) else null,
        &ranked,
    );
    const limit = @min(count, if (limit_raw == 0) @as(usize, 8) else @as(usize, @intCast(@min(limit_raw, muscle.MAX_BINARIES))));
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    out.print(gpa, "{{\"abi_version\":{d},\"count\":{d},\"candidates\":[", .{ ABI_VERSION, count }) catch return null;
    for (ranked[0..limit], 0..) |candidate, index| {
        if (index > 0) out.append(gpa, ',') catch return null;
        out.appendSlice(gpa, "{\"binary\":") catch return null;
        appendJsonString(&out, candidate.binary) catch return null;
        out.print(
            gpa,
            ",\"energy\":{d},\"context_energy\":{d},\"transition_energy\":",
            .{ candidate.energy, candidate.context_energy },
        ) catch return null;
        if (candidate.transition_energy) |energy| out.print(gpa, "{d}", .{energy}) catch return null else out.appendSlice(gpa, "null") catch return null;
        out.print(
            gpa,
            ",\"fires\":{d},\"successes\":{d},\"failures\":{d},\"confidence\":{d},\"evidence_ready\":{s}}}",
            .{ candidate.fires, candidate.successes, candidate.failures, candidate.confidence, if (candidate.successes >= 3 and candidate.failures == 0 and candidate.confidence >= 0.9) "true" else "false" },
        ) catch return null;
    }
    out.appendSlice(gpa, "]}") catch return null;
    return returned(out.items);
}

/// Native fixed-cell proposer receptor — the substrate-native policy + settlement.
/// The LLM I/O (the "execute" step) stays in the host transport; this primitive
/// owns the tamper-resistant half: authorize -> sense -> settle. It is GENERIC
/// (provider aiko-proposer, never aiko-arc); ARC and any task consume it, and
/// the core stays provider-neutral. Composes no new state — pure policy + parse.
///
/// Request JSON: {domain, context, authority:bool, transport, model, raw,
///   capability_id, provider, candidate_schema:{required:[...]}}
/// Settlement envelope (NUL-terminated; free with contract_free):
///   {domain,context,model,capability,provider,transport, settled, held, valid,
///    parsed:object|null, raw, reason?}
///   - authority false            -> settled=false, held=true (paid-effect gate)
///   - authority true, raw empty  -> settled=false, held=false (prepared/awaiting transport)
///   - authority true, raw set    -> sense (last JSON object + schema.required) -> settle
export fn contract_propose_settle(request_json: [*:0]const u8) ?[*:0]u8 {
    const req = cstr(request_json);
    var parsed = std.json.parseFromSlice(std.json.Value, gpa, req, .{}) catch return null;
    defer parsed.deinit();
    const obj = switch (parsed.value) {
        .object => |o| o,
        else => return null,
    };

    const domain = objectString(obj, "domain") orelse "";
    const context = objectString(obj, "context") orelse "";
    const transport = objectString(obj, "transport") orelse "";
    const model = objectString(obj, "model") orelse "";
    const raw = objectString(obj, "raw") orelse "";
    const cap_id = objectString(obj, "capability_id") orelse "aiko-proposer.propose";
    const provider = objectString(obj, "provider") orelse "aiko-proposer";
    const authority = switch (obj.get("authority") orelse .null) {
        .bool => |b| b,
        else => false,
    };

    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    out.print(gpa, "{{\"domain\":", .{}) catch return null;
    appendJsonString(&out, domain) catch return null;
    out.appendSlice(gpa, ",\"context\":") catch return null;
    appendJsonString(&out, context) catch return null;
    out.appendSlice(gpa, ",\"model\":") catch return null;
    appendJsonString(&out, model) catch return null;
    out.appendSlice(gpa, ",\"capability\":") catch return null;
    appendJsonString(&out, cap_id) catch return null;
    out.appendSlice(gpa, ",\"provider\":") catch return null;
    appendJsonString(&out, provider) catch return null;
    out.appendSlice(gpa, ",\"transport\":") catch return null;
    appendJsonString(&out, transport) catch return null;

    // authorize (substrate-native, fail-closed): a paid LLM effect needs authority.
    if (!authority) {
        out.appendSlice(gpa, ",\"settled\":false,\"held\":true,\"valid\":false,\"parsed\":null,\"raw\":") catch return null;
        appendJsonString(&out, raw) catch return null;
        out.appendSlice(gpa, ",\"reason\":\"authority required for paid LLM effect\"}") catch return null;
        return returned(out.items);
    }

    // authorized but transport not yet run: prepared, not held, not settled.
    if (raw.len == 0) {
        out.appendSlice(gpa, ",\"settled\":false,\"held\":false,\"valid\":false,\"parsed\":null,\"raw\":\"\",\"reason\":\"awaiting transport\"}") catch return null;
        return returned(out.items);
    }

    // sense: parse the last {...} in raw; validate candidate_schema.required keys.
    var valid = false;
    var parsed_obj_json: ?[]const u8 = null;
    defer if (parsed_obj_json) |p| gpa.free(p);
    if (std.mem.lastIndexOfScalar(u8, raw, '{')) |start| {
        if (std.mem.lastIndexOfScalar(u8, raw, '}')) |end| {
            if (end >= start) {
                const slice = raw[start .. end + 1];
                if (std.json.parseFromSlice(std.json.Value, gpa, slice, .{})) |inner| {
                    defer inner.deinit();
                    switch (inner.value) {
                        .object => |inner_obj| {
                            var ok = true;
                            if (obj.get("candidate_schema")) |schema_v| switch (schema_v) {
                                .object => |schema_obj| if (schema_obj.get("required")) |req_v| switch (req_v) {
                                    .array => |arr| for (arr.items) |key_v| {
                                        const key_name: ?[]const u8 = switch (key_v) {
                                            .string => |s| s,
                                            else => null,
                                        };
                                        if (key_name) |kn| {
                                            if (inner_obj.get(kn) == null) {
                                                ok = false;
                                                break;
                                            }
                                        }
                                    },
                                    else => {},
                                },
                                else => {},
                            };
                            if (ok) {
                                valid = true;
                                var aw: std.Io.Writer.Allocating = .init(gpa);
                                defer aw.deinit();
                                var st = std.json.Stringify{ .writer = &aw.writer };
                                st.write(inner.value) catch return null;
                                parsed_obj_json = gpa.dupe(u8, aw.writer.buffered()) catch return null;
                            }
                        },
                        else => {},
                    }
                } else |_| {}
            }
        }
    }

    // settle
    out.print(gpa, ",\"settled\":{s},\"held\":{s},\"valid\":{s},\"parsed\":", .{
        if (valid) "true" else "false",
        if (valid) "false" else "true",
        if (valid) "true" else "false",
    }) catch return null;
    if (parsed_obj_json) |p| {
        out.appendSlice(gpa, p) catch return null;
    } else {
        out.appendSlice(gpa, "null") catch return null;
    }
    out.appendSlice(gpa, ",\"raw\":") catch return null;
    appendJsonString(&out, raw) catch return null;
    out.appendSlice(gpa, "}") catch return null;
    return returned(out.items);
}

/// Erase one learned cell and append a durable tombstone so deterministic
/// replay cannot resurrect observations that precede the deletion.
export fn contract_muscle_delete(binary: [*:0]const u8) bool {
    const name = cstr(binary);
    if (name.len == 0 or name.len > 128) return false;
    while (!muscle_mutex.tryLock()) std.atomic.spinLoopHint();
    defer muscle_mutex.unlock();
    ensureMuscleLoaded();
    var row: std.ArrayList(u8) = .empty;
    defer row.deinit(gpa);
    row.appendSlice(gpa, "{\"event\":\"muscle_deleted\",\"binary\":") catch return false;
    appendJsonString(&row, name) catch return false;
    row.append(gpa, '}') catch return false;
    const path = ledger.appendRow(gpa, extEnv(), row.items) catch return false;
    gpa.free(path);
    _ = muscle_state.delete(name);
    return true;
}

/// Mechanical fire/prepare/hold decision for a learned reflex. The host passes
/// persisted operator policy and grounded evidence; no model text is trusted.
export fn contract_reflex_decide_json(request_json: [*:0]const u8) ?[*:0]u8 {
    var parsed = std.json.parseFromSlice(std.json.Value, gpa, cstr(request_json), .{}) catch return null;
    defer parsed.deinit();
    if (parsed.value != .object) return null;
    const object = parsed.value.object;
    const successes_raw = objectInt(object, "successes") orelse 0;
    const failures_raw = objectInt(object, "failures") orelse 0;
    if (successes_raw < 0 or failures_raw < 0) return null;
    const verdict = reflex.decide(.{
        .enabled = objectBool(object, "enabled") orelse true,
        .capability_enabled = objectBool(object, "capability_enabled") orelse false,
        .successes = @intCast(@min(successes_raw, std.math.maxInt(u32))),
        .failures = @intCast(@min(failures_raw, std.math.maxInt(u32))),
        .confidence = objectFloat(object, "confidence") orelse 0,
        .effect_scope = objectString(object, "effect_scope") orelse "unknown",
        .authority = objectBool(object, "authority") orelse false,
        .reversible = objectBool(object, "reversible") orelse false,
        .read_only = objectBool(object, "read_only") orelse false,
        .estimated_cost = objectFloat(object, "estimated_cost") orelse 0,
        .max_cost = objectFloat(object, "max_cost") orelse 0,
    });
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    out.print(gpa, "{{\"abi_version\":{d},\"decision\":\"{s}\",\"reason\":", .{ ABI_VERSION, @tagName(verdict.decision) }) catch return null;
    appendJsonString(&out, verdict.reason) catch return null;
    out.append(gpa, '}') catch return null;
    return returned(out.items);
}

/// Materialize one event/reasoning pointer as a native contract DAG and return
/// dependency-safe waves for isolated Aiko/subagent workers. Authorization is
/// represented as a hold on effect children; it never prevents observation,
/// identity, logging, or rule siblings from being declared and scheduled.
///
/// Request: {plan, action?, cwd?, agent?, children:[
///   {key, plan, action?, depends_on?:[key], requires_authorization?:bool,
///    authorization?:"approved"|"pending_authorization"|"denied"}
/// ]}
fn expandGraphJson(request_json: [*:0]const u8) !?[*:0]u8 {
    var parsed = std.json.parseFromSlice(std.json.Value, gpa, cstr(request_json), .{}) catch return null;
    defer parsed.deinit();
    const root_object = switch (parsed.value) {
        .object => |object| object,
        else => return null,
    };
    const plan = objectString(root_object, "plan") orelse return null;
    const action = objectString(root_object, "action") orelse "event";
    const cwd = objectString(root_object, "cwd");
    const agent = objectString(root_object, "agent") orelse "aiko-contract-worker";
    const existing_root_id = objectString(root_object, "root_id");
    if (existing_root_id) |id| if (!validContractId(id)) return null;
    const child_values = switch (root_object.get("children") orelse return null) {
        .array => |array| array.items,
        else => return null,
    };
    if (child_values.len == 0 or child_values.len > muscle.MAX_PARALLEL) return null;

    const owned_root_id = if (existing_root_id == null)
        contract.declare(gpa, extEnv(), plan, action, .{
            .agent = agent,
            .cwd = cwd,
            .extras = &.{.{ .key = "execution_model", .value = "parallel_contract_dag" }},
        }) catch return null
    else
        null;
    defer if (owned_root_id) |id| gpa.free(id);
    const root_id = existing_root_id orelse owned_root_id.?;

    var keys: [muscle.MAX_PARALLEL][]const u8 = undefined;
    var plans: [muscle.MAX_PARALLEL][]const u8 = undefined;
    var actions: [muscle.MAX_PARALLEL][]const u8 = undefined;
    var held = [_]bool{false} ** muscle.MAX_PARALLEL;
    var dependency_names: [muscle.MAX_PARALLEL][]const std.json.Value = undefined;
    for (child_values, 0..) |child_value, index| {
        const child = switch (child_value) {
            .object => |object| object,
            else => return null,
        };
        keys[index] = objectString(child, "key") orelse return null;
        plans[index] = objectString(child, "plan") orelse return null;
        actions[index] = objectString(child, "action") orelse "neuron";
        dependency_names[index] = if (child.get("depends_on")) |dependency_value|
            switch (dependency_value) {
                .array => |array| array.items,
                else => return null,
            }
        else
            &.{};
        const requires_authorization = if (child.get("requires_authorization")) |authorization_value|
            switch (authorization_value) {
                .bool => |value| value,
                else => return null,
            }
        else
            false;
        const authorization = objectString(child, "authorization") orelse "pending_authorization";
        held[index] = requires_authorization and !std.mem.eql(u8, authorization, "approved");
    }

    var ids: [muscle.MAX_PARALLEL]?[]u8 = [_]?[]u8{null} ** muscle.MAX_PARALLEL;
    defer for (ids[0..child_values.len]) |maybe_id| if (maybe_id) |id| gpa.free(id);
    var dependencies = [_][muscle.MAX_PARALLEL]usize{[_]usize{0} ** muscle.MAX_PARALLEL} ** muscle.MAX_PARALLEL;
    var dependency_counts = [_]usize{0} ** muscle.MAX_PARALLEL;
    var nodes: [muscle.MAX_PARALLEL + 1]muscle.Node = undefined;
    var root_children: [muscle.MAX_PARALLEL]usize = undefined;
    nodes[0] = .{ .id = root_id, .children = root_children[0..child_values.len] };

    for (child_values, 0..) |child_value, index| {
        const child = child_value.object;
        for (dependency_names[index]) |dependency_value| {
            const dependency_key = switch (dependency_value) {
                .string => |value| value,
                else => return null,
            };
            var found: ?usize = null;
            for (keys[0..child_values.len], 0..) |key, candidate| {
                if (std.mem.eql(u8, key, dependency_key)) {
                    found = candidate + 1;
                    break;
                }
            }
            dependencies[index][dependency_counts[index]] = found orelse return null;
            dependency_counts[index] += 1;
        }
        var dependency_json: std.ArrayList(u8) = .empty;
        defer dependency_json.deinit(gpa);
        try dependency_json.append(gpa, '[');
        for (dependency_names[index], 0..) |dependency_value, dep_index| {
            if (dep_index > 0) try dependency_json.append(gpa, ',');
            try appendJsonString(&dependency_json, dependency_value.string);
        }
        try dependency_json.append(gpa, ']');
        const authorization = objectString(child, "authorization") orelse "pending_authorization";
        const fields = [_]contract.Field{
            .{ .key = "graph_key", .value = keys[index] },
            .{ .key = "depends_on", .value = dependency_json.items },
            .{ .key = "authorization", .value = authorization },
            .{ .key = "execution_model", .value = "isolated_aiko_worker" },
        };
        ids[index] = contract.declare(gpa, extEnv(), plans[index], actions[index], .{
            .parent_id = root_id,
            .agent = agent,
            .cwd = cwd,
            .extras = &fields,
        }) catch return null;
        root_children[index] = index + 1;
        nodes[index + 1] = .{
            .id = ids[index].?,
            .depends_on = dependencies[index][0..dependency_counts[index]],
        };
    }

    const scheduled = muscle.schedule(nodes[0 .. child_values.len + 1], 0) catch return null;
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    try out.print(gpa, "{{\"abi_version\":{d},\"root_id\":", .{ABI_VERSION});
    try appendJsonString(&out, root_id);
    try out.appendSlice(gpa, ",\"children\":[");
    for (0..child_values.len) |index| {
        if (index > 0) try out.append(gpa, ',');
        try out.appendSlice(gpa, "{\"key\":");
        try appendJsonString(&out, keys[index]);
        try out.appendSlice(gpa, ",\"id\":");
        try appendJsonString(&out, ids[index].?);
        try out.print(gpa, ",\"held\":{s}}}", .{if (held[index]) "true" else "false"});
    }
    try out.appendSlice(gpa, "],\"waves\":[");
    var wrote_wave = false;
    for (0..scheduled.wave_count) |wave_index| {
        var runnable_count: usize = 0;
        for (scheduled.waves[wave_index][0..scheduled.counts[wave_index]]) |node_index| {
            if (node_index > 0 and !held[node_index - 1]) runnable_count += 1;
        }
        if (runnable_count == 0) continue;
        if (wrote_wave) try out.append(gpa, ',');
        wrote_wave = true;
        try out.append(gpa, '[');
        var wrote_child = false;
        for (scheduled.waves[wave_index][0..scheduled.counts[wave_index]]) |node_index| {
            if (node_index == 0 or held[node_index - 1]) continue;
            if (wrote_child) try out.append(gpa, ',');
            wrote_child = true;
            try appendJsonString(&out, ids[node_index - 1].?);
        }
        try out.append(gpa, ']');
    }
    try out.appendSlice(gpa, "]}");
    return returned(out.items);
}

export fn contract_expand_json(request_json: [*:0]const u8) ?[*:0]u8 {
    return expandGraphJson(request_json) catch null;
}

// On POSIX with libc, `environ` is the global env-var array. Wrap it as a
// std.process.Environ.PosixBlock so contract.zig's existing API (which takes
// a std.process.Environ) works from non-Zig callers.
extern var environ: [*:null]const ?[*:0]const u8;

fn extEnv() std.process.Environ {
    if (@import("builtin").os.tag == .windows) {
        return .{ .block = .global };
    }
    var count: usize = 0;
    while (environ[count] != null) : (count += 1) {}
    // PosixBlock.slice is [:null]const ?[*:0]const u8 — a sentinel-terminated
    // slice. Cast the libc-provided pointer + length into that shape.
    const ptr: [*:null]const ?[*:0]const u8 = @ptrCast(environ);
    const slice: [:null]const ?[*:0]const u8 = ptr[0..count :null];
    return .{ .block = .{ .slice = slice } };
}

fn cstr(p: [*:0]const u8) []const u8 {
    return std.mem.span(p);
}

fn returned(value: []const u8) ?[*:0]u8 {
    const out = gpa.allocSentinel(u8, value.len, 0) catch return null;
    @memcpy(out, value);
    return out.ptr;
}

fn appendJsonString(out: *std.ArrayList(u8), value: []const u8) !void {
    try out.append(gpa, '"');
    for (value) |ch| switch (ch) {
        '"' => try out.appendSlice(gpa, "\\\""),
        '\\' => try out.appendSlice(gpa, "\\\\"),
        '\n' => try out.appendSlice(gpa, "\\n"),
        '\r' => try out.appendSlice(gpa, "\\r"),
        '\t' => try out.appendSlice(gpa, "\\t"),
        else => if (ch >= 0x20) try out.append(gpa, ch),
    };
    try out.append(gpa, '"');
}

fn objectString(object: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const value = object.get(key) orelse return null;
    return switch (value) {
        .string => |string| string,
        else => null,
    };
}

fn objectInt(object: std.json.ObjectMap, key: []const u8) ?i64 {
    const value = object.get(key) orelse return null;
    return switch (value) {
        .integer => |integer| integer,
        else => null,
    };
}

fn objectBool(object: std.json.ObjectMap, key: []const u8) ?bool {
    const value = object.get(key) orelse return null;
    return switch (value) {
        .bool => |boolean| boolean,
        else => null,
    };
}

fn objectFloat(object: std.json.ObjectMap, key: []const u8) ?f64 {
    const value = object.get(key) orelse return null;
    return switch (value) {
        .float => |number| number,
        .integer => |number| @floatFromInt(number),
        else => null,
    };
}

fn jsonStringField(json: []const u8, key: []const u8) ?[]const u8 {
    var needle_buf: [96]u8 = undefined;
    const needle = std.fmt.bufPrint(&needle_buf, "\"{s}\":\"", .{key}) catch return null;
    const start = std.mem.indexOf(u8, json, needle) orelse return null;
    const value_start = start + needle.len;
    var i = value_start;
    while (i < json.len) : (i += 1) {
        if (json[i] == '\\') {
            i += 1;
            continue;
        }
        if (json[i] == '"') return json[value_start..i];
    }
    return null;
}

/// Return a string field's unquoted body or any other JSON value's raw slice.
/// Outcome metadata is stored as privacy-scrubbed string extras, but numeric
/// durations and structured result schemas must not disappear at the ABI.
fn jsonValueField(json: []const u8, key: []const u8) ?[]const u8 {
    if (jsonStringField(json, key)) |value| return value;
    var needle_buf: [96]u8 = undefined;
    const needle = std.fmt.bufPrint(&needle_buf, "\"{s}\"", .{key}) catch return null;
    const key_start = std.mem.indexOf(u8, json, needle) orelse return null;
    var start = key_start + needle.len;
    while (start < json.len and (json[start] == ' ' or json[start] == ':')) : (start += 1) {}
    if (start >= json.len) return null;
    if (json[start] == '{' or json[start] == '[') {
        const open = json[start];
        const close: u8 = if (open == '{') '}' else ']';
        var depth: usize = 0;
        var in_string = false;
        var escaped = false;
        var i = start;
        while (i < json.len) : (i += 1) {
            const c = json[i];
            if (in_string) {
                if (escaped) {
                    escaped = false;
                } else if (c == '\\') {
                    escaped = true;
                } else if (c == '"') {
                    in_string = false;
                }
                continue;
            }
            if (c == '"') {
                in_string = true;
            } else if (c == open) {
                depth += 1;
            } else if (c == close) {
                depth -= 1;
                if (depth == 0) return json[start .. i + 1];
            }
        }
        return null;
    }
    var end = start;
    while (end < json.len and json[end] != ',' and json[end] != '}') : (end += 1) {}
    return std.mem.trim(u8, json[start..end], " \t\r\n");
}

/// Declare a contract via the C ABI.
/// plan, action — required C strings.
/// parent_id, agent — may be NULL.
/// Returns a malloc'd C string (the 8-hex id), NULL on failure.
/// Caller MUST call contract_free on the returned pointer.
export fn contract_declare(
    plan: [*:0]const u8,
    action: [*:0]const u8,
    parent_id: ?[*:0]const u8,
    agent: ?[*:0]const u8,
) ?[*:0]u8 {
    const opts = contract.DeclareOptions{
        .parent_id = if (parent_id) |p| cstr(p) else null,
        .agent = if (agent) |a| cstr(a) else null,
        .cwd = null,
    };
    const id = contract.declare(gpa, extEnv(), cstr(plan), cstr(action), opts) catch return null;
    defer gpa.free(id);
    const out = gpa.allocSentinel(u8, id.len, 0) catch return null;
    @memcpy(out, id);
    return out.ptr;
}

/// Additive agency-aware declaration. Existing ABI v2 callers continue to use
/// `contract_declare`; new callers pass one canonical agency envelope. The
/// JSON tree remains alive for the duration of declare().
export fn contract_declare_agency(
    plan: [*:0]const u8,
    action: [*:0]const u8,
    parent_id: ?[*:0]const u8,
    agent: ?[*:0]const u8,
    agency_json: [*:0]const u8,
) ?[*:0]u8 {
    var parsed = agency.decodeEnvelope(gpa, cstr(agency_json)) catch return null;
    defer parsed.deinit();
    const opts = contract.DeclareOptions{
        .parent_id = if (parent_id) |p| cstr(p) else null,
        .agent = if (agent) |a| cstr(a) else null,
        .cwd = null,
        .agency_envelope = parsed.value,
    };
    const id = contract.declare(gpa, extEnv(), cstr(plan), cstr(action), opts) catch return null;
    defer gpa.free(id);
    const out = gpa.allocSentinel(u8, id.len, 0) catch return null;
    @memcpy(out, id);
    return out.ptr;
}

/// Pure validation surface for clients that need to fail before touching the
/// ledger or signing path. Returns 1 for a supported valid envelope, else 0.
export fn contract_agency_validate(agency_json: [*:0]const u8) u8 {
    var parsed = agency.decodeEnvelope(gpa, cstr(agency_json)) catch return 0;
    defer parsed.deinit();
    return 1;
}

/// Compile a multiscale action → sensor → evaluator system into the strict
/// Contract skill manifest ABI. Null means the specification failed closed.
export fn contract_compile_internal_system_json(spec_json: [*:0]const u8) ?[*:0]u8 {
    const compiled = workflow.compileInternalSystem(gpa, cstr(spec_json)) catch return null;
    defer gpa.free(compiled);
    return returned(compiled);
}

/// Validate that observed settlement evidence contains every antiparticle
/// derived from its effect class. Returns zero only for a complete collision.
export fn contract_validate_effect_evidence_json(evidence_json: [*:0]const u8) u8 {
    workflow.validateEffectEvidenceJson(gpa, cstr(evidence_json)) catch return 1;
    return 0;
}

/// Aiko turn declaration with an explicit workspace context, entirely
/// in-process. Returns the canonical eight-hex id.
export fn contract_declare_turn(
    plan: [*:0]const u8,
    cwd: ?[*:0]const u8,
) ?[*:0]u8 {
    const opts = contract.DeclareOptions{
        .parent_id = null,
        .agent = "aiko-native",
        .cwd = if (cwd) |p| cstr(p) else null,
    };
    const id = contract.declare(gpa, extEnv(), cstr(plan), "neuron", opts) catch return null;
    defer gpa.free(id);
    return returned(id);
}

fn validContractId(id: []const u8) bool {
    if (id.len != 8) return false;
    for (id) |byte| if (!std.ascii.isHex(byte)) return false;
    return true;
}

/// Declare the canonical contract for a root or stateless descendant worker.
/// The context envelope is deliberately bounded and inherited by the host:
/// {plan,cwd?,parent_id?,root_id?,depth?,max_depth?,max_children?,
///  max_total_children?,max_concurrency?}. A descendant without a valid parent
/// is rejected instead of silently producing a disconnected root.
export fn contract_declare_turn_context_json(request_json: [*:0]const u8) ?[*:0]u8 {
    var parsed = std.json.parseFromSlice(std.json.Value, gpa, cstr(request_json), .{}) catch return null;
    defer parsed.deinit();
    if (parsed.value != .object) return null;
    const object = parsed.value.object;
    const plan = objectString(object, "plan") orelse return null;
    const cwd = objectString(object, "cwd");
    const parent_id = objectString(object, "parent_id");
    const supplied_root = objectString(object, "root_id");
    const depth_raw = objectInt(object, "depth") orelse 0;
    const max_depth_raw = objectInt(object, "max_depth") orelse 4;
    const max_children_raw = objectInt(object, "max_children") orelse 16;
    const max_total_raw = objectInt(object, "max_total_children") orelse 64;
    const max_concurrency_raw = objectInt(object, "max_concurrency") orelse 4;
    if (depth_raw < 0 or max_depth_raw < 0 or depth_raw > max_depth_raw or max_depth_raw > 16) return null;
    if (max_children_raw < 1 or max_children_raw > muscle.MAX_PARALLEL) return null;
    if (max_total_raw < 1 or max_total_raw > muscle.MAX_NODES) return null;
    if (max_concurrency_raw < 1 or max_concurrency_raw > muscle.MAX_PARALLEL) return null;
    if (depth_raw > 0 and parent_id == null) return null;
    if (parent_id) |id| if (!validContractId(id)) return null;
    if (supplied_root) |id| if (!validContractId(id)) return null;
    if (parent_id != null and supplied_root == null) return null;

    var depth_buf: [24]u8 = undefined;
    var max_depth_buf: [24]u8 = undefined;
    var max_children_buf: [24]u8 = undefined;
    var max_total_buf: [24]u8 = undefined;
    var max_concurrency_buf: [24]u8 = undefined;
    const fields = [_]contract.Field{
        .{ .key = "execution_model", .value = "stateless_aiko_worker" },
        .{ .key = "contract_depth", .value = std.fmt.bufPrint(&depth_buf, "{d}", .{depth_raw}) catch return null },
        .{ .key = "max_depth", .value = std.fmt.bufPrint(&max_depth_buf, "{d}", .{max_depth_raw}) catch return null },
        .{ .key = "max_children", .value = std.fmt.bufPrint(&max_children_buf, "{d}", .{max_children_raw}) catch return null },
        .{ .key = "max_total_children", .value = std.fmt.bufPrint(&max_total_buf, "{d}", .{max_total_raw}) catch return null },
        .{ .key = "max_concurrency", .value = std.fmt.bufPrint(&max_concurrency_buf, "{d}", .{max_concurrency_raw}) catch return null },
    };
    const id = contract.declare(gpa, extEnv(), plan, "neuron", .{
        .parent_id = parent_id,
        .agent = "aiko-native",
        .cwd = cwd,
        .extras = &fields,
    }) catch return null;
    defer gpa.free(id);
    const root_id = supplied_root orelse id;
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    out.print(gpa, "{{\"abi_version\":{d},\"id\":", .{ABI_VERSION}) catch return null;
    appendJsonString(&out, id) catch return null;
    out.appendSlice(gpa, ",\"root_id\":") catch return null;
    appendJsonString(&out, root_id) catch return null;
    out.print(gpa, ",\"depth\":{d},\"remaining_depth\":{d}}}", .{ depth_raw, max_depth_raw - depth_raw }) catch return null;
    return returned(out.items);
}

/// Declare durable scheduled work from a native host. The user prompt remains
/// the plan; scheduling metadata lives in the action so execution receives a
/// clean prompt. Returns the canonical contract id.
export fn contract_declare_scheduled(
    prompt: [*:0]const u8,
    cwd: [*:0]const u8,
    interval_seconds: u64,
    recurring: bool,
    first_due_unix: i64,
) ?[*:0]u8 {
    if (interval_seconds == 0 or interval_seconds > @as(u64, @intCast(std.math.maxInt(i64)))) {
        return null;
    }
    var action: std.ArrayList(u8) = .empty;
    defer action.deinit(gpa);
    if (recurring) {
        action.print(
            gpa,
            "neuron:background repeat:{d}s not_before:{d}",
            .{ interval_seconds, first_due_unix },
        ) catch return null;
    } else {
        action.print(gpa, "neuron:background at:{d}", .{first_due_unix}) catch return null;
    }
    const fields = [_]contract.Field{
        .{ .key = "background", .value = "true" },
        .{ .key = "authority_policy", .value = "aiko-current-policy" },
    };
    const id = contract.declare(gpa, extEnv(), cstr(prompt), action.items, .{
        .parent_id = null,
        .agent = "aiko-native",
        .cwd = cstr(cwd),
        .extras = &fields,
    }) catch return null;
    defer gpa.free(id);
    return returned(id);
}

/// Parent-aware future obligation declaration. Without explicit durable
/// authority this creates a held proposal child; with authority it creates a
/// runnable one-shot or recurring schedule beneath the active root.
export fn contract_declare_scheduled_json(request_json: [*:0]const u8) ?[*:0]u8 {
    var parsed = std.json.parseFromSlice(std.json.Value, gpa, cstr(request_json), .{}) catch return null;
    defer parsed.deinit();
    if (parsed.value != .object) return null;
    const object = parsed.value.object;
    const prompt = objectString(object, "prompt") orelse return null;
    const cwd = objectString(object, "cwd") orelse return null;
    const parent_id = objectString(object, "parent_id");
    if (parent_id) |id| if (!validContractId(id)) return null;
    const authority = objectBool(object, "authority") orelse false;
    const recurring = objectBool(object, "recurring") orelse false;
    const interval_raw = objectInt(object, "interval_seconds") orelse 0;
    const due = objectInt(object, "first_due_unix") orelse time(null);
    if (interval_raw < 0 or due < 0) return null;

    var action: std.ArrayList(u8) = .empty;
    defer action.deinit(gpa);
    if (!authority) {
        action.appendSlice(gpa, "future:proposed hold:authority") catch return null;
    } else if (recurring) {
        if (interval_raw <= 0) return null;
        action.print(gpa, "neuron:background repeat:{d}s not_before:{d}", .{ interval_raw, due }) catch return null;
    } else {
        action.print(gpa, "neuron:background at:{d}", .{due}) catch return null;
    }
    const fields = [_]contract.Field{
        .{ .key = "background", .value = if (authority) "true" else "false" },
        .{ .key = "authorization", .value = if (authority) "approved" else "pending_authorization" },
        .{ .key = "future_obligation", .value = "true" },
    };
    const id = contract.declare(gpa, extEnv(), prompt, action.items, .{
        .parent_id = parent_id,
        .agent = "aiko-native",
        .cwd = cwd,
        .extras = &fields,
    }) catch return null;
    defer gpa.free(id);
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    out.appendSlice(gpa, "{\"id\":") catch return null;
    appendJsonString(&out, id) catch return null;
    out.print(gpa, ",\"scheduled\":{s},\"held\":{s}}}", .{ if (authority) "true" else "false", if (authority) "false" else "true" }) catch return null;
    return returned(out.items);
}

/// Record an `iterated` event.
export fn contract_iterate(
    id: [*:0]const u8,
    wave: u32,
    action_exit: i32,
    action_result: [*:0]const u8,
) c_int {
    contract.recordIteration(gpa, extEnv(), cstr(id), wave, action_exit, cstr(action_result)) catch return 1;
    return 0;
}

/// Mark a contract satisfied. proof may be NULL for proof_skip cases.
export fn contract_mark_satisfied(
    id: [*:0]const u8,
    wave: u32,
    proof: ?[*:0]const u8,
) c_int {
    const proof_slice: ?[]const u8 = if (proof) |p| cstr(p) else null;
    contract.markSatisfied(gpa, extEnv(), cstr(id), wave, proof_slice) catch return 1;
    return 0;
}

/// Settle a parent only when every directly declared child has a grounded
/// satisfied event. Returns 2 when children are still open or failed.
export fn contract_mark_grounded_satisfied(
    id: [*:0]const u8,
    wave: u32,
    proof: ?[*:0]const u8,
) c_int {
    const parent_id = cstr(id);
    if (!validContractId(parent_id)) return 1;
    const rows = ledger.readAll(gpa, extEnv()) catch return 1;
    defer gpa.free(rows);
    var child_ids: [muscle.MAX_NODES][8]u8 = undefined;
    var child_count: usize = 0;
    var satisfied = [_]bool{false} ** muscle.MAX_NODES;
    var transferred = [_]bool{false} ** muscle.MAX_NODES;
    var lines = std.mem.splitScalar(u8, rows, '\n');
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        var parsed = std.json.parseFromSlice(std.json.Value, gpa, line, .{}) catch continue;
        defer parsed.deinit();
        if (parsed.value != .object) continue;
        const object = parsed.value.object;
        const event = objectString(object, "event") orelse continue;
        const row_id = objectString(object, "id") orelse continue;
        if (std.mem.eql(u8, event, "declared")) {
            const row_parent = objectString(object, "parent_id") orelse continue;
            if (!std.mem.eql(u8, row_parent, parent_id) or !validContractId(row_id)) continue;
            var known = false;
            for (child_ids[0..child_count]) |child_id| if (std.mem.eql(u8, &child_id, row_id)) {
                known = true;
                break;
            };
            if (!known) {
                if (child_count >= muscle.MAX_NODES) return 2;
                @memcpy(&child_ids[child_count], row_id);
                // A future obligation is grounded for the current turn once it
                // has been durably transferred to the scheduler. Its eventual
                // execution belongs to a later root and must not keep this
                // conversational root open forever.
                transferred[child_count] = if (objectString(object, "future_obligation")) |value|
                    std.mem.eql(u8, value, "true")
                else
                    false;
                child_count += 1;
            }
        } else if (std.mem.eql(u8, event, "satisfied")) {
            for (child_ids[0..child_count], 0..) |child_id, index| {
                if (std.mem.eql(u8, &child_id, row_id)) satisfied[index] = true;
            }
        }
    }
    // A satisfied event can precede discovery in the single-pass scan only if
    // the ledger is malformed; normal append-only order is declare→satisfy.
    for (satisfied[0..child_count], transferred[0..child_count]) |done, durable_transfer| {
        if (!done and !durable_transfer) return 2;
    }
    contract.markSatisfied(gpa, extEnv(), parent_id, wave, if (proof) |p| cstr(p) else null) catch return 1;
    return 0;
}

/// Get all rows for an id as a NUL-terminated JSONL buffer.
/// Returns NULL on failure. Caller frees with contract_free.
export fn contract_get(id: [*:0]const u8) ?[*:0]u8 {
    const blob = contract.get(gpa, extEnv(), cstr(id)) catch return null;
    defer gpa.free(blob);
    const out = gpa.allocSentinel(u8, blob.len, 0) catch return null;
    @memcpy(out, blob);
    return out.ptr;
}

/// List all declared contracts as `<id>\t<plan>\n` lines (NUL-terminated).
/// Caller frees with contract_free.
export fn contract_list() ?[*:0]u8 {
    const blob = contract.listAll(gpa, extEnv()) catch return null;
    defer gpa.free(blob);
    const out = gpa.allocSentinel(u8, blob.len, 0) catch return null;
    @memcpy(out, blob);
    return out.ptr;
}

/// List only native durable schedules with their trigger and execution state.
export fn contract_list_scheduled_json() ?[*:0]u8 {
    const json = contract.scheduler.listScheduledJson(gpa, extEnv()) catch return null;
    defer gpa.free(json);
    return returned(json);
}

/// Authorize a tool call: the SIGNED tool-authority policy (gate.zig). Returns a
/// malloc'd JSON string {"decision","risk","reason"} where decision is
/// allow|confirm|deny. scope="" ⇒ deny (fail-closed). Caller frees with
/// contract_free. This is what makes aiko-cli's tool gate signed code — its
/// gate.ts TS mirror is used only when this isn't loaded.
export fn contract_gate(
    scope: [*:0]const u8,
    tool: [*:0]const u8,
    args_json: [*:0]const u8,
) ?[*:0]u8 {
    const r = gate.decide(cstr(scope), cstr(tool), cstr(args_json));
    var buf: [512]u8 = undefined;
    const json = std.fmt.bufPrint(
        &buf,
        "{{\"decision\":\"{s}\",\"risk\":\"{s}\",\"reason\":\"{s}\"}}",
        .{ gate.decisionStr(r.decision), r.risk, r.reason },
    ) catch return null;
    const out = gpa.allocSentinel(u8, json.len, 0) catch return null;
    @memcpy(out, json);
    return out.ptr;
}

/// The LEARNED router + self-documented usage: given a goal, return JSON
/// {"binary":..,"example":<the nearest proven command>,"score":..} — the tool to try
/// plus the exact past command that satisfied a similar goal. NULL when nothing learned.
/// Caller frees with contract_free.
export fn contract_recommend(context: [*:0]const u8) ?[*:0]u8 {
    const j = (contract.recommend(gpa, extEnv(), cstr(context)) catch return null) orelse return null;
    defer gpa.free(j);
    const out = gpa.allocSentinel(u8, j.len, 0) catch return null;
    @memcpy(out, j);
    return out.ptr;
}

/// Typed capability shortlist: verified learned route plus available cold
/// descriptors. Cold descriptors never become ledger successes.
export fn contract_recommend_capabilities(
    context: [*:0]const u8,
    availability_json: [*:0]const u8,
) ?[*:0]u8 {
    const learned = contract.recommend(gpa, extEnv(), cstr(context)) catch null;
    defer if (learned) |j| gpa.free(j);
    const json = capability_cells.recommendJson(
        gpa,
        cstr(context),
        learned,
        cstr(availability_json),
        5,
    ) catch return null;
    defer gpa.free(json);
    return returned(json);
}

/// Atomically replace one FECH provider snapshot. Descriptors are fully
/// validated before the live catalog changes. Returns a small status object or
/// NULL on malformed/unsafe input; caller frees with contract_free.
export fn contract_register_capabilities(
    source: [*:0]const u8,
    descriptors_json: [*:0]const u8,
) ?[*:0]u8 {
    lockRegistry();
    defer registry_mutex.unlock();
    const count = registry().replaceSource(cstr(source), cstr(descriptors_json)) catch return null;
    var buf: [160]u8 = undefined;
    const json = std.fmt.bufPrint(&buf, "{{\"schema_version\":1,\"source\":\"{s}\",\"count\":{d}}}", .{ cstr(source), count }) catch return null;
    return returned(json);
}

/// List the effective dynamic FECH catalog. `filter_json` is `{}` or an
/// optional `{"source":"..."}` selector.
export fn contract_list_capabilities(filter_json: [*:0]const u8) ?[*:0]u8 {
    lockRegistry();
    defer registry_mutex.unlock();
    const json = registry().listJson(gpa, cstr(filter_json)) catch return null;
    defer gpa.free(json);
    return returned(json);
}

/// Rank the dynamic FECH catalog and return the conservative v1 plan shape.
/// Live availability is version-qualified and supplied by Aiko per prompt.
export fn contract_recommend_plan(
    context: [*:0]const u8,
    availability_json: [*:0]const u8,
    limit: u32,
) ?[*:0]u8 {
    if (cstr(context).len == 0 or limit == 0) return null;
    // Episodic evidence improves ranking, but it is not the capability
    // catalog. A corrupt, oversized, or temporarily unavailable ledger must
    // not make every live capability disappear. Degrade to the registered
    // cold catalog and let recommendPlan mark candidates unverified.
    const learned = route.latestCapabilityEvidenceJson(gpa, extEnv()) catch null;
    defer if (learned) |evidence| gpa.free(evidence);
    lockRegistry();
    defer registry_mutex.unlock();
    const json = registry().recommendPlan(gpa, cstr(context), learned, cstr(availability_json), limit) catch return null;
    defer gpa.free(json);
    return returned(json);
}

/// Incrementally warm verified route embeddings inside the resident process.
/// Returns the number of completed passes.
export fn contract_warm_router(passes: u32) u32 {
    var completed: u32 = 0;
    const bounded = @min(passes, 64);
    while (completed < bounded) : (completed += 1) {
        const json = (contract.recommend(gpa, extEnv(), "warm the semantic cache") catch return completed) orelse return completed;
        gpa.free(json);
    }
    return completed;
}

/// Reconcile Contract's durable schedule and lease runnable occurrences to a
/// native host. Request:
/// {"owner":"aiko:<stable-instance>","now_unix":123,"max_items":32,
///  "lease_seconds":300}
///
/// `now_unix` is optional (wall clock is used); all other optional fields are
/// conservatively bounded. The returned JSON is owned by libcontract.
export fn contract_tick_json(request_json: [*:0]const u8) ?[*:0]u8 {
    var parsed = std.json.parseFromSlice(std.json.Value, gpa, cstr(request_json), .{}) catch return null;
    defer parsed.deinit();
    if (parsed.value != .object) return null;
    const object = parsed.value.object;
    const owner = objectString(object, "owner") orelse return null;
    const cwd = objectString(object, "cwd");
    if (owner.len == 0 or owner.len > 256) return null;
    const now_unix = objectInt(object, "now_unix") orelse time(null);
    const max_raw = objectInt(object, "max_items") orelse 32;
    const lease_raw = objectInt(object, "lease_seconds") orelse 300;
    if (max_raw < 0 or lease_raw <= 0) return null;
    const max_items: usize = @intCast(@min(max_raw, 256));
    const lease_seconds: u32 = @intCast(@min(lease_raw, 86400));

    var batch = contract.scheduler.claimDueAt(
        gpa,
        extEnv(),
        now_unix,
        max_items,
        owner,
        lease_seconds,
        cwd,
    ) catch return null;
    defer batch.deinit(gpa);

    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    out.print(gpa, "{{\"abi_version\":{d},\"now_unix\":", .{ABI_VERSION}) catch return null;
    out.print(gpa, "{d}", .{now_unix}) catch return null;
    out.appendSlice(gpa, ",\"next_wake_unix\":") catch return null;
    if (batch.next_wake_unix) |deadline| {
        out.print(gpa, "{d}", .{deadline}) catch return null;
    } else {
        out.appendSlice(gpa, "null") catch return null;
    }
    out.appendSlice(gpa, ",\"claims\":[") catch return null;
    for (batch.claims, 0..) |claim, index| {
        if (index > 0) out.append(gpa, ',') catch return null;
        out.appendSlice(gpa, "{\"contract_id\":") catch return null;
        appendJsonString(&out, claim.contract_id) catch return null;
        out.appendSlice(gpa, ",\"occurrence\":") catch return null;
        appendJsonString(&out, claim.occurrence) catch return null;
        out.appendSlice(gpa, ",\"prompt\":") catch return null;
        appendJsonString(&out, claim.prompt) catch return null;
        out.appendSlice(gpa, ",\"cwd\":") catch return null;
        appendJsonString(&out, claim.cwd) catch return null;
        out.appendSlice(gpa, ",\"due_unix\":") catch return null;
        out.print(gpa, "{d}", .{claim.due_unix}) catch return null;
        out.appendSlice(gpa, ",\"lease_until_unix\":") catch return null;
        out.print(gpa, "{d}", .{claim.lease_until_unix}) catch return null;
        out.append(gpa, '}') catch return null;
    }
    out.appendSlice(gpa, "]}") catch return null;
    return returned(out.items);
}

/// Settle one occurrence previously returned by contract_tick_json. Request:
/// {"owner":"...","contract_id":"...","occurrence":"...",
///  "outcome":"satisfied|retry|died","detail":"privacy-safe proof"}
export fn contract_settle_execution_json(request_json: [*:0]const u8) c_int {
    var parsed = std.json.parseFromSlice(std.json.Value, gpa, cstr(request_json), .{}) catch return 1;
    defer parsed.deinit();
    if (parsed.value != .object) return 1;
    const object = parsed.value.object;
    const owner = objectString(object, "owner") orelse return 1;
    const id = objectString(object, "contract_id") orelse return 1;
    const occurrence = objectString(object, "occurrence") orelse return 1;
    const outcome_text = objectString(object, "outcome") orelse return 1;
    const detail = objectString(object, "detail") orelse "";
    const outcome: contract.scheduler.SettleOutcome =
        if (std.mem.eql(u8, outcome_text, "satisfied"))
            .satisfied
        else if (std.mem.eql(u8, outcome_text, "retry"))
            .retry
        else if (std.mem.eql(u8, outcome_text, "died"))
            .died
        else
            return 1;

    contract.scheduler.settleExecutionAt(
        gpa,
        extEnv(),
        time(null),
        id,
        occurrence,
        owner,
        outcome,
        detail,
    ) catch return 1;
    if (outcome == .satisfied) {
        contract.recordIteration(gpa, extEnv(), id, 0, 0, detail) catch return 1;
        contract.markSatisfied(gpa, extEnv(), id, 0, detail) catch return 1;
    } else if (outcome == .died) {
        contract.markDied(gpa, extEnv(), id, .apoptosed, null, detail) catch return 1;
    }
    return 0;
}

/// Renew a live execution lease. Request uses the same identity fields as
/// settlement plus `lease_seconds`.
export fn contract_renew_execution_json(request_json: [*:0]const u8) c_int {
    var parsed = std.json.parseFromSlice(std.json.Value, gpa, cstr(request_json), .{}) catch return 1;
    defer parsed.deinit();
    if (parsed.value != .object) return 1;
    const object = parsed.value.object;
    const owner = objectString(object, "owner") orelse return 1;
    const id = objectString(object, "contract_id") orelse return 1;
    const occurrence = objectString(object, "occurrence") orelse return 1;
    const lease_raw = objectInt(object, "lease_seconds") orelse return 1;
    if (lease_raw <= 0) return 1;
    const lease_seconds: u32 = @intCast(@min(lease_raw, 86400));
    _ = contract.scheduler.renewExecutionAt(
        gpa,
        extEnv(),
        time(null),
        id,
        occurrence,
        owner,
        lease_seconds,
    ) catch return 1;
    return 0;
}

/// Cancel a durable contract by appending an explicit terminal death row.
export fn contract_cancel(id: [*:0]const u8, reason: ?[*:0]const u8) c_int {
    const detail = if (reason) |value| cstr(value) else "cancelled by Aiko operator";
    contract.markDied(gpa, extEnv(), cstr(id), .apoptosed, null, detail) catch return 1;
    return 0;
}

/// Reopen the latest occurrence for operator-directed retry.
export fn contract_retry(id: [*:0]const u8) c_int {
    contract.scheduler.forceRetryAt(gpa, extEnv(), time(null), cstr(id)) catch return 1;
    return 0;
}

/// Append a workspace-scoped event signal for `when:event:<name>` contracts.
/// Request: {"name":"build-finished","cwd":"/workspace","detail":"..."}
export fn contract_emit_signal_json(request_json: [*:0]const u8) c_int {
    var parsed = std.json.parseFromSlice(std.json.Value, gpa, cstr(request_json), .{}) catch return 1;
    defer parsed.deinit();
    if (parsed.value != .object) return 1;
    const object = parsed.value.object;
    const name = objectString(object, "name") orelse return 1;
    const cwd = objectString(object, "cwd") orelse "";
    const detail = objectString(object, "detail") orelse "";
    contract.scheduler.emitSignalAt(gpa, extEnv(), time(null), name, cwd, detail) catch return 1;
    return 0;
}

const BufferWriter = struct {
    list: *std.ArrayList(u8),

    pub const Error = std.mem.Allocator.Error;

    pub fn writeAll(self: BufferWriter, bytes: []const u8) Error!void {
        try self.list.appendSlice(gpa, bytes);
    }

    pub fn print(self: BufferWriter, comptime fmt: []const u8, args: anytype) Error!void {
        const value = try std.fmt.allocPrint(gpa, fmt, args);
        defer gpa.free(value);
        try self.list.appendSlice(gpa, value);
    }
};

/// Native fractal lineage retrieval. The rendered field is diagnostic context;
/// typed capability dependencies live in contract_recommend_capabilities.
export fn contract_get_fractal_context(
    id: [*:0]const u8,
    event: [*:0]const u8,
) ?[*:0]u8 {
    var rendered: std.ArrayList(u8) = .empty;
    defer rendered.deinit(gpa);
    fractal.renderContext(gpa, extEnv(), cstr(id), cstr(event), BufferWriter{ .list = &rendered }) catch return null;

    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    out.appendSlice(gpa, "{\"id\":\"") catch return null;
    out.appendSlice(gpa, cstr(id)) catch return null;
    out.appendSlice(gpa, "\",\"event\":\"") catch return null;
    out.appendSlice(gpa, cstr(event)) catch return null;
    out.appendSlice(gpa, "\",\"rendered\":\"") catch return null;
    for (rendered.items) |ch| switch (ch) {
        '"' => out.appendSlice(gpa, "\\\"") catch return null,
        '\\' => out.appendSlice(gpa, "\\\\") catch return null,
        '\n' => out.appendSlice(gpa, "\\n") catch return null,
        '\r' => {},
        else => out.append(gpa, ch) catch return null,
    };
    out.appendSlice(gpa, "\"}") catch return null;
    return returned(out.items);
}

/// Record one sanitized, typed capability outcome.
///
/// `context` is the routing intent; `capability` is a stable primitive id
/// (for example `application.click`); `exemplar_json` is a shape-only command
/// with secret/user values removed. Successful outcomes become recommendable;
/// failed outcomes terminate as `died` and therefore cannot be routed to.
/// Returns malloc'd JSON {"id", "status"}; caller frees with contract_free.
export fn contract_record_capability_outcome(
    context: [*:0]const u8,
    capability: [*:0]const u8,
    exemplar_json: [*:0]const u8,
    success: bool,
) ?[*:0]u8 {
    return contract_record_capability_outcome_v2(
        context,
        capability,
        exemplar_json,
        "{}",
        success,
    );
}

/// V2 outcome recording carries privacy-scrubbed execution metadata and binds
/// every capability under a stable application root.
export fn contract_record_capability_outcome_v2(
    context: [*:0]const u8,
    capability: [*:0]const u8,
    exemplar_json: [*:0]const u8,
    metadata_json: [*:0]const u8,
    success: bool,
) ?[*:0]u8 {
    return recordCapabilityOutcomeParts(
        cstr(context),
        cstr(capability),
        cstr(exemplar_json),
        cstr(metadata_json),
        success,
    );
}

fn recordCapabilityOutcomeParts(
    context_slice: []const u8,
    capability_slice: []const u8,
    exemplar_slice: []const u8,
    metadata_slice: []const u8,
    success: bool,
) ?[*:0]u8 {
    if (context_slice.len == 0 or capability_slice.len == 0 or exemplar_slice.len == 0) return null;

    const application = jsonStringField(metadata_slice, "application") orelse "unknown";
    var root_plan: std.ArrayList(u8) = .empty;
    defer root_plan.deinit(gpa);
    root_plan.appendSlice(gpa, "Application capability root: ") catch return null;
    root_plan.appendSlice(gpa, application) catch return null;
    var root_action: std.ArrayList(u8) = .empty;
    defer root_action.deinit(gpa);
    root_action.appendSlice(gpa, "neuron:application-root ") catch return null;
    root_action.appendSlice(gpa, application) catch return null;
    const root_id = contract.declare(gpa, extEnv(), root_plan.items, root_action.items, .{
        .parent_id = null,
        .agent = "aiko-native",
        .cwd = null,
    }) catch return null;
    defer gpa.free(root_id);

    var action_buf: std.ArrayList(u8) = .empty;
    defer action_buf.deinit(gpa);
    action_buf.appendSlice(gpa, capability_slice) catch return null;
    action_buf.append(gpa, ' ') catch return null;
    action_buf.appendSlice(gpa, exemplar_slice) catch return null;

    var fields: [12]contract.Field = undefined;
    var field_count: usize = 0;
    const keys = [_][]const u8{
        "application",
        "permission",
        "result_schema",
        "duration_ms",
        "permission_outcome",
        "availability",
        "capability_version",
        "permission_result",
        "error_class",
        "result_shape",
        "observed_at",
    };
    for (keys) |key| {
        if (jsonValueField(metadata_slice, key)) |value| {
            fields[field_count] = .{ .key = key, .value = value };
            field_count += 1;
        }
    }
    const opts = contract.DeclareOptions{
        .parent_id = root_id,
        .agent = "aiko-native",
        .cwd = null,
        .extras = fields[0..field_count],
    };
    const id = contract.declare(gpa, extEnv(), context_slice, action_buf.items, opts) catch return null;
    defer gpa.free(id);

    contract.recordIteration(
        gpa,
        extEnv(),
        id,
        1,
        if (success) 0 else 1,
        if (success) "verified capability outcome" else "capability execution failed",
    ) catch return null;

    const status = if (success) "satisfied" else "died";
    if (success) {
        contract.markSatisfied(gpa, extEnv(), id, 1, "verified by embedded application runtime") catch return null;
    } else {
        contract.markDied(gpa, extEnv(), id, .apoptosed, null, "embedded application runtime reported failure") catch return null;
    }

    var json_buf: std.ArrayList(u8) = .empty;
    defer json_buf.deinit(gpa);
    json_buf.appendSlice(gpa, "{\"id\":\"") catch return null;
    json_buf.appendSlice(gpa, id) catch return null;
    json_buf.appendSlice(gpa, "\",\"status\":\"") catch return null;
    json_buf.appendSlice(gpa, status) catch return null;
    json_buf.appendSlice(gpa, "\"}") catch return null;
    return returned(json_buf.items);
}

/// Record one FECH v1 observation. The raw JSON is validated and then
/// discarded; only typed, bounded fields are re-serialized into Contract's
/// existing append-only row machinery. `context` remains a separate routing
/// intent and is never part of the observation payload.
export fn contract_record_capability_observation(
    context: [*:0]const u8,
    observation_json: [*:0]const u8,
) ?[*:0]u8 {
    const context_slice = cstr(context);
    const observation_slice = cstr(observation_json);
    if (context_slice.len == 0) return null;
    capability_registry.validateObservation(gpa, observation_slice) catch return null;

    var parsed = std.json.parseFromSlice(std.json.Value, gpa, observation_slice, .{}) catch return null;
    defer parsed.deinit();
    const object = parsed.value.object;
    const id = objectString(object, "capability_id") orelse return null;
    const version = objectString(object, "capability_version") orelse return null;
    const success = switch (object.get("success") orelse return null) {
        .bool => |value| value,
        else => return null,
    };
    const result_shape = objectString(object, "result_shape") orelse return null;

    var capability_key: std.ArrayList(u8) = .empty;
    defer capability_key.deinit(gpa);
    capability_key.appendSlice(gpa, id) catch return null;
    capability_key.append(gpa, '@') catch return null;
    capability_key.appendSlice(gpa, version) catch return null;

    var exemplar: std.ArrayList(u8) = .empty;
    defer exemplar.deinit(gpa);
    exemplar.appendSlice(gpa, "{\"result_shape\":") catch return null;
    appendJsonString(&exemplar, result_shape) catch return null;
    exemplar.append(gpa, '}') catch return null;

    var metadata: std.ArrayList(u8) = .empty;
    defer metadata.deinit(gpa);
    var writer = BufferWriter{ .list = &metadata };
    writer.writeAll("{\"application\":\"fech\",\"capability_version\":") catch return null;
    appendJsonString(&metadata, version) catch return null;
    const typed_keys = [_][]const u8{
        "duration_ms",
        "permission_result",
        "error_class",
        "result_shape",
        "observed_at",
    };
    for (typed_keys) |key| {
        const value = object.get(key) orelse return null;
        metadata.appendSlice(gpa, ",\"") catch return null;
        metadata.appendSlice(gpa, key) catch return null;
        metadata.appendSlice(gpa, "\":") catch return null;
        var allocating: std.Io.Writer.Allocating = .init(gpa);
        defer allocating.deinit();
        var stringify = std.json.Stringify{ .writer = &allocating.writer };
        stringify.write(value) catch return null;
        metadata.appendSlice(gpa, allocating.writer.buffered()) catch return null;
    }
    metadata.append(gpa, '}') catch return null;

    // Contract declarations are content-addressed/idempotent by plan. Give
    // each distinct typed outcome its own safe observation identity so a
    // later failure cannot collapse onto an older satisfied row with the
    // same routing context. Only bounded ABI fields are appended.
    const observed_at = objectString(object, "observed_at") orelse return null;
    var observation_context: std.ArrayList(u8) = .empty;
    defer observation_context.deinit(gpa);
    observation_context.appendSlice(gpa, context_slice) catch return null;
    observation_context.appendSlice(gpa, "\nFECH observation ") catch return null;
    observation_context.appendSlice(gpa, observed_at) catch return null;
    observation_context.appendSlice(gpa, if (success) " success" else " failure") catch return null;

    const recorded = recordCapabilityOutcomeParts(
        observation_context.items,
        capability_key.items,
        exemplar.items,
        metadata.items,
        success,
    );
    if (recorded != null) {
        lockRegistry();
        defer registry_mutex.unlock();
        registry().recordObservation(observation_slice) catch {
            contract_free(recorded.?);
            return null;
        };
    }
    return recorded;
}

/// Evaluate one claim against caller-supplied append-only ledger JSONL.
/// Return values: 1=promote, 0=governed HOLD, -1=legacy/ungoverned,
/// -2=malformed or invalid trust state. This is the same pure replay used by
/// the native resolver and MCP surface.
export fn contract_trust_evaluate(
    ledger_jsonl: [*:0]const u8,
    claim_id: [*:0]const u8,
    now_unix: i64,
) i32 {
    const result = contract.trust.evaluateLedger(
        gpa,
        cstr(ledger_jsonl),
        cstr(claim_id),
        now_unix,
    ) catch return -2;
    const decision = result orelse return -1;
    return if (decision.promote) 1 else 0;
}

fn collectiveError(error_value: anyerror) ?[*:0]u8 {
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    out.appendSlice(gpa, "{\"verdict\":\"reject\",\"reason_codes\":[") catch return null;
    appendJsonString(&out, @errorName(error_value)) catch return null;
    out.appendSlice(gpa, "]}") catch return null;
    return returned(out.items);
}

fn appendCollectiveIdentity(out: *std.ArrayList(u8), result: collective_object.Result) !void {
    try out.appendSlice(gpa, "\"object_id\":");
    try appendJsonString(out, &result.object_id);
    try out.appendSlice(gpa, ",\"schema_version\":1");
}

/// Canonicalize and content-address a bounded unsigned collective object.
/// The returned JSON embeds `canonical` as an object, not an escaped byte
/// string, so independent callers can reserialize and compare the exact form.
export fn contract_collective_canonicalize(
    candidate_json: [*:0]const u8,
) ?[*:0]u8 {
    const result = collective_object.canonicalize(gpa, cstr(candidate_json)) catch |err|
        return collectiveError(err);
    defer result.deinit(gpa);
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    out.append(gpa, '{') catch return null;
    appendCollectiveIdentity(&out, result) catch return null;
    out.appendSlice(gpa, ",\"canonical\":") catch return null;
    out.appendSlice(gpa, result.canonical) catch return null;
    out.appendSlice(gpa, ",\"verdict\":\"valid\"}") catch return null;
    return returned(out.items);
}

/// Apply Contract's fail-closed publication classifier. Aiko owns the actual
/// user setting and publication action; `publishable` is not an execution or
/// network side effect.
export fn contract_collective_publication_verdict(
    candidate_json: [*:0]const u8,
) ?[*:0]u8 {
    const result = collective_object.canonicalize(gpa, cstr(candidate_json)) catch |err|
        return collectiveError(err);
    defer result.deinit(gpa);
    const decision = collective_object.publicationDecision(cstr(candidate_json), gpa) catch |err|
        return collectiveError(err);
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    out.appendSlice(gpa, "{\"verdict\":") catch return null;
    appendJsonString(&out, @tagName(decision.verdict)) catch return null;
    out.appendSlice(gpa, ",\"classification\":") catch return null;
    appendJsonString(&out, @tagName(decision.classification)) catch return null;
    out.appendSlice(gpa, ",\"reason_codes\":[") catch return null;
    appendJsonString(&out, decision.reason_code) catch return null;
    out.appendSlice(gpa, "],") catch return null;
    appendCollectiveIdentity(&out, result) catch return null;
    out.appendSlice(gpa, ",\"sanitized_descriptor\":") catch return null;
    out.appendSlice(gpa, result.canonical) catch return null;
    out.append(gpa, '}') catch return null;
    return returned(out.items);
}

/// Return the domain-separated 32-byte digest that Aiko's local keystore must
/// sign. Private key material never crosses this ABI.
export fn contract_collective_signing_payload(
    candidate_json: [*:0]const u8,
) ?[*:0]u8 {
    const result = collective_object.canonicalize(gpa, cstr(candidate_json)) catch |err|
        return collectiveError(err);
    defer result.deinit(gpa);
    const digest = collective_object.signingDigest(collective_object.objectDigest(result.canonical));
    var digest_hex: [64]u8 = undefined;
    const alphabet = "0123456789abcdef";
    for (digest, 0..) |byte, i| {
        digest_hex[i * 2] = alphabet[byte >> 4];
        digest_hex[i * 2 + 1] = alphabet[byte & 0x0f];
    }
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    out.appendSlice(gpa, "{") catch return null;
    appendCollectiveIdentity(&out, result) catch return null;
    out.appendSlice(gpa, ",\"domain\":") catch return null;
    appendJsonString(&out, collective_object.SIGNING_DOMAIN[0 .. collective_object.SIGNING_DOMAIN.len - 1]) catch return null;
    out.appendSlice(gpa, ",\"payload_encoding\":\"hex\",\"payload_hex\":") catch return null;
    appendJsonString(&out, &digest_hex) catch return null;
    out.append(gpa, '}') catch return null;
    return returned(out.items);
}

/// Verify exact object identity, publisher binding, expiry, and Ed25519
/// signature. `claimed_object_id` is the hash requested from the peer/DHT.
export fn contract_collective_verify(
    candidate_json: [*:0]const u8,
    claimed_object_id: [*:0]const u8,
    signature_hex: [*:0]const u8,
    publisher_key_hex: [*:0]const u8,
    now_iso: [*:0]const u8,
) ?[*:0]u8 {
    const result = collective_object.verify(
        gpa,
        cstr(candidate_json),
        cstr(claimed_object_id),
        cstr(signature_hex),
        cstr(publisher_key_hex),
        cstr(now_iso),
    ) catch |err| return collectiveError(err);
    defer result.deinit(gpa);
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    out.appendSlice(gpa, "{\"verdict\":\"verified\",\"reason_codes\":[\"signature_valid\",\"object_id_valid\",\"time_valid\"],") catch return null;
    appendCollectiveIdentity(&out, result) catch return null;
    out.append(gpa, '}') catch return null;
    return returned(out.items);
}

/// Deterministically combine bounded semantic affinity with public evidence.
/// The caller owns retrieval and supplies no task text or private context.
export fn contract_collective_rank(
    candidates_json: [*:0]const u8,
    limit: u32,
) ?[*:0]u8 {
    const ranked = collective_rank.rank(gpa, cstr(candidates_json), @min(limit, 100)) catch |err|
        return collectiveError(err);
    defer gpa.free(ranked);
    return returned(ranked);
}

/// Build a deterministic content checkpoint from an unordered JSON array of
/// admitted object IDs. Persistence and witness gossip remain Aiko-owned.
export fn contract_collective_checkpoint(object_ids_json: [*:0]const u8) ?[*:0]u8 {
    const checkpoint = collective_checkpoint.rootForIds(gpa, cstr(object_ids_json)) catch |err|
        return collectiveError(err);
    defer gpa.free(checkpoint);
    return returned(checkpoint);
}

/// Build a logarithmic inclusion proof for one object under the deterministic
/// checkpoint root. This is additive: the existing checkpoint ABI and every
/// pre-collective symbol retain their original signatures.
export fn contract_collective_inclusion_proof(
    object_ids_json: [*:0]const u8,
    target_object_id: [*:0]const u8,
) ?[*:0]u8 {
    const proof = collective_checkpoint.proofForId(
        gpa,
        cstr(object_ids_json),
        cstr(target_object_id),
    ) catch |err| return collectiveError(err);
    defer gpa.free(proof);
    return returned(proof);
}

export fn contract_collective_verify_inclusion_proof(proof_json: [*:0]const u8) ?[*:0]u8 {
    const valid = collective_checkpoint.verifyProof(gpa, cstr(proof_json)) catch |err|
        return collectiveError(err);
    return returned(if (valid)
        "{\"verdict\":\"verified\",\"reason_codes\":[\"inclusion_valid\"]}"
    else
        "{\"verdict\":\"rejected\",\"reason_codes\":[\"inclusion_invalid\"]}");
}

/// Verify and classify a complete signed envelope received by Aiko. The
/// returned ledger effect is an instruction for the existing Contract ledger;
/// this function performs no persistence itself.
export fn contract_collective_admit(
    envelope_json: [*:0]const u8,
    source_peer: [*:0]const u8,
    received_at: [*:0]const u8,
) ?[*:0]u8 {
    const admission = collective_admission.admit(gpa, cstr(envelope_json), cstr(source_peer), cstr(received_at)) catch |err|
        return collectiveError(err);
    defer admission.deinit(gpa);
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    out.appendSlice(gpa, "{\"verdict\":\"admitted\",\"reason_codes\":[\"signature_valid\",\"publication_policy_valid\"],\"object_id\":") catch return null;
    appendJsonString(&out, &admission.result.object_id) catch return null;
    out.appendSlice(gpa, ",\"kind\":") catch return null;
    appendJsonString(&out, admission.kind) catch return null;
    out.appendSlice(gpa, ",\"ledger_effects\":[") catch return null;
    appendJsonString(&out, admission.ledger_effect) catch return null;
    out.appendSlice(gpa, "]}") catch return null;
    return returned(out.items);
}

export fn contract_collective_merge(admitted_metadata_json: [*:0]const u8) ?[*:0]u8 {
    const projection = collective_state.merge(gpa, cstr(admitted_metadata_json)) catch |err|
        return collectiveError(err);
    defer gpa.free(projection);
    return returned(projection);
}

export fn contract_collective_apply_revocations(
    revocation_envelopes_json: [*:0]const u8,
    now_iso: [*:0]const u8,
) ?[*:0]u8 {
    const projection = collective_state.applyRevocations(gpa, cstr(revocation_envelopes_json), cstr(now_iso)) catch |err|
        return collectiveError(err);
    defer gpa.free(projection);
    return returned(projection);
}

/// Release a buffer previously returned by one of the C ABI getters.
export fn contract_free(p: ?[*:0]u8) void {
    if (p) |ptr| {
        const slice = std.mem.span(ptr);
        const full = ptr[0 .. slice.len + 1];
        gpa.free(full);
    }
}

test "outcome metadata keeps strings numbers and structured schemas" {
    const metadata =
        \\{"application":"Notes","duration_ms":17,"result_schema":{"type":"object","fields":["success"]}}
    ;
    try std.testing.expectEqualStrings("Notes", jsonValueField(metadata, "application").?);
    try std.testing.expectEqualStrings("17", jsonValueField(metadata, "duration_ms").?);
    try std.testing.expectEqualStrings(
        "{\"type\":\"object\",\"fields\":[\"success\"]}",
        jsonValueField(metadata, "result_schema").?,
    );
}

test "C ABI compiles internal systems and rejects invalid specifications" {
    const valid =
        \\{"purpose":"learn","authority":"operator","evidence_policy":"independent","recurrence":{"trigger":"verdict","max_occurrences":2},"loops":[{"scale":"micro","action":{"prompt":"act"},"sensor":{"prompt":"observe"},"evaluator":{"prompt":"judge"}}]}
    ;
    const result = contract_compile_internal_system_json(valid) orelse return error.UnexpectedNull;
    defer contract_free(result);
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, std.mem.span(result), .{});
    defer parsed.deinit();
    try std.testing.expectEqual(
        @as(usize, 3),
        parsed.value.object.get("nodes").?.array.items.len,
    );
    try std.testing.expect(contract_compile_internal_system_json("{}") == null);

    const complete =
        \\{"effect":"process_spawn","approval_class":"process","sensor_evidence":["positron:sensor=process_identity","positron:sensor=health_state","positron:sensor=lease_state"],"evaluator_evidence":["positron:evaluator=cancellation_path","positron:evaluator=restart_owner","positron:evaluator=bounded_child_tree"]}
    ;
    try std.testing.expectEqual(@as(u8, 0), contract_validate_effect_evidence_json(complete));
    const incomplete =
        \\{"effect":"process_spawn","approval_class":"process","sensor_evidence":["positron:sensor=process_identity"],"evaluator_evidence":[]}
    ;
    try std.testing.expectEqual(@as(u8, 1), contract_validate_effect_evidence_json(incomplete));
}

test "native ABI version is pinned for independently-built Aiko" {
    try std.testing.expectEqual(@as(u32, 6), contract_abi_version());
}

test "turn context rejects disconnected and over-budget descendants" {
    try std.testing.expect(validContractId("deadbeef"));
    try std.testing.expect(!validContractId("not-an-id"));
    try std.testing.expect(contract_declare_turn_context_json(
        "{\"plan\":\"child\",\"depth\":1,\"root_id\":\"deadbeef\"}",
    ) == null);
    try std.testing.expect(contract_declare_turn_context_json(
        "{\"plan\":\"child\",\"depth\":5,\"max_depth\":4,\"parent_id\":\"deadbeef\",\"root_id\":\"cafebabe\"}",
    ) == null);
}

test "muscle ABI trains recall and JEPA prediction from real usage" {
    try std.testing.expect(contract_muscle_observe("search source", "rg-muscle-test", "source tree", "matching lines", 1));
    try std.testing.expect(contract_muscle_observe("compile library", "zig-muscle-test", "source tree", "built library", 1));
    const recall_ptr = contract_muscle_recall("search source text") orelse return error.TestUnexpectedResult;
    defer contract_free(recall_ptr);
    try std.testing.expectEqualStrings("rg-muscle-test", std.mem.span(recall_ptr));
    const predict_ptr = contract_muscle_predict("source tree", "built library") orelse return error.TestUnexpectedResult;
    defer contract_free(predict_ptr);
    try std.testing.expectEqualStrings("zig-muscle-test", std.mem.span(predict_ptr));
}

test "agency C ABI validation is additive and fail-closed" {
    const valid =
        \\{"role":"action","authority_pointer":"identity:operator","purpose_id":"purpose:root","cadence_class":"operational","effect_scope":"local_write","valid_from":1,"valid_until":2,"schema_version":1}
    ;
    try std.testing.expectEqual(@as(u8, 1), contract_agency_validate(valid));
    try std.testing.expectEqual(@as(u8, 0), contract_agency_validate("{}"));
}

test "trust C ABI distinguishes legacy malformed hold and promote" {
    try std.testing.expectEqual(
        @as(i32, -1),
        contract_trust_evaluate(
            "{\"event\":\"satisfied\",\"id\":\"legacy\"}",
            "legacy",
            100,
        ),
    );
    try std.testing.expectEqual(
        @as(i32, -2),
        contract_trust_evaluate(
            "{\"event\":\"trust_policy\",\"id\":\"broken\"}",
            "broken",
            100,
        ),
    );
}

test "collective C ABI is additive deterministic and fail closed" {
    const candidate =
        \\{"protocol":"aiko-collective/1","kind":"capability","publisher":"ed25519:0000000000000000000000000000000000000000000000000000000000000000","sequence":1,"created_at":"2026-07-21T00:00:00Z","expires_at":"2026-08-20T00:00:00Z","payload":{"capability_id":"unbrowse.registry.search","capability_version":"1","origin":"registry.example","operation":"search","summary":"Search public package metadata","input_shape":{"query":{"type":"string","required":true}},"output_shape":{"items":{"type":"array","required":true,"items_type":"object"}},"permission":"network","effects":["network_read","read_only"],"requires":[],"sanitizer_version":1}}
    ;
    const canonical_ptr = contract_collective_canonicalize(candidate) orelse return error.OutOfMemory;
    defer contract_free(canonical_ptr);
    const canonical_json = std.mem.span(canonical_ptr);
    try std.testing.expect(std.mem.indexOf(u8, canonical_json, "\"verdict\":\"valid\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, canonical_json, "\"object_id\":\"blake3:") != null);

    const publication_ptr = contract_collective_publication_verdict(candidate) orelse return error.OutOfMemory;
    defer contract_free(publication_ptr);
    try std.testing.expect(std.mem.indexOf(u8, std.mem.span(publication_ptr), "\"verdict\":\"publishable\"") != null);

    const rejected_ptr = contract_collective_canonicalize("{\"token\":\"secret\"}") orelse return error.OutOfMemory;
    defer contract_free(rejected_ptr);
    try std.testing.expect(std.mem.indexOf(u8, std.mem.span(rejected_ptr), "\"verdict\":\"reject\"") != null);
}
