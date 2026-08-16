#!/usr/bin/env python3
import hashlib, importlib.util, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path
sys.dont_write_bytecode = True
LIMB=Path(os.environ.get("UNBROWSE_LIMB", Path(__file__).resolve().parent.parent)).resolve()
NEURON=Path(__file__).resolve().parents[3]/"zig-out/bin/neuron"
SECRET="test-only-boundary-secret-91"
RAW_MARKER="private-payload-marker-73"
URL="https://api.example.test/v1/items?tenant=private-tenant-value"
HANDLE="cred:opaque-account-7"

def raw_digest(text): return hashlib.sha256(text.encode()).hexdigest()
def read(ref_id,schema,value):
 raw=json.dumps(value,sort_keys=True,separators=(",",":"))
 return {"id":ref_id,"schema":schema,"bytes":raw,"digest":raw_digest(raw)}
def stimulus(fid,event,prior=None):
 reads=[read("boundary/firing/"+fid,"neuron.unbrowse-boundary-event/v1",event)]
 if prior is not None:
  reads.append(read("contract/projections/unbrowse/"+event["route_id"],"contract.unbrowse-route-projection/v1",prior))
 return {"schema":"neuron.stimulus/v1","firing_id":fid,"receptor_schema":"neuron.unbrowse-boundary-event/v1","now_ms":0,"reads":reads,"permitted_reads":[r["id"] for r in reads],"messages":[]}
def fire(stim):
 p=subprocess.run([sys.executable,str(LIMB/"neurons/unbrowse.py")],input=json.dumps(stim),text=True,capture_output=True)
 try: out=json.loads(p.stdout)
 except Exception: raise AssertionError((p.returncode,p.stdout,p.stderr))
 return p.returncode,out
def projection(stim):
 rc,out=fire(stim); assert rc==0,out
 assert out["schema"]=="neuron.decision/v1" and len(out["effects"])==1,out
 ev=out["evidence"][0]
 assert set(ev["sources"])=={r["id"] for r in stim["reads"]},ev
 return json.loads(out["effects"][0]["artifact"]["bytes"])
def load_boundary():
 spec=importlib.util.spec_from_file_location("admitted_unbrowse_boundary",LIMB/"boundary.py")
 mod=importlib.util.module_from_spec(spec); sys.modules[spec.name]=mod; spec.loader.exec_module(mod); return mod
class Fixture:
 def __init__(self,bodies): self.bodies=list(bodies); self.order=[]; self.resolutions=0
 def resolver(self,handle,scope):
  self.order.append(("resolve",handle,dict(scope))); self.resolutions+=1
  assert handle==HANDLE and scope=={"scheme":"https","authority":"api.example.test","method":"GET","path":"/v1/items"}
  return SECRET
 def transport(self,url,headers):
  self.order.append(("transport",url,dict(headers)))
  assert self.order[-2][0]=="resolve" and headers["Authorization"]=="Bearer "+SECRET
  return 200,json.dumps(self.bodies.pop(0)).encode()
def admitted_digest(state):
 state.mkdir(parents=True,exist_ok=True)
 p=subprocess.run([str(NEURON),"limb","admit",str(LIMB),str(state)],text=True,capture_output=True)
 assert p.returncode==0,(p.stdout,p.stderr)
 tokens=[x for x in p.stdout.replace("("," ").replace(")"," ").split() if len(x)==64 and all(c in "0123456789abcdef" for c in x)]
 assert tokens,p.stdout
 return tokens[-1]
def main():
 b=load_boundary()
 fixture=Fixture([{"items":[{"id":1,"value":RAW_MARKER}]},{"items":[{"id":1,"value":RAW_MARKER}]}])
 obs=b.observe(URL,HANDLE,"origin-observation-1",fixture.resolver,fixture.transport).event
 sealed=json.dumps(obs,sort_keys=True)
 assert SECRET not in sealed and RAW_MARKER not in sealed and "private-tenant-value" not in sealed
 p1=projection(stimulus("projection-observe",obs))
 assert p1["status"]=="observed" and p1["promotion"] is None,p1
 # A replay carrying the observation's own firing identity cannot promote.
 same=dict(obs); same["kind"]="replay"
 psame=projection(stimulus("projection-self-replay",same,p1))
 assert psame["status"]=="demoted" and psame["demotion"]["reason"]=="replay_not_independent",psame
 # A separately issued origin read is separate evidence and earns promotion.
 rep=b.replay(URL,HANDLE,"origin-replay-2",fixture.resolver,fixture.transport).event
 p2=projection(stimulus("projection-independent-replay",rep,p1))
 assert p2["status"]=="promoted" and p2["promotion"]["independent"] is True,p2
 assert p2["promotion"]["observation_firing_id"]!=p2["promotion"]["replay_firing_id"]
 durable=json.dumps(p2,sort_keys=True)
 assert SECRET not in durable and RAW_MARKER not in durable and "private-tenant-value" not in durable
 # Matching live execution may return invocation data, never lifecycle state.
 good=Fixture([{"items":[{"id":9,"value":"fresh"}]}])
 served=b.execute(p2,URL,HANDLE,"origin-execute-3",good.resolver,good.transport)
 assert served.product["items"][0]["value"]=="fresh" and served.event is None
 # Schema drift is not served; its cited firing demotes the Contract projection.
 drift=Fixture([{"items":{"id":9}}])
 stale=b.execute(p2,URL,HANDLE,"origin-drift-4",drift.resolver,drift.transport)
 assert stale.product is None and stale.event["kind"]=="drift"
 p3=projection(stimulus("projection-drift",stale.event,p2)); assert p3["status"]=="demoted",p3
 # After demotion the resolver is not even consulted: no serve-after-drift.
 blocked=Fixture([])
 try: b.execute(p3,URL,HANDLE,"origin-after-drift",blocked.resolver,blocked.transport); raise AssertionError("served after drift")
 except b.Refusal: pass
 assert blocked.resolutions==0
 # Invalid route/handle also refuse before resolution.
 for url,handle in (("https://evil.example.test/v1/items",HANDLE),(URL,"cred:different-account")):
  blocked=Fixture([])
  try: b.execute(p2,url,handle,"scope-attack",blocked.resolver,blocked.transport); raise AssertionError("scope change crossed")
  except b.Refusal: pass
  assert blocked.resolutions==0
 # Real public admission + firing commits only the sealed projection.
 temp=Path(tempfile.mkdtemp(prefix="unbrowse-limb-gate.")); state=temp/"state"; state.mkdir()
 d1=admitted_digest(state)
 sp=temp/"observe.json"; sp.write_text(json.dumps(stimulus("admitted-observation",obs)))
 run=subprocess.run([str(NEURON),"limb","run",str(state),"--package",str(LIMB),"--neuron","unbrowse","--stimulus",str(sp),"--json"],text=True,capture_output=True)
 assert run.returncode==0,(run.stdout,run.stderr)
 assert json.loads(run.stdout)["status"]=="committed"
 journal=(state/"substrate.log").read_text()
 for forbidden in (SECRET,RAW_MARKER,"private-tenant-value"):
  assert forbidden not in journal,forbidden
 # Control planes copy/attach the same admitted bytes rather than rebuilding a Smithers variant.
 copied=temp/"unchanged-package"; shutil.copytree(LIMB,copied,ignore=shutil.ignore_patterns("__pycache__","*.pyc"))
 old=os.environ.get("UNBROWSE_LIMB")
 try:
  globals()["LIMB"]=copied
  d2=admitted_digest(temp/"copy-state")
 finally:
  globals()["LIMB"]=Path(old).resolve() if old else Path(__file__).resolve().parent.parent
 assert d1==d2,(d1,d2)
 print("unbrowse limb: digest-admitted + cited independent replay + Contract projection + request-boundary credential + sealed drift demotion: PASS")
if __name__=="__main__": main()
