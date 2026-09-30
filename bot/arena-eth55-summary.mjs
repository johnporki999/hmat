/** Strictly public, bounded presentation for the independent ETH-55 account. */
import {PROTOCOL} from './eth55-core.mjs';
const reason=x=>String(x??'').slice(0,180);
export function rememberEth55(state,events,market){
  const a=state.accounts.eth55,now=state.lastObservedAt;
  const ui=state.presentation??{history:[],recentTrades:[],lastAction:'Czeka na pierwszą zamkniętą minutę'};
  if(!ui.history.length)ui.history.push({at:state.startedAt,equity:1000});
  const last=ui.history.at(-1);
  if(last.at===now)last.equity=a.equity;
  else if(ui.history.length>1&&Math.floor(last.at/900000)===Math.floor(now/900000))ui.history[ui.history.length-1]={at:now,equity:a.equity};
  else ui.history.push({at:now,equity:a.equity});
  ui.history=ui.history.slice(-193);
  events.forEach((e,i)=>{
    if(e.kind==='fill')ui.recentTrades.push({id:`eth55-${state.seq}-${i}`,at:e.at,playerId:'eth55',symbol:'ETH',
      side:e.delta>0?'BUY':'SELL',qty:Math.abs(e.delta),price:e.price,fee:e.fee,reason:reason(e.reason)||'Cel grafu'});
    if(['fill','decision','blocked','risk','missed'].includes(e.kind))ui.lastAction=reason(e.reason??e.trace?.state??e.kind);
  });
  ui.recentTrades=ui.recentTrades.slice(-60);ui.mark=market.mark;state.presentation=ui;
}
export function publicEth55(state,now,{error=null,cycleMs=null,decisionLagMs=null}={}){
  const a=state.accounts.eth55,ui=state.presentation??{history:[],recentTrades:[],lastAction:'Czeka na sygnał'},g=state.policies.eth55;
  const q=a.qty.ETH??0,p=a.positions.ETH,mark=ui.mark??p?.averageEntry;
  const positions=p&&q>0?[{symbol:'ETH',side:'LONG',qty:q,entryPrice:p.averageEntry,mark,notional:q*mark,
    pnlUsd:q*(mark-p.averageEntry),openedAt:p.openedAt,stage:g.state??'Pozycja otwarta'}]:[];
  const start=new Date(state.startedAt).toISOString();
  return{schema:1,kind:'hajsomat-eth55-paper',protocol:PROTOCOL.id,paper:true,ordersEnabled:false,initial:1000,
    startedAt:state.startedAt,lastObservedAt:state.lastObservedAt,updatedAt:now,status:error?'blocked':'running',error,
    cycleMs,decisionLagMs,seq:state.seq,
    player:{id:'eth55',name:'ETH-55',color:'#7da8f7',
      description:`Rzadko aktywny kandydat ETH. Oryginalne etapy: wejście, ponowne ustawienie alokacji i redukcja o 25%. Osobny start PAPER: ${start}.`+
        (state.fundingGapEvents?' UWAGA: funding po przerwie przybliżony starą ceną oracle.':''),
      capital:a.equity,roi:a.equity/1000-1,drawdown:a.maxDD,fees:a.fees,funding:a.funding,
      closed:a.closed,wins:a.wins,fills:a.fills,status:error||a.status!=='running'?'blocked':positions.length?'holding':'waiting',
      nextDecision:state.nextSlot,positions,history:ui.history,lastAction:error?`Zatrzymany: ${error}`:ui.lastAction,
      signalSource:'PAPER Hyperliquid, zamknięte 1m, Wilder/RSI14 i ER48 z 256 świec. Backtest Binance futures: inne źródło i wykonanie. HL L2 + 5 pb poślizgu, 4,5 pb prowizji, funding; limit wolumenu z poprzedniej minuty. Sygnały bez odtwarzania pominiętych minut.',
      decisionMinutes:1,leverage:1,startedAt:state.startedAt,lastObservedAt:state.lastObservedAt},
    recentTrades:[...ui.recentTrades].reverse(),quality:state.quality};
}
