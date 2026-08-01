#!/usr/bin/env python3
"""ARC-AGI-3 client, toggleable offline (Kaggle, default) <-> online (live API).

Mode is chosen by the env var ARC_API_MODE:

    ARC_API_MODE=kaggle   (DEFAULT)  offline local engine, no internet, no key
    ARC_API_MODE=offline             alias for kaggle
    ARC_API_MODE=online              live API at https://three.arcprize.org

The default is the Kaggle setup on purpose: Kaggle scoring kernels have NO
internet, so the path that must "just work" is the offline one. Online is the
opt-in that requires ARC_API_KEY.

Online uses a PERSISTENT cookie jar (in-process AND on disk). This is not
optional: the live API sits behind an AWS-ALB with sticky AWSALBAPP/GAMESESSION
cookies. A stateless client lands on random backends and gets spurious
SERVER_ERROR "game <id> not found" on RESET. Persisting cookies pins one healthy
backend across the whole open -> reset -> act -> close flow, and across separate
processes. See references/03-gotchas.md.

Subcommands:
    mode                       print the resolved mode + config, exit 0
    games                      list game_ids
    open  <game_id>            open a scorecard + RESET, render the first frame
    reset                      RESET the current game (re-render)
    act   <N> [x y]            ACTION1..7; ACTION6 click: x=col y=row, 0..63
    close                      close the scorecard, print levels_completed

Session state (current game/guid/card_id) and cookies persist under
~/.arc-agi-3-session/ so subcommands chain across processes.
"""

import http.client
import http.cookiejar
import json
import os
import random
import socket
import sys
import time
import urllib.error
import urllib.request

BASE_ONLINE = os.environ.get("ARC_API_BASE", "https://three.arcprize.org")
STATE_DIR = os.path.expanduser(os.environ.get("ARC_SESSION_DIR", "~/.arc-agi-3-session"))
COOKIE_FILE = os.path.join(STATE_DIR, "cookies.txt")
STATE_FILE = os.path.join(STATE_DIR, "state.json")


def resolve_mode():
    """kaggle/offline -> 'offline'; online -> 'online'. Default = offline (Kaggle)."""
    raw = os.environ.get("ARC_API_MODE", "kaggle").strip().lower()
    if raw in ("kaggle", "offline", "local", ""):
        return "offline"
    if raw in ("online", "live", "api"):
        return "online"
    sys.exit(f"ARC_API_MODE='{raw}' not recognized (use kaggle|offline|online)")


def _load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save_state(state):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)


# --------------------------------------------------------------------------- #
# ONLINE: live API with a persistent cookie jar (the sticky-session fix).
# --------------------------------------------------------------------------- #
def _opener():
    os.makedirs(STATE_DIR, exist_ok=True)
    jar = http.cookiejar.LWPCookieJar(COOKIE_FILE)
    try:
        jar.load(ignore_discard=True, ignore_expires=True)
    except (OSError, http.cookiejar.LoadError):
        pass
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    return opener, jar


def _api_key():
    key = os.environ.get("ARC_API_KEY", "").strip()
    if not key:
        sys.exit("online mode needs ARC_API_KEY (get one at https://three.arcprize.org).")
    return key


# --- retry-with-backoff for the API interface (covers every online op; offline
# mode never reaches here, so the request layer is robust in all modes) -------
# Transient failures seen live: HttpChunkTruncated / IncompleteRead, connection
# resets, read timeouts, and 5xx/429 from the AWS-ALB front. Fail FAST on real
# 4xx (a bad request will not heal by retrying).
_HTTP_TIMEOUT = float(os.environ.get("ARC_HTTP_TIMEOUT", "60"))
_RETRY_TRIES = int(os.environ.get("ARC_HTTP_TRIES", "5"))
_RETRY_BASE = float(os.environ.get("ARC_HTTP_BASE_DELAY", "0.5"))
_RETRY_CAP = float(os.environ.get("ARC_HTTP_CAP_DELAY", "20"))
_RETRY_STATUS = {408, 425, 429, 500, 502, 503, 504}
_RETRYABLE = (
    urllib.error.URLError, http.client.IncompleteRead, http.client.BadStatusLine,
    http.client.RemoteDisconnected, ConnectionError, socket.timeout, TimeoutError,
)


def _backoff_delay(attempt):
    """Exponential backoff with full jitter, capped. attempt is 0-based."""
    return min(_RETRY_CAP, _RETRY_BASE * (2 ** attempt)) * (0.5 + random.random())


def _request(req, path):
    """opener.open(req) with exponential-backoff retry on transient failures.
    Retries network errors and 5xx/429; fails fast on other 4xx; gives up after
    ARC_HTTP_TRIES. The cookie jar is saved on success (sticky AWS-ALB session)."""
    last = None
    for attempt in range(_RETRY_TRIES):
        opener, jar = _opener()
        try:
            with opener.open(req, timeout=_HTTP_TIMEOUT) as resp:
                body = json.loads(resp.read().decode())
            jar.save(ignore_discard=True, ignore_expires=True)
            return body
        except urllib.error.HTTPError as e:
            if e.code in _RETRY_STATUS and attempt < _RETRY_TRIES - 1:
                last = f"HTTP {e.code}"
            else:
                try:
                    detail = e.read().decode()[:400]
                except Exception:
                    detail = ""
                sys.exit(f"HTTP {e.code} on {path}: {detail}")
        except _RETRYABLE as e:
            last = repr(e)
            if attempt >= _RETRY_TRIES - 1:
                sys.exit(f"network error on {path} after {_RETRY_TRIES} tries: {e}")
        d = _backoff_delay(attempt)
        print(f"[arc] transient {last} on {path}; retry {attempt + 1}/{_RETRY_TRIES} "
              f"in {d:.1f}s", file=sys.stderr)
        time.sleep(d)
    sys.exit(f"giving up on {path} after {_RETRY_TRIES} tries: {last}")


def _post(path, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        BASE_ONLINE + path, data=data, method="POST",
        headers={"X-API-Key": _api_key(), "Content-Type": "application/json"},
    )
    return _request(req, path)


def _get(path):
    req = urllib.request.Request(BASE_ONLINE + path, headers={"X-API-Key": _api_key()})
    return _request(req, path)


def online_games():
    return _get("/api/games")


def online_open(game_id):
    card = _post("/api/scorecard/open", {"tags": [os.environ.get("ARC_TAGS", "skill-arc-agi-3")]})
    card_id = card.get("card_id") or card.get("guid")
    frame = _post("/api/cmd/RESET", {"game_id": game_id, "card_id": card_id})
    _save_state({"mode": "online", "game_id": game_id, "card_id": card_id,
                 "guid": frame.get("guid")})
    return frame


def _require_state():
    st = _load_state()
    if not all(st.get(k) for k in ("game_id", "guid", "card_id")):
        sys.exit("no open game. Run `arc_client.py open <game_id>` first "
                 "(it opens a scorecard + RESET and saves the session).")
    return st


def online_reset():
    """RESET the current game, REUSING the open scorecard (no new scorecard)."""
    st = _require_state()
    frame = _post("/api/cmd/RESET", {"game_id": st["game_id"], "card_id": st["card_id"]})
    if frame.get("guid"):
        st["guid"] = frame["guid"]
        _save_state(st)
    return frame


def online_act(n, x=None, y=None):
    st = _require_state()
    payload = {"game_id": st["game_id"], "guid": st["guid"], "card_id": st["card_id"]}
    if x is not None:
        payload["x"], payload["y"] = int(x), int(y)
    frame = _post(f"/api/cmd/ACTION{n}", payload)
    if frame.get("guid"):
        st["guid"] = frame["guid"]
        _save_state(st)
    return frame


def online_close():
    st = _require_state()
    return _post("/api/scorecard/close", {"card_id": st["card_id"]})


# --------------------------------------------------------------------------- #
# OFFLINE / KAGGLE: the local arc_agi engine, no key, no internet.
# --------------------------------------------------------------------------- #
def _offline_arcade():
    try:
        import arc_agi  # provided by github.com/arcprize/ARC-AGI (the offline tool)
    except ImportError:
        sys.exit(
            "offline (kaggle) mode needs the arc_agi tool.\n"
            "  pip install git+https://github.com/arcprize/ARC-AGI.git\n"
            "On Kaggle it is preinstalled in the scoring image.\n"
            "Set ARC_ENVIRONMENTS_DIR to a folder of game files "
            "(the toolkit ships test_environment_files/ with real games)."
        )
    env_dir = os.environ.get("ARC_ENVIRONMENTS_DIR")
    kwargs = {"operation_mode": arc_agi.OperationMode.OFFLINE} if hasattr(arc_agi, "OperationMode") else {}
    if env_dir:
        kwargs["environments_dir"] = env_dir
    return arc_agi.Arcade(**kwargs)


def offline_games():
    arc = _offline_arcade()
    lister = getattr(arc, "game_ids", None) or arc.list_games  # API name varies by version
    return {"games": list(lister())}


# --------------------------------------------------------------------------- #
def render(frame):
    """Render a 64x64 frame as hex chars (0 -> '.'). Tolerant of odd shapes."""
    grid = frame.get("frame") if isinstance(frame, dict) else frame
    # ARC-AGI-3 frames are a list of 64x64 grid layers; render the last (latest).
    if (isinstance(grid, list) and grid and isinstance(grid[0], list)
            and grid[0] and isinstance(grid[0][0], list)):
        grid = grid[-1]
    if not grid or not isinstance(grid, list) or not isinstance(grid[0], list):
        # transient non-64x64 frame (e.g. a (0,) frame mid-game). Do NOT crash/reset.
        return f"[non-grid frame: {json.dumps(frame)[:200]}]"
    # Compact by default: state + structural glyphs (the cheap pointer the agent
    # actually reasons over). The raw 64x64 grid (the expensive value) is opt-in
    # via ARC_RENDER_GRID=1: inline the pointer, defer the value, so a multi-turn
    # solve fits the model context (sp-memory: value-or-pointer per node).
    meta = ""
    if isinstance(frame, dict):
        lvl = frame.get("levels_completed", frame.get("score"))  # field renamed v0.9.3
        meta = (f"state={frame.get('state')} levels_completed={lvl} "
                f"available_actions={frame.get('available_actions')}")
    body = ""
    if os.environ.get("ARC_RENDER_GRID"):
        lines = ["   " + "".join(str(c % 10) for c in range(len(grid[0])))]
        for row in grid:
            lines.append("".join("." if c == 0 else format(c, "x") for c in row))
        body = "\n".join(lines) + "\n"
    return body + meta + _glyphs(grid)


def _glyphs(grid):
    """Structural perception: connected-component glyphs (color, size, box,
    center), background and main region excluded. This is what makes a frame
    reasonable: targets, dots, palette swatches, and control buttons fall out as
    components with exact click centers (x=col, y=row)."""
    import collections
    h, w = len(grid), len(grid[0])
    counts = collections.Counter(c for row in grid for c in row)
    common = [c for c, _ in counts.most_common(2)]
    bg = common[0]
    region = common[1] if len(common) > 1 else None
    seen = [[False] * w for _ in range(h)]
    comps = []
    for y in range(h):
        for x in range(w):
            c = grid[y][x]
            if c in (bg, region) or seen[y][x]:
                continue
            stack, cells = [(y, x)], []
            seen[y][x] = True
            while stack:
                cy, cx = stack.pop()
                cells.append((cy, cx))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < h and 0 <= nx < w and not seen[ny][nx] and grid[ny][nx] == c:
                        seen[ny][nx] = True
                        stack.append((ny, nx))
            xs = [p[1] for p in cells]
            ys = [p[0] for p in cells]
            comps.append((c, len(cells), min(xs), min(ys), max(xs), max(ys),
                          sum(xs) // len(cells), sum(ys) // len(cells)))
    comps.sort(key=lambda t: (t[7], t[6]))  # reading order: top-to-bottom, left-to-right
    out = [f"\nglyphs (bg={format(bg,'x')} region={format(region,'x') if region is not None else '-'}; "
           f"color size center(x=col,y=row) box):"]
    for c, n, x0, y0, x1, y1, cx, cy in comps[:30]:
        out.append(f"  {format(c,'x'):>2}  sz{n:<4} center({cx:>2},{cy:>2})  box({x0:>2},{y0:>2}..{x1:>2},{y1:>2})")
    return "\n".join(out)


def main(argv):
    mode = resolve_mode()
    cmd = argv[0] if argv else "mode"

    if cmd == "mode":
        print(json.dumps({
            "ARC_API_MODE": os.environ.get("ARC_API_MODE", "kaggle (default)"),
            "resolved": mode,
            "base": BASE_ONLINE if mode == "online" else "local arc_agi engine",
            "needs_key": mode == "online",
            "cookie_jar": COOKIE_FILE if mode == "online" else None,
        }, indent=2))
        return 0

    if mode == "offline":
        if cmd == "games":
            print(json.dumps(offline_games(), indent=2))
            return 0
        sys.exit(f"offline mode: '{cmd}' drives the local engine; implement your "
                 f"agent against arc_agi.Arcade (see references/05-kaggle.md). "
                 f"'games' and 'mode' are wired here.")

    # online
    if cmd == "games":
        print(json.dumps(online_games(), indent=2))
    elif cmd == "open":
        print(render(online_open(argv[1])))
    elif cmd == "reset":
        print(render(online_reset()))
    elif cmd == "act":
        n = int(argv[1])
        x, y = (argv[2], argv[3]) if len(argv) > 3 else (None, None)
        print(render(online_act(n, x, y)))
    elif cmd == "close":
        print(json.dumps(online_close(), indent=2))
    else:
        sys.exit(f"unknown command: {cmd}")
    return 0


if __name__ == "__main__":
    # allow `--mode X` as a leading override of ARC_API_MODE for convenience
    args = sys.argv[1:]
    if args and args[0] == "--mode":
        os.environ["ARC_API_MODE"] = args[1]
        args = args[2:]
    sys.exit(main(args))
