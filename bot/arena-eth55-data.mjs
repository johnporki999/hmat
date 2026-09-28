/** Public read-only data. ETH 1m, no credentials or order endpoint. */
import {info,validateCandles,fetchMarket,fetchFunding} from './arena-data.mjs';
export const MINUTE=60000,HOUR=3600000;
const ensure=(ok,message)=>{if(!ok)throw Error(message);};

export async function fetchClosed1m(slot,request=fetch){
  ensure(Number.isSafeInteger(slot)&&slot>0&&slot%MINUTE===0,'ETH55: invalid minute slot');
  const rows=await info({type:'candleSnapshot',req:{coin:'ETH',interval:'1m',startTime:slot-256*MINUTE,endTime:slot-1}},request);
  ensure(Array.isArray(rows)&&rows.every(x=>x.s==='ETH'&&x.i==='1m'),'ETH55: wrong candle source/interval');
  const bars=rows.map(x=>({t:Number(x.t),o:Number(x.o),h:Number(x.h),l:Number(x.l),c:Number(x.c),v:Number(x.v)}));
  return validateCandles(bars,{symbol:'ETH',slot,count:256,step:MINUTE});
}

export async function fetchEthMarket(symbols,volumes,request=fetch,clock=Date.now){
  let contextReceivedAt=null;
  const observedRequest=async(url,options)=>{
    const response=await request(url,options),isContext=JSON.parse(options.body).type==='metaAndAssetCtxs';
    return {ok:response.ok,status:response.status,json:async()=>{
      const value=await response.json();if(isContext)contextReceivedAt=clock();return value;
    }};
  };
  const markets=await fetchMarket(symbols,volumes,observedRequest);
  ensure(contextReceivedAt!==null,'ETH55: missing context receipt timestamp');
  // Old shared reader stamps request START; this profile explicitly requires receipt.
  markets.ETH.contextAt=contextReceivedAt;return markets;
}
export async function collectEth55(state,readers={fetchClosed1m,fetchMarket:fetchEthMarket,fetchFunding},clock=Date.now,{deadline=Infinity,request=fetch}={}){
  const begin=clock(),slot=Math.floor(begin/MINUTE)*MINUTE;
  const stop=Math.min(begin+45000,slot+45000,deadline);
  ensure(stop>begin,'ETH55: decision/window deadline passed');
  const bounded=async(url,options={})=>{
    const remaining=Math.floor(stop-clock());ensure(remaining>0,'ETH55: request deadline passed');
    const signals=[AbortSignal.timeout(remaining)];if(options.signal)signals.push(options.signal);
    return request(url,{...options,signal:AbortSignal.any(signals)});
  };
  const bars=await readers.fetchClosed1m(slot,bounded);
  // The execution limit uses the last completed MINUTE, never hourly/4.
  const funding=state&&state.lastFundingHour<Math.floor(begin/HOUR)*HOUR?
    await readers.fetchFunding('ETH',state.lastFundingHour+1,begin,bounded):[];
  const markets=await readers.fetchMarket(['ETH'],{ETH:bars.at(-1).v},bounded);
  const now=clock();
  ensure(now<stop,'ETH55: request/worker deadline passed');
  ensure(now>=begin&&now-begin<45000,'ETH55: data collection exceeded 45 seconds');
  ensure(Math.floor(now/MINUTE)*MINUTE===slot,'ETH55: minute changed during collection; no fill');
  return {now,market:{...markets.ETH,volumeWindowMinutes:1},signal:{slot,bars},funding,
    cycleMs:now-begin,decisionLagMs:now-slot};
}
