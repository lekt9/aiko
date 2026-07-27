// Generative-limb lifecycle (§30): admit a Skill package by content digest,
// attach it with exactly its declared caps_request, fire through ordinary
// Script-Neuron paths, judge, revoke, detach, and garbage-collect (§22).

const std = @import("std");
const types = @import("types.zig");
const caps_mod = @import("caps.zig");
const substrate_mod = @import("substrate.zig");
const runtime_mod = @import("runtime.zig");
const neuron_mod = @import("neuron.zig");
const script_mod = @import("script.zig");
const run_mod = @import("run.zig");

const Allocator = std.mem.Allocator;
const Sha256 = std.crypto.hash.sha2.Sha256;

const ADMISSION_SCHEMA = "neuron.limb-admission/v1";
const ADMISSION_PREFIX = "artifact/limbs/admitted/";
const REVOKED_PREFIX = "artifact/limbs/revoked/";
const DETACHED_PREFIX = "artifact/limbs/detached/";

const admission_evidence = [_]types.Evidence{.{
    .claim = "manifest validated and package digest pinned by the harness admission boundary",
    .sources = &.{"stimulus"},
    .method = "harness admission (§29/§30)",
}};

pub fn computePackageDigest(allocator: Allocator, io: std.Io, package_dir: []const u8) !types.Digest {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const cwd = std.Io.Dir.cwd();
    const manifest_path = try std.fs.path.join(a, &.{ package_dir, "neuron.json" });
    const manifest_bytes = try cwd.readFileAlloc(io, manifest_path, a, .limited(1 << 20));
    const manifest = try std.json.parseFromSliceLeaky(std.json.Value, a, manifest_bytes, .{});
    if (manifest != .object) return error.InvalidManifest;

    var entries: std.ArrayList([]const u8) = .empty;
    try entries.append(a, try a.dupe(u8, "neuron.json"));
    const neurons = manifest.object.get("neurons") orelse return error.InvalidManifest;
    if (neurons != .array) return error.InvalidManifest;
    for (neurons.array.items) |entry| {
        if (entry != .object) continue;
        const argv = entry.object.get("argv") orelse continue;
        if (argv != .array) continue;
        for (argv.array.items) |item| {
            const part = switch (item) {
                .string => |s| s,
                else => continue,
            };
            if (part.len > 0 and part[0] != '/' and std.mem.indexOfScalar(u8, part, '/') != null) {
                const abs = try std.fs.path.join(a, &.{ package_dir, part });
                _ = cwd.statFile(io, abs, .{}) catch continue;
                try entries.append(a, try a.dupe(u8, part));
            }
        }
    }
    const schemas_path = try std.fs.path.join(a, &.{ package_dir, "schemas" });
    if (cwd.openDir(io, schemas_path, .{})) |schemas_dir| {
        defer schemas_dir.close(io);
        var walker = try schemas_dir.walk(a);
        defer walker.deinit();
        while (try walker.next(io)) |entry| {
            if (entry.kind == .file) try entries.append(a, try std.fmt.allocPrint(a, "schemas/{s}", .{entry.path}));
        }
    } else |_| {}
    std.mem.sort([]const u8, entries.items, {}, stringLess);
    var hasher = Sha256.init(.{});
    hasher.update("neuron.limb-package/v1\n");
    for (entries.items) |relpath| {
        const abs = try std.fs.path.join(a, &.{ package_dir, relpath });
        const file_bytes = cwd.readFileAlloc(io, abs, a, .limited(1 << 20)) catch return error.PackageIoError;
        hasher.update(relpath);
        hasher.update(file_bytes);
    }
    var digest: types.Digest = undefined;
    hasher.final(&digest);
    return digest;
}

pub fn admit(allocator: Allocator, io: std.Io, package_dir: []const u8, state_dir: []const u8) !AdmitResult {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const digest = try computePackageDigest(a, io, package_dir);
    var hex: [64]u8 = undefined;
    _ = try std.fmt.bufPrint(&hex, "{s}", .{std.fmt.bytesToHex(digest, .lower)});

    var substrate = try substrate_mod.Substrate.initDir(allocator, io, std.Io.Dir.cwd(), state_dir);
    defer substrate.deinit();
    const runtime: runtime_mod.Runtime = .{ .substrate = &substrate };

    const manifest_path = try std.fs.path.join(a, &.{ package_dir, "neuron.json" });
    const manifest_bytes = try std.Io.Dir.cwd().readFileAlloc(io, manifest_path, a, .limited(1 << 20));
    const manifest_str = try std.json.Stringify.valueAlloc(a, manifest_bytes, .{});
    const record_bytes = try std.fmt.allocPrint(a,
        \\{{"schema":"{s}","package":{s},"digest":"{s}"}}
    , .{ ADMISSION_SCHEMA, manifest_str, &hex });

    const firing_id = try std.fmt.allocPrint(a, "admission/{s}", .{&hex});
    const write_id = try std.fmt.allocPrint(a, ADMISSION_PREFIX ++ "{s}", .{&hex});
    var fx: [1]types.Effect = .{
        .{ .write = .{ .id = write_id, .schema = ADMISSION_SCHEMA, .bytes = record_bytes } },
    };
    const result = runtime.execute(.{
        .firing_id = firing_id,
        .receptor_schema = "neuron.limb-admission/v1",
    }, harnessCaps(ADMISSION_PREFIX), .{
        .control = .{ .terminate = "admitted" },
        .effects = &fx,
        .evidence = &admission_evidence,
    }) catch |err| {
        if (err == error.FiringAlreadySettled or err == error.FiringMismatch) return .{ .digest = hex, .created = false };
        return err;
    };
    return .{ .digest = hex, .created = result.effects_committed > 0 };
}

pub const AdmitResult = struct { digest: [64]u8, created: bool };

pub fn limbRun(
    allocator: Allocator,
    io: std.Io,
    state_dir: []const u8,
    package_dir: []const u8,
    neuron_id: []const u8,
    stimulus_path: []const u8,
    json_out: bool,
    dump: bool,
) !void {
    const digest = try computePackageDigest(allocator, io, package_dir);
    var hex: [64]u8 = undefined;
    _ = try std.fmt.bufPrint(&hex, "{s}", .{std.fmt.bytesToHex(digest, .lower)});

    var substrate = try substrate_mod.Substrate.initDir(allocator, io, std.Io.Dir.cwd(), state_dir);
    defer substrate.deinit();

    const admission_id = try std.fmt.allocPrint(allocator, ADMISSION_PREFIX ++ "{s}", .{&hex});
    defer allocator.free(admission_id);
    const admission_artifact = substrate.artifacts.get(admission_id) orelse return error.LimbNotAdmitted;
    if (!std.mem.eql(u8, admission_artifact.schema, ADMISSION_SCHEMA)) return error.LimbNotAdmitted;
    const revoked_id = try std.fmt.allocPrint(allocator, REVOKED_PREFIX ++ "{s}", .{&hex});
    defer allocator.free(revoked_id);
    if (substrate.artifacts.contains(revoked_id)) return error.LimbRevoked;
    const detached_id = try std.fmt.allocPrint(allocator, DETACHED_PREFIX ++ "{s}", .{&hex});
    defer allocator.free(detached_id);
    if (substrate.artifacts.contains(detached_id)) return error.LimbDetached;

    const admission = try std.json.parseFromSliceLeaky(std.json.Value, allocator, admission_artifact.bytes, .{});
    if (admission != .object) return error.CorruptAdmission;
    const package_field = admission.object.get("package") orelse return error.CorruptAdmission;
    if (package_field != .string) return error.CorruptAdmission;
    const manifest = try std.json.parseFromSliceLeaky(std.json.Value, allocator, package_field.string, .{});
    if (manifest != .object) return error.InvalidManifest;
    const resolved = try run_mod.resolveNeuronArgv(allocator, manifest, package_dir, neuron_id);

    const cwd = std.Io.Dir.cwd();
    const stimulus_bytes = if (std.mem.eql(u8, stimulus_path, "-"))
        try readStdin(allocator, io)
    else
        try cwd.readFileAlloc(io, stimulus_path, allocator, .limited(1 << 20));
    defer allocator.free(stimulus_bytes);
    const stimulus_json = try std.json.parseFromSliceLeaky(std.json.Value, allocator, stimulus_bytes, .{});
    if (stimulus_json != .object) return error.InvalidStimulus;
    const stimulus = try run_mod.stageStimulus(allocator, stimulus_json, &substrate);

    var implementation: script_mod.ScriptNeuron = .{
        .allocator = allocator,
        .io = io,
        .argv = resolved.argv,
        .substrate = &substrate,
    };
    if (manifest.object.get("budgets")) |budgets| {
        if (budgets == .object) {
            if (budgets.object.get("deadline_ms_per_firing")) |v| {
                if (v == .integer and v.integer > 0) {
                    implementation.default_timeout = .{
                        .duration = .{ .raw = .{ .nanoseconds = @as(i96, @intCast(v.integer)) * std.time.ns_per_ms }, .clock = .boot },
                    };
                }
            }
        }
    }
    const version = jsonString(manifest.object.get("package") orelse return error.InvalidManifest, "version") orelse "0.0.0";
    const neuron = neuron_mod.bind(script_mod.ScriptNeuron, &implementation, neuron_id, version);
    const result = try (runtime_mod.Runtime{ .substrate = &substrate }).fire(neuron, stimulus, resolved.caps);
    try printSummary(allocator, io, .{
        .firing_id = stimulus.firing_id,
        .neuron_id = neuron_id,
        .effects_committed = result.effects_committed,
        .duplicates_skipped = result.duplicates_skipped,
        .artifacts = substrate.artifacts.count(),
        .messages = substrate.messages.items.len,
        .neurons = substrate.neurons.count(),
        .digest = result.decision_digest,
    }, json_out, dump);
}

pub fn revoke(allocator: Allocator, io: std.Io, package_dir: []const u8, state_dir: []const u8) !void {
    const digest = try computePackageDigest(allocator, io, package_dir);
    var hex: [64]u8 = undefined;
    _ = try std.fmt.bufPrint(&hex, "{s}", .{std.fmt.bytesToHex(digest, .lower)});

    var substrate = try substrate_mod.Substrate.initDir(allocator, io, std.Io.Dir.cwd(), state_dir);
    defer substrate.deinit();
    const runtime: runtime_mod.Runtime = .{ .substrate = &substrate };

    const revoke_id = try std.fmt.allocPrint(allocator, REVOKED_PREFIX ++ "{s}", .{&hex});
    defer allocator.free(revoke_id);
    const firing_id = try std.fmt.allocPrint(allocator, "revocation/{s}", .{&hex});
    defer allocator.free(firing_id);
    var fx: [1]types.Effect = .{
        .{ .write = .{ .id = revoke_id, .schema = "neuron.limb-revocation/v1", .bytes = &hex } },
    };
    _ = runtime.execute(.{
        .firing_id = firing_id,
        .receptor_schema = "neuron.limb-revocation/v1",
    }, harnessCaps(REVOKED_PREFIX), .{
        .control = .{ .terminate = "revoked" },
        .effects = &fx,
        .evidence = &admission_evidence,
    }) catch |err| {
        if (err == error.FiringAlreadySettled or err == error.FiringMismatch) return;
        return err;
    };
}

pub fn detach(allocator: Allocator, io: std.Io, package_dir: []const u8, state_dir: []const u8) !DetachResult {
    const digest = try computePackageDigest(allocator, io, package_dir);
    var hex: [64]u8 = undefined;
    _ = try std.fmt.bufPrint(&hex, "{s}", .{std.fmt.bytesToHex(digest, .lower)});

    var substrate = try substrate_mod.Substrate.initDir(allocator, io, std.Io.Dir.cwd(), state_dir);
    defer substrate.deinit();
    const runtime: runtime_mod.Runtime = .{ .substrate = &substrate };

    const admission_id = try std.fmt.allocPrint(allocator, ADMISSION_PREFIX ++ "{s}", .{&hex});
    defer allocator.free(admission_id);
    const admission_artifact = substrate.artifacts.get(admission_id) orelse return error.LimbNotAdmitted;
    const admission = try std.json.parseFromSliceLeaky(std.json.Value, allocator, admission_artifact.bytes, .{});
    if (admission != .object) return error.CorruptAdmission;
    const package_field = admission.object.get("package") orelse return error.CorruptAdmission;
    if (package_field != .string) return error.CorruptAdmission;
    const manifest = try std.json.parseFromSliceLeaky(std.json.Value, allocator, package_field.string, .{});
    if (manifest != .object) return error.InvalidManifest;

    var prefixes: std.ArrayList([]const u8) = .empty;
    const neurons = manifest.object.get("neurons") orelse return error.InvalidManifest;
    if (neurons != .array) return error.InvalidManifest;
    for (neurons.array.items) |entry| {
        if (entry != .object) continue;
        const caps_req = entry.object.get("caps_request") orelse continue;
        const caps = script_mod.capsFromJson(caps_req) catch continue;
        if (caps.allow_write and caps.write_prefix.len > 0) try prefixes.append(allocator, caps.write_prefix);
    }
    if (prefixes.items.len == 0) return error.InvalidManifest;

    const detach_id = try std.fmt.allocPrint(allocator, DETACHED_PREFIX ++ "{s}", .{&hex});
    defer allocator.free(detach_id);
    const firing_id = try std.fmt.allocPrint(allocator, "detachment/{s}", .{&hex});
    defer allocator.free(firing_id);
    var fx: [1]types.Effect = .{
        .{ .write = .{ .id = detach_id, .schema = "neuron.limb-detach/v1", .bytes = &hex } },
    };
    _ = runtime.execute(.{
        .firing_id = firing_id,
        .receptor_schema = "neuron.limb-detach/v1",
    }, harnessCaps(DETACHED_PREFIX), .{
        .control = .{ .terminate = "detached" },
        .effects = &fx,
        .evidence = &admission_evidence,
    }) catch |err| return err;

    const collected = try substrate.gcArtifacts(prefixes.items);
    try substrate.journalGc(prefixes.items);
    for (prefixes.items) |p| allocator.free(p);
    prefixes.deinit(allocator);
    return .{ .collected = collected };
}

pub const DetachResult = struct { collected: usize };

pub fn inspect(allocator: Allocator, io: std.Io, state_dir: []const u8, json_out: bool) !void {
    var substrate = try substrate_mod.Substrate.initDir(allocator, io, std.Io.Dir.cwd(), state_dir);
    defer substrate.deinit();

    var admitted: usize = 0;
    var revoked: usize = 0;
    var detached: usize = 0;
    var artifact_it = substrate.artifacts.keyIterator();
    while (artifact_it.next()) |key| {
        if (std.mem.startsWith(u8, key.*, ADMISSION_PREFIX)) admitted += 1;
        if (std.mem.startsWith(u8, key.*, REVOKED_PREFIX)) revoked += 1;
        if (std.mem.startsWith(u8, key.*, DETACHED_PREFIX)) detached += 1;
    }
    var out_buffer: [1024]u8 = undefined;
    var writer = std.Io.File.stdout().writer(io, &out_buffer);
    if (json_out) {
        try writer.interface.writeAll("{");
        try writer.interface.print(
            \\"admitted":{},"revoked":{},"detached":{},"artifacts":{},"messages":{},"neurons":{},"firings":{},"artifact_ids":[
        , .{ admitted, revoked, detached, substrate.artifacts.count(), substrate.messages.items.len, substrate.neurons.count(), substrate.firings.count() });
        var ait = substrate.artifacts.keyIterator();
        var afirst = true;
        while (ait.next()) |key| {
            if (!afirst) try writer.interface.writeAll(",");
            afirst = false;
            try std.json.Stringify.encodeJsonString(key.*, .{}, &writer.interface);
        }
        try writer.interface.writeAll("]}\n");
    } else {
        try writer.interface.print(
            \\admitted  {d}
            \\revoked   {d}
            \\detached  {d}
            \\artifacts {d}
            \\messages  {d}
            \\neurons   {d}
            \\firings   {d}
            \\
        , .{ admitted, revoked, detached, substrate.artifacts.count(), substrate.messages.items.len, substrate.neurons.count(), substrate.firings.count() });
    }
    try writer.interface.flush();
}

/// Project committed firing records into a deterministic rollup for the
/// closed telemetry loop (§28, §31). Reads the substrate snapshot, never
/// writes — no feedback path can mutate historical records.
pub fn telemetryProject(allocator: Allocator, io: std.Io, state_dir: []const u8, json_out: bool) !void {
    var substrate = try substrate_mod.Substrate.initDir(allocator, io, std.Io.Dir.cwd(), state_dir);
    defer substrate.deinit();

    var committed: usize = 0;
    var rejected: usize = 0;
    var cancelled: usize = 0;
    var total_effects: usize = 0;
    var firing_it = substrate.firings.iterator();
    while (firing_it.next()) |entry| {
        switch (entry.value_ptr.status) {
            .committed => {
                committed += 1;
                total_effects += entry.value_ptr.effects_committed;
            },
            .rejected => rejected += 1,
            .cancelled => cancelled += 1,
            else => {},
        }
    }
    const total = committed + rejected + cancelled;
    var out_buffer: [1024]u8 = undefined;
    var writer = std.Io.File.stdout().writer(io, &out_buffer);
    if (json_out) {
        try writer.interface.writeAll("{");
        try writer.interface.print(
            \\"schema":"neuron.telemetry/v1","committed":{},"rejected":{},"cancelled":{},"total":{},"effects_committed":{},"artifacts":{},"messages":{},"neurons":{}
        , .{ committed, rejected, cancelled, total, total_effects, substrate.artifacts.count(), substrate.messages.items.len, substrate.neurons.count() });
        try writer.interface.writeAll("}\n");
    } else {
        try writer.interface.print(
            \\committed  {d}
            \\rejected   {d}
            \\cancelled  {d}
            \\total      {d}
            \\effects    {d}
            \\artifacts  {d}
            \\messages   {d}
            \\neurons    {d}
            \\
        , .{ committed, rejected, cancelled, total, total_effects, substrate.artifacts.count(), substrate.messages.items.len, substrate.neurons.count() });
    }
    try writer.interface.flush();
}

fn harnessCaps(prefix: []const u8) caps_mod.Caps {
    return .{ .allow_write = true, .write_prefix = prefix };
}

fn stringLess(_: void, a: []const u8, b: []const u8) bool {
    return std.mem.order(u8, a, b) == .lt;
}

fn jsonString(value: std.json.Value, key: []const u8) ?[]const u8 {
    if (value != .object) return null;
    const field = value.object.get(key) orelse return null;
    return switch (field) {
        .string => |str| str,
        else => null,
    };
}

fn printSummary(
    allocator: Allocator,
    io: std.Io,
    summary: struct {
        firing_id: []const u8,
        neuron_id: []const u8,
        effects_committed: usize,
        duplicates_skipped: usize,
        artifacts: usize,
        messages: usize,
        neurons: usize,
        digest: types.Digest,
    },
    json: bool,
    dump: bool,
) !void {
    _ = allocator;
    _ = dump;
    var buffer: [1024]u8 = undefined;
    var writer = std.Io.File.stdout().writer(io, &buffer);
    if (json) {
        try writer.interface.print("{{\"status\":\"committed\",\"firing_id\":\"{s}\",\"neuron\":\"{s}\",\"effects_committed\":{d},\"duplicates_skipped\":{d},\"artifacts\":{d},\"messages\":{d},\"neurons\":{d},\"digest\":\"{x}\"}}\n", .{
            summary.firing_id, summary.neuron_id, summary.effects_committed, summary.duplicates_skipped,
            summary.artifacts, summary.messages,  summary.neurons,           summary.digest,
        });
    } else {
        try writer.interface.print(
            "✓ firing {s} committed via {s}\n  {d} effects · {d} artifacts · {d} messages · {d} neurons\n  decision {x}\n",
            .{ summary.firing_id, summary.neuron_id, summary.effects_committed, summary.artifacts, summary.messages, summary.neurons, summary.digest },
        );
    }
    try writer.interface.flush();
}

fn readStdin(allocator: Allocator, io: std.Io) ![]u8 {
    var buffer: [4096]u8 = undefined;
    var reader = std.Io.File.stdin().reader(io, &buffer);
    return reader.interface.allocRemaining(allocator, .limited(1 << 20));
}
