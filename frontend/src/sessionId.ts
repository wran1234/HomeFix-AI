/** Works on http://<lan-ip> where `crypto.randomUUID` is not available (non-secure context). */
export function createSessionId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${Date.now()}-${s4()}${s4()}-${s4()}`;
}
