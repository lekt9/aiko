#!/usr/bin/env python3
"""shadow.py — shadow a human on their real interfaces (application_observe + Unbrowse capture).

Thin capture shim over fde/self-wire: reads observe bytes, emits normalized breakpoint events.
Compose fde/self-wire.cell.yaml as harness parent; this script is the edge adapter only.
"""
import json, sys, pathlib

def main():
    # stub: observe bytes → normalized event
    payload = {"source": "shadow", "observed": True}
    out = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else ".")
    print(json.dumps(payload))

if __name__ == "__main__":
    main()
