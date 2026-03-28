from dataclasses import dataclass, field
from typing import Optional


@dataclass
class SessionState:
    session_id: str
    active_phase: str = "vision"  # "vision" | "guidance" | "verification" | "escalate"
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
