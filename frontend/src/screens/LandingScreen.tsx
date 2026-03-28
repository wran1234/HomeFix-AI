import { useCallback, useEffect, useState, type FormEvent } from "react";

export type NycInsightsPayload = {
  ok: boolean;
  zip: string;
  /** Count of rows matching the query (housing-related when housing_focus). */
  requests_30d: number;
  /** Sum of counts for displayed top categories (for bar scaling). */
  total: number;
  items: { complaint_type: string; count: number }[];
  period_days: number;
  error: string | null;
  /** When true, counts and categories are filtered to home/building conditions. */
  housing_focus?: boolean;
};

function titleCaseComplaint(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function insightsBackendMessage(code: string | null | undefined): string {
  switch (code) {
    case "timeout":
      return "The NYC Open Data service took too long to respond. Try again in a moment.";
    case "query_failed":
      return "We couldn’t load live 311 data from NYC Open Data. If you’re on Cloud Run, make sure this revision can reach the public internet, then tap Retry. If it keeps failing, add NYC_APP_TOKEN for higher API limits.";
    case "sodapy_not_installed":
      return "Backend dependencies may be incomplete. Run pip install -r backend/requirements.txt from the project and redeploy.";
    default:
      return "We couldn’t load live 311 statistics right now. You can retry below; NYC Open Data may be busy or temporarily unavailable.";
  }
}

interface Props {
  onTryApp: () => void;
}

export function LandingScreen({ onTryApp }: Props) {
  const [draftZip, setDraftZip] = useState("10001");
  const [data, setData] = useState<NycInsightsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [zipHint, setZipHint] = useState<string | null>(null);

  const load = useCallback(async (z: string) => {
    const clean = /^\d{5}$/.test(z) ? z : "10001";
    setLoading(true);
    setFetchError(null);
    setZipHint(null);
    try {
      const res = await fetch(`/api/nyc-insights?zip=${encodeURIComponent(clean)}`);
      if (!res.ok) throw new Error("Could not load neighborhood data.");
      const json = (await res.json()) as NycInsightsPayload;
      setData(json);
      setDraftZip(clean);
    } catch {
      setFetchError("We couldn’t reach NYC Open Data from here. Check your connection or try again.");
      setData({
        ok: false,
        zip: clean,
        requests_30d: 0,
        total: 0,
        items: [],
        period_days: 30,
        error: "network",
        housing_focus: true,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-load when the field has five digits (stable ~450ms) so typing or pasting a ZIP always refreshes.
  useEffect(() => {
    const z = draftZip.replace(/\D/g, "").slice(0, 5);
    if (z.length !== 5) {
      return;
    }
    const handle = window.setTimeout(() => {
      void load(z);
    }, 280);
    return () => window.clearTimeout(handle);
  }, [draftZip, load]);

  const applyZip = (e?: FormEvent) => {
    e?.preventDefault();
    const z = draftZip.replace(/\D/g, "").slice(0, 5);
    if (z.length !== 5) {
      setZipHint("Enter a full 5-digit NYC area ZIP code.");
      return;
    }
    setZipHint(null);
    void load(z);
  };

  const maxCount = data?.items?.length ? Math.max(...data.items.map((i) => i.count), 1) : 1;

  return (
    <div className="hf-landing">
      <header className="hf-landing__nav">
        <span className="hf-landing__logo">HomeFix</span>
        <span className="hf-landing__nav-note">NYC · guided repairs</span>
      </header>

      <section className="hf-landing__hero">
        <p className="hf-landing__eyebrow">On-site assistance</p>
        <h1 className="hf-landing__headline">
          Catch small home problems before they become emergencies.
        </h1>
        <p className="hf-landing__lead">
          HomeFix walks you through repairs with your camera and voice: identify what’s wrong, follow
          clear steps, and confirm the fix. When something isn’t safe to DIY, we tell you plainly—and
          point you to a pro.
        </p>
      </section>

      <section className="hf-landing__steps" aria-label="How it works">
        <h2 className="hf-landing__section-title">How it works</h2>
        <ol className="hf-landing__step-list">
          <li className="hf-landing__step">
            <span className="hf-landing__step-num">1</span>
            <div>
              <strong className="hf-landing__step-title">Inspect</strong>
              <p className="hf-landing__step-text">
                Point your phone at leaks, wiring, heating, or finishes. We characterize the issue and
                severity.
              </p>
            </div>
          </li>
          <li className="hf-landing__step">
            <span className="hf-landing__step-num">2</span>
            <div>
              <strong className="hf-landing__step-title">Repair</strong>
              <p className="hf-landing__step-text">
                Follow spoken guidance with on-screen cues—tools, sequence, and what to watch for.
              </p>
            </div>
          </li>
          <li className="hf-landing__step">
            <span className="hf-landing__step-num">3</span>
            <div>
              <strong className="hf-landing__step-title">Verify</strong>
              <p className="hf-landing__step-text">
                We re-check your work so you’re not guessing whether the job is really done.
              </p>
            </div>
          </li>
        </ol>
      </section>

      <section className="hf-landing__nyc" aria-labelledby="nyc-heading">
        <div className="hf-landing__nyc-head">
          <h2 id="nyc-heading" className="hf-landing__section-title">
            Why early fixes matter in the city
          </h2>
          <p className="hf-landing__nyc-deck">
            Many{" "}
            <a
              href="https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2010-to-Present/erm2-nwe9"
              target="_blank"
              rel="noreferrer"
              className="hf-landing__link"
            >
              NYC 311
            </a>{" "}
            cases involve housing conditions—leaks, heat, pests, mold, and building defects—that get
            worse when people wait. HomeFix helps you address fixable problems early, with guardrails
            when a licensed pro is the right call.
          </p>
        </div>

        <div className="hf-landing__nyc-card">
          <form
            className="hf-landing__nyc-toolbar"
            onSubmit={applyZip}
            aria-label="Look up 311 housing-related complaints by ZIP"
          >
            <label className="hf-landing__zip-label" htmlFor="landing-zip">
              ZIP code
            </label>
            <div className="hf-landing__zip-row">
              <input
                id="landing-zip"
                className="hf-landing__zip-input"
                inputMode="numeric"
                autoComplete="postal-code"
                placeholder="10001"
                maxLength={5}
                value={draftZip}
                onChange={(e) => {
                  setZipHint(null);
                  setDraftZip(e.target.value.replace(/\D/g, "").slice(0, 5));
                }}
              />
              <button type="submit" className="hf-landing__zip-btn">
                Update
              </button>
            </div>
            {zipHint && (
              <p className="hf-landing__zip-hint" role="status">
                {zipHint}
              </p>
            )}
            <p className="hf-landing__zip-microcopy">
              Results load automatically for a full ZIP. Use a NYC-area code (e.g. 11201, 10458).
            </p>
          </form>

          {fetchError && <p className="hf-landing__warn hf-landing__warn--below-form">{fetchError}</p>}

          {loading && <p className="hf-landing__loading">Loading open data…</p>}

          {!loading && data && (
            <>
              <p className="hf-landing__stat-lead">
                {data.ok && data.requests_30d > 0 ? (
                  <>
                    In the last <strong>{data.period_days} days</strong>,{" "}
                    <strong>{data.zip}</strong> had{" "}
                    <strong>{data.requests_30d.toLocaleString()}</strong>{" "}
                    {data.housing_focus !== false ? (
                      <>
                        <strong>housing-related</strong> 311 service requests (heat, leaks, electrical,
                        pests, construction, and similar) in NYC Open Data
                      </>
                    ) : (
                      <>311 service requests in NYC Open Data for that ZIP</>
                    )}
                    . The bars show the most common complaint types in that slice—useful context for
                    what neighbors are reporting before problems spread.
                  </>
                ) : data.ok && data.requests_30d === 0 ? (
                  <>
                    No matching 311 requests in <strong>{data.zip}</strong> for this window in Open
                    Data (or none in the housing-related filter). Try another NYC ZIP, or check back
                    later.
                  </>
                ) : (
                  <>
                    <span className="hf-landing__err-lead">{insightsBackendMessage(data.error)}</span>{" "}
                    In many NYC ZIP codes, housing-related 311 volume is high; fixing problems at home
                    early keeps cases from compounding.
                    <span className="hf-landing__retry-wrap">
                      <button
                        type="button"
                        className="hf-landing__retry-btn"
                        onClick={() => void load(data.zip)}
                      >
                        Retry lookup
                      </button>
                    </span>
                  </>
                )}
              </p>

              {data.items.length > 0 && (
                <ul className="hf-landing__bars" aria-label="Complaint mix">
                  {data.items.slice(0, 6).map((row) => (
                    <li key={row.complaint_type} className="hf-landing__bar-row">
                      <span className="hf-landing__bar-label">
                        {titleCaseComplaint(row.complaint_type)}
                      </span>
                      <div className="hf-landing__bar-track">
                        <div
                          className="hf-landing__bar-fill"
                          style={{ width: `${Math.min(100, (row.count / maxCount) * 100)}%` }}
                        />
                      </div>
                      <span className="hf-landing__bar-count">{row.count}</span>
                    </li>
                  ))}
                </ul>
              )}

              <p className="hf-landing__closing">
                HomeFix won’t replace 311—but it can help you fix the right things at home before they
                turn into someone else’s emergency dispatch.
              </p>
            </>
          )}
        </div>
      </section>

      <section className="hf-landing__cta-block">
        <button type="button" className="hf-btn-primary hf-landing__cta" onClick={onTryApp}>
          Try the live demo
        </button>
        <p className="hf-landing__cta-note">
          You’ll enable the camera and microphone for a short session. Works best on your phone.
        </p>
      </section>

      <footer className="hf-landing__footer">
        <span>HomeFix · Hackathon build</span>
      </footer>
    </div>
  );
}
