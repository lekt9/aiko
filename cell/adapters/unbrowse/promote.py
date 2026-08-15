"""Cell leaf for the two-read promotion protocol."""
from __future__ import annotations
import contextlib
import io
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import unbrowse_port

class Args:
    pass

def run(inputs, ctx):
    args = Args()
    args.state_dir = inputs["state_dir"]
    args.url = inputs["url"]
    args.credential_env = inputs.get("credential_env") or None
    # A promotion is deliberately two origin reads. Suppress CLI receipts; the
    # durable boundary, rather than output resemblance, is the Cell product.
    with contextlib.redirect_stdout(io.StringIO()):
        unbrowse_port.cmd_observe(args)
        unbrowse_port.cmd_replay(args)
    return {"boundary": unbrowse_port.load(args.state_dir)}
