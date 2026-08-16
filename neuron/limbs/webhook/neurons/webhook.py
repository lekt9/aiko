#!/usr/bin/env python3
"""Pure admission-side planner for a provider-neutral webhook effect."""
import ipaddress, json, os, re, sys
from urllib.parse import urlsplit
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "shared"))
from _neuron import Reject, artifact_ref, canonical, decision, digest, run

REQUEST="neuron.webhook-request/v1"
PLAN="neuron.webhook-plan/v1"
HEX=re.compile(r"^[0-9a-f]{64}$")

def public(ip):
    try: return ipaddress.ip_address(ip).is_global
    except ValueError: return False

def fire(stim):
    if stim.get("receptor_schema") != REQUEST: raise Reject("validation", "wrong webhook receptor")
    ref,req=artifact_ref(stim,REQUEST)
    for key in ("effect_id","body_schema","body_digest","method","destination","resolved_ips","credential","execution","lease_fence","status"):
        if key not in req: raise Reject("validation",f"missing pinned field: {key}")
    u=urlsplit(req["destination"])
    if u.scheme!="https" or not u.hostname or u.username or u.password or u.fragment: raise Reject("validation","HTTPS destination required")
    if req["method"] not in ("POST","PUT","PATCH","DELETE"): raise Reject("validation","method refused")
    if not HEX.match(req["body_digest"]): raise Reject("validation","body digest must be SHA-256")
    if not req["resolved_ips"] or not all(public(x) for x in req["resolved_ips"]): raise Reject("validation","non-public DNS pin refused")
    cred=req["credential"]
    for k in ("handle","generation","audience","destination_host","operation","resource"):
        if k not in cred: raise Reject("validation",f"credential binding missing {k}")
    if cred["destination_host"].lower()!=u.hostname.lower() or cred["audience"]!="https://"+u.hostname.lower() or cred["operation"]!=req["method"] or cred["resource"]!=(u.path or "/"):
        raise Reject("validation","credential binding differs from destination")
    plan={"schema":PLAN, **req}
    plan_bytes=canonical(plan).decode()
    aid="artifact/webhook/outbox/"+req["effect_id"]
    return decision(control={"kind":"terminate","result":"webhook effect pinned"},effects=[{"kind":"write","artifact":{"id":aid,"schema":PLAN,"bytes":plan_bytes,"digest":digest(plan)}}],evidence=[{"claim":"webhook host/path/method/schema, credential generation/fence and logical effect id are digest-pinned before crossing","sources":[ref["id"]],"method":"admitted webhook planner"}],stim=stim)
if __name__=="__main__": run(fire)
