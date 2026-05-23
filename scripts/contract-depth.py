#!/usr/bin/env python3
"""contract-depth — walk the multi-dimensional resolution graph of a contract.

Surfaces four axes:
  - depth: longest chain of parent_id ↑ links from <id> to a root
  - dims:  number of contract:<id> action refs the resolution touches (lateral pointers)
  - breadth_max: widest sibling fan-out at any level of the parent tree
  - cycles: any contract:<id> chain that loops back on itself (X→Y→X)

PASS: prints the report (pretty or --json), exit 0
FAIL: never — this script DESCRIBES, it doesn't VERDICT (substrate principle).
      The exit code is 0 unless --strict-cycles is passed AND a cycle exists.

The substrate enables; the agent (or _mark, with --strict-cycles) judges.

Usage:
  contract-depth.py <id> [--json] [--strict-cycles]
  contract-depth.py --self-test
"""

import argparse, json, os, sys
from pathlib import Path

# Bootstrap path to contract_core regardless of cwd
HERE = Path(__file__).resolve().parent
LIB = HERE / 'lib'
sys.path.insert(0, str(LIB))
from contract_core import get, list_all, _resolve_ledger  # type: ignore


def _action_refs(c):
    """Return the contract id(s) a contract's action references via 'contract:<id>'."""
    if not c:
        return []
    action = (c.get('action') or '').strip()
    if action.startswith('contract:'):
        return [action[len('contract:'):].strip()]
    return []


def _parent_chain(c, all_by_id, seen):
    """Return list of ancestor ids from immediate parent up to root."""
    chain = []
    cur = c
    while cur and cur.get('parent_id'):
        pid = cur['parent_id']
        if pid in seen:
            break
        seen.add(pid)
        chain.append(pid)
        cur = all_by_id.get(pid)
    return chain


def _children_of(pid, all_contracts):
    return [c for c in all_contracts if c.get('parent_id') == pid]


def analyze(root_id):
    """Walk the resolution graph and return a structured report."""
    all_contracts = list_all(show_merged=True)  # include fossils for honest depth
    by_id = {c['id']: c for c in all_contracts}

    root = by_id.get(root_id)
    if not root:
        return {'error': f'contract {root_id} not found'}

    # ─── parent chain (upward) ────────────────────────────────────────────────
    parent_chain = _parent_chain(root, by_id, set([root_id]))

    # ─── children + breadth (downward) ────────────────────────────────────────
    # BFS down from root, track breadth at each level, count nodes by depth
    levels = [[root_id]]
    visited_down = {root_id}
    breadth_max = 1
    while levels[-1]:
        next_level = []
        for nid in levels[-1]:
            for child in _children_of(nid, all_contracts):
                cid = child['id']
                if cid not in visited_down:
                    visited_down.add(cid)
                    next_level.append(cid)
        if next_level:
            breadth_max = max(breadth_max, len(next_level))
            levels.append(next_level)
        else:
            break
    descendant_depth = len(levels) - 1   # 0 if no children

    # ─── contract-ref chain (lateral, cycle-prone) ────────────────────────────
    # Follow action='contract:<id>' transitively from root, detect cycles
    cycles = []
    dim_visited = set()
    ref_paths = []

    def walk_refs(cid, path):
        if cid in path:
            # Found a cycle — record from first occurrence
            i = path.index(cid)
            cycles.append(path[i:] + [cid])
            return
        if cid in dim_visited:
            return  # already explored this subgraph
        dim_visited.add(cid)
        c = by_id.get(cid)
        if not c:
            return
        refs = _action_refs(c)
        if not refs:
            ref_paths.append(path + [cid])
            return
        for ref in refs:
            walk_refs(ref, path + [cid])

    walk_refs(root_id, [])

    # Dims = unique contract-ref endpoints reached
    dims = len(dim_visited) - 1   # exclude root itself

    # ─── corroborate synapses (lateral, non-cycling) ─────────────────────────
    # Each row carries other side; we don't recurse through synapses by default
    # because they're association edges, not gating edges.
    synapse_count = 0
    for row in all_contracts:
        # Note: list_all returns latest declared rows; synapses are events.
        # For lightweight estimate, count rows that mention the root id via corroborate metadata.
        if row.get('event') == 'corroborated' and (row.get('id') == root_id or row.get('with_id') == root_id):
            synapse_count += 1

    return {
        'id': root_id,
        'plan': (root.get('plan') or '')[:80],
        'shape': _infer_shape(root.get('action', '')),
        'parent_chain': parent_chain,          # ancestor ids, immediate-first
        'depth_up': len(parent_chain),         # how high above root
        'depth_down': descendant_depth,        # how deep below root
        'depth_total': len(parent_chain) + descendant_depth,
        'breadth_max': breadth_max,
        'dims': max(0, dims),
        'ref_paths': ref_paths[:8],
        'cycles': cycles,
        'synapse_count': synapse_count,
    }


def _infer_shape(action):
    a = (action or '').strip()
    if not a: return '?'
    if a == 'agent-judges': return 'judgment'
    if a in ('funnel', 'children-satisfy'): return 'funnel'
    if a == 'funnel-first': return 'funnel-first'
    if a == 'sequence': return 'sequence'
    if a.startswith('quorum:'): return 'quorum'
    if a.startswith('loop-until:'): return 'loop'
    if a.startswith('harness:'): return 'harness'
    if a.startswith('tool-guard:'): return 'tool-guard'
    if a.startswith('contract:'): return 'contract-ref'
    return 'cell'


# ─── Miller's 7±2 working-memory cap ───────────────────────────────────────
DEPTH_WARN = 7
DIMS_WARN = 4


def pretty(rep):
    if 'error' in rep:
        return f"ERROR: {rep['error']}"
    out = []
    out.append(f"=== contract depth · {rep['id']} ({rep['shape']})")
    out.append(f"  plan: {rep['plan']}")
    out.append(f"  depth ↑ {rep['depth_up']}  ↓ {rep['depth_down']}  total {rep['depth_total']}")
    out.append(f"  breadth_max: {rep['breadth_max']}")
    out.append(f"  dims (contract-ref reach): {rep['dims']}")
    out.append(f"  synapses (corroborate edges): {rep['synapse_count']}")
    if rep['parent_chain']:
        out.append(f"  ↑ parent chain: {' ← '.join(rep['parent_chain'][:6])}" + (' …' if len(rep['parent_chain']) > 6 else ''))
    if rep['ref_paths']:
        out.append("  → contract-ref paths:")
        for p in rep['ref_paths']:
            out.append(f"      {' → '.join(p)}")
    if rep['cycles']:
        out.append("  🔥 CYCLES DETECTED (will hard-break on satisfy):")
        for cyc in rep['cycles']:
            out.append(f"      {' → '.join(cyc)}")

    warns = []
    if rep['depth_total'] >= DEPTH_WARN:
        warns.append(f"depth_total={rep['depth_total']} ≥ {DEPTH_WARN} (exceeds Miller's 7±2 working-memory cap)")
    if rep['dims'] >= DIMS_WARN:
        warns.append(f"dims={rep['dims']} ≥ {DIMS_WARN} (KEY-2 judgment becomes pattern-matching above ~3 dims)")
    if warns:
        out.append("  ⚠️  soft warnings:")
        for w in warns:
            out.append(f"      {w}")
    return '\n'.join(out)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('id', nargs='?')
    p.add_argument('--json', action='store_true')
    p.add_argument('--strict-cycles', action='store_true',
                   help='exit 1 if any cycle is detected (used by _mark satisfied)')
    p.add_argument('--self-test', action='store_true')
    args = p.parse_args()

    if args.self_test:
        # Self-test: declare a tiny tree, analyze it, verify shape of the report
        import subprocess, tempfile
        tmp = tempfile.mkdtemp(prefix='depth_selftest_')
        env = os.environ.copy()
        env['CONTRACTS_STORE'] = os.path.join(tmp, 'l.jsonl')
        C = str(HERE / 'contract')
        def run(*a):
            return subprocess.run(['bash', C, *a], env=env, capture_output=True, text=True)
        a = run('declare', 'selftest root', '--action', 'funnel', '--no-drive').stdout.split()
        rid = [s for s in a if len(s) == 8 and all(c in '0123456789abcdef' for c in s)][0]
        b = run('declare', 'selftest child', '--action', 'true', '--parent', rid, '--no-drive').stdout.split()
        cid = [s for s in b if len(s) == 8 and all(c in '0123456789abcdef' for c in s)][0]
        os.environ['CONTRACTS_STORE'] = env['CONTRACTS_STORE']
        rep = analyze(rid)
        ok = (rep.get('depth_down') == 1 and rep.get('breadth_max') >= 1 and cid in [c['id'] for c in list_all(show_merged=True) if c.get('parent_id') == rid])
        if ok:
            print('selftest ok')
            return 0
        print('selftest FAIL'); print(json.dumps(rep, indent=2)); return 1

    if not args.id:
        print(p.format_help(), file=sys.stderr); return 2

    rep = analyze(args.id)
    if args.json:
        print(json.dumps(rep, indent=2))
    else:
        print(pretty(rep))
    if args.strict_cycles and rep.get('cycles'):
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
