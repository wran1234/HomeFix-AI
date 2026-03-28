import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/theme.css";

// Recovery from stale SW after `npm run build` (old index.html → missing hashed JS = blank page)
if (import.meta.env.PROD && typeof window !== "undefined") {
  const q = new URLSearchParams(window.location.search);
  if (q.get("fresh") === "1") {
    navigator.serviceWorker
      ?.getRegistrations?.()
      .then((regs) => Promise.all(regs.map((r) => r.unregister())))
      .then(() => {
        window.location.replace(window.location.pathname);
      })
      .catch(() => {
        window.location.replace(window.location.pathname);
      });
  }
}

// Global reset — full height chain so % heights and overlays behave predictably
const style = document.createElement("style");
style.textContent = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #root { height: 100%; min-height: 100vh; min-height: 100dvh; }
  body { background: #12100e; overflow: hidden; }
  button { font-family: inherit; cursor: pointer; }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
`;
document.head.appendChild(style);

type BoundaryState = { error: Error | null };

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  BoundaryState
> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            minHeight: "100vh",
            padding: 24,
            background: "#0a0a0a",
            color: "#fca5a5",
            fontFamily: "system-ui, sans-serif",
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          <h1 style={{ color: "#fff", fontSize: 18, marginBottom: 12 }}>HomeFix couldn’t start</h1>
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {this.state.error.message}
          </pre>
          <p style={{ marginTop: 16, color: "#888" }}>
            If the page was blank before this message: try{" "}
            <a href="?fresh=1" style={{ color: "#93c5fd" }}>
              ?fresh=1
            </a>{" "}
            once to clear an old service worker, or hard-reload with cache disabled.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

const el = document.getElementById("root");
if (!el) {
  throw new Error('Missing <div id="root">');
}

ReactDOM.createRoot(el).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>
);
