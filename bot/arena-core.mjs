/**
 * New, isolated PAPER league. See ARENA-CORE-API.md for the frozen contract.
 * Pure synchronous reducers: no I/O, wall clock, randomness, credentials/orders.
 * Main owns snapshots and durable commit; a thrown advance never mutates input.
 *
 * Signals: original whitelisted legacy functions on 256 CLOSED HL 15m bars;
 * original Winner features/decide on Binance spot, 6h + 15m delayed execution;
 * unmodified research state_graph-59, HL fixed15m features, 30m decisions.
 * Execution is observed HL L2 VWAP plus fixed costs, NOT historical replay.
 * No virtual fill can satisfy readiness. Partial graph goals/entry ATR/trim
 * quantities persist; one edge and one execution attempt per decision endpoint.
 */
import {features as winnerFeatures, decide as winnerDecide} from './winner-paper-core.mjs';
import {rsi, atr, efficiencyRatio} from './strategy.mjs';
import {stworzGraczy, czyWyjsc} from './gracze.mjs';
import sourceSpec from './arena-skoczek-spec.mjs';

export const HOUR=3600000, QUARTER=900000;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const ensure=(ok,message)=>{if(!ok)throw Error(message);};
const clone=x=>structuredClone(x);
const sum=xs=>xs.reduce((a,b)=>a+b,0);
function deepFreeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(deepFreeze);Object.freeze(value);}return value;}
const DEFAULT_SYMBOLS=['SOL','JUP','JTO','PYTH','RENDER','BONK','BTC','ETH','W','TNSR','PENGU'];
export const PROTOCOL=deepFreeze({id:'arena-paper-v1-20260927',schema:1,paper:true,ordersEnabled:false,
  initial:1000,fee:.00045,slip:.0005,marginLeverage:3,maintenance:.05,minimumOrder:10,
  volumeFraction:.001,volumeModel:'last completed hour base volume / 4; shared 15m bucket',
  maxSnapshotAgeMs:60000,maxPreOracleAgeMs:QUARTER,historyBars:256,
  legacySymbols:DEFAULT_SYMBOLS,legacyDecisionMs:QUARTER,skoczekDecisionMs:2*QUARTER,
  winnerDecisionMs:6*HOUR,winnerDelayMs:QUARTER,decisionWindowMs:QUARTER,
  sources:{legacy:'HL closed 15m; paper variant, live open-bar observations differ',
    skoczek:'papier HL; historyczny test Binance futures — inne źródło',
    winner:'original Binance spot 1h; BTC30 gate',execution:'observed Hyperliquid L2/mark/oracle'},
  indicators:'Wilder14 and ER48 from ALL supplied 256 bars; rolling warmup, no hidden fallback',
  risk:'sampled marks; maintenance breach queues L2 liquidation and permanently halts new entries',
  note:'New paper experiment. No claim of exact backtest replay or future profit.'});
export const PLAYERS=deepFreeze([
  {id:'panika',name:'Panika',maxPositions:2,allocation:.40,leverage:3},
  {id:'panikaLuzna',name:'Panika luźna',maxPositions:2,allocation:.40,leverage:3},
  {id:'sitoOstre',name:'Sito ostre',maxPositions:6,allocation:.13,leverage:3},
  {id:'winnerBTC30',name:'Winner BTC30',maxPositions:1,allocation:.75,leverage:1},
  {id:'skoczekSOL',name:'Skoczek SOL',maxPositions:1,allocation:.30,leverage:1},
]);
export const SKOCZEK_SPEC=deepFreeze(clone(sourceSpec));
const legacyIds=['panika','panikaLuzna','sitoOstre'];
// Do not enumerate the returned dictionary into the league: the source may
// contain unrelated experiments (including uncommitted panikaWzgledna).
const definitions=stworzGraczy({los:()=>{throw Error('Random player forbidden');}});
const legacy=Object.fromEntries(legacyIds.map(id=>[id,definitions[id]]));
ensure(legacy.panikaLuzna.stopAtr===3.5&&legacy.panikaLuzna.bezSmyczy===true,'Legacy loose control changed');
const coins=['BTC','ETH','SOL'];
const nextBoundary=(now,step)=>(Math.floor(now/step)+1)*step;
const safeTime=(x,label)=>ensure(Number.isSafeInteger(x)&&x>=0,`Invalid ${label} timestamp`);
const quantity=(a,symbol)=>a.qty[symbol]??0;

export function makeGraph(){
  return {state:null,since:null,goal:null,start_q:null,first_price:null,entry_atr:null,
    entry_equity:null,peak_move:0,last_atr:null,last_equity:null,last_flat:null};
}
function enterGraph(g,name,x,p=SKOCZEK_SPEC.params){
  const action=p.states[name].action;
  g.state=name;g.since=x.now;g.start_q=x.quantity;
  g.goal=action.kind==='allocate'?action.weight*x.equity/x.mark:
    action.kind==='trim'?x.quantity*action.keep:action.kind==='flat'?0:null;
}
const comparisons={gt:(a,b)=>a>b,ge:(a,b)=>a>=b,lt:(a,b)=>a<b,le:(a,b)=>a<=b,eq:(a,b)=>a===b,ne:(a,b)=>a!==b};
function operand(value,x,metrics){
  if(typeof value==='number')return value;
  if('metric'in value)return metrics[value.metric];
  ensure('feature'in value&&value.asset===2,'Unsupported frozen graph operand');
  return x.features[value.feature]*(value.scale??1);
}
function guard(rule,x,metrics){
  if(rule.all)return rule.all.every(r=>guard(r,x,metrics));
  if(rule.any)return rule.any.some(r=>guard(r,x,metrics));
  const left=operand(rule.left,x,metrics),right=operand(rule.right,x,metrics);
  return finite(left)&&finite(right)&&comparisons[rule.op](left,right);
}
/** Low-level parity seam, mutates ONLY supplied graph memory like StateGraph. */
export function graphDecide(g,x,p=SKOCZEK_SPEC.params){
  ensure(finite(x.equity)&&x.equity>0&&x.quantity>=0&&x.mark>0,'Invalid graph account');
  g.last_atr=finite(x.features.atr14)?x.features.atr14:null;g.last_equity=x.equity;
  if(g.state===null){g.last_flat=x.now;enterGraph(g,p.initial,x,p);}
  const previous=g.state,action=p.states[g.state].action;
  let ready=g.goal!==null?Math.abs(x.quantity-g.goal)<=Math.max(1e-12,.05*Math.abs(g.goal-g.start_q)):x.quantity!==0;
  if(action.kind==='flat')ready=x.quantity===0;
  const move=g.first_price!==null&&g.entry_atr>0?(x.mark-g.first_price)/g.entry_atr:NaN;
  if(finite(move))g.peak_move=Math.max(g.peak_move,move);
  const metrics={state_h:(x.now-g.since)/HOUR,age_h:x.ageHours??0,
    flat_h:g.last_flat!==null?(x.now-g.last_flat)/HOUR:0,filled:Number(x.quantity!==0),ready:Number(ready),
    pnl_net:x.quantity?(x.cyclePnl??0):0,cycle_return:x.quantity&&g.entry_equity?(x.cyclePnl??0)/g.entry_equity:0,
    move_atr:move,giveback_atr:g.peak_move-move,peak_move_atr:finite(move)?g.peak_move:NaN};
  let trigger=null;const checked=[];
  const valid=x.features.valid===true&&finite(x.features.atr14)&&x.features.atr14>0;
  if(!valid){if(g.state!==p.exit)enterGraph(g,p.exit,x,p);trigger='invalid-data';}
  else if(action.kind!=='flat'||x.quantity===0){
    for(const e of p.states[g.state].next){
      const passed=guard(e.when,x,metrics);checked.push({label:e.label,passed});
      if(passed){trigger=e.label;enterGraph(g,e.to,x,p);break;}
    }
  }
  const kind=p.states[g.state].action.kind;
  if(kind==='trim')g.goal=Math.min(Math.abs(g.goal),Math.abs(x.quantity));
  const want=g.goal===null?x.quantity:g.goal,rawWeight=want*x.mark/x.equity;
  const weight=Math.min(p.gross_cap,Math.max(-p.gross_cap,rawWeight));
  const metricsBefore=Object.fromEntries(Object.entries(metrics).map(([k,v])=>[k,finite(v)?v:null]));
  return {weights:[0,0,weight],trace:{previous,state:g.state,transition:trigger,action:kind,
    goal_quantity:g.goal,actual_quantity:x.quantity,cap_applied:Math.abs(rawWeight)>p.gross_cap,
    evaluated:checked,metrics_before:metricsBefore}};
}
/** Actual-fill feedback, never called for wishes, decisions or empty IOC. */
export function graphFill(g,{quantityAfter,price,now}){
  if(Math.abs(quantityAfter)<1e-12){g.first_price=g.entry_atr=g.entry_equity=null;g.peak_move=0;g.last_flat=now;}
  else if(g.first_price===null){g.first_price=price;g.entry_atr=g.last_atr;g.entry_equity=g.last_equity;g.peak_move=0;}
}

export function makeState(now,freeze){
  safeTime(now,'start');ensure(freeze!==undefined&&freeze!==null,'Explicit freeze required');
  ensure(typeof freeze==='string'||(typeof freeze==='object'&&!Array.isArray(freeze)),'Invalid freeze');
  const frozen=JSON.parse(JSON.stringify(freeze));
  const symbols=clone(typeof frozen==='object'?(frozen.legacySymbols??DEFAULT_SYMBOLS):DEFAULT_SYMBOLS);
  ensure(Array.isArray(symbols)&&symbols.length>0&&new Set(symbols).size===symbols.length&&
    symbols.every(s=>typeof s==='string'&&/^[A-Za-z0-9]{1,24}$/.test(s)),'Invalid legacySymbols');
  const accounts=Object.fromEntries(PLAYERS.map(p=>[p.id,{id:p.id,name:p.name,cash:1000,qty:{},positions:{},
    equity:1000,gross:0,marginUsed:0,fees:0,funding:0,slippage:0,fills:0,closed:0,wins:0,realized:0,
    peak:1000,maxDD:0,status:'running'}]));
  return {schema:1,protocol:PROTOCOL.id,freeze:frozen,legacySymbols:symbols,startedAt:now,lastObservedAt:null,
    seq:0,lastFundingHour:Math.floor(now/HOUR)*HOUR,oracleBefore:[],decimals:{},liquidity:{},accounts,
    policies:{skoczek:makeGraph(),winner:{coin:null,openedHour:null}},pending:{winner:null,skoczek:null},
    nextSlots:{legacy:nextBoundary(now,QUARTER),skoczek:nextBoundary(now,2*QUARTER),winner:nextBoundary(now,6*HOUR)},
    quality:{missedSlots:0,expiredExecutions:0,blockedSignals:0,gapMinutes:0,fundingApproxEvents:0}};
}
function validateBars(bars,slot){
  ensure(Array.isArray(bars)&&bars.length===256,'Need exactly 256 closed 15m bars');
  bars.forEach((b,i)=>{
    ensure(b.t===slot-(256-i)*QUARTER,'Candle gap/duplicate/future candle');
    ensure([b.o,b.h,b.l,b.c].every(v=>finite(v)&&v>0)&&b.h>=Math.max(b.o,b.c)&&b.l<=Math.min(b.o,b.c)&&b.l<=b.h,'Invalid OHLC');
    ensure(finite(b.v)&&b.v>=0,'Invalid base volume');
  });
}
export function indicators(bars,slot){
  validateBars(bars,slot);
  const closes=bars.map(b=>b.c),a=atr(bars,14).at(-1),r=rsi(closes,14).at(-1),er=efficiencyRatio(closes,closes.length-1,48);
  ensure(finite(a)&&a>0&&finite(r)&&finite(er),'Invalid/warmup indicator');
  return {price:closes.at(-1),atr:a,rsi:r,er,volPct:a/closes.at(-1),barTs:bars.at(-1).t};
}
export function winnerSignal(series,slot){return {slot,features:winnerFeatures(series,slot)};}
function validateWinner(x){
  ensure(x&&typeof x.valid==='boolean','Invalid Winner validity');
  for(const key of ['price','ma168','r24'])ensure(Array.isArray(x[key])&&x[key].length===3&&
    x[key].every(v=>finite(v)&&(key==='r24'||v>0)),`Invalid Winner ${key}`);
  ensure(finite(x.btcOld)&&x.btcOld>0,'Invalid Winner BTC30 anchor');
}
function validateMarket(m,symbol,now,s){
  ensure(m&&[m.mark,m.oracle].every(v=>finite(v)&&v>0),`${symbol}: missing/invalid market`);
  for(const t of [m.observedAt,m.contextAt??m.observedAt]){
    safeTime(t,'market');ensure(t<=now&&now-t<=PROTOCOL.maxSnapshotAgeMs,`${symbol}: stale/future market`);
  }
  ensure(Number.isInteger(m.decimals)&&m.decimals>=0&&m.decimals<=10,`${symbol}: invalid decimals`);
  ensure(finite(m.volume)&&m.volume>=0,`${symbol}: invalid hourly base volume`);
  if(symbol in s.decimals)ensure(s.decimals[symbol]===m.decimals,`${symbol}: lot changed`);
  s.decimals[symbol]=m.decimals;
  for(const [side,sign] of [[m.bids,-1],[m.asks,1]]){
    ensure(Array.isArray(side),`${symbol}: missing depth`);
    side.forEach((l,i)=>ensure(finite(l.px)&&l.px>0&&finite(l.sz)&&l.sz>=0&&(!i||sign*(l.px-side[i-1].px)>=0),`${symbol}: invalid depth`));
  }
  if(m.bids.length&&m.asks.length)ensure(m.bids[0].px<m.asks[0].px,`${symbol}: crossed book`);
}
export function markedEquity(account,markets){return account.cash+sum(Object.entries(account.qty).map(([symbol,q])=>q*markets[symbol].mark));}
function gross(a,markets){return sum(Object.entries(a.qty).map(([symbol,q])=>Math.abs(q)*markets[symbol].mark));}
function observe(a,markets){
  a.equity=markedEquity(a,markets);a.gross=gross(a,markets);a.marginUsed=a.gross/3;
  ensure(finite(a.equity)&&finite(a.gross),'Nonfinite paper account');
  a.peak=Math.max(a.peak,a.equity);a.maxDD=Math.max(a.maxDD,1-a.equity/a.peak);
}
function settleFunding(s,funding,now,events){
  const hour=Math.floor(now/HOUR)*HOUR;
  const held=new Set(Object.values(s.accounts).flatMap(a=>Object.keys(a.positions)));
  if(!held.size){s.lastFundingHour=hour;return;}
  for(let t=s.lastFundingHour+HOUR;t<=hour;t+=HOUR){
    for(const symbol of held){
      const rows=(funding[symbol]??[]).filter(r=>Math.floor(r.time/HOUR)*HOUR===t);
      ensure(rows.length===1&&finite(rows[0].rate)&&Number.isSafeInteger(rows[0].time)&&rows[0].time<=now,`${symbol}: missing/duplicate/invalid funding hour ${t}`);
      const oracle=s.oracleBefore.filter(o=>o.at<t&&symbol in o.prices).at(-1);
      ensure(oracle&&finite(oracle.prices[symbol])&&oracle.prices[symbol]>0&&t-oracle.at<=14*24*HOUR,
        `${symbol}: missing causal pre-settlement oracle ${t}`);
      const stale=t-oracle.at>PROTOCOL.maxPreOracleAgeMs;
      for(const a of Object.values(s.accounts)){
        const q=quantity(a,symbol);if(!q)continue;
        const payment=q*oracle.prices[symbol]*rows[0].rate;
        a.cash-=payment;a.funding+=payment;a.positions[symbol].costs+=payment;s.quality.fundingApproxEvents++;
        if(stale){s.quality.staleFundingEvents=(s.quality.staleFundingEvents??0)+1;
          a.estimatedFunding=(a.estimatedFunding??0)+payment;}
        events.push({kind:'funding',at:t,reportedAt:rows[0].time,observedAt:now,player:a.id,symbol,rate:rows[0].rate,
          oracle:oracle.prices[symbol],oracleAt:oracle.at,payment,
          approximation:stale?'stale-causal-oracle-after-gap':'persisted-pre-hour-oracle',oracleAgeMs:t-oracle.at});
      }
    }
  }
  s.lastFundingHour=hour;
}
function vwap(levels,amount){
  let quantity=0,notional=0;
  for(const l of levels){const used=Math.min(l.sz,amount-quantity);quantity+=used;notional+=used*l.px;if(quantity>=amount-1e-12)break;}
  return {quantity,price:quantity?notional/quantity:0};
}
function consume(levels,amount){for(const l of levels){const used=Math.min(l.sz,amount);l.sz-=used;amount-=used;if(amount<=1e-12)break;}}
function liquidity(s,a,symbol,m,now,contexts){
  const key=a.id+':'+symbol;if(contexts.has(key))return contexts.get(key);
  s.liquidity[a.id]??={};const previous=s.liquidity[a.id][symbol];
  const bucket=Math.floor(now/QUARTER)*QUARTER;
  const repeated=previous&&m.observedAt<=previous.lastSnapshot;
  const used=previous?.bucket===bucket?previous.used:0;
  const record={bucket,used,lastSnapshot:Math.max(m.observedAt,previous?.lastSnapshot??0)};
  s.liquidity[a.id][symbol]=record;
  const result={record,budget:repeated?0:Math.max(0,m.volume/4*PROTOCOL.volumeFraction-used),
    bids:clone(m.bids),asks:clone(m.asks),repeated};
  contexts.set(key,result);return result;
}
function newPosition(player,price,now,atrAtEntry){
  const def=legacy[player];
  return {quantity:0,averageEntry:price,firstPrice:price,openedAt:now,atrAtEntry:atrAtEntry??null,
    realized:0,costs:0,side:'LONG',entryPrice:price,entryTs:new Date(now).toISOString(),
    ...(def?{stopPrice:price-(def.stopAtr??1.6)*atrAtEntry,takeProfit:price+3.2*atrAtEntry,
      bestPrice:price,trailArmed:false,trailAtr:2,bezSmyczy:!!def.bezSmyczy,maxHoldH:36}:{}),
  };
}
function bookFill(s,a,symbol,delta,raw,now,reason,atrAtEntry,events){
  const old=quantity(a,symbol),price=raw*(1+Math.sign(delta)*PROTOCOL.slip),fee=Math.abs(delta)*price*PROTOCOL.fee;
  ensure(delta!==0&&old+delta>=-1e-10,'Invalid paper delta');
  const p=a.positions[symbol]??newPosition(a.id,price,now,atrAtEntry);
  if(delta>0&&old>0)p.averageEntry=(old*p.averageEntry+delta*price)/(old+delta);
  if(delta<0)p.realized+=-delta*(price-p.averageEntry);
  p.costs+=fee;
  let q=old+delta;if(Math.abs(q)<1e-12)q=0;
  p.quantity=q;a.qty[symbol]=q;a.positions[symbol]=p;
  a.cash-=delta*price+fee;a.fees+=fee;a.slippage+=delta*(price-raw);a.fills++;
  events.push({kind:'fill',at:now,player:a.id,symbol,delta,amount:Math.abs(delta),raw,price,fee,
    cash:a.cash,quantity:q,reason});
  if(a.id==='skoczekSOL')graphFill(s.policies.skoczek,{quantityAfter:q,price,now});
  if(old>0&&q===0){
    const net=p.realized-p.costs;a.realized+=net;a.closed++;a.wins+=Number(net>0);
    events.push({kind:'closed',at:now,player:a.id,symbol,net,openedAt:p.openedAt,reason});
    delete a.positions[symbol];delete a.qty[symbol];
  }
}
function execute(s,a,targets,markets,now,events,contexts,{reason='target',atrAtEntry=null,softThreshold=false}={}){
  for(const side of [-1,1])for(const [symbol,goal] of Object.entries(targets)){
    const old=quantity(a,symbol),delta=goal-old;
    if(Math.sign(delta)!==side||Math.abs(delta)<1e-12)continue;
    const m=markets[symbol],lot=10**-m.decimals;
    if(softThreshold&&goal!==0&&Math.abs(delta)*m.mark<Math.max(10,markedEquity(a,markets)*.01))continue;
    const liq=liquidity(s,a,symbol,m,now,contexts),levels=side>0?liq.asks:liq.bids;
    let amount=Math.min(Math.abs(delta),liq.budget,sum(levels.map(l=>l.sz)),side<0?old:Infinity);
    amount=Math.floor(amount/lot+1e-8)*lot;
    const leverage=PLAYERS.find(p=>p.id===a.id).leverage;
    const room=q=>{
      if(!q)return markedEquity(a,markets)>0&&gross(a,markets)<=leverage*markedEquity(a,markets)+1e-8;
      const raw=vwap(levels,q),price=raw.price*(1+PROTOCOL.slip),fee=q*price*PROTOCOL.fee;
      const eq=markedEquity(a,markets)+q*(m.mark-price)-fee;
      return raw.quantity>=q-1e-9&&eq>0&&gross(a,markets)+q*m.mark<=leverage*eq+1e-8;
    };
    if(side>0&&!room(amount)){
      if(!room(0))amount=0;
      else {let lo=0,hi=amount;for(let i=0;i<48;i++){const mid=(lo+hi)/2;if(room(mid))lo=mid;else hi=mid;}amount=Math.floor(lo/lot+1e-8)*lot;}
    }
    const raw=vwap(levels,amount),price=raw.price*(1+side*PROTOCOL.slip);
    if(amount<=0||amount*price<PROTOCOL.minimumOrder||(side>0&&!room(amount))){
      events.push({kind:'blocked',at:now,player:a.id,symbol,reason:liq.repeated?'repeated-book':'lot/minimum/depth/volume/margin',requested:delta});continue;
    }
    ensure(raw.quantity>=amount-1e-9,'Incomplete L2 fill');
    bookFill(s,a,symbol,side*amount,raw.price,now,reason,atrAtEntry,events);
    consume(levels,amount);liq.budget=Math.max(0,liq.budget-amount);liq.record.used+=amount;
    observe(a,markets);
  }
}
function graphTick(s,signal,markets,now,events,contexts){
  const a=s.accounts.skoczekSOL;if(a.status!=='running')return;
  let f={valid:false,atr14:null,er48:null,vol14:null};
  if(signal){const m=indicators(signal.bars,signal.slot);f={valid:true,atr14:m.atr,er48:m.er,vol14:m.volPct};}
  const p=a.positions.SOL,mark=markets.SOL.mark;
  const result=graphDecide(s.policies.skoczek,{now,mark,features:f,quantity:quantity(a,'SOL'),equity:markedEquity(a,markets),
    ageHours:p?(now-p.openedAt)/HOUR:0,cyclePnl:p?p.realized+quantity(a,'SOL')*(mark-p.averageEntry)-p.costs:0});
  const target=result.weights[2]*markedEquity(a,markets)/mark;
  events.push({kind:'decision',at:now,player:a.id,slot:s.nextSlots.skoczek,features:f,...result});
  execute(s,a,{SOL:target},markets,now,events,contexts,{reason:'graph:'+result.trace.state,atrAtEntry:f.atr14,
    softThreshold:!['allocate','trim'].includes(result.trace.action)});
  s.pending.skoczek={slot:s.nextSlots.skoczek,state:s.policies.skoczek.state,goalQuantity:s.policies.skoczek.goal,
    acceptedQuantity:target,actualQuantity:quantity(a,'SOL'),remainingQuantity:target-quantity(a,'SOL')};
}
function legacyExits(s,markets,now,events,contexts){
  for(const id of legacyIds){const a=s.accounts[id];if(a.status!=='running')continue;
    for(const [symbol,p] of Object.entries(a.positions)){
      const px=markets[symbol].mark;p.bestPrice=Math.max(p.bestPrice,px);
      if(!p.trailArmed&&px-p.entryPrice>=p.atrAtEntry)p.trailArmed=true;
      // Original helper, explicit frozen trailing/time fields avoid env defaults.
      const reason=czyWyjsc(p,p.atrAtEntry,px,now);
      if(reason)execute(s,a,{[symbol]:0},markets,now,events,contexts,{reason});
    }
  }
}
function legacyEntries(s,signal,markets,now,events,contexts){
  if(!signal)return;
  const analyzed=Object.fromEntries(s.legacySymbols.map(symbol=>[symbol,indicators(signal.bars[symbol],signal.slot)]));
  for(const id of legacyIds){const a=s.accounts[id],player=PLAYERS.find(p=>p.id===id);if(a.status!=='running')continue;
    for(const symbol of s.legacySymbols){
      if(Object.keys(a.positions).length>=player.maxPositions)break;
      if(quantity(a,symbol))continue;
      const m=analyzed[symbol],entry=legacy[id].wejscie(symbol,m,signal.bars[symbol]);if(!entry)continue;
      ensure(entry.kier==='LONG','Unexpected non-long legacy signal');
      const eq=markedEquity(a,markets),available=Math.max(0,eq-gross(a,markets)/3);
      const margin=Math.min(available,eq*player.allocation),goal=margin*3/markets[symbol].mark;
      events.push({kind:'decision',at:now,slot:signal.slot,player:id,symbol,reason:entry.powod,features:m,goalQuantity:goal});
      execute(s,a,{[symbol]:goal},markets,now,events,contexts,{reason:entry.powod,atrAtEntry:m.atr});
    }
  }
}
function winnerTick(s,signal,markets,now,events){
  const a=s.accounts.winnerBTC30;if(!signal||a.status!=='running')return;
  const x=signal.features??winnerFeatures(signal.series,signal.slot);validateWinner(x);
  const d=winnerDecide(s.policies.winner,x,signal.slot/HOUR,true);s.policies.winner=d.policy;
  const eq=markedEquity(a,markets);
  const targets=Object.fromEntries(coins.map((symbol,j)=>[symbol,d.target[j]*eq/markets[symbol].mark]));
  for(const symbol of coins){const delta=targets[symbol]-quantity(a,symbol);
    if(targets[symbol]!==0&&Math.abs(delta)*markets[symbol].mark<Math.max(10,eq*.01))targets[symbol]=quantity(a,symbol);}
  s.pending.winner={slot:signal.slot,dueAt:signal.slot+QUARTER,expiresAt:signal.slot+2*QUARTER,targets};
  events.push({kind:'decision',at:now,slot:signal.slot,player:a.id,features:x,...d});
}
function prepareSignal(s,name,signal,now,events){
  const step={legacy:QUARTER,skoczek:2*QUARTER,winner:6*HOUR}[name];
  while(s.nextSlots[name]+QUARTER<=now){events.push({kind:'missed',at:now,strategy:name,slot:s.nextSlots[name]});s.nextSlots[name]+=step;s.quality.missedSlots++;}
  if(now<s.nextSlots[name])return false;
  if(signal){ensure(signal.slot===s.nextSlots[name],`${name}: wrong/stale signal slot`);return true;}
  s.quality.blockedSignals++;events.push({kind:'blocked',at:now,strategy:name,slot:s.nextSlots[name],reason:'missing-signal'});
  return name==='skoczek'; // Invalid graph data requests its safety exit once.
}
function validateState(s){
  ensure(s.schema===1&&s.protocol===PROTOCOL.id&&Number.isSafeInteger(s.seq)&&s.seq>=0,'Wrong arena state/protocol');
  ensure(JSON.stringify(Object.keys(s.accounts).sort())===JSON.stringify(PLAYERS.map(p=>p.id).sort()),'Wrong league accounts');
  for(const a of Object.values(s.accounts)){
    ensure(finite(a.cash)&&Object.values(a.qty).every(q=>finite(q)&&q>0),'Corrupt cash/quantity');
    ensure(Object.keys(a.qty).length===Object.keys(a.positions).length,'Corrupt positions');
    for(const [symbol,q] of Object.entries(a.qty))ensure(a.positions[symbol]?.quantity===q,'Position/quantity mismatch');
  }
}
/** Atomic pure tick; persist BOTH returned state and events, or neither. */
export function advance(inputState,{now,markets,signals={},funding={}}){
  safeTime(now,'tick');validateState(inputState);
  ensure(now>=(inputState.lastObservedAt??inputState.startedAt),'Backdated tick');
  if(now===inputState.lastObservedAt)return {state:clone(inputState),events:[]};
  const s=clone(inputState),events=[],contexts=new Map();
  const required=new Set([...s.legacySymbols,...coins,...Object.values(s.accounts).flatMap(a=>Object.keys(a.qty))]);
  for(const symbol of required)validateMarket(markets?.[symbol],symbol,now,s);
  for(const [name,signal] of Object.entries(signals)){
    ensure(['legacy','skoczek','winner'].includes(name),'Unknown signal source');
    if(!signal)continue;safeTime(signal.slot,'signal');
    ensure(signal.slot<=now&&signal.slot%({legacy:QUARTER,skoczek:2*QUARTER,winner:6*HOUR}[name])===0,'Future/misaligned signal');
    if(name==='legacy')for(const symbol of s.legacySymbols)validateBars(signal.bars?.[symbol],signal.slot);
    if(name==='skoczek')validateBars(signal.bars,signal.slot);
    if(name==='winner')validateWinner(signal.features??winnerFeatures(signal.series,signal.slot));
  }
  if(s.lastObservedAt!==null&&now-s.lastObservedAt>QUARTER)s.quality.gapMinutes+=(now-s.lastObservedAt)/60000;
  settleFunding(s,funding,now,events);
  for(const a of Object.values(s.accounts)){
    observe(a,markets);
    if(a.status==='running'&&a.gross>0&&a.equity<=PROTOCOL.maintenance*a.gross){
      a.status='liquidating';events.push({kind:'risk',at:now,player:a.id,reason:'sampled-maintenance-breach',equity:a.equity,gross:a.gross});
      if(a.id==='winnerBTC30')s.pending.winner=null;
    }
    if(a.status==='liquidating'){
      execute(s,a,Object.fromEntries(Object.keys(a.qty).map(symbol=>[symbol,0])),markets,now,events,contexts,{reason:'paper-liquidation'});
      if(!Object.keys(a.qty).length)a.status='halted';
    }
  }
  // Settle old pending Winner quantities before accepting the next decision.
  if(s.pending.winner&&now>=s.pending.winner.expiresAt){events.push({kind:'expired',at:now,player:'winnerBTC30',slot:s.pending.winner.slot});s.pending.winner=null;s.quality.expiredExecutions++;}
  if(s.pending.winner&&now>=s.pending.winner.dueAt){
    execute(s,s.accounts.winnerBTC30,s.pending.winner.targets,markets,now,events,contexts,{reason:'winner-delayed'});
    s.pending.winner=null; // One IOC execution window, as in frozen Winner paper.
  }
  legacyExits(s,markets,now,events,contexts);
  if(prepareSignal(s,'legacy',signals.legacy,now,events)){legacyEntries(s,signals.legacy,markets,now,events,contexts);s.nextSlots.legacy+=QUARTER;}
  if(prepareSignal(s,'skoczek',signals.skoczek,now,events)){graphTick(s,signals.skoczek,markets,now,events,contexts);s.nextSlots.skoczek+=2*QUARTER;}
  if(prepareSignal(s,'winner',signals.winner,now,events)){winnerTick(s,signals.winner,markets,now,events);s.nextSlots.winner+=6*HOUR;}
  for(const a of Object.values(s.accounts))observe(a,markets);
  for(const a of Object.values(s.accounts))if(a.status==='running'&&a.equity<=0){
    a.status=a.gross?'liquidating':'halted';
    events.push({kind:'risk',at:now,player:a.id,reason:'nonpositive-equity',equity:a.equity,gross:a.gross});
    if(a.id==='winnerBTC30')s.pending.winner=null;
  }
  // Each oracle keeps its own causal source timestamp. A bundle's earliest
  // timestamp must NEVER backdate another symbol observed after settlement.
  for(const symbol of required)s.oracleBefore.push({at:markets[symbol].contextAt??markets[symbol].observedAt,
    prices:{[symbol]:markets[symbol].oracle}});
  s.oracleBefore=s.oracleBefore.filter(o=>o.at>=now-2*HOUR);
  s.oracleBefore.sort((a,b)=>a.at-b.at);
  s.lastObservedAt=now;s.seq++;
  return {state:s,events};
}
