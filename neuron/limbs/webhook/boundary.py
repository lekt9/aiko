#!/usr/bin/env python3
"""Admitted webhook boundary.

Only credential handles and payload digests are durable. Payload and credential
bytes are supplied again at the boundary and are zeroed/discarded after the
call. Provider acceptance is settled only by an independent status read.
"""
import argparse, hashlib, hmac, http.client, ipaddress, json, os, socket, ssl, sys
from pathlib import Path
from urllib.parse import urlsplit

SCHEMA = "neuron.webhook-outbox-record/v1"
TERMINAL = {"acknowledged", "dead_letter", "cancelled", "compensation_required"}
CROSSED = {"crossing", "reconciliation_required", "acknowledged", "dead_letter"}
METADATA_HOSTS = {"metadata.google.internal", "metadata.google", "instance-data.ec2.internal"}

class Refusal(Exception): pass
class Uncertain(Exception): pass

def canonical(value): return json.dumps(value, sort_keys=True, separators=(",", ":"))
def digest_bytes(data): return hashlib.sha256(data).hexdigest()

def _public_ip(text):
    try: ip = ipaddress.ip_address(text.split("%")[0])
    except ValueError as exc: raise Refusal("resolver returned a non-IP address") from exc
    # is_global excludes private, loopback, link-local, multicast, reserved,
    # unspecified and the cloud metadata addresses (169.254.169.254 etc.).
    if not ip.is_global: raise Refusal(f"non-public destination address refused: {ip}")
    return str(ip)

def validate_url(url):
    u=urlsplit(url)
    if u.scheme != "https" or not u.hostname or u.username or u.password or u.fragment:
        raise Refusal("destination must be credential-free absolute HTTPS")
    host=u.hostname.rstrip(".").lower()
    if host in METADATA_HOSTS or host.endswith(".internal") or host == "localhost":
        raise Refusal("metadata/private destination name refused")
    return u

def resolve_public(host, resolver=socket.getaddrinfo):
    try: rows=resolver(host, 443, type=socket.SOCK_STREAM)
    except OSError as exc: raise Refusal("DNS resolution failed") from exc
    ips=sorted({_public_ip(row[4][0]) for row in rows})
    if not ips: raise Refusal("DNS returned no public address")
    return ips

def validate_plan(plan, resolver=socket.getaddrinfo):
    required=("schema","effect_id","body_schema","body_digest","method","destination",
              "resolved_ips","credential","execution","lease_fence","status")
    for key in required:
        if key not in plan: raise Refusal(f"plan missing {key}")
    if plan["schema"] != "neuron.webhook-plan/v1": raise Refusal("wrong plan schema")
    if plan["method"] not in ("POST","PUT","PATCH","DELETE"): raise Refusal("method is not admitted")
    if len(plan["effect_id"]) < 16 or len(plan["body_digest"]) != 64: raise Refusal("identity pin malformed")
    cred=plan["credential"]
    for key in ("handle","generation","audience","destination_host","operation","resource"):
        if key not in cred: raise Refusal(f"credential binding missing {key}")
    dest=validate_url(plan["destination"])
    if cred["destination_host"].lower() != dest.hostname.lower(): raise Refusal("credential host binding mismatch")
    if cred["audience"] != f"https://{dest.hostname.lower()}": raise Refusal("credential audience mismatch")
    if cred["operation"] != plan["method"] or cred["resource"] != (dest.path or "/"):
        raise Refusal("credential operation/resource mismatch")
    pins=sorted(_public_ip(x) for x in plan["resolved_ips"])
    first=resolve_public(dest.hostname, resolver)
    if first != pins: raise Refusal("DNS result differs from admitted pin")
    for redir in plan.get("redirects", []):
        ru=validate_url(redir["url"])
        if sorted(_public_ip(x) for x in redir["resolved_ips"]) != resolve_public(ru.hostname, resolver):
            raise Refusal("redirect DNS differs from admitted pin")
    status=validate_url(plan["status"])
    if status.hostname.lower() != dest.hostname.lower(): raise Refusal("status endpoint crosses audience")
    return plan

def append_record(path, rec):
    path=Path(path); path.parent.mkdir(parents=True,exist_ok=True)
    safe={k:v for k,v in rec.items() if k not in ("body","secret","signature")}
    safe["schema"]=SCHEMA
    line=canonical(safe)+"\n"
    fd=os.open(path, os.O_WRONLY|os.O_CREAT|os.O_APPEND, 0o600)
    try: os.write(fd,line.encode()); os.fsync(fd)
    finally: os.close(fd)

def history(path):
    p=Path(path)
    return [json.loads(x) for x in p.read_text().splitlines() if x] if p.exists() else []

def latest(path,effect_id):
    rows=[r for r in history(path) if r.get("effect_id")==effect_id]
    if not rows: raise Refusal("unknown logical effect")
    return rows[-1]

def enqueue(path, plan, body, resolver=socket.getaddrinfo):
    validate_plan(plan,resolver)
    if digest_bytes(body) != plan["body_digest"]: raise Refusal("body bytes differ from pin")
    try: old=latest(path,plan["effect_id"])
    except Refusal: old=None
    if old:
        if old["plan_digest"] != digest_bytes(canonical(plan).encode()): raise Refusal("effect id collision")
        return old
    rec={"effect_id":plan["effect_id"],"status":"queued","plan_digest":digest_bytes(canonical(plan).encode()),
         "body_digest":plan["body_digest"],"body_schema":plan["body_schema"],"destination":plan["destination"],
         "method":plan["method"],"credential_handle":plan["credential"]["handle"],
         "credential_generation":plan["credential"]["generation"],"execution":plan["execution"],
         "lease_fence":plan["lease_fence"]}
    append_record(path,rec); return rec

class HTTPS:
    """TLS to the already-resolved IP; Host/SNI remain the admitted hostname.

    Connecting to the numeric pin rather than asking the HTTP library to resolve
    again closes the check/use DNS-rebinding gap. Redirects remain caller-owned.
    """
    def request_pinned(self,url,method,body,headers,pinned_ip):
        u=validate_url(url); port=u.port or 443
        conn=http.client.HTTPConnection(u.hostname,port,timeout=15)
        raw=None
        try:
            raw=socket.create_connection((pinned_ip,port),timeout=15)
            conn.sock=ssl.create_default_context().wrap_socket(raw,server_hostname=u.hostname)
            target=(u.path or "/")+("?"+u.query if u.query else "")
            conn.request(method,target,body=body,headers=headers); resp=conn.getresponse(); data=resp.read(65536)
            return resp.status,dict(resp.getheaders()),data
        except (OSError,TimeoutError,http.client.HTTPException) as exc: raise Uncertain("transport outcome unknown") from exc
        finally: conn.close()

def _transport_request(transport,url,method,body,headers,pins):
    if hasattr(transport,"request_pinned"):
        return transport.request_pinned(url,method,body,headers,sorted(pins)[0])
    return transport.request(url,method,body,headers)

def _request_with_pinned_redirects(plan, transport, body, headers, resolver):
    url=plan["destination"]; method=plan["method"]
    hops=iter(plan.get("redirects",[]))
    while True:
        u=validate_url(url)
        # Revalidate immediately before every secret-bearing request: catches
        # DNS rebinding between admission/enqueue and crossing.
        pins=plan["resolved_ips"] if url==plan["destination"] else current["resolved_ips"]
        checked=resolve_public(u.hostname,resolver)
        admitted=sorted(_public_ip(x) for x in pins)
        if checked != admitted: raise Refusal("DNS rebinding refused")
        status,rh,data=_transport_request(transport,url,method,body,headers,admitted)
        if status not in (301,302,303,307,308): return status,rh,data
        try: current=next(hops)
        except StopIteration: raise Refusal("unpinned redirect refused")
        location=rh.get("Location") or rh.get("location")
        if location != current["url"]: raise Refusal("redirect target differs from pin")
        if current.get("method",method) != method: raise Refusal("redirect method rewrite refused")
        url=location

def _readback(plan, transport, effect_id, body_digest, resolver):
    u=validate_url(plan["status"])
    admitted=sorted(_public_ip(x) for x in plan["resolved_ips"])
    if resolve_public(u.hostname,resolver) != admitted: raise Refusal("status DNS rebinding refused")
    status,_headers,data=_transport_request(transport,plan["status"],"GET",b"",{"Accept":"application/json","X-Aiko-Effect-Id":effect_id},admitted)
    if status != 200: return None,None
    try: receipt=json.loads(data)
    except Exception: return None,None
    if receipt.get("effect_id") != effect_id or receipt.get("body_digest") != body_digest: return None,None
    return receipt.get("status"),digest_bytes(data)

def deliver(path,plan,body,secret,current_generation,current_fence,transport=None,resolver=socket.getaddrinfo):
    validate_plan(plan,resolver); rec=latest(path,plan["effect_id"])
    if rec["status"] != "queued": raise Refusal("effect is not eligible to send")
    if digest_bytes(body)!=rec["body_digest"]: raise Refusal("body bytes differ from durable pin")
    if current_generation != plan["credential"]["generation"]: raise Refusal("credential generation is stale")
    if current_fence != plan["lease_fence"]: raise Refusal("execution fence is stale")
    append_record(path,{**rec,"status":"crossing"}) # durable before boundary crossing
    sig=hmac.new(secret,body,hashlib.sha256).hexdigest()
    headers={"Content-Type":"application/json","X-Aiko-Effect-Id":plan["effect_id"],
             "X-Aiko-Body-Schema":plan["body_schema"],"X-Aiko-Signature":"sha256="+sig}
    transport=transport or HTTPS()
    try:
        status,_rh,_data=_request_with_pinned_redirects(plan,transport,body,headers,resolver)
        if status < 200 or status >= 300:
            append_record(path,{**rec,"status":"dead_letter","http_status":status}); return "dead_letter"
        evidence,receipt_digest=_readback(plan,transport,plan["effect_id"],rec["body_digest"],resolver)
        state="acknowledged" if evidence=="accepted" else "reconciliation_required"
        update={**rec,"status":state}
        if receipt_digest: update["provider_receipt_digest"]=receipt_digest
        append_record(path,update)
        return state
    except Uncertain:
        append_record(path,{**rec,"status":"reconciliation_required","reason":"unknown_acceptance"}); return "reconciliation_required"

def reconcile(path,plan,transport=None,resolver=socket.getaddrinfo):
    rec=latest(path,plan["effect_id"])
    if rec["status"] != "reconciliation_required": raise Refusal("effect is not awaiting reconciliation")
    result,receipt_digest=_readback(plan,transport or HTTPS(),plan["effect_id"],rec["body_digest"],resolver)
    if result not in ("accepted","rejected"): return "reconciliation_required"
    state="acknowledged" if result=="accepted" else "dead_letter"
    append_record(path,{**rec,"status":state,"provider_receipt_digest":receipt_digest}); return state

def invalidate(path,effect_id):
    rec=latest(path,effect_id)
    state="cancelled" if rec["status"]=="queued" else "compensation_required"
    append_record(path,{**rec,"status":state,"reason":"source_invalidated"}); return state

def read_fd(fd):
    chunks=[]
    while True:
        b=os.read(fd,65536)
        if not b: break
        chunks.append(b)
    return b"".join(chunks)

def main(argv=None):
    ap=argparse.ArgumentParser(); ap.add_argument("--state",required=True); sub=ap.add_subparsers(dest="cmd",required=True)
    q=sub.add_parser("enqueue"); q.add_argument("--plan",required=True); q.add_argument("--body",required=True)
    d=sub.add_parser("deliver"); d.add_argument("--plan",required=True); d.add_argument("--body",required=True); d.add_argument("--credential-fd",type=int,required=True); d.add_argument("--generation",type=int,required=True); d.add_argument("--fence",type=int,required=True)
    r=sub.add_parser("reconcile"); r.add_argument("--plan",required=True)
    i=sub.add_parser("invalidate"); i.add_argument("--effect",required=True)
    s=sub.add_parser("status"); s.add_argument("--effect",required=True)
    a=ap.parse_args(argv)
    try:
        if a.cmd in ("enqueue","deliver","reconcile"):
            plan=json.load(open(a.plan))
        if a.cmd=="enqueue": out=enqueue(a.state,plan,Path(a.body).read_bytes())
        elif a.cmd=="deliver":
            secret=bytearray(read_fd(a.credential_fd))
            try: out=deliver(a.state,plan,Path(a.body).read_bytes(),secret,a.generation,a.fence)
            finally: secret[:]=b"\0"*len(secret)
        elif a.cmd=="reconcile": out=reconcile(a.state,plan)
        elif a.cmd=="invalidate": out=invalidate(a.state,a.effect)
        else: out=latest(a.state,a.effect)
        print(canonical(out)); return 0
    except Refusal as exc: print(f"refused: {exc}",file=sys.stderr); return 2
if __name__=="__main__": raise SystemExit(main())
