import type { MediaGateStatus } from "../media/gate";

interface Props {
  onStart: () => void | Promise<void>;
  cameraError: string | null;
  cameraReady: boolean;
  mediaGate: MediaGateStatus;
  /** WebSocket to backend is open — safe to send `ready` (may be queued if still handshaking). */
  socketConnected: boolean;
  startupError: string | null;
  startRequested: boolean;
}

export function StartScreen({
  onStart,
  cameraError,
  cameraReady,
  mediaGate,
  socketConnected,
  startupError,
  startRequested,
}: Props) {
  const mediaOk = !cameraError && cameraReady && mediaGate.videoOk && mediaGate.audioOk;
  const canBegin = mediaOk && socketConnected;
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

        {cameraError || startupError ? (
          <div className="hf-error" role="alert">
            {cameraError ?? startupError}
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
            <button type="button" className="hf-btn-primary" onClick={onStart} disabled={!canBegin || startRequested}>
              {startRequested ? "Connecting to AI…" : "Begin session"}
            </button>
            {(!canBegin || startRequested) && !cameraError && !startupError && (
              <p className="hf-start__fine hf-start__fine--hint">
                {!mediaOk
                  ? "Allow camera and microphone for this site, then wait until both show \"on\"."
                  : !socketConnected
                    ? "Connecting to the server — button enables when the link is up."
                    : "Sending start signal to AI…"}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
