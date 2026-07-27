//! Canonical, importable Typed Neuron core.
//!
//! This pure package owns both the polymorphic runtime contract and the
//! generated transport DTOs. Hosts own ingress and execution adapters;
//! substrates own atomic commit, replay, outbox delivery, and persistence.

const std = @import("std");
const generated = @import("generated_wire.zig");

pub const SOURCE_SCHEMA = generated.SOURCE_SCHEMA;
pub const CORE_VERSION = generated.CORE_VERSION;
pub const HASH_PROFILE = generated.HASH_PROFILE;
pub const SCHEMA_DIGEST = generated.SCHEMA_DIGEST;
pub const FIRE_SCHEMA = generated.FIRE_SCHEMA;
pub const RESULT_SCHEMA = generated.RESULT_SCHEMA;
pub const CAPS_SCHEMA = generated.CAPS_SCHEMA;
pub const FIRING_VECTOR = generated.FIRING_VECTOR;
pub const DECISION_VECTOR = generated.DECISION_VECTOR;

pub const MAX_EFFECTS: usize = 64;
pub const MAX_EVIDENCE: usize = 64;
pub const MAX_READS: usize = 256;
pub const MAX_MESSAGES: usize = 256;
pub const MAX_GRANTS: usize = 128;

// Generated transport types. These are a codec boundary, not a second
// implementation of Neuron semantics.
pub const WireNeuronIdentity = generated.NeuronIdentity;
pub const WireMessage = generated.NeuronMessage;
pub const WireStimulus = generated.NeuronStimulus;
pub const WireGrant = generated.NeuronGrant;
pub const WireCaps = generated.NeuronCaps;
pub const WireControl = generated.NeuronControl;
pub const WireEffect = generated.NeuronEffect;
pub const Evidence = generated.NeuronEvidence;
pub const WireDecision = generated.NeuronDecision;
pub const FireRequest = generated.NeuronFireRequest;
pub const WireFireResult = generated.NeuronFireResult;
pub const WireFireStatus = generated.NeuronFireStatus;

// Canonical runtime types used by the standalone interpreter and by every
// native Neuron implementation.
pub const Digest = [32]u8;

pub const Budget = struct {
    max_effects: usize = 32,
    max_writes: usize = 8,
    max_messages: usize = 16,
    max_spawns: usize = 8,
    max_bytes: usize = 1024 * 1024,
    max_depth: u8 = 8,
};

pub const Caps = struct {
    allow_write: bool = false,
    allow_send: bool = false,
    allow_spawn: bool = false,
    write_prefix: []const u8 = "",
    send_prefix: []const u8 = "",
    spawn_prefix: []const u8 = "",
    budget: Budget = .{},
};

pub const Control = union(enum) {
    continue_wait: ?[]const u8,
    terminate: []const u8,
    branch: []const u8,
};

pub const ArtifactWrite = struct {
    id: []const u8,
    schema: []const u8,
    bytes: []const u8,
    expected_prior: ?Digest = null,
};

pub const Message = struct {
    to: []const u8,
    schema: []const u8,
    payload: []const u8,
    durable: bool = true,
};

pub const Spawn = struct {
    id: []const u8,
    kind: []const u8,
    grant: ?Caps = null,
};

pub const Effect = union(enum) {
    write: ArtifactWrite,
    send: Message,
    spawn: Spawn,
};

pub const Decision = struct {
    control: Control,
    effects: []const Effect = &.{},
    evidence: []const Evidence,
};

pub const ArtifactRef = struct {
    id: []const u8,
    digest: Digest,
};

pub const Artifact = struct {
    schema: []const u8,
    bytes: []const u8,
    digest: Digest,
};

pub const Stimulus = struct {
    firing_id: []const u8,
    receptor_schema: []const u8,
    permitted_reads: []const []const u8 = &.{},
    reads: []const ArtifactRef = &.{},
    messages: []const Message = &.{},
    now_ms: u64 = 0,
    deadline_ms: ?u64 = null,
    depth: u8 = 0,
    random: ?Digest = null,
};

/// The one polymorphic computational primitive. Configuration behind `context`
/// is immutable; all effects remain declarative data in the returned Decision.
pub const Neuron = struct {
    context: *const anyopaque,
    identity: []const u8,
    version: []const u8,
    fire_fn: *const fn (
        context: *const anyopaque,
        stimulus: Stimulus,
        caps: Caps,
    ) anyerror!Decision,

    pub fn fire(self: Neuron, stimulus: Stimulus, caps: Caps) !Decision {
        if (self.identity.len == 0 or self.version.len == 0) return error.InvalidNeuron;
        return self.fire_fn(self.context, stimulus, caps);
    }
};

pub fn bind(
    comptime T: type,
    implementation: *const T,
    identity: []const u8,
    version: []const u8,
) Neuron {
    const Adapter = struct {
        fn fire(context: *const anyopaque, stimulus: Stimulus, caps: Caps) anyerror!Decision {
            const typed: *const T = @ptrCast(@alignCast(context));
            return typed.fire(stimulus, caps);
        }
    };
    return .{
        .context = implementation,
        .identity = identity,
        .version = version,
        .fire_fn = Adapter.fire,
    };
}

pub const Error = error{
    InvalidJson,
    UnsupportedSchema,
    InvalidNeuron,
    InvalidStimulus,
    InvalidCaps,
    InvalidControl,
    InvalidEffect,
    CapabilityDenied,
    BudgetExceeded,
    MissingEvidence,
    UngroundedEvidence,
    DeadlineExceeded,
};

pub fn validate(request: FireRequest) Error!void {
    if (!std.mem.eql(u8, request.schema, FIRE_SCHEMA)) return Error.UnsupportedSchema;
    if (!safeToken(request.neuron.id) or !safeToken(request.neuron.version) or
        !validHexDigest(request.neuron.digest)) return Error.InvalidNeuron;
    if (!safeToken(request.stimulus.id) or !safeToken(request.stimulus.schema) or
        !validHexDigest(request.stimulus.payload_digest) or
        request.stimulus.read_digests.len > MAX_READS or
        request.stimulus.messages.len > MAX_MESSAGES) return Error.InvalidStimulus;
    for (request.stimulus.read_digests) |value| {
        if (!validHexDigest(value)) return Error.InvalidStimulus;
    }
    for (request.stimulus.messages) |message| {
        if (!safeToken(message.schema) or !safeToken(message.correlation_id) or
            !safeToken(message.causation_id) or !validHexDigest(message.payload_digest))
            return Error.InvalidStimulus;
    }
    if (request.stimulus.random_digest) |value| {
        if (!validHexDigest(value)) return Error.InvalidStimulus;
    }
    for (request.stimulus.adapter_versions) |adapter| {
        if (!safeToken(adapter)) return Error.InvalidStimulus;
    }
    if (request.stimulus.deadline_ms) |deadline| {
        if (request.stimulus.now_ms >= deadline) return Error.DeadlineExceeded;
    }

    if (!std.mem.eql(u8, request.caps.schema, CAPS_SCHEMA) or
        !validHexDigest(request.caps.fingerprint) or
        request.caps.max_effects > MAX_EFFECTS or
        request.caps.effects.len > MAX_EFFECTS or
        request.caps.grants.len > MAX_GRANTS) return Error.InvalidCaps;
    for (request.caps.effects, 0..) |effect_kind, index| {
        if (!validEffectKind(effect_kind) or
            contains(request.caps.effects[0..index], effect_kind)) return Error.InvalidCaps;
    }
    for (request.caps.grants) |grant| {
        if (!safeToken(grant.kind) or !safeToken(grant.target) or
            !safeToken(grant.classification)) return Error.InvalidCaps;
        if (grant.expires_ms) |expiry| {
            if (request.stimulus.now_ms >= expiry) return Error.InvalidCaps;
        }
    }

    if (request.decision.effects.len > request.caps.max_effects)
        return Error.BudgetExceeded;
    if (request.decision.evidence.len == 0) return Error.MissingEvidence;
    if (request.decision.evidence.len > MAX_EVIDENCE) return Error.InvalidJson;
    if (!validControl(request.decision.control)) return Error.InvalidControl;

    var total_bytes: u64 = 0;
    for (request.decision.effects, 0..) |effect, index| {
        if (!validEffect(effect)) return Error.InvalidEffect;
        if (!contains(request.caps.effects, effect.kind)) return Error.CapabilityDenied;
        for (request.decision.effects[0..index]) |prior| {
            if (std.mem.eql(u8, prior.idempotency_key, effect.idempotency_key))
                return Error.InvalidEffect;
        }
        total_bytes = std.math.add(u64, total_bytes, effect.bytes) catch
            return Error.BudgetExceeded;
    }
    if (total_bytes > request.caps.max_bytes) return Error.BudgetExceeded;

    for (request.decision.evidence) |evidence| {
        if (evidence.claim.len == 0 or evidence.method.len == 0 or
            evidence.sources.len == 0 or !validHexDigest(evidence.digest) or
            !safeToken(evidence.producer) or evidence.observed_at_ms == 0 or
            evidence.observed_at_ms > request.stimulus.now_ms or
            evidence.confidence_milli > 1000) return Error.MissingEvidence;
        for (evidence.sources) |source| {
            if (!std.mem.eql(u8, source, request.stimulus.payload_digest) and
                !contains(request.stimulus.read_digests, source))
                return Error.UngroundedEvidence;
        }
    }
}

fn validControl(control: WireControl) bool {
    if (!safeToken(control.value)) return false;
    return std.mem.eql(u8, control.kind, "continue") or
        std.mem.eql(u8, control.kind, "terminate") or
        std.mem.eql(u8, control.kind, "branch");
}

fn validEffect(effect: WireEffect) bool {
    if (!safeToken(effect.target) or !safeToken(effect.schema) or
        !validHexDigest(effect.payload_digest) or
        !safeToken(effect.idempotency_key)) return false;
    return validEffectKind(effect.kind);
}

fn validEffectKind(kind: []const u8) bool {
    return std.mem.eql(u8, kind, "write") or
        std.mem.eql(u8, kind, "send") or
        std.mem.eql(u8, kind, "spawn");
}

fn contains(items: []const []const u8, wanted: []const u8) bool {
    for (items) |item| if (std.mem.eql(u8, item, wanted)) return true;
    return false;
}

pub fn validHexDigest(value: []const u8) bool {
    if (value.len != 64) return false;
    for (value) |byte| if (!std.ascii.isHex(byte)) return false;
    return true;
}

fn safeToken(value: []const u8) bool {
    if (value.len == 0 or value.len > 256) return false;
    for (value) |byte| {
        if (!std.ascii.isAlphanumeric(byte) and
            byte != '.' and byte != '_' and byte != '-' and
            byte != ':' and byte != '/') return false;
    }
    return true;
}

/// Minimal deterministic-CBOR writer that streams directly into SHA-256.
/// All composite values are fixed-order arrays, avoiding map-key ambiguity.
const CborHash = struct {
    hash: std.crypto.hash.sha2.Sha256 = std.crypto.hash.sha2.Sha256.init(.{}),

    fn header(self: *CborHash, major: u8, value: u64) void {
        var first: [1]u8 = undefined;
        if (value < 24) {
            first[0] = (major << 5) | @as(u8, @intCast(value));
            self.hash.update(&first);
            return;
        }
        var encoded: [8]u8 = undefined;
        if (value <= std.math.maxInt(u8)) {
            first[0] = (major << 5) | 24;
            self.hash.update(&first);
            encoded[0] = @intCast(value);
            self.hash.update(encoded[0..1]);
        } else if (value <= std.math.maxInt(u16)) {
            first[0] = (major << 5) | 25;
            self.hash.update(&first);
            std.mem.writeInt(u16, encoded[0..2], @intCast(value), .big);
            self.hash.update(encoded[0..2]);
        } else if (value <= std.math.maxInt(u32)) {
            first[0] = (major << 5) | 26;
            self.hash.update(&first);
            std.mem.writeInt(u32, encoded[0..4], @intCast(value), .big);
            self.hash.update(encoded[0..4]);
        } else {
            first[0] = (major << 5) | 27;
            self.hash.update(&first);
            std.mem.writeInt(u64, &encoded, value, .big);
            self.hash.update(&encoded);
        }
    }

    fn unsigned(self: *CborHash, value: anytype) void {
        self.header(0, @intCast(value));
    }

    fn array(self: *CborHash, length: usize) void {
        self.header(4, @intCast(length));
    }

    fn text(self: *CborHash, value: []const u8) void {
        self.header(3, @intCast(value.len));
        self.hash.update(value);
    }

    fn bytes(self: *CborHash, value: []const u8) void {
        self.header(2, @intCast(value.len));
        self.hash.update(value);
    }

    fn boolean(self: *CborHash, value: bool) void {
        const encoded = [_]u8{if (value) 0xf5 else 0xf4};
        self.hash.update(&encoded);
    }

    fn nullValue(self: *CborHash) void {
        const encoded = [_]u8{0xf6};
        self.hash.update(&encoded);
    }

    fn finish(self: *CborHash) Digest {
        var value: Digest = undefined;
        self.hash.final(&value);
        return value;
    }

    fn finishHex(self: *CborHash) [64]u8 {
        return std.fmt.bytesToHex(self.finish(), .lower);
    }
};

fn cborTexts(cbor: *CborHash, values: []const []const u8) void {
    cbor.array(values.len);
    for (values) |value| cbor.text(value);
}

fn cborWireIdentity(cbor: *CborHash, identity: WireNeuronIdentity) void {
    cbor.array(3);
    cbor.text(identity.id);
    cbor.text(identity.version);
    cbor.text(identity.digest);
}

fn cborWireStimulus(cbor: *CborHash, stimulus: WireStimulus) void {
    cbor.array(9);
    cbor.text(stimulus.id);
    cbor.text(stimulus.schema);
    cbor.text(stimulus.payload_digest);
    cborTexts(cbor, stimulus.read_digests);
    cbor.array(stimulus.messages.len);
    for (stimulus.messages) |message| {
        cbor.array(6);
        cbor.text(message.schema);
        cbor.text(message.correlation_id);
        cbor.text(message.causation_id);
        cbor.text(message.payload_digest);
        cbor.boolean(message.durable);
        if (message.ttl_ms) |ttl| cbor.unsigned(ttl) else cbor.nullValue();
    }
    cbor.unsigned(stimulus.now_ms);
    if (stimulus.deadline_ms) |deadline| cbor.unsigned(deadline) else cbor.nullValue();
    if (stimulus.random_digest) |random| cbor.text(random) else cbor.nullValue();
    cborTexts(cbor, stimulus.adapter_versions);
}

fn cborWireCaps(cbor: *CborHash, caps: WireCaps) void {
    cbor.array(7);
    cbor.text(caps.schema);
    cbor.text(caps.fingerprint);
    cbor.array(caps.grants.len);
    for (caps.grants) |grant| {
        cbor.array(6);
        cbor.text(grant.kind);
        cbor.text(grant.target);
        cbor.text(grant.classification);
        if (grant.expires_ms) |expiry| cbor.unsigned(expiry) else cbor.nullValue();
        cbor.boolean(grant.human_approval);
        cbor.boolean(grant.delegation);
    }
    cborTexts(cbor, caps.effects);
    cbor.unsigned(caps.max_effects);
    cbor.unsigned(caps.max_bytes);
    cbor.unsigned(caps.max_cost_micros);
}

fn cborWireDecision(cbor: *CborHash, decision: WireDecision) void {
    cbor.array(3);
    cbor.array(2);
    cbor.text(decision.control.kind);
    cbor.text(decision.control.value);
    cbor.array(decision.effects.len);
    for (decision.effects) |effect| {
        cbor.array(6);
        cbor.text(effect.kind);
        cbor.text(effect.target);
        cbor.text(effect.schema);
        cbor.text(effect.payload_digest);
        cbor.unsigned(effect.bytes);
        cbor.text(effect.idempotency_key);
    }
    cbor.array(decision.evidence.len);
    for (decision.evidence) |evidence| {
        cbor.array(7);
        cbor.text(evidence.claim);
        cborTexts(cbor, evidence.sources);
        cbor.text(evidence.method);
        cbor.text(evidence.digest);
        cbor.text(evidence.producer);
        cbor.unsigned(evidence.observed_at_ms);
        cbor.unsigned(evidence.confidence_milli);
    }
}

pub fn firingId(request: FireRequest) [64]u8 {
    var cbor: CborHash = .{};
    cbor.array(5);
    cbor.text("neuron.firing/v2");
    cbor.text(request.schema);
    cborWireIdentity(&cbor, request.neuron);
    cborWireStimulus(&cbor, request.stimulus);
    cborWireCaps(&cbor, request.caps);
    return cbor.finishHex();
}

pub fn decisionDigest(request: FireRequest) [64]u8 {
    var cbor: CborHash = .{};
    cbor.array(6);
    cbor.text("neuron.decision/v2");
    cbor.text(request.schema);
    cborWireIdentity(&cbor, request.neuron);
    cborWireStimulus(&cbor, request.stimulus);
    cborWireCaps(&cbor, request.caps);
    cborWireDecision(&cbor, request.decision);
    return cbor.finishHex();
}

pub fn digest(value: []const u8) Digest {
    var result: Digest = undefined;
    std.crypto.hash.sha2.Sha256.hash(value, &result, .{});
    return result;
}

pub fn allowsDelegation(parent: Caps, child: Caps) bool {
    if (child.allow_write and (!parent.allow_write or
        !std.mem.startsWith(u8, child.write_prefix, parent.write_prefix))) return false;
    if (child.allow_send and (!parent.allow_send or
        !std.mem.startsWith(u8, child.send_prefix, parent.send_prefix))) return false;
    if (child.allow_spawn and (!parent.allow_spawn or
        !std.mem.startsWith(u8, child.spawn_prefix, parent.spawn_prefix))) return false;
    return child.budget.max_effects <= parent.budget.max_effects and
        child.budget.max_writes <= parent.budget.max_writes and
        child.budget.max_messages <= parent.budget.max_messages and
        child.budget.max_spawns <= parent.budget.max_spawns and
        child.budget.max_bytes <= parent.budget.max_bytes and
        child.budget.max_depth <= parent.budget.max_depth;
}

pub fn fingerprint(caps: Caps) Digest {
    var cbor: CborHash = .{};
    cborRuntimeCaps(&cbor, caps);
    return cbor.finish();
}

fn cborRuntimeCaps(cbor: *CborHash, caps: Caps) void {
    cbor.array(10);
    cbor.boolean(caps.allow_write);
    cbor.boolean(caps.allow_send);
    cbor.boolean(caps.allow_spawn);
    cbor.text(caps.write_prefix);
    cbor.text(caps.send_prefix);
    cbor.text(caps.spawn_prefix);
    cbor.unsigned(caps.budget.max_effects);
    cbor.unsigned(caps.budget.max_writes);
    cbor.unsigned(caps.budget.max_messages);
    cbor.array(3);
    cbor.unsigned(caps.budget.max_spawns);
    cbor.unsigned(caps.budget.max_bytes);
    cbor.unsigned(caps.budget.max_depth);
}

fn cborRuntimeStimulus(cbor: *CborHash, stimulus: Stimulus) void {
    cbor.array(9);
    cbor.text(stimulus.firing_id);
    cbor.text(stimulus.receptor_schema);
    cborTexts(cbor, stimulus.permitted_reads);
    cbor.array(stimulus.reads.len);
    for (stimulus.reads) |read| {
        cbor.array(2);
        cbor.text(read.id);
        cbor.bytes(&read.digest);
    }
    cbor.array(stimulus.messages.len);
    for (stimulus.messages) |message| {
        cbor.array(4);
        cbor.text(message.to);
        cbor.text(message.schema);
        cbor.bytes(message.payload);
        cbor.boolean(message.durable);
    }
    cbor.unsigned(stimulus.now_ms);
    if (stimulus.deadline_ms) |deadline| cbor.unsigned(deadline) else cbor.nullValue();
    cbor.unsigned(stimulus.depth);
    if (stimulus.random) |random| cbor.bytes(&random) else cbor.nullValue();
}

fn cborRuntimeDecision(cbor: *CborHash, decision: Decision) void {
    cbor.array(3);
    switch (decision.control) {
        .continue_wait => |predicate| {
            cbor.array(2);
            cbor.text("continue");
            if (predicate) |value| cbor.text(value) else cbor.nullValue();
        },
        .terminate => |value| {
            cbor.array(2);
            cbor.text("terminate");
            cbor.text(value);
        },
        .branch => |value| {
            cbor.array(2);
            cbor.text("branch");
            cbor.text(value);
        },
    }
    cbor.array(decision.effects.len);
    for (decision.effects) |effect| switch (effect) {
        .write => |write| {
            cbor.array(5);
            cbor.text("write");
            cbor.text(write.id);
            cbor.text(write.schema);
            cbor.bytes(write.bytes);
            if (write.expected_prior) |prior| cbor.bytes(&prior) else cbor.nullValue();
        },
        .send => |message| {
            cbor.array(5);
            cbor.text("send");
            cbor.text(message.to);
            cbor.text(message.schema);
            cbor.bytes(message.payload);
            cbor.boolean(message.durable);
        },
        .spawn => |spawn| {
            cbor.array(4);
            cbor.text("spawn");
            cbor.text(spawn.id);
            cbor.text(spawn.kind);
            if (spawn.grant) |grant| cborRuntimeCaps(cbor, grant) else cbor.nullValue();
        },
    };
    cbor.array(decision.evidence.len);
    for (decision.evidence) |evidence| {
        cbor.array(7);
        cbor.text(evidence.claim);
        cborTexts(cbor, evidence.sources);
        cbor.text(evidence.method);
        cbor.text(evidence.digest);
        cbor.text(evidence.producer);
        cbor.unsigned(evidence.observed_at_ms);
        cbor.unsigned(evidence.confidence_milli);
    }
}

pub fn runtimeDecisionDigest(stimulus: Stimulus, caps: Caps, decision: Decision) Digest {
    var cbor: CborHash = .{};
    cbor.array(4);
    cbor.text("neuron.runtime-decision/v2");
    cborRuntimeStimulus(&cbor, stimulus);
    cborRuntimeCaps(&cbor, caps);
    cborRuntimeDecision(&cbor, decision);
    return cbor.finish();
}

pub fn runtimeStimulusDigest(stimulus: Stimulus) Digest {
    var cbor: CborHash = .{};
    cbor.array(2);
    cbor.text("neuron.runtime-stimulus/v2");
    cborRuntimeStimulus(&cbor, stimulus);
    return cbor.finish();
}

const digest_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const digest_b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const digest_c = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

fn validFixture() FireRequest {
    return .{
        .schema = FIRE_SCHEMA,
        .neuron = .{
            .id = "skill/aiko-meta-agent/aiko-meta-agent--settle",
            .version = "2.0.0",
            .digest = digest_a,
        },
        .stimulus = .{
            .id = "turn-1",
            .schema = "aiko.turn/v1",
            .payload_digest = digest_b,
            .now_ms = 2,
            .deadline_ms = 10,
            .adapter_versions = &.{"aiko-host/2"},
        },
        .caps = .{
            .schema = CAPS_SCHEMA,
            .fingerprint = digest_c,
            .effects = &.{"write"},
            .max_effects = 1,
            .max_bytes = 16,
        },
        .decision = .{
            .control = .{ .kind = "terminate", .value = "complete" },
            .effects = &.{.{
                .kind = "write",
                .target = "contract:turn-1",
                .schema = "aiko.turn-result/v1",
                .payload_digest = digest_b,
                .bytes = 8,
                .idempotency_key = "turn-1/0",
            }},
            .evidence = &.{.{
                .claim = "typed terminal adapter reached its bounded boundary",
                .sources = &.{digest_b},
                .method = "host result adapter",
                .digest = digest_c,
                .producer = "adapter/aiko-turn-terminal",
                .observed_at_ms = 1,
                .confidence_milli = 1000,
            }},
        },
    };
}

test "generated schema identity and deterministic CBOR wire vectors are stable" {
    const request = validFixture();
    try validate(request);
    try std.testing.expectEqualStrings("typed-neuron/2", CORE_VERSION);
    try std.testing.expectEqualStrings("deterministic-cbor-sha256/1", HASH_PROFILE);
    try std.testing.expectEqualSlices(u8, &firingId(request), &firingId(request));
    try std.testing.expectEqualSlices(u8, &decisionDigest(request), &decisionDigest(request));
    try std.testing.expectEqualStrings(
        FIRING_VECTOR,
        &firingId(request),
    );
    try std.testing.expectEqualStrings(
        DECISION_VECTOR,
        &decisionDigest(request),
    );
}

test "wire authority budget grounding and changed decisions fail closed" {
    var request = validFixture();
    request.caps.effects = &.{"send"};
    try std.testing.expectError(Error.CapabilityDenied, validate(request));
    request = validFixture();
    request.caps.max_bytes = 1;
    try std.testing.expectError(Error.BudgetExceeded, validate(request));
    request = validFixture();
    var bad_evidence = [_]Evidence{request.decision.evidence[0]};
    bad_evidence[0].sources = &.{digest_c};
    request.decision.evidence = &bad_evidence;
    try std.testing.expectError(Error.UngroundedEvidence, validate(request));
    request = validFixture();
    const before = decisionDigest(request);
    request.decision.control.value = "different";
    try std.testing.expect(!std.mem.eql(u8, &before, &decisionDigest(request)));
}

test "runtime primitive binds and canonical Caps deny by default" {
    const Static = struct {
        fn fire(_: *const @This(), _: Stimulus, _: Caps) !Decision {
            return .{
                .control = .{ .terminate = "done" },
                .evidence = &.{.{
                    .claim = "fixture",
                    .sources = &.{"stimulus"},
                    .method = "test",
                }},
            };
        }
    };
    const implementation = Static{};
    const neuron = bind(Static, &implementation, "fixture", "1");
    const result = try neuron.fire(.{
        .firing_id = "fixture-1",
        .receptor_schema = "fixture/v1",
    }, .{});
    try std.testing.expect(result.control == .terminate);
    try std.testing.expect(!(Caps{}).allow_write);
}
