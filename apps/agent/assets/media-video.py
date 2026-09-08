"""Offline schematic crossing interpretation, not photographic vision.

Consumes privately retained, source-verified media.frames output. A blue vehicle
and magenta pedestrian are recognized by the published diagram grammar. Reports
only sampled occupancy/order/conflict, never absence between sampled frames.
"""
import base64
import math
import pathlib
import subprocess
import tempfile


def box(pixels, kind):
    points = []
    for i in range(0, len(pixels), 3):
        r, g, b = pixels[i:i+3]
        match = (b > 150 and b > r*1.7 and b > g*1.4) if kind == "vehicle" else (r > 150 and b > 100 and g < 100 and r > g*1.7)
        if match:
            points.append((i//3 % 320, i//3//320))
    if len(points) < 30:
        return None
    return (min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points))


def inside(bounds):
    return bounds is not None and bounds[0] < 180 and bounds[2] >= 140 and bounds[1] < 200 and bounds[3] >= 40


def run(envelope):
    value = envelope.get("value", envelope)
    if value.get("task") != "crossing-conflict":
        raise ValueError("unsupported_video_task")
    evidence = value["frames"]
    duration = evidence.get("durationSeconds", 0)
    result = {"status": "unsupported_scene", "task": "crossing-conflict", "answer": "unavailable",
        "observations": [], "conflictAtSeconds": [], "firstObservedOrder": [],
        "coverage": {"exhaustive": False, "sampledSeconds": [], "maxUnsampledGapSeconds": duration},
        "quality": {"semanticAccuracy": "unmeasured", "domain": "schematic-crossing-v1", "absenceEstablished": False}}
    if evidence["status"] in ("invalid_media", "no_video"):
        result["status"] = evidence["status"]
        return result
    frames = evidence["frames"]
    if evidence["status"] != "ok" or not 1 <= len(frames) <= 16 or not math.isfinite(duration) or duration <= 0:
        raise ValueError("invalid_frame_evidence")
    times = [f["atSeconds"] for f in frames]
    if times != sorted(set(times)) or any(not math.isfinite(t) or t < 0 or t >= duration for t in times):
        raise ValueError("invalid_frame_bounds")
    observations = []
    with tempfile.TemporaryDirectory(prefix="video-interpret-") as directory:
        for i, frame in enumerate(frames):
            data = base64.b64decode(frame["data"], validate=True)
            if len(data) != frame["bytes"] or len(data) > 196608:
                raise ValueError("invalid_frame_bytes")
            path = pathlib.Path(directory) / (str(i) + ".jpg")
            path.write_bytes(data)
            p = subprocess.run(["/tools/ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-threads", "1",
                "-i", str(path), "-frames:v", "1", "-vf", "scale=320:240", "-threads", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
                check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
            pixels = p.stdout
            if len(pixels) != 320*240*3:
                raise ValueError("frame_decode_unavailable")
            # Required road and zebra fiducials distinguish this diagram grammar.
            def rgb(x,y): return pixels[(y*320+x)*3:(y*320+x)*3+3]
            if any(max(rgb(x,60)) > 80 for x in (20,280)) or any(min(rgb(142,y)) < 180 for y in (42,82,162)):
                return result
            vehicle, pedestrian = box(pixels,"vehicle"), box(pixels,"pedestrian")
            if vehicle is None or pedestrian is None:
                return result
            observations.append({"atSeconds": times[i], "vehicleInCrossing": inside(vehicle), "pedestrianInCrossing": inside(pedestrian)})
    seen = set()
    order = []
    for o in observations:
        newly = [name for name in ("vehicle","pedestrian") if o[name+"InCrossing"] and name not in seen]
        if newly: order.append("simultaneous" if len(newly)==2 else newly[0])
        seen.update(newly)
    conflicts = [o["atSeconds"] for o in observations if o["vehicleInCrossing"] and o["pedestrianInCrossing"]]
    result.update(status="interpreted", answer="observed_conflict" if conflicts else "not_observed",
        observations=observations, conflictAtSeconds=conflicts, firstObservedOrder=order,
        coverage={"exhaustive":False,"sampledSeconds":times,"maxUnsampledGapSeconds":max(b-a for a,b in zip([0]+times,times+[duration]))})
    return result
