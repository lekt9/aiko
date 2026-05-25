#!/usr/bin/env python3
"""Harvest authentic user prompts from Claude transcripts in PROJECT_DIRS."""
import json, os, glob, re, sys
from datetime import datetime, timedelta, timezone

SINCE_DAYS = int(os.environ.get("SINCE_DAYS", "8"))
PROJECT_DIRS = os.environ.get("PROJECT_DIRS", "").split()
cutoff = datetime.now(timezone.utc) - timedelta(days=SINCE_DAYS)

prompts = []
SKIP_PAT = re.compile(r"^(<system-reminder|<command-message|<local-command|\[Request interrupted)", re.I)

for d in PROJECT_DIRS:
    if not os.path.isdir(d):
        continue
    for fp in sorted(glob.glob(os.path.join(d, "*.jsonl"))):
        try:
            mtime = datetime.fromtimestamp(os.path.getmtime(fp), tz=timezone.utc)
        except Exception:
            continue
        if mtime < cutoff:
            continue
        with open(fp, "r", errors="replace") as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                if row.get("type") != "user":
                    continue
                msg = row.get("message", {})
                if msg.get("role") != "user":
                    continue
                content = msg.get("content")
                texts = []
                if isinstance(content, list):
                    for blk in content:
                        if isinstance(blk, dict) and blk.get("type") == "text":
                            texts.append(blk.get("text", ""))
                elif isinstance(content, str):
                    texts.append(content)
                if not texts:
                    continue
                joined = "\n".join(texts).strip()
                if not joined or SKIP_PAT.match(joined):
                    continue
                if joined.startswith("Base directory for this skill") or "# /contract\n\nCore job:" in joined[:400]:
                    m = re.search(r"<command-args>([^<]+)</command-args>", joined)
                    if m:
                        joined = "/contract " + m.group(1).strip()
                    else:
                        continue
                if len(joined) < 6:
                    continue
                ts = row.get("timestamp") or msg.get("timestamp") or ""
                prompts.append((ts, os.path.basename(fp), joined))

prompts.sort()
seen = set()
for ts, fp, text in prompts:
    key = text[:200]
    if key in seen:
        continue
    seen.add(key)
    print(json.dumps({"ts": ts, "file": fp, "text": text}))
