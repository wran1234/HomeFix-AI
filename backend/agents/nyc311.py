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


def _int_socrata_cell(row: dict[str, Any], key: str) -> int:
    """Counts from Socrata JSON are often strings."""
    v = row.get(key, 0)
    if v is None or v == "":
        return 0
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def _socrata_json_get(params: dict[str, str]) -> list[dict[str, Any]]:
    """
    Plain HTTPS Socrata GET — anonymous access works; POST is rejected (403) without auth.
    Keep $where short: long URLs hit 414/proxy limits on some hosts (e.g. Cloud Run).
    """
    import httpx

    url = f"https://{NYC_OPEN_DATA_DOMAIN}/resource/{NYC_311_DATASET}.json"
    app_token = os.getenv("NYC_APP_TOKEN")
    q: dict[str, str] = {k: v for k, v in params.items() if v is not None}
    if app_token:
        q["$$app_token"] = app_token
    headers = {"Accept": "application/json", "User-Agent": "HomeFix/1.0 (nyc-insights)"}
    with httpx.Client(timeout=25.0) as client:
        r = client.get(url, params=q, headers=headers)
        r.raise_for_status()
        data = r.json()
        return data if isinstance(data, list) else []


# Substrings (lowercase) for classifying complaint_type — used when SoQL OR is too long.
_HOUSING_KEYWORDS = frozenset(
    "heat hot water plumb water leak electric mold unsanitary pest rodent paint plaster "
    "construction window door ceiling wall boiler elevator safety structural appliance "
    "scaffold gasket loft gas steam radiator unsanitary lead".split()
)


def _complaint_looks_housing(complaint_type: str) -> bool:
    n = (complaint_type or "").lower()
    return any(k in n for k in _HOUSING_KEYWORDS)


def _housing_sum_and_top_items(
    grouped_rows: list[dict[str, Any]], item_limit: int = 8
) -> tuple[int, list[dict[str, Any]]]:
    """Filter grouped Socrata rows to housing-like types; sum counts (within this slice)."""
    housing = [r for r in grouped_rows if _complaint_looks_housing(str(r.get("complaint_type", "")))]
    housing.sort(key=lambda r: _int_socrata_cell(r, "count"), reverse=True)
    total_in_slice = sum(_int_socrata_cell(r, "count") for r in housing)
    return total_in_slice, housing[:item_limit]


def _query_insights_http(where_clause: str) -> tuple[int, list[dict[str, Any]]]:
    total_rows = _socrata_json_get(
        {"$select": "count(*) as total", "$where": where_clause},
    )
    requests_30d = _int_socrata_cell(total_rows[0], "total") if total_rows else 0
    results = _socrata_json_get(
        {
            "$select": "complaint_type, count(*) as count",
            "$where": where_clause,
            "$group": "complaint_type",
            "$order": "count DESC",
            "$limit": "8",
        },
    )
    return requests_30d, results


def _query_insights_http_fallback_zip(zip_code: str) -> tuple[int, list[dict[str, Any]]]:
    """
    Short SoQL (ZIP + date only): top complaint buckets, then classify housing in-process.
    Avoids very long GET URLs that fail in production.
    """
    zip_code = _normalize_zip(zip_code)
    base = f"incident_zip='{zip_code}' AND created_date > '{_cutoff_iso_utc(30)}'"
    results = _socrata_json_get(
        {
            "$select": "complaint_type, count(*) as count",
            "$where": base,
            "$group": "complaint_type",
            "$order": "count DESC",
            "$limit": "50",
        },
    )
    return _housing_sum_and_top_items(results, 8)


def _housing_complaint_where_fragment() -> str:
    """
    Compact SoQL OR for housing-ish complaint_type (keep URL short for GET).
    If this still fails, _query_insights_http_fallback_zip is used.
    """
    needles = (
        "Heat",
        "Plumb",
        "Water",
        "Leak",
        "Electric",
        "Mold",
        "Construction",
        "Rodent",
        "Paint",
        "Unsanitary",
        "Pest",
        "Elevator",
        "Boiler",
    )
    parts = [f"complaint_type like '%{n}%'" for n in needles]
    return "(" + " OR ".join(parts) + ")"


def _fetch_insights_sync(zip_code: str) -> dict[str, Any]:
    """Structured 311 stats for marketing / landing UI (housing-related complaints)."""
    zip_code = _normalize_zip(zip_code)
    empty: dict[str, Any] = {
        "ok": False,
        "zip": zip_code,
        "requests_30d": 0,
        "total": 0,
        "items": [],
        "period_days": 30,
        "error": "unavailable",
        "housing_focus": True,
    }

    def _build_response(
        requests_30d: int,
        results: list[dict[str, Any]],
        housing_focus: bool,
    ) -> dict[str, Any]:
        if not results:
            return {
                "ok": True,
                "zip": zip_code,
                "requests_30d": requests_30d,
                "total": 0,
                "items": [],
                "period_days": 30,
                "error": None,
                "housing_focus": housing_focus,
            }
        items: list[dict[str, Any]] = []
        for r in results:
            c = _int_socrata_cell(r, "count")
            items.append({"complaint_type": r.get("complaint_type", "Unknown"), "count": c})
        top_sum = sum(i["count"] for i in items)
        return {
            "ok": True,
            "zip": zip_code,
            "requests_30d": requests_30d,
            "total": top_sum,
            "items": items,
            "period_days": 30,
            "error": None,
            "housing_focus": housing_focus,
        }

    try:
        base = f"incident_zip='{zip_code}' AND created_date > '{_cutoff_iso_utc(30)}'"
        housing_where = f"{base} AND {_housing_complaint_where_fragment()}"
        housing_focus = True
        try:
            requests_30d, results = _query_insights_http(housing_where)
        except Exception:
            requests_30d, results = _query_insights_http_fallback_zip(zip_code)
        return _build_response(requests_30d, results, housing_focus)
    except Exception:
        # Last resort: sodapy (older envs / unusual httpx failures)
        if not SODAPY_AVAILABLE:
            empty["error"] = "query_failed"
            return empty
        try:
            app_token = os.getenv("NYC_APP_TOKEN")
            client = Socrata(NYC_OPEN_DATA_DOMAIN, app_token)

            def _query_soda(where_clause: str) -> tuple[int, list[dict[str, Any]]]:
                total_row = client.get(
                    NYC_311_DATASET,
                    where=where_clause,
                    select="count(*) as total",
                )
                req = _int_socrata_cell(total_row[0], "total") if total_row else 0
                res = client.get(
                    NYC_311_DATASET,
                    where=where_clause,
                    select="complaint_type, COUNT(*) as count",
                    group="complaint_type",
                    order="count DESC",
                    limit=8,
                ) or []
                return req, res

            base = f"incident_zip='{zip_code}' AND created_date > '{_cutoff_iso_utc(30)}'"
            housing_where = f"{base} AND {_housing_complaint_where_fragment()}"
            housing_focus = True

            def _soda_fallback_zip() -> tuple[int, list[dict[str, Any]]]:
                res = (
                    client.get(
                        NYC_311_DATASET,
                        where=base,
                        select="complaint_type, COUNT(*) as count",
                        group="complaint_type",
                        order="count DESC",
                        limit=50,
                    )
                    or []
                )
                return _housing_sum_and_top_items(res, 8)

            try:
                requests_30d, results = _query_soda(housing_where)
            except Exception:
                requests_30d, results = _soda_fallback_zip()
            return _build_response(requests_30d, results, housing_focus)
        except Exception:
            empty["error"] = "query_failed"
            return empty


async def fetch_landing_insights(zip_code: str) -> dict[str, Any]:
    """Public landing page: best-effort NYC 311 home-repair-related complaints by zip."""
    zip_code = _normalize_zip(zip_code)
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(_fetch_insights_sync, zip_code),
            timeout=18.0,
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
            "housing_focus": True,
        }
