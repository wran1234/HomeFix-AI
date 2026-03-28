import type { Ref } from "react";
import { BBox } from "../types";
import { CanvasOverlay } from "../components/CanvasOverlay";
import { VoiceWaveform } from "../components/VoiceWaveform";

interface Props {
  videoRef: Ref<HTMLVideoElement>;
  bbox: BBox | null;
  isSpeaking: boolean;
  nycChip: string | null;
  status: string;
}

export function IdentifyScreen({ videoRef, bbox, isSpeaking, nycChip, status }: Props) {
  const loadingGuidance = status === "loading_guidance";

  return (
    <div className="hf-shell">
      <header className="hf-topbar">
        <span className="hf-topbar__brand">HomeFix</span>
        <div className="hf-topbar__meta">
          <span className="hf-topbar__kicker">Live session</span>
          <span className="hf-topbar__phase">{loadingGuidance ? "Preparing guidance" : "Inspecting"}</span>
        </div>
      </header>

      <div className="hf-camera">
        <video
          ref={videoRef}
          className="hf-camera-feed"
          autoPlay
          playsInline
          muted
          controls={false}
          disablePictureInPicture
        />
        <CanvasOverlay bbox={bbox} />
      </div>

      <div className="hf-panel">
        <div className="hf-status-line">
          <span
            className={
              loadingGuidance ? "hf-status-dot hf-status-dot--idle" : "hf-status-dot"
            }
            aria-hidden
          />
          <span className="hf-status-text">
            {loadingGuidance
              ? "Reviewing repair context…"
              : isSpeaking
              ? "Listening…"
              : "Point your camera at the problem — you can speak at any time."}
          </span>
        </div>

        <VoiceWaveform isActive={isSpeaking} label="Assistant audio" />

        {!loadingGuidance && !isSpeaking && (
          <p className="hf-identify__hint">
            The assistant will guide you. Speak naturally to ask questions.
          </p>
        )}

        {nycChip && (
          <div className="hf-chip-context">
            <span className="hf-chip-context__dot" aria-hidden />
            <p className="hf-chip-context__text">{nycChip}</p>
          </div>
        )}
      </div>
    </div>
  );
}
