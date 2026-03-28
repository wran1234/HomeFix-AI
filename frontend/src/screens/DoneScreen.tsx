interface Props {
  issue: string | null;
  onRestart: () => void;
}

const MESSAGES = [
  "You just saved yourself a service call.",
  "That's one less thing to worry about.",
  "Nice work — your home is better for it.",
  "Fixed it yourself. That's the move.",
  "One repair down. You've got this.",
];

function pickMessage(): string {
  return MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
}

export function DoneScreen({ issue, onRestart }: Props) {
  const message = pickMessage();

  return (
    <div className="hf-done">
      <div className="hf-done__content">
        <div className="hf-done__check" aria-hidden>✓</div>
        <h1 className="hf-done__headline">All done.</h1>
        <p className="hf-done__message">{message}</p>
        {issue && <p className="hf-done__issue">{issue}</p>}
      </div>

      <div className="hf-done__actions">
        <button type="button" className="hf-btn-primary" onClick={onRestart}>
          Fix something else
        </button>
      </div>
    </div>
  );
}
