import { useEffect, useMemo, useState } from "react";
import { api, money, type FeedItem } from "../api";
import { buildCandles, CANDLE_TIMEFRAMES, type Candle, type CandleTimeframe, type PriceTick } from "../candles";

type Range = "DAY" | "WEEK" | "SEASON";
type ChartMode = "CANDLES" | "LINE";
interface HistoryPoint {
  timestamp: string; price: number;
  cause: { type: "OPEN" | "TRADE" | "CURRENT"; tradeId?: string; side?: "BUY" | "SELL" | "SHORT" | "COVER" | "LIQUIDATE"; quantity?: number; actorName?: string; priceChange?: number };
}
interface StockHistory {
  stock: { id: string; displayName: string; ticker: string; aura: number };
  summary: { opening: number; current: number; high: number; low: number };
  points: HistoryPoint[]; ticks: PriceTick[]; auraEvents: FeedItem[];
}
const rangeMs: Record<Range, number> = { DAY: 86_400_000, WEEK: 604_800_000, SEASON: Infinity };

export function StockHistoryPanel({ stockId, onOpenFeedEvent }: { stockId: string; onOpenFeedEvent: (eventId: string) => void }) {
  const [data, setData] = useState<StockHistory | null>(null);
  const [range, setRange] = useState<Range>("SEASON");
  const [candleTimeframe,setCandleTimeframe]=useState<CandleTimeframe>("FIFTEEN_MINUTES");
  const [chartMode, setChartMode] = useState<ChartMode>("CANDLES");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true; setData(null); setError("");
    const load = () => api<StockHistory>(`/api/stocks/${stockId}/history`).then((result) => { if (active) { setData(result); setError(""); } }).catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "History unavailable"); });
    void load();
    const refresh = window.setInterval(() => { void load(); }, 15_000);
    return () => { active = false; window.clearInterval(refresh); };
  }, [stockId]);
  const candleConfig=CANDLE_TIMEFRAMES[candleTimeframe];
  const visibleWindowMs=chartMode==="CANDLES"?candleConfig.windowMs:rangeMs[range];
  const filteredTrades = useMemo(() => filterWithPrior(data?.points ?? [], visibleWindowMs), [data, visibleWindowMs]);
  const filteredTicks = useMemo(() => filterWithPrior(data?.ticks ?? [], visibleWindowMs), [data, visibleWindowMs]);
  const candles=useMemo(()=>{
    const cutoff=Date.now()-candleConfig.windowMs;
    return buildCandles(filteredTicks,candleConfig.intervalMs).filter((candle)=>Date.parse(candle.timestamp)>=cutoff);
  },[filteredTicks,candleConfig]);

  if (error) return <div className="stock-history-state error">{error}</div>;
  if (!data) return <div className="stock-history-state">Building the tape…</div>;
  const prices = filteredTicks.map((point) => point.price);
  const high = prices.length ? Math.max(...prices) : data.summary.current;
  const low = prices.length ? Math.min(...prices) : data.summary.current;
  const cutoff = visibleWindowMs === Infinity ? 0 : Date.now() - visibleWindowMs;
  const auraEvents = data.auraEvents.filter((event) => Date.parse(event.createdAt) >= cutoff);

  return <section className="stock-history-panel">
    <div className="history-topline">
      <div><span>PRICE HISTORY</span><strong>${data.stock.ticker}</strong></div>
      <div className="history-controls">
        <div className="segmented chart-mode"><button className={chartMode === "CANDLES" ? "active" : ""} onClick={() => setChartMode("CANDLES")}>Candles</button><button className={chartMode === "LINE" ? "active" : ""} onClick={() => setChartMode("LINE")}>Line</button></div>
        {chartMode==="CANDLES"?<div className="segmented history-range candle-timeframes">{(Object.entries(CANDLE_TIMEFRAMES) as [CandleTimeframe,(typeof CANDLE_TIMEFRAMES)[CandleTimeframe]][]).map(([value,config])=><button key={value} className={candleTimeframe===value?"active":""} onClick={()=>setCandleTimeframe(value)} title={`${config.label} candles · ${formatDuration(config.windowMs)} window`}>{config.label}</button>)}</div>:<div className="segmented history-range">{(["DAY", "WEEK", "SEASON"] as Range[]).map((value) => <button key={value} className={range === value ? "active" : ""} onClick={() => setRange(value)}>{value === "DAY" ? "1D" : value === "WEEK" ? "1W" : "Season"}</button>)}</div>}
      </div>
    </div>
    <div className="history-metrics"><span><small>OPEN</small><b>{money(data.summary.opening)}</b></span><span><small>CURRENT</small><b>{money(data.summary.current)}</b></span><span><small>HIGH</small><b className="positive">{money(high)}</b></span><span><small>LOW</small><b className="negative">{money(low)}</b></span></div>
    <div className="motion-disclosure"><span className="motion-dot"/>Ambient motion is a synthetic random walk, sampled every 15 seconds and capped at ±3% from the latest trade price.</div>
    {chartMode === "CANDLES" ? <CandlestickChart candles={candles} timeframe={candleConfig.label} windowLabel={formatDuration(candleConfig.windowMs)} onOpenFeedEvent={onOpenFeedEvent} /> : <PriceChart ticks={filteredTicks} />}
    <div className="history-context-grid">
      <div><h4>Price catalysts</h4><p>Direct AMM moves from executed trades.</p><div className="catalyst-list">
        {filteredTrades.filter((point) => point.cause.type === "TRADE").reverse().slice(0, 8).map((point) => <div key={point.cause.tradeId}><em className={(point.cause.priceChange ?? 0) >= 0 ? "positive" : "negative"}>{(point.cause.priceChange ?? 0) >= 0 ? "▲" : "▼"}</em><span><b>{point.cause.actorName}</b> {describeTrade(point.cause.side)} {point.cause.quantity?.toFixed(2)} shares<small>{formatTime(point.timestamp)} · mark {money(point.price)} AC · {signedPrice(point.cause.priceChange ?? 0)}</small></span></div>)}
        {!filteredTrades.some((point) => point.cause.type === "TRADE") && <p className="history-empty">No trades in this range.</p>}
      </div></div>
      <div><h4>Aura context</h4><p>Sentiment events shown for context; they do not directly set the market price.</p><div className="aura-context-list">
        {auraEvents.slice(0, 6).map((event) => <div key={event.id}><b className={(event.votes?.effectiveDelta ?? Number(event.payload.delta)) >= 0 ? "positive" : "negative"}>{formatSigned(event.votes?.effectiveDelta ?? Number(event.payload.delta))}</b><span>{String(event.payload.explanation)}<small>{formatTime(event.createdAt)}</small></span></div>)}
        {!auraEvents.length && <p className="history-empty">No Aura rulings in this range.</p>}
      </div></div>
    </div>
  </section>;
}

function filterWithPrior<T extends { timestamp: string }>(items: T[], windowMs: number): T[] {
  if (windowMs === Infinity) return items;
  const cutoff = Date.now() - windowMs;
  const current = items.filter((item) => Date.parse(item.timestamp) >= cutoff);
  const prior = [...items].reverse().find((item) => Date.parse(item.timestamp) < cutoff);
  return prior ? [prior, ...current] : current;
}
function scale(values: number[]) {
  const width = 760, height = 210, padX = 28, padY = 24, rawMin = Math.min(...values), rawMax = Math.max(...values);
  const padding = Math.max((rawMax - rawMin) * .15, rawMax * .0015, .08), min = rawMin-padding, max = rawMax+padding;
  return { width, height, padX, padY, rawMin, rawMax, y: (price: number) => padY + ((max-price)/(max-min))*(height-padY*2) };
}
function PriceChart({ ticks }: { ticks: PriceTick[] }) {
  if (!ticks.length) return <div className="history-chart empty">No price points.</div>;
  const times=ticks.map((tick)=>Date.parse(tick.timestamp)), prices=ticks.map((tick)=>tick.price), s=scale(prices), minTime=Math.min(...times), maxTime=Math.max(...times);
  const x=(time:number)=>minTime===maxTime?s.width/2:s.padX+((time-minTime)/(maxTime-minTime))*(s.width-s.padX*2);
  const path=ticks.map((tick,index)=>`${index?"L":"M"}${x(times[index]!).toFixed(2)},${s.y(tick.price).toFixed(2)}`).join(" ");
  return <div className="history-chart"><svg viewBox={`0 0 ${s.width} ${s.height}`} preserveAspectRatio="none" role="img" aria-label="Stock price history"><ChartGrid scale={s}/><path className="history-area" d={`${path} L${x(times.at(-1)!)},${s.height-s.padY} L${x(times[0]!)},${s.height-s.padY} Z`}/><path className="history-line" d={path}/><LastPrice price={prices.at(-1)!} scale={s}/></svg></div>;
}
function CandlestickChart({ candles, timeframe, windowLabel, onOpenFeedEvent }: { candles: Candle[];timeframe:string;windowLabel:string; onOpenFeedEvent: (eventId: string) => void }) {
  if (!candles.length) return <div className="history-chart empty">No candle data.</div>;
  const s=scale(candles.flatMap((candle)=>[candle.low,candle.high])), slot=(s.width-s.padX*2-50)/candles.length, body=Math.max(2,Math.min(11,slot*.58)), x=(index:number)=>s.padX+slot*(index+.5);
  return <><div className="history-chart candle-chart"><svg viewBox={`0 0 ${s.width} ${s.height}`} preserveAspectRatio="none" role="img" aria-label={`${timeframe} OHLC candlestick price history over ${windowLabel}`}><ChartGrid scale={s}/>{candles.map((candle,index)=>{const up=candle.close>=candle.open,top=s.y(Math.max(candle.open,candle.close)),bottom=s.y(Math.min(candle.open,candle.close)),eventId=candle.feedEventIds[0];return <g key={candle.timestamp} role={eventId?"link":undefined} tabIndex={eventId?0:undefined} onClick={()=>{if(eventId)onOpenFeedEvent(eventId)}} onKeyDown={(event)=>{if(eventId&&(event.key==="Enter"||event.key===" ")){event.preventDefault();onOpenFeedEvent(eventId)}}} className={`candle ${up?"up":"down"} ${candle.syntheticOnly?"synthetic":"traded"} ${eventId?"linked":""}`}><rect className="candle-hit" x={x(index)-Math.max(body,slot)/2} y={s.padY} width={Math.max(body,slot)} height={s.height-s.padY*2}/><line className="candle-wick" x1={x(index)} x2={x(index)} y1={s.y(candle.high)} y2={s.y(candle.low)}/><rect className="candle-body" x={x(index)-body/2} y={top} width={body} height={Math.max(2,bottom-top)}/><title>{formatTime(candle.timestamp)} · O {money(candle.open)} · H {money(candle.high)} · L {money(candle.low)} · C {money(candle.close)} AC{eventId?` · ${candle.feedEventIds.length} real event${candle.feedEventIds.length===1?"":"s"} · click to view`:" · ambient only"}</title></g>})}<LastPrice price={candles.at(-1)!.close} scale={s}/></svg></div><div className="chart-window-caption"><span>{formatAxisTime(candles[0]!.timestamp,timeframe)}</span><b>{timeframe} candles · {windowLabel}</b><span>{formatAxisTime(candles.at(-1)!.timestamp,timeframe)}</span></div></>;
}
type ChartScale = ReturnType<typeof scale>;
function ChartGrid({scale:s}:{scale:ChartScale}) { const lines=[0,.25,.5,.75,1]; return <g className="chart-grid">{lines.map((part)=>{const price=s.rawMax-(s.rawMax-s.rawMin)*part,y=s.y(price);return <g key={part}><line x1={s.padX} x2={s.width-46} y1={y} y2={y}/><text x={s.width-42} y={y+3}>{money(price)}</text></g>})}</g>; }
function LastPrice({price,scale:s}:{price:number;scale:ChartScale}) { const y=s.y(price); return <g className="last-price"><line x1={s.padX} x2={s.width-46} y1={y} y2={y}/><rect x={s.width-44} y={y-8} width="43" height="16" rx="3"/><text x={s.width-22.5} y={y+3} textAnchor="middle">{money(price)}</text></g>; }
function describeTrade(side?: HistoryPoint["cause"]["side"]) { return ({BUY:"bought",SELL:"sold",SHORT:"shorted",COVER:"covered",LIQUIDATE:"was liquidated for"} as const)[side??"BUY"]; }
function formatTime(value:string){return new Date(value).toLocaleString([],{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});}
function signedPrice(value:number){return `${value>=0?"+":""}${money(value)} AC`;}
function formatSigned(value:number){return `${value>=0?"+":""}${new Intl.NumberFormat("en-US",{maximumFractionDigits:2}).format(value)} aura`;}
function formatDuration(ms:number){if(ms<86_400_000)return `${Math.round(ms/3_600_000)}h`;return `${Math.round(ms/86_400_000)}d`;}
function formatAxisTime(value:string,timeframe:string){return new Date(value).toLocaleString([],timeframe==="1h"?{weekday:"short",hour:"numeric"}:{hour:"numeric",minute:"2-digit"});}
