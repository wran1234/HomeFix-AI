import { BBox } from "../types";
import { CanvasOverlay } from "../components/CanvasOverlay";
import { VoiceWaveform } from "../components/VoiceWaveform";

interface Props {
  videoRef: React.RefObject<HTMLVideoElement>;
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
        <video ref={videoRef} autoPlay playsInline muted />
        <CanvasOverlay bbox={bbox} width={640} height={480} />
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
              : "Looking at your space — take your time."}
          </span>
        </div>

        <VoiceWaveform isActive={isSpeaking} label="Assistant audio" />

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
