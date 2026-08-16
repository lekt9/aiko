#!/usr/bin/env python3
import importlib.util,json,os,sys,tempfile
from pathlib import Path
MODULE=Path(os.environ.get("TELETHON_BOUNDARY",Path(__file__).parents[1]/"boundary.py"))
spec=importlib.util.spec_from_file_location("telethon_boundary",MODULE); b=importlib.util.module_from_spec(spec); spec.loader.exec_module(b)

def plan(effect="effect-00000001",execution="exec-1",recipient="r1",expires=100,payload=b"hello"):
 return {"schema":"neuron.telethon-effect-plan/v1","effect_id":effect,"execution":execution,"conversation_id":"c1","recipient_id":recipient,"payload_digest":b.digest(payload),"credential_handle":"cred:test","expires_at":expires}
ACL={("c1","r1","send"),("c1","r2","send"),("c1","r1","observe")}
class Provider:
 def __init__(self,result="accepted",receipt=True,wrong_recipient=False): self.result=result; self.receipt=receipt; self.wrong=wrong_recipient; self.sends=[]; self.reads=[]
 def send(self,c,r,p,e): self.sends.append((c,r,e)); return self.result
 def read_back(self,c,r,e):
  self.reads.append((c,r,e))
  if not self.receipt:return None
  return {"effect_id":e,"recipient_id":"other" if self.wrong else r,"payload_digest":plan(effect=e,recipient=r,payload=b"hello")["payload_digest"]}
def refused(fn):
 try: fn()
 except b.Refusal:return
 raise AssertionError("expected refusal")

def main():
 with tempfile.TemporaryDirectory() as td:
  td=Path(td)
  # Provider shape terminates here and ACL matches the exact conversation/sender/action tuple.
  ev=b.normalize_inbound({"update_id":1,"chat_id":"c1","sender_id":"r1","text":"hi","provider_extra":"x"},ACL)
  assert ev=={"schema":"neuron.normalized-inbound/v1","source_id":"1","conversation_id":"c1","sender_id":"r1","body":"hi"}
  refused(lambda:b.normalize_inbound({"update_id":2,"chat_id":"other","sender_id":"r1","text":"hi"},ACL))
  refused(lambda:b.enqueue(td/'x',plan(recipient="r9"),b"hello",ACL))
  # Independently settle each recipient; an aggregate/provider acceptance cannot settle either.
  for recipient in ("r1","r2"):
   p=Provider(); q=plan(effect="effect-"+recipient+"-000000",recipient=recipient); path=td/(recipient+".jsonl")
   b.enqueue(path,q,b"hello",ACL); out=b.dispatch(path,q,b"hello",p,now=1)
   assert out["status"]=="acknowledged" and p.reads==[("c1",recipient,q["effect_id"])] and len(p.sends)==1
  # A wrong-recipient receipt cannot settle an effect.
  q=plan(effect="effect-wrong-0001"); path=td/'wrong'; p=Provider(wrong_recipient=True)
  b.enqueue(path,q,b"hello",ACL); assert b.dispatch(path,q,b"hello",p,now=1)["status"]=="reconciliation_required"
  # Accepted-without-ACK and uncertain both park after read-back, never blind retry.
  for result in ("accepted","uncertain"):
   q=plan(effect="effect-"+result+"-01"); path=td/result; p=Provider(result,False)
   b.enqueue(path,q,b"hello",ACL); first=b.dispatch(path,q,b"hello",p,now=1); assert first["status"]=="reconciliation_required" and len(p.reads)==1
   b.dispatch(path,q,b"hello",p,now=2); assert len(p.sends)==1
   p.receipt=True; assert b.reconcile(path,q,p)["status"]=="acknowledged" and len(p.sends)==1
  # Pending expiry is exact and creates a bounded privacy-safe dead letter.
  q=plan(effect="effect-expire-0001",expires=10); path=td/'expiry'; p=Provider()
  b.enqueue(path,q,b"hello",ACL); out=b.dispatch(path,q,b"hello",p,now=10)
  assert out["status"]=="dead_letter" and out["classification"]=="pending_expired" and not p.sends
  assert {"effect_id","execution","recipient_id","attempt","classification","evidence"}<=set(out)
  raw=path.read_text(); assert "hello" not in raw and "credential" not in raw and "exception" not in raw
  # Requeue is authorized, new and linked; history is append-only.
  q2=plan(effect="effect-requeue-01",execution="exec-2"); before=len(b.history(path))
  fresh=b.enqueue(path,q2,b"hello",ACL,original=out); assert fresh["parent_effect"]==q["effect_id"] and fresh["parent_execution"]==q["execution"]
  assert len(b.history(path))==before+1
  refused(lambda:b.enqueue(path,plan(effect="effect-requeue-02",execution="exec-2"),b"hello",ACL,original=out))
  # Amendment is recipient-local, includes removals, and excludes unchanged recipients.
  delta=b.amendment_delta({"r1":"A","r2":"B"},{"r1":"A","r2":"C","r3":"D"})
  assert delta==[{"recipient_id":"r2","before":"B","after":"C"},{"recipient_id":"r3","before":None,"after":"D"}]
  # Once crossed, invalidation compensates and every later dispatch is a no-op.
  q=plan(effect="effect-comp-00001"); path=td/'comp'; p=Provider()
  b.enqueue(path,q,b"hello",ACL); b.dispatch(path,q,b"hello",p,now=1); b.invalidate(path,q["effect_id"],"amendment-2")
  assert b.latest(path,q["effect_id"])["status"]=="compensation_required"
  b.dispatch(path,q,b"hello",p,now=2); assert len(p.sends)==1
  # Permanent failure DLQ retains bounded evidence, never raw provider details.
  q=plan(effect="effect-reject-0001"); path=td/'reject'; p=Provider("rejected")
  b.enqueue(path,q,b"hello",ACL); out=b.dispatch(path,q,b"hello",p,now=1)
  assert out["status"]=="dead_letter" and out["classification"]=="provider_rejected"
 print("telethon limb conformance: PASS")
if __name__=="__main__": main()
