import { useCallback, useEffect, useRef, useState } from "react";
import { WSMessage } from "../types";

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;
const MAX_PENDING_SEND = 100;
/** Only surface UI after disconnect persists this long (filters brief glitches). */
const BANNER_AFTER_MS = 2800;

export type ConnectionBanner = null | "recovering" | "failed";

export interface UseWebSocketReturn {
  send: (msg: object) => boolean;
  isConnected: boolean;
  connectionBanner: ConnectionBanner;
}

export function useWebSocket(
  sessionId: string,
  onMessage: (msg: WSMessage) => void,
  enabled: boolean = true
): UseWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const pendingSendRef = useRef<string[]>([]);
  const retriesRef = useRef(0);
  const enabledRef = useRef(enabled);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionBanner, setConnectionBanner] = useState<ConnectionBanner>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  enabledRef.current = enabled;

  const flushPending = useCallback((ws: WebSocket) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const q = pendingSendRef.current;
    while (q.length) {
      const next = q.shift();
      if (next !== undefined) ws.send(next);
    }
  }, []);

  const clearBannerTimer = useCallback(() => {
    if (bannerTimerRef.current !== null) {
      clearTimeout(bannerTimerRef.current);
      bannerTimerRef.current = null;
    }
  }, []);

  const scheduleShowRecoveringBanner = useCallback(() => {
    clearBannerTimer();
    bannerTimerRef.current = window.setTimeout(() => {
      bannerTimerRef.current = null;
      if (!enabledRef.current) return;
      if (wsRef.current?.readyState === WebSocket.OPEN) return;
      setConnectionBanner("recovering");
    }, BANNER_AFTER_MS);
  }, [clearBannerTimer]);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const host = window.location.host;
    const url = `${protocol}://${host}/ws/${sessionId}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      clearBannerTimer();
      setIsConnected(true);
      setConnectionBanner(null);
      retriesRef.current = 0;
      flushPending(ws);

      if ("geolocation" in navigator) {
        navigator.geolocation.getCurrentPosition(
          async (pos) => {
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;
            let zip = "10001";
            try {
              const res = await fetch(
                `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
                { headers: { "Accept-Language": "en" } }
              );
              const geo = await res.json();
              zip = geo.address?.postcode?.split("-")[0] ?? "10001";
            } catch {
              /* fall back to 10001 */
            }
            ws.send(JSON.stringify({ type: "location", lat, lng, zip }));
          },
          () => {},
          { timeout: 5000 }
        );
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WSMessage;
        onMessageRef.current(msg);
      } catch {
        /* ignore */
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      if (!enabledRef.current) {
        pendingSendRef.current = [];
        return;
      }

      const willRetry = retriesRef.current < MAX_RETRIES;
      // Keep queued messages (e.g. `ready`) so the next socket can flush them — clearing here
      // caused "Begin session" with no `saw_ready` after a brief disconnect or slow handshake.
      if (!willRetry) pendingSendRef.current = [];

      if (willRetry) {
        scheduleShowRecoveringBanner();
        const delay = BACKOFF_BASE_MS * Math.pow(2, retriesRef.current);
        retriesRef.current += 1;
        setTimeout(connect, delay);
      } else {
        clearBannerTimer();
        setConnectionBanner("failed");
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [sessionId, clearBannerTimer, scheduleShowRecoveringBanner, flushPending]);

  useEffect(() => {
    if (!enabled) {
      clearBannerTimer();
      retriesRef.current = MAX_RETRIES;
      pendingSendRef.current = [];
      wsRef.current?.close();
      wsRef.current = null;
      setIsConnected(false);
      setConnectionBanner(null);
      return;
    }

    retriesRef.current = 0;
    connect();

    return () => {
      clearBannerTimer();
      retriesRef.current = MAX_RETRIES;
      wsRef.current?.close();
    };
  }, [connect, enabled, clearBannerTimer]);

  const send = useCallback((msg: object): boolean => {
    const raw = JSON.stringify(msg);
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(raw);
      return true;
    }
    const q = pendingSendRef.current;
    q.push(raw);
    while (q.length > MAX_PENDING_SEND) q.shift();
    return false;
  }, []);

  return { send, isConnected, connectionBanner };
}
