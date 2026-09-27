/** Public market data only. No wallet, credentials, signing or order endpoints. */
import { features as winnerFeatures } from './winner-paper-core.mjs';

export const HOUR = 3600000, QUARTER = 900000;
export const SYMBOLS = Object.freeze(['SOL','JUP','JTO','PYTH','RENDER','BONK','BTC','ETH','W','TNSR','PENGU']);
const alias = symbol => symbol === 'BONK' ? 'kBONK' : symbol;
const check = (ok, message) => { if (!ok) throw Error(message); };
const positive = x => Number.isFinite(x) && x > 0;

export async function readJSON(url, body, request = fetch) {
  const response = await request(url, {method: body ? 'POST' : 'GET',
    headers: {'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {}),
    signal:AbortSignal.timeout(15000)});
  check(response.ok, `Public market HTTP ${response.status}`);
  return response.json();
}
export async function info(body, request = fetch) {
  check(['metaAndAssetCtxs','l2Book','candleSnapshot','fundingHistory'].includes(body.type), 'Read-only request required');
  return readJSON('https://api.hyperliquid.xyz/info',body,request);
}
export async function mapLimited(items, fn, limit = 3) {
  const output = new Array(items.length); let next = 0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    for (;;) {const i=next++; if(i>=items.length)return; output[i]=await fn(items[i],i);}
  }));
  return output;
}
export function validateCandles(rows, {symbol,slot,count,step=QUARTER}) {
  check(Array.isArray(rows),'Candle response is not an array');
  const ordered=rows.filter(b=>b.t<slot).sort((a,b)=>a.t-b.t);
  const selected=ordered.filter(b=>b.t>=slot-count*step);
  check(selected.length===count, `${symbol}: need ${count} closed candles, got ${selected.length}`);
  selected.forEach((b,i)=>{
    check(b.t===slot-(count-i)*step, `${symbol}: candle gap/duplicate`);
    check([b.o,b.h,b.l,b.c].every(positive)&&b.h>=Math.max(b.o,b.c)&&b.l<=Math.min(b.o,b.c)&&b.l<=b.h,
      `${symbol}: invalid OHLC`);
    check(Number.isFinite(b.v)&&b.v>=0,`${symbol}: invalid volume`);
  });
  return selected;
}
export async function fetchClosed15m(symbol,slot,count=256,request=fetch) {
  check(slot%QUARTER===0&&count>=4&&count<=1000,'Invalid 15m request');
  const rows=await info({type:'candleSnapshot',req:{coin:alias(symbol),interval:'15m',startTime:slot-count*QUARTER,endTime:slot-1}},request);
  check(Array.isArray(rows),'Invalid HL candles');
  check(rows.every(x=>x.s===alias(symbol)&&x.i==='15m'),'Wrong HL candle market/interval');
  const normalized=rows.map(x=>({t:Number(x.t),o:Number(x.o),h:Number(x.h),l:Number(x.l),c:Number(x.c),v:Number(x.v)}));
  return validateCandles(normalized,{symbol,slot,count});
}
export function validateBook(book,symbol,now=Date.now()) {
  check(book.coin===alias(symbol)&&Number.isFinite(book.time)&&Math.abs(now-book.time)<60000,`${symbol}: stale/wrong order book`);
  check(Array.isArray(book.levels)&&book.levels.length===2,`${symbol}: invalid order book`);
  const [bids,asks]=book.levels.map(levels=>levels.map(l=>({px:Number(l.px),sz:Number(l.sz)})));
  check(bids.length&&asks.length&&bids[0].px<asks[0].px,`${symbol}: empty/crossed order book`);
  for(const [side,sign] of [[bids,-1],[asks,1]])side.forEach((l,i)=>
    check(positive(l.px)&&positive(l.sz)&&(!i||sign*(l.px-side[i-1].px)>=0),`${symbol}: invalid depth`));
  return {bids,asks,observedAt:book.time};
}
export async function fetchMarket(symbols=SYMBOLS,volumes={},request=fetch) {
  const begin=Date.now(),response=await info({type:'metaAndAssetCtxs'},request);
  check(Array.isArray(response)&&response.length===2,'Invalid market context');
  const [meta,contexts]=response;
  check(Array.isArray(meta.universe)&&Array.isArray(contexts),'Invalid market metadata');
  const markets={};
  for(const symbol of symbols){
    const i=meta.universe.findIndex(x=>x.name===alias(symbol));
    check(i>=0&&!meta.universe[i].isDelisted,`${symbol}: unavailable market`);
    const mark=Number(contexts[i].markPx),oracle=Number(contexts[i].oraclePx),decimals=meta.universe[i].szDecimals;
    check(positive(mark)&&positive(oracle)&&Number.isInteger(decimals)&&decimals>=0&&decimals<=8,`${symbol}: invalid market context`);
    markets[symbol]={mark,oracle,decimals,volume:volumes[symbol],contextAt:begin};
  }
  await mapLimited(symbols,async symbol=>{
    Object.assign(markets[symbol],validateBook(await info({type:'l2Book',coin:alias(symbol)},request),symbol));
  });
  check(Date.now()-begin<60000,'Market snapshot collection exceeded 60 seconds');
  return markets;
}
export async function fetchWinner(slot,request=fetch) {
  const symbols=['BTC','ETH','SOL'];
  const series=await mapLimited(symbols,async symbol=>{
    const url=new URL('https://data-api.binance.vision/api/v3/klines');
    url.search=new URLSearchParams({symbol:symbol+'USDT',interval:'1h',startTime:String(slot-721*HOUR),endTime:String(slot-1),limit:'1000'});
    const rows=await readJSON(url,null,request);
    check(Array.isArray(rows),'Invalid Winner candles');
    return validateCandles(rows.map(x=>({t:Number(x[0]),o:Number(x[1]),h:Number(x[2]),l:Number(x[3]),c:Number(x[4]),v:Number(x[5])})),
      {symbol,slot,count:721,step:HOUR});
  });
  return {slot,features:winnerFeatures(series,slot)};
}
export async function fetchFunding(symbol,from,to,request=fetch) {
  check(to>=from&&to-from<14*24*HOUR,'Funding gap exceeds automatic recovery window');
  const rows=await info({type:'fundingHistory',coin:alias(symbol),startTime:from,endTime:to},request);
  check(Array.isArray(rows)&&rows.length<500,'Invalid/truncated funding history');
  return rows.map(r=>{
    check(r.coin===alias(symbol),'Wrong funding market');
    const time=Number(r.time),rate=Number(r.fundingRate);
    check(Number.isFinite(time)&&Number.isFinite(rate),'Invalid funding record');
    return {time,rate};
  });
}
