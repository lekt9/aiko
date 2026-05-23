#!/usr/bin/env python3
"""video-message renderer: substrate stdio → HINT envelope naming the
chain to call for an actual video render. The substrate doesn't ship
seedance / fal credentials itself; the agent or downstream service
performs the render using the envelope.

Output envelope:
    {
      "kind": "video-message-hint",
      "tts": {"provider": "chatterbox", "text": "<spoken line>"},
      "video": {
        "provider": "seedance-r2v",
        "prompt":   "<scene + delivery prompt>",
        "audio_urls": "<TTS output piped in>",
        "duration_s": 12
      },
      "raw_substrate_text": "<original input truncated>"
    }
"""
from __future__ import annotations
import json, os, re, sys


def extract_spoken_line(text: str) -> str:
    """Pick the most user-facing line — first body: / plan: / message line."""
    for line in text.splitlines():
        s = line.strip()
        if not s: continue
        for prefix in ("body:", "plan:", "Body:", "Plan:"):
            if s.startswith(prefix):
                return s[len(prefix):].strip()[:300]
    # Fallback: first non-marker line
    for line in text.splitlines():
        s = line.strip()
        if s and not s.startswith("=") and not s.startswith("{") and 20 < len(s) < 300:
            return s
    return text.strip()[:300] or "Update from your agent."


def main() -> int:
    text = sys.stdin.read()
    cid = os.environ.get("CONTEXT_CONTRACT_ID", "")
    spoken = extract_spoken_line(text)
    envelope = {
        "kind": "video-message-hint",
        "contract_id": cid,
        "tts": {
            "provider": "chatterbox",
            "text": spoken,
            "fal_endpoint": "fal-ai/chatterbox/text-to-speech",
        },
        "video": {
            "provider": "seedance-r2v",
            "fal_endpoint": "fal-ai/seedance-pro",
            "prompt": (
                f"Aiko speaks to camera with the following line, "
                f"first-person feminine, no AI-slop, natural pacing: '{spoken[:200]}'"
            ),
            "audio_urls": "<TTS output URL goes here after tts step>",
            "duration_s": 12,
        },
        "rendering_chain": [
            "1. POST chatterbox/text-to-speech with spoken text → audio_url",
            "2. POST seedance-r2v with prompt + audio_urls=[audio_url] → video_url",
            "3. Cap video to duration_s via ffmpeg if longer",
            "4. Return video_url to caller",
        ],
        "raw_substrate_text": text[:500] + ("…" if len(text) > 500 else ""),
    }
    print(json.dumps(envelope, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
