//! Compatibility aliases for canonical capability semantics.

const core = @import("typed_neuron");

pub const Budget = core.Budget;
pub const Caps = core.Caps;
pub const allowsDelegation = core.allowsDelegation;
pub const fingerprint = core.fingerprint;

test "capabilities deny by default and delegation never widens" {
    const std = @import("std");
    const parent: Caps = .{
        .allow_write = true,
        .write_prefix = "artifact/",
    };
    const child: Caps = .{
        .allow_write = true,
        .write_prefix = "artifact/narrow/",
        .budget = .{ .max_writes = 1 },
    };
    try std.testing.expect(!(Caps{}).allow_write);
    try std.testing.expect(allowsDelegation(parent, child));
    var widened = child;
    widened.write_prefix = "other/";
    try std.testing.expect(!allowsDelegation(parent, widened));
}
