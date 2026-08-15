
# jesus-graph-ralph — Prime Agent Extension

Rewrites **jesus-graph** (skill + `graph.py` + `multi_contract.py`) as a Prime Agent Extension
so it **ralphs everything autonomously, thoroughly, based on a plan**.

Per [`extensions.md`](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/extensions.md).

## What was rewritten

- **Skill** (prompt template the LLM walks, manual frontier walking) →
  **Extension** (code that subscribes to `session_start`, `before_agent_start`, `tool_call`,
  `turn_end`, `agent_end`, registers `jesus_graph` + `ralph_witness` tools and
  `/graph`, `/graph-status`, `/ralph`, `/cancel-ralph`, `/jesus-ralph` commands,
  persists via `pi.appendEntry`, and drives an unbounded witness-gated loop).

- Planner (`graph.py` Kahn) → `graph.ts` (same Kahn over `depends_on`/`reads`/`writes`/`produces`,
  collisions, ungrounded/ungated detection, `nextFrontier`, `formatPlan`).

- Ralph runner (`skills/jesus-ralph/scripts/start.sh` + Stop-hook) → `ralph.ts` +
  `agent_end` auto-advance with stagnation guard (default 7 dry turns).

## Install

**Pick one scope — never both.** Prime Agent auto-discovers global *and*
project extensions; the same tool names (`jesus_graph`, `ralph_witness`) in
both places abort startup with `Tool "…" conflicts with …`.

| Location | When |
|----------|------|
| `.prime/agent/extensions/jesus-graph-ralph/` (project-local) | Working in this repo (default; versioned here) |
| `~/.prime/agent/extensions/jesus-graph-ralph/` (global) | Other repos only — and only if the project-local copy is **not** present |

```bash
# This repo: use project-local only
ls .prime/agent/extensions/jesus-graph-ralph/
test ! -e ~/.prime/agent/extensions/jesus-graph-ralph && echo "no global duplicate OK"

# Other repo: install global from this source (after ensuring no project-local)
# cp -R /path/to/jesus-pattern/.prime/agent/extensions/jesus-graph-ralph \
#   ~/.prime/agent/extensions/

prime-agent --help | head
# in TUI: /graph-status, /ralph "north" --check "witness"
# Hot-reload via /reload (no restart)
```

## Usage

```
/graph "ship feature X"          # scaffold .claude/jesus-graph.local.json
/graph-status                    # frontiers + gaps + ralph state
/ralph "all frontiers green" --check "pytest -q"   # arm autonomous loop
/cancel-ralph                    # disarm
```

Tools the model can call: `jesus_graph` (plan/frontier/settle/block/add_node), `ralph_witness` (run gate).
