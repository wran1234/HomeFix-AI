interface Props {
  onStart: () => void;
  cameraError: string | null;
}

export function StartScreen({ onStart, cameraError }: Props) {
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
          <button type="button" className="hf-btn-primary" onClick={onStart}>
            Begin session
          </button>
        )}
      </div>
    </div>
  );
}
