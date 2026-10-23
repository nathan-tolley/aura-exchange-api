import { useState, type FormEvent } from "react";
import { api, type FeedItem } from "../api";
import { ArrowIcon, BoltIcon, FeedIcon, ShieldIcon, SparkIcon } from "../icons";

function relativeTime(value: string) {
  const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds/60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds/3600)}h`;
  return `${Math.floor(seconds/86400)}d`;
}

export function FeedView({ items, ownStockId, onAuraClick, refresh }: {
  items: FeedItem[]; ownStockId: string | null; onAuraClick: () => void; refresh: () => Promise<void>;
}) {
  const [filter, setFilter] = useState("ALL");
  const shown = items.filter((item) => filter === "ALL" || (filter === "AURA" ? item.kind.startsWith("AURA") : item.kind === "TRADE"));
  return <section className="page-content">
    <header className="page-heading"><div><p className="eyebrow">THE GLOBAL TAPE</p><h1>Floor activity</h1><p>Rulings, positions, and market chaos in one stream.</p></div><button className="button primary" onClick={onAuraClick}><SparkIcon /> File aura</button></header>
    <div className="feed-toolbar segmented"><button className={filter==="ALL"?"active":""} onClick={()=>setFilter("ALL")}>All</button><button className={filter==="AURA"?"active":""} onClick={()=>setFilter("AURA")}>Aura</button><button className={filter==="TRADE"?"active":""} onClick={()=>setFilter("TRADE")}>Trades</button></div>
    <div className="feed-list">
      {shown.length === 0 && <Empty icon={<FeedIcon />} title="The tape is quiet" text="File the first Aura event or execute a trade." />}
      {shown.map((item) => <FeedCard key={item.id} item={item} ownStockId={ownStockId} refresh={refresh} />)}
    </div>
  </section>;
}

function FeedCard({ item, ownStockId, refresh }: { item: FeedItem; ownStockId: string | null; refresh: () => Promise<void> }) {
  const delta = Number(item.payload.delta ?? 0);
  const isAura = item.kind === "AURA_RULING";
  const isTrade = item.kind === "TRADE";
  const [appealing, setAppealing] = useState(false);
  async function appeal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "");
    await api(`/api/aura-events/${item.payload.submissionId}/appeal`, { method: "POST", body: JSON.stringify({ reason }) });
    setAppealing(false); await refresh();
  }
  return <article className={`feed-card ${isAura ? (delta >= 0 ? "gain" : "loss") : ""}`}>
    <div className="feed-card-icon">{isAura ? <SparkIcon /> : isTrade ? <ArrowIcon /> : item.kind.includes("APPEAL") ? <ShieldIcon /> : <BoltIcon />}</div>
    <div className="feed-card-body">
      <div className="feed-meta"><b>{item.actor.displayName}</b><span>·</span><span>{relativeTime(item.createdAt)}</span><span className="feed-kind">{item.kind.replaceAll("_"," ")}</span></div>
      {isAura && <>
        <h3><span>${item.subject?.ticker}</span> {String(item.payload.explanation)}</h3>
        <blockquote>“{String(item.payload.rationale)}”</blockquote>
        <div className={`aura-delta ${delta >= 0 ? "positive" : "negative"}`}>{delta >= 0 ? "+" : ""}{delta} AURA</div>
        {item.subject?.id === ownStockId && !appealing && <button className="text-button" onClick={() => setAppealing(true)}>Appeal ruling</button>}
        {appealing && <form className="inline-appeal" onSubmit={appeal}><input name="reason" minLength={8} maxLength={800} required placeholder="Why should this be reviewed?"/><button className="button small">Send</button></form>}
      </>}
      {isTrade && <h3><b>{item.actor.displayName}</b> {String(item.payload.side).toLowerCase()}ed <span>{Number(item.payload.quantity).toFixed(2)} ${item.subject?.ticker}</span> at {Number(item.payload.price).toFixed(2)} AC</h3>}
      {item.kind === "MEMBER_JOINED" && <h3><span>${item.subject?.ticker}</span> listed on the exchange.</h3>}
      {item.kind === "ALLOWANCE" && <h3>The weekly bell paid every trader <span>{String(item.payload.amount)} AC</span>.</h3>}
      {item.kind === "AURA_APPEALED" && <h3><span>${item.subject?.ticker}</span> challenged an Aura ruling.</h3>}
      {item.kind === "SEASON_STARTED" && <h3>A new market season is officially open.</h3>}
    </div>
  </article>;
}

export function Empty({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return <div className="empty-state"><div>{icon}</div><h3>{title}</h3><p>{text}</p></div>;
}

