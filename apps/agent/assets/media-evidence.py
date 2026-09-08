"""Trusted independent physical inspector. Never imports candidate media code.

Executed only by the host's pinned, networkless SandboxJob checker binding.
Output remains in private custody; hashes of pixels/audio never become log evidence.
"""
import base64
import hashlib
import json
import math
import pathlib
import re
import subprocess
import tempfile


def command(args):
    p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
    if p.returncode < 0 or p.returncode in (126, 127):
        raise RuntimeError("inspector_tool_unavailable")
    if p.returncode:
        raise ValueError("decode_failed")
    return p


def pixels(path):
    metadata = json.loads(command(["/tools/ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
        "-show_entries", "stream=width,height", "-of", "json", str(path)]).stdout)["streams"][0]
    w, h = int(metadata["width"]), int(metadata["height"])
    if not 0 < w <= 320 or not 0 < h <= 320:
        raise ValueError("image_budget")
    data = command(["/tools/ffmpeg", "-v", "error", "-protocol_whitelist", "file,pipe", "-threads", "1",
        "-i", str(path), "-frames:v", "1", "-threads", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]).stdout
    if len(data) != w*h*3:
        raise ValueError("pixel_length")
    encoded = base64.b64encode(data).decode("ascii")
    return {"width": w, "height": h, "pixelDigest": "sha256:" + hashlib.sha256(json.dumps(encoded).encode()).hexdigest(),
            "minRgb": [min(data[c::3]) for c in range(3)], "maxRgb": [max(data[c::3]) for c in range(3)]}


def run(value):
    name = value["asset"]
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,120}", name):
        raise ValueError("asset_name")
    path = pathlib.Path(value["_files"][name])
    if path != pathlib.Path("/input") / name or path.is_symlink() or not path.is_file():
        raise ValueError("asset_scope")
    if value["mode"] == "pixels":
        return pixels(path)
    try:
        raw = json.loads(command(["/tools/ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
            "-show_format", "-show_streams", "-of", "json", str(path)]).stdout)
        duration = float(raw.get("format", {}).get("duration", 0))
        if duration <= 0:
            duration = max(float(s.get("duration", 0)) for s in raw["streams"])
        if not math.isfinite(duration) or not 0 < duration <= 600 or len(raw["streams"]) > 32:
            raise ValueError("media_budget")
        streams = []
        for s in raw["streams"]:
            if s["codec_type"] not in ("video", "audio"):
                continue
            fields = ("width", "height") if s["codec_type"] == "video" else ("sample_rate", "channels")
            streams.append(dict(index=int(s["index"]), kind=s["codec_type"], codec=s.get("codec_name", "unknown"),
                                **{key: int(s[key]) for key in fields}))
        if not streams:
            raise ValueError("missing_streams")
    except ValueError:
        return {"status": "invalid_media"}
    result = {"status": "ok", "durationSeconds": duration, "streams": streams}
    if value["mode"] == "probe":
        return result
    if value["mode"] == "frames":
        if not any(s["kind"] == "video" for s in streams):
            return {"status": "no_video", "durationSeconds": duration}
        frames = []
        times = value["timestamps"]
        if not isinstance(times, list) or not 1 <= len(times) <= 16:
            raise ValueError("frame_budget")
        with tempfile.TemporaryDirectory() as directory:
            for i, timestamp in enumerate(times):
                if isinstance(timestamp, bool) or not isinstance(timestamp, (float, int)) or not math.isfinite(timestamp) or not 0 <= timestamp < duration:
                    raise ValueError("frame_time")
                target = pathlib.Path(directory) / (str(i) + ".jpg")
                p = command(["/tools/ffmpeg", "-nostdin", "-v", "info", "-protocol_whitelist", "file,pipe", "-threads", "1",
                    "-i", str(path), "-map", "0:v:0", "-an", "-vf",
                    "setpts=PTS-STARTPTS,select='gte(t," + str(timestamp) + ")',showinfo,scale=320:320:force_original_aspect_ratio=decrease",
                    "-frames:v", "1", "-threads", "1", "-q:v", "3", str(target)])
                pts = re.findall(r"pts_time:([0-9.eE+-]+)", p.stderr.decode("utf-8", "replace"))
                if not pts:
                    raise ValueError("frame_unavailable")
                evidence = pixels(target)
                frames.append({"atSeconds": float(pts[0]), "toleranceSeconds": 0.00001,
                               **{k: evidence[k] for k in ("width", "height", "pixelDigest")}})
        return {"status": "ok", "durationSeconds": duration, "frames": frames}
    if value["mode"] != "transcribe":
        raise ValueError("inspector_mode")
    if not any(s["kind"] == "audio" for s in streams):
        return {"status": "no_audio", "durationSeconds": duration}
    # Independent decode + VAD. This establishes physical speech coverage, NOT words.
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import get_speech_timestamps, VadOptions
    audio = decode_audio(str(path), sampling_rate=16000)
    regions = get_speech_timestamps(audio, VadOptions())
    return {"status": "physical_audio", "durationSeconds": duration,
            "speechSeconds": sum(r["end"]-r["start"] for r in regions)/16000,
            "regions": [{"startSeconds": r["start"]/16000, "endSeconds": r["end"]/16000} for r in regions]}
