//! The bridge: a neuron firing becomes a contract row that answers all six
//! interrogatives.
//!
//! This is the edge that was missing. neuron commits firings to its own
//! journal — durable, content-addressed, replayable — but that journal knows
//! nothing about *when* in wall-clock terms, *who* signed, or *why*, and it has
//! no notion of an occurrence superseding a prior answer. contract knows all
//! four and had no way to learn that a firing happened.
//!
//! WHY `declare` AND NOT `neuron.fireJson`
//!
//! contract exposes both. `fireJson` (neuron.zig:130) appends the canonical
//! firing straight to the ledger — durable, but it goes to `appendRow`
//! DIRECTLY, so it never passes the W6H gate. `declare` (contract.zig:438)
//! routes through that gate at contract.zig:651, where a row that cannot
//! project into who/what/when/where/why/how fails the WRITE with the missing
//! interrogative named.
//!
//! The whole point of bridging into contract is to gain what neuron's journal
//! does not carry. Choosing the path that skips the gate would move bytes and
//! gain nothing, so the bridge declares.
//!
//! THE PROJECTION
//!
//! Each interrogative is taken from the firing, never invented:
//!
//!   who    the node identity that committed it   (substrate device identity)
//!   what   the firing's own claim                (its evidence claim)
//!   when   the commit ORDINAL, not a clock       (see below)
//!   where  agent + artifact prefix it wrote to
//!   why    the evidence sources it cited
//!   how    the effect kinds it committed         (write | send | spawn)
//!
//! `when` is the one that looks wrong and is not. neuron hashes `now_ms` into
//! the decision digest, so a wall clock inside a stimulus gives every
//! redelivery a new identity and turns idempotent replay into `FiringMismatch`
//! (AGENTS.md §28.1). The firing therefore carries `now_ms = 0` by design, and
//! its real position in time is the journal's commit ordinal. contract stamps
//! its own `ts` at declare time; the ordinal is what makes two rows orderable
//! against each other. Reading a clock out of the firing would read zero.

const std = @import("std");
const neuron = @import("typed_neuron");
const contract = @import("contract");

pub const Error = error{
    NoSuchJournal,
    UnreadableJournal,
};

/// One firing, reduced to what a contract row needs. Everything here is read
/// out of the journal record; nothing is synthesised.
pub const Firing = struct {
    firing_id: []const u8,
    /// Commit position in the journal. This is `when`.
    seq: usize,
    claim: []const u8,
    sources: []const []const u8,
    wrote: usize,
    sent: usize,
    spawned: usize,

    /// `how` — the effect kinds actually committed, in the substrate's own
    /// closed alphabet. A firing that committed nothing is not "unknown", it
    /// is a decision that declined to act, and it says so.
    pub fn how(self: Firing, buf: []u8) []const u8 {
        var w: usize = 0;
        const parts = [_]struct { n: usize, name: []const u8 }{
            .{ .n = self.wrote, .name = "write" },
            .{ .n = self.sent, .name = "send" },
            .{ .n = self.spawned, .name = "spawn" },
        };
        for (parts) |p| {
            if (p.n == 0) continue;
            if (w != 0 and w < buf.len) {
                buf[w] = '+';
                w += 1;
            }
            const end = @min(buf.len, w + p.name.len);
            @memcpy(buf[w..end], p.name[0 .. end - w]);
            w = end;
        }
        if (w == 0) return "no-effect";
        return buf[0..w];
    }
};

/// Read committed firings out of a neuron substrate journal.
///
/// The journal is the substrate's own append-only log: one JSON record per
/// commit, in commit order. Position in that file IS the ordinal, which is why
/// this counts rather than parsing a timestamp — §28.4 established that
/// canonical form sorts by id and destroys log order, so the ordinal has to be
/// carried, not recomputed later.
pub fn readFirings(a: std.mem.Allocator, io: std.Io, state_dir: []const u8) ![]Firing {
    const path = try std.fs.path.join(a, &.{ state_dir, "substrate.log" });
    const bytes = std.Io.Dir.cwd().readFileAlloc(io, path, a, .limited(64 << 20)) catch
        return Error.NoSuchJournal;

    var out: std.ArrayList(Firing) = .empty;
    var seq: usize = 0;
    var it = std.mem.splitScalar(u8, bytes, '\n');
    while (it.next()) |line| {
        if (line.len == 0) continue;
        seq += 1;
        const parsed = std.json.parseFromSliceLeaky(std.json.Value, a, line, .{}) catch continue;
        if (parsed != .object) continue;
        const firing_id = str(parsed, "firing_id") orelse continue;

        var claim: []const u8 = "";
        var sources: std.ArrayList([]const u8) = .empty;
        if (parsed.object.get("evidence")) |ev| if (ev == .array) {
            for (ev.array.items) |e| {
                if (e != .object) continue;
                if (claim.len == 0) claim = str(e, "claim") orelse "";
                if (e.object.get("sources")) |s| if (s == .array) {
                    for (s.array.items) |src| if (src == .string) {
                        try sources.append(a, src.string);
                    };
                };
            }
        };

        try out.append(a, .{
            .firing_id = firing_id,
            .seq = seq,
            .claim = if (claim.len == 0) "firing committed without an evidence claim" else claim,
            .sources = try sources.toOwnedSlice(a),
            .wrote = countIn(parsed, "artifacts"),
            .sent = countIn(parsed, "messages"),
            .spawned = countIn(parsed, "spawns"),
        });
    }
    return out.toOwnedSlice(a);
}

fn str(v: std.json.Value, key: []const u8) ?[]const u8 {
    if (v != .object) return null;
    const f = v.object.get(key) orelse return null;
    return if (f == .string) f.string else null;
}

fn countIn(v: std.json.Value, key: []const u8) usize {
    const f = v.object.get(key) orelse return 0;
    return if (f == .array) f.array.items.len else 0;
}

/// Declare one firing into the contract ledger through the W6H gate.
///
/// Returns the contract id. Idempotent by contract's own cache: the same
/// (plan, action, cwd, parent) resolves to one row, so re-running the bridge
/// over a journal it has already mirrored appends nothing new. That property
/// is contract's, not ours — the bridge does not keep a watermark, because a
/// watermark would be a second source of truth about what has been mirrored.
pub fn declareFiring(
    a: std.mem.Allocator,
    env: std.process.Environ,
    node_id: []const u8,
    agent: []const u8,
    f: Firing,
) ![]u8 {
    var how_buf: [32]u8 = undefined;
    const how = f.how(&how_buf);

    // `what` — the truth claim this row asserts. The firing's own evidence
    // claim, never a restatement of it.
    const plan = try std.fmt.allocPrint(
        a,
        "neuron firing {s} committed: {s}",
        .{ f.firing_id, f.claim },
    );

    // `how` — the verb. Typed pointer, not prose.
    const action = try std.fmt.allocPrint(a, "neuron:firing/{s}", .{how});

    // `why` — the evidence the firing cited. A firing that grounded itself in
    // nothing says so explicitly; an empty `why` would fail the gate, and
    // filling it with a guess is the fabrication the gate exists to catch.
    const why = if (f.sources.len == 0)
        try a.dupe(u8, "firing cited no sources")
    else
        try std.mem.join(a, ",", f.sources);

    const extras = [_]contract.Field{
        .{ .key = "neuron_firing_id", .value = f.firing_id },
        // `when`: the commit ordinal. NOT a clock — see the module header.
        .{ .key = "neuron_commit_seq", .value = try std.fmt.allocPrint(a, "{d}", .{f.seq}) },
        .{ .key = "neuron_node", .value = node_id },
        .{ .key = "neuron_evidence_sources", .value = why },
        .{ .key = "neuron_effects", .value = how },
    };

    return contract.declare(a, env, plan, action, .{
        .agent = agent,
        .extras = &extras,
    });
}

comptime {
    // The bridge only makes sense while both sides speak one firing type. If
    // this ever diverges the BUILD fails here, rather than a row silently
    // describing a firing shape contract no longer understands.
    std.debug.assert(contract.neuron.FireRequest == neuron.FireRequest);
}
