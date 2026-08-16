//! Standalone Neuron capability admission and dispatch policy.
//!
//! This module deliberately imports only `std`: Contract supplies verified
//! lease facts to the boundary, but Neuron owns the admission and dispatch
//! decision.  A claim is only a snapshot; `use` repeats every authority check
//! immediately before returning an executable envelope.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Digest = [32]u8;

pub const Action = enum { list, admit, attach, claim, use, revoke, detach, collect };
pub const Outcome = enum { allowed, refused };
pub const Reason = enum {
    ok,
    already_listed,
    unlisted,
    wrong_digest,
    not_admitted,
    revoked,
    not_attached,
    already_attached,
    verified_identity_required,
    subject_denied,
    tenant_denied,
    lease_required,
    stale_lease_fence,
    effect_denied,
    resource_denied,
    credential_required,
    credential_audience_denied,
    credential_generation_stale,
    budget_exhausted,
    stale_claim,
    detach_first,
    revoke_first,
};

/// Stable audit fact. It contains no wall clock and no allocator-owned text, so
/// identical state and input produce identical bytes.
pub const Record = struct {
    sequence: u64,
    action: Action,
    outcome: Outcome,
    reason: Reason,
    package: Digest,
    admission_generation: u64,
    attachment_generation: u64,
    revocation_generation: u64,
};

pub const Grant = struct {
    subject: []const u8,
    tenant: []const u8,
    effect: []const u8,
    resource_prefix: []const u8,
    credential_audience: []const u8,
    credential_generation: u64,
};

pub const Request = struct {
    effect: []const u8,
    resource: []const u8,
    cost: u64,
};

/// These are verified projections, not a Contract import or cached authority.
pub const Authority = struct {
    subject: []const u8,
    tenant: []const u8,
    subject_verified: bool,
    tenant_verified: bool,
    lease_current: bool,
    lease_fence: u64,
    credential_valid: bool,
    credential_audience: []const u8,
    credential_generation: u64,
    remaining_budget: u64,
};

pub const Claim = struct {
    package: Digest,
    admission_generation: u64,
    attachment_generation: u64,
    revocation_generation: u64,
    lease_fence: u64,
    credential_generation: u64,
    request_effect: []const u8,
    request_resource: []const u8,
    request_cost: u64,
    claim_generation: u64,
    seal: Digest,
};

/// Generated execution receives an explicit empty environment. `home = null`
/// prevents a runner from silently restoring HOME by convention.
pub const Sandbox = struct {
    env: []const []const u8 = &.{},
    home: ?[]const u8 = null,
};

pub const Dispatch = struct {
    record: Record,
    sandbox: Sandbox = .{},
};

const OwnedGrant = struct {
    subject: []u8,
    tenant: []u8,
    effect: []u8,
    resource_prefix: []u8,
    credential_audience: []u8,
    credential_generation: u64,

    fn init(a: Allocator, grant: Grant) !OwnedGrant {
        const subject = try a.dupe(u8, grant.subject);
        errdefer a.free(subject);
        const tenant = try a.dupe(u8, grant.tenant);
        errdefer a.free(tenant);
        const effect = try a.dupe(u8, grant.effect);
        errdefer a.free(effect);
        const resource = try a.dupe(u8, grant.resource_prefix);
        errdefer a.free(resource);
        const audience = try a.dupe(u8, grant.credential_audience);
        return .{
            .subject = subject,
            .tenant = tenant,
            .effect = effect,
            .resource_prefix = resource,
            .credential_audience = audience,
            .credential_generation = grant.credential_generation,
        };
    }

    fn deinit(self: *OwnedGrant, a: Allocator) void {
        a.free(self.subject);
        a.free(self.tenant);
        a.free(self.effect);
        a.free(self.resource_prefix);
        a.free(self.credential_audience);
    }
};

const Package = struct {
    name: []u8,
    digest: Digest,
    admitted: bool = false,
    attached: bool = false,
    revoked: bool = false,
    admission_generation: u64 = 0,
    attachment_generation: u64 = 0,
    revocation_generation: u64 = 0,
    claim_generation: u64 = 0,
    active_claim: Digest = @splat(0),
    grant: ?OwnedGrant = null,

    fn deinit(self: *Package, a: Allocator) void {
        a.free(self.name);
        if (self.grant) |*grant| grant.deinit(a);
    }
};

pub const Kernel = struct {
    allocator: Allocator,
    packages: std.ArrayList(Package) = .empty,
    records: std.ArrayList(Record) = .empty,
    next_sequence: u64 = 1,

    pub fn init(allocator: Allocator) Kernel {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *Kernel) void {
        for (self.packages.items) |*package| package.deinit(self.allocator);
        self.packages.deinit(self.allocator);
        self.records.deinit(self.allocator);
    }

    fn find(self: *Kernel, name: []const u8) ?*Package {
        for (self.packages.items) |*package| {
            if (std.mem.eql(u8, package.name, name)) return package;
        }
        return null;
    }

    fn emit(self: *Kernel, action: Action, outcome: Outcome, reason: Reason, package: ?*const Package, digest: Digest) !Record {
        const record: Record = .{
            .sequence = self.next_sequence,
            .action = action,
            .outcome = outcome,
            .reason = reason,
            .package = if (package) |p| p.digest else digest,
            .admission_generation = if (package) |p| p.admission_generation else 0,
            .attachment_generation = if (package) |p| p.attachment_generation else 0,
            .revocation_generation = if (package) |p| p.revocation_generation else 0,
        };
        try self.records.append(self.allocator, record);
        self.next_sequence += 1;
        return record;
    }

    fn refuse(self: *Kernel, action: Action, reason: Reason, package: ?*const Package, digest: Digest) !Record {
        return self.emit(action, .refused, reason, package, digest);
    }

    pub fn list(self: *Kernel, name: []const u8, digest: Digest) !Record {
        if (self.find(name)) |package| return self.refuse(.list, .already_listed, package, digest);
        const owned = try self.allocator.dupe(u8, name);
        errdefer self.allocator.free(owned);
        try self.packages.append(self.allocator, .{ .name = owned, .digest = digest });
        return self.emit(.list, .allowed, .ok, &self.packages.items[self.packages.items.len - 1], digest);
    }

    pub fn admit(self: *Kernel, name: []const u8, digest: Digest) !Record {
        const package = self.find(name) orelse return self.refuse(.admit, .unlisted, null, digest);
        if (!std.mem.eql(u8, &package.digest, &digest)) return self.refuse(.admit, .wrong_digest, package, digest);
        if (package.revoked) return self.refuse(.admit, .revoked, package, digest);
        package.admitted = true;
        package.admission_generation += 1;
        return self.emit(.admit, .allowed, .ok, package, digest);
    }

    pub fn attach(self: *Kernel, name: []const u8, digest: Digest, grant: Grant) !Record {
        const package = self.find(name) orelse return self.refuse(.attach, .unlisted, null, digest);
        if (!std.mem.eql(u8, &package.digest, &digest)) return self.refuse(.attach, .wrong_digest, package, digest);
        if (!package.admitted) return self.refuse(.attach, .not_admitted, package, digest);
        if (package.revoked) return self.refuse(.attach, .revoked, package, digest);
        if (package.attached) return self.refuse(.attach, .already_attached, package, digest);
        const owned = try OwnedGrant.init(self.allocator, grant);
        if (package.grant) |*old| old.deinit(self.allocator);
        package.grant = owned;
        package.attached = true;
        package.attachment_generation += 1;
        return self.emit(.attach, .allowed, .ok, package, digest);
    }

    fn hashPart(hasher: *std.crypto.hash.sha2.Sha256, bytes: []const u8) void {
        var size: [8]u8 = undefined;
        std.mem.writeInt(u64, &size, bytes.len, .big);
        hasher.update(&size);
        hasher.update(bytes);
    }

    fn claimSeal(package: *const Package, claim_token: Claim) Digest {
        var hasher = std.crypto.hash.sha2.Sha256.init(.{});
        hasher.update("neuron.capability-claim/v1");
        hasher.update(&claim_token.package);
        var number: [8]u8 = undefined;
        const values = [_]u64{
            claim_token.admission_generation,
            claim_token.attachment_generation,
            claim_token.revocation_generation,
            claim_token.lease_fence,
            claim_token.credential_generation,
            claim_token.request_cost,
            claim_token.claim_generation,
        };
        for (values) |value| {
            std.mem.writeInt(u64, &number, value, .big);
            hasher.update(&number);
        }
        hashPart(&hasher, package.name);
        hashPart(&hasher, claim_token.request_effect);
        hashPart(&hasher, claim_token.request_resource);
        var out: Digest = undefined;
        hasher.final(&out);
        return out;
    }

    fn authorize(package: *const Package, request: Request, authority: Authority) Reason {
        const grant = package.grant orelse return .not_attached;
        if (!authority.subject_verified or !authority.tenant_verified) return .verified_identity_required;
        if (!std.mem.eql(u8, authority.subject, grant.subject)) return .subject_denied;
        if (!std.mem.eql(u8, authority.tenant, grant.tenant)) return .tenant_denied;
        if (!authority.lease_current or authority.lease_fence == 0) return .lease_required;
        if (!std.mem.eql(u8, request.effect, grant.effect)) return .effect_denied;
        if (!std.mem.startsWith(u8, request.resource, grant.resource_prefix)) return .resource_denied;
        if (!authority.credential_valid) return .credential_required;
        if (!std.mem.eql(u8, authority.credential_audience, grant.credential_audience)) return .credential_audience_denied;
        if (authority.credential_generation != grant.credential_generation) return .credential_generation_stale;
        if (request.cost > authority.remaining_budget) return .budget_exhausted;
        return .ok;
    }

    pub fn claim(self: *Kernel, name: []const u8, digest: Digest, request: Request, authority: Authority) !struct { record: Record, claim: ?Claim } {
        const package = self.find(name) orelse return .{ .record = try self.refuse(.claim, .unlisted, null, digest), .claim = null };
        if (!std.mem.eql(u8, &package.digest, &digest)) return .{ .record = try self.refuse(.claim, .wrong_digest, package, digest), .claim = null };
        if (!package.admitted) return .{ .record = try self.refuse(.claim, .not_admitted, package, digest), .claim = null };
        if (package.revoked) return .{ .record = try self.refuse(.claim, .revoked, package, digest), .claim = null };
        if (!package.attached) return .{ .record = try self.refuse(.claim, .not_attached, package, digest), .claim = null };
        const reason = authorize(package, request, authority);
        if (reason != .ok) return .{ .record = try self.refuse(.claim, reason, package, digest), .claim = null };
        package.claim_generation += 1;
        var claim_token: Claim = .{
            .package = package.digest,
            .admission_generation = package.admission_generation,
            .attachment_generation = package.attachment_generation,
            .revocation_generation = package.revocation_generation,
            .lease_fence = authority.lease_fence,
            .credential_generation = authority.credential_generation,
            .request_effect = request.effect,
            .request_resource = request.resource,
            .request_cost = request.cost,
            .claim_generation = package.claim_generation,
            .seal = @splat(0),
        };
        claim_token.seal = claimSeal(package, claim_token);
        package.active_claim = claim_token.seal;
        return .{
            .record = try self.emit(.claim, .allowed, .ok, package, digest),
            .claim = claim_token,
        };
    }

    /// Immediate pre-dispatch check. No result from `claim` carries authority:
    /// every mutable fact and every pinned generation is checked again here.
    pub fn use(self: *Kernel, name: []const u8, claim_token: Claim, authority: Authority) !Dispatch {
        const zero: Digest = @splat(0);
        const package = self.find(name) orelse return .{ .record = try self.refuse(.use, .unlisted, null, zero) };
        if (!std.mem.eql(u8, &package.digest, &claim_token.package)) return .{ .record = try self.refuse(.use, .wrong_digest, package, claim_token.package) };
        if (!package.admitted) return .{ .record = try self.refuse(.use, .not_admitted, package, claim_token.package) };
        if (package.revoked) return .{ .record = try self.refuse(.use, .revoked, package, claim_token.package) };
        if (!package.attached) return .{ .record = try self.refuse(.use, .not_attached, package, claim_token.package) };
        if (claim_token.admission_generation != package.admission_generation or
            claim_token.attachment_generation != package.attachment_generation or
            claim_token.revocation_generation != package.revocation_generation or
            claim_token.claim_generation != package.claim_generation or
            !std.mem.eql(u8, &claim_token.seal, &package.active_claim) or
            !std.mem.eql(u8, &claim_token.seal, &claimSeal(package, claim_token)))
            return .{ .record = try self.refuse(.use, .stale_claim, package, claim_token.package) };
        if (claim_token.lease_fence != authority.lease_fence) return .{ .record = try self.refuse(.use, .stale_lease_fence, package, claim_token.package) };
        if (claim_token.credential_generation != authority.credential_generation) return .{ .record = try self.refuse(.use, .credential_generation_stale, package, claim_token.package) };
        const request: Request = .{ .effect = claim_token.request_effect, .resource = claim_token.request_resource, .cost = claim_token.request_cost };
        const reason = authorize(package, request, authority);
        if (reason != .ok) return .{ .record = try self.refuse(.use, reason, package, claim_token.package) };
        return .{ .record = try self.emit(.use, .allowed, .ok, package, claim_token.package) };
    }

    pub fn revoke(self: *Kernel, name: []const u8, digest: Digest) !Record {
        const package = self.find(name) orelse return self.refuse(.revoke, .unlisted, null, digest);
        if (!std.mem.eql(u8, &package.digest, &digest)) return self.refuse(.revoke, .wrong_digest, package, digest);
        package.revoked = true;
        package.revocation_generation += 1;
        return self.emit(.revoke, .allowed, .ok, package, digest);
    }

    pub fn detach(self: *Kernel, name: []const u8, digest: Digest) !Record {
        const package = self.find(name) orelse return self.refuse(.detach, .unlisted, null, digest);
        if (!std.mem.eql(u8, &package.digest, &digest)) return self.refuse(.detach, .wrong_digest, package, digest);
        if (!package.attached) return self.refuse(.detach, .not_attached, package, digest);
        package.attached = false;
        package.attachment_generation += 1;
        return self.emit(.detach, .allowed, .ok, package, digest);
    }

    pub fn collect(self: *Kernel, name: []const u8, digest: Digest) !Record {
        var index: ?usize = null;
        for (self.packages.items, 0..) |*package, i| if (std.mem.eql(u8, package.name, name)) {
            index = i;
            break;
        };
        const i = index orelse return self.refuse(.collect, .unlisted, null, digest);
        const package = &self.packages.items[i];
        if (!std.mem.eql(u8, &package.digest, &digest)) return self.refuse(.collect, .wrong_digest, package, digest);
        if (package.attached) return self.refuse(.collect, .detach_first, package, digest);
        if (!package.revoked) return self.refuse(.collect, .revoke_first, package, digest);
        // Emit before removal so the durable record retains all generations.
        const record = try self.emit(.collect, .allowed, .ok, package, digest);
        var removed = self.packages.orderedRemove(i);
        removed.deinit(self.allocator);
        return record;
    }
};

fn fixtureDigest(byte: u8) Digest {
    return @splat(byte);
}
fn fixtureGrant() Grant {
    return .{ .subject = "worker-7", .tenant = "tenant-a", .effect = "send", .resource_prefix = "https://api.example/tenant-a/", .credential_audience = "api.example", .credential_generation = 4 };
}
fn fixtureRequest() Request {
    return .{ .effect = "send", .resource = "https://api.example/tenant-a/jobs/9", .cost = 3 };
}
fn fixtureAuthority() Authority {
    return .{ .subject = "worker-7", .tenant = "tenant-a", .subject_verified = true, .tenant_verified = true, .lease_current = true, .lease_fence = 11, .credential_valid = true, .credential_audience = "api.example", .credential_generation = 4, .remaining_budget = 3 };
}

fn ready(kernel: *Kernel) !Claim {
    _ = try kernel.list("generated/tool", fixtureDigest(1));
    _ = try kernel.admit("generated/tool", fixtureDigest(1));
    _ = try kernel.attach("generated/tool", fixtureDigest(1), fixtureGrant());
    return (try kernel.claim("generated/tool", fixtureDigest(1), fixtureRequest(), fixtureAuthority())).claim.?;
}

test "generated package is inert until exact digest admission and attachment" {
    var kernel = Kernel.init(std.testing.allocator);
    defer kernel.deinit();
    _ = try kernel.list("generated/tool", fixtureDigest(1));
    try std.testing.expectEqual(Reason.not_admitted, (try kernel.claim("generated/tool", fixtureDigest(1), fixtureRequest(), fixtureAuthority())).record.reason);
    try std.testing.expectEqual(Reason.wrong_digest, (try kernel.admit("generated/tool", fixtureDigest(2))).reason);
    _ = try kernel.admit("generated/tool", fixtureDigest(1));
    try std.testing.expectEqual(Reason.not_attached, (try kernel.claim("generated/tool", fixtureDigest(1), fixtureRequest(), fixtureAuthority())).record.reason);
    _ = try kernel.attach("generated/tool", fixtureDigest(1), fixtureGrant());
    // Knowing every public request field is still not a claim: only `claim`
    // installs the matching seal in kernel state.
    const direct: Claim = .{
        .package = fixtureDigest(1),
        .admission_generation = 1,
        .attachment_generation = 1,
        .revocation_generation = 0,
        .lease_fence = 11,
        .credential_generation = 4,
        .request_effect = "send",
        .request_resource = "https://api.example/tenant-a/jobs/9",
        .request_cost = 3,
        .claim_generation = 0,
        .seal = @splat(0),
    };
    try std.testing.expectEqual(Reason.stale_claim, (try kernel.use("generated/tool", direct, fixtureAuthority())).record.reason);
}

test "claim and immediate use fail closed on every authority dimension" {
    var kernel = Kernel.init(std.testing.allocator);
    defer kernel.deinit();
    const claim_token = try ready(&kernel);
    const good = try kernel.use("generated/tool", claim_token, fixtureAuthority());
    try std.testing.expectEqual(Outcome.allowed, good.record.outcome);
    try std.testing.expectEqual(@as(usize, 0), good.sandbox.env.len);
    try std.testing.expectEqual(@as(?[]const u8, null), good.sandbox.home);

    var changed = fixtureAuthority();
    changed.subject_verified = false;
    try std.testing.expectEqual(Reason.verified_identity_required, (try kernel.use("generated/tool", claim_token, changed)).record.reason);
    changed = fixtureAuthority();
    changed.tenant = "tenant-b";
    try std.testing.expectEqual(Reason.tenant_denied, (try kernel.use("generated/tool", claim_token, changed)).record.reason);
    changed = fixtureAuthority();
    changed.lease_current = false;
    try std.testing.expectEqual(Reason.lease_required, (try kernel.use("generated/tool", claim_token, changed)).record.reason);
    changed = fixtureAuthority();
    changed.lease_fence += 1;
    try std.testing.expectEqual(Reason.stale_lease_fence, (try kernel.use("generated/tool", claim_token, changed)).record.reason);
    changed = fixtureAuthority();
    changed.credential_audience = "attacker.example";
    try std.testing.expectEqual(Reason.credential_audience_denied, (try kernel.use("generated/tool", claim_token, changed)).record.reason);
    changed = fixtureAuthority();
    changed.credential_generation += 1;
    try std.testing.expectEqual(Reason.credential_generation_stale, (try kernel.use("generated/tool", claim_token, changed)).record.reason);
    changed = fixtureAuthority();
    changed.remaining_budget = 2;
    try std.testing.expectEqual(Reason.budget_exhausted, (try kernel.use("generated/tool", claim_token, changed)).record.reason);
}

test "effect resource and destination grant cannot be widened by request text" {
    var kernel = Kernel.init(std.testing.allocator);
    defer kernel.deinit();
    _ = try kernel.list("generated/tool", fixtureDigest(1));
    _ = try kernel.admit("generated/tool", fixtureDigest(1));
    _ = try kernel.attach("generated/tool", fixtureDigest(1), fixtureGrant());
    var req = fixtureRequest();
    req.effect = "spawn";
    try std.testing.expectEqual(Reason.effect_denied, (try kernel.claim("generated/tool", fixtureDigest(1), req, fixtureAuthority())).record.reason);
    req = fixtureRequest();
    req.resource = "https://api.example/tenant-b/jobs/9";
    try std.testing.expectEqual(Reason.resource_denied, (try kernel.claim("generated/tool", fixtureDigest(1), req, fixtureAuthority())).record.reason);
}

test "revocation detach collection and generation changes invalidate cached claims" {
    var kernel = Kernel.init(std.testing.allocator);
    defer kernel.deinit();
    const claim_token = try ready(&kernel);
    _ = try kernel.revoke("generated/tool", fixtureDigest(1));
    try std.testing.expectEqual(Reason.revoked, (try kernel.use("generated/tool", claim_token, fixtureAuthority())).record.reason);
    try std.testing.expectEqual(Reason.detach_first, (try kernel.collect("generated/tool", fixtureDigest(1))).reason);
    _ = try kernel.detach("generated/tool", fixtureDigest(1));
    _ = try kernel.collect("generated/tool", fixtureDigest(1));
    try std.testing.expectEqual(Reason.unlisted, (try kernel.use("generated/tool", claim_token, fixtureAuthority())).record.reason);
}

test "records are deterministic facts rather than clocks or prompt prose" {
    var left = Kernel.init(std.testing.allocator);
    defer left.deinit();
    var right = Kernel.init(std.testing.allocator);
    defer right.deinit();
    const a = try left.list("generated/tool", fixtureDigest(9));
    const b = try right.list("generated/tool", fixtureDigest(9));
    try std.testing.expectEqualDeep(a, b);
}
