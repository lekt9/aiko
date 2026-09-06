"""Private per-user media processing; no gateway credentials or model shell input."""
import base64
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET

root = pathlib.Path("/home/daytona/aiko/operations")
operation = sys.argv[1]
if len(operation) != 36 or any(c not in "abcdef0123456789-" for c in operation):
    raise ValueError("Invalid operation")
os.umask(0o077)
source = root / (operation + ".media")

def run(args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

def process_media():
    if config.get("mode") == "speak":
        return speak()
    mime = config.get("mimeType", "")
    if mime == "application/pdf":
        output = root / (operation + ".extracted.txt")
        try:
            run(["pdftotext", "-layout", str(source), str(output)])
            with output.open("r", errors="replace") as text_file:
                text = text_file.read(64001)
            return {"status":"processed", "text":text[:64000], "truncated":len(text)>64000,
                    "reason":"pdf_text_layer_only_not_ocr"}
        finally:
            output.unlink(missing_ok=True)
    if mime.startswith("application/vnd.openxmlformats-officedocument."):
        parts, remaining = [], 64001
        with zipfile.ZipFile(source) as archive:
            for entry in archive.infolist():
                if not entry.filename.endswith(".xml") or not entry.filename.startswith(("word/", "xl/", "ppt/slides/")):
                    continue
                if entry.file_size > 20 * 1024 * 1024:
                    raise ValueError("Document XML part exceeds resource limit")
                # Text only: never execute macros, resolve external links or extract archive paths.
                document = ET.fromstring(archive.read(entry))
                for node in document.iter():
                    if node.tag.rsplit("}", 1)[-1] in ("t", "v") and node.text:
                        part = node.text[:remaining]
                        parts.append(part)
                        remaining -= len(part) + 1
                        if remaining <= 0:
                            break
                if remaining <= 0:
                    break
        return {"status":"processed", "text":"\n".join(parts)[:64000], "truncated":remaining<=0,
                "reason":"office_text_and_cell_values_only_no_macros_or_external_links"}
    return audiovisual()

def speak():
    text = str(config["text"])
    if not text or len(text) > 12000:
        raise ValueError("Invalid speech length")
    wav, ogg = root / (operation + ".wav"), root / (operation + ".ogg")
    try:
        subprocess.run(["espeak-ng", "-v", "en-us", "-s", "145", "--stdin", "-w", str(wav)], input=text.encode(), check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        run(["ffmpeg", "-v", "error", "-y", "-i", str(wav), "-c:a", "libopus", str(ogg)])
        return {"status":"processed", "mimeType":"audio/ogg", "data":base64.b64encode(ogg.read_bytes()).decode()}
    finally:
        wav.unlink(missing_ok=True)
        ogg.unlink(missing_ok=True)

def audiovisual():
    kind, mime = config["kind"], config.get("mimeType", "")
    info = json.loads(run(["ffprobe", "-v", "quiet", "-show_streams", "-show_format", "-of", "json", str(source)]).stdout)
    streams = info.get("streams", [])
    duration = float(info.get("format", {}).get("duration", 0))
    images, text = [], ""
    if any(s.get("codec_type") == "video" for s in streams):
        positions = [0] if mime.startswith("image/") else [duration * i / 6 for i in range(6)] if duration > 0 else [0]
        for index, position in enumerate(positions):
            frame = root / (operation + "." + str(index) + ".jpg")
            try:
                run(["ffmpeg", "-v", "error", "-y", "-ss", str(position), "-i", str(source), "-frames:v", "1", "-vf", "scale=640:640:force_original_aspect_ratio=decrease", str(frame)])
                images.append({"mimeType":"image/jpeg", "data":base64.b64encode(frame.read_bytes()).decode(), "atSeconds":position})
            finally:
                frame.unlink(missing_ok=True)
    if any(s.get("codec_type") == "audio" for s in streams):
        from faster_whisper import WhisperModel
        model = WhisperModel("small", device="cpu", compute_type="int8", cpu_threads=2, download_root="/home/daytona/aiko/models")
        segments, metadata = model.transcribe(str(source), beam_size=5, vad_filter=True)
        text = " ".join(segment.text.strip() for segment in segments)
    return {"status":"processed", "text":text, "images":images, "duration":duration, "sampledVideo":len(images)>1}

try:
    config = json.loads((root / (operation + ".media.json")).read_text())
    # The gateway's exec tail is bounded and its download path UTF-8 decodes files.
    # ASCII JSON is lossless for both Unicode text and inline base64 media; stdout
    # carries only integrity metadata, never the potentially multi-megabyte result.
    result = json.dumps(process_media(), ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("ascii")
    if len(result) > 24 * 1024 * 1024:
        raise ValueError("Media processing result exceeds resource limit")
    temporary = root / (operation + ".media.result.tmp")
    temporary.write_bytes(result)
    temporary.replace(root / (operation + ".media.result.json"))
    print(json.dumps({"version":1, "size":len(result), "sha256":hashlib.sha256(result).hexdigest()}))
finally:
    source.unlink(missing_ok=True)
    (root / (operation + ".media.json")).unlink(missing_ok=True)
