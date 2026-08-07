# Video harness (fal)

`patterns/video/` is the video harness — a DAG that generates video via fal, polls, and dedups via CAS. Follows the same `session→auth→request→extract` primitive shape, but for `fal-generate→poll→cas`.

```
prompt + model + params
  → primitives/fal-generate (POST queue.fal.run/<model>)
  → patterns/video/poll (python loop over primitives/fal-status)
  → primitives/cas (video_url → .cell-cas/<sha16>)
```

Every firing writes `out/manifest.json` — Merkle DAG already covers video jobs. Optional `patterns/confirm` wraps the final GET to prove `video_url` is reachable.

## Use

```sh
FAL_KEY=... python run.py run patterns/video/harness.cell.yaml --inputs '{"prompt":"a cat in space"}' --out out/
FAL_KEY=... python run.py run patterns/video/generate.cell.yaml --inputs '{"prompt":"cat", "model":"fal-ai/veo3"}' --out /tmp/g

# Mock (no key): still fires — returns mock request_id + mock mp4
python run.py run patterns/video/harness.cell.yaml --inputs '{"prompt":"mock"}' --out /tmp/mock
```

Primitives: `primitives/fal-generate.cell.yaml`, `primitives/fal-status.cell.yaml` (add new models by editing one function).
Pattern: `patterns/video/poll` is raw Python loop — no `policy.loop` in spec (see bitter lesson: maximal action space).
