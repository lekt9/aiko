#!/usr/bin/env python3
"""Cayden DM poller — watches the @cayden27 DM thread on @l_wis's account
and writes new inbound messages to ~/.contracts/inbox/cayden/dm.jsonl.

Run as a daemon (nohup or in tmux):
  python3 scripts/cayden-dm-poller.py --interval 30

The receptor contract waits on the inbox via wait-for-event.py.

State: ~/.contracts/inbox/cayden/.last_msg_id (tracks high-water-mark).
"""
import asyncio, json, pathlib, time, argparse, sys
from telethon import TelegramClient

CAYDEN_USERNAME = "cayden27"
CAYDEN_ID = 1313681228
INBOX_DIR = pathlib.Path.home() / ".contracts" / "inbox" / "cayden"
INBOX_FILE = INBOX_DIR / "dm.jsonl"
HWM_FILE = INBOX_DIR / ".last_msg_id"
SESSION = "/tmp/lewis_user"
API_ID_F = pathlib.Path.home() / ".config" / "telegram" / "api_id"
API_HASH_F = pathlib.Path.home() / ".config" / "telegram" / "api_hash"


def read_hwm() -> int:
    try:
        return int(HWM_FILE.read_text().strip())
    except FileNotFoundError:
        return 0


def write_hwm(mid: int) -> None:
    HWM_FILE.write_text(str(mid))


def append_event(row: dict) -> None:
    INBOX_FILE.parent.mkdir(parents=True, exist_ok=True)
    with INBOX_FILE.open("a") as f:
        f.write(json.dumps(row) + "\n")


async def poll_once(client: TelegramClient) -> int:
    hwm = read_hwm()
    cayden = await client.get_entity(CAYDEN_USERNAME)
    new = []
    async for m in client.iter_messages(cayden, limit=20):
        if m.id <= hwm:
            break
        # Only Cayden's outbound to us (m.out=False from our POV)
        if m.out:
            continue
        new.append(m)
    new.reverse()  # oldest first
    if not new:
        return 0
    for m in new:
        row = {
            "id": m.id,
            "from": {"username": CAYDEN_USERNAME, "id": CAYDEN_ID, "first_name": "Cayden"},
            "text": m.text or "",
            "date": m.date.isoformat(),
            "reply_to": m.reply_to_msg_id,
        }
        append_event(row)
        print(f"[{m.date.isoformat()}] @cayden27: {(m.text or '')[:200]}", flush=True)
    write_hwm(max(m.id for m in new))
    return len(new)


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=int, default=30)
    ap.add_argument("--once", action="store_true", help="single poll then exit")
    args = ap.parse_args()
    api_id = int(API_ID_F.read_text().strip())
    api_hash = API_HASH_F.read_text().strip()
    async with TelegramClient(SESSION, api_id, api_hash) as client:
        me = await client.get_me()
        print(f"poller live as @{me.username} watching @{CAYDEN_USERNAME} → {INBOX_FILE}", flush=True)
        while True:
            try:
                n = await poll_once(client)
                if n:
                    print(f"  +{n} new from @{CAYDEN_USERNAME}", flush=True)
            except Exception as e:
                print(f"  poll err: {e}", file=sys.stderr, flush=True)
            if args.once:
                break
            await asyncio.sleep(args.interval)


if __name__ == "__main__":
    asyncio.run(main())
