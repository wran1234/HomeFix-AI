export type AppPhase =
  | "landing"
  | "start"
  | "identifying"
  | "loading_guidance"
  | "guiding"
  | "verifying"
  | "verified"
  | "escalate";

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

export type WSMessage =
  | { type: "status"; state: AppPhase }
  | { type: "speech"; audio: string }
  | { type: "annotation"; bbox: [number, number, number, number]; label: string; color: "white" | "red" }
  | { type: "step"; n: number; total: number; title: string; body: string; tools: string[]; component?: string }
  | { type: "severity"; diy_safe: boolean; issue: string; severity: string; reason: string; findings: string[] }
  | { type: "verify_result"; pass: boolean; message: string }
  | { type: "escalated"; findings: string[]; pro_type: string }
  | { type: "nyc_chip"; text: string }
  | { type: "nyc_context"; text: string }
  | { type: "error"; code: string; message: string };
