"""perceive.py -- the SEEING primitive: read a raw grid into STRUCTURED OBJECTS, deterministically.

The right-problem fix: the generic agent path was blind (it fed raw frames to a novelty CNN; only the
hand-coded metas could "see"). tinytools #10 / sp-vision lesson: the precise extraction step is a
DETERMINISTIC tool, not a model. perceive(grid) returns the board's objects -- connected components with
colour, size, centroid, bbox -- plus a structural read (background, palette swatches, big regions, small
movable pieces). Whatever needs it (route -> meta / goose / forge) sees objects, not pixels.
"""
from collections import Counter


def _components(cells, w, h):
    """4-connected components over a set of (x,y) cells."""
    cellset = set(cells)
    seen = set()
    comps = []
    for start in cells:
        if start in seen:
            continue
        stack = [start]
        seen.add(start)
        comp = []
        while stack:
            x, y = stack.pop()
            comp.append((x, y))
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if (nx, ny) in cellset and (nx, ny) not in seen:
                    seen.add((nx, ny)); stack.append((nx, ny))
        comps.append(comp)
    return comps


def perceive(grid):
    """Read `grid` (2D list of ints) into structured objects. Deterministic; the agent's eyes."""
    h = len(grid)
    w = len(grid[0]) if h else 0
    flat = [grid[y][x] for y in range(h) for x in range(w)]
    cnt = Counter(flat)
    bg, _ = cnt.most_common(1)[0]                       # background = most common colour

    objects = []
    for color in sorted(c for c in cnt if c != bg):
        cells = [(x, y) for y in range(h) for x in range(w) if grid[y][x] == color]
        if len(cells) > 2000:                           # a fill, not an object -- skip per-component blowup
            xs = [p[0] for p in cells]; ys = [p[1] for p in cells]
            objects.append({"color": color, "size": len(cells),
                            "centroid": (sum(xs) / len(xs), sum(ys) / len(ys)),
                            "bbox": (min(xs), min(ys), max(xs), max(ys))})
            continue
        for comp in _components(cells, w, h):
            xs = [p[0] for p in comp]; ys = [p[1] for p in comp]
            objects.append({"color": color, "size": len(comp),
                            "centroid": (sum(xs) / len(comp), sum(ys) / len(comp)),
                            "bbox": (min(xs), min(ys), max(xs), max(ys))})

    board = w * h
    # SCALE-AGNOSTIC tiers. The old absolutes (0.15*board for big, <=12 for small) were tuned for
    # small ARC-1 grids; on ARC-3's 64x64 board they drop every mid-size object (the target boxes
    # ~36 cells, the palette swatches ~18) into a dead zone, blinding the eye. Tier by the object-size
    # distribution + grid-relative caps so the same eye works on a 10x10 and a 64x64 board.
    sizes = sorted(o["size"] for o in objects)
    med = sizes[len(sizes) // 2] if sizes else 1
    big = [o for o in objects if o["size"] >= max(8, 2 * med) and o["size"] < 0.6 * board]   # notably large, not a fill
    small = [o for o in objects if 1 <= o["size"] <= max(12, med)]                           # dots / movable pieces
    # POSITION bands. ARC-3 paint-to-match grids encode the goal by POSITION, not size: the target
    # boxes (top) and the palette swatches (bottom) are the SAME colours and sizes, separable only by
    # row. Size-tiering alone can't tell them apart, so surface both bands explicitly.
    band = [o for o in objects if o["centroid"][1] > h * 0.82 and 1 <= o["size"] <= 0.05 * board]  # palette tray (bottom)
    topband = [o for o in objects if o["centroid"][1] < h * 0.18 and 1 <= o["size"] <= 0.05 * board]  # target row (top)
    return {
        "w": w, "h": h, "bg": bg, "n_colors": len(cnt),
        "objects": objects, "n_objects": len(objects),
        "big_regions": big, "small_objects": small,
        "palette": band if len(band) >= 2 else [],
        "targets": topband if len(topband) >= 2 else [],   # the goal row (paint-to-match targets)
        # the candidate controllable element: the single smallest distinct object (what a piece game steers)
        "element": min(small, key=lambda o: o["size"]) if small else None,
    }
