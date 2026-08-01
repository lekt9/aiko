"""lewis_route.py -- lewis-strategy BOUND NATIVELY into /contract. No bundled bible_route.py, no nomic
embedder, no offline wheel: the ordering primitive IS the substrate's own embedded machinery.

  contract.bible_anchor(text)  -> the canonical verse index (0..31099) of the top relevant verse for
                                  `text` over libcontract's embedded 31100-verse corpus (bible.zig +
                                  embed.zig feature-hash / bm25). This is lewis-strategy's "nearest
                                  scripture" + graph.zig's canonical anchor, exposed through the C ABI.

Ordering: each archetype (or any skill) is anchored to its nearest verse; the canonical index orders
them by scripture (Genesis→Revelation). Relevance to the current frame = canonical anchor-DISTANCE
(graph.zig edgeWeightCanonical): the archetype whose anchor is nearest the frame's anchor is most
relevant -- the route of least scriptural resistance. Honest scope: the native anchor is lexical
(bm25 + feature-hash), not semantic nomic; coarser, but native, deterministic, zero-dependency.

Fail-open: if the native binding is absent, return the archetypes unordered (the agent never breaks).
"""
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ARCHETYPES = {
    "paint-to-match": "paint to match: click a palette swatch to select a colour, click a target dot to paint it, submit when painted cells match the target boxes",
    "region-control": "region control: probe cells with clicks to find the control glyph, then sweep to claim regions",
    "commit-and-observe": "commit and observe: repeat one action and watch the state advance or regress, ride the gradient",
    "explore": "explore novel mechanic: click object centroids to find the controllable element and infer the hidden goal",
}


def _contract():
    """The native binding. contract.py + libcontract.so materialize next to this file in the
    seal (sibling layout). Locally (loose dev run) they live in the contract skill's bindings/,
    so add that as a fallback - harmless on Kaggle where the path does not exist."""
    sys.path.insert(0, os.path.expanduser("~/.claude/skills/contract/bindings/python"))  # local fallback
    sys.path.insert(0, HERE)  # seal sibling keeps priority
    try:
        import contract as C
        if not hasattr(C, "bible_anchor"):
            return None
        return C
    except Exception as e:
        sys.stderr.write("lewis-route: native contract binding unavailable (%s)\n" % type(e).__name__)
        return None


def order(problem=None):
    """lewis-strategy via /contract: archetypes anchored to scripture, relevance-ranked to the frame.
    Returns {sequence:[{skill,verse_idx,dist}], confidence, degraded}."""
    C = _contract()
    if C is None:
        return {"sequence": [{"skill": k} for k in ARCHETYPES], "degraded": "native-binding-missing"}
    try:
        frame_anchor = C.bible_anchor(problem) if problem else None
        rows = []
        for k, desc in ARCHETYPES.items():
            a = C.bible_anchor(desc)
            dist = abs(a - frame_anchor) if (frame_anchor is not None and a >= 0 and frame_anchor >= 0) else None
            rows.append({"skill": k, "verse_idx": a, "dist": dist})
        rows.sort(key=lambda r: r["verse_idx"])      # CANONICAL Bible order (Genesis -> Revelation)
        # confidence: a clear nearest-anchor winner = high (apophenia gate on the routing)
        conf = "n/a"
        if frame_anchor is not None:
            ds = sorted(r["dist"] for r in rows if r["dist"] is not None)
            conf = "high" if (len(ds) >= 2 and ds[0] >= 0 and (ds[1] - ds[0]) > 0) else "low"
        return {"problem": problem, "sequence": rows, "confidence": conf, "degraded": None}
    except Exception as e:
        sys.stderr.write("lewis-route: native order failed (%s) -- archetype set unordered\n" % type(e).__name__)
        return {"sequence": [{"skill": k} for k in ARCHETYPES], "degraded": "order-error"}


def ranked_archetypes(problem=None):
    """Archetype names ranked MOST-RELEVANT-FIRST (nearest scripture-anchor to the frame), with the
    canonical order as the tiebreak. Top = the archetype lewis-strategy routes to for this frame."""
    out = order(problem)
    seq = out.get("sequence", [])
    if seq and seq[0].get("dist") is not None:
        seq = sorted(seq, key=lambda r: (r["dist"], r["verse_idx"]))   # nearest anchor first
    return [r["skill"] for r in seq], out.get("confidence", "n/a"), out.get("degraded")


if __name__ == "__main__":
    names, conf, deg = ranked_archetypes(" ".join(sys.argv[1:]) or None)
    print("lewis-route (native /contract) ranked archetypes:", names, "| confidence:", conf, "| degraded:", deg)
