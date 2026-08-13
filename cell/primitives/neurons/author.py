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
    {"name": "fde-seat", "probe": "fde", "template": """
apiVersion: cell/v0
kind: Cell
metadata:
  name: aiko-seat
  description: harness that seats Aiko as the employee on this role
spec:
  membrane:
    inputs:
      role: { schema: string }
      handle: { schema: object }
      workflow_digest: { schema: string }
    outputs:
      handoff: { schema: object }
    caps: {}
  organelles:
    - { name: seat, cell: ../fde/deploy-aiko.cell.yaml }
  wiring:
    - { from: membrane.role, to: seat.role }
    - { from: membrane.handle, to: seat.handle }
    - { from: membrane.workflow_digest, to: seat.digest }
    - { from: seat.attachment, to: membrane.handoff }
"""},
    {"name": "roster-level", "probe": "roster", "template": """
apiVersion: cell/v0
kind: Cell
metadata:
  name: roster-level
  description: deterministic shift fill — locals then TS then NTS, refuse a shortfall
spec:
  membrane:
    inputs:
      requirement: { schema: object }
      workers: { schema: object }
    outputs:
      roster: { schema: object }
    caps: {}
  run:
    kind: python
    code: |
      def run(inputs, ctx):
          req = inputs.get("requirement") or {}
          target = int(req.get("target") or 0)
          shift = str(req.get("shift") or "D")
          raw = (inputs.get("workers") or {}).get("items") or []
          rank = {"local": 0, "ts": 1, "nts": 2}
          eligible = []
          for w in raw:
              if w.get("pref_off"):
                  continue
              if int(w.get("consecutive") or 0) >= int(req.get("max_consecutive") or 5):
                  continue
              eligible.append(w)
          eligible.sort(key=lambda w: (rank.get(str(w.get("klass") or "nts").lower(), 9), w.get("last_worked") or "", w.get("name") or w.get("id") or ""))
          assigned = eligible[:target]
          if len(assigned) < target:
              raise ValueError("roster-level: shortfall — refused, wrote nothing")
          return {"roster": {"shift": shift, "target": target, "assigned": [w.get("id") for w in assigned], "count": len(assigned)}}
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

