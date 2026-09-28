/** Independent PAPER process. It cannot submit orders or access wallet credentials. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {makeState,advance,PROTOCOL,indicators} from './eth55-core.mjs';
import {collectEth55} from './arena-eth55-data.mjs';
import {rememberEth55,publicEth55} from './arena-eth55-summary.mjs';
import {atomic,digest,recover,commit} from './arena-store.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),project=path.resolve(here,'..');
const files=['arena-eth55.mjs','arena-eth55-data.mjs','arena-eth55-summary.mjs','eth55-core.mjs','eth55-spec.mjs',
  'arena-data.mjs','arena-store.mjs','winner-paper-core.mjs','strategy.mjs'];
export const FREEZE=digest(files.map(n=>n+'\n'+fs.readFileSync(path.join(here,n),'utf8').replace(/\r\n/g,'\n')).join('\n'));
export async function runEth55(base=project,{collect=collectEth55,clock=Date.now,deadline=Infinity}={}){
  const dir=path.join(base,'logs','eth55-paper-v1'),pub=path.join(dir,'public.json');
  fs.mkdirSync(dir,{recursive:true});
  const lock=path.join(dir,'running.lock');let fd;
  try{fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({pid:process.pid,at:clock()}));}
  catch{throw Error('ETH55 already running or stale lock: inspect logs/eth55-paper-v1/running.lock');}
  let state=null,prior=null;
  try{
    prior=recover(dir,FREEZE);state=prior?.state??null;
    if(!state&&fs.existsSync(pub)){
      const old=JSON.parse(fs.readFileSync(pub,'utf8'));
      if(old.startedAt)throw Error('ETH55 public account exists without its journal: refusing reset');
    }
    const input=await collect(state,undefined,clock,{deadline});
    if(clock()>=deadline)throw Error('ETH55 worker deadline passed; no execution');
    if(!state)state=makeState(input.now,{hash:FREEZE});
    const result=advance(state,input);
    if(result.state.seq===state.seq){
      // A duplicated observation must not duplicate the journal or funding.
      return{state,summary:publicEth55(state,clock())};
    }
    if(result.state.seq!==state.seq+1)throw Error('ETH55 non-consecutive sequence');
    rememberEth55(result.state,result.events,input.market);
    const evidence={now:input.now,cycleMs:input.cycleMs,decisionLagMs:input.decisionLagMs,market:input.market,funding:input.funding,
      signal:{slot:input.signal.slot,count:input.signal.bars.length,first:input.signal.bars[0].t,last:input.signal.bars.at(-1).t,
        sha256:digest(JSON.stringify(input.signal.bars))}};
    commit(dir,result,evidence,prior,PROTOCOL);state=result.state;
    const view=publicEth55(state,clock(),{cycleMs:input.cycleMs,decisionLagMs:input.decisionLagMs});atomic(pub,view);
    console.log(`ETH55 PAPER OK seq=${state.seq}; equity=${state.accounts.eth55.equity.toFixed(4)}; fills=${state.accounts.eth55.fills}; lagMs=${input.decisionLagMs}`);
    return{state,summary:view};
  }catch(error){
    let view=null;
    if(state)view=publicEth55(state,clock(),{error:String(error.message).slice(0,240)});
    else if(fs.existsSync(pub)){
      try{const old=JSON.parse(fs.readFileSync(pub,'utf8'));if(old.kind==='hajsomat-eth55-paper'&&old.paper===true&&old.ordersEnabled===false)view={...old,updatedAt:clock(),status:'blocked',error:String(error.message).slice(0,240)};}catch{}
    }
    if(view){if(view.player)view.player.status='blocked';atomic(pub,view);}
    throw error;
  }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
/** A bounded worker between two existing five-minute cron ticks, not a daemon.
 * The parent retains the only Git publisher. No private environment is needed.
 */
export async function runWindow(base=project,{clock=Date.now,wait=sleep,run=runEth55}={}){
  const dir=path.join(base,'logs','eth55-paper-v1');fs.mkdirSync(dir,{recursive:true});
  const lock=path.join(dir,'window.lock');let fd;
  try{fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({pid:process.pid,at:clock()}));}
  catch{throw Error('ETH55 window already running or stale lock: inspect window.lock');}
  const end=(Math.floor(clock()/300000)+1)*300000;
  let runs=0,failures=0;
  try{
    while(clock()<end&&runs<5){
      try{await run(base,{clock,deadline:end-1000});}catch(e){failures++;console.error('ETH55 minute blocked:',e.message);}
      runs++;
      const next=(Math.floor(clock()/60000)+1)*60000+2000;
      if(next>=end)break;
      await wait(Math.max(1,next-clock()));
    }
    return{runs,failures,end};
  }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.includes('--check')){
      const input=await collectEth55(null);const features=indicators(input.signal.bars,input.signal.slot);
      console.log(JSON.stringify({readOnly:true,ordersEnabled:false,symbol:'ETH',minutes:1,bars:input.signal.bars.length,
        features,decisionLagMs:input.decisionLagMs,freeze:FREEZE}));
    }else if(process.argv.includes('--window'))await runWindow();
    else await runEth55();
  }catch(error){console.error('ETH55 PAPER blocked:',error.message);process.exitCode=1;}
}
