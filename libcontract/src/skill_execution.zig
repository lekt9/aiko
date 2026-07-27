//! Durable execution of admitted typed Neuron Skill graphs.
//!
//! Graph rows remain the program. Claiming releases only dependency-ready
//! firings; settlement gates their typed evidence and journals the canonical
//! Neuron decision. The shared module is the single projection of graph state.

const std = @import("std");
const claim = @import("skill_execution/claim.zig");
const common = @import("skill_execution/common.zig");
const settle = @import("skill_execution/settle.zig");

pub const CLAIM_SCHEMA = claim.CLAIM_SCHEMA;
pub const CLAIM_RESULT_SCHEMA = claim.CLAIM_RESULT_SCHEMA;
pub const SETTLE_SCHEMA = settle.SETTLE_SCHEMA;
pub const SETTLE_RESULT_SCHEMA = settle.SETTLE_RESULT_SCHEMA;
pub const MAX_NODES = common.MAX_NODES;
pub const MAX_ATTEMPTS = common.MAX_ATTEMPTS;
pub const Error = common.Error;

pub const graphDigest = common.graphDigest;
pub const admitGraph = common.admitGraph;
pub const claimJson = claim.claimJson;
pub const settleJson = settle.settleJson;

test {
    std.testing.refAllDecls(@This());
}
