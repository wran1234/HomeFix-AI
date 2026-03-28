import { useEffect, useRef } from "react";
import { BBox } from "../types";

interface Props {
  bbox: BBox | null;
  width: number;
  height: number;
}

const INK = "rgba(13, 12, 11, 0.78)";
const ACCENT = "#c45c26";
const DANGER = "#b84740";
const LABEL_TEXT = "#f5ece4";

/**
 * Annotation overlay on the live camera. Bbox coords are normalized 0–1.
 */
export function CanvasOverlay({ bbox, width, height }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);

    if (!bbox) return;

    const [nx, ny, nw, nh] = bbox.bbox;
    const x = nx * width;
    const y = ny * height;
    const w = nw * width;
    const h = nh * height;
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
  }, [bbox, width, height]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    />
  );
}
