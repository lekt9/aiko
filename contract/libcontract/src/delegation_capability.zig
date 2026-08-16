//! Contract-owned delegated capabilities.
//!
//! A grant is authority only after its append-only `issued` row is replayed.
//! Environment lineage is intentionally absent from every authorization path.
const std = @import("std");
const builtin = @import("builtin");
extern fn getentropy(buf: [*]u8, len: usize) c_int;
extern fn rand_s(value: *c_uint) c_int;

pub const SCHEMA = "contract.delegation-capability/v1";
pub const MAX_SCOPE_ITEMS: usize = 64;
pub const MAX_TEXT: usize = 512;

pub const Error = error{
    InvalidRequest, InvalidIdentity, Widening, MissingGrant, Revoked, Expired,
    WrongSubject, WrongTenant, WrongRoot, WrongParent, WrongAudience,
    StaleFence, StaleGeneration, EffectsExhausted, TamperedJournal,
    OutOfMemory, Io,
};

/// This value must be constructed from Contract's durable declared occurrence
/// and current execution lease. It is not a request DTO.
pub const VerifiedParent = struct {
    subject: []const u8,
    tenant: []const u8,
    root_id: []const u8,
    parent_occurrence: []const u8,
    execution_id: []const u8,
    lease_id: []const u8,
    fence: u64,
    expires_at_ms: u64,
    max_effects: u64,
    read_only: bool,
    effect_scopes: []const []const u8,
    resource_scopes: []const []const u8,
    credential_generation: u64,
};

pub const Request = struct {
    audience: []const u8,
    purpose: []const u8,
    expires_at_ms: u64,
    max_effects: u64,
    read_only: bool,
    effect_scopes: []const []const u8,
    resource_scopes: []const []const u8,
    credential_generation: u64,
};

/// Policy is evaluated before issuing and is intersected with the parent and
/// request. An empty scope list grants nothing, never "all".
pub const Policy = struct {
    max_expires_at_ms: u64,
    max_effects: u64,
    force_read_only: bool = false,
    effect_scopes: []const []const u8,
    resource_scopes: []const []const u8,
    max_credential_generation: u64,
};

pub const Grant = struct {
    id: [64]u8,
    subject: []const u8,
    tenant: []const u8,
    root_id: []const u8,
    parent_occurrence: []const u8,
    issuing_execution_id: []const u8,
    issuing_lease_id: []const u8,
    issuing_fence: u64,
    audience: []const u8,
    purpose: []const u8,
    expires_at_ms: u64,
    max_effects: u64,
    read_only: bool,
    effect_scopes: []const []const u8,
    resource_scopes: []const []const u8,
    credential_generation: u64,
};

pub const Adoption = struct {
    subject: []const u8,
    tenant: []const u8,
    root_id: []const u8,
    parent_occurrence: []const u8,
    audience: []const u8,
    now_ms: u64,
    current_execution_id: []const u8,
    current_lease_id: []const u8,
    current_fence: u64,
    credential_generation: u64,
    effects_already_used: u64 = 0,
};

fn validText(s: []const u8) bool { return s.len > 0 and s.len <= MAX_TEXT and std.mem.indexOfScalar(u8, s, '\n') == null; }
fn contains(haystack: []const []const u8, needle: []const u8) bool {
    for (haystack) |item| if (std.mem.eql(u8, item, needle)) return true;
    return false;
}
fn subset(child: []const []const u8, parent: []const []const u8) bool {
    if (child.len > MAX_SCOPE_ITEMS) return false;
    for (child) |item| if (!validText(item) or !contains(parent, item)) return false;
    return true;
}
fn dupScopes(a: std.mem.Allocator, scopes: []const []const u8) ![]const []const u8 {
    var out = try a.alloc([]const u8, scopes.len);
    errdefer a.free(out);
    var done: usize = 0;
    errdefer for (out[0..done]) |item| a.free(item);
    for (scopes, 0..) |item, i| { out[i] = try a.dupe(u8, item); done += 1; }
    return out;
}
fn min3(a: u64, b: u64, c: u64) u64 { return @min(a, @min(b, c)); }
fn opaqueId(random: [32]u8, parent: VerifiedParent, request: Request) [64]u8 {
    var h = std.crypto.hash.sha2.Sha256.init(.{});
    h.update("contract.delegation.opaque-id/v1"); h.update(&random);
    h.update(parent.tenant); h.update(parent.root_id); h.update(parent.parent_occurrence);
    h.update(request.audience); h.update(request.purpose);
    var raw: [32]u8 = undefined; h.final(&raw); return std.fmt.bytesToHex(raw, .lower);
}

/// Verify the issuing execution against the durable Contract ledger. The last
/// execution event for (execution_id,parent_occurrence) must be its current,
/// unexpired claim with the same lease and fence.
pub fn verifyCurrentExecution(a: std.mem.Allocator, journal: []const u8, parent: VerifiedParent, now_unix: u64) Error!void {
    var matched=false; var active=false; var lines=std.mem.tokenizeScalar(u8,journal,'\n');
    while(lines.next())|line| {
        var parsed=std.json.parseFromSlice(std.json.Value,a,line,.{}) catch continue; defer parsed.deinit(); if(parsed.value!=.object)continue; const o=parsed.value.object;
        const event=str(o,"event") orelse continue; if(!std.mem.startsWith(u8,event,"execution_"))continue;
        const id=str(o,"id") orelse continue; const occurrence=str(o,"occurrence") orelse continue;
        if(!std.mem.eql(u8,id,parent.execution_id) or !std.mem.eql(u8,occurrence,parent.parent_occurrence))continue;
        matched=true; active=false;
        if(std.mem.eql(u8,event,"execution_claimed")) {
            const lease=str(o,"lease_id") orelse continue; const fence=integer(o,"fence") orelse continue; const until=integer(o,"lease_until_unix") orelse continue;
            active=std.mem.eql(u8,lease,parent.lease_id) and fence==parent.fence and until>now_unix;
        }
    }
    if(!matched or !active)return Error.StaleFence;
}

/// Issue only from verified authority. Requests which attempt to widen a parent
/// or policy are refused rather than quietly creating misleading authority.
fn fillRandom(buf: []u8) void {
    switch (builtin.os.tag) {
        .macos, .ios, .tvos, .watchos, .freebsd, .netbsd, .openbsd, .dragonfly => std.c.arc4random_buf(buf.ptr, buf.len),
        .windows => { var off: usize = 0; while (off < buf.len) { var x: c_uint = 0; if (rand_s(&x) != 0) @panic("CSPRNG failed"); const b=std.mem.asBytes(&x); const n=@min(b.len,buf.len-off); @memcpy(buf[off..off+n],b[0..n]); off+=n; } },
        else => if (getentropy(buf.ptr, buf.len) != 0) @panic("CSPRNG failed"),
    }
}
pub fn issue(a: std.mem.Allocator, parent: VerifiedParent, request: Request, policy_bound: Policy, now_ms: u64) Error!Grant {
    var random: [32]u8 = undefined; fillRandom(&random);
    return issueWithRandom(a, parent, request, policy_bound, random, now_ms);
}

pub fn issueWithRandom(a: std.mem.Allocator, parent: VerifiedParent, request: Request, policy: Policy, random: [32]u8, now_ms: u64) Error!Grant {
    if (!validText(parent.subject) or !validText(parent.tenant) or !validText(parent.root_id) or
        !validText(parent.parent_occurrence) or !validText(parent.execution_id) or !validText(parent.lease_id) or
        parent.fence == 0 or parent.expires_at_ms <= now_ms or !validText(request.audience) or !validText(request.purpose)) return Error.InvalidIdentity;
    if (request.expires_at_ms <= now_ms or policy.max_expires_at_ms <= now_ms or request.max_effects > parent.max_effects or request.max_effects > policy.max_effects or
        request.credential_generation > parent.credential_generation or request.credential_generation > policy.max_credential_generation or
        !subset(request.effect_scopes, parent.effect_scopes) or !subset(request.effect_scopes, policy.effect_scopes) or
        !subset(request.resource_scopes, parent.resource_scopes) or !subset(request.resource_scopes, policy.resource_scopes)) return Error.Widening;
    const read_only = parent.read_only or request.read_only or policy.force_read_only;
    if (read_only and (request.max_effects != 0 or request.effect_scopes.len != 0)) return Error.Widening;
    const effects = dupScopes(a, request.effect_scopes) catch return Error.OutOfMemory;
    errdefer { for (effects) |x| a.free(x); a.free(effects); }
    const resources = dupScopes(a, request.resource_scopes) catch return Error.OutOfMemory;
    errdefer { for (resources) |x| a.free(x); a.free(resources); }
    return .{
        .id = opaqueId(random, parent, request), .subject = a.dupe(u8, parent.subject) catch return Error.OutOfMemory,
        .tenant = a.dupe(u8, parent.tenant) catch return Error.OutOfMemory, .root_id = a.dupe(u8, parent.root_id) catch return Error.OutOfMemory,
        .parent_occurrence = a.dupe(u8, parent.parent_occurrence) catch return Error.OutOfMemory,
        .issuing_execution_id = a.dupe(u8, parent.execution_id) catch return Error.OutOfMemory,
        .issuing_lease_id = a.dupe(u8, parent.lease_id) catch return Error.OutOfMemory, .issuing_fence = parent.fence,
        .audience = a.dupe(u8, request.audience) catch return Error.OutOfMemory, .purpose = a.dupe(u8, request.purpose) catch return Error.OutOfMemory,
        .expires_at_ms = min3(parent.expires_at_ms, request.expires_at_ms, policy.max_expires_at_ms),
        .max_effects = min3(parent.max_effects, request.max_effects, policy.max_effects), .read_only = read_only,
        .effect_scopes = effects, .resource_scopes = resources,
        .credential_generation = min3(parent.credential_generation, request.credential_generation, policy.max_credential_generation),
    };
}

pub fn deinitGrant(a: std.mem.Allocator, grant: *Grant) void {
    a.free(grant.subject); a.free(grant.tenant); a.free(grant.root_id); a.free(grant.parent_occurrence);
    a.free(grant.issuing_execution_id); a.free(grant.issuing_lease_id); a.free(grant.audience); a.free(grant.purpose);
    for (grant.effect_scopes) |x| a.free(x); a.free(grant.effect_scopes);
    for (grant.resource_scopes) |x| a.free(x); a.free(grant.resource_scopes); grant.* = undefined;
}

pub fn adopt(grant: *const Grant, revoked: bool, request: Adoption) Error!*const Grant {
    if (revoked) return Error.Revoked;
    if (request.now_ms >= grant.expires_at_ms) return Error.Expired;
    if (!std.mem.eql(u8, request.subject, grant.subject)) return Error.WrongSubject;
    if (!std.mem.eql(u8, request.tenant, grant.tenant)) return Error.WrongTenant;
    if (!std.mem.eql(u8, request.root_id, grant.root_id)) return Error.WrongRoot;
    if (!std.mem.eql(u8, request.parent_occurrence, grant.parent_occurrence)) return Error.WrongParent;
    if (!std.mem.eql(u8, request.audience, grant.audience)) return Error.WrongAudience;
    if (!std.mem.eql(u8, request.current_execution_id, grant.issuing_execution_id) or
        !std.mem.eql(u8, request.current_lease_id, grant.issuing_lease_id) or request.current_fence != grant.issuing_fence) return Error.StaleFence;
    if (request.credential_generation != grant.credential_generation) return Error.StaleGeneration;
    if (request.effects_already_used > grant.max_effects) return Error.EffectsExhausted;
    return grant;
}

/// Append-only persistence. Revocation never edits an issued row.
pub fn appendIssued(file: std.fs.File, grant: Grant) !void {
    var wbuf: [4096]u8 = undefined; var fw = file.writer(&wbuf); const w = &fw.interface;
    try std.json.Stringify.value(.{ .schema = SCHEMA, .event = "issued", .grant_id = grant.id[0..], .subject = grant.subject,
        .tenant = grant.tenant, .root_id = grant.root_id, .parent_occurrence = grant.parent_occurrence,
        .issuing_execution_id = grant.issuing_execution_id, .issuing_lease_id = grant.issuing_lease_id, .issuing_fence = grant.issuing_fence,
        .audience = grant.audience, .purpose = grant.purpose, .expires_at_ms = grant.expires_at_ms, .max_effects = grant.max_effects,
        .read_only = grant.read_only, .effect_scopes = grant.effect_scopes, .resource_scopes = grant.resource_scopes,
        .credential_generation = grant.credential_generation }, .{}, w);
    try w.writeByte('\n'); try w.flush();
}
pub fn appendRevoked(file: std.fs.File, grant_id: [64]u8, subject: []const u8, tenant: []const u8, root_id: []const u8, now_ms: u64) !void {
    if (!validText(subject) or !validText(tenant) or !validText(root_id)) return Error.InvalidIdentity;
    var wbuf: [1024]u8 = undefined; var fw = file.writer(&wbuf); const w = &fw.interface;
    try std.json.Stringify.value(.{ .schema = SCHEMA, .event = "revoked", .grant_id = grant_id[0..], .subject = subject, .tenant = tenant, .root_id = root_id, .revoked_at_ms = now_ms }, .{}, w);
    try w.writeByte('\n'); try w.flush();
}

fn str(o: std.json.ObjectMap, key: []const u8) ?[]const u8 { const v=o.get(key) orelse return null; return if(v==.string) v.string else null; }
fn integer(o: std.json.ObjectMap, key: []const u8) ?u64 { const v=o.get(key) orelse return null; return if(v==.integer and v.integer>=0) @intCast(v.integer) else null; }
fn boolValue(o: std.json.ObjectMap, key: []const u8) ?bool { const v=o.get(key) orelse return null; return if(v==.bool) v.bool else null; }
fn parseScopes(a: std.mem.Allocator, o: std.json.ObjectMap, key: []const u8) ![]const []const u8 {
    const v=o.get(key) orelse return Error.TamperedJournal; if(v!=.array or v.array.items.len>MAX_SCOPE_ITEMS) return Error.TamperedJournal;
    var out=try a.alloc([]const u8,v.array.items.len); errdefer a.free(out); var n:usize=0; errdefer for(out[0..n])|x|a.free(x);
    for(v.array.items,0..) |item,i| { if(item!=.string or !validText(item.string)) return Error.TamperedJournal; out[i]=try a.dupe(u8,item.string); n+=1; } return out;
}
/// Replay the append-only journal and adopt only an actually-issued, unrevoked
/// row. A request or environment variable can never synthesize row existence.
pub fn adoptJournal(a: std.mem.Allocator, journal: []const u8, grant_id: [64]u8, request: Adoption) Error!Grant {
    var found:?Grant=null; errdefer if(found)|*g|deinitGrant(a,g); var revoked=false;
    var lines=std.mem.tokenizeScalar(u8,journal,'\n'); while(lines.next())|line| {
        var parsed=std.json.parseFromSlice(std.json.Value,a,line,.{}) catch return Error.TamperedJournal; defer parsed.deinit();
        if(parsed.value!=.object) return Error.TamperedJournal; const o=parsed.value.object;
        const schema=str(o,"schema") orelse continue; if(!std.mem.eql(u8,schema,SCHEMA)) continue;
        const id_text=str(o,"grant_id") orelse return Error.TamperedJournal; if(!std.mem.eql(u8,id_text,&grant_id)) continue;
        const event=str(o,"event") orelse return Error.TamperedJournal;
        if(std.mem.eql(u8,event,"revoked")) { if(found==null) return Error.TamperedJournal; revoked=true; continue; }
        if(!std.mem.eql(u8,event,"issued") or found!=null) return Error.TamperedJournal;
        const es=try parseScopes(a,o,"effect_scopes"); errdefer {for(es)|x|a.free(x);a.free(es);} const rs=try parseScopes(a,o,"resource_scopes");
        found=.{.id=grant_id,.subject=try a.dupe(u8,str(o,"subject") orelse return Error.TamperedJournal),.tenant=try a.dupe(u8,str(o,"tenant") orelse return Error.TamperedJournal),.root_id=try a.dupe(u8,str(o,"root_id") orelse return Error.TamperedJournal),.parent_occurrence=try a.dupe(u8,str(o,"parent_occurrence") orelse return Error.TamperedJournal),.issuing_execution_id=try a.dupe(u8,str(o,"issuing_execution_id") orelse return Error.TamperedJournal),.issuing_lease_id=try a.dupe(u8,str(o,"issuing_lease_id") orelse return Error.TamperedJournal),.issuing_fence=integer(o,"issuing_fence") orelse return Error.TamperedJournal,.audience=try a.dupe(u8,str(o,"audience") orelse return Error.TamperedJournal),.purpose=try a.dupe(u8,str(o,"purpose") orelse return Error.TamperedJournal),.expires_at_ms=integer(o,"expires_at_ms") orelse return Error.TamperedJournal,.max_effects=integer(o,"max_effects") orelse return Error.TamperedJournal,.read_only=boolValue(o,"read_only") orelse return Error.TamperedJournal,.effect_scopes=es,.resource_scopes=rs,.credential_generation=integer(o,"credential_generation") orelse return Error.TamperedJournal};
    }
    var result=found orelse return Error.MissingGrant; _=try adopt(&result,revoked,request); return result;
}

fn fixture() VerifiedParent { return .{ .subject="subject", .tenant="tenant", .root_id="root", .parent_occurrence="parent", .execution_id="exec", .lease_id="lease", .fence=7, .expires_at_ms=1000, .max_effects=3, .read_only=false, .effect_scopes=&.{"send","write"}, .resource_scopes=&.{"repo:a","repo:b"}, .credential_generation=4 }; }
fn fixturePolicy() Policy { return .{ .max_expires_at_ms=900, .max_effects=2, .effect_scopes=&.{"send"}, .resource_scopes=&.{"repo:a"}, .max_credential_generation=3 }; }
test "issue is bounded intersection and opaque" {
    const a=std.testing.allocator; const req: Request=.{.audience="child",.purpose="test",.expires_at_ms=800,.max_effects=2,.read_only=false,.effect_scopes=&.{"send"},.resource_scopes=&.{"repo:a"},.credential_generation=3};
    var g=try issueWithRandom(a,fixture(),req,fixturePolicy(),[_]u8{9}**32,1); defer deinitGrant(a,&g);
    try std.testing.expectEqual(@as(u64,800),g.expires_at_ms); try std.testing.expectEqual(@as(u64,2),g.max_effects);
    try std.testing.expect(!std.mem.eql(u8,&g.id,"parent"));
    var wide=req; wide.effect_scopes=&.{"write"}; try std.testing.expectError(Error.Widening,issueWithRandom(a,fixture(),wide,fixturePolicy(),[_]u8{1}**32,1));
}
test "adoption refuses every forged authority dimension" {
    const a=std.testing.allocator; const req: Request=.{.audience="child",.purpose="test",.expires_at_ms=800,.max_effects=2,.read_only=false,.effect_scopes=&.{"send"},.resource_scopes=&.{"repo:a"},.credential_generation=3};
    var g=try issueWithRandom(a,fixture(),req,fixturePolicy(),[_]u8{8}**32,1); defer deinitGrant(a,&g);
    var x: Adoption=.{.subject="subject",.tenant="tenant",.root_id="root",.parent_occurrence="parent",.audience="child",.now_ms=2,.current_execution_id="exec",.current_lease_id="lease",.current_fence=7,.credential_generation=3};
    _=try adopt(&g,false,x); x.tenant="other"; try std.testing.expectError(Error.WrongTenant,adopt(&g,false,x)); x.tenant="tenant"; x.root_id="other"; try std.testing.expectError(Error.WrongRoot,adopt(&g,false,x)); x.root_id="root"; x.current_fence=8; try std.testing.expectError(Error.StaleFence,adopt(&g,false,x)); x.current_fence=7; x.credential_generation=4; try std.testing.expectError(Error.StaleGeneration,adopt(&g,false,x)); try std.testing.expectError(Error.Revoked,adopt(&g,true,x));
}
test "read-only parent cannot mint effects" {
    var p=fixture(); p.read_only=true; const req: Request=.{.audience="child",.purpose="test",.expires_at_ms=800,.max_effects=1,.read_only=true,.effect_scopes=&.{"send"},.resource_scopes=&.{"repo:a"},.credential_generation=3};
    try std.testing.expectError(Error.Widening,issueWithRandom(std.testing.allocator,p,req,fixturePolicy(),[_]u8{0}**32,1));
}

test "durable execution and issued row are authority, env lineage is not" {
    const a=std.testing.allocator; const req:Request=.{.audience="child",.purpose="test",.expires_at_ms=800,.max_effects=2,.read_only=false,.effect_scopes=&.{"send"},.resource_scopes=&.{"repo:a"},.credential_generation=3};
    var g=try issueWithRandom(a,fixture(),req,fixturePolicy(),[_]u8{7}**32,1); defer deinitGrant(a,&g);
    const execution="{\"event\":\"execution_claimed\",\"id\":\"exec\",\"occurrence\":\"parent\",\"lease_id\":\"lease\",\"fence\":7,\"lease_until_unix\":50}\n";
    try verifyCurrentExecution(a,execution,fixture(),10); try std.testing.expectError(Error.StaleFence,verifyCurrentExecution(a,execution,fixture(),60));
    const journal=try std.fmt.allocPrint(a,"{{\"schema\":\"{s}\",\"event\":\"issued\",\"grant_id\":\"{s}\",\"subject\":\"subject\",\"tenant\":\"tenant\",\"root_id\":\"root\",\"parent_occurrence\":\"parent\",\"issuing_execution_id\":\"exec\",\"issuing_lease_id\":\"lease\",\"issuing_fence\":7,\"audience\":\"child\",\"purpose\":\"test\",\"expires_at_ms\":800,\"max_effects\":2,\"read_only\":false,\"effect_scopes\":[\"send\"],\"resource_scopes\":[\"repo:a\"],\"credential_generation\":3}}\n",.{SCHEMA,g.id}); defer a.free(journal);
    const adoption:Adoption=.{.subject="subject",.tenant="tenant",.root_id="root",.parent_occurrence="parent",.audience="child",.now_ms=2,.current_execution_id="exec",.current_lease_id="lease",.current_fence=7,.credential_generation=3};
    var replayed=try adoptJournal(a,journal,g.id,adoption); defer deinitGrant(a,&replayed);
    const revoked=try std.fmt.allocPrint(a,"{s}{{\"schema\":\"{s}\",\"event\":\"revoked\",\"grant_id\":\"{s}\"}}\n",.{journal,SCHEMA,g.id}); defer a.free(revoked);
    try std.testing.expectError(Error.Revoked,adoptJournal(a,revoked,g.id,adoption));
}
