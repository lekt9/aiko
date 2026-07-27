const std = @import("std");
const types = @import("types.zig");

pub const Candidate = struct {
    name: []const u8,
    version: []const u8,
    bytes: []const u8,
    pinned_digest: types.Digest,
    signature_verified: bool,
    scan_passed: bool,
    contract_tests_passed: bool,
    requests_authority: bool = false,
};

pub const Admitted = struct {
    version: []u8,
    digest: types.Digest,
};

/// Skills are inert data until every admission witness passes. Admission never
/// grants runtime authority; that remains a separate capability decision.
pub const Registry = struct {
    allocator: std.mem.Allocator,
    packages: std.StringHashMap(Admitted),

    pub fn init(allocator: std.mem.Allocator) Registry {
        return .{
            .allocator = allocator,
            .packages = std.StringHashMap(Admitted).init(allocator),
        };
    }

    pub fn deinit(self: *Registry) void {
        var iterator = self.packages.iterator();
        while (iterator.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
            self.allocator.free(entry.value_ptr.version);
        }
        self.packages.deinit();
    }

    pub fn admit(self: *Registry, candidate: Candidate) !void {
        if (candidate.name.len == 0 or candidate.version.len == 0) return error.InvalidPackage;
        if (!std.mem.eql(u8, &types.digest(candidate.bytes), &candidate.pinned_digest))
            return error.PinMismatch;
        if (!candidate.signature_verified) return error.SignatureRequired;
        if (!candidate.scan_passed) return error.ScanFailed;
        if (!candidate.contract_tests_passed) return error.ContractTestsFailed;
        if (candidate.requests_authority) return error.AmbientAuthorityDenied;
        if (self.packages.contains(candidate.name)) return error.PackageAlreadyAdmitted;
        const name = try self.allocator.dupe(u8, candidate.name);
        errdefer self.allocator.free(name);
        const version = try self.allocator.dupe(u8, candidate.version);
        errdefer self.allocator.free(version);
        try self.packages.put(name, .{ .version = version, .digest = candidate.pinned_digest });
    }

    /// Retires an admitted package: the digest is no longer attachable and a
    /// future admission must pass the full witness gauntlet again (§30).
    pub fn revoke(self: *Registry, name: []const u8) bool {
        const entry = self.packages.fetchRemove(name) orelse return false;
        self.allocator.free(entry.key);
        self.allocator.free(entry.value.version);
        return true;
    }
};
