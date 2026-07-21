//! Deterministic trust kernel for public Aiko Collective contract objects.
//!
//! This module is deliberately pure: hostile bytes in, deterministic bytes or
//! reason-coded refusal out. Aiko owns persistence, networking, keys, and every
//! execution decision. Public objects never carry invocation or result data.

const std = @import("std");
const cas = @import("cas.zig");

pub const PROTOCOL = "aiko-collective/1";
pub const SCHEMA_VERSION: u32 = 1;
pub const MAX_OBJECT_BYTES: usize = 256 * 1024;
pub const MAX_CANONICAL_BYTES: usize = 192 * 1024;
pub const MAX_DEPTH: usize = 16;
pub const MAX_COLLECTION_ITEMS: usize = 4096;
pub const MAX_OBJECT_PROPERTIES: usize = 128;
pub const OBJECT_DOMAIN = "aiko.collective.object.v1\x00";
pub const SIGNING_DOMAIN = "aiko.collective.signature.v1\x00";

const Blake3 = std.crypto.hash.Blake3;
const Ed25519 = std.crypto.sign.Ed25519;

pub const Error = error{
    InputTooLarge,
    InvalidJson,
    InvalidRoot,
    UnknownField,
    MissingField,
    InvalidField,
    UnsupportedProtocol,
    TooDeep,
    TooManyItems,
    SecretBearing,
    PrivateOrigin,
    SensitiveDomain,
    MutatingCapability,
    InvalidObjectId,
    InvalidPublisher,
    InvalidSignature,
    DuplicateKey,
    Expired,
    NotYetValid,
    OutOfMemory,
};

fn scanValue(allocator: std.mem.Allocator, scanner: *std.json.Scanner, first: std.json.Token, depth: usize) Error!void {
    if (depth > MAX_DEPTH) return Error.TooDeep;
    switch (first) {
        .allocated_string => |value| allocator.free(value),
        .allocated_number => |value| allocator.free(value),
        .object_begin => {
            var keys: std.StringHashMap(void) = .init(allocator);
            defer {
                var it = keys.keyIterator();
                while (it.next()) |key| allocator.free(key.*);
                keys.deinit();
            }
            while (true) {
                const token = scanner.nextAllocMax(allocator, .alloc_always, MAX_OBJECT_BYTES) catch return Error.InvalidJson;
                if (token == .object_end) break;
                const key = switch (token) { .allocated_string => |value| value, else => return Error.InvalidJson };
                if (keys.contains(key)) {
                    allocator.free(key);
                    return Error.DuplicateKey;
                }
                keys.put(key, {}) catch return Error.OutOfMemory;
                const value = scanner.nextAllocMax(allocator, .alloc_always, MAX_OBJECT_BYTES) catch return Error.InvalidJson;
                try scanValue(allocator, scanner, value, depth + 1);
            }
        },
        .array_begin => while (true) {
            const token = scanner.nextAllocMax(allocator, .alloc_always, MAX_OBJECT_BYTES) catch return Error.InvalidJson;
            if (token == .array_end) break;
            try scanValue(allocator, scanner, token, depth + 1);
        },
        .true, .false, .null => {},
        else => return Error.InvalidJson,
    }
}

/// Reject duplicate object keys before dynamic parsing can collapse them.
pub fn validateNoDuplicateKeys(allocator: std.mem.Allocator, bytes: []const u8) Error!void {
    var scanner = std.json.Scanner.initCompleteInput(allocator, bytes);
    defer scanner.deinit();
    const first = scanner.nextAllocMax(allocator, .alloc_always, MAX_OBJECT_BYTES) catch return Error.InvalidJson;
    try scanValue(allocator, &scanner, first, 0);
    const final = scanner.next() catch return Error.InvalidJson;
    if (final != .end_of_document) return Error.InvalidJson;
}

pub const Verdict = enum {
    reject,
    quarantine,
    admit_private,
    publishable,
};

pub const Classification = enum {
    public_api,
    public_documented,
    authenticated_generic,
    account_scoped,
    local_private,
    sensitive,
    mutation,
    unknown,
};

pub const Result = struct {
    canonical: []u8,
    object_id: [71]u8, // "blake3:" + 64 lowercase hex

    pub fn deinit(self: Result, allocator: std.mem.Allocator) void {
        allocator.free(self.canonical);
    }
};

pub const PublicationDecision = struct {
    verdict: Verdict,
    classification: Classification,
    reason_code: []const u8,
};

const root_fields = [_][]const u8{ "protocol", "kind", "publisher", "sequence", "created_at", "expires_at", "payload" };

const forbidden_fragments = [_][]const u8{
    "authorization",  "bearer",        "cookie",       "credential",
    "password",       "passwd",        "secret",       "session",
    "token",          "api_key",       "apikey",       "private_key",
    "request_body",   "response_body", "raw_argument", "prompt",
    "command_output", "machine_path",  "account_id",   "tenant_id",
};

const sensitive_authorities = [_][]const u8{
    "linkedin.com",
    "healthcare.gov",
    "mychart.com",
    "paypal.com",
    "stripe.com",
    "irs.gov",
};

fn containsForbidden(value: []const u8) bool {
    for (forbidden_fragments) |fragment| {
        if (value.len >= fragment.len) {
            var i: usize = 0;
            while (i + fragment.len <= value.len) : (i += 1)
                if (std.ascii.eqlIgnoreCase(value[i .. i + fragment.len], fragment)) return true;
        }
    }
    for ([_][]const u8{ "http://", "https://", "file://" }) |scheme| if (value.len >= scheme.len) {
        var i: usize = 0;
        while (i + scheme.len <= value.len) : (i += 1)
            if (std.ascii.eqlIgnoreCase(value[i .. i + scheme.len], scheme)) return true;
    };
    return false;
}

fn validatePublicTree(value: std.json.Value, depth: usize) Error!void {
    if (depth > MAX_DEPTH) return Error.TooDeep;
    switch (value) {
        .object => |object| {
            if (object.count() > MAX_OBJECT_PROPERTIES) return Error.TooManyItems;
            var it = object.iterator();
            while (it.next()) |entry| {
                if (containsForbidden(entry.key_ptr.*)) return Error.SecretBearing;
                try validatePublicTree(entry.value_ptr.*, depth + 1);
            }
        },
        .array => |array| {
            if (array.items.len > MAX_COLLECTION_ITEMS) return Error.TooManyItems;
            for (array.items) |item| try validatePublicTree(item, depth + 1);
        },
        .string => |string| {
            if (string.len > 4096) return Error.InvalidField;
            if (containsForbidden(string)) return Error.SecretBearing;
        },
        .float, .number_string => return Error.InvalidField,
        .integer => |integer| if (integer < 0 or integer > 9007199254740991) return Error.InvalidField,
        else => {},
    }
}

fn stringField(object: std.json.ObjectMap, key: []const u8) Error![]const u8 {
    const value = object.get(key) orelse return Error.MissingField;
    return switch (value) {
        .string => |string| if (string.len > 0 and string.len <= 512) string else Error.InvalidField,
        else => Error.InvalidField,
    };
}

fn objectField(object: std.json.ObjectMap, key: []const u8) Error!std.json.ObjectMap {
    const value = object.get(key) orelse return Error.MissingField;
    return switch (value) {
        .object => |child| child,
        else => Error.InvalidField,
    };
}

fn arrayField(object: std.json.ObjectMap, key: []const u8) Error!std.json.Array {
    const value = object.get(key) orelse return Error.MissingField;
    return switch (value) {
        .array => |child| child,
        else => Error.InvalidField,
    };
}

fn intField(object: std.json.ObjectMap, key: []const u8) Error!i64 {
    const value = object.get(key) orelse return Error.MissingField;
    return switch (value) {
        .integer => |integer| if (integer >= 0 and integer <= 9007199254740991) integer else Error.InvalidField,
        else => Error.InvalidField,
    };
}

fn fieldAllowed(fields: []const []const u8, key: []const u8) bool {
    for (fields) |field| if (std.mem.eql(u8, field, key)) return true;
    return false;
}

fn validateExact(object: std.json.ObjectMap, fields: []const []const u8) Error!void {
    if (object.count() != fields.len) return Error.UnknownField;
    var it = object.iterator();
    while (it.next()) |entry| if (!fieldAllowed(fields, entry.key_ptr.*)) return Error.UnknownField;
    for (fields) |field| if (!object.contains(field)) return Error.MissingField;
}

fn validTimestamp(value: []const u8) bool {
    if (value.len != 20 or value[4] != '-' or value[7] != '-' or value[10] != 'T' or
        value[13] != ':' or value[16] != ':' or value[19] != 'Z') return false;
    for (value, 0..) |ch, i| {
        if (i == 4 or i == 7 or i == 10 or i == 13 or i == 16 or i == 19) continue;
        if (!std.ascii.isDigit(ch)) return false;
    }
    const year = std.fmt.parseInt(u16, value[0..4], 10) catch return false;
    const month = std.fmt.parseInt(u8, value[5..7], 10) catch return false;
    const day = std.fmt.parseInt(u8, value[8..10], 10) catch return false;
    const hour = std.fmt.parseInt(u8, value[11..13], 10) catch return false;
    const minute = std.fmt.parseInt(u8, value[14..16], 10) catch return false;
    const second = std.fmt.parseInt(u8, value[17..19], 10) catch return false;
    if (year == 0 or month == 0 or month > 12 or day == 0 or hour > 23 or minute > 59 or second > 59)
        return false;
    const leap = (year % 4 == 0 and year % 100 != 0) or year % 400 == 0;
    const days = [_]u8{ 31, if (leap) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    return day <= days[month - 1];
}

fn isLowerHex(value: []const u8) bool {
    for (value) |ch| if (!std.ascii.isHex(ch) or (ch >= 'A' and ch <= 'F')) return false;
    return true;
}

fn validObjectId(value: []const u8) bool {
    return value.len == 71 and std.mem.startsWith(u8, value, "blake3:") and isLowerHex(value[7..]);
}

/// Validate the stable external spelling of a collective content identifier.
/// Kept public so other pure trust-kernel modules can reject malformed peer
/// input without duplicating protocol rules.
pub fn isObjectId(value: []const u8) bool {
    return validObjectId(value);
}

fn validateShapeMap(shape: std.json.ObjectMap) Error!void {
    if (shape.count() > 128) return Error.TooManyItems;
    var it = shape.iterator();
    const field_names = [_][]const u8{ "type", "required", "items_type" };
    while (it.next()) |entry| {
        if (entry.key_ptr.*.len == 0 or entry.key_ptr.*.len > 128) return Error.InvalidField;
        const field = switch (entry.value_ptr.*) {
            .object => |object| object,
            else => return Error.InvalidField,
        };
        if (field.count() < 2 or field.count() > 3) return Error.InvalidField;
        var fit = field.iterator();
        while (fit.next()) |part| if (!fieldAllowed(&field_names, part.key_ptr.*)) return Error.UnknownField;
        const ty = try stringField(field, "type");
        const valid_type = std.mem.eql(u8, ty, "null") or std.mem.eql(u8, ty, "boolean") or
            std.mem.eql(u8, ty, "integer") or std.mem.eql(u8, ty, "number") or
            std.mem.eql(u8, ty, "string") or std.mem.eql(u8, ty, "array") or
            std.mem.eql(u8, ty, "object");
        if (!valid_type) return Error.InvalidField;
        const required = field.get("required") orelse return Error.MissingField;
        if (required != .bool) return Error.InvalidField;
        if (field.get("items_type")) |items| if (items != .string) return Error.InvalidField;
    }
}

fn validateCapability(payload: std.json.ObjectMap) Error!void {
    const fields = [_][]const u8{ "capability_id", "capability_version", "origin", "operation", "summary", "input_shape", "output_shape", "permission", "effects", "requires", "sanitizer_version" };
    try validateExact(payload, &fields);
    _ = try stringField(payload, "capability_id");
    _ = try stringField(payload, "capability_version");
    const authority = try stringField(payload, "origin");
    if (authority.len > 253 or std.mem.indexOfScalar(u8, authority, '/') != null or
        std.mem.indexOfScalar(u8, authority, ':') != null) return Error.InvalidField;
    _ = try stringField(payload, "operation");
    _ = try stringField(payload, "summary");
    try validateShapeMap(try objectField(payload, "input_shape"));
    try validateShapeMap(try objectField(payload, "output_shape"));
    const permission = try stringField(payload, "permission");
    if (!std.mem.eql(u8, permission, "read") and !std.mem.eql(u8, permission, "network")) return Error.MutatingCapability;
    const effects = try arrayField(payload, "effects");
    if (effects.items.len == 0 or effects.items.len > 2) return Error.InvalidField;
    for (effects.items) |effect| switch (effect) {
        .string => |name| if (!std.mem.eql(u8, name, "read_only") and !std.mem.eql(u8, name, "network_read")) return Error.MutatingCapability,
        else => return Error.InvalidField,
    };
    const requires = try arrayField(payload, "requires");
    if (requires.items.len > 32) return Error.TooManyItems;
    for (requires.items) |item| switch (item) {
        .string => |id| if (!validObjectId(id)) return Error.InvalidObjectId,
        else => return Error.InvalidObjectId,
    };
    const sanitizer = try intField(payload, "sanitizer_version");
    if (sanitizer < 1 or sanitizer > 65535) return Error.InvalidField;
}

fn validateAttestation(payload: std.json.ObjectMap) Error!void {
    const fields = [_][]const u8{ "subject", "capability_version", "outcome", "latency_bucket_ms", "environment", "observed_bucket" };
    try validateExact(payload, &fields);
    if (!validObjectId(try stringField(payload, "subject"))) return Error.InvalidObjectId;
    _ = try stringField(payload, "capability_version");
    const outcome = try stringField(payload, "outcome");
    const outcomes = [_][]const u8{ "success", "permission_denied", "provider_unavailable", "timeout", "invalid_input", "provider_failure" };
    if (!fieldAllowed(&outcomes, outcome)) return Error.InvalidField;
    const latency = try intField(payload, "latency_bucket_ms");
    const buckets = [_]i64{ 0, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000 };
    var valid_bucket = false;
    for (buckets) |bucket| if (latency == bucket) {
        valid_bucket = true;
        break;
    };
    if (!valid_bucket) return Error.InvalidField;
    const environment = try stringField(payload, "environment");
    const environments = [_][]const u8{ "macos-arm64", "macos-x86_64", "windows-x86_64", "windows-arm64", "linux-x86_64", "linux-arm64", "other" };
    if (!fieldAllowed(&environments, environment)) return Error.InvalidField;
    if (!validTimestamp(try stringField(payload, "observed_bucket"))) return Error.InvalidField;
}

fn validateProviderRecord(payload: std.json.ObjectMap) Error!void {
    const fields = [_][]const u8{ "node_id", "objects", "addresses", "transport" };
    try validateExact(payload, &fields);
    const node_id = try stringField(payload, "node_id");
    if (node_id.len != 72 or !std.mem.startsWith(u8, node_id, "ed25519:") or !isLowerHex(node_id[8..])) return Error.InvalidPublisher;
    const objects = try arrayField(payload, "objects");
    if (objects.items.len == 0 or objects.items.len > 256) return Error.TooManyItems;
    for (objects.items) |item| switch (item) {
        .string => |id| if (!validObjectId(id)) return Error.InvalidObjectId,
        else => return Error.InvalidObjectId,
    };
    const addresses = try arrayField(payload, "addresses");
    if (addresses.items.len > 16) return Error.TooManyItems;
    for (addresses.items) |item| switch (item) {
        .string => |address| if (address.len == 0 or address.len > 256) return Error.InvalidField,
        else => return Error.InvalidField,
    };
    const transports = try arrayField(payload, "transport");
    if (transports.items.len == 0 or transports.items.len > 8) return Error.InvalidField;
    const allowed = [_][]const u8{ "quic-v1", "tcp-v1", "relay-v1" };
    for (transports.items) |item| switch (item) {
        .string => |transport| if (!fieldAllowed(&allowed, transport)) return Error.InvalidField,
        else => return Error.InvalidField,
    };
}

fn validateRevocation(payload: std.json.ObjectMap) Error!void {
    const fields = [_][]const u8{ "target_kind", "target", "reason", "effective_at" };
    try validateExact(payload, &fields);
    const target_kind = try stringField(payload, "target_kind");
    const target_kinds = [_][]const u8{ "object", "publisher", "delegation" };
    if (!fieldAllowed(&target_kinds, target_kind)) return Error.InvalidField;
    const target = try stringField(payload, "target");
    if (std.mem.eql(u8, target_kind, "object") and !validObjectId(target)) return Error.InvalidObjectId;
    const reason = try stringField(payload, "reason");
    const reasons = [_][]const u8{ "superseded", "compromised", "invalid", "privacy", "publisher_request" };
    if (!fieldAllowed(&reasons, reason)) return Error.InvalidField;
    if (!validTimestamp(try stringField(payload, "effective_at"))) return Error.InvalidField;
}

fn validPublisher(value: []const u8) bool {
    return value.len == 72 and std.mem.startsWith(u8, value, "ed25519:") and isLowerHex(value[8..]);
}

fn validateKeyRotation(payload: std.json.ObjectMap, publisher: []const u8, created: []const u8, expires: []const u8) Error!void {
    const fields = [_][]const u8{ "previous_publisher", "new_publisher", "effective_at" };
    try validateExact(payload, &fields);
    const previous = try stringField(payload, "previous_publisher");
    const next = try stringField(payload, "new_publisher");
    const effective = try stringField(payload, "effective_at");
    if (!validPublisher(previous) or !validPublisher(next)) return Error.InvalidPublisher;
    if (!std.mem.eql(u8, previous, publisher) or std.mem.eql(u8, previous, next)) return Error.InvalidField;
    if (!validTimestamp(effective) or std.mem.order(u8, effective, created) == .lt or
        std.mem.order(u8, effective, expires) != .lt) return Error.InvalidField;
}

fn validateDelegation(payload: std.json.ObjectMap, publisher: []const u8, created: []const u8, expires: []const u8) Error!void {
    const fields = [_][]const u8{ "delegate", "scope", "not_before", "not_after" };
    try validateExact(payload, &fields);
    const delegate = try stringField(payload, "delegate");
    if (!validPublisher(delegate) or std.mem.eql(u8, delegate, publisher)) return Error.InvalidPublisher;
    const scope = try arrayField(payload, "scope");
    if (scope.items.len == 0 or scope.items.len > 7) return Error.InvalidField;
    const allowed = [_][]const u8{ "capability", "provider_record", "attestation", "checkpoint", "index_root", "index_segment", "revocation" };
    for (scope.items, 0..) |entry, i| {
        const name = switch (entry) { .string => |value| value, else => return Error.InvalidField };
        if (!fieldAllowed(&allowed, name)) return Error.InvalidField;
        for (scope.items[0..i]) |earlier| if (earlier == .string and std.mem.eql(u8, earlier.string, name)) return Error.InvalidField;
    }
    const not_before = try stringField(payload, "not_before");
    const not_after = try stringField(payload, "not_after");
    if (!validTimestamp(not_before) or !validTimestamp(not_after) or
        std.mem.order(u8, not_before, not_after) != .lt or
        std.mem.order(u8, not_before, created) == .lt or
        std.mem.order(u8, not_after, expires) == .gt) return Error.InvalidField;
}

fn validateCheckpoint(payload: std.json.ObjectMap) Error!void {
    const fields = [_][]const u8{ "tree_size", "root_hash", "previous" };
    try validateExact(payload, &fields);
    _ = try intField(payload, "tree_size");
    const root_hash = try stringField(payload, "root_hash");
    if (root_hash.len != 64 or !isLowerHex(root_hash)) return Error.InvalidField;
    const previous = payload.get("previous") orelse return Error.MissingField;
    switch (previous) {
        .null => {},
        .string => |id| if (!validObjectId(id)) return Error.InvalidObjectId,
        else => return Error.InvalidField,
    }
}

fn validateIndexRoot(payload: std.json.ObjectMap) Error!void {
    const fields = [_][]const u8{ "generation", "schema_version", "shards" };
    try validateExact(payload, &fields);
    _ = try intField(payload, "generation");
    if (try intField(payload, "schema_version") != 1) return Error.InvalidField;
    const shards = try arrayField(payload, "shards");
    if (shards.items.len > 4096) return Error.TooManyItems;
    const shard_fields = [_][]const u8{ "prefix", "object_id", "count" };
    for (shards.items) |item| {
        const shard = switch (item) {
            .object => |object| object,
            else => return Error.InvalidField,
        };
        try validateExact(shard, &shard_fields);
        _ = try stringField(shard, "prefix");
        if (!validObjectId(try stringField(shard, "object_id"))) return Error.InvalidObjectId;
        if (try intField(shard, "count") > 10000000) return Error.InvalidField;
    }
}

fn validateIndexSegment(payload: std.json.ObjectMap) Error!void {
    const fields = [_][]const u8{ "generation", "prefix", "entries" };
    try validateExact(payload, &fields);
    _ = try intField(payload, "generation");
    const prefix = try stringField(payload, "prefix");
    if (prefix.len == 0 or prefix.len > 32) return Error.InvalidField;
    const entries = try arrayField(payload, "entries");
    if (entries.items.len > 512) return Error.TooManyItems;
    const entry_fields = [_][]const u8{
        "object_id", "publisher", "capability_id", "capability_version",
        "summary", "operation", "origin", "effects",
    };
    for (entries.items) |item| {
        const entry = switch (item) {
            .object => |value| value,
            else => return Error.InvalidField,
        };
        try validateExact(entry, &entry_fields);
        if (!validObjectId(try stringField(entry, "object_id"))) return Error.InvalidObjectId;
        if (!validPublisher(try stringField(entry, "publisher"))) return Error.InvalidPublisher;
        _ = try stringField(entry, "capability_id");
        _ = try stringField(entry, "capability_version");
        _ = try stringField(entry, "summary");
        _ = try stringField(entry, "operation");
        const origin = try stringField(entry, "origin");
        if (origin.len == 0 or origin.len > 253 or
            std.mem.indexOfScalar(u8, origin, '/') != null or
            std.mem.indexOfScalar(u8, origin, ':') != null) return Error.InvalidField;
        const effects = try arrayField(entry, "effects");
        if (effects.items.len == 0 or effects.items.len > 2) return Error.InvalidField;
        for (effects.items) |effect| switch (effect) {
            .string => |name| if (!std.mem.eql(u8, name, "read_only") and
                !std.mem.eql(u8, name, "network_read")) return Error.MutatingCapability,
            else => return Error.InvalidField,
        };
    }
}

fn validateUnsigned(root: std.json.ObjectMap) Error!void {
    try validateExact(root, &root_fields);
    if (!std.mem.eql(u8, try stringField(root, "protocol"), PROTOCOL)) return Error.UnsupportedProtocol;
    const kind = try stringField(root, "kind");
    const publisher = try stringField(root, "publisher");
    if (!validPublisher(publisher)) return Error.InvalidPublisher;
    _ = try intField(root, "sequence");
    const created = try stringField(root, "created_at");
    const expires = try stringField(root, "expires_at");
    if (!validTimestamp(created) or !validTimestamp(expires) or std.mem.order(u8, created, expires) != .lt) return Error.InvalidField;
    const payload = try objectField(root, "payload");
    if (std.mem.eql(u8, kind, "capability")) return validateCapability(payload);
    if (std.mem.eql(u8, kind, "attestation")) return validateAttestation(payload);
    if (std.mem.eql(u8, kind, "provider_record")) return validateProviderRecord(payload);
    if (std.mem.eql(u8, kind, "revocation")) return validateRevocation(payload);
    if (std.mem.eql(u8, kind, "key_rotation")) return validateKeyRotation(payload, publisher, created, expires);
    if (std.mem.eql(u8, kind, "delegation")) return validateDelegation(payload, publisher, created, expires);
    if (std.mem.eql(u8, kind, "checkpoint")) return validateCheckpoint(payload);
    if (std.mem.eql(u8, kind, "index_root")) return validateIndexRoot(payload);
    if (std.mem.eql(u8, kind, "index_segment")) return validateIndexSegment(payload);
    return Error.InvalidField;
}

fn lessThan(_: void, lhs: []const u8, rhs: []const u8) bool {
    return std.mem.order(u8, lhs, rhs) == .lt;
}

fn writeCanonical(allocator: std.mem.Allocator, out: *std.ArrayList(u8), value: std.json.Value, depth: usize) Error!void {
    if (depth > MAX_DEPTH) return Error.TooDeep;
    switch (value) {
        .object => |object| {
            var keys = allocator.alloc([]const u8, object.count()) catch return Error.OutOfMemory;
            defer allocator.free(keys);
            var it = object.iterator();
            var index: usize = 0;
            while (it.next()) |entry| : (index += 1) keys[index] = entry.key_ptr.*;
            std.mem.sort([]const u8, keys, {}, lessThan);
            out.append(allocator, '{') catch return Error.OutOfMemory;
            for (keys, 0..) |key, i| {
                if (i != 0) out.append(allocator, ',') catch return Error.OutOfMemory;
                try writeJsonScalar(allocator, out, .{ .string = key });
                out.append(allocator, ':') catch return Error.OutOfMemory;
                try writeCanonical(allocator, out, object.get(key).?, depth + 1);
            }
            out.append(allocator, '}') catch return Error.OutOfMemory;
        },
        .array => |array| {
            out.append(allocator, '[') catch return Error.OutOfMemory;
            for (array.items, 0..) |item, i| {
                if (i != 0) out.append(allocator, ',') catch return Error.OutOfMemory;
                try writeCanonical(allocator, out, item, depth + 1);
            }
            out.append(allocator, ']') catch return Error.OutOfMemory;
        },
        else => try writeJsonScalar(allocator, out, value),
    }
}

fn writeJsonScalar(allocator: std.mem.Allocator, out: *std.ArrayList(u8), value: std.json.Value) Error!void {
    var allocating: std.Io.Writer.Allocating = .init(allocator);
    defer allocating.deinit();
    var stringify = std.json.Stringify{ .writer = &allocating.writer };
    stringify.write(value) catch return Error.InvalidField;
    out.appendSlice(allocator, allocating.writer.buffered()) catch return Error.OutOfMemory;
}

fn hexDigest(digest: [32]u8, out: *[64]u8) void {
    const alphabet = "0123456789abcdef";
    for (digest, 0..) |byte, i| {
        out[i * 2] = alphabet[byte >> 4];
        out[i * 2 + 1] = alphabet[byte & 0x0f];
    }
}

pub fn objectDigest(canonical: []const u8) [32]u8 {
    return cas.domainHash(.blake3_v1, OBJECT_DOMAIN, canonical);
}

pub fn signingDigest(object_digest: [32]u8) [32]u8 {
    var hasher = Blake3.init(.{});
    hasher.update(SIGNING_DOMAIN);
    hasher.update(&object_digest);
    var digest: [32]u8 = undefined;
    hasher.final(&digest);
    return digest;
}

pub fn canonicalize(allocator: std.mem.Allocator, bytes: []const u8) Error!Result {
    if (bytes.len == 0 or bytes.len > MAX_OBJECT_BYTES) return Error.InputTooLarge;
    try validateNoDuplicateKeys(allocator, bytes);
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, bytes, .{
        .max_value_len = MAX_OBJECT_BYTES,
        .allocate = .alloc_always,
    }) catch return Error.InvalidJson;
    defer parsed.deinit();
    const root = switch (parsed.value) {
        .object => |object| object,
        else => return Error.InvalidRoot,
    };
    try validatePublicTree(parsed.value, 0);
    try validateUnsigned(root);

    var canonical_list: std.ArrayList(u8) = .empty;
    errdefer canonical_list.deinit(allocator);
    try writeCanonical(allocator, &canonical_list, parsed.value, 0);
    if (canonical_list.items.len > MAX_CANONICAL_BYTES) return Error.InputTooLarge;

    const digest = objectDigest(canonical_list.items);
    var result = Result{
        .canonical = try canonical_list.toOwnedSlice(allocator),
        .object_id = undefined,
    };
    @memcpy(result.object_id[0..7], "blake3:");
    hexDigest(digest, result.object_id[7..71]);
    return result;
}

fn hasString(array: std.json.Array, wanted: []const u8) bool {
    for (array.items) |item| switch (item) {
        .string => |string| if (std.mem.eql(u8, string, wanted)) return true,
        else => {},
    };
    return false;
}

pub fn publicationDecision(bytes: []const u8, allocator: std.mem.Allocator) Error!PublicationDecision {
    const result = try canonicalize(allocator, bytes);
    defer result.deinit(allocator);
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, result.canonical, .{}) catch
        return Error.InvalidJson;
    defer parsed.deinit();
    const root = parsed.value.object;
    const kind = root.get("kind").?.string;
    if (!std.mem.eql(u8, kind, "capability"))
        return .{ .verdict = .publishable, .classification = .public_documented, .reason_code = "typed_collective_object" };
    const payload = root.get("payload").?.object;
    const authority = payload.get("origin").?.string;
    for (sensitive_authorities) |domain| {
        const subdomain = authority.len > domain.len and
            std.mem.endsWith(u8, authority, domain) and
            authority[authority.len - domain.len - 1] == '.';
        if (std.mem.eql(u8, authority, domain) or subdomain)
            return .{ .verdict = .admit_private, .classification = .sensitive, .reason_code = "sensitive_authority_private" };
    }
    return .{ .verdict = .publishable, .classification = .public_api, .reason_code = "public_shape_sanitized" };
}

fn parseHex(comptime N: usize, encoded: []const u8, out: *[N]u8) bool {
    if (encoded.len != N * 2) return false;
    _ = std.fmt.hexToBytes(out, encoded) catch return false;
    return true;
}

pub fn verify(
    allocator: std.mem.Allocator,
    candidate: []const u8,
    claimed_id: []const u8,
    signature_hex: []const u8,
    publisher_key_hex: []const u8,
    now_iso: []const u8,
) Error!Result {
    if (!validTimestamp(now_iso)) return Error.InvalidField;
    var result = try canonicalize(allocator, candidate);
    errdefer result.deinit(allocator);
    if (!std.mem.eql(u8, &result.object_id, claimed_id)) return Error.InvalidObjectId;

    var parsed = std.json.parseFromSlice(std.json.Value, allocator, result.canonical, .{}) catch
        return Error.InvalidJson;
    defer parsed.deinit();
    const root = parsed.value.object;
    const publisher = root.get("publisher").?.string;
    if (!std.mem.eql(u8, publisher[8..], publisher_key_hex)) return Error.InvalidPublisher;
    const created = root.get("created_at").?.string;
    const expires = root.get("expires_at").?.string;
    if (std.mem.order(u8, now_iso, created) == .lt) return Error.NotYetValid;
    if (std.mem.order(u8, now_iso, expires) != .lt) return Error.Expired;

    var public_bytes: [32]u8 = undefined;
    var signature_bytes: [64]u8 = undefined;
    if (!parseHex(32, publisher_key_hex, &public_bytes) or
        !parseHex(64, signature_hex, &signature_bytes)) return Error.InvalidSignature;
    const public_key = Ed25519.PublicKey.fromBytes(public_bytes) catch return Error.InvalidPublisher;
    const signature = Ed25519.Signature.fromBytes(signature_bytes);
    signature.verify(&signingDigest(objectDigest(result.canonical)), public_key) catch return Error.InvalidSignature;
    return result;
}

const fixture_public =
    \\{"payload":{"summary":"Search public package metadata","operation":"search","origin":"registry.example","output_shape":{"items":{"required":true,"type":"array","items_type":"object"}},"input_shape":{"query":{"required":true,"type":"string"}},"capability_version":"1","effects":["network_read","read_only"],"requires":[],"sanitizer_version":1,"permission":"network","capability_id":"unbrowse.registry.search"},"expires_at":"2026-08-20T00:00:00Z","created_at":"2026-07-21T00:00:00Z","sequence":1,"publisher":"ed25519:0000000000000000000000000000000000000000000000000000000000000000","kind":"capability","protocol":"aiko-collective/1"}
;
const fixture_public_key = "0000000000000000000000000000000000000000000000000000000000000000";

test "canonicalization is key-order independent and domain-addressed" {
    const a = try canonicalize(std.testing.allocator, fixture_public);
    defer a.deinit(std.testing.allocator);
    const reordered = "{\"protocol\":\"aiko-collective/1\",\"kind\":\"capability\",\"publisher\":\"ed25519:0000000000000000000000000000000000000000000000000000000000000000\",\"sequence\":1,\"created_at\":\"2026-07-21T00:00:00Z\",\"expires_at\":\"2026-08-20T00:00:00Z\",\"payload\":{\"capability_id\":\"unbrowse.registry.search\",\"capability_version\":\"1\",\"origin\":\"registry.example\",\"operation\":\"search\",\"summary\":\"Search public package metadata\",\"input_shape\":{\"query\":{\"type\":\"string\",\"required\":true}},\"output_shape\":{\"items\":{\"type\":\"array\",\"required\":true,\"items_type\":\"object\"}},\"permission\":\"network\",\"effects\":[\"network_read\",\"read_only\"],\"requires\":[],\"sanitizer_version\":1}}";
    const b = try canonicalize(std.testing.allocator, reordered);
    defer b.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings(a.canonical, b.canonical);
    try std.testing.expectEqualSlices(u8, &a.object_id, &b.object_id);
    try std.testing.expect(std.mem.startsWith(u8, &a.object_id, "blake3:"));
    const repeated = try canonicalize(std.testing.allocator, a.canonical);
    defer repeated.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings(a.canonical, repeated.canonical);
    try std.testing.expectEqualSlices(u8, &a.object_id, &repeated.object_id);
}

test "canonical collective fixture is admitted byte-for-byte" {
    const fixture = @embedFile("fixtures/collective-valid-capability.json");
    const result = try canonicalize(std.testing.allocator, fixture);
    defer result.deinit(std.testing.allocator);
    try std.testing.expect(std.mem.startsWith(u8, &result.object_id, "blake3:"));
}

test "publication policy publishes safe public reads and keeps mutations private" {
    const safe = try publicationDecision(fixture_public, std.testing.allocator);
    try std.testing.expectEqual(Verdict.publishable, safe.verdict);
    const mutation = try std.mem.replaceOwned(u8, std.testing.allocator, fixture_public, "\"network\"", "\"write\"");
    defer std.testing.allocator.free(mutation);
    try std.testing.expectError(Error.MutatingCapability, publicationDecision(mutation, std.testing.allocator));
}

test "secret-bearing schema and raw URLs fail closed" {
    const secret = try std.mem.replaceOwned(u8, std.testing.allocator, fixture_public, "\"query\"", "\"api_token\"");
    defer std.testing.allocator.free(secret);
    try std.testing.expectError(Error.SecretBearing, canonicalize(std.testing.allocator, secret));
    const url = try std.mem.replaceOwned(u8, std.testing.allocator, fixture_public, "registry.example", "https://example.com/search");
    defer std.testing.allocator.free(url);
    try std.testing.expectError(Error.SecretBearing, canonicalize(std.testing.allocator, url));
}

test "malformed corpus rejects duplicate keys floats unknown fields and excessive depth" {
    const duplicate = try std.mem.replaceOwned(u8, std.testing.allocator, fixture_public,
        "\"sequence\":1", "\"sequence\":1,\"sequence\":2");
    defer std.testing.allocator.free(duplicate);
    try std.testing.expectError(Error.DuplicateKey, canonicalize(std.testing.allocator, duplicate));
    const floating = try std.mem.replaceOwned(u8, std.testing.allocator, fixture_public,
        "\"sequence\":1", "\"sequence\":1.5");
    defer std.testing.allocator.free(floating);
    try std.testing.expectError(Error.InvalidField, canonicalize(std.testing.allocator, floating));
    const unknown = try std.mem.replaceOwned(u8, std.testing.allocator, fixture_public,
        "\"sequence\":1", "\"sequence\":1,\"mystery\":true");
    defer std.testing.allocator.free(unknown);
    try std.testing.expectError(Error.UnknownField, canonicalize(std.testing.allocator, unknown));
}

test "Ed25519 verification binds exact canonical bytes id publisher and expiry" {
    const seed: [32]u8 = [_]u8{7} ** 32;
    const key_pair = try Ed25519.KeyPair.generateDeterministic(seed);
    var public_hex: [64]u8 = undefined;
    hexDigest(key_pair.public_key.bytes, &public_hex);
    const candidate = try std.mem.replaceOwned(u8, std.testing.allocator, fixture_public, fixture_public_key, &public_hex);
    defer std.testing.allocator.free(candidate);
    const canonical = try canonicalize(std.testing.allocator, candidate);
    defer canonical.deinit(std.testing.allocator);
    const signature = try key_pair.sign(&signingDigest(objectDigest(canonical.canonical)), null);
    var signature_hex: [128]u8 = undefined;
    const signature_bytes = signature.toBytes();
    const alphabet = "0123456789abcdef";
    for (signature_bytes, 0..) |byte, i| {
        signature_hex[i * 2] = alphabet[byte >> 4];
        signature_hex[i * 2 + 1] = alphabet[byte & 0x0f];
    }
    const verified = try verify(
        std.testing.allocator,
        candidate,
        &canonical.object_id,
        &signature_hex,
        &public_hex,
        "2026-08-01T00:00:00Z",
    );
    verified.deinit(std.testing.allocator);
    try std.testing.expectError(Error.Expired, verify(
        std.testing.allocator,
        candidate,
        &canonical.object_id,
        &signature_hex,
        &public_hex,
        "2026-08-20T00:00:00Z",
    ));
}

test "rotation and delegation are bounded ordered identity objects" {
    const old = "ed25519:1111111111111111111111111111111111111111111111111111111111111111";
    const next = "ed25519:2222222222222222222222222222222222222222222222222222222222222222";
    const rotation = "{\"protocol\":\"aiko-collective/1\",\"kind\":\"key_rotation\",\"publisher\":\"" ++ old ++ "\",\"sequence\":8,\"created_at\":\"2026-07-21T00:00:00Z\",\"expires_at\":\"2027-07-21T00:00:00Z\",\"payload\":{\"previous_publisher\":\"" ++ old ++ "\",\"new_publisher\":\"" ++ next ++ "\",\"effective_at\":\"2026-07-22T00:00:00Z\"}}";
    const rotated = try canonicalize(std.testing.allocator, rotation);
    defer rotated.deinit(std.testing.allocator);
    const delegation = "{\"protocol\":\"aiko-collective/1\",\"kind\":\"delegation\",\"publisher\":\"" ++ old ++ "\",\"sequence\":9,\"created_at\":\"2026-07-21T00:00:00Z\",\"expires_at\":\"2027-07-21T00:00:00Z\",\"payload\":{\"delegate\":\"" ++ next ++ "\",\"scope\":[\"capability\",\"attestation\"],\"not_before\":\"2026-07-22T00:00:00Z\",\"not_after\":\"2026-08-22T00:00:00Z\"}}";
    const delegated = try canonicalize(std.testing.allocator, delegation);
    defer delegated.deinit(std.testing.allocator);
    const self_rotation = try std.mem.replaceOwned(u8, std.testing.allocator, rotation, next, old);
    defer std.testing.allocator.free(self_rotation);
    try std.testing.expectError(Error.InvalidField, canonicalize(std.testing.allocator, self_rotation));
}

test "index segments are first-class bounded public objects" {
    const publisher = "ed25519:1111111111111111111111111111111111111111111111111111111111111111";
    const object_id = "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const segment = "{\"protocol\":\"aiko-collective/1\",\"kind\":\"index_segment\",\"publisher\":\"" ++ publisher ++ "\",\"sequence\":10,\"created_at\":\"2026-07-21T00:00:00Z\",\"expires_at\":\"2026-08-21T00:00:00Z\",\"payload\":{\"generation\":1,\"prefix\":\"aa\",\"entries\":[{\"object_id\":\"" ++ object_id ++ "\",\"publisher\":\"" ++ publisher ++ "\",\"capability_id\":\"unbrowse.registry.search\",\"capability_version\":\"1\",\"summary\":\"Search public package metadata\",\"operation\":\"search\",\"origin\":\"registry.example\",\"effects\":[\"network_read\",\"read_only\"]}]}}";
    const canonical = try canonicalize(std.testing.allocator, segment);
    defer canonical.deinit(std.testing.allocator);
    const unsafe = try std.mem.replaceOwned(u8, std.testing.allocator, segment,
        "network_read", "message_send");
    defer std.testing.allocator.free(unsafe);
    try std.testing.expectError(Error.MutatingCapability, canonicalize(std.testing.allocator, unsafe));
}
