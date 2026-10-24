import { useCallback, useEffect, useMemo, useState } from "react";
import { api, money, setCsrf, signed, type CompositeStock, type FeedItem, type Market, type Portfolio, type Stock, type User } from "./api";
import { AdminIcon, BoltIcon, ExchangeIcon, FeedIcon, PortfolioIcon, SparkIcon, TrophyIcon } from "./icons";
import { AuthScreen } from "./components/AuthScreen";
import { TradePanel } from "./components/TradePanel";
import { AuraModal } from "./components/AuraModal";
import { FeedView, Empty } from "./components/FeedView";
import { AdminView } from "./components/AdminView";
import { StockHistoryPanel } from "./components/StockHistoryPanel";
import { AuraFarmingView } from "./components/AuraFarmingView";
import { CompositeStockPanel } from "./components/CompositeStockPanel";
import {DerivativesView} from "./components/DerivativesView";

type Page = "exchange" | "feed" | "farming" | "derivatives" | "portfolio" | "leaders" | "notifications" | "account" | "admin";

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<Page>("exchange");
  const [market, setMarket] = useState<Market>({ stocks: [], auraComposite: 100, marketIndex: 100 });
  const [composite,setComposite]=useState<CompositeStock>({ticker:"AURA",name:"Aura Composite",current:100,open:100,high:100,low:100,change:0,points:[]});
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [selectedStock, setSelectedStock] = useState<Stock | null>(null);
  const [auraOpen, setAuraOpen] = useState(false);
  const [error, setError] = useState("");
  const [targetFeedId, setTargetFeedId] = useState<string | null>(null);
  const [notificationCount,setNotificationCount]=useState(0);

  const openFeedEvent = useCallback((eventId: string) => { setTargetFeedId(eventId); setPage("feed"); }, []);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("chatgpt") !== "connected") return;
    window.opener?.postMessage({ type: "aura-chatgpt-connected" }, window.location.origin);
    if (window.opener) window.close();
    else { setPage("admin"); window.history.replaceState({}, "", "/"); }
  }, []);

  const loadSession = useCallback(async () => {
    try {
      const result = await api<{ user: User }>("/api/auth/session");
      setCsrf(result.user.csrfToken); setUser(result.user);
    } catch { setUser(null); }
    finally { setLoading(false); }
  }, []);

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const [marketData, portfolioData, feedData,compositeData,notificationData] = await Promise.all([
        api<Market>("/api/market"), api<Portfolio>("/api/portfolio"), api<{ items: FeedItem[] }>("/api/feed"),api<CompositeStock>("/api/composite"),api<{unread:number}>("/api/notifications")
      ]);
      setMarket({...marketData,stocks:Array.isArray(marketData.stocks)?marketData.stocks:[]}); setPortfolio(portfolioData); setFeed(Array.isArray(feedData.items)?feedData.items:[]);setComposite({...compositeData,points:Array.isArray(compositeData.points)?compositeData.points:[]});setNotificationCount(Number(notificationData.unread??0)); setError("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not refresh the exchange"); }
  }, [user]);

  useEffect(() => { loadSession(); }, [loadSession]);
  useEffect(() => {
    if (!user) return;
    refresh();
    const interval = window.setInterval(refresh, 15_000);
    return () => window.clearInterval(interval);
  }, [user, refresh]);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    setUser(null); setMarket({ stocks: [], auraComposite: 100, marketIndex: 100 });
  }

  if (loading) return <div className="app-loading"><span className="brand-mark"><BoltIcon /></span><p>Opening the floor…</p></div>;
  if (!user) return <AuthScreen onAuthenticated={loadSession} />;

  const elevated = user.role === "OWNER" || user.role === "MODERATOR";
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><BoltIcon /></span><span>AURA<br/><b>EXCHANGE</b></span></div>
      <nav>
        <NavButton active={page==="exchange"} onClick={()=>setPage("exchange")} icon={<ExchangeIcon />} label="Exchange" />
        <NavButton active={page==="feed"} onClick={()=>setPage("feed")} icon={<FeedIcon />} label="Global tape" badge={(feed??[]).filter((item)=>item.kind==="AURA_RULING").length || undefined} />
        <NavButton active={page==="farming"} onClick={()=>setPage("farming")} icon={<SparkIcon />} label="Aura Farming" />
        <NavButton active={page==="derivatives"} onClick={()=>setPage("derivatives")} icon={<BoltIcon/>} label="Contracts" />
        <NavButton active={page==="portfolio"} onClick={()=>setPage("portfolio")} icon={<PortfolioIcon />} label="Portfolio" />
        <NavButton active={page==="leaders"} onClick={()=>setPage("leaders")} icon={<TrophyIcon />} label="Leaderboards" />
        <NavButton active={page==="notifications"} onClick={()=>setPage("notifications")} icon={<BoltIcon />} label="Notifications" badge={notificationCount||undefined}/>
        {elevated && <><div className="nav-divider"/><NavButton active={page==="admin"} onClick={()=>setPage("admin")} icon={<AdminIcon />} label="Operations" /></>}
      </nav>
      <div className="season-card"><span>SEASON 01</span><strong>Market is open</strong><div><i/><small>8-week competition</small></div></div>
      <div className="sidebar-user"><button className="avatar small account-avatar" onClick={()=>setPage("account")} title="Account and sessions">{(user.displayName ?? user.username).slice(0,2).toUpperCase()}</button><span><b>{user.displayName ?? user.username}</b><small>{user.ticker ? `$${user.ticker}` : user.role}</small></span><button onClick={logout} title="Sign out">↗</button></div>
    </aside>

    <main className="main-stage">
      {window.location.protocol!=="https:"&&window.location.hostname!=="localhost"&&window.location.hostname!=="127.0.0.1"&&<div className="transport-warning"><b>Temporary insecure pilot:</b> this connection is HTTP. Do not reuse a work or personal password.</div>}
      <div className="pilot-banner"><b>PILOT MODE</b><span>Fictional credits · trusted participants only · rules and balances may be tuned before Season 1</span></div>
      <div className="mobile-top"><div className="brand"><span className="brand-mark"><BoltIcon /></span><b>AURA EXCHANGE</b></div><button className="button primary small" onClick={()=>setAuraOpen(true)}><SparkIcon/> File aura</button></div>
      {error && <div className="system-error">{error}</div>}
      {page === "exchange" && <ExchangePage market={market} composite={composite} portfolio={portfolio} onSelect={setSelectedStock} onAura={()=>setAuraOpen(true)} feed={feed.slice(0,4)} onOpenFeedEvent={openFeedEvent} />}
      {page === "feed" && <FeedView items={feed} ownStockId={user.stockId} onAuraClick={()=>setAuraOpen(true)} refresh={refresh} targetEventId={targetFeedId} onTargetHandled={()=>setTargetFeedId(null)} />}
      {page === "farming" && <AuraFarmingView ownStockId={user.stockId} onReward={refresh} />}
      {page === "derivatives" && <DerivativesView stocks={market.stocks} ownStockId={user.stockId} elevated={elevated} onChanged={refresh}/>}
      {page === "portfolio" && <PortfolioPage portfolio={portfolio} onSelect={(id)=>setSelectedStock(market.stocks.find((stock)=>stock.id===id) ?? null)} />}
      {page === "leaders" && <LeaderboardsPage />}
      {page === "notifications" && <NotificationsPage onRead={refresh}/>}
      {page === "account" && <AccountPage onSignedOut={()=>setUser(null)} />}
      {page === "admin" && elevated && <AdminView />}
    </main>

    <nav className="mobile-nav">
      <NavButton active={page==="exchange"} onClick={()=>setPage("exchange")} icon={<ExchangeIcon />} label="Market" />
      <NavButton active={page==="feed"} onClick={()=>setPage("feed")} icon={<FeedIcon />} label="Tape" />
      <NavButton active={page==="farming"} onClick={()=>setPage("farming")} icon={<SparkIcon />} label="Farm" />
      <NavButton active={page==="derivatives"} onClick={()=>setPage("derivatives")} icon={<BoltIcon />} label="Contracts" />
      <NavButton active={page==="portfolio"} onClick={()=>setPage("portfolio")} icon={<PortfolioIcon />} label="Portfolio" />
      <NavButton active={page==="leaders"} onClick={()=>setPage("leaders")} icon={<TrophyIcon />} label="Ranks" />
    </nav>
    {selectedStock && <TradePanel stock={selectedStock} portfolio={portfolio} ownStockId={user.stockId} onClose={()=>setSelectedStock(null)} onTraded={refresh} />}
    {auraOpen && <AuraModal stocks={market.stocks} ownStockId={user.stockId} onClose={()=>setAuraOpen(false)} onSubmitted={refresh} />}
  </div>;
}

function NavButton({ active, onClick, icon, label, badge }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; badge?: number }) {
  return <button className={active ? "nav-button active" : "nav-button"} onClick={onClick}>{icon}<span>{label}</span>{badge && <em>{badge}</em>}</button>;
}

function ExchangePage({ market,composite, portfolio, onSelect, onAura, feed, onOpenFeedEvent }: {
  market: Market;composite:CompositeStock; portfolio: Portfolio | null; onSelect: (stock: Stock) => void; onAura: () => void; feed: FeedItem[]; onOpenFeedEvent: (eventId: string) => void;
}) {
  const sorted = useMemo(() => [...market.stocks].sort((a,b)=>b.dayChangePct-a.dayChangePct), [market.stocks]);
  const [expandedStockId, setExpandedStockId] = useState<string | null>(null);
  const top = sorted[0];
  return <section className="page-content exchange-page">
    <header className="page-heading"><div><p className="eyebrow">THURSDAY · MARKET OPEN</p><h1>Good evening, trader.</h1><p>The office is volatile. Position accordingly.</p></div><button className="button primary desktop-action" onClick={onAura}><SparkIcon /> File aura</button></header>
    <div className="ticker-tape"><span className="live-dot">LIVE</span>{market.stocks.slice(0,7).map((stock)=><button key={stock.id} onClick={()=>onSelect(stock)}><b>${stock.ticker}</b><span>{money(stock.price)}</span><em className={stock.dayChangePct>=0?"positive":"negative"}>{signed(stock.dayChangePct,"%")}</em></button>)}</div>
    <CompositeStockPanel stock={composite}/>
    <div className="metric-grid">
      <MetricCard label="AURA COMPOSITE" value={market.auraComposite.toFixed(2)} change={market.auraComposite-100} caption="Collective office aura" accent="amber" />
      <MetricCard label="MARKET INDEX" value={market.marketIndex.toFixed(2)} change={market.marketIndex-100} caption="Trader sentiment" accent="mint" />
      <MetricCard label="YOUR EQUITY" value={`${money(portfolio?.equity ?? 0)} AC`} change={(portfolio?.equity ?? 10000)-10000} caption={`${money(portfolio?.cash ?? 0)} available`} accent="blue" />
      <MetricCard label="TOP MOVER" value={top ? `$${top.ticker}` : "—"} change={top?.dayChangePct ?? 0} caption={top?.displayName ?? "Waiting for listings"} accent="coral" />
    </div>
    <div className="exchange-grid">
      <section className="panel market-panel"><div className="panel-heading"><div><p className="eyebrow">ALL LISTINGS</p><h2>The board</h2></div><span>{market.stocks.length} active</span></div>
        <div className="market-table"><div className="market-head"><span>Stock</span><span>Aura</span><span>Price</span><span>Today</span><span/></div>
          {market.stocks.length===0 && <Empty icon={<ExchangeIcon/>} title="No active listings" text="Claim a stock or add someone in Operations."/>}
          {market.stocks.map((stock)=><div className="stock-listing" key={stock.id}>
            <div className="market-row" role="button" tabIndex={0} aria-expanded={expandedStockId===stock.id} onClick={()=>setExpandedStockId(expandedStockId===stock.id?null:stock.id)} onKeyDown={(event)=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();setExpandedStockId(expandedStockId===stock.id?null:stock.id)}}}>
              <span className="stock-identity"><i className="avatar">{stock.displayName.split(" ").map((p)=>p[0]).join("").slice(0,2)}</i><span><b>${stock.ticker}</b><small>{stock.displayName} · {expandedStockId===stock.id?"Hide chart":"View chart"}</small></span></span>
              <span className="aura-number"><SparkIcon/>{stock.aura}</span><b>{money(stock.price)}</b><span className={stock.dayChangePct>=0?"positive":"negative"}>{signed(stock.dayChangePct,"%")}</span><button className="trade-link" onClick={(event)=>{event.stopPropagation();onSelect(stock)}}>Trade →</button>
            </div>
            {expandedStockId===stock.id && <StockHistoryPanel stockId={stock.id} onOpenFeedEvent={onOpenFeedEvent}/>} 
          </div>)}
        </div>
      </section>
      <section className="panel pulse-panel"><div className="panel-heading"><div><p className="eyebrow">MARKET PULSE</p><h2>Latest tape</h2></div><FeedIcon/></div>
        <div className="mini-feed">{feed.length===0 && <p className="muted">Nothing on the tape yet.</p>}{feed.map((item)=>{const delta=item.votes?.effectiveDelta??Number(item.payload.delta);return <div key={item.id}><span className={`mini-icon ${item.kind==='AURA_RULING'?'aura':''}`}>{item.kind==='AURA_RULING'?<SparkIcon/>:<BoltIcon/>}</span><p>{item.kind==='AURA_RULING'?<><b>${item.subject?.ticker}</b> moved <strong className={delta>=0?"positive":"negative"}>{delta>=0?"+":""}{delta} aura</strong></>:item.kind==='TRADE'?<><b>{item.actor.displayName}</b> {String(item.payload.side).toLowerCase()}ed <strong>${item.subject?.ticker}</strong></>:<>{item.kind.replaceAll("_"," ").toLowerCase()}</>}<small>{new Date(item.createdAt).toLocaleTimeString([], {hour:"numeric",minute:"2-digit"})}</small></p></div>})}</div>
      </section>
    </div>
  </section>;
}

function MetricCard({ label, value, change, caption, accent }: { label:string; value:string; change:number; caption:string; accent:string }) {
  return <article className={`metric-card ${accent}`}><span>{label}</span><strong>{value}</strong><div><em className={change>=0?"positive":"negative"}>{signed(change)}</em><small>{caption}</small></div><svg viewBox="0 0 120 38" preserveAspectRatio="none"><path d={change>=0?"M0 31 C18 27, 24 34, 38 24 S61 29, 74 17 S97 22,120 6":"M0 8 C18 12,24 5,38 15 S61 10,74 21 S97 18,120 33"}/></svg></article>;
}

function PortfolioPage({ portfolio, onSelect }: { portfolio: Portfolio | null; onSelect: (id:string)=>void }) {
  return <section className="page-content"><header className="page-heading"><div><p className="eyebrow">YOUR BOOK</p><h1>Portfolio</h1><p>Long conviction, short skepticism, fully fictional consequences.</p></div></header>
    <div className="portfolio-hero"><div><span>NET LIQUIDATION VALUE</span><strong>{money(portfolio?.equity ?? 0)} <small>AC</small></strong><em className={(portfolio?.equity ?? 10000)>=10000?"positive":"negative"}>{signed((portfolio?.equity??10000)-10000)} this season</em></div><div className="allocation"><span style={{"--size": `${Math.min(100,((portfolio?.longValue??0)/(portfolio?.equity||1))*100)}%`} as React.CSSProperties}/><p><b>{money(portfolio?.cash??0)}</b> cash<small>{money(portfolio?.longValue??0)} long · {money(portfolio?.shortLiability??0)} short</small></p></div></div>
    <section className="panel"><div className="panel-heading"><div><p className="eyebrow">OPEN POSITIONS</p><h2>Exposure</h2></div></div>
      <div className="positions-table">{!portfolio?.positions.length && <Empty icon={<PortfolioIcon/>} title="All cash" text="Open a listing from the exchange to make your first trade."/>}{portfolio?.positions.map((position)=><button key={position.id} onClick={()=>onSelect(position.stockId)}><span><b>${position.ticker}</b><small>{position.displayName}</small></span><span><small>{position.longQty>0?"LONG":"SHORT"}</small><b>{position.longQty||position.shortQty} shares</b></span><span><small>MARK</small><b>{money(position.price)} AC</b></span><span><small>UNREALIZED</small><b className={position.unrealizedPnl>=0?"positive":"negative"}>{signed(position.unrealizedPnl)} AC</b></span><em>Manage →</em></button>)}</div>
    </section>
  </section>;
}

function LeaderboardsPage() {
  const [boards,setBoards]=useState<{aura:any[];wealth:any[]}>({aura:[],wealth:[]});
  useEffect(()=>{api<{aura:any[];wealth:any[]}>("/api/leaderboards").then(setBoards)},[]);
  return <section className="page-content"><header className="page-heading"><div><p className="eyebrow">THE STANDINGS</p><h1>Leaderboards</h1><p>Bragging rights expire at the closing bell.</p></div></header><div className="leader-grid">
    <Board title="Aura elite" subtitle="Seasonal social index" rows={boards.aura.map((row)=>({name:row.display_name,ticker:row.ticker,value:`${row.seasonal_aura} AURA`}))}/>
    <Board title="Market makers" subtitle="Marked portfolio equity" rows={boards.wealth.map((row)=>({name:row.display_name,ticker:row.ticker,value:`${money(Number(row.net_worth))} AC`}))}/>
  </div></section>;
}
interface LoginSession {id:string;user_agent:string|null;ip_address:string|null;created_at:string;last_seen_at:string;expires_at:string;is_current:boolean}
interface UserNotification {id:string;kind:string;payload:Record<string,unknown>;read_at:string|null;created_at:string}
function NotificationsPage({onRead}:{onRead:()=>Promise<void>}){
  const [items,setItems]=useState<UserNotification[]>([]),[error,setError]=useState("");
  const load=useCallback(()=>api<{items:UserNotification[]}>("/api/notifications").then((result)=>setItems(result.items)).catch((caught)=>setError(caught instanceof Error?caught.message:"Could not load notifications")),[]);
  useEffect(()=>{void load()},[load]);
  async function read(item:UserNotification){if(item.read_at)return;try{await api(`/api/notifications/${item.id}/read`,{method:"POST",body:"{}"});await Promise.all([load(),onRead()])}catch(caught){setError(caught instanceof Error?caught.message:"Could not update notification")}}
  return <section className="page-content"><header className="page-heading"><div><p className="eyebrow">YOUR ALERTS</p><h1>Notifications</h1><p>Rulings, filled orders, farming rewards, and risk events.</p></div></header>{error&&<div className="form-error">{error}</div>}<section className="panel notification-list">{!items.length&&<div className="empty-compact">No notifications yet.</div>}{items.map((item)=><button key={item.id} className={item.read_at?"notification-row":"notification-row unread"} onClick={()=>read(item)}><i/><span><b>{item.kind.replaceAll("_"," ").toLowerCase()}</b><small>{notificationText(item)}</small><em>{new Date(item.created_at).toLocaleString()}</em></span></button>)}</section></section>
}
function notificationText(item:UserNotification){const p=item.payload;if(item.kind==="AURA_RULING")return `${Number(p.delta)>=0?"+":""}${p.delta} Aura · ${p.rationale}`;if(item.kind==="LIMIT_ORDER_FILLED")return `${p.side} ${p.quantity} shares at ${p.price} AC`;if(item.kind==="FARMING_REWARD")return `Participation reward: +${p.aura} Aura and +${p.credits} AC`;if(item.kind==="FARMING_RESOLVED")return `Community outcome: ${p.outcome}`;if(item.kind==="SHORT_LIQUIDATED")return `${p.quantity} shares covered automatically at ${p.price} AC`;if(item.kind==="PREDICTION_RESOLVED")return `Prediction result: ${p.outcome}`;if(item.kind==="OPTION_SETTLED")return `${p.type} settled at ${money(Number(p.settlementPrice))} AC · payout ${money(Number(p.payout))} AC`;return "Account activity update"}
function AccountPage({onSignedOut}:{onSignedOut:()=>void}){
  const [sessions,setSessions]=useState<LoginSession[]>([]),[error,setError]=useState("");
  const load=useCallback(()=>api<{items:LoginSession[]}>("/api/auth/sessions").then((result)=>setSessions(result.items)).catch((caught)=>setError(caught instanceof Error?caught.message:"Could not load sessions")),[]);
  useEffect(()=>{void load()},[load]);
  async function revoke(session:LoginSession){try{const result=await api<{signedOut:boolean}>(`/api/auth/sessions/${session.id}/revoke`,{method:"POST",body:"{}"});if(result.signedOut)onSignedOut();else await load()}catch(caught){setError(caught instanceof Error?caught.message:"Could not revoke session")}}
  return <section className="page-content"><header className="page-heading"><div><p className="eyebrow">ACCOUNT SECURITY</p><h1>Active sessions</h1><p>Review the devices signed in to your Aura Exchange account.</p></div></header>{error&&<div className="form-error">{error}</div>}<section className="panel session-list"><div className="panel-heading"><div><p className="eyebrow">ACCESS</p><h2>{sessions.length} active session{sessions.length===1?"":"s"}</h2></div></div>{sessions.map((session)=><div className="session-row" key={session.id}><span><b>{session.is_current?"This device":"Signed-in device"}</b><small>{session.user_agent??"Unknown browser"}</small><em>{session.ip_address??"Unknown IP"} · last seen {new Date(session.last_seen_at).toLocaleString()}</em></span><button className="button small danger" onClick={()=>revoke(session)}>{session.is_current?"Sign out":"Revoke"}</button></div>)}</section></section>
}
function Board({title,subtitle,rows}:{title:string;subtitle:string;rows:{name:string;ticker:string;value:string}[]}) { return <section className="panel board"><div className="panel-heading"><div><p className="eyebrow">{subtitle}</p><h2>{title}</h2></div><TrophyIcon/></div>{rows.map((row,index)=><div className="board-row" key={row.ticker}><strong>{String(index+1).padStart(2,"0")}</strong><span className="avatar small">{row.name.slice(0,2).toUpperCase()}</span><span><b>{row.name}</b><small>${row.ticker}</small></span><em>{row.value}</em></div>)}</section>; }

