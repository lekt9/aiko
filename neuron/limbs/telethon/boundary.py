#!/usr/bin/env python3
"""Provider-neutral durable message effect boundary.

The name records the source protocol family, not a live-provider claim.  The
boundary consumes normalized values and an injected provider.  Its append-only
journal contains identifiers, digests, classifications and evidence only.
"""
import hashlib, json, os, time
from pathlib import Path

SCHEMA="neuron.telethon-effect-record/v1"
TERMINAL={"acknowledged","dead_letter","cancelled","compensation_required"}
CROSSED={"crossing","reconciliation_required","acknowledged","dead_letter","compensation_required"}
ALLOWED_CLASSIFICATIONS={"provider_rejected","pending_expired","read_back_mismatch","read_back_unavailable","revoked"}
class Refusal(Exception): pass

def canonical(x): return json.dumps(x,sort_keys=True,separators=(",",":"))
def digest(data): return hashlib.sha256(data if isinstance(data,bytes) else data.encode()).hexdigest()
def append(path,row):
    # Fail closed if a caller tries to persist provider/body/error material.
    forbidden={"body","text","raw_update","exception","credential","phone","username"}
    if forbidden & set(row): raise Refusal("privacy-unsafe durable field refused")
    if row.get("classification") and row["classification"] not in ALLOWED_CLASSIFICATIONS:
        raise Refusal("unbounded provider error refused")
    p=Path(path); p.parent.mkdir(parents=True,exist_ok=True)
    safe=dict(row,schema=SCHEMA)
    fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
    try: os.write(fd,(canonical(safe)+"\n").encode()); os.fsync(fd)
    finally: os.close(fd)

def history(path):
    p=Path(path); return [json.loads(x) for x in p.read_text().splitlines() if x] if p.exists() else []
def latest(path,effect_id):
    rows=[r for r in history(path) if r.get("effect_id")==effect_id]
    if not rows: raise Refusal("unknown effect")
    return rows[-1]
def normalize_inbound(update,acl):
    """Terminate provider shape at the membrane and enforce exact tuple ACL."""
    try:
        event={"schema":"neuron.normalized-inbound/v1","source_id":str(update["update_id"]),
               "conversation_id":str(update["chat_id"]),"sender_id":str(update["sender_id"]),
               "body":str(update["text"])}
    except (KeyError,TypeError) as exc: raise Refusal("malformed provider update") from exc
    if (event["conversation_id"],event["sender_id"],"observe") not in acl:
        raise Refusal("exact inbound ACL refused")
    return event

def validate_plan(plan,acl):
    required=("schema","effect_id","execution","conversation_id","recipient_id","payload_digest","credential_handle","expires_at")
    if any(k not in plan for k in required): raise Refusal("incomplete effect plan")
    if plan["schema"]!="neuron.telethon-effect-plan/v1" or len(plan["payload_digest"])!=64: raise Refusal("invalid effect plan")
    if not str(plan["credential_handle"]).startswith("cred:"): raise Refusal("opaque credential handle required")
    if (plan["conversation_id"],plan["recipient_id"],"send") not in acl:
        raise Refusal("exact outbound ACL refused")
    return plan

def enqueue(path,plan,payload,acl,now=None,original=None):
    validate_plan(plan,acl)
    if digest(payload)!=plan["payload_digest"]: raise Refusal("payload differs from pin")
    if original:
        if original.get("status")!="dead_letter": raise Refusal("only dead letters may be requeued")
        if plan["effect_id"]==original["effect_id"] or plan["execution"]==original["execution"]: raise Refusal("requeue requires new linked Contract attempt")
        if plan["recipient_id"]!=original["recipient_id"]: raise Refusal("requeue recipient drift refused")
        if any(r.get("parent_effect")==original["effect_id"] and r.get("execution")==plan["execution"] for r in history(path)):
            raise Refusal("linked Contract attempt already exists")
    try: old=latest(path,plan["effect_id"])
    except Refusal: old=None
    if old: raise Refusal("effect history is immutable")
    row={k:plan[k] for k in required_fields()}
    row.update(status="queued",crossed=False,attempt=0,evidence=[],parent_effect=original["effect_id"] if original else None,
               parent_execution=original["execution"] if original else None)
    append(path,row); return row

def required_fields(): return ("effect_id","execution","conversation_id","recipient_id","payload_digest","expires_at")
def _transition(path,row,**change):
    nxt={k:row.get(k) for k in required_fields()}; nxt.update({"crossed":row.get("crossed",False),"attempt":row.get("attempt",0),"evidence":row.get("evidence",[]),"parent_effect":row.get("parent_effect"),"parent_execution":row.get("parent_execution")}); nxt.update(change); append(path,nxt); return nxt

def _readback(provider,plan,row):
    try: receipt=provider.read_back(plan["conversation_id"],plan["recipient_id"],plan["effect_id"])
    except Exception: receipt=None
    good=receipt and receipt.get("effect_id")==plan["effect_id"] and receipt.get("recipient_id")==plan["recipient_id"] and receipt.get("payload_digest")==plan["payload_digest"]
    if good: return _transition(provider.journal,row,status="acknowledged",crossed=True,evidence=[digest(canonical(receipt))])
    classification="read_back_mismatch" if receipt else "read_back_unavailable"
    return _transition(provider.journal,row,status="reconciliation_required",crossed=True,classification=classification,evidence=[digest(canonical(receipt))] if receipt else [])

def dispatch(path,plan,payload,provider,now=None):
    provider.journal=path; row=latest(path,plan["effect_id"]); now=int(time.time()) if now is None else now
    if row["status"]!="queued":
        # A crossed or parked effect is never replayed, including after restart.
        return row
    if now>=int(row["expires_at"]): return _transition(path,row,status="dead_letter",crossed=False,classification="pending_expired",attempt=row["attempt"])
    row=_transition(path,row,status="crossing",crossed=True,attempt=row["attempt"]+1)
    try: result=provider.send(plan["conversation_id"],plan["recipient_id"],payload,plan["effect_id"])
    except Exception: result="uncertain"
    if result=="rejected": return _transition(path,row,status="dead_letter",crossed=True,classification="provider_rejected")
    # Accepted and uncertain are both merely sender-side claims; settle only by read-back.
    return _readback(provider,plan,row)

def reconcile(path,plan,provider):
    provider.journal=path; row=latest(path,plan["effect_id"])
    if row["status"]!="reconciliation_required": raise Refusal("effect is not awaiting reconciliation")
    return _readback(provider,plan,row)

def invalidate(path,effect_id,evidence_id):
    row=latest(path,effect_id)
    if row["status"] in CROSSED:
        return _transition(path,row,status="compensation_required",crossed=True,evidence=row.get("evidence",[])+[digest(evidence_id)])
    if row["status"]=="queued": return _transition(path,row,status="cancelled",crossed=False,evidence=[digest(evidence_id)])
    return row

def amendment_delta(before,after):
    """Return only changed recipients, independently, in total order."""
    return [{"recipient_id":r,"before":before.get(r),"after":after.get(r)}
            for r in sorted(set(before)|set(after)) if before.get(r)!=after.get(r)]
