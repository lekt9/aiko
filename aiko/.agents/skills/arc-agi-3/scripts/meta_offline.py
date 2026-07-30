"""meta_offline.py -- the scoring metas' planning logic, PURE and offline (no arc_client, no network).

Given a single live frame (a 64x64 grid), produce the action plan to clear the current level:
  - paint_plan(grid):  paint-to-match -> [(action, x, y), ...] (select swatch, paint dot, ..., submit)
  - region_plan(grid): region-control -> [(6, x, y), ...] (sweep candidate control cells)
The harness calls choose_action once per step, so ArcAgent emits one planned action per call and rebuilds
the plan when the level changes. All logic here is copied verbatim from the live solvers but stripped of
the internet API client -- same moves, computed from the frame, no network.
"""
from collections import Counter


def grid_of(frame):
    g = frame
    while isinstance(g, list) and g and isinstance(g[0], list) and isinstance(g[0][0], list):
        g = g[-1]
    return g


def comps(cells):
    cells = set(cells); seen = set(); res = []
    for p in cells:
        if p in seen:
            continue
        st = [p]; comp = []
        while st:
            q = st.pop()
            if q in seen or q not in cells:
                continue
            seen.add(q); comp.append(q); x, y = q
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    st.append((x + dx, y + dy))
        res.append(comp)
    return res


# ── paint-to-match ──
def detect(g):
    H, W = len(g), len(g[0])
    bg = Counter(g[y][x] for y in range(H) for x in range(W)).most_common(1)[0][0]
    linerows = {y for y in range(H) if sum(1 for x in range(W) if g[y][x] == 2) > 40}
    redy = min(linerows) if linerows else H - 10
    dotcells = [(x, y) for y in range(H) for x in range(W) if g[y][x] == 2 and y not in linerows and y < redy]
    dots = [(sum(p[0] for p in c) // len(c), sum(p[1] for p in c) // len(c)) for c in comps(dotcells) if len(c) >= 2]
    dots.sort(key=lambda p: (p[1], p[0]))
    sw = {}
    for y in range(redy + 1, H):
        for x in range(W):
            col = g[y][x]
            if col not in (bg, 0, 2):
                sw.setdefault(col, []).append((x, y))
    swpos = {}
    for col, pts in sw.items():
        groups = [c for c in comps(pts) if len(c) >= 9]
        if groups:
            big = max(groups, key=len)
            swpos[col] = (sum(p[0] for p in big) // len(big), sum(p[1] for p in big) // len(big))
    topcells = [(x, y) for y in range(0, 15) for x in range(W) if g[y][x] not in (bg, 5, 0)]
    tgt = []
    for c in comps(topcells):
        if len(c) < 4:
            continue
        cx = sum(p[0] for p in c) // len(c)
        col = Counter(g[y][x] for (x, y) in c).most_common(1)[0][0]
        tgt.append((cx, col))
    tgt.sort()
    return dots, [t[1] for t in tgt], swpos


def _split_containers(pts, gap=9):
    pts = sorted(pts, key=lambda p: p[0]); groups = []; cur = []
    for p in pts:
        if cur and p[0] - cur[-1][0] > gap:
            groups.append(cur); cur = []
        cur.append(p)
    if cur:
        groups.append(cur)
    return groups


def order_dots(dots):
    ys = sorted({y for _, y in dots})
    if len(ys) <= 1:
        return sorted(dots, key=lambda p: p[0])
    rowsplit = (ys[0] + ys[-1]) / 2
    upper = sorted([p for p in dots if p[1] < rowsplit], key=lambda p: p[0])
    lower = [p for p in dots if p[1] >= rowsplit]
    if not upper:
        return sorted(lower, key=lambda p: p[0])
    containers = _split_containers(lower); rank = {}
    for ci, grp in enumerate(containers):
        cx = sum(p[0] for p in grp) / len(grp)
        rank[ci] = sum(1 for u in upper if u[0] < cx)
    seq = []
    for k in range(len(upper) + 1):
        for ci, grp in enumerate(containers):
            if rank[ci] == k:
                seq.extend(grp)
        if k < len(upper):
            seq.append(upper[k])
    return seq


def _targets_with_pos(g):
    """Top target boxes as (cx, colour), sorted left-to-right -- the positions detect() discards."""
    H, W = len(g), len(g[0])
    bg = Counter(g[y][x] for y in range(H) for x in range(W)).most_common(1)[0][0]
    topcells = [(x, y) for y in range(0, 15) for x in range(W) if g[y][x] not in (bg, 5, 0)]
    tg = []
    for c in comps(topcells):
        if len(c) < 4:
            continue
        cx = sum(p[0] for p in c) // len(c)
        col = Counter(g[y][x] for (x, y) in c).most_common(1)[0][0]
        tg.append((cx, col))
    return sorted(tg)


def _paint_assignments(grid):
    """Candidate colour-per-ordered-dot assignments, most-plausible first. v0 = the historical
    order_dots + sorted-target index pairing (solves L1-L4, where #dots == #targets). When there are
    MORE targets than dots (L5: 9 targets, 8 dots -- some columns have no dot) the question is WHICH
    targets to drop; we enumerate every drop-subset (emptiest-column drops first), index-pairing the
    kept targets with the dot order. The live submit signal picks the winner -- a real search, general,
    no game id, no route. Column-nearest + reversed are appended as long-shots."""
    from itertools import combinations
    dots, tgtcols, sw = detect(grid)
    tg = _targets_with_pos(grid)
    seq = order_dots(dots)
    n = len(seq)
    cands = []
    extra = len(tgtcols) - n
    if extra == 0:
        cands.append(list(tgtcols))                                     # exact pairing (L1-L4 winner)
    elif 0 < extra <= 3:
        dotxs = [d[0] for d in seq]
        def gap(ti):                                                    # distance from target ti to nearest dot
            cx = tg[ti][0] if ti < len(tg) else -999
            return min((abs(cx - dx) for dx in dotxs), default=10 ** 9)
        drops = sorted(combinations(range(len(tgtcols)), extra),
                       key=lambda comb: -sum(gap(i) for i in comb))     # drop the emptiest columns first
        for comb in drops[:24]:                                         # cap the search breadth
            cands.append([tgtcols[i] for i in range(len(tgtcols)) if i not in comb])
    else:
        cands.append(tgtcols[:n])
    if tg:
        cands.append([min(tg, key=lambda t: abs(t[0] - d[0]))[1] for d in seq])  # column-nearest
    cands.append(list(reversed(tgtcols))[:n])                           # reversed target order
    out, sn = [], set()
    for c in cands:
        cc = c[:n]
        if cc and tuple(cc) not in sn:
            sn.add(tuple(cc)); out.append(cc)
    return seq, sw, out


def paint_plan_variant(grid, variant=0):
    """Action sequence for one paint hypothesis (see _paint_assignments). variant past the last
    candidate returns [] so the caller falls through to brain exploration."""
    seq, sw, cands = _paint_assignments(grid)
    if variant >= len(cands):
        return []
    colors = cands[variant]
    plan = []
    for i, (dx, dy) in enumerate(seq):
        if i >= len(colors):
            break
        col = colors[i]
        if col in sw:
            plan.append((6, sw[col][0], sw[col][1]))     # select colour
            plan.append((6, dx, dy))                     # paint dot
    plan.append((5, None, None))                          # submit
    return plan


def _paint_hypotheses(grid):
    """Broader hypothesis space as explicit (dot_pos, colour) pairs. L1-L4 are solved by
    order_dots[i] <-> sorted_target[i]; L5's novelty is 9 targets / 8 dots (one target has no dot) and
    its 5-upper/3-lower layout, where order_dots may mis-order. So enumerate {3 dot-orderings} x {each
    single-target drop} + column-nearest. The submit signal selects; memory then locks the winner.
    Returns (swatch_positions, [ [(dot,colour),...], ... ])."""
    from itertools import combinations
    dots, tgtcols, sw = detect(grid)
    tg = _targets_with_pos(grid)
    n = len(dots)
    orderings = [order_dots(dots),
                 sorted(dots, key=lambda p: (p[0], p[1])),       # x then y
                 sorted(dots, key=lambda p: (p[1], p[0]))]       # y then x (row by row)
    # "after their kind" (Gen 1:11) -- the 2-row SEED: order each row by x, concat upper-then-lower and
    # lower-then-upper. Generate abundantly; the submit gate separates creativity from apophenia.
    if dots:
        ys = sorted({p[1] for p in dots})
        if len(ys) >= 2:
            split = (ys[0] + ys[-1]) / 2
            up = sorted([p for p in dots if p[1] < split], key=lambda p: p[0])
            lo = sorted([p for p in dots if p[1] >= split], key=lambda p: p[0])
            orderings.append(up + lo)
            orderings.append(lo + up)
    hyps = []
    _construct = None
    try:                                                        # construction by energy DESCENT (Exodus 25:40,
        import construct as _C                                  # z-20260530-01): make the canvas after the
        _construct = _C.greedy_construct(dots, tg) or None      # target pattern. Appended LAST (live-refuted as
    except Exception:                                           # the first hypothesis on the paint games -- it
        pass                                                    # does not reproduce the order-pairing; extra only)
    if len(tgtcols) == n:
        for od in orderings:
            hyps.append(list(zip(od, tgtcols)))
    elif 0 < len(tgtcols) - n <= 3:
        extra = len(tgtcols) - n
        drops = list(combinations(range(len(tgtcols)), extra))[:12]
        for od in orderings:
            for drop in drops:
                kept = [tgtcols[i] for i in range(len(tgtcols)) if i not in drop]
                hyps.append(list(zip(od, kept)))
        if tg:                                                   # column-nearest (handles 2-row layouts)
            hyps.append([(d, min(tg, key=lambda t: abs(t[0] - d[0]))[1]) for d in orderings[0]])
    else:
        for od in orderings:
            hyps.append(list(zip(od, tgtcols[:n])))
    if _construct:
        hyps.append(_construct)                                  # energy-descent painting, as a LAST candidate
    out, sn = [], set()
    for h in hyps:
        key = tuple(sorted(((int(d[0]), int(d[1])), int(c)) for (d, c) in h))
        if h and key not in sn:
            sn.add(key); out.append(h)
    return sw, out


def paint_plan_from_pairs(grid, pairs, sw):
    """Action sequence painting each (dot, colour) pair, then submit."""
    plan = []
    for (d, col) in pairs:
        if col in sw:
            plan.append((6, sw[col][0], sw[col][1]))
            plan.append((6, d[0], d[1]))
    plan.append((5, None, None))
    return plan


def paint_plan_hypothesis(grid, variant=0):
    """Return one bounded assignment from the broader structural hypothesis set."""
    sw, hypotheses = _paint_hypotheses(grid)
    if variant < 0 or variant >= len(hypotheses):
        return []
    return paint_plan_from_pairs(grid, hypotheses[variant], sw)


def paint_frame_pairs(grid, pairs):
    """Grid after painting each (dot, colour) pair -- predicted completion frame for a hypothesis."""
    g = [row[:] for row in grid]
    cell_of = {}
    for comp in dot_components(grid):
        cx = sum(p[0] for p in comp) // len(comp); cy = sum(p[1] for p in comp) // len(comp)
        cell_of[(cx, cy)] = comp
    for (d, col) in pairs:
        comp = cell_of.get((int(d[0]), int(d[1])))
        if comp:
            for (x, y) in comp:
                g[y][x] = col
    return g


def dot_components(g):
    """Ordered dot components (cell lists) in the same order order_dots() yields -- to simulate a painting."""
    H, W = len(g), len(g[0])
    linerows = {y for y in range(H) if sum(1 for x in range(W) if g[y][x] == 2) > 40}
    redy = min(linerows) if linerows else H - 10
    dotcells = [(x, y) for y in range(H) for x in range(W) if g[y][x] == 2 and y not in linerows and y < redy]
    cs = [c for c in comps(dotcells) if len(c) >= 2]
    cents = [(sum(p[0] for p in c) // len(c), sum(p[1] for p in c) // len(c)) for c in cs]
    by_cent = {cents[i]: cs[i] for i in range(len(cs))}
    return [by_cent[c] for c in order_dots(cents) if c in by_cent]


def paint_frame(grid, colors):
    """The grid AFTER painting each ordered dot its assigned colour -- the predicted completion frame
    for one hypothesis, so a goal-ranker can score it without spending a live submit."""
    g = [row[:] for row in grid]
    for i, comp in enumerate(dot_components(grid)):
        if i >= len(colors):
            break
        for (x, y) in comp:
            g[y][x] = colors[i]
    return g


def paint_plan_from_colors(grid, colors):
    """Action sequence to paint the ordered dots a given colour list, then submit."""
    seq, sw, _ = _paint_assignments(grid)
    plan = []
    for i, (dx, dy) in enumerate(seq):
        if i >= len(colors):
            break
        col = colors[i]
        if col in sw:
            plan.append((6, sw[col][0], sw[col][1]))
            plan.append((6, dx, dy))
    plan.append((5, None, None))
    return plan


def paint_plan(grid):
    """Full action sequence to clear a paint-to-match level (the base hypothesis, v0)."""
    return paint_plan_variant(grid, 0)


# ── region-control ──
def candidate_controls(g):
    H, W = len(g), len(g[0])
    bg = Counter(g[y][x] for y in range(H) for x in range(W)).most_common(1)[0][0]
    cands = []
    for col in set(g[y][x] for y in range(H) for x in range(W)):
        if col == bg:
            continue
        pts = [(x, y) for y in range(H) for x in range(W) if g[y][x] == col]
        if len(pts) > 400:
            continue
        for comp in comps(pts):
            if 1 <= len(comp) <= 120:
                cx = sum(p[0] for p in comp) // len(comp); cy = sum(p[1] for p in comp) // len(comp)
                cands.append((cy, cx, col, len(comp)))
    cands.sort(key=lambda t: (-t[0], t[1]))
    return cands


def region_plan(grid):
    """Sweep: click each candidate control once (bottom-most first)."""
    return [(6, cx, cy) for (cy, cx, _col, _sz) in candidate_controls(grid)]


def navigation_action(grid):
    """Infer one move on a repeated-cell path toward a rare target.

    This is a structural proposer, not a game rule: it requires a single
    one-pixel control marker, two or more repeated equal-sized cell families,
    and a rare target cell. It returns only when one family forms a connected
    route from the marker's host cell to that target.
    """
    from collections import defaultdict, deque

    H, W = len(grid), len(grid[0])
    bg = Counter(value for row in grid for value in row).most_common(1)[0][0]
    objects = []
    for color in set(value for row in grid for value in row if value != bg):
        for cell in comps((x, y) for y in range(H) for x in range(W) if grid[y][x] == color):
            objects.append({
                "color": color,
                "size": len(cell),
                "center": (
                    round(sum(x for x, _ in cell) / len(cell)),
                    round(sum(y for _, y in cell) / len(cell)),
                ),
            })
    markers = [obj for obj in objects if obj["size"] == 1]
    if len(markers) != 1:
        return None
    marker = markers[0]["center"]
    sized = defaultdict(list)
    for obj in objects:
        if 4 <= obj["size"] <= 25:
            sized[(obj["color"], obj["size"])].append(obj["center"])
    families = [points for points in sized.values() if len(points) >= 6]
    rare = [
        obj["center"] for obj in objects
        if 4 <= obj["size"] <= 25 and len(sized[(obj["color"], obj["size"])]) == 1
    ]
    if not families or not rare:
        return None
    player = min(rare, key=lambda point: abs(point[0] - marker[0]) + abs(point[1] - marker[1]))

    for points in sorted(families, key=len, reverse=True):
        xs = sorted({x for x, _ in points})
        ys = sorted({y for _, y in points})
        gaps = [b - a for values in (xs, ys) for a, b in zip(values, values[1:]) if b > a]
        if not gaps:
            continue
        step = Counter(gaps).most_common(1)[0][0]
        if step <= 0:
            continue
        start = min(points, key=lambda point: abs(point[0] - player[0]) + abs(point[1] - player[1]))
        if abs(start[0] - player[0]) + abs(start[1] - player[1]) > step:
            continue
        aligned_targets = [
            point for point in rare
            if point != player
            if (point[0] - start[0]) % step == 0
            and (point[1] - start[1]) % step == 0
            and abs(point[0] - marker[0]) + abs(point[1] - marker[1]) > step
        ]
        if not aligned_targets:
            continue
        target = max(
            aligned_targets,
            key=lambda point: abs(point[0] - start[0]) + abs(point[1] - start[1]),
        )
        nodes = set(points)
        nodes.add(player)
        # A target may replace the traversable cell's color, so include it as
        # a terminal node when it aligns to the lattice.
        nodes.add(target)
        origin = player
        queue = deque([origin])
        parent = {origin: None}
        reached = None
        while queue:
            node = queue.popleft()
            if node == target:
                reached = node
                break
            for delta in ((0, -step), (0, step), (-step, 0), (step, 0)):
                nxt = (node[0] + delta[0], node[1] + delta[1])
                if nxt in nodes and nxt not in parent:
                    parent[nxt] = node
                    queue.append(nxt)
        if reached is None:
            continue
        path = []
        while reached is not None:
            path.append(reached)
            reached = parent[reached]
        path.reverse()
        if len(path) < 2:
            return None
        dx, dy = path[1][0] - path[0][0], path[1][1] - path[0][1]
        return {(0, -step): 1, (0, step): 2, (-step, 0): 3, (step, 0): 4}.get((dx, dy))
    return None


def navigation_actions(grid, visited=None):
    """Rank locally visible navigation edges by frontier novelty and goal distance."""
    from collections import defaultdict

    visited = visited if visited is not None else set()
    H, W = len(grid), len(grid[0])
    bg = Counter(value for row in grid for value in row).most_common(1)[0][0]
    objects = []
    for color in set(value for row in grid for value in row if value != bg):
        for cell in comps((x, y) for y in range(H) for x in range(W) if grid[y][x] == color):
            objects.append({
                "color": color,
                "size": len(cell),
                "center": (
                    round(sum(x for x, _ in cell) / len(cell)),
                    round(sum(y for _, y in cell) / len(cell)),
                ),
            })
    markers = [obj for obj in objects if obj["size"] == 1]
    if len(markers) != 1:
        return []
    marker = markers[0]["center"]
    families = defaultdict(int)
    for obj in objects:
        families[(obj["color"], obj["size"])] += 1
    rare = [
        obj for obj in objects
        if 4 <= obj["size"] <= 25 and families[(obj["color"], obj["size"])] == 1
    ]
    if len(rare) < 2:
        return []
    player = min(rare, key=lambda obj: abs(obj["center"][0] - marker[0]) + abs(obj["center"][1] - marker[1]))
    target = max(rare, key=lambda obj: abs(obj["center"][0] - marker[0]) + abs(obj["center"][1] - marker[1]))
    origin = player["center"]
    visited.add(origin)
    distances = sorted({
        abs(obj["center"][0] - origin[0]) + abs(obj["center"][1] - origin[1])
        for obj in objects
        if obj is not player
        and 4 <= obj["size"] <= 25
        and abs(obj["center"][0] - origin[0]) + abs(obj["center"][1] - origin[1]) >= 2
    })
    if not distances:
        return []
    half_step = distances[0]
    options = []
    for obj in objects:
        px, py = obj["center"]
        dx, dy = px - origin[0], py - origin[1]
        if abs(dx) + abs(dy) != half_step:
            continue
        action = {
            (0, -half_step): 1,
            (0, half_step): 2,
            (-half_step, 0): 3,
            (half_step, 0): 4,
        }.get((dx, dy))
        if action is None:
            continue
        landing = (origin[0] + 2 * dx, origin[1] + 2 * dy)
        distance = abs(target["center"][0] - landing[0]) + abs(target["center"][1] - landing[1])
        options.append((landing in visited, distance, action))
    return [action for _, _, action in sorted(set(options))]
