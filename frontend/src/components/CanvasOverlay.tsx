import { useEffect, useRef, useState } from "react";
import { BBox } from "../types";

interface Props {
  bbox: BBox | null;
}

const INK = "rgba(13, 12, 11, 0.78)";
const ACCENT = "#c45c26";
const DANGER = "#b84740";
const LABEL_TEXT = "#f5ece4";

/**
 * Annotation overlay on the live camera. Bbox coords are normalized 0–1.
 * Sizes itself to match its rendered container via ResizeObserver.
 */
export function CanvasOverlay({ bbox }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 640, h: 480 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setSize({ w: Math.round(width), h: Math.round(height) });
        }
      }
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, size.w, size.h);

    if (!bbox) return;

    const [nx, ny, nw, nh] = bbox.bbox;
    const x = nx * size.w;
    const y = ny * size.h;
    const w = nw * size.w;
    const h = nh * size.h;
    const stroke = bbox.color === "red" ? DANGER : ACCENT;

    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);

    const labelPad = 7;
    const fontSize = 12;
    ctx.font = `600 ${fontSize}px Outfit, system-ui, sans-serif`;
    const tw = ctx.measureText(bbox.label).width;
    const labelH = fontSize + labelPad * 2;
    const labelY = Math.max(0, y - labelH);

    ctx.fillStyle = bbox.color === "red" ? "rgba(184, 71, 64, 0.92)" : INK;
    ctx.fillRect(x, labelY, tw + labelPad * 2, labelH);

    ctx.fillStyle = LABEL_TEXT;
    ctx.fillText(bbox.label, x + labelPad, labelY + fontSize + (labelH - fontSize) / 2 - 3);
  }, [bbox, size]);

  return (
    <canvas
      ref={canvasRef}
      width={size.w}
      height={size.h}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        zIndex: 1,
        pointerEvents: "none",
      }}
    />
  );
}
