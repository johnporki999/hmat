/** PAPER ONLY: virtual accounts, public market reads, no exchange/order API. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SYMBOLS,HOUR,QUARTER,mapLimited,fetchClosed15m,fetchMarket,fetchWinner,fetchFunding} from './arena-data.mjs';
import {makeState,advance,PROTOCOL} from './arena-core.mjs';
import {summary,rememberPresentation} from './arena-summary.mjs';
import {atomic,digest,recover,commit} from './arena-store.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..');
const sources=['arena.mjs','arena-core.mjs','arena-skoczek-spec.mjs','arena-data.mjs','arena-store.mjs','winner-paper-core.mjs','gracze.mjs','strategy.mjs'];
export const FREEZE=digest(sources.map(name=>name+'\n'+fs.readFileSync(path.join(here,name),'utf8').replace(/\r\n/g,'\n')).join('\n'));
const ensure=(ok,message)=>{if(!ok)throw Error(message);};

export async function collect(state,readers={fetchClosed15m,fetchMarket,fetchWinner,fetchFunding}){
  const begin=Date.now(),slot=Math.floor(begin/QUARTER)*QUARTER;
  const candles=await mapLimited(SYMBOLS,s=>readers.fetchClosed15m(s,slot));
  const hour=Math.floor(slot/HOUR)*HOUR;
  const volumes=Object.fromEntries(SYMBOLS.map((s,i)=>{
    const previous=candles[i].filter(b=>b.t>=hour-HOUR&&b.t<hour);
    ensure(previous.length===4,`${s}: previous complete hourly volume unavailable`);
    return [s,previous.reduce((n,b)=>n+b.v,0)];
  }));
  const closed15m=Object.fromEntries(SYMBOLS.map((s,i)=>[s,{slot,bars:candles[i]}]));
  const signals={legacy:{slot,bars:Object.fromEntries(SYMBOLS.map((s,i)=>[s,candles[i]]))}};
  if(slot%(2*QUARTER)===0)signals.skoczek={slot,bars:closed15m.SOL.bars};
  // Winner keeps its original six-hour clock. The first read is validation only.
  let winnerWarmup=null;
  if(!state)winnerWarmup=await readers.fetchWinner(hour);
  else if(slot%(6*HOUR)===0)signals.winner=await readers.fetchWinner(slot);
  const funding={};
  if(state){
    ensure(Number.isFinite(state.lastFundingHour),'Arena state has no funding watermark');
    if(state.lastFundingHour<hour){
      await mapLimited(SYMBOLS,async s=>{funding[s]=await readers.fetchFunding(s,state.lastFundingHour+1,begin);});
    }
  }
  // Fetch the executable depth last: candle preparation must not age the book.
  const markets=await readers.fetchMarket(SYMBOLS,volumes);
  const now=Date.now();
  ensure(now-begin<90000,'Arena data cycle exceeded 90 seconds');
  ensure(Math.floor(now/QUARTER)*QUARTER===slot,'Clock crossed a candle boundary while collecting; retry next cycle');
  return {now,markets,signals,funding,closed15m,winnerWarmup,cycleMs:now-begin};
}

function publicError(previous,now,message){
  return {...(previous??{schema:1,kind:'hajsomat-paper-arena',protocol:PROTOCOL.id,paper:true,ordersEnabled:false,
    startedAt:null,lastObservedAt:null,initial:1000,players:[],recentTrades:[],note:'Liga wyłącznie papierowa. Brak potwierdzonych danych startowych; nie otwarto wirtualnych pozycji.'}),
    updatedAt:now,status:'blocked',error:message};
}
export async function run(base=root,dependencies={collect}){
  const dir=path.join(base,'logs','arena-v1'),pub=path.join(base,'state','arena.json');
  fs.mkdirSync(dir,{recursive:true});
  const lock=path.join(dir,'running.lock');
  let fd;
  try {fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({pid:process.pid,at:Date.now()}));}
  catch {throw Error('Arena already running or stale lock: inspect logs/arena-v1/running.lock');}
  let prior=null,state=null;
  try{
    prior=recover(dir,FREEZE);state=prior?.state??null;
    if(!state&&fs.existsSync(pub)){
      const old=JSON.parse(fs.readFileSync(pub,'utf8'));
      ensure(!old.startedAt,'Published Arena already started but private journal is absent; refusing reset');
    }
    const input=await dependencies.collect(state);
    if(!state)state=makeState(input.now,{hash:FREEZE,legacySymbols:[...SYMBOLS]});
    const result=advance(state,input);
    ensure(result.state.seq===state.seq+1,'Arena core did not increment journal sequence');
    // Full candle input would grow by hundreds of MB/day. Keep closed-input digests,
    // derived decision evidence emitted by the core and actual market/funding snapshots.
    const evidence={now:input.now,cycleMs:input.cycleMs,markets:input.markets,funding:input.funding,
      winner:input.signals.winner??input.winnerWarmup,closed15m:Object.fromEntries(Object.entries(input.closed15m).map(([s,x])=>
        [s,{slot:x.slot,count:x.bars.length,first:x.bars[0].t,last:x.bars.at(-1).t,sha256:digest(JSON.stringify(x.bars))}]))};
    rememberPresentation(result.state,result.events,input.markets);
    commit(dir,result,evidence,prior,PROTOCOL);
    state=result.state;
    const view=summary(state,input.now);
    view.lastCycleMs=input.cycleMs;atomic(pub,view);
    console.log(`Arena PAPER OK seq=${state.seq}; players=${view.players.length}; initial=1000; fills=${view.players.reduce((n,p)=>n+p.fills,0)}; ${input.cycleMs}ms`);
    return {state,summary:view};
  }catch(error){
    let view=null;
    if(state)view=summary(state,Date.now());
    else if(fs.existsSync(pub)){
      try{const old=JSON.parse(fs.readFileSync(pub,'utf8'));if(old.kind==='hajsomat-paper-arena'&&old.paper===true&&old.ordersEnabled===false)view=old;}catch{}
    }
    atomic(pub,publicError(view,Date.now(),String(error.message).slice(0,240)));
    throw error;
  }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.includes('--check')){
      const input=await collect(null);
      console.log(JSON.stringify({readOnly:true,ordersEnabled:false,markets:Object.keys(input.markets),
        candles:Object.values(input.closed15m).map(x=>x.bars.length),winnerValid:input.winnerWarmup.features.valid,freeze:FREEZE,cycleMs:input.cycleMs}));
    }else await run();
  }catch(error){console.error('Arena PAPER blocked:',error.message);process.exitCode=1;}
}
