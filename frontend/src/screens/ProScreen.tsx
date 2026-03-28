import { SeverityData } from "../types";

interface Props {
  severity: SeverityData;
  onHandleMyself: () => void;
}

export function ProScreen({ severity, onHandleMyself }: Props) {
  const mapsUrl = `https://maps.google.com/?q=${encodeURIComponent(
    (severity.pro_type ?? "licensed contractor") + " near me"
  )}`;

  const level = severity.severity;
  const riskLabel =
    level === "HIGH" ? "Elevated risk" : level === "MEDIUM" ? "Caution" : "Review recommended";

  return (
    <div className="hf-pro">
      <div className="hf-pro__hero">
        <div className="hf-pro__row">
          <div className="hf-pro__icon" aria-hidden>
            !
          </div>
          <span className="hf-badge-risk">{riskLabel}</span>
        </div>
      </div>

      <div className="hf-pro__body">
        <h1 className="hf-pro__title">Use a professional for this one</h1>
        <p className="hf-pro__reason">{severity.reason}</p>

        <div className="hf-findings">
          <div className="hf-findings__title">What we noticed</div>
          {severity.findings.map((f) => (
            <div key={f} className="hf-finding">
              {f}
            </div>
          ))}
        </div>

        <a href={mapsUrl} target="_blank" rel="noreferrer" className="hf-cta-primary">
          Find a qualified pro nearby
        </a>

        <button type="button" className="hf-cta-ghost" onClick={onHandleMyself}>
          I’ll still do it myself — show guidance anyway
        </button>
      </div>
    </div>
  );
}
