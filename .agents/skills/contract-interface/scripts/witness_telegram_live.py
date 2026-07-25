#!/usr/bin/env python3
"""witness_telegram_live.py — RM6 bounded live proof for the Telegram receptor.

The receptor mesh (RM0-RM7) is built; RM6 is the LIVE-provider step: prove a
real Telegram effect lands through the Bot API. This is the bounded live proof
(getMe + ONE sendMessage), not a standing webhook. The bot token + chat id are
loaded from the repo .env (never printed, never placed in a contract/log).

Authority: this sends ONE real message to the chat in .env (the owner's own
chat). Externally visible — run only with explicit authorization.

Exit 0 only when:
  - getMe returns ok:true (the token is live) AND
  - sendMessage returns ok:true with a message_id (the effect landed)

That is two-witness corroboration: the token works (read-only) + the effect
landed (the binding external witness). Provider-neutral: Telegram is the
example provider; the receptor shape (observe -> authorize -> effect -> settle)
is the same as the generic proposer receptor.
"""
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

ENV_PATH = Path(__file__).resolve().parents[4] / ".env"  # repo root .env


def load_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip("'\"")
    return out


def api(token: str, method: str, payload: dict | None = None) -> dict:
    url = f"https://api.telegram.org/bot{token}/{method}"
    data = json.dumps(payload).encode() if payload else None
    headers = {"Content-Type": "application/json"} if payload else {}
    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if payload else "GET")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def main() -> int:
    env = load_env(ENV_PATH)
    # Allow override from the real environment too (do not print the token).
    token = os.environ.get("TELEGRAM_BOT_TOKEN") or env.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID") or env.get("TELEGRAM_CHAT_ID")
    if not token:
        print("RED: TELEGRAM_BOT_TOKEN not set (env or .env)")
        return 1
    if not chat_id:
        print("RED: TELEGRAM_CHAT_ID not set (env or .env)")
        return 1

    # Witness 1 (read-only): the token is live.
    me = api(token, "getMe")
    if not me.get("ok"):
        print(f"RED: getMe failed: {me}")
        return 1
    bot = me["result"]["username"]
    print(f"getMe ok: bot=@{bot}")

    # Witness 2 (the binding external effect): one real message lands.
    text = f"RM6 live receptor proof: contract-native Telegram effect witnessed at {int(time.time())} (bounded live proof, one message)."
    sent = api(token, "sendMessage", {"chat_id": chat_id, "text": text})
    if not sent.get("ok"):
        print(f"RED: sendMessage failed: {sent}")
        return 1
    msg_id = sent["result"]["message_id"]
    date = sent["result"].get("date")
    print(f"sendMessage ok: message_id={msg_id} date={date}")
    print("VERDICT=PASS (token live + effect landed)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
