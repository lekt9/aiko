#!/usr/bin/env python3
"""Decoupled first-contact auto-approve — whoever messaged first is paired by default.

Runs OUTSIDE the daemon (cockpit layer). Reads approvedUserIds + bridge log;
if approved is empty and pendingChats exist, auto-approves the earliest pending
chat and persists to user-settings.json + self.json wiring, then kicks bridge.

Idempotent: if someone is already approved, does nothing.
Safe: never stores token, just chat id. Log parsing only.
"""
import json, pathlib, re, subprocess, sys, os
HOME = pathlib.Path.home()
SETTINGS = HOME / ".aiko/self.json"  # we update both, but primary is user-settings.json
USER_SETTINGS = HOME / ".aiko/user-settings.json"
LOG = HOME / ".aiko/logs/telegram-bridge.log"

def load_user_settings():
    try: return json.loads(USER_SETTINGS.read_text())
    except: return {}

def load_approved():
    try: return (load_user_settings().get("telegram") or {}).get("approvedUserIds") or []
    except: return []

def pending_from_log():
    if not LOG.exists(): return []
    out=[]
    for line in LOG.read_text().splitlines():
        m=re.search(r"Unauthorized chat (\d+)", line)
        if m and m.group(1) not in out:
            out.append(m.group(1))
    return out

def approve(chat_id_str):
    cid=int(chat_id_str)
    raw = load_user_settings()
    tel = raw.setdefault("telegram", {})
    lst = tel.setdefault("approvedUserIds", [])
    if cid in lst:
        print(f"already approved {cid}")
        return False
    lst.append(cid)
    USER_SETTINGS.write_text(json.dumps(raw, indent=2))
    print(f"FIRST_CONTACT auto.approve {cid} -> {USER_SETTINGS}")
    # also update self.json wiring if present
    try:
        sj = json.loads((HOME/".aiko/self.json").read_text())
        for w in sj.get("wiring",[]):
            if "bridge" in w:
                b=w["bridge"]
                if cid not in b.get("approvedUserIds",[]):
                    b.setdefault("approvedUserIds", []).append(cid)
                # remove from pending
                if str(cid) in b.get("pendingChats",[]):
                    b["pendingChats"]=[x for x in b["pendingChats"] if x!=str(cid)]
        (HOME/".aiko/self.json").write_text(json.dumps(sj, indent=2))
    except Exception as e:
        print(f"self.json update skip: {e}")
    # kick bridge so it re-reads approvedUserIds
    try:
        uid=os.getuid()
        # daemon reads file on each poll? still kick to be safe
        subprocess.run(["launchctl","kickstart","-k",f"gui/{uid}/net.theclarityproject.aiko.telegram-bridge"], capture_output=True, timeout=5)
    except: pass
    return True

if __name__=="__main__":
    approved=load_approved()
    if approved:
        print(f"FIRST_CONTACT skip — already approved {approved}")
        sys.exit(0)
    pending=pending_from_log()
    if not pending:
        print("FIRST_CONTACT no pending chats yet")
        sys.exit(0)
    # whoever messaged first = earliest pending
    first=pending[0]
    approve(first)
