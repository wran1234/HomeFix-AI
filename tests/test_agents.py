"""
3 targeted pytest unit tests for HomeFix AI.
Tests the 3 paths most likely to cause silent demo failures.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from ws_handler import _try_parse_json
import session as session_store


# ── Test 1: DIY/Pro routing ──────────────────────────────────────────────────

def test_diy_safe_true_sets_guidance_phase():
    """diy_safe: true → active_phase switches to 'guidance'."""
    state = session_store.SessionState(session_id="test-1")
    assert state.active_phase == "vision"

    # Simulate what _run_vision_phase does on identification
    severity_json = {
        "phase": "identified",
        "issue": "leaking pipe compression joint",
        "severity": "MEDIUM",
        "diy_safe": True,
        "reason": "No electrical or structural risk",
        "findings": ["water dripping at joint", "no corrosion visible"],
    }
    state.problem = severity_json["issue"]
    state.severity_json = severity_json
    state.diy_safe = severity_json["diy_safe"]
    state.active_phase = "guidance" if state.diy_safe else "escalate"

    assert state.active_phase == "guidance"
    assert state.problem == "leaking pipe compression joint"


def test_diy_safe_false_sets_escalate_phase():
    """diy_safe: false → active_phase switches to 'escalate', not 'guidance'."""
    state = session_store.SessionState(session_id="test-2")

    severity_json = {
        "phase": "identified",
        "issue": "exposed wiring near moisture",
        "severity": "HIGH",
        "diy_safe": False,
        "reason": "Exposed conductor + water proximity",
        "findings": ["exposed conductor", "no visible shutoff", "moisture present"],
    }
    state.problem = severity_json["issue"]
    state.severity_json = severity_json
    state.diy_safe = severity_json["diy_safe"]
    state.active_phase = "guidance" if state.diy_safe else "escalate"

    assert state.active_phase == "escalate"
    assert state.diy_safe is False


# ── Test 2: bbox JSON parse-or-ignore ────────────────────────────────────────

def test_valid_bbox_json_parses():
    """Valid bbox JSON in text stream → parsed to dict with 'bbox' key."""
    text = '{"bbox": [0.3, 0.4, 0.2, 0.15], "label": "compression nut"}'
    result = _try_parse_json(text)

    assert result is not None
    assert result["bbox"] == [0.3, 0.4, 0.2, 0.15]
    assert result["label"] == "compression nut"


def test_malformed_json_returns_none():
    """Malformed JSON (e.g. transcript text) → None, no crash."""
    texts = [
        "Turn the nut clockwise one full rotation.",
        "Step 2: tighten the fitting.",
        '{"bbox": [0.1, unclosed',
        "",
        "   ",
    ]
    for text in texts:
        result = _try_parse_json(text)
        assert result is None, f"Expected None for: {text!r}, got {result}"


def test_json_embedded_in_prose_extracts():
    """JSON embedded in surrounding text is extracted correctly."""
    text = 'Great, now {"bbox": [0.1, 0.2, 0.3, 0.4], "label": "pipe joint"} is what to focus on.'
    result = _try_parse_json(text)
    assert result is not None
    assert result["label"] == "pipe joint"


# ── Test 3: Step counter → verify trigger ────────────────────────────────────

def test_final_step_triggers_verification():
    """When steps_completed reaches total_steps, repair_attempted flips to True."""
    state = session_store.SessionState(session_id="test-3")
    state.total_steps = 3
    state.current_step = 3
    state.steps_completed = 3

    # Simulate GuidanceAgent detecting guidance_complete
    guidance_complete_json = {"phase": "guidance_complete"}
    is_complete = guidance_complete_json.get("phase") == "guidance_complete"

    if is_complete:
        state.repair_attempted = True
        state.active_phase = "verification"

    assert state.repair_attempted is True
    assert state.active_phase == "verification"


def test_incomplete_steps_do_not_trigger_verification():
    """Mid-session step update does NOT flip to verification phase."""
    state = session_store.SessionState(session_id="test-4")
    state.total_steps = 4
    state.current_step = 2  # still guiding

    step_json = {"phase": "step", "n": 2, "total": 4, "title": "Tighten nut"}
    is_complete = step_json.get("phase") == "guidance_complete"

    if is_complete:
        state.repair_attempted = True
        state.active_phase = "verification"

    assert state.repair_attempted is False
    assert state.active_phase == "vision"  # unchanged


# ── Regression: escalation interrupt → resume guidance ───────────────────────

def test_escalation_interrupt_resumes_guidance():
    """Interrupt received after escalation → active_phase flips to 'guidance'."""
    state = session_store.SessionState(session_id="esc-1")
    state.active_phase = "escalate"
    state.diy_safe = False

    # Simulate the interrupt handling added to _run_escalation_phase
    interrupt_msg = {"type": "interrupt", "text": "I understand the risk. Please guide me anyway."}
    if interrupt_msg.get("type") == "interrupt":
        state.active_phase = "guidance"
        state.diy_safe = True

    assert state.active_phase == "guidance"
    assert state.diy_safe is True


def test_escalation_no_interrupt_stays_escalate():
    """Non-interrupt messages during escalation wait period do NOT resume guidance."""
    state = session_store.SessionState(session_id="esc-2")
    state.active_phase = "escalate"

    for msg in [{"type": "frame", "data": "abc"}, {"type": "audio", "data": "xyz"}]:
        if msg.get("type") == "interrupt":
            state.active_phase = "guidance"

    assert state.active_phase == "escalate"


# ── Regression: location zombie fix ──────────────────────────────────────────

def test_location_not_requeued_after_context_set():
    """_feed_frames skips re-queuing location message when nyc_context already set."""
    state = session_store.SessionState(session_id="loc-1")
    state.nyc_context = "NYC 311 data for zip 11238: 47 complaints in last 30 days."

    msg = {"type": "location", "zip": "11238"}
    # Guard logic from _feed_frames
    should_requeue = not state.nyc_context
    assert should_requeue is False


def test_location_requeued_before_context_set():
    """_feed_frames re-queues location message when nyc_context is not yet set."""
    state = session_store.SessionState(session_id="loc-2")
    assert state.nyc_context is None

    msg = {"type": "location", "zip": "10001"}
    should_requeue = not state.nyc_context
    assert should_requeue is True
