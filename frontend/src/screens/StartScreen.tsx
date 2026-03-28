import type { MediaGateStatus } from "../media/gate";

interface Props {
  onStart: () => void | Promise<void>;
  cameraError: string | null;
  cameraReady: boolean;
  mediaGate: MediaGateStatus;
}

export function StartScreen({ onStart, cameraError, cameraReady, mediaGate }: Props) {
  const canBegin =
    !cameraError && cameraReady && mediaGate.videoOk && mediaGate.audioOk;
  return (
    <div className="hf-start">
      <div className="hf-start__glow">
        <div className="hf-start__frame" aria-hidden>
          <p className="hf-start__frame-inner">
            {cameraError ?? "Live preview loads when the camera is ready."}
          </p>
        </div>
      </div>

      <div className="hf-start__bottom">
        <h1 className="hf-start__wordmark">HomeFix</h1>
        <p className="hf-start__tagline">Guided home repairs, start to finish.</p>
        <p className="hf-start__fine">
          Point your camera at the issue. You’ll get spoken steps, clear visuals, and a quick quality check when you’re done.
        </p>

        {cameraError ? (
          <div className="hf-error" role="alert">
            {cameraError}
          </div>
        ) : (
          <>
            <ul className="hf-media-check" aria-label="Camera and microphone status">
              <li className={mediaGate.videoOk ? "hf-media-check__ok" : ""}>
                Camera: {mediaGate.videoOk ? "on" : cameraReady ? "off or blocked" : "starting…"}
              </li>
              <li className={mediaGate.audioOk ? "hf-media-check__ok" : ""}>
                Microphone: {mediaGate.audioOk ? "on" : cameraReady ? "off or blocked" : "starting…"}
              </li>
            </ul>
            <button type="button" className="hf-btn-primary" onClick={onStart} disabled={!canBegin}>
              Begin session
            </button>
            {!canBegin && !cameraError && (
              <p className="hf-start__fine hf-start__fine--hint">
                Allow camera and microphone for this site, then wait until both show &quot;on&quot;.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
