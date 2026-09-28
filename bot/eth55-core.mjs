/** Pure, isolated ETH-55 ORIGINAL PAPER reducer. No I/O, orders or wall clock.
 * Inputs and persisted state are caller-owned; advance is atomic on failure.
 * Graph identity is frozen; HL source/rolling warmup/L2 execution are NOT a
 * reproduction of the Binance historical experiment. See ETH55-CORE-API.md.
 */
import {ETH55_SPEC, ORIGINAL, SOURCE_SHA256, deepFreeze} from './eth55-spec.mjs';
export {ETH55_SPEC};
export const MINUTE=60000, HOUR=3600000;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const ensure=(ok,message)=>{if(!ok)throw Error('ETH55: '+message);};
const clone=x=>structuredClone(x);
const sum=xs=>xs.reduce((a,b)=>a+b,0);
const floorMinute=t=>Math.floor(t/MINUTE)*MINUTE;
const safeTime=(t,label)=>ensure(Number.isSafeInteger(t)&&t>=0,'invalid '+label+' timestamp');
export const PROTOCOL=deepFreeze({id:'eth55-original-hl-paper-v1-20260928',schema:1,paper:true,
  ordersEnabled:false,player:'eth55',symbol:'ETH',initial:1000,marginLeverage:1,
  fee:.00045,slip:.0005,maintenance:.05,minimumOrder:10,rebalanceFraction:.01,
  volumeFraction:.001,volumeWindowMinutes:1,decisionMs:MINUTE,decisionWindowMs:45000,
  maxSnapshotAgeMs:60000,maxPreOracleAgeMs:60000,historyBars:256,
  originalId:ETH55_SPEC.id,originalSignature:ORIGINAL.signature,sourceSha256:SOURCE_SHA256,
  storedEnvelopeMinutes:ETH55_SPEC.every_h*60,effectiveEnvelopeMinutes:1,
  source:'Hyperliquid closed 1m TRADE OHLCV; historical original used Binance futures',
  indicators:'Wilder14 ATR/RSI reseeded over all 256 supplied closed bars; ER48; vol14=ATR14/close',
  execution:'observed HL L2 VWAP plus fixed slip and fee; sampled MARK risk, no historic L2 claim',
  minimumModel:'original intent threshold; hard USD10 only for increases; accepted reductions exempt; fully liquid close preserves sub-lot remainder',
  volumeModel:'previous completed 1m base volume * .001; shared budget within execution minute',
  funding:'hourly reported rate * held ETH quantity * persisted pre-hour oracle; oracle approximation disclosed',
  risk:'sampled maintenance/nonpositive equity: L2 liquidation attempts, permanent halt after close',
  missing:'no backfilled decisions/trades; recovery observation gap skips the current signal; missing funding/oracle throws',
  comparison:'NOT_COMPARABLE to historical Binance profits or Winner; no live-profit promise'});

export function makeGraph(){
  return {state:null,since:null,goal:null,start_q:null,first_price:null,entry_atr:null,
    entry_equity:null,peak_move:0,last_atr:null,last_equity:null,last_flat:null};
}
function enterGraph(g,name,x){
  const a=ETH55_SPEC.params.states[name].action;
  g.state=name;g.since=x.now;g.start_q=x.quantity;
  g.goal=a.kind==='allocate'?a.weight*x.equity/x.mark:a.kind==='trim'?x.quantity*a.keep:a.kind==='flat'?0:null;
}
const cmp={gt:(a,b)=>a>b,ge:(a,b)=>a>=b,lt:(a,b)=>a<b,le:(a,b)=>a<=b,eq:(a,b)=>a===b,ne:(a,b)=>a!==b};
function operand(value,x,metrics){
  if(typeof value==='number')return value;
  if('metric'in value)return metrics[value.metric];
  ensure('feature'in value&&value.asset===1,'unsupported frozen graph operand');
  return x.features[value.feature]*(value.scale??1);
}
function guard(rule,x,metrics){
  if(rule.all)return rule.all.every(r=>guard(r,x,metrics));
  if(rule.any)return rule.any.some(r=>guard(r,x,metrics));
  const a=operand(rule.left,x,metrics),b=operand(rule.right,x,metrics);
  ensure(typeof cmp[rule.op]==='function','unsupported graph comparison');
  return finite(a)&&finite(b)&&cmp[rule.op](a,b);
}
/** Mutates only supplied graph memory: one edge per decision, original order. */
export function graphDecide(g,x){
  safeTime(x.now,'decision');
  ensure(finite(x.equity)&&x.equity>0&&finite(x.mark)&&x.mark>0&&finite(x.quantity)&&x.quantity>=0,'invalid graph account');
  const p=ETH55_SPEC.params;
  g.last_atr=finite(x.features.atr14)?x.features.atr14:null;g.last_equity=x.equity;
  if(g.state===null){g.last_flat=x.now;enterGraph(g,p.initial,x);}
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
  if(!valid){if(g.state!==p.exit)enterGraph(g,p.exit,x);trigger='invalid-data';}
  else if(action.kind!=='flat'||x.quantity===0){
    for(const e of p.states[g.state].next){const passed=guard(e.when,x,metrics);checked.push({label:e.label,passed});
      if(passed){trigger=e.label;enterGraph(g,e.to,x);break;}}
  }
  const kind=p.states[g.state].action.kind;
  if(kind==='trim')g.goal=Math.min(Math.abs(g.goal),Math.abs(x.quantity));
  const want=g.goal===null?x.quantity:g.goal,rawWeight=want*x.mark/x.equity;
  const weight=Math.min(p.gross_cap,Math.max(-p.gross_cap,rawWeight));
  return {weights:[0,weight,0],trace:{previous,state:g.state,transition:trigger,action:kind,
    goal_quantity:g.goal,actual_quantity:x.quantity,cap_applied:Math.abs(rawWeight)>p.gross_cap,
    evaluated:checked,metrics_before:Object.fromEntries(Object.entries(metrics).map(([k,v])=>[k,finite(v)?v:null]))}};
}
/** Actual fills only; empty/blocked attempts must never call this seam. */
export function graphFill(g,{quantityAfter,price,now}){
  safeTime(now,'fill');ensure(finite(quantityAfter)&&quantityAfter>=0&&finite(price)&&price>0,'invalid graph fill');
  if(Math.abs(quantityAfter)<1e-12){g.first_price=g.entry_atr=g.entry_equity=null;g.peak_move=0;g.last_flat=now;}
  else if(g.first_price===null){
    ensure(finite(g.last_atr)&&g.last_atr>0&&finite(g.last_equity)&&g.last_equity>0,'first fill without decision context');
    g.first_price=price;g.entry_atr=g.last_atr;g.entry_equity=g.last_equity;g.peak_move=0;
  }
}

function validateBars(bars,slot){
  safeTime(slot,'signal');ensure(slot%MINUTE===0,'misaligned signal');
  ensure(Array.isArray(bars)&&bars.length>0&&bars.length<=256,'need 1..256 closed 1m bars');
  bars.forEach((b,i)=>{
    ensure(b.t===slot-(bars.length-i)*MINUTE,'candle gap/duplicate/future candle');
    ensure([b.o,b.h,b.l,b.c].every(v=>finite(v)&&v>0)&&b.h>=Math.max(b.o,b.c)&&b.l<=Math.min(b.o,b.c)&&b.l<=b.h,'invalid OHLC');
    ensure(finite(b.v)&&b.v>=0,'invalid base volume');
  });
}
export function indicators(bars,slot){
  validateBars(bars,slot);
  if(bars.length!==256)return {valid:false,reason:'warmup',observedBars:bars.length,requiredBars:256,
    atr14:null,rsi14:null,er48:null,vol14:null,price:bars.at(-1).c,barTs:bars.at(-1).t};
  // Original Wilder seeding: changes/TR at indices 1..14, excluding row 0 TR.
  let a=0,gain=0,loss=0;
  for(let i=1;i<bars.length;i++){
    const b=bars[i],previous=bars[i-1].c,d=b.c-previous;
    const tr=Math.max(b.h-b.l,Math.abs(b.h-previous),Math.abs(b.l-previous));
    if(i<=14){a+=tr;gain+=Math.max(d,0);loss+=Math.max(-d,0);if(i===14){a/=14;gain/=14;loss/=14;}}
    else {a=(a*13+tr)/14;gain=(gain*13+Math.max(d,0))/14;loss=(loss*13+Math.max(-d,0))/14;}
  }
  const last=bars.length-1;let travel=0;
  for(let i=last-47;i<=last;i++)travel+=Math.abs(bars[i].c-bars[i-1].c);
  const er=travel>0?Math.abs(bars[last].c-bars[last-48].c)/travel:0;
  const rsi=loss===0?100:100-100/(1+gain/loss),price=bars[last].c;
  const valid=[a,rsi,er].every(finite)&&a>0;
  return {valid,reason:valid?null:'invalid-indicator',observedBars:256,requiredBars:256,
    atr14:finite(a)?a:null,rsi14:finite(rsi)?rsi:null,er48:finite(er)?er:null,
    vol14:finite(a/price)?a/price:null,price,barTs:bars[last].t};
}

function validateFreeze(freeze){
  const hash=typeof freeze==='string'?freeze:freeze?.hash;
  ensure(typeof hash==='string'&&/^[a-f0-9]{64}$/i.test(hash),'explicit SHA256 freeze.hash required');
  if(typeof freeze==='object'&&freeze.sourceSha256!==undefined)ensure(freeze.sourceSha256===SOURCE_SHA256,'wrong frozen ORIGINAL source');
}
export function makeState(now,freeze){
  safeTime(now,'start');validateFreeze(freeze);
  return {schema:1,protocol:PROTOCOL.id,freeze:clone(freeze),sourceSha256:SOURCE_SHA256,
    originalSignature:ORIGINAL.signature,startedAt:now,lastObservedAt:null,lastFundingHour:Math.floor(now/HOUR)*HOUR,
    seq:0,nextSlot:floorMinute(now)+MINUTE,oracleBefore:[],decimals:null,lastMarket:null,
    liquidity:{slot:null,used:0,volume:null,lastBookAt:null},
    accounts:{eth55:{id:'eth55',name:'ETH-55 ORIGINAL',cash:1000,qty:{ETH:0},positions:{},equity:1000,gross:0,
      marginUsed:0,fees:0,funding:0,slippage:0,fills:0,closed:0,wins:0,realized:0,peak:1000,maxDD:0,status:'running'}},
    policies:{eth55:makeGraph()},pending:{eth55:null},
    quality:{missedSlots:0,blockedSignals:0,gapMinutes:0,fundingApproxEvents:0}};
}
function validateState(s){
  ensure(s&&s.schema===1&&s.protocol===PROTOCOL.id&&s.sourceSha256===SOURCE_SHA256&&s.originalSignature===ORIGINAL.signature,'wrong state identity');
  validateFreeze(s.freeze);safeTime(s.startedAt,'state start');
  ensure(Number.isSafeInteger(s.seq)&&s.seq>=0,'invalid sequence');
  if(s.lastObservedAt!==null){safeTime(s.lastObservedAt,'last observation');ensure(s.lastObservedAt>=s.startedAt,'observation precedes start');}
  safeTime(s.lastFundingHour,'funding watermark');safeTime(s.nextSlot,'next slot');
  ensure(s.lastFundingHour%HOUR===0&&s.lastFundingHour<=Math.floor((s.lastObservedAt??s.startedAt)/HOUR)*HOUR,'invalid funding watermark');
  ensure(s.nextSlot%MINUTE===0&&s.nextSlot>(s.lastObservedAt??s.startedAt),'invalid next slot');
  ensure(Object.keys(s.accounts??{}).join()==='eth55'&&Object.keys(s.policies??{}).join()==='eth55','wrong account/policy set');
  const a=s.accounts.eth55,g=s.policies.eth55,q=a.qty?.ETH,p=a.positions?.ETH;
  ensure(a.id==='eth55'&&Object.keys(a.qty).join()==='ETH'&&finite(q)&&q>=0,'corrupt ETH quantity');
  ensure(Object.keys(a.positions).every(k=>k==='ETH')&&(q>0?!!p&&!Object.keys(a.positions).some(k=>k!=='ETH'):!p),'corrupt positions');
  for(const name of ['cash','equity','gross','marginUsed','fees','funding','slippage','realized','peak','maxDD'])ensure(finite(a[name]),'nonfinite account '+name);
  for(const name of ['fills','closed','wins'])ensure(Number.isSafeInteger(a[name])&&a[name]>=0,'invalid account counter');
  ensure(a.fees>=0&&a.gross>=0&&a.peak>=1000&&a.wins<=a.closed&&['running','liquidating','halted'].includes(a.status),'invalid account state');
  ensure(a.status!=='halted'||q===0,'halted account still holds a position');
  if(p){safeTime(p.openedAt,'position open');ensure(p.quantity===q&&p.averageEntry>0&&p.firstPrice>0&&p.atrAtEntry>0&&
    [p.averageEntry,p.firstPrice,p.atrAtEntry,p.realized,p.costs].every(finite),'corrupt position');}
  const expectedCash=1000+a.realized+(p?p.realized-p.costs-q*p.averageEntry:0);
  ensure(Math.abs(a.cash-expectedCash)<=1e-7*Math.max(1,Math.abs(a.cash)/1000),'cash/cycle accounting mismatch');
  ensure(g.state===null||Object.hasOwn(ETH55_SPEC.params.states,g.state),'unknown graph state');
  for(const [key,value] of Object.entries(g))if(key!=='state')ensure(value===null||finite(value),'invalid graph memory '+key);
  for(const key of ['since','last_flat'])if(g[key]!==null){safeTime(g[key],'graph '+key);ensure(g[key]<=(s.lastObservedAt??s.startedAt),'future graph memory');}
  ensure(g.goal===null||g.goal>=0,'negative long-only graph goal');
  ensure(q===0?g.first_price===null:g.first_price>0&&g.entry_atr>0&&g.entry_equity>0,'position/graph memory mismatch');
  ensure(Array.isArray(s.oracleBefore)&&s.oracleBefore.length<=3,'invalid oracle history');
  for(const o of s.oracleBefore){safeTime(o.at,'oracle');ensure(o.at<=(s.lastObservedAt??s.startedAt)&&finite(o.price)&&o.price>0,'invalid causal oracle');}
  ensure(finite(s.liquidity?.used)&&s.liquidity.used>=0,'invalid liquidity usage');
}
function validateMarket(m,now,s,signal){
  ensure(m&&[m.mark,m.oracle].every(v=>finite(v)&&v>0),'missing mark/oracle');
  if(m.symbol!==undefined)ensure(m.symbol==='ETH','wrong market symbol');
  for(const t of [m.observedAt,m.contextAt]){safeTime(t,'market');ensure(t<=now&&now-t<=PROTOCOL.maxSnapshotAgeMs,'stale/future market');}
  ensure(Number.isInteger(m.decimals)&&m.decimals>=0&&m.decimals<=8,'invalid lot decimals');
  ensure(s.decimals===null||s.decimals===m.decimals,'lot changed after freeze');
  ensure(m.volumeWindowMinutes===1&&finite(m.volume)&&m.volume>=0,'expected previous closed 1m base volume');
  const slot=m.volumeSlot??(signal?signal.slot-MINUTE:null);
  ensure(slot===floorMinute(now)-MINUTE,'wrong/future volume minute');
  if(signal){ensure(signal.slot===floorMinute(now),'wrong/stale signal slot');validateBars(signal.bars,signal.slot);
    ensure(signal.bars.at(-1).v===m.volume,'volume disagrees with last closed candle');}
  for(const [side,sign] of [[m.bids,-1],[m.asks,1]]){
    ensure(Array.isArray(side)&&side.length<=200,'missing/oversize L2 depth');
    side.forEach((l,i)=>ensure(finite(l.px)&&l.px>0&&finite(l.sz)&&l.sz>=0&&(!i||sign*(l.px-side[i-1].px)>=0),'invalid L2 depth'));
  }
  if(m.bids.length&&m.asks.length)ensure(m.bids[0].px<m.asks[0].px,'crossed book');
  const fingerprint=JSON.stringify([m.bids,m.asks]),old=s.lastMarket;
  if(old){
    ensure(m.observedAt>=old.observedAt&&m.contextAt>=old.contextAt,'market clock regressed');
    if(m.observedAt===old.observedAt)ensure(fingerprint===old.book,'book changed under repeated timestamp');
    if(m.contextAt===old.contextAt)ensure(m.mark===old.mark&&m.oracle===old.oracle,'context changed under repeated timestamp');
  }
  return fingerprint;
}
function observe(a,m){
  a.equity=a.cash+a.qty.ETH*m.mark;a.gross=a.qty.ETH*m.mark;a.marginUsed=a.gross;
  ensure(finite(a.equity)&&finite(a.gross),'nonfinite marked account');
  a.peak=Math.max(a.peak,a.equity);a.maxDD=Math.max(a.maxDD,1-a.equity/a.peak);
}
function settleFunding(s,rows,now,events){
  ensure(Array.isArray(rows),'funding must be an array');const map=new Map();
  for(const row of rows){safeTime(row.time,'funding');ensure(row.time%HOUR===0&&row.time<=now&&finite(row.rate)&&Math.abs(row.rate)<=.04,'invalid/future funding');
    ensure(!map.has(row.time),'duplicate funding hour');map.set(row.time,row.rate);}
  const hour=Math.floor(now/HOUR)*HOUR,a=s.accounts.eth55,q=a.qty.ETH;
  if(q>0)for(let t=s.lastFundingHour+HOUR;t<=hour;t+=HOUR){
    ensure(map.has(t),'missing funding hour '+t);
    const oracle=s.oracleBefore.filter(o=>o.at<t).sort((a,b)=>a.at-b.at).at(-1);
    ensure(oracle&&t-oracle.at<=PROTOCOL.maxPreOracleAgeMs,'missing persisted pre-hour oracle '+t);
    const rate=map.get(t),payment=q*oracle.price*rate;
    a.cash-=payment;a.funding+=payment;a.positions.ETH.costs+=payment;s.quality.fundingApproxEvents++;
    events.push({kind:'funding',at:t,observedAt:now,player:'eth55',symbol:'ETH',rate,payment,
      oracle:oracle.price,oracleAt:oracle.at,approximation:'persisted-pre-hour-oracle',quantity:q,cash:a.cash});
  }
  s.lastFundingHour=hour;
}
function vwap(levels,amount){
  let quantity=0,notional=0;
  for(const l of levels){const used=Math.min(l.sz,Math.max(0,amount-quantity));quantity+=used;notional+=used*l.px;if(quantity>=amount-1e-12)break;}
  return {quantity,price:quantity?notional/quantity:0};
}
function bookFill(s,delta,raw,now,reason,events){
  const a=s.accounts.eth55,old=a.qty.ETH,price=raw*(1+Math.sign(delta)*PROTOCOL.slip),fee=Math.abs(delta)*price*PROTOCOL.fee;
  ensure(delta!==0&&old+delta>=-1e-10,'invalid fill delta');
  const p=a.positions.ETH??{quantity:0,averageEntry:price,firstPrice:price,openedAt:now,
    atrAtEntry:s.policies.eth55.last_atr,realized:0,costs:0,side:'LONG'};
  if(delta>0&&old>0)p.averageEntry=(old*p.averageEntry+delta*price)/(old+delta);
  if(delta<0)p.realized+=-delta*(price-p.averageEntry);
  p.costs+=fee;let q=old+delta;if(Math.abs(q)<1e-12)q=0;
  p.quantity=q;a.qty.ETH=q;a.positions.ETH=p;a.cash-=delta*price+fee;
  a.fees+=fee;a.slippage+=delta*(price-raw);a.fills++;
  events.push({kind:'fill',at:now,player:'eth55',symbol:'ETH',delta,amount:Math.abs(delta),raw,price,fee,
    cash:a.cash,quantity:q,reason});
  graphFill(s.policies.eth55,{quantityAfter:q,price,now});
  if(old>0&&q===0){const net=p.realized-p.costs;a.realized+=net;a.closed++;a.wins+=Number(net>0);
    events.push({kind:'closed',at:now,player:'eth55',symbol:'ETH',net,openedAt:p.openedAt,reason});delete a.positions.ETH;}
}
function execute(s,target,m,now,events,{reason,action='flat'}={}){
  const a=s.accounts.eth55,old=a.qty.ETH,delta=target-old,side=Math.sign(delta),liq=s.liquidity;
  if(Math.abs(delta)<1e-12)return;
  const minimum=['allocate','trim'].includes(action)?10:Math.max(10,a.equity*.01);
  if(target!==0&&Math.abs(delta)*m.mark<minimum){events.push({kind:'blocked',at:now,player:'eth55',reason:'minimum-intent',requested:delta});return;}
  const repeated=liq.lastBookAt!==null&&m.observedAt<=liq.lastBookAt;
  const levels=side>0?m.asks:m.bids,lot=10**-m.decimals;
  const budget=Math.max(0,liq.volume*.001-liq.used);
  liq.lastBookAt=Math.max(liq.lastBookAt??0,m.observedAt);
  if(repeated||m.observedAt<floorMinute(now)){
    events.push({kind:'blocked',at:now,player:'eth55',reason:repeated?'repeated-book':'pre-slot-book',requested:delta});return;
  }
  let amount=Math.min(Math.abs(delta),budget,sum(levels.map(l=>l.sz)),side<0?old:Infinity);
  const rounded=q=>Math.floor(Math.max(0,q)/lot+1e-8)*lot;
  // Frozen CPU round_amount(closing=True): close the actual remainder if
  // liquidity permits; otherwise partial reductions still round down to lot.
  amount=target===0&&side<0&&amount>=old-1e-12?old:rounded(amount);
  const room=q=>{
    const raw=vwap(levels,q),price=raw.price*(1+PROTOCOL.slip),fee=q*price*PROTOCOL.fee;
    const eq=a.equity+q*(m.mark-price)-fee;
    return raw.quantity>=q-1e-10&&eq>0&&a.gross+q*m.mark<=eq+1e-8;
  };
  if(side>0&&!room(amount)){
    if(!room(0))amount=0;
    else {let lo=0,hi=amount;for(let i=0;i<48;i++){const mid=(lo+hi)/2;if(room(mid))lo=mid;else hi=mid;}amount=rounded(lo);}
  }
  const raw=vwap(levels,amount),price=raw.price*(1+side*PROTOCOL.slip);
  // Original reductions have no hard fill minimum. The nonzero-goal intent
  // threshold above remains unchanged, including for small trim intentions.
  if(amount<=0||(side>0&&(amount*price<10||!room(amount)))){
    events.push({kind:'blocked',at:now,player:'eth55',reason:'lot/minimum/depth/volume/margin',requested:delta});return;
  }
  ensure(raw.quantity>=amount-1e-10,'incomplete L2 execution');
  bookFill(s,side*amount,raw.price,now,reason,events);liq.used+=amount;observe(a,m);
}
function risk(s,m,now,events){
  const a=s.accounts.eth55;observe(a,m);
  if(a.status==='running'&&(a.equity<=0||(a.gross>0&&a.equity<=PROTOCOL.maintenance*a.gross))){
    a.status=a.qty.ETH>0?'liquidating':'halted';s.pending.eth55=null;
    events.push({kind:'risk',at:now,player:'eth55',reason:'sampled-maintenance/nonpositive-equity',equity:a.equity,gross:a.gross});
  }
  if(a.status==='liquidating'){
    execute(s,0,m,now,events,{reason:'paper-liquidation'});
    if(a.qty.ETH===0)a.status='halted';
  }
}

/** Caller persists state+events atomically. Duplicate now is a no-op (same seq). */
export function advance(inputState,{now,market,signal=null,funding=[]}){
  safeTime(now,'tick');validateState(inputState);
  ensure(now>=(inputState.lastObservedAt??inputState.startedAt),'backdated tick');
  if(now===inputState.lastObservedAt)return {state:clone(inputState),events:[]};
  const fingerprint=validateMarket(market,now,inputState,signal),s=clone(inputState),events=[];
  const slot=floorMinute(now),a=s.accounts.eth55,previousObservation=s.lastObservedAt??s.startedAt;
  // Scheduler/HTTP jitter within adjacent minute slots is not a missing slot.
  const gap=slot-floorMinute(previousObservation)>MINUTE;
  if(gap){s.quality.gapMinutes+=(now-previousObservation)/MINUTE;
    events.push({kind:'gap',at:now,player:'eth55',from:previousObservation,to:now,reason:'unobserved-path-no-replay'});}
  s.decimals=market.decimals;
  if(s.liquidity.slot!==slot){s.liquidity.slot=slot;s.liquidity.used=0;s.liquidity.volume=market.volume;}
  else ensure(s.liquidity.volume===market.volume,'closed minute volume changed within bucket');
  settleFunding(s,funding,now,events);risk(s,market,now,events);
  if(slot>s.nextSlot){const count=(slot-s.nextSlot)/MINUTE;s.quality.missedSlots+=count;
    events.push({kind:'missed',at:now,player:'eth55',from:s.nextSlot,to:slot,count});s.nextSlot=slot;}
  if(now>=s.nextSlot){
    if(now-s.nextSlot>=PROTOCOL.decisionWindowMs){s.quality.missedSlots++;
      events.push({kind:'missed',at:now,player:'eth55',slot:s.nextSlot,count:1,reason:'expired-45s-window'});}
    else if(gap||!signal){s.quality.blockedSignals++;
      events.push({kind:'blocked',at:now,player:'eth55',slot:s.nextSlot,reason:gap?'observation-gap':'missing-signal'});}
    else if(a.status==='running'){
      const f=indicators(signal.bars,signal.slot),p=a.positions.ETH;
      const decision=graphDecide(s.policies.eth55,{now,mark:market.mark,features:f,quantity:a.qty.ETH,equity:a.equity,
        ageHours:p?(now-p.openedAt)/HOUR:0,cyclePnl:p?p.realized+a.qty.ETH*(market.mark-p.averageEntry)-p.costs:0});
      const target=decision.weights[1]*a.equity/market.mark;
      events.push({kind:'decision',at:now,slot:signal.slot,player:'eth55',symbol:'ETH',features:f,...decision});
      if(!f.valid)s.quality.blockedSignals++;
      execute(s,target,market,now,events,{reason:'graph:'+decision.trace.state,action:decision.trace.action});
      s.pending.eth55={slot:signal.slot,state:s.policies.eth55.state,goalQuantity:s.policies.eth55.goal,
        acceptedQuantity:target,actualQuantity:a.qty.ETH,remainingQuantity:target-a.qty.ETH,
        execution:'one-attempt-no-pending-order'};
      risk(s,market,now,events);
    }
    s.nextSlot+=MINUTE;
  }
  const oracleHour=Math.floor(market.contextAt/HOUR)*HOUR;
  s.oracleBefore=s.oracleBefore.filter(o=>Math.floor(o.at/HOUR)*HOUR!==oracleHour&&o.at>=Math.floor(now/HOUR)*HOUR-2*HOUR);
  s.oracleBefore.push({at:market.contextAt,price:market.oracle});s.oracleBefore.sort((a,b)=>a.at-b.at);
  s.lastMarket={observedAt:market.observedAt,contextAt:market.contextAt,mark:market.mark,oracle:market.oracle,book:fingerprint};
  s.lastObservedAt=now;s.seq++;observe(a,market);validateState(s);
  return {state:s,events};
}
