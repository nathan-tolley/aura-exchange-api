import { useMemo, useState } from "react";
import { api, money, signed, type Portfolio, type Stock } from "../api";
import { ArrowIcon } from "../icons";

type Side = "BUY" | "SELL" | "SHORT" | "COVER";

export function TradePanel({ stock, portfolio, ownStockId, onClose, onTraded }: {
  stock: Stock;
  portfolio: Portfolio | null;
  ownStockId: string | null;
  onClose: () => void;
  onTraded: () => Promise<void>;
}) {
  const [side, setSide] = useState<Side>("BUY");
  const [quantity, setQuantity] = useState("1");
  const [quote, setQuote] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const position = useMemo(() => portfolio?.positions.find((item) => item.stockId === stock.id), [portfolio, stock.id]);
  const disabled = ownStockId === stock.id;

  async function getQuote() {
    setBusy(true); setError(""); setQuote(null);
    try {
      const result = await api<Record<string, string>>("/api/trades/quote", {
        method: "POST", body: JSON.stringify({ stockId: stock.id, side, quantity: Number(quantity) })
      });
      setQuote(result);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Quote failed"); }
    finally { setBusy(false); }
  }

  async function execute() {
    if (!quote) return;
    setBusy(true); setError("");
    try {
      await api("/api/trades/execute", { method: "POST", body: JSON.stringify({
        quoteId: quote.id, idempotencyKey: crypto.randomUUID()
      }) });
      await onTraded(); onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Trade failed"); setQuote(null); }
    finally { setBusy(false); }
  }

  return <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside className="trade-drawer">
      <button className="icon-button drawer-close" onClick={onClose} aria-label="Close">×</button>
      <div className="stock-identity large">
        <span className="avatar">{stock.displayName.split(" ").map((part) => part[0]).join("").slice(0,2)}</span>
        <div><span className="ticker">${stock.ticker}</span><h2>{stock.displayName}</h2></div>
      </div>
      <div className="drawer-quote"><strong>{money(stock.price)} AC</strong><span className={stock.dayChangePct >= 0 ? "positive" : "negative"}>{signed(stock.dayChangePct, "%")} today</span></div>
      <div className="segmented four">
        {(["BUY","SELL","SHORT","COVER"] as Side[]).map((item) => <button key={item} className={side===item ? "active" : ""} onClick={() => { setSide(item); setQuote(null); }}>{item}</button>)}
      </div>
      <div className="position-summary">
        <span>Available cash <b>{money(portfolio?.cash ?? 0)} AC</b></span>
        <span>Position <b>{position ? `${position.longQty || position.shortQty} ${position.longQty ? "long" : "short"}` : "None"}</b></span>
      </div>
      <label className="quantity-field">Shares<input value={quantity} onChange={(event) => { setQuantity(event.target.value); setQuote(null); }} inputMode="decimal" /></label>
      {disabled && <div className="form-error">You cannot trade your own Aura stock.</div>}
      {error && <div className="form-error">{error}</div>}
      {quote && <div className="quote-ticket">
        <div><span>Market price</span><b>{money(Number(quote.currentPrice))} AC</b></div>
        <div><span>Execution price</span><b>{money(Number(quote.executionPrice))} AC</b></div>
        <div><span>Price impact</span><b>{(Number(quote.priceImpact)*100).toFixed(2)}%</b></div>
        <div><span>Trading fee</span><b>{money(Number(quote.feeAmount))} AC</b></div>
        <div className="quote-total"><span>{side === "SELL" || side === "SHORT" ? "Estimated proceeds" : "Estimated cost"}</span><b>{money(Number(quote.netAmount))} AC</b></div>
        <p>Quote locks for 15 seconds and executes only if the pool has not moved.</p>
      </div>}
      {!quote ? <button className="button primary full" onClick={getQuote} disabled={busy || disabled}>{busy ? "Quoting…" : "Preview order"} <ArrowIcon /></button>
        : <button className={`button full ${side === "SHORT" ? "danger" : "primary"}`} onClick={execute} disabled={busy}>{busy ? "Executing…" : `Confirm ${side.toLowerCase()}`}</button>}
      {side === "SHORT" && <p className="risk-note">Shorts require 150% collateral, accrue a 0.1% daily borrow fee, and liquidate below 125% maintenance.</p>}
    </aside>
  </div>;
}

