#!/usr/bin/env python3
"""Pure admitted planner: pinned normalized request -> durable outbox intent."""
import hashlib,json,sys
s=json.load(sys.stdin); req=None
for r in s.get("reads",[]):
 if r.get("schema")=="neuron.telethon-effect-request/v1": req=json.loads(r["bytes"]); source=r["id"]
if req is None:
 json.dump({"schema":"neuron.rejection/v1","failure":"dependency","detail":"pinned request required"},sys.stdout); raise SystemExit
needed=("effect_id","execution","conversation_id","recipient_id","payload_digest","credential_handle","expires_at")
if any(k not in req for k in needed):
 json.dump({"schema":"neuron.rejection/v1","failure":"validation","detail":"incomplete request"},sys.stdout); raise SystemExit
plan=dict(req,schema="neuron.telethon-effect-plan/v1")
json.dump({"schema":"neuron.decision/v1","control":{"kind":"terminate","result":"planned"},"effects":[{"kind":"write","artifact":{"id":"artifact/telethon/outbox/"+req["effect_id"],"schema":"neuron.telethon-effect-plan/v1","bytes":json.dumps(plan,sort_keys=True,separators=(",",":"))}}],"evidence":[{"claim":"effect plan derives from the pinned normalized request","method":"pure projection","sources":[source]}]},sys.stdout)
