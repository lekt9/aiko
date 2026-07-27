//! Compatibility aliases for the canonical `typed_neuron` package.
//! Runtime code imports this facade while every type remains owned by the
//! package consumed by production interpreters.

const core = @import("typed_neuron");

pub const Digest = core.Digest;
pub const Control = core.Control;
pub const ArtifactWrite = core.ArtifactWrite;
pub const Message = core.Message;
pub const Spawn = core.Spawn;
pub const Effect = core.Effect;
pub const Evidence = core.Evidence;
pub const Decision = core.Decision;
pub const Stimulus = core.Stimulus;
pub const ArtifactRef = core.ArtifactRef;
pub const Artifact = core.Artifact;
pub const digest = core.digest;

test "digest is stable and content sensitive" {
    const std = @import("std");
    try std.testing.expectEqual(digest("same"), digest("same"));
    try std.testing.expect(!std.mem.eql(u8, &digest("same"), &digest("different")));
}
