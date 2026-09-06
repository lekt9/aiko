# Execute in browser-harness's helper scope, against explicitly isolated Chromium.
import json, os, subprocess, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
context = cdp('Target.createBrowserContext')['browserContextId']
target = cdp('Target.createTarget', url='about:blank', browserContextId=context)['targetId']
class Relay(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size > 1048576: raise ValueError('Body limit')
            message = json.loads(self.rfile.read(size))
            result = cdp(message['method'], session_id=message.get('sessionId'), **message['params'])
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        except Exception:
            self.send_response(500); self.end_headers(); self.wfile.write(b'{}')
relay = HTTPServer(('127.0.0.1', 0), Relay)
thread = threading.Thread(target=relay.serve_forever, daemon=True); thread.start()
try:
    result = subprocess.run(['node', 'scripts/cdp-smoke.mjs'], cwd=os.environ['UNLOCK_ROOT'], env={**os.environ, 'UNLOCK_CDP_RELAY': f'http://127.0.0.1:{relay.server_port}', 'UNLOCK_CDP_CONTEXT': context, 'UNLOCK_CDP_TARGET': target}, capture_output=True, text=True, timeout=60)
    print(result.stdout)
    if result.returncode: raise AssertionError('Private adapter QA failed; ' + result.stderr)
finally:
    relay.shutdown(); relay.server_close(); cdp('Target.disposeBrowserContext', browserContextId=context)
