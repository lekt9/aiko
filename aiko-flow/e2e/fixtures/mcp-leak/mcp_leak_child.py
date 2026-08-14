#!/usr/bin/env python3
"""Stage B of the mcp-leak gate fixture: the idle grandchild.

It exists so a fixture "tree" is 2 processes, not 1. `unbrowse mcp` leaks a
4-process tree whose stages are killed together only because `aiko` `setsid`s
the direct child and `SafeTokioChildProcess::Drop` calls `kill_process_group()`
— a reap that kills only the direct child would leave the deeper stages behind
and still look green to a counter that watches stage A alone. This process
holds no pipe to the parent and never exits on its own, so the only thing that
can end it is that group kill.
"""

import os
import signal
import sys
import time


def main():
    tag = "untagged"
    argv = sys.argv[1:]
    for i, a in enumerate(argv):
        if a == "--tag" and i + 1 < len(argv):
            tag = argv[i + 1]
    # Do not die from a stray SIGHUP when the session leader goes away; the
    # gate must observe a real group kill, not a hangup race.
    try:
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
    except Exception:
        pass
    sys.stderr.write("mcp-leak-fixture-child: up pid=%d tag=%s\n" % (os.getpid(), tag))
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
