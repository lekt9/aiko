//! Immutable Neuron Skill admission and activation on Contract's ledger.
//!
//! Skill bytes live in a content-addressed artifact store. This module stores
//! only identities, proof digests, gates, and lifecycle transitions. Generated
//! code is inert until `admit` and an authority-bearing `activate` transition.

const std = @import("std");
const ledger = @import("ledger.zig");

pub const TRANSITION_SCHEMA = "contract.neuron-skill.transition/v1";
pub const TRANSITION_RESULT_SCHEMA = "contract.neuron-skill.transition-result/v1";
pub const STATE_SCHEMA = "contract.neuron-skill.state/v1";
pub const STATE_RESULT_SCHEMA = "contract.neuron-skill.state-result/v1";
pub const MAX_ARTIFACT_BYTES: usize = 1024 * 1024;

pub const Error = error{
    InvalidJson,
    UnsupportedSchema,
    InvalidArtifact,
    InvalidProof,
    InvalidTransition,
    AdmissionDenied,
    AuthorityRequired,
    StateConflict,
    FiringConflict,
    OutOfMemory,
    LedgerFailure,
};

pub const State = enum {
    absent,
    candidate,
    admitted,
    active,
    retired,
};

pub const Artifact = struct {
    id: []const u8,
    version: []const u8,
    digest: []const u8,
    bytes: usize,
};

pub const Proofs = struct {
    manifest_digest: []const u8,
    instructions_digest: []const u8,
    eval_digest: []const u8,
    witness_digest: []const u8,
};

pub const Gates = struct {
    manifest_valid: bool,
    instructions_valid: bool,
    evals_passed: bool,
    witness_passed: bool,
    provenance_valid: bool,
    privacy_valid: bool,
    replay_valid: bool,
    rollback_ready: bool,
};

pub const TransitionRequest = struct {
    schema: []const u8,
    stimulus_id: []const u8,
    artifact: Artifact,
    action: []const u8,
    proofs: Proofs,
    gates: Gates,
    actor_digest: []const u8,
    authority: bool = false,
    supersedes_digest: ?[]const u8 = null,
    now_ms: u64,
};

pub const StateRequest = struct {
    schema: []const u8,
    artifact: Artifact,
};

const Projection = struct {
    state: State,
    active_digest: ?[]const u8,
};

pub fn transitionJson(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    request_json: []const u8,
) Error![]u8 {
    var parsed = std.json.parseFromSlice(TransitionRequest, allocator, request_json, .{
        .ignore_unknown_fields = false,
    }) catch return Error.InvalidJson;
    defer parsed.deinit();
    try validate(parsed.value);

    const transition_id = transitionId(parsed.value);
    const request_digest = requestDigest(parsed.value);
    const lock = ledger.acquireExclusive(allocator, env) catch return Error.LedgerFailure;
    defer ledger.releaseExclusive(lock);
    const scan = try scanLifecycle(allocator, env, parsed.value.artifact, &transition_id);

    if (scan.priorRequestDigest()) |prior| {
        if (!std.mem.eql(u8, prior, &request_digest)) return Error.FiringConflict;
        return encodeTransitionResult(
            allocator,
            "replayed",
            &transition_id,
            &request_digest,
            scan.state,
            scan.activeDigest(),
        );
    }

    const before: Projection = .{ .state = scan.state, .active_digest = scan.activeDigest() };
    const after = try decide(parsed.value, before);
    const row = encodeRow(
        allocator,
        parsed.value,
        &transition_id,
        &request_digest,
        before.state,
        after,
    ) catch return Error.OutOfMemory;
    defer allocator.free(row);
    const path = ledger.appendRow(allocator, env, row) catch return Error.LedgerFailure;
    allocator.free(path);
    const active_after = if (after == .active)
        parsed.value.artifact.digest
    else if (std.mem.eql(u8, parsed.value.action, "retire"))
        null
    else
        before.active_digest;
    return encodeTransitionResult(
        allocator,
        "committed",
        &transition_id,
        &request_digest,
        after,
        active_after,
    );
}

pub fn stateJson(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    request_json: []const u8,
) Error![]u8 {
    var parsed = std.json.parseFromSlice(StateRequest, allocator, request_json, .{
        .ignore_unknown_fields = false,
    }) catch return Error.InvalidJson;
    defer parsed.deinit();
    if (!std.mem.eql(u8, parsed.value.schema, STATE_SCHEMA)) return Error.UnsupportedSchema;
    try validateArtifact(parsed.value.artifact);
    const scan = try scanLifecycle(allocator, env, parsed.value.artifact, null);
    const projection: Projection = .{ .state = scan.state, .active_digest = scan.activeDigest() };
    return encodeStateResult(allocator, parsed.value.artifact, projection);
}

pub fn validate(request: TransitionRequest) Error!void {
    if (!std.mem.eql(u8, request.schema, TRANSITION_SCHEMA)) return Error.UnsupportedSchema;
    try validateArtifact(request.artifact);
    if (!safeToken(request.stimulus_id) or !validDigest(request.actor_digest) or request.now_ms == 0)
        return Error.InvalidTransition;
    if (!validDigest(request.proofs.manifest_digest) or
        !validDigest(request.proofs.instructions_digest) or
        !validDigest(request.proofs.eval_digest) or
        !validDigest(request.proofs.witness_digest)) return Error.InvalidProof;
    if (!knownAction(request.action)) return Error.InvalidTransition;
    if (request.supersedes_digest) |digest| {
        if (!validDigest(digest) or std.mem.eql(u8, digest, request.artifact.digest))
            return Error.InvalidTransition;
    }
    if (!request.gates.manifest_valid or !request.gates.instructions_valid)
        return Error.AdmissionDenied;
    if (std.mem.eql(u8, request.action, "admit") or
        std.mem.eql(u8, request.action, "activate") or
        std.mem.eql(u8, request.action, "rollback"))
    {
        if (!allAdmissionGates(request.gates) or
            zeroDigest(request.proofs.eval_digest) or
            zeroDigest(request.proofs.witness_digest)) return Error.AdmissionDenied;
    }
    if ((std.mem.eql(u8, request.action, "activate") or
        std.mem.eql(u8, request.action, "retire") or
        std.mem.eql(u8, request.action, "rollback")) and !request.authority)
        return Error.AuthorityRequired;
}

fn validateArtifact(artifact: Artifact) Error!void {
    if (!safeId(artifact.id) or !numericSemver(artifact.version) or
        !validDigest(artifact.digest) or artifact.bytes == 0 or
        artifact.bytes > MAX_ARTIFACT_BYTES) return Error.InvalidArtifact;
}

fn decide(request: TransitionRequest, before: Projection) Error!State {
    if (std.mem.eql(u8, request.action, "stage")) {
        if (before.state != .absent) return Error.StateConflict;
        return .candidate;
    }
    if (std.mem.eql(u8, request.action, "admit")) {
        if (before.state != .candidate) return Error.StateConflict;
        return .admitted;
    }
    if (std.mem.eql(u8, request.action, "activate")) {
        if (before.state != .admitted) return Error.StateConflict;
        if (before.active_digest) |active| {
            const supersedes = request.supersedes_digest orelse return Error.StateConflict;
            if (!std.mem.eql(u8, active, supersedes)) return Error.StateConflict;
        } else if (request.supersedes_digest != null) return Error.StateConflict;
        return .active;
    }
    if (std.mem.eql(u8, request.action, "retire")) {
        if (before.state != .active or before.active_digest == null or
            !std.mem.eql(u8, before.active_digest.?, request.artifact.digest))
            return Error.StateConflict;
        return .retired;
    }
    if (std.mem.eql(u8, request.action, "rollback")) {
        if (before.state != .retired and before.state != .admitted) return Error.StateConflict;
        const active = before.active_digest orelse return Error.StateConflict;
        const supersedes = request.supersedes_digest orelse return Error.StateConflict;
        if (!std.mem.eql(u8, active, supersedes)) return Error.StateConflict;
        return .active;
    }
    return Error.InvalidTransition;
}

const LifecycleScan = struct {
    artifact: Artifact,
    watch_transition: ?[]const u8 = null,
    state: State = .absent,
    active_buf: [64]u8 = undefined,
    active_len: usize = 0,
    has_active: bool = false,
    prior_buf: [64]u8 = undefined,
    prior_len: usize = 0,
    has_prior: bool = false,

    fn activeDigest(self: *const LifecycleScan) ?[]const u8 {
        if (!self.has_active) return null;
        return self.active_buf[0..self.active_len];
    }

    fn priorRequestDigest(self: *const LifecycleScan) ?[]const u8 {
        if (!self.has_prior) return null;
        return self.prior_buf[0..self.prior_len];
    }
};

fn lifecycleLine(opaque_ctx: *anyopaque, line: []const u8) void {
    const ctx: *LifecycleScan = @ptrCast(@alignCast(opaque_ctx));
    if (!isLifecycleRow(line)) return;
    // First transition row with the watched transition_id pins its
    // request_digest (replay dedupe) — same first-match rule as the retired
    // body scan.
    if (ctx.watch_transition) |watch| {
        if (!ctx.has_prior) {
            if (fieldString(line, "transition_id")) |candidate| {
                if (std.mem.eql(u8, candidate, watch)) {
                    if (fieldString(line, "request_digest")) |digest| {
                        if (digest.len <= ctx.prior_buf.len) {
                            @memcpy(ctx.prior_buf[0..digest.len], digest);
                            ctx.prior_len = digest.len;
                            ctx.has_prior = true;
                        }
                    }
                }
            }
        }
    }
    const id = fieldString(line, "skill_id") orelse return;
    if (!std.mem.eql(u8, id, ctx.artifact.id)) return;
    const digest = fieldString(line, "skill_digest") orelse return;
    const action = fieldString(line, "action") orelse return;
    const supersedes = fieldString(line, "supersedes_digest");
    if (std.mem.eql(u8, action, "activate") or std.mem.eql(u8, action, "rollback")) {
        if (digest.len <= ctx.active_buf.len) {
            @memcpy(ctx.active_buf[0..digest.len], digest);
            ctx.active_len = digest.len;
            ctx.has_active = true;
        }
    } else if (std.mem.eql(u8, action, "retire") and
        ctx.has_active and std.mem.eql(u8, ctx.activeDigest().?, digest))
    {
        ctx.has_active = false;
        ctx.active_len = 0;
    }
    if (supersedes) |prior| {
        if (std.mem.eql(u8, prior, ctx.artifact.digest)) ctx.state = .retired;
    }
    if (!std.mem.eql(u8, digest, ctx.artifact.digest)) return;
    ctx.state = if (std.mem.eql(u8, action, "stage"))
        .candidate
    else if (std.mem.eql(u8, action, "admit"))
        .admitted
    else if (std.mem.eql(u8, action, "activate") or std.mem.eql(u8, action, "rollback"))
        .active
    else if (std.mem.eql(u8, action, "retire"))
        .retired
    else
        ctx.state;
}

/// Streaming lifecycle projection — the same fold as the retired body scan,
/// replayed line-by-line so transitions work on stores past readAll's 16 MiB
/// cap. Digests are copied out of the reused line buffer.
fn scanLifecycle(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    artifact: Artifact,
    watch_transition: ?[]const u8,
) Error!LifecycleScan {
    var ctx: LifecycleScan = .{ .artifact = artifact, .watch_transition = watch_transition };
    ledger.forEachLine(allocator, env, &ctx, lifecycleLine) catch return Error.LedgerFailure;
    return ctx;
}

fn isLifecycleRow(line: []const u8) bool {
    const event = fieldString(line, "event") orelse return false;
    return std.mem.eql(u8, event, "neuron_skill_transition");
}

fn fieldString(line: []const u8, key: []const u8) ?[]const u8 {
    var marker_buf: [96]u8 = undefined;
    const marker = std.fmt.bufPrint(&marker_buf, "\"{s}\"", .{key}) catch return null;
    const key_start = std.mem.indexOf(u8, line, marker) orelse return null;
    const colon = std.mem.indexOfScalarPos(u8, line, key_start + marker.len, ':') orelse return null;
    const quote = std.mem.indexOfScalarPos(u8, line, colon + 1, '"') orelse return null;
    const end = std.mem.indexOfScalarPos(u8, line, quote + 1, '"') orelse return null;
    return line[quote + 1 .. end];
}

fn encodeRow(
    allocator: std.mem.Allocator,
    request: TransitionRequest,
    transition_id: []const u8,
    request_digest: []const u8,
    before: State,
    after: State,
) ![]u8 {
    const supersedes = request.supersedes_digest orelse "";
    return std.fmt.allocPrint(
        allocator,
        "{{\"event\":\"neuron_skill_transition\",\"schema\":\"{s}\"," ++
            "\"transition_id\":\"{s}\",\"request_digest\":\"{s}\"," ++
            "\"stimulus_id\":\"{s}\",\"skill_id\":\"{s}\",\"skill_version\":\"{s}\"," ++
            "\"skill_digest\":\"{s}\",\"artifact_bytes\":{d},\"action\":\"{s}\"," ++
            "\"prior_state\":\"{s}\",\"state\":\"{s}\",\"supersedes_digest\":\"{s}\"," ++
            "\"manifest_digest\":\"{s}\",\"instructions_digest\":\"{s}\"," ++
            "\"eval_digest\":\"{s}\",\"witness_digest\":\"{s}\"," ++
            "\"actor_digest\":\"{s}\",\"authority\":{s},\"now_ms\":{d}}}",
        .{
            TRANSITION_SCHEMA,
            transition_id,
            request_digest,
            request.stimulus_id,
            request.artifact.id,
            request.artifact.version,
            request.artifact.digest,
            request.artifact.bytes,
            request.action,
            @tagName(before),
            @tagName(after),
            supersedes,
            request.proofs.manifest_digest,
            request.proofs.instructions_digest,
            request.proofs.eval_digest,
            request.proofs.witness_digest,
            request.actor_digest,
            if (request.authority) "true" else "false",
            request.now_ms,
        },
    );
}

fn encodeTransitionResult(
    allocator: std.mem.Allocator,
    status: []const u8,
    transition_id: []const u8,
    request_digest: []const u8,
    state: State,
    active_digest: ?[]const u8,
) Error![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    out.print(
        allocator,
        "{{\"schema\":\"{s}\",\"status\":\"{s}\",\"transition_id\":\"{s}\"," ++
            "\"request_digest\":\"{s}\",\"state\":\"{s}\",\"active_digest\":",
        .{
            TRANSITION_RESULT_SCHEMA,
            status,
            transition_id,
            request_digest,
            @tagName(state),
        },
    ) catch return Error.OutOfMemory;
    if (active_digest) |digest| {
        out.print(allocator, "\"{s}\"", .{digest}) catch return Error.OutOfMemory;
    } else {
        out.appendSlice(allocator, "null") catch return Error.OutOfMemory;
    }
    out.append(allocator, '}') catch return Error.OutOfMemory;
    return out.toOwnedSlice(allocator) catch return Error.OutOfMemory;
}

fn encodeStateResult(
    allocator: std.mem.Allocator,
    artifact: Artifact,
    projection: Projection,
) Error![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    out.print(
        allocator,
        "{{\"schema\":\"{s}\",\"skill_id\":\"{s}\",\"skill_version\":\"{s}\"," ++
            "\"skill_digest\":\"{s}\",\"state\":\"{s}\",\"active_digest\":",
        .{ STATE_RESULT_SCHEMA, artifact.id, artifact.version, artifact.digest, @tagName(projection.state) },
    ) catch return Error.OutOfMemory;
    if (projection.active_digest) |digest| {
        out.print(allocator, "\"{s}\"", .{digest}) catch return Error.OutOfMemory;
    } else {
        out.appendSlice(allocator, "null") catch return Error.OutOfMemory;
    }
    out.append(allocator, '}') catch return Error.OutOfMemory;
    return out.toOwnedSlice(allocator) catch return Error.OutOfMemory;
}

fn transitionId(request: TransitionRequest) [64]u8 {
    var hash = std.crypto.hash.sha2.Sha256.init(.{});
    update(&hash, "contract.neuron-skill.transition-id.v1");
    update(&hash, request.stimulus_id);
    update(&hash, request.artifact.id);
    update(&hash, request.artifact.version);
    update(&hash, request.artifact.digest);
    return finish(&hash);
}

fn requestDigest(request: TransitionRequest) [64]u8 {
    var hash = std.crypto.hash.sha2.Sha256.init(.{});
    update(&hash, "contract.neuron-skill.transition-request.v1");
    update(&hash, request.stimulus_id);
    update(&hash, request.artifact.id);
    update(&hash, request.artifact.version);
    update(&hash, request.artifact.digest);
    hash.update(std.mem.asBytes(&request.artifact.bytes));
    update(&hash, request.action);
    update(&hash, request.proofs.manifest_digest);
    update(&hash, request.proofs.instructions_digest);
    update(&hash, request.proofs.eval_digest);
    update(&hash, request.proofs.witness_digest);
    update(&hash, request.actor_digest);
    const gates = [_]bool{
        request.gates.manifest_valid,
        request.gates.instructions_valid,
        request.gates.evals_passed,
        request.gates.witness_passed,
        request.gates.provenance_valid,
        request.gates.privacy_valid,
        request.gates.replay_valid,
        request.gates.rollback_ready,
        request.authority,
    };
    for (gates) |gate| hash.update(&.{@intFromBool(gate)});
    if (request.supersedes_digest) |digest| update(&hash, digest);
    return finish(&hash);
}

fn update(hash: *std.crypto.hash.sha2.Sha256, value: []const u8) void {
    hash.update(std.mem.asBytes(&value.len));
    hash.update(value);
}

fn finish(hash: *std.crypto.hash.sha2.Sha256) [64]u8 {
    var digest: [32]u8 = undefined;
    hash.final(&digest);
    return std.fmt.bytesToHex(digest, .lower);
}

fn allAdmissionGates(gates: Gates) bool {
    return gates.manifest_valid and gates.instructions_valid and gates.evals_passed and
        gates.witness_passed and gates.provenance_valid and gates.privacy_valid and
        gates.replay_valid and gates.rollback_ready;
}

fn knownAction(action: []const u8) bool {
    return std.mem.eql(u8, action, "stage") or std.mem.eql(u8, action, "admit") or
        std.mem.eql(u8, action, "activate") or std.mem.eql(u8, action, "retire") or
        std.mem.eql(u8, action, "rollback");
}

fn safeToken(value: []const u8) bool {
    if (value.len == 0 or value.len > 128) return false;
    for (value) |byte| {
        if (!std.ascii.isAlphanumeric(byte) and byte != '.' and byte != '_' and byte != '-' and
            byte != ':' and byte != '/') return false;
    }
    return true;
}

fn safeId(value: []const u8) bool {
    if (value.len == 0 or value.len > 64 or value[0] == '-' or value[value.len - 1] == '-')
        return false;
    for (value) |byte| {
        if (!std.ascii.isLower(byte) and !std.ascii.isDigit(byte) and byte != '-') return false;
    }
    return true;
}

fn numericSemver(value: []const u8) bool {
    var parts = std.mem.splitScalar(u8, value, '.');
    var count: usize = 0;
    while (parts.next()) |part| {
        count += 1;
        if (part.len == 0) return false;
        for (part) |byte| if (!std.ascii.isDigit(byte)) return false;
    }
    return count == 3;
}

fn validDigest(value: []const u8) bool {
    if (value.len != 64) return false;
    for (value) |byte| {
        if (!std.ascii.isDigit(byte) and (byte < 'a' or byte > 'f')) return false;
    }
    return true;
}

fn zeroDigest(value: []const u8) bool {
    for (value) |byte| if (byte != '0') return false;
    return true;
}

const digest_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const digest_b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const digest_c = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const digest_d = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

fn fixture(action: []const u8) TransitionRequest {
    return .{
        .schema = TRANSITION_SCHEMA,
        .stimulus_id = "turn-1",
        .artifact = .{ .id = "generated-limb", .version = "1.0.0", .digest = digest_a, .bytes = 512 },
        .action = action,
        .proofs = .{
            .manifest_digest = digest_b,
            .instructions_digest = digest_c,
            .eval_digest = digest_d,
            .witness_digest = digest_b,
        },
        .gates = .{
            .manifest_valid = true,
            .instructions_valid = true,
            .evals_passed = true,
            .witness_passed = true,
            .provenance_valid = true,
            .privacy_valid = true,
            .replay_valid = true,
            .rollback_ready = true,
        },
        .actor_digest = digest_c,
        .now_ms = 1,
    };
}

test "transition validation is typed, bounded, and authority gated" {
    try validate(fixture("stage"));
    var request = fixture("activate");
    try std.testing.expectError(Error.AuthorityRequired, validate(request));
    request.authority = true;
    try validate(request);
    request.artifact.bytes = MAX_ARTIFACT_BYTES + 1;
    try std.testing.expectError(Error.InvalidArtifact, validate(request));
    request = fixture("admit");
    request.gates.replay_valid = false;
    try std.testing.expectError(Error.AdmissionDenied, validate(request));
}

test "ledger projection supports replacement retirement and rollback" {
    const body =
        "{\"event\":\"neuron_skill_transition\",\"skill_id\":\"generated-limb\",\"skill_digest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"action\":\"stage\",\"supersedes_digest\":\"\"}\n" ++
        "{\"event\":\"neuron_skill_transition\",\"skill_id\":\"generated-limb\",\"skill_digest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"action\":\"admit\",\"supersedes_digest\":\"\"}\n" ++
        "{\"event\":\"neuron_skill_transition\",\"skill_id\":\"generated-limb\",\"skill_digest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"action\":\"activate\",\"supersedes_digest\":\"\"}\n" ++
        "{\"event\":\"neuron_skill_transition\",\"skill_id\":\"generated-limb\",\"skill_digest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"action\":\"activate\",\"supersedes_digest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}\n" ++
        "{\"event\":\"neuron_skill_transition\",\"skill_id\":\"generated-limb\",\"skill_digest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"action\":\"rollback\",\"supersedes_digest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}\n";
    const old = fixture("rollback").artifact;
    const old_projection = projectBody(body, old);
    try std.testing.expectEqual(State.active, old_projection.state);
    try std.testing.expectEqualStrings(digest_a, old_projection.activeDigest().?);
    var replacement = old;
    replacement.digest = digest_b;
    const replacement_projection = projectBody(body, replacement);
    try std.testing.expectEqual(State.retired, replacement_projection.state);
    try std.testing.expectEqualStrings(digest_a, replacement_projection.activeDigest().?);
}

/// Fold a synthetic ledger body through the streaming lifecycle callback —
/// same projection the ledger scan produces, without touching the filesystem.
fn projectBody(body: []const u8, artifact: Artifact) LifecycleScan {
    var ctx: LifecycleScan = .{ .artifact = artifact };
    var lines = std.mem.splitScalar(u8, body, '\n');
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        lifecycleLine(&ctx, line);
    }
    return ctx;
}

test "transition identity detects changed intent within one stimulus" {
    const first = fixture("stage");
    var changed = first;
    changed.action = "admit";
    try std.testing.expectEqualSlices(u8, &transitionId(first), &transitionId(changed));
    try std.testing.expect(!std.mem.eql(u8, &requestDigest(first), &requestDigest(changed)));
}
