"""HomeFix AI — FastAPI backend."""

import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import ws_handler
from agents.nyc311 import fetch_landing_insights

load_dotenv()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Matches ws_handler / agents: Gemini via Vertex AI
    project = os.getenv("GOOGLE_CLOUD_PROJECT", "").strip()
    if not project or project == "your-gcp-project-id":
        raise RuntimeError(
            "GOOGLE_CLOUD_PROJECT is not set (or is still the placeholder). "
            "Set it in backend/.env — see .env.example."
        )
    yield


app = FastAPI(title="HomeFix AI", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "homefix-ai"}


@app.get("/api/nyc-insights")
async def nyc_insights(zip: str = "10001"):
    """311 Open Data: home-repair-related complaints in the last 30 days for a ZIP (landing page)."""
    return await fetch_landing_insights(zip)


frontend_dist = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
_icon_path = os.path.join(frontend_dist, "icon.svg")


@app.get("/icon.svg")
async def icon_svg():
    """Served explicitly so favicon works even if static mount order differs."""
    if not os.path.isfile(_icon_path):
        raise HTTPException(
            status_code=404,
            detail="Missing frontend/dist/icon.svg — run: cd frontend && npm run build",
        )
    return FileResponse(_icon_path, media_type="image/svg+xml")


@app.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    await ws_handler.handle(websocket, session_id)


# Serve React frontend in production (built files in ../frontend/dist)
if os.path.isdir(frontend_dist):
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="static")
