//! spirit.zig — biblical doctrine corpus + per-file attestation verifier.
//!
//! The build refuses to produce a binary unless every .zig source file
//! under `libcontract/src/` and `zig/src/` carries a current PASS row
//! in `.contract-spirit-attest.jsonl`, signed by the root /contract
//! wallet. The verdict is produced by an LLM judge (`aiko attest`)
//! evaluating each file's structure against:
//!
//!   ORDER — the 10 commandments (Exodus 20:1-17). The order layer of
//!   the substrate. What MUST NOT be present in shipped code.
//!
//!   SPIRIT — the 7 fruits of the spirit (Galatians 5:22-23, first 7
//!   of the 9-fruit list). The spirit layer. What MUST be present in
//!   shipped code.
//!
//! "By their fruits ye shall know them" (Matt 7:16). The LLM is the
//! eye that knows; the root wallet is the hand that signs; the build
//! is the gate that refuses entry without both.
//!
//! NOTE on layering: this file's checks live OUTSIDE the comptime
//! `pattern.assertInvariants()` block in pattern.zig because they
//! depend on filesystem state (attestation ledger) and are necessarily
//! runtime. Pattern (1..6/7/8 layer surface) is enforced at compile-
//! time inside the source; spirit (doctrinal alignment of each file)
//! is enforced at build-time via the spirit-check binary RunStep.

const std = @import("std");
const ledger = @import("ledger.zig");
const lineage = @import("lineage.zig");

pub const SpiritError = error{
    UnattestedSource,
    SourceUnreadable,
    LedgerUnreadable,
    NoAttestationLedger,
    AttestationSignatureInvalid,
    AttestationVerdictNotPass,
    OutOfMemory,
};

/// Ten Commandments (Exodus 20:1-17). The ORDER axis — what shipped
/// code must not violate. Used both as prompt context for the LLM
/// judge and as documentation surfaced by `aiko self --doctrine`.
pub const COMMANDMENTS = [10][]const u8{
    "no other gods before me — singular truth-root, not split among substrates",
    "no graven images — no abstraction worshipped over substance",
    "do not take the name in vain — no empty invocations, no painted gates",
    "remember the sabbath — every cycle reaches a verdict day, not endless loops",
    "honor father and mother — lineage respected, parent contracts never orphaned",
    "do not kill — do not destroy what gives life to downstream callers",
    "do not commit adultery — no mixing of incompatible substrates in one row",
    "do not steal — no taking what isn't attributable; proper provenance always",
    "do not bear false witness — honest evidence; no fake-green, no painted PASS",
    "do not covet — no scope creep beyond the declared truth claim",
};

/// Seven fruits of the spirit (Galatians 5:22-23, first 7). The SPIRIT
/// axis — what shipped code must embody. The full list has 9; we use
/// the canonical first 7 per Lewis's spec. "Against such there is no
/// law" (Gal 5:23) — code bearing these fruits passes the gate.
pub const FRUITS = [7][]const u8{
    "love — care for the downstream caller, the on-call engineer, the future reader",
    "joy — code that delights when it succeeds; clear PASS surfaces, not silent ok-results",
    "peace — graceful degradation; honest failure rather than panicked aborts",
    "patience — bounded retries, exponential backoff, the right to wait without burning",
    "kindness — error messages that teach, not shame; surface actionable next steps",
    "goodness — does what it says; the action matches the plan",
    "faithfulness — append-only ledger; once written, the truth is preserved",
};

/// Source files the spirit-check binary walks. Paths are relative to
/// the repo root (parent of both `libcontract/` and `zig/`). Adding a
/// new .zig file to either tree REQUIRES adding it here AND attesting
/// it — there is no "auto-discover via filesystem walk" because that
/// would create an escape hatch (drop a file in, gate doesn't know).
pub const SOURCE_FILES = [_][]const u8{
    "libcontract/src/contract.zig",
    "libcontract/src/pointer.zig",
    "libcontract/src/ledger.zig",
    "libcontract/src/lineage.zig",
    "libcontract/src/id.zig",
    "libcontract/src/fractal.zig",
    "libcontract/src/words.zig",
    "libcontract/src/pattern.zig",
    "libcontract/src/spirit.zig",
    "libcontract/src/http.zig",
    "libcontract/src/keystore.zig",
    "libcontract/src/cache.zig",
    "libcontract/src/guards.zig",
    "libcontract/src/payload_crypto.zig",
    "libcontract/src/env_fingerprint.zig",
    "libcontract/src/client.zig",
    "libcontract/src/bible.zig",
    "libcontract/src/verses.zig",
    "libcontract/src/c_abi.zig",
    "libcontract/src/shim.zig",
    "zig/src/main.zig",
    "zig/src/id.zig",
    "zig/src/ledger.zig",
    "zig/src/pointer.zig",
};

/// Compute the 64-char hex SHA256 of a file's bytes. Returns owned
/// slice (caller frees) on success. Caller-side failures (missing
/// file, read errors) bubble up unchanged.
pub fn sourceSha256(allocator: std.mem.Allocator, abs_path: []const u8) ![]u8 {
    const path_z = try allocator.dupeZ(u8, abs_path);
    defer allocator.free(path_z);
    var flags: std.c.O = .{};
    flags.ACCMODE = .RDONLY;
    const fd: c_int = std.c.open(path_z.ptr, flags, @as(c_uint, 0));
    if (fd < 0) return SpiritError.SourceUnreadable;
    defer _ = std.c.close(fd);

    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    var buf: [8192]u8 = undefined;
    while (true) {
        const n = std.c.read(fd, &buf, buf.len);
        if (n <= 0) break;
        hasher.update(buf[0..@intCast(n)]);
    }
    var digest: [32]u8 = undefined;
    hasher.final(&digest);

    const hex_chars = "0123456789abcdef";
    var hex_buf: [64]u8 = undefined;
    for (digest, 0..) |b, i| {
        hex_buf[i * 2] = hex_chars[b >> 4];
        hex_buf[i * 2 + 1] = hex_chars[b & 0x0F];
    }
    return try allocator.dupe(u8, &hex_buf);
}

/// Resolve the attestation ledger path. Lives at <repo-root>/.contract-
/// spirit-attest.jsonl. Repo root is found by walking up from the cwd
/// until both `libcontract/` and `zig/` are present as siblings.
pub fn attestationLedgerPath(allocator: std.mem.Allocator) ![]u8 {
    var cwd_buf: [4096]u8 = undefined;
    const cwd_ptr = std.c.getcwd(&cwd_buf, cwd_buf.len);
    if (cwd_ptr == null) return SpiritError.NoAttestationLedger;
    var cwd: []const u8 = std.mem.span(@as([*:0]const u8, @ptrCast(cwd_ptr.?)));

    while (cwd.len > 1) {
        const libc_probe = try std.fs.path.join(allocator, &.{ cwd, "libcontract" });
        defer allocator.free(libc_probe);
        const zig_probe = try std.fs.path.join(allocator, &.{ cwd, "zig" });
        defer allocator.free(zig_probe);
        if (isDir(allocator, libc_probe) and isDir(allocator, zig_probe)) {
            return try std.fs.path.join(allocator, &.{ cwd, ".contract-spirit-attest.jsonl" });
        }
        // Walk up.
        const slash = std.mem.lastIndexOfScalar(u8, cwd, '/') orelse break;
        if (slash == 0) cwd = "/" else cwd = cwd[0..slash];
    }
    return SpiritError.NoAttestationLedger;
}

extern fn opendir(name: [*:0]const u8) ?*anyopaque;
extern fn closedir(dirp: *anyopaque) c_int;

fn isDir(allocator: std.mem.Allocator, path: []const u8) bool {
    const z = allocator.dupeZ(u8, path) catch return false;
    defer allocator.free(z);
    const d = opendir(z.ptr);
    if (d == null) return false;
    _ = closedir(d.?);
    return true;
}

/// Slurp the attestation ledger. Returns owned bytes; empty if file
/// missing. Distinct from a missing ledger DIR — that's caught earlier.
fn readAttestationLedger(allocator: std.mem.Allocator) ![]u8 {
    const path = try attestationLedgerPath(allocator);
    defer allocator.free(path);
    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);
    var flags: std.c.O = .{};
    flags.ACCMODE = .RDONLY;
    const fd: c_int = std.c.open(path_z.ptr, flags, @as(c_uint, 0));
    if (fd < 0) return try allocator.alloc(u8, 0);
    defer _ = std.c.close(fd);

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    var buf: [8192]u8 = undefined;
    while (true) {
        const n = std.c.read(fd, &buf, buf.len);
        if (n <= 0) break;
        try out.appendSlice(allocator, buf[0..@intCast(n)]);
        if (out.items.len > 32 * 1024 * 1024) break;
    }
    return try out.toOwnedSlice(allocator);
}

/// Naive single-key JSON string extractor (slice into input, no alloc).
fn extractString(line: []const u8, key: []const u8) ?[]const u8 {
    var needle_buf: [128]u8 = undefined;
    const needle = std.fmt.bufPrint(&needle_buf, "\"{s}\": \"", .{key}) catch return null;
    const start = std.mem.indexOf(u8, line, needle) orelse return null;
    const value_start = start + needle.len;
    var i: usize = value_start;
    while (i < line.len) : (i += 1) {
        if (line[i] == '\\') {
            i += 1;
            continue;
        }
        if (line[i] == '"') return line[value_start..i];
    }
    return null;
}

/// Verify that `source_path` has a current PASS attestation. Current =
/// the row's `source_sha256` matches the file's current sha. The row's
/// `signature` must be a valid ed25519 sig by the root wallet over the
/// canonical digest `attest|<source_path>|<source_sha256>|PASS`. The
/// LATEST matching row wins (append-only ledger; a later row supersedes).
pub fn verifyAttestation(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    source_path: []const u8,
) !void {
    _ = env;
    // Resolve absolute source path (relative-to-repo → absolute).
    const ledger_path = try attestationLedgerPath(allocator);
    defer allocator.free(ledger_path);
    const repo_root = std.fs.path.dirname(ledger_path) orelse return SpiritError.NoAttestationLedger;
    const abs_source = try std.fs.path.join(allocator, &.{ repo_root, source_path });
    defer allocator.free(abs_source);

    const want_sha = try sourceSha256(allocator, abs_source);
    defer allocator.free(want_sha);

    const data = try readAttestationLedger(allocator);
    defer allocator.free(data);

    var latest_verdict: ?[]const u8 = null;
    var latest_sig: ?[]const u8 = null;
    var line_it = std.mem.splitScalar(u8, data, '\n');
    while (line_it.next()) |line| {
        if (line.len < 2) continue;
        const evt = extractString(line, "event") orelse continue;
        if (!std.mem.eql(u8, evt, "spirit_attested")) continue;
        const path_in_row = extractString(line, "file") orelse continue;
        if (!std.mem.eql(u8, path_in_row, source_path)) continue;
        const sha_in_row = extractString(line, "source_sha256") orelse continue;
        if (!std.mem.eql(u8, sha_in_row, want_sha)) continue;
        latest_verdict = extractString(line, "verdict");
        latest_sig = extractString(line, "signature");
    }

    if (latest_verdict == null) return SpiritError.UnattestedSource;
    if (!std.mem.eql(u8, latest_verdict.?, "PASS"))
        return SpiritError.AttestationVerdictNotPass;
    if (latest_sig == null or latest_sig.?.len == 0)
        return SpiritError.AttestationSignatureInvalid;

    // Signature verification: HMAC the canonical digest with the root
    // pubkey and check. lineage.zig owns the ed25519 surface.
    var canonical_buf: std.ArrayList(u8) = .empty;
    defer canonical_buf.deinit(allocator);
    try canonical_buf.appendSlice(allocator, "attest|");
    try canonical_buf.appendSlice(allocator, source_path);
    try canonical_buf.append(allocator, '|');
    try canonical_buf.appendSlice(allocator, want_sha);
    try canonical_buf.appendSlice(allocator, "|PASS");

    var digest: [32]u8 = undefined;
    var h = std.crypto.hash.sha2.Sha256.init(.{});
    h.update(canonical_buf.items);
    h.final(&digest);

    // Derive root pubkey from the same seed used everywhere else.
    // The env arg threads through from the caller (build-time gate
    // hands its `init.environ`; runtime callers pass theirs); we never
    // synthesize an empty Environ struct since std.process.Environ
    // requires a `block` field that only the process-loader populates.
    const root_key = lineage.loadOrInitRootKey(allocator, env_caller) catch
        return SpiritError.AttestationSignatureInvalid;
    const root_kp = lineage.deriveKeyPair(root_key, "") catch
        return SpiritError.AttestationSignatureInvalid;
    var root_pubkey_hex: [lineage.PUBKEY_HEX_LEN]u8 = undefined;
    lineage.bytesToHex(&root_kp.public_key.bytes, &root_pubkey_hex);

    lineage.verifyDigest(latest_sig.?, &root_pubkey_hex, digest) catch
        return SpiritError.AttestationSignatureInvalid;
}

/// Verify every file in SOURCE_FILES. Returns the first failing path
/// (caller-owned) plus the error code so the caller can render a
/// targeted diagnostic. Empty path on success.
pub const VerifyAllResult = struct {
    err: ?SpiritError,
    failing_path: ?[]u8, // owned; null on success or non-source-specific error
};

pub fn verifyAllAttested(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
) !VerifyAllResult {
    for (SOURCE_FILES) |p| {
        if (verifyAttestation(allocator, env, p)) |_| {
            continue;
        } else |e| {
            return .{
                .err = switch (e) {
                    error.UnattestedSource => SpiritError.UnattestedSource,
                    error.SourceUnreadable => SpiritError.SourceUnreadable,
                    error.LedgerUnreadable => SpiritError.LedgerUnreadable,
                    error.NoAttestationLedger => SpiritError.NoAttestationLedger,
                    error.AttestationSignatureInvalid => SpiritError.AttestationSignatureInvalid,
                    error.AttestationVerdictNotPass => SpiritError.AttestationVerdictNotPass,
                    error.OutOfMemory => SpiritError.OutOfMemory,
                    else => SpiritError.UnattestedSource,
                },
                .failing_path = try allocator.dupe(u8, p),
            };
        }
    }
    return .{ .err = null, .failing_path = null };
}

// ─────────────────────────────────────────────────────────────────────
// Tests

test "COMMANDMENTS has exactly 10 entries" {
    try std.testing.expectEqual(@as(usize, 10), COMMANDMENTS.len);
    for (COMMANDMENTS) |c| try std.testing.expect(c.len > 0);
}

test "FRUITS has exactly 7 entries" {
    try std.testing.expectEqual(@as(usize, 7), FRUITS.len);
    for (FRUITS) |f| try std.testing.expect(f.len > 0);
}

test "SOURCE_FILES is non-empty and includes self" {
    try std.testing.expect(SOURCE_FILES.len > 0);
    var found_self = false;
    for (SOURCE_FILES) |p| {
        if (std.mem.endsWith(u8, p, "spirit.zig")) found_self = true;
    }
    try std.testing.expect(found_self);
}

test "extractString picks out JSON string values" {
    const line = "{\"event\": \"spirit_attested\", \"file\": \"libcontract/src/spirit.zig\", \"verdict\": \"PASS\"}";
    try std.testing.expectEqualStrings("spirit_attested", extractString(line, "event").?);
    try std.testing.expectEqualStrings("libcontract/src/spirit.zig", extractString(line, "file").?);
    try std.testing.expectEqualStrings("PASS", extractString(line, "verdict").?);
    try std.testing.expect(extractString(line, "missing") == null);
}
