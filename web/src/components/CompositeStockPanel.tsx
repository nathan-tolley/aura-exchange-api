import {money,signed,type CompositeStock} from "../api";
import {SparkIcon} from "../icons";

export function CompositeStockPanel({stock}:{stock:CompositeStock}){
  const width=1000,height=210,padX=38,padY=22;
  const points=Array.isArray(stock.points)&&stock.points.length?stock.points:[{timestamp:new Date().toISOString(),value:Number(stock.current)||100}];
  const values=points.map(point=>point.value),rawMin=Math.min(...values),rawMax=Math.max(...values),span=Math.max(.5,rawMax-rawMin),min=rawMin-span*.15,max=rawMax+span*.15;
  const coords=points.map((point,index)=>({x:padX+(index/Math.max(1,points.length-1))*(width-padX*2),y:padY+((max-point.value)/(max-min))*(height-padY*2),...point}));
  const line=coords.map((point,index)=>`${index?"L":"M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
  const area=`${line} L${coords.at(-1)!.x},${height-padY} L${coords[0]!.x},${height-padY} Z`;
  const positive=stock.change>=0;
  return <section className="composite-stock panel">
    <div className="composite-identity"><span className="composite-mark"><SparkIcon/></span><div><span>OFFICE-WIDE INDEX STOCK</span><h2>$AURA <small>Aura Composite</small></h2><p>Equal-weight exposure to everyone’s seasonal Aura.</p></div></div>
    <div className="composite-quote"><strong>{stock.current.toFixed(2)}</strong><em className={positive?"positive":"negative"}>{signed(stock.change)} today</em><div><span>OPEN <b>{stock.open.toFixed(2)}</b></span><span>HIGH <b>{stock.high.toFixed(2)}</b></span><span>LOW <b>{stock.low.toFixed(2)}</b></span></div></div>
    <div className="composite-chart"><svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Aura Composite line chart, current ${money(stock.current)}`}><defs><linearGradient id="composite-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={positive?"#bcf45f":"#ff6f61"} stopOpacity=".25"/><stop offset="1" stopColor={positive?"#bcf45f":"#ff6f61"} stopOpacity="0"/></linearGradient></defs>{[0,.25,.5,.75,1].map(f=><line key={f} x1={padX} x2={width-padX} y1={padY+f*(height-padY*2)} y2={padY+f*(height-padY*2)}/>) }<path className="composite-area" d={area}/><path className={positive?"composite-line up":"composite-line down"} d={line}/><circle className={positive?"last-dot up":"last-dot down"} cx={coords.at(-1)!.x} cy={coords.at(-1)!.y} r="4"/><text x={width-padX-4} y={coords.at(-1)!.y-9} textAnchor="end">{stock.current.toFixed(2)}</text></svg><div><span>{new Date(points[0]!.timestamp).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}</span><span>LIVE</span></div></div>
  </section>;
}
