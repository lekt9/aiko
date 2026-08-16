#!/usr/bin/env python3
"""Prove the gate catches the three named lifecycle lies."""
import os, shutil, subprocess, sys, tempfile
from pathlib import Path
SOURCE=Path(__file__).resolve().parent.parent
TEST=SOURCE/"tests/conformance.py"

def mutate(name, relative, old, new):
 root=Path(tempfile.mkdtemp(prefix="unbrowse-mutant-"+name+".")); limb=root/"unbrowse"
 shutil.copytree(SOURCE,limb,ignore=shutil.ignore_patterns("__pycache__","*.pyc"))
 path=limb/relative; text=path.read_text()
 assert text.count(old)==1,(name,text.count(old))
 path.write_text(text.replace(old,new))
 env=dict(os.environ,UNBROWSE_LIMB=str(limb))
 p=subprocess.run([sys.executable,str(TEST)],env=env,text=True,capture_output=True)
 if p.returncode==0:
  print(f"FAIL: {name} mutant survived the public conformance witness",file=sys.stderr)
  print(p.stdout,file=sys.stderr); raise SystemExit(1)
 print(f"  mutation killed: {name}")

mutate("promote-on-observation","neurons/unbrowse.py",
       '"status": "observed", "observation_firing_id"',
       '"status": "promoted", "observation_firing_id"')
mutate("serve-after-drift","boundary.py",
       'if projection.get("status") != "promoted":',
       'if False:  # MUTANT: ignores Contract demotion')
mutate("retain-raw-response","boundary.py",
       'return BoundaryResult(event=event)\n\ndef replay',
       'event["raw_response"] = product  # MUTANT: capture leaked into durable evidence\n    return BoundaryResult(event=event)\n\ndef replay')
mutate("retain-secret","boundary.py",
       'event = {"schema": EVENT_SCHEMA, "kind": "observation",',
       'event = {"secret": "test-only-boundary-secret-91", "schema": EVENT_SCHEMA, "kind": "observation",')
print("unbrowse limb mutation falsifiers: PASS")
