import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppPhase, BBox, SeverityData, StepData, VerifyResult, WSMessage } from "./types";
import { useWebSocket } from "./hooks/useWebSocket";
import { useCamera } from "./hooks/useCamera";
import { createSessionId } from "./sessionId";
import { LandingScreen } from "./screens/LandingScreen";
import { StartScreen } from "./screens/StartScreen";
import { IdentifyScreen } from "./screens/IdentifyScreen";
import { GuideScreen } from "./screens/GuideScreen";
import { VerifyScreen } from "./screens/VerifyScreen";
import { ProScreen } from "./screens/ProScreen";

export default function App() {
  const sessionId = useMemo(() => createSessionId(), []);
  const [phase, setPhase] = useState<AppPhase>("landing");
  const [bbox, setBbox] = useState<BBox | null>(null);
  const [step, setStep] = useState<StepData | null>(null);
  const [severity, setSeverity] = useState<SeverityData | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [nycChip, setNycChip] = useState<string | null>(null);
  const [nycContext, setNycContext] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const sessionActive = phase !== "landing";
  const {
    videoRef,
    error: cameraError,
    startCapture,
    stopCapture,
    startLiveAudio,
    stopLiveAudio,
  } = useCamera(sessionActive);

  // ── Audio playback ──────────────────────────────────────────────────────────
  const playAudio = useCallback(async (b64: string) => {
    if (!audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    await ctx.resume(); // Safari unlock

    const raw = atob(b64);
    const buf = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);

    try {
      const audioBuf = await ctx.decodeAudioData(buf.buffer);
      const source = ctx.createBufferSource();
      source.buffer = audioBuf;
      source.connect(ctx.destination);
      source.start();
      setIsSpeaking(true);
      source.onended = () => setIsSpeaking(false);
    } catch {
      // PCM raw data — handle as linear16
      // Gemini Live sends 16-bit PCM at 24kHz
      const pcm = new Int16Array(buf.buffer);
      const float32 = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) float32[i] = pcm[i] / 32768;
      const audioBuf = ctx.createBuffer(1, float32.length, 24000);
      audioBuf.copyToChannel(float32, 0);
      const source = ctx.createBufferSource();
      source.buffer = audioBuf;
      source.connect(ctx.destination);
      source.start();
      setIsSpeaking(true);
      source.onended = () => setIsSpeaking(false);
    }
  }, []);

  // ── WebSocket message handler ───────────────────────────────────────────────
  const handleMessage = useCallback((msg: WSMessage) => {
    switch (msg.type) {
      case "status":
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
      case "nyc_chip":
        setNycChip(msg.text);
        break;
      case "nyc_context":
        setNycContext(msg.text);
        break;
      case "error":
        console.warn("HomeFix error:", msg.code, msg.message);
        break;
    }
  }, [playAudio]);

  const { send, connectionBanner } = useWebSocket(sessionId, handleMessage, sessionActive);

  // ── Live mic → Gemini (16 kHz PCM chunks) ───────────────────────────────────
  useEffect(() => {
    const voicePhases: AppPhase[] = ["identifying", "loading_guidance", "guiding", "verifying"];
    if (!sessionActive || !voicePhases.includes(phase)) {
      stopLiveAudio();
      return;
    }
    startLiveAudio((b64) => {
      send({ type: "audio", data: b64 });
    });
    return () => stopLiveAudio();
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
  const handleStart = useCallback(() => {
    // Unlock AudioContext on user gesture (Safari requirement)
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }
    audioCtxRef.current.resume();
    setPhase("identifying");
  }, []);

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

      {phase === "landing" && <LandingScreen onTryApp={() => setPhase("start")} />}

      {phase === "start" && (
        <>
          <video ref={videoRef} autoPlay playsInline muted className="hf-bg-video" />
          <div className="hf-start-layer">
            <StartScreen onStart={handleStart} cameraError={cameraError} />
          </div>
        </>
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
          onInterrupt={(text) => send({ type: "interrupt", text })}
        />
      )}

      {(phase === "verifying" || phase === "verified") && (
        <VerifyScreen
          videoRef={videoRef}
          result={verifyResult}
          nycContext={nycContext}
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
