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

pub const ADMISSION_SCHEMA = "neuron.limb-admission/v1";
pub const ADMISSION_PREFIX = "artifact/limbs/admitted/";
pub const REVOKED_PREFIX = "artifact/limbs/revoked/";
pub const DETACHED_PREFIX = "artifact/limbs/detached/";

/// Every package declares what it is supposed to do, in the same file shape a
/// skill uses: YAML frontmatter that a machine reads, prose beneath it that a
/// reader does.
pub const SKILL_DOC = "SKILL.md";

pub const SkillDocError = error{
    SkillDocMissing,
    SkillDocMalformed,
    SkillDocUnfalsifiable,
    SkillDocUngrounded,
};

/// The machine-read half of a package's SKILL.md.
///
/// `expect_contains` is the load-bearing field and the reason this type exists.
/// `morphogenesis.CapabilityGap` already refuses a gap that declares no
/// acceptance, because anything returning bytes would "satisfy" it. A package
/// is the same object with a longer life: without a declared acceptance there
/// is no statement that could turn out to be false, so "it works" degrades to
/// "it ran". This carries that refusal from the transient gap onto the durable
/// package.
pub const SkillDoc = struct {
    name: []const u8,
    description: []const u8,
    probe_input: []const u8,
    expect_contains: []const u8,
    /// What this package was authored FROM, as resolvable citations.
    ///
    /// `expect_contains` says what the package claims; this says where the
    /// claim came from. Both sit inside the digest, so neither can be edited
    /// to say something new while the pin stays put — which is exactly how a
    /// package and the doctrine it was built against drift apart.
    ///
    /// Cited, never re-interpreted. A producer that re-reads its grounding and
    /// decides afresh each pass is non-deterministic and `redrive` refuses it.
    /// This field exists to be *checked*, not consulted.
    grounding: []const u8,

    /// Parse the frontmatter. The body is deliberately NOT returned: prose is
    /// evidence to be cited by digest, never a decision procedure re-read on
    /// the recompute path. A producer that re-interprets prose each pass is
    /// non-deterministic, and `redrive` refuses those for having no
    /// termination proof.
    pub fn parse(bytes: []const u8) SkillDocError!SkillDoc {
        if (!std.mem.startsWith(u8, bytes, "---\n")) return SkillDocError.SkillDocMalformed;
        const rest = bytes["---\n".len..];
        const end = std.mem.indexOf(u8, rest, "\n---") orelse
            return SkillDocError.SkillDocMalformed;
        const front = rest[0..end];

        var doc: SkillDoc = .{ .name = "", .description = "", .probe_input = "", .expect_contains = "", .grounding = "" };
        var lines = std.mem.splitScalar(u8, front, '\n');
        while (lines.next()) |line| {
            const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
            const key = std.mem.trim(u8, line[0..colon], " \t");
            const val = std.mem.trim(u8, line[colon + 1 ..], " \t\"");
            if (std.mem.eql(u8, key, "name")) {
                doc.name = val;
            } else if (std.mem.eql(u8, key, "description")) {
                doc.description = val;
            } else if (std.mem.eql(u8, key, "probe_input")) {
                doc.probe_input = val;
            } else if (std.mem.eql(u8, key, "expect_contains")) {
                doc.expect_contains = val;
            } else if (std.mem.eql(u8, key, "grounding")) {
                doc.grounding = val;
            }
        }
        if (doc.name.len == 0 or doc.description.len == 0)
            return SkillDocError.SkillDocMalformed;
        // The generalized refusal. See the doc comment on this type.
        if (doc.expect_contains.len == 0) return SkillDocError.SkillDocUnfalsifiable;
        // A package that cannot say what it was built from is a claim with no
        // provenance: nothing to re-check when the thing it was built against
        // moves. Whether each citation still resolves is the gate's job — this
        // only refuses the empty case, the one no reader could ever chase.
        if (doc.grounding.len == 0) return SkillDocError.SkillDocUngrounded;
        return doc;
    }
};

/// Read and validate a package's SKILL.md. Fails closed: a package that cannot
/// say what it is for does not get admitted on the strength of compiling.
pub fn readSkillDoc(a: Allocator, io: std.Io, package_dir: []const u8) !SkillDoc {
    const path = try std.fs.path.join(a, &.{ package_dir, SKILL_DOC });
    const bytes = std.Io.Dir.cwd().readFileAlloc(io, path, a, .limited(1 << 20)) catch
        return SkillDocError.SkillDocMissing;
    return SkillDoc.parse(bytes);
}

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

    // EVERY regular file under the package root, not a curated list.
    //
    // This used to hash an allowlist: `neuron.json`, the argv entries that
    // looked like relative paths, `SKILL.md`, and everything under `schemas/`.
    // An adversarial audit found the hole that shape necessarily leaves. A
    // second module the entrypoint IMPORTS — `neurons/helper.py`, loaded by
    // `neurons/main.py` — is named by no argv, so it was in none of those sets.
    // Its bytes could be replaced wholesale and the digest never moved:
    // admission went on vouching for code it had never seen. Demonstrated with
    // a two-file package whose helper changed from a constant to anything at
    // all, both admissions returning the identical digest.
    //
    // An allowlist is the wrong shape for this job. The property §30 needs is
    // "code pinned to bytes that existed before the pin", and every path an
    // allowlist omits is an unpinned byte. A package IS its directory, so the
    // digest walks the whole thing; anything transient in there is a packaging
    // fault, not a reason to weaken the pin.
    var entries: std.ArrayList([]const u8) = .empty;
    // `.iterate` is required to walk the handle: without it the fd carries no
    // read capability and `walker.next` fails `BADF` on Linux. macOS tolerates
    // the omission, so every package carrying a subdirectory admitted there and
    // panicked here.
    var pkg_dir = cwd.openDir(io, package_dir, .{ .iterate = true }) catch
        return error.PackageIoError;
    defer pkg_dir.close(io);
    var walker = try pkg_dir.walk(a);
    defer walker.deinit();
    while (try walker.next(io)) |entry| {
        if (entry.kind != .file) continue;
        try entries.append(a, try a.dupe(u8, entry.path));
    }
    if (entries.items.len == 0) return error.InvalidManifest;
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

    // Refuse before pinning, not after. A package that cannot state what it is
    // supposed to do has nothing that could later be found false, so admitting
    // it would vouch for bytes on the strength of their compiling — the one
    // thing §30 says never earns retention.
    const skill = try readSkillDoc(a, io, package_dir);

    const digest = try computePackageDigest(a, io, package_dir);
    var hex: [64]u8 = undefined;
    _ = try std.fmt.bufPrint(&hex, "{s}", .{std.fmt.bytesToHex(digest, .lower)});

    var substrate = try substrate_mod.Substrate.initDir(allocator, io, std.Io.Dir.cwd(), state_dir);
    defer substrate.deinit();
    const runtime: runtime_mod.Runtime = .{ .substrate = &substrate };

    const manifest_path = try std.fs.path.join(a, &.{ package_dir, "neuron.json" });
    const manifest_bytes = try std.Io.Dir.cwd().readFileAlloc(io, manifest_path, a, .limited(1 << 20));
    const manifest_str = try std.json.Stringify.valueAlloc(a, manifest_bytes, .{});
    // The declared intent rides the admission row. A reader of the ledger can
    // then ask what this package CLAIMED to do at the moment it was pinned,
    // without trusting a file that may since have been edited — the digest
    // covers SKILL.md, so a changed claim is a different package entirely.
    const skill_name = try std.json.Stringify.valueAlloc(a, skill.name, .{});
    const skill_desc = try std.json.Stringify.valueAlloc(a, skill.description, .{});
    const skill_expect = try std.json.Stringify.valueAlloc(a, skill.expect_contains, .{});
    const skill_grounding = try std.json.Stringify.valueAlloc(a, skill.grounding, .{});
    const record_bytes = try std.fmt.allocPrint(a,
        \\{{"schema":"{s}","package":{s},"digest":"{s}","skill":{{"name":{s},"description":{s},"expect_contains":{s},"grounding":{s}}}}}
    , .{ ADMISSION_SCHEMA, manifest_str, &hex, skill_name, skill_desc, skill_expect, skill_grounding });

    const firing_id = try std.fmt.allocPrint(a, "admission/{s}", .{&hex});
    const write_id = try std.fmt.allocPrint(a, ADMISSION_PREFIX ++ "{s}", .{&hex});
    var fx: [2]types.Effect = .{
        .{ .write = .{ .id = write_id, .schema = ADMISSION_SCHEMA, .bytes = record_bytes } },
        .{ .send = .{
            .to = "event/neuron.limb-admission/v1",
            .schema = ADMISSION_SCHEMA,
            .payload = record_bytes,
            .durable = true,
        } },
    };
    const result = runtime.execute(.{
        .firing_id = firing_id,
        .receptor_schema = "neuron.limb-admission/v1",
    }, admissionCaps(), .{
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

/// The three checks that decide whether a limb package may run *at all*:
/// admitted under this digest, not revoked, not detached. Factored out of
/// `limbRun` because every caller that binds or dispatches a limb has to ask
/// the same question of the same substrate — a second copy of this predicate
/// is a second place for a revocation to be missed, and a revocation that is
/// missed on one path is not a revocation.
///
/// Returns the package `neuron.json` as parsed from the *admission record*,
/// not from disk. The admitted bytes are the pin; re-reading the directory
/// would let an edited package answer for a digest it no longer has.
pub fn liveAdmission(
    a: Allocator,
    substrate: *const substrate_mod.Substrate,
    hex: []const u8,
) !std.json.Value {
    const admission_id = try std.fmt.allocPrint(a, ADMISSION_PREFIX ++ "{s}", .{hex});
    const admission_artifact = substrate.artifacts.get(admission_id) orelse return error.LimbNotAdmitted;
    if (!std.mem.eql(u8, admission_artifact.schema, ADMISSION_SCHEMA)) return error.LimbNotAdmitted;
    const revoked_id = try std.fmt.allocPrint(a, REVOKED_PREFIX ++ "{s}", .{hex});
    if (substrate.artifacts.contains(revoked_id)) return error.LimbRevoked;
    const detached_id = try std.fmt.allocPrint(a, DETACHED_PREFIX ++ "{s}", .{hex});
    if (substrate.artifacts.contains(detached_id)) return error.LimbDetached;

    const admission = try std.json.parseFromSliceLeaky(std.json.Value, a, admission_artifact.bytes, .{});
    if (admission != .object) return error.CorruptAdmission;
    const package_field = admission.object.get("package") orelse return error.CorruptAdmission;
    if (package_field != .string) return error.CorruptAdmission;
    const manifest = try std.json.parseFromSliceLeaky(std.json.Value, a, package_field.string, .{});
    if (manifest != .object) return error.InvalidManifest;
    return manifest;
}

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
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const digest = try computePackageDigest(a, io, package_dir);
    var hex: [64]u8 = undefined;
    _ = try std.fmt.bufPrint(&hex, "{s}", .{std.fmt.bytesToHex(digest, .lower)});

    // The firing is one ownership region: parsed transport JSON, ScriptNeuron
    // output, staged reads, and replayed substrate all die with this arena.
    // This keeps leaky dynamic JSON parsing out of the process allocator.
    var substrate = try substrate_mod.Substrate.initDir(a, io, std.Io.Dir.cwd(), state_dir);
    defer substrate.deinit();

    const manifest = try liveAdmission(a, &substrate, &hex);
    const resolved = try run_mod.resolveNeuronArgv(a, manifest, package_dir, neuron_id);

    const cwd = std.Io.Dir.cwd();
    const stimulus_bytes = if (std.mem.eql(u8, stimulus_path, "-"))
        try readStdin(a, io)
    else
        try cwd.readFileAlloc(io, stimulus_path, a, .limited(1 << 20));
    const stimulus_json = try std.json.parseFromSliceLeaky(std.json.Value, a, stimulus_bytes, .{});
    if (stimulus_json != .object) return error.InvalidStimulus;
    const stimulus = try run_mod.stageStimulus(a, stimulus_json, &substrate);

    var implementation: script_mod.ScriptNeuron = .{
        .allocator = a,
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
    try printSummary(a, io, .{
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
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const digest = try computePackageDigest(a, io, package_dir);
    var hex: [64]u8 = undefined;
    _ = try std.fmt.bufPrint(&hex, "{s}", .{std.fmt.bytesToHex(digest, .lower)});

    var substrate = try substrate_mod.Substrate.initDir(a, io, std.Io.Dir.cwd(), state_dir);
    defer substrate.deinit();
    const runtime: runtime_mod.Runtime = .{ .substrate = &substrate };

    const admission_id = try std.fmt.allocPrint(a, ADMISSION_PREFIX ++ "{s}", .{&hex});
    const admission_artifact = substrate.artifacts.get(admission_id) orelse return error.LimbNotAdmitted;
    const admission = try std.json.parseFromSliceLeaky(std.json.Value, a, admission_artifact.bytes, .{});
    if (admission != .object) return error.CorruptAdmission;
    const package_field = admission.object.get("package") orelse return error.CorruptAdmission;
    if (package_field != .string) return error.CorruptAdmission;
    const manifest = try std.json.parseFromSliceLeaky(std.json.Value, a, package_field.string, .{});
    if (manifest != .object) return error.InvalidManifest;

    var prefixes: std.ArrayList([]const u8) = .empty;
    const neurons = manifest.object.get("neurons") orelse return error.InvalidManifest;
    if (neurons != .array) return error.InvalidManifest;
    for (neurons.array.items) |entry| {
        if (entry != .object) continue;
        const caps_req = entry.object.get("caps_request") orelse continue;
        const caps = script_mod.capsFromJson(caps_req) catch continue;
        if (caps.allow_write and caps.write_prefix.len > 0) try prefixes.append(a, caps.write_prefix);
    }
    // Attachment is topology data owned by the admitted digest. Detaching a
    // limb must remove its live edges as well as its runtime artifacts, while
    // the immutable admission/revocation/audit roots remain reachable.
    try prefixes.append(a, try std.fmt.allocPrint(
        a,
        "topology/edges/{s}/",
        .{&hex},
    ));
    if (prefixes.items.len == 0) return error.InvalidManifest;

    const detach_id = try std.fmt.allocPrint(a, DETACHED_PREFIX ++ "{s}", .{&hex});
    const firing_id = try std.fmt.allocPrint(a, "detachment/{s}", .{&hex});
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
    var writer = std.Io.File.stdout().writerStreaming(io, &out_buffer);
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

/// One committed firing as the journal recorded it. The trace projection reads
/// the raw log rather than the replayed substrate because evidence citations
/// are observability, not state: `validate` already consumed them, so replay
/// deliberately drops them and only the log still holds the derivation edges.
pub const TraceRecordJ = struct {
    schema: []const u8 = "",
    op: []const u8 = "",
    firing_id: []const u8 = "",
    now_ms: u64 = 0,
    committed_at_ms: i64 = 0,
    effects_committed: usize = 0,
    artifacts: []const struct {
        id: []const u8 = "",
        produced_by: []const u8 = "",
        /// Hex-encoded content, as `journalCommit` wrote it. Only the
        /// version-recovery projection reads it; the trace and staleness
        /// projections need identities and ordinals, not payloads.
        bytes: []const u8 = "",
    } = &.{},
    messages: []const struct { to: []const u8 = "" } = &.{},
    evidence: []const EvidenceView = &.{},
    /// Present only on a `snapshot` record: the folded firing table, carrying
    /// the commit ordinals and citations that let the projections keep working
    /// after `compact` has removed every per-commit record.
    firings: []const struct {
        firing_id: []const u8 = "",
        seq: u64 = 0,
        evidence: []const EvidenceView = &.{},
    } = &.{},
};

const EvidenceView = struct {
    claim: []const u8 = "",
    method: []const u8 = "",
    sources: []const []const u8 = &.{},
};

/// Read the journal as a sequence of committed firings, newest last. Pure read:
/// it opens the log directly and never takes the substrate's exclusive lock,
/// so tracing a live node cannot block or be blocked by it.
pub fn readJournal(allocator: Allocator, io: std.Io, state_dir: []const u8) ![]const u8 {
    const log_path = try std.fmt.allocPrint(allocator, "{s}/substrate.log", .{state_dir});
    defer allocator.free(log_path);
    const file = try std.Io.Dir.cwd().openFile(io, log_path, .{});
    defer file.close(io);
    const size = (try file.stat(io)).size;
    if (size == 0) return "";
    const bytes = try allocator.alloc(u8, @intCast(size));
    const n = try file.readPositionalAll(io, bytes, 0);
    return bytes[0..n];
}

/// Per-firing trace: what fired, when, what it cited, and what it produced.
/// The counterpart to `telemetryProject`'s aggregate counters — same source of
/// truth, one row per firing instead of one row per node.
pub fn telemetryTrace(allocator: Allocator, io: std.Io, state_dir: []const u8, json_out: bool) !void {
    const bytes = try readJournal(allocator, io, state_dir);
    defer if (bytes.len > 0) allocator.free(bytes);

    var out_buffer: [4096]u8 = undefined;
    var writer = std.Io.File.stdout().writerStreaming(io, &out_buffer);
    const w = &writer.interface;
    if (!json_out) try w.writeAll("firing_id                                          now_ms         cites  writes  sends\n");

    var first_ms: i64 = 0;
    var lines = std.mem.splitScalar(u8, bytes, '\n');
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        var arena = std.heap.ArenaAllocator.init(allocator);
        defer arena.deinit();
        const rec = std.json.parseFromSliceLeaky(TraceRecordJ, arena.allocator(), line, .{
            .ignore_unknown_fields = true,
        }) catch continue;
        if (std.mem.eql(u8, rec.op, "snapshot")) {
            // Folded firings still have identity, citations, and — via
            // `produced_by` — their writes. Timing does not survive: a wall
            // clock cannot enter a canonical snapshot (§28.1), so it is
            // reported unavailable rather than as `0`, which already means
            // "no caller set a clock" and would be a different lie.
            for (rec.firings) |firing| {
                var folded_cites: usize = 0;
                for (firing.evidence) |item| folded_cites += item.sources.len;
                var writes: usize = 0;
                for (rec.artifacts) |artifact| {
                    if (std.mem.eql(u8, artifact.produced_by, firing.firing_id)) writes += 1;
                }
                if (json_out) {
                    try w.writeAll("{\"schema\":\"neuron.trace/v1\",\"firing_id\":");
                    try std.json.Stringify.value(firing.firing_id, .{}, w);
                    try w.print(",\"seq\":{},\"timing\":\"unavailable\",\"cites\":{},\"writes\":{},\"from\":\"snapshot\"}}\n", .{
                        firing.seq, folded_cites, writes,
                    });
                } else {
                    try w.print("{s: <50} {s: >8}  {d: >12}  {d: >5}  {s: >5}\n", .{
                        firing.firing_id, "--", folded_cites, writes, "--",
                    });
                }
            }
            continue;
        }
        if (!std.mem.eql(u8, rec.op, "commit")) continue;

        var cites: usize = 0;
        for (rec.evidence) |item| cites += item.sources.len;
        // Elapsed is relative to the first committed firing in this log: an
        // absolute wall clock is not comparable across nodes, but the offset
        // within one log is. Journals written before `committed_at_ms` existed
        // report 0 rather than a fabricated duration.
        if (first_ms == 0) first_ms = rec.committed_at_ms;
        const elapsed: i64 = if (rec.committed_at_ms >= first_ms) rec.committed_at_ms - first_ms else 0;

        if (json_out) {
            try w.writeAll("{\"schema\":\"neuron.trace/v1\",\"firing_id\":");
            try std.json.Stringify.value(rec.firing_id, .{}, w);
            try w.print(",\"now_ms\":{},\"elapsed_ms\":{},\"cites\":{},\"writes\":{},\"sends\":{},\"effects\":{}", .{
                rec.now_ms, elapsed, cites, rec.artifacts.len, rec.messages.len, rec.effects_committed,
            });
            try w.writeAll(",\"sources\":[");
            var n: usize = 0;
            for (rec.evidence) |item| for (item.sources) |source| {
                if (n != 0) try w.writeAll(",");
                n += 1;
                try std.json.Stringify.value(source, .{}, w);
            };
            try w.writeAll("]}\n");
        } else {
            try w.print("{s: <50} {d: >8}  {d: >12}  {d: >5}  {d: >5}\n", .{
                rec.firing_id, elapsed, cites, rec.artifacts.len, rec.messages.len,
            });
        }
    }
    try w.flush();
}

/// Emit the stale rows a compacted journal still supports. Ordering comes from
/// the firing ordinals the snapshot preserved, so the answer matches what the
/// un-compacted log would have given.
///
/// `redrivable` cannot be recovered here: the snapshot keeps final artifact
/// state, not each firing's messages, so whether a producer crossed an
/// `outbox/` boundary is genuinely unknown. It is reported `false` — the
/// conservative direction, since re-driving a boundary-crossing firing repeats
/// a real-world effect, and a wrong `true` would cause one.
fn reportSnapshotStale(
    a: Allocator,
    rows: *std.ArrayList(StaleRow),
    rec: TraceRecordJ,
    last_write: std.StringHashMap(usize),
    firing_seq: std.StringHashMap(usize),
) !void {
    // A firing may cite many sources, so the lookup has to be firing → its
    // whole evidence set. Keeping one source per firing silently under-reports
    // every derivation that rested on more than one input.
    var cited = std.StringHashMap([]const EvidenceView).init(a);
    for (rec.firings) |firing| try cited.put(firing.firing_id, firing.evidence);

    for (rec.artifacts) |artifact| {
        const derived_at = firing_seq.get(artifact.produced_by) orelse continue;
        const evidence = cited.get(artifact.produced_by) orelse continue;
        for (evidence) |item| for (item.sources) |source| {
            if (std.mem.eql(u8, source, "stimulus")) continue;
            const moved = last_write.get(source) orelse continue;
            if (moved <= derived_at) continue;
            try rows.append(a, .{
                .artifact = artifact.id,
                .stale_source = source,
                .produced_by = artifact.produced_by,
                .derived_at = derived_at,
                .source_moved_at = moved,
                .redrivable = false,
                .from_snapshot = true,
                .crossed = "",
            });
        };
    }
}

/// One stale derivation, as `neuron.staleness/v1` describes it, plus the one
/// fact the wire form deliberately compresses into a bool: *which* external
/// address the producing firing crossed. A caller that only reports staleness
/// needs the bool; a caller that must decide what to do about it needs the
/// address, because "may not be re-fired" and "already told the world" are
/// different obligations (R10 case 2 vs case 3).
///
/// Every slice borrows the arena the journal was parsed into.
pub const StaleRow = struct {
    artifact: []const u8,
    stale_source: []const u8,
    produced_by: []const u8,
    derived_at: usize,
    source_moved_at: usize,
    redrivable: bool,
    from_snapshot: bool,
    /// The `outbox/` address this firing sent to, or empty. Empty with
    /// `redrivable == false` means the crossing is *unknown*, not absent —
    /// which is what a folded firing degrades to (§28.4).
    crossed: []const u8,
};

/// One row, in whichever form the caller asked for. Shared so the commit-record
/// and snapshot paths cannot drift into reporting the same fact differently.
fn emitStaleRow(w: *std.Io.Writer, row: StaleRow, json_out: bool) !void {
    if (json_out) {
        try w.writeAll("{\"schema\":\"neuron.staleness/v1\",\"artifact\":");
        try std.json.Stringify.value(row.artifact, .{}, w);
        try w.writeAll(",\"stale_source\":");
        try std.json.Stringify.value(row.stale_source, .{}, w);
        try w.writeAll(",\"produced_by\":");
        try std.json.Stringify.value(row.produced_by, .{}, w);
        try w.print(",\"derived_at\":{},\"source_moved_at\":{},\"redrivable\":{},\"from\":\"{s}\"}}\n", .{
            row.derived_at, row.source_moved_at, row.redrivable, if (row.from_snapshot) "snapshot" else "journal",
        });
    } else {
        try w.print("{s: <50} {s: <50} {}\n", .{ row.artifact, row.stale_source, row.redrivable });
    }
}

/// Staleness projection: which committed artifacts were derived from a source
/// that has since been rewritten.
///
/// An artifact written at journal position `i` by a firing that cited source
/// `s` is stale exactly when `s`'s last write lands at some `j > i` — the
/// derivation happened, and then an input moved underneath it. Journal order
/// is the only ordering used, so this needs no clock and is reproducible.
///
/// This is a *read*. It marks nothing and re-fires nothing, because re-firing
/// is only safe under gates this projection cannot enforce on its own: the
/// producing firing must have been writes-only (a firing with sends crossed a
/// boundary, so repeating it repeats an external effect, not a derivation).
/// `redrivable` reports that gate per row; acting on it is a separate step.
pub fn telemetryStale(allocator: Allocator, io: std.Io, state_dir: []const u8, json_out: bool) !void {
    const bytes = try readJournal(allocator, io, state_dir);
    defer if (bytes.len > 0) allocator.free(bytes);

    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const rows = try collectStale(a, bytes);

    var out_buffer: [4096]u8 = undefined;
    var writer = std.Io.File.stdout().writerStreaming(io, &out_buffer);
    const w = &writer.interface;
    if (!json_out) try w.writeAll("stale_artifact                                     stale_source                                       redrivable\n");
    for (rows) |row| try emitStaleRow(w, row, json_out);
    if (!json_out) try w.print("\n{d} stale derivation(s)\n", .{rows.len});
    try w.flush();
}

/// The staleness projection itself, separated from rendering so that the
/// re-derivation loop (`redrive`) decides from exactly the rows the operator
/// is shown. A second implementation of "which derivation went stale" would be
/// a second place for detection and action to disagree, and the whole point of
/// R10 is that they must not.
///
/// Rows borrow `a`; the caller owns the arena.
pub fn collectStale(a: Allocator, bytes: []const u8) ![]const StaleRow {
    var rows: std.ArrayList(StaleRow) = .empty;

    // Pass 1: the position at which each artifact id was last written.
    //
    // Two sources, because a compacted journal has no commit records left. A
    // commit record's position is its log offset; a snapshot's firings carry
    // an explicit `seq`, and an artifact's position is the seq of the firing
    // named in its `produced_by`. Both yield the same ordering, which is what
    // lets staleness survive `compact` (§28.4).
    var last_write = std.StringHashMap(usize).init(a);
    var firing_seq = std.StringHashMap(usize).init(a);
    var index: usize = 0;
    var pass1 = std.mem.splitScalar(u8, bytes, '\n');
    while (pass1.next()) |line| {
        if (line.len == 0) continue;
        const rec = std.json.parseFromSliceLeaky(TraceRecordJ, a, line, .{
            .ignore_unknown_fields = true,
        }) catch continue;
        if (std.mem.eql(u8, rec.op, "snapshot")) {
            for (rec.firings) |firing| try firing_seq.put(firing.firing_id, @intCast(firing.seq));
            for (rec.artifacts) |artifact| {
                const at = firing_seq.get(artifact.produced_by) orelse continue;
                try last_write.put(artifact.id, at);
            }
            // A snapshot folds every prior firing, so later commit records
            // continue past the highest ordinal it recorded.
            var it = firing_seq.valueIterator();
            while (it.next()) |value| index = @max(index, value.* + 1);
            continue;
        }
        if (!std.mem.eql(u8, rec.op, "commit")) continue;
        // 0-based, matching the firing ordinals a snapshot carries, so the
        // same derivation reports the same position before and after compact.
        for (rec.artifacts) |artifact| try last_write.put(artifact.id, index);
        index += 1;
    }

    // Pass 2: an artifact is stale when a source it cited moved after it.
    index = 0;
    var pass2 = std.mem.splitScalar(u8, bytes, '\n');
    while (pass2.next()) |line| {
        if (line.len == 0) continue;
        const rec = std.json.parseFromSliceLeaky(TraceRecordJ, a, line, .{
            .ignore_unknown_fields = true,
        }) catch continue;
        if (std.mem.eql(u8, rec.op, "snapshot")) {
            try reportSnapshotStale(a, &rows, rec, last_write, firing_seq);
            // Advance past every ordinal the snapshot folded, exactly as pass 1
            // does. Without this, commits appended after a compaction restart
            // numbering at zero and collide with the folded firings, so a
            // mixed-mode journal silently loses rows.
            for (rec.firings) |firing| index = @max(index, @as(usize, @intCast(firing.seq)) + 1);
            continue;
        }
        if (!std.mem.eql(u8, rec.op, "commit")) continue;
        const position = index;
        index += 1;
        // The re-derivation gate. What disqualifies a firing is crossing an
        // external boundary, which is an `outbox/` send — repeating that
        // repeats a real-world effect rather than recomputing a value.
        // Internal `event/` and `neuron/` traffic (settlement events, stage
        // hand-offs) is confined to this substrate and re-derives safely, so
        // gating on `messages.len == 0` would be conservative to the point of
        // marking every agent firing undrivable.
        var crossed: []const u8 = "";
        for (rec.messages) |message| {
            if (std.mem.startsWith(u8, message.to, "outbox/")) {
                crossed = message.to;
                break;
            }
        }
        for (rec.artifacts) |artifact| {
            // Only the artifact as it exists *now*. A version that was later
            // overwritten is not stale, it is gone — reporting it would invite
            // re-deriving bytes nothing can read. This is also what makes the
            // answer identical before and after `compact`, since a snapshot
            // keeps only final state and structurally cannot report the rest.
            if ((last_write.get(artifact.id) orelse position) != position) continue;
            for (rec.evidence) |item| {
                for (item.sources) |source| {
                    if (std.mem.eql(u8, source, "stimulus")) continue;
                    const moved = last_write.get(source) orelse continue;
                    if (moved <= position) continue;
                    try rows.append(a, .{
                        .artifact = artifact.id,
                        .stale_source = source,
                        .produced_by = rec.firing_id,
                        .derived_at = position,
                        .source_moved_at = moved,
                        .redrivable = crossed.len == 0,
                        .from_snapshot = false,
                        .crossed = crossed,
                    });
                }
            }
        }
    }
    return rows.items;
}

/// One version of one artifact, recovered from the journal.
pub const ArtifactVersion = struct {
    bytes: []const u8,
    digest: types.Digest,
    /// Commit ordinal of the write that produced it, on the same scale
    /// `StaleRow.derived_at` and `source_moved_at` use.
    at: usize,
};

/// The content an artifact held at commit ordinal `at` — the version a
/// derivation recorded at that ordinal actually read.
///
/// This lives beside `collectStale` because it must walk ordinals by exactly
/// the same rule; computing "position" a second time somewhere else is how the
/// before-image and the staleness row end up disagreeing about which version
/// moved. Returns null when the journal no longer carries the bytes — a
/// compacted log holds final state only, so a superseded version is genuinely
/// unrecoverable and must be reported missing rather than guessed at.
pub fn artifactVersionAt(a: Allocator, bytes: []const u8, id: []const u8, at: usize) !?ArtifactVersion {
    var found: ?ArtifactVersion = null;
    var index: usize = 0;
    var lines = std.mem.splitScalar(u8, bytes, '\n');
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        const rec = std.json.parseFromSliceLeaky(TraceRecordJ, a, line, .{
            .ignore_unknown_fields = true,
        }) catch continue;
        if (std.mem.eql(u8, rec.op, "snapshot")) {
            for (rec.firings) |firing| index = @max(index, @as(usize, @intCast(firing.seq)) + 1);
            continue;
        }
        if (!std.mem.eql(u8, rec.op, "commit")) continue;
        const position = index;
        index += 1;
        if (position > at) break;
        for (rec.artifacts) |artifact| {
            if (!std.mem.eql(u8, artifact.id, id)) continue;
            if (artifact.bytes.len % 2 != 0) continue;
            const raw = try a.alloc(u8, artifact.bytes.len / 2);
            _ = std.fmt.hexToBytes(raw, artifact.bytes) catch continue;
            found = .{ .bytes = raw, .digest = types.digest(raw), .at = position };
        }
    }
    return found;
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
    var writer = std.Io.File.stdout().writerStreaming(io, &out_buffer);
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

fn admissionCaps() caps_mod.Caps {
    return .{
        .allow_write = true,
        .write_prefix = ADMISSION_PREFIX,
        .allow_send = true,
        .send_prefix = "event/neuron.limb-admission/v1",
        .budget = .{
            .max_effects = 2,
            .max_writes = 1,
            .max_messages = 1,
            .max_spawns = 0,
        },
    };
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
    var writer = std.Io.File.stdout().writerStreaming(io, &buffer);
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
