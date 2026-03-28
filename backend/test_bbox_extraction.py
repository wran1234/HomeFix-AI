"""
Day 1 Critical Test — Bbox JSON extraction from Gemini Live text channel.

Run: python backend/test_bbox_extraction.py

Outcome:
  PASS → bbox JSON arrives in the Live text channel (Layer A native).
         Proceed as-is — no fallback needed for bbox.
  FAIL → Live text channel carries transcript only, not structured JSON.
         Use Layer B fallback (separate gemini-2.0-flash call per step).

This test sends a single JPEG frame (a small test image) to Gemini Live
and asks it to return bbox JSON. If the parsed JSON lands in the text
channel within 10 seconds, Layer A is viable.
"""

import asyncio
import base64
import json
import os
import sys

# Load .env
from pathlib import Path
env_path = Path(__file__).parent / ".env"
if env_path.exists():
    for line in env_path.read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

from google import genai
from google.genai import types

GEMINI_LIVE_MODEL = "gemini-2.0-flash-live-001"

# Minimal 1x1 white JPEG (valid JPEG for testing)
TINY_JPEG_B64 = (
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U"
    "HRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgN"
    "DRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy"
    "MjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABAMC/8QAHhAA"
    "AgICAwEAAAAAAAAAAAAAAQIDEQQSITH/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAA"
    "AAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKbKWYTjJPIBJP8Ag9sKqlLFGKSSABwAB/9k="
)


async def run_test():
    project = os.getenv("GOOGLE_CLOUD_PROJECT", "")
    if not project or project == "your-gcp-project-id":
        print("ERROR: Set GOOGLE_CLOUD_PROJECT in backend/.env first")
        sys.exit(1)

    client = genai.Client(
        vertexai=True,
        project=project,
        location=os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1"),
    )

    system_prompt = (
        "You are a computer vision assistant. "
        "When you see an image, locate any visible objects and return their bounding boxes. "
        "ALWAYS respond with this JSON format (and nothing else): "
        '{"phase": "identified", "bbox": [x, y, width, height], "label": "object name"} '
        "where coordinates are 0-1 normalized fractions. "
        "If the image is blank or no objects are visible, return: "
        '{"phase": "identified", "bbox": null, "label": "none"}'
    )

    live_config = types.LiveConnectConfig(
        response_modalities=["AUDIO", "TEXT"],
        system_instruction=system_prompt,
    )

    print(f"Connecting to {GEMINI_LIVE_MODEL}...")
    json_received = None
    text_received = []

    try:
        async with client.aio.live.connect(model=GEMINI_LIVE_MODEL, config=live_config) as live:
            # Send the test frame
            frame_bytes = base64.b64decode(TINY_JPEG_B64)
            await live.send(
                input=types.Part.from_bytes(data=frame_bytes, mime_type="image/jpeg"),
                end_of_turn=True,
            )
            print("Frame sent. Waiting for text response (10s timeout)...")

            async with asyncio.timeout(10):
                async for response in live.receive():
                    # Try to get text
                    text = ""
                    if hasattr(response, "text") and response.text:
                        text = response.text
                    elif hasattr(response, "server_content") and response.server_content:
                        sc = response.server_content
                        if hasattr(sc, "model_turn") and sc.model_turn:
                            for part in sc.model_turn.parts:
                                if hasattr(part, "text") and part.text:
                                    text = part.text
                                    break

                    if text:
                        text_received.append(text)
                        print(f"  Text received: {text!r}")
                        # Try JSON parse
                        stripped = text.strip()
                        start = stripped.find("{")
                        end = stripped.rfind("}") + 1
                        if start != -1 and end > 0:
                            try:
                                parsed = json.loads(stripped[start:end])
                                if "phase" in parsed or "bbox" in parsed:
                                    json_received = parsed
                                    print(f"  JSON parsed: {parsed}")
                                    break
                            except json.JSONDecodeError:
                                pass

                    # Check if turn is complete
                    if hasattr(response, "server_content") and response.server_content:
                        sc = response.server_content
                        if getattr(sc, "turn_complete", False):
                            break

    except asyncio.TimeoutError:
        print("  (timed out waiting for response)")
    except Exception as e:
        print(f"ERROR: {e}")
        sys.exit(1)

    print()
    print("=" * 60)
    if json_received:
        print("RESULT: PASS ✓")
        print(f"  bbox JSON arrived in Live text channel: {json_received}")
        print()
        print("→ Layer A (native) is viable. No fallback needed.")
        print("  ws_handler.py is already configured for this path.")
    else:
        all_text = " ".join(text_received)
        print("RESULT: FAIL — JSON not found in text channel")
        print(f"  Text received: {all_text!r}")
        print()
        print("→ Use Layer B fallback (already implemented in ws_handler.py).")
        print("  _fetch_and_send_bbox() will fire per step.")
        print("  No code changes needed — fallback is active by default.")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(run_test())
