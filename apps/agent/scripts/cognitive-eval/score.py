"""Reuse the existing Telegram receipt rubric without claiming live delivery."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "scripts/telegram-eval"))
from evaluator import score

result = json.loads(Path(sys.argv[1]).read_text())
graded = score({"id": result["id"]}, result["events"])
# The shared evaluator historically sums absent usage as zero. Offline model
# fixtures have no measured provider usage: keep it explicitly unavailable here.
for source, target in [("promptTokens", "prompt_tokens"), ("completionTokens", "completion_tokens")]:
    if not any(isinstance(e.get("usage"), dict) and isinstance(e["usage"].get(source), (int, float)) for e in result["events"]):
        graded[target] = None
graded["human_quality"] = None
graded["measurement"] = "synthetic_host_receipts_only"
print(json.dumps(graded))
