---
name: signed-evaluation-lineage
description: Record measurable prompt or agent variants as signed, tamper-evident evaluation lineage.
---

# Signed evaluation lineage

Materialize evaluation as the graph in `contract-skill.json`. Hash the exact
prompt, evaluated artifact, and evaluation set. Record the parent prompt hash,
provider class, run, and judge. Append only through
`scripts/contract_lineage.py`; verify the complete chain before using a score
for selection.

A signature proves who wrote a record and that it was not changed. It does not
prove the judge or evaluation is correct, so keep evaluator evidence separate
from authorization and promotion.
