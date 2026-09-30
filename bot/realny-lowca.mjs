/** Human-activated live adapter. Do NOT run armed from an automated assistant.
 * Default invocation exits before credentials/network/state. --check is public
 * market reads only. Existing realny.mjs and both Panikas are not imported.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {lowcaIndicators} from './lowca-policy.mjs';
import {CONFIRM,ACCOUNT_CONFIRM,STEP,WINDOW,assertActivation,account,initialize,validate,reconcile,plan,
  acceptReceipt,funding,publicState} from './lowca-live-core.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'..');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
export const FREEZE=sha(['realny-lowca.mjs','lowca-live-core.mjs','lowca-policy.mjs','lowca-source.mjs','lowca-graph.mjs']
  .map(n=>n+'\n'+fs.readFileSync(path.join(here,n),'utf8').replace(/\r\n/g,'\n')).join('\n'));
const ensure=(c,m)=>{if(!c)throw Error(m);};
function read(file,optional=false){try{return JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(e){if(optional&&e.code==='ENOENT')return null;throw Error('STATE_READ_FAILED');}}
function atomic(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+'.tmp';const fd=fs.openSync(tmp,'w',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(data,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(tmp,file);}
export async function info(body,request=fetch){
  const r=await request('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  ensure(r.ok,'HL_INFO_HTTP_ERROR');return r.json();
}
export async function market(now,reader=info){
  const slot=Math.floor(now/STEP)*STEP;
  const [meta,raw]=await Promise.all([reader({type:'metaAndAssetCtxs'}),
    reader({type:'candleSnapshot',req:{coin:'SOL',interval:'15m',startTime:slot-512*WINDOW,endTime:slot-1}})]);
  const asset=meta[0]?.universe?.findIndex(a=>a.name==='SOL');
  ensure(asset>=0&&Array.isArray(raw),'INVALID_SOL_DATA');
  const desc=meta[0].universe[asset],ctx=meta[1]?.[asset];
  ensure(!desc.isDelisted&&Number(desc.maxLeverage)>=3,'SOL_UNAVAILABLE');
  const bars=raw.filter(b=>b.t<slot).map(b=>({t:b.t,o:Number(b.o),h:Number(b.h),l:Number(b.l),c:Number(b.c),v:Number(b.v)}))
    .sort((a,b)=>a.t-b.t);
  const features=lowcaIndicators(bars,slot),mark=Number(ctx?.markPx);
  ensure(Number.isFinite(mark)&&mark>0,'INVALID_SOL_MARK');
  return {asset,decimals:desc.szDecimals,mark,features,slot};
}
export function makeReaders(user,reader=info){
  return {
    market:now=>market(now,reader),
    async snapshot(){
      const abstraction=await reader({type:'userAbstraction',user});
      ensure(['disabled','default','unifiedAccount'].includes(abstraction),'UNSUPPORTED_ACCOUNT_MODE');
      const [p,o]=await Promise.all([reader({type:'clearinghouseState',user}),reader({type:'openOrders',user})]);
      let spot,otherDexs;
      if(abstraction==='unifiedAccount'){
        // Re-discover shared DEXs each snapshot; failure never means "none".
        const [s,dexs]=await Promise.all([reader({type:'spotClearinghouseState',user}),reader({type:'perpDexs'})]);
        ensure(Array.isArray(dexs)&&dexs[0]===null&&dexs.length<=100&&
          dexs.slice(1).every(d=>d&&typeof d.name==='string'&&d.name!==''), 'INVALID_SHARED_DEX_LIST');
        const names=dexs.slice(1).map(d=>d.name);
        ensure(new Set(names).size===names.length,'INVALID_SHARED_DEX_LIST');
        spot=s;otherDexs=[];
        // Bound concurrency and API pressure, never CPU workers or exchange writes.
        for(let i=0;i<names.length;i+=4)otherDexs.push(...await Promise.all(names.slice(i,i+4).map(async dex=>{
          const [state,orders]=await Promise.all([reader({type:'clearinghouseState',user,dex}),reader({type:'openOrders',user,dex})]);
          return {dex,state,orders};
        })));
      }
      ensure(await reader({type:'userAbstraction',user})===abstraction,'ACCOUNT_MODE_CHANGED_DURING_READ');
      return {...account(p,o,{abstraction,spot,otherDexs}),abstraction};
    },
    async taker(){const f=await reader({type:'userFees',user});return Number(f?.userCrossRate);},
    status:c=>reader({type:'orderStatus',user,oid:c}),
    fills:(from,to)=>reader({type:'userFillsByTime',user,startTime:from,endTime:to,aggregateByTime:false}),
    funding:(from,to)=>reader({type:'userFunding',user,startTime:from,endTime:to}),
    transfers:(from,to)=>reader({type:'userNonFundingLedgerUpdates',user,startTime:from,endTime:to}),
  };
}
function publish(base,s,a){
  const dir=path.join(base,'state'),publicView=publicState(s,a);
  atomic(path.join(dir,'stado-lowcaSOL-state.json'),publicView);
  atomic(path.join(dir,'stado-lowcaSOL-trades.json'),s.ledger);
  atomic(path.join(dir,'stado-lowcaSOL-equity.json'),s.equity);
  const roster=read(path.join(dir,'stado.json'));
  roster.lowcaSOL={gracz:'lowcaSOL',nazwa:'Łowca SOL',prefiks:'stado-lowcaSOL',suchy:false,start:s.start,
    kapital:a.equity,zamkniete:s.closed,pozycji:a.q?1:0,lastRun:s.lastRun,koniec:null,przejalPo:'sitoOstre'};
  atomic(path.join(dir,'stado.json'),roster);
}
export async function runOnce(base,env,readers,exchange,clock=Date.now){
  assertActivation(env);const identity=sha(env.REALNY_KONTO.toLowerCase());
  const snapshot=async()=>{
    const a=await readers.snapshot();
    ensure(a.abstraction!=='unifiedAccount'||env.REALNY_LOWCA_ACCOUNT_CONFIRM===ACCOUNT_CONFIRM,
      'UNIFIED_ACCOUNT_REQUIRES_CONFIRMATION');
    return a;
  };
  const dir=path.join(base,'logs','lowca-real-v1'),file=path.join(dir,'state.json');fs.mkdirSync(dir,{recursive:true});
  const lock=path.join(dir,'running.lock');let fd;
  try{fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,String(process.pid));}catch{throw Error('LOWCA_LOCKED');}
  try{
    const now=clock();let s=read(file,true),a=await snapshot();
    if(!s){
      ensure(!fs.existsSync(path.join(base,'state','stado-lowcaSOL-state.json')),'LIVE_JOURNAL_MISSING_NO_RESET');
      const prior=read(path.join(base,'state','stado-sitoOstre-state.json'));
      const roster=read(path.join(base,'state','stado.json'));
      ensure(roster.sitoOstre?.prefiks==='stado-sitoOstre','PREDECESSOR_ROSTER_MISSING');
      s=initialize({now,snapshot:a,prior,freeze:FREEZE,identity});s.fundingTo=now;s.auditTo=now;
      // The backup is durable before the new account acquires ownership.
      atomic(path.join(dir,'predecessor-backup.json'),{at:now,sha256:sha(JSON.stringify(prior)),state:prior});
      atomic(file,s);
    }
    validate(s,FREEZE,identity);
    const m=await readers.market(now);
    if(s.pending){
      // A lost acknowledgement NEVER causes a blind re-submission.
      const [status,rows]=await Promise.all([readers.status(s.pending.c),readers.fills(s.pending.at-1000,clock())]);
      a=await snapshot();s=acceptReceipt(s,{status,rows,snapshot:a,decimals:m.decimals,now:clock()});atomic(file,s);
    }
    reconcile(s,a,m.decimals);
    const auditNow=clock();const [money,transfers,allFills]=await Promise.all([
      readers.funding(s.fundingTo+1,auditNow),readers.transfers(s.auditTo+1,auditNow),readers.fills(s.auditTo+1,auditNow)]);
    ensure(Array.isArray(transfers)&&transfers.length===0,'EXTERNAL_LEDGER_UPDATE_REQUIRES_REVIEW');
    ensure(Array.isArray(allFills)&&allFills.length<2000&&allFills.every(f=>s.ledger.some(l=>l.tid===f.tid)),
      'EXTERNAL_OR_UNRECORDED_FILL');
    s=funding(s,money,s.fundingTo+1,auditNow);s.auditTo=auditNow;atomic(file,s);
    a=await snapshot();reconcile(s,a,m.decimals);
    const current=clock();ensure(current-now<60000,'DATA_CYCLE_STALE');
    ensure(Math.floor(current/STEP)*STEP===m.slot,'DECISION_BOUNDARY_CROSSED');
    const r=plan(s,{...m,now:current,snapshot:a,taker:await readers.taker()});s=r.state;
    // Graph transition and unique cloid/intent commit BEFORE exchange effects.
    atomic(file,s);
    if(r.intent){
      // No action at all on other accounts. Cross margin setting for SOL only.
      try{
        if(r.intent.buy)await exchange.updateLeverage({asset:m.asset,isCross:true,leverage:3});
        await exchange.order({orders:[r.intent.order],grouping:'na'});
      }catch{throw Error('SUBMISSION_UNCERTAIN_RECEIPT_REQUIRED');}
      const receiptAt=clock();
      const [status,rows]=await Promise.all([readers.status(r.intent.c),readers.fills(r.intent.at-1000,receiptAt)]);
      a=await snapshot();s=acceptReceipt(s,{status,rows,snapshot:a,decimals:m.decimals,now:clock()});atomic(file,s);
    }
    s.lastRun=new Date(clock()).toISOString();s.kapital=a.equity;s.szczyt=Math.max(s.szczyt,a.equity);
    s.equity.push({ts:clock(),equityUsd:a.equity});
    if(s.equity.length>4000)s.equity=s.equity.filter((_,i)=>i%2===0||i>=2000);
    atomic(file,s);publish(base,s,a);return s;
  }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.includes('--account-check')){
      // No key/SDK, activation, journal writes, leverage changes or orders.
      ensure(/^0x[0-9a-f]{40}$/i.test(process.env.REALNY_KONTO??''),'INVALID_ACCOUNT');
      const a=await makeReaders(process.env.REALNY_KONTO).snapshot();
      const file=path.join(root,'logs','lowca-real-v1','state.json');
      let journal='not-created';
      if(fs.existsSync(file)){
        validate(read(file),FREEZE,sha(process.env.REALNY_KONTO.toLowerCase()));
        journal='compatible';
      }
      console.log(JSON.stringify({readOnly:true,ordersEnabled:false,abstraction:a.abstraction,
        equityUsd:a.equity,availableUsd:a.available,solQuantity:a.q,journal,
        accountConfirmationRequired:a.abstraction==='unifiedAccount'}));
    }else if(process.argv.includes('--check')){
      const m=await market(Date.now());console.log(JSON.stringify({readOnly:true,ordersEnabled:false,
        source:CONFIRM,clockHours:6,featuresMinutes:15,mark:m.mark,features:m.features}));
    }else{
      assertActivation(process.env); // before signer creation or account reads
      const {ExchangeClient,HttpTransport}=await import('@nktkas/hyperliquid');
      const {privateKeyToAccount}=await import('viem/accounts');let wallet;
      try{const k=process.env.REALNY_AGENT_KEY;wallet=privateKeyToAccount(k.startsWith('0x')?k:'0x'+k);}
      catch{throw Error('INVALID_AGENT');}
      const exchange=new ExchangeClient({wallet,transport:new HttpTransport()});
      await runOnce(root,process.env,makeReaders(process.env.REALNY_KONTO),exchange);
      console.log('Łowca SOL: account reconciled, cycle recorded.');
    }
  }catch(error){
    // Only our fixed codes may reach the public log. Never print SDK/key/body errors.
    const code=/^[A-Z_]+$/.test(error.message??'')?error.message:'PRIVATE_ERROR';
    console.error('Łowca SOL blocked ('+code+'). Inspect private journal locally; no blind order retry.');process.exitCode=1;
  }
}
