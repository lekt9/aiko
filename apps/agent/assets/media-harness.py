"""Pinned offline media primitives. Imported by the isolated SandboxJob driver.

Only trusted /input mappings are accepted. Model paths belong to the immutable
entry module and must be read-only /models mounts. Never install or download here.
Private bytes/results travel through the driver's sealed job custody, not logs.
"""
import base64
import json
import math
import os
import pathlib
import re
import subprocess
import tempfile


class MediaInputError(ValueError):
    pass


class MediaDurationError(MediaInputError):
    pass


class MediaRuntimeError(RuntimeError):
    pass


def _input(envelope):
    # HarnessLibrary wraps its original input in value; direct jobs may use it flat.
    value = envelope.get("value", envelope)
    if not isinstance(value, dict):
        raise MediaInputError("invalid_input")
    files = envelope.get("_files")
    name = value.get("asset")
    if not isinstance(files, dict) or not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,120}", name):
        raise MediaInputError("input_asset_unavailable")
    supplied = files.get(name)
    if not isinstance(supplied, str):
        raise MediaInputError("input_asset_unavailable")
    path = pathlib.Path(supplied)
    if not path.is_absolute() or path.parent != pathlib.Path("/input") or path.name != name or path.is_symlink() or not path.is_file():
        raise MediaInputError("input_asset_scope")
    if path.stat().st_size > 64 * 1024 * 1024:
        raise MediaInputError("input_asset_budget")
    return value, path


def _run(args, timeout=20):
    # Fixed argv, no shell, no network protocols. The VM adds CPU/memory/egress fences.
    try:
        return subprocess.run(args, check=True, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=timeout)
    except subprocess.CalledProcessError as error:
        if error.returncode < 0 or error.returncode in (126, 127):
            raise MediaRuntimeError("media_tool_unavailable") from None
        raise
    except (FileNotFoundError, subprocess.TimeoutExpired):
        raise MediaRuntimeError("media_tool_unavailable_or_timeout") from None


def _number(value, fallback=0):
    try:
        result = float(value)
        return result if math.isfinite(result) else fallback
    except (TypeError, ValueError):
        return fallback


def _probe(path):
    raw = json.loads(_run(["/tools/ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
        "-show_entries", "format=duration:stream=index,codec_type,codec_name,width,height,sample_rate,channels,duration",
        "-of", "json", str(path)]).stdout)
    if len(raw.get("streams", [])) > 32:
        raise MediaInputError("stream_budget")
    streams = []
    for item in raw.get("streams", []):
        kind = item.get("codec_type")
        if kind not in ("video", "audio"):
            continue
        stream = {"index": int(item["index"]), "kind": kind, "codec": str(item.get("codec_name", "unknown"))}
        for name in (("width", "height") if kind == "video" else ("sample_rate", "channels")):
            stream[name] = int(item.get(name, 0))
        streams.append(stream)
    duration = _number(raw.get("format", {}).get("duration"))
    if duration <= 0:
        duration = max([_number(s.get("duration")) for s in raw.get("streams", [])] + [0])
    if duration > 600:
        raise MediaDurationError("duration_exceeds_600_seconds")
    if not streams or duration <= 0:
        raise MediaInputError("unsupported_duration_or_streams")
    return {"status": "ok", "durationSeconds": duration, "streams": streams,
            "hasAudio": any(s["kind"] == "audio" for s in streams),
            "hasVideo": any(s["kind"] == "video" for s in streams)}


def run_probe(envelope):
    _, path = _input(envelope)
    try:
        return _probe(path)
    except (subprocess.SubprocessError, ValueError, KeyError):
        return {"status": "invalid_media", "reason": "decode_failed"}


def run_frames(envelope):
    value, path = _input(envelope)
    positions = value.get("timestamps")
    if not isinstance(positions, list) or not 1 <= len(positions) <= 16 or any(
        isinstance(t, bool) or not isinstance(t, (int, float)) or not math.isfinite(t) or t < 0 for t in positions
    ) or positions != sorted(set(positions)):
        raise MediaInputError("invalid_timestamps")
    try:
        info = _probe(path)
    except (subprocess.SubprocessError, ValueError, KeyError):
        return {"status": "invalid_media", "reason": "decode_failed"}
    if not info["hasVideo"]:
        return {"status": "no_video", "durationSeconds": info["durationSeconds"], "frames": []}
    if positions[-1] >= info["durationSeconds"]:
        raise MediaInputError("timestamp_outside_media")
    frames = []
    with tempfile.TemporaryDirectory(prefix="media-frames-") as directory:
        for index, position in enumerate(positions):
            target = pathlib.Path(directory) / (str(index) + ".jpg")
            # Decode presentation order and retain actual selected PTS, not the requested time.
            filters = "setpts=PTS-STARTPTS,select='gte(t,%s)',showinfo,scale=320:320:force_original_aspect_ratio=decrease" % position
            result = _run(["/tools/ffmpeg", "-nostdin", "-v", "info", "-protocol_whitelist", "file,pipe",
                "-threads", "1", "-i", str(path), "-map", "0:v:0", "-an", "-vf", filters,
                "-frames:v", "1", "-threads", "1", "-q:v", "3", "-y", str(target)])
            times = re.findall(rb"\bn:\s*0\s+pts:.*?pts_time:([0-9.eE+-]+)", result.stderr)
            if not times or not target.is_file():
                raise MediaInputError("requested_frame_unavailable")
            actual = float(times[0])
            data = target.read_bytes()
            if actual < position - 0.00001 or actual >= info["durationSeconds"] or len(data) > 196608:
                raise MediaInputError("frame_budget_or_timestamp")
            frames.append({"requestedSeconds": position, "atSeconds": actual, "mimeType": "image/jpeg",
                           "data": base64.b64encode(data).decode("ascii"), "bytes": len(data)})
    return {"status": "ok", "durationSeconds": info["durationSeconds"], "frames": frames,
            "coverage": {"kind": "decoded-requested-frames", "exhaustive": False,
                         "requested": len(positions), "decoded": len(frames)}}


def run_transcribe(envelope, model_path, model_revision, allowed_languages=("en",)):
    value, path = _input(envelope)
    model = pathlib.Path(model_path)
    if not model.is_absolute() or model.parent != pathlib.Path("/models") or not model.is_dir() or model.is_symlink():
        raise MediaInputError("locked_model_unavailable")
    if not re.fullmatch(r"[a-f0-9]{40}", model_revision):
        raise MediaInputError("locked_model_revision")
    language = value.get("language", "en")
    if language not in allowed_languages:
        return {"status": "unsupported_language", "requestedLanguage": str(language)[:16]}
    try:
        info = _probe(path)
    except MediaDurationError:
        return {"status": "unsupported_duration", "limitSeconds": 600}
    except (subprocess.SubprocessError, ValueError, KeyError):
        return {"status": "invalid_media", "reason": "decode_failed"}
    if not info["hasAudio"]:
        return {"status": "no_audio", "durationSeconds": info["durationSeconds"], "text": "", "segments": []}
    # Explicit offline mode plus an existing absolute path: no model name resolution.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    from faster_whisper import WhisperModel
    recognizer = WhisperModel(str(model), device="cpu", compute_type="int8", cpu_threads=2,
                              num_workers=1, local_files_only=True)
    generated, metadata = recognizer.transcribe(str(path), language=language, beam_size=5,
        temperature=0, vad_filter=True, condition_on_previous_text=False, word_timestamps=False)
    segments = []
    for segment in generated:
        text = segment.text.strip()
        if not text:
            continue
        start, end = float(segment.start), float(segment.end)
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end < start or end > info["durationSeconds"] + 0.25:
            raise MediaInputError("invalid_segment_timing")
        segments.append({"startSeconds": start, "endSeconds": end, "text": text,
                         "noSpeechProbability": float(segment.no_speech_prob),
                         "avgLogProbability": float(segment.avg_logprob), "compressionRatio": float(segment.compression_ratio)})
        if len(segments) > 256 or sum(len(s["text"]) for s in segments) > 64000:
            raise MediaInputError("transcript_budget")
    return {"status": "transcribed" if segments else "no_speech", "durationSeconds": info["durationSeconds"],
            "text": " ".join(s["text"] for s in segments), "segments": segments, "language": metadata.language,
            "modelRevision": model_revision, "coverage": "full-audio-vad", "speechSeconds": float(metadata.duration_after_vad)}
