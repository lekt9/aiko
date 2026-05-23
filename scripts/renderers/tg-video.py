#!/usr/bin/env python3
"""tg-video renderer: composes video-message renderer's HINT envelope
with a Telegram sendVideo dispatch hint. Output envelope tells the
caller exactly which TG Bot API call to make once the video is rendered.

Output:
    {
      "kind": "tg-video-hint",
      "video": <video-message-hint envelope>,
      "telegram_dispatch": {
        "method": "sendVideo",
        "chat_id_env": "TG_CHAT_ID",
        "thread_id_env": "TG_THREAD_ID",
        "caption": "<auto-derived caption>"
      }
    }
"""
from __future__ import annotations
import json, os, subprocess, sys
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
VIDEO_RENDERER = SKILL / "renderers" / "video-message.py"


def main() -> int:
    text = sys.stdin.read()
    cid = os.environ.get("CONTEXT_CONTRACT_ID", "")
    if not VIDEO_RENDERER.exists():
        sys.stderr.write("tg-video: depends on video-message renderer (missing)\n")
        return 1
    cp = subprocess.run(
        ["python3", str(VIDEO_RENDERER)],
        input=text, text=True, capture_output=True, env=os.environ,
    )
    if cp.returncode != 0 or not cp.stdout:
        sys.stderr.write(f"tg-video: video-message renderer failed: {cp.stderr}\n")
        return 1
    try:
        video_env = json.loads(cp.stdout)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"tg-video: invalid video-message envelope: {e}\n")
        return 1
    spoken = video_env.get("tts", {}).get("text", "")
    caption = spoken[:200]
    envelope = {
        "kind": "tg-video-hint",
        "contract_id": cid,
        "video": video_env,
        "telegram_dispatch": {
            "method": "sendVideo",
            "chat_id_env": "TG_CHAT_ID",
            "thread_id_env": "TG_THREAD_ID",
            "caption": caption,
            "curl_example": (
                "curl -F chat_id=\"$TG_CHAT_ID\" "
                "-F message_thread_id=\"$TG_THREAD_ID\" "
                "-F video=@<rendered.mp4> "
                f"-F caption={json.dumps(caption)} "
                "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendVideo"
            ),
            "discipline": "MUST resolve chat_id via harness.social.resolve_handle before sending (contract 61e84fd1); MUST set message_thread_id when posting to Karabot supergroup (-1003661261221, thread 2738) per standing rule 0c3fcd65.",
        },
    }
    print(json.dumps(envelope, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
