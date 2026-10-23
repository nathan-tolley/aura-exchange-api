import { useEffect, useMemo, useState } from "react";
import { api, money, signed, type Portfolio, type Stock } from "../api";
import { ArrowIcon } from "../icons";

type Side = "BUY" | "SELL" | "SHORT" | "COVER";
type OrderMode = "MARKET" | "LIMIT";
interface LimitOrder {id:string;stock_id:string;side:"BUY"|"SELL";quantity:string;limit_price:string;status:string;created_at:string}
interface Preview { currentPrice:string;executionPrice:string;nextPrice:string;priceImpact:string;grossAmount:string;feeAmount:string;netAmount:string;availableCash:string;cashChange:string;projectedCash:string;collateralRequired:string;escrowChange:string;longBefore:string;longAfter:string;shortBefore:string;shortAfter:string;auraImpact:string;canExecute:boolean;reason:string|null }
const sideCopy:Record<Side,{title:string;detail:string;flow:string}>={
  BUY:{title:"Build a long position",detail:"Pay AC now. You profit if the stock price rises and receive eligible Aura dividends.",flow:"Cash out → shares in"},
  SELL:{title:"Reduce a long position",detail:"Return shares to the pool and receive AC at the live AMM price.",flow:"Shares out → cash in"},
  SHORT:{title:"Bet against the stock",detail:"Borrow and sell shares. Proceeds stay escrowed and you post 50% additional collateral.",flow:"Collateral locked → short opened"},
  COVER:{title:"Close a short position",detail:"Buy borrowed shares back. Escrow pays first; any surplus returns to cash.",flow:"Escrow out → short reduced"}
};
function idempotencyKey(){return `${Date.now().toString(36)}-${Array.from({length:4},()=>Math.random().toString(36).slice(2)).join("")}`}

export function TradePanel({stock,portfolio,ownStockId,onClose,onTraded}:{stock:Stock;portfolio:Portfolio|null;ownStockId:string|null;onClose:()=>void;onTraded:()=>Promise<void>}){
  const [side,setSide]=useState<Side>("BUY"),[quantity,setQuantity]=useState("1"),[preview,setPreview]=useState<Preview|null>(null);
  const [quote,setQuote]=useState<Record<string,string>|null>(null),[error,setError]=useState(""),[previewing,setPreviewing]=useState(false),[busy,setBusy]=useState(false);
  const [mode,setMode]=useState<OrderMode>("MARKET"),[limitPrice,setLimitPrice]=useState(stock.price.toFixed(2)),[orders,setOrders]=useState<LimitOrder[]>([]);
  const position=useMemo(()=>portfolio?.positions.find(item=>item.stockId===stock.id),[portfolio,stock.id]);
  const disabled=ownStockId===stock.id,q=Number(quantity);
  const isLimit=mode==="LIMIT"&&(side==="BUY"||side==="SELL"),limit=Number(limitPrice),reservedEstimate=q*limit*1.005;

  async function loadOrders(){try{const data=await api<{items:LimitOrder[]}>("/api/limit-orders");setOrders(data.items.filter(item=>item.stock_id===stock.id))}catch{/* main ticket remains usable */}}
  useEffect(()=>{loadOrders()},[stock.id]);

  useEffect(()=>{
    setQuote(null);setError("");
    if(disabled||!Number.isFinite(q)||q<=0){setPreview(null);return}
    const timer=window.setTimeout(async()=>{setPreviewing(true);try{setPreview(await api<Preview>("/api/trades/preview",{method:"POST",body:JSON.stringify({stockId:stock.id,side,quantity:q})}));setError("")}catch(e){setPreview(null);setError(e instanceof Error?e.message:"Could not price this order")}finally{setPreviewing(false)}},350);
    return()=>window.clearTimeout(timer);
  },[side,quantity,stock.id,disabled,q]);

  async function lockQuote(){setBusy(true);setError("");try{setQuote(await api<Record<string,string>>("/api/trades/quote",{method:"POST",body:JSON.stringify({stockId:stock.id,side,quantity:q})}))}catch(e){setError(e instanceof Error?e.message:"Quote failed")}finally{setBusy(false)}}
  async function execute(){if(!quote)return;setBusy(true);setError("");try{await api("/api/trades/execute",{method:"POST",body:JSON.stringify({quoteId:quote.id,idempotencyKey:idempotencyKey()})});await onTraded();onClose()}catch(e){setError(e instanceof Error?e.message:"Trade failed");setQuote(null)}finally{setBusy(false)}}
  async function placeLimit(){setBusy(true);setError("");try{await api("/api/limit-orders",{method:"POST",body:JSON.stringify({stockId:stock.id,side,quantity:q,limitPrice:limit})});await loadOrders();await onTraded()}catch(e){setError(e instanceof Error?e.message:"Limit order failed")}finally{setBusy(false)}}
  async function cancelLimit(id:string){setBusy(true);setError("");try{await api(`/api/limit-orders/${id}/cancel`,{method:"POST"});await loadOrders();await onTraded()}catch(e){setError(e instanceof Error?e.message:"Cancellation failed")}finally{setBusy(false)}}
  const cashChange=Number(preview?.cashChange??0),positionAfter=side==="BUY"||side==="SELL"?Number(preview?.longAfter??0):Number(preview?.shortAfter??0);

  return <div className="drawer-backdrop" onMouseDown={e=>e.target===e.currentTarget&&onClose()}><aside className="trade-drawer">
    <button className="icon-button drawer-close" onClick={onClose} aria-label="Close">×</button>
    <div className="stock-identity large"><span className="avatar">{stock.displayName.split(" ").map(p=>p[0]).join("").slice(0,2)}</span><div><span className="ticker">${stock.ticker}</span><h2>{stock.displayName}</h2></div></div>
    <div className="drawer-quote"><strong>{money(stock.price)} AC</strong><span className={stock.dayChangePct>=0?"positive":"negative"}>{signed(stock.dayChangePct,"%")} today</span></div>
    <div className="segmented four">{(["BUY","SELL","SHORT","COVER"] as Side[]).map(item=><button key={item} className={side===item?"active":""} onClick={()=>setSide(item)}>{item}</button>)}</div>
    {(side==="BUY"||side==="SELL")&&<div className="order-mode"><button className={mode==="MARKET"?"active":""} onClick={()=>setMode("MARKET")}><b>Market</b><span>Execute now at the live price</span></button><button className={mode==="LIMIT"?"active":""} onClick={()=>setMode("LIMIT")}><b>Limit</b><span>Wait for your chosen price</span></button></div>}
    <div className="trade-explainer"><b>{sideCopy[side].title}</b><p>{sideCopy[side].detail}</p><small>{sideCopy[side].flow}</small></div>
    <div className="position-summary"><span>Spendable cash<b>{money(portfolio?.cash??0)} AC</b></span><span>Current position<b>{position?`${position.longQty||position.shortQty} ${position.longQty?"long":"short"}`:"None"}</b></span></div>
    <label className="quantity-field">Shares<input value={quantity} onChange={e=>setQuantity(e.target.value)} inputMode="decimal"/></label>
    {isLimit&&<label className="limit-price-field">Limit price per share<input value={limitPrice} onChange={e=>setLimitPrice(e.target.value)} inputMode="decimal"/><small>{side==="BUY"?"Fills when the full order can buy at this price or less.":"Fills when the full order can sell at this price or more."}</small></label>}
    <div className="quick-qty">{[1,5,10,25].map(value=><button key={value} onClick={()=>setQuantity(String(value))}>{value} shares</button>)}</div>
    {disabled&&<div className="form-error">You cannot trade your own Aura stock.</div>}{error&&<div className="form-error">{error}</div>}
    {previewing&&<div className="quote-loading">Updating live price…</div>}
    {preview&&<div className={`live-trade-preview ${preview.canExecute||isLimit?"":"blocked"}`}>
      <div className="preview-head"><span>LIVE ESTIMATE</span><em>{preview.canExecute?"ORDER AVAILABLE":"ORDER BLOCKED"}</em></div>
      <div className="trade-stat-grid"><span><small>Market price</small><b>{money(Number(preview.currentPrice))} AC</b></span><span><small>Average fill</small><b>{money(Number(preview.executionPrice))} AC</b></span><span><small>Price after</small><b>{money(Number(preview.nextPrice))} AC</b></span><span><small>Price impact</small><b>{(Number(preview.priceImpact)*100).toFixed(2)}%</b></span></div>
      <div className="cash-waterfall"><div><span>Share value</span><b>{money(Number(preview.grossAmount))} AC</b></div><div><span>Trading fee</span><b>{money(Number(preview.feeAmount))} AC</b></div>{side==="SHORT"&&<div><span>Collateral locked</span><b>{money(Number(preview.collateralRequired))} AC</b></div>}<div className="quote-total"><span>{cashChange>=0?"Cash received":"Cash required"}</span><b>{money(Math.abs(cashChange))} AC</b></div></div>
      <div className="after-trade"><span><small>Cash after</small><b className={Number(preview.projectedCash)<0?"negative":""}>{money(Number(preview.projectedCash))} AC</b></span><span><small>{side==="BUY"||side==="SELL"?"Long shares after":"Short shares after"}</small><b>{positionAfter}</b></span><span><small>Aura impact</small><b className={Number(preview.auraImpact)>=0?"positive":"negative"}>{signed(Number(preview.auraImpact))}</b></span></div>
      {isLimit&&<div className="limit-reservation"><span>{side==="BUY"?"Maximum cash reserved":"Shares reserved"}</span><b>{side==="BUY"?`${money(reservedEstimate)} AC`:`${q} shares`}</b></div>}
      {!preview.canExecute&&!isLimit&&<div className="order-block-reason">{preview.reason}</div>}
    </div>}
    {quote&&<div className="locked-quote"><b>Price locked for 15 seconds</b><span>Final total: {money(Number(quote.netAmount))} AC</span></div>}
    {isLimit?<button className="button primary full" onClick={placeLimit} disabled={busy||disabled||!Number.isFinite(limit)||limit<=0||q<=0}>{busy?"Placing…":`Place ${side.toLowerCase()} limit`} <ArrowIcon/></button>:!quote?<button className={`button full ${side==="SHORT"?"danger":"primary"}`} onClick={lockQuote} disabled={busy||disabled||!preview?.canExecute}>{busy?"Locking price…":`Review & lock ${side.toLowerCase()}`} <ArrowIcon/></button>:<button className={`button full ${side==="SHORT"?"danger":"primary"}`} onClick={execute} disabled={busy}>{busy?"Executing…":`Confirm ${side.toLowerCase()}`}</button>}
    {orders.length>0&&<div className="open-limit-orders"><h3>Orders for ${stock.ticker}</h3>{orders.map(order=><div key={order.id}><span><b>{order.side} {Number(order.quantity)} @ {money(Number(order.limit_price))}</b><small>{order.status.toLowerCase()} · {new Date(order.created_at).toLocaleString()}</small></span>{order.status==="OPEN"&&<button onClick={()=>cancelLimit(order.id)} disabled={busy}>Cancel</button>}</div>)}</div>}
    {(side==="SHORT"||side==="COVER")&&<p className="risk-note">Shorts require 150% total backing, accrue a 0.1% daily borrow fee, and liquidate below 125% maintenance.</p>}
  </aside></div>;
}
