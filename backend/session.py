from dataclasses import dataclass, field
from typing import Optional


@dataclass
class LiveDebugStats:
    """Mutable counters for on-screen Live API diagnostics (single asyncio thread)."""

    bridge_label: str = "waiting_ready"
    live_socket_open: bool = False
    saw_ready: bool = False
    client_frames_in: int = 0
    client_audio_chunks_in: int = 0
    last_client_frame_ts: float = 0.0
    last_client_audio_ts: float = 0.0
    gemini_video_sends: int = 0
    gemini_audio_sends: int = 0
    last_gemini_video_send_ts: float = 0.0
    last_gemini_audio_send_ts: float = 0.0
    gemini_send_errors: int = 0
    last_gemini_send_error: str = ""
    gemini_audio_out_chunks: int = 0
    gemini_audio_out_bytes: int = 0
    gemini_tool_events: int = 0
    last_gemini_audio_out_ts: float = 0.0
    last_gemini_tool_ts: float = 0.0


@dataclass
class SessionState:
    session_id: str
    active_phase: str = "vision"  # "vision" | "guidance" | "verification" | "escalate"
    live_debug: LiveDebugStats = field(default_factory=LiveDebugStats)
    problem: Optional[str] = None
    severity_json: Optional[dict] = None
    nyc_context: Optional[str] = None
    steps_completed: int = 0
    current_step: int = 0
    total_steps: int = 0
    repair_attempted: bool = False
    bbox_history: list = field(default_factory=list)
    diy_safe: Optional[bool] = None
    grounding_cache: Optional[str] = None  # cached repair procedure from Google Search


# In-memory store keyed by session_id
_sessions: dict[str, SessionState] = {}


def get_or_create(session_id: str) -> SessionState:
    if session_id not in _sessions:
        _sessions[session_id] = SessionState(session_id=session_id)
    return _sessions[session_id]


def delete(session_id: str) -> None:
    _sessions.pop(session_id, None)
