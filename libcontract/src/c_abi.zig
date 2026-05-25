//! c_abi.zig — extern "C" wrappers exposing the Stage 1 verbs so non-Zig
//! callers (bash via libffi, future Python/Node bindings) can link
//! libcontract.a directly.
//!
//! Strings returned to C are NUL-terminated and must be released with
//! `contract_free`. All operations are synchronous and run on the libc
//! allocator (no caller-owned arena required).
const std = @import("std");
const contract = @import("contract.zig");

const gpa = std.heap.c_allocator;

// On POSIX with libc, `environ` is the global env-var array. Wrap it as a
// std.process.Environ.PosixBlock so contract.zig's existing API (which takes
// a std.process.Environ) works from non-Zig callers.
extern var environ: [*:null]const ?[*:0]const u8;

fn extEnv() std.process.Environ {
    var count: usize = 0;
    while (environ[count] != null) : (count += 1) {}
    // PosixBlock.slice is [:null]const ?[*:0]const u8 — a sentinel-terminated
    // slice. Cast the libc-provided pointer + length into that shape.
    const ptr: [*:null]const ?[*:0]const u8 = @ptrCast(environ);
    const slice: [:null]const ?[*:0]const u8 = ptr[0..count :null];
    return .{ .block = .{ .slice = slice } };
}

fn cstr(p: [*:0]const u8) []const u8 {
    return std.mem.span(p);
}

/// Declare a contract via the C ABI.
/// plan, action — required C strings.
/// parent_id, agent — may be NULL.
/// Returns a malloc'd C string (the 8-hex id), NULL on failure.
/// Caller MUST call contract_free on the returned pointer.
export fn contract_declare(
    plan: [*:0]const u8,
    action: [*:0]const u8,
    parent_id: ?[*:0]const u8,
    agent: ?[*:0]const u8,
) ?[*:0]u8 {
    const opts = contract.DeclareOptions{
        .parent_id = if (parent_id) |p| cstr(p) else null,
        .agent = if (agent) |a| cstr(a) else null,
        .cwd = null,
    };
    const id = contract.declare(gpa, extEnv(), cstr(plan), cstr(action), opts) catch return null;
    defer gpa.free(id);
    const out = gpa.allocSentinel(u8, id.len, 0) catch return null;
    @memcpy(out, id);
    return out.ptr;
}

/// Record an `iterated` event.
export fn contract_iterate(
    id: [*:0]const u8,
    wave: u32,
    action_exit: i32,
    action_result: [*:0]const u8,
) c_int {
    contract.recordIteration(gpa, extEnv(), cstr(id), wave, action_exit, cstr(action_result)) catch return 1;
    return 0;
}

/// Mark a contract satisfied. proof may be NULL for proof_skip cases.
export fn contract_mark_satisfied(
    id: [*:0]const u8,
    wave: u32,
    proof: ?[*:0]const u8,
) c_int {
    const proof_slice: ?[]const u8 = if (proof) |p| cstr(p) else null;
    contract.markSatisfied(gpa, extEnv(), cstr(id), wave, proof_slice) catch return 1;
    return 0;
}

/// Get all rows for an id as a NUL-terminated JSONL buffer.
/// Returns NULL on failure. Caller frees with contract_free.
export fn contract_get(id: [*:0]const u8) ?[*:0]u8 {
    const blob = contract.get(gpa, extEnv(), cstr(id)) catch return null;
    defer gpa.free(blob);
    const out = gpa.allocSentinel(u8, blob.len, 0) catch return null;
    @memcpy(out, blob);
    return out.ptr;
}

/// List all declared contracts as `<id>\t<plan>\n` lines (NUL-terminated).
/// Caller frees with contract_free.
export fn contract_list() ?[*:0]u8 {
    const blob = contract.listAll(gpa, extEnv()) catch return null;
    defer gpa.free(blob);
    const out = gpa.allocSentinel(u8, blob.len, 0) catch return null;
    @memcpy(out, blob);
    return out.ptr;
}

/// Release a buffer previously returned by one of the C ABI getters.
export fn contract_free(p: ?[*:0]u8) void {
    if (p) |ptr| {
        const slice = std.mem.span(ptr);
        const full = ptr[0 .. slice.len + 1];
        gpa.free(full);
    }
}
