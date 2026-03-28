import type { LiveDebugSnapshot } from "../types";

interface Props {
  data: LiveDebugSnapshot | null;
}

export function LiveDebugPanel({ data }: Props) {
  if (!data) {
    return (
      <aside className="hf-live-debug" aria-live="polite">
        <div className="hf-live-debug__head">Live debug</div>
        <p className="hf-live-debug__summary">Waiting for server telemetry…</p>
      </aside>
    );
  }

  const flowOk =
    data.live_ws_to_vertex &&
    data.receiving_from_phone &&
    data.sending_to_gemini &&
    data.receiving_from_gemini;

  return (
    <aside
      className={`hf-live-debug${flowOk ? " hf-live-debug--ok" : " hf-live-debug--warn"}`}
      aria-live="polite"
    >
      <div className="hf-live-debug__head">
        <span className="hf-live-debug__badge">{data.live_ws_to_vertex ? "Vertex WS" : "No WS"}</span>
        <span className="hf-live-debug__phase">{data.bridge}</span>
      </div>
      <p className="hf-live-debug__summary">{data.summary}</p>
      <ul className="hf-live-debug__stats">
        <li>
          Phone → server: frames {data.client_frames_in}, audio chunks {data.client_audio_chunks_in}{" "}
          {data.ms_since_client_frame != null && (
            <span className="hf-live-debug__age">(last frame {data.ms_since_client_frame}ms ago)</span>
          )}
        </li>
        <li>
          Server → Gemini: JPEG×{data.gemini_jpeg_sends}, audio×{data.gemini_audio_sends}
          {data.gemini_upstream_errors > 0 && (
            <span className="hf-live-debug__err"> · upstream errors: {data.gemini_upstream_errors}</span>
          )}
        </li>
        <li>
          Gemini → you: audio chunks {data.gemini_audio_out_chunks} (~{data.gemini_audio_out_kb}KB), tools{" "}
          {data.tool_events_from_model}
          {data.ms_since_gemini_spoke != null && data.gemini_audio_out_chunks > 0 && (
            <span className="hf-live-debug__age"> (last speech {data.ms_since_gemini_spoke}ms ago)</span>
          )}
        </li>
        <li>
          WS queue: {data.ws_queue_depth ?? "—"} / {data.ws_queue_max ?? "—"} · bbox REST cap:{" "}
          {data.bbox_fetch_concurrency_cap ?? "—"}
        </li>
        <li className="hf-live-debug__model">Model: {data.model}</li>
        {data.last_upstream_error ? (
          <li className="hf-live-debug__err">Error: {data.last_upstream_error}</li>
        ) : null}
      </ul>
    </aside>
  );
}
