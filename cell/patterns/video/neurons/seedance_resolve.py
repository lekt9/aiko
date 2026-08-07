#!/usr/bin/env python3
def run(inputs, ctx):
    prompt = inputs.get("prompt","")
    # ByteDance Seedance 2 realistic defaults — fractal harnesses love pinned params
    # Seedance is fal's model for seedance: fal-ai/bytedance/seedance-v1 or seedance/v1
    model = "fal-ai/bytedance/seedance-pro"  # mock-friendly; real fal key will hit queue.fal.run/<model>
    params = {
        "prompt": prompt,
        "duration": "5s",
        "aspect_ratio": "16:9",
        "resolution": "720p",
        "camera_fixed": False,
    }
    return {"model": model, "params": params}
