import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppPhase,
  BBox,
  SeverityData,
  StepData,
  ToolsList,
  VerifyResult,
  WSMessage,
} from "./types";
import { useWebSocket } from "./hooks/useWebSocket";
import { useCamera } from "./hooks/useCamera";
import { useLiveSpeechPlayback } from "./hooks/useLiveSpeechPlayback";
import { createSessionId } from "./sessionId";
import { LandingScreen } from "./screens/LandingScreen";
import { StartScreen } from "./screens/StartScreen";
import { IdentifyScreen } from "./screens/IdentifyScreen";
import { GuideScreen } from "./screens/GuideScreen";
import { VerifyScreen } from "./screens/VerifyScreen";
import { ProScreen } from "./screens/ProScreen";
import { DoneScreen } from "./screens/DoneScreen";


export default function App() {
  const sessionId = useMemo(() => createSessionId(), []);
  const [phase, setPhase] = useState<AppPhase>("landing");
  const [bbox, setBbox] = useState<BBox | null>(null);
  const [step, setStep] = useState<StepData | null>(null);
  const [severity, setSeverity] = useState<SeverityData | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [toolsList, setToolsList] = useState<ToolsList | null>(null);
  const [nycChip, setNycChip] = useState<string | null>(null);
  const [nycContext, setNycContext] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [startRequested, setStartRequested] = useState(false);
  /** Bumps on “Begin session” so the camera runs `.play()` again (fixes black video on prod Safari/WebKit). */
  const [cameraPlayNonce, setCameraPlayNonce] = useState(0);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const sessionActive = phase !== "landing";
  const {
    videoRef,
    error: cameraError,
    isReady: cameraReady,
    mediaGate,
    assertMediaReady,
    startCapture,
    stopCapture,
    startLiveAudio,
    stopLiveAudio,
  } = useCamera(sessionActive, cameraPlayNonce, audioCtxRef, phase);

  const playAudio = useLiveSpeechPlayback(audioCtxRef, setIsSpeaking, phase);

  // ── WebSocket message handler ───────────────────────────────────────────────
  const handleMessage = useCallback((msg: WSMessage) => {
    console.debug("[HomeFix][ws<-]", msg);
    switch (msg.type) {
      case "status":
        setStartupError(null);
        setStartRequested(false);
        setPhase(msg.state);
        break;
      case "speech":
        playAudio(msg.audio);
        break;
      case "annotation":
        setBbox({ bbox: msg.bbox, label: msg.label, color: msg.color });
        // Clear annotation after 4 seconds
        setTimeout(() => setBbox(null), 4000);
        break;
      case "step":
        setStep({ n: msg.n, total: msg.total, title: msg.title, body: msg.body, tools: msg.tools });
        break;
      case "severity":
        setSeverity({
          issue: msg.issue,
          severity: msg.severity as "LOW" | "MEDIUM" | "HIGH",
          diy_safe: msg.diy_safe,
          reason: msg.reason,
          findings: msg.findings,
        });
        if (!msg.diy_safe) setPhase("escalate");
        break;
      case "verify_result":
        setVerifyResult({ pass: msg.pass, message: msg.message });
        setPhase("verified");
        break;
      case "escalated":
        setSeverity((prev) => prev ? { ...prev, pro_type: msg.pro_type, findings: msg.findings } : null);
        break;
      case "tools_list":
        setToolsList({ tools: msg.tools, materials: msg.materials, summary: msg.summary });
        break;
      case "agent_ready":
        break;
      case "nyc_chip":
        setNycChip(msg.text);
        break;
      case "nyc_context":
        setNycContext(msg.text);
        break;
      case "error":
        console.warn("HomeFix error:", msg.code, msg.message);
        if (msg.code === "LIVE_CONNECT_TIMEOUT" || msg.code === "LIVE_CONNECT_FAILED" || msg.code === "READY_TIMEOUT") {
          setStartupError(msg.message);
          setStartRequested(false);
          setPhase("start");
        }
        break;
      case "debug_live":
        break;
    }
  }, [playAudio]);

  const { send, connectionBanner, isConnected } = useWebSocket(sessionId, handleMessage, sessionActive);

  useEffect(() => {
    console.info("[HomeFix] phase changed:", phase);
  }, [phase]);

  // After a WebSocket reconnect the server creates a new session (`saw_ready` resets). Resync `ready`
  // if the user already passed Begin (common when `ready` was only queued, or consumed on the old socket).
  const lostConnectionRef = useRef(false);
  useEffect(() => {
    if (!isConnected) {
      lostConnectionRef.current = true;
      return;
    }
    if (!lostConnectionRef.current) return;
    lostConnectionRef.current = false;
    const pastStart = sessionActive && phase !== "start";
    if (pastStart) {
      console.info("[HomeFix][ws->] resend ready after reconnect");
      send({ type: "ready" });
    }
  }, [isConnected, sessionActive, phase, send]);

  // ── Live mic → Gemini (16 kHz PCM chunks) ───────────────────────────────────
  useEffect(() => {
    const voicePhases: AppPhase[] = ["identifying", "loading_guidance", "guiding", "verifying"];
    if (!sessionActive || !voicePhases.includes(phase)) {
      stopLiveAudio();
      return;
    }
    let cancelled = false;
    void (async () => {
      await startLiveAudio((b64) => {
        if (!cancelled) send({ type: "audio", data: b64 });
      });
    })();
    return () => {
      cancelled = true;
      stopLiveAudio();
    };
  }, [phase, sessionActive, send, startLiveAudio, stopLiveAudio]);

  // ── Frame sending ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase === "landing" || phase === "start" || phase === "escalate" || phase === "verified") {
      stopCapture();
      return;
    }
    const fps = phase === "identifying" || phase === "loading_guidance" ? 1 : 2;
    startCapture(fps, (b64) => {
      send({ type: "frame", data: b64, ts: Date.now() });
    });
    return stopCapture;
  }, [phase, startCapture, stopCapture, send]);

  // ── Session start ───────────────────────────────────────────────────────────
  const handleStart = useCallback(async () => {
    console.info("[HomeFix] Begin button pressed");
    // Re-check tracks but don't block — mic may not be "live" yet on mobile at the
    // exact moment of tap. We proceed regardless; audio will work once tracks settle.
    assertMediaReady();
    setStartupError(null);
    if (!isConnected) {
      setStartupError("Connection to server is not ready yet. Please wait a moment and try again.");
      return;
    }
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }
    try {
      await audioCtxRef.current.resume();
    } catch {
      /* still try to run session */
    }
    console.info("[HomeFix][ws->] sending ready");
    const readySent = send({ type: "ready" });
    if (!readySent) {
      setStartupError("Could not send start signal to server. Please try again.");
      return;
    }
    setStartRequested(true);
    setCameraPlayNonce((n) => n + 1);
    setPhase("identifying");
    queueMicrotask(() => {
      const v = videoRef.current;
      if (v?.srcObject) void v.play();
    });
  }, [assertMediaReady, send, videoRef, isConnected]);

  // ── "Handle myself" override ────────────────────────────────────────────────
  const handleMyselfOverride = useCallback(() => {
    send({ type: "interrupt", text: "I understand the risk. Please guide me anyway." });
    setPhase("loading_guidance");
  }, [send]);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className={`hf-app-root${phase === "landing" ? " hf-app-root--scroll" : ""}`}>
      {connectionBanner === "recovering" && (
        <div className="hf-reconnect" role="status">
          Having trouble staying connected — trying to restore your session…
        </div>
      )}
      {connectionBanner === "failed" && (
        <div className="hf-reconnect hf-reconnect--failed" role="alert">
          Couldn’t reconnect. Check your network, then reload the page.
        </div>
      )}

      {sessionActive && phase !== "start" && mediaGate.warning && (
        <div className="hf-media-warn" role="status">
          {mediaGate.warning}
        </div>
      )}

      {/* Full-bleed preview only on Start; after Begin, each phase mounts the same ref in .hf-camera (WebKit-safe). */}
      {sessionActive && phase === "start" && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          controls={false}
          disablePictureInPicture
          className="hf-session-video hf-session-video--dimmed"
        />
      )}

      {phase === "landing" && <LandingScreen onTryApp={() => {
        setStartupError(null);
        setStartRequested(false);
        setPhase("start");
      }} />}

      {phase === "start" && (
        <div className="hf-start-layer">
          <StartScreen
            onStart={handleStart}
            cameraError={cameraError}
            cameraReady={cameraReady}
            mediaGate={mediaGate}
            socketConnected={isConnected}
            startupError={startupError}
            startRequested={startRequested}
          />
        </div>
      )}

      {(phase === "identifying" || phase === "loading_guidance") && (
        <IdentifyScreen
          videoRef={videoRef}
          bbox={bbox}
          isSpeaking={isSpeaking}
          nycChip={nycChip}
          status={phase}
        />
      )}

      {phase === "guiding" && (
        <GuideScreen
          videoRef={videoRef}
          bbox={bbox}
          step={step}
          toolsList={toolsList}
          onInterrupt={(text) => send({ type: "interrupt", text })}
        />
      )}

      {(phase === "verifying" || phase === "verified") && (
        <VerifyScreen
          videoRef={videoRef}
          result={verifyResult}
          nycContext={nycContext}
          onDone={() => setPhase("done")}
        />
      )}

      {phase === "done" && (
        <DoneScreen
          issue={severity?.issue ?? null}
          onRestart={() => {
            setPhase("landing");
            setSeverity(null);
            setStep(null);
            setVerifyResult(null);
            setBbox(null);
            setToolsList(null);
            setNycChip(null);
            setNycContext(null);
            setStartupError(null);
            setStartRequested(false);
          }}
        />
      )}

      {phase === "escalate" && severity && (
        <ProScreen
          severity={severity}
          onHandleMyself={handleMyselfOverride}
        />
      )}

    </div>
  );
}
