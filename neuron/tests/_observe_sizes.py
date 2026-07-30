#!/usr/bin/env python3
"""Assert the observability bootstrap redacts payloads and nothing else."""
import json, sys

doc = json.load(open(sys.argv[1]))
writes = [a for f in doc["firings"] for a in f["w"]]
assert writes, "bootstrap reported no artifact writes at all"
assert max(a["n"] for a in writes) > 0, "artifact sizes were dropped along with payloads"
assert not any("bytes" in a for a in writes), "an artifact bytes field survived redaction"
