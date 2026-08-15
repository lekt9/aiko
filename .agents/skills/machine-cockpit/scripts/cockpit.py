#!/usr/bin/env python3
"""Decoupled cockpit: browser chat + Telegram wizard + self-aware health.
- Serves chat.html with __TOKEN__/__API_BASE__ from ~/.aiko/native/api.json
- Wraps aiko native telegram {status,set-token,approve-pair,log} + launchctl
- Self-aware layer: /api/telegram/self-aware and /api/auth-aware surface
  login/bridge/pairing state so the UI (and Aiko via Telegram) can explain
  instead of silently dropping requests. Daemon stays untouched."""
import json, os, sys, subprocess, pathlib, re, urllib.request, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

HOME = pathlib.Path.home()
AIKO_BIN = str(HOME / ".local" / "bin" / "aiko")
# chat template: prefer share dir (installed), fallback to /tmp
for _cand in [HOME / ".local/share/aiko-cockpit/index.template.html",
              pathlib.Path("/tmp/aiko-chat-ui.html")]:
    if _cand.exists():
        CHAT_HTML_TEMPLATE = _cand
        break
else:
    CHAT_HTML_TEMPLATE = HOME / ".local/share/aiko-cockpit/index.template.html"
PORT = int(os.environ.get("AIKO_COCKPIT_PORT", "8787"))
NATIVE_DISCOVERY = HOME / ".aiko" / "native" / "api.json"
NATIVE_TOKEN = HOME / ".aiko" / "native" / "token"
TELEGRAM_DAEMON_BIN = HOME / ".local" / "bin" / "telegram-daemon"
LOG_PATH = HOME / ".aiko" / "logs" / "telegram-bridge.log"
SETTINGS_PATH = HOME / ".aiko" / "user-settings.json"

def read_native():
    try:
        d = json.loads(NATIVE_DISCOVERY.read_text())
        return d["authorization"]["token"], d["baseUrl"]
    except Exception:
        try:
            tok = NATIVE_TOKEN.read_text().strip() if NATIVE_TOKEN.exists() else None
            return tok, "http://127.0.0.1:19420"
        except Exception:
            return None, None

def run_aiko(args):
    env = os.environ.copy()
    env["PATH"] = f"{HOME}/.local/bin:{HOME}/bin:/opt/homebrew/bin:/usr/bin:/bin"
    try:
        p = subprocess.run([AIKO_BIN] + args, capture_output=True, text=True, timeout=20, env=env)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except Exception as e:
        return 1, str(e)

def read_auth():
    """Self-aware: read /v1/auth via native bearer so UI knows signed_in."""
    tok, base = read_native()
    if not tok or not base:
        return {"signed_in": False, "provider": None, "accounts": [], "error": "native discovery missing"}
    try:
        req = urllib.request.Request(f"{base}/v1/auth", headers={"Authorization": f"Bearer {tok}"})
        with urllib.request.urlopen(req, timeout=4) as r:
            j = json.loads(r.read().decode())
            return {"signed_in": bool(j.get("signed_in")), "provider": j.get("provider"), "accounts": j.get("accounts") or [], "raw": j}
    except Exception as e:
        return {"signed_in": False, "provider": None, "accounts": [], "error": str(e)[:300]}

def read_telegram_state():
    """Self-aware snapshot: token/username/bridge/pairing + tail of log."""
    tok = None
    approved = []
    username = None
    try:
        if SETTINGS_PATH.exists():
            j = json.loads(SETTINGS_PATH.read_text())
            tel = j.get("telegram") or {}
            tok = (tel.get("botToken") or "").strip() or None
            approved = tel.get("approvedUserIds") or []
    except Exception:
        pass
    # live username via getMe (no secret logged — just username)
    if tok:
        try:
            with urllib.request.urlopen(f"https://api.telegram.org/bot{tok}/getMe", timeout=6) as r:
                gj = json.loads(r.read().decode())
                if gj.get("ok"):
                    username = (gj.get("result") or {}).get("username")
        except Exception:
            pass
    rc, out = run_aiko(["native", "telegram", "status"])
    running = False
    try:
        uid = os.getuid()
        p = subprocess.run(["launchctl", "print", f"gui/{uid}/net.theclarityproject.aiko.telegram-bridge"], capture_output=True, text=True, timeout=5)
        running = "state = running" in p.stdout
    except Exception:
        running = "running" in out.lower() and "bridge" in out.lower()
    log_tail = []
    try:
        if LOG_PATH.exists():
            log_tail = LOG_PATH.read_text().splitlines()[-20:]
    except Exception:
        pass
    # surface unauthorized attempts so UI can explain pairing
    pending_chats = []
    for line in log_tail:
        if "Unauthorized chat" in line:
            m = re.search(r"Unauthorized chat (\d+)", line)
            if m:
                cid = m.group(1)
                if cid not in pending_chats:
                    pending_chats.append(cid)
    return {
        "hasToken": bool(tok),
        "username": username,
        "running": running,
        "approvedUserIds": approved,
        "pendingChats": pending_chats[-5:],
        "bridgeLog": log_tail[-10:],
        "raw": out[:3000],
        "ok": rc == 0,
    }

def check_token_validity(token):
    token = token.strip()
    if len(token) < 20 or ":" not in token:
        return False, "looks too short"
    try:
        with urllib.request.urlopen(f"https://api.telegram.org/bot{token}/getMe", timeout=6) as r:
            j = json.loads(r.read().decode())
            if j.get("ok") and j.get("result", {}).get("username"):
                return True, j["result"]["username"]
            return False, j.get("description", "not ok")
    except Exception as e:
        return False, str(e)[:200]

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args): sys.stderr.write(f"{self.client_address[0]} - {fmt%args}\n")
    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status); self.send_header("Content-Type","application/json"); self.send_header("Access-Control-Allow-Origin","*"); self.send_header("Access-Control-Allow-Methods","GET,POST,OPTIONS"); self.send_header("Access-Control-Allow-Headers","Content-Type"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_OPTIONS(self): self.send_response(204); self.send_header("Access-Control-Allow-Origin","*"); self.send_header("Access-Control-Allow-Methods","GET,POST,OPTIONS"); self.send_header("Access-Control-Allow-Headers","Content-Type"); self.end_headers()
    def do_GET(self):
        parsed = urlparse(self.path); path = parsed.path
        if path in ("/","/index.html"):
            token, base = read_native()
            html = ""
            if CHAT_HTML_TEMPLATE.exists():
                html = CHAT_HTML_TEMPLATE.read_text()
                # chat.html has __TOKEN__/__API_BASE__ placeholders
                if token and base:
                    html = html.replace("__TOKEN__", token).replace("__API_BASE__", base)
                else:
                    html = html.replace("__TOKEN__","").replace("__API_BASE__","http://127.0.0.1:19420")
            else:
                html = "<h1>aiko cockpit not ready</h1>"
            body = html.encode()
            self.send_response(200); self.send_header("Content-Type","text/html; charset=utf-8"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body); return
        if path == "/api/health":
            tok, base = read_native()
            self.send_json({"ok": True, "nativeBase": base, "hasToken": bool(tok)}); return
        if path == "/api/auth-aware":
            # self-aware: single call that merges auth + native health
            tok, base = read_native()
            auth = read_auth()
            health = {"ok": False}
            try:
                req = urllib.request.Request(f"{base}/v1/health", headers={"Authorization": f"Bearer {tok}"}) if tok and base else None
                if req:
                    with urllib.request.urlopen(req, timeout=3) as r:
                        hj = json.loads(r.read().decode())
                        health = {"ok": hj.get("status")=="ok", "version": hj.get("version"), "contractAbi": hj.get("contractAbi"), "raw": hj}
            except Exception as e:
                health = {"ok": False, "error": str(e)[:300]}
            self.send_json({"auth": auth, "health": health, "nativeBase": base}); return
        if path in ("/api/telegram/self-aware", "/api/telegram/status"):
            # decoupled self-aware + FIRST_CONTACT auto-approve (no daemon fork):
            # if nobody is approved yet and someone is pending, whoever messaged first is auto-paired
            auth = read_auth()
            tel = read_telegram_state()
            # FIRST_CONTACT: whoever messaged first is paired by default (decoupled, idempotent)
            # Gate on signed_in — dont auto-approve while aiko cant reply (would hide the login banner)
            if auth.get("signed_in") and tel.get("hasToken") and tel.get("running") and not tel.get("approvedUserIds") and tel.get("pendingChats"):
                try:
                    first = str(tel["pendingChats"][0])
                    # persist via user-settings.json (the daemon's source of truth)
                    raw = SETTINGS_PATH.read_text() if SETTINGS_PATH.exists() else "{}"
                    uj = json.loads(raw) if raw.strip() else {}
                    tcfg = uj.setdefault("telegram", {})
                    lst = tcfg.setdefault("approvedUserIds", [])
                    cid = int(first)
                    if cid not in lst:
                        lst.append(cid)
                        SETTINGS_PATH.write_text(json.dumps(uj, indent=2))
                        # also reflect in self.json wiring
                        try:
                            sp = HOME / ".aiko/self.json"
                            if sp.exists():
                                sj2 = json.loads(sp.read_text())
                                for w in sj2.get("wiring", []):
                                    if "bridge" in w:
                                        b = w["bridge"]
                                        if cid not in b.get("approvedUserIds", []):
                                            b.setdefault("approvedUserIds", []).append(cid)
                                        if first in b.get("pendingChats", []):
                                            b["pendingChats"] = [x for x in b["pendingChats"] if x != first]
                                sp.write_text(json.dumps(sj2, indent=2))
                        except: pass
                        # re-read so response reflects it
                        tel = read_telegram_state()
                except: pass
            hint = None
            if not auth.get("signed_in"):
                hint = "not_signed_in"
            elif not tel.get("hasToken"):
                hint = "no_telegram_token"
            elif not tel.get("running"):
                hint = "bridge_stopped"
            elif not tel.get("approvedUserIds"):
                if tel.get("pendingChats"):
                    hint = "needs_pairing"
                else:
                    hint = "waiting_first_message"
            else:
                hint = "ready"
            self.send_json({**tel, "auth": auth, "hint": hint, "action": {
                "not_signed_in": "Run `aiko login --device-code` on this Mac, then recheck.",
                "no_telegram_token": "Paste a bot token in the Telegram tab.",
                "bridge_stopped": "Click Start bridge.",
                "needs_pairing": f"Pending chats {tel.get('pendingChats')}: message @{(tel.get('username') or 'your bot')} then paste the pairing code.",
                "waiting_first_message": f"Message @{(tel.get('username') or 'your bot')} on Telegram to pair.",
                "ready": "All good — @"+(tel.get("username") or "bot")+" · bridge running · "+str(len(tel.get("approvedUserIds") or []))+" paired",
            }.get(hint, "")}); return
        if path == "/api/telegram/check":
            rc, out = run_aiko(["native","telegram","status"])
            try:
                raw = SETTINGS_PATH.read_text(); j = json.loads(raw)
                tok = (j.get("telegram") or {}).get("botToken") or ""
                ok, info = check_token_validity(tok) if tok else (False, "no token saved yet")
                self.send_json({"ok": ok, "username": info if ok else None, "error": None if ok else info, "raw": out[:2000]}); return
            except Exception as e:
                self.send_json({"ok": False, "error": str(e), "raw": out[:2000]}); return
        if path == "/api/telegram/log":
            try:
                txt = LOG_PATH.read_text() if LOG_PATH.exists() else ""
                self.send_json(txt.splitlines()[-80:])
            except Exception as e: self.send_json({"ok": False, "error": str(e)})
            return
        if path in ("/api/self", "/v1/self"):
            try:
                sj = {}
                sp = HOME / ".aiko/self.json"
                if sp.exists():
                    sj = json.loads(sp.read_text())
                sj = {**sj, "auth": read_auth(), "live": {"telegram": read_telegram_state()}}
                self.send_json(sj)
            except Exception as e:
                self.send_json({"ok": False, "error": str(e)}, 500)
            return
        self.send_response(404); self.end_headers(); self.wfile.write(b"not found")

    def do_POST(self):
        parsed = urlparse(self.path); path = parsed.path
        length = int(self.headers.get("Content-Length","0") or 0)
        body = self.rfile.read(length) if length else b""
        try: data = json.loads(body.decode()) if body else {}
        except: data = {}
        if path == "/api/telegram/set-token":
            tok = (data.get("token") or "").strip()
            if not tok or len(tok) < 20:
                self.send_json({"ok": False, "error": "token too short"}, 400); return
            ok, info = check_token_validity(tok)
            if not ok:
                self.send_json({"ok": False, "error": f"Telegram rejected token: {info}"}, 400); return
            rc, out = run_aiko(["native","telegram","set-token", tok])
            if rc != 0:
                self.send_json({"ok": False, "error": out[:2000]}, 400); return
            masked = f"{tok[:6]}…{tok[-6:]}" if len(tok) > 12 else "••••"
            self.send_json({"ok": True, "masked": masked, "username": info, "raw": out[:2000]}); return
        if path == "/api/telegram/start":
            if not TELEGRAM_DAEMON_BIN.exists():
                self.send_json({"ok": False, "error": f"telegram-daemon not found at {TELEGRAM_DAEMON_BIN}"}, 500); return
            uid = os.getuid(); label = "net.theclarityproject.aiko.telegram-bridge"
            plist = HOME / "Library" / "LaunchAgents" / f"{label}.plist"
            plist.parent.mkdir(parents=True, exist_ok=True)
            log_dir = HOME / ".aiko" / "logs"; log_dir.mkdir(parents=True, exist_ok=True)
            daemon_path = str(TELEGRAM_DAEMON_BIN)
            plist.write_text(f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key><array><string>{daemon_path}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>{log_dir}/telegram-bridge.log</string>
  <key>StandardErrorPath</key><string>{log_dir}/telegram-bridge.log</string>
  <key>EnvironmentVariables</key><dict><key>RUST_LOG</key><string>info,telegram_daemon=debug</string></dict>
</dict></plist>""")
            subprocess.run(["launchctl","bootout", f"gui/{uid}/{label}"], capture_output=True, timeout=5)
            rc = subprocess.run(["launchctl","bootstrap", f"gui/{uid}", str(plist)], capture_output=True, text=True, timeout=10)
            rc2 = subprocess.run(["launchctl","kickstart", f"gui/{uid}/{label}"], capture_output=True, text=True, timeout=10)
            time.sleep(1)
            auth = read_auth(); tel = read_telegram_state()
            self.send_json({"ok": tel.get("running"), "running": tel.get("running"), "auth": auth, "telegram": tel, "bootstrap": rc.stdout+rc.stderr, "kickstart": rc2.stdout+rc2.stderr}); return
        if path == "/api/telegram/stop":
            uid = os.getuid(); label="net.theclarityproject.aiko.telegram-bridge"
            subprocess.run(["launchctl","bootout", f"gui/{uid}/{label}"], capture_output=True, timeout=10)
            tel = read_telegram_state()
            self.send_json({"ok": not tel.get("running"), "running": tel.get("running"), "telegram": tel}); return
        if path == "/api/telegram/approve-pair":
            code = (data.get("code") or "").strip().upper()
            if not re.fullmatch(r"[0-9A-F]{4,6}", code):
                self.send_json({"ok": False, "error": "code must be 4–6 hex chars (0-9, A-F)"}, 400); return
            rc, out = run_aiko(["native","telegram","approve-pair", code])
            tel = read_telegram_state()
            self.send_json({"ok": rc==0, "error": None if rc==0 else out[:2000], "raw": out[:4000], "telegram": tel}); return
        self.send_response(404); self.end_headers()

if __name__ == "__main__":
    tok, base = read_native()
    print(f"aiko cockpit http://127.0.0.1:{PORT}  (chat + telegram + self-aware) — Ctrl-C to stop")
    print(f"  native {base}  auth check via /v1/auth")
    print(f"  daemon {TELEGRAM_DAEMON_BIN} {'exists' if TELEGRAM_DAEMON_BIN.exists() else 'MISSING'}")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
