//! energy.zig — pure structural energy scorer for typed neuron firing candidates.
//
// This is the Zig implementation of the EBM-style recommendation function.
// It is a pure module intended for use inside router/planner neurons or
// as the core of a generative EnergyRouter limb.
//
// Lower energy is always better. The function is deterministic and has no
// side effects. It consumes only the observable attributes of a candidate
// firing (grounding, evidence strength, cost, settlement distance, violations).
//
// It does NOT live in the substrate. Substrate only stores the scored
// outcomes as normal ArtifactWrites.

const std = @import("std");

/// Core energy of one firing candidate.
/// Mirrors the reference Python implementation for cross-language fidelity.
pub fn firingEnergy(
    grounding_ok: bool,
    evidence_conf_milli: u16,
    normalized_cost: f64,
    settlement_distance: f64,
    violations: u32,
) f64 {
    var e: f64 = 0.0;

    // Grounding violation is expensive (structural requirement).
    e += if (grounding_ok) 0.0 else 3.0;

    // Weak evidence is penalized. 1000 milli = perfect confidence.
    const conf: f64 = @floatFromInt(evidence_conf_milli);
    e += @max(0.0, (1000.0 - conf) / 250.0);

    // Direct cost term (already normalized 0..1 from budgets).
    e += normalized_cost * 2.0;

    // How far the overall plan/frontier is from settlement.
    e += settlement_distance;

    // Explicit violations (schema, policy, etc.).
    e += @as(f64, @floatFromInt(violations)) * 2.5;

    return e;
}

/// Breakdown of the energy for audit / EnergyScore artifacts.
pub const EnergyComponents = struct {
    grounding_penalty: f64,
    evidence_penalty: f64,
    cost_penalty: f64,
    settlement_penalty: f64,
    violation_penalty: f64,
    total: f64,
};

pub fn firingEnergyComponents(
    grounding_ok: bool,
    evidence_conf_milli: u16,
    normalized_cost: f64,
    settlement_distance: f64,
    violations: u32,
) EnergyComponents {
    const g: f64 = if (grounding_ok) @as(f64, 0.0) else @as(f64, 3.0);
    const conf: f64 = @floatFromInt(evidence_conf_milli);
    const ev = @max(0.0, (1000.0 - conf) / 250.0);
    const c = normalized_cost * 2.0;
    const s = settlement_distance;
    const v = @as(f64, @floatFromInt(violations)) * 2.5;

    return .{
        .grounding_penalty = g,
        .evidence_penalty = ev,
        .cost_penalty = c,
        .settlement_penalty = s,
        .violation_penalty = v,
        .total = g + ev + c + s + v,
    };
}

/// Lightweight candidate description for routers.
/// The `id` is an opaque identifier owned by the caller (e.g. neuron identity,
/// work-item ref, or a digest string). The scorer does not interpret it.
pub const FiringCandidate = struct {
    id: []const u8,
    grounding_ok: bool,
    evidence_conf_milli: u16,
    normalized_cost: f64,
    settlement_distance: f64,
    violations: u32 = 0,
};

pub const ScoredCandidate = struct {
    energy: f64,
    candidate: FiringCandidate,
};

/// Returns the candidate with the lowest energy, or null for empty input.
/// Ties are broken by first occurrence (stable, deterministic).
pub fn chooseLowestEnergy(candidates: []const FiringCandidate) ?ScoredCandidate {
    if (candidates.len == 0) return null;

    var best_energy = firingEnergy(
        candidates[0].grounding_ok,
        candidates[0].evidence_conf_milli,
        candidates[0].normalized_cost,
        candidates[0].settlement_distance,
        candidates[0].violations,
    );
    var best_idx: usize = 0;

    for (candidates[1..], 1..) |c, i| {
        const e = firingEnergy(
            c.grounding_ok,
            c.evidence_conf_milli,
            c.normalized_cost,
            c.settlement_distance,
            c.violations,
        );
        if (e < best_energy) {
            best_energy = e;
            best_idx = i;
        }
    }

    return .{
        .energy = best_energy,
        .candidate = candidates[best_idx],
    };
}

// -----------------------------------------------------------------------------
// Reference cases (must stay in sync with the Python seed and docs)

test "firing energy reference values" {
    // context-narrow (strong evidence, modest cost)
    const e1 = firingEnergy(true, 920, 0.15, 0.4, 0);
    try std.testing.expectApproxEqAbs(e1, 1.02, 0.015);

    // spawn-micro-ebm (slightly weaker evidence, very low settlement distance)
    const e2 = firingEnergy(true, 880, 0.25, 0.1, 0);
    try std.testing.expectApproxEqAbs(e2, 1.08, 0.015);

    // router-heuristic (weaker evidence + higher cost + high settlement)
    const e3 = firingEnergy(true, 710, 0.35, 1.2, 0);
    try std.testing.expectApproxEqAbs(e3, 3.06, 0.015);
}

test "chooseLowestEnergy selects lowest and is stable on ties" {
    const cands = [_]FiringCandidate{
        .{ .id = "router-heuristic", .grounding_ok = true, .evidence_conf_milli = 710, .normalized_cost = 0.35, .settlement_distance = 1.2 },
        .{ .id = "context-narrow", .grounding_ok = true, .evidence_conf_milli = 920, .normalized_cost = 0.15, .settlement_distance = 0.4 },
        .{ .id = "spawn-micro-ebm", .grounding_ok = true, .evidence_conf_milli = 880, .normalized_cost = 0.25, .settlement_distance = 0.1 },
    };

    const best = chooseLowestEnergy(&cands) orelse unreachable;
    try std.testing.expectEqualStrings("context-narrow", best.candidate.id);
    try std.testing.expectApproxEqAbs(best.energy, 1.02, 0.015);
}

test "empty candidates returns null" {
    const empty: []const FiringCandidate = &.{};
    try std.testing.expect(chooseLowestEnergy(empty) == null);
}

test "grounding violation dominates" {
    // Perfect good case (max confidence, zero cost/settlement/violations).
    const good = firingEnergy(true, 1000, 0.0, 0.0, 0);
    const bad = firingEnergy(false, 1000, 0.0, 0.0, 0);
    // Grounding alone must contribute the full 3.0 base penalty.
    try std.testing.expect(bad > good + 2.0);
}

test "components add up to total" {
    const comps = firingEnergyComponents(true, 800, 0.2, 0.5, 1);
    const manual = comps.grounding_penalty +
        comps.evidence_penalty +
        comps.cost_penalty +
        comps.settlement_penalty +
        comps.violation_penalty;
    try std.testing.expectApproxEqAbs(comps.total, manual, 1e-9);
}
