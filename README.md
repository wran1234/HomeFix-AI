# HomeFix AI
Author: 
William Ran - wr2176@nyu.edu
Selina Liu - liuyiyang903@gmail.com



> Point. Speak. Fix.

A mobile-first AI home repair assistant: marketing landing with local 311 context, then a live camera session where Gemini **sees**, **speaks**, listens to your **mic**, draws **bbox** overlays, and **verifies** the fix — powered by **Gemini 2.0 Flash Live** (Vertex AI) + Google ADK agents.

## Architecture

```
Mobile browser (React + Vite PWA)
  │  WebSocket /ws/{session_id}  (frames, audio chunks, interrupts)
  │  REST /api/nyc-insights?zip=…  (landing only; 30-day 311 snapshot)
  ▼
FastAPI (backend/)
  │
  ├── VisionAgent        — 1 fps frames → problem + severity
  ├── GuidanceAgent      — 2 fps + Live audio in/out + bbox JSON
  ├── VerificationAgent — sparse frames → pass/fail
  └── NYC311Agent       — Socrata → chip during session; insights for landing
```

**Auth / AI:** Gemini is called through **Vertex AI**. The app does **not** use `GOOGLE_API_KEY` for the Live path — set **`GOOGLE_CLOUD_PROJECT`** (see Environment).

## Quick start

### 1. Backend

Run commands from the **`backend/`** directory (so `main` resolves).

```bash
cd backend
cp .env.example .env
# Set GOOGLE_CLOUD_PROJECT to your real GCP project ID (not the placeholder).

pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8080
```

- Health: `GET http://localhost:8080/health`
- NYC landing data: `GET http://localhost:8080/api/nyc-insights?zip=10001`

### 2. Frontend (development)

Vite proxies **`/ws`** → `ws://localhost:8080` and **`/api`** → `http://localhost:8080`, so the React app can stay on port **5173**.

```bash
cd frontend
npm install
npm run dev
```

Open on your **phone** at `http://<your-lan-ip>:5173` — camera + mic work best on real devices.

### 3. Production-style (single server)

Build the SPA, then serve it from FastAPI:

```bash
cd frontend && npm run build && cd ../backend
uvicorn main:app --host 0.0.0.0 --port 8080
```

Open `http://localhost:8080`. Static files come from `frontend/dist/`; `/ws` and `/health` stay on the same origin.

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

1. **Landing** — HomeFix story, CTA; fetches **`/api/nyc-insights`** for a default ZIP (repair-related 311 volume + top complaint types, rolling **30 days**). **No WebSocket** yet — camera/mic are idle.
2. **Start** — “Start session” unlocks audio (Safari-friendly) and begins the session.
3. **Identify** — camera at **1 fps**; you can **speak**; agent responds with **speech** and optional NYC chip from 311.
4. **Guide** — **2 fps** video + **voice** step-by-step + **annotation** overlay (`bbox` JSON).
5. **Verify** — agent checks the repair; pass/fail.
6. **Escalate** — if not DIY-safe, **Pro** screen with maps handoff; optional “handle myself” override sends an **interrupt** over the socket.

Phases that send **microphone** audio to the model: `identifying`, `loading_guidance`, `guiding`, `verifying`. If the browser denies the mic, capture may fall back to **video-only** (check permission settings).

## Realtime protocol (summary)

| Direction | Payload |
|-----------|---------|
| Client → server | `{ type: "frame", data: base64 JPEG, ts }` |
| Client → server | `{ type: "audio", data: base64 }` — **16 kHz mono PCM16** chunks |
| Client → server | `{ type: "interrupt", text }` — human text (“ask anyway”, step clarifications) |
| Server → client | `status`, `speech` (audio), `annotation`, `step`, `severity`, `verify_result`, `nyc_*`, `error` |

## Connection UX

If the WebSocket drops, the UI shows a **recovering** banner after a short delay while retries run; if reconnection fails, a **failed** banner asks you to reload. The socket is only opened **after** you leave the landing page (session active).

## PWA / caching

The app registers a service worker (`vite-plugin-pwa`). If you see a **blank or stale UI** after deploy, try **`?fresh=1`** on the URL or clear site data. Workbox is configured so **`/api`** and **`/ws`** are not treated as offline shell routes.

## Deploy to Google Cloud Run

```bash
cd frontend && npm run build && cd ..
gcloud run deploy homefix-ai \
  --source backend \
  --region us-central1 \
  --allow-unauthenticated \
  --min-instances 1 \
  --set-env-vars GOOGLE_CLOUD_PROJECT=your-project-id \
  --port 8080
```

Add `GOOGLE_CLOUD_LOCATION`, `NYC_APP_TOKEN` in the Cloud Run service if needed.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLOUD_PROJECT` | ✅ | GCP project ID for Vertex AI (must be set at startup; placeholder values fail fast) |
| `GOOGLE_CLOUD_LOCATION` | optional | Region (default: `us-central1`) |
| `NYC_APP_TOKEN` | optional | [Socrata app token](https://dev.socrata.co.jp/docs/app-tokens/) — higher rate limits for NYC Open Data |

## Models (Gemini)

| Area | Model |
|------|--------|
| Live streaming (vision / guidance / verification loop) | `gemini-2.0-flash-live-001` |
| Bbox fallback / grounding | `gemini-2.0-flash` + Google Search where configured |

---

**Repository layout:** `backend/` (FastAPI, agents, `ws_handler.py`), `frontend/` (React + Vite), `tests/` (pytest against backend modules).
