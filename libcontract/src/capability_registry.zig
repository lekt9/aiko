//! Dynamic FECH capability catalog.
//!
//! Source snapshots are validated before replacement and stored separately
//! from outcome evidence. The registry owns descriptors only; live
//! availability remains prompt-scoped input to planning.

const std = @import("std");

pub const RegistryError = error{
    InvalidSource,
    InvalidJson,
    InvalidDescriptor,
    DuplicateCapability,
    InvalidObservation,
};

pub fn validateObservation(allocator: std.mem.Allocator, json: []const u8) !void {
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, json, .{}) catch return RegistryError.InvalidJson;
    defer parsed.deinit();
    if (parsed.value != .object) return RegistryError.InvalidObservation;
    const object = parsed.value.object;
    if (object.count() != 9) return RegistryError.InvalidObservation;
    const schema_version = object.get("schema_version") orelse return RegistryError.InvalidObservation;
    if (schema_version != .integer or schema_version.integer != 1) return RegistryError.InvalidObservation;
    const id = stringField(object, "capability_id") orelse return RegistryError.InvalidObservation;
    if (!validIdentifier(id)) return RegistryError.InvalidObservation;
    const version = stringField(object, "capability_version") orelse return RegistryError.InvalidObservation;
    if (version.len == 0 or version.len > 64) return RegistryError.InvalidObservation;
    const success = boolField(object, "success") orelse return RegistryError.InvalidObservation;
    const duration = object.get("duration_ms") orelse return RegistryError.InvalidObservation;
    if (duration != .integer or duration.integer < 0 or duration.integer > 86_400_000) return RegistryError.InvalidObservation;
    const permission = stringField(object, "permission_result") orelse return RegistryError.InvalidObservation;
    if (!oneOf(permission, &.{ "allowed", "denied", "not_required" })) return RegistryError.InvalidObservation;
    const result_shape = stringField(object, "result_shape") orelse return RegistryError.InvalidObservation;
    if (!oneOf(result_shape, &.{ "null", "boolean", "number", "string", "array", "object" })) return RegistryError.InvalidObservation;
    const observed_at = stringField(object, "observed_at") orelse return RegistryError.InvalidObservation;
    if (observed_at.len < 20 or observed_at.len > 64 or observed_at[observed_at.len - 1] != 'Z') return RegistryError.InvalidObservation;
    const error_value = object.get("error_class") orelse return RegistryError.InvalidObservation;
    if (success) {
        if (error_value != .null) return RegistryError.InvalidObservation;
    } else {
        if (error_value != .string or !oneOf(error_value.string, &.{ "permission_denied", "provider_unavailable", "timeout", "invalid_input", "provider_failure" })) return RegistryError.InvalidObservation;
    }
}

const Snapshot = struct {
    source: []u8,
    json: []u8,
};

const LatestObservation = struct {
    id: []u8,
    version: []u8,
    success: bool,
    duration_ms: f64,
};

pub const Registry = struct {
    allocator: std.mem.Allocator,
    snapshots: std.ArrayList(Snapshot) = .empty,
    observations: std.ArrayList(LatestObservation) = .empty,

    pub fn init(allocator: std.mem.Allocator) Registry {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *Registry) void {
        for (self.snapshots.items) |snapshot| {
            self.allocator.free(snapshot.source);
            self.allocator.free(snapshot.json);
        }
        self.snapshots.deinit(self.allocator);
        for (self.observations.items) |observation| {
            self.allocator.free(observation.id);
            self.allocator.free(observation.version);
        }
        self.observations.deinit(self.allocator);
    }

    /// Retain only the latest typed result for an exact capability version.
    /// Durable rows still live in Contract's ledger; this prompt-time cache is
    /// the authoritative fresh failure veto within the resident runtime.
    pub fn recordObservation(self: *Registry, observation_json: []const u8) !void {
        try validateObservation(self.allocator, observation_json);
        var parsed = try std.json.parseFromSlice(std.json.Value, self.allocator, observation_json, .{});
        defer parsed.deinit();
        const object = parsed.value.object;
        const id = stringField(object, "capability_id").?;
        const version = stringField(object, "capability_version").?;
        const success = boolField(object, "success").?;
        const duration = numericValue(object.get("duration_ms")).?;
        for (self.observations.items) |*existing| {
            if (std.mem.eql(u8, existing.id, id) and std.mem.eql(u8, existing.version, version)) {
                existing.success = success;
                existing.duration_ms = duration;
                return;
            }
        }
        const id_copy = try self.allocator.dupe(u8, id);
        errdefer self.allocator.free(id_copy);
        const version_copy = try self.allocator.dupe(u8, version);
        errdefer self.allocator.free(version_copy);
        try self.observations.append(self.allocator, .{
            .id = id_copy,
            .version = version_copy,
            .success = success,
            .duration_ms = duration,
        });
    }

    /// Validate the full snapshot before changing registry state. Repeating an
    /// identical source snapshot performs no allocation and is idempotent.
    pub fn replaceSource(self: *Registry, source: []const u8, descriptors_json: []const u8) !usize {
        if (!validSource(source)) return RegistryError.InvalidSource;
        const count = try validateSnapshot(self.allocator, source, descriptors_json);
        for (self.snapshots.items, 0..) |snapshot, index| {
            if (!std.mem.eql(u8, snapshot.source, source)) continue;
            if (std.mem.eql(u8, snapshot.json, descriptors_json)) return count;
            const replacement = try self.allocator.dupe(u8, descriptors_json);
            self.allocator.free(self.snapshots.items[index].json);
            self.snapshots.items[index].json = replacement;
            return count;
        }
        const source_copy = try self.allocator.dupe(u8, source);
        errdefer self.allocator.free(source_copy);
        const json_copy = try self.allocator.dupe(u8, descriptors_json);
        errdefer self.allocator.free(json_copy);
        try self.snapshots.append(self.allocator, .{ .source = source_copy, .json = json_copy });
        return count;
    }

    pub fn listJson(self: *const Registry, allocator: std.mem.Allocator, filter_json: []const u8) ![]u8 {
        const source_filter = parseSourceFilter(allocator, filter_json) catch return RegistryError.InvalidJson;
        defer if (source_filter.parsed) |*parsed| parsed.deinit();

        var aw: std.Io.Writer.Allocating = .init(allocator);
        errdefer aw.deinit();
        var out = std.json.Stringify{ .writer = &aw.writer };
        try out.beginObject();
        try out.objectField("schema_version");
        try out.write(1);
        try out.objectField("capabilities");
        try out.beginArray();
        for (self.snapshots.items) |snapshot| {
            if (source_filter.value) |wanted| {
                if (!std.mem.eql(u8, wanted, snapshot.source)) continue;
            }
            var parsed = std.json.parseFromSlice(std.json.Value, allocator, snapshot.json, .{}) catch
                return RegistryError.InvalidJson;
            defer parsed.deinit();
            for (parsed.value.array.items) |descriptor| try out.write(descriptor);
        }
        try out.endArray();
        try out.endObject();
        return aw.toOwnedSlice();
    }

    pub fn recommendPlan(
        self: *const Registry,
        allocator: std.mem.Allocator,
        context: []const u8,
        evidence_json: ?[]const u8,
        availability_json: []const u8,
        requested_limit: usize,
    ) ![]u8 {
        const limit = @min(requested_limit, 3);
        var availability = try Availability.init(allocator, availability_json);
        defer availability.deinit();
        var evidence = try Evidence.init(allocator, evidence_json);
        defer evidence.deinit();

        var ranked: std.ArrayList(Ranked) = .empty;
        defer ranked.deinit(allocator);
        var parsed_snapshots: std.ArrayList(std.json.Parsed(std.json.Value)) = .empty;
        defer {
            for (parsed_snapshots.items) |*parsed| parsed.deinit();
            parsed_snapshots.deinit(allocator);
        }
        for (self.snapshots.items) |snapshot| {
            const parsed = std.json.parseFromSlice(std.json.Value, allocator, snapshot.json, .{}) catch
                return RegistryError.InvalidJson;
            try parsed_snapshots.append(allocator, parsed);
            for (parsed_snapshots.items[parsed_snapshots.items.len - 1].value.array.items) |descriptor| {
                const object = descriptor.object;
                const id = stringField(object, "id") orelse continue;
                const version = stringField(object, "capability_version") orelse continue;
                const declared_available = boolField(object, "available") orelse false;
                const provider = stringField(object, "provider") orelse "";
                const live = if (std.mem.eql(u8, provider, "aiko_builtin"))
                    self.toolIsAvailable(&availability, stringField(object, "tool") orelse "")
                else
                    availability.isAvailable(id, version, declared_available);
                var score = if (live) descriptorScore(object, context) else 0.0;
                const local_observation = self.latestObservation(id, version);
                const proof = if (local_observation) |observation|
                    if (observation.success) Proof.verified_fresh else Proof.failed
                else
                    evidence.forCapability(id, version);
                if (proof == .verified_fresh) score = @min(0.99, score * 0.75 + 0.25);
                if (proof == .verified_stale) score = @min(0.94, score * 0.85 + 0.10);
                if (proof == .failed) score *= 0.20;
                const fast_history = if (local_observation) |observation|
                    observation.success and observation.duration_ms <= 500
                else
                    evidence.isFastFor(id, version);
                if (fast_history) score = @min(0.99, score + 0.03);
                const effect_mismatch = effectMismatch(object, context);
                if (effect_mismatch) score *= 0.75;
                try ranked.append(allocator, .{
                    .value = descriptor,
                    .score = score,
                    .available = live,
                    .proof = proof,
                    .read_only = hasOnlyReadEffects(object),
                    .fast_history = fast_history,
                    .effect_mismatch = effect_mismatch,
                });
            }
        }
        std.mem.sort(Ranked, ranked.items, {}, Ranked.lessThan);

        var aw: std.Io.Writer.Allocating = .init(allocator);
        errdefer aw.deinit();
        var out = std.json.Stringify{ .writer = &aw.writer };
        const take = @min(limit, ranked.items.len);
        const confidence: f64 = if (take == 0) 0 else ranked.items[0].score;
        const runner_up: f64 = if (take > 1) ranked.items[1].score else 0;
        const margin = @max(0, confidence - runner_up);
        var parallel_indices: [3]usize = undefined;
        var parallel_count: usize = 0;
        if (requestsParallel(context)) {
            var index: usize = 0;
            while (index < take and parallel_count < parallel_indices.len) : (index += 1) {
                const candidate = ranked.items[index];
                if (!candidate.available or !candidate.read_only or hasRequirements(candidate.value.object)) continue;
                const provider = stringField(candidate.value.object, "provider") orelse continue;
                if (std.mem.eql(u8, provider, "skill")) continue;
                var provider_seen = false;
                for (parallel_indices[0..parallel_count]) |prior_index| {
                    const prior_provider = stringField(ranked.items[prior_index].value.object, "provider") orelse "";
                    if (std.mem.eql(u8, provider, prior_provider)) provider_seen = true;
                }
                if (!provider_seen) {
                    parallel_indices[parallel_count] = index;
                    parallel_count += 1;
                }
            }
            if (parallel_count < 2) parallel_count = 0;
        }
        const top_automatic = parallel_count == 0 and take > 0 and ranked.items[0].available and
            ranked.items[0].proof == .verified_fresh and ranked.items[0].read_only and
            !std.mem.eql(u8, stringField(ranked.items[0].value.object, "provider") orelse "", "skill") and
            confidence >= 0.85 and margin >= 0.15;

        try out.beginObject();
        try out.objectField("version");
        try out.write(1);
        try out.objectField("candidates");
        try out.beginArray();
        for (ranked.items[0..take]) |item| {
            const object = item.value.object;
            try out.beginObject();
            try out.objectField("capability_id");
            try out.write(stringField(object, "id").?);
            try out.objectField("capability_version");
            try out.write(stringField(object, "capability_version").?);
            try out.objectField("provider");
            try out.write(stringField(object, "provider").?);
            try out.objectField("tool");
            try out.write(stringField(object, "tool").?);
            try out.objectField("action");
            try out.write(stringField(object, "action").?);
            try out.objectField("permission");
            try out.write(stringField(object, "permission").?);
            try out.objectField("effects");
            try out.write(object.get("effects").?);
            try out.objectField("score");
            try out.write(item.score);
            try out.objectField("status");
            try out.write(if (!item.available)
                "unavailable"
            else switch (item.proof) {
                .verified_fresh => "verified_fresh",
                .verified_stale => "verified_stale",
                .failed => "inhibited",
                .none => "available_unverified",
            });
            try out.objectField("reason_codes");
            try out.beginArray();
            if (!item.available) {
                try out.write("unavailable");
            } else {
                try out.write("context_match");
                switch (item.proof) {
                    .verified_fresh => try out.write("proven_success"),
                    .verified_stale => try out.write("stale_evidence"),
                    .failed => try out.write("recent_failure"),
                    .none => {},
                }
                if (item.fast_history) try out.write("fast_history");
                if (item.effect_mismatch) try out.write("effect_mismatch");
            }
            try out.endArray();
            try out.endObject();
        }
        try out.endArray();
        try out.objectField("sequence");
        try out.beginArray();
        if (parallel_count == 0 and take > 0 and ranked.items[0].available) {
            const object = ranked.items[0].value.object;
            if (object.get("requires")) |requires| {
                for (requires.array.items) |requirement| try out.write(requirement.string);
            }
            try out.write(stringField(object, "id").?);
        }
        try out.endArray();
        try out.objectField("parallel");
        try out.beginArray();
        for (parallel_indices[0..parallel_count]) |index| {
            try out.write(stringField(ranked.items[index].value.object, "id").?);
        }
        try out.endArray();
        try out.objectField("confidence");
        try out.write(confidence);
        try out.objectField("margin");
        try out.write(margin);
        try out.objectField("automatic");
        try out.write(top_automatic);
        try out.objectField("reason_codes");
        try out.beginArray();
        if (take == 0) {
            try out.write("no_candidates");
        } else if (!ranked.items[0].available) {
            try out.write("unavailable");
        } else switch (ranked.items[0].proof) {
            .verified_fresh => try out.write(if (top_automatic) "verified_automatic" else "verified_manual"),
            .verified_stale => try out.write("stale_evidence"),
            .failed => try out.write("recent_failure"),
            .none => try out.write("unverified"),
        }
        try out.endArray();
        try out.endObject();
        return aw.toOwnedSlice();
    }

    fn toolIsAvailable(self: *const Registry, availability: *const Availability, tool: []const u8) bool {
        // Unit callers without a live-availability snapshot retain the prior;
        // Aiko always supplies a complete prompt-scoped snapshot.
        if (availability.parsed == null) return true;
        for (self.snapshots.items) |snapshot| {
            if (std.mem.eql(u8, snapshot.source, "aiko_builtin")) continue;
            var parsed = std.json.parseFromSlice(std.json.Value, self.allocator, snapshot.json, .{}) catch continue;
            defer parsed.deinit();
            for (parsed.value.array.items) |descriptor| {
                if (descriptor != .object) continue;
                const object = descriptor.object;
                if (!std.mem.eql(u8, stringField(object, "tool") orelse "", tool)) continue;
                const id = stringField(object, "id") orelse continue;
                const version = stringField(object, "capability_version") orelse continue;
                if (availability.isAvailable(id, version, false)) return true;
            }
        }
        return false;
    }

    fn latestObservation(self: *const Registry, id: []const u8, version: []const u8) ?LatestObservation {
        for (self.observations.items) |observation| {
            if (std.mem.eql(u8, observation.id, id) and std.mem.eql(u8, observation.version, version)) return observation;
        }
        return null;
    }
};

const Ranked = struct {
    value: std.json.Value,
    score: f64,
    available: bool,
    proof: Proof,
    read_only: bool,
    fast_history: bool,
    effect_mismatch: bool,

    fn lessThan(_: void, a: Ranked, b: Ranked) bool {
        if (a.available != b.available) return a.available;
        return a.score > b.score;
    }
};

const Proof = enum { none, verified_fresh, verified_stale, failed };

const EvidenceEntry = struct {
    id: []const u8,
    version: []const u8,
    proof: Proof,
    duration_ms: ?f64,
};

const Evidence = struct {
    allocator: std.mem.Allocator,
    parsed: ?std.json.Parsed(std.json.Value),
    entries: std.ArrayList(EvidenceEntry) = .empty,

    fn init(allocator: std.mem.Allocator, json: ?[]const u8) !Evidence {
        const raw = json orelse return .{ .allocator = allocator, .parsed = null };
        if (raw.len == 0) return .{ .allocator = allocator, .parsed = null };
        const parsed = try std.json.parseFromSlice(std.json.Value, allocator, raw, .{});
        errdefer parsed.deinit();
        var entries: std.ArrayList(EvidenceEntry) = .empty;
        errdefer entries.deinit(allocator);
        if (parsed.value == .object) {
            try appendEvidenceEntry(allocator, &entries, parsed.value.object);
        } else if (parsed.value == .array) {
            for (parsed.value.array.items) |value| {
                if (value != .object) return RegistryError.InvalidJson;
                try appendEvidenceEntry(allocator, &entries, value.object);
            }
        } else return RegistryError.InvalidJson;
        return .{ .allocator = allocator, .parsed = parsed, .entries = entries };
    }

    fn appendEvidenceEntry(allocator: std.mem.Allocator, entries: *std.ArrayList(EvidenceEntry), object: std.json.ObjectMap) !void {
        const binary = stringField(object, "binary") orelse return;
        const split = std.mem.lastIndexOfScalar(u8, binary, '@') orelse return;
        const example = stringField(object, "example") orelse "";
        const freshness = stringField(object, "freshness") orelse "stale";
        try entries.append(allocator, .{
            .id = binary[0..split],
            .version = binary[split + 1 ..],
            .proof = if (example.len == 0) .failed else if (std.mem.eql(u8, freshness, "fresh")) .verified_fresh else .verified_stale,
            .duration_ms = numericValue(object.get("duration_ms")),
        });
    }

    fn deinit(self: *Evidence) void {
        self.entries.deinit(self.allocator);
        if (self.parsed) |*parsed| parsed.deinit();
    }

    fn forCapability(self: *const Evidence, id: []const u8, version: []const u8) Proof {
        for (self.entries.items) |entry| {
            if (std.mem.eql(u8, entry.id, id) and std.mem.eql(u8, entry.version, version)) return entry.proof;
        }
        return .none;
    }

    fn isFastFor(self: *const Evidence, id: []const u8, version: []const u8) bool {
        for (self.entries.items) |entry| {
            if (std.mem.eql(u8, entry.id, id) and std.mem.eql(u8, entry.version, version))
                return (entry.duration_ms orelse std.math.inf(f64)) <= 500;
        }
        return false;
    }
};

fn numericValue(value: ?std.json.Value) ?f64 {
    const actual = value orelse return null;
    return switch (actual) {
        .integer => |number| @floatFromInt(number),
        .float => |number| number,
        else => null,
    };
}

const SourceFilter = struct {
    parsed: ?std.json.Parsed(std.json.Value),
    value: ?[]const u8,
};

fn parseSourceFilter(allocator: std.mem.Allocator, json: []const u8) !SourceFilter {
    if (json.len == 0 or std.mem.eql(u8, json, "{}")) return .{ .parsed = null, .value = null };
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, json, .{});
    if (parsed.value != .object) return RegistryError.InvalidJson;
    const value = if (parsed.value.object.get("source")) |source|
        if (source == .string) source.string else return RegistryError.InvalidJson
    else
        null;
    return .{ .parsed = parsed, .value = value };
}

const Availability = struct {
    parsed: ?std.json.Parsed(std.json.Value),

    fn init(allocator: std.mem.Allocator, json: []const u8) !Availability {
        if (json.len == 0 or std.mem.eql(u8, json, "{}") or std.mem.eql(u8, json, "[]")) return .{ .parsed = null };
        const parsed = try std.json.parseFromSlice(std.json.Value, allocator, json, .{});
        if (parsed.value != .array) return RegistryError.InvalidJson;
        return .{ .parsed = parsed };
    }

    fn deinit(self: *Availability) void {
        if (self.parsed) |*parsed| parsed.deinit();
    }

    fn isAvailable(self: *const Availability, id: []const u8, version: []const u8, fallback: bool) bool {
        const parsed = self.parsed orelse return fallback;
        for (parsed.value.array.items) |entry| {
            if (entry != .object) continue;
            const object = entry.object;
            if (std.mem.eql(u8, stringField(object, "capability_id") orelse "", id) and
                std.mem.eql(u8, stringField(object, "capability_version") orelse "", version))
            {
                return boolField(object, "available") orelse false;
            }
        }
        return fallback;
    }
};

fn validSource(source: []const u8) bool {
    if (source.len == 0 or source.len > 128) return false;
    for (source) |ch| if (!(std.ascii.isAlphanumeric(ch) or ch == ':' or ch == '_' or ch == '-')) return false;
    return true;
}

fn validIdentifier(value: []const u8) bool {
    if (value.len < 3 or value.len > 255 or std.mem.indexOfScalar(u8, value, '.') == null) return false;
    for (value) |ch| if (!(std.ascii.isLower(ch) or std.ascii.isDigit(ch) or ch == ':' or ch == '_' or ch == '-' or ch == '.')) return false;
    return true;
}

/// Every field a descriptor must carry. Validation is by field shape, never by
/// an exact key count: an additive optional field must not make a whole
/// provider snapshot unroutable.
const required_descriptor_fields = [_][]const u8{
    "schema_version", "id",       "capability_version", "provider",
    "tool",           "action",   "description",        "input_schema",
    "output_schema",  "requires", "permission",         "effects",
    "available",
};

/// Declared additive fields. Unknown keys still fail closed.
const optional_descriptor_fields = [_][]const u8{"roles"};

/// A position in the receptor → predictor → planner → executor → sensor limb
/// sequence, declared by the adapter that owns the capability.
const cell_roles = [_][]const u8{ "receptor", "predictor", "planner", "executor", "sensor" };

fn validateSnapshot(allocator: std.mem.Allocator, source: []const u8, json: []const u8) !usize {
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, json, .{}) catch return RegistryError.InvalidJson;
    defer parsed.deinit();
    if (parsed.value != .array) return RegistryError.InvalidJson;
    var ids = std.StringHashMap(void).init(allocator);
    defer ids.deinit();
    for (parsed.value.array.items) |descriptor| {
        if (descriptor != .object) return RegistryError.InvalidDescriptor;
        if (containsForbiddenContent(descriptor)) return RegistryError.InvalidDescriptor;
        const object = descriptor.object;
        var keys = object.iterator();
        while (keys.next()) |entry| {
            const key = entry.key_ptr.*;
            if (!oneOf(key, &required_descriptor_fields) and !oneOf(key, &optional_descriptor_fields))
                return RegistryError.InvalidDescriptor;
        }
        for (required_descriptor_fields) |field| {
            if (!object.contains(field)) return RegistryError.InvalidDescriptor;
        }
        const schema_version = object.get("schema_version") orelse return RegistryError.InvalidDescriptor;
        if (schema_version != .integer or schema_version.integer != 1) return RegistryError.InvalidDescriptor;
        const id = stringField(object, "id") orelse return RegistryError.InvalidDescriptor;
        if (!validIdentifier(id) or ids.contains(id)) return if (ids.contains(id)) RegistryError.DuplicateCapability else RegistryError.InvalidDescriptor;
        try ids.put(id, {});
        const provider = stringField(object, "provider") orelse return RegistryError.InvalidDescriptor;
        if (!std.mem.eql(u8, provider, source)) return RegistryError.InvalidDescriptor;
        if (!std.mem.eql(u8, provider, "aiko_builtin")) {
            var prefix_buf: [132]u8 = undefined;
            const prefix = std.fmt.bufPrint(&prefix_buf, "{s}.", .{provider}) catch return RegistryError.InvalidDescriptor;
            if (!std.mem.startsWith(u8, id, prefix)) return RegistryError.InvalidDescriptor;
        }
        _ = stringField(object, "capability_version") orelse return RegistryError.InvalidDescriptor;
        _ = stringField(object, "tool") orelse return RegistryError.InvalidDescriptor;
        _ = stringField(object, "action") orelse return RegistryError.InvalidDescriptor;
        _ = stringField(object, "description") orelse return RegistryError.InvalidDescriptor;
        if ((object.get("input_schema") orelse return RegistryError.InvalidDescriptor) != .object) return RegistryError.InvalidDescriptor;
        if ((object.get("output_schema") orelse return RegistryError.InvalidDescriptor) != .object) return RegistryError.InvalidDescriptor;
        const requires = object.get("requires") orelse return RegistryError.InvalidDescriptor;
        if (requires != .array) return RegistryError.InvalidDescriptor;
        for (requires.array.items) |requirement| if (requirement != .string or !validIdentifier(requirement.string)) return RegistryError.InvalidDescriptor;
        const permission = stringField(object, "permission") orelse return RegistryError.InvalidDescriptor;
        if (!oneOf(permission, &.{ "read", "write", "network", "purchase" })) return RegistryError.InvalidDescriptor;
        const effects = object.get("effects") orelse return RegistryError.InvalidDescriptor;
        if (effects != .array or effects.array.items.len == 0) return RegistryError.InvalidDescriptor;
        for (effects.array.items) |effect| if (effect != .string or !oneOf(effect.string, &.{ "read_only", "local_write", "network_read", "network_write", "message_send", "purchase" })) return RegistryError.InvalidDescriptor;
        if (object.get("roles")) |roles| {
            if (roles != .array) return RegistryError.InvalidDescriptor;
            for (roles.array.items) |role| {
                if (role != .string or !oneOf(role.string, &cell_roles)) return RegistryError.InvalidDescriptor;
            }
        }
        _ = boolField(object, "available") orelse return RegistryError.InvalidDescriptor;
    }
    return parsed.value.array.items.len;
}

fn containsForbiddenContent(value: std.json.Value) bool {
    return switch (value) {
        .object => |object| blk: {
            var iterator = object.iterator();
            while (iterator.next()) |entry| {
                const key = entry.key_ptr.*;
                const lower_key_forbidden = containsFold(key, "api_key") or
                    containsFold(key, "apikey") or containsFold(key, "password") or
                    containsFold(key, "credential") or containsFold(key, "secret") or
                    containsFold(key, "private_key") or containsFold(key, "access_token") or
                    containsFold(key, "refresh_token") or containsFold(key, "authorization") or
                    containsFold(key, "cookie");
                if (lower_key_forbidden or containsForbiddenContent(entry.value_ptr.*)) break :blk true;
            }
            break :blk false;
        },
        .array => |array| blk: {
            for (array.items) |item| if (containsForbiddenContent(item)) break :blk true;
            break :blk false;
        },
        .string => |text| containsFold(text, "://") or containsFold(text, "bearer ") or
            containsFold(text, "cg_sk_") or containsFold(text, "sk-"),
        else => false,
    };
}

fn oneOf(value: []const u8, options: []const []const u8) bool {
    for (options) |option| if (std.mem.eql(u8, value, option)) return true;
    return false;
}

fn stringField(object: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const value = object.get(key) orelse return null;
    return if (value == .string) value.string else null;
}

fn boolField(object: std.json.ObjectMap, key: []const u8) ?bool {
    const value = object.get(key) orelse return null;
    return if (value == .bool) value.bool else null;
}

fn containsFold(haystack: []const u8, needle: []const u8) bool {
    if (needle.len == 0 or needle.len > haystack.len) return false;
    var index: usize = 0;
    while (index + needle.len <= haystack.len) : (index += 1) {
        if (std.ascii.eqlIgnoreCase(haystack[index .. index + needle.len], needle)) return true;
    }
    return false;
}

fn descriptorScore(object: std.json.ObjectMap, context: []const u8) f64 {
    var score: f64 = 0.05;
    const fields = [_][]const u8{ "tool", "action", "description" };
    for (fields) |field| {
        const value = stringField(object, field) orelse continue;
        if (containsFold(context, value)) score += 0.45;
        var words = std.mem.tokenizeAny(u8, value, " ._-:/");
        while (words.next()) |word| {
            if (word.len >= 3 and containsFold(context, word)) score += 0.12;
        }
    }
    return @min(score, 0.99);
}

fn hasOnlyReadEffects(object: std.json.ObjectMap) bool {
    const effects = object.get("effects") orelse return false;
    if (effects != .array or effects.array.items.len == 0) return false;
    for (effects.array.items) |effect| {
        if (effect != .string or !(std.mem.eql(u8, effect.string, "read_only") or
            std.mem.eql(u8, effect.string, "network_read"))) return false;
    }
    return true;
}

fn effectMismatch(object: std.json.ObjectMap, context: []const u8) bool {
    const mutation_words = [_][]const u8{
        "write", "create", "update", "delete", "remove", "send", "publish", "buy", "purchase", "submit", "edit", "click", "press", "fill", "type", "select", "check", "navigate", "close", "reload",
    };
    var requests_mutation = false;
    for (mutation_words) |word| {
        if (containsFold(context, word)) {
            requests_mutation = true;
            break;
        }
    }
    return requests_mutation != !hasOnlyReadEffects(object);
}

fn requestsParallel(context: []const u8) bool {
    const cues = [_][]const u8{ "parallel", "simultaneously", "compare", "both", "at the same time" };
    for (cues) |cue| if (containsFold(context, cue)) return true;
    return false;
}

fn hasRequirements(object: std.json.ObjectMap) bool {
    const requires = object.get("requires") orelse return true;
    return requires != .array or requires.array.items.len != 0;
}

const valid_fixture =
    \\[{"schema_version":1,"id":"mcp:github.issues.list","capability_version":"1","provider":"mcp:github","tool":"issues","action":"list","description":"List repository issues","input_schema":{},"output_schema":{},"requires":[],"permission":"network","effects":["network_read"],"available":true}]
;

test "source snapshots are validated idempotent and replace atomically" {
    var registry = Registry.init(std.testing.allocator);
    defer registry.deinit();
    try std.testing.expectEqual(@as(usize, 1), try registry.replaceSource("mcp:github", valid_fixture));
    try std.testing.expectEqual(@as(usize, 1), try registry.replaceSource("mcp:github", valid_fixture));
    try std.testing.expectEqual(@as(usize, 1), registry.snapshots.items.len);
    try std.testing.expectError(RegistryError.InvalidDescriptor, registry.replaceSource("mcp:github", "[{}]"));
    try std.testing.expectEqual(@as(usize, 1), registry.snapshots.items.len);
}

test "unknown and secret-bearing top-level fields fail closed" {
    var registry = Registry.init(std.testing.allocator);
    defer registry.deinit();
    const secret =
        \\[{"schema_version":1,"id":"mcp:github.issues.list","capability_version":"1","provider":"mcp:github","tool":"issues","action":"list","description":"List repository issues","input_schema":{},"output_schema":{},"requires":[],"permission":"network","effects":["network_read"],"available":true,"credential":"no"}]
    ;
    try std.testing.expectError(RegistryError.InvalidDescriptor, registry.replaceSource("mcp:github", secret));

    const embedded_url =
        \\[{"schema_version":1,"id":"mcp:github.issues.list","capability_version":"1","provider":"mcp:github","tool":"issues","action":"list","description":"Fetch https://private.example/issues","input_schema":{},"output_schema":{},"requires":[],"permission":"network","effects":["network_read"],"available":true}]
    ;
    try std.testing.expectError(RegistryError.InvalidDescriptor, registry.replaceSource("mcp:github", embedded_url));
}

test "declared optional roles are admitted while unknown fields still fail closed" {
    var registry = Registry.init(std.testing.allocator);
    defer registry.deinit();
    const with_roles =
        \\[{"schema_version":1,"id":"binary.rg.invoke","capability_version":"1","provider":"binary","tool":"Bash","action":"rg","description":"Run the locally installed rg command.","input_schema":{},"output_schema":{},"requires":[],"permission":"write","effects":["local_write"],"roles":["executor"],"available":true}]
    ;
    try std.testing.expectEqual(@as(usize, 1), try registry.replaceSource("binary", with_roles));

    const unknown_role =
        \\[{"schema_version":1,"id":"binary.rg.invoke","capability_version":"1","provider":"binary","tool":"Bash","action":"rg","description":"Run the locally installed rg command.","input_schema":{},"output_schema":{},"requires":[],"permission":"write","effects":["local_write"],"roles":["overlord"],"available":true}]
    ;
    try std.testing.expectError(RegistryError.InvalidDescriptor, registry.replaceSource("binary", unknown_role));

    const missing_required =
        \\[{"schema_version":1,"id":"binary.rg.invoke","capability_version":"1","provider":"binary","tool":"Bash","action":"rg","description":"Run the locally installed rg command.","input_schema":{},"output_schema":{},"requires":[],"permission":"write","roles":["executor"],"available":true}]
    ;
    try std.testing.expectError(RegistryError.InvalidDescriptor, registry.replaceSource("binary", missing_required));
}

test "versioned live availability inhibits a dynamic capability" {
    var registry = Registry.init(std.testing.allocator);
    defer registry.deinit();
    _ = try registry.replaceSource("mcp:github", valid_fixture);
    const unavailable = "[{\"capability_id\":\"mcp:github.issues.list\",\"capability_version\":\"1\",\"available\":false}]";
    const plan = try registry.recommendPlan(std.testing.allocator, "list github issues", null, unavailable, 3);
    defer std.testing.allocator.free(plan);
    try std.testing.expect(std.mem.indexOf(u8, plan, "\"status\":\"unavailable\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, plan, "\"automatic\":false") != null);
}

test "fresh evidence is version-bound and only read-only proof becomes automatic" {
    var registry = Registry.init(std.testing.allocator);
    defer registry.deinit();
    _ = try registry.replaceSource("mcp:github", valid_fixture);
    const matching = "{\"binary\":\"mcp:github.issues.list@1\",\"example\":\"shape\",\"score\":0.9,\"freshness\":\"fresh\"}";
    const verified = try registry.recommendPlan(std.testing.allocator, "list repository issues", matching, "[]", 3);
    defer std.testing.allocator.free(verified);
    try std.testing.expect(std.mem.indexOf(u8, verified, "\"status\":\"verified_fresh\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, verified, "\"automatic\":true") != null);

    const old_version = "{\"binary\":\"mcp:github.issues.list@0\",\"example\":\"shape\",\"score\":0.9,\"freshness\":\"fresh\"}";
    const unverified = try registry.recommendPlan(std.testing.allocator, "list repository issues", old_version, "[]", 3);
    defer std.testing.allocator.free(unverified);
    try std.testing.expect(std.mem.indexOf(u8, unverified, "\"status\":\"available_unverified\"") != null);
}

test "parallel plans require explicit cue independent providers and read-only effects" {
    var registry = Registry.init(std.testing.allocator);
    defer registry.deinit();
    _ = try registry.replaceSource("mcp:github", valid_fixture);
    const local =
        \\[{"schema_version":1,"id":"aiko.issues.list","capability_version":"1","provider":"aiko","tool":"issues","action":"list","description":"List local issues","input_schema":{},"output_schema":{},"requires":[],"permission":"read","effects":["read_only"],"available":true}]
    ;
    _ = try registry.replaceSource("aiko", local);
    const plan = try registry.recommendPlan(std.testing.allocator, "compare both issue lists in parallel", null, "[]", 3);
    defer std.testing.allocator.free(plan);
    try std.testing.expect(std.mem.indexOf(u8, plan, "\"sequence\":[]") != null);
    try std.testing.expect(std.mem.indexOf(u8, plan, "\"parallel\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, plan, "mcp:github.issues.list") != null);
    try std.testing.expect(std.mem.indexOf(u8, plan, "aiko.issues.list") != null);
    try std.testing.expect(std.mem.indexOf(u8, plan, "\"automatic\":false") != null);
}

test "failed evidence inhibits only its exact version and availability vetoes success" {
    var registry = Registry.init(std.testing.allocator);
    defer registry.deinit();
    _ = try registry.replaceSource("mcp:github", valid_fixture);
    const failed = "{\"binary\":\"mcp:github.issues.list@1\",\"example\":\"\",\"score\":-2,\"freshness\":\"fresh\",\"duration_ms\":42}";
    const inhibited = try registry.recommendPlan(std.testing.allocator, "list repository issues", failed, "[]", 3);
    defer std.testing.allocator.free(inhibited);
    try std.testing.expect(std.mem.indexOf(u8, inhibited, "\"status\":\"inhibited\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, inhibited, "\"recent_failure\"") != null);

    const success = "{\"binary\":\"mcp:github.issues.list@1\",\"example\":\"shape\",\"score\":0.9,\"freshness\":\"fresh\",\"duration_ms\":42}";
    const unavailable = "[{\"capability_id\":\"mcp:github.issues.list\",\"capability_version\":\"1\",\"available\":false}]";
    const vetoed = try registry.recommendPlan(std.testing.allocator, "list repository issues", success, unavailable, 3);
    defer std.testing.allocator.free(vetoed);
    try std.testing.expect(std.mem.indexOf(u8, vetoed, "\"status\":\"unavailable\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, vetoed, "\"automatic\":false") != null);
}

test "zig consumes the canonical descriptor golden fixture" {
    const descriptor = @embedFile("fixtures/fech-valid-descriptor.json");
    const snapshot = "[" ++ descriptor ++ "]";
    var registry = Registry.init(std.testing.allocator);
    defer registry.deinit();
    try std.testing.expectEqual(@as(usize, 1), try registry.replaceSource("mcp:github", snapshot));
}

test "observation validation accepts typed fixture and rejects raw result content" {
    try validateObservation(std.testing.allocator, @embedFile("fixtures/fech-valid-observation.json"));
    try std.testing.expectError(
        RegistryError.InvalidObservation,
        validateObservation(std.testing.allocator, @embedFile("fixtures/fech-invalid-secret-observation.json")),
    );
}

test "Contract-owned application priors join the registry with live tool availability" {
    const cells = @import("capability_cells.zig");
    var registry = Registry.init(std.testing.allocator);
    defer registry.deinit();
    const builtins = try cells.descriptorsJson(std.testing.allocator);
    defer std.testing.allocator.free(builtins);
    _ = try registry.replaceSource("aiko_builtin", builtins);
    const tools =
        \\[{
        \\  "schema_version":1,"id":"aiko.application_observe.invoke","capability_version":"tools-v1","provider":"aiko","tool":"application_observe","action":"invoke","description":"Observe an application","input_schema":{},"output_schema":{},"requires":[],"permission":"read","effects":["read_only"],"available":true
        \\},{
        \\  "schema_version":1,"id":"aiko.application_act.invoke","capability_version":"tools-v1","provider":"aiko","tool":"application_act","action":"invoke","description":"Act in an application","input_schema":{},"output_schema":{},"requires":[],"permission":"write","effects":["local_write"],"available":true
        \\}]
    ;
    _ = try registry.replaceSource("aiko", tools);
    const availability =
        \\[{"capability_id":"aiko.application_observe.invoke","capability_version":"tools-v1","available":true},{"capability_id":"aiko.application_act.invoke","capability_version":"tools-v1","available":true}]
    ;
    const plan = try registry.recommendPlan(std.testing.allocator, "click the login button", null, availability, 3);
    defer std.testing.allocator.free(plan);
    try std.testing.expect(std.mem.indexOf(u8, plan, "\"capability_id\":\"application.click\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, plan, "\"sequence\":[\"application.attach\",\"application.snapshot\",\"application.click\"]") != null);
    try std.testing.expect(std.mem.indexOf(u8, plan, "\"automatic\":false") != null);
}

test "skill guidance is never automatic or parallel" {
    var registry = Registry.init(std.testing.allocator);
    defer registry.deinit();
    const skill =
        \\[{"schema_version":1,"id":"skill.skill.deploy","capability_version":"1","provider":"skill","tool":"Skill","action":"deploy","description":"Deploy safely","input_schema":{},"output_schema":{},"requires":[],"permission":"read","effects":["read_only"],"available":true}]
    ;
    _ = try registry.replaceSource("skill", skill);
    const learned = "{\"binary\":\"skill.skill.deploy@1\",\"example\":\"shape\",\"score\":0.99,\"freshness\":\"fresh\"}";
    const plan = try registry.recommendPlan(std.testing.allocator, "deploy in parallel", learned, "[]", 3);
    defer std.testing.allocator.free(plan);
    try std.testing.expect(std.mem.indexOf(u8, plan, "\"automatic\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, plan, "\"parallel\":[]") != null);
}
