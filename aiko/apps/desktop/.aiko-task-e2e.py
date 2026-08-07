"""End-to-end: drive /ws/chat and confirm the Task chat is aiko-backed.

Creates a session, joins it, sends one message, and collects the AgentEvents.
Passes only if reasoning (thinking) AND a whole assistant message AND done all
arrive — i.e. the aiko engine reached the Task view, not the Manus sandbox.
"""
import asyncio, json, sys, time, uuid
import urllib.request
import websockets

BASE = "http://127.0.0.1:8000/api/v1"
WS = "ws://127.0.0.1:8000/api/v1/ws/chat"
PROMPT = sys.argv[1] if len(sys.argv) > 1 else "What is 6 times 7? Think briefly, then answer."


def create_session():
    req = urllib.request.Request(f"{BASE}/sessions", method="PUT")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)["data"]["session_id"]


def envelope(type_, **fields):
    return {"id": uuid.uuid4().hex[:8], "timestamp": int(time.time()), "version": 2, "type": type_, **fields}


async def main():
    sid = create_session()
    print("session:", sid)
    seen = {"reasoning": 0, "tool": 0, "message": [], "done": 0, "status": [], "other": []}
    async with websockets.connect(WS, max_size=16 * 1024 * 1024) as ws:
        await ws.send(json.dumps(envelope("join_session", session_id=sid)))
        await ws.send(json.dumps(envelope("chat", session_id=sid, message=PROMPT)))
        deadline = time.time() + 150
        while time.time() < deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=120)
            except asyncio.TimeoutError:
                print("timeout"); break
            msg = json.loads(raw)
            t = msg.get("type")
            if t == "event":
                ev = msg.get("event")
                if ev == "reasoning":
                    seen["reasoning"] += 1
                elif ev == "tool":
                    seen["tool"] += 1
                elif ev == "message":
                    seen["message"].append(msg["data"].get("content", "")[:80])
                elif ev == "done":
                    seen["done"] += 1
                elif ev == "status_update":
                    seen["status"].append(msg["data"].get("agent_status"))
                elif ev in ("title",):
                    pass
                else:
                    seen["other"].append(ev)
            elif t == "stream_end":
                print("stream_end")
                break
            elif t == "error":
                print("ERROR frame:", msg.get("error")); break

    print("\n=== observed ===")
    print("reasoning events:", seen["reasoning"])
    print("tool events     :", seen["tool"])
    print("assistant msgs  :", seen["message"])
    print("done            :", seen["done"])
    print("status_updates  :", seen["status"])
    print("other events    :", seen["other"])

    ok = seen["reasoning"] > 0 and len(seen["message"]) >= 1 and seen["done"] >= 1
    # status must settle so the spinner clears
    settled = any(s in ("completed", "waiting", "error") for s in seen["status"])
    print("\nRESULT:", "PASS — Task chat is aiko-backed (thinking+answer+done, spinner settles)"
          if (ok and settled) else "FAIL")
    sys.exit(0 if (ok and settled) else 1)


asyncio.run(main())
