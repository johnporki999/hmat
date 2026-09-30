/** Live execution planning/receipt reducer. Pure: no network, keys or orders. */
import crypto from 'node:crypto';
import {LOWCA_SOURCE,makeLowca,lowcaDecide,lowcaFill} from './lowca-policy.mjs';
import {makeGraph,graphDecide,graphFill} from './lowca-graph.mjs';
export const CONFIRM=LOWCA_SOURCE.signature;
export const STEP=6*3600000,WINDOW=900000;
const ok=(c,m)=>{if(!c)throw Error(m);},num=Number,finite=Number.isFinite;
export function assertActivation(env){
  ok(env.REALNY_LOWCA_CONFIRM===CONFIRM&&env.REALNY_SUCHY==='0','LOWCA_NOT_ACTIVATED');
  ok(/^0x[0-9a-f]{40}$/i.test(env.REALNY_KONTO??''),'INVALID_ACCOUNT');
  ok(/^(0x)?[0-9a-f]{64}$/i.test(env.REALNY_AGENT_KEY??''),'INVALID_AGENT');
}
export function account(perp,orders){
  ok(perp&&Array.isArray(perp.assetPositions)&&Array.isArray(orders),'MISSING_EXCHANGE_ACCOUNT');
  ok(orders.length===0,'ACCOUNT_HAS_OPEN_ORDERS');
  const positions=perp.assetPositions.map(x=>x.position).filter(p=>num(p.szi)!==0);
  ok(positions.every(p=>p.coin==='SOL'&&finite(num(p.szi))&&num(p.szi)>0),'FOREIGN_OR_SHORT_POSITION');
  ok(positions.length<=1,'DUPLICATE_POSITION');
  const equity=num(perp.marginSummary?.accountValue),available=num(perp.withdrawable);
  ok(finite(equity)&&equity>0&&finite(available)&&available>=0,'UNSUPPORTED_OR_EMPTY_ACCOUNT');
  const p=positions[0];
  return {equity,available,q:p?num(p.szi):0,entry:p?num(p.entryPx):null,
    liquidation:p&&finite(num(p.liquidationPx))&&num(p.liquidationPx)>0?num(p.liquidationPx):null};
}
export function predecessor(s){
  ok(s&&s.gracz==='sitoOstre'&&s.suchy===false&&s.pozycje&&typeof s.pozycje==='object'&&!Array.isArray(s.pozycje),
    'MISSING_OR_INVALID_PREDECESSOR');
  ok(Object.keys(s.pozycje).length===0,'PREDECESSOR_NOT_FLAT');
}
export function initialize({now,snapshot,prior,freeze,identity}){
  predecessor(prior);ok(snapshot.q===0,'EXCHANGE_NOT_FLAT');
  return {schema:1,gracz:'lowcaSOL',suchy:false,source:LOWCA_SOURCE,freeze,identity,przejalPo:'sitoOstre',
    utworzony:new Date(now).toISOString(),start:snapshot.equity,szczyt:snapshot.equity,kapital:snapshot.equity,
    quantity:0,cycle:null,closed:0,fees:0,funding:0,policy:makeLowca(),
    nextSlot:(Math.floor(now/STEP)+1)*STEP,pending:null,serial:0,lastRun:null,ledger:[],equity:[],finishedCycles:[]};
}
export function validate(s,freeze,identity){
  ok(s.schema===1&&s.gracz==='lowcaSOL'&&s.suchy===false&&s.freeze===freeze&&s.identity===identity,'LIVE_FREEZE_OR_ACCOUNT_CHANGED');
  ok(finite(s.quantity)&&s.quantity>=0&&Array.isArray(s.ledger)&&s.policy&&Number.isSafeInteger(s.nextSlot),'CORRUPT_LIVE_STATE');
}
export function reconcile(s,a,decimals){
  ok(Math.abs(s.quantity-a.q)<Math.max(1e-12,.01*10**-decimals),'EXTERNAL_POSITION_CHANGE');
}
const px=(v,d)=>num(num(v.toPrecision(5)).toFixed(Math.max(0,6-d)));
const floor=(q,d)=>num((Math.floor((q+1e-12)*10**d)/10**d).toFixed(d));
export function plan(input,{now,mark,features,snapshot,decimals,asset,taker}){
  const s=structuredClone(input);ok(!s.pending,'UNRESOLVED_ORDER');reconcile(s,snapshot,decimals);
  ok(finite(mark)&&mark>0&&Number.isSafeInteger(decimals)&&decimals>=0&&decimals<=6&&
    Number.isSafeInteger(asset)&&asset>=0&&finite(taker)&&taker>=0&&taker<.01,'INVALID_MARKET');
  s.lastRun=new Date(now).toISOString();s.kapital=snapshot.equity;s.szczyt=Math.max(s.szczyt,s.kapital);
  while(s.nextSlot+WINDOW<=now)s.nextSlot+=STEP;
  if(now<s.nextSlot)return {state:s,intent:null};
  const slot=s.nextSlot;s.nextSlot+=STEP;
  const r=lowcaDecide(s.policy,{now,mark,features,quantity:s.quantity,equity:snapshot.equity,
    ageHours:s.cycle?(now-s.cycle.at)/3600000:0,cyclePnl:0},graphDecide,makeGraph);
  let target=r.weights[2]*snapshot.equity/mark;
  const buy=target>s.quantity,limit=px(mark*(buy?1.01:.99),decimals);
  if(buy){
    // Fee/slippage-aware admission limit. No order may require more than
    // available margin or put projected notional above 3x equity.
    const room=Math.max(0,Math.min(3*snapshot.available/(1+3*taker),
      (3*snapshot.equity-s.quantity*mark)/(1+3*taker)))/limit;
    target=Math.min(target,s.quantity+room);
  }
  // Holding must not constantly re-balance against tiny mark/fee changes.
  let amount=floor(Math.abs(target-s.quantity),decimals);
  if(['hold','flat'].includes(r.trace.action)&&target!==0&&amount*mark<Math.max(10,.01*snapshot.equity))amount=0;
  s.decision={at:now,slot,mark,features,trace:r.trace,target};
  // Never strand a small position: full reduce-only exit may be below the
  // opening minimum. If exchange rejects it, retain the position/intent.
  if(!amount||(amount*mark<10&&!(target===0&&!buy)))return {state:s,intent:null};
  const c='0x'+crypto.createHash('sha256').update(s.identity+':'+s.freeze+':'+(++s.serial)).digest('hex').slice(0,32);
  const intent={at:now,slot,priorQuantity:s.quantity,amount,buy,limit,mark,c,atr:features.atr14,
    expectedEntry:!s.quantity,reason:r.trace.transition??r.trace.state,
    order:{a:asset,b:buy,p:String(limit),s:String(amount),r:!buy,t:{limit:{tif:'Ioc'}},c}};
  s.pending=intent;return {state:s,intent};
}
export function acceptReceipt(input,{status,rows,snapshot,decimals,now}){
  const s=structuredClone(input),p=s.pending;ok(p,'NO_PENDING_ORDER');
  ok(Array.isArray(rows)&&rows.length<2000,'INCOMPLETE_FILL_HISTORY');
  ok(status?.status==='order','UNKNOWN_ORDER_DO_NOT_RETRY');
  const order=status.order?.order,ending=status.order?.status;
  ok(order&&order.coin==='SOL'&&order.cloid===p.c,'ORDER_IDENTITY_MISMATCH');
  ok(ending==='filled'||ending==='canceled'||ending==='rejected'||/Canceled$|Rejected$/.test(ending??''),
    'ORDER_NOT_TERMINAL');
  const fills=rows.filter(f=>f.oid===order.oid).sort((a,b)=>a.time-b.time||a.tid-b.tid);
  ok(new Set(fills.map(f=>f.tid)).size===fills.length,'DUPLICATE_FILL');
  let q=p.priorQuantity,amount=0;
  for(const f of fills){
    ok(f.coin==='SOL'&&f.feeToken==='USDC'&&f.side===(p.buy?'B':'A')&&
      [f.px,f.sz,f.fee,f.startPosition,f.closedPnl].every(v=>finite(num(v)))&&
      num(f.px)>0&&num(f.sz)>0&&f.time>=p.at-1000&&f.time<=now,'INVALID_REAL_FILL');
    ok(Math.abs(num(f.startPosition)-q)<Math.max(1e-12,.01*10**-decimals),'FILL_POSITION_MISMATCH');
    q+=num(f.sz)*(p.buy?1:-1);amount+=num(f.sz);if(Math.abs(q)<1e-12)q=0;
    ok(q>=0&&amount<=p.amount+1e-10,'OVERFILL_OR_FLIP');
    if(!s.cycle)s.cycle={at:f.time,entryPrice:num(f.px),atr:p.atr,initialEquity:s.kapital,pnl:0,fees:0,funding:0};
    const net=num(f.closedPnl)-num(f.fee);s.fees+=num(f.fee);s.cycle.pnl+=net;s.cycle.fees+=num(f.fee);
    lowcaFill(s.policy,{quantityAfter:q,price:num(f.px),now:f.time},graphFill);
    s.ledger.push({ts:new Date(f.time).toISOString(),sym:'SOL',side:'LONG',typ:p.buy?'OPEN':'REDUCE',
      powod:p.reason,cenaWidziana:p.mark,cenaWypelnienia:num(f.px),sz:num(f.sz),oid:f.oid,tid:f.tid,
      oplata:num(f.fee),pnlUsd:num(f.closedPnl),poslizg:(num(f.px)/p.mark-1)*(p.buy?1:-1)});
    if(!q){
      s.closed++;s.ledger.push({ts:new Date(f.time).toISOString(),sym:'SOL',side:'LONG',typ:'CLOSE',
        powod:p.reason,entryTs:new Date(s.cycle.at).toISOString(),entryPrice:s.cycle.entryPrice,
        cenaWypelnienia:num(f.px),pnlUsd:s.cycle.pnl+s.cycle.funding,oplata:0,
        // Net cycle result divided by initial account equity (not a trade's margin).
        R:(s.cycle.pnl+s.cycle.funding)/s.cycle.initialEquity,miaraR:'equity-at-cycle-start',
        fundingUsd:s.cycle.funding,trzymane_h:(f.time-s.cycle.at)/3600000});
      s.finishedCycles.push({...s.cycle,endedAt:f.time,ledgerIndex:s.ledger.length-1});s.cycle=null;
    }
  }
  if(ending==='filled')ok(amount>0,'FILLED_WITHOUT_RECEIPTS');
  s.quantity=q;reconcile(s,snapshot,decimals);s.pending=null;
  s.kapital=snapshot.equity;s.szczyt=Math.max(s.szczyt,s.kapital);return s;
}
export function funding(input,rows,from,to){
  const s=structuredClone(input);ok(Array.isArray(rows)&&rows.length<500,'INCOMPLETE_FUNDING');
  const seen=new Set();
  for(const r of rows){
    ok(r.delta?.type==='funding'&&r.delta.coin==='SOL'&&finite(num(r.delta.usdc))&&
      Number.isSafeInteger(r.time)&&r.time>=from&&r.time<=to,'INVALID_FUNDING');
    const id=r.time+':'+r.hash;ok(!seen.has(id),'DUPLICATE_FUNDING');seen.add(id);
    s.funding+=num(r.delta.usdc);
    if(s.cycle&&r.time>=s.cycle.at)s.cycle.funding+=num(r.delta.usdc);
    else {
      const cycle=s.finishedCycles.find(c=>r.time>=c.at&&r.time<=c.endedAt);
      ok(cycle,'FUNDING_WITHOUT_OWNED_CYCLE');cycle.funding+=num(r.delta.usdc);
      const close=s.ledger[cycle.ledgerIndex];close.fundingUsd=cycle.funding;
      close.pnlUsd=cycle.pnl+cycle.funding;close.R=close.pnlUsd/cycle.initialEquity;
    }
    s.ledger.push({ts:new Date(r.time).toISOString(),sym:'SOL',typ:'FUNDING',pnlUsd:num(r.delta.usdc)});
  }
  s.fundingTo=to;return s;
}
export function publicState(s,a){
  const cycle=s.cycle;
  return {wersja:1,gracz:'lowcaSOL',suchy:false,start:s.start,utworzony:s.utworzony,startZrodlo:'konto',
    cash:a.equity-a.q*(a.entry??0)/3,kapital:a.equity,szczyt:s.szczyt,zamkniete:s.closed,koniec:null,
    przejalPo:'sitoOstre',lastRun:s.lastRun,ceny:s.decision?{SOL:s.decision.mark}:{},skan:[],
    ustawienia:{lewar:3,miejsc:1,alloc:1,maxTrejdow:0},source:s.source,decision:s.decision,
    pozycje:a.q?{SOL:{sym:'SOL',side:'LONG',sz:a.q,entryPrice:a.entry,entryTs:new Date(cycle.at).toISOString(),
      margin:a.q*a.entry/3,notional:a.q*a.entry,leverage:3,liqPrice:a.liquidation,
      atrAtEntry:cycle.atr,stage:s.policy.child?.state,stopPrice:cycle.entryPrice-.8*cycle.atr,
      takeProfit:null,bezSmyczy:true}}:{},fundingUsd:s.funding,feesUsd:s.fees};
}
