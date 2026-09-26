/** PUBLIC MARKET DATA ONLY. No wallet, signing, exchange/order endpoint or env credentials.
 * Persistent journal lives under ignored logs/. Only a compact summary goes to state/.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { COINS,H,STEP,PROTOCOL,ensure,features,newState,advance,summary } from './winner-paper-core.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..');
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
export const FREEZE=digest(JSON.stringify(PROTOCOL)+fs.readFileSync(path.join(here,'winner-paper-core.mjs'),'utf8').replace(/\r\n/g,'\n')+fs.readFileSync(fileURLToPath(import.meta.url),'utf8').replace(/\r\n/g,'\n'));
export function atomic(file, data) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data)+'\n');fs.renameSync(tmp,file);
}
export function recover(dir) {
  const events=path.join(dir,'events');
  if(!fs.existsSync(events))return null;
  const files=fs.readdirSync(events).filter(n=>/^\d{9}\.json$/.test(n)).sort();
  if(!files.length)return null;
  ensure(files.every((f,i)=>Number(f.slice(0,9))===i+1),'Missing journal event');
  const last=JSON.parse(fs.readFileSync(path.join(events,files.at(-1)),'utf8'));
  ensure(last.hash===digest(JSON.stringify(last.payload)),'Corrupt paper journal');
  ensure(last.payload.state.seq===Number(files.at(-1).slice(0,9)),'Journal sequence mismatch');
  ensure(last.payload.state.freeze===FREEZE,'Frozen experiment code changed; do not reset or mix versions');
  return last.payload.state;
}
export function commit(dir, result, input) {
  const previous=recover(dir);
  ensure(result.state.seq===(previous?.seq??0)+1,'Non-consecutive journal sequence');
  const marker=path.join(dir,'EXPERIMENT.json');
  if(!previous){
    ensure(!fs.existsSync(marker),'Existing experiment without journal; refuse reset');
    atomic(marker,{startedAt:result.state.startedAt,freeze:FREEZE,protocol:PROTOCOL});
  }
  const payload={state:result.state,events:result.events,input};
  const target=path.join(dir,'events',`${String(result.state.seq).padStart(9,'0')}.json`);
  ensure(!fs.existsSync(target),'Duplicate journal sequence');
  atomic(target,{payload,hash:digest(JSON.stringify(payload))});
  // Journal is authoritative; a crash here is recovered without repeating fills.
  atomic(path.join(dir,'checkpoint.json'),result.state);
}
async function json(url, body) {
  const r=await fetch(url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  ensure(r.ok,`Public data HTTP ${r.status}`);return r.json();
}
async function hl(body) {
  ensure(['metaAndAssetCtxs','l2Book','candleSnapshot','fundingHistory'].includes(body.type),'Not a public market request');
  return json('https://api.hyperliquid.xyz/info',body);
}
export async function spot(slot) {
  const series=await Promise.all(COINS.map(async coin=>{
    const u=new URL('https://data-api.binance.vision/api/v3/klines');
    u.search=new URLSearchParams({symbol:coin+'USDT',interval:'1h',startTime:String(slot-721*H),endTime:String(slot-1),limit:'1000'});
    const a=await json(u);ensure(Array.isArray(a),'Invalid Binance response');
    return a.map(x=>({t:Number(x[0]),o:Number(x[1]),h:Number(x[2]),l:Number(x[3]),c:Number(x[4])}));
  }));
  return {slot,features:features(series,slot),series};
}
export async function marketSnapshot(withBooks=false, slot=null) {
  const begin=Date.now(),[meta,contexts]=await hl({type:'metaAndAssetCtxs'});
  ensure(Array.isArray(meta.universe)&&Array.isArray(contexts),'Invalid HL context');
  const ids=COINS.map(c=>meta.universe.findIndex(x=>x.name===c));ensure(ids.every(i=>i>=0),'HL market missing');
  const m={observedAt:Date.now(),marks:ids.map(i=>Number(contexts[i].markPx)),oracles:ids.map(i=>Number(contexts[i].oraclePx)),
    decimals:ids.map(i=>meta.universe[i].szDecimals),books:[],volumes:[]};
  ensure([...m.marks,...m.oracles].every(x=>Number.isFinite(x)&&x>0),'Invalid price');
  ensure(m.decimals.every(x=>Number.isInteger(x)&&x>=0&&x<=8),'Invalid quantity step');
  if(withBooks){
    const books=await Promise.all(COINS.map(coin=>hl({type:'l2Book',coin})));
    const candles=await Promise.all(COINS.map(coin=>hl({type:'candleSnapshot',req:{coin,interval:'1h',startTime:slot-H,endTime:slot-1}})));
    m.books=books.map((b,j)=>{
      ensure(b.coin===COINS[j]&&Math.abs(Date.now()-b.time)<60000,'Stale/wrong HL book');
      const [bids,asks]=b.levels.map(side=>side.map(x=>({px:Number(x.px),sz:Number(x.sz)})));
      ensure(bids.length&&asks.length&&bids[0].px<asks[0].px,'Crossed/empty book');
      for(const [side,sign] of [[bids,-1],[asks,1]])side.forEach((l,i)=>ensure(Number.isFinite(l.px)&&l.px>0&&Number.isFinite(l.sz)&&l.sz>0&&(!i||sign*(l.px-side[i-1].px)>=0),'Invalid book level'));
      return {time:b.time,bids,asks};
    });
    m.volumes=candles.map((a,j)=>{
      const b=a.filter(x=>x.s===COINS[j]&&x.t===slot-H);
      ensure(b.length===1&&Number.isFinite(Number(b[0].v))&&Number(b[0].v)>=0,'Missing previous HL hourly volume');
      return Number(b[0].v);
    });
  }
  ensure(Date.now()-begin<60000,'Market collection took too long');return m;
}
export async function funding(state, now) {
  if(!state || state.lastFundingHour>=Math.floor(now/H)*H)return [[],[],[]];
  const from=state.lastFundingHour+H, end=now;
  ensure(end-from<14*24*H,'Funding gap too large; investigation required');
  return Promise.all(COINS.map(async(coin,j)=>{
    if(!Object.values(state.accounts).some(a=>a.qty[j]>0))return [];
    const rows=await hl({type:'fundingHistory',coin,startTime:from,endTime:end});
    ensure(Array.isArray(rows)&&rows.length<500,'Incomplete funding response');
    return rows.map(r=>{ensure(r.coin===coin,'Wrong funding market');return {time:Number(r.time),rate:Number(r.fundingRate)};});
  }));
}
export async function run(base=root) {
  const dir=path.join(base,'logs','winner-paper-v1'),pub=path.join(base,'state','winner-paper.json');
  fs.mkdirSync(dir,{recursive:true});
  const lock=path.join(dir,'running.lock');
  let fd,state=null;
  try {fd=fs.openSync(lock,'wx');}catch{throw Error('Winner paper already running or stale lock; inspect logs/winner-paper-v1/running.lock');}
  try {
    state=recover(dir);
    if(!state)ensure(!fs.existsSync(path.join(dir,'EXPERIMENT.json'))&&!fs.existsSync(path.join(dir,'checkpoint.json')),'Missing private journal: refuse to reset existing experiment');
    if(!state && fs.existsSync(pub))ensure(!JSON.parse(fs.readFileSync(pub,'utf8')).startedAt,'Missing private journal: refuse to restart experiment');
    const begin=Date.now();
    const decision=state && begin>=state.nextSlot && begin<state.nextSlot+15*60000;
    const execution=state?.pending && begin>=state.pending.slot+15*60000 && begin<state.pending.slot+30*60000;
    // Initial source validation is warmup only; never enter a position in the past.
    const signal=decision?await spot(state.nextSlot):!state?await spot(Math.floor(begin/H)*H):null;
    const market=await marketSnapshot(Boolean(execution),state?.pending?.slot);
    const rows=await funding(state,Date.now()),now=Date.now();
    ensure(now-begin<60000,'Cycle exceeded 60 seconds');
    if(!state)state=newState(now,FREEZE);
    const result=advance(state,market,decision?signal:null,rows,now);
    commit(dir,result,{receivedAt:now,market,signal,funding:rows});
    state=result.state;atomic(pub,summary(state,now));
    console.log(`Winner PAPER OK seq=${state.seq}; ${COINS.join('/')}; next=${new Date(state.nextSlot).toISOString()}`);
    return state;
  } catch(e) {
    // Never overwrite a healthy journal or reset balances on an API/parse error.
    atomic(pub,summary(state,Date.now(),String(e.message).slice(0,220)));
    throw e;
  } finally {fs.closeSync(fd);fs.unlinkSync(lock);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.includes('--check')){
    try {const s=await spot(Math.floor(Date.now()/H)*H);const m=await marketSnapshot();console.log(JSON.stringify({readOnly:true,signalValid:s.features.valid,assets:COINS,quantityDecimals:m.decimals,freeze:FREEZE}));}
    catch(e){console.error(e.message);process.exitCode=1;}
  } else {try{await run();}catch(e){console.error('Winner PAPER blocked:',e.message);process.exitCode=1;}}
}
