//! contract-lib-shim — thin CLI wrapper around the contract Zig API used by
//! the parity tests in libcontract/. The real bash `contract` script will
//! eventually link libcontract.a via FFI; this shim is end-to-end smoke for
//! the C ABI surface before that wiring lands (Stage 2).
//!
//! Usage:
//!   contract-lib-shim declare <plan> <action> [parent_id] [agent]
//!   contract-lib-shim get <id>
//!   contract-lib-shim list
const std = @import("std");
const contract = @import("contract.zig");

// Pull the C ABI exports into the same translation unit so they're included
// in the static library when this is the entry source.
comptime {
    _ = @import("c_abi.zig");
}

fn writeFd(fd: c_int, bytes: []const u8) void {
    var rem = bytes;
    while (rem.len > 0) {
        const n = std.c.write(fd, rem.ptr, rem.len);
        if (n <= 0) return;
        rem = rem[@intCast(n)..];
    }
}

fn stdoutWrite(bytes: []const u8) void {
    writeFd(std.c.STDOUT_FILENO, bytes);
}

fn stderrWrite(bytes: []const u8) void {
    writeFd(std.c.STDERR_FILENO, bytes);
}

fn usage() void {
    stderrWrite(
        \\contract-lib-shim — Stage 1 parity shim
        \\Usage:
        \\  contract-lib-shim declare <plan> <action> [parent_id] [agent]
        \\  contract-lib-shim get <id>
        \\  contract-lib-shim list
        \\
    );
}

pub fn main(init: std.process.Init.Minimal) !u8 {
    var gpa: std.heap.DebugAllocator(.{}) = .init;
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    var arena: std.heap.ArenaAllocator = .init(allocator);
    defer arena.deinit();
    const arena_alloc = arena.allocator();
    const argv_z = try init.args.toSlice(arena_alloc);

    if (argv_z.len < 2) {
        usage();
        return 2;
    }
    const verb = argv_z[1];
    const rest = argv_z[2..];

    if (std.mem.eql(u8, verb, "declare")) {
        if (rest.len < 2) {
            usage();
            return 2;
        }
        const plan = rest[0];
        const action = rest[1];
        const parent: ?[]const u8 = if (rest.len >= 3 and rest[2].len > 0) rest[2] else null;
        const agent: ?[]const u8 = if (rest.len >= 4 and rest[3].len > 0) rest[3] else null;
        const cid = try contract.declare(allocator, init.environ, plan, action, .{
            .parent_id = parent,
            .agent = agent,
        });
        defer allocator.free(cid);
        stdoutWrite(cid);
        stdoutWrite("\n");
        return 0;
    } else if (std.mem.eql(u8, verb, "get")) {
        if (rest.len < 1) {
            usage();
            return 2;
        }
        const blob = try contract.get(allocator, init.environ, rest[0]);
        defer allocator.free(blob);
        stdoutWrite(blob);
        return if (blob.len > 0) 0 else 1;
    } else if (std.mem.eql(u8, verb, "list")) {
        const blob = try contract.listAll(allocator, init.environ);
        defer allocator.free(blob);
        stdoutWrite(blob);
        return 0;
    } else {
        stderrWrite("contract-lib-shim: unknown verb\n");
        usage();
        return 2;
    }
}
