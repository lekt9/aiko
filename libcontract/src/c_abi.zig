//! c_abi.zig — extern "C" wrappers exposing the Stage 1 verbs so non-Zig
//! callers (bash via the shim binary, or a future Python/Node FFI) can link
//! libcontract.a directly.
//!
//! The wrappers allocate via the C allocator so they don't depend on a
//! caller-provided arena. Strings returned to C are NUL-terminated and must
//! be released with `contract_free`.
const std = @import("std");
const contract = @import("contract.zig");

const gpa = std.heap.c_allocator;

fn currentEnv() std.process.Environ {
    return std.process.Init.Minimal.environ_var.*;
}

// HACK for stage 1: extern callers don't have a real std.process.Environ to
// hand us, so we synthesize one off the libc `environ` global. Mirrors the
// way std.process.Init.Minimal pulls it in main().
extern var environ: [*:null]?[*:0]u8;

fn extEnv() std.process.Environ {
    // std.process.Environ wraps an `environ`-style pointer; the type lives in
    // std/process/Environ.zig as { ptr, count }. Materialize by counting.
    var count: usize = 0;
    while (environ[count] != null) : (count += 1) {}
    return std.process.Environ{ .ptr = @ptrCast(&environ[0]), .count = count };
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
    // NUL-terminated copy for C callers.
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
        // allocSentinel returns []:0]T whose underlying buffer is len+1.
        const full = ptr[0 .. slice.len + 1];
        gpa.free(full);
    }
}
