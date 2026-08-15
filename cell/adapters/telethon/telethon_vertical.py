#!/usr/bin/env python3
"""Durable, provider-neutral Telethon vertical.

The production-shaped adapter owns policy and an outbox, not credentials.  A
provider implementation is injected at the membrane; the hermetic provider in
this module is explicitly a gate double and writes its own journal so read-back
is independent of the sender's outbox.
"""
from __future__ import annotations
import hashlib, json, os, pathlib, time, uuid

class Refusal(RuntimeError): pass

def _load(path):
    try: return json.loads(pathlib.Path(path).read_text())
    except (OSError, ValueError) as exc: raise Refusal(f"invalid contract: {path}") from exc

def _atomic(path, value):
    path=pathlib.Path(path); path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix(path.suffix+".tmp")
    tmp.write_text(json.dumps(value,sort_keys=True,indent=2)+"\n")
    os.chmod(tmp,0o600); os.replace(tmp,path)

def consume_contracts(*, credential, adapter_family, context, control, tenant, now):
    c,a,x,w=map(_load,(credential,adapter_family,context,control))
    handle=c.get("handle")
    if c.get("schema")!="aiko.credential-handle-contract/v1" or not isinstance(handle,str) or not handle.startswith("cred:"):
        raise Refusal("opaque credential contract required")
    if c.get("tenant")!=tenant or c.get("status")!="active" or c.get("revoked") is True:
        raise Refusal("credential scope or status refused")
    if int(c.get("expires_at",0))<=now: raise Refusal("credential expired")
    if not {"observe","send"} <= set(c.get("allowed_actions",[])): raise Refusal("credential lacks chat authority")
    if a.get("schema")!="aiko.admitted-adapter-family/v1" or not a.get("admitted_by_digest") or a.get("judgment")!="accepted":
        raise Refusal("adapter family was not admitted and judged")
    if x.get("schema")!="aiko.cited-context-lineage/v1" or x.get("tenant")!=tenant:
        raise Refusal("cited tenant context required")
    if w.get("schema")!="aiko.durable-pause-resume/v1" or w.get("status")!="running" or not w.get("cell_digest"):
        raise Refusal("bound workflow is not running")
    return {"credential_handle":handle,"cell_digest":w["cell_digest"],"adapter_digest":a.get("package_digest")}

class SyntheticProvider:
    """Hermetic provider double. Its journal is the independent read surface."""
    synthetic_provider_data_only=True
    def __init__(self,path): self.path=pathlib.Path(path); self.calls=[]
    def _rows(self): return _load(self.path) if self.path.exists() else []
    def send(self,chat_id,recipient_id,text,message_id):
        self.calls.append((chat_id,recipient_id,message_id))
        rows=self._rows(); rows.append({"chat_id":chat_id,"recipient_id":recipient_id,"text":text,"message_id":message_id})
        _atomic(self.path,rows); return message_id
    def read_back(self,message_id):
        return next((r for r in self._rows() if r["message_id"]==message_id),None)

class TelethonVertical:
    def __init__(self,state_dir,provider,*,now=lambda:int(time.time())):
        self.root=pathlib.Path(state_dir); self.path=self.root/"vertical.json"; self.provider=provider; self.now=now
    def _state(self):
        if not self.path.exists(): raise Refusal("vertical not logged in")
        return _load(self.path)
    def login(self,*,credential,adapter_family,context,control,tenant,phone,code,two_factor):
        if self.path.exists(): raise Refusal("already initialized")
        # Authorization material is used at the boundary and deliberately never persisted.
        if not phone or not code or not two_factor: raise Refusal("phone, code and 2FA required")
        binding=consume_contracts(credential=credential,adapter_family=adapter_family,context=context,control=control,tenant=tenant,now=self.now())
        s={"schema":"aiko.telethon-vertical/v1","tenant":tenant,"login":binding,
           "acl":{},"inbound":[],"outbox":{},"assignments":{},"escalations":[]}
        _atomic(self.path,s); return binding["credential_handle"]
    def grant(self,chat_id,recipients):
        if not chat_id or not recipients: raise Refusal("empty ACL refused")
        s=self._state(); s["acl"][chat_id]=sorted(set(recipients)); _atomic(self.path,s)
    def normalize_inbound(self,update):
        # Provider-specific shape terminates here. The durable event has no Telethon type.
        try: event={"kind":"inbound_message","conversation_id":str(update["chat_id"]),
                    "sender_id":str(update["sender_id"]),"body":str(update["text"]),"source_id":str(update["update_id"])}
        except (KeyError,TypeError) as exc: raise Refusal("malformed inbound update") from exc
        s=self._state(); allowed=s["acl"].get(event["conversation_id"],[])
        if event["sender_id"] not in allowed: raise Refusal("inbound chat/recipient ACL refused")
        s["inbound"].append(event); _atomic(self.path,s); return event
    def _authorized(self,s,chat,recipient):
        if recipient not in s["acl"].get(chat,[]): raise Refusal("send chat/recipient ACL refused")
    def send(self,chat,recipient,text,*,observable=True,key=None):
        s=self._state(); self._authorized(s,chat,recipient)
        mid=key or hashlib.sha256(f"{chat}\0{recipient}\0{text}".encode()).hexdigest()[:24]
        old=s["outbox"].get(mid)
        if old and old.get("crossed"): return old
        row={"message_id":mid,"chat_id":chat,"recipient_id":recipient,"text":text,
             "status":"pending","crossed":False,"read_back":False}
        s["outbox"][mid]=row; _atomic(self.path,s) # durable intent precedes effect
        self.provider.send(chat,recipient,text,mid)
        s=self._state(); row=s["outbox"][mid]; row["crossed"]=True; _atomic(self.path,s)
        observed=self.provider.read_back(mid) if observable else None
        s=self._state(); row=s["outbox"][mid]
        if observed and all(observed.get(k)==row[k] for k in ("chat_id","recipient_id","text")):
            row.update(status="settled",read_back=True)
        else:
            s["escalations"].append({"message_id":mid,"reason":"independent read-back unavailable"})
        _atomic(self.path,s); return row
    def apply_assignments(self,chat,assignments):
        s=self._state(); before=s["assignments"]
        changed=sorted(r for r in set(before)|set(assignments) if before.get(r)!=assignments.get(r))
        for r in changed:
            self._authorized(s,chat,r)
            old,new=before.get(r),assignments.get(r)
            self.send(chat,r,f"assignment amended: {old or 'none'} -> {new or 'none'}",key=f"amend:{r}:{new}")
        s=self._state(); s["assignments"]=dict(sorted(assignments.items())); _atomic(self.path,s)
        return changed
    def redrive(self):
        s=self._state(); result=[]
        for mid,row in sorted(s["outbox"].items()):
            if row["crossed"]:
                result.append({"message_id":mid,"action":"do-not-resend","status":row["status"]})
            else:
                result.append({"message_id":mid,"action":"pending"})
        return result
    def send_if_authorized(self,chat,recipient,text,credential_contract):
        c=_load(credential_contract)
        if c.get("status")!="active" or c.get("revoked") or int(c.get("expires_at",0))<=self.now():
            s=self._state(); mid=hashlib.sha256(f"{chat}\0{recipient}\0{text}".encode()).hexdigest()[:24]
            s["outbox"][mid]={"message_id":mid,"chat_id":chat,"recipient_id":recipient,"text":text,"status":"pending","crossed":False,"read_back":False}
            s["escalations"].append({"message_id":mid,"reason":"credential expired"}); _atomic(self.path,s)
            return s["outbox"][mid]
        return self.send(chat,recipient,text)
