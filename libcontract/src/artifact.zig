//! Immutable content-addressed payloads for Neuron firings.
//!
//! The append-only ledger keeps identities and digests. Bounded payloads live
//! beside it and are verified on every read, so a mutable or symlinked backing
//! file cannot silently change the evidence a later Neuron receives.

const std = @import("std");
const builtin = @import("builtin");
const ledger = @import("ledger.zig");

pub const MAX_BYTES: usize = 64 * 1024;

pub const Error = error{
    InvalidDigest,
    EmptyArtifact,
    ArtifactTooLarge,
    ArtifactMissing,
    ArtifactConflict,
    SensitiveArtifact,
    StoreFailure,
    OutOfMemory,
};

pub fn digest(bytes: []const u8) [64]u8 {
    var hash = std.crypto.hash.sha2.Sha256.init(.{});
    hash.update(bytes);
    var raw: [32]u8 = undefined;
    hash.final(&raw);
    return std.fmt.bytesToHex(raw, .lower);
}

pub fn validDigest(value: []const u8) bool {
    if (value.len != 64) return false;
    for (value) |byte| {
        if (!std.ascii.isDigit(byte) and (byte < 'a' or byte > 'f')) return false;
    }
    return true;
}

fn tokenTail(value: []const u8, prefix: []const u8, minimum: usize) bool {
    var offset: usize = 0;
    while (std.mem.indexOfPos(u8, value, offset, prefix)) |index| {
        const start = index + prefix.len;
        var end = start;
        while (end < value.len and
            (std.ascii.isAlphanumeric(value[end]) or value[end] == '_' or value[end] == '-'))
        {
            end += 1;
        }
        if (end - start >= minimum) return true;
        offset = start;
    }
    return false;
}

/// High-confidence credential detector for evidence payloads. It deliberately
/// avoids broad words such as "password": only concrete token/key shapes are
/// rejected, keeping ordinary diagnostic evidence usable.
pub fn containsSensitiveMaterial(value: []const u8) bool {
    if (std.mem.indexOf(u8, value, "-----BEGIN PRIVATE KEY-----") != null or
        std.mem.indexOf(u8, value, "-----BEGIN OPENSSH PRIVATE KEY-----") != null or
        std.mem.indexOf(u8, value, "Authorization: Bearer ") != null)
        return true;
    if (tokenTail(value, "github_pat_", 20) or
        tokenTail(value, "ghp_", 20) or
        tokenTail(value, "xoxb-", 20))
        return true;
    var offset: usize = 0;
    while (std.mem.indexOfPos(u8, value, offset, "AKIA")) |index| {
        const end = index + 20;
        if (end <= value.len) {
            var shaped = true;
            for (value[index + 4 .. end]) |byte| {
                if (!std.ascii.isUpper(byte) and !std.ascii.isDigit(byte)) {
                    shaped = false;
                    break;
                }
            }
            if (shaped) return true;
        }
        offset = index + 4;
    }
    return false;
}

fn pathFor(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    value_digest: []const u8,
) Error![]u8 {
    if (!validDigest(value_digest)) return Error.InvalidDigest;
    const ledger_path = ledger.resolvePath(allocator, env) catch return Error.StoreFailure;
    defer allocator.free(ledger_path);
    const parent = std.fs.path.dirname(ledger_path) orelse ".";
    const filename = std.fmt.allocPrint(
        allocator,
        "{s}.json",
        .{value_digest},
    ) catch return Error.OutOfMemory;
    defer allocator.free(filename);
    return std.fs.path.join(
        allocator,
        &.{ parent, "neuron-artifacts", filename },
    ) catch Error.OutOfMemory;
}

fn readPath(
    allocator: std.mem.Allocator,
    path: []const u8,
    expected_digest: []const u8,
) Error![]u8 {
    var threaded: std.Io.Threaded = .init(allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();
    var file = std.Io.Dir.openFileAbsolute(io, path, .{}) catch |err| switch (err) {
        error.FileNotFound => return Error.ArtifactMissing,
        else => return Error.StoreFailure,
    };
    defer file.close(io);
    const length = file.length(io) catch return Error.StoreFailure;
    if (length == 0) return Error.EmptyArtifact;
    if (length > MAX_BYTES) return Error.ArtifactTooLarge;
    var buffer: [4096]u8 = undefined;
    var reader = file.reader(io, &buffer);
    const bytes = reader.interface.allocRemaining(
        allocator,
        .limited(MAX_BYTES + 1),
    ) catch return Error.StoreFailure;
    errdefer allocator.free(bytes);
    if (bytes.len == 0) return Error.EmptyArtifact;
    if (bytes.len > MAX_BYTES) return Error.ArtifactTooLarge;
    const observed = digest(bytes);
    if (!std.mem.eql(u8, &observed, expected_digest)) return Error.ArtifactConflict;
    return bytes;
}

/// Store one immutable artifact. Repeating identical bytes is a cache hit;
/// finding different bytes at the digest path fails closed.
pub fn put(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    bytes: []const u8,
) Error![64]u8 {
    if (bytes.len == 0) return Error.EmptyArtifact;
    if (bytes.len > MAX_BYTES) return Error.ArtifactTooLarge;
    if (containsSensitiveMaterial(bytes)) return Error.SensitiveArtifact;
    const value_digest = digest(bytes);
    const path = try pathFor(allocator, env, &value_digest);
    defer allocator.free(path);

    var threaded: std.Io.Threaded = .init(allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();
    var atomic = std.Io.Dir.createFileAtomic(
        .cwd(),
        io,
        path,
        .{
            .make_path = true,
            .permissions = if (builtin.os.tag == .windows)
                .default_file
            else
                .fromMode(0o600),
        },
    ) catch return Error.StoreFailure;
    defer atomic.deinit(io);
    atomic.file.writeStreamingAll(io, bytes) catch return Error.StoreFailure;
    atomic.file.sync(io) catch return Error.StoreFailure;
    atomic.link(io) catch |err| switch (err) {
        error.PathAlreadyExists => {
            const existing = try readPath(allocator, path, &value_digest);
            defer allocator.free(existing);
            if (!std.mem.eql(u8, existing, bytes)) return Error.ArtifactConflict;
        },
        else => return Error.StoreFailure,
    };
    return value_digest;
}

pub fn read(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    value_digest: []const u8,
) Error![]u8 {
    const path = try pathFor(allocator, env, value_digest);
    defer allocator.free(path);
    return readPath(allocator, path, value_digest) catch |err| switch (err) {
        Error.ArtifactMissing => readCommittedPayload(allocator, env, value_digest),
        else => return err,
    };
}

fn committedPayload(value: std.json.Value, value_digest: []const u8) ?std.json.Value {
    if (value != .object) return null;
    const event = value.object.get("event") orelse return null;
    if (event == .string and std.mem.eql(u8, event.string, "neuron_transaction")) {
        const rows = value.object.get("rows") orelse return null;
        if (rows != .array) return null;
        for (rows.array.items) |row| {
            if (committedPayload(row, value_digest)) |payload| return payload;
        }
        return null;
    }
    if (event != .string or
        !std.mem.eql(u8, event.string, "neuron_skill_node_settled")) return null;
    const digest_value = value.object.get("evidence_digest") orelse return null;
    if (digest_value != .string or
        !std.mem.eql(u8, digest_value.string, value_digest)) return null;
    return value.object.get("evidence_payload");
}

fn readCommittedPayload(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    value_digest: []const u8,
) Error![]u8 {
    const body = ledger.readAll(allocator, env) catch return Error.StoreFailure;
    defer allocator.free(body);
    var lines = std.mem.tokenizeScalar(u8, body, '\n');
    while (lines.next()) |line| {
        var parsed = std.json.parseFromSlice(std.json.Value, allocator, line, .{}) catch continue;
        defer parsed.deinit();
        const payload = committedPayload(parsed.value, value_digest) orelse continue;
        var allocating: std.Io.Writer.Allocating = .init(allocator);
        errdefer allocating.deinit();
        var out = std.json.Stringify{ .writer = &allocating.writer };
        out.write(payload) catch return Error.OutOfMemory;
        const bytes = allocating.toOwnedSlice() catch return Error.OutOfMemory;
        errdefer allocator.free(bytes);
        if (bytes.len == 0 or bytes.len > MAX_BYTES) return Error.ArtifactTooLarge;
        const observed = digest(bytes);
        if (!std.mem.eql(u8, &observed, value_digest)) return Error.ArtifactConflict;
        return bytes;
    }
    return Error.ArtifactMissing;
}

test "artifact digests are deterministic lower hex and bounded" {
    const first = digest("{\"answer\":42}");
    const second = digest("{\"answer\":42}");
    try std.testing.expectEqualSlices(u8, &first, &second);
    try std.testing.expect(validDigest(&first));
    try std.testing.expectError(Error.EmptyArtifact, put(
        std.testing.allocator,
        std.process.Environ.empty,
        "",
    ));
}

test "artifact privacy gate rejects concrete secret shapes without keyword false positives" {
    try std.testing.expect(containsSensitiveMaterial(
        "{\"token\":\"github_pat_1234567890abcdefghij\"}",
    ));
    try std.testing.expect(containsSensitiveMaterial(
        "{\"credential\":\"AKIA1234567890ABCDEF\"}",
    ));
    try std.testing.expect(containsSensitiveMaterial(
        "-----BEGIN OPENSSH PRIVATE KEY-----",
    ));
    try std.testing.expect(!containsSensitiveMaterial(
        "{\"claim\":\"the password field was redacted\",\"value\":\"[REDACTED]\"}",
    ));
}

test "committed transaction payload is the authoritative artifact" {
    const expected = digest("{\"proof\":true}");
    const row = try std.fmt.allocPrint(
        std.testing.allocator,
        "{{\"event\":\"neuron_transaction\",\"rows\":[{{" ++
            "\"event\":\"neuron_skill_node_settled\"," ++
            "\"evidence_digest\":\"{s}\"," ++
            "\"evidence_payload\":{{\"proof\":true}}}}]}}",
        .{&expected},
    );
    defer std.testing.allocator.free(row);
    var parsed = try std.json.parseFromSlice(
        std.json.Value,
        std.testing.allocator,
        row,
        .{},
    );
    defer parsed.deinit();
    const payload = committedPayload(parsed.value, &expected).?;
    try std.testing.expect(payload == .object);
}
