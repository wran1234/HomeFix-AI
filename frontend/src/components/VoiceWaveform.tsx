import { useEffect, useRef } from "react";

interface Props {
  isActive: boolean;
  /** Accessible name */
  label?: string;
}

/** Voice activity indicator — subtle bars, copper accent when speaking. */
export function VoiceWaveform({ isActive, label = "Voice output" }: Props) {
  const barsRef = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    if (!isActive) {
      barsRef.current.forEach((b) => {
        if (b) b.style.height = "4px";
      });
      return;
    }

    const ids = barsRef.current.map((bar, i) => {
      if (!bar) return 0;
      const animate = () => {
        const h = 5 + Math.random() * 18;
        bar.style.height = `${h}px`;
      };
      return window.setInterval(animate, 85 + i * 22);
    });

    return () => ids.forEach((tid) => clearInterval(tid));
  }, [isActive]);

  return (
    <div className="hf-voice" role="status" aria-live="polite" aria-label={label}>
      {Array.from({ length: 10 }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            barsRef.current[i] = el;
          }}
          className="hf-voice__bar"
          style={{
            height: 4,
            background: isActive ? "var(--hf-accent)" : "var(--hf-surface-2)",
          }}
        />
      ))}
    </div>
  );
}
