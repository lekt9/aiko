---
description: cell — run/build a fractal harness (DAG in YAML, composable)
---

Run the cell harness. For writing a new cell, trigger the `cell` skill (`/skill:cell`).
For building/running:

```sh
python cell/run.py build <root.cell.yaml> — validate DAG + digest
python cell/run.py run   <root.cell.yaml> --inputs inputs.json --out out/ — topo fire leaves, manifest.json + .cell-cas
python cell/run.py check <root.cell.yaml> --inputs inputs.json — schemas + determinism
```

Primitives (frozen membranes): session → auth → request (API), author (gap→cell), fal-generate/fal-status (seedance). Builder is a cell: `cell/system/builder.cell.yaml`.
