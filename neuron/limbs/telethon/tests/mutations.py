#!/usr/bin/env python3
"""Mutation survivors here would reopen a production boundary bug."""
import os,subprocess,sys,tempfile
from pathlib import Path
root=Path(__file__).parents[1]; source=(root/"boundary.py").read_text(); test=root/"tests"/"conformance.py"
baseline=subprocess.run([sys.executable,str(test)],stdout=subprocess.DEVNULL)
if baseline.returncode: raise SystemExit("baseline conformance failed")
mutants={
 "acl-not-exact":('if (event["conversation_id"],event["sender_id"],"observe") not in acl:', 'if event["sender_id"] not in {x[1] for x in acl}:'),
 "aggregate-readback":('and receipt.get("recipient_id")==plan["recipient_id"]', 'and True'),
 "blind-replay":('if row["status"]!="queued":', 'if False:'),
 "expiry-off-by-one":('if now>=int(row["expires_at"]):', 'if now>int(row["expires_at"]):'),
 "aggregate-amendment":('if before.get(r)!=after.get(r)]', 'if True]'),
}
for name,(old,new) in mutants.items():
 if source.count(old)!=1: raise SystemExit("mutation anchor missing: "+name)
 with tempfile.TemporaryDirectory() as td:
  candidate=Path(td)/"boundary.py"; candidate.write_text(source.replace(old,new))
  env=dict(os.environ,TELETHON_BOUNDARY=str(candidate)); p=subprocess.run([sys.executable,str(test)],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  if p.returncode==0: raise SystemExit("mutation survived: "+name)
 print("  killed",name)
print("telethon mutation falsifiers: PASS")
