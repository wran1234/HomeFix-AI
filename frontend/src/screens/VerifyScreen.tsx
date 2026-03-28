import { VerifyResult } from "../types";

interface Props {
  videoRef: React.RefObject<HTMLVideoElement>;
  result: VerifyResult | null;
  nycContext: string | null;
}

export function VerifyScreen({ videoRef, result, nycContext }: Props) {
  return (
    <div className="hf-shell">
      <header className="hf-topbar">
        <span className="hf-topbar__brand">HomeFix</span>
        <div className="hf-topbar__meta">
          <span className="hf-topbar__kicker">Quality check</span>
          <span className="hf-topbar__phase">{result ? "Complete" : "Verifying"}</span>
        </div>
      </header>

      <div className="hf-camera" style={{ flex: "0 0 48%", minHeight: 200 }}>
        <video ref={videoRef} autoPlay playsInline muted />
        {!result && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "column",
              pointerEvents: "none",
            }}
          >
            <div className="hf-scan-frame">
              <span className="hf-scan-corner hf-scan-corner--tl" />
              <span className="hf-scan-corner hf-scan-corner--tr" />
              <span className="hf-scan-corner hf-scan-corner--bl" />
              <span className="hf-scan-corner hf-scan-corner--br" />
            </div>
            <p className="hf-verify__scan-label">Hold steady on the repaired area</p>
          </div>
        )}
      </div>

      <div className="hf-panel" style={{ alignItems: "center", textAlign: "center" }}>
        {result ? (
          <>
            <div
              className={
                result.pass ? "hf-result-icon hf-result-icon--pass" : "hf-result-icon hf-result-icon--fail"
              }
              aria-hidden
            >
              {result.pass ? "✓" : "✗"}
            </div>
            <h2
              className={
                result.pass
                  ? "hf-result-title hf-result-title--pass"
                  : "hf-result-title hf-result-title--fail"
              }
            >
              {result.pass ? "Looks good" : "Almost there"}
            </h2>
            <p className="hf-result-detail">{result.message}</p>

            {nycContext && (
              <div className="hf-card-nyc">
                <div className="hf-card-nyc__title">Neighborhood context · NYC 311</div>
                <p className="hf-card-nyc__body">{nycContext}</p>
              </div>
            )}
          </>
        ) : (
          <p className="hf-waiting">Reviewing your repair against the original issue…</p>
        )}
      </div>
    </div>
  );
}
