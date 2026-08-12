//! Contract-owned GraphHarness admission attestation.
//!
//! The caller names only the durable graph identity it expects. Evidence,
//! verdict references, ledger reference, clock and signing identity are projected
//! here from the append-only Contract ledger and deployment bootstrap.

const std = @import("std");
const artifact = @import("artifact.zig");
const ledger = @import("ledger.zig");
const common = @import("skill_execution/common.zig");
const Ed25519 = std.crypto.sign.Ed25519;

pub const ISSUE_SCHEMA = "contract.graph-harness-attestation.issue/v1";
pub const ATTESTATION_SCHEMA = "graph-harness-attestation/v1";
const MAX_NODES = common.MAX_NODES;

pub const Error = error{
    InvalidJson,
    InvalidRequest,
    Incomplete,
    Mismatch,
    SelfJudge,
    Stale,
    SigningBootstrap,
    LedgerFailure,
    OutOfMemory,
};

const Verdict = struct {
    digest: []const u8,
    evaluator: []const u8,
    verdict: []const u8,
};
const Descriptor = struct { ref: []const u8, digest: []const u8 };

const Node = struct {
    id: []const u8,
    key: []const u8,
    depends_on: []const u8,
    requirements: []const u8,
    cell_digest: []const u8,
    witness_id: []const u8,
    witness_digest: []const u8,
    judge_digest: []const u8,
    settled: bool = false,
    bad_settlement: bool = false,
    evidence_digest: []const u8 = "",
    firing_id: []const u8 = "",
    witness: ?Verdict = null,
    judge: ?Verdict = null,
};
const Scan = struct {
    allocator: std.mem.Allocator,
    root_id: []const u8,
    graph_digest: []const u8,
    subject_digest: []const u8,
    transitive_digest: []const u8,
    admissions: usize = 0,
    mismatch_admission: bool = false,
    revoked: bool = false,
    ledger_ref: []const u8 = "",
    nodes: std.ArrayList(Node) = .empty,
    issued_statement: ?[]const u8 = null,
    issued_key_id: ?[]const u8 = null,
    parse_failed: bool = false,
};

fn str(object: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    return common.objectString(object, key);
}
fn validWitnessId(value: []const u8) bool {
    if (value.len == 0 or value.len > 64 or !std.ascii.isLower(value[0])) return false;
    var previous_hyphen = false;
    for (value) |byte| {
        const hyphen = byte == '-';
        if (!std.ascii.isLower(byte) and !std.ascii.isDigit(byte) and !hyphen) return false;
        if (hyphen and previous_hyphen) return false;
        previous_hyphen = hyphen;
    }
    return !previous_hyphen;
}
fn hasRequirement(encoded: []const u8, wanted: []const u8) bool {
    var parsed = std.json.parseFromSlice(std.json.Value, std.heap.page_allocator, encoded, .{}) catch return false;
    defer parsed.deinit();
    if (parsed.value != .array) return false;
    for (parsed.value.array.items) |item| if (item == .string and std.mem.eql(u8, item.string, wanted)) return true;
    return false;
}
fn verdictFrom(value: std.json.Value) ?Verdict {
    if (value != .object or value.object.count() != 3) return null;
    const result: Verdict = .{
        .digest = str(value.object, "digest") orelse return null,
        .evaluator = str(value.object, "evaluator") orelse return null,
        .verdict = str(value.object, "verdict") orelse return null,
    };
    if (!artifact.validDigest(result.digest) or !common.safeToken(result.evaluator) or
        !std.mem.eql(u8, result.verdict, "pass")) return null;
    return result;
}
fn findNode(scan: *Scan, id: []const u8) ?*Node {
    for (scan.nodes.items) |*node| if (std.mem.eql(u8, node.id, id)) return node;
    return null;
}

fn scanValue(scan: *Scan, value: std.json.Value) !void {
    if (value != .object) return;
    const object = value.object;
    const event = str(object, "event") orelse return;
    if (std.mem.eql(u8, event, "neuron_transaction")) {
        const rows = object.get("rows") orelse return;
        if (rows != .array) return;
        for (rows.array.items) |row| try scanValue(scan, row);
        return;
    }
    if (std.mem.eql(u8, event, "neuron_skill_graph_admitted") and
        std.mem.eql(u8, str(object, "root_id") orelse "", scan.root_id))
    {
        const digest = str(object, "graph_digest") orelse return;
        if (!std.mem.eql(u8, digest, scan.graph_digest)) {
            // Historical superseded graphs do not stale a later identity. Only
            // an admission after the requested identity makes this issuance stale.
            if (scan.admissions > 0) scan.mismatch_admission = true;
            return;
        }
        const gh = object.get("graph_harness") orelse return;
        if (gh != .object or
            !std.mem.eql(u8, str(gh.object, "subject_digest") orelse "", scan.subject_digest) or
            !std.mem.eql(u8, str(gh.object, "transitive_digest") orelse "", scan.transitive_digest) or
            !std.mem.eql(u8, str(gh.object, "api_version") orelse "", "graph-harness/v1")) return;
        scan.admissions += 1;
        scan.ledger_ref = try std.fmt.allocPrint(scan.allocator, "ledger:neuron_skill_graph_admitted:{s}:{s}", .{ scan.root_id, scan.graph_digest });
        return;
    }
    if ((std.mem.eql(u8, event, "graph_harness_revoked") or
        std.mem.eql(u8, event, "neuron_skill_graph_invalidated")) and
        std.mem.eql(u8, str(object, "root_id") orelse "", scan.root_id) and
        std.mem.eql(u8, str(object, "graph_digest") orelse "", scan.graph_digest))
    {
        scan.revoked = true;
        return;
    }
    if (std.mem.eql(u8, event, "declared") and
        std.mem.eql(u8, str(object, "parent_id") orelse "", scan.root_id) and
        std.mem.eql(u8, str(object, "graph_digest") orelse "", scan.graph_digest) and
        std.mem.eql(u8, str(object, "execution_model") orelse "", "typed_neuron_skill_node"))
    {
        if (scan.nodes.items.len >= MAX_NODES) return Error.Incomplete;
        const node: Node = .{
            .id = str(object, "id") orelse return Error.Incomplete,
            .key = str(object, "graph_key") orelse return Error.Incomplete,
            .depends_on = str(object, "depends_on") orelse return Error.Incomplete,
            .requirements = str(object, "evidence_requirements") orelse return Error.Incomplete,
            .cell_digest = str(object, "cell_digest") orelse return Error.Incomplete,
            .witness_id = str(object, "witness_id") orelse return Error.Incomplete,
            .witness_digest = str(object, "witness_digest") orelse return Error.Incomplete,
            .judge_digest = str(object, "judge_digest") orelse return Error.Incomplete,
        };
        if (!artifact.validDigest(node.cell_digest) or !validWitnessId(node.witness_id) or !artifact.validDigest(node.witness_digest) or
            !artifact.validDigest(node.judge_digest) or std.mem.eql(u8, node.witness_digest, node.judge_digest))
            return Error.Mismatch;
        try scan.nodes.append(scan.allocator, node);
        return;
    }
    if (std.mem.eql(u8, event, "neuron_skill_node_settled") and
        std.mem.eql(u8, str(object, "root_id") orelse "", scan.root_id) and
        std.mem.eql(u8, str(object, "graph_digest") orelse "", scan.graph_digest))
    {
        const node = findNode(scan, str(object, "node_id") orelse return) orelse return;
        if (node.settled or node.bad_settlement) {
            node.bad_settlement = true;
            return;
        }
        if (!std.mem.eql(u8, str(object, "outcome") orelse "", "satisfied")) {
            node.bad_settlement = true;
            return;
        }
        const evidence_digest = str(object, "evidence_digest") orelse {
            node.bad_settlement = true;
            return;
        };
        const firing_id = str(object, "firing_id") orelse {
            node.bad_settlement = true;
            return;
        };
        const payload = object.get("evidence_payload") orelse {
            node.bad_settlement = true;
            return;
        };
        if (!artifact.validDigest(evidence_digest) or !artifact.validDigest(firing_id) or payload != .object) {
            node.bad_settlement = true;
            return;
        }
        const witness_value = payload.object.get("witness_verdict") orelse {
            node.bad_settlement = true;
            return;
        };
        const judge_value = payload.object.get("judge_verdict") orelse {
            node.bad_settlement = true;
            return;
        };
        node.witness = verdictFrom(witness_value) orelse {
            node.bad_settlement = true;
            return;
        };
        node.judge = verdictFrom(judge_value) orelse {
            node.bad_settlement = true;
            return;
        };
        node.evidence_digest = evidence_digest;
        node.firing_id = firing_id;
        node.settled = true;
        return;
    }
    if (std.mem.eql(u8, event, "graph_harness_attestation_issued") and
        std.mem.eql(u8, str(object, "root_id") orelse "", scan.root_id) and
        std.mem.eql(u8, str(object, "graph_digest") orelse "", scan.graph_digest) and
        std.mem.eql(u8, str(object, "subject_digest") orelse "", scan.subject_digest) and
        std.mem.eql(u8, str(object, "transitive_digest") orelse "", scan.transitive_digest))
    {
        if (scan.issued_statement != null) {
            scan.parse_failed = true;
            return;
        }
        scan.issued_statement = str(object, "statement_json") orelse {
            scan.parse_failed = true;
            return;
        };
        scan.issued_key_id = str(object, "key_id") orelse {
            scan.parse_failed = true;
            return;
        };
    }
}
fn scanLine(opaque_ctx: *anyopaque, line: []const u8) void {
    const scan: *Scan = @ptrCast(@alignCast(opaque_ctx));
    if (scan.parse_failed) return;
    const parsed = std.json.parseFromSlice(std.json.Value, scan.allocator, line, .{
        .allocate = .alloc_always,
    }) catch return;
    scanValue(scan, parsed.value) catch {
        scan.parse_failed = true;
    };
}

fn appendString(out: *std.ArrayList(u8), allocator: std.mem.Allocator, value: []const u8) Error!void {
    common.appendJsonString(out, allocator, value) catch return Error.OutOfMemory;
}
fn readPinnedFile(allocator: std.mem.Allocator, path: []const u8, expected_size: ?usize) Error![]u8 {
    if (@import("builtin").os.tag == .windows or !std.fs.path.isAbsolute(path)) return Error.SigningBootstrap;
    const io = std.Io.Threaded.global_single_threaded.io();
    const stat = std.Io.Dir.cwd().statFile(io, path, .{ .follow_symlinks = false }) catch return Error.SigningBootstrap;
    if (stat.kind != .file or stat.permissions.toMode() & 0o400 == 0 or stat.size > 4096 or
        (expected_size != null and stat.size != expected_size.?)) return Error.SigningBootstrap;
    const path_z = allocator.dupeZ(u8, path) catch return Error.OutOfMemory;
    defer allocator.free(path_z);
    var flags: std.c.O = .{};
    flags.ACCMODE = .RDONLY;
    flags.NOFOLLOW = true;
    const fd = std.c.open(path_z.ptr, flags, @as(c_uint, 0));
    if (fd < 0) return Error.SigningBootstrap;
    defer _ = std.c.close(fd);
    const bytes = allocator.alloc(u8, @intCast(stat.size)) catch return Error.OutOfMemory;
    errdefer allocator.free(bytes);
    var offset: usize = 0;
    while (offset < bytes.len) {
        const count = std.c.read(fd, bytes[offset..].ptr, bytes.len - offset);
        if (count <= 0) return Error.SigningBootstrap;
        offset += @intCast(count);
    }
    var extra: [1]u8 = undefined;
    if (std.c.read(fd, &extra, 1) != 0) return Error.SigningBootstrap;
    return bytes;
}
fn verifierDer(allocator: std.mem.Allocator, env: std.process.Environ) Error![44]u8 {
    const path = env.getPosix("AIKO_CONTRACT_VERIFY_KEY") orelse return Error.SigningBootstrap;
    const pem = try readPinnedFile(allocator, path, null);
    defer allocator.free(pem);
    const begin = "-----BEGIN PUBLIC KEY-----";
    const end = "-----END PUBLIC KEY-----";
    const start = (std.mem.indexOf(u8, pem, begin) orelse return Error.SigningBootstrap) + begin.len;
    const stop = std.mem.indexOfPos(u8, pem, start, end) orelse return Error.SigningBootstrap;
    var encoded: [128]u8 = undefined;
    var count: usize = 0;
    for (pem[start..stop]) |byte| {
        if (std.ascii.isWhitespace(byte)) continue;
        if (count == encoded.len) return Error.SigningBootstrap;
        encoded[count] = byte;
        count += 1;
    }
    if ((std.base64.standard.Decoder.calcSizeForSlice(encoded[0..count]) catch return Error.SigningBootstrap) != 44)
        return Error.SigningBootstrap;
    var der: [44]u8 = undefined;
    std.base64.standard.Decoder.decode(&der, encoded[0..count]) catch return Error.SigningBootstrap;
    const prefix = [_]u8{ 0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00 };
    if (!std.mem.eql(u8, der[0..12], &prefix)) return Error.SigningBootstrap;
    return der;
}
fn signingIdentity(allocator: std.mem.Allocator, env: std.process.Environ) Error!struct { pair: Ed25519.KeyPair, key_id: [71]u8 } {
    const seed_path = env.getPosix("AIKO_CONTRACT_ATTESTATION_SIGNING_KEY") orelse return Error.SigningBootstrap;
    const seed_bytes = try readPinnedFile(allocator, seed_path, 32);
    defer allocator.free(seed_bytes);
    var seed: [32]u8 = undefined;
    @memcpy(&seed, seed_bytes);
    const pair = Ed25519.KeyPair.generateDeterministic(seed) catch return Error.SigningBootstrap;
    const der = try verifierDer(allocator, env);
    if (!std.mem.eql(u8, der[12..44], &pair.public_key.bytes)) return Error.SigningBootstrap;
    var raw: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(&der, &raw, .{});
    var key_id: [71]u8 = undefined;
    @memcpy(key_id[0..7], "sha256:");
    _ = std.fmt.bufPrint(key_id[7..], "{x}", .{raw}) catch unreachable;
    return .{ .pair = pair, .key_id = key_id };
}

fn validateCoverage(scan: *Scan, expected_witness: []const u8, expected_judge: []const u8) Error!void {
    if (scan.parse_failed or scan.admissions != 1 or scan.nodes.items.len == 0) return Error.Incomplete;
    if (scan.mismatch_admission or scan.revoked) return Error.Stale;
    var north: ?*Node = null;
    for (scan.nodes.items, 0..) |*node, index| {
        for (scan.nodes.items[0..index]) |prior| {
            if (std.mem.eql(u8, prior.witness_id, node.witness_id) or
                std.mem.eql(u8, prior.evidence_digest, node.evidence_digest)) return Error.Mismatch;
        }
        if (!node.settled or node.bad_settlement or node.witness == null or node.judge == null) return Error.Incomplete;
        if (!hasRequirement(node.requirements, "cell_manifest") or
            !hasRequirement(node.requirements, "witness_verdict") or
            !hasRequirement(node.requirements, "judge_verdict")) return Error.Incomplete;
        if (!std.mem.eql(u8, node.witness.?.digest, node.witness_digest) or
            !std.mem.eql(u8, node.judge.?.digest, node.judge_digest)) return Error.Mismatch;
        if (std.mem.eql(u8, node.witness.?.evaluator, node.judge.?.evaluator)) return Error.SelfJudge;
        if (std.mem.eql(u8, node.key, "__graph_harness_north_star")) north = node;
    }
    const ns = north orelse return Error.Incomplete;
    if (!std.mem.eql(u8, ns.witness_digest, expected_witness) or
        !std.mem.eql(u8, ns.judge_digest, expected_judge)) return Error.Mismatch;
    var deps = std.json.parseFromSlice(std.json.Value, std.heap.page_allocator, ns.depends_on, .{}) catch return Error.Incomplete;
    defer deps.deinit();
    if (deps.value != .array or deps.value.array.items.len + 1 != scan.nodes.items.len) return Error.Incomplete;
    for (scan.nodes.items) |node| {
        if (std.mem.eql(u8, node.key, ns.key)) continue;
        var covered = false;
        for (deps.value.array.items) |item| if (item == .string and std.mem.eql(u8, item.string, node.key)) {
            covered = true;
            break;
        };
        if (!covered) return Error.Incomplete;
    }
}

fn appendDigest(out: *std.ArrayList(u8), allocator: std.mem.Allocator, value: []const u8) Error!void {
    out.appendSlice(allocator, "{\"algorithm\":\"sha256\",\"value\":") catch return Error.OutOfMemory;
    try appendString(out, allocator, value);
    out.append(allocator, '}') catch return Error.OutOfMemory;
}
fn canonicalBlank(
    allocator: std.mem.Allocator,
    scan: *Scan,
    admitted_by: Descriptor,
    key_id: []const u8,
    admitted_at: []const u8,
) Error![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    out.appendSlice(allocator, "{\"admitted_at\":") catch return Error.OutOfMemory;
    try appendString(&out, allocator, admitted_at);
    out.appendSlice(allocator, ",\"admitted_by\":{\"digest\":") catch return Error.OutOfMemory;
    try appendDigest(&out, allocator, admitted_by.digest);
    out.appendSlice(allocator, ",\"ref\":") catch return Error.OutOfMemory;
    try appendString(&out, allocator, admitted_by.ref);
    out.appendSlice(allocator, "},\"api_version\":\"graph-harness-attestation/v1\",\"authentication\":{\"algorithm\":\"ed25519\",\"key_id\":") catch return Error.OutOfMemory;
    try appendString(&out, allocator, key_id);
    out.appendSlice(allocator, ",\"value\":\"\"},\"evidence_refs\":[") catch return Error.OutOfMemory;
    for (scan.nodes.items, 0..) |node, index| {
        if (index > 0) out.append(allocator, ',') catch return Error.OutOfMemory;
        const evidence_ref = std.fmt.allocPrint(allocator, "artifact:{s}", .{node.evidence_digest}) catch return Error.OutOfMemory;
        defer allocator.free(evidence_ref);
        try appendString(&out, allocator, evidence_ref);
    }
    out.appendSlice(allocator, "],\"kind\":\"GraphHarnessAdmissionAttestation\",\"ledger_ref\":") catch return Error.OutOfMemory;
    try appendString(&out, allocator, scan.ledger_ref);
    out.appendSlice(allocator, ",\"owner\":\"contract\",\"subject_digest\":") catch return Error.OutOfMemory;
    try appendDigest(&out, allocator, scan.subject_digest);
    out.appendSlice(allocator, ",\"transitive_digest\":") catch return Error.OutOfMemory;
    try appendDigest(&out, allocator, scan.transitive_digest);
    out.appendSlice(allocator, ",\"verdicts\":[") catch return Error.OutOfMemory;
    for (scan.nodes.items, 0..) |node, index| {
        if (index > 0) out.append(allocator, ',') catch return Error.OutOfMemory;
        const evidence_ref = std.fmt.allocPrint(allocator, "artifact:{s}", .{node.evidence_digest}) catch return Error.OutOfMemory;
        defer allocator.free(evidence_ref);
        const judge_ref = std.fmt.allocPrint(allocator, "cas:{s}", .{node.judge_digest}) catch return Error.OutOfMemory;
        defer allocator.free(judge_ref);
        out.appendSlice(allocator, "{\"judge\":{\"digest\":") catch return Error.OutOfMemory;
        try appendDigest(&out, allocator, node.judge_digest);
        out.appendSlice(allocator, ",\"ref\":") catch return Error.OutOfMemory;
        try appendString(&out, allocator, judge_ref);
        out.appendSlice(allocator, "},\"verdict_ref\":") catch return Error.OutOfMemory;
        try appendString(&out, allocator, evidence_ref);
        out.appendSlice(allocator, ",\"witness_id\":") catch return Error.OutOfMemory;
        try appendString(&out, allocator, node.witness_id);
        out.append(allocator, '}') catch return Error.OutOfMemory;
    }
    out.appendSlice(allocator, "]}") catch return Error.OutOfMemory;
    return out.toOwnedSlice(allocator) catch Error.OutOfMemory;
}

pub fn issueJson(allocator: std.mem.Allocator, env: std.process.Environ, request_json: []const u8) Error![]u8 {
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, request_json, .{}) catch return Error.InvalidJson;
    defer parsed.deinit();
    if (parsed.value != .object or parsed.value.object.count() != 8) return Error.InvalidRequest;
    const request = parsed.value.object;
    if (!std.mem.eql(u8, str(request, "schema") orelse "", ISSUE_SCHEMA)) return Error.InvalidRequest;
    const root_id = str(request, "root_id") orelse return Error.InvalidRequest;
    const graph_digest = str(request, "graph_digest") orelse return Error.InvalidRequest;
    const subject_digest = str(request, "subject_digest") orelse return Error.InvalidRequest;
    const transitive_digest = str(request, "transitive_digest") orelse return Error.InvalidRequest;
    const expected_witness = str(request, "expected_witness_digest") orelse return Error.InvalidRequest;
    const expected_judge = str(request, "expected_judge_digest") orelse return Error.InvalidRequest;
    const admitted_value = request.get("admitted_by") orelse return Error.InvalidRequest;
    if (admitted_value != .object or admitted_value.object.count() != 2) return Error.InvalidRequest;
    const admitted_ref = str(admitted_value.object, "ref") orelse return Error.InvalidRequest;
    const admitted_digest_value = admitted_value.object.get("digest") orelse return Error.InvalidRequest;
    if (admitted_digest_value != .object or admitted_digest_value.object.count() != 2 or
        !std.mem.eql(u8, str(admitted_digest_value.object, "algorithm") orelse "", "sha256")) return Error.InvalidRequest;
    const admitted_digest = str(admitted_digest_value.object, "value") orelse return Error.InvalidRequest;
    const admitted_by: Descriptor = .{ .ref = admitted_ref, .digest = admitted_digest };
    if (!common.safeToken(root_id) or !artifact.validDigest(graph_digest) or
        !artifact.validDigest(subject_digest) or !artifact.validDigest(transitive_digest) or
        !artifact.validDigest(expected_witness) or !artifact.validDigest(expected_judge) or
        admitted_ref.len == 0 or admitted_ref.len > 512 or !artifact.validDigest(admitted_digest)) return Error.InvalidRequest;

    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const scratch = arena.allocator();
    const lock = ledger.acquireExclusive(allocator, env) catch return Error.LedgerFailure;
    defer ledger.releaseExclusive(lock);
    var scan: Scan = .{ .allocator = scratch, .root_id = root_id, .graph_digest = graph_digest, .subject_digest = subject_digest, .transitive_digest = transitive_digest };
    ledger.forEachLine(scratch, env, &scan, scanLine) catch return Error.LedgerFailure;
    try validateCoverage(&scan, expected_witness, expected_judge);
    const identity = try signingIdentity(allocator, env);
    if (scan.issued_statement) |statement| {
        if (!std.mem.eql(u8, scan.issued_key_id.?, &identity.key_id)) return Error.Stale;
        return allocator.dupe(u8, statement) catch Error.OutOfMemory;
    }
    var admitted_at_buf: [40]u8 = undefined;
    const admitted_at = nowIsoUtc(&admitted_at_buf) catch return Error.InvalidRequest;
    const blank = try canonicalBlank(allocator, &scan, admitted_by, &identity.key_id, admitted_at);
    defer allocator.free(blank);
    const signature = identity.pair.sign(blank, null) catch return Error.SigningBootstrap;
    var signature_hex: [128]u8 = undefined;
    _ = std.fmt.bufPrint(&signature_hex, "{x}", .{signature.toBytes()}) catch unreachable;
    const needle = "\"value\":\"\"";
    const at = std.mem.indexOf(u8, blank, needle) orelse return Error.Mismatch;
    var statement = std.ArrayList(u8).empty;
    defer statement.deinit(allocator);
    statement.appendSlice(allocator, blank[0 .. at + "\"value\":\"".len]) catch return Error.OutOfMemory;
    statement.appendSlice(allocator, &signature_hex) catch return Error.OutOfMemory;
    statement.appendSlice(allocator, blank[at + needle.len - 1 ..]) catch return Error.OutOfMemory;
    var digest_raw: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(statement.items, &digest_raw, .{});
    var digest_hex: [64]u8 = undefined;
    _ = std.fmt.bufPrint(&digest_hex, "{x}", .{digest_raw}) catch unreachable;
    var row: std.ArrayList(u8) = .empty;
    defer row.deinit(allocator);
    row.appendSlice(allocator, "{\"event\":\"graph_harness_attestation_issued\",\"graph_digest\":") catch return Error.OutOfMemory;
    try appendString(&row, allocator, graph_digest);
    row.appendSlice(allocator, ",\"key_id\":") catch return Error.OutOfMemory;
    try appendString(&row, allocator, &identity.key_id);
    row.appendSlice(allocator, ",\"root_id\":") catch return Error.OutOfMemory;
    try appendString(&row, allocator, root_id);
    row.appendSlice(allocator, ",\"statement_digest\":") catch return Error.OutOfMemory;
    try appendString(&row, allocator, &digest_hex);
    row.appendSlice(allocator, ",\"statement_json\":") catch return Error.OutOfMemory;
    try appendString(&row, allocator, statement.items);
    row.appendSlice(allocator, ",\"subject_digest\":") catch return Error.OutOfMemory;
    try appendString(&row, allocator, subject_digest);
    row.appendSlice(allocator, ",\"transitive_digest\":") catch return Error.OutOfMemory;
    try appendString(&row, allocator, transitive_digest);
    row.append(allocator, '}') catch return Error.OutOfMemory;
    const path = ledger.appendRow(allocator, env, row.items) catch return Error.LedgerFailure;
    allocator.free(path);
    return statement.toOwnedSlice(allocator) catch Error.OutOfMemory;
}

fn nowIsoUtc(buf: []u8) ![]u8 {
    var tv: std.c.timeval = undefined;
    _ = std.c.gettimeofday(&tv, null);
    const epoch = std.time.epoch.EpochSeconds{ .secs = @intCast(tv.sec) };
    const year_day = epoch.getEpochDay().calculateYearDay();
    const month_day = year_day.calculateMonthDay();
    const day = epoch.getDaySeconds();
    return std.fmt.bufPrint(buf, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.{d:0>6}Z", .{
        year_day.year,               month_day.month.numeric(), month_day.day_index + 1,
        day.getHoursIntoDay(),       day.getMinutesIntoHour(),  day.getSecondsIntoMinute(),
        @as(u64, @intCast(tv.usec)),
    });
}

test "verdict parser rejects self-authored shapes and non-pass verdicts" {
    var good = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, "{\"digest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"evaluator\":\"judge/v1\",\"verdict\":\"pass\"}", .{});
    defer good.deinit();
    try std.testing.expect(verdictFrom(good.value) != null);
    var bad = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, "{\"digest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"evaluator\":\"judge/v1\",\"verdict\":\"hold\"}", .{});
    defer bad.deinit();
    try std.testing.expect(verdictFrom(bad.value) == null);
}

test "canonical statement is byte stable and leaves only signature value blank" {
    var scan: Scan = .{ .allocator = std.testing.allocator, .root_id = "root-1", .graph_digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", .subject_digest = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", .transitive_digest = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", .ledger_ref = "ledger:row" };
    defer scan.nodes.deinit(std.testing.allocator);
    try scan.nodes.append(std.testing.allocator, .{ .id = "node-1", .key = "__graph_harness_north_star", .depends_on = "[]", .requirements = "[\"cell_manifest\",\"witness_verdict\",\"judge_verdict\"]", .cell_digest = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", .witness_id = "north-star", .witness_digest = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", .judge_digest = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", .settled = true, .evidence_digest = "1111111111111111111111111111111111111111111111111111111111111111", .firing_id = "2222222222222222222222222222222222222222222222222222222222222222", .witness = .{ .digest = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", .evaluator = "witness/v1", .verdict = "pass" }, .judge = .{ .digest = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", .evaluator = "judge/v1", .verdict = "pass" } });
    const descriptor: Descriptor = .{ .ref = "cas:admitter", .digest = "3333333333333333333333333333333333333333333333333333333333333333" };
    const a = try canonicalBlank(std.testing.allocator, &scan, descriptor, "sha256:4444444444444444444444444444444444444444444444444444444444444444", "2026-08-10T00:00:00.000000Z");
    defer std.testing.allocator.free(a);
    const b = try canonicalBlank(std.testing.allocator, &scan, descriptor, "sha256:4444444444444444444444444444444444444444444444444444444444444444", "2026-08-10T00:00:00.000000Z");
    defer std.testing.allocator.free(b);
    try std.testing.expectEqualStrings(a, b);
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, a, "\"value\":\"\""));
    var statement = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, a, .{});
    defer statement.deinit();
    try std.testing.expectEqual(@as(usize, 11), statement.value.object.count());
    try std.testing.expectEqualStrings("graph-harness-attestation/v1", statement.value.object.get("api_version").?.string);
    try std.testing.expectEqualStrings("GraphHarnessAdmissionAttestation", statement.value.object.get("kind").?.string);
    try std.testing.expectEqualStrings("contract", statement.value.object.get("owner").?.string);
    const authentication = statement.value.object.get("authentication").?.object;
    try std.testing.expectEqual(@as(usize, 3), authentication.count());
    try std.testing.expectEqualStrings("ed25519", authentication.get("algorithm").?.string);
    try std.testing.expect(authentication.get("public_key") == null and authentication.get("scheme") == null);
}

test "coverage refuses incomplete self-judged and stale durable rows" {
    const a = std.testing.allocator;
    var scan: Scan = .{ .allocator = a, .root_id = "root-1", .graph_digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", .subject_digest = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", .transitive_digest = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", .admissions = 1, .ledger_ref = "ledger:row" };
    defer scan.nodes.deinit(a);
    try scan.nodes.append(a, .{ .id = "node-1", .key = "__graph_harness_north_star", .depends_on = "[]", .requirements = "[\"cell_manifest\",\"witness_verdict\",\"judge_verdict\"]", .cell_digest = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", .witness_id = "north-star", .witness_digest = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", .judge_digest = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" });
    try std.testing.expectError(Error.Incomplete, validateCoverage(&scan, scan.nodes.items[0].witness_digest, scan.nodes.items[0].judge_digest));
    scan.nodes.items[0].settled = true;
    scan.nodes.items[0].evidence_digest = "1111111111111111111111111111111111111111111111111111111111111111";
    scan.nodes.items[0].firing_id = "2222222222222222222222222222222222222222222222222222222222222222";
    scan.nodes.items[0].witness = .{ .digest = scan.nodes.items[0].witness_digest, .evaluator = "same/v1", .verdict = "pass" };
    scan.nodes.items[0].judge = .{ .digest = scan.nodes.items[0].judge_digest, .evaluator = "same/v1", .verdict = "pass" };
    try std.testing.expectError(Error.SelfJudge, validateCoverage(&scan, scan.nodes.items[0].witness_digest, scan.nodes.items[0].judge_digest));
    scan.nodes.items[0].judge.?.evaluator = "independent/v1";
    scan.revoked = true;
    try std.testing.expectError(Error.Stale, validateCoverage(&scan, scan.nodes.items[0].witness_digest, scan.nodes.items[0].judge_digest));
}
