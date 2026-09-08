import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ConnectorEngine, connectorStorePrefix, type ConnectorStore, type SecureBrowserAdapter } from "../src/connectors.ts";

class Store implements ConnectorStore {
  rows=new Map<string,unknown>();writes=0;
  async get(key:string){return structuredClone(this.rows.get(key));}
  getSync(key:string){return structuredClone(this.rows.get(key));}
  async set(key:string,value:unknown){this.writes++;this.rows.set(key,structuredClone(value));}
  async list(prefix:string){return [...this.rows].filter(([key])=>key.startsWith(prefix)).map(([,value])=>structuredClone(value));}
}
const id="11111111-1111-4111-8111-111111111111";
function fixture(native=true){
  const store=new Store();let externalCalls=0;
  const denied=async():Promise<never>=>{externalCalls++;throw Error("Must not call private browser, provider, or events");};
  const secureBrowser:SecureBrowserAdapter={native,begin:denied,status:denied,control:denied,readContext:denied,disconnect:denied};
  const engine=new ConnectorEngine({owner:"123",store,secureBrowser,env:{},fetch:denied,onEvent:denied});
  const row={id,owner:"123",connectorId:"browser:example.com",provider:"browser",status:"connected",createdAt:Date.now(),expiresAt:Date.now()-1,
    browserVerification:{verified:true,revision:7,expiresAt:Date.now()+60000},
    authorizationUrl:"https://private.example/secret-token",credentialReference:{managerId:"private-manager",reference:"private-password-reference"},authId:"private-auth-id",importedUsername:"private-name"};
  // Existing ConnectorEngine uses this exact owner-prefixed store key.
  store.rows.set(`${connectorStorePrefix("123")}connection:${id}`,row);
  return {store,engine,row,externalCalls:()=>externalCalls};
}
test("watch authority reads committed native revision and expiry without any browser/provider operations",async()=>{
  const f=fixture();
  expect(await f.engine.browserWatchAuthority(id)).toEqual({owner:"123",connectionId:id,domain:"example.com",revision:7,expiresAt:f.row.browserVerification.expiresAt,status:"connected",native:true});
  const first=await f.engine.browserWatchAuthorities();expect(first).toHaveLength(1);expect(JSON.stringify(first)).not.toContain("private");
  first[0]!.revision=999;expect((await f.engine.browserWatchAuthority(id))!.revision).toBe(7);
  f.row.browserVerification.revision=8;expect((await f.engine.browserWatchAuthority(id))!.revision).toBe(8);
  expect(f.externalCalls()).toBe(0);expect(f.store.writes).toBe(0);
});
test("expired, stale-status, unverified, malformed, foreign and non-browser records never grant watch authority",async()=>{
  const f=fixture();const original=structuredClone(f.row);
  const invalid=[{status:"pending"},{status:"disconnected"},{status:"failed"},{provider:"arcade"},{owner:"456"},{connectorId:"browser:127.0.0.1"},
    {browserVerification:{verified:true,revision:0,expiresAt:Date.now()+60000}},
    {browserVerification:{verified:true,revision:7.5,expiresAt:Date.now()+60000}},
    {browserVerification:{verified:false,revision:7,expiresAt:Date.now()+60000}},
    {browserVerification:{verified:true,revision:7,expiresAt:Date.now()-1}},
    {browserVerification:{verified:true,revision:7,expiresAt:Number.POSITIVE_INFINITY}}];
  for(const patch of invalid){
    f.store.rows.set(`${connectorStorePrefix("123")}connection:${id}`,{...original,...patch});
    if("owner" in patch)await expect(f.engine.browserWatchAuthority(id)).rejects.toThrow("unavailable");
    else expect(await f.engine.browserWatchAuthority(id)).toBeUndefined();
    expect(await f.engine.browserWatchAuthorities()).toEqual([]);
  }
  expect(f.externalCalls()).toBe(0);expect(f.store.writes).toBe(0);
  await expect(f.engine.browserWatchAuthority("../../bob")).rejects.toThrow("unavailable");
});
test("external-vault provenance remains distinguishable and read-only discovery never renews expired native records",async()=>{
  const external=fixture(false);expect((await external.engine.browserWatchAuthority(id))!.native).toBe(false);
  const native=fixture();native.row.browserVerification.expiresAt=Date.now()-1;
  expect(await native.engine.browserWatchAuthorities()).toEqual([]);
  expect(await native.engine.browserWatchAuthority(id)).toBeUndefined();
  expect(native.row.status).toBe("connected");expect(native.externalCalls()).toBe(0);expect(native.store.writes).toBe(0);
});

test("commit authority rejects revocation, revision drift and expiry after a successful async proof",async()=>{
  const f=fixture(),proof=(await f.engine.browserWatchAuthority(id))!;
  const current=()=>{
    const authority=f.engine.browserWatchCommitAuthority(id);
    return !!authority&&authority.native&&authority.owner===proof.owner&&authority.domain===proof.domain&&authority.revision===proof.revision;
  };
  expect(current()).toBe(true);
  f.row.browserVerification.revision++;expect(current()).toBe(false);
  expect(f.engine.browserWatchCommitAuthority(id)?.revision).toBe(proof.revision+1);
  f.row.browserVerification.revision=proof.revision;f.row.status="disconnected";expect(current()).toBe(false);
  f.row.status="connected";
  const clock=spyOn(Date,"now").mockImplementation(()=>proof.expiresAt);
  try{expect(current()).toBe(false);}finally{clock.mockRestore();}
  expect(f.externalCalls()).toBe(0);expect(f.store.writes).toBe(0);
});

test("commit authority fails closed for missing, failed or async storage and exact owned key mismatches",async()=>{
  const f=fixture(),key=`${connectorStorePrefix("123")}connection:${id}`,original=structuredClone(f.row);
  expect(f.engine.browserWatchCommitAuthority(id)).toEqual(await f.engine.browserWatchAuthority(id));
  const getSync=f.store.getSync.bind(f.store);
  for(const read of [undefined,()=>{throw Error("read failed");},()=>Promise.resolve(original),()=>({...original,then:()=>{}})]){
    Object.assign(f.store,{getSync:read});
    expect(f.engine.browserWatchCommitAuthority(id)).toBeUndefined();
  }
  Object.assign(f.store,{getSync});
  for(const patch of [{owner:"456"},{id:"22222222-2222-4222-8222-222222222222"},{status:"pending"},
    {provider:"arcade"},{connectorId:"browser:127.0.0.1"},{browserVerification:{verified:true,revision:0,expiresAt:Date.now()+60000}}]){
    f.store.rows.set(key,{...original,...patch});expect(f.engine.browserWatchCommitAuthority(id)).toBeUndefined();
  }
  f.store.rows.delete(key);expect(f.engine.browserWatchCommitAuthority(id)).toBeUndefined();
  expect(f.engine.browserWatchCommitAuthority("../../foreign")).toBeUndefined();
  expect(f.externalCalls()).toBe(0);expect(f.store.writes).toBe(0);
});

test("commit authority reads persisted SQLite state inside the native transaction across engine reconstruction",async()=>{
  const db=new Database(":memory:");
  try{
    db.exec("CREATE TABLE connector_authority(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    const f=fixture(),key=`${connectorStorePrefix("123")}connection:${id}`;
    const write=(value:unknown)=>db.query("INSERT OR REPLACE INTO connector_authority VALUES(?,?)").run(key,JSON.stringify(value));
    const getSync=(key:string)=>{
      const row=db.query("SELECT value FROM connector_authority WHERE key=?").get(key) as {value:string}|null;
      return row?JSON.parse(row.value):undefined;
    };
    let externalCalls=0;
    const denied=async():Promise<never>=>{externalCalls++;throw Error("No browser work during authority checks");};
    const store:ConnectorStore={get:async key=>getSync(key),getSync,set:async(_key,value)=>{write(value);},list:async()=>[]};
    const make=()=>new ConnectorEngine({owner:"123",store,secureBrowser:{native:true,begin:denied,status:denied,control:denied,readContext:denied,disconnect:denied}});
    write(f.row);let engine=make();const proof=(await engine.browserWatchAuthority(id))!;
    expect(proof.revision).toBe(7);
    db.transaction(()=>{
      write({...f.row,browserVerification:{...f.row.browserVerification,revision:8}});
      expect(engine.browserWatchCommitAuthority(id)?.revision).toBe(8);
    })();
    engine=make();expect(engine.browserWatchCommitAuthority(id)?.revision).toBe(8);
    db.transaction(()=>{
      write({...f.row,status:"disconnected"});
      expect(engine.browserWatchCommitAuthority(id)).toBeUndefined();
    })();
    expect(make().browserWatchCommitAuthority(id)).toBeUndefined();
    expect(externalCalls).toBe(0);
  }finally{db.close();}
});
