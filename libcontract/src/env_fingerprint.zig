//! env_fingerprint.zig — sanitized projection of the local cwd that travels
//! with remote aiko declarations so the Unbrowse word→tree compiler can
//! choose the right adapter family for the environment.
//!
//! Fingerprint is intentionally minimal and pattern-shaped: top-level
//! manifest filenames + top-level directory names + a handful of typed
//! environment hints. No file contents, no paths beyond cwd basename, no
//! user identifiers. Roughly: "this cwd is a Swift app with a notch" /
//! "this cwd is a Cloudflare Worker + Convex backend".
//!
//! Output is a small JSON object suitable for inclusion as one field on the
//! remote declare body. The server can ignore it; once aware, it routes
//! adapter selection.

const std = @import("std");

const c = std.c;

extern fn opendir(name: [*:0]const u8) ?*anyopaque;
extern fn closedir(dirp: *anyopaque) c_int;
extern fn readdir(dirp: *anyopaque) ?*Dirent;

// Minimal `struct dirent` layout — we only read d_name. macOS layout:
// ino(8) seekoff(8) reclen(2) namelen(2) type(1) name[1024].
// We slice from a fixed offset; fields before name are stable on darwin64.
const Dirent = extern struct {
    _opaque: [21]u8,
    name: [1024]u8,
};

/// Manifest patterns the substrate recognizes. Order matters only for output
/// determinism; presence triggers a lang-hint emission.
const KnownManifest = struct { file: []const u8, hint: []const u8 };

const known_manifests = [_]KnownManifest{
    .{ .file = "Package.swift", .hint = "swift" },
    .{ .file = "Cargo.toml", .hint = "rust" },
    .{ .file = "build.zig", .hint = "zig" },
    .{ .file = "package.json", .hint = "node" },
    .{ .file = "pnpm-lock.yaml", .hint = "node-pnpm" },
    .{ .file = "bun.lockb", .hint = "bun" },
    .{ .file = "wrangler.toml", .hint = "cloudflare-worker" },
    .{ .file = "convex.json", .hint = "convex" },
    .{ .file = "pyproject.toml", .hint = "python" },
    .{ .file = "Gemfile", .hint = "ruby" },
    .{ .file = "go.mod", .hint = "go" },
    .{ .file = "Info.plist", .hint = "darwin-bundle" },
};

/// Directory patterns that indicate higher-level structure. Surfaced in
/// addition to manifest hints so the server can recognize composed apps
/// (e.g. native/ + web/ + backend/ ⇒ multi-surface project).
const known_dirs = [_][]const u8{
    "native",
    "web",
    "backend",
    "convex",
    "worker",
    "scripts",
    ".claude",
    "src",
};

fn endsWith(haystack: []const u8, needle: []const u8) bool {
    if (needle.len > haystack.len) return false;
    return std.mem.eql(u8, haystack[haystack.len - needle.len ..], needle);
}

fn writeJsonString(out: *std.ArrayList(u8), allocator: std.mem.Allocator, s: []const u8) !void {
    try out.append(allocator, '"');
    for (s) |b| switch (b) {
        '"' => try out.appendSlice(allocator, "\\\""),
        '\\' => try out.appendSlice(allocator, "\\\\"),
        '\n' => try out.appendSlice(allocator, "\\n"),
        '\r' => try out.appendSlice(allocator, "\\r"),
        '\t' => try out.appendSlice(allocator, "\\t"),
        else => {
            if (b < 0x20) {
                var hex_buf: [8]u8 = undefined;
                const hex = try std.fmt.bufPrint(&hex_buf, "\\u{x:0>4}", .{b});
                try out.appendSlice(allocator, hex);
            } else try out.append(allocator, b);
        },
    };
    try out.append(allocator, '"');
}

/// Build a sanitized fingerprint object for `cwd`. Returns owned slice the
/// caller must free. The shape is:
///   { "cwd_basename": "...",
///     "manifests":    ["Package.swift","wrangler.toml",...],
///     "dirs":         ["native","web","backend",...],
///     "lang_hints":   ["swift","cloudflare-worker",...] }
pub fn fingerprintCwd(allocator: std.mem.Allocator, cwd: []const u8) ![]u8 {
    var manifests: std.ArrayList([]const u8) = .empty;
    defer manifests.deinit(allocator);
    var dirs: std.ArrayList([]const u8) = .empty;
    defer dirs.deinit(allocator);
    var hints: std.ArrayList([]const u8) = .empty;
    defer hints.deinit(allocator);

    const cwd_z = try allocator.dupeZ(u8, cwd);
    defer allocator.free(cwd_z);

    if (opendir(cwd_z.ptr)) |dirp| {
        defer _ = closedir(dirp);
        while (readdir(dirp)) |de| {
            // Name is null-terminated within fixed buffer.
            var name_len: usize = 0;
            while (name_len < de.name.len and de.name[name_len] != 0) name_len += 1;
            const name = de.name[0..name_len];
            if (name.len == 0) continue;
            if (name[0] == '.' and name.len <= 2) continue; // skip . and ..

            // Pattern match — manifests are exact filenames, dirs are exact basenames.
            var matched_manifest = false;
            for (known_manifests) |km| {
                if (std.mem.eql(u8, name, km.file)) {
                    try manifests.append(allocator, km.file);
                    try hints.append(allocator, km.hint);
                    matched_manifest = true;
                    break;
                }
            }
            if (matched_manifest) continue;
            for (known_dirs) |kd| {
                if (std.mem.eql(u8, name, kd)) {
                    try dirs.append(allocator, kd);
                    break;
                }
            }
        }
    }

    // Sort hints + de-duplicate (multiple manifests may share a hint).
    std.mem.sort([]const u8, hints.items, {}, ltStr);
    var i: usize = 0;
    while (i + 1 < hints.items.len) {
        if (std.mem.eql(u8, hints.items[i], hints.items[i + 1])) {
            _ = hints.orderedRemove(i + 1);
        } else i += 1;
    }

    // basename of cwd
    var basename: []const u8 = cwd;
    if (std.mem.lastIndexOfScalar(u8, cwd, '/')) |slash| {
        basename = cwd[slash + 1 ..];
    }

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.appendSlice(allocator, "{\"cwd_basename\":");
    try writeJsonString(&out, allocator, basename);
    try out.appendSlice(allocator, ",\"manifests\":[");
    for (manifests.items, 0..) |m, idx| {
        if (idx > 0) try out.append(allocator, ',');
        try writeJsonString(&out, allocator, m);
    }
    try out.appendSlice(allocator, "],\"dirs\":[");
    for (dirs.items, 0..) |d, idx| {
        if (idx > 0) try out.append(allocator, ',');
        try writeJsonString(&out, allocator, d);
    }
    try out.appendSlice(allocator, "],\"lang_hints\":[");
    for (hints.items, 0..) |h, idx| {
        if (idx > 0) try out.append(allocator, ',');
        try writeJsonString(&out, allocator, h);
    }
    try out.appendSlice(allocator, "]}");
    return try out.toOwnedSlice(allocator);
}

fn ltStr(_: void, a: []const u8, b: []const u8) bool {
    return std.mem.order(u8, a, b) == .lt;
}

test "fingerprint surfaces nothing for an empty dir" {
    const allocator = std.testing.allocator;
    // Use /tmp/empty-fp; create + cleanup.
    var tmp_buf: [256]u8 = undefined;
    const tmp = try std.fmt.bufPrint(&tmp_buf, "/tmp/aiko-fp-test-empty-{d}", .{std.time.milliTimestamp()});
    const tmp_z = try allocator.dupeZ(u8, tmp);
    defer allocator.free(tmp_z);
    _ = c.mkdir(tmp_z.ptr, 0o755);
    defer _ = c.rmdir(tmp_z.ptr);
    const fp = try fingerprintCwd(allocator, tmp);
    defer allocator.free(fp);
    try std.testing.expect(std.mem.indexOf(u8, fp, "\"manifests\":[]") != null);
    try std.testing.expect(std.mem.indexOf(u8, fp, "\"lang_hints\":[]") != null);
}
