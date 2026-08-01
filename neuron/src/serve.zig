//! Inbound served interfaces (`neuron.published-interface/v1`): the node is
//! *called through* a boundary instead of *calling out through* one.
//!
//! An outbound `neuron.interface-manifest/v1` pins a callee — `locator` plus
//! `implementation_digest` — and records what that callee promises this node.
//! A published manifest flips exactly one thing: direction. `bind.path` is
//! where this node listens, `handler_digest` pins the admitted limb that
//! answers, and `accepts`/`emits`/`errors` become this node's promise to a
//! caller. The contract already existed; it was simply never served.
//!
//! Five refusals are structural here, not advisory:
//!
//!   1. **Only an admitted, unrevoked, attached port answers.** A published
//!      document sitting on disk serves nothing; an unadmitted or revoked
//!      digest 404s. Never a 500, never a partial answer — a request that
//!      resolves to no live port must be indistinguishable from a request to
//!      a path this node never published.
//!   2. **The handler is re-verified before every request.** Package digest,
//!      `limbs/admitted` present, `limbs/revoked` absent, `limbs/detached`
//!      absent — the same three checks `limb_ops.limbRun` makes. Revoking the
//!      handler kills the port at the *next request*, not the next restart
//!      (invariant 13 pointed inbound).
//!   3. **The grant is a function of (agent, published manifest) only.** No
//!      header, body field, or peer identity can widen it; a peer may only
//!      *deny*. That is invariant 6 ("an adapter cannot widen its caller's
//!      Caps") inverted, and it is the whole distance between a published
//!      interface and an execute-anything capability.
//!   4. **No artifact payload is ever streamed.** The response carries the
//!      product of *this caller's own firing*, under the port's own derived
//!      write prefix, and nothing else. There is no endpoint that takes an
//!      artifact id, no journal tail, no directory listing. An inbound port
//!      that could name an artifact is an exfiltration surface, and the whole
//!      substrate is reachable from one.
//!   5. **A served command does not execute during the request.** Its handler
//!      commits content and an outbox record in ONE firing and the response is
//!      the outbox *address*, not a result. Crossing stays the outbox's job.
//!
//! Binding is loopback-only unless the operator explicitly opts out, exactly as
//! `observe.zig` does, and the inbound HTTP framing is that module's framing
//! reused rather than a second parser.
//!
//! INTEGRATION NOTE. This module is self-contained on purpose: it was written
//! alongside sibling features and depends on no file they also touch, so it
//! carries its own published-manifest parser, publish/attach records, and port
//! slots. `src/publication.zig` and `src/port_bind.zig` landed concurrently
//! with overlapping cores. The piece that is only here is the operator-facing
//! listener: `port http <node_dir> --listen <ip:port> [--allow-public]`, which
//! opens the substrate PER REQUEST (so a limb or a record can be revoked from
//! another process while the listener is up) and refuses a non-loopback bind.
//! At integration, keep `serveHttp` and re-point `resolveRoute`/`serveRequest`
//! at whichever core is chosen; the publish/attach/revoke/detach verbs here are
//! the ones to drop, not the listener.

const std = @import("std");
const types = @import("types.zig");
const caps_mod = @import("caps.zig");
const substrate_mod = @import("substrate.zig");
const runtime_mod = @import("runtime.zig");
const neuron_mod = @import("neuron.zig");
const script_mod = @import("script.zig");
const run_mod = @import("run.zig");
const limb_ops = @import("limb_ops.zig");
const membrane = @import("membrane.zig");

const Allocator = std.mem.Allocator;
const Sha256 = std.crypto.hash.sha2.Sha256;
const net = std.Io.net;

pub const PUBLISHED_SCHEMA = "neuron.published-interface/v1";

/// Domain separator for a published document's digest. A published digest must
/// never be presentable where an outbound admitted digest is expected, in
/// either direction — so the two are computed under different domains and can
/// never collide even for byte-identical documents (§2 of the frozen design).
pub const PUBLISHED_DOMAIN = "neuron.published-interface/v1\n";

pub const PUBLICATION_SCHEMA = "neuron.published-admission/v1";
pub const PUBLICATION_REVOCATION_SCHEMA = "neuron.published-revocation/v1";
pub const PORT_ATTACHMENT_SCHEMA = "neuron.port-attachment/v1";
pub const REQUEST_SCHEMA = "neuron.served-request/v1";

pub const PUBLISHED_PREFIX = "interfaces/published/";
pub const PUBLISHED_REVOKED_PREFIX = "interfaces/published-revoked/";

/// Port slots live in their own namespace, deliberately disjoint from
/// `agents/<agent>/interfaces/<role>/<step>`. `liveChain` walks *that* prefix,
/// and a chain means "step N's product is step N+1's input" — two served
/// contracts are not a pipeline. Keeping ports out of the chain namespace makes
/// the work-plan hop walker structurally unable to receive a served surface,
/// which is a stronger guarantee than refusing a role at run time.
pub const PORT_PREFIX_FMT = "agents/{s}/ports/{d:0>2}";
pub const MAX_PORTS = 8;

/// A hard ceiling read before any route is resolved, so an oversized body is
/// refused before its bytes are ever pulled off the socket.
pub const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
pub const MAX_HEADERS = 64;
pub const MAX_PATH_BYTES = 256;

/// The hard ceiling on what *any* published interface may hold, independent of
/// which agent later attaches it. The budget numbers are the interface
/// ceiling's, single-sourced, because an inbound boundary is not entitled to
/// more than an outbound one. Only the send namespace differs: a served
/// command's outbox record must not land where the outbound interface
/// dispatcher looks, or the existing dispatcher would try to cross a record
/// that names no admitted outbound interface.
pub const PORT_CAPS_CEILING: caps_mod.Caps = .{
    .allow_write = true,
    .write_prefix = "agents/",
    .allow_send = true,
    .send_prefix = "outbox/served/",
    .allow_spawn = false,
    .spawn_prefix = "",
    .budget = membrane.CAPS_CEILING.budget,
};

pub const Error = error{
    /// The document is not a well-formed published interface, or it carries a
    /// field that belongs to an outbound manifest. Never silently ignored: an
    /// operator who believes an `implementation_digest` is pinned when nothing
    /// checks it has been lied to.
    InvalidPublishedInterface,
    IncompletePublishedInterface,
    /// A boundary with no declared typed surface is not describable, so it is
    /// not publishable — the same refusal as `UntypedInterface`, inbound.
    UntypedPublishedInterface,
    InterfaceHandlerNotAdmitted,
    InterfaceHandlerUnresolvable,
    /// The handler limb's bytes moved after the pin was taken.
    InterfaceHandlerDrift,
    InterfacePortOccupied,
    InterfacePathInvalid,
    InterfacePoisonedRequest,
    InterfaceRequestTruncated,
    InterfaceRequestTooLarge,
    InterfaceCallerDenied,
    InterfaceNotPublished,
    InterfacePublicationRevoked,
    InterfaceNoLivePort,
    InterfacePortsExhausted,
    InterfaceCapsWidened,
    /// The handler produced something outside what the port promised in
    /// `emits`, or produced nothing at all.
    InterfaceProductOutsideContract,
    /// A published command whose handler committed no outbox record. A command
    /// that queued nothing is not a command.
    InterfaceCommandNotQueued,
    CorruptPublishedRecord,
    ServeAddressNotLoopback,
    InvalidListenAddress,
};

/// Which listener carries the contract. `mcp` is deliberately absent: the
/// existing stdio JSON-RPC edge can carry published contracts with no new
/// framing at all, so inventing a second one here would be premature.
pub const Transport = enum {
    neuron_wire,
    http,

    pub fn parse(text: []const u8) ?Transport {
        return std.meta.stringToEnum(Transport, text);
    }

    pub fn name(self: Transport) []const u8 {
        return @tagName(self);
    }
};

/// Where a request's firing identity comes from. `caller_supplied` never means
/// "the caller names the firing": the key is one input to a domain-separated
/// digest that also binds the published digest and the peer (see
/// `servedFiringId`).
pub const FiringIdSource = enum {
    content,
    caller_supplied,

    pub fn parse(text: []const u8) ?FiringIdSource {
        return std.meta.stringToEnum(FiringIdSource, text);
    }

    pub fn name(self: FiringIdSource) []const u8 {
        return @tagName(self);
    }
};

/// Deny-by-default. `tailnet` names a pinned ceiling that only exists for an
/// attested tailnet peer; a raw HTTP socket carries no such attestation, so an
/// http port declaring `tailnet` refuses every caller rather than pretending a
/// TCP source address is an identity.
pub const CallerMode = enum {
    deny_all,
    tailnet,
    listed,

    pub fn parse(text: []const u8) ?CallerMode {
        return std.meta.stringToEnum(CallerMode, text);
    }

    pub fn name(self: CallerMode) []const u8 {
        return @tagName(self);
    }
};

/// Fields that only mean something for an *outbound* boundary. Presence is a
/// refusal rather than an ignored key: silently dropping an
/// `implementation_digest` would let an operator believe a pin exists that
/// nothing ever checks — exactly the failure `InterfaceDigestDrift` exists to
/// prevent, in reverse.
pub const FORBIDDEN_FIELDS = [_][]const u8{
    "locator",                "implementation_digest", "argv_template",
    "target_template",        "input_channel",         "url_template",
    "response_encoding",      "response_field",        "non_mutating",
    "reconcile_url_template", "reconcile_encoding",    "reconcile_field",
    "idempotency_header",     "tool",                  "provider",
    "model_name",             "protocol",              "cost_micros",
    "device_role",            "device_state_template", "human_interaction",
    "approval_interface",     "payment_adapter",       "payment_approval_interface",
    "payment_response_field",
};

/// The admitted description of one boundary this node *serves*. Slices borrow
/// from the bytes the document was parsed out of; parse into an arena and
/// discard both together.
pub const PublishedManifest = struct {
    id: []const u8,
    version: []const u8,
    transport: Transport,
    /// Absolute, literal served path. No placeholders: a `{param}` route
    /// segment would be an input channel with no schema, and `accepts` is the
    /// only admissible one.
    bind_path: []const u8,
    bind_method: membrane.Method,
    /// Required for a command, forbidden otherwise. It is the independent
    /// read-back that lets `UnverifiableCommand` cross the publish/consume
    /// boundary instead of stopping at it: a publisher who exposes no sensor
    /// simply cannot be consumed as a command.
    bind_reconcile_path: []const u8 = "",
    handler_digest: types.Digest,
    handler_neuron: []const u8,
    receptor_schema: []const u8,
    firing_id_source: FiringIdSource = .content,
    max_request_bytes: usize,
    max_concurrent: u32,
    caller_mode: CallerMode = .deny_all,
    caller_peers: []const []const u8 = &.{},
    accepts: []const []const u8,
    emits: []const []const u8,
    errors: []const []const u8,
    invocation: membrane.Invocation = .{},
    requested_caps: caps_mod.Caps = .{},
    input_classes: []const []const u8 = &.{},
    output_classes: []const []const u8 = &.{},
    evidence_claim: []const u8,
    evidence_method: []const u8,
    settlement: []const u8,
    /// Digest of the exact document bytes under `PUBLISHED_DOMAIN`.
    manifest_digest: types.Digest = std.mem.zeroes(types.Digest),

    pub fn manifestHex(self: *const PublishedManifest) [64]u8 {
        return std.fmt.bytesToHex(self.manifest_digest, .lower);
    }

    pub fn handlerHex(self: *const PublishedManifest) [64]u8 {
        return std.fmt.bytesToHex(self.handler_digest, .lower);
    }

    pub fn emitsSchema(self: *const PublishedManifest, schema: []const u8) bool {
        for (self.emits) |candidate| if (std.mem.eql(u8, candidate, schema)) return true;
        return false;
    }
};

/// The document digest, domain-separated. Byte-identical documents admitted
/// through the outbound path and the published path produce different digests,
/// so neither record key can ever be presented as the other's.
pub fn publishedDigest(bytes: []const u8) types.Digest {
    var hasher = Sha256.init(.{});
    hasher.update(PUBLISHED_DOMAIN);
    hasher.update(bytes);
    var out: types.Digest = undefined;
    hasher.final(&out);
    return out;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// A served path is a literal route, validated the same way a filesystem
/// interface's relative target is: no traversal, no placeholders, no query, no
/// control bytes. Everything a caller may vary travels in the body, where a
/// schema governs it.
pub fn validateServedPath(path: []const u8) !void {
    if (path.len == 0 or path.len > MAX_PATH_BYTES) return Error.InterfacePathInvalid;
    if (path[0] != '/') return Error.InterfacePathInvalid;
    if (path.len > 1 and path[path.len - 1] == '/') return Error.InterfacePathInvalid;
    if (std.mem.indexOf(u8, path, "//") != null) return Error.InterfacePathInvalid;
    // `/agents/<agent>` is the namespace the harness owns (R4). A published
    // path that started with it could shadow another agent's mount point.
    if (std.mem.startsWith(u8, path, "/agents/")) return Error.InterfacePathInvalid;
    var parts = std.mem.splitScalar(u8, path[1..], '/');
    var segments: usize = 0;
    while (parts.next()) |segment| {
        segments += 1;
        if (segment.len == 0) return Error.InterfacePathInvalid;
        if (std.mem.eql(u8, segment, ".") or std.mem.eql(u8, segment, ".."))
            return Error.InterfacePathInvalid;
        for (segment) |c| {
            const ok = (c >= 'a' and c <= 'z') or (c >= 'A' and c <= 'Z') or
                (c >= '0' and c <= '9') or c == '-' or c == '_' or c == '.';
            if (!ok) return Error.InterfacePathInvalid;
        }
    }
    if (segments == 0 or segments > 8) return Error.InterfacePathInvalid;
}

/// Which field a publish/validate refusal was about, and — for an enum or
/// bounded field — what it would have accepted. Populated only when the
/// caller passes a non-null pointer: the served HTTP path resolves a route
/// through `resolvePublished(..., null)` and computes nothing extra, so a
/// caller can learn nothing beyond the refusal itself (module doc, refusal
/// 1 — an unadmitted, revoked, or never-published route must 404
/// indistinguishably). Only the operator-facing `port publish` CLI passes a
/// pointer and prints what comes back.
pub const PublishDiagnostic = struct {
    field: []const u8 = "",
    detail: []const u8 = "",
};

fn setDiag(diag: ?*PublishDiagnostic, field: []const u8, detail: []const u8) void {
    const d = diag orelse return;
    d.field = field;
    d.detail = detail;
}

fn str(value: std.json.Value, key: []const u8) ?[]const u8 {
    if (value != .object) return null;
    const field = value.object.get(key) orelse return null;
    return switch (field) {
        .string => |s| s,
        else => null,
    };
}

fn int(value: std.json.Value, key: []const u8) ?i64 {
    if (value != .object) return null;
    const field = value.object.get(key) orelse return null;
    return switch (field) {
        .integer => |i| i,
        else => null,
    };
}

fn boolean(value: std.json.Value, key: []const u8, default: bool) bool {
    if (value != .object) return default;
    const field = value.object.get(key) orelse return default;
    return switch (field) {
        .bool => |b| b,
        else => default,
    };
}

fn stringList(
    a: Allocator,
    value: std.json.Value,
    key: []const u8,
    diag_field: []const u8,
    diag: ?*PublishDiagnostic,
) ![]const []const u8 {
    if (value != .object) return &.{};
    const field = value.object.get(key) orelse return &.{};
    if (field != .array) {
        setDiag(diag, diag_field, "must be an array of strings");
        return Error.InvalidPublishedInterface;
    }
    var out: std.ArrayList([]const u8) = .empty;
    for (field.array.items) |item| {
        if (item != .string) {
            setDiag(diag, diag_field, "must be an array of strings");
            return Error.InvalidPublishedInterface;
        }
        try out.append(a, item.string);
    }
    return out.items;
}

fn safeId(id: []const u8) bool {
    if (id.len == 0 or id.len > 128) return false;
    for (id) |c| {
        const ok = (c >= 'a' and c <= 'z') or (c >= 'A' and c <= 'Z') or
            (c >= '0' and c <= '9') or c == '-' or c == '_' or c == '.' or c == '/';
        if (!ok) return false;
    }
    return true;
}

/// Capability request from JSON. `script.capsFromJson` cannot be reused here:
/// its unstated budget fields fall back to the permissive global defaults,
/// which on this path would mean an omitted `max_spawns` silently exceeding the
/// port ceiling. An absent field must never be a widening, so an unstated
/// budget is the ceiling.
fn capsFromJson(value: std.json.Value, diag: ?*PublishDiagnostic) !caps_mod.Caps {
    if (value != .object) {
        setDiag(diag, "requested_caps", "must be an object");
        return Error.InvalidPublishedInterface;
    }
    var caps: caps_mod.Caps = .{
        .allow_write = boolean(value, "allow_write", false),
        .allow_send = boolean(value, "allow_send", false),
        .allow_spawn = boolean(value, "allow_spawn", false),
        .write_prefix = str(value, "write_prefix") orelse "",
        .send_prefix = str(value, "send_prefix") orelse "",
        .spawn_prefix = str(value, "spawn_prefix") orelse "",
        .budget = PORT_CAPS_CEILING.budget,
    };
    if (value.object.get("budget")) |budget| {
        if (budget != .object) {
            setDiag(diag, "requested_caps.budget", "must be an object");
            return Error.InvalidPublishedInterface;
        }
        if (int(budget, "max_effects")) |v| caps.budget.max_effects = @intCast(v);
        if (int(budget, "max_writes")) |v| caps.budget.max_writes = @intCast(v);
        if (int(budget, "max_messages")) |v| caps.budget.max_messages = @intCast(v);
        if (int(budget, "max_spawns")) |v| caps.budget.max_spawns = @intCast(v);
        if (int(budget, "max_bytes")) |v| caps.budget.max_bytes = @intCast(v);
        if (int(budget, "max_depth")) |v| caps.budget.max_depth = @intCast(v);
        if (int(budget, "max_turns")) |v| caps.budget.max_turns = @intCast(v);
    }
    return caps;
}

/// A published manifest declares which *classes* of authority its handler
/// needs; the harness picks the exact namespace (`grantForPort`). A manifest
/// that names a prefix is trying to name its own write target, which is
/// precisely what derived grants exist to prevent — so a declared prefix is a
/// refusal, not a preference, and the class/budget check is performed against
/// the namespaces the harness will actually derive.
fn requestedWithinCeiling(requested: caps_mod.Caps) bool {
    if (requested.write_prefix.len != 0) return false;
    if (requested.send_prefix.len != 0) return false;
    if (requested.spawn_prefix.len != 0) return false;
    if (requested.allow_spawn) return false;
    var probe = requested;
    probe.write_prefix = PORT_CAPS_CEILING.write_prefix;
    probe.send_prefix = PORT_CAPS_CEILING.send_prefix;
    return caps_mod.allowsDelegation(PORT_CAPS_CEILING, probe);
}

/// Parse and fully validate a published interface document. Every rejection is
/// typed: a partially understood served surface is exactly the case that must
/// not be admitted.
pub fn parsePublished(a: Allocator, bytes: []const u8) !PublishedManifest {
    return parsePublishedDiag(a, bytes, null);
}

/// Same refusal decisions as `parsePublished`; when `diag` is non-null, every
/// refusal additionally names the offending field (and, for an enum, what it
/// would have accepted) before returning. Passing `diag` is safe on any path
/// because the field name never substitutes for or narrows the returned
/// `Error` — a caller reading only the error still sees exactly what it saw
/// before. Only pass non-null from operator-facing code (see `PublishDiagnostic`).
pub fn parsePublishedDiag(a: Allocator, bytes: []const u8, diag: ?*PublishDiagnostic) !PublishedManifest {
    const root = std.json.parseFromSliceLeaky(std.json.Value, a, bytes, .{}) catch {
        setDiag(diag, "<document>", "not well-formed JSON");
        return Error.InvalidPublishedInterface;
    };
    if (root != .object) {
        setDiag(diag, "<document>", "must be a JSON object");
        return Error.InvalidPublishedInterface;
    }
    const schema = str(root, "schema") orelse {
        setDiag(diag, "schema", "required; must be \"" ++ PUBLISHED_SCHEMA ++ "\"");
        return Error.InvalidPublishedInterface;
    };
    if (!std.mem.eql(u8, schema, PUBLISHED_SCHEMA)) {
        setDiag(diag, "schema", "must be \"" ++ PUBLISHED_SCHEMA ++ "\"");
        return Error.InvalidPublishedInterface;
    }

    for (FORBIDDEN_FIELDS) |field| {
        if (root.object.contains(field)) {
            setDiag(diag, field, "outbound-only field; not admissible on a published (inbound) manifest");
            return Error.InvalidPublishedInterface;
        }
    }

    var published: PublishedManifest = .{
        .id = str(root, "id") orelse {
            setDiag(diag, "id", "required string");
            return Error.IncompletePublishedInterface;
        },
        .version = str(root, "version") orelse {
            setDiag(diag, "version", "required string");
            return Error.IncompletePublishedInterface;
        },
        .transport = undefined,
        .bind_path = "",
        .bind_method = .POST,
        .handler_digest = undefined,
        .handler_neuron = str(root, "handler_neuron") orelse {
            setDiag(diag, "handler_neuron", "required string");
            return Error.IncompletePublishedInterface;
        },
        .receptor_schema = str(root, "receptor_schema") orelse {
            setDiag(diag, "receptor_schema", "required string");
            return Error.IncompletePublishedInterface;
        },
        .max_request_bytes = 0,
        .max_concurrent = 0,
        .accepts = try stringList(a, root, "accepts", "accepts", diag),
        .emits = try stringList(a, root, "emits", "emits", diag),
        .errors = try stringList(a, root, "errors", "errors", diag),
        .evidence_claim = str(root, "evidence_claim") orelse {
            setDiag(diag, "evidence_claim", "required string");
            return Error.IncompletePublishedInterface;
        },
        .evidence_method = str(root, "evidence_method") orelse {
            setDiag(diag, "evidence_method", "required string");
            return Error.IncompletePublishedInterface;
        },
        .settlement = str(root, "settlement") orelse {
            setDiag(diag, "settlement", "required string");
            return Error.IncompletePublishedInterface;
        },
        .manifest_digest = publishedDigest(bytes),
    };
    if (!safeId(published.id)) {
        setDiag(diag, "id", "1-128 chars of [A-Za-z0-9._/-]");
        return Error.IncompletePublishedInterface;
    }
    if (published.version.len == 0) {
        setDiag(diag, "version", "must be non-empty");
        return Error.IncompletePublishedInterface;
    }
    if (published.evidence_claim.len == 0) {
        setDiag(diag, "evidence_claim", "must be non-empty");
        return Error.IncompletePublishedInterface;
    }
    if (published.evidence_method.len == 0) {
        setDiag(diag, "evidence_method", "must be non-empty");
        return Error.IncompletePublishedInterface;
    }
    if (published.settlement.len == 0) {
        setDiag(diag, "settlement", "must be non-empty");
        return Error.IncompletePublishedInterface;
    }
    if (published.accepts.len == 0) {
        setDiag(diag, "accepts", "must declare at least one schema");
        return Error.UntypedPublishedInterface;
    }
    if (published.emits.len == 0) {
        setDiag(diag, "emits", "must declare at least one schema");
        return Error.UntypedPublishedInterface;
    }
    if (published.errors.len == 0) {
        setDiag(diag, "errors", "must declare at least one schema");
        return Error.UntypedPublishedInterface;
    }
    if (!safeId(published.handler_neuron)) {
        setDiag(diag, "handler_neuron", "1-128 chars of [A-Za-z0-9._/-]");
        return Error.IncompletePublishedInterface;
    }

    const transport_text = str(root, "transport") orelse {
        setDiag(diag, "transport", "required string; one of neuron_wire|http");
        return Error.IncompletePublishedInterface;
    };
    published.transport = Transport.parse(transport_text) orelse {
        setDiag(diag, "transport", "must be one of neuron_wire|http");
        return Error.InvalidPublishedInterface;
    };

    const handler_hex = str(root, "handler_digest") orelse {
        setDiag(diag, "handler_digest", "required string; 64 lowercase hex chars");
        return Error.IncompletePublishedInterface;
    };
    published.handler_digest = script_mod.digestFromHex(handler_hex) catch {
        setDiag(diag, "handler_digest", "must be 64 lowercase hex chars");
        return Error.IncompletePublishedInterface;
    };

    const invocation = root.object.get("invocation") orelse {
        setDiag(diag, "invocation", "required object");
        return Error.IncompletePublishedInterface;
    };
    if (invocation != .object) {
        setDiag(diag, "invocation", "must be an object");
        return Error.IncompletePublishedInterface;
    }
    published.invocation = .{
        .mode = membrane.Mode.parse(str(invocation, "mode") orelse ""),
        .streaming = boolean(invocation, "streaming", false),
        .deterministic = boolean(invocation, "deterministic", false),
        .idempotency = membrane.Idempotency.parse(str(invocation, "idempotency") orelse ""),
        .timeout_ms = blk: {
            const raw = int(invocation, "timeout_ms") orelse 2000;
            if (raw <= 0 or raw > membrane.MAX_TIMEOUT_MS) {
                setDiag(diag, "invocation.timeout_ms", "must be > 0 and <= membrane.MAX_TIMEOUT_MS");
                return Error.InvalidPublishedInterface;
            }
            break :blk @intCast(raw);
        },
        .max_output_bytes = blk: {
            const raw = int(invocation, "max_output_bytes") orelse 64 * 1024;
            if (raw <= 0 or raw > membrane.MAX_OUTPUT_BYTES) {
                setDiag(diag, "invocation.max_output_bytes", "must be > 0 and <= membrane.MAX_OUTPUT_BYTES");
                return Error.InvalidPublishedInterface;
            }
            break :blk @intCast(raw);
        },
    };
    // Streaming deltas stay inert until a complete typed result is decoded
    // (invariant 7). There is no server-side streaming either: a partial
    // answer is not a typed answer.
    if (published.invocation.streaming) {
        setDiag(diag, "invocation.streaming", "must be false or omitted; server-side streaming is not supported");
        return Error.IncompletePublishedInterface;
    }

    const bind = root.object.get("bind") orelse {
        setDiag(diag, "bind", "required object");
        return Error.IncompletePublishedInterface;
    };
    if (bind != .object) {
        setDiag(diag, "bind", "must be an object");
        return Error.IncompletePublishedInterface;
    }
    published.bind_path = str(bind, "path") orelse {
        setDiag(diag, "bind.path", "required string");
        return Error.IncompletePublishedInterface;
    };
    validateServedPath(published.bind_path) catch |err| {
        setDiag(diag, "bind.path", "absolute literal path: no {param}, no '.'/'..', no '//', not under /agents/, 1-8 segments of [A-Za-z0-9._-]");
        return err;
    };
    if (std.mem.indexOfScalar(u8, published.bind_path, '{') != null or
        std.mem.indexOfScalar(u8, published.bind_path, '}') != null)
    {
        setDiag(diag, "bind.path", "no {param} placeholders; a served route is a literal");
        return Error.InterfacePathInvalid;
    }
    if (str(bind, "method")) |method_text| {
        published.bind_method = membrane.Method.parse(method_text) orelse {
            setDiag(diag, "bind.method", "must be one of GET|HEAD|POST|PUT|PATCH|DELETE");
            return Error.InvalidPublishedInterface;
        };
    }
    if (str(bind, "reconcile_path")) |reconcile| {
        validateServedPath(reconcile) catch |err| {
            setDiag(diag, "bind.reconcile_path", "absolute literal path: no {param}, no '.'/'..', no '//', not under /agents/, 1-8 segments of [A-Za-z0-9._-]");
            return err;
        };
        published.bind_reconcile_path = reconcile;
    }
    switch (published.invocation.mode) {
        .command => if (published.bind_reconcile_path.len == 0) {
            setDiag(diag, "bind.reconcile_path", "required when invocation.mode=command (a served command must expose an independent read-back)");
            return Error.IncompletePublishedInterface;
        },
        // A read that advertises a sensor is claiming a consequence it does not
        // have; the field means nothing on this path and is refused rather than
        // ignored.
        .read => if (published.bind_reconcile_path.len != 0) {
            setDiag(diag, "bind.reconcile_path", "must be absent when invocation.mode=read");
            return Error.InvalidPublishedInterface;
        },
    }
    // A safe method must never carry consequence. A command reachable by GET or
    // HEAD is a mutation any prefetcher, link preview, or crawler can trigger
    // without a caller ever deciding to. The converse is deliberately allowed:
    // a read served over POST is merely uncacheable, not unsafe, and a typed
    // request body has to travel somewhere.
    if (published.invocation.mode == .command and published.bind_method.safe()) {
        setDiag(diag, "bind.method", "a command must not be served over a safe method (GET/HEAD)");
        return Error.InvalidPublishedInterface;
    }

    if (str(root, "firing_id_source")) |source_text| {
        published.firing_id_source = FiringIdSource.parse(source_text) orelse {
            setDiag(diag, "firing_id_source", "must be one of content|caller_supplied");
            return Error.InvalidPublishedInterface;
        };
    }
    // A caller key may only participate in a firing identity where an
    // idempotency discipline exists to give it meaning. Without one, a peer
    // would be choosing identities in this node's WAL namespace for free.
    if (published.firing_id_source == .caller_supplied and
        published.invocation.idempotency == .none)
    {
        setDiag(diag, "invocation.idempotency", "required (intrinsic|keyed) when firing_id_source=caller_supplied");
        return Error.InvalidPublishedInterface;
    }

    const raw_request = int(root, "max_request_bytes") orelse {
        setDiag(diag, "max_request_bytes", "required integer");
        return Error.IncompletePublishedInterface;
    };
    if (raw_request <= 0 or raw_request > MAX_REQUEST_BYTES) {
        setDiag(diag, "max_request_bytes", "must be > 0 and <= MAX_REQUEST_BYTES");
        return Error.InvalidPublishedInterface;
    }
    published.max_request_bytes = @intCast(raw_request);

    const raw_concurrent = int(root, "max_concurrent") orelse {
        setDiag(diag, "max_concurrent", "required integer");
        return Error.IncompletePublishedInterface;
    };
    if (raw_concurrent <= 0 or raw_concurrent > 1024) {
        setDiag(diag, "max_concurrent", "must be > 0 and <= 1024");
        return Error.InvalidPublishedInterface;
    }
    published.max_concurrent = @intCast(raw_concurrent);

    if (root.object.get("callers")) |callers| {
        if (callers != .object) {
            setDiag(diag, "callers", "must be an object");
            return Error.InvalidPublishedInterface;
        }
        const mode_text = str(callers, "mode") orelse {
            setDiag(diag, "callers.mode", "required string; one of deny_all|tailnet|listed");
            return Error.IncompletePublishedInterface;
        };
        published.caller_mode = CallerMode.parse(mode_text) orelse {
            setDiag(diag, "callers.mode", "deny_all|tailnet|listed");
            return Error.InvalidPublishedInterface;
        };
        published.caller_peers = try stringList(a, callers, "peers", "callers.peers", diag);
    }
    if (published.caller_mode == .listed and published.caller_peers.len == 0) {
        setDiag(diag, "callers.peers", "required (non-empty) when callers.mode=listed");
        return Error.IncompletePublishedInterface;
    }

    if (root.object.get("requested_caps")) |value| {
        published.requested_caps = try capsFromJson(value, diag);
    }
    if (root.object.get("data_flow")) |flow| {
        if (flow != .object) {
            setDiag(diag, "data_flow", "must be an object");
            return Error.InvalidPublishedInterface;
        }
        published.input_classes = try stringList(a, flow, "input_classes", "data_flow.input_classes", diag);
        published.output_classes = try stringList(a, flow, "output_classes", "data_flow.output_classes", diag);
    }
    // Charging a caller is the opposite direction from the outbound economic
    // profile and needs its own document, not a reversed field (R7).
    if (str(root, "economics")) |economics| {
        if (!std.mem.eql(u8, economics, "none")) {
            setDiag(diag, "economics", "must be \"none\"; charging a caller needs its own document (R7)");
            return Error.InvalidPublishedInterface;
        }
    }

    // The schema a request is admitted as must be one this port declared it
    // accepts. Without this, the port is an execute-anything capability
    // wearing a contract.
    var receptor_declared = false;
    for (published.accepts) |candidate| {
        if (std.mem.eql(u8, candidate, published.receptor_schema)) receptor_declared = true;
    }
    if (!receptor_declared) {
        setDiag(diag, "receptor_schema", "must be one of the schemas listed in accepts");
        return Error.InvalidPublishedInterface;
    }

    if (!requestedWithinCeiling(published.requested_caps)) {
        setDiag(diag, "requested_caps", "exceeds the port ceiling: write_prefix/send_prefix/spawn_prefix must be unset and allow_spawn must be false");
        return Error.InterfaceCapsWidened;
    }
    // A command must be able to reach the outbox; a read must not be able to
    // send at all. Sending is the whole consequence of a served command.
    switch (published.invocation.mode) {
        .command => if (!published.requested_caps.allow_send) {
            setDiag(diag, "requested_caps.allow_send", "required (true) when invocation.mode=command");
            return Error.IncompletePublishedInterface;
        },
        .read => if (published.requested_caps.allow_send) {
            setDiag(diag, "requested_caps.allow_send", "must be false when invocation.mode=read");
            return Error.InvalidPublishedInterface;
        },
    }
    return published;
}

// ---------------------------------------------------------------------------
// Publication: the authority step
// ---------------------------------------------------------------------------

const publication_sources = [_][]const u8{"stimulus"};

fn evidence(a: Allocator, claim: []const u8, method: []const u8) ![]types.Evidence {
    const items = try a.alloc(types.Evidence, 1);
    items[0] = .{ .claim = claim, .sources = &publication_sources, .method = method };
    return items;
}

fn harnessCaps(write_prefix: []const u8) caps_mod.Caps {
    return .{
        .allow_write = true,
        .write_prefix = write_prefix,
        .allow_send = true,
        .send_prefix = "event/",
        .budget = .{ .max_effects = 8, .max_writes = 4, .max_messages = 4 },
    };
}

pub const Check = struct {
    name: []const u8,
    ok: bool,
    detail: []const u8,
};

pub fn batteryPassed(checks: []const Check) bool {
    for (checks) |check| if (!check.ok) return false;
    return true;
}

/// Is this digest a live admitted limb package on this node? These are the same
/// three checks `limb_ops.limbRun` makes before it will fire anything, and they
/// are the only reason a `handler_digest` means more than a number.
pub fn handlerLive(
    a: Allocator,
    substrate: *const substrate_mod.Substrate,
    handler_hex: []const u8,
) !void {
    const admitted = try std.fmt.allocPrint(a, "artifact/limbs/admitted/{s}", .{handler_hex});
    if (!substrate.artifacts.contains(admitted)) return Error.InterfaceHandlerNotAdmitted;
    const revoked = try std.fmt.allocPrint(a, "artifact/limbs/revoked/{s}", .{handler_hex});
    if (substrate.artifacts.contains(revoked)) return Error.InterfaceHandlerNotAdmitted;
    const detached = try std.fmt.allocPrint(a, "artifact/limbs/detached/{s}", .{handler_hex});
    if (substrate.artifacts.contains(detached)) return Error.InterfaceHandlerNotAdmitted;
}

/// The adversarial battery for a served surface. Admission refuses a manifest
/// whose battery fails; this runs in the trusted base for the same reason
/// `runBattery` does — if a limb decided admissibility, a compromised limb
/// could approve its own successor.
pub fn runBattery(
    a: Allocator,
    substrate: *const substrate_mod.Substrate,
    published: *const PublishedManifest,
) ![]Check {
    var checks: std.ArrayList(Check) = .empty;
    const handler_hex = published.handlerHex();

    try checks.append(a, .{
        .name = "manifest-typed",
        .ok = true,
        .detail = try std.fmt.allocPrint(a, "{s} · transport={s} · mode={s}", .{
            published.id,
            published.transport.name(),
            published.invocation.mode.name(),
        }),
    });

    if (handlerLive(a, substrate, &handler_hex)) |_| {
        try checks.append(a, .{
            .name = "handler-live",
            .ok = true,
            .detail = try a.dupe(u8, handler_hex[0..16]),
        });
    } else |err| {
        try checks.append(a, .{ .name = "handler-live", .ok = false, .detail = @errorName(err) });
    }

    const within = requestedWithinCeiling(published.requested_caps);
    try checks.append(a, .{
        .name = "caps-least-authority",
        .ok = within,
        .detail = if (within)
            "requested caps are inside the interface ceiling"
        else
            "requested caps exceed the interface ceiling",
    });

    const path_ok = if (validateServedPath(published.bind_path)) |_| true else |_| false;
    try checks.append(a, .{
        .name = "path-literal",
        .ok = path_ok,
        .detail = published.bind_path,
    });

    const reconcile_ok = switch (published.invocation.mode) {
        .command => published.bind_reconcile_path.len > 0,
        .read => published.bind_reconcile_path.len == 0,
    };
    try checks.append(a, .{
        .name = "command-reconcilable",
        .ok = reconcile_ok,
        .detail = if (published.invocation.mode == .command)
            "a served command exposes an independent read-back"
        else
            "a served read declares no sensor",
    });

    // Deny-by-default is a property of the document, not of the deployment: a
    // port that never says who may call it must refuse everyone.
    try checks.append(a, .{
        .name = "callers-deny-by-default",
        .ok = true,
        .detail = published.caller_mode.name(),
    });
    return checks.toOwnedSlice(a);
}

pub const PublishResult = struct {
    published_digest: [64]u8,
    handler_digest: [64]u8,
    id: []const u8,
    mode: membrane.Mode,
    path: []const u8,
    created: bool,
    checks: []const Check,
};

/// Publication is the authority boundary. It re-checks the handler against live
/// substrate state, runs the battery itself rather than trusting a prior test
/// run, and writes an immutable record naming the exact document and handler
/// digests. A published document has no authority until this succeeds — and
/// even then it serves nothing until a port attachment resolves it.
pub fn publishCore(
    a: Allocator,
    substrate: *substrate_mod.Substrate,
    document: []const u8,
    diag: ?*PublishDiagnostic,
) !PublishResult {
    const published = try parsePublishedDiag(a, document, diag);
    const published_hex = published.manifestHex();
    const handler_hex = published.handlerHex();

    const checks = try runBattery(a, substrate, &published);
    if (!batteryPassed(checks)) return Error.InterfaceHandlerNotAdmitted;

    const record = try std.json.Stringify.valueAlloc(a, .{
        .schema = PUBLICATION_SCHEMA,
        .id = published.id,
        .version = published.version,
        .transport = published.transport.name(),
        .path = published.bind_path,
        .method = published.bind_method.name(),
        .mode = published.invocation.mode.name(),
        .receptor_schema = published.receptor_schema,
        .handler_digest = handler_hex[0..],
        .handler_neuron = published.handler_neuron,
        .published_digest = published_hex[0..],
        .manifest = document,
    }, .{});

    const record_id = try std.fmt.allocPrint(a, PUBLISHED_PREFIX ++ "{s}", .{&published_hex});
    const firing_id = try std.fmt.allocPrint(a, "published/admission/{s}", .{&published_hex});
    var fx = [_]types.Effect{
        .{ .write = .{ .id = record_id, .schema = PUBLICATION_SCHEMA, .bytes = record } },
    };
    const runtime: runtime_mod.Runtime = .{ .substrate = substrate };
    const result = runtime.execute(.{
        .firing_id = firing_id,
        .receptor_schema = PUBLICATION_SCHEMA,
    }, harnessCaps(PUBLISHED_PREFIX), .{
        .control = .{ .terminate = "published" },
        .effects = &fx,
        .evidence = try evidence(
            a,
            "published document validated, handler re-checked against live limb state, battery passed",
            "published interface admission",
        ),
    }) catch |err| switch (err) {
        // Re-publishing the identical document is a no-op, not a conflict.
        error.FiringAlreadySettled, error.FiringMismatch => return .{
            .published_digest = published_hex,
            .handler_digest = handler_hex,
            .id = published.id,
            .mode = published.invocation.mode,
            .path = published.bind_path,
            .created = false,
            .checks = checks,
        },
        else => return err,
    };
    return .{
        .published_digest = published_hex,
        .handler_digest = handler_hex,
        .id = published.id,
        .mode = published.invocation.mode,
        .path = published.bind_path,
        .created = result.effects_committed > 0,
        .checks = checks,
    };
}

/// Revocation stops the *next* request before dispatch. It does not detach:
/// detach precedes revoke exactly as it does for limbs (R6), and the audit edge
/// outlives the revocation.
pub fn revokePublishedCore(
    a: Allocator,
    substrate: *substrate_mod.Substrate,
    published_hex: []const u8,
) !void {
    const record_id = try std.fmt.allocPrint(a, PUBLISHED_PREFIX ++ "{s}", .{published_hex});
    if (!substrate.artifacts.contains(record_id)) return Error.InterfaceNotPublished;
    const revoked_id = try std.fmt.allocPrint(a, PUBLISHED_REVOKED_PREFIX ++ "{s}", .{published_hex});
    const firing_id = try std.fmt.allocPrint(a, "published/revocation/{s}", .{published_hex});
    var fx = [_]types.Effect{
        .{ .write = .{
            .id = revoked_id,
            .schema = PUBLICATION_REVOCATION_SCHEMA,
            .bytes = published_hex,
        } },
    };
    const runtime: runtime_mod.Runtime = .{ .substrate = substrate };
    _ = runtime.execute(.{
        .firing_id = firing_id,
        .receptor_schema = PUBLICATION_REVOCATION_SCHEMA,
    }, harnessCaps(PUBLISHED_REVOKED_PREFIX), .{
        .control = .{ .terminate = "revoked" },
        .effects = &fx,
        .evidence = try evidence(
            a,
            "published interface revoked; the next request fails closed before dispatch",
            "published interface revocation",
        ),
    }) catch |err| switch (err) {
        error.FiringAlreadySettled, error.FiringMismatch => return,
        else => return err,
    };
}

/// Resolve a published, unrevoked record into a parsed manifest. Both checks
/// happen on every path that could lead to a request being served — this is the
/// function that makes an unadmitted or revoked digest a 404.
pub fn resolvePublished(
    a: Allocator,
    substrate: *const substrate_mod.Substrate,
    published_hex: []const u8,
) !PublishedManifest {
    const record_id = try std.fmt.allocPrint(a, PUBLISHED_PREFIX ++ "{s}", .{published_hex});
    const artifact = substrate.artifacts.get(record_id) orelse return Error.InterfaceNotPublished;
    if (!std.mem.eql(u8, artifact.schema, PUBLICATION_SCHEMA)) return Error.CorruptPublishedRecord;
    const revoked_id = try std.fmt.allocPrint(a, PUBLISHED_REVOKED_PREFIX ++ "{s}", .{published_hex});
    if (substrate.artifacts.contains(revoked_id)) return Error.InterfacePublicationRevoked;

    const record = std.json.parseFromSliceLeaky(std.json.Value, a, artifact.bytes, .{}) catch
        return Error.CorruptPublishedRecord;
    const embedded = record.object.get("manifest") orelse return Error.CorruptPublishedRecord;
    if (embedded != .string) return Error.CorruptPublishedRecord;
    return parsePublished(a, embedded.string);
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

pub const Port = struct {
    published_hex: [64]u8,
    /// The operator's local path to the handler limb package. The substrate
    /// stores the package *manifest*, never its files, so the bytes have to be
    /// re-hashed from somewhere — and that somewhere is named at attach, by the
    /// operator, not by the caller.
    package_dir: []const u8,
    slot: usize,
    attached: bool,
};

pub fn portId(a: Allocator, agent: []const u8, slot: usize) ![]const u8 {
    return std.fmt.allocPrint(a, PORT_PREFIX_FMT, .{ agent, slot });
}

fn readPort(
    a: Allocator,
    substrate: *const substrate_mod.Substrate,
    agent: []const u8,
    slot: usize,
) !?Port {
    const id = try portId(a, agent, slot);
    const artifact = substrate.artifacts.get(id) orelse return null;
    const record = std.json.parseFromSliceLeaky(std.json.Value, a, artifact.bytes, .{}) catch
        return Error.CorruptPublishedRecord;
    if (record != .object) return Error.CorruptPublishedRecord;
    const published = record.object.get("published") orelse return Error.CorruptPublishedRecord;
    if (published != .string or published.string.len != 64) return Error.CorruptPublishedRecord;
    const status = record.object.get("status") orelse return Error.CorruptPublishedRecord;
    if (status != .string) return Error.CorruptPublishedRecord;
    const package = record.object.get("package_dir") orelse return Error.CorruptPublishedRecord;
    if (package != .string) return Error.CorruptPublishedRecord;

    var hex: [64]u8 = undefined;
    @memcpy(&hex, published.string);
    return .{
        .published_hex = hex,
        .package_dir = package.string,
        .slot = slot,
        .attached = std.mem.eql(u8, status.string, "attached"),
    };
}

/// Every live port of one agent. Deliberately NOT a chain: ports are unordered,
/// so a detached slot is skipped rather than truncating the scan. A chain
/// stopping at a hole prevents silent reordering; a port set has no order to
/// reorder, and truncating there would silently unpublish routes.
pub fn livePorts(
    a: Allocator,
    substrate: *const substrate_mod.Substrate,
    agent: []const u8,
) ![]Port {
    var out: std.ArrayList(Port) = .empty;
    var slot: usize = 0;
    while (slot < MAX_PORTS) : (slot += 1) {
        const port = (try readPort(a, substrate, agent, slot)) orelse continue;
        if (!port.attached) continue;
        try out.append(a, port);
    }
    return out.toOwnedSlice(a);
}

pub const ResolvedHandler = struct {
    argv: []const []const u8,
    declared_caps: caps_mod.Caps,
    version: []const u8,
    deadline_ms: ?u64,
};

/// Invariant 13 pointed inbound: the handler's bytes must still hash to the
/// pinned digest, the limb must still be admitted, and it must be neither
/// revoked nor detached. This runs at attach AND before every single request,
/// so revoking the handler kills the port at the next request rather than at
/// the next restart.
pub fn verifyHandler(
    a: Allocator,
    io: std.Io,
    substrate: *const substrate_mod.Substrate,
    published: *const PublishedManifest,
    package_dir: []const u8,
) !ResolvedHandler {
    const pinned = published.handlerHex();
    const live = limb_ops.computePackageDigest(a, io, package_dir) catch
        return Error.InterfaceHandlerUnresolvable;
    const live_hex = std.fmt.bytesToHex(live, .lower);
    if (!std.mem.eql(u8, &pinned, &live_hex)) return Error.InterfaceHandlerDrift;
    try handlerLive(a, substrate, &pinned);

    const admission_id = try std.fmt.allocPrint(a, "artifact/limbs/admitted/{s}", .{&pinned});
    const admission_artifact = substrate.artifacts.get(admission_id) orelse
        return Error.InterfaceHandlerNotAdmitted;
    const admission = std.json.parseFromSliceLeaky(std.json.Value, a, admission_artifact.bytes, .{}) catch
        return Error.CorruptPublishedRecord;
    if (admission != .object) return Error.CorruptPublishedRecord;
    const package_field = admission.object.get("package") orelse return Error.CorruptPublishedRecord;
    if (package_field != .string) return Error.CorruptPublishedRecord;
    const manifest = std.json.parseFromSliceLeaky(std.json.Value, a, package_field.string, .{}) catch
        return Error.CorruptPublishedRecord;
    if (manifest != .object) return Error.CorruptPublishedRecord;

    // A handler naming a neuron the package does not declare must fail at
    // attach, never as a 404 at request time: a route that resolves to nothing
    // is indistinguishable from a route that was never published, and an
    // operator would never learn the port was broken.
    const resolved = run_mod.resolveNeuronArgv(a, manifest, package_dir, published.handler_neuron) catch
        return Error.InterfaceHandlerUnresolvable;

    var deadline: ?u64 = null;
    if (manifest.object.get("budgets")) |budgets| {
        if (budgets == .object) {
            if (budgets.object.get("deadline_ms_per_firing")) |v| {
                if (v == .integer and v.integer > 0) deadline = @intCast(v.integer);
            }
        }
    }
    const version = blk: {
        const package = manifest.object.get("package") orelse break :blk "0.0.0";
        _ = package;
        break :blk str(manifest, "version") orelse "0.0.0";
    };
    return .{
        .argv = resolved.argv,
        .declared_caps = resolved.caps,
        .version = version,
        .deadline_ms = deadline,
    };
}

pub const AttachResult = struct {
    slot: usize,
    published_hex: [64]u8,
    route: []const u8,
    created: bool,
};

/// Attach a published interface to one agent as a live port. Path uniqueness is
/// agent-local by construction (R4): the served route is
/// `/agents/<agent><bind.path>`, so two agents may publish the same path and
/// neither can shadow the other. No cross-agent scan, no cross-agent invariant.
pub fn attachPortCore(
    a: Allocator,
    io: std.Io,
    substrate: *substrate_mod.Substrate,
    agent: []const u8,
    published_hex: []const u8,
    package_dir: []const u8,
) !AttachResult {
    const published = try resolvePublished(a, substrate, published_hex);
    _ = try verifyHandler(a, io, substrate, &published, package_dir);

    var slot: usize = 0;
    var free_slot: ?usize = null;
    while (slot < MAX_PORTS) : (slot += 1) {
        const existing = (try readPort(a, substrate, agent, slot)) orelse {
            if (free_slot == null) free_slot = slot;
            continue;
        };
        if (!existing.attached) {
            if (free_slot == null) free_slot = slot;
            continue;
        }
        if (std.mem.eql(u8, &existing.published_hex, published_hex)) {
            return .{
                .slot = slot,
                .published_hex = existing.published_hex,
                .route = try routeFor(a, agent, published.bind_path),
                .created = false,
            };
        }
        const other = try resolvePublished(a, substrate, &existing.published_hex);
        // One route, one contract. Two live ports on one path would make which
        // contract answers depend on scan order.
        if (std.mem.eql(u8, other.bind_path, published.bind_path))
            return Error.InterfacePortOccupied;
    }
    const target = free_slot orelse return Error.InterfacePortsExhausted;

    const record = try std.json.Stringify.valueAlloc(a, .{
        .schema = PORT_ATTACHMENT_SCHEMA,
        .agent = agent,
        .published = published_hex,
        .package_dir = package_dir,
        .path = published.bind_path,
        .route = try routeFor(a, agent, published.bind_path),
        .status = "attached",
    }, .{});
    const record_id = try portId(a, agent, target);
    const firing_id = try std.fmt.allocPrint(a, "published/attach/{s}/{s}", .{ agent, published_hex });
    var fx = [_]types.Effect{
        .{
            .write = .{
                .id = record_id,
                .schema = PORT_ATTACHMENT_SCHEMA,
                .bytes = record,
                // Reusing a detached slot overwrites a record that already exists;
                // the compare-and-set is what keeps a concurrent attach from
                // silently clobbering another one.
                .expected_prior = priorDigest(substrate, record_id),
            },
        },
    };
    const prefix = try std.fmt.allocPrint(a, "agents/{s}/ports/", .{agent});
    const runtime: runtime_mod.Runtime = .{ .substrate = substrate };
    _ = runtime.execute(.{
        .firing_id = firing_id,
        .receptor_schema = PORT_ATTACHMENT_SCHEMA,
    }, harnessCaps(prefix), .{
        .control = .{ .terminate = "attached" },
        .effects = &fx,
        .evidence = try evidence(
            a,
            "published interface bound to an agent-local route with a re-verified handler",
            "port attachment",
        ),
    }) catch |err| switch (err) {
        error.FiringAlreadySettled, error.FiringMismatch => {},
        else => return err,
    };
    var hex: [64]u8 = undefined;
    @memcpy(&hex, published_hex);
    return .{
        .slot = target,
        .published_hex = hex,
        .route = try routeFor(a, agent, published.bind_path),
        .created = true,
    };
}

/// Detach releases the route. The attachment record stays, flipped to
/// `detached`: the audit outlives the edge (invariant 15).
pub fn detachPortCore(
    a: Allocator,
    substrate: *substrate_mod.Substrate,
    agent: []const u8,
    published_hex: []const u8,
) !usize {
    var slot: usize = 0;
    while (slot < MAX_PORTS) : (slot += 1) {
        const existing = (try readPort(a, substrate, agent, slot)) orelse continue;
        if (!std.mem.eql(u8, &existing.published_hex, published_hex)) continue;
        if (!existing.attached) return slot;

        const record = try std.json.Stringify.valueAlloc(a, .{
            .schema = PORT_ATTACHMENT_SCHEMA,
            .agent = agent,
            .published = published_hex,
            .package_dir = existing.package_dir,
            .status = "detached",
        }, .{});
        const record_id = try portId(a, agent, slot);
        const firing_id = try std.fmt.allocPrint(a, "published/detach/{s}/{s}", .{ agent, published_hex });
        var fx = [_]types.Effect{
            .{ .write = .{
                .id = record_id,
                .schema = PORT_ATTACHMENT_SCHEMA,
                .bytes = record,
                .expected_prior = priorDigest(substrate, record_id),
            } },
        };
        const prefix = try std.fmt.allocPrint(a, "agents/{s}/ports/", .{agent});
        const runtime: runtime_mod.Runtime = .{ .substrate = substrate };
        _ = runtime.execute(.{
            .firing_id = firing_id,
            .receptor_schema = PORT_ATTACHMENT_SCHEMA,
        }, harnessCaps(prefix), .{
            .control = .{ .terminate = "detached" },
            .effects = &fx,
            .evidence = try evidence(
                a,
                "port released; the route resolves to nothing and the record remains for audit",
                "port detachment",
            ),
        }) catch |err| switch (err) {
            error.FiringAlreadySettled, error.FiringMismatch => {},
            else => return err,
        };
        return slot;
    }
    return Error.InterfaceNoLivePort;
}

/// The digest a slot currently holds, or null when it is unwritten. Flipping a
/// port record is a compare-and-set against exactly what was read, never a
/// blind overwrite.
fn priorDigest(substrate: *const substrate_mod.Substrate, id: []const u8) ?types.Digest {
    const artifact = substrate.artifacts.get(id) orelse return null;
    return artifact.digest;
}

pub fn routeFor(a: Allocator, agent: []const u8, bind_path: []const u8) ![]const u8 {
    return std.fmt.allocPrint(a, "/agents/{s}{s}", .{ agent, bind_path });
}

// ---------------------------------------------------------------------------
// Grant derivation and firing identity
// ---------------------------------------------------------------------------

/// The authority a served request confers. The decisive property is that this
/// is a function of `(agent, published manifest)` and NOTHING else: no header,
/// body field, or peer identity appears in it. A peer may only cause a denial
/// before this is ever called. That is invariant 6 inverted, and it is what
/// keeps a published interface from becoming an execute-anything capability.
pub fn grantForPort(
    a: Allocator,
    agent: []const u8,
    published_hex: []const u8,
    published: *const PublishedManifest,
) !caps_mod.Caps {
    const limit = PORT_CAPS_CEILING;
    const requested = published.requested_caps;
    return .{
        .allow_write = requested.allow_write,
        // One contract's whole surface is revocable by prefix, and a caller of
        // contract A can never touch contract B's artifacts.
        .write_prefix = try std.fmt.allocPrint(a, "agents/{s}/served/{s}/", .{ agent, published_hex }),
        .allow_send = requested.allow_send,
        // Deliberately NOT the outbound interface outbox: a served command's
        // record must not be mistaken for an admitted outbound call by the
        // existing dispatcher.
        .send_prefix = try std.fmt.allocPrint(a, "outbox/served/{s}/", .{published_hex}),
        .allow_spawn = false,
        .spawn_prefix = "",
        .budget = .{
            .max_effects = @min(requested.budget.max_effects, limit.budget.max_effects),
            .max_writes = @min(requested.budget.max_writes, limit.budget.max_writes),
            .max_messages = @min(requested.budget.max_messages, limit.budget.max_messages),
            .max_spawns = 0,
            // Also min'd against the inbound ceiling, so a caller cannot buy
            // budget by sending a bigger body.
            .max_bytes = @min(
                @min(requested.budget.max_bytes, limit.budget.max_bytes),
                published.max_request_bytes,
            ),
            .max_depth = @min(requested.budget.max_depth, limit.budget.max_depth),
            .max_turns = @min(requested.budget.max_turns, limit.budget.max_turns),
        },
    };
}

/// Intersect a derived grant with a limb's own declared request. Every field
/// can only shrink; there is no branch here that can widen anything.
fn narrow(grant: caps_mod.Caps, declared: caps_mod.Caps) caps_mod.Caps {
    var out = grant;
    out.allow_write = grant.allow_write and declared.allow_write;
    out.allow_send = grant.allow_send and declared.allow_send;
    out.allow_spawn = false;
    out.budget = .{
        .max_effects = @min(grant.budget.max_effects, declared.budget.max_effects),
        .max_writes = @min(grant.budget.max_writes, declared.budget.max_writes),
        .max_messages = @min(grant.budget.max_messages, declared.budget.max_messages),
        .max_spawns = 0,
        .max_bytes = @min(grant.budget.max_bytes, declared.budget.max_bytes),
        .max_depth = @min(grant.budget.max_depth, declared.budget.max_depth),
        .max_turns = @min(grant.budget.max_turns, declared.budget.max_turns),
    };
    return out;
}

/// Firing identity for a served request (operator ruling R2).
///
///   firing_id = H(PUBLISHED_DOMAIN || published_hex || peer || key)
///
/// A caller key NEVER becomes a firing id directly. If it did, a hostile peer
/// could deliberately collide with another peer's key and force a replay of
/// that peer's recorded response — naming an identity inside this node's WAL
/// namespace. Domain separation by published digest AND peer identity makes
/// that structurally impossible: two peers presenting the same key get two
/// distinct firings, and neither can read the other's result.
pub fn servedFiringId(
    a: Allocator,
    published_hex: []const u8,
    peer: []const u8,
    key: []const u8,
) ![]const u8 {
    var hasher = Sha256.init(.{});
    hasher.update(PUBLISHED_DOMAIN);
    hasher.update(published_hex);
    hasher.update("\n");
    hasher.update(peer);
    hasher.update("\n");
    hasher.update(key);
    var out: types.Digest = undefined;
    hasher.final(&out);
    const hex = std.fmt.bytesToHex(out, .lower);
    return std.fmt.allocPrint(a, "served/{s}/{s}", .{ published_hex, &hex });
}

/// A stable, port-independent name for a peer. The ephemeral source port is
/// deliberately excluded: it would make every request from one peer a new
/// identity and defeat replay entirely.
pub fn peerText(a: Allocator, address: net.IpAddress) ![]const u8 {
    return switch (address) {
        .ip4 => |v4| std.fmt.allocPrint(a, "ip4:{d}.{d}.{d}.{d}", .{
            v4.bytes[0], v4.bytes[1], v4.bytes[2], v4.bytes[3],
        }),
        .ip6 => |v6| std.fmt.allocPrint(a, "ip6:{s}", .{
            std.fmt.bytesToHex(v6.bytes, .lower),
        }),
    };
}

/// Deny-by-default peer admission. A peer may only ever *narrow* what happens
/// next; nothing here can widen the grant, because the grant does not take a
/// peer as an input at all.
pub fn callerAdmitted(published: *const PublishedManifest, peer: []const u8) bool {
    return switch (published.caller_mode) {
        .deny_all => false,
        // A raw socket carries no attested tailnet identity. Refusing is the
        // only honest answer: treating a source address as an identity would be
        // pretending to an attestation this transport cannot make.
        .tailnet => false,
        .listed => blk: {
            for (published.caller_peers) |candidate| {
                if (std.mem.eql(u8, candidate, peer)) break :blk true;
            }
            break :blk false;
        },
    };
}

// ---------------------------------------------------------------------------
// The serve path
// ---------------------------------------------------------------------------

pub const Status = enum { served, queued, replayed };

pub const Served = struct {
    status: Status,
    /// Read path only: the product of THIS firing. Never any other artifact.
    product: []const u8 = "",
    product_id: []const u8 = "",
    product_schema: []const u8 = "",
    product_digest: [64]u8 = [_]u8{'0'} ** 64,
    /// Command path only: where the outbox record landed. Nothing has crossed.
    outbox_address: []const u8 = "",
    firing_id: []const u8 = "",
};

/// Reconstruct what a firing already committed, without re-running anything.
/// The committed firing record IS the receipt: the WAL already carries the
/// firing, its artifacts and its messages, so a duplicate request is answered
/// from durable state rather than by firing the handler a second time.
fn replayOf(
    a: Allocator,
    substrate: *const substrate_mod.Substrate,
    published: *const PublishedManifest,
    firing_id: []const u8,
    write_prefix: []const u8,
) !?Served {
    const record = substrate.firings.get(firing_id) orelse return null;
    if (record.status != .committed) return null;

    switch (published.invocation.mode) {
        .read => {
            const product = (try productOf(a, substrate, firing_id, write_prefix)) orelse
                return Error.InterfaceProductOutsideContract;
            return .{
                .status = .replayed,
                .product = product.bytes,
                .product_id = product.id,
                .product_schema = product.schema,
                .product_digest = product.hex,
                .firing_id = firing_id,
            };
        },
        .command => {
            for (substrate.messages.items) |message| {
                if (!std.mem.eql(u8, message.firing_id, firing_id)) continue;
                return .{
                    .status = .replayed,
                    .outbox_address = try a.dupe(u8, message.to),
                    .firing_id = firing_id,
                };
            }
            return Error.InterfaceCommandNotQueued;
        },
    }
}

const Product = struct {
    id: []const u8,
    schema: []const u8,
    bytes: []const u8,
    hex: [64]u8,
};

/// The one artifact a response may carry: produced by THIS firing, under THIS
/// port's derived write prefix. There is deliberately no way for a caller to
/// name an artifact — no id parameter, no listing, no journal tail. An inbound
/// port that could address the substrate is an exfiltration surface.
fn productOf(
    a: Allocator,
    substrate: *const substrate_mod.Substrate,
    firing_id: []const u8,
    write_prefix: []const u8,
) !?Product {
    var chosen: ?Product = null;
    var iterator = substrate.artifacts.iterator();
    while (iterator.next()) |entry| {
        const id = entry.key_ptr.*;
        const artifact = entry.value_ptr.*;
        if (!std.mem.startsWith(u8, id, write_prefix)) continue;
        if (!std.mem.eql(u8, artifact.produced_by, firing_id)) continue;
        // Deterministic when a firing wrote several: the smallest id wins, so
        // the same request always yields the same response.
        if (chosen) |current| {
            if (std.mem.order(u8, id, current.id) != .lt) continue;
        }
        chosen = .{
            .id = try a.dupe(u8, id),
            .schema = try a.dupe(u8, artifact.schema),
            .bytes = try a.dupe(u8, artifact.bytes),
            .hex = std.fmt.bytesToHex(artifact.digest, .lower),
        };
    }
    return chosen;
}

/// Turn one admitted request into one firing of the pinned handler.
///
/// Order is the point: the handler is re-verified before the body is trusted,
/// the body is admitted as `receptor_schema` or refused as poisoned, the grant
/// is derived from `(agent, manifest)` alone, and only then does anything run.
pub fn serveRequest(
    a: Allocator,
    io: std.Io,
    substrate: *substrate_mod.Substrate,
    agent: []const u8,
    port: *const Port,
    published: *const PublishedManifest,
    peer: []const u8,
    caller_key: []const u8,
    body: []const u8,
) !Served {
    if (body.len > published.max_request_bytes) return Error.InterfaceRequestTooLarge;
    if (!callerAdmitted(published, peer)) return Error.InterfaceCallerDenied;

    const published_hex = published.manifestHex();
    const handler = try verifyHandler(a, io, substrate, published, port.package_dir);

    // Bytes never become a stimulus without decoding as the declared schema.
    // An undecodable body is refused as poisoned rather than handed to the
    // handler to interpret.
    const decoded = std.json.parseFromSliceLeaky(std.json.Value, a, body, .{}) catch
        return Error.InterfacePoisonedRequest;
    if (decoded != .object) return Error.InterfacePoisonedRequest;

    const key = switch (published.firing_id_source) {
        .content => &std.fmt.bytesToHex(types.digest(body), .lower),
        .caller_supplied => if (caller_key.len > 0)
            caller_key
        else
            return Error.InterfacePoisonedRequest,
    };
    const firing_id = try servedFiringId(a, &published_hex, peer, key);
    // The port's grant, narrowed again by what the handler limb itself asked
    // for at admission. A limb never receives more authority than it declared,
    // even when the contract it serves was allowed more. Prefixes are NOT
    // intersected — the harness owns the namespace, and a limb that could
    // choose one would be naming its own write target.
    const grant = narrow(try grantForPort(a, agent, &published_hex, published), handler.declared_caps);

    if (try replayOf(a, substrate, published, firing_id, grant.write_prefix)) |replayed| {
        return replayed;
    }

    // The request body enters as a read the handler is permitted to see, under
    // the port's own prefix. It is staged, not committed: an inbound body is
    // not a durable node artifact until a firing decides it should be.
    const request_id = try std.fmt.allocPrint(a, "{s}request/{s}", .{
        grant.write_prefix,
        std.fmt.bytesToHex(types.digest(body), .lower)[0..32],
    });
    const request_digest = types.digest(body);
    try substrate.artifacts.put(try a.dupe(u8, request_id), .{
        .schema = try a.dupe(u8, published.receptor_schema),
        .bytes = try a.dupe(u8, body),
        .digest = request_digest,
        .produced_by = try a.dupe(u8, "served-request"),
    });
    const permitted = try a.alloc([]const u8, 1);
    permitted[0] = request_id;
    const reads = try a.alloc(types.ArtifactRef, 1);
    reads[0] = .{ .id = request_id, .digest = request_digest };

    var implementation: script_mod.ScriptNeuron = .{
        .allocator = a,
        .io = io,
        .argv = handler.argv,
        .substrate = substrate,
    };
    const timeout_ms = @min(
        @as(u64, published.invocation.timeout_ms),
        handler.deadline_ms orelse @as(u64, published.invocation.timeout_ms),
    );
    implementation.default_timeout = .{ .duration = .{
        .raw = .{ .nanoseconds = @as(i96, @intCast(timeout_ms)) * std.time.ns_per_ms },
        .clock = .boot,
    } };
    const neuron = neuron_mod.bind(
        script_mod.ScriptNeuron,
        &implementation,
        published.handler_neuron,
        handler.version,
    );
    const stimulus: types.Stimulus = .{
        .firing_id = firing_id,
        .receptor_schema = published.receptor_schema,
        .permitted_reads = permitted,
        .reads = reads,
    };
    const runtime: runtime_mod.Runtime = .{ .substrate = substrate };
    _ = runtime.fire(neuron, stimulus, grant) catch |err| switch (err) {
        // A redelivery that raced the replay check settles on identity rather
        // than committing twice.
        error.FiringAlreadySettled, error.FiringMismatch => {},
        else => return err,
    };

    switch (published.invocation.mode) {
        .read => {
            const product = (try productOf(a, substrate, firing_id, grant.write_prefix)) orelse
                return Error.InterfaceProductOutsideContract;
            // The port promised `emits`. A product outside it is a contract
            // violation, not a response.
            if (!published.emitsSchema(product.schema))
                return Error.InterfaceProductOutsideContract;
            return .{
                .status = .served,
                .product = product.bytes,
                .product_id = product.id,
                .product_schema = product.schema,
                .product_digest = product.hex,
                .firing_id = firing_id,
            };
        },
        .command => {
            // Content and outbox record landed together in the handler's single
            // firing, or not at all. Nothing has crossed: the response is the
            // address, and `dispatch` is still what crosses it later.
            for (substrate.messages.items) |message| {
                if (!std.mem.eql(u8, message.firing_id, firing_id)) continue;
                return .{
                    .status = .queued,
                    .outbox_address = try a.dupe(u8, message.to),
                    .firing_id = firing_id,
                };
            }
            return Error.InterfaceCommandNotQueued;
        },
    }
}

// ---------------------------------------------------------------------------
// HTTP framing (the `observe.zig` listener pattern, inbound)
// ---------------------------------------------------------------------------

fn isLoopback(address: net.IpAddress) bool {
    return switch (address) {
        .ip4 => |v4| v4.bytes[0] == 127,
        .ip6 => |v6| std.mem.eql(u8, &v6.bytes, &([_]u8{0} ** 15 ++ [_]u8{1})),
    };
}

const RequestHead = struct {
    method: ?membrane.Method,
    target: []const u8,
    content_length: usize,
    idempotency_key: []const u8,
};

pub const IDEMPOTENCY_HEADER = "x-neuron-idempotency-key";

fn parseHead(a: Allocator, reader: *std.Io.Reader) !RequestHead {
    // `takeDelimiterExclusive` leaves the delimiter in the stream, so the next
    // call would return an empty slice forever. The inclusive form advances
    // past it; the CRLF is trimmed here instead.
    const line = reader.takeDelimiterInclusive('\n') catch return Error.InterfacePoisonedRequest;
    var parts = std.mem.splitScalar(u8, std.mem.trimEnd(u8, line, "\r\n"), ' ');
    const method_text = parts.next() orelse return Error.InterfacePoisonedRequest;
    const target = parts.next() orelse return Error.InterfacePoisonedRequest;

    var head: RequestHead = .{
        .method = membrane.Method.parse(method_text),
        .target = try a.dupe(u8, target),
        .content_length = 0,
        .idempotency_key = "",
    };
    var count: usize = 0;
    while (count < MAX_HEADERS) : (count += 1) {
        const header = reader.takeDelimiterInclusive('\n') catch return Error.InterfacePoisonedRequest;
        const trimmed = std.mem.trimEnd(u8, header, "\r\n");
        if (trimmed.len == 0) return head;
        const colon = std.mem.indexOfScalar(u8, trimmed, ':') orelse continue;
        const name = trimmed[0..colon];
        const value = std.mem.trim(u8, trimmed[colon + 1 ..], " \t");
        var lowered_buf: [64]u8 = undefined;
        if (name.len > lowered_buf.len) continue;
        const lowered = std.ascii.lowerString(lowered_buf[0..name.len], name);
        if (std.mem.eql(u8, lowered, "content-length")) {
            head.content_length = std.fmt.parseInt(usize, value, 10) catch
                return Error.InterfacePoisonedRequest;
            if (head.content_length > MAX_REQUEST_BYTES) return Error.InterfaceRequestTooLarge;
        } else if (std.mem.eql(u8, lowered, IDEMPOTENCY_HEADER)) {
            if (value.len > 128) return Error.InterfacePoisonedRequest;
            head.idempotency_key = try a.dupe(u8, value);
        }
    }
    return Error.InterfacePoisonedRequest;
}

/// A served target is exactly `/agents/<agent><bind.path>` (R4). Query strings
/// and fragments are refused rather than stripped: everything a caller may vary
/// travels in the body, where `receptor_schema` governs it.
const Route = struct { agent: []const u8, path: []const u8 };

fn parseRoute(target: []const u8) ?Route {
    if (std.mem.indexOfScalar(u8, target, '?') != null) return null;
    if (std.mem.indexOfScalar(u8, target, '#') != null) return null;
    if (std.mem.indexOf(u8, target, "..") != null) return null;
    if (!std.mem.startsWith(u8, target, "/agents/")) return null;
    const rest = target["/agents/".len..];
    const slash = std.mem.indexOfScalar(u8, rest, '/') orelse return null;
    const agent = rest[0..slash];
    if (agent.len == 0 or !safeId(agent)) return null;
    const path = rest[slash..];
    validateServedPath(path) catch return null;
    return .{ .agent = agent, .path = path };
}

fn respond(
    w: *std.Io.Writer,
    status: []const u8,
    content_type: []const u8,
    extra: []const u8,
    body: []const u8,
) !void {
    try w.print(
        "HTTP/1.1 {s}\r\nContent-Type: {s}\r\nCache-Control: no-store\r\n{s}Content-Length: {}\r\nConnection: close\r\n\r\n",
        .{ status, content_type, extra, body.len },
    );
    try w.writeAll(body);
    try w.flush();
}

/// Every refusal collapses to one of these. Note what is NOT here: there is no
/// status that distinguishes "this digest was revoked" from "this path was
/// never published". Both are 404, because telling a caller which one it was
/// would turn the port into an oracle over the node's published set.
fn statusFor(err: anyerror) []const u8 {
    return switch (err) {
        Error.InterfaceNotPublished,
        Error.InterfacePublicationRevoked,
        Error.InterfaceNoLivePort,
        Error.InterfaceHandlerNotAdmitted,
        Error.InterfaceHandlerDrift,
        Error.InterfaceHandlerUnresolvable,
        => "404 Not Found",
        Error.InterfaceCallerDenied => "403 Forbidden",
        Error.InterfaceRequestTooLarge => "413 Payload Too Large",
        Error.InterfacePoisonedRequest, Error.InterfaceRequestTruncated => "400 Bad Request",
        else => "500 Internal Server Error",
    };
}

fn errorBody(a: Allocator, err: anyerror) ![]const u8 {
    return std.json.Stringify.valueAlloc(a, .{
        .schema = "neuron.served-failure/v1",
        .@"error" = @errorName(err),
    }, .{});
}

/// Serve published interfaces over HTTP.
///
/// Binding is loopback-only unless the operator explicitly opts out, exactly as
/// `observe.zig` binds: a served port is reachable authority, and the default
/// must never be "reachable from the network".
pub fn serveHttp(
    allocator: Allocator,
    io: std.Io,
    node_dir: []const u8,
    listen: []const u8,
    allow_public: bool,
) !void {
    const address = net.IpAddress.parseLiteral(listen) catch return Error.InvalidListenAddress;
    if (!allow_public and !isLoopback(address)) return Error.ServeAddressNotLoopback;

    var server = try address.listen(io, .{ .reuse_address = true });
    defer server.deinit(io);

    var banner: [200]u8 = undefined;
    const line = try std.fmt.bufPrint(&banner, "neuron port http: http://{s}/agents/<agent><path> (loopback={})\n", .{
        listen, isLoopback(address),
    });
    var out_buf: [256]u8 = undefined;
    var stdout = std.Io.File.stdout().writerStreaming(io, &out_buf);
    try stdout.interface.writeAll(line);
    try stdout.interface.flush();

    while (true) {
        const stream = server.accept(io) catch continue;
        // One request in flight at a time: the substrate lock is exclusive, so
        // serialising here is what lets an operator revoke a limb or a record
        // from another process while the listener is up.
        handleConnection(allocator, io, stream, node_dir) catch {};
        stream.close(io);
    }
}

fn handleConnection(
    allocator: Allocator,
    io: std.Io,
    stream: net.Stream,
    node_dir: []const u8,
) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var in_buf: [8192]u8 = undefined;
    var reader = stream.reader(io, &in_buf);
    var out_buf: [16384]u8 = undefined;
    var writer = stream.writer(io, &out_buf);
    const w = &writer.interface;

    const peer = try peerText(a, stream.socket.address);
    const head = parseHead(a, &reader.interface) catch |err| {
        return respond(w, statusFor(err), "application/json", "", try errorBody(a, err));
    };
    if (head.content_length > 0) {
        // The ceiling is checked before the bytes are pulled, so an oversized
        // body is refused without ever being read into this process.
        if (head.content_length > MAX_REQUEST_BYTES) {
            return respond(w, "413 Payload Too Large", "application/json", "", try errorBody(a, Error.InterfaceRequestTooLarge));
        }
    }

    const route = parseRoute(head.target) orelse {
        return respond(w, "404 Not Found", "application/json", "", try errorBody(a, Error.InterfaceNoLivePort));
    };

    var substrate = substrate_mod.Substrate.initDir(
        a,
        io,
        std.Io.Dir.cwd(),
        try std.fs.path.join(a, &.{ node_dir, "state" }),
    ) catch |err| {
        // A locked substrate is a busy node, not a missing route.
        return respond(w, "503 Service Unavailable", "application/json", "", try errorBody(a, err));
    };
    defer substrate.deinit();

    const resolved = resolveRoute(a, &substrate, route) catch |err| {
        return respond(w, statusFor(err), "application/json", "", try errorBody(a, err));
    };
    const published = resolved.published;

    // Method is part of the contract, not a formality: a read is only reachable
    // through the method the manifest declared.
    const method = head.method orelse {
        return respond(w, "405 Method Not Allowed", "application/json", "", try errorBody(a, Error.InterfacePoisonedRequest));
    };
    if (method != published.bind_method) {
        return respond(w, "405 Method Not Allowed", "application/json", "", try errorBody(a, Error.InterfacePoisonedRequest));
    }
    if (head.content_length > published.max_request_bytes) {
        return respond(w, "413 Payload Too Large", "application/json", "", try errorBody(a, Error.InterfaceRequestTooLarge));
    }

    const body = try a.alloc(u8, head.content_length);
    if (body.len > 0) {
        reader.interface.readSliceAll(body) catch {
            // A body shorter than its declared Content-Length is a truncated
            // request, not a malformed document: distinguishing them is what
            // makes a framing bug debuggable instead of looking like a caller
            // sending garbage.
            return respond(w, "400 Bad Request", "application/json", "", try errorBody(a, Error.InterfaceRequestTruncated));
        };
    }

    const served = serveRequest(
        a,
        io,
        &substrate,
        route.agent,
        &resolved.port,
        &published,
        peer,
        head.idempotency_key,
        body,
    ) catch |err| {
        return respond(w, statusFor(err), "application/json", "", try errorBody(a, err));
    };

    switch (published.invocation.mode) {
        .read => {
            const extra = try std.fmt.allocPrint(
                a,
                "X-Neuron-Product-Schema: {s}\r\nX-Neuron-Product-Digest: {s}\r\nX-Neuron-Status: {s}\r\n",
                .{ served.product_schema, &served.product_digest, @tagName(served.status) },
            );
            try respond(w, "200 OK", "application/json", extra, served.product);
        },
        .command => {
            // 202: committed here, crossing later. Returning a result would be
            // claiming the boundary was already crossed.
            const body_out = try std.json.Stringify.valueAlloc(a, .{
                .schema = "neuron.served-command/v1",
                .status = @tagName(served.status),
                .outbox_address = served.outbox_address,
            }, .{});
            try respond(w, "202 Accepted", "application/json", "", body_out);
        },
    }
}

const ResolvedRoute = struct { port: Port, published: PublishedManifest };

/// Resolve a route to a live port, or refuse. Every failure on this path is a
/// 404: an unattached route, a revoked record and a path that was never
/// published must be indistinguishable from outside.
fn resolveRoute(
    a: Allocator,
    substrate: *const substrate_mod.Substrate,
    route: Route,
) !ResolvedRoute {
    const ports = try livePorts(a, substrate, route.agent);
    for (ports) |port| {
        const published = resolvePublished(a, substrate, &port.published_hex) catch continue;
        if (!std.mem.eql(u8, published.bind_path, route.path)) continue;
        if (published.transport != .http) continue;
        return .{ .port = port, .published = published };
    }
    return Error.InterfaceNoLivePort;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

fn emit(a: Allocator, io: std.Io, text: []const u8) !void {
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(a, text);
    if (out.items.len == 0 or out.items[out.items.len - 1] != '\n') try out.append(a, '\n');
    var buffer: [4096]u8 = undefined;
    var writer = std.Io.File.stdout().writerStreaming(io, &buffer);
    try writer.interface.writeAll(out.items);
    try writer.interface.flush();
}

/// Diagnostic-only output, operator-facing (see `PublishDiagnostic`). Never
/// called on any path that could answer a served HTTP request.
fn emitStderr(a: Allocator, io: std.Io, text: []const u8) !void {
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(a, text);
    if (out.items.len == 0 or out.items[out.items.len - 1] != '\n') try out.append(a, '\n');
    var buffer: [4096]u8 = undefined;
    var writer = std.Io.File.stderr().writerStreaming(io, &buffer);
    try writer.interface.writeAll(out.items);
    try writer.interface.flush();
}

fn flagValue(args: []const []const u8, name: []const u8) ?[]const u8 {
    var index: usize = 0;
    while (index + 1 < args.len) : (index += 1) {
        if (std.mem.eql(u8, args[index], name)) return args[index + 1];
    }
    return null;
}

fn hasFlag(args: []const []const u8, name: []const u8) bool {
    for (args) |arg| if (std.mem.eql(u8, arg, name)) return true;
    return false;
}

fn openNodeSubstrate(a: Allocator, io: std.Io, node_dir: []const u8) !substrate_mod.Substrate {
    const state_path = try std.fs.path.join(a, &.{ node_dir, "state" });
    return substrate_mod.Substrate.initDir(a, io, std.Io.Dir.cwd(), state_path);
}

pub const VERB = "port";

pub const USAGE =
    \\  neuron port publish <node_dir> <published.json> [--json]
    \\                         admit a neuron.published-interface/v1 document
    \\  neuron port revoke <node_dir> --published <digest>
    \\                         stop the next request; detach first
    \\  neuron port attach <node_dir> <agent> --published <digest> --handler <package_dir>
    \\                         bind an admitted published interface to
    \\                         /agents/<agent><bind.path>
    \\  neuron port detach <node_dir> <agent> --published <digest>
    \\                         release the route; the record remains
    \\  neuron port list <node_dir> [--agent <id>] [--json]
    \\  neuron port http <node_dir> --listen <ip:port> [--allow-public]
    \\                         serve live ports over HTTP (loopback-only by default)
    \\
;

/// The single registration point. `main.zig` is deliberately not edited here;
/// wiring is one call to this function from the top-level dispatcher.
/// Returns false when `args` are not a `serve` invocation, so the caller can
/// fall through to its other verbs.
pub fn dispatch(allocator: Allocator, io: std.Io, args: []const []const u8) !bool {
    if (args.len < 2 or !std.mem.eql(u8, args[0], VERB)) return false;
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const verb = args[1];
    const rest = args[2..];
    const json_out = hasFlag(rest, "--json");

    if (std.mem.eql(u8, verb, "publish")) {
        if (rest.len < 2) return Error.InvalidPublishedInterface;
        const document = try std.Io.Dir.cwd().readFileAlloc(io, rest[1], a, .limited(1 << 20));
        var substrate = try openNodeSubstrate(a, io, rest[0]);
        defer substrate.deinit();
        // Publish is operator-driven, never the served request path (see
        // `PublishDiagnostic`), so it is the one call site allowed to ask
        // `parsePublished` which field was wrong and print that to the
        // operator before the same error propagates and fails the process
        // closed exactly as it did before this diagnostic existed.
        var diag: PublishDiagnostic = .{};
        const result = publishCore(a, &substrate, document, &diag) catch |err| {
            if (diag.field.len != 0) {
                try emitStderr(a, io, try std.fmt.allocPrint(a, "error: {s} · field {s}: {s}", .{
                    @errorName(err), diag.field, diag.detail,
                }));
            }
            return err;
        };
        const line = if (json_out)
            try std.json.Stringify.valueAlloc(a, .{
                .schema = PUBLICATION_SCHEMA,
                .published = result.published_digest[0..],
                .handler = result.handler_digest[0..],
                .id = result.id,
                .mode = result.mode.name(),
                .path = result.path,
                .created = result.created,
                .checks = result.checks.len,
            }, .{})
        else
            try std.fmt.allocPrint(a, "✓ interface published · {s} · {s} · {s}", .{
                result.id, result.path, result.published_digest[0..16],
            });
        try emit(a, io, line);
        return true;
    }

    if (std.mem.eql(u8, verb, "revoke")) {
        if (rest.len < 1) return Error.InvalidPublishedInterface;
        const digest = flagValue(rest, "--published") orelse return Error.InvalidPublishedInterface;
        var substrate = try openNodeSubstrate(a, io, rest[0]);
        defer substrate.deinit();
        try revokePublishedCore(a, &substrate, digest);
        try emit(a, io, try std.fmt.allocPrint(
            a,
            "✓ published interface revoked · {s} · the next request fails closed",
            .{digest[0..@min(16, digest.len)]},
        ));
        return true;
    }

    if (std.mem.eql(u8, verb, "attach")) {
        if (rest.len < 2) return Error.InvalidPublishedInterface;
        const digest = flagValue(rest, "--published") orelse return Error.InvalidPublishedInterface;
        const package_dir = flagValue(rest, "--handler") orelse return Error.InvalidPublishedInterface;
        var substrate = try openNodeSubstrate(a, io, rest[0]);
        defer substrate.deinit();
        const result = try attachPortCore(a, io, &substrate, rest[1], digest, package_dir);
        const line = if (json_out)
            try std.json.Stringify.valueAlloc(a, .{
                .schema = PORT_ATTACHMENT_SCHEMA,
                .published = result.published_hex[0..],
                .slot = result.slot,
                .route = result.route,
                .created = result.created,
            }, .{})
        else
            try std.fmt.allocPrint(a, "✓ port attached · {s} · slot {d}", .{ result.route, result.slot });
        try emit(a, io, line);
        return true;
    }

    if (std.mem.eql(u8, verb, "detach")) {
        if (rest.len < 2) return Error.InvalidPublishedInterface;
        const digest = flagValue(rest, "--published") orelse return Error.InvalidPublishedInterface;
        var substrate = try openNodeSubstrate(a, io, rest[0]);
        defer substrate.deinit();
        const slot = try detachPortCore(a, &substrate, rest[1], digest);
        try emit(a, io, try std.fmt.allocPrint(
            a,
            "✓ port detached · slot {d} · the route resolves to nothing",
            .{slot},
        ));
        return true;
    }

    if (std.mem.eql(u8, verb, "list")) {
        if (rest.len < 1) return Error.InvalidPublishedInterface;
        var substrate = try openNodeSubstrate(a, io, rest[0]);
        defer substrate.deinit();

        var published_ids: std.ArrayList([]const u8) = .empty;
        var revoked: usize = 0;
        var iterator = substrate.artifacts.iterator();
        while (iterator.next()) |entry| {
            const id = entry.key_ptr.*;
            if (std.mem.startsWith(u8, id, PUBLISHED_REVOKED_PREFIX)) {
                revoked += 1;
            } else if (std.mem.startsWith(u8, id, PUBLISHED_PREFIX)) {
                try published_ids.append(a, try a.dupe(u8, id[PUBLISHED_PREFIX.len..]));
            }
        }
        std.mem.sort([]const u8, published_ids.items, {}, struct {
            fn lessThan(_: void, left: []const u8, right: []const u8) bool {
                return std.mem.order(u8, left, right) == .lt;
            }
        }.lessThan);

        var routes: std.ArrayList([]const u8) = .empty;
        if (flagValue(rest, "--agent")) |agent| {
            for (try livePorts(a, &substrate, agent)) |port| {
                const published = resolvePublished(a, &substrate, &port.published_hex) catch continue;
                try routes.append(a, try routeFor(a, agent, published.bind_path));
            }
        }
        const line = if (json_out)
            try std.json.Stringify.valueAlloc(a, .{
                .schema = "neuron.published-list/v1",
                .published = published_ids.items,
                .revoked = revoked,
                .routes = routes.items,
            }, .{})
        else
            try std.fmt.allocPrint(a, "published={d} revoked={d} routes={d}", .{
                published_ids.items.len, revoked, routes.items.len,
            });
        try emit(a, io, line);
        return true;
    }

    if (std.mem.eql(u8, verb, "http")) {
        if (rest.len < 1) return Error.InvalidPublishedInterface;
        const listen = flagValue(rest, "--listen") orelse "127.0.0.1:8791";
        try serveHttp(allocator, io, rest[0], listen, hasFlag(rest, "--allow-public"));
        return true;
    }

    return Error.InvalidPublishedInterface;
}
