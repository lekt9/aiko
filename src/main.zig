//! aiko — the harness entry point.
//!
//! This binary is the first thing in the repository that links BOTH layers in
//! one process: `typed_neuron` (the firing primitive and its canonical types)
//! and `contract` (the durable ledger, W6H, occurrence invalidation). Until the
//! module export landed beside it, a Zig consumer could only reach contract
//! through the C ABI — marshalling a struct out to C and back to arrive at a
//! type both ends already agree on, since `contract.FireRequest` IS
//! `typed_neuron.FireRequest`.
//!
//! `doctor` exists to make that seam falsifiable rather than assumed: it calls
//! into each layer and reports what each one answers. If the link is not real,
//! this does not compile; if a layer's identity moves, the output changes.

const std = @import("std");
const neuron = @import("typed_neuron");
const contract = @import("contract");

pub fn main(init: std.process.Init) !void {
    var buf: [4096]u8 = undefined;
    var w = std.Io.File.stdout().writerStreaming(init.io, &buf);
    const out = &w.interface;

    // Proof the shared type is genuinely shared, checked at comptime: if these
    // ever diverge the build fails here rather than at a wire boundary during
    // a firing, which is the expensive place to find out.
    comptime std.debug.assert(contract.neuron.FireRequest == neuron.FireRequest);

    try out.print("aiko — meta-fractal harness (MCP surface for Hermes)\n\n", .{});
    try out.print("  neuron    core={s}\n", .{neuron.CORE_VERSION});
    try out.print("            hash_profile={s}\n", .{neuron.HASH_PROFILE});
    try out.print("            schema_digest={s}\n", .{neuron.SCHEMA_DIGEST});
    try out.print("  contract  w6h={s}\n", .{@typeName(contract.w6h.W6H)});
    try out.print("            FireRequest shared with neuron: yes (comptime-checked)\n", .{});
    try out.print("\nThe six interrogatives a contract row must answer or be refused:\n", .{});
    // Filter to the interrogatives themselves: W6HError also carries carrier
    // failures (OutOfMemory, BadJson, NotDeclared) which are not questions a
    // row failed to answer, and listing them under that heading would overstate
    // what the gate checks.
    inline for (@typeInfo(contract.w6h.W6HError).error_set.?) |e| {
        if (comptime std.mem.startsWith(u8, e.name, "Missing")) {
            try out.print("  {s}\n", .{e.name});
        }
    }
    try out.flush();
}
