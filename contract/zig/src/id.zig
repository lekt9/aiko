//! 8-hex-lowercase id generation via libc arc4random_buf (BSD/macOS) /
//! getentropy (Linux). Zig 0.16 dropped the top-level std.crypto.random
//! convenience, but every modern POSIX has a stable userspace CSPRNG hook.
//!
//! Mirrors contract_core.declare(): `cid = str(uuid.uuid4())[:8]` — 4 random
//! bytes hex-encoded lowercase = exactly 8 hex chars.
const std = @import("std");
const builtin = @import("builtin");

fn fillRandom(buf: []u8) void {
    switch (builtin.os.tag) {
        .macos, .ios, .tvos, .watchos, .freebsd, .netbsd, .openbsd, .dragonfly => {
            std.c.arc4random_buf(buf.ptr, buf.len);
        },
        else => {
            // Linux / others — use getentropy via libc.
            _ = std.c.getentropy(buf.ptr, buf.len);
        },
    }
}

/// Allocates an 8-byte slice owned by the caller. Caller frees.
pub fn generateId(allocator: std.mem.Allocator) ![]u8 {
    var raw: [4]u8 = undefined;
    fillRandom(&raw);
    const out = try allocator.alloc(u8, 8);
    const hex = "0123456789abcdef";
    for (raw, 0..) |byte, i| {
        out[i * 2] = hex[(byte >> 4) & 0xF];
        out[i * 2 + 1] = hex[byte & 0xF];
    }
    return out;
}

test "generateId produces 8 lowercase hex chars" {
    const allocator = std.testing.allocator;
    const id = try generateId(allocator);
    defer allocator.free(id);
    try std.testing.expect(id.len == 8);
    for (id) |c| {
        try std.testing.expect((c >= '0' and c <= '9') or (c >= 'a' and c <= 'f'));
    }
}
