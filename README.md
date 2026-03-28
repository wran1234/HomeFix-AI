# HomeFix AI

> Point. Speak. Fix.

A mobile-first AI home repair assistant that watches your camera, speaks live instructions, annotates the problem area, and verifies the fix — powered by Gemini 2.0 Flash Live API + Google ADK.

## Architecture

```
Mobile Browser (PWA)
  │  WebSocket (bidirectional)
  ▼
FastAPI Backend (Google Cloud Run)
  │
  ├── VisionAgent  — 1fps frames → problem identification + severity
  ├── GuidanceAgent — 2fps frames + Gemini Live audio + bbox JSON annotations
  ├── VerificationAgent — 3 frames → pass/fail confirmation
  └── NYC311Agent  — async Socrata API → neighborhood repair context
```

## Quick Start

### 1. Backend

```bash
cd backend
cp .env.example .env
# Add your GOOGLE_API_KEY to .env

pip install -r requirements.txt
uvicorn main:app --reload --port 8080
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open on your **phone** at `http://<your-local-ip>:5173` — mobile camera works best.

### 3. Run Tests

```bash
python -m pytest tests/ -v
```

## Deploy to Google Cloud Run

```bash
# Build frontend first
cd frontend && npm run build && cd ..

# Deploy backend (serves frontend static files too)
gcloud run deploy homefix-ai \
  --source backend \
  --region us-central1 \
  --allow-unauthenticated \
  --min-instances 1 \
  --set-env-vars GOOGLE_CLOUD_PROJECT=your-project-id \
  --port 8080
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLOUD_PROJECT` | ✅ | GCP project ID (Vertex AI) |
| `GOOGLE_CLOUD_LOCATION` | optional | Region (default: `us-central1`) |
| `NYC_APP_TOKEN` | optional | Socrata app token (increases 311 API rate limits) |

## Models Used (all Gemini)

| Component | Model |
|-----------|-------|
| Live streaming (Vision/Guidance/Verification) | `gemini-2.0-flash-live-001` |
| Bbox detection (fallback) | `gemini-2.0-flash` |
| Repair procedure grounding | `gemini-2.0-flash` + Google Search |

## Day 1 Critical Test

Before building the full UI, verify bbox JSON extraction from the Live API:

```python
# Run this to test bbox extraction from Gemini Live text channel
python backend/test_bbox_extraction.py
```

If it returns bbox JSON cleanly → proceed with Layer A (native).
If not → the fallback (separate `gemini-2.0-flash` call per step) is already implemented.

## Demo Flow

1. **Start** — tap "Start Session", camera opens
2. **Identify** — point at a leak/crack/outlet; agent speaks what it sees
3. **Guide** — step-by-step voice + annotation overlay on the component
4. **Verify** — agent scans repair area; confirms or retries
5. **Pro Screen** — for HIGH RISK issues: explains why, links to Google Maps for pros
