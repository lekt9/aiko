#!/usr/bin/env python3
import copy, hashlib, hmac, importlib.util, json, os, subprocess, sys, tempfile
sys.dont_write_bytecode = True
from pathlib import Path
LIMB=Path(__file__).resolve().parent.parent
NEURON=LIMB.parent.parent/"zig-out/bin/neuron"
spec=importlib.util.spec_from_file_location("webhook_boundary",LIMB/"boundary.py")
w=importlib.util.module_from_spec(spec); spec.loader.exec_module(w)
BODY=b'{"event":"worker.confirmed","worker_id":"synthetic-7"}'
SECRET=b'test-only-credential-not-durable'
IP="93.184.216.34"
def resolver(host,port,type=None): return [(2,1,6,"",(IP,port))]
def plan(effect="effect-0123456789abcdef"):
 return {"schema":"neuron.webhook-plan/v1","effect_id":effect,"body_schema":"staffing.confirmed/v1","body_digest":hashlib.sha256(BODY).hexdigest(),"method":"POST","destination":"https://webhooks.example.com/v1/events","resolved_ips":[IP],"credential":{"handle":"cred_opaque_7f4d","generation":7,"audience":"https://webhooks.example.com","destination_host":"webhooks.example.com","operation":"POST","resource":"/v1/events"},"execution":"exec-1","lease_fence":9,"status":f"https://webhooks.example.com/v1/status/{effect}","redirects":[]}
class Provider:
 def __init__(self,status_body=None,send_status=202,redirect=None,uncertain=False): self.calls=[]; self.status_body=status_body; self.send_status=send_status; self.redirect=redirect; self.uncertain=uncertain
 def request(self,url,method,body,headers):
  self.calls.append((url,method,body,dict(headers)))
  if method!="GET":
   if self.uncertain: raise w.Uncertain("reset after write")
   if self.redirect: return 307,{"Location":self.redirect},b""
   expected=hmac.new(SECRET,BODY,hashlib.sha256).hexdigest()
   assert body==BODY and headers["X-Aiko-Signature"]=="sha256="+expected
   return self.send_status,{},b'{"accepted":true}' # sender response is deliberately insufficient
  body=self.status_body
  if body is None: return 404,{},b""
  return 200,{},json.dumps(body).encode()
def run(cmd):
 p=subprocess.run(cmd,capture_output=True,text=True,timeout=120)
 if p.returncode: print(p.stdout,p.stderr,file=sys.stderr); raise SystemExit(p.returncode)
 return p

def admitted_path(tmp):
 state=tmp/"neuron-state"; state.mkdir()
 digest=run([str(NEURON),"limb","admit",str(LIMB),str(state)]).stdout
 assert len([x for x in digest.split() if len(x)==64])==1,digest
 p=plan(); req={k:v for k,v in p.items() if k!="schema"}; raw=json.dumps(req,sort_keys=True,separators=(",",":"))
 stim={"schema":"neuron.stimulus/v1","firing_id":"webhook-gate-admitted","receptor_schema":"neuron.webhook-request/v1","now_ms":0,"reads":[{"id":"request","schema":"neuron.webhook-request/v1","bytes":raw,"digest":hashlib.sha256(raw.encode()).hexdigest()}],"permitted_reads":["request"],"messages":[]}
 sp=tmp/"stim.json"; sp.write_text(json.dumps(stim))
 out=run([str(NEURON),"limb","run",str(state),"--package",str(LIMB),"--neuron","webhook","--stimulus",str(sp),"--json"])
 summary=json.loads(out.stdout); assert summary["status"]=="committed" and summary["effects_committed"]==1,summary
 log=(state/"substrate.log").read_text()
 assert "test-only-credential" not in log and BODY.decode() not in log
 return state

def main():
 tmp=Path(tempfile.mkdtemp(prefix="webhook-limb-gate.")); admitted_path(tmp)
 # Full crossed effect: 2xx is independently read back, exact-byte HMAC checked by provider.
 state=tmp/"outbox.jsonl"; p=plan(); w.enqueue(state,p,BODY,resolver)
 provider=Provider({"effect_id":p["effect_id"],"body_digest":p["body_digest"],"status":"accepted"})
 assert w.deliver(state,p,BODY,SECRET,7,9,provider,resolver)=="acknowledged"
 assert [c[1] for c in provider.calls]==["POST","GET"]
 assert w.invalidate(state,p["effect_id"])=="compensation_required"
 # Unknown acceptance parks. A second delivery is refused; reconciliation performs GET only.
 p2=plan("effect-unknown-0123456789"); w.enqueue(state,p2,BODY,resolver)
 unknown=Provider(uncertain=True)
 assert w.deliver(state,p2,BODY,SECRET,7,9,unknown,resolver)=="reconciliation_required"
 try: w.deliver(state,p2,BODY,SECRET,7,9,Provider(),resolver); raise AssertionError("blind resend allowed")
 except w.Refusal: pass
 rec=Provider({"effect_id":p2["effect_id"],"body_digest":p2["body_digest"],"status":"accepted"})
 assert w.reconcile(state,p2,rec,resolver)=="acknowledged"
 assert [c[1] for c in rec.calls]==["GET"]
 # An uncrossed invalidated effect is cancelled, not sent.
 p3=plan("effect-queued-01234567890"); w.enqueue(state,p3,BODY,resolver); assert w.invalidate(state,p3["effect_id"])=="cancelled"
 # Generation and lease fence are checked immediately at the credential boundary.
 for generation,fence in ((8,9),(7,10)):
  px=plan(f"effect-fence-{generation}-{fence}-abcdef"); w.enqueue(state,px,BODY,resolver)
  try: w.deliver(state,px,BODY,SECRET,generation,fence,Provider(),resolver); raise AssertionError("stale authority crossed")
  except w.Refusal: pass
 # SSRF/private/metadata and DNS rebinding refuse before a send.
 bad=plan("effect-private-012345678") ; bad["resolved_ips"]=["169.254.169.254"]
 try: w.validate_plan(bad,lambda *a,**k:[(2,1,6,"",("169.254.169.254",443))]); raise AssertionError("metadata admitted")
 except w.Refusal: pass
 calls=[0]
 def rebound(host,port,type=None):
  calls[0]+=1; ip=IP if calls[0]==1 else "203.0.113.9"; return [(2,1,6,"",(ip,port))]
 # 203.0.113.9 is non-global and therefore refused on the immediate re-check.
 pr=plan("effect-rebind-0123456789"); w.enqueue(state,pr,BODY,resolver)
 try: w.deliver(state,pr,BODY,SECRET,7,9,Provider(),rebound); raise AssertionError("DNS rebound crossed")
 except w.Refusal: pass
 # Redirects are never followed unless their exact URL/method/DNS are in the pin.
 pu=plan("effect-redirect-01234567"); w.enqueue(state,pu,BODY,resolver)
 evil="https://other.example.net/collect"
 try: w.deliver(state,pu,BODY,SECRET,7,9,Provider(redirect=evil),resolver); raise AssertionError("unpinned redirect followed")
 except w.Refusal: pass
 # Durable state contains identity/digests only: no body, secret, or HMAC signature.
 durable=state.read_bytes()
 assert BODY not in durable and SECRET not in durable and hmac.new(SECRET,BODY,hashlib.sha256).hexdigest().encode() not in durable
 rows=w.history(state); assert any(r["status"]=="reconciliation_required" for r in rows) and any(r["status"]=="compensation_required" for r in rows)
 print("webhook limb: admitted pin + SSRF/rebinding/redirect fence + durable outbox/HMAC/read-back/reconciliation/compensation: PASS")
if __name__=="__main__": main()
