"""Grounding — fetches repair procedure via Gemini + Google Search tool (ADK)."""

import os
from typing import Optional

from google import genai
from google.genai import types


async def fetch_repair_procedure(issue: str) -> Optional[str]:
    """
    Uses Gemini 2.0 Flash with Google Search grounding to fetch real repair steps.
    Called once per repair type at the start of the guidance phase.
    Cached in SessionState.grounding_cache for the session duration.
    """
    api_key = os.getenv("GOOGLE_API_KEY", "").strip()
    client = genai.Client(api_key=api_key) if api_key else genai.Client(
        vertexai=True,
        project=os.getenv("GOOGLE_CLOUD_PROJECT"),
        location=os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1"),
    )

    query = f"How to fix {issue} at home — step by step repair guide"

    try:
        response = await client.aio.models.generate_content(
            model="gemini-2.0-flash-001",
            contents=query,
            config=types.GenerateContentConfig(
                tools=[types.Tool(google_search=types.GoogleSearch())],
                temperature=0.2,
                system_instruction=(
                    "You are a home repair expert. Given a repair problem, "
                    "provide a concise 3-5 step repair procedure. "
                    "Format: numbered steps, each under 30 words. "
                    "Include required tools at the start. Be practical and safe."
                ),
            ),
        )
        return response.text
    except Exception:
        # Fallback: return generic guidance request (model will use its training)
        return None
