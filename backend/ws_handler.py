"""Phone camera + mic → WebSocket → Gemini Live (gemini-live-2.5-flash-native-audio) → spoken guidance for home repairs."""

import asyncio
import base64
import binascii
import json
import logging
import os
import time
import traceback
from contextlib import asynccontextmanager

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
from agents.grounding import fetch_repair_procedure
from agents.nyc311 import fetch_311_context

logger = logging.getLogger(__name__)

# ── Memory guardrails (Cloud Run OOM / crash loops) ───────────────────────────
# Unbounded asyncio.create_task(_fetch_and_send_bbox) each ran generate_content + JPEG decode;
# rapid tool calls (e.g. many emit_step) spiked RAM and killed small containers.
BBOX_FETCH_CONCURRENCY = 2
_bbox_fetch_sem = asyncio.BoundedSemaphore(BBOX_FETCH_CONCURRENCY)

# While waiting for {"type":"ready"}, do not hold arbitrary client frames in RAM forever.
_MAX_DEFERRED_BEFORE_READY = 48

# Smaller queue = lower worst-case duplicate JSON+JPEG copies per connection (bound × frame size).
WS_INBOUND_QUEUE_MAX = 128
LIVE_CONNECT_TIMEOUT_S = 20.0
# Maximum time to wait for a Gemini Live response before treating the session as stalled.
LIVE_RECEIVE_TIMEOUT_S = 90.0
BYPASS_LIVE_CONNECT_FOR_DEBUG = os.getenv("BYPASS_LIVE_CONNECT_FOR_DEBUG", "false").lower() == "true"


class LiveConnectTimeoutError(Exception):
    """Raised when opening Gemini Live socket exceeds timeout."""


class LiveConnectFailedError(Exception):
    """Raised when opening Gemini Live socket fails."""


async def _wait_for_client_ready(queue: asyncio.Queue) -> None:
    """Block until {"type":"ready"} while preserving early media (Python 3.10–compatible).

    Frames/audio used to be dropped here if they arrived before `ready` was dequeued
    (e.g. fast Begin + WS ordering). Re-inject them in order after `ready` so Gemini still
    receives video for the vision phase.
    """
    deferred: list[dict] = []
    location_msg: dict | None = None
    while True:
        try:
            msg = await asyncio.wait_for(queue.get(), timeout=5.0)
        except asyncio.TimeoutError:
            logger.info("_wait_for_client_ready: still waiting (qsize=%d, deferred=%d)", queue.qsize(), len(deferred))
            continue
        t = msg.get("type")
        if t == "ready":
            logger.info("_wait_for_client_ready: got ready")
            # Re-inject location and deferred media so later phases can use them.
            if location_msg is not None:
                queue.put_nowait(location_msg)
            for m in deferred:
                queue.put_nowait(m)
            break
        if t == "location":
            # Hold aside — do NOT re-queue or it will spin forever.
            location_msg = msg
        elif t in ("frame", "audio", "interrupt"):
            if len(deferred) >= _MAX_DEFERRED_BEFORE_READY:
                deferred.pop(0)
                logger.debug("deferred-before-ready cap: dropped oldest buffered message")
            deferred.append(msg)

# Multimodal Live: JPEG frames + 16 kHz mic PCM in; native audio (+ tool JSON) out.
GEMINI_LIVE_MODEL = "publishers/google/models/gemini-live-2.5-flash-native-audio"
GEMINI_MODEL = "gemini-2.0-flash-001"
BBOX_HISTORY_MAX = 5
MIC_PCM_MIME = "audio/pcm;rate=16000"


def _live_config(*, system_instruction: str, tools: list[types.Tool] | None = None) -> types.LiveConnectConfig:
    return types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        system_instruction=system_instruction,
        tools=tools,
    )


@asynccontextmanager
async def _live_session(
    client: genai.Client, config: types.LiveConnectConfig, state: session_store.SessionState
):
    connect_ctx = client.aio.live.connect(model=GEMINI_LIVE_MODEL, config=config)
    exc_type = None
    exc = None
    tb = None
    logger.info("opening Gemini Live session", extra={"model": GEMINI_LIVE_MODEL})
    try:
        live = await asyncio.wait_for(connect_ctx.__aenter__(), timeout=LIVE_CONNECT_TIMEOUT_S)
    except asyncio.TimeoutError as e:
        logger.error("Gemini Live connect timeout after %.1fs", LIVE_CONNECT_TIMEOUT_S)
        raise LiveConnectTimeoutError(f"timed out after {LIVE_CONNECT_TIMEOUT_S:.1f}s") from e
    except Exception as e:
        logger.error("Gemini Live connect failed: %s", e)
        raise LiveConnectFailedError(str(e)) from e

    state.live_debug.live_socket_open = True
    logger.info("Gemini Live connected", extra={"model": GEMINI_LIVE_MODEL})
    try:
        yield live
    except Exception as e:
        exc_type = type(e)
        exc = e
        tb = e.__traceback__
        raise
    finally:
        state.live_debug.live_socket_open = False
        try:
            await connect_ctx.__aexit__(exc_type, exc, tb)
        except Exception:
            pass


def _live_debug_touch_client_in(state: session_store.SessionState, msg: dict) -> None:
    d = state.live_debug
    t = msg.get("type")
    now = time.time()
    if t == "frame":
        d.client_frames_in += 1
        d.last_client_frame_ts = now
    elif t == "audio":
        d.client_audio_chunks_in += 1
        d.last_client_audio_ts = now
    elif t == "ready":
        d.saw_ready = True


def _live_debug_note_gemini_send_ok(state: session_store.SessionState, kind: str) -> None:
    d = state.live_debug
    now = time.time()
    if kind == "video":
        d.gemini_video_sends += 1
        d.last_gemini_video_send_ts = now
    elif kind == "audio":
        d.gemini_audio_sends += 1
        d.last_gemini_audio_send_ts = now


def _live_debug_note_gemini_send_err(state: session_store.SessionState, err: BaseException) -> None:
    d = state.live_debug
    d.gemini_send_errors += 1
    d.last_gemini_send_error = str(err)[:400]


def _live_debug_note_gemini_out_audio(state: session_store.SessionState, nbytes: int) -> None:
    d = state.live_debug
    d.gemini_audio_out_chunks += 1
    d.gemini_audio_out_bytes += nbytes
    d.last_gemini_audio_out_ts = time.time()


def _live_debug_note_tool(state: session_store.SessionState) -> None:
    d = state.live_debug
    d.gemini_tool_events += 1
    d.last_gemini_tool_ts = time.time()


# ── Function declarations (used instead of inline JSON for phase transitions) ─

IDENTIFY_TOOL = types.FunctionDeclaration(
    name="identify_problem",
    description="Call this when you have clearly identified the home repair problem from the camera feed.",
    parameters=types.Schema(
        type="OBJECT",
        properties={
            "issue": types.Schema(type="STRING", description="Brief description of the problem"),
            "severity": types.Schema(type="STRING", enum=["LOW", "MEDIUM", "HIGH"]),
            "diy_safe": types.Schema(type="BOOLEAN", description="True if safe for DIY repair"),
            "reason": types.Schema(type="STRING", description="Why DIY is safe or not"),
            "findings": types.Schema(type="ARRAY", items=types.Schema(type="STRING"), description="Specific observations"),
        },
        required=["issue", "severity", "diy_safe", "reason", "findings"],
    ),
)

EMIT_TOOLS_LIST = types.FunctionDeclaration(
    name="emit_tools_list",
    description="Call this to tell the user what tools and materials they need before starting the repair.",
    parameters=types.Schema(
        type="OBJECT",
        properties={
            "tools": types.Schema(type="ARRAY", items=types.Schema(type="STRING")),
            "materials": types.Schema(type="ARRAY", items=types.Schema(type="STRING")),
            "summary": types.Schema(type="STRING", description="One sentence describing what we're about to do"),
        },
        required=["tools", "materials", "summary"],
    ),
)

EMIT_STEP = types.FunctionDeclaration(
    name="emit_step",
    description="Call this for each repair step to update the on-screen step card.",
    parameters=types.Schema(
        type="OBJECT",
        properties={
            "n": types.Schema(type="INTEGER", description="Step number"),
            "total": types.Schema(type="INTEGER", description="Total number of steps"),
            "title": types.Schema(type="STRING", description="Short step title"),
            "body": types.Schema(type="STRING", description="Detailed instruction"),
            "tools": types.Schema(type="ARRAY", items=types.Schema(type="STRING")),
            "component": types.Schema(type="STRING", description="The specific part or area to focus the camera on"),
        },
        required=["n", "total", "title", "body", "tools", "component"],
    ),
)

GUIDANCE_COMPLETE = types.FunctionDeclaration(
    name="guidance_complete",
    description="Call this when all repair steps have been completed and it is time to verify the repair.",
    parameters=types.Schema(type="OBJECT", properties={}, required=[]),
)

VERIFY_REPAIR = types.FunctionDeclaration(
    name="verify_repair",
    description="Call this to report whether the repair looks successful based on the camera feed.",
    parameters=types.Schema(
        type="OBJECT",
        properties={
            "repair_passed": types.Schema(type="BOOLEAN", description="True if repair looks complete"),
            "message": types.Schema(type="STRING", description="Specific observation about what you see"),
        },
        required=["repair_passed", "message"],
    ),
)

ESCALATE = types.FunctionDeclaration(
    name="escalate",
    description="Call this when the problem is too dangerous for DIY and a professional is required.",
    parameters=types.Schema(
        type="OBJECT",
        properties={
            "findings": types.Schema(type="ARRAY", items=types.Schema(type="STRING")),
            "pro_type": types.Schema(type="STRING", description="Type of professional needed"),
        },
        required=["findings", "pro_type"],
    ),
)


def _make_client() -> genai.Client:
    api_key = os.getenv("GOOGLE_API_KEY", "").strip()
    if api_key:
        return genai.Client(api_key=api_key)
    return genai.Client(
        vertexai=True,
        project=os.getenv("GOOGLE_CLOUD_PROJECT"),
        location=os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1"),
    )


async def handle(websocket: WebSocket, session_id: str) -> None:
    await websocket.accept()
    logger.info("websocket connected", extra={"session_id": session_id})

    state = session_store.get_or_create(session_id)
    raw_queue: asyncio.Queue = asyncio.Queue(maxsize=WS_INBOUND_QUEUE_MAX)
    stop_debug = asyncio.Event()

    bridge_task = asyncio.create_task(_bridge(websocket, state, raw_queue))
    recv_task = asyncio.create_task(_receive_loop(websocket, raw_queue, state))
    debug_task = asyncio.create_task(_debug_pump(websocket, state, raw_queue, stop_debug))

    try:
        done, pending = await asyncio.wait(
            [bridge_task, recv_task],
            return_when=asyncio.FIRST_EXCEPTION,
        )
        for task in pending:
            task.cancel()
        for task in done:
            if not task.cancelled() and task.exception():
                raise task.exception()
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error("Session %s crashed: %s\n%s", session_id, e, traceback.format_exc())
        try:
            await websocket.send_json({"type": "error", "code": "session_error", "message": str(e)})
        except Exception:
            pass
    finally:
        stop_debug.set()
        debug_task.cancel()
        bridge_task.cancel()
        recv_task.cancel()
        try:
            await debug_task
        except asyncio.CancelledError:
            pass
        session_store.delete(session_id)


async def _debug_pump(
    websocket: WebSocket,
    state: session_store.SessionState,
    inbound_queue: asyncio.Queue,
    stop: asyncio.Event,
) -> None:
    """Push Live telemetry to the client ~1 Hz for on-device debugging."""
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=1.25)
            break
        except asyncio.TimeoutError:
            pass
        d = state.live_debug
        now = time.time()

        def age_ms(ts: float) -> int | None:
            if not ts:
                return None
            return max(0, int((now - ts) * 1000))

        receiving_from_phone = d.client_frames_in > 0 or d.client_audio_chunks_in > 0
        sending_to_gemini = d.gemini_video_sends > 0 or d.gemini_audio_sends > 0
        receiving_from_gemini = d.gemini_audio_out_chunks > 0 or d.gemini_tool_events > 0

        summary_parts = []
        if not d.saw_ready:
            summary_parts.append("No client ready signal yet (tap Begin session)")
        elif not d.live_socket_open:
            summary_parts.append("Vertex Live socket closed (between phases or error)")
        elif not receiving_from_phone:
            summary_parts.append("No frames/audio from phone on WS")
        elif not sending_to_gemini:
            summary_parts.append("Phone sending but nothing forwarded to Gemini (check bridge)")
        elif not receiving_from_gemini:
            summary_parts.append("Sending to Gemini but no audio/tool back yet")
        else:
            summary_parts.append("OK: bidirectional Live traffic observed")

        try:
            await _send(
                websocket,
                {
                    "type": "debug_live",
                    "model": GEMINI_LIVE_MODEL,
                    "bridge": d.bridge_label,
                    "live_ws_to_vertex": d.live_socket_open,
                    "saw_client_ready": d.saw_ready,
                    "client_frames_in": d.client_frames_in,
                    "client_audio_chunks_in": d.client_audio_chunks_in,
                    "ms_since_client_frame": age_ms(d.last_client_frame_ts),
                    "ms_since_client_audio": age_ms(d.last_client_audio_ts),
                    "gemini_jpeg_sends": d.gemini_video_sends,
                    "gemini_audio_sends": d.gemini_audio_sends,
                    "ms_since_gemini_jpeg_send": age_ms(d.last_gemini_video_send_ts),
                    "ms_since_gemini_audio_send": age_ms(d.last_gemini_audio_send_ts),
                    "gemini_audio_out_chunks": d.gemini_audio_out_chunks,
                    "gemini_audio_out_kb": round(d.gemini_audio_out_bytes / 1024.0, 2),
                    "ms_since_gemini_spoke": age_ms(d.last_gemini_audio_out_ts),
                    "tool_events_from_model": d.gemini_tool_events,
                    "ms_since_tool_event": age_ms(d.last_gemini_tool_ts),
                    "gemini_upstream_errors": d.gemini_send_errors,
                    "last_upstream_error": d.last_gemini_send_error or "",
                    "receiving_from_phone": receiving_from_phone,
                    "sending_to_gemini": sending_to_gemini,
                    "receiving_from_gemini": receiving_from_gemini,
                    "ws_queue_depth": inbound_queue.qsize(),
                    "ws_queue_max": WS_INBOUND_QUEUE_MAX,
                    "bbox_fetch_concurrency_cap": BBOX_FETCH_CONCURRENCY,
                    "summary": " · ".join(summary_parts),
                },
            )
        except Exception:
            break


async def _receive_loop(websocket: WebSocket, queue: asyncio.Queue, state: session_store.SessionState) -> None:
    async for message in websocket.iter_text():
        try:
            data = json.loads(message)
            logger.info("ws recv: type=%s qsize=%d", data.get("type"), queue.qsize())
            _live_debug_touch_client_in(state, data)
            await queue.put(data)
        except json.JSONDecodeError:
            pass


async def _bridge(
    websocket: WebSocket,
    state: session_store.SessionState,
    queue: asyncio.Queue,
) -> None:
    # Signal the UI before any Vertex/client work — genai.Client() can block on first use;
    # delaying agent_ready left users stuck on "Connecting to AI…".
    await _send(websocket, {"type": "agent_ready"})
    state.live_debug.bridge_label = "waiting_ready"
    logger.info("agent_ready sent")

    client = _make_client()

    # We do NOT open Gemini Live until {"type":"ready"} — avoids extra concurrent Live sockets.
    logger.info("waiting for ready")

    try:
        await asyncio.wait_for(_wait_for_client_ready(queue), timeout=120.0)
    except asyncio.TimeoutError:
        logger.warning("ready timeout path", extra={"timeout_s": 120})
        await _send(
            websocket,
            {
                "type": "error",
                "code": "READY_TIMEOUT",
                "message": "Begin session was not received in time. Please tap Begin session again.",
            },
        )
        return

    logger.info("ready received")
    if BYPASS_LIVE_CONNECT_FOR_DEBUG:
        logger.warning("BYPASS_LIVE_CONNECT_FOR_DEBUG enabled — skipping Gemini connect")
        await _send(websocket, {"type": "status", "state": "identifying"})
        logger.info("identifying status sent (bypass)")
        return

    logger.info("opening Gemini Live session")
    try:
        await _send(websocket, {"type": "status", "state": "identifying"})
        logger.info("identifying status sent")
        await _run_vision_phase(client, websocket, state, queue)
    except LiveConnectTimeoutError:
        logger.exception("LIVE_CONNECT_TIMEOUT path")
        await _send(
            websocket,
            {
                "type": "error",
                "code": "LIVE_CONNECT_TIMEOUT",
                "message": "Timed out while connecting to AI",
            },
        )
        return
    except LiveConnectFailedError as e:
        logger.exception("LIVE_CONNECT_FAILED path")
        await _send(
            websocket,
            {
                "type": "error",
                "code": "LIVE_CONNECT_FAILED",
                "message": str(e),
            },
        )
        return
    except Exception as e:
        logger.exception("Unexpected startup exception")
        await _send(
            websocket,
            {
                "type": "error",
                "code": "LIVE_CONNECT_FAILED",
                "message": str(e),
            },
        )
        return

    # Remaining phases each open their own session (config/tools differ per phase)
    while True:
        if state.active_phase == "guidance":
            await _run_guidance_phase(client, websocket, state, queue)
        elif state.active_phase == "verification":
            await _run_verification_phase(client, websocket, state, queue)
        elif state.active_phase == "escalate":
            await _run_escalation_phase(client, websocket, state, queue)
            if state.active_phase == "escalate":
                break
        else:
            break


def _text_turn(text: str) -> types.Content:
    return types.Content(parts=[types.Part(text=text)], role="user")


def _extract_audio(response) -> bytes | None:
    """Extract raw PCM audio bytes from a Live API response.
    The SDK exposes audio via server_content.model_turn.parts[].inline_data.data.
    Fall back to response.data for older SDK versions.
    """
    try:
        if hasattr(response, "server_content") and response.server_content:
            sc = response.server_content
            if hasattr(sc, "model_turn") and sc.model_turn:
                for part in sc.model_turn.parts:
                    if hasattr(part, "inline_data") and part.inline_data and part.inline_data.data:
                        return part.inline_data.data
    except Exception:
        pass
    # Fallback: some SDK versions surface audio directly on response.data
    if hasattr(response, "data") and response.data:
        return response.data
    return None


def _parse_function_call(response) -> tuple[str | None, dict, str | None]:
    """Extract function name, args, and call id (for tool responses) from a Live message."""
    try:
        if hasattr(response, "tool_call") and response.tool_call:
            for fc in response.tool_call.function_calls:
                args = dict(fc.args) if fc.args else {}
                fid = getattr(fc, "id", None) or None
                return fc.name, args, fid
        if hasattr(response, "server_content") and response.server_content:
            sc = response.server_content
            if hasattr(sc, "model_turn") and sc.model_turn:
                for part in sc.model_turn.parts:
                    if hasattr(part, "function_call") and part.function_call:
                        fc = part.function_call
                        args = dict(fc.args) if fc.args else {}
                        fid = getattr(fc, "id", None) or None
                        return fc.name, args, fid
    except Exception:
        pass
    return None, {}, None


async def _ack_tool(live_session, fn_name: str, call_id: str | None = None) -> None:
    """Send a tool response so the model knows the call was handled."""
    try:
        if call_id:
            fr = types.FunctionResponse(name=fn_name, response={"result": "ok"}, id=call_id)
        else:
            fr = types.FunctionResponse(name=fn_name, response={"result": "ok"})
        await live_session.send_tool_response(function_responses=[fr])
    except Exception as e:
        logger.warning("_ack_tool(%s) failed: %s", fn_name, e)


async def _run_vision_phase(
    client: genai.Client,
    websocket: WebSocket,
    state: session_store.SessionState,
    queue: asyncio.Queue,
    live=None,
) -> None:
    """Vision phase. If `live` is provided it reuses the pre-warmed session; otherwise opens its own."""
    state.live_debug.bridge_label = "vision_identify"

    async def _run(live_session) -> None:
        logger.info("vision: sending initial prompt")
        try:
            await live_session.send_realtime_input(
                text="Start now: greet the user warmly and ask them to show you the problem area."
            )
            logger.info("vision: initial prompt sent OK")
        except Exception as e:
            logger.error("vision: initial prompt send FAILED: %s", e)
            return
        send_task = asyncio.create_task(_feed_frames(queue, live_session, state, fps=1))
        last_activity = time.monotonic()
        logger.info("vision: entering receive loop")
        try:
            while True:
                async for response in live_session.receive():
                    last_activity = time.monotonic()
                    audio_bytes = _extract_audio(response)
                    if audio_bytes:
                        _live_debug_note_gemini_out_audio(state, len(audio_bytes))
                        audio_b64 = base64.b64encode(audio_bytes).decode()
                        await _send(websocket, {"type": "speech", "audio": audio_b64})

                    fn_name, args, call_id = _parse_function_call(response)
                    if fn_name:
                        _live_debug_note_tool(state)
                    if fn_name == "identify_problem" and args:
                        await _ack_tool(live_session, fn_name, call_id)
                        send_task.cancel()

                        state.problem = args.get("issue", "")
                        state.severity_json = args
                        state.diy_safe = args.get("diy_safe", True)

                        await _send(websocket, {"type": "severity", **args})
                        asyncio.create_task(
                            _fetch_and_send_bbox(client, websocket, state, state.problem)
                        )

                        if state.diy_safe:
                            await _send(websocket, {"type": "status", "state": "loading_guidance"})
                            state.grounding_cache = await fetch_repair_procedure(state.problem)
                            state.active_phase = "guidance"
                        else:
                            state.active_phase = "escalate"
                        return

                    await _process_location_from_queue(queue, state, websocket)

                # receive() iterator exhausted — check for stall
                if time.monotonic() - last_activity > LIVE_RECEIVE_TIMEOUT_S:
                    logger.error("vision phase: no Gemini activity for %.0fs, aborting", LIVE_RECEIVE_TIMEOUT_S)
                    await _send(websocket, {"type": "error", "code": "LIVE_STALLED", "message": "AI stopped responding. Please try again."})
                    return
        finally:
            send_task.cancel()

    if live is not None:
        await _run(live)
    else:
        nyc_context = state.nyc_context or ""
        system_prompt = VISION_SYSTEM_PROMPT.replace("{nyc_context}", nyc_context)
        live_config = _live_config(
            system_instruction=system_prompt,
            tools=[types.Tool(function_declarations=[IDENTIFY_TOOL])],
        )
        async with _live_session(client, live_config, state) as fresh_live:
            await _run(fresh_live)


async def _run_guidance_phase(
    client: genai.Client,
    websocket: WebSocket,
    state: session_store.SessionState,
    queue: asyncio.Queue,
) -> None:
    state.live_debug.bridge_label = "guidance"
    await _send(websocket, {"type": "status", "state": "guiding"})

    repair_procedure = state.grounding_cache or f"Standard repair procedure for {state.problem}"
    system_prompt = GUIDANCE_SYSTEM_PROMPT.format(
        problem=state.problem or "home repair issue",
        repair_procedure=repair_procedure,
        current_step=state.current_step + 1,
        total_steps=state.total_steps or "several",
    )

    live_config = _live_config(
        system_instruction=system_prompt,
        tools=[types.Tool(function_declarations=[EMIT_TOOLS_LIST, EMIT_STEP, GUIDANCE_COMPLETE])],
    )

    async with _live_session(client, live_config, state) as live:
        context_msg = (
            f"The user needs help fixing: {state.problem}. "
            f"Safety context: {json.dumps(state.severity_json)}. "
            f"Start by listing all tools and materials needed using emit_tools_list, then wait for them to say ready."
        )
        await live.send_realtime_input(text=context_msg)

        send_task = asyncio.create_task(_feed_frames(queue, live, state, fps=1))  # Live API max is 1fps
        last_activity = time.monotonic()
        try:
            while True:
                async for response in live.receive():
                    last_activity = time.monotonic()
                    audio_bytes = _extract_audio(response)
                    if audio_bytes:
                        _live_debug_note_gemini_out_audio(state, len(audio_bytes))
                        audio_b64 = base64.b64encode(audio_bytes).decode()
                        await _send(websocket, {"type": "speech", "audio": audio_b64})

                    fn_name, args, call_id = _parse_function_call(response)
                    if fn_name:
                        _live_debug_note_tool(state)
                    if fn_name == "emit_tools_list" and args:
                        await _ack_tool(live, fn_name, call_id)
                        await _send(websocket, {"type": "tools_list", **args})

                    elif fn_name == "emit_step" and args:
                        await _ack_tool(live, fn_name, call_id)
                        state.current_step = args.get("n", state.current_step)
                        state.total_steps = args.get("total", state.total_steps)
                        await _send(websocket, {"type": "step", **args})
                        asyncio.create_task(
                            _fetch_and_send_bbox(client, websocket, state, args.get("component", ""))
                        )

                    elif fn_name == "guidance_complete":
                        await _ack_tool(live, fn_name, call_id)
                        send_task.cancel()
                        state.repair_attempted = True
                        state.active_phase = "verification"
                        await _send(websocket, {"type": "status", "state": "verifying"})
                        return

                # receive() iterator exhausted — check for stall
                if time.monotonic() - last_activity > LIVE_RECEIVE_TIMEOUT_S:
                    logger.error("guidance phase: no Gemini activity for %.0fs, aborting", LIVE_RECEIVE_TIMEOUT_S)
                    await _send(websocket, {"type": "error", "code": "LIVE_STALLED", "message": "AI stopped responding during guidance. Please try again."})
                    return
        finally:
            send_task.cancel()


async def _run_verification_phase(
    client: genai.Client,
    websocket: WebSocket,
    state: session_store.SessionState,
    queue: asyncio.Queue,
) -> None:
    state.live_debug.bridge_label = "verification"
    await _send(websocket, {"type": "status", "state": "verifying"})

    system_prompt = VERIFICATION_SYSTEM_PROMPT.format(problem=state.problem or "repair")

    live_config = _live_config(
        system_instruction=system_prompt,
        tools=[types.Tool(function_declarations=[VERIFY_REPAIR])],
    )

    frames_sent = 0
    async with _live_session(client, live_config, state) as live:

        async def _ingest_verify_frames() -> None:
            nonlocal frames_sent
            while frames_sent < 3:
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=5.0)
                    t = msg.get("type")
                    if t == "audio":
                        pcm = base64.b64decode(msg["data"])
                        try:
                            await live.send_realtime_input(audio=types.Blob(data=pcm, mime_type=MIC_PCM_MIME))
                            _live_debug_note_gemini_send_ok(state, "audio")
                        except Exception as e:
                            _live_debug_note_gemini_send_err(state, e)
                    elif t == "frame":
                        frame_bytes = base64.b64decode(msg["data"])
                        try:
                            await live.send_realtime_input(
                                video=types.Blob(data=frame_bytes, mime_type="image/jpeg")
                            )
                            _live_debug_note_gemini_send_ok(state, "video")
                        except Exception as e:
                            _live_debug_note_gemini_send_err(state, e)
                        frames_sent += 1
                        if frames_sent == 3:
                            await live.send_realtime_input(
                                text="I've shown you the repair area. Please assess it and call verify_repair."
                            )
                except asyncio.TimeoutError:
                    break

        try:
            await asyncio.wait_for(_ingest_verify_frames(), timeout=30.0)
        except asyncio.TimeoutError:
            pass

        last_activity = time.monotonic()
        while True:
            async for response in live.receive():
                last_activity = time.monotonic()
                audio_bytes = _extract_audio(response)
                if audio_bytes:
                    audio_b64 = base64.b64encode(audio_bytes).decode()
                    await _send(websocket, {"type": "speech", "audio": audio_b64})

                fn_name, args, call_id = _parse_function_call(response)
                if fn_name == "verify_repair" and args:
                    await _ack_tool(live, fn_name, call_id)
                    result = {"pass": args.get("repair_passed", False), "message": args.get("message", "")}
                    await _send(websocket, {"type": "verify_result", **result})
                    if state.nyc_context:
                        await _send(websocket, {"type": "nyc_context", "text": state.nyc_context})
                    return

            # receive() iterator exhausted — check for stall
            if time.monotonic() - last_activity > LIVE_RECEIVE_TIMEOUT_S:
                logger.error("verification phase: no Gemini activity for %.0fs, aborting", LIVE_RECEIVE_TIMEOUT_S)
                await _send(websocket, {"type": "error", "code": "LIVE_STALLED", "message": "AI stopped responding during verification. Please try again."})
                return


async def _run_escalation_phase(
    client: genai.Client,
    websocket: WebSocket,
    state: session_store.SessionState,
    queue: asyncio.Queue,
) -> None:
    state.live_debug.bridge_label = "escalation"
    await _send(websocket, {"type": "status", "state": "escalate"})

    findings = json.dumps(state.severity_json.get("findings", []) if state.severity_json else [])
    system_prompt = PRO_ESCALATION_PROMPT.format(
        problem=state.problem or "hazardous issue",
        findings=findings,
    )

    live_config = _live_config(
        system_instruction=system_prompt,
        tools=[types.Tool(function_declarations=[ESCALATE])],
    )

    async with _live_session(client, live_config, state) as live:
        await live.send_realtime_input(
            text=f"Explain why this is unsafe for DIY and call escalate: {state.problem}"
        )

        escalated = False
        last_activity = time.monotonic()
        while not escalated:
            async for response in live.receive():
                last_activity = time.monotonic()
                audio_bytes = _extract_audio(response)
                if audio_bytes:
                    _live_debug_note_gemini_out_audio(state, len(audio_bytes))
                    audio_b64 = base64.b64encode(audio_bytes).decode()
                    await _send(websocket, {"type": "speech", "audio": audio_b64})

                fn_name, args, call_id = _parse_function_call(response)
                if fn_name:
                    _live_debug_note_tool(state)
                if fn_name == "escalate" and args:
                    await _ack_tool(live, fn_name, call_id)
                    await _send(websocket, {"type": "escalated", **args})
                    escalated = True
                    break

            if not escalated and time.monotonic() - last_activity > LIVE_RECEIVE_TIMEOUT_S:
                logger.error("escalation phase: no Gemini activity for %.0fs, aborting", LIVE_RECEIVE_TIMEOUT_S)
                await _send(websocket, {"type": "error", "code": "LIVE_STALLED", "message": "AI stopped responding during escalation. Please try again."})
                return

    async def _wait_escalate_interrupt() -> None:
        while True:
            try:
                msg = await asyncio.wait_for(queue.get(), timeout=5.0)
            except asyncio.TimeoutError:
                continue
            if msg.get("type") == "interrupt":
                state.active_phase = "guidance"
                state.diy_safe = True
                if not state.grounding_cache and state.problem:
                    await _send(websocket, {"type": "status", "state": "loading_guidance"})
                    state.grounding_cache = await fetch_repair_procedure(state.problem)
                return

    try:
        await asyncio.wait_for(_wait_escalate_interrupt(), timeout=60.0)
    except asyncio.TimeoutError:
        pass


async def _fetch_and_send_bbox(
    client: genai.Client,
    websocket: WebSocket,
    state: session_store.SessionState,
    component: str,
) -> None:
    if not component or not state.bbox_history:
        return
    async with _bbox_fetch_sem:
        try:
            response = await client.aio.models.generate_content(
                model=GEMINI_MODEL,
                contents=[
                    types.Part.from_bytes(data=base64.b64decode(state.bbox_history[-1]), mime_type="image/jpeg"),
                    types.Part(text=(
                        f"Locate '{component}' in this image. "
                        f'Return ONLY this JSON: {{"bbox": [x, y, width, height], "label": "{component}"}} '
                        f"where coordinates are 0-1 normalized. If not visible: {{\"bbox\": null}}"
                    )),
                ],
                config=types.GenerateContentConfig(temperature=0.0),
            )
            parsed = _try_parse_json(response.text or "")
            if parsed and parsed.get("bbox"):
                await _send(websocket, {"type": "annotation", "bbox": parsed["bbox"], "label": component, "color": "white"})
        except Exception:
            pass


async def _feed_frames(
    queue: asyncio.Queue,
    live_session,
    state: session_store.SessionState,
    fps: int,
) -> None:
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
            if len(pcm) < 2:
                continue
            try:
                await live_session.send_realtime_input(audio=types.Blob(data=pcm, mime_type=MIC_PCM_MIME))
                _live_debug_note_gemini_send_ok(state, "audio")
            except Exception as e:
                logger.debug("send_realtime_input audio failed: %s", e)
                _live_debug_note_gemini_send_err(state, e)

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
                try:
                    frame_bytes = base64.b64decode(msg["data"], validate=True)
                except (ValueError, binascii.Error):
                    continue
                if len(frame_bytes) < 100:
                    continue
                try:
                    # Vertex Live: JPEG frames go on the video stream (see Gen AI SDK + Live API input specs).
                    await live_session.send_realtime_input(
                        video=types.Blob(data=frame_bytes, mime_type="image/jpeg")
                    )
                    _live_debug_note_gemini_send_ok(state, "video")
                    state.bbox_history.append(msg["data"])
                    if len(state.bbox_history) > BBOX_HISTORY_MAX:
                        state.bbox_history.pop(0)
                except Exception as e:
                    logger.debug("send_realtime_input video frame failed: %s", e)
                    _live_debug_note_gemini_send_err(state, e)

        elif t == "location":
            if not state.nyc_context:
                queue.put_nowait(msg)


async def _process_location_from_queue(
    queue: asyncio.Queue,
    state: session_store.SessionState,
    websocket: WebSocket,
) -> None:
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
            await queue.put(msg)
    except asyncio.QueueEmpty:
        pass


def _try_parse_json(text: str) -> dict | None:
    text = text.strip()
    start = text.find("{")
    end = text.rfind("}") + 1
    if start == -1 or end == 0:
        return None
    try:
        return json.loads(text[start:end])
    except json.JSONDecodeError:
        return None


async def _send(websocket: WebSocket, data: dict) -> bool:
    try:
        await websocket.send_json(data)
        return True
    except Exception as e:
        logger.warning("ws send failed (%s): %s", data.get("type", "?"), e)
        return False
