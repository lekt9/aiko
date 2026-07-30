//! Universal interface membrane (§17.3 / entrypoint plan Phase 2).
//!
//! Anything with a callable or observable boundary participates through one
//! typed contract without being rewritten as a Neuron. This module is the
//! *mechanism* half of that membrane and holds no policy: it parses and
//! validates an `InterfaceManifest`, re-pins the boundary by digest before any
//! invocation, classifies every operation as a capability **read** or a
//! consequential **command**, and performs the bounded invocation itself.
//!
//! Three invariants are structural here rather than advisory:
//!
//!   1. A command cannot be invoked on the read path. `invokeRead` refuses a
//!      command manifest, so relabelling a mutation as a read cannot bypass the
//!      outbox — the type system carries the classification, not a comment.
//!   2. A locator is inert. A path, pipeline, or executable name only names a
//!      boundary; it confers nothing until an admitted manifest and current
//!      Caps authorize that exact operation.
//!   3. Drift invalidates identity. `verifyImplementation` recomputes the
//!      implementation digest from the live boundary before every call, so a
//!      swapped binary or moved root fails closed instead of executing.
//!
//! Admission, attachment, and agent wiring live in `membrane_ops.zig`; this
//! module never writes to the substrate.

const std = @import("std");
const types = @import("types.zig");
const caps_mod = @import("caps.zig");

const Allocator = std.mem.Allocator;
const Sha256 = std.crypto.hash.sha2.Sha256;

pub const MANIFEST_SCHEMA = "neuron.interface-manifest/v1";
pub const ADMISSION_SCHEMA = "neuron.interface-admission/v1";
pub const ATTACHMENT_SCHEMA = "neuron.interface-attachment/v1";
pub const DETACHMENT_SCHEMA = "neuron.interface-detachment/v1";
pub const CANDIDATE_SCHEMA = "neuron.interface-candidate/v1";
pub const CALL_SCHEMA = "neuron.interface-call/v1";
pub const RESULT_SCHEMA = "neuron.interface-result/v1";
pub const FAILURE_SCHEMA = "neuron.interface-failure/v1";
pub const RECEIPT_SCHEMA = "neuron.interface-receipt/v1";
pub const ACCEPTANCE_SCHEMA = "neuron.acceptance-predicate/v1";
pub const HUMAN_DECISION_SCHEMA = "neuron.human-decision/v1";
pub const PAYMENT_QUOTE_SCHEMA = "neuron.payment-quote/v1";
pub const SPENDING_POLICY_SCHEMA = "neuron.spending-policy/v1";
pub const PAYMENT_RECEIPT_SCHEMA = "neuron.payment-receipt/v1";

/// x402 is an economic *transport* profile, not Neuron admission, identity,
/// Caps, or evidence (plan §10). These are the wire names it uses.
pub const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";

/// Domain separators. A digest computed for one interface kind must never
/// collide with, or be reusable as, a digest for another kind.
const FUNCTION_DOMAIN = "neuron.interface-function/v1\n";
const PROCESS_DOMAIN = "neuron.interface-process/v1\n";
const FILESYSTEM_DOMAIN = "neuron.interface-fs-root/v1\n";
const HTTP_DOMAIN = "neuron.interface-http-endpoint/v1\n";
const MCP_DOMAIN = "neuron.interface-mcp-tool/v1\n";
const MODEL_DOMAIN = "neuron.interface-model-endpoint/v1\n";
const DEVICE_DOMAIN = "neuron.interface-device-root/v1\n";
const HUMAN_DOMAIN = "neuron.interface-human-inbox/v1\n";

/// The hard ceiling on what *any* interface may hold, independent of which
/// agent later attaches it. It lives here, next to the parser, so an omitted
/// budget resolves to the ceiling instead of inheriting the wider global
/// defaults — an absent field must never be a widening.
pub const CAPS_CEILING: caps_mod.Caps = .{
    .allow_write = true,
    .write_prefix = "agents/",
    .allow_send = true,
    .send_prefix = "outbox/interface/",
    .allow_spawn = false,
    .spawn_prefix = "",
    .budget = .{
        .max_effects = 8,
        .max_writes = 4,
        .max_messages = 4,
        .max_spawns = 0,
        .max_bytes = 1 << 20,
        .max_depth = 4,
        .max_turns = 4,
    },
};

pub const MAX_ARGV = 32;
pub const MAX_PIPELINE_OPS = 16;
pub const MAX_IMPLEMENTATION_BYTES = 64 * 1024 * 1024;
pub const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
pub const MAX_TIMEOUT_MS = 600_000;

pub const Error = error{
    /// The document is not a `neuron.interface-manifest/v1` object.
    InvalidInterfaceManifest,
    /// A required typed field is absent or empty.
    IncompleteInterfaceManifest,
    /// The manifest declares no accepts/emits/errors schemas: an untyped
    /// boundary is never admissible (§17.3).
    UntypedInterface,
    UnknownInterfaceKind,
    /// `{input}` appears as a substring of a larger argv element, an
    /// unrecognized placeholder appears, or an element carries control bytes.
    ArgvTemplateInjection,
    ArgvLocatorMismatch,
    /// The declared input channel and the argv template disagree.
    InterfaceInputChannelMismatch,
    /// A target template or a substituted path escapes its declared root.
    InterfacePathEscape,
    UnknownFunctionOp,
    /// A command whose external consequence has no independent local sensor.
    UnverifiableCommand,
    /// The live boundary no longer hashes to the pinned implementation digest.
    InterfaceDigestDrift,
    /// The boundary is missing, the wrong kind, or not executable.
    InterfaceBoundaryUnusable,
    /// `invokeRead` was handed a command, or `applyCommand` a read.
    InterfaceModeMismatch,
    InterfaceTimeout,
    InterfaceCallFailed,
    InterfaceOutputTooLarge,
    /// Declared budgets are outside the mechanism's hard ceilings.
    InterfaceBudgetInvalid,
    /// Independent read-back disagreed with the committed command content.
    InterfaceReconciliationFailed,
    InvalidAcceptancePredicate,
    /// A remote answered, but not in the shape it declared. The bytes never
    /// become evidence: an undecodable response is a typed failure, not data.
    InterfacePoisonedResponse,
    /// A remote operation was declared a read without being contractually
    /// non-mutating, so it defaults to a command (§17.3).
    InterfaceRemoteReadUnsafe,
    /// The remote answered with a non-success status.
    InterfaceRemoteStatus,
    /// A URL template carries an unrecognized placeholder, more than one
    /// `{input}`, or bytes that cannot appear in a URL.
    InterfaceUrlTemplateInvalid,
    // --- Phase 4: models, devices, humans ---------------------------------
    /// A model or human boundary claimed determinism. Their outputs are
    /// nondeterministic by nature, so the claim that would license
    /// verification-by-second-invocation is refused at admission rather than
    /// discovered later by a replay that silently disagrees.
    InterfaceNondeterminismClaim,
    /// A nondeterministic boundary declared no provenance for the input it
    /// cannot reproduce — provider/model/protocol for a model, the interaction
    /// schema for a human. Untraceable nondeterminism is not admissible.
    InterfaceProvenanceMissing,
    /// A model or human output was used as if it were grounded. Both are
    /// untrusted evidence until an independent validation admits them.
    InterfaceUntrustedEvidence,
    /// A device manifest did not declare exactly one of sensor/actuator, or an
    /// actuator was declared without its safety gate.
    InterfaceDeviceRoleInvalid,
    /// An actuator was admitted without naming the human approval interface
    /// that gates it. A consequential actuator with no gate is not admissible.
    InterfaceSafetyGateMissing,
    /// An actuator effect reached dispatch with no recorded human approval for
    /// exactly this content. The boundary is not crossed.
    InterfaceApprovalMissing,
    /// A human explicitly refused this content. The effect is settled as denied
    /// and never crosses.
    InterfaceApprovalDenied,
    /// A human decision document did not match the declared typed schema.
    InterfaceApprovalMalformed,
    // --- Phase 5: optional economic profile --------------------------------
    /// The resource answered `402 Payment Required`. Not a failure in itself —
    /// it is the challenge that begins the paid flow.
    InterfacePaymentRequired,
    /// The 402 challenge did not decode as a quote. An undecodable challenge
    /// never becomes a payment: unparsed bytes cannot authorize spending.
    InterfacePaymentQuoteInvalid,
    /// The quote exceeds a per-call ceiling or the cumulative budget. Nothing
    /// is signed.
    InterfacePaymentUnaffordable,
    /// The quote is at or above the approval threshold and no human approval
    /// for exactly this quote exists. Nothing is signed.
    InterfacePaymentUnapproved,
    /// The quote names an asset, network, or payee the policy does not allow.
    InterfacePaymentUnacceptable,
    /// The quote's validity window has passed.
    InterfacePaymentQuoteExpired,
    /// The admitted payment adapter failed to produce a payment payload. Keys
    /// and signing live behind that boundary, never in the core.
    InterfacePaymentAdapterFailed,
    /// The resource rejected the payment proof.
    InterfacePaymentProofRejected,
    /// A paid interface declared no payment adapter or no spending policy.
    InterfacePaymentProfileIncomplete,
};

pub const Method = enum {
    GET,
    HEAD,
    POST,
    PUT,
    PATCH,
    DELETE,

    pub fn parse(text: []const u8) ?Method {
        return std.meta.stringToEnum(Method, text);
    }

    pub fn name(self: Method) []const u8 {
        return @tagName(self);
    }

    /// Only GET and HEAD can even be *considered* for the read path; the
    /// manifest must additionally declare the endpoint non-mutating.
    pub fn safe(self: Method) bool {
        return self == .GET or self == .HEAD;
    }

    pub fn toStd(self: Method) std.http.Method {
        return switch (self) {
            .GET => .GET,
            .HEAD => .HEAD,
            .POST => .POST,
            .PUT => .PUT,
            .PATCH => .PATCH,
            .DELETE => .DELETE,
        };
    }
};

pub const ResponseEncoding = enum {
    /// The body is the value.
    raw,
    /// The body is a JSON object and `response_field` names the value.
    json,

    pub fn parse(text: []const u8) ?ResponseEncoding {
        return std.meta.stringToEnum(ResponseEncoding, text);
    }

    pub fn name(self: ResponseEncoding) []const u8 {
        return @tagName(self);
    }
};

pub const Kind = enum {
    function,
    process,
    filesystem,
    http,
    mcp,
    model,
    device,
    human,

    pub fn parse(text: []const u8) ?Kind {
        return std.meta.stringToEnum(Kind, text);
    }

    pub fn name(self: Kind) []const u8 {
        return @tagName(self);
    }

    /// A remote boundary cannot be hashed: its implementation lives on someone
    /// else's machine. Its pin therefore covers the *declared contract* —
    /// method, address, and response shape — not the implementation bytes, so
    /// correctness has to come from the response contract and independent
    /// verification rather than from the pin. Local kinds pin real bytes.
    pub fn pinsRemoteContract(self: Kind) bool {
        return self == .http or self == .model;
    }

    /// A boundary whose output cannot be reproduced by calling it again: a
    /// model samples, a human decides. The membrane refuses their determinism
    /// claim and marks their product untrusted until validated, because
    /// verification-by-second-invocation — the check every deterministic
    /// boundary settles under — is unavailable to them by construction.
    pub fn nondeterministic(self: Kind) bool {
        return self == .model or self == .human;
    }
};

/// A device boundary is exactly one of these. Conflating them is the failure
/// this split exists to prevent: a sensor that can actuate is an actuator with
/// no gate.
pub const DeviceRole = enum {
    sensor,
    actuator,

    pub fn parse(text: []const u8) ?DeviceRole {
        return std.meta.stringToEnum(DeviceRole, text);
    }

    pub fn name(self: DeviceRole) []const u8 {
        return @tagName(self);
    }
};

/// What a human is being asked for. The schema is typed so the answer can be
/// validated as a document rather than interpreted as prose.
pub const HumanInteraction = enum {
    approval,
    review,
    annotation,

    pub fn parse(text: []const u8) ?HumanInteraction {
        return std.meta.stringToEnum(HumanInteraction, text);
    }

    pub fn name(self: HumanInteraction) []const u8 {
        return @tagName(self);
    }
};

/// Read versus command is the whole safety split (§17.3 / plan §5). Anything
/// unknown, absent, or mixed — including `duplex` — is a command: the
/// classification never fails open.
pub const Mode = enum {
    read,
    command,

    pub fn parse(text: []const u8) Mode {
        if (std.mem.eql(u8, text, "read")) return .read;
        return .command;
    }

    pub fn name(self: Mode) []const u8 {
        return @tagName(self);
    }
};

pub const Idempotency = enum {
    intrinsic,
    keyed,
    none,

    pub fn parse(text: []const u8) Idempotency {
        return std.meta.stringToEnum(Idempotency, text) orelse .none;
    }

    pub fn name(self: Idempotency) []const u8 {
        return @tagName(self);
    }
};

pub const InputChannel = enum {
    none,
    argv,
    stdin,

    pub fn parse(text: []const u8) ?InputChannel {
        return std.meta.stringToEnum(InputChannel, text);
    }

    pub fn name(self: InputChannel) []const u8 {
        return @tagName(self);
    }
};

pub const Invocation = struct {
    mode: Mode = .command,
    streaming: bool = false,
    deterministic: bool = false,
    idempotency: Idempotency = .none,
    timeout_ms: u32 = 2000,
    max_output_bytes: usize = 64 * 1024,
};

/// The admitted description of one external boundary. Slices borrow from the
/// bytes the manifest was parsed out of; parse into an arena and discard both
/// together.
pub const Manifest = struct {
    id: []const u8,
    version: []const u8,
    kind: Kind,
    /// Interpreted only by this kind's adapter: an op pipeline, an executable
    /// path, or a filesystem root. Never ambient authority.
    locator: []const u8,
    implementation_digest: types.Digest,
    argv_template: []const []const u8 = &.{},
    /// Relative path template under a filesystem root. `{input}` is only
    /// permitted on the read path; `{digest}` addresses command content.
    target_template: []const u8 = "",
    input_channel: InputChannel = .none,
    // --- remote kinds -----------------------------------------------------
    method: Method = .POST,
    /// Absolute URL template. `{input}` is substituted percent-encoded exactly
    /// once, so a value can never break out of the query it was placed in.
    url_template: []const u8 = "",
    response_encoding: ResponseEncoding = .raw,
    /// Required when `response_encoding` is `json`: the field that carries the
    /// value. A response missing it is poisoned, not empty.
    response_field: []const u8 = "",
    /// The endpoint's own contractual claim that it mutates nothing. Necessary
    /// but not sufficient for the read path; the method must also be safe.
    non_mutating: bool = false,
    /// An independent read-back for a remote command: the sensor that makes
    /// reconciliation possible. A command with no sensor is not admissible.
    reconcile_url_template: []const u8 = "",
    /// The sensor's own response contract. It is a different endpoint from the
    /// command, so it decodes by its own declaration — conflating the two would
    /// make a working sensor look like a poisoned one.
    reconcile_encoding: ResponseEncoding = .raw,
    reconcile_field: []const u8 = "",
    /// Header carrying the content idempotency key on a remote command, so a
    /// redelivered request cannot become a second effect.
    idempotency_header: []const u8 = "Idempotency-Key",
    /// MCP tool name invoked through `tools/call`.
    tool: []const u8 = "",
    // --- models (Phase 4) --------------------------------------------------
    /// Exact provider identity. Part of the contract pin: swapping providers is
    /// a different interface that must be admitted again, which is precisely
    /// what makes a provider swap auditable rather than silent.
    provider: []const u8 = "",
    /// Exact model identity at that provider.
    model_name: []const u8 = "",
    /// Wire protocol/tokenizer contract the caller relies on.
    protocol: []const u8 = "",
    /// Declared cost per call in micro-units, recorded as provenance so spend
    /// is attributable per firing. Zero is a real declaration, not "unknown".
    cost_micros: u64 = 0,
    // --- devices (Phase 4) -------------------------------------------------
    device_role: DeviceRole = .sensor,
    /// Relative path template naming the device's independently readable state,
    /// so an actuator's effect can be reconciled by a different code path than
    /// the one that wrote it.
    device_state_template: []const u8 = "",
    // --- humans and safety gates (Phase 4) ---------------------------------
    human_interaction: HumanInteraction = .approval,
    /// Hex interface digest of the human `approval` boundary that gates this
    /// actuator. Required for every actuator; empty for everything else.
    approval_interface: []const u8 = "",
    // --- economics (Phase 5) -----------------------------------------------
    /// Payment is orthogonal to invocation (plan §10): an interface is the same
    /// interface whether or not it costs money. `none` is the default, so an
    /// omitted profile can never accidentally authorize spending.
    economics: Economics = .none,
    /// Hex interface digest of the admitted adapter that signs payments. The
    /// core never signs; it only decides whether signing is permitted.
    payment_adapter: []const u8 = "",
    /// Hex interface digest of the human `approval` boundary consulted when a
    /// quote reaches the policy's approval threshold.
    payment_approval_interface: []const u8 = "",
    /// Response field carrying the resource's settlement information, decoded
    /// strictly like any other declared field.
    payment_response_field: []const u8 = "",
    accepts: []const []const u8,
    emits: []const []const u8,
    errors: []const []const u8,
    invocation: Invocation = .{},
    requested_caps: caps_mod.Caps = .{},
    input_classes: []const []const u8 = &.{},
    output_classes: []const []const u8 = &.{},
    evidence_claim: []const u8,
    evidence_method: []const u8,
    settlement: []const u8,
    /// Digest of the exact bytes this manifest was parsed from. Admission pins
    /// it so an attachment names one immutable description.
    manifest_digest: types.Digest = std.mem.zeroes(types.Digest),

    pub fn implementationHex(self: *const Manifest) [64]u8 {
        return std.fmt.bytesToHex(self.implementation_digest, .lower);
    }

    pub fn manifestHex(self: *const Manifest) [64]u8 {
        return std.fmt.bytesToHex(self.manifest_digest, .lower);
    }
};

pub const Outcome = struct {
    output: []const u8,
    /// Where the effect landed, for a command. Empty on the read path.
    target: []const u8 = "",
    /// Digest of the produced bytes — the caller's independent comparison key.
    output_digest: types.Digest,
};

// ---------------------------------------------------------------------------
// Manifest parsing and validation
// ---------------------------------------------------------------------------

/// Parse and fully validate a manifest document. Every rejection is typed:
/// there is no "mostly valid" interface, because a partially understood
/// boundary is exactly the case that must not be admitted.
pub fn parseManifest(a: Allocator, bytes: []const u8) !Manifest {
    const root = std.json.parseFromSliceLeaky(std.json.Value, a, bytes, .{}) catch
        return Error.InvalidInterfaceManifest;
    if (root != .object) return Error.InvalidInterfaceManifest;
    const schema = str(root, "schema") orelse return Error.InvalidInterfaceManifest;
    if (!std.mem.eql(u8, schema, MANIFEST_SCHEMA)) return Error.InvalidInterfaceManifest;

    const kind_text = str(root, "kind") orelse return Error.IncompleteInterfaceManifest;
    const kind = Kind.parse(kind_text) orelse return Error.UnknownInterfaceKind;

    var manifest: Manifest = .{
        .id = str(root, "id") orelse return Error.IncompleteInterfaceManifest,
        .version = str(root, "version") orelse return Error.IncompleteInterfaceManifest,
        .kind = kind,
        .locator = str(root, "locator") orelse return Error.IncompleteInterfaceManifest,
        .implementation_digest = undefined,
        .accepts = try strings(a, root, "accepts"),
        .emits = try strings(a, root, "emits"),
        .errors = try strings(a, root, "errors"),
        .evidence_claim = str(root, "evidence_claim") orelse return Error.IncompleteInterfaceManifest,
        .evidence_method = str(root, "evidence_method") orelse return Error.IncompleteInterfaceManifest,
        .settlement = str(root, "settlement") orelse return Error.IncompleteInterfaceManifest,
        .manifest_digest = types.digest(bytes),
    };
    if (!safeId(manifest.id) or manifest.version.len == 0 or manifest.locator.len == 0)
        return Error.IncompleteInterfaceManifest;
    if (manifest.evidence_claim.len == 0 or manifest.evidence_method.len == 0 or
        manifest.settlement.len == 0) return Error.IncompleteInterfaceManifest;

    // An interface with no declared typed surface is not describable, so it is
    // not admissible — regardless of how well its locator resolves.
    if (manifest.accepts.len == 0 or manifest.emits.len == 0 or manifest.errors.len == 0)
        return Error.UntypedInterface;

    const digest_hex = str(root, "implementation_digest") orelse return Error.IncompleteInterfaceManifest;
    manifest.implementation_digest = digestFromHex(digest_hex) catch return Error.IncompleteInterfaceManifest;

    const invocation = root.object.get("invocation") orelse return Error.IncompleteInterfaceManifest;
    if (invocation != .object) return Error.IncompleteInterfaceManifest;
    manifest.invocation = .{
        .mode = Mode.parse(str(invocation, "mode") orelse ""),
        .streaming = boolean(invocation, "streaming", false),
        .deterministic = boolean(invocation, "deterministic", false),
        .idempotency = Idempotency.parse(str(invocation, "idempotency") orelse ""),
        .timeout_ms = blk: {
            const raw = int(invocation, "timeout_ms") orelse 2000;
            if (raw <= 0 or raw > MAX_TIMEOUT_MS) return Error.InterfaceBudgetInvalid;
            break :blk @intCast(raw);
        },
        .max_output_bytes = blk: {
            const raw = int(invocation, "max_output_bytes") orelse 64 * 1024;
            if (raw <= 0 or raw > MAX_OUTPUT_BYTES) return Error.InterfaceBudgetInvalid;
            break :blk @intCast(raw);
        },
    };
    // Streaming deltas stay inert until a complete typed result is decoded
    // (invariant 7). No local Phase 2 adapter decodes a stream, so declaring
    // one fails closed rather than silently collapsing to a whole read.
    if (manifest.invocation.streaming) return Error.IncompleteInterfaceManifest;

    if (root.object.get("input_channel")) |value| {
        if (value != .string) return Error.IncompleteInterfaceManifest;
        manifest.input_channel = InputChannel.parse(value.string) orelse
            return Error.InterfaceInputChannelMismatch;
    }
    if (root.object.get("requested_caps")) |value| {
        manifest.requested_caps = capsFromJson(value) catch return Error.InvalidInterfaceManifest;
    }
    if (root.object.get("data_flow")) |flow| {
        if (flow != .object) return Error.InvalidInterfaceManifest;
        manifest.input_classes = try strings(a, flow, "input_classes");
        manifest.output_classes = try strings(a, flow, "output_classes");
    }
    if (root.object.get("target_template")) |value| {
        if (value != .string) return Error.InvalidInterfaceManifest;
        manifest.target_template = value.string;
    }
    if (root.object.get("argv_template")) |value| {
        manifest.argv_template = try stringArray(a, value);
    }
    if (root.object.get("method")) |value| {
        if (value != .string) return Error.InvalidInterfaceManifest;
        manifest.method = Method.parse(value.string) orelse return Error.InvalidInterfaceManifest;
    }
    if (root.object.get("url_template")) |value| {
        if (value != .string) return Error.InvalidInterfaceManifest;
        manifest.url_template = value.string;
    }
    if (root.object.get("response_encoding")) |value| {
        if (value != .string) return Error.InvalidInterfaceManifest;
        manifest.response_encoding = ResponseEncoding.parse(value.string) orelse
            return Error.InvalidInterfaceManifest;
    }
    if (root.object.get("response_field")) |value| {
        if (value != .string) return Error.InvalidInterfaceManifest;
        manifest.response_field = value.string;
    }
    manifest.non_mutating = boolean(root, "non_mutating", false);
    if (root.object.get("reconcile_url_template")) |value| {
        if (value != .string) return Error.InvalidInterfaceManifest;
        manifest.reconcile_url_template = value.string;
    }
    if (root.object.get("reconcile_encoding")) |value| {
        if (value != .string) return Error.InvalidInterfaceManifest;
        manifest.reconcile_encoding = ResponseEncoding.parse(value.string) orelse
            return Error.InvalidInterfaceManifest;
    }
    if (root.object.get("reconcile_field")) |value| {
        if (value != .string) return Error.InvalidInterfaceManifest;
        manifest.reconcile_field = value.string;
    }
    if (root.object.get("idempotency_header")) |value| {
        if (value != .string or value.string.len == 0) return Error.InvalidInterfaceManifest;
        manifest.idempotency_header = value.string;
    }
    if (root.object.get("tool")) |value| {
        if (value != .string) return Error.InvalidInterfaceManifest;
        manifest.tool = value.string;
    }
    // --- Phase 4 fields ----------------------------------------------------
    if (root.object.get("provider")) |value| {
        if (value != .string) return Error.InvalidInterfaceManifest;
        manifest.provider = value.string;
    }
    if (root.object.get("model_name")) |value| {
        if (value != .string) return Error.InvalidInterfaceManifest;
        manifest.model_name = value.string;
    }
    if (root.object.get("protocol")) |value| {
        if (value != .string) return Error.InvalidInterfaceManifest;
        manifest.protocol = value.string;
    }
    if (root.object.get("cost_micros")) |value| {
        const raw = int(root, "cost_micros") orelse return Error.InvalidInterfaceManifest;
        if (value != .integer or raw < 0) return Error.InvalidInterfaceManifest;
        manifest.cost_micros = @intCast(raw);
    }
    if (root.object.get("device_role")) |value| {
        if (value != .string) return Error.InvalidInterfaceManifest;
        manifest.device_role = DeviceRole.parse(value.string) orelse
            return Error.InterfaceDeviceRoleInvalid;
    }
    if (root.object.get("device_state_template")) |value| {
        if (value != .string) return Error.InvalidInterfaceManifest;
        manifest.device_state_template = value.string;
    }
    if (root.object.get("human_interaction")) |value| {
        if (value != .string) return Error.InvalidInterfaceManifest;
        manifest.human_interaction = HumanInteraction.parse(value.string) orelse
            return Error.InterfaceProvenanceMissing;
    }
    if (root.object.get("approval_interface")) |value| {
        if (value != .string) return Error.InvalidInterfaceManifest;
        manifest.approval_interface = value.string;
    }
    if (root.object.get("economics")) |value| {
        if (value != .string) return Error.InvalidInterfaceManifest;
        manifest.economics = Economics.parse(value.string) orelse
            return Error.InterfacePaymentProfileIncomplete;
    }
    if (root.object.get("payment_adapter")) |value| {
        if (value != .string) return Error.InvalidInterfaceManifest;
        manifest.payment_adapter = value.string;
    }
    if (root.object.get("payment_approval_interface")) |value| {
        if (value != .string) return Error.InvalidInterfaceManifest;
        manifest.payment_approval_interface = value.string;
    }
    if (root.object.get("payment_response_field")) |value| {
        if (value != .string) return Error.InvalidInterfaceManifest;
        manifest.payment_response_field = value.string;
    }

    try validateKind(&manifest);
    return manifest;
}

/// A URL template may carry `{input}` at most once and nothing else in braces.
/// Substitution percent-encodes the value, so the template is the only place a
/// URL's structure is decided.
fn validateUrlTemplate(template: []const u8) !void {
    if (!std.mem.startsWith(u8, template, "http://") and
        !std.mem.startsWith(u8, template, "https://")) return Error.InterfaceUrlTemplateInvalid;
    var placeholders: usize = 0;
    var index: usize = 0;
    while (index < template.len) {
        const byte = template[index];
        if (byte <= 0x20 or byte >= 0x7f or byte == '"' or byte == '\\')
            return Error.InterfaceUrlTemplateInvalid;
        if (byte == '{') {
            if (!std.mem.startsWith(u8, template[index..], "{input}"))
                return Error.InterfaceUrlTemplateInvalid;
            placeholders += 1;
            index += "{input}".len;
            continue;
        }
        if (byte == '}') return Error.InterfaceUrlTemplateInvalid;
        index += 1;
    }
    if (placeholders > 1) return Error.InterfaceUrlTemplateInvalid;
}

/// Percent-encode everything outside the unreserved set. The value becomes one
/// opaque URL component and cannot introduce a delimiter, a second parameter,
/// or a path segment.
pub fn resolveUrl(a: Allocator, template: []const u8, input: []const u8) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    var index: usize = 0;
    while (index < template.len) {
        if (std.mem.startsWith(u8, template[index..], "{input}")) {
            for (input) |byte| {
                const unreserved = std.ascii.isAlphanumeric(byte) or
                    byte == '-' or byte == '_' or byte == '.' or byte == '~';
                if (unreserved) {
                    try out.append(a, byte);
                } else {
                    try out.appendSlice(a, try std.fmt.allocPrint(a, "%{X:0>2}", .{byte}));
                }
            }
            index += "{input}".len;
            continue;
        }
        try out.append(a, template[index]);
        index += 1;
    }
    return out.toOwnedSlice(a);
}

fn validateKind(manifest: *const Manifest) !void {
    switch (manifest.kind) {
        .function => {
            // A pure function's code *is* the pipeline text, so validating it
            // and pinning its digest are the same act.
            var count: usize = 0;
            var it = std.mem.splitScalar(u8, manifest.locator, '|');
            while (it.next()) |raw| {
                const op = std.mem.trim(u8, raw, " ");
                if (op.len == 0) return Error.UnknownFunctionOp;
                _ = Op.parse(op) orelse return Error.UnknownFunctionOp;
                count += 1;
                if (count > MAX_PIPELINE_OPS) return Error.InterfaceBudgetInvalid;
            }
            if (count == 0) return Error.UnknownFunctionOp;
            if (manifest.invocation.mode != .read) return Error.UnverifiableCommand;
            if (manifest.argv_template.len != 0 or manifest.target_template.len != 0)
                return Error.InvalidInterfaceManifest;
        },
        .process => {
            if (manifest.argv_template.len == 0) return Error.IncompleteInterfaceManifest;
            if (manifest.argv_template.len > MAX_ARGV) return Error.InterfaceBudgetInvalid;
            if (!std.fs.path.isAbsolute(manifest.locator)) return Error.InterfaceBoundaryUnusable;
            if (!std.mem.eql(u8, manifest.argv_template[0], manifest.locator))
                return Error.ArgvLocatorMismatch;
            var placeholders: usize = 0;
            for (manifest.argv_template) |element| {
                if (element.len == 0) return Error.ArgvTemplateInjection;
                for (element) |byte| {
                    if (byte < 0x20 or byte == 0x7f) return Error.ArgvTemplateInjection;
                }
                if (std.mem.eql(u8, element, "{input}")) {
                    placeholders += 1;
                    continue;
                }
                // The load-bearing rule: an argument is either the whole
                // input or contains none of it. `"cat {input}"` — the shape
                // that turns a value into extra arguments once anything
                // splits it — is rejected structurally, not filtered.
                if (std.mem.indexOfScalar(u8, element, '{') != null or
                    std.mem.indexOfScalar(u8, element, '}') != null)
                    return Error.ArgvTemplateInjection;
            }
            switch (manifest.input_channel) {
                .argv => if (placeholders != 1) return Error.InterfaceInputChannelMismatch,
                .stdin, .none => if (placeholders != 0) return Error.InterfaceInputChannelMismatch,
            }
            // A process mutation has no independent local sensor to reconcile
            // against, so Phase 2 admits process boundaries as reads only.
            // Verified process commands arrive with Phase 3 sensors.
            if (manifest.invocation.mode != .read) return Error.UnverifiableCommand;
            if (manifest.target_template.len != 0) return Error.InvalidInterfaceManifest;
        },
        .filesystem => {
            if (!std.fs.path.isAbsolute(manifest.locator)) return Error.InterfaceBoundaryUnusable;
            if (manifest.target_template.len == 0) return Error.IncompleteInterfaceManifest;
            if (manifest.argv_template.len != 0) return Error.InvalidInterfaceManifest;
            try validateTemplate(manifest.target_template, manifest.invocation.mode);
            switch (manifest.invocation.mode) {
                .read => if (manifest.input_channel != .argv)
                    return Error.InterfaceInputChannelMismatch,
                // Content addressing makes a filesystem command intrinsically
                // idempotent and independently readable back: the two
                // properties that let it cross the outbox safely.
                .command => {
                    if (manifest.input_channel != .stdin)
                        return Error.InterfaceInputChannelMismatch;
                    if (manifest.invocation.idempotency != .intrinsic)
                        return Error.UnverifiableCommand;
                    if (std.mem.indexOf(u8, manifest.target_template, "{digest}") == null)
                        return Error.UnverifiableCommand;
                },
            }
        },
        .http => {
            if (manifest.url_template.len == 0) return Error.IncompleteInterfaceManifest;
            try validateUrlTemplate(manifest.url_template);
            if (manifest.argv_template.len != 0 or manifest.target_template.len != 0)
                return Error.InvalidInterfaceManifest;
            if (manifest.response_encoding == .json and manifest.response_field.len == 0)
                return Error.IncompleteInterfaceManifest;
            switch (manifest.invocation.mode) {
                // A read must be *contractually* non-mutating: a safe method
                // and the endpoint's own declaration. Either one alone leaves
                // the operation mixed, and mixed defaults to command (§17.3).
                .read => if (!manifest.method.safe() or !manifest.non_mutating)
                    return Error.InterfaceRemoteReadUnsafe,
                .command => {
                    // Remote consequence is only admissible with an
                    // independent sensor to reconcile against, and an
                    // idempotency key so a redelivery is not a second effect.
                    if (manifest.reconcile_url_template.len == 0)
                        return Error.UnverifiableCommand;
                    try validateUrlTemplate(manifest.reconcile_url_template);
                    if (manifest.reconcile_encoding == .json and manifest.reconcile_field.len == 0)
                        return Error.IncompleteInterfaceManifest;
                    if (manifest.invocation.idempotency == .none)
                        return Error.UnverifiableCommand;
                },
            }
        },
        .mcp => {
            if (!std.fs.path.isAbsolute(manifest.locator)) return Error.InterfaceBoundaryUnusable;
            if (manifest.tool.len == 0) return Error.IncompleteInterfaceManifest;
            if (manifest.argv_template.len == 0) return Error.IncompleteInterfaceManifest;
            if (manifest.argv_template.len > MAX_ARGV) return Error.InterfaceBudgetInvalid;
            if (!std.mem.eql(u8, manifest.argv_template[0], manifest.locator))
                return Error.ArgvLocatorMismatch;
            // The server is launched, not templated: the input travels as a
            // typed tool argument, never as an argument to the process.
            for (manifest.argv_template) |element| {
                if (element.len == 0) return Error.ArgvTemplateInjection;
                if (std.mem.indexOfScalar(u8, element, '{') != null or
                    std.mem.indexOfScalar(u8, element, '}') != null)
                    return Error.ArgvTemplateInjection;
                for (element) |byte| {
                    if (byte < 0x20 or byte == 0x7f) return Error.ArgvTemplateInjection;
                }
            }
            if (manifest.target_template.len != 0) return Error.InvalidInterfaceManifest;
            // A tool call's external consequence has no local sensor, so the
            // MCP kind is admitted for reads only in this phase.
            if (manifest.invocation.mode != .read) return Error.UnverifiableCommand;
        },
        .model => {
            // A model is a remote endpoint, so it validates as one: real URL,
            // strict response contract, no local templates.
            if (manifest.url_template.len == 0) return Error.IncompleteInterfaceManifest;
            try validateUrlTemplate(manifest.url_template);
            if (manifest.argv_template.len != 0 or manifest.target_template.len != 0)
                return Error.InvalidInterfaceManifest;
            if (manifest.response_encoding == .json and manifest.response_field.len == 0)
                return Error.IncompleteInterfaceManifest;
            // Exact provenance for output nobody can reproduce. Without all
            // three, a sampled answer could not be attributed to what produced
            // it — which is the only thing that makes it auditable at all.
            if (manifest.provider.len == 0 or manifest.model_name.len == 0 or
                manifest.protocol.len == 0) return Error.InterfaceProvenanceMissing;
            // Inference is an observation, not a world-effect. Admitting a
            // model as a command would put sampled bytes on the outbox path
            // with no sensor that could ever reconcile them.
            if (manifest.invocation.mode != .read) return Error.UnverifiableCommand;
            if (!manifest.method.safe() and !manifest.non_mutating)
                return Error.InterfaceRemoteReadUnsafe;
        },
        .device => {
            if (!std.fs.path.isAbsolute(manifest.locator)) return Error.InterfaceBoundaryUnusable;
            if (manifest.argv_template.len != 0) return Error.InvalidInterfaceManifest;
            if (manifest.device_state_template.len == 0) return Error.IncompleteInterfaceManifest;
            // The role/mode agreement is checked *before* the template, so a
            // sensor mislabelled as a command is rejected for the reason it is
            // actually wrong rather than for the path-escape that mislabelling
            // happens to imply.
            switch (manifest.device_role) {
                .sensor => if (manifest.invocation.mode != .read) return Error.InterfaceDeviceRoleInvalid,
                .actuator => if (manifest.invocation.mode != .command) return Error.InterfaceDeviceRoleInvalid,
            }
            try validateTemplate(manifest.device_state_template, manifest.invocation.mode);
            switch (manifest.device_role) {
                // A sensor observes. It may never be a command: that is the
                // whole point of declaring the split.
                .sensor => {
                    if (manifest.input_channel != .argv)
                        return Error.InterfaceInputChannelMismatch;
                },
                // An actuator changes the world, so it carries every property
                // a consequential command needs — content addressing for
                // idempotency, an independent state path to reconcile
                // against — plus the human gate that Phase 4 adds.
                .actuator => {
                    if (manifest.input_channel != .stdin)
                        return Error.InterfaceInputChannelMismatch;
                    if (manifest.invocation.idempotency != .intrinsic)
                        return Error.UnverifiableCommand;
                    if (std.mem.indexOf(u8, manifest.device_state_template, "{digest}") == null)
                        return Error.UnverifiableCommand;
                    if (manifest.approval_interface.len == 0)
                        return Error.InterfaceSafetyGateMissing;
                    _ = digestFromHex(manifest.approval_interface) catch
                        return Error.InterfaceSafetyGateMissing;
                },
            }
        },
        .human => {
            if (!std.fs.path.isAbsolute(manifest.locator)) return Error.InterfaceBoundaryUnusable;
            if (manifest.argv_template.len != 0) return Error.InvalidInterfaceManifest;
            if (manifest.target_template.len == 0) return Error.IncompleteInterfaceManifest;
            try validateTemplate(manifest.target_template, .read);
            if (manifest.input_channel != .argv) return Error.InterfaceInputChannelMismatch;
            // Asking a human is an observation of their decision. The decision
            // gates an effect elsewhere; it is never itself the effect.
            if (manifest.invocation.mode != .read) return Error.UnverifiableCommand;
        },
    }
    // A model samples and a human decides; neither can be checked by calling it
    // twice. Letting either claim determinism would license exactly the
    // verification path that cannot work for them.
    if (manifest.kind.nondeterministic() and manifest.invocation.deterministic)
        return Error.InterfaceNondeterminismClaim;
    // An economic profile is only meaningful over a boundary that can actually
    // be challenged, and it is incomplete without somewhere to send the
    // challenge and someone to approve the spend.
    if (manifest.economics != .none) {
        if (manifest.kind != .http and manifest.kind != .model)
            return Error.InterfacePaymentProfileIncomplete;
        if (manifest.payment_adapter.len == 0 or manifest.payment_approval_interface.len == 0)
            return Error.InterfacePaymentProfileIncomplete;
        _ = digestFromHex(manifest.payment_adapter) catch
            return Error.InterfacePaymentProfileIncomplete;
        _ = digestFromHex(manifest.payment_approval_interface) catch
            return Error.InterfacePaymentProfileIncomplete;
    }
    if (manifest.invocation.mode == .command and !manifest.requested_caps.allow_send)
        return Error.UnverifiableCommand;
}

/// A relative template may not climb, absolutize, or hide control bytes, and
/// `{input}` — the only placeholder carrying caller data into a path — is
/// confined to the read path.
fn validateTemplate(template: []const u8, mode: Mode) !void {
    if (std.fs.path.isAbsolute(template)) return Error.InterfacePathEscape;
    var index: usize = 0;
    while (index < template.len) {
        if (template[index] == '{') {
            if (std.mem.startsWith(u8, template[index..], "{input}")) {
                if (mode != .read) return Error.InterfacePathEscape;
                index += "{input}".len;
                continue;
            }
            if (std.mem.startsWith(u8, template[index..], "{digest}")) {
                index += "{digest}".len;
                continue;
            }
            return Error.InterfacePathEscape;
        }
        if (template[index] == '}') return Error.InterfacePathEscape;
        index += 1;
    }
    // The literal skeleton must already be a well-formed relative path;
    // substituted values are re-validated in full afterwards.
    try validateRelative(template);
}

/// Every component must be an ordinary name: no climb, no self-reference, no
/// empty component, no control bytes. Applied to the template *and* again to
/// the substituted result, because the value is what actually opens a file.
fn validateRelative(path: []const u8) !void {
    if (path.len == 0) return Error.InterfacePathEscape;
    if (std.fs.path.isAbsolute(path)) return Error.InterfacePathEscape;
    for (path) |byte| {
        if (byte < 0x20 or byte == 0x7f) return Error.InterfacePathEscape;
    }
    var it = std.mem.splitScalar(u8, path, '/');
    var components: usize = 0;
    while (it.next()) |component| {
        if (component.len == 0) return Error.InterfacePathEscape;
        if (std.mem.eql(u8, component, ".") or std.mem.eql(u8, component, ".."))
            return Error.InterfacePathEscape;
        components += 1;
    }
    if (components == 0) return Error.InterfacePathEscape;
    return;
}

/// Substitute the template and re-validate the whole result. A traversal
/// smuggled in through `input` dies here, after substitution, where it is
/// visible as a path rather than as a value.
pub fn resolveTarget(
    a: Allocator,
    manifest: *const Manifest,
    input: []const u8,
    content_digest: types.Digest,
) ![]const u8 {
    const hex = std.fmt.bytesToHex(content_digest, .lower);
    var out: std.ArrayList(u8) = .empty;
    var index: usize = 0;
    while (index < manifest.target_template.len) {
        const rest = manifest.target_template[index..];
        if (std.mem.startsWith(u8, rest, "{input}")) {
            try out.appendSlice(a, input);
            index += "{input}".len;
        } else if (std.mem.startsWith(u8, rest, "{digest}")) {
            try out.appendSlice(a, &hex);
            index += "{digest}".len;
        } else {
            try out.append(a, manifest.target_template[index]);
            index += 1;
        }
    }
    const resolved = try out.toOwnedSlice(a);
    try validateRelative(resolved);
    return resolved;
}

// ---------------------------------------------------------------------------
// Pure-function adapter: total, deterministic, content-addressed code
// ---------------------------------------------------------------------------

/// The op vocabulary is deliberately total: every op terminates, allocates
/// O(input), and has no environment. A pipeline therefore needs no timeout and
/// its digest fully determines its behavior.
pub const Op = union(enum) {
    trim,
    upper,
    lower,
    reverse,
    sha256,
    len,
    lines,
    words,
    first_line,
    sort_lines,
    unique_lines,
    collapse_ws,

    pub fn parse(text: []const u8) ?Op {
        const table = .{
            .{ "trim", Op.trim },
            .{ "upper", Op.upper },
            .{ "lower", Op.lower },
            .{ "reverse", Op.reverse },
            .{ "sha256", Op.sha256 },
            .{ "len", Op.len },
            .{ "lines", Op.lines },
            .{ "words", Op.words },
            .{ "first-line", Op.first_line },
            .{ "sort-lines", Op.sort_lines },
            .{ "unique-lines", Op.unique_lines },
            .{ "collapse-ws", Op.collapse_ws },
        };
        inline for (table) |entry| {
            if (std.mem.eql(u8, text, entry[0])) return entry[1];
        }
        return null;
    }
};

pub fn evalPipeline(a: Allocator, pipeline: []const u8, input: []const u8) ![]const u8 {
    var current: []const u8 = input;
    var it = std.mem.splitScalar(u8, pipeline, '|');
    while (it.next()) |raw| {
        const name = std.mem.trim(u8, raw, " ");
        const op = Op.parse(name) orelse return Error.UnknownFunctionOp;
        current = try applyOp(a, op, current);
    }
    return current;
}

fn applyOp(a: Allocator, op: Op, input: []const u8) ![]const u8 {
    switch (op) {
        .trim => return std.mem.trim(u8, input, " \t\r\n"),
        .upper => {
            const out = try a.alloc(u8, input.len);
            for (input, 0..) |byte, index| out[index] = std.ascii.toUpper(byte);
            return out;
        },
        .lower => {
            const out = try a.alloc(u8, input.len);
            for (input, 0..) |byte, index| out[index] = std.ascii.toLower(byte);
            return out;
        },
        .reverse => {
            const out = try a.alloc(u8, input.len);
            for (input, 0..) |byte, index| out[input.len - 1 - index] = byte;
            return out;
        },
        .sha256 => {
            const hex = std.fmt.bytesToHex(types.digest(input), .lower);
            return a.dupe(u8, &hex);
        },
        .len => return std.fmt.allocPrint(a, "{d}", .{input.len}),
        .lines => {
            if (input.len == 0) return a.dupe(u8, "0");
            var count: usize = 1;
            for (input) |byte| {
                if (byte == '\n') count += 1;
            }
            if (input[input.len - 1] == '\n') count -= 1;
            return std.fmt.allocPrint(a, "{d}", .{count});
        },
        .words => {
            var count: usize = 0;
            var it = std.mem.tokenizeAny(u8, input, " \t\r\n");
            while (it.next()) |_| count += 1;
            return std.fmt.allocPrint(a, "{d}", .{count});
        },
        .first_line => {
            const end = std.mem.indexOfScalar(u8, input, '\n') orelse input.len;
            return input[0..end];
        },
        .sort_lines => {
            var list: std.ArrayList([]const u8) = .empty;
            var it = std.mem.splitScalar(u8, input, '\n');
            while (it.next()) |line| try list.append(a, line);
            std.mem.sort([]const u8, list.items, {}, lessThan);
            return std.mem.join(a, "\n", list.items);
        },
        .unique_lines => {
            var list: std.ArrayList([]const u8) = .empty;
            var it = std.mem.splitScalar(u8, input, '\n');
            while (it.next()) |line| {
                var seen = false;
                for (list.items) |prior| {
                    if (std.mem.eql(u8, prior, line)) {
                        seen = true;
                        break;
                    }
                }
                if (!seen) try list.append(a, line);
            }
            return std.mem.join(a, "\n", list.items);
        },
        .collapse_ws => {
            var out: std.ArrayList(u8) = .empty;
            var it = std.mem.tokenizeAny(u8, input, " \t\r\n");
            var first = true;
            while (it.next()) |token| {
                if (!first) try out.append(a, ' ');
                try out.appendSlice(a, token);
                first = false;
            }
            return out.toOwnedSlice(a);
        },
    }
}

fn lessThan(_: void, left: []const u8, right: []const u8) bool {
    return std.mem.lessThan(u8, left, right);
}

/// Canonical pipeline text: op names, single `|` separators, no spacing
/// freedom. The digest pins behavior, so two spellings of one pipeline must
/// not produce two identities.
pub fn canonicalPipeline(a: Allocator, pipeline: []const u8) ![]const u8 {
    var list: std.ArrayList([]const u8) = .empty;
    var it = std.mem.splitScalar(u8, pipeline, '|');
    while (it.next()) |raw| {
        const name = std.mem.trim(u8, raw, " ");
        _ = Op.parse(name) orelse return Error.UnknownFunctionOp;
        try list.append(a, name);
    }
    if (list.items.len == 0) return Error.UnknownFunctionOp;
    return std.mem.join(a, "|", list.items);
}

// ---------------------------------------------------------------------------
// Implementation pinning
// ---------------------------------------------------------------------------

/// Recompute the implementation digest from the live boundary. Called before
/// admission and again before every invocation: an interface whose
/// implementation moved is not the interface that was admitted.
///
/// Remote kinds have no local bytes to hash, so `contractPin` covers their
/// declared contract instead — see `Kind.pinsRemoteContract`.
pub fn computeImplementationDigest(a: Allocator, io: std.Io, kind: Kind, locator: []const u8) !types.Digest {
    var hasher = Sha256.init(.{});
    const cwd = std.Io.Dir.cwd();
    switch (kind) {
        .function => {
            const canonical = try canonicalPipeline(a, locator);
            hasher.update(FUNCTION_DOMAIN);
            hasher.update(canonical);
        },
        .process => {
            const stat = cwd.statFile(io, locator, .{}) catch return Error.InterfaceBoundaryUnusable;
            if (stat.kind != .file) return Error.InterfaceBoundaryUnusable;
            cwd.access(io, locator, .{ .execute = true }) catch return Error.InterfaceBoundaryUnusable;
            const bytes = cwd.readFileAlloc(io, locator, a, .limited(MAX_IMPLEMENTATION_BYTES)) catch
                return Error.InterfaceBoundaryUnusable;
            hasher.update(PROCESS_DOMAIN);
            hasher.update(bytes);
        },
        .filesystem => {
            const stat = cwd.statFile(io, locator, .{}) catch return Error.InterfaceBoundaryUnusable;
            if (stat.kind != .directory) return Error.InterfaceBoundaryUnusable;
            const canonical = canonicalRoot(a, io, locator) catch return Error.InterfaceBoundaryUnusable;
            hasher.update(FILESYSTEM_DOMAIN);
            hasher.update(canonical);
        },
        // A remote endpoint is pinned by its contract, which lives in the
        // manifest rather than at the locator; `contractPin` computes it.
        .http, .model => return Error.InterfaceBoundaryUnusable,
        // A device root and a human inbox are both real local directories, so
        // they pin like one: the canonical path, under their own domain so a
        // device root can never be reused as a human inbox.
        .device => {
            const stat = cwd.statFile(io, locator, .{}) catch return Error.InterfaceBoundaryUnusable;
            if (stat.kind != .directory) return Error.InterfaceBoundaryUnusable;
            const canonical = canonicalRoot(a, io, locator) catch return Error.InterfaceBoundaryUnusable;
            hasher.update(DEVICE_DOMAIN);
            hasher.update(canonical);
        },
        .human => {
            const stat = cwd.statFile(io, locator, .{}) catch return Error.InterfaceBoundaryUnusable;
            if (stat.kind != .directory) return Error.InterfaceBoundaryUnusable;
            const canonical = canonicalRoot(a, io, locator) catch return Error.InterfaceBoundaryUnusable;
            hasher.update(HUMAN_DOMAIN);
            hasher.update(canonical);
        },
        .mcp => {
            const stat = cwd.statFile(io, locator, .{}) catch return Error.InterfaceBoundaryUnusable;
            if (stat.kind != .file) return Error.InterfaceBoundaryUnusable;
            cwd.access(io, locator, .{ .execute = true }) catch return Error.InterfaceBoundaryUnusable;
            const bytes = cwd.readFileAlloc(io, locator, a, .limited(MAX_IMPLEMENTATION_BYTES)) catch
                return Error.InterfaceBoundaryUnusable;
            hasher.update(MCP_DOMAIN);
            hasher.update(bytes);
        },
    }
    var digest: types.Digest = undefined;
    hasher.final(&digest);
    return digest;
}

/// The pin for a boundary whose identity is a declaration rather than local
/// bytes. It covers everything the caller relies on — method, address, and the
/// response shape — so changing any of them is a different interface that must
/// be admitted again. It deliberately does *not* claim anything about the
/// remote implementation: only the response contract check and independent
/// verification can speak to that.
pub fn contractPin(a: Allocator, manifest: *const Manifest) !types.Digest {
    var hasher = Sha256.init(.{});
    hasher.update(if (manifest.kind == .model) MODEL_DOMAIN else HTTP_DOMAIN);
    // Provider identity is *inside* the pin, so swapping provider or model
    // produces a different interface digest that must be admitted again. That
    // is what makes a provider swap an auditable event rather than a silent
    // substitution behind an unchanged name.
    const cost = try std.fmt.allocPrint(a, "{d}", .{manifest.cost_micros});
    for ([_][]const u8{
        manifest.method.name(),
        manifest.url_template,
        manifest.response_encoding.name(),
        manifest.response_field,
        manifest.reconcile_url_template,
        manifest.reconcile_encoding.name(),
        manifest.reconcile_field,
        if (manifest.non_mutating) "non-mutating" else "mutating",
        manifest.invocation.mode.name(),
        manifest.provider,
        manifest.model_name,
        manifest.protocol,
        cost,
    }) |field| {
        hasher.update(try std.fmt.allocPrint(a, "{d}:", .{field.len}));
        hasher.update(field);
        hasher.update("\n");
    }
    var digest: types.Digest = undefined;
    hasher.final(&digest);
    return digest;
}

/// The full MCP pin: the server executable's bytes *and* the tool name. A
/// different tool on the same server is a different interface.
pub fn mcpPin(a: Allocator, io: std.Io, manifest: *const Manifest) !types.Digest {
    const server = try computeImplementationDigest(a, io, .mcp, manifest.locator);
    var hasher = Sha256.init(.{});
    hasher.update(MCP_DOMAIN);
    hasher.update(&server);
    hasher.update(try std.fmt.allocPrint(a, "{d}:", .{manifest.tool.len}));
    hasher.update(manifest.tool);
    var digest: types.Digest = undefined;
    hasher.final(&digest);
    return digest;
}

fn canonicalRoot(a: Allocator, io: std.Io, root: []const u8) ![]const u8 {
    const resolved = try std.Io.Dir.cwd().realPathFileAlloc(io, root, a);
    return resolved[0..resolved.len];
}

pub fn verifyImplementation(a: Allocator, io: std.Io, manifest: *const Manifest) !void {
    const live = switch (manifest.kind) {
        .http, .model => try contractPin(a, manifest),
        .mcp => try mcpPin(a, io, manifest),
        else => try computeImplementationDigest(a, io, manifest.kind, manifest.locator),
    };
    if (!std.mem.eql(u8, &live, &manifest.implementation_digest)) return Error.InterfaceDigestDrift;
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

/// A capability read: observe the boundary without externally meaningful
/// mutation. Refuses a command manifest outright — the outbox is the only path
/// for consequence, and that is enforced here rather than trusted upstream.
pub fn invokeRead(a: Allocator, io: std.Io, manifest: *const Manifest, input: []const u8) !Outcome {
    if (manifest.invocation.mode != .read) return Error.InterfaceModeMismatch;
    try verifyImplementation(a, io, manifest);
    const output = switch (manifest.kind) {
        .function => try evalPipeline(a, manifest.locator, input),
        .process => try runProcess(a, io, manifest, input),
        .filesystem => try readUnderRoot(a, io, manifest, input),
        .http, .model => try httpRequest(a, io, manifest, manifest.url_template, input, null, manifest.response_encoding, manifest.response_field),
        .mcp => try mcpToolCall(a, io, manifest, input),
        // A sensor reads the device's own state path; a human's answer is read
        // out of their inbox. Both decode strictly, so an absent or malformed
        // document is a typed failure rather than an empty value.
        .device => try readDeviceState(a, io, manifest, input),
        .human => try readHumanDecision(a, io, manifest, input),
    };
    if (output.len > manifest.invocation.max_output_bytes) return Error.InterfaceOutputTooLarge;
    return .{ .output = output, .output_digest = types.digest(output) };
}

/// A read against a boundary that may charge for it.
///
/// `challenge_out` receives the raw 402 body when the resource asks to be paid;
/// `payment_signature` carries a proof produced by an admitted adapter. This
/// function still does not pay: it performs the exchange and reports what
/// happened. The decision to spend is made by `governSpend` above it, and the
/// signature is made by an adapter beside it — neither is here.
pub fn invokeReadPaid(
    a: Allocator,
    io: std.Io,
    manifest: *const Manifest,
    input: []const u8,
    payment_signature: ?[]const u8,
    challenge_out: ?*[]const u8,
) !Outcome {
    if (manifest.invocation.mode != .read) return Error.InterfaceModeMismatch;
    if (manifest.economics == .none) return invokeRead(a, io, manifest, input);
    try verifyImplementation(a, io, manifest);
    const output = try httpRequestPaid(
        a,
        io,
        manifest,
        manifest.url_template,
        input,
        null,
        manifest.response_encoding,
        manifest.response_field,
        payment_signature,
        challenge_out,
    );
    if (output.len > manifest.invocation.max_output_bytes) return Error.InterfaceOutputTooLarge;
    return .{ .output = output, .output_digest = types.digest(output) };
}

/// A consequential command. Reachable only from the outbox drain path: the
/// caller must already hold a committed outbox record naming this content.
pub fn applyCommand(a: Allocator, io: std.Io, manifest: *const Manifest, input: []const u8) !Outcome {
    if (manifest.invocation.mode != .command) return Error.InterfaceModeMismatch;
    try verifyImplementation(a, io, manifest);
    switch (manifest.kind) {
        .filesystem => {
            const content_digest = types.digest(input);
            const relative = try resolveTarget(a, manifest, input, content_digest);
            const path = try confinedPath(a, io, manifest.locator, relative, true);
            const cwd = std.Io.Dir.cwd();
            if (std.fs.path.dirname(path)) |parent| {
                cwd.createDirPath(io, parent) catch return Error.InterfaceBoundaryUnusable;
            }
            cwd.writeFile(io, .{ .sub_path = path, .data = input }) catch
                return Error.InterfaceCallFailed;
            return .{
                .output = input,
                .target = relative,
                .output_digest = content_digest,
            };
        },
        .http => {
            // The content idempotency key travels with the request, so a
            // redelivery of the same committed record is the same effect at the
            // far end rather than a second one.
            const key = std.fmt.bytesToHex(types.digest(input), .lower);
            const output = try httpRequest(a, io, manifest, manifest.url_template, input, &key, manifest.response_encoding, manifest.response_field);
            return .{
                .output = output,
                .target = try resolveUrl(a, manifest.reconcile_url_template, &key),
                .output_digest = types.digest(output),
            };
        },
        // An actuator's effect is content-addressed into the device's state
        // path, exactly like a filesystem command — so the same read-back that
        // reconciles a file reconciles a device. The human gate that permits
        // this call at all is enforced on the dispatch path, before here.
        .device => {
            const content_digest = types.digest(input);
            const relative = try resolveDeviceState(a, manifest, input, content_digest);
            const path = try confinedPath(a, io, manifest.locator, relative, true);
            const cwd = std.Io.Dir.cwd();
            if (std.fs.path.dirname(path)) |parent| {
                cwd.createDirPath(io, parent) catch return Error.InterfaceBoundaryUnusable;
            }
            cwd.writeFile(io, .{ .sub_path = path, .data = input }) catch
                return Error.InterfaceCallFailed;
            return .{
                .output = input,
                .target = relative,
                .output_digest = content_digest,
            };
        },
        // Rejected at admission; unreachable through an admitted manifest.
        .function, .process, .mcp, .model, .human => return Error.UnverifiableCommand,
    }
}

/// Independent reconciliation: read the external state back through a
/// different code path than the write and compare content identity. An
/// acknowledgement from the writer is not evidence that the write happened.
pub fn verifyCommand(a: Allocator, io: std.Io, manifest: *const Manifest, input: []const u8) !void {
    if (manifest.invocation.mode != .command) return Error.InterfaceModeMismatch;
    switch (manifest.kind) {
        .filesystem => {
            const relative = try resolveTarget(a, manifest, input, types.digest(input));
            const path = try confinedPath(a, io, manifest.locator, relative, false);
            const bytes = std.Io.Dir.cwd().readFileAlloc(io, path, a, .limited(MAX_OUTPUT_BYTES)) catch
                return Error.InterfaceReconciliationFailed;
            if (!std.mem.eql(u8, bytes, input)) return Error.InterfaceReconciliationFailed;
        },
        .http => {
            // The declared sensor is read through the ordinary read path — a
            // GET, independent of the write — and must return the content that
            // was sent. The remote's own success reply is not the evidence.
            const key = std.fmt.bytesToHex(types.digest(input), .lower);
            const observed = httpRequest(a, io, manifest, manifest.reconcile_url_template, &key, null, manifest.reconcile_encoding, manifest.reconcile_field) catch
                return Error.InterfaceReconciliationFailed;
            if (!std.mem.eql(u8, observed, input)) return Error.InterfaceReconciliationFailed;
        },
        // Read the actuator's effect back out of the device's own state path —
        // a different code path than the write. The actuator's own return value
        // is not evidence that the device moved.
        .device => {
            const relative = try resolveDeviceState(a, manifest, input, types.digest(input));
            const path = try confinedPath(a, io, manifest.locator, relative, false);
            const bytes = std.Io.Dir.cwd().readFileAlloc(io, path, a, .limited(MAX_OUTPUT_BYTES)) catch
                return Error.InterfaceReconciliationFailed;
            if (!std.mem.eql(u8, bytes, input)) return Error.InterfaceReconciliationFailed;
        },
        .function, .process, .mcp, .model, .human => return Error.UnverifiableCommand,
    }
}

/// One bounded HTTP exchange. The response is decoded strictly against the
/// declared contract: a non-success status, an oversized body, or a shape the
/// manifest did not declare is a typed failure. Undecoded bytes never become
/// evidence (invariant 7 / §17.3 "a remote response is untrusted input").
fn httpRequest(
    a: Allocator,
    io: std.Io,
    manifest: *const Manifest,
    template: []const u8,
    input: []const u8,
    idempotency_key: ?[]const u8,
    encoding: ResponseEncoding,
    field: []const u8,
) ![]const u8 {
    return httpRequestPaid(a, io, manifest, template, input, idempotency_key, encoding, field, null, null);
}

/// The same bounded exchange, with the two additions the economic profile needs:
/// an optional payment proof to send, and an optional out-parameter that
/// receives the raw 402 challenge. The challenge is returned as *bytes* rather
/// than acted upon — decoding and judging it happen above, and signing happens
/// behind an admitted adapter.
fn httpRequestPaid(
    a: Allocator,
    io: std.Io,
    manifest: *const Manifest,
    template: []const u8,
    input: []const u8,
    idempotency_key: ?[]const u8,
    encoding: ResponseEncoding,
    field: []const u8,
    payment_signature: ?[]const u8,
    challenge_out: ?*[]const u8,
) ![]const u8 {
    const url = try resolveUrl(a, template, input);
    // A reconciliation read is always a GET, whatever the command's method is.
    const method: std.http.Method = if (std.mem.eql(u8, template, manifest.url_template))
        manifest.method.toStd()
    else
        .GET;

    var client: std.http.Client = .{ .allocator = a, .io = io };
    defer client.deinit();

    var body: std.ArrayList(u8) = .empty;
    var body_writer = std.Io.Writer.Allocating.fromArrayList(a, &body);
    defer body_writer.deinit();

    var headers: [2]std.http.Header = undefined;
    var header_count: usize = 0;
    if (idempotency_key) |key| {
        headers[header_count] = .{ .name = manifest.idempotency_header, .value = key };
        header_count += 1;
    }
    if (payment_signature) |proof| {
        headers[header_count] = .{ .name = PAYMENT_SIGNATURE_HEADER, .value = proof };
        header_count += 1;
    }

    const result = client.fetch(.{
        .location = .{ .url = url },
        .method = method,
        .payload = if (method == .GET or method == .HEAD) null else input,
        .response_writer = &body_writer.writer,
        .extra_headers = headers[0..header_count],
        .keep_alive = false,
    }) catch return Error.InterfaceCallFailed;
    // A 402 is a challenge, not a failure. It is surfaced as raw bytes for the
    // governor above to decode; this layer never decides to pay.
    if (result.status == .payment_required) {
        if (challenge_out) |slot| {
            const raw = body_writer.written();
            if (raw.len > manifest.invocation.max_output_bytes) return Error.InterfaceOutputTooLarge;
            slot.* = try a.dupe(u8, raw);
        }
        // Presenting a proof and still being challenged means the proof was
        // not accepted — a different condition from being asked to pay.
        return if (payment_signature == null)
            Error.InterfacePaymentRequired
        else
            Error.InterfacePaymentProofRejected;
    }
    if (result.status.class() != .success) return Error.InterfaceRemoteStatus;

    const bytes = body_writer.written();
    if (bytes.len > manifest.invocation.max_output_bytes) return Error.InterfaceOutputTooLarge;
    return decodeResponse(a, encoding, field, bytes);
}

/// Decode a remote answer into the value the manifest declared, or fail typed.
fn decodeResponse(
    a: Allocator,
    encoding: ResponseEncoding,
    field_name: []const u8,
    bytes: []const u8,
) ![]const u8 {
    switch (encoding) {
        .raw => return a.dupe(u8, bytes),
        .json => {
            const root = std.json.parseFromSliceLeaky(std.json.Value, a, bytes, .{}) catch
                return Error.InterfacePoisonedResponse;
            if (root != .object) return Error.InterfacePoisonedResponse;
            const field = root.object.get(field_name) orelse
                return Error.InterfacePoisonedResponse;
            return switch (field) {
                .string => |text| a.dupe(u8, text),
                .integer => |number| std.fmt.allocPrint(a, "{d}", .{number}),
                else => Error.InterfacePoisonedResponse,
            };
        },
    }
}

/// One MCP `tools/call` over NDJSON JSON-RPC 2.0 against a pinned server — the
/// same dialect `neuron mcp` serves, so the two are symmetric. The input
/// travels as a typed tool argument; it never reaches the server's argv.
fn mcpToolCall(a: Allocator, io: std.Io, manifest: *const Manifest, input: []const u8) ![]const u8 {
    var child = std.process.spawn(io, .{
        .argv = manifest.argv_template,
        .stdin = .pipe,
        .stdout = .pipe,
        .stderr = .pipe,
    }) catch return Error.InterfaceBoundaryUnusable;
    defer child.kill(io);

    const arguments = try std.json.Stringify.valueAlloc(a, .{ .input = input }, .{});
    const conversation = try std.fmt.allocPrint(a,
        \\{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{}}}}
        \\{{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{{"name":{s},"arguments":{s}}}}}
        \\
    , .{ try std.json.Stringify.valueAlloc(a, manifest.tool, .{}), arguments });

    var stdin_buffer: [4096]u8 = undefined;
    var stdin_writer = child.stdin.?.writer(io, &stdin_buffer);
    stdin_writer.interface.writeAll(conversation) catch return Error.InterfaceCallFailed;
    stdin_writer.interface.flush() catch return Error.InterfaceCallFailed;
    child.stdin.?.close(io);
    child.stdin = null;

    const timeout: std.Io.Timeout = .{ .duration = .{
        .raw = .{ .nanoseconds = @as(i96, manifest.invocation.timeout_ms) * std.time.ns_per_ms },
        .clock = .boot,
    } };
    var mr_buffer: std.Io.File.MultiReader.Buffer(2) = undefined;
    var multi_reader: std.Io.File.MultiReader = undefined;
    multi_reader.init(a, io, mr_buffer.toStreams(), &.{ child.stdout.?, child.stderr.? });
    defer multi_reader.deinit();
    while (multi_reader.fill(64, timeout)) |_| {
        if (multi_reader.reader(0).buffered().len > manifest.invocation.max_output_bytes)
            return Error.InterfaceOutputTooLarge;
    } else |err| switch (err) {
        error.EndOfStream => {},
        error.Timeout => return Error.InterfaceTimeout,
        else => return Error.InterfaceCallFailed,
    }
    multi_reader.checkAnyError() catch return Error.InterfaceCallFailed;
    _ = child.wait(io) catch return Error.InterfaceCallFailed;
    const transcript = multi_reader.toOwnedSlice(0) catch return Error.InterfaceCallFailed;

    return decodeToolResult(a, manifest, transcript);
}

/// Find the reply to the tool call in the NDJSON transcript and extract its
/// text content. Anything else — a missing reply, a JSON-RPC error, a result
/// that is not the declared shape — is poisoned input, never a value.
fn decodeToolResult(a: Allocator, manifest: *const Manifest, transcript: []const u8) ![]const u8 {
    var lines = std.mem.tokenizeAny(u8, transcript, "\r\n");
    while (lines.next()) |line| {
        const root = std.json.parseFromSliceLeaky(std.json.Value, a, line, .{}) catch continue;
        if (root != .object) continue;
        const id = root.object.get("id") orelse continue;
        if (id != .integer or id.integer != 2) continue;
        if (root.object.get("error") != null) return Error.InterfacePoisonedResponse;
        const result = root.object.get("result") orelse return Error.InterfacePoisonedResponse;
        if (result != .object) return Error.InterfacePoisonedResponse;
        const content = result.object.get("content") orelse return Error.InterfacePoisonedResponse;
        if (content != .array or content.array.items.len == 0) return Error.InterfacePoisonedResponse;
        const first = content.array.items[0];
        if (first != .object) return Error.InterfacePoisonedResponse;
        const text = first.object.get("text") orelse return Error.InterfacePoisonedResponse;
        if (text != .string) return Error.InterfacePoisonedResponse;
        // An MCP tool result carries its payload as text; when the manifest
        // declares a JSON field, that text is decoded one level further.
        if (manifest.response_encoding == .json)
            return decodeResponse(a, manifest.response_encoding, manifest.response_field, text.string);
        return a.dupe(u8, text.string);
    }
    return Error.InterfacePoisonedResponse;
}

fn readUnderRoot(a: Allocator, io: std.Io, manifest: *const Manifest, input: []const u8) ![]const u8 {
    const relative = try resolveTarget(a, manifest, input, types.digest(input));
    const path = try confinedPath(a, io, manifest.locator, relative, false);
    return std.Io.Dir.cwd().readFileAlloc(io, path, a, .limited(manifest.invocation.max_output_bytes + 1)) catch |err| switch (err) {
        error.StreamTooLong => Error.InterfaceOutputTooLarge,
        else => Error.InterfaceCallFailed,
    };
}

// ---------------------------------------------------------------------------
// Device and human adapters (Phase 4)
// ---------------------------------------------------------------------------

/// Resolve a device's state path. Identical substitution rules to
/// `resolveTarget`, but over `device_state_template`, so an actuator's write
/// target and a sensor's read target are the same declared surface.
pub fn resolveDeviceState(
    a: Allocator,
    manifest: *const Manifest,
    input: []const u8,
    content_digest: types.Digest,
) ![]const u8 {
    const hex = std.fmt.bytesToHex(content_digest, .lower);
    var out: std.ArrayList(u8) = .empty;
    var index: usize = 0;
    while (index < manifest.device_state_template.len) {
        const rest = manifest.device_state_template[index..];
        if (std.mem.startsWith(u8, rest, "{input}")) {
            try out.appendSlice(a, input);
            index += "{input}".len;
        } else if (std.mem.startsWith(u8, rest, "{digest}")) {
            try out.appendSlice(a, &hex);
            index += "{digest}".len;
        } else {
            try out.append(a, manifest.device_state_template[index]);
            index += 1;
        }
    }
    const resolved = try out.toOwnedSlice(a);
    try validateRelative(resolved);
    return resolved;
}

fn readDeviceState(a: Allocator, io: std.Io, manifest: *const Manifest, input: []const u8) ![]const u8 {
    const relative = try resolveDeviceState(a, manifest, input, types.digest(input));
    const path = try confinedPath(a, io, manifest.locator, relative, false);
    return std.Io.Dir.cwd().readFileAlloc(io, path, a, .limited(manifest.invocation.max_output_bytes + 1)) catch |err| switch (err) {
        error.StreamTooLong => Error.InterfaceOutputTooLarge,
        else => Error.InterfaceCallFailed,
    };
}

/// One human's typed answer. `decision` is meaningful only for an `approval`
/// interaction; review and annotation carry their content in `note`.
pub const HumanDecision = struct {
    approved: bool,
    /// The exact content the human was shown, hex. An approval is bound to the
    /// bytes it approved — otherwise an approval of one effect would authorize
    /// a different one.
    subject_hex: []const u8,
    note: []const u8,
};

/// Decode a human decision document strictly against the declared schema. A
/// missing file, a non-JSON body, an unknown decision word, or an absent
/// subject each fail closed: a human's silence is never an approval.
pub fn parseHumanDecision(a: Allocator, bytes: []const u8) !HumanDecision {
    const root = std.json.parseFromSliceLeaky(std.json.Value, a, bytes, .{}) catch
        return Error.InterfaceApprovalMalformed;
    if (root != .object) return Error.InterfaceApprovalMalformed;
    const schema = str(root, "schema") orelse return Error.InterfaceApprovalMalformed;
    if (!std.mem.eql(u8, schema, HUMAN_DECISION_SCHEMA)) return Error.InterfaceApprovalMalformed;
    const subject = str(root, "subject") orelse return Error.InterfaceApprovalMalformed;
    if (subject.len != 64) return Error.InterfaceApprovalMalformed;
    _ = digestFromHex(subject) catch return Error.InterfaceApprovalMalformed;
    const decision = str(root, "decision") orelse return Error.InterfaceApprovalMalformed;
    const approved = if (std.mem.eql(u8, decision, "approve"))
        true
    else if (std.mem.eql(u8, decision, "reject"))
        false
    else
        return Error.InterfaceApprovalMalformed;
    return .{
        .approved = approved,
        .subject_hex = subject,
        .note = str(root, "note") orelse "",
    };
}

/// Read a human's answer out of their inbox and validate it as a document. The
/// bytes returned are the human's *claim*; they remain untrusted evidence until
/// something independent validates them (§17.3 / plan §5).
fn readHumanDecision(a: Allocator, io: std.Io, manifest: *const Manifest, input: []const u8) ![]const u8 {
    const relative = try resolveTarget(a, manifest, input, types.digest(input));
    const path = try confinedPath(a, io, manifest.locator, relative, false);
    const bytes = std.Io.Dir.cwd().readFileAlloc(io, path, a, .limited(manifest.invocation.max_output_bytes + 1)) catch |err| switch (err) {
        error.StreamTooLong => return Error.InterfaceOutputTooLarge,
        // No answer yet is not a refusal and not an approval — it is simply
        // not evidence. The caller must not proceed on it.
        else => return Error.InterfaceCallFailed,
    };
    const decision = try parseHumanDecision(a, bytes);
    // An approval interaction must answer about the exact subject it was asked
    // about. Anything else is an answer to a different question.
    if (manifest.human_interaction == .approval and
        !std.mem.eql(u8, decision.subject_hex, input)) return Error.InterfaceApprovalMalformed;
    return bytes;
}

// ---------------------------------------------------------------------------
// Economic profile (Phase 5) — mechanism only
// ---------------------------------------------------------------------------
//
// Everything here decodes, bounds, and judges. Nothing here signs, holds a key,
// or knows what a wallet is: that lives behind an admitted payment adapter
// (plan §10, "keys never enter Neuron data"). The core's whole job is to decide
// whether a payment is *permitted* — the adapter's job is to produce one.

pub const Economics = enum {
    none,
    x402,

    pub fn parse(text: []const u8) ?Economics {
        return std.meta.stringToEnum(Economics, text);
    }

    pub fn name(self: Economics) []const u8 {
        return @tagName(self);
    }
};

/// A decoded 402 challenge. It is untrusted data the resource server chose, so
/// every field is validated before it can influence a spend decision.
pub const Quote = struct {
    amount_micros: u64,
    asset: []const u8,
    network: []const u8,
    pay_to: []const u8,
    resource: []const u8,
    /// Seconds of validity remaining, as declared by the resource. Zero means
    /// the quote carries no expiry and is refused: an unbounded quote could be
    /// replayed indefinitely.
    expires_in_s: u64,
    /// Digest of the exact challenge bytes. An approval is bound to this, so a
    /// human approves one quote rather than a class of them.
    quote_digest: types.Digest,

    pub fn digestHex(self: *const Quote) [64]u8 {
        return std.fmt.bytesToHex(self.quote_digest, .lower);
    }
};

/// Decode a 402 challenge. A challenge that does not decode never becomes a
/// payment — unparsed bytes cannot authorize spending.
pub fn parseQuote(a: Allocator, bytes: []const u8) !Quote {
    const root = std.json.parseFromSliceLeaky(std.json.Value, a, bytes, .{}) catch
        return Error.InterfacePaymentQuoteInvalid;
    if (root != .object) return Error.InterfacePaymentQuoteInvalid;
    const schema = str(root, "schema") orelse return Error.InterfacePaymentQuoteInvalid;
    if (!std.mem.eql(u8, schema, PAYMENT_QUOTE_SCHEMA)) return Error.InterfacePaymentQuoteInvalid;

    const amount_raw = int(root, "amount_micros") orelse return Error.InterfacePaymentQuoteInvalid;
    if (amount_raw <= 0) return Error.InterfacePaymentQuoteInvalid;
    const expires_raw = int(root, "expires_in_s") orelse return Error.InterfacePaymentQuoteInvalid;
    if (expires_raw <= 0) return Error.InterfacePaymentQuoteExpired;

    const quote: Quote = .{
        .amount_micros = @intCast(amount_raw),
        .asset = str(root, "asset") orelse return Error.InterfacePaymentQuoteInvalid,
        .network = str(root, "network") orelse return Error.InterfacePaymentQuoteInvalid,
        .pay_to = str(root, "pay_to") orelse return Error.InterfacePaymentQuoteInvalid,
        .resource = str(root, "resource") orelse return Error.InterfacePaymentQuoteInvalid,
        .expires_in_s = @intCast(expires_raw),
        .quote_digest = types.digest(bytes),
    };
    if (quote.asset.len == 0 or quote.network.len == 0 or quote.pay_to.len == 0)
        return Error.InterfacePaymentQuoteInvalid;
    return quote;
}

/// What the caller is willing to spend, and under what conditions. Declared by
/// the operator, never by the resource being paid.
pub const SpendingPolicy = struct {
    max_per_call_micros: u64,
    cumulative_budget_micros: u64,
    /// At or above this, a human must approve the exact quote. Zero means every
    /// paid call needs approval.
    approval_threshold_micros: u64,
    allowed_assets: []const []const u8,
    allowed_networks: []const []const u8,

    pub fn parse(a: Allocator, bytes: []const u8) !SpendingPolicy {
        const root = std.json.parseFromSliceLeaky(std.json.Value, a, bytes, .{}) catch
            return Error.InterfacePaymentProfileIncomplete;
        if (root != .object) return Error.InterfacePaymentProfileIncomplete;
        const schema = str(root, "schema") orelse return Error.InterfacePaymentProfileIncomplete;
        if (!std.mem.eql(u8, schema, SPENDING_POLICY_SCHEMA))
            return Error.InterfacePaymentProfileIncomplete;
        const per_call = int(root, "max_per_call_micros") orelse
            return Error.InterfacePaymentProfileIncomplete;
        const cumulative = int(root, "cumulative_budget_micros") orelse
            return Error.InterfacePaymentProfileIncomplete;
        const threshold = int(root, "approval_threshold_micros") orelse
            return Error.InterfacePaymentProfileIncomplete;
        if (per_call < 0 or cumulative < 0 or threshold < 0)
            return Error.InterfacePaymentProfileIncomplete;
        return .{
            .max_per_call_micros = @intCast(per_call),
            .cumulative_budget_micros = @intCast(cumulative),
            .approval_threshold_micros = @intCast(threshold),
            .allowed_assets = try strings(a, root, "allowed_assets"),
            .allowed_networks = try strings(a, root, "allowed_networks"),
        };
    }
};

fn listHas(haystack: []const []const u8, needle: []const u8) bool {
    for (haystack) |item| if (std.mem.eql(u8, item, needle)) return true;
    return false;
}

/// The spending governor. A pure decision over declared numbers — it performs
/// no I/O and signs nothing, so "would this be permitted" is answerable without
/// any possibility of it also being *paid*.
///
/// Returns whether a human approval is additionally required. Every refusal is
/// typed, and a refusal means the adapter is never reached at all.
pub fn governSpend(
    policy: *const SpendingPolicy,
    quote: *const Quote,
    already_spent_micros: u64,
) !bool {
    if (!listHas(policy.allowed_assets, quote.asset)) return Error.InterfacePaymentUnacceptable;
    if (!listHas(policy.allowed_networks, quote.network)) return Error.InterfacePaymentUnacceptable;
    if (quote.amount_micros > policy.max_per_call_micros) return Error.InterfacePaymentUnaffordable;
    // Saturating, so a hostile quote cannot wrap the cumulative check.
    const projected = std.math.add(u64, already_spent_micros, quote.amount_micros) catch
        return Error.InterfacePaymentUnaffordable;
    if (projected > policy.cumulative_budget_micros) return Error.InterfacePaymentUnaffordable;
    return quote.amount_micros >= policy.approval_threshold_micros;
}

/// Join a validated relative path under a canonical root and prove the result
/// is still inside it. Structural validation already forbids climbing; this
/// closes the symlink path, which no amount of string checking can.
fn confinedPath(
    a: Allocator,
    io: std.Io,
    root: []const u8,
    relative: []const u8,
    for_write: bool,
) ![]const u8 {
    const canonical = canonicalRoot(a, io, root) catch return Error.InterfaceBoundaryUnusable;
    const joined = try std.fs.path.join(a, &.{ canonical, relative });
    const cwd = std.Io.Dir.cwd();
    // Resolve the deepest existing ancestor: a symlink anywhere along the
    // chain must not land the operation outside the root.
    const probe = if (for_write) std.fs.path.dirname(joined) orelse canonical else joined;
    if (cwd.realPathFileAlloc(io, probe, a)) |resolved| {
        if (!std.mem.startsWith(u8, resolved, canonical)) return Error.InterfacePathEscape;
        if (resolved.len > canonical.len and resolved[canonical.len] != std.fs.path.sep)
            return Error.InterfacePathEscape;
    } else |_| {
        // Not yet materialized. The structural guarantee stands: the relative
        // path has no climbing component, so the join stays under the root.
        if (!for_write) return Error.InterfaceCallFailed;
    }
    return joined;
}

fn runProcess(a: Allocator, io: std.Io, manifest: *const Manifest, input: []const u8) ![]const u8 {
    var argv: std.ArrayList([]const u8) = .empty;
    for (manifest.argv_template) |element| {
        if (std.mem.eql(u8, element, "{input}")) {
            // The input is always exactly one argument. It is never split,
            // quoted, or re-parsed, so it cannot become two.
            try argv.append(a, input);
        } else {
            try argv.append(a, element);
        }
    }

    var child = std.process.spawn(io, .{
        .argv = argv.items,
        .stdin = .pipe,
        .stdout = .pipe,
        .stderr = .pipe,
    }) catch return Error.InterfaceBoundaryUnusable;
    defer child.kill(io); // reaps on timeout; no-op after a successful wait

    var stdin_buffer: [4096]u8 = undefined;
    var stdin_writer = child.stdin.?.writer(io, &stdin_buffer);
    if (manifest.input_channel == .stdin) {
        stdin_writer.interface.writeAll(input) catch return Error.InterfaceCallFailed;
        stdin_writer.interface.flush() catch return Error.InterfaceCallFailed;
    }
    child.stdin.?.close(io);
    child.stdin = null;

    const timeout: std.Io.Timeout = .{ .duration = .{
        .raw = .{ .nanoseconds = @as(i96, manifest.invocation.timeout_ms) * std.time.ns_per_ms },
        .clock = .boot,
    } };

    var mr_buffer: std.Io.File.MultiReader.Buffer(2) = undefined;
    var multi_reader: std.Io.File.MultiReader = undefined;
    multi_reader.init(a, io, mr_buffer.toStreams(), &.{ child.stdout.?, child.stderr.? });
    defer multi_reader.deinit();

    // Resource enforcement is kernel duty (§30): the boundary cannot outlive
    // its declared deadline or outgrow its declared output budget.
    while (multi_reader.fill(64, timeout)) |_| {
        if (multi_reader.reader(0).buffered().len > manifest.invocation.max_output_bytes)
            return Error.InterfaceOutputTooLarge;
    } else |err| switch (err) {
        error.EndOfStream => {},
        error.Timeout => return Error.InterfaceTimeout,
        else => return Error.InterfaceCallFailed,
    }
    multi_reader.checkAnyError() catch return Error.InterfaceCallFailed;

    const term = child.wait(io) catch return Error.InterfaceCallFailed;
    const output = multi_reader.toOwnedSlice(0) catch return Error.InterfaceCallFailed;
    if (term != .exited or term.exited != 0) return Error.InterfaceCallFailed;
    if (output.len > manifest.invocation.max_output_bytes) return Error.InterfaceOutputTooLarge;
    return output;
}

// ---------------------------------------------------------------------------
// Discovery and description — reads that confer nothing
// ---------------------------------------------------------------------------

pub const Candidate = struct {
    target: []const u8,
    kind: ?Kind,
    exists: bool,
    executable: bool,
    /// Present only when the boundary can be pinned right now.
    implementation_digest: ?types.Digest,
    note: []const u8,
};

/// Discovery is a read: it inspects a target and yields an inert candidate.
/// It writes nothing, admits nothing, and grants nothing (§17.3).
pub fn discover(a: Allocator, io: std.Io, target: []const u8) !Candidate {
    const cwd = std.Io.Dir.cwd();
    // A URL names a remote boundary. Discovery cannot pin it: a remote's
    // identity is the contract its manifest declares, which does not exist yet.
    // Reporting no digest here is the honest answer, not a gap.
    if (std.mem.startsWith(u8, target, "http://") or std.mem.startsWith(u8, target, "https://")) {
        return .{
            .target = target,
            .kind = .http,
            .exists = true,
            .executable = false,
            .implementation_digest = null,
            .note = "remote endpoint: pinned by its declared contract, not by observed bytes",
        };
    }
    // A pipeline is recognized by being one: every segment must be a known op.
    // Nothing about the string is trusted beyond that parse.
    if (canonicalPipeline(a, target)) |_| {
        return .{
            .target = target,
            .kind = .function,
            .exists = true,
            .executable = false,
            .implementation_digest = try computeImplementationDigest(a, io, .function, target),
            .note = "pure op pipeline: deterministic, total, code pinned by digest",
        };
    } else |_| {}
    const stat = cwd.statFile(io, target, .{}) catch {
        return .{
            .target = target,
            .kind = null,
            .exists = false,
            .executable = false,
            .implementation_digest = null,
            .note = "no boundary found at this locator",
        };
    };
    if (stat.kind == .directory) {
        return .{
            .target = target,
            .kind = .filesystem,
            .exists = true,
            .executable = false,
            .implementation_digest = computeImplementationDigest(a, io, .filesystem, target) catch null,
            .note = "directory: a path-scoped store boundary",
        };
    }
    const executable = if (cwd.access(io, target, .{ .execute = true })) |_| true else |_| false;
    return .{
        .target = target,
        .kind = if (executable) .process else null,
        .exists = true,
        .executable = executable,
        .implementation_digest = if (executable)
            computeImplementationDigest(a, io, .process, target) catch null
        else
            null,
        .note = if (executable)
            "executable file: a bounded argv/stdin/stdout process boundary"
        else
            "regular file: not executable; describe its directory as a store instead",
    };
}

pub const DescribeOptions = struct {
    kind: ?Kind = null,
    id: []const u8 = "",
    mode: Mode = .read,
    /// Filesystem only. Defaults per mode when empty.
    target_template: []const u8 = "",
    input_channel: ?InputChannel = null,
    /// Claim that repeated invocations reproduce one product. A pure function
    /// is deterministic by construction; for any other boundary this is the
    /// author's claim, and the admission battery makes them prove it.
    deterministic: bool = false,
    timeout_ms: u32 = 2000,
    // --- remote kinds: the contract must be declared, not discovered --------
    method: Method = .GET,
    url_template: []const u8 = "",
    response_encoding: ResponseEncoding = .raw,
    response_field: []const u8 = "",
    non_mutating: bool = false,
    reconcile_url_template: []const u8 = "",
    reconcile_encoding: ResponseEncoding = .raw,
    reconcile_field: []const u8 = "",
    tool: []const u8 = "",
    // --- Phase 4 ------------------------------------------------------------
    provider: []const u8 = "",
    model_name: []const u8 = "",
    protocol: []const u8 = "",
    cost_micros: u64 = 0,
    device_role: DeviceRole = .sensor,
    device_state_template: []const u8 = "",
    human_interaction: HumanInteraction = .approval,
    approval_interface: []const u8 = "",
    economics: Economics = .none,
    payment_adapter: []const u8 = "",
    payment_approval_interface: []const u8 = "",
    payment_response_field: []const u8 = "",
};

/// Emit a draft manifest with the boundary pinned. The draft is inert data:
/// it has no authority until an independent admission accepts its digests.
pub fn describe(a: Allocator, io: std.Io, target: []const u8, options: DescribeOptions) ![]u8 {
    const candidate = try discover(a, io, target);
    const kind = options.kind orelse candidate.kind orelse return Error.UnknownInterfaceKind;
    const id = if (options.id.len > 0) options.id else try defaultId(a, kind, target);

    const channel: InputChannel = options.input_channel orelse switch (kind) {
        .function => .stdin,
        .process => .argv,
        .filesystem => if (options.mode == .read) .argv else .stdin,
        // A remote boundary carries its input in the declared contract — the
        // URL template or the typed tool argument — not on a local channel.
        .http, .mcp, .model => .none,
        // A sensor is asked about a subject; an actuator is handed content.
        .device => if (options.device_role == .sensor) .argv else .stdin,
        // A human is asked about a subject named on the way in.
        .human => .argv,
    };
    // A model samples and a human decides: the determinism claim is refused at
    // admission, so `describe` must never author one.
    const deterministic = if (kind.nondeterministic())
        false
    else
        kind == .function or options.deterministic;
    const idempotency: Idempotency = switch (kind) {
        .function, .filesystem => .intrinsic,
        .process => .none,
        // Remote effects are keyed by the content digest carried in the
        // idempotency header, so a redelivery is the same effect.
        .http => if (options.mode == .command) .keyed else .intrinsic,
        .mcp => .none,
        .model, .human => .none,
        // An actuator addresses its state by content digest, so replaying the
        // same content lands on the same place rather than moving twice.
        .device => .intrinsic,
    };

    // A remote pin covers the declared contract, so it can only be computed
    // once the declaration is assembled. Local pins read the boundary itself.
    const digest = switch (kind) {
        .http, .mcp, .model => blk: {
            const draft: Manifest = .{
                .id = id,
                .version = "0.1.0",
                .kind = kind,
                .locator = target,
                .implementation_digest = std.mem.zeroes(types.Digest),
                .method = options.method,
                .url_template = if (options.url_template.len > 0) options.url_template else target,
                .response_encoding = options.response_encoding,
                .response_field = options.response_field,
                .non_mutating = options.non_mutating,
                .reconcile_url_template = options.reconcile_url_template,
                .reconcile_encoding = options.reconcile_encoding,
                .reconcile_field = options.reconcile_field,
                .tool = options.tool,
                .provider = options.provider,
                .model_name = options.model_name,
                .protocol = options.protocol,
                .cost_micros = options.cost_micros,
                .accepts = &.{CALL_SCHEMA},
                .emits = &.{RESULT_SCHEMA},
                .errors = &.{FAILURE_SCHEMA},
                .invocation = .{ .mode = options.mode },
                .evidence_claim = "c",
                .evidence_method = "m",
                .settlement = "s",
            };
            break :blk if (kind == .mcp)
                try mcpPin(a, io, &draft)
            else
                try contractPin(a, &draft);
        },
        else => try computeImplementationDigest(a, io, kind, target),
    };
    const hex = std.fmt.bytesToHex(digest, .lower);

    var root: std.json.ObjectMap = .empty;
    try root.put(a, "schema", .{ .string = MANIFEST_SCHEMA });
    try root.put(a, "id", .{ .string = id });
    try root.put(a, "implementation_digest", .{ .string = try a.dupe(u8, &hex) });
    try root.put(a, "version", .{ .string = "0.1.0" });
    try root.put(a, "kind", .{ .string = kind.name() });
    try root.put(a, "locator", .{ .string = if (kind == .function)
        try canonicalPipeline(a, target)
    else
        target });
    try root.put(a, "input_channel", .{ .string = channel.name() });
    if (kind == .process) {
        var argv = std.json.Array.init(a);
        try argv.append(.{ .string = target });
        if (channel == .argv) try argv.append(.{ .string = "{input}" });
        try root.put(a, "argv_template", .{ .array = argv });
    }
    if (kind == .mcp) {
        var argv = std.json.Array.init(a);
        try argv.append(.{ .string = target });
        try root.put(a, "argv_template", .{ .array = argv });
        try root.put(a, "tool", .{ .string = options.tool });
    }
    if (kind == .filesystem) {
        const template = if (options.target_template.len > 0)
            options.target_template
        else if (options.mode == .read) "{input}" else "{digest}";
        try root.put(a, "target_template", .{ .string = template });
    }
    if (kind == .http) {
        const url = if (options.url_template.len > 0) options.url_template else target;
        try root.put(a, "method", .{ .string = options.method.name() });
        try root.put(a, "url_template", .{ .string = url });
        try root.put(a, "non_mutating", .{ .bool = options.non_mutating });
        if (options.reconcile_url_template.len > 0) {
            try root.put(a, "reconcile_url_template", .{ .string = options.reconcile_url_template });
            try root.put(a, "reconcile_encoding", .{ .string = options.reconcile_encoding.name() });
            if (options.reconcile_field.len > 0)
                try root.put(a, "reconcile_field", .{ .string = options.reconcile_field });
        }
    }
    if (kind == .model) {
        const url = if (options.url_template.len > 0) options.url_template else target;
        try root.put(a, "method", .{ .string = options.method.name() });
        try root.put(a, "url_template", .{ .string = url });
        try root.put(a, "non_mutating", .{ .bool = options.non_mutating });
        // Provenance for an answer nobody can reproduce.
        try root.put(a, "provider", .{ .string = options.provider });
        try root.put(a, "model_name", .{ .string = options.model_name });
        try root.put(a, "protocol", .{ .string = options.protocol });
        try root.put(a, "cost_micros", .{ .integer = @intCast(options.cost_micros) });
    }
    if (kind == .device) {
        const template = if (options.device_state_template.len > 0)
            options.device_state_template
        else if (options.device_role == .sensor) "{input}" else "{digest}";
        try root.put(a, "device_role", .{ .string = options.device_role.name() });
        try root.put(a, "device_state_template", .{ .string = template });
        if (options.device_role == .actuator)
            try root.put(a, "approval_interface", .{ .string = options.approval_interface });
    }
    if (kind == .human) {
        const template = if (options.target_template.len > 0) options.target_template else "{input}.json";
        try root.put(a, "target_template", .{ .string = template });
        try root.put(a, "human_interaction", .{ .string = options.human_interaction.name() });
    }
    if (options.economics != .none) {
        try root.put(a, "economics", .{ .string = options.economics.name() });
        try root.put(a, "payment_adapter", .{ .string = options.payment_adapter });
        try root.put(a, "payment_approval_interface", .{ .string = options.payment_approval_interface });
        if (options.payment_response_field.len > 0)
            try root.put(a, "payment_response_field", .{ .string = options.payment_response_field });
    }
    if (kind == .http or kind == .mcp or kind == .model) {
        try root.put(a, "response_encoding", .{ .string = options.response_encoding.name() });
        if (options.response_field.len > 0)
            try root.put(a, "response_field", .{ .string = options.response_field });
    }
    try root.put(a, "accepts", try jsonStrings(a, &.{CALL_SCHEMA}));
    try root.put(a, "emits", try jsonStrings(a, &.{RESULT_SCHEMA}));
    try root.put(a, "errors", try jsonStrings(a, &.{FAILURE_SCHEMA}));

    var invocation: std.json.ObjectMap = .empty;
    try invocation.put(a, "mode", .{ .string = options.mode.name() });
    try invocation.put(a, "streaming", .{ .bool = false });
    try invocation.put(a, "deterministic", .{ .bool = deterministic });
    try invocation.put(a, "idempotency", .{ .string = idempotency.name() });
    try invocation.put(a, "timeout_ms", .{ .integer = options.timeout_ms });
    try invocation.put(a, "max_output_bytes", .{ .integer = 64 * 1024 });
    try root.put(a, "invocation", .{ .object = invocation });

    var caps: std.json.ObjectMap = .empty;
    try caps.put(a, "allow_write", .{ .bool = true });
    try caps.put(a, "write_prefix", .{ .string = "agents/" });
    try caps.put(a, "allow_send", .{ .bool = options.mode == .command });
    try caps.put(a, "send_prefix", .{ .string = if (options.mode == .command) "outbox/interface/" else "" });
    try root.put(a, "requested_caps", .{ .object = caps });

    var flow: std.json.ObjectMap = .empty;
    try flow.put(a, "input_classes", try jsonStrings(a, &.{"public"}));
    try flow.put(a, "output_classes", try jsonStrings(a, &.{"public"}));
    try root.put(a, "data_flow", .{ .object = flow });

    try root.put(a, "evidence_claim", .{ .string = try std.fmt.allocPrint(
        a,
        "output produced by the pinned {s} boundary {s}",
        .{ kind.name(), id },
    ) });
    try root.put(a, "evidence_method", .{ .string = try std.fmt.allocPrint(
        a,
        "interface-{s}-{s}",
        .{ kind.name(), options.mode.name() },
    ) });
    try root.put(a, "settlement", .{
        .string = if (deterministic)
            "result digest independently recomputed by a second invocation"
        else if (options.mode == .command)
            "external state independently read back and compared by content digest"
        else if (kind.nondeterministic())
            // Naming it here keeps the untrusted status in the durable record
            // rather than only in the code that happens to read it.
            "untrusted evidence: a resampled answer cannot corroborate itself, so it settles only against the caller's declared acceptance predicate"
        else
            "result checked against the caller's declared acceptance predicate",
    });

    return std.json.Stringify.valueAlloc(a, std.json.Value{ .object = root }, .{ .whitespace = .indent_2 });
}

fn defaultId(a: Allocator, kind: Kind, target: []const u8) ![]const u8 {
    const base = std.fs.path.basename(target);
    const cleaned = if (base.len == 0) "boundary" else base;
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(a, kind.name());
    try out.append(a, '/');
    for (cleaned) |byte| {
        try out.append(a, if (std.ascii.isAlphanumeric(byte) or byte == '-' or byte == '.')
            std.ascii.toLower(byte)
        else
            '-');
    }
    return out.toOwnedSlice(a);
}

// ---------------------------------------------------------------------------
// Acceptance predicates: the caller's explicit definition of "solved"
// ---------------------------------------------------------------------------

pub const Acceptance = struct {
    pub const Predicate = enum { nonempty, digest_equals, contains, max_bytes };

    kind: Predicate,
    value: []const u8 = "",
    limit: usize = 0,

    pub fn parse(a: Allocator, bytes: []const u8) !Acceptance {
        const root = std.json.parseFromSliceLeaky(std.json.Value, a, bytes, .{}) catch
            return Error.InvalidAcceptancePredicate;
        if (root != .object) return Error.InvalidAcceptancePredicate;
        const schema = str(root, "schema") orelse return Error.InvalidAcceptancePredicate;
        if (!std.mem.eql(u8, schema, ACCEPTANCE_SCHEMA)) return Error.InvalidAcceptancePredicate;
        const kind_text = str(root, "kind") orelse return Error.InvalidAcceptancePredicate;
        const kind = std.meta.stringToEnum(Predicate, kind_text) orelse
            return Error.InvalidAcceptancePredicate;
        var predicate: Acceptance = .{ .kind = kind };
        switch (kind) {
            .nonempty => {},
            .digest_equals, .contains => {
                predicate.value = str(root, "value") orelse return Error.InvalidAcceptancePredicate;
                if (predicate.value.len == 0) return Error.InvalidAcceptancePredicate;
                if (kind == .digest_equals and predicate.value.len != 64)
                    return Error.InvalidAcceptancePredicate;
            },
            .max_bytes => {
                const raw = int(root, "limit") orelse return Error.InvalidAcceptancePredicate;
                if (raw <= 0) return Error.InvalidAcceptancePredicate;
                predicate.limit = @intCast(raw);
            },
        }
        return predicate;
    }

    /// Judged against the real output bytes, never against a status field the
    /// producer chose for itself.
    pub fn holds(self: *const Acceptance, output: []const u8) bool {
        return switch (self.kind) {
            .nonempty => output.len > 0,
            .digest_equals => blk: {
                const hex = std.fmt.bytesToHex(types.digest(output), .lower);
                break :blk std.mem.eql(u8, &hex, self.value);
            },
            .contains => std.mem.indexOf(u8, output, self.value) != null,
            .max_bytes => output.len <= self.limit,
        };
    }
};

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

fn str(value: std.json.Value, key: []const u8) ?[]const u8 {
    if (value != .object) return null;
    const field = value.object.get(key) orelse return null;
    return switch (field) {
        .string => |text| text,
        else => null,
    };
}

fn int(value: std.json.Value, key: []const u8) ?i64 {
    if (value != .object) return null;
    const field = value.object.get(key) orelse return null;
    return switch (field) {
        .integer => |number| number,
        else => null,
    };
}

fn boolean(value: std.json.Value, key: []const u8, default: bool) bool {
    if (value != .object) return default;
    const field = value.object.get(key) orelse return default;
    return switch (field) {
        .bool => |flag| flag,
        else => default,
    };
}

fn strings(a: Allocator, value: std.json.Value, key: []const u8) ![]const []const u8 {
    if (value != .object) return &.{};
    const field = value.object.get(key) orelse return &.{};
    return stringArray(a, field);
}

fn stringArray(a: Allocator, value: std.json.Value) ![]const []const u8 {
    if (value != .array) return Error.InvalidInterfaceManifest;
    var list: std.ArrayList([]const u8) = .empty;
    for (value.array.items) |item| {
        if (item != .string) return Error.InvalidInterfaceManifest;
        try list.append(a, item.string);
    }
    return list.toOwnedSlice(a);
}

fn jsonStrings(a: Allocator, values: []const []const u8) !std.json.Value {
    var array = std.json.Array.init(a);
    for (values) |value| try array.append(.{ .string = value });
    return .{ .array = array };
}

fn capsFromJson(value: std.json.Value) !caps_mod.Caps {
    if (value != .object) return Error.InvalidInterfaceManifest;
    var caps: caps_mod.Caps = .{
        .allow_write = boolean(value, "allow_write", false),
        .allow_send = boolean(value, "allow_send", false),
        .allow_spawn = boolean(value, "allow_spawn", false),
        .write_prefix = str(value, "write_prefix") orelse "",
        .send_prefix = str(value, "send_prefix") orelse "",
        .spawn_prefix = str(value, "spawn_prefix") orelse "",
        // An unstated budget is the ceiling, not the permissive global default.
        .budget = CAPS_CEILING.budget,
    };
    if (value.object.get("budget")) |budget| {
        if (budget != .object) return Error.InvalidInterfaceManifest;
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

fn digestFromHex(hex: []const u8) !types.Digest {
    if (hex.len != 64) return error.InvalidDigest;
    var digest: types.Digest = undefined;
    _ = try std.fmt.hexToBytes(&digest, hex);
    return digest;
}

fn safeId(id: []const u8) bool {
    if (id.len == 0 or id.len > 128) return false;
    for (id) |byte| {
        const ok = std.ascii.isAlphanumeric(byte) or byte == '-' or byte == '_' or
            byte == '.' or byte == '/';
        if (!ok) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;

fn testManifest(a: Allocator, overrides: []const u8) ![]u8 {
    return std.fmt.allocPrint(a,
        \\{{"schema":"neuron.interface-manifest/v1","id":"text/hash","version":"1.0.0",
        \\"kind":"function","locator":"trim|sha256","implementation_digest":"{s}",
        \\"input_channel":"stdin","accepts":["neuron.interface-call/v1"],
        \\"emits":["neuron.interface-result/v1"],"errors":["neuron.interface-failure/v1"],
        \\"invocation":{{"mode":"read","deterministic":true,"idempotency":"intrinsic",
        \\"timeout_ms":1000,"max_output_bytes":4096}},
        \\"evidence_claim":"c","evidence_method":"m","settlement":"s"{s}}}
    , .{ &pipelineHex(), overrides });
}

fn pipelineHex() [64]u8 {
    var hasher = Sha256.init(.{});
    hasher.update(FUNCTION_DOMAIN);
    hasher.update("trim|sha256");
    var digest: types.Digest = undefined;
    hasher.final(&digest);
    return std.fmt.bytesToHex(digest, .lower);
}

test "a pure-function manifest parses, pins its code, and invokes deterministically" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const bytes = try testManifest(a, "");
    const manifest = try parseManifest(a, bytes);
    try testing.expectEqual(Kind.function, manifest.kind);
    try testing.expectEqual(Mode.read, manifest.invocation.mode);

    // The pipeline text is the code, so the pinned digest must match it.
    try verifyImplementation(a, testing.io, &manifest);

    const outcome = try invokeRead(a, testing.io, &manifest, "  hello  ");
    const expected = std.fmt.bytesToHex(types.digest("hello"), .lower);
    try testing.expectEqualStrings(&expected, outcome.output);

    // Same input, same output: a second invocation is the verifier's evidence.
    const again = try invokeRead(a, testing.io, &manifest, "  hello  ");
    try testing.expect(std.mem.eql(u8, &outcome.output_digest, &again.output_digest));
}

test "an untyped or unknown boundary is never admissible" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const untyped = try std.fmt.allocPrint(a,
        \\{{"schema":"neuron.interface-manifest/v1","id":"x","version":"1","kind":"function",
        \\"locator":"trim","implementation_digest":"{s}","accepts":[],"emits":[],"errors":[],
        \\"invocation":{{"mode":"read"}},"evidence_claim":"c","evidence_method":"m","settlement":"s"}}
    , .{&pipelineHex()});
    try testing.expectError(Error.UntypedInterface, parseManifest(a, untyped));

    const unknown = try std.fmt.allocPrint(a,
        \\{{"schema":"neuron.interface-manifest/v1","id":"x","version":"1","kind":"quantum",
        \\"locator":"t","implementation_digest":"{s}","accepts":["a"],"emits":["b"],"errors":["c"],
        \\"invocation":{{"mode":"read"}},"evidence_claim":"c","evidence_method":"m","settlement":"s"}}
    , .{&pipelineHex()});
    try testing.expectError(Error.UnknownInterfaceKind, parseManifest(a, unknown));
}

test "mode classification never fails open" {
    try testing.expectEqual(Mode.command, Mode.parse("duplex"));
    try testing.expectEqual(Mode.command, Mode.parse(""));
    try testing.expectEqual(Mode.command, Mode.parse("READ"));
    try testing.expectEqual(Mode.read, Mode.parse("read"));
}

test "argv templates reject smuggled arguments and locator mismatch" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const base =
        \\{{"schema":"neuron.interface-manifest/v1","id":"p/x","version":"1","kind":"process",
        \\"locator":"/bin/echo","implementation_digest":"{s}","input_channel":"argv",
        \\"argv_template":{s},"accepts":["a"],"emits":["b"],"errors":["c"],
        \\"invocation":{{"mode":"read","timeout_ms":500,"max_output_bytes":4096}},
        \\"evidence_claim":"c","evidence_method":"m","settlement":"s"}}
    ;
    // `{input}` inside a larger argument is the injection shape.
    const smuggled = try std.fmt.allocPrint(a, base, .{ &pipelineHex(), "[\"/bin/echo\",\"cat {input}\"]" });
    try testing.expectError(Error.ArgvTemplateInjection, parseManifest(a, smuggled));

    // argv[0] must be the pinned executable, not a different program.
    const mismatch = try std.fmt.allocPrint(a, base, .{ &pipelineHex(), "[\"/bin/sh\",\"{input}\"]" });
    try testing.expectError(Error.ArgvLocatorMismatch, parseManifest(a, mismatch));

    // A declared argv channel with no placeholder cannot receive its input.
    const missing = try std.fmt.allocPrint(a, base, .{ &pipelineHex(), "[\"/bin/echo\"]" });
    try testing.expectError(Error.InterfaceInputChannelMismatch, parseManifest(a, missing));
}

test "relative paths cannot climb, absolutize, or hide control bytes" {
    try testing.expectError(Error.InterfacePathEscape, validateRelative("../escape"));
    try testing.expectError(Error.InterfacePathEscape, validateRelative("/etc/passwd"));
    try testing.expectError(Error.InterfacePathEscape, validateRelative("a//b"));
    try testing.expectError(Error.InterfacePathEscape, validateRelative("a/./b"));
    try testing.expectError(Error.InterfacePathEscape, validateRelative("a/\x00b"));
    try testing.expectError(Error.InterfacePathEscape, validateRelative(""));
    try validateRelative("out/result.txt");
}

test "a traversal smuggled through the input dies after substitution" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const manifest: Manifest = .{
        .id = "fs/read",
        .version = "1",
        .kind = .filesystem,
        .locator = "/tmp",
        .implementation_digest = std.mem.zeroes(types.Digest),
        .target_template = "{input}",
        .input_channel = .argv,
        .accepts = &.{"a"},
        .emits = &.{"b"},
        .errors = &.{"c"},
        .invocation = .{ .mode = .read },
        .evidence_claim = "c",
        .evidence_method = "m",
        .settlement = "s",
    };
    try testing.expectError(
        Error.InterfacePathEscape,
        resolveTarget(a, &manifest, "../../etc/passwd", std.mem.zeroes(types.Digest)),
    );
    const ok = try resolveTarget(a, &manifest, "notes/today.txt", std.mem.zeroes(types.Digest));
    try testing.expectEqualStrings("notes/today.txt", ok);
}

test "an unverifiable command is refused at parse time" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    // A process mutation has no independent local sensor in Phase 2.
    const process_command = try std.fmt.allocPrint(a,
        \\{{"schema":"neuron.interface-manifest/v1","id":"p/x","version":"1","kind":"process",
        \\"locator":"/bin/echo","implementation_digest":"{s}","input_channel":"stdin",
        \\"argv_template":["/bin/echo"],"accepts":["a"],"emits":["b"],"errors":["c"],
        \\"invocation":{{"mode":"command","idempotency":"intrinsic"}},
        \\"requested_caps":{{"allow_send":true,"send_prefix":"outbox/"}},
        \\"evidence_claim":"c","evidence_method":"m","settlement":"s"}}
    , .{&pipelineHex()});
    try testing.expectError(Error.UnverifiableCommand, parseManifest(a, process_command));

    // A filesystem command that is not content-addressed cannot be replayed
    // safely or read back by identity.
    const unaddressed = try std.fmt.allocPrint(a,
        \\{{"schema":"neuron.interface-manifest/v1","id":"fs/x","version":"1","kind":"filesystem",
        \\"locator":"/tmp","implementation_digest":"{s}","input_channel":"stdin",
        \\"target_template":"fixed.txt","accepts":["a"],"emits":["b"],"errors":["c"],
        \\"invocation":{{"mode":"command","idempotency":"intrinsic"}},
        \\"requested_caps":{{"allow_send":true,"send_prefix":"outbox/"}},
        \\"evidence_claim":"c","evidence_method":"m","settlement":"s"}}
    , .{&pipelineHex()});
    try testing.expectError(Error.UnverifiableCommand, parseManifest(a, unaddressed));
}

test "a command manifest cannot be invoked on the read path" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const manifest: Manifest = .{
        .id = "fs/write",
        .version = "1",
        .kind = .filesystem,
        .locator = "/tmp",
        .implementation_digest = std.mem.zeroes(types.Digest),
        .target_template = "{digest}",
        .input_channel = .stdin,
        .accepts = &.{"a"},
        .emits = &.{"b"},
        .errors = &.{"c"},
        .invocation = .{ .mode = .command, .idempotency = .intrinsic },
        .evidence_claim = "c",
        .evidence_method = "m",
        .settlement = "s",
    };
    try testing.expectError(Error.InterfaceModeMismatch, invokeRead(a, testing.io, &manifest, "x"));
}

test "acceptance predicates judge the real output bytes" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const nonempty = try Acceptance.parse(a,
        \\{"schema":"neuron.acceptance-predicate/v1","kind":"nonempty"}
    );
    try testing.expect(nonempty.holds("x"));
    try testing.expect(!nonempty.holds(""));

    const hex = std.fmt.bytesToHex(types.digest("payload"), .lower);
    const exact = try Acceptance.parse(a, try std.fmt.allocPrint(a,
        \\{{"schema":"neuron.acceptance-predicate/v1","kind":"digest_equals","value":"{s}"}}
    , .{&hex}));
    try testing.expect(exact.holds("payload"));
    try testing.expect(!exact.holds("payloads"));

    try testing.expectError(Error.InvalidAcceptancePredicate, Acceptance.parse(a,
        \\{"schema":"neuron.acceptance-predicate/v1","kind":"telepathy"}
    ));
}

test "the op vocabulary is total and canonical" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    try testing.expectEqualStrings("trim|upper", try canonicalPipeline(a, " trim | upper "));
    try testing.expectError(Error.UnknownFunctionOp, canonicalPipeline(a, "trim|exec"));
    try testing.expectEqualStrings("A B", try evalPipeline(a, "collapse-ws|upper", "  a   b \n"));
    try testing.expectEqualStrings("2", try evalPipeline(a, "words", "one two"));
    try testing.expectEqualStrings("a\nb", try evalPipeline(a, "unique-lines", "a\nb\na"));
}
