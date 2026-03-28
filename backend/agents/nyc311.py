"""NYC311Agent — queries NYC Open Data for neighborhood repair complaint context."""

import asyncio
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

# Rolling window for Open Data queries (avoids stale hard-coded dates)
def _cutoff_iso_utc(days: int = 30) -> str:
    dt = datetime.now(timezone.utc) - timedelta(days=days)
    return dt.strftime("%Y-%m-%dT%H:%M:%S")

# sodapy for Socrata API
try:
    from sodapy import Socrata
    SODAPY_AVAILABLE = True
except ImportError:
    SODAPY_AVAILABLE = False

# 311 Service Requests dataset ID on NYC Open Data
NYC_311_DATASET = "erm2-nwe9"
NYC_OPEN_DATA_DOMAIN = "data.cityofnewyork.us"

# Complaint types related to home repair
REPAIR_COMPLAINT_TYPES = [
    "PLUMBING",
    "WATER SUPPLY",
    "WATER LEAK",
    "HEATING",
    "ELECTRIC",
    "UNSANITARY CONDITION",
    "MOLD",
]


async def fetch_311_context(zip_code: str) -> Optional[str]:
    """
    Async best-effort: query NYC 311 data for repair complaints near this zip.
    Returns a one-line context string or None if unavailable.
    Times out after 2 seconds — session continues either way.
    """
    if not SODAPY_AVAILABLE:
        return None

    try:
        result = await asyncio.wait_for(
            asyncio.to_thread(_fetch_sync, zip_code),
            timeout=2.0,
        )
        return result
    except (asyncio.TimeoutError, Exception):
        return None


def _fetch_sync(zip_code: str) -> Optional[str]:
    """Synchronous Socrata query — runs in executor thread."""
    zip_code = _normalize_zip(zip_code)
    app_token = os.getenv("NYC_APP_TOKEN")  # optional, increases rate limits

    try:
        client = Socrata(NYC_OPEN_DATA_DOMAIN, app_token)

        types_in = "(" + ",".join(f"'{t}'" for t in REPAIR_COMPLAINT_TYPES) + ")"
        where_clause = (
            f"incident_zip='{zip_code}' "
            f"AND created_date > '{_cutoff_iso_utc(30)}' "
            f"AND complaint_type in {types_in}"
        )

        results = client.get(
            NYC_311_DATASET,
            where=where_clause,
            select="complaint_type, COUNT(*) as count",
            group="complaint_type",
            order="count DESC",
            limit=5,
        )

        if not results:
            return None

        total = sum(int(r.get("count", 0)) for r in results)
        top_type = results[0].get("complaint_type", "repair") if results else "repair"

        return (
            f"NYC 311 data for zip {zip_code}: {total} repair complaints in the last 30 days. "
            f"Most common: {top_type}."
        )

    except Exception:
        return None


def _normalize_zip(zip_code: str) -> str:
    z = (zip_code or "").strip()
    if z.isdigit() and len(z) == 5:
        return z
    return "10001"


def _fetch_insights_sync(zip_code: str) -> dict[str, Any]:
    """Structured 311 stats for marketing / landing UI."""
    zip_code = _normalize_zip(zip_code)
    empty: dict[str, Any] = {
        "ok": False,
        "zip": zip_code,
        "requests_30d": 0,
        "total": 0,
        "items": [],
        "period_days": 30,
        "error": "unavailable",
    }
    if not SODAPY_AVAILABLE:
        empty["error"] = "sodapy_not_installed"
        return empty

    app_token = os.getenv("NYC_APP_TOKEN")
    try:
        client = Socrata(NYC_OPEN_DATA_DOMAIN, app_token)
        # Broad ZIP + date slice (exact 311 complaint_type strings vary widely)
        where_clause = (
            f"incident_zip='{zip_code}' "
            f"AND created_date > '{_cutoff_iso_utc(30)}'"
        )
        total_row = client.get(
            NYC_311_DATASET,
            where=where_clause,
            select="count(*) as total",
        )
        requests_30d = int(total_row[0].get("total", 0)) if total_row else 0

        results = client.get(
            NYC_311_DATASET,
            where=where_clause,
            select="complaint_type, COUNT(*) as count",
            group="complaint_type",
            order="count DESC",
            limit=8,
        )
        if not results:
            return {
                "ok": True,
                "zip": zip_code,
                "requests_30d": requests_30d,
                "total": 0,
                "items": [],
                "period_days": 30,
                "error": None,
            }
        items = [
            {"complaint_type": r.get("complaint_type", "Unknown"), "count": int(r.get("count", 0))}
            for r in results
        ]
        top_sum = sum(i["count"] for i in items)
        return {
            "ok": True,
            "zip": zip_code,
            "requests_30d": requests_30d,
            "total": top_sum,
            "items": items,
            "period_days": 30,
            "error": None,
        }
    except Exception:
        empty["error"] = "query_failed"
        return empty


async def fetch_landing_insights(zip_code: str) -> dict[str, Any]:
    """Public landing page: best-effort NYC 311 home-repair-related complaints by zip."""
    zip_code = _normalize_zip(zip_code)
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(_fetch_insights_sync, zip_code),
            timeout=5.0,
        )
    except (asyncio.TimeoutError, Exception):
        return {
            "ok": False,
            "zip": zip_code,
            "requests_30d": 0,
            "total": 0,
            "items": [],
            "period_days": 30,
            "error": "timeout",
        }
