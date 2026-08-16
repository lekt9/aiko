//! Contract-owned retention and archive kernel.
//!
//! Storage adapters normalize their rows into `Record`.  This module alone
//! decides what may leave the live journal and publishes immutable generations
//! behind an atomic CURRENT pointer.  A generation is accepted only when its
//! checkpoint and every ordinal/digest link in its archive agree.
const std = @import("std");
const projection = @import("context_projection.zig");

pub const Kind = enum(u8) { ordinary, root, lease, settlement, citation };
pub const Record = struct {
    id: []const u8,
    parent: ?usize = null,
    kind: Kind = .ordinary,
    commit_ordinal: u64,
    payload: []const u8 = "",
    active: bool = false,
    lease_until_ms: u64 = 0,
    fence: u64 = 0,
    lease_fence: u64 = 0,
    citation_target: ?usize = null,
};

pub const ChainHead = struct { digest: [64]u8 = [_]u8{'0'} ** 64, commit_ordinal: u64 = 0 };
pub const ArchiveEntry = struct { record_index: usize, commit_ordinal: u64, previous: [64]u8, digest: [64]u8 };
pub const Plan = struct {
    allocator: std.mem.Allocator,
    retained: []bool,
    archive: []ArchiveEntry,
    prior: ChainHead,
    head: ChainHead,
    pub fn deinit(self: *Plan) void { self.allocator.free(self.retained); self.allocator.free(self.archive); self.* = undefined; }
};

pub const Error = error{ InvalidReference, InvalidOrdinal, LiveReference, Tampered, MissingGeneration, InvalidFormat, InjectedCrash, OutOfMemory };

fn hashHex(parts: []const []const u8) [64]u8 {
    var h = std.crypto.hash.sha2.Sha256.init(.{});
    for (parts) |part| { var n: [8]u8 = undefined; std.mem.writeInt(u64, &n, part.len, .little); h.update(&n); h.update(part); }
    var raw: [32]u8 = undefined; h.final(&raw); return std.fmt.bytesToHex(raw, .lower);
}
fn recordDigest(previous: [64]u8, r: Record) [64]u8 {
    var ord: [8]u8 = undefined; std.mem.writeInt(u64, &ord, r.commit_ordinal, .little);
    const kind = [_]u8{@intFromEnum(r.kind)};
    return hashHex(&.{ "contract.archive/v1", &previous, &ord, &kind, r.id, r.payload });
}

/// Produce the only legal GC plan. Roots retain their descendants. An active,
/// correctly fenced lease, a settlement, or a citation retains its ancestry
/// and descendants; citations additionally retain their referenced row.
pub fn plan(allocator: std.mem.Allocator, records: []const Record, now_ms: u64, prior: ChainHead) Error!Plan {
    var keep = allocator.alloc(bool, records.len) catch return Error.OutOfMemory;
    errdefer allocator.free(keep); @memset(keep, false);
    for (records, 0..) |r, i| {
        if (r.parent) |parent| if (parent >= records.len or parent == i) return Error.InvalidReference;
        if (r.citation_target) |target| if (target >= records.len) return Error.InvalidReference;
        if (r.commit_ordinal == 0) return Error.InvalidOrdinal;
        const active_lease = r.kind == .lease and r.active and r.lease_until_ms > now_ms and r.fence != 0 and r.lease_fence == r.fence;
        if ((r.kind == .root and r.active) or active_lease or r.kind == .settlement or r.kind == .citation) keep[i] = true;
        if (r.kind == .citation) {
            if (r.citation_target) |target| keep[target] = true else return Error.InvalidReference;
        }
    }
    // Protected rows retain ancestors. Any retained parent retains all its
    // descendants, repeated to a fixpoint independent of input ordering.
    var changed = true;
    while (changed) {
        changed = false;
        for (records, 0..) |r, i| {
            if (keep[i]) if (r.parent) |parent| if (!keep[parent]) { keep[parent] = true; changed = true; };
            if (r.parent) |parent| if (keep[parent] and !keep[i]) { keep[i] = true; changed = true; };
        }
    }
    var removed: std.ArrayList(usize) = .empty; defer removed.deinit(allocator);
    for (keep, 0..) |yes, i| if (!yes) removed.append(allocator, i) catch return Error.OutOfMemory;
    const Ctx = struct { rs: []const Record, fn less(c: @This(), a: usize, b: usize) bool { return c.rs[a].commit_ordinal < c.rs[b].commit_ordinal; } };
    std.mem.sort(usize, removed.items, Ctx{ .rs = records }, Ctx.less);
    var entries = allocator.alloc(ArchiveEntry, removed.items.len) catch return Error.OutOfMemory;
    errdefer allocator.free(entries);
    var head = prior;
    for (removed.items, 0..) |idx, n| {
        const r = records[idx];
        if (r.commit_ordinal <= head.commit_ordinal) return Error.InvalidOrdinal;
        const d = recordDigest(head.digest, r);
        entries[n] = .{ .record_index = idx, .commit_ordinal = r.commit_ordinal, .previous = head.digest, .digest = d };
        head = .{ .digest = d, .commit_ordinal = r.commit_ordinal };
    }
    return .{ .allocator = allocator, .retained = keep, .archive = entries, .prior = prior, .head = head };
}

pub fn requireCollectible(p: Plan, index: usize) Error!void {
    if (index >= p.retained.len) return Error.InvalidReference;
    if (p.retained[index]) return Error.LiveReference;
}

fn appendInt(out: *std.ArrayList(u8), a: std.mem.Allocator, v: u64) !void { var b: [8]u8 = undefined; std.mem.writeInt(u64, &b, v, .little); try out.appendSlice(a, &b); }
fn appendBytes(out: *std.ArrayList(u8), a: std.mem.Allocator, v: []const u8) !void { try appendInt(out, a, v.len); try out.appendSlice(a, v); }
fn retainedDigest(records: []const Record, p: Plan) [64]u8 {
    var h = std.crypto.hash.sha2.Sha256.init(.{});
    h.update("contract.checkpoint.retained/v1");
    for (records, 0..) |r, i| if (p.retained[i]) { h.update(r.id); h.update(r.payload); var b:[8]u8=undefined; std.mem.writeInt(u64,&b,r.commit_ordinal,.little); h.update(&b); };
    var raw:[32]u8=undefined; h.final(&raw); return std.fmt.bytesToHex(raw,.lower);
}
fn encodeArchive(a: std.mem.Allocator, records: []const Record, p: Plan) ![]u8 {
    var out: std.ArrayList(u8)=.empty; errdefer out.deinit(a); try out.appendSlice(a,"CAR1"); try appendInt(&out,a,p.prior.commit_ordinal); try out.appendSlice(a,&p.prior.digest); try appendInt(&out,a,p.archive.len);
    for (p.archive) |e| { const r=records[e.record_index]; try appendInt(&out,a,e.commit_ordinal); try out.appendSlice(a,&e.previous); try out.appendSlice(a,&e.digest); try appendBytes(&out,a,r.id); try appendBytes(&out,a,r.payload); try out.append(a,@intFromEnum(r.kind)); }
    return out.toOwnedSlice(a);
}
fn encodeCheckpoint(a: std.mem.Allocator, generation:u64, source_version:u64, records:[]const Record, p:Plan, archive_bytes:[]const u8) ![]u8 {
    var out:std.ArrayList(u8)=.empty; errdefer out.deinit(a); try out.appendSlice(a,"CCP1"); try appendInt(&out,a,generation); try appendInt(&out,a,source_version); try appendInt(&out,a,p.head.commit_ordinal); try out.appendSlice(a,&p.head.digest);
    const rd=retainedDigest(records,p); const ad=hashHex(&.{archive_bytes}); try out.appendSlice(a,&rd); try out.appendSlice(a,&ad);
    var count:u64=0; for(p.retained)|yes| { if(yes){count+=1;} } try appendInt(&out,a,count);
    for(records,0..) |r,i| { if(p.retained[i]) { try appendInt(&out,a,r.commit_ordinal); try appendBytes(&out,a,r.id); try appendBytes(&out,a,r.payload); } }
    return out.toOwnedSlice(a);
}
extern fn close(fd:c_int) c_int;
extern fn read(fd:c_int, buf:[*]u8, len:usize) isize;
extern fn write(fd:c_int, buf:[*]const u8, len:usize) isize;
extern fn fsync(fd:c_int) c_int;
extern fn mkdir(path:[*:0]const u8, mode:c_uint) c_int;
extern fn rename(old:[*:0]const u8,new:[*:0]const u8) c_int;
extern fn unlink(path:[*:0]const u8) c_int;
fn makeDirs(a:std.mem.Allocator,path:[]const u8)!void { var i:usize=1; while(i<=path.len):(i+=1) { if(i==path.len or path[i]=='/') { const z=try a.dupeZ(u8,path[0..i]); defer a.free(z); _=mkdir(z.ptr,0o755); } } }
fn writeSync(path:[]const u8, bytes:[]const u8) !void { const z=try std.heap.page_allocator.dupeZ(u8,path); defer std.heap.page_allocator.free(z); var flags:std.c.O=.{ }; flags.ACCMODE=.WRONLY; flags.CREAT=true; flags.TRUNC=true; const fd=std.c.open(z.ptr,flags,@as(c_uint,0o644)); if(fd<0)return error.OpenFailed; defer _=close(fd); var off:usize=0; while(off<bytes.len){const n=write(fd,bytes.ptr+off,bytes.len-off);if(n<=0)return error.WriteFailed;off+=@intCast(n);} if(fsync(fd)!=0)return error.SyncFailed; }
fn readAlloc(a:std.mem.Allocator,path:[]const u8,max:usize)![]u8 { const z=try a.dupeZ(u8,path);defer a.free(z);var flags:std.c.O=.{ }; flags.ACCMODE=.RDONLY; const fd=std.c.open(z.ptr,flags,@as(c_uint,0));if(fd<0)return error.FileNotFound;defer _=close(fd);var out:std.ArrayList(u8)=.empty;errdefer out.deinit(a);var b:[4096]u8=undefined;while(true){const n=read(fd,&b,b.len);if(n<0)return error.ReadFailed;if(n==0)break;try out.appendSlice(a,b[0..@intCast(n)]);if(out.items.len>max)return error.TooLarge;}return out.toOwnedSlice(a);}
pub const Crash = enum { none, before_publish, after_publish };

/// Write immutable archive/checkpoint files, then publish them with one atomic
/// CURRENT rename. Before the rename the prior generation remains authoritative;
/// after it, the new complete generation is authoritative.
pub fn publish(a:std.mem.Allocator, dir:[]const u8, generation:u64, source_version:u64, records:[]const Record, p:Plan, crash:Crash) !void {
    try makeDirs(a,dir);
    const arch=try encodeArchive(a,records,p); defer a.free(arch);
    const cp=try encodeCheckpoint(a,generation,source_version,records,p,arch); defer a.free(cp);
    const ap=try std.fmt.allocPrint(a,"{s}/archive.{d}",.{dir,generation}); defer a.free(ap);
    const cpp=try std.fmt.allocPrint(a,"{s}/checkpoint.{d}",.{dir,generation}); defer a.free(cpp);
    try writeSync(ap,arch); try writeSync(cpp,cp);
    if (crash==.before_publish) return Error.InjectedCrash;
    const tmp=try std.fmt.allocPrint(a,"{s}/CURRENT.tmp",.{dir}); defer a.free(tmp);
    const cur=try std.fmt.allocPrint(a,"{s}/CURRENT",.{dir}); defer a.free(cur);
    var gb:[32]u8=undefined; const gs=try std.fmt.bufPrint(&gb,"{d}\n",.{generation}); try writeSync(tmp,gs);
    const tz=try a.dupeZ(u8,tmp); defer a.free(tz); const cz=try a.dupeZ(u8,cur); defer a.free(cz);
    if (rename(tz.ptr,cz.ptr)!=0) return error.RenameFailed;
    if (crash==.after_publish) return Error.InjectedCrash;
}

pub const Recovered = struct { generation:u64, source_version:u64, head:ChainHead };
fn takeInt(bytes:[]const u8, off:*usize) Error!u64 { if (off.*+8>bytes.len) return Error.InvalidFormat; const v=std.mem.readInt(u64,bytes[off.*..][0..8],.little); off.*+=8; return v; }
fn takeBytes(bytes:[]const u8,off:*usize) Error![]const u8 { const n=try takeInt(bytes,off); if(n>bytes.len-off.*) return Error.InvalidFormat; const v=bytes[off.*..off.*+@as(usize,@intCast(n))]; off.*+=@intCast(n); return v; }

/// Recover exactly the generation named by CURRENT. Orphan files from a crash
/// before publication are ignored. Missing files, reordered/lost links, changed
/// payloads, or checkpoint digest mismatches are refused.
pub fn recover(a:std.mem.Allocator,dir:[]const u8) Error!Recovered {
    const curp=std.fmt.allocPrint(a,"{s}/CURRENT",.{dir}) catch return Error.OutOfMemory; defer a.free(curp);
    const cur=readAlloc(a,curp,64) catch return Error.MissingGeneration; defer a.free(cur);
    const generation=std.fmt.parseInt(u64,std.mem.trim(u8,cur," \r\n\t"),10) catch return Error.InvalidFormat;
    const ap=std.fmt.allocPrint(a,"{s}/archive.{d}",.{dir,generation}) catch return Error.OutOfMemory; defer a.free(ap);
    const cpp=std.fmt.allocPrint(a,"{s}/checkpoint.{d}",.{dir,generation}) catch return Error.OutOfMemory; defer a.free(cpp);
    const arch=readAlloc(a,ap,64*1024*1024) catch return Error.MissingGeneration; defer a.free(arch);
    const cp=readAlloc(a,cpp,4096) catch return Error.MissingGeneration; defer a.free(cp);
    if(cp.len<4+8*4+64*3 or !std.mem.eql(u8,cp[0..4],"CCP1")) return Error.InvalidFormat;
    var co:usize=4; const cg=try takeInt(cp,&co); const sv=try takeInt(cp,&co); const last=try takeInt(cp,&co); if(cg!=generation) return Error.Tampered;
    const head:[64]u8=cp[co..][0..64].*; co+=64; const expected_retained:[64]u8=cp[co..][0..64].*; co+=64; const expected_arch:[64]u8=cp[co..][0..64].*; co+=64;
    if(!std.mem.eql(u8,&expected_arch,&hashHex(&.{arch}))) return Error.Tampered;
    const retained_count=try takeInt(cp,&co); var rh=std.crypto.hash.sha2.Sha256.init(.{}); rh.update("contract.checkpoint.retained/v1"); var ri:u64=0; while(ri<retained_count):(ri+=1){const ro=try takeInt(cp,&co);const rid=try takeBytes(cp,&co);const rp=try takeBytes(cp,&co);rh.update(rid);rh.update(rp);var rb:[8]u8=undefined;std.mem.writeInt(u64,&rb,ro,.little);rh.update(&rb);} if(co!=cp.len)return Error.InvalidFormat; var rr:[32]u8=undefined;rh.final(&rr);const actual_retained=std.fmt.bytesToHex(rr,.lower);if(!std.mem.eql(u8,&expected_retained,&actual_retained))return Error.Tampered;
    if(arch.len<84 or !std.mem.eql(u8,arch[0..4],"CAR1")) return Error.InvalidFormat;
    var off:usize=4; var ordinal=try takeInt(arch,&off); const base:[64]u8=arch[off..][0..64].*; off+=64; const count=try takeInt(arch,&off); var previous:[64]u8=base;
    var n:u64=0; while(n<count):(n+=1) { const ord=try takeInt(arch,&off); if(ord<=ordinal) return Error.Tampered; if(off+128>arch.len)return Error.InvalidFormat; const claimed_prev:[64]u8=arch[off..][0..64].*; off+=64; const claimed:[64]u8=arch[off..][0..64].*; off+=64; const id=try takeBytes(arch,&off); const payload=try takeBytes(arch,&off); if(off>=arch.len)return Error.InvalidFormat; const kv=arch[off]; off+=1; if(kv>@intFromEnum(Kind.citation))return Error.InvalidFormat; const r:Record=.{.id=id,.payload=payload,.kind=@enumFromInt(kv),.commit_ordinal=ord}; if(!std.mem.eql(u8,&claimed_prev,&previous) or !std.mem.eql(u8,&claimed,&recordDigest(previous,r))) return Error.Tampered; previous=claimed; ordinal=ord; }
    if(off!=arch.len or ordinal!=last or !std.mem.eql(u8,&previous,&head)) return Error.Tampered;
    return .{.generation=generation,.source_version=sv,.head=.{.digest=head,.commit_ordinal=last}};
}

/// Equivalence predicate used at the Contract context seam. Archival may alter
/// only the citation's storage kind; identity, ordinal, field and value remain.
pub fn projectionEquivalent(before:projection.Projection, after:projection.Projection) bool {
    if(before.source_version!=after.source_version or before.items.len!=after.items.len)return false;
    for(before.items,after.items)|x,y| if(x.commit_ordinal!=y.commit_ordinal or !std.mem.eql(u8,x.citation_digest,y.citation_digest) or !std.mem.eql(u8,x.field,y.field) or !std.mem.eql(u8,x.value,y.value)) return false;
    return true;
}

fn rec(id:[]const u8,ord:u64) Record{return .{.id=id,.commit_ordinal=ord};}
test "reachability roots leases settlements and citations refuse live GC" {
    var rs=[_]Record{rec("root",1),rec("child",2),rec("expired",3),rec("leased",4),rec("settled",5),rec("evidence",6),rec("target",7),rec("dead",8)};
    rs[0].kind=.root; rs[0].active=true; rs[1].parent=0; rs[3].kind=.lease; rs[3].active=true; rs[3].lease_until_ms=50; rs[3].fence=2; rs[3].lease_fence=2; rs[4].kind=.settlement; rs[5].kind=.citation; rs[5].citation_target=6;
    var p=try plan(std.testing.allocator,&rs,10,.{}); defer p.deinit();
    for([_]usize{0,1,3,4,5,6})|i| try std.testing.expectError(Error.LiveReference,requireCollectible(p,i)); try requireCollectible(p,2); try requireCollectible(p,7);
}
test "atomic generation recovery and archive tamper loss refusal" {
    var tmp=std.testing.tmpDir(.{}); defer tmp.cleanup(); const dir=try std.fmt.allocPrint(std.testing.allocator,".zig-cache/tmp/{s}",.{tmp.sub_path}); defer std.testing.allocator.free(dir);
    const rs=[_]Record{rec("old",1)}; var p=try plan(std.testing.allocator,&rs,0,.{}); defer p.deinit();
    try publish(std.testing.allocator,dir,1,9,&rs,p,.none); try std.testing.expectEqual(@as(u64,1),(try recover(std.testing.allocator,dir)).generation);
    try std.testing.expectError(Error.InjectedCrash,publish(std.testing.allocator,dir,2,10,&rs,p,.before_publish)); try std.testing.expectEqual(@as(u64,1),(try recover(std.testing.allocator,dir)).generation);
    try std.testing.expectError(Error.InjectedCrash,publish(std.testing.allocator,dir,3,11,&rs,p,.after_publish)); try std.testing.expectEqual(@as(u64,3),(try recover(std.testing.allocator,dir)).generation);
    const ap=try std.fmt.allocPrint(std.testing.allocator,"{s}/archive.3",.{dir}); defer std.testing.allocator.free(ap); var damaged=try readAlloc(std.testing.allocator,ap,1024*1024); defer std.testing.allocator.free(damaged); const original=damaged[20]; damaged[20]=if(original=='X') 'Y' else 'X'; try writeSync(ap,damaged);
    try std.testing.expectError(Error.Tampered,recover(std.testing.allocator,dir)); damaged[20]=original; try writeSync(ap,damaged); _=try recover(std.testing.allocator,dir);
    const az=try std.testing.allocator.dupeZ(u8,ap); defer std.testing.allocator.free(az); try std.testing.expectEqual(@as(c_int,0),unlink(az.ptr)); try std.testing.expectError(Error.MissingGeneration,recover(std.testing.allocator,dir));
}


fn contextFact(kind: projection.FactKind) projection.Fact { return .{ .tenant="t", .root_id="r", .producer_role="p", .delegated_role="worker", .purpose="do", .audience="smithers", .field="answer", .value="42", .citation_digest="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", .commit_ordinal=7, .source_version=4, .kind=kind, .state=.active, .visibility=.delegated, .cited=true, .secret=false }; }
test "context projection is equivalent across live to archive compaction" {
    const ingress:projection.VerifiedIngress=.{.authenticated_subject="s",.verified_tenant="t",.audience="smithers",.granted_scopes=&.{projection.REQUIRED_SCOPE},.credential_generation="g"};
    const delegation:projection.Delegation=.{.authenticated_subject="s",.tenant="t",.role="worker",.root_id="r",.purpose="do",.audience="smithers",.credential_generation="g",.source_version=4,.allowed_fields=&.{"answer"}};
    const live=[_]projection.Fact{contextFact(.evidence_citation)}; const archived=[_]projection.Fact{contextFact(.archived_citation)};
    var before=try projection.project(std.testing.allocator,ingress,delegation,4,&live); defer before.deinit(); var after=try projection.project(std.testing.allocator,ingress,delegation,4,&archived); defer after.deinit();
    try std.testing.expect(projectionEquivalent(before,after)); try std.testing.expect(!before.items[0].archived and after.items[0].archived);
}
