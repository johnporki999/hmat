// Frozen paper experiment. Pure accounting/signal code: no network or orders.
export const H = 3600000, STEP = 6 * H;
export const COINS = Object.freeze(['BTC', 'ETH', 'SOL']);
export const PROTOCOL = Object.freeze({
  id: 'winner-ab-hl-v1-20260926', initial: 10000, weight: 0.75, leverage: 1,
  fee: 0.00045, baseSlip: 0.0005, stressSlip: 0.002,
  maHours: 168, gateHours: 720, gateRatio: 0.95, maxHoldHours: 72,
  decisionHoursUTC: [0, 6, 12, 18], executionDelayMinutes: 15,
  decisionWindowMinutes: 15, executionWindowMinutes: 15,
  rebalanceFraction: 0.01, minNotional: 10, volumeCapFraction: 0.001,
  reviewDays: 90, minimumClosedEpisodes: 20, maximumDD: 0.35,
  signalSource: 'Binance public spot 1h, closed candles only',
  executionSource: 'Hyperliquid observed L2 VWAP + fixed model slippage',
  fundingModel: 'actual hourly HL rate x last observed oracle before settlement; missing oracle stops accounting',
  strategySHA256: 'a3dce07babe55ab646f8e97379fd457ca1a20d0a3b229c0825f8d7a01dc4086b',
  policiesSHA256: '25f2f51298a76d33c48f77ebcbf6414c83481416095a258815b7213a20edb7a6',
  ordersEnabled: false,
});
const sum = a => a.reduce((s,x)=>s+x,0);
const finite = x => typeof x === 'number' && Number.isFinite(x);
export function ensure(ok, message) { if (!ok) throw Error(message); }
export function features(series, slot) {
  ensure(series.length === 3, 'Three signal markets required');
  for (const bars of series) {
    ensure(bars.length === 721, 'Need 721 closed hours');
    bars.forEach((b,i)=>{
      ensure(b.t === slot - (721-i)*H, 'Signal candle gap or future candle');
      ensure([b.o,b.h,b.l,b.c].every(v=>finite(v)&&v>0) && b.h>=Math.max(b.o,b.c) && b.l<=Math.min(b.o,b.c), 'Invalid OHLC');
    });
  }
  const price=series.map(b=>b[720].c);
  const ma168=series.map(b=>sum(b.slice(-168).map(x=>x.c))/168);
  const r24=series.map((b,j)=>price[j]/b[696].c-1);
  // Original feature validity also rejects zero ER denominator.
  const valid=series.every(b=>b.slice(-168).some((x,i)=>x.c!==b[552+i].c));
  return {price, ma168, r24, valid, btcOld:series[0][0].c};
}
export function decide(policy, x, hour, gated) {
  let coin=policy.coin, openedHour=policy.openedHour, rejected=false;
  let reason='hold';
  if (!x.valid) { coin=null; openedHour=null; reason='invalid'; }
  else if (coin != null) {
    if (x.price[coin]<x.ma168[coin] || hour-openedHour>=72) {
      reason=hour-openedHour>=72?'72h':'MA168'; coin=null; openedHour=null;
    }
  } else if (x.r24.every(v=>v<0)) {
    const eligible=[0,1,2].filter(j=>x.price[j]>x.ma168[j]);
    eligible.sort((a,b)=>x.r24[b]-x.r24[a]);
    if (eligible.length) {
      coin=eligible[0]; openedHour=hour; reason='entry';
      if (gated && !(finite(x.btcOld)&&x.btcOld>0&&x.price[0]>=0.95*x.btcOld)) {
        coin=null; openedHour=null; rejected=true; reason='BTC30';
      }
    }
  }
  return {policy:{coin,openedHour},target:[0,1,2].map(j=>j===coin?0.75:0),rejected,reason};
}
export function equity(a, marks) { return a.cash + sum(a.qty.map((q,j)=>q*marks[j])); }
export function newState(now, freeze) {
  const accounts={};
  for (const variant of ['filtered','plain']) for(const scenario of ['base','stress']) {
    accounts[`${variant}-${scenario}`]={variant,scenario,cash:10000,qty:[0,0,0],fees:0,slippage:0,funding:0,
      peak:10000,maxDD:0,equity:10000,fills:0,closed:0,wins:0,episode:null};
  }
  return {protocol:PROTOCOL.id,freeze,seq:0,startedAt:now,reviewAt:now+90*24*H,
    lastObservedAt:null,lastFundingHour:Math.floor(now/H)*H,accounts,
    policies:{filtered:{coin:null,openedHour:null},plain:{coin:null,openedHour:null}},
    nextSlot:(Math.floor(now/STEP)+1)*STEP,pending:null,lastDecision:null,
    quality:{missedSlots:0,expiredExecutions:0,gapMinutes:0,fundingApproxEvents:0},rejected:0,oracleBefore:[]};
}
function vwap(levels, requested) {
  let quantity=0,notional=0;
  for(const l of levels) { const q=Math.min(l.sz,requested-quantity);quantity+=q;notional+=q*l.px;if(quantity>=requested-1e-12)break; }
  return {quantity,price:quantity>0?notional/quantity:0};
}
export function fill(a, j, delta, market, volume, now, events) {
  const side=Math.sign(delta);if(!side)return;
  const slip=a.scenario==='base'?PROTOCOL.baseSlip:PROTOCOL.stressSlip;
  const book=market.books[j], lot=10**(-market.decimals[j]);
  const levels=side>0?book.asks:book.bids;
  let amount=Math.min(Math.abs(delta),volume*PROTOCOL.volumeCapFraction);
  amount=Math.min(amount, side<0?a.qty[j]:Math.max(0,a.cash)/(levels.at(-1).px*(1+slip)*(1+PROTOCOL.fee)));
  amount=Math.min(amount,sum(levels.map(x=>x.sz)));
  amount=Math.floor(amount/lot+1e-8)*lot;
  if(amount<=0 || amount*market.marks[j]<PROTOCOL.minNotional)return;
  const raw=vwap(levels,amount);ensure(raw.quantity>=amount-1e-9,'Incomplete depth');
  const px=raw.price*(1+side*slip), fee=amount*px*PROTOCOL.fee;
  const emptyBefore=a.qty.every(q=>q===0), eqBefore=equity(a,market.marks);
  a.cash-=side*amount*px+fee; a.qty[j]+=side*amount;
  if(Math.abs(a.qty[j])<lot/2)a.qty[j]=0;
  ensure(a.cash>=-1e-7 && a.qty.every(q=>q>=0), 'Negative cash or short inventory');
  a.fees+=fee;a.slippage+=side*amount*(px-raw.price);a.fills++;
  if(emptyBefore && side>0)a.episode={startedAt:now,startEquity:eqBefore,coin:COINS[j]};
  if(a.qty.every(q=>q===0) && a.episode){a.closed++;if(equity(a,market.marks)>a.episode.startEquity)a.wins++;a.episode=null;}
  events.push({kind:'fill',variant:a.variant,scenario:a.scenario,coin:COINS[j],side,amount,raw:raw.price,price:px,fee,at:now,cash:a.cash,qty:[...a.qty]});
}
export function advance(inputState, market, signal, fundingRows, now) {
  const s=structuredClone(inputState),events=[];
  ensure(s.protocol===PROTOCOL.id && now>=(s.lastObservedAt??s.startedAt),'Wrong protocol/time');
  ensure(market.marks.length===3 && market.marks.every(v=>finite(v)&&v>0),'Invalid marks');
  if(s.decimals)ensure(JSON.stringify(s.decimals)===JSON.stringify(market.decimals),'Market quantity steps changed');
  else s.decimals=[...market.decimals];
  if(s.lastObservedAt && now-s.lastObservedAt>15*60000)s.quality.gapMinutes+=(now-s.lastObservedAt)/60000;
  const currentHour=Math.floor(now/H)*H;
  // No portfolio changes occur until all outstanding funding is accounted for.
  for(let t=s.lastFundingHour+H;t<=currentHour;t+=H){
    for(let j=0;j<3;j++){
      if(!Object.values(s.accounts).some(a=>a.qty[j]>0))continue;
      const rows=fundingRows[j].filter(r=>Math.floor(r.time/H)*H===t);
      ensure(rows.length===1 && finite(rows[0].rate),'Missing/duplicate funding hour');
      const oracle=s.oracleBefore.filter(x=>x.at<t).at(-1);
      ensure(oracle && t-oracle.at<=15*60000,'Missing pre-settlement oracle; manual investigation required');
      for(const a of Object.values(s.accounts)){
        const payment=a.qty[j]*oracle.prices[j]*rows[0].rate;
        if(!a.qty[j])continue;
        a.cash-=payment;a.funding+=payment;s.quality.fundingApproxEvents++;
        events.push({kind:'funding',variant:a.variant,scenario:a.scenario,coin:COINS[j],at:t,rate:rows[0].rate,oracle:oracle.prices[j],oracleAt:oracle.at,payment});
      }
    }
  }
  s.lastFundingHour=currentHour;
  ensure(Object.values(s.accounts).every(a=>a.cash>=0), 'Paper cash exhausted by funding');
  if(s.pending && now>=s.pending.slot+30*60000){events.push({kind:'expired',slot:s.pending.slot});s.pending=null;s.quality.expiredExecutions++;}
  if(s.pending && now>=s.pending.slot+15*60000){
    ensure(now-market.observedAt<60000,'Stale execution snapshot');
    for(const a of Object.values(s.accounts)){
      const deltas=s.pending.quantities[`${a.variant}-${a.scenario}`];
      for(const side of [-1,1])for(let j=0;j<3;j++)if(Math.sign(deltas[j])===side)fill(a,j,deltas[j],market,market.volumes[j],now,events);
    }
    events.push({kind:'executed',slot:s.pending.slot,at:now});s.pending=null;
  }
  while(s.nextSlot+15*60000<=now){events.push({kind:'missed',slot:s.nextSlot});s.nextSlot+=STEP;s.quality.missedSlots++;}
  if(now>=s.nextSlot && now<s.nextSlot+15*60000){
    ensure(signal?.slot===s.nextSlot,'Missing signal snapshot');
    const quantities={},decisions={};
    for(const variant of ['filtered','plain']){
      const d=decide(s.policies[variant],signal.features,s.nextSlot/H,variant==='filtered');
      s.policies[variant]=d.policy; decisions[variant]=d;
      if(d.rejected)s.rejected++;
      for(const scenario of ['base','stress']){
        const key=`${variant}-${scenario}`,a=s.accounts[key],e=equity(a,market.marks);
        quantities[key]=d.target.map((w,j)=>{
          const delta=w*e/market.marks[j]-a.qty[j];
          return Math.abs(delta)*market.marks[j]>=Math.max(10,e*.01)||(w===0&&delta<0)?delta:0;
        });
      }
    }
    s.pending={slot:s.nextSlot,quantities};s.lastDecision={at:now,slot:s.nextSlot,decisions,features:signal.features};
    events.push({kind:'decision',...s.lastDecision});s.nextSlot+=STEP;
  }
  for(const a of Object.values(s.accounts)){
    a.equity=equity(a,market.marks);ensure(finite(a.equity)&&a.equity>0,'Paper equity exhausted');
    a.peak=Math.max(a.peak,a.equity);a.maxDD=Math.max(a.maxDD,1-a.equity/a.peak);
  }
  s.oracleBefore.push({at:now,prices:market.oracles});s.oracleBefore=s.oracleBefore.filter(x=>x.at>=now-2*H);
  s.lastObservedAt=now;s.seq++;return {state:s,events};
}
export function summary(s, now, error=null) {
  return {schema:1,protocol:PROTOCOL.id,paper:true,ordersEnabled:false,updatedAt:now,status:error?'blocked':s?'running':'waiting',error,
    startedAt:s?.startedAt??null,reviewAt:s?.reviewAt??null,lastObservedAt:s?.lastObservedAt??null,
    nextDecision:s?.nextSlot??null,pendingExecution:s?.pending?s.pending.slot+15*60000:null,
    quality:s?.quality??null,rejected:s?.rejected??0,minimumClosed:20,
    arms:s?['filtered','plain'].map(id=>{const a=s.accounts[`${id}-base`],stress=s.accounts[`${id}-stress`];return {
      id,name:id==='filtered'?'Winner + BTC30':'Winner bez filtra',capital:a.equity,roi:a.equity/10000-1,drawdown:a.maxDD,
      stressRoi:stress.equity/10000-1,closed:a.closed,fills:a.fills,fees:a.fees,funding:a.funding,
      position:a.episode?.coin??null,openedAt:a.episode?.startedAt??null};}):[],
    costs:{initial:10000,feeBps:4.5,slipBps:5,stressSlipBps:20,targetPct:75},
    note:'Papier HL, sygnal Binance spot. Funding: stawka rzeczywista, cena oracle z poprzedniej migawki. DD tylko z odczytow, nie intrabar. 90 dni to przeglad, nie dowod przewagi.'};
}
