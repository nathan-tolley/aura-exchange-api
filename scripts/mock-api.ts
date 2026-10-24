import Fastify from "fastify";

const app = Fastify({ logger: false });
const stocks = [
  { id:"11111111-1111-4111-8111-111111111111", displayName:"Maya Chen", ticker:"MAYA", aura:112, careerAura:48, price:118.42, dayChangePct:8.41, seasonChangePct:18.42, haltedUntil:null },
  { id:"22222222-2222-4222-8222-222222222222", displayName:"Theo Brooks", ticker:"THEO", aura:91, careerAura:-12, price:86.73, dayChangePct:-6.28, seasonChangePct:-13.27, haltedUntil:null },
  { id:"33333333-3333-4333-8333-333333333333", displayName:"Jordan Blake", ticker:"JBLK", aura:104, careerAura:19, price:103.19, dayChangePct:1.94, seasonChangePct:3.19, haltedUntil:null },
  { id:"44444444-4444-4444-8444-444444444444", displayName:"Sam Rivera", ticker:"SAMR", aura:98, careerAura:7, price:96.18, dayChangePct:-1.12, seasonChangePct:-3.82, haltedUntil:null },
  { id:"55555555-5555-4555-8555-555555555555", displayName:"Nina Patel", ticker:"NINA", aura:109, careerAura:35, price:110.06, dayChangePct:4.7, seasonChangePct:10.06, haltedUntil:null }
];
const user = { id:"99999999-9999-4999-8999-999999999999", username:"owner", role:"OWNER", stockId:stocks[2]!.id, displayName:"Jordan Blake", ticker:"JBLK", csrfToken:"preview-token" };
const now = Date.now();
const feed = [
  { id:"f1",kind:"AURA_RULING",createdAt:new Date(now-120000).toISOString(),actor:{displayName:"Anonymous",ticker:null},subject:{id:stocks[0]!.id,displayName:"Maya Chen",ticker:"MAYA"},payload:{submissionId:"77777777-7777-4777-8777-777777777777",delta:5,explanation:"Fixed the projector with 30 seconds left and never stopped presenting.",rationale:"Clutch under fluorescent pressure. The tape respects it."}},
  { id:"f2",kind:"TRADE",createdAt:new Date(now-600000).toISOString(),actor:{displayName:"Nina Patel",ticker:"NINA"},subject:{id:stocks[1]!.id,displayName:"Theo Brooks",ticker:"THEO"},payload:{side:"SHORT",quantity:"7.5",price:"89.12"}},
  { id:"f3",kind:"AURA_RULING",createdAt:new Date(now-1200000).toISOString(),actor:{displayName:"Anonymous",ticker:null},subject:{id:stocks[1]!.id,displayName:"Theo Brooks",ticker:"THEO"},payload:{submissionId:"88888888-8888-4888-8888-888888888888",delta:-4,explanation:"Replied all to say please stop replying all.",rationale:"A self-sustaining cringe loop hit the office index."}},
  { id:"f4",kind:"MEMBER_JOINED",createdAt:new Date(now-3600000).toISOString(),actor:{displayName:"Sam Rivera",ticker:"SAMR"},subject:{id:stocks[3]!.id,displayName:"Sam Rivera",ticker:"SAMR"},payload:{}}
];

app.get("/api/setup/status", async()=>({needsSetup:false}));
app.get("/api/auth/session", async()=>({user}));
app.get("/api/market", async()=>({stocks,auraComposite:102.8,marketIndex:101.72}));
app.get("/api/portfolio", async()=>({cash:7421.8,equity:10834.27,longValue:2541.4,shortLiability:912.6,positions:[
  {id:"p1",stockId:stocks[0]!.id,ticker:"MAYA",displayName:"Maya Chen",longQty:14,shortQty:0,price:118.42,averageEntry:102.1,unrealizedPnl:228.48,realizedPnl:0},
  {id:"p2",stockId:stocks[1]!.id,ticker:"THEO",displayName:"Theo Brooks",longQty:0,shortQty:6,price:86.73,averageEntry:94.8,unrealizedPnl:48.42,realizedPnl:12.5}
] }));
app.get("/api/feed", async()=>({items:feed}));
app.get("/api/composite",async()=>({ticker:"AURA",name:"Aura Composite",current:102.8,open:100.4,high:103.2,low:99.8,change:2.4,points:Array.from({length:48},(_,i)=>({timestamp:new Date(now-(47-i)*30*60_000).toISOString(),value:100+i*.05+Math.sin(i/4)*.8}))}));
app.get("/api/notifications",async()=>({unread:2,items:[
  {id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",kind:"LIMIT_ORDER_FILLED",payload:{side:"BUY",quantity:"4",price:"111.20"},read_at:null,created_at:new Date(now-90_000).toISOString()},
  {id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",kind:"FARMING_REWARD",payload:{aura:2,credits:100},read_at:null,created_at:new Date(now-900_000).toISOString()}
]}));
app.get("/api/auth/sessions",async()=>({items:[{id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",user_agent:"Preview browser",ip_address:"127.0.0.1",created_at:new Date(now-3600_000).toISOString(),last_seen_at:new Date().toISOString(),expires_at:new Date(now+86400_000).toISOString(),is_current:true}]}));
app.get("/api/leaderboards", async()=>({aura:stocks.map(s=>({display_name:s.displayName,ticker:s.ticker,seasonal_aura:s.aura})).sort((a,b)=>b.seasonal_aura-a.seasonal_aura),wealth:stocks.map((s,i)=>({display_name:s.displayName,ticker:s.ticker,net_worth:12000-i*840}))}));
app.get("/api/predictions",async()=>({items:[
  {id:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",question:"Will anyone finish Friday above 120 Aura?",description:"Resolved from the official Aura ledger after the Friday close.",status:"OPEN",closes_at:new Date(now+36*3600_000).toISOString(),outcome:null,yes_pool:"740",no_pool:"420",user_yes:"100",user_no:"0",user_payout:"0",yes_probability:62.7},
  {id:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",question:"Will the market index close green today?",description:"Compared with today's opening snapshot.",status:"RESOLVED",closes_at:new Date(now-3600_000).toISOString(),outcome:"YES",yes_pool:"560",no_pool:"310",user_yes:"0",user_no:"50",user_payout:"0",yes_probability:62.5}
]}));
app.get("/api/options",async()=>({stocks:stocks.map(stock=>({id:stock.id,display_name:stock.displayName,ticker:stock.ticker,price:String(stock.price),strikes:[Math.round(stock.price*.9),Math.round(stock.price),Math.round(stock.price*1.1)]})),positions:[
  {id:"ffffffff-ffff-4fff-8fff-ffffffffffff",stock_id:stocks[0]!.id,ticker:"MAYA",display_name:"Maya Chen",option_type:"CALL",strike:"115",quantity:"3",premium_paid:"19.44",expires_at:new Date(now+5*86400_000).toISOString(),status:"OPEN",settlement_price:null,payout:null}
]}));
app.get("/api/admin/roster",async()=>({people:stocks.map(s=>({id:s.id,display_name:s.displayName,ticker:s.ticker,is_active:true,username:s.ticker.toLowerCase(),role:"MEMBER",seasonal_aura:s.aura}))}));
app.get("/api/moderation/review",async()=>({items:[]}));
app.get("/api/admin/chatgpt/status",async()=>({connected:true,email:"owner@example.com",model:"gpt-6-astra"}));
app.get("/api/health",async()=>({database:{ok:true,latencyMs:4},migrations:{current:true,applied:11,expected:11,pending:[]},worker:{ok:true,lastSeenAt:new Date().toISOString()},scheduler:{ok:true,lastRunAt:new Date().toISOString()},jobs:{pending:{count:0,oldestAt:null},failed:{count:0,oldestAt:null}},ai:{configured:true,provider:"chatgpt",chatgptConnections:1},backup:{latestAt:new Date(now-3600_000).toISOString(),stale:false,restoreTest:{completedAt:new Date(now-86400_000).toISOString()}},transport:{secure:false,origin:"http://localhost"}}));
app.post("*",async()=>({ok:true,id:crypto.randomUUID()}));
await app.listen({host:"127.0.0.1",port:8787});
