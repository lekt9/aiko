//! route_bench.zig — a reproducible, HONEST benchmark for the learned energy router.
//!
//! Run standalone (prints a report; NOT in `zig build test` so it can print freely,
//! and ReleaseFast so the BERT forward pass is quick):
//!   zig test libcontract/src/route_bench.zig -OReleaseFast
//!
//! It measures routing accuracy on a labeled (goal → binary) dataset with proper
//! held-out evaluation, against real baselines. It uses the SAME embedding + energy
//! model the production router uses (bge.zig — the baked BERT), PURE LEDGER: there is
//! no lexicon seed, so a binary is a candidate only via its trained goals — exactly
//! what route.zig does now. Each distinct goal is embedded ONCE up front (bge is
//! ~ms/embed); LOO then reuses the cached vectors.
//!
//! NOTE on candidates: with the hardcoded lexicon removed, the git-lfs/gh distractors
//! (which had zero goals and only existed as cold-start seeds) are gone — this is a
//! 6-way problem now, not 8-way. So the headline % is NOT directly comparable to the
//! old 8-way seeded number; random is 1/6 (16.7%), not 1/8.
//!
//! Metrics: leave-one-out accuracy, baselines (random, keyword), per-binary, learning
//! curve at k = 1,2,3,5, and a 1-NN comparison (same embedding, different aggregation).

const std = @import("std");
const bge = @import("bge.zig");

const Example = struct { goal: []const u8, bin: []const u8 };

// Only binaries that have labeled goals — PURE LEDGER has no seeded distractors.
const BINS = [_][]const u8{ "git", "docker", "grep", "curl", "npm", "tar" };

// A labeled dataset of natural-language goals, phrased as a user would (rarely naming
// the binary), so keyword-matching mostly fails and the model must route by meaning.
const DATA = [_]Example{
    // git
    .{ .goal = "commit my changes to the repository", .bin = "git" },
    .{ .goal = "record my latest edits", .bin = "git" },
    .{ .goal = "create a new feature branch", .bin = "git" },
    .{ .goal = "push my work to the remote", .bin = "git" },
    .{ .goal = "check what has changed since the last save", .bin = "git" },
    .{ .goal = "roll back to a previous version", .bin = "git" },
    .{ .goal = "view the history of commits", .bin = "git" },
    .{ .goal = "merge one line of development into another", .bin = "git" },
    .{ .goal = "stage files before saving a snapshot", .bin = "git" },
    // docker
    .{ .goal = "build a container image from a file", .bin = "docker" },
    .{ .goal = "start a new container from an image", .bin = "docker" },
    .{ .goal = "list the containers that are running", .bin = "docker" },
    .{ .goal = "stop a running container", .bin = "docker" },
    .{ .goal = "pull an image from a registry", .bin = "docker" },
    .{ .goal = "show the logs of a container", .bin = "docker" },
    .{ .goal = "remove an unused container", .bin = "docker" },
    .{ .goal = "list all the images stored locally", .bin = "docker" },
    .{ .goal = "run a command inside a container", .bin = "docker" },
    // grep
    .{ .goal = "search the files for a keyword", .bin = "grep" },
    .{ .goal = "find every line that matches a pattern", .bin = "grep" },
    .{ .goal = "look through the source for a symbol", .bin = "grep" },
    .{ .goal = "hunt for a phrase across the whole tree", .bin = "grep" },
    .{ .goal = "locate where a word appears in the code", .bin = "grep" },
    .{ .goal = "scan the project for a piece of text", .bin = "grep" },
    .{ .goal = "match lines against a regular expression", .bin = "grep" },
    .{ .goal = "which files contain this string", .bin = "grep" },
    .{ .goal = "find occurrences of a term recursively", .bin = "grep" },
    // curl
    .{ .goal = "download a file from a web address", .bin = "curl" },
    .{ .goal = "make an http request to a server", .bin = "curl" },
    .{ .goal = "fetch the contents of a web page", .bin = "curl" },
    .{ .goal = "send a post request to an api endpoint", .bin = "curl" },
    .{ .goal = "retrieve some json data over the network", .bin = "curl" },
    .{ .goal = "call a rest api and print the response", .bin = "curl" },
    .{ .goal = "grab a resource from a url", .bin = "curl" },
    .{ .goal = "hit a health endpoint over https", .bin = "curl" },
    .{ .goal = "upload a payload to a remote service", .bin = "curl" },
    // npm
    .{ .goal = "install the project dependencies", .bin = "npm" },
    .{ .goal = "add a new package to the project", .bin = "npm" },
    .{ .goal = "run the build script for the app", .bin = "npm" },
    .{ .goal = "start the local development server", .bin = "npm" },
    .{ .goal = "execute the test suite via the package manager", .bin = "npm" },
    .{ .goal = "update the installed libraries", .bin = "npm" },
    .{ .goal = "publish the package to the registry", .bin = "npm" },
    .{ .goal = "remove a dependency from the project", .bin = "npm" },
    .{ .goal = "list the outdated packages", .bin = "npm" },
    // tar
    .{ .goal = "create a compressed archive of a folder", .bin = "tar" },
    .{ .goal = "extract the contents of a tarball", .bin = "tar" },
    .{ .goal = "unpack a gzip compressed archive", .bin = "tar" },
    .{ .goal = "bundle a directory into a single file", .bin = "tar" },
    .{ .goal = "compress a set of files for transfer", .bin = "tar" },
    .{ .goal = "list the files inside an archive", .bin = "tar" },
    .{ .goal = "decompress a bundle to disk", .bin = "tar" },
    .{ .goal = "package up a release as an archive", .bin = "tar" },
    .{ .goal = "roll several files into one compressed blob", .bin = "tar" },
};

const SEM = bge.DIM;

fn binIndex(bin: []const u8) usize {
    for (BINS, 0..) |b, i| if (std.mem.eql(u8, b, bin)) return i;
    unreachable;
}

// ── embedding cache: embed each goal exactly once ──
var goal_vecs: [DATA.len][SEM]f32 = undefined;
fn precompute() void {
    for (DATA, 0..) |ex, i| bge.embed(ex.goal, &goal_vecs[i]);
}

// The router's semantic centroid (mirror route.zig's SemProto), folding PRE-EMBEDDED
// vectors so the benchmark doesn't re-run the BERT thousands of times.
const Proto = struct {
    mean: [SEM]f32 = [_]f32{0} ** SEM,
    w: f64 = 0,
    fn foldVec(self: *Proto, v: []const f32, reward: f64) void {
        const w_new = self.w + reward;
        if (@abs(w_new) < 1e-9) {
            self.mean = [_]f32{0} ** SEM;
            self.w = 0;
            return;
        }
        const a: f32 = @floatCast(reward / w_new);
        for (&self.mean, 0..) |*m, i| m.* += a * (v[i] - m.*);
        self.w = w_new;
    }
    fn energyVec(self: Proto, v: []const f32) f64 {
        if (self.w <= 0) return std.math.inf(f64);
        return -@as(f64, bge.cosine(v, &self.mean));
    }
};

fn route(protos: *const [BINS.len]Proto, v: []const f32) ?usize {
    var best: ?usize = null;
    var best_e: f64 = std.math.inf(f64);
    for (protos, 0..) |p, i| {
        const e = p.energyVec(v);
        if (e < best_e) {
            best_e = e;
            best = i;
        }
    }
    return best;
}

const LooResult = struct { overall: f64, per_bin: [BINS.len]f64 };

fn looAccuracy() LooResult {
    var ok: usize = 0;
    var bin_ok = [_]usize{0} ** BINS.len;
    var bin_tot = [_]usize{0} ** BINS.len;
    for (DATA, 0..) |test_ex, ti| {
        var protos = [_]Proto{.{}} ** BINS.len;
        for (DATA, 0..) |tr, tri| {
            if (tri == ti) continue;
            protos[binIndex(tr.bin)].foldVec(&goal_vecs[tri], 1.0);
        }
        const want = binIndex(test_ex.bin);
        bin_tot[want] += 1;
        if (route(&protos, &goal_vecs[ti])) |r| if (r == want) {
            ok += 1;
            bin_ok[want] += 1;
        };
    }
    var per: [BINS.len]f64 = undefined;
    for (0..BINS.len) |i| per[i] = if (bin_tot[i] == 0) 0 else 100.0 * @as(f64, @floatFromInt(bin_ok[i])) / @as(f64, @floatFromInt(bin_tot[i]));
    return .{ .overall = 100.0 * @as(f64, @floatFromInt(ok)) / DATA.len, .per_bin = per };
}

/// Train the FIRST k goals of each binary; test on that binary's remaining goals.
fn curveAccuracy(k: usize) f64 {
    var protos = [_]Proto{.{}} ** BINS.len;
    var count = [_]usize{0} ** BINS.len;
    for (DATA, 0..) |ex, i| {
        const bi = binIndex(ex.bin);
        if (count[bi] < k) {
            protos[bi].foldVec(&goal_vecs[i], 1.0);
            count[bi] += 1;
        }
    }
    var ok: usize = 0;
    var tot: usize = 0;
    var seen = [_]usize{0} ** BINS.len;
    for (DATA, 0..) |ex, i| {
        const bi = binIndex(ex.bin);
        defer seen[bi] += 1;
        if (seen[bi] < k) continue;
        tot += 1;
        if (route(&protos, &goal_vecs[i])) |r| if (r == bi) {
            ok += 1;
        };
    }
    return if (tot == 0) 0 else 100.0 * @as(f64, @floatFromInt(ok)) / @as(f64, @floatFromInt(tot));
}

fn knnLoo() f64 {
    var ok: usize = 0;
    for (DATA, 0..) |test_ex, ti| {
        const want = binIndex(test_ex.bin);
        var best_c: f32 = -2;
        var best_bin: usize = 0;
        for (DATA, 0..) |tr, tri| {
            if (tri == ti) continue;
            const c = bge.cosine(&goal_vecs[ti], &goal_vecs[tri]);
            if (c > best_c) {
                best_c = c;
                best_bin = binIndex(tr.bin);
            }
        }
        if (best_bin == want) ok += 1;
    }
    return 100.0 * @as(f64, @floatFromInt(ok)) / DATA.len;
}

test "BENCHMARK — learned energy router accuracy vs baselines (pure ledger)" {
    const P = std.debug.print;
    precompute();

    P("\n══════════ ROUTER BENCHMARK (bge-small baked BERT · PURE LEDGER) ══════════\n", .{});
    P("  dataset: {d} goals across {d} candidate binaries (all learned from the ledger, no lexicon seed)\n\n", .{ DATA.len, BINS.len });

    var kw_hit: usize = 0;
    for (DATA) |ex| {
        if (std.mem.indexOf(u8, ex.goal, ex.bin) != null) kw_hit += 1;
    }
    P("  baseline · random            : {d:.1}%\n", .{100.0 / @as(f64, BINS.len)});
    P("  baseline · keyword-in-goal   : {d:.1}%  (goals rarely name the binary)\n", .{100.0 * @as(f64, @floatFromInt(kw_hit)) / DATA.len});

    const loo = looAccuracy();
    P("\n  LEAVE-ONE-OUT (every goal held out, trained on the other {d}):\n", .{DATA.len - 1});
    P("    learned centroid (pure ledger) : {d:.1}%   ← production config\n", .{loo.overall});

    P("\n  per-binary (LOO):\n", .{});
    for (BINS, 0..) |b, i| P("    {s: <8}: {d:.0}%\n", .{ b, loo.per_bin[i] });

    P("\n  LEARNING CURVE (train k goals/binary, test on the rest):\n", .{});
    for ([_]usize{ 1, 2, 3, 5 }) |k| P("    k={d}: {d:.1}%\n", .{ k, curveAccuracy(k) });

    P("\n  1-NN (nearest training goal), LOO : {d:.1}%   ← vs {d:.1}% centroid\n", .{ knnLoo(), loo.overall });
    P("\n═══════════════════════════════════════════════════════════\n", .{});

    // HONEST witness — pure-ledger, 6-way (random 16.7%). The baked BERT clears every
    // baseline by a wide margin; numbers the data supports, no fabricated green.
    try std.testing.expect(loo.overall > 100.0 / @as(f64, BINS.len) * 3.0); // > 3× random
    try std.testing.expect(loo.overall >= 85.0); // a real learned embedder on 6-way
}
