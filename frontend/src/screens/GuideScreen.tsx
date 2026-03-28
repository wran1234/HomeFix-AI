import { BBox, StepData } from "../types";
import { CanvasOverlay } from "../components/CanvasOverlay";

interface Props {
  videoRef: React.RefObject<HTMLVideoElement>;
  bbox: BBox | null;
  step: StepData | null;
  onInterrupt: (text: string) => void;
}

function resolveTotalSteps(step: StepData): number {
  const t = step.total;
  if (typeof t === "number" && Number.isFinite(t) && t > 0) return Math.min(t, 24);
  return Math.max(3, step.n, 1);
}

export function GuideScreen({ videoRef, bbox, step, onInterrupt }: Props) {
  const total = step ? resolveTotalSteps(step) : 0;
  const label = bbox?.label || step?.component || "";

  return (
    <div className="hf-guide">
      <header className="hf-topbar">
        <span className="hf-topbar__brand">HomeFix</span>
        <div className="hf-topbar__meta">
          <span className="hf-topbar__kicker">Guided repair</span>
          <span className="hf-topbar__phase">
            {step ? `Step ${step.n} of ${total}` : "In progress"}
          </span>
        </div>
      </header>

      <div className="hf-guide__cam">
        <video ref={videoRef} autoPlay playsInline muted />
        <CanvasOverlay bbox={bbox} width={640} height={480} />
        {label ? <div className="hf-pin-label">{label}</div> : null}
      </div>

      <div className="hf-guide__body">
        {step ? (
          <>
            <article className="hf-step-card">
              <div className="hf-step-head">
                <span className="hf-step-num">{step.n}</span>
                <h2 className="hf-step-title">{step.title}</h2>
              </div>
              <p className="hf-step-body">{step.body}</p>
              {(step.tools?.length ?? 0) > 0 && (
                <div className="hf-tools" aria-label="Tools for this step">
                  {(step.tools ?? []).map((t) => (
                    <span key={t} className="hf-tool-pill">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </article>

            <div className="hf-progress" aria-label="Progress">
              {Array.from({ length: total }, (_, i) => {
                const done = i < step.n - 1;
                const current = i === step.n - 1;
                return (
                  <span
                    key={i}
                    className={
                      done
                        ? "hf-progress-dot hf-progress-dot--done"
                        : current
                          ? "hf-progress-dot hf-progress-dot--current"
                          : "hf-progress-dot"
                    }
                  />
                );
              })}
            </div>
          </>
        ) : (
          <p className="hf-loading-copy">Preparing your step-by-step instructions…</p>
        )}

        <button
          type="button"
          className="hf-btn-secondary"
          onClick={() => onInterrupt("Could you explain that step again in simpler terms?")}
        >
          Ask in chat
        </button>
        <p className="hf-guide__voice-hint">Or speak your question — the assistant listens while you work.</p>
      </div>
    </div>
  );
}
