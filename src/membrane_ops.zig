//! Interface membrane lifecycle against a durable node substrate
//! (§17.3 / entrypoint plan Phase 2):
//!
//!   discover → describe → test → admit → attach → operate → judge → detach
//!
//! Every verb here is an ordinary Neuron firing through the same Runtime valve
//! and WAL as any limb. Discovery and description write nothing at all;
//! admission is the only step that turns a described boundary into a callable
//! one, and it refuses any manifest whose own adversarial battery fails.
//!
//! The read/command split is enforced at two levels. `membrane.zig` refuses to
//! invoke a command on the read path; this module never dispatches a command
//! except from a committed outbox record, and settles it only after
//! independent read-back reconciliation.

const std = @import("std");
const types = @import("types.zig");
const caps_mod = @import("caps.zig");
const substrate_mod = @import("substrate.zig");
const runtime_mod = @import("runtime.zig");
const delivery_mod = @import("delivery.zig");
const membrane = @import("membrane.zig");
const morphogenesis = @import("morphogenesis.zig");

const Allocator = std.mem.Allocator;

pub const ADMITTED_PREFIX = "interfaces/admitted/";
pub const REVOKED_PREFIX = "interfaces/revoked/";
pub const PENDING_PREFIX = "interfaces/pending/";
pub const RECEIPT_PREFIX = "interfaces/receipts/";
pub const OUTBOX_PREFIX = "outbox/interface/";
pub const PAYMENT_PREFIX = "interfaces/payments/";
/// The operator's spending policy. A durable node artifact, so the boundary
/// being paid can never declare what it is allowed to charge.
pub const POLICY_ID = "interfaces/policy/spending";

pub const PROBE_INPUT = "neuron-interface-probe";

pub const Error = error{
    InterfaceNotAdmitted,
    InterfaceRevoked,
    InterfaceNotAttached,
    /// Another interface already holds this role on this agent.
    InterfaceRoleOccupied,
    /// The manifest asks for more authority than any interface may hold.
    InterfaceCapsWidened,
    /// The adversarial battery rejected this manifest.
    InterfaceTestsFailed,
    CorruptInterfaceRecord,
};

/// The hard ceiling on what *any* interface may request, independent of which
/// agent later attaches it. An adapter cannot widen its caller's authority
/// (invariant 6), so this is where an over-reaching manifest dies — before
/// admission, not at call time.
pub fn ceiling() caps_mod.Caps {
    return membrane.CAPS_CEILING;
}

/// The grant an attachment actually confers. The manifest declares which
/// *classes* of authority it needs; the harness picks the exact namespace, so a
/// manifest can never name its own write target.
pub fn grantFor(a: Allocator, agent: []const u8, requested: caps_mod.Caps) !caps_mod.Caps {
    const limit = ceiling();
    return .{
        .allow_write = requested.allow_write,
        .write_prefix = try std.fmt.allocPrint(a, "agents/{s}/work/", .{agent}),
        .allow_send = requested.allow_send,
        .send_prefix = OUTBOX_PREFIX,
        .allow_spawn = false,
        .spawn_prefix = "",
        .budget = .{
            .max_effects = @min(requested.budget.max_effects, limit.budget.max_effects),
            .max_writes = @min(requested.budget.max_writes, limit.budget.max_writes),
            .max_messages = @min(requested.budget.max_messages, limit.budget.max_messages),
            .max_spawns = 0,
            .max_bytes = @min(requested.budget.max_bytes, limit.budget.max_bytes),
            .max_depth = @min(requested.budget.max_depth, limit.budget.max_depth),
            .max_turns = @min(requested.budget.max_turns, limit.budget.max_turns),
        },
    };
}

// ---------------------------------------------------------------------------
// The adversarial battery
// ---------------------------------------------------------------------------

pub const Check = struct {
    name: []const u8,
    ok: bool,
    detail: []const u8,
};

/// Contract and adversarial tests, run in a sandbox before admission (§29.5).
/// A boundary that compiles, resolves, or merely exists has proven nothing;
/// these are the claims that must hold before it can be called.
pub fn runBattery(a: Allocator, io: std.Io, manifest: *const membrane.Manifest) ![]Check {
    var checks: std.ArrayList(Check) = .empty;

    try checks.append(a, .{
        .name = "manifest-typed",
        .ok = true,
        .detail = try std.fmt.allocPrint(a, "{s} · kind={s} · mode={s}", .{
            manifest.id,
            manifest.kind.name(),
            manifest.invocation.mode.name(),
        }),
    });

    // 1. The live boundary must still hash to the pinned implementation.
    if (membrane.verifyImplementation(a, io, manifest)) |_| {
        try checks.append(a, .{
            .name = "implementation-pinned",
            .ok = true,
            .detail = try a.dupe(u8, &manifest.implementationHex()),
        });
    } else |err| {
        try checks.append(a, .{
            .name = "implementation-pinned",
            .ok = false,
            .detail = @errorName(err),
        });
    }

    // 2. Least authority: the request must fit inside the global ceiling.
    const within = caps_mod.allowsDelegation(ceiling(), manifest.requested_caps);
    try checks.append(a, .{
        .name = "caps-least-authority",
        .ok = within,
        .detail = if (within)
            "requested caps are inside the interface ceiling"
        else
            "requested caps exceed the interface ceiling",
    });

    // 3. Classification is structural: a command must be unreachable through
    //    the read path, whatever the manifest calls itself.
    switch (manifest.invocation.mode) {
        .command => {
            const refused = if (membrane.invokeRead(a, io, manifest, PROBE_INPUT)) |_|
                false
            else |err|
                err == membrane.Error.InterfaceModeMismatch;
            try checks.append(a, .{
                .name = "command-cannot-read",
                .ok = refused,
                .detail = if (refused)
                    "read path refuses this command; consequence requires the outbox"
                else
                    "command was invocable as a read",
            });
        },
        .read => {
            // A read is exercised for real. Filesystem reads are probed
            // structurally instead: a probe path that does not exist is not a
            // defect in the interface.
            // A device sensor and a human inbox are addressed like a filesystem
            // read: the probe subject legitimately does not exist yet, so they
            // are probed structurally for confinement rather than by a call
            // whose absence would be misread as a defect.
            if (manifest.kind == .filesystem or manifest.kind == .device or manifest.kind == .human) {
                const escaped = if (manifest.kind == .device)
                    membrane.resolveDeviceState(a, manifest, "../escape", std.mem.zeroes(types.Digest))
                else
                    membrane.resolveTarget(a, manifest, "../escape", std.mem.zeroes(types.Digest));
                const confined = if (escaped) |_| false else |err| err == membrane.Error.InterfacePathEscape;
                try checks.append(a, .{
                    .name = "path-confinement",
                    .ok = confined,
                    .detail = if (confined)
                        "a traversal in the input is rejected after substitution"
                    else
                        "a traversal in the input resolved to a path",
                });
            } else if (membrane.invokeRead(a, io, manifest, PROBE_INPUT)) |outcome| {
                try checks.append(a, .{
                    .name = "probe-invocation",
                    .ok = true,
                    .detail = try std.fmt.allocPrint(a, "{d} bytes, digest {s}", .{
                        outcome.output.len,
                        std.fmt.bytesToHex(outcome.output_digest, .lower)[0..16],
                    }),
                });
            } else |err| {
                // A resource with an economic profile answering `402` to an
                // unpaid probe is behaving correctly, not failing. Treating the
                // challenge as a defect would make every paid boundary
                // inadmissible — and admission must not require paying.
                const challenged = err == membrane.Error.InterfacePaymentRequired and
                    manifest.economics != .none;
                try checks.append(a, .{
                    .name = if (challenged) "payment-challenged" else "probe-invocation",
                    .ok = challenged,
                    .detail = if (challenged)
                        "the boundary demanded payment for an unpaid probe; nothing was signed"
                    else
                        @errorName(err),
                });
            }
        },
    }

    // 4. A declared deterministic boundary must actually be one. Two
    //    invocations, one comparison — the same evidence the agent's verifier
    //    will later rely on.
    if (manifest.invocation.deterministic and manifest.kind != .filesystem) {
        const first = membrane.invokeRead(a, io, manifest, PROBE_INPUT) catch null;
        const second = membrane.invokeRead(a, io, manifest, PROBE_INPUT) catch null;
        const stable = first != null and second != null and
            std.mem.eql(u8, &first.?.output_digest, &second.?.output_digest);
        try checks.append(a, .{
            .name = "determinism",
            .ok = stable,
            .detail = if (stable)
                "two invocations produced one content identity"
            else
                "declared deterministic but two invocations disagreed",
        });
    }

    // 5. Process boundaries: the input is one whole argument, never a
    //    fragment another layer could re-split.
    if (manifest.kind == .process) {
        var whole = true;
        for (manifest.argv_template) |element| {
            if (std.mem.eql(u8, element, "{input}")) continue;
            if (std.mem.indexOf(u8, element, "{input}") != null) whole = false;
        }
        try checks.append(a, .{
            .name = "argv-whole-element",
            .ok = whole,
            .detail = if (whole)
                "input occupies exactly one argv element; no shell is involved"
            else
                "input is embedded inside a larger argument",
        });
    }

    // 5b. Phase 4: a boundary that samples or decides is recorded as untrusted
    //     evidence, and it must carry the provenance that makes its answer
    //     attributable to something.
    if (manifest.kind.nondeterministic()) {
        const traced = !manifest.invocation.deterministic and switch (manifest.kind) {
            .model => manifest.provider.len > 0 and manifest.model_name.len > 0 and
                manifest.protocol.len > 0,
            else => true,
        };
        try checks.append(a, .{
            .name = "nondeterministic-untrusted",
            .ok = traced,
            .detail = if (manifest.kind == .model)
                try std.fmt.allocPrint(a, "untrusted until validated · provider={s} model={s} protocol={s} cost_micros={d}", .{
                    manifest.provider,
                    manifest.model_name,
                    manifest.protocol,
                    manifest.cost_micros,
                })
            else
                try std.fmt.allocPrint(a, "untrusted until validated · interaction={s}", .{
                    manifest.human_interaction.name(),
                }),
        });
    }

    // 5c. Phase 4: an actuator names the human approval boundary that gates it,
    //     and that gate must really be one.
    if (manifest.kind == .device and manifest.device_role == .actuator) {
        const gated = manifest.approval_interface.len == 64;
        try checks.append(a, .{
            .name = "actuator-safety-gate",
            .ok = gated,
            .detail = if (gated)
                try std.fmt.allocPrint(a, "gated by human approval interface {s}", .{manifest.approval_interface})
            else
                "actuator declares no human approval interface",
        });
    }

    // 6. Every call carries a deadline and an output ceiling.
    const bounded = manifest.invocation.timeout_ms > 0 and
        manifest.invocation.timeout_ms <= membrane.MAX_TIMEOUT_MS and
        manifest.invocation.max_output_bytes > 0 and
        manifest.invocation.max_output_bytes <= membrane.MAX_OUTPUT_BYTES;
    try checks.append(a, .{
        .name = "budget-bounded",
        .ok = bounded,
        .detail = try std.fmt.allocPrint(a, "timeout={d}ms max_output={d}B", .{
            manifest.invocation.timeout_ms,
            manifest.invocation.max_output_bytes,
        }),
    });

    return checks.toOwnedSlice(a);
}

pub fn batteryPassed(checks: []const Check) bool {
    for (checks) |check| {
        if (!check.ok) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Admission and revocation
// ---------------------------------------------------------------------------

const admission_sources = [_][]const u8{"stimulus"};

fn evidence(a: Allocator, claim: []const u8, method: []const u8) ![]types.Evidence {
    const items = try a.alloc(types.Evidence, 1);
    items[0] = .{ .claim = claim, .sources = &admission_sources, .method = method };
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

pub const AdmitResult = struct {
    manifest_digest: [64]u8,
    implementation_digest: [64]u8,
    id: []const u8,
    kind: membrane.Kind,
    mode: membrane.Mode,
    created: bool,
    checks: []const Check,
};

/// Admission is the authority boundary: it re-pins the implementation, runs
/// the battery itself rather than trusting a prior `interface test` run, and
/// publishes an immutable record naming the exact manifest and implementation
/// digests. A described boundary has no authority until this succeeds.
pub fn admitCore(
    a: Allocator,
    io: std.Io,
    substrate: *substrate_mod.Substrate,
    manifest_bytes: []const u8,
) !AdmitResult {
    const manifest = try membrane.parseManifest(a, manifest_bytes);
    if (!caps_mod.allowsDelegation(ceiling(), manifest.requested_caps))
        return Error.InterfaceCapsWidened;

    const checks = try runBattery(a, io, &manifest);
    if (!batteryPassed(checks)) return Error.InterfaceTestsFailed;

    const manifest_hex = manifest.manifestHex();
    const implementation_hex = manifest.implementationHex();
    const record = try std.json.Stringify.valueAlloc(a, .{
        .schema = membrane.ADMISSION_SCHEMA,
        .id = manifest.id,
        .version = manifest.version,
        .kind = manifest.kind.name(),
        .mode = manifest.invocation.mode.name(),
        .deterministic = manifest.invocation.deterministic,
        .idempotency = manifest.invocation.idempotency.name(),
        .manifest_digest = manifest_hex[0..],
        .implementation_digest = implementation_hex[0..],
        .manifest = manifest_bytes,
    }, .{});

    const record_id = try std.fmt.allocPrint(a, ADMITTED_PREFIX ++ "{s}", .{&manifest_hex});
    const firing_id = try std.fmt.allocPrint(a, "interface/admission/{s}", .{&manifest_hex});
    var fx = [_]types.Effect{
        .{ .write = .{ .id = record_id, .schema = membrane.ADMISSION_SCHEMA, .bytes = record } },
        .{ .send = .{
            .to = "event/neuron.interface-admission/v1",
            .schema = membrane.ADMISSION_SCHEMA,
            .payload = record,
            .durable = true,
        } },
    };
    const runtime: runtime_mod.Runtime = .{ .substrate = substrate };
    const result = runtime.execute(.{
        .firing_id = firing_id,
        .receptor_schema = membrane.ADMISSION_SCHEMA,
    }, harnessCaps(ADMITTED_PREFIX), .{
        .control = .{ .terminate = "admitted" },
        .effects = &fx,
        .evidence = try evidence(
            a,
            "manifest validated, implementation re-pinned, and adversarial battery passed",
            "interface admission (§29/§17.3)",
        ),
    }) catch |err| switch (err) {
        // Re-admitting the identical manifest is a no-op, not a conflict.
        error.FiringAlreadySettled, error.FiringMismatch => return .{
            .manifest_digest = manifest_hex,
            .implementation_digest = implementation_hex,
            .id = manifest.id,
            .kind = manifest.kind,
            .mode = manifest.invocation.mode,
            .created = false,
            .checks = checks,
        },
        else => return err,
    };
    return .{
        .manifest_digest = manifest_hex,
        .implementation_digest = implementation_hex,
        .id = manifest.id,
        .kind = manifest.kind,
        .mode = manifest.invocation.mode,
        .created = result.effects_committed > 0,
        .checks = checks,
    };
}

/// Revocation stops new calls before the next adapter operation (invariant
/// 14). Existing audit roots are untouched.
pub fn revokeCore(
    a: Allocator,
    substrate: *substrate_mod.Substrate,
    interface_hex: []const u8,
) !void {
    const admitted_id = try std.fmt.allocPrint(a, ADMITTED_PREFIX ++ "{s}", .{interface_hex});
    if (!substrate.artifacts.contains(admitted_id)) return Error.InterfaceNotAdmitted;
    const revoked_id = try std.fmt.allocPrint(a, REVOKED_PREFIX ++ "{s}", .{interface_hex});
    const firing_id = try std.fmt.allocPrint(a, "interface/revocation/{s}", .{interface_hex});
    var fx = [_]types.Effect{
        .{ .write = .{
            .id = revoked_id,
            .schema = "neuron.interface-revocation/v1",
            .bytes = interface_hex,
        } },
    };
    const runtime: runtime_mod.Runtime = .{ .substrate = substrate };
    _ = runtime.execute(.{
        .firing_id = firing_id,
        .receptor_schema = "neuron.interface-revocation/v1",
    }, harnessCaps(REVOKED_PREFIX), .{
        .control = .{ .terminate = "revoked" },
        .effects = &fx,
        .evidence = try evidence(
            a,
            "admitted interface revoked; no further call may resolve it",
            "interface revocation",
        ),
    }) catch |err| switch (err) {
        error.FiringAlreadySettled, error.FiringMismatch => return,
        else => return err,
    };
}

/// Resolve an admitted, unrevoked interface into a parsed manifest. Both
/// checks happen on every path that could lead to an invocation.
pub fn resolveAdmitted(
    a: Allocator,
    substrate: *const substrate_mod.Substrate,
    interface_hex: []const u8,
) !membrane.Manifest {
    const admitted_id = try std.fmt.allocPrint(a, ADMITTED_PREFIX ++ "{s}", .{interface_hex});
    const artifact = substrate.artifacts.get(admitted_id) orelse return Error.InterfaceNotAdmitted;
    if (!std.mem.eql(u8, artifact.schema, membrane.ADMISSION_SCHEMA))
        return Error.CorruptInterfaceRecord;
    const revoked_id = try std.fmt.allocPrint(a, REVOKED_PREFIX ++ "{s}", .{interface_hex});
    if (substrate.artifacts.contains(revoked_id)) return Error.InterfaceRevoked;

    const record = std.json.parseFromSliceLeaky(std.json.Value, a, artifact.bytes, .{}) catch
        return Error.CorruptInterfaceRecord;
    if (record != .object) return Error.CorruptInterfaceRecord;
    const embedded = record.object.get("manifest") orelse return Error.CorruptInterfaceRecord;
    if (embedded != .string) return Error.CorruptInterfaceRecord;
    return membrane.parseManifest(a, embedded.string);
}

// ---------------------------------------------------------------------------
// Attachment
// ---------------------------------------------------------------------------

pub const Role = enum {
    /// Produces the result for a goal. Must be a capability read.
    worker,
    /// Carries the worker's result across a consequential boundary.
    effector,

    pub fn parse(text: []const u8) ?Role {
        return std.meta.stringToEnum(Role, text);
    }

    pub fn name(self: Role) []const u8 {
        return @tagName(self);
    }
};

/// Attachments are ordered within a role, so a role can hold a *chain* of
/// boundaries rather than a single hop. Step 0 is the first hop.
pub const MAX_CHAIN_STEPS = 8;

pub fn attachmentId(a: Allocator, agent: []const u8, role: Role, step: usize) ![]const u8 {
    return std.fmt.allocPrint(a, "agents/{s}/interfaces/{s}/{d:0>2}", .{ agent, role.name(), step });
}

pub const Attachment = struct {
    interface_hex: [64]u8,
    role: Role,
    step: usize,
    attached: bool,
};

/// Read the live attachment for one role, or null when the role was never
/// attached. A detached role resolves to `attached = false` rather than
/// disappearing: the audit outlives the edge.
pub fn liveAttachment(
    a: Allocator,
    substrate: *const substrate_mod.Substrate,
    agent: []const u8,
    role: Role,
    step: usize,
) !?Attachment {
    const id = try attachmentId(a, agent, role, step);
    const artifact = substrate.artifacts.get(id) orelse return null;
    const record = std.json.parseFromSliceLeaky(std.json.Value, a, artifact.bytes, .{}) catch
        return Error.CorruptInterfaceRecord;
    if (record != .object) return Error.CorruptInterfaceRecord;
    const interface = record.object.get("interface") orelse return Error.CorruptInterfaceRecord;
    if (interface != .string or interface.string.len != 64) return Error.CorruptInterfaceRecord;
    const status = record.object.get("status") orelse return Error.CorruptInterfaceRecord;
    if (status != .string) return Error.CorruptInterfaceRecord;

    var hex: [64]u8 = undefined;
    @memcpy(&hex, interface.string);
    return .{
        .interface_hex = hex,
        .role = role,
        .step = step,
        .attached = std.mem.eql(u8, status.string, "attached"),
    };
}

/// Every live hop of a role, in step order, stopping at the first gap. A chain
/// with a hole in it is not a chain: the ordered sequence is the topology, so
/// step 2 without step 1 would silently reorder the work.
pub fn liveChain(
    a: Allocator,
    substrate: *const substrate_mod.Substrate,
    agent: []const u8,
    role: Role,
) ![]Attachment {
    var hops: std.ArrayList(Attachment) = .empty;
    var step: usize = 0;
    while (step < MAX_CHAIN_STEPS) : (step += 1) {
        const live = (try liveAttachment(a, substrate, agent, role, step)) orelse break;
        if (!live.attached) break;
        try hops.append(a, live);
    }
    return hops.toOwnedSlice(a);
}

/// Attach an admitted interface to one agent role through a typed edge. The
/// grant is derived, never adopted: the manifest says which authority classes
/// it needs and the harness decides the exact namespace.
pub fn attachCore(
    a: Allocator,
    io: std.Io,
    substrate: *substrate_mod.Substrate,
    agent: []const u8,
    role: Role,
    step: usize,
    interface_hex: []const u8,
    replace: bool,
) !caps_mod.Caps {
    const manifest = try resolveAdmitted(a, substrate, interface_hex);
    // Drift between admission and attachment invalidates the attachment
    // (invariant 13): the edge must name a boundary that is still there.
    try membrane.verifyImplementation(a, io, &manifest);

    // Roles carry a classification contract: a worker is read-only because its
    // result is verified by recomputation; an effector is the consequential
    // slot and must cross the outbox.
    switch (role) {
        .worker => if (manifest.invocation.mode != .read) return membrane.Error.InterfaceModeMismatch,
        .effector => if (manifest.invocation.mode != .command) return membrane.Error.InterfaceModeMismatch,
    }

    if (step >= MAX_CHAIN_STEPS) return Error.InterfaceRoleOccupied;
    // A chain must be contiguous: attaching step N requires step N-1 to be live
    // already, so an ordered pipeline cannot acquire a hole.
    if (step > 0) {
        const previous = (try liveAttachment(a, substrate, agent, role, step - 1)) orelse
            return Error.InterfaceNotAttached;
        if (!previous.attached) return Error.InterfaceNotAttached;
    }
    const id = try attachmentId(a, agent, role, step);
    const prior = substrate.artifacts.get(id);
    if (prior != null and !replace) {
        if (try liveAttachment(a, substrate, agent, role, step)) |live| {
            if (live.attached and !std.mem.eql(u8, &live.interface_hex, interface_hex))
                return Error.InterfaceRoleOccupied;
        }
    }

    const granted = try grantFor(a, agent, manifest.requested_caps);
    const record = try std.json.Stringify.valueAlloc(a, .{
        .schema = membrane.ATTACHMENT_SCHEMA,
        .agent = agent,
        .role = role.name(),
        .step = step,
        .interface = interface_hex,
        .interface_id = manifest.id,
        .kind = manifest.kind.name(),
        .mode = manifest.invocation.mode.name(),
        .status = "attached",
        .granted_caps = .{
            .allow_write = granted.allow_write,
            .write_prefix = granted.write_prefix,
            .allow_send = granted.allow_send,
            .send_prefix = granted.send_prefix,
            .allow_spawn = granted.allow_spawn,
            .max_writes = granted.budget.max_writes,
            .max_messages = granted.budget.max_messages,
            .max_bytes = granted.budget.max_bytes,
        },
    }, .{});

    const firing_id = try std.fmt.allocPrint(a, "interface/attach/{s}/{s}/{d}/{s}", .{
        agent,
        role.name(),
        step,
        interface_hex,
    });
    var fx = [_]types.Effect{
        .{ .write = .{
            .id = id,
            .schema = membrane.ATTACHMENT_SCHEMA,
            .bytes = record,
            .expected_prior = if (prior) |artifact| artifact.digest else null,
        } },
    };
    const runtime: runtime_mod.Runtime = .{ .substrate = substrate };
    _ = runtime.execute(.{
        .firing_id = firing_id,
        .receptor_schema = membrane.ATTACHMENT_SCHEMA,
    }, harnessCaps(try std.fmt.allocPrint(a, "agents/{s}/interfaces/", .{agent})), .{
        .control = .{ .terminate = "attached" },
        .effects = &fx,
        .evidence = try evidence(
            a,
            "admitted interface attached to an agent role under a derived least-authority grant",
            "interface attachment (§17.3 attach)",
        ),
    }) catch |err| switch (err) {
        error.FiringAlreadySettled, error.FiringMismatch => return granted,
        else => return err,
    };
    return granted;
}

/// Detach the role. New calls fail closed from the next resolution; the
/// admitted record, receipts, and WAL history all survive (invariant 15).
pub fn detachCore(
    a: Allocator,
    substrate: *substrate_mod.Substrate,
    agent: []const u8,
    role: Role,
    step: usize,
) ![64]u8 {
    const live = (try liveAttachment(a, substrate, agent, role, step)) orelse
        return Error.InterfaceNotAttached;
    if (!live.attached) return Error.InterfaceNotAttached;
    // Detaching a hop mid-chain would leave the tail unreachable, so the chain
    // is withdrawn from the end: step N requires N+1 to be gone already.
    if (step + 1 < MAX_CHAIN_STEPS) {
        if (try liveAttachment(a, substrate, agent, role, step + 1)) |next| {
            if (next.attached) return Error.InterfaceRoleOccupied;
        }
    }

    const id = try attachmentId(a, agent, role, step);
    const prior = substrate.artifacts.get(id) orelse return Error.InterfaceNotAttached;
    const record = try std.json.Stringify.valueAlloc(a, .{
        .schema = membrane.DETACHMENT_SCHEMA,
        .agent = agent,
        .role = role.name(),
        .step = step,
        .interface = live.interface_hex[0..],
        .status = "detached",
    }, .{});
    const firing_id = try std.fmt.allocPrint(a, "interface/detach/{s}/{s}/{d}/{s}", .{
        agent,
        role.name(),
        step,
        live.interface_hex[0..],
    });
    var fx = [_]types.Effect{
        .{ .write = .{
            .id = id,
            .schema = membrane.DETACHMENT_SCHEMA,
            .bytes = record,
            .expected_prior = prior.digest,
        } },
    };
    const runtime: runtime_mod.Runtime = .{ .substrate = substrate };
    _ = runtime.execute(.{
        .firing_id = firing_id,
        .receptor_schema = membrane.DETACHMENT_SCHEMA,
    }, harnessCaps(try std.fmt.allocPrint(a, "agents/{s}/interfaces/", .{agent})), .{
        .control = .{ .terminate = "detached" },
        .effects = &fx,
        .evidence = try evidence(
            a,
            "attachment edge withdrawn by compare-and-swap; audit roots preserved",
            "interface detachment (§17.3 retire)",
        ),
    }) catch |err| switch (err) {
        error.FiringAlreadySettled, error.FiringMismatch => return live.interface_hex,
        else => return err,
    };
    return live.interface_hex;
}

// ---------------------------------------------------------------------------
// Operate: reads inside the firing, commands through the outbox
// ---------------------------------------------------------------------------

pub const CallStatus = enum { read, queued, replayed };

pub const CallResult = struct {
    status: CallStatus,
    interface_hex: [64]u8,
    input_digest: [64]u8,
    output_digest: [64]u8,
    /// Read path only: the produced bytes.
    output: []const u8 = "",
    receipt_id: []const u8 = "",
    outbox_address: []const u8 = "",
};

fn receiptBytes(
    a: Allocator,
    manifest: *const membrane.Manifest,
    interface_hex: []const u8,
    input_digest: []const u8,
    output_digest: []const u8,
    target: []const u8,
) ![]const u8 {
    // Receipts are deliberately clock-free: provenance is content and order,
    // both of which the WAL already carries. A wall clock here would make
    // replay non-identical for no gain.
    return std.json.Stringify.valueAlloc(a, .{
        .schema = membrane.RECEIPT_SCHEMA,
        .interface = interface_hex,
        .interface_id = manifest.id,
        .interface_version = manifest.version,
        .kind = manifest.kind.name(),
        .mode = manifest.invocation.mode.name(),
        .implementation_digest = manifest.implementationHex()[0..],
        .input_digest = input_digest,
        .output_digest = output_digest,
        .target = target,
        .evidence_claim = manifest.evidence_claim,
        .evidence_method = manifest.evidence_method,
        .settlement = manifest.settlement,
    }, .{});
}

// ---------------------------------------------------------------------------
// The economic profile (Phase 5)
// ---------------------------------------------------------------------------

/// Cumulative spend, recomputed from the durable payment receipts rather than
/// held in a counter. The ledger *is* the budget state, so a lost cache or a
/// restart cannot silently reset what has already been spent.
fn spentMicros(a: Allocator, substrate: *substrate_mod.Substrate) u64 {
    var total: u64 = 0;
    var iterator = substrate.artifacts.iterator();
    while (iterator.next()) |entry| {
        if (!std.mem.startsWith(u8, entry.key_ptr.*, PAYMENT_PREFIX)) continue;
        const parsed = std.json.parseFromSliceLeaky(
            std.json.Value,
            a,
            entry.value_ptr.*.bytes,
            .{},
        ) catch continue;
        if (parsed != .object) continue;
        const amount = parsed.object.get("amount_micros") orelse continue;
        if (amount != .integer or amount.integer < 0) continue;
        total = std.math.add(u64, total, @intCast(amount.integer)) catch return std.math.maxInt(u64);
    }
    return total;
}

/// The operator's declared spending policy. It is a durable node artifact, not
/// a manifest field: the thing being paid must never get to state what it may
/// charge.
fn spendingPolicy(a: Allocator, substrate: *substrate_mod.Substrate) !membrane.SpendingPolicy {
    const artifact = substrate.artifacts.get(POLICY_ID) orelse
        return membrane.Error.InterfacePaymentProfileIncomplete;
    return membrane.SpendingPolicy.parse(a, artifact.bytes);
}

pub const PaidRead = struct {
    outcome: membrane.Outcome,
    /// Empty when the answer came from an already-paid quote.
    payment_id: []const u8 = "",
    amount_micros: u64 = 0,
    repaid: bool = false,
};

/// Perform a read against a boundary that charges for it.
///
/// The order is the whole safety property: challenge → decode → govern →
/// approve → sign → retry. Every refusal happens *before* the adapter is
/// reached, so an over-budget or unapproved call cannot have signed anything.
fn paidRead(
    a: Allocator,
    io: std.Io,
    substrate: *substrate_mod.Substrate,
    manifest: *const membrane.Manifest,
    interface_hex: []const u8,
    input: []const u8,
) !PaidRead {
    const input_digest = std.fmt.bytesToHex(types.digest(input), .lower);
    const payment_id = try std.fmt.allocPrint(a, PAYMENT_PREFIX ++ "{s}/{s}", .{
        interface_hex,
        &input_digest,
    });

    // Idempotency: this exact call was already paid for. Present the stored
    // proof again rather than buying a second one — a retry is the same
    // purchase, so it must not become a second charge.
    if (substrate.artifacts.get(payment_id)) |prior| {
        const record = std.json.parseFromSliceLeaky(std.json.Value, a, prior.bytes, .{}) catch
            return Error.CorruptInterfaceRecord;
        const proof = record.object.get("payment_payload") orelse return Error.CorruptInterfaceRecord;
        if (proof != .string) return Error.CorruptInterfaceRecord;
        const replayed = try membrane.invokeReadPaid(a, io, manifest, input, proof.string, null);
        return .{ .outcome = replayed, .repaid = false };
    }

    // 1. Ask. An unpaid call is expected to be challenged.
    var challenge: []const u8 = "";
    if (membrane.invokeReadPaid(a, io, manifest, input, null, &challenge)) |free| {
        // The resource did not charge after all. Nothing was signed, and there
        // is no payment to record.
        return .{ .outcome = free };
    } else |err| if (err != membrane.Error.InterfacePaymentRequired) return err;

    // 2. Decode the challenge as untrusted data.
    const quote = try membrane.parseQuote(a, challenge);

    // 3. Govern the spend. This is a pure decision over declared numbers.
    const declared = try spendingPolicy(a, substrate);
    const needs_approval = try membrane.governSpend(&declared, &quote, spentMicros(a, substrate));

    // 4. Above the threshold a human approves *this quote*, bound to its
    //    digest. Reuses the Phase 4 approval boundary unchanged.
    if (needs_approval) {
        const gate = resolveAdmitted(a, substrate, manifest.payment_approval_interface) catch
            return membrane.Error.InterfacePaymentUnapproved;
        if (gate.kind != .human or gate.human_interaction != .approval)
            return membrane.Error.InterfacePaymentUnapproved;
        const quote_hex = quote.digestHex();
        const answer = membrane.invokeRead(a, io, &gate, &quote_hex) catch
            return membrane.Error.InterfacePaymentUnapproved;
        const decision = membrane.parseHumanDecision(a, answer.output) catch
            return membrane.Error.InterfacePaymentUnapproved;
        if (!std.mem.eql(u8, decision.subject_hex, &quote_hex) or !decision.approved)
            return membrane.Error.InterfacePaymentUnapproved;
    }

    // 5. Sign — behind an admitted adapter. Keys never enter Neuron data
    //    (plan §10); the core only ever holds the payload the adapter returns.
    const adapter = resolveAdmitted(a, substrate, manifest.payment_adapter) catch
        return membrane.Error.InterfacePaymentAdapterFailed;
    const signed = membrane.invokeRead(a, io, &adapter, challenge) catch
        return membrane.Error.InterfacePaymentAdapterFailed;
    const payload = std.mem.trim(u8, signed.output, " \t\r\n");
    if (payload.len == 0) return membrane.Error.InterfacePaymentAdapterFailed;

    // 6. Retry the identical request carrying the proof.
    const paid = try membrane.invokeReadPaid(a, io, manifest, input, payload, null);

    // 7. Record the payment separately from the resource result: paying proves
    //    only that a payment condition was satisfied, never that the answer is
    //    correct (plan §10).
    const record = try std.json.Stringify.valueAlloc(a, .{
        .schema = membrane.PAYMENT_RECEIPT_SCHEMA,
        .interface = interface_hex,
        .interface_id = manifest.id,
        .input_digest = input_digest[0..],
        .quote_digest = quote.digestHex()[0..],
        .amount_micros = quote.amount_micros,
        .asset = quote.asset,
        .network = quote.network,
        .pay_to = quote.pay_to,
        .resource = quote.resource,
        .approval_required = needs_approval,
        .payment_payload = payload,
        .payment_payload_digest = std.fmt.bytesToHex(types.digest(payload), .lower)[0..],
        .adapter = manifest.payment_adapter,
    }, .{});

    var fx = [_]types.Effect{
        .{ .write = .{
            .id = payment_id,
            .schema = membrane.PAYMENT_RECEIPT_SCHEMA,
            .bytes = record,
        } },
    };
    const firing_id = try std.fmt.allocPrint(a, "interface/payment/{s}/{s}", .{
        interface_hex,
        &input_digest,
    });
    const runtime: runtime_mod.Runtime = .{ .substrate = substrate };
    _ = runtime.execute(.{
        .firing_id = firing_id,
        .receptor_schema = membrane.PAYMENT_RECEIPT_SCHEMA,
    }, harnessCaps(PAYMENT_PREFIX), .{
        .control = .{ .terminate = "paid" },
        .effects = &fx,
        .evidence = try evidence(
            a,
            "a payment condition was satisfied; the resource answer is judged separately",
            "x402 challenge, governed spend, adapter signature, and retry with proof",
        ),
    }) catch |err| switch (err) {
        error.FiringAlreadySettled, error.FiringMismatch => {},
        else => return err,
    };

    return .{
        .outcome = paid,
        .payment_id = payment_id,
        .amount_micros = quote.amount_micros,
        .repaid = true,
    };
}

/// One interface operation. A read is performed now and recorded as firing
/// provenance; a command is only *committed* now — the adapter is not touched
/// until `dispatchCore` drains the outbox record.
pub fn callCore(
    a: Allocator,
    io: std.Io,
    substrate: *substrate_mod.Substrate,
    interface_hex: []const u8,
    input: []const u8,
) !CallResult {
    const manifest = try resolveAdmitted(a, substrate, interface_hex);
    const input_digest = std.fmt.bytesToHex(types.digest(input), .lower);
    const runtime: runtime_mod.Runtime = .{ .substrate = substrate };

    switch (manifest.invocation.mode) {
        .read => {
            // A paid boundary goes through the governed flow; a free one is
            // called directly. The economic profile is orthogonal to the
            // invocation (plan §10), so nothing below this line differs.
            const paid: ?PaidRead = if (manifest.economics != .none)
                try paidRead(a, io, substrate, &manifest, interface_hex, input)
            else
                null;
            const outcome = if (paid) |p| p.outcome else try membrane.invokeRead(a, io, &manifest, input);
            const output_hex = std.fmt.bytesToHex(outcome.output_digest, .lower);
            const receipt_id = try std.fmt.allocPrint(a, RECEIPT_PREFIX ++ "{s}/{s}", .{
                interface_hex,
                &input_digest,
            });
            const record = try receiptBytes(
                a,
                &manifest,
                interface_hex,
                &input_digest,
                &output_hex,
                "",
            );
            var fx = [_]types.Effect{
                .{ .write = .{ .id = receipt_id, .schema = membrane.RECEIPT_SCHEMA, .bytes = record } },
            };
            const firing_id = try std.fmt.allocPrint(a, "interface/read/{s}/{s}", .{
                interface_hex,
                &input_digest,
            });
            _ = runtime.execute(.{
                .firing_id = firing_id,
                .receptor_schema = membrane.CALL_SCHEMA,
            }, harnessCaps(RECEIPT_PREFIX), .{
                .control = .{ .terminate = "read" },
                .effects = &fx,
                .evidence = try evidence(a, manifest.evidence_claim, manifest.evidence_method),
            }) catch |err| switch (err) {
                error.FiringAlreadySettled, error.FiringMismatch => {},
                else => return err,
            };
            return .{
                .status = .read,
                .interface_hex = try manifestHex(interface_hex),
                .input_digest = input_digest,
                .output_digest = output_hex,
                .output = outcome.output,
                .receipt_id = receipt_id,
            };
        },
        .command => {
            // The consequential path: content lands in the substrate and an
            // outbox record names it, atomically, in one firing. Nothing has
            // crossed the boundary yet.
            const pending_id = try std.fmt.allocPrint(a, PENDING_PREFIX ++ "{s}/{s}", .{
                interface_hex,
                &input_digest,
            });
            const address = try std.fmt.allocPrint(a, OUTBOX_PREFIX ++ "{s}/{s}", .{
                interface_hex,
                &input_digest,
            });
            if (substrate.artifacts.contains(pending_id)) {
                return .{
                    .status = .replayed,
                    .interface_hex = try manifestHex(interface_hex),
                    .input_digest = input_digest,
                    .output_digest = input_digest,
                    .outbox_address = address,
                };
            }
            const envelope = try std.json.Stringify.valueAlloc(a, .{
                .schema = membrane.CALL_SCHEMA,
                .interface = interface_hex,
                .content = pending_id,
                .content_digest = input_digest[0..],
                .idempotency_key = input_digest[0..],
            }, .{});
            var fx = [_]types.Effect{
                .{ .write = .{ .id = pending_id, .schema = membrane.CALL_SCHEMA, .bytes = input } },
                .{ .send = .{
                    .to = address,
                    .schema = membrane.CALL_SCHEMA,
                    .payload = envelope,
                    .durable = true,
                } },
            };
            const firing_id = try std.fmt.allocPrint(a, "interface/command/{s}/{s}", .{
                interface_hex,
                &input_digest,
            });
            var caps = harnessCaps(PENDING_PREFIX);
            caps.send_prefix = OUTBOX_PREFIX;
            _ = runtime.execute(.{
                .firing_id = firing_id,
                .receptor_schema = membrane.CALL_SCHEMA,
            }, caps, .{
                .control = .{ .terminate = "queued" },
                .effects = &fx,
                .evidence = try evidence(
                    a,
                    "consequential command committed to the outbox with a content idempotency key",
                    "interface outbox commit (§17.3 command)",
                ),
            }) catch |err| switch (err) {
                error.FiringAlreadySettled, error.FiringMismatch => {},
                else => return err,
            };
            return .{
                .status = .queued,
                .interface_hex = try manifestHex(interface_hex),
                .input_digest = input_digest,
                .output_digest = input_digest,
                .outbox_address = address,
            };
        },
    }
}

fn manifestHex(hex: []const u8) ![64]u8 {
    if (hex.len != 64) return Error.CorruptInterfaceRecord;
    var out: [64]u8 = undefined;
    @memcpy(&out, hex);
    return out;
}

/// The adapter bound into the outbox state machine. It holds the allocator,
/// the `Io`, and the substrate it must resolve interfaces from — which is why
/// delivery adapters carry context.
const CommandAdapter = struct {
    allocator: Allocator,
    io: std.Io,
    substrate: *substrate_mod.Substrate,
    /// Set by `deliver` so the caller can record what actually happened.
    outcome: *DispatchOutcome,

    pub fn deliver(self: *const CommandAdapter, message: *const substrate_mod.StoredMessage) delivery_mod.AdapterResult {
        const a = self.allocator;
        const envelope = std.json.parseFromSliceLeaky(std.json.Value, a, message.payload, .{}) catch
            return .permanent_failure;
        if (envelope != .object) return .permanent_failure;
        const interface = envelope.object.get("interface") orelse return .permanent_failure;
        const content_id = envelope.object.get("content") orelse return .permanent_failure;
        if (interface != .string or content_id != .string) return .permanent_failure;

        const manifest = resolveAdmitted(a, self.substrate, interface.string) catch
            return .permanent_failure;
        const content = self.substrate.artifacts.get(content_id.string) orelse
            return .permanent_failure;

        // The safety gate, before the boundary is crossed rather than after.
        // An actuator with no recorded human approval for *exactly* these bytes
        // does not move the device: a missing answer parks for retry, and an
        // explicit refusal is permanent. Silence is never consent.
        if (manifest.kind == .device and manifest.device_role == .actuator) {
            self.approvalFor(&manifest, content.bytes) catch |err| {
                self.outcome.failure = @errorName(err);
                return switch (err) {
                    // The human has not answered yet. Nothing crossed.
                    membrane.Error.InterfaceApprovalMissing => .retryable,
                    // A refusal is a decision, not a transient condition.
                    else => .permanent_failure,
                };
            };
        }

        // Cross the boundary.
        const applied = membrane.applyCommand(a, self.io, &manifest, content.bytes) catch |err| {
            // An uncertain outcome must never be silently retried: it parks
            // for explicit reconciliation (§27).
            self.outcome.failure = @errorName(err);
            return switch (err) {
                membrane.Error.InterfaceTimeout => .uncertain,
                membrane.Error.InterfaceCallFailed => .retryable,
                else => .permanent_failure,
            };
        };
        // Judge it independently: read the external state back and compare
        // content identity. The writer's own success is not the evidence.
        membrane.verifyCommand(a, self.io, &manifest, content.bytes) catch |err| {
            self.outcome.failure = @errorName(err);
            return .uncertain;
        };
        self.outcome.target = a.dupe(u8, applied.target) catch "";
        self.outcome.interface_hex = manifestHex(interface.string) catch return .permanent_failure;
        self.outcome.content_id = content_id.string;
        self.outcome.output_digest = std.fmt.bytesToHex(applied.output_digest, .lower);
        self.outcome.reconciled = true;
        return .acknowledged;
    }

    /// Resolve the actuator's declared human gate and read the decision bound
    /// to this exact content. The human interface is invoked through the
    /// ordinary read path, so the same strict decoding, path confinement, and
    /// digest re-pinning that guard every other boundary guard this one — a
    /// forged or drifted approval inbox fails closed like anything else.
    fn approvalFor(
        self: *const CommandAdapter,
        manifest: *const membrane.Manifest,
        content: []const u8,
    ) !void {
        const a = self.allocator;
        const subject = std.fmt.bytesToHex(types.digest(content), .lower);
        const gate = resolveAdmitted(a, self.substrate, manifest.approval_interface) catch
            return membrane.Error.InterfaceSafetyGateMissing;
        // The gate must actually be a human approval boundary. An actuator
        // pointing its safety gate at, say, a filesystem read would otherwise
        // "approve" itself with arbitrary bytes.
        if (gate.kind != .human or gate.human_interaction != .approval)
            return membrane.Error.InterfaceSafetyGateMissing;
        const answer = membrane.invokeRead(a, self.io, &gate, &subject) catch |err| switch (err) {
            // An answer that exists but does not decode, or answers about
            // different bytes, is a *malformed* approval — a distinct condition
            // from no answer at all, and permanent rather than retryable.
            membrane.Error.InterfaceApprovalMalformed => return err,
            else => return membrane.Error.InterfaceApprovalMissing,
        };
        const decision = try membrane.parseHumanDecision(a, answer.output);
        if (!std.mem.eql(u8, decision.subject_hex, &subject))
            return membrane.Error.InterfaceApprovalMalformed;
        if (!decision.approved) return membrane.Error.InterfaceApprovalDenied;
    }
};

pub const DispatchOutcome = struct {
    interface_hex: [64]u8 = @splat('0'),
    content_id: []const u8 = "",
    target: []const u8 = "",
    output_digest: [64]u8 = @splat('0'),
    reconciled: bool = false,
    failure: []const u8 = "",
    status: substrate_mod.DeliveryStatus = .queued,
    attempts: u8 = 0,
    receipt_id: []const u8 = "",
};

/// Drain one queued interface command: dispatch it, reconcile it
/// independently, acknowledge it, and record a receipt. A record that is
/// already acknowledged is never dispatched twice — retry is safe because
/// identity, not resemblance, decides.
pub fn dispatchOneCore(
    a: Allocator,
    io: std.Io,
    substrate: *substrate_mod.Substrate,
) !?DispatchOutcome {
    var outcome: DispatchOutcome = .{};
    var adapter_impl: CommandAdapter = .{
        .allocator = a,
        .io = io,
        .substrate = substrate,
        .outcome = &outcome,
    };
    const adapter = delivery_mod.bind(CommandAdapter, &adapter_impl, OUTBOX_PREFIX);
    const delivered = (try delivery_mod.deliverNext(substrate, adapter)) orelse return null;
    outcome.status = delivered.status;
    outcome.attempts = delivered.attempts;

    if (delivered.status == .acknowledged and outcome.reconciled) {
        const receipt_id = try std.fmt.allocPrint(a, RECEIPT_PREFIX ++ "{s}/{s}", .{
            outcome.interface_hex[0..],
            outcome.output_digest[0..],
        });
        const manifest = try resolveAdmitted(a, substrate, &outcome.interface_hex);
        const record = try receiptBytes(
            a,
            &manifest,
            &outcome.interface_hex,
            &outcome.output_digest,
            &outcome.output_digest,
            outcome.target,
        );
        var fx = [_]types.Effect{
            .{ .write = .{ .id = receipt_id, .schema = membrane.RECEIPT_SCHEMA, .bytes = record } },
        };
        const firing_id = try std.fmt.allocPrint(a, "interface/dispatch/{s}/{s}", .{
            outcome.interface_hex[0..],
            outcome.output_digest[0..],
        });
        const runtime: runtime_mod.Runtime = .{ .substrate = substrate };
        _ = runtime.execute(.{
            .firing_id = firing_id,
            .receptor_schema = membrane.RECEIPT_SCHEMA,
        }, harnessCaps(RECEIPT_PREFIX), .{
            .control = .{ .terminate = "reconciled" },
            .effects = &fx,
            .evidence = try evidence(
                a,
                "external state independently read back and compared by content digest",
                "interface reconciliation (§27)",
            ),
        }) catch |err| switch (err) {
            error.FiringAlreadySettled, error.FiringMismatch => {},
            else => return err,
        };
        outcome.receipt_id = receipt_id;
    }
    return outcome;
}

// ---------------------------------------------------------------------------
// CLI wrappers: open the durable node substrate, run the core, print, close.
// ---------------------------------------------------------------------------

fn openNodeSubstrate(a: Allocator, io: std.Io, node_dir: []const u8) !substrate_mod.Substrate {
    const state_path = try std.fs.path.join(a, &.{ node_dir, "state" });
    return substrate_mod.Substrate.initDir(a, io, std.Io.Dir.cwd(), state_path);
}

fn readSource(a: Allocator, io: std.Io, path: []const u8) ![]u8 {
    if (std.mem.eql(u8, path, "-")) {
        var buffer: [4096]u8 = undefined;
        var reader = std.Io.File.stdin().reader(io, &buffer);
        return reader.interface.allocRemaining(a, .limited(1 << 20));
    }
    return std.Io.Dir.cwd().readFileAlloc(io, path, a, .limited(1 << 20));
}

/// One stdout write per process invocation. A `File.Writer` carries its own
/// position, so two writers over the same stdout would overwrite each other
/// instead of appending: every verb composes its whole output, then emits once.
fn emit(a: Allocator, io: std.Io, parts: []const []const u8) !void {
    var out: std.ArrayList(u8) = .empty;
    for (parts) |part| try out.appendSlice(a, part);
    if (out.items.len == 0 or out.items[out.items.len - 1] != '\n') try out.append(a, '\n');
    var buffer: [4096]u8 = undefined;
    var writer = std.Io.File.stdout().writerStreaming(io, &buffer);
    try writer.interface.writeAll(out.items);
    try writer.interface.flush();
}

/// `neuron interface policy` — install the operator's spending policy as a
/// durable node artifact. Declaring a policy is the only way a paid interface
/// becomes callable at all; without one, every economic profile fails closed.
pub fn policy(
    allocator: Allocator,
    io: std.Io,
    node_dir: []const u8,
    policy_path: []const u8,
    json_out: bool,
) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const bytes = try readSource(a, io, policy_path);
    // Validated before it is stored: an unparseable policy must not be able to
    // sit in the substrate looking like a budget.
    const parsed = try membrane.SpendingPolicy.parse(a, bytes);

    var substrate = try openNodeSubstrate(a, io, node_dir);
    defer substrate.deinit();

    // Replacing a policy is a compare-and-swap against the one in force, so a
    // concurrent change cannot be silently overwritten by a stale budget.
    const prior = substrate.artifacts.get(POLICY_ID);
    var fx = [_]types.Effect{
        .{ .write = .{
            .id = POLICY_ID,
            .schema = membrane.SPENDING_POLICY_SCHEMA,
            .bytes = bytes,
            .expected_prior = if (prior) |p| p.digest else null,
        } },
    };
    const runtime: runtime_mod.Runtime = .{ .substrate = &substrate };
    // The firing identifies the *transition*, not the policy content. Content
    // alone would make re-installing a previously used policy — a legitimate
    // revert to an earlier budget — collide with the settled firing that first
    // installed it, and be silently skipped while the caller is told it took.
    const firing_id = try std.fmt.allocPrint(a, "interface/policy/{s}/{s}", .{
        if (prior) |p| std.fmt.bytesToHex(p.digest, .lower)[0..] else "genesis",
        std.fmt.bytesToHex(types.digest(bytes), .lower)[0..],
    });
    _ = runtime.execute(.{
        .firing_id = firing_id,
        .receptor_schema = membrane.SPENDING_POLICY_SCHEMA,
    }, harnessCaps("interfaces/policy/"), .{
        .control = .{ .terminate = "policy" },
        .effects = &fx,
        .evidence = try evidence(
            a,
            "operator-declared spending policy",
            "spending policy installed as a durable node artifact",
        ),
    }) catch |err| switch (err) {
        error.FiringAlreadySettled, error.FiringMismatch => {},
        else => return err,
    };

    if (json_out) {
        try emit(a, io, &.{try std.json.Stringify.valueAlloc(a, .{
            .schema = membrane.SPENDING_POLICY_SCHEMA,
            .max_per_call_micros = parsed.max_per_call_micros,
            .cumulative_budget_micros = parsed.cumulative_budget_micros,
            .approval_threshold_micros = parsed.approval_threshold_micros,
            .spent_micros = spentMicros(a, &substrate),
        }, .{})});
    } else {
        try emit(a, io, &.{try std.fmt.allocPrint(
            a,
            "✓ spending policy installed · per-call ≤ {d} · budget {d} · approval ≥ {d}",
            .{
                parsed.max_per_call_micros,
                parsed.cumulative_budget_micros,
                parsed.approval_threshold_micros,
            },
        )});
    }
}

/// `neuron interface resolve-gap` — automatic interface morphogenesis (§9).
/// Reuse is searched before discovery, and a generated adapter that fails the
/// gap on the real path is retired rather than retained.
pub fn resolveGap(
    allocator: Allocator,
    io: std.Io,
    node_dir: []const u8,
    agent: []const u8,
    gap_path: []const u8,
    role: Role,
    step: usize,
    json_out: bool,
) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const bytes = try readSource(a, io, gap_path);
    const gap = try morphogenesis.CapabilityGap.parse(a, bytes);

    var substrate = try openNodeSubstrate(a, io, node_dir);
    defer substrate.deinit();

    const resolution = try morphogenesis.resolveGap(a, io, &substrate, agent, role, step, &gap);

    if (json_out) {
        try emit(a, io, &.{try std.json.Stringify.valueAlloc(a, .{
            .schema = morphogenesis.RESULT_SCHEMA,
            .gap = gap.id,
            .route = resolution.route.name(),
            .interface = resolution.interface_hex[0..],
            .verified = resolution.verified,
            .verified_successes = resolution.successes,
            .result_digest = resolution.result_digest[0..],
            .agent = agent,
            .role = role.name(),
            .step = step,
        }, .{})});
    } else {
        try emit(a, io, &.{try std.fmt.allocPrint(
            a,
            "✓ capability gap resolved · {s} · {s} · {s} · verified on the real path ({d} success(es))",
            .{ gap.id, resolution.route.name(), resolution.interface_hex[0..16], resolution.successes },
        )});
    }
}

/// `neuron interface discover` — a pure read. It inspects a target, reports
/// what kind of boundary it looks like, and writes nothing anywhere.
pub fn discover(allocator: Allocator, io: std.Io, target: []const u8, json_out: bool) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const candidate = try membrane.discover(a, io, target);
    const digest_hex: []const u8 = if (candidate.implementation_digest) |digest|
        try a.dupe(u8, &std.fmt.bytesToHex(digest, .lower))
    else
        "";
    if (json_out) {
        try emit(a, io, &.{try std.json.Stringify.valueAlloc(a, .{
            .schema = membrane.CANDIDATE_SCHEMA,
            .target = candidate.target,
            .kind = if (candidate.kind) |kind| kind.name() else "unknown",
            .exists = candidate.exists,
            .executable = candidate.executable,
            .implementation_digest = digest_hex,
            .note = candidate.note,
            .authority = "none: discovery is a read and admits nothing",
        }, .{})});
    } else {
        try emit(a, io, &.{try std.fmt.allocPrint(a, "{s} · {s} · {s}", .{
            candidate.target,
            if (candidate.kind) |kind| kind.name() else "unknown",
            candidate.note,
        })});
    }
    if (candidate.kind == null) return membrane.Error.UnknownInterfaceKind;
}

/// `neuron interface describe` — emit an inert draft manifest with the
/// boundary pinned. The draft has no authority until it is admitted.
pub fn describe(
    allocator: Allocator,
    io: std.Io,
    target: []const u8,
    options: membrane.DescribeOptions,
    output_path: ?[]const u8,
) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const draft = try membrane.describe(a, io, target, options);
    // Round-trip the draft through the real validator: a description that
    // cannot be parsed is a defect in the describer, not a user problem.
    _ = try membrane.parseManifest(a, draft);
    if (output_path) |path| {
        try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = path, .data = draft });
        try emit(a, io, &.{try std.fmt.allocPrint(
            a,
            "✓ interface described (inert until admitted) · {s}",
            .{path},
        )});
    } else {
        try emit(a, io, &.{draft});
    }
}

/// `neuron interface test` — run the contract and adversarial battery without
/// admitting anything. This is a read: it proves or disproves, it never grants.
pub fn testInterface(allocator: Allocator, io: std.Io, manifest_path: []const u8, json_out: bool) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const bytes = try readSource(a, io, manifest_path);
    const manifest = try membrane.parseManifest(a, bytes);
    const checks = try runBattery(a, io, &manifest);
    const passed = batteryPassed(checks);

    var out: std.ArrayList([]const u8) = .empty;
    if (json_out) {
        var array = std.json.Array.init(a);
        for (checks) |check| {
            var object: std.json.ObjectMap = .empty;
            try object.put(a, "check", .{ .string = check.name });
            try object.put(a, "ok", .{ .bool = check.ok });
            try object.put(a, "detail", .{ .string = check.detail });
            try array.append(.{ .object = object });
        }
        var root: std.json.ObjectMap = .empty;
        try root.put(a, "interface", .{ .string = manifest.id });
        try root.put(a, "manifest_digest", .{ .string = try a.dupe(u8, &manifest.manifestHex()) });
        try root.put(a, "passed", .{ .bool = passed });
        try root.put(a, "checks", .{ .array = array });
        try out.append(a, try std.json.Stringify.valueAlloc(a, std.json.Value{ .object = root }, .{}));
    } else {
        for (checks) |check| {
            try out.append(a, try std.fmt.allocPrint(a, "  {s} {s} · {s}\n", .{
                if (check.ok) "✓" else "✗",
                check.name,
                check.detail,
            }));
        }
        try out.append(a, if (passed)
            "interface battery: PASS (not admitted — admission is a separate write)"
        else
            "interface battery: FAIL");
    }
    try emit(a, io, out.items);
    if (!passed) return Error.InterfaceTestsFailed;
}

pub fn admit(
    allocator: Allocator,
    io: std.Io,
    node_dir: []const u8,
    manifest_path: []const u8,
    json_out: bool,
) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const bytes = try readSource(a, io, manifest_path);
    var substrate = try openNodeSubstrate(a, io, node_dir);
    defer substrate.deinit();
    const result = try admitCore(a, io, &substrate, bytes);
    const line = if (json_out)
        try std.json.Stringify.valueAlloc(a, .{
            .schema = membrane.ADMISSION_SCHEMA,
            .interface = result.manifest_digest[0..],
            .id = result.id,
            .kind = result.kind.name(),
            .mode = result.mode.name(),
            .implementation_digest = result.implementation_digest[0..],
            .created = result.created,
            .checks = result.checks.len,
        }, .{})
    else
        try std.fmt.allocPrint(a, "✓ interface admitted · {s} · {s} · {s}", .{
            result.id,
            result.kind.name(),
            result.manifest_digest[0..16],
        });
    try emit(a, io, &.{line});
}

pub fn revoke(allocator: Allocator, io: std.Io, node_dir: []const u8, interface_hex: []const u8) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var substrate = try openNodeSubstrate(a, io, node_dir);
    defer substrate.deinit();
    try revokeCore(a, &substrate, interface_hex);
    try emit(a, io, &.{try std.fmt.allocPrint(
        a,
        "✓ interface revoked · {s} · new calls fail closed",
        .{interface_hex[0..@min(16, interface_hex.len)]},
    )});
}

pub fn attach(
    allocator: Allocator,
    io: std.Io,
    node_dir: []const u8,
    agent: []const u8,
    role: Role,
    step: usize,
    interface_hex: []const u8,
    replace: bool,
    json_out: bool,
) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var substrate = try openNodeSubstrate(a, io, node_dir);
    defer substrate.deinit();
    const granted = try attachCore(a, io, &substrate, agent, role, step, interface_hex, replace);
    const line = if (json_out)
        try std.json.Stringify.valueAlloc(a, .{
            .schema = membrane.ATTACHMENT_SCHEMA,
            .agent = agent,
            .role = role.name(),
            .step = step,
            .interface = interface_hex,
            .granted_write_prefix = granted.write_prefix,
            .granted_send_prefix = granted.send_prefix,
            .allow_spawn = granted.allow_spawn,
        }, .{})
    else
        try std.fmt.allocPrint(a, "✓ interface attached · {s}/{s} step {d} · write {s}", .{
            agent,
            role.name(),
            step,
            granted.write_prefix,
        });
    try emit(a, io, &.{line});
}

pub fn detach(
    allocator: Allocator,
    io: std.Io,
    node_dir: []const u8,
    agent: []const u8,
    role: Role,
    step: usize,
) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var substrate = try openNodeSubstrate(a, io, node_dir);
    defer substrate.deinit();
    const hex = try detachCore(a, &substrate, agent, role, step);
    try emit(a, io, &.{try std.fmt.allocPrint(
        a,
        "✓ interface detached · {s}/{s} step {d} · {s} · audit preserved",
        .{ agent, role.name(), step, hex[0..16] },
    )});
}

pub fn call(
    allocator: Allocator,
    io: std.Io,
    node_dir: []const u8,
    interface_hex: []const u8,
    input: []const u8,
    json_out: bool,
) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var substrate = try openNodeSubstrate(a, io, node_dir);
    defer substrate.deinit();
    const result = try callCore(a, io, &substrate, interface_hex, input);
    const line = if (json_out)
        try std.json.Stringify.valueAlloc(a, .{
            .schema = membrane.RESULT_SCHEMA,
            .status = @tagName(result.status),
            .interface = result.interface_hex[0..],
            .input_digest = result.input_digest[0..],
            .output_digest = result.output_digest[0..],
            .output = result.output,
            .receipt = result.receipt_id,
            .outbox = result.outbox_address,
        }, .{})
    else switch (result.status) {
        .read => result.output,
        .queued => try std.fmt.allocPrint(
            a,
            "✓ command queued in the outbox · {s}\n  run `neuron interface dispatch` to cross the boundary",
            .{result.outbox_address},
        ),
        .replayed => try std.fmt.allocPrint(
            a,
            "✓ command already committed · {s} · no duplicate outbox record",
            .{result.outbox_address},
        ),
    };
    try emit(a, io, &.{line});
}

pub fn dispatch(allocator: Allocator, io: std.Io, node_dir: []const u8, json_out: bool) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var substrate = try openNodeSubstrate(a, io, node_dir);
    defer substrate.deinit();

    var drained: usize = 0;
    var acknowledged: usize = 0;
    var parked: usize = 0;
    var last: DispatchOutcome = .{};
    while (try dispatchOneCore(a, io, &substrate)) |outcome| {
        drained += 1;
        last = outcome;
        switch (outcome.status) {
            .acknowledged => acknowledged += 1,
            .reconciliation_required, .dead_letter => parked += 1,
            .queued => {},
        }
        if (drained >= 64) break;
    }
    const line = if (json_out)
        try std.json.Stringify.valueAlloc(a, .{
            .schema = membrane.RESULT_SCHEMA,
            .drained = drained,
            .acknowledged = acknowledged,
            .parked = parked,
            .target = last.target,
            .receipt = last.receipt_id,
            .reconciled = last.reconciled,
            .failure = last.failure,
        }, .{})
    else if (drained == 0)
        "outbox empty · nothing to dispatch"
    else
        try std.fmt.allocPrint(
            a,
            "✓ dispatched {d} · acknowledged {d} · parked {d}",
            .{ drained, acknowledged, parked },
        );
    try emit(a, io, &.{line});
    // A parked record is an unsettled external effect, not a success.
    if (parked > 0) return membrane.Error.InterfaceReconciliationFailed;
}

/// `neuron interface list` — a read over durable state: what is admitted, what
/// is revoked, and which agent roles hold live attachments.
pub fn list(allocator: Allocator, io: std.Io, node_dir: []const u8, json_out: bool) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var substrate = try openNodeSubstrate(a, io, node_dir);
    defer substrate.deinit();

    var admitted: std.ArrayList([]const u8) = .empty;
    var attachments: std.ArrayList([]const u8) = .empty;
    var revoked: usize = 0;
    var receipts: usize = 0;
    var iterator = substrate.artifacts.iterator();
    while (iterator.next()) |entry| {
        const id = entry.key_ptr.*;
        if (std.mem.startsWith(u8, id, ADMITTED_PREFIX)) {
            try admitted.append(a, id[ADMITTED_PREFIX.len..]);
        } else if (std.mem.startsWith(u8, id, REVOKED_PREFIX)) {
            revoked += 1;
        } else if (std.mem.startsWith(u8, id, RECEIPT_PREFIX)) {
            receipts += 1;
        } else if (std.mem.eql(u8, entry.value_ptr.schema, membrane.ATTACHMENT_SCHEMA) or
            std.mem.eql(u8, entry.value_ptr.schema, membrane.DETACHMENT_SCHEMA))
        {
            try attachments.append(a, id);
        }
    }
    std.mem.sort([]const u8, admitted.items, {}, lessThan);
    std.mem.sort([]const u8, attachments.items, {}, lessThan);

    var out: std.ArrayList([]const u8) = .empty;
    if (json_out) {
        var admitted_json = std.json.Array.init(a);
        for (admitted.items) |hex| {
            // Read the admission record itself rather than resolving for a
            // call: a revoked interface is still admitted history and must stay
            // visible, even though nothing may call it again.
            const summary = admissionSummary(a, &substrate, hex) orelse continue;
            var object: std.json.ObjectMap = .empty;
            try object.put(a, "interface", .{ .string = hex });
            try object.put(a, "id", .{ .string = summary.id });
            try object.put(a, "kind", .{ .string = summary.kind });
            try object.put(a, "mode", .{ .string = summary.mode });
            try object.put(a, "deterministic", .{ .bool = summary.deterministic });
            try object.put(a, "status", .{ .string = summary.status });
            try admitted_json.append(.{ .object = object });
        }
        var attached_json = std.json.Array.init(a);
        for (attachments.items) |id| {
            const artifact = substrate.artifacts.get(id).?;
            var object: std.json.ObjectMap = .empty;
            try object.put(a, "artifact", .{ .string = id });
            try object.put(a, "status", .{
                .string = if (std.mem.eql(u8, artifact.schema, membrane.ATTACHMENT_SCHEMA))
                    "attached"
                else
                    "detached",
            });
            try attached_json.append(.{ .object = object });
        }
        var root: std.json.ObjectMap = .empty;
        try root.put(a, "admitted", .{ .array = admitted_json });
        try root.put(a, "attachments", .{ .array = attached_json });
        try root.put(a, "revoked", .{ .integer = @intCast(revoked) });
        try root.put(a, "receipts", .{ .integer = @intCast(receipts) });
        try out.append(a, try std.json.Stringify.valueAlloc(a, std.json.Value{ .object = root }, .{}));
    } else {
        try out.append(a, try std.fmt.allocPrint(
            a,
            "{d} admitted · {d} attachments · {d} revoked · {d} receipts\n",
            .{ admitted.items.len, attachments.items.len, revoked, receipts },
        ));
        for (admitted.items) |hex| {
            const summary = admissionSummary(a, &substrate, hex) orelse continue;
            try out.append(a, try std.fmt.allocPrint(a, "  {s} · {s} · {s}/{s} · {s}\n", .{
                hex[0..16],
                summary.id,
                summary.kind,
                summary.mode,
                summary.status,
            }));
        }
    }
    try emit(a, io, out.items);
}

fn lessThan(_: void, left: []const u8, right: []const u8) bool {
    return std.mem.lessThan(u8, left, right);
}

const AdmissionSummary = struct {
    id: []const u8,
    kind: []const u8,
    mode: []const u8,
    deterministic: bool,
    status: []const u8,
};

/// The admission record's own summary fields, read without re-parsing or
/// re-validating the embedded manifest. Used by listings, which must show
/// revoked interfaces rather than resolve callable ones.
fn admissionSummary(
    a: Allocator,
    substrate: *const substrate_mod.Substrate,
    interface_hex: []const u8,
) ?AdmissionSummary {
    const id = std.fmt.allocPrint(a, ADMITTED_PREFIX ++ "{s}", .{interface_hex}) catch return null;
    const artifact = substrate.artifacts.get(id) orelse return null;
    const record = std.json.parseFromSliceLeaky(std.json.Value, a, artifact.bytes, .{}) catch return null;
    if (record != .object) return null;
    const revoked_id = std.fmt.allocPrint(a, REVOKED_PREFIX ++ "{s}", .{interface_hex}) catch return null;
    return .{
        .id = jsonText(record, "id") orelse return null,
        .kind = jsonText(record, "kind") orelse return null,
        .mode = jsonText(record, "mode") orelse return null,
        .deterministic = if (record.object.get("deterministic")) |value|
            value == .bool and value.bool
        else
            false,
        .status = if (substrate.artifacts.contains(revoked_id)) "revoked" else "admitted",
    };
}

fn jsonText(value: std.json.Value, key: []const u8) ?[]const u8 {
    const field = value.object.get(key) orelse return null;
    return switch (field) {
        .string => |text| text,
        else => null,
    };
}
