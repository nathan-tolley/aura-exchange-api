import {useCallback,useEffect,useState} from "react";
import {api} from "../api";
import {SparkIcon} from "../icons";

type Choice="SUPPORT"|"DECLINE"|"RECONSIDER";
interface FarmingItem{ id:string;status:"OPEN"|"RESOLVED";outcome:Choice|null;closes_at:string;resolved_at:string|null;explanation:string;subject_stock_id:string;display_name:string;ticker:string;verdict:string;delta:number;confidence:number;rationale:string;support:number;decline:number;reconsider:number;viewer_choice:Choice|null }

export function AuraFarmingView({ownStockId,onReward}:{ownStockId:string|null;onReward:()=>Promise<void>}){
  const [items,setItems]=useState<FarmingItem[]>([]),[error,setError]=useState("");
  const load=useCallback(async()=>{try{setItems((await api<{items:FarmingItem[]}>("/api/aura-farming")).items);setError("")}catch(e){setError(e instanceof Error?e.message:"Could not load Aura Farming")}},[]);
  useEffect(()=>{load();const timer=window.setInterval(load,10_000);return()=>window.clearInterval(timer)},[load]);
  async function vote(id:string,choice:Choice){try{await api(`/api/aura-farming/${id}/vote`,{method:"POST",body:JSON.stringify({choice})});await load();await onReward()}catch(e){setError(e instanceof Error?e.message:"Vote failed")}}
  const safeItems=Array.isArray(items)?items:[];
  const open=safeItems.filter(item=>item.status==="OPEN"),resolved=safeItems.filter(item=>item.status==="RESOLVED");
  return <section className="page-content farming-page"><header className="page-heading"><div><p className="eyebrow">COMMUNITY CONSENSUS</p><h1>Aura Farming</h1><p>Major AI swings spend one hour on the floor. Vote and earn +2 Aura and 100 AC when the poll settles.</p></div></header>{error&&<div className="form-error">{error}</div>}<div className="farming-list">{open.length===0&&<div className="panel empty-compact">No major swings are farming right now.</div>}{open.map(item=><FarmCard key={item.id} item={item} own={item.subject_stock_id===ownStockId} vote={vote}/>)}</div>{resolved.length>0&&<><div className="section-label">RECENT HARVESTS</div><div className="farming-list resolved">{resolved.slice(0,12).map(item=><FarmCard key={item.id} item={item} own={false} vote={vote}/>)}</div></>}</section>;
}

function FarmCard({item,own,vote}:{item:FarmingItem;own:boolean;vote:(id:string,choice:Choice)=>Promise<void>}){
  const remaining=Math.max(0,new Date(item.closes_at).getTime()-Date.now()),mins=Math.floor(remaining/60000),secs=Math.floor((remaining%60000)/1000);
  return <article className="panel farming-card"><div className="farm-score"><SparkIcon/><strong className={item.delta>=0?"positive":"negative"}>{item.delta>=0?"+":""}{item.delta}</strong><small>AI PROPOSAL</small></div><div className="farm-copy"><span className="ticker">${item.ticker} · {item.display_name}</span><h3>{item.explanation}</h3><blockquote>“{item.rationale}”</blockquote><small>{Math.round(Number(item.confidence)*100)}% AI confidence · {item.status==="OPEN"?`${mins}:${String(secs).padStart(2,"0")} remaining`:`Result: ${item.outcome}`}</small></div><div className="farm-votes">{(["SUPPORT","DECLINE","RECONSIDER"] as Choice[]).map(choice=><button key={choice} disabled={item.status!=="OPEN"||own} className={item.viewer_choice===choice?"active":""} onClick={()=>vote(item.id,choice)}><b>{choice==="SUPPORT"?"Support":choice==="DECLINE"?"Net zero":"Ask AI again"}</b><span>{choice==="SUPPORT"?item.support:choice==="DECLINE"?item.decline:item.reconsider} votes</span></button>)}{own&&<small>You cannot vote on your own Aura.</small>}</div></article>;
}
