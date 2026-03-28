"""
WebSocket ↔ Gemini Live API bridge.

Architecture:
  Browser → WS → FastAPI handler → asyncio.Queue (raw messages)
                                         ↓
                                   bridge_coroutine (per session)
                                         ↓
                              Gemini Live API session (active phase)
                                         ↓
                              Server → Client WS messages
"""

import asyncio
import base64
import json
import os
from fastapi import WebSocket, WebSocketDisconnect
from google import genai
from google.genai import types

import session as session_store
from agents.prompts import (
    VISION_SYSTEM_PROMPT,
    GUIDANCE_SYSTEM_PROMPT,
    VERIFICATION_SYSTEM_PROMPT,
    PRO_ESCALATION_PROMPT,
)
from agents.nyc311 import fetch_311_context
from agents.grounding import fetch_repair_procedure

GEMINI_LIVE_MODEL = "gemini-2.0-flash-live-001"
GEMINI_MODEL = "gemini-2.0-flash"
BBOX_HISTORY_MAX = 5
# Gemini Live mic input: raw little-endian PCM (see send_realtime_input audio=...)
MIC_PCM_MIME = "audio/pcm;rate=16000"


def _make_client() -> genai.Client:
    return genai.Client(
        vertexai=True,
        project=os.getenv("GOOGLE_CLOUD_PROJECT"),
        location=os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1"),
    )


async def handle(websocket: WebSocket, session_id: str) -> None:
    """Main WebSocket handler — one per connected client."""
    await websocket.accept()

    state = session_store.get_or_create(session_id)
    raw_queue: asyncio.Queue = asyncio.Queue(maxsize=120)

    # Run the bridge coroutine and WS receiver concurrently
    bridge_task = asyncio.create_task(_bridge(websocket, state, raw_queue))
    recv_task = asyncio.create_task(_receive_loop(websocket, raw_queue))

    try:
        done, pending = await asyncio.wait(
            [bridge_task, recv_task],
            return_when=asyncio.FIRST_EXCEPTION,
        )
        for task in pending:
            task.cancel()
        # Re-raise any exception
        for task in done:
            if task.exception():
                raise task.exception()
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_json({"type": "error", "code": "session_error", "message": str(e)})
        except Exception:
            pass
    finally:
        bridge_task.cancel()
        recv_task.cancel()
        session_store.delete(session_id)


async def _receive_loop(websocket: WebSocket, queue: asyncio.Queue) -> None:
    """Drain incoming WebSocket messages into the raw queue."""
    async for message in websocket.iter_text():
        try:
            data = json.loads(message)
            await queue.put(data)
        except json.JSONDecodeError:
            pass


async def _bridge(
    websocket: WebSocket,
    state: session_store.SessionState,
    queue: asyncio.Queue,
) -> None:
    """
    Core bridge: reads from queue, routes to the active Gemini Live session,
    streams responses back to the browser.
    """
    client = _make_client()

    while True:
        # Each phase gets its own Live session
        if state.active_phase == "vision":
            await _run_vision_phase(client, websocket, state, queue)
        elif state.active_phase == "guidance":
            await _run_guidance_phase(client, websocket, state, queue)
        elif state.active_phase == "verification":
            await _run_verification_phase(client, websocket, state, queue)
        elif state.active_phase == "escalate":
            await _run_escalation_phase(client, websocket, state, queue)
            # If user overrode ("handle myself"), active_phase is now "guidance"
            # and the loop continues. Otherwise we're done.
            if state.active_phase == "escalate":
                break
        else:
            break


async def _run_vision_phase(
    client: genai.Client,
    websocket: WebSocket,
    state: session_store.SessionState,
    queue: asyncio.Queue,
) -> None:
    """VisionAgent: 1fps camera frames → problem identification."""
    await _send(websocket, {"type": "status", "state": "identifying"})

    nyc_context = state.nyc_context or ""
    system_prompt = VISION_SYSTEM_PROMPT.replace("{nyc_context}", nyc_context)

    live_config = types.LiveConnectConfig(
        response_modalities=["AUDIO", "TEXT"],
        system_instruction=system_prompt,
    )

    async with client.aio.live.connect(model=GEMINI_LIVE_MODEL, config=live_config) as live:
        send_task = asyncio.create_task(_feed_frames(queue, live, state, fps=1))
        try:
            async for response in live.receive():
                # Handle audio output → relay to browser
                if hasattr(response, "data") and response.data:
                    audio_b64 = base64.b64encode(response.data).decode()
                    await _send(websocket, {"type": "speech", "audio": audio_b64})

                # Handle text output → try to parse as phase JSON
                text = _extract_text(response)
                if text:
                    parsed = _try_parse_json(text)
                    if parsed and parsed.get("phase") == "identified":
                        send_task.cancel()
                        state.problem = parsed.get("issue", "")
                        state.severity_json = parsed
                        state.diy_safe = parsed.get("diy_safe", True)

                        await _send(websocket, {"type": "severity", **parsed})

                        if state.diy_safe:
                            # Fetch grounding + switch to guidance
                            await _send(websocket, {"type": "status", "state": "loading_guidance"})
                            state.grounding_cache = await fetch_repair_procedure(state.problem)
                            state.active_phase = "guidance"
                        else:
                            state.active_phase = "escalate"
                        return

                # Handle NYC location message from queue (non-blocking peek)
                await _process_location_from_queue(queue, state, websocket)

        finally:
            send_task.cancel()


async def _run_guidance_phase(
    client: genai.Client,
    websocket: WebSocket,
    state: session_store.SessionState,
    queue: asyncio.Queue,
) -> None:
    """GuidanceAgent: live voice + step instructions + bbox annotations."""
    await _send(websocket, {"type": "status", "state": "guiding"})

    repair_procedure = state.grounding_cache or f"Standard repair procedure for {state.problem}"
    system_prompt = GUIDANCE_SYSTEM_PROMPT.format(
        problem=state.problem or "home repair issue",
        repair_procedure=repair_procedure,
        current_step=state.current_step + 1,
        total_steps=state.total_steps or "several",
    )

    live_config = types.LiveConnectConfig(
        response_modalities=["AUDIO", "TEXT"],
        system_instruction=system_prompt,
    )

    async with client.aio.live.connect(model=GEMINI_LIVE_MODEL, config=live_config) as live:
        # Inject context so agent knows what to guide
        context_msg = (
            f"The user needs help fixing: {state.problem}. "
            f"Safety context: {json.dumps(state.severity_json)}. "
            f"Begin guiding step by step now."
        )
        await live.send(input=context_msg, end_of_turn=True)

        send_task = asyncio.create_task(_feed_frames(queue, live, state, fps=2))
        try:
            async for response in live.receive():
                if hasattr(response, "data") and response.data:
                    audio_b64 = base64.b64encode(response.data).decode()
                    await _send(websocket, {"type": "speech", "audio": audio_b64})

                text = _extract_text(response)
                if text:
                    parsed = _try_parse_json(text)
                    if parsed:
                        if parsed.get("phase") == "step":
                            state.current_step = parsed.get("n", state.current_step)
                            state.total_steps = parsed.get("total", state.total_steps)
                            await _send(websocket, {"type": "step", **parsed})

                            # Fetch bbox for this component via separate Gemini call
                            asyncio.create_task(
                                _fetch_and_send_bbox(
                                    client, websocket, state, parsed.get("component", "")
                                )
                            )

                        elif parsed.get("phase") == "guidance_complete":
                            send_task.cancel()
                            state.repair_attempted = True
                            state.active_phase = "verification"
                            await _send(websocket, {"type": "status", "state": "verifying"})
                            return

        finally:
            send_task.cancel()


async def _run_verification_phase(
    client: genai.Client,
    websocket: WebSocket,
    state: session_store.SessionState,
    queue: asyncio.Queue,
) -> None:
    """VerificationAgent: watch 3 frames, emit pass/fail."""
    await _send(websocket, {"type": "status", "state": "verifying"})

    system_prompt = VERIFICATION_SYSTEM_PROMPT.format(problem=state.problem or "repair")

    live_config = types.LiveConnectConfig(
        response_modalities=["AUDIO", "TEXT"],
        system_instruction=system_prompt,
    )

    frames_sent = 0
    async with client.aio.live.connect(model=GEMINI_LIVE_MODEL, config=live_config) as live:
        # Feed exactly 3 frames then ask for verdict
        async with asyncio.timeout(30):
            while frames_sent < 3:
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=5.0)
                    t = msg.get("type")
                    if t == "audio":
                        pcm = base64.b64decode(msg["data"])
                        try:
                            await live.send_realtime_input(
                                audio=types.Blob(data=pcm, mime_type=MIC_PCM_MIME),
                            )
                        except Exception:
                            pass
                    elif t == "frame":
                        frame_bytes = base64.b64decode(msg["data"])
                        await live.send(
                            input=types.Part.from_bytes(data=frame_bytes, mime_type="image/jpeg"),
                            end_of_turn=(frames_sent == 2),
                        )
                        frames_sent += 1
                except asyncio.TimeoutError:
                    break

        async for response in live.receive():
            if hasattr(response, "data") and response.data:
                audio_b64 = base64.b64encode(response.data).decode()
                await _send(websocket, {"type": "speech", "audio": audio_b64})

            text = _extract_text(response)
            if text:
                parsed = _try_parse_json(text)
                if parsed and parsed.get("phase") == "verified":
                    await _send(websocket, {"type": "verify_result", **parsed})
                    if state.nyc_context:
                        await _send(websocket, {"type": "nyc_context", "text": state.nyc_context})
                    return


async def _run_escalation_phase(
    client: genai.Client,
    websocket: WebSocket,
    state: session_store.SessionState,
    queue: asyncio.Queue,
) -> None:
    """Escalation: explain why DIY is unsafe, recommend professional."""
    await _send(websocket, {"type": "status", "state": "escalate"})

    findings = json.dumps(state.severity_json.get("findings", []) if state.severity_json else [])
    system_prompt = PRO_ESCALATION_PROMPT.format(
        problem=state.problem or "hazardous issue",
        findings=findings,
    )

    live_config = types.LiveConnectConfig(
        response_modalities=["AUDIO", "TEXT"],
        system_instruction=system_prompt,
    )

    async with client.aio.live.connect(model=GEMINI_LIVE_MODEL, config=live_config) as live:
        await live.send(
            input=f"Explain why this is unsafe for DIY and what professional to call: {state.problem}",
            end_of_turn=True,
        )

        async for response in live.receive():
            if hasattr(response, "data") and response.data:
                audio_b64 = base64.b64encode(response.data).decode()
                await _send(websocket, {"type": "speech", "audio": audio_b64})

            text = _extract_text(response)
            if text:
                parsed = _try_parse_json(text)
                if parsed and parsed.get("phase") == "escalated":
                    await _send(websocket, {"type": "escalated", **parsed})
                    break

    # Wait up to 60 seconds for the user to override ("I'll handle it myself")
    # or close the session. Interrupt message → resume as guided DIY.
    try:
        async with asyncio.timeout(60):
            while True:
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=5.0)
                except asyncio.TimeoutError:
                    continue
                if msg.get("type") == "interrupt":
                    state.active_phase = "guidance"
                    state.diy_safe = True  # user override
                    # Fetch grounding now so guidance phase has it
                    if not state.grounding_cache and state.problem:
                        await _send(websocket, {"type": "status", "state": "loading_guidance"})
                        state.grounding_cache = await fetch_repair_procedure(state.problem)
                    return
    except asyncio.TimeoutError:
        pass  # No override — session ends normally


async def _fetch_and_send_bbox(
    client: genai.Client,
    websocket: WebSocket,
    state: session_store.SessionState,
    component: str,
) -> None:
    """
    Bbox fallback: separate non-streaming Gemini call to get bounding box.
    This is the reliable path — does not depend on Live text channel parsing.
    """
    if not component or not state.bbox_history:
        return

    # Use the most recent frame for bbox detection
    last_frame_b64 = state.bbox_history[-1] if state.bbox_history else None
    if not last_frame_b64:
        return

    try:
        response = await client.aio.models.generate_content(
            model=GEMINI_MODEL,
            contents=[
                types.Part.from_bytes(
                    data=base64.b64decode(last_frame_b64),
                    mime_type="image/jpeg",
                ),
                types.Part(
                    text=(
                        f"Locate '{component}' in this image. "
                        f"Return ONLY this JSON, nothing else: "
                        f'{{\"bbox\": [x, y, width, height], \"label\": \"{component}\"}}'
                        f" where coordinates are 0-1 normalized (fraction of image size). "
                        f"If not visible, return {{\"bbox\": null}}"
                    )
                ),
            ],
            config=types.GenerateContentConfig(temperature=0.0),
        )

        parsed = _try_parse_json(response.text or "")
        if parsed and parsed.get("bbox"):
            await _send(websocket, {
                "type": "annotation",
                "bbox": parsed["bbox"],
                "label": component,
                "color": "white",
            })
    except Exception:
        pass  # bbox is best-effort, never blocks the session


async def _feed_frames(
    queue: asyncio.Queue,
    live_session,
    state: session_store.SessionState,
    fps: int,
) -> None:
    """
    Pull frame messages from the queue and send to the Live session.
    fps controls how many frames per second to forward (others are dropped).
    """
    import time
    interval = 1.0 / fps
    last_sent = 0.0

    while True:
        try:
            msg = await asyncio.wait_for(queue.get(), timeout=5.0)
        except asyncio.TimeoutError:
            continue

        t = msg.get("type")
        if t == "audio":
            pcm = base64.b64decode(msg["data"])
            try:
                await live_session.send_realtime_input(
                    audio=types.Blob(data=pcm, mime_type=MIC_PCM_MIME),
                )
            except Exception:
                pass

        elif t == "interrupt":
            txt = (msg.get("text") or "").strip()
            if txt:
                try:
                    await live_session.send_realtime_input(text=txt)
                except Exception:
                    pass

        elif t == "frame":
            now = time.monotonic()
            if now - last_sent >= interval:
                last_sent = now
                frame_bytes = base64.b64decode(msg["data"])
                try:
                    await live_session.send(
                        input=types.Part.from_bytes(data=frame_bytes, mime_type="image/jpeg"),
                        end_of_turn=False,
                    )
                    b64 = msg["data"]
                    state.bbox_history.append(b64)
                    if len(state.bbox_history) > BBOX_HISTORY_MAX:
                        state.bbox_history.pop(0)
                except Exception:
                    pass

        elif t == "location":
            # Re-queue for _process_location_from_queue only if context not yet fetched
            if not state.nyc_context:
                queue.put_nowait(msg)


async def _process_location_from_queue(
    queue: asyncio.Queue,
    state: session_store.SessionState,
    websocket: WebSocket,
) -> None:
    """Non-blocking: check if a location message is at the front of the queue."""
    if state.nyc_context:
        return
    try:
        msg = queue.get_nowait()
        if msg.get("type") == "location":
            zip_code = msg.get("zip", "")
            if zip_code:
                context = await fetch_311_context(zip_code)
                if context:
                    state.nyc_context = context
                    await _send(websocket, {"type": "nyc_chip", "text": context})
        else:
            # Not a location message — put back
            await queue.put(msg)
    except asyncio.QueueEmpty:
        pass


def _extract_text(response) -> str:
    """Extract text content from a Gemini Live response."""
    try:
        if hasattr(response, "text") and response.text:
            return response.text
        if hasattr(response, "server_content") and response.server_content:
            sc = response.server_content
            if hasattr(sc, "model_turn") and sc.model_turn:
                for part in sc.model_turn.parts:
                    if hasattr(part, "text") and part.text:
                        return part.text
    except Exception:
        pass
    return ""


def _try_parse_json(text: str) -> dict | None:
    """Try to parse JSON from text. Silent failure — returns None if not valid JSON."""
    text = text.strip()
    # Find JSON object in text (model may wrap it in prose)
    start = text.find("{")
    end = text.rfind("}") + 1
    if start == -1 or end == 0:
        return None
    try:
        return json.loads(text[start:end])
    except json.JSONDecodeError:
        return None


async def _send(websocket: WebSocket, data: dict) -> None:
    """Safe WebSocket send — swallows errors on closed connections."""
    try:
        await websocket.send_json(data)
    except Exception:
        pass
