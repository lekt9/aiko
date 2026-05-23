#!/usr/bin/env python3
"""merjs renderer: substrate stdio → markdown-with-structured-blocks
suitable for a merjs (or any markdown-component) renderer. Sections:

    ## <title>
    <prose body>
    ### Actions
    - [<label>](cmd:<command>)
    ### Raw
    ```
    <truncated raw>
    ```

This is the "structured components" path — no raw JSON in the UI rule
(see "No raw JSON in the UI" doctrine). The HTML/JSX renderer maps each
section to a real component (KPI card, action list, code block).
"""
from __future__ import annotations
import os, re, sys

def parse(text: str) -> dict:
    lines = text.splitlines()
    title = "Update"
    body = []
    actions = []
    for line in lines:
        s = line.strip()
        m = re.match(r"=== (.+) ===", s)
        if m:
            title = m.group(1).title()
            continue
        for am in re.finditer(r"contract (iterate|_mark|judge|render|context-of|next-of) ([0-9a-f]{8})\b", line):
            actions.append((am.group(1), am.group(2)))
        if s and not s.startswith("=") and not s.startswith("Run:") and not s.startswith("If genuine"):
            body.append(s)
    body_text = " ".join(body)[:600]
    # de-dup actions
    seen = set()
    uniq = []
    for v, i in actions:
        k = (v, i)
        if k in seen: continue
        seen.add(k); uniq.append(k)
        if len(uniq) >= 5: break
    return {"title": title, "body": body_text, "actions": uniq}


def main() -> int:
    text = sys.stdin.read()
    cid = os.environ.get("CONTEXT_CONTRACT_ID", "")
    parsed = parse(text)
    out = []
    out.append(f"## {parsed['title']}")
    if cid:
        out.append(f"_contract `{cid}`_")
    out.append("")
    if parsed["body"]:
        out.append(parsed["body"])
        out.append("")
    if parsed["actions"]:
        out.append("### Actions")
        for verb, ref in parsed["actions"]:
            out.append(f"- [{verb} `{ref[:8]}`](cmd:contract%20{verb}%20{ref})")
        out.append("")
    out.append("### Raw")
    out.append("```")
    out.append(text[:1200] + ("\n…(truncated)" if len(text) > 1200 else ""))
    out.append("```")
    sys.stdout.write("\n".join(out) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
