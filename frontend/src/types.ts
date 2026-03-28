export type AppPhase =
  | "landing"
  | "start"
  | "identifying"
  | "loading_guidance"
  | "guiding"
  | "verifying"
  | "verified"
  | "escalate"
  | "done";

export interface BBox {
  bbox: [number, number, number, number]; // [x, y, w, h] normalized 0-1
  label: string;
  color: "white" | "red";
}

export interface StepData {
  n: number;
  total: number;
  title: string;
  body: string;
  tools: string[];
  component?: string;
}

export interface SeverityData {
  issue: string;
  severity: "LOW" | "MEDIUM" | "HIGH";
  diy_safe: boolean;
  reason: string;
  findings: string[];
  pro_type?: string;
}

export interface VerifyResult {
  pass: boolean;
  message: string;
}

export interface ToolsList {
  tools: string[];
  materials: string[];
  summary: string;
}

/** Server pushes ~1 Hz while the WebSocket session is open (Gemini Live diagnostics). */
export interface LiveDebugSnapshot {
  type: "debug_live";
  model: string;
  bridge: string;
  live_ws_to_vertex: boolean;
  saw_client_ready: boolean;
  client_frames_in: number;
  client_audio_chunks_in: number;
  ms_since_client_frame: number | null;
  ms_since_client_audio: number | null;
  gemini_jpeg_sends: number;
  gemini_audio_sends: number;
  ms_since_gemini_jpeg_send: number | null;
  ms_since_gemini_audio_send: number | null;
  gemini_audio_out_chunks: number;
  gemini_audio_out_kb: number;
  ms_since_gemini_spoke: number | null;
  tool_events_from_model: number;
  ms_since_tool_event: number | null;
  gemini_upstream_errors: number;
  last_upstream_error: string;
  receiving_from_phone: boolean;
  sending_to_gemini: boolean;
  receiving_from_gemini: boolean;
  summary: string;
}

export type WSMessage =
  | { type: "status"; state: AppPhase }
  | { type: "speech"; audio: string }
  | { type: "annotation"; bbox: [number, number, number, number]; label: string; color: "white" | "red" }
  | { type: "step"; n: number; total: number; title: string; body: string; tools: string[]; component?: string }
  | { type: "severity"; diy_safe: boolean; issue: string; severity: string; reason: string; findings: string[] }
  | { type: "verify_result"; pass: boolean; message: string }
  | { type: "escalated"; findings: string[]; pro_type: string }
  | { type: "tools_list"; tools: string[]; materials: string[]; summary: string }
  | { type: "nyc_chip"; text: string }
  | { type: "nyc_context"; text: string }
  | { type: "error"; code: string; message: string }
  | LiveDebugSnapshot;
