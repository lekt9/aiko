#!/usr/bin/env python3
"""Stage A of the mcp-leak gate fixture: a minimal, hermetic stdio MCP server.

WHY A FIXTURE AND NOT THE REAL `unbrowse`
-----------------------------------------
The leak this gate defends against (`liveness.rs`'s former `Arc` cycle, plus
the missing `owned_clients` drain on session teardown) lives entirely in
`McpClient`'s lifecycle — it is indifferent to WHICH stdio server was spawned.
Driving the real `unbrowse mcp` under a hermetic `HOME` would mean a cold
`~/.cache/unbrowse`, a 45 s startup budget, network reachability and ~473 MB
of leaked RSS per session on the falsification arm. Worse, if that cold start
failed the handshake, the client would be reaped by the ALREADY-CORRECT
handshake-failure path (`mcp-leak-rootcause.md` §3a) and the gate would prove
nothing while looking green.

This fixture is instead:
  * hermetic     — stdlib only, no network, no state outside its own argv;
  * fast         — handshake in milliseconds, not 45 s;
  * cheap        — ~10 MB/tree instead of ~473 MB, so the leaky arm cannot OOM
                   a box that has OOM-killed builds all session;
  * SHAPED LIKE A TREE — it spawns one child (stage B) so a leaked "tree" is
                   more than one process and the reap has to take the whole
                   process GROUP, exactly as `unbrowse mcp`'s 4-process tree
                   does (`SafeTokioChildProcess::Drop` → `kill_process_group`).

The fixture's validity as an instrument is not asserted, it is DEMONSTRATED:
CHECK E drives the identical procedure against the pre-fix binary, where this
same fixture leaks. An instrument that goes red on the old binary and green on
the new one is measuring the defect and not the fixture.

PROTOCOL
--------
Newline-delimited JSON-RPC 2.0 on stdin/stdout, enough of MCP for rmcp's
client to complete `initialize` and reach `Ready`:
  initialize / notifications/initialized / tools/list / tools/call / ping
Everything else answers -32601. Nothing is written to stdout that is not a
single-line JSON-RPC message (stdout is the transport; diagnostics go to
stderr).

The server exits when stdin reaches EOF — i.e. when the transport is closed.
It NEVER exits on its own, so any copy still alive after its owning session
was torn down is, by construction, a leak.
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CHILD = os.path.join(HERE, "mcp_leak_child.py")


def log(msg):
    sys.stderr.write("mcp-leak-fixture: %s\n" % msg)
    sys.stderr.flush()


def send(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def spawn_child(tag):
    """Stage B — the grandchild that makes this a TREE, not a process.

    Detached from our stdio on purpose: it must not hold the MCP transport
    open, so the only thing that can end it is a signal. It inherits our
    process group (the parent `aiko` already `setsid`'d us), which is what
    makes `kill_process_group()` the thing that has to work.
    """
    try:
        return subprocess.Popen(
            [sys.executable, CHILD, "--tag", tag],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
    except Exception as exc:  # pragma: no cover - fixture diagnostics only
        log("child spawn failed: %r" % (exc,))
        return None


def main():
    tag = "untagged"
    argv = sys.argv[1:]
    for i, a in enumerate(argv):
        if a == "--tag" and i + 1 < len(argv):
            tag = argv[i + 1]

    child = spawn_child(tag)
    log("stage A up pid=%d tag=%s child=%s" % (os.getpid(), tag, child.pid if child else "none"))

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue

        method = req.get("method")
        rid = req.get("id")

        # Notifications carry no id and get no reply.
        if rid is None:
            continue

        if method == "initialize":
            params = req.get("params") or {}
            # Echo the client's protocol version back: this fixture supports
            # whatever the client speaks, and guessing a version the client
            # rejects would fail the handshake for reasons unrelated to the
            # property under test.
            pv = params.get("protocolVersion") or "2025-06-18"
            send({
                "jsonrpc": "2.0",
                "id": rid,
                "result": {
                    "protocolVersion": pv,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "mcp-leak-fixture", "version": "1"},
                    "instructions": "gate fixture; tag=%s" % tag,
                },
            })
        elif method == "tools/list":
            send({
                "jsonrpc": "2.0",
                "id": rid,
                "result": {
                    "tools": [
                        {
                            "name": "mcp_leak_noop",
                            "description": "Returns a constant. Exists so the server has a tool.",
                            "inputSchema": {"type": "object", "properties": {}},
                        }
                    ]
                },
            })
        elif method == "tools/call":
            send({
                "jsonrpc": "2.0",
                "id": rid,
                "result": {"content": [{"type": "text", "text": "ok"}], "isError": False},
            })
        elif method == "ping":
            send({"jsonrpc": "2.0", "id": rid, "result": {}})
        elif method in ("resources/list", "resources/templates/list"):
            send({"jsonrpc": "2.0", "id": rid, "result": {"resources": [], "resourceTemplates": []}})
        elif method == "prompts/list":
            send({"jsonrpc": "2.0", "id": rid, "result": {"prompts": []}})
        else:
            send({
                "jsonrpc": "2.0",
                "id": rid,
                "error": {"code": -32601, "message": "method not found: %s" % method},
            })

    log("stage A stdin EOF, exiting pid=%d" % os.getpid())
    if child is not None:
        try:
            child.terminate()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
