# HomeFix AI

**Authors**

- William Ran — wr2176@nyu.edu  
- Selina Liu — liuyiyang903@gmail.com  

> Point. Speak. Fix.

A mobile-first AI home repair assistant: marketing landing with local **311** context, then a **live** camera session where Gemini **sees** the feed, **speaks** natively, listens to your **mic**, draws **bbox** overlays, and **verifies** the fix — implemented in **FastAPI** + **google-genai** (optional **Vertex AI** or **API key**), not a separate “ADK” service.

## Architecture

```
Mobile browser (React + Vite PWA)
  │  WebSocket /ws/{session_id}
  │  REST GET /api/nyc-insights?zip=…  (landing only; ~30-day 311 snapshot)
  ▼
FastAPI (backend/)
  │
  └── ws_handler.py — phased Gemini Live sessions:
        identify (vision + tools) → guidance (steps + tools) → verify / escalate
        • JPEG frames + 16 kHz mono PCM16 uplink; native audio downlink (+ tools)
        • optional Live debug: debug_live ~1 Hz during session
  agents/
  ├── prompts.py       — system prompts per phase
  ├── grounding.py     — repair procedure via gemini-2.0-flash-001 + Google Search
  └── nyc311.py        — Socrata 311 (landing + in-session chip/context)
```

**Auth / AI:** `ws_handler._make_client()` uses **`GOOGLE_API_KEY`** if set; otherwise **`GOOGLE_CLOUD_PROJECT`** + **`GOOGLE_CLOUD_LOCATION`** with Vertex (`vertexai=True`). Production is usually Vertex on Cloud Run.

## Quick start

### 1. Backend

Run from **`backend/`** so imports resolve.

```bash
cd backend
cp .env.example .env
# Set GOOGLE_CLOUD_PROJECT (e.g. homefix-ai-491603 for Cloud Run / Vertex).

pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8080
```

- Health: `GET http://localhost:8080/health`
- NYC landing data: `GET http://localhost:8080/api/nyc-insights?zip=10001`

### 2. Frontend (development)

Vite proxies **`/ws`** and **`/api`** to port **8080**, so the app stays on **5173**.

```bash
cd frontend
npm install
npm run dev
```

Open on a **phone** at `http://<your-lan-ip>:5173` — camera + mic behave best on a real device.

### 3. Production-style (single origin)

`main.py` serves the built SPA from **`backend/frontend/dist`**. After each frontend build, copy the output there (Docker / Cloud Run builds from `backend/` with the same layout):

```bash
cd frontend && npm run build
mkdir -p ../backend/frontend
rm -rf ../backend/frontend/dist
cp -r dist ../backend/frontend/dist
cd ../backend
uvicorn main:app --host 0.0.0.0 --port 8080
```

Open `http://localhost:8080` — static UI, `/ws`, and `/health` share one origin.

### Tests

From the **repository root**:

```bash
python -m pytest tests/ -v
```

Optional Live bbox smoke test:

```bash
python backend/test_bbox_extraction.py
```

## User flow

1. **Landing** — story + CTA; **`/api/nyc-insights`** for default ZIP (311 volume + complaint types). No WebSocket until you leave landing.
2. **Start** — live preview; **Begin session** unlocks **AudioContext** (Safari-friendly) and emits **`{"type":"ready"}`** on the socket.
3. **Identify** — camera **~1 fps** + mic; model greets and identifies the problem (tool call). Optional **NYC** chip from 311. Backend may **pre-open** the Live socket while waiting for `ready` to cut perceived latency.
4. **Loading guidance** / **Guide** — **~2 fps**, spoken steps, **annotation** `bbox`, **tools_list** card.
5. **Verify** — sparse frames + mic; **verify_result**.
6. **Escalate** / **Pro** — DIY-not-safe path; optional **interrupt** to continue anyway.

Phases that stream **mic** audio: `identifying`, `loading_guidance`, `guiding`, `verifying`. If the mic is denied, you may get **video-only** upstream.

During inspect / guide / verify / escalate, a **Live debug** panel can show counters (`saw_client_ready`, frames, Gemini sends, etc.) from **`debug_live`** messages.

## Realtime protocol (summary)

| Direction | Payload |
|-----------|---------|
| Client → server | `{ type: "ready" }` — after **Begin session** (required for bridge; resync after reconnect when past Start) |
| Client → server | `{ type: "location", lat, lng, zip }` — optional geohint for 311 context |
| Client → server | `{ type: "frame", data: base64 JPEG, ts }` |
| Client → server | `{ type: "audio", data: base64 }` — **16 kHz mono PCM16** |
| Client → server | `{ type: "interrupt", text }` — free-text user message to the model |
| Server → client | `status` — phase state (`identifying`, `guiding`, …) |
| Server → client | `speech` — assistant audio (native PCM chunks; client schedules gapless playback) |
| Server → client | `annotation`, `step`, `severity`, `tools_list`, `verify_result`, `escalated`, `nyc_chip`, `nyc_context`, `error` |
| Server → client | `debug_live` — ~1 Hz telemetry for on-device debugging |

Downlink speech is **raw-ish PCM** from the Live API (handled in the client, typically **24 kHz** mono for native audio paths).

## Connection UX

If the WebSocket drops, the UI shows **recovering** then **failed** after retries. The socket opens when **session is active** (after leaving landing). Pending messages (including **`ready`**) are **kept across reconnect attempts**; after a successful reconnect, if you are already past Start, the client **sends `ready` again** because the server creates a new in-memory session per connection.

## PWA / caching

**vite-plugin-pwa** registers a service worker. If the UI looks stale after deploy, use **`?fresh=1`** or clear site data. **`/api`** and **`/ws`** are not offline shell routes.

## Deploy (Google Cloud Run)

Build the SPA into **`backend/frontend/dist`**, then deploy from **`backend/`** (Dockerfile copies the tree):

```bash
cd frontend && npm run build
mkdir -p ../backend/frontend && rm -rf ../backend/frontend/dist && cp -r dist ../backend/frontend/dist
cd ..
gcloud run deploy homefix-ai \
  --source backend \
  --region us-central1 \
  --allow-unauthenticated \
  --min-instances 1 \
  --set-env-vars GOOGLE_CLOUD_PROJECT=homefix-ai-491603 \
  --port 8080
```

Add **`GOOGLE_CLOUD_LOCATION`**, **`NYC_APP_TOKEN`**, or **`GOOGLE_API_KEY`** on the service as needed.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLOUD_PROJECT` | ✅ (Vertex) | GCP project for Vertex; **must** be set at startup — placeholder/default `your-gcp-project-id` fails fast in `main.py` |
| `GOOGLE_CLOUD_LOCATION` | optional | Vertex region (default **us-central1**) |
| `GOOGLE_API_KEY` | optional | If set, **google-genai** uses the API key client instead of Vertex (useful for local/dev with AI Studio) |
| `NYC_APP_TOKEN` | optional | [Socrata app token](https://dev.socrata.co.jp/docs/app-tokens/) for NYC Open Data rate limits |

## Models (Gemini)

| Use | Model (see `backend/ws_handler.py` / `agents/`) |
|-----|--------------------------------------------------|
| Live streaming (vision, voice, tools) | **`gemini-3.1-flash-live-preview`** |
| Bbox JSON from still frame, non-Live helpers | **`gemini-2.0-flash-001`** |
| Grounding / repair procedure | **`gemini-2.0-flash-001`** + Google Search tool |

Live **`response_modalities`** in code: **`["AUDIO"]`** (native audio out; tools still used for phase transitions).

---

**Layout:** `backend/` (FastAPI, `ws_handler.py`, agents, optional `frontend/dist`), `frontend/` (React + Vite source), `tests/` (pytest).
