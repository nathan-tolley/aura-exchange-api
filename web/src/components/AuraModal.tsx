import { useState, type FormEvent } from "react";
import { api, type Stock } from "../api";
import { SparkIcon } from "../icons";

export function AuraModal({ stocks, ownStockId, onClose, onSubmitted }: {
  stocks: Stock[]; ownStockId: string | null; onClose: () => void; onSubmitted: () => Promise<void>;
}) {
  const eligible = stocks.filter((stock) => stock.id !== ownStockId);
  const [subjectId, setSubjectId] = useState(eligible[0]?.id ?? "");
  const [explanation, setExplanation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await api("/api/aura-events", { method: "POST", body: JSON.stringify({ subjectId, explanation }) });
      await onSubmitted(); onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Submission failed"); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="modal-card aura-modal">
      <button className="icon-button drawer-close" onClick={onClose}>×</button>
      <div className="modal-icon"><SparkIcon /></div>
      <p className="eyebrow">FILE AN AURA EVENT</p>
      <h2>What happened?</h2>
      <p>The judge scores the moment, not the person. Your name stays hidden from the public feed. You can file 10 events per 24 hours, with at most 2 about the same person.</p>
      <form onSubmit={submit}>
        <label>Who is this about?<select value={subjectId} onChange={(event) => setSubjectId(event.target.value)}>
          {eligible.map((stock) => <option value={stock.id} key={stock.id}>${stock.ticker} · {stock.displayName}</option>)}
        </select></label>
        <label>Tell the tape<textarea value={explanation} onChange={(event) => setExplanation(event.target.value)} minLength={8} maxLength={800} required placeholder="They joined a client call muted, gave a three-minute speech, then realized…" /></label>
        <div className="char-count">{explanation.length}/800</div>
        {error && <div className="form-error">{error}</div>}
        <button className="button primary full" disabled={busy || !subjectId}>{busy ? "Sending to the judge…" : "Submit anonymously"}</button>
      </form>
    </section>
  </div>;
}

