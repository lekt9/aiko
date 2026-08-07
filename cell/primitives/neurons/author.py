#!/usr/bin/env python3
# author — writes a cell inert, never reads the gap's expect/should string.
# Bounded search over transforms written ahead of time, none of which reads the gap.
# A gap no transform fits is refused.
import hashlib, textwrap, json, re

TRANSFORMS = [
    {"name": "seedance-realistic", "probe": "seedance", "template": """
apiVersion: cell/v0
kind: Cell
metadata:
  name: seedance-realistic
  description: realistic video via seedance 2 — prompt + duration + aspect -> video
spec:
  membrane:
    inputs:
      prompt: { schema: string }
      duration: { schema: string, required: false }
      aspect: { schema: string, required: false }
    outputs:
      video_url: { schema: string }
      status: { schema: string }
    caps:
      allow_net: ["queue.fal.run", "fal.run", "api.fal.ai"]
  organelles:
    - name: gen
      cell: ../../primitives/fal-generate.cell.yaml
    - name: poll
      cell: ../../patterns/video/poll.cell.yaml
  wiring:
    - from: membrane.prompt
      to: gen.prompt
    - from: gen.request_id
      to: poll.request_id
    - from: poll.video_url
      to: membrane.video_url
    - from: poll.status
      to: membrane.status
"""},
    {"name": "http-wrap", "probe": "http", "template": """
apiVersion: cell/v0
kind: Cell
metadata:
  name: http-wrap
  description: authored http leaf — method + url + body -> response
spec:
  membrane:
    inputs:
      method: { schema: string }
      url: { schema: string }
      body: { schema: object, required: false }
    outputs:
      response: { schema: object }
    caps:
      allow_net: []
  run:
    kind: http
    http: { method: "{{inputs.method}}", url: "{{inputs.url}}" }
"""},
    {"name": "python-echo", "probe": "echo", "template": """
apiVersion: cell/v0
kind: Cell
metadata:
  name: python-echo
  description: authored echo leaf
spec:
  membrane:
    inputs:
      text: { schema: string }
    outputs:
      echoed: { schema: string }
    caps: {}
  run:
    kind: python
    code: |
      def run(inputs, ctx):
          return {"echoed": inputs.get("text","")}
"""},
]

def run(inputs, ctx):
    gap = inputs.get("gap") or {}
    need = (gap.get("need") or gap.get("kind") or gap.get("probe") or gap.get("name") or "").lower()
    want = gap.get("want") or gap.get("accept") or ""
    # Bounded search: pick first transform whose probe is substring of need. Never reads want/expect.
    for t in TRANSFORMS:
        if t["probe"] in need:
            try:
                import yaml
                cell = yaml.safe_load(t["template"])
                # Do NOT inject want into the cell — that would let a do-nothing handler print expect_contains and pass.
                return {"cell": cell, "cell_yaml": t["template"]}
            except Exception as e:
                raise RuntimeError(f"author transform parse failed: {e}") from e
    raise ValueError(f"author: no transform fits need={need!r} — refused (bounded search, gap has no matching probe) — available: {[t['probe'] for t in TRANSFORMS]}")

