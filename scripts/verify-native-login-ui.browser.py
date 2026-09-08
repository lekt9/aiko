#!/usr/bin/env python3
"""Deployed /connect witness; run --prepare, then --live after the parent's go.

python3 scripts/verify-native-login-ui.browser.py --prepare
python3 scripts/verify-native-login-ui.browser.py --live

Optional --connection UUID resumes an explicitly selected pending canary login.
Otherwise Add website starts/resumes the canary through the actual UI/API. A
previously connected canary is disconnected through its UI first for a fresh login.
Only /api/connectors/session is simulated. CDP supplies the real synthetic bearer;
native login and connection responses are observed, never replaced. Preparation
tests that header override and origin isolation locally without touching the account.
Chrome and browser-harness use disposable runtime directories, never personal cookies.
Only the named JSON and PNG artifacts are retained. No Telegram messages are sent.
"""

import argparse
import base64
import hashlib
import http.server
import json
import os
import pathlib
import queue
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit

ROOT = pathlib.Path(os.environ.get("UNLOCK_ROOT", pathlib.Path.cwd())).resolve()
DOMAIN = "unlock-login-canary.lewis-6d8.workers.dev"
OWNER = "acct_cloudflare_e2e02"
OUT = ROOT / "artifacts/connectors/browser/native-login-recovery-ui.json"
PNG = OUT.with_suffix(".png")
UUID = r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"


class WitnessError(Exception):
    """Only fixed, credential-free messages may be emitted."""


def require(condition, message):
    if not condition:
        raise WitnessError(message)


def announce(message):
    print(message, flush=True)


def private_config():
    # Use the same owner-only parser as verify-deployed-native-login.ts. Its
    # stdout is captured in memory; neither the bearer nor config is logged.
    code = """
    import { cloudflareState } from './scripts/cloudflare-paths.ts';
    const s = await cloudflareState();
    process.stdout.write(JSON.stringify({base:s.AIKO_CLOUDFLARE_URL,
      owner:s.AIKO_E2E_OWNER,token:s.AIKO_E2E_TOKEN}));
    """
    result = subprocess.run(["bun", "--eval", code], cwd=ROOT,
                            capture_output=True, timeout=30)
    require(result.returncode == 0, "Could not read private canary configuration")
    config = json.loads(result.stdout)
    require(config.get("owner") == OWNER, "Refusing a non-canary account")
    base = config.get("base", "").rstrip("/")
    url = urlsplit(base)
    require(url.scheme == "https" and url.hostname and not url.username
            and not url.password and not url.path and not url.query
            and not url.fragment, "Expected an HTTPS deployment origin")
    require(isinstance(config.get("token"), str) and bool(config["token"]),
            "Missing synthetic bearer")
    config["base"] = base
    return config


def browser_binary():
    candidates = [os.environ.get("CHROME_BIN"), shutil.which("chromium"),
                  shutil.which("google-chrome"), shutil.which("chromium-browser")]
    for root in (pathlib.Path.home() / ".local/share/flatpak", pathlib.Path("/var/lib/flatpak")):
        candidates.append(str(root / "app/org.chromium.Chromium/current/active/files/chromium/chrome"))
    for candidate in candidates:
        if candidate and pathlib.Path(candidate).is_file():
            return pathlib.Path(candidate).resolve()
    raise WitnessError("Chrome not found; set CHROME_BIN to an installed Chromium executable")


def launch(args):
    require(shutil.which("browser-harness"), "browser-harness is not installed")
    binary = browser_binary()
    with tempfile.TemporaryDirectory(prefix="unlock-ui-", dir="/tmp") as directory:
        runtime = pathlib.Path(directory)
        env = {**os.environ, "UNLOCK_ROOT": str(ROOT), "BH_NO_BROWSER_COOKIES": "1",
               "BH_RECORD": "0", "BH_TELEMETRY": "0", "BH_DOMAIN_SKILLS": "0",
               "BU_NAME": "login-ui-" + str(os.getpid()),
               "BH_HOME": str(runtime / "harness"),
               "BH_AGENT_WORKSPACE": str(runtime / "workspace"),
               "BH_WITNESS_CHILD": "1", "BH_WITNESS_LIVE": "1" if args.live else "0",
               "BH_WITNESS_CONNECTION": args.connection or "",
               "LD_LIBRARY_PATH": str(binary.parent) + ":" + os.environ.get("LD_LIBRARY_PATH", "")}
        # Never inherit an endpoint, tracing setting, profile or runtime directory.
        for key in ("BU_CDP_WS", "BU_CDP_URL", "BU_BROWSER_ID", "BU_AUTOSPAWN",
                    "BH_DEBUG_CLICKS", "BH_CONFIG_DIR", "BH_RUNTIME_DIR", "BH_TMP_DIR",
                    "BH_COOKIE_DB", "BH_BROWSER", "BH_PROFILE"):
            env.pop(key, None)
        chrome = subprocess.Popen(
            [str(binary), "--headless=new", "--no-sandbox", "--disable-gpu",
             "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
             "--disable-background-networking", "--disable-sync", "--disable-extensions",
             "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
             "--user-data-dir=" + str(runtime / "chrome"), "about:blank"],
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True)
        try:
            port_file = runtime / "chrome/DevToolsActivePort"
            deadline = time.monotonic() + 20
            while not port_file.exists() and time.monotonic() < deadline and chrome.poll() is None:
                time.sleep(.1)
            require(port_file.exists(), "Isolated Chrome did not become ready")
            port = int(port_file.read_text().splitlines()[0])
            env["BU_CDP_URL"] = "http://127.0.0.1:" + str(port)
            source = (ROOT / "scripts/verify-native-login-ui.browser.py").read_text()
            # Script output is restricted to our fixed progress/error messages.
            process = subprocess.Popen(["browser-harness"], text=True, env=env, cwd=ROOT,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.DEVNULL)
            def forward_progress():
                for line in process.stdout:
                    if line.startswith(("PASS:", "READY:", "WAITING:", "FAIL:")):
                        announce(line.rstrip())
            forwarding = threading.Thread(target=forward_progress, daemon=True)
            forwarding.start()
            try:
                process.stdin.write(source)
                process.stdin.close()
                process.wait(timeout=1200)
                forwarding.join(timeout=5)
                require(process.returncode == 0, "Browser witness did not pass; no success receipt was issued")
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
        finally:
            subprocess.run(["browser-harness", "--reload"], env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            if chrome.poll() is None:
                os.killpg(chrome.pid, signal.SIGTERM)
                try:
                    chrome.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(chrome.pid, signal.SIGKILL)
                    chrome.wait(timeout=5)


_gate_stop = threading.Event()
_gate_thread = None
_gate_failed = False
_network_events = queue.Queue()


def stop_network_gate():
    global _gate_thread
    if _gate_thread is not None:
        _gate_stop.set()
        _gate_thread.join(timeout=6)
        # Keep interception enabled until the isolated browser is destroyed;
        # disabling it could release a paused cross-origin request with headers.
        _gate_thread = None


def network_events():
    require(not _gate_failed, "Browser origin isolation stopped unexpectedly")
    events = []
    while True:
        try:
            events.append(_network_events.get_nowait())
        except queue.Empty:
            return events


def isolate_network(base, token):
    global _gate_thread, _gate_failed, _network_events
    cdp("Network.enable")
    cdp("Network.setCacheDisabled", cacheDisabled=True)
    cdp("Network.setBypassServiceWorker", bypass=True)
    # Older Chrome silently ignores Network.setBlockedURLs.urlPatterns. Gate
    # transport instead: same-origin requests continue completely unchanged;
    # cross-origin requests/redirects fail before the bearer leaves Chrome.
    # No API response is fulfilled or replaced by this gate.
    cdp("Fetch.enable", patterns=[{"urlPattern": "*", "requestStage": "Request"}])
    _gate_failed = False
    _network_events = queue.Queue()
    _gate_stop.clear()

    def gate():
        global _gate_failed
        try:
            while not _gate_stop.is_set():
                for event in drain_events():
                    if event.get("method") == "Fetch.requestPaused":
                        params = event["params"]
                        args = {"requestId": params["requestId"], "session_id": event.get("session_id")}
                        if params["request"]["url"].startswith(base + "/"):
                            cdp("Fetch.continueRequest", **args)
                        else:
                            cdp("Fetch.failRequest", errorReason="BlockedByClient", **args)
                    elif event.get("method", "").startswith("Network."):
                        _network_events.put(event)
                _gate_stop.wait(.05)
        except Exception:
            _gate_failed = True

    _gate_thread = threading.Thread(target=gate, daemon=True)
    _gate_thread.start()
    cdp("Network.setExtraHTTPHeaders", headers={"Authorization": "Bearer " + token})


def wait_until(predicate, message, timeout=30, pump=None):
    deadline, next_update = time.monotonic() + timeout, time.monotonic() + 25
    while time.monotonic() < deadline:
        if pump:
            pump()
        if predicate():
            return
        if time.monotonic() >= next_update:
            announce("WAITING: " + message)
            next_update = time.monotonic() + 25
        time.sleep(.15)
    raise WitnessError(message)


def prepare():
    hits = []

    class Probe(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            hits.append((self.server.server_port, self.path, self.headers.get("Authorization")))
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<!doctype html><title>Isolated witness preparation</title><p>Local probe</p>")

        def log_message(self, *args):
            pass

    servers = [http.server.ThreadingHTTPServer(("127.0.0.1", 0), Probe) for _ in range(2)]
    try:
        for server in servers:
            threading.Thread(target=server.serve_forever, daemon=True).start()
        base = "http://127.0.0.1:" + str(servers[0].server_port)
        forbidden = "http://127.0.0.1:" + str(servers[1].server_port)
        new_tab("about:blank")
        isolate_network(base, "local-probe-only")
        goto_url(base + "/")
        wait_for_load()
        js("fetch('/probe',{headers:{Authorization:'tms synthetic-session'}}).then(r=>r.text()).then(()=>window.probeDone=true);true")
        wait_until(lambda: js("window.probeDone === true"), "Local header probe did not complete")
        require(any(path == "/probe" and auth == "Bearer local-probe-only" for _, path, auth in hits),
                "CDP did not override the UI session header with the bearer")
        js("fetch(" + json.dumps(forbidden + "/must-not-receive-bearer") + ").catch(()=>window.blockedDone=true);true")
        wait_until(lambda: js("window.blockedDone === true"), "Cross-origin request was not blocked")
        require(not any(port == servers[1].server_port for port, _, _ in hits),
                "Bearer origin isolation failed")
        announce("PASS: isolated Chrome, real bearer header override, and cross-origin blocking")
        announce("READY: python3 scripts/verify-native-login-ui.browser.py --live")
        announce("READY: live login remains gated on the parent's go; preparation did not contact the deployment")
    finally:
        stop_network_gate()
        for server in servers:
            server.shutdown()
            server.server_close()


def live():
    config = private_config()
    base, token = config["base"], config["token"]
    connection_id = os.environ.get("BH_WITNESS_CONNECTION", "")
    receipt = {"verified": False, "base": base, "owner": OWNER, "domain": DOMAIN,
               "syntheticCredentials": True, "scope": "deployed-native-login-browser-ui"}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    # Invalidate an old green receipt before starting a new live attempt.
    PNG.unlink(missing_ok=True)

    def save():
        receipt["at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        OUT.write_text(json.dumps(receipt, indent=2) + "\n")

    save()

    def connections():
        # Match the deployed API witness's Bun transport. Some deployment edges
        # reject Python urllib before the authenticated application is reached.
        code = """
        import {cloudflareState} from './scripts/cloudflare-paths.ts';
        const s=await cloudflareState();
        if(s.AIKO_E2E_OWNER!=='acct_cloudflare_e2e02')throw Error('Invalid canary');
        const r=await fetch(s.AIKO_CLOUDFLARE_URL.replace(/\\/$/,'')+'/api/connectors/connections',
          {headers:{authorization:'Bearer '+s.AIKO_E2E_TOKEN},redirect:'error',signal:AbortSignal.timeout(30000)});
        process.stdout.write(JSON.stringify({httpStatus:r.status,value:r.ok?await r.json():null}));
        """
        result = subprocess.run(["bun", "--eval", code], cwd=ROOT, capture_output=True, timeout=40)
        require(result.returncode == 0, "Deployed connection read did not complete")
        value = json.loads(result.stdout)
        require(value.get("httpStatus") == 200, "Deployed connection read was rejected")
        return value["value"]

    before = connections()
    require(before.get("nativeInline") is True, "Deployed native login is unavailable")
    previous = [r for r in before["connections"]
                if r.get("connectorId") == "browser:" + DOMAIN and r.get("status") == "connected"]
    require(len(previous) <= 1, "Multiple connected canaries require explicit coordination")
    retired_id = previous[0]["id"] if previous and not connection_id else None
    if connection_id:
        require(re.fullmatch(UUID, connection_id), "Invalid connection UUID")
        row = next((r for r in before["connections"] if r["id"] == connection_id), {})
        require(row.get("connectorId") == "browser:" + DOMAIN and row.get("status") == "pending",
                "Selected connection is not a pending synthetic canary")
    new_tab("about:blank")
    isolate_network(base, token)
    cdp("Emulation.setDeviceMetricsOverride", width=1280, height=1000,
        deviceScaleFactor=1, mobile=False)
    # Authentication shim ONLY. All other fetches execute unchanged, with the
    # real bearer applied by CDP after the app's tms header is constructed.
    shim = """(() => {
      window.Telegram = {WebApp: {initData: 'synthetic-canary-launch', ready(){}, expand(){}}};
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, options) => {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (url.origin === location.origin && url.pathname === '/api/connectors/session')
          return Promise.resolve(new Response(JSON.stringify({token:'synthetic-bearer-via-cdp'}),
            {status:200,headers:{'Content-Type':'application/json'}}));
        return originalFetch(input, options);
      };
    })();"""
    cdp("Page.addScriptToEvaluateOnNewDocument", source=shim)
    requests, evidence, clicks = {}, [], []

    def pump():
        nonlocal connection_id
        for event in network_events():
            params = event.get("params", {})
            request_id = params.get("requestId")
            if event["method"] == "Network.requestWillBeSent":
                request = params["request"]
                url = urlsplit(request["url"])
                if url.path not in ("/api/connectors/browser", "/api/connectors/native", "/api/connectors/disconnect"):
                    continue
                require(request["url"].startswith(base + "/"), "Unexpected API origin")
                body = json.loads(request.get("postData", "{}"))
                entry = {"path": url.path, "action": body.get("action")}
                if url.path.endswith("/browser"):
                    require(body.get("domain") == DOMAIN, "Refusing a non-canary website")
                elif url.path.endswith("/disconnect"):
                    require(retired_id and body.get("connectionId") == retired_id,
                            "Refusing to disconnect anything except the previous canary")
                else:
                    require(body.get("connectionId") == connection_id, "Native login connection mismatch")
                    if body.get("action") in ("login", "credentials"):
                        require(body.get("username") == "fixture-user" and body.get("password") == "fixture-password",
                                "Only synthetic login credentials are permitted")
                requests[request_id] = entry
            elif event["method"] == "Network.responseReceived" and request_id in requests:
                requests[request_id]["httpStatus"] = params["response"]["status"]
            elif event["method"] == "Network.loadingFinished" and request_id in requests:
                entry = requests.pop(request_id)
                raw = cdp("Network.getResponseBody", requestId=request_id)
                value = json.loads(base64.b64decode(raw["body"]) if raw.get("base64Encoded") else raw["body"])
                entry.update({k: value[k] for k in ("status", "revision", "credentialsSaved", "relayDisconnectStatus") if k in value})
                if entry["path"].endswith("/browser"):
                    require(value.get("nativeInline") is True and re.fullmatch(UUID, value.get("id", "")),
                            "Canary connection creation did not return a native connection")
                    connection_id = value["id"]
                evidence.append(entry)
            elif event["method"] == "Network.loadingFailed" and request_id in requests:
                raise WitnessError("A real native-login API request failed")

    def ax(role, name, contains=False):
        matches = [n for n in cdp("Accessibility.getFullAXTree")["nodes"]
                   if n.get("role", {}).get("value") == role
                   and (name in n.get("name", {}).get("value", "") if contains
                        else n.get("name", {}).get("value") == name)]
        require(len(matches) == 1, "Expected one accessible " + role + ": " + name)
        return matches[0]["backendDOMNodeId"]

    def click_node(node, label):
        cdp("DOM.scrollIntoViewIfNeeded", backendNodeId=node)
        box = cdp("DOM.getBoxModel", backendNodeId=node)["model"]["content"]
        x, y = sum(box[0::2]) / 4, sum(box[1::2]) / 4
        click_at_xy(x, y)
        clicks.append({"target": label, "x": x, "y": y, "method": "CDP coordinate click"})

    def click(role, name, contains=False):
        click_node(ax(role, name, contains), name)

    def fill(label, value, selector=None):
        # Password inputs have no textbox AX role in some Chrome versions.
        if selector:
            root = cdp("DOM.getDocument")["root"]["nodeId"]
            node = cdp("DOM.querySelector", nodeId=root, selector=selector)["nodeId"]
            backend = cdp("DOM.describeNode", nodeId=node)["node"]["backendNodeId"]
        else:
            backend = ax("textbox", label)
        click_node(backend, label)
        cdp("Input.dispatchKeyEvent", type="rawKeyDown", key="a", code="KeyA", modifiers=2,
            windowsVirtualKeyCode=65, commands=["selectAll"])
        cdp("Input.dispatchKeyEvent", type="keyUp", key="a", code="KeyA", modifiers=2)
        cdp("Input.insertText", text=value)

    goto_url(base + "/connect" + ("?connection=" + connection_id if connection_id else ""))
    wait_for_load()
    wait_until(lambda: js("!!document.querySelector('button[aria-label=\"Refresh connections\"]:not(:disabled)')"),
               "Waiting for authenticated Connect UI", timeout=180, pump=pump)
    announce("PASS: deployed Connect authenticated with the synthetic bearer")
    if retired_id:
        # A reusable witness must not mistake the parent's previously connected
        # canary for a new login. Only this synthetic connection is reset, and
        # only in --live after the parent has released the shared account.
        root = cdp("DOM.getDocument")["root"]["nodeId"]
        retired_selector = '[data-connection-id="' + retired_id + '"]'
        node = cdp("DOM.querySelector", nodeId=root, selector=retired_selector)["nodeId"]
        backend = cdp("DOM.describeNode", nodeId=node)["node"]["backendNodeId"]
        click_node(backend, "Previous synthetic canary")
        wait_until(lambda: js("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Disconnect app')"),
                   "Canary management did not open", pump=pump)
        click("button", "Disconnect app")
        wait_until(lambda: any(e["path"].endswith("/disconnect") and e.get("status") == "disconnected"
                               and e.get("httpStatus") == 200 and e.get("relayDisconnectStatus") == "confirmed"
                               for e in evidence), "Waiting for confirmed synthetic canary cleanup", timeout=180, pump=pump)
        wait_until(lambda: js("!document.querySelector(" + json.dumps(retired_selector)
                              + ") && !!document.querySelector('button[aria-label=\"Refresh connections\"]:not(:disabled)')"),
                   "Waiting for the refreshed canary UI", timeout=60, pump=pump)
        receipt["retiredConnectionId"] = retired_id
        announce("PASS: prior synthetic canary disconnected through the actual UI")
    if not connection_id:
        click("button", "Add website", contains=True)
        wait_until(lambda: js("!!document.querySelector('#website-domain')"), "Website form did not open", pump=pump)
        fill("Website address", DOMAIN)
        click("button", "Continue")
    wait_until(lambda: bool(connection_id) and js("!!document.querySelector('#website-password:not(:disabled)')"),
               "Waiting for the canary private-login form", timeout=180, pump=pump)
    require(js("document.querySelector('.credential-identity')?.textContent.includes(" + json.dumps(DOMAIN) + ")"),
            "The private-login form does not identify the synthetic domain")
    fill("Email or username", "fixture-user")
    fill("Password", "fixture-password", "#website-password")
    click("button", "Connect")
    announce("PASS: clicked Connect once with fixture credentials on the deployed UI")

    def verified_response():
        return any(e.get("status") == "connected" and e.get("httpStatus") == 200
                   and e["path"].endswith("/native") for e in evidence)

    wait_until(verified_response, "Waiting for actual deployed native-login verification", timeout=480, pump=pump)
    login_calls = [e for e in evidence if e.get("action") in ("login", "credentials")]
    require(len(login_calls) == 1 and login_calls[0].get("credentialsSaved") is True,
            "Expected one real login submission with saved synthetic credentials")
    row = next((r for r in connections()["connections"] if r["id"] == connection_id), {})
    require(row.get("status") == "connected" and row.get("connectorId") == "browser:" + DOMAIN,
            "The deployed connection list did not confirm the canary connected")
    selector = '[data-connection-id="' + connection_id + '"]'
    wait_until(lambda: js("!document.querySelector('#website-password') && document.querySelector(" + json.dumps(selector)
                          + ")?.querySelector('.is-connected')?.textContent.trim() === 'Connected'"),
               "The UI did not render the verified connected canary", timeout=60, pump=pump)
    # Snapshot only the successful screen; never capture credentials in flight.
    require(js("(() => {const values=[document.body.innerText,...[...document.querySelectorAll('input')].map(e=>e.value)].join(' ');"
               + "return !" + json.dumps([token, "fixture-user", "fixture-password"])
               + ".some(secret=>values.includes(secret));})()"), "Sensitive text remains in the screenshot surface")
    root = cdp("DOM.getDocument")["root"]["nodeId"]
    node = cdp("DOM.querySelector", nodeId=root, selector=selector)["nodeId"]
    cdp("DOM.scrollIntoViewIfNeeded", nodeId=node)
    wait_until(lambda: js("document.fonts.status === 'loaded'"), "Fonts did not settle")
    image = base64.b64decode(cdp("Page.captureScreenshot", format="png", captureBeyondViewport=False)["data"])
    require(image.startswith(b"\x89PNG\r\n\x1a\n"), "Invalid screenshot")
    PNG.write_bytes(image)
    receipt.update({"verified": True, "connectionId": connection_id,
                    "credentialsSaved": True, "uiConnected": True, "backendConnected": True,
                    "authentication": "synthetic bearer via CDP; session endpoint shim only",
                    "originIsolation": "CDP transport gate; same-origin requests continued unchanged",
                    "mockedEndpoints": ["/api/connectors/session"],
                    "nativeLoginMocked": False, "connectionsMocked": False,
                    "isolatedChrome": True, "browserCookiesImported": False,
                    "telegramSent": False, "loginSubmissions": len(login_calls),
                    "evidence": evidence, "clicks": clicks,
                    "screenshot": str(PNG.relative_to(ROOT)),
                    "screenshotSha256": hashlib.sha256(image).hexdigest()})
    save()
    announce("PASS: actual backend and Connect UI verified connected; fresh secret-free JSON and PNG saved")


def main():
    os.umask(0o077)
    if os.environ.get("BH_WITNESS_CHILD") == "1":
        require(os.environ.get("BH_NO_BROWSER_COOKIES") == "1", "Browser cookie import must be disabled")
        try:
            prepare()
            if os.environ.get("BH_WITNESS_LIVE") == "1":
                live()
        finally:
            stop_network_gate()
        return
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--prepare", action="store_true", help="Local preflight only (default)")
    mode.add_argument("--live", action="store_true", help="Run only after the parent authorizes live login")
    parser.add_argument("--connection", help="Existing pending synthetic canary connection UUID")
    args = parser.parse_args()
    if args.connection:
        require(args.live and re.fullmatch(UUID, args.connection), "--connection requires --live and a UUID")
    launch(args)


try:
    main()
except BaseException as error:
    if isinstance(error, SystemExit):
        raise
    # Harness exceptions can contain JS expressions, request bodies or headers.
    # Never include their text or traceback in logs/artifacts.
    announce("FAIL: " + (str(error) if isinstance(error, WitnessError) else "Witness stopped without verified success (" + type(error).__name__ + ")"))
    raise SystemExit(1) from None
