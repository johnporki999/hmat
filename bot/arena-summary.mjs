/** Bounded public view. No wallet addresses, raw private state or credentials. */
import {PROTOCOL,PLAYERS} from './arena-core.mjs';
import {mergeEth55,safeRead,ETH55_PUBLIC_PATH} from './arena-eth55-merge.mjs';
const META={
  panika:{color:'#efaa61',description:'Kupuje głębokie wyprzedanie podczas dużej zmienności. Stop 1,6 ATR, cel 3,2 ATR i smycz.',minutes:15,
    source:'Hyperliquid · zamknięte świece 15m. Papierowy wariant; konta realne obserwują także świecę w budowie.'},
  panikaLuzna:{color:'#c5a8f5',description:'Ten sam sygnał Paniki, szerszy stop 3,5 ATR i bez smyczy. Dwa miejsca po 40% depozytu.',minutes:15,
    source:'Hyperliquid · zamknięte świece 15m. Papierowy wariant dotychczasowego gracza.'},
  sitoOstre:{color:'#63c8d8',description:'Kupuje prosty, głęboki spadek: ER48 ≥ 0,45 i RSI14 < 25. Sześć miejsc po 13% depozytu.',minutes:15,
    source:'Hyperliquid · zamknięte świece 15m. Papierowy wariant dotychczasowego gracza.'},
  winnerBTC30:{color:'#e2cd82',description:'Co 6 godzin wybiera najmocniejszy rynek po wspólnym spadku BTC, ETH i SOL. Filtr BTC30; cel 75% kapitału.',minutes:360,
    source:'Sygnał: Binance spot 1h. Wykonanie papierowe HL po 15 min. Oryginalne konto testowe pozostaje osobno.'},
  skoczekSOL:{color:'#b3db77',description:'Nowy kandydat: wchodzi małą pozycją SOL, dokłada po wzroście, a później redukuje do 25%. ATR14/cena ≥ 3%.',minutes:30,
    source:'Papier HL · wskaźniki 15m, decyzje 30m. Historyczny test: Binance futures — inne źródło, nie ten sam backtest.'},
};
const n=x=>Number.isFinite(x)?x:0;
const tidy=x=>typeof x==='string'?x.slice(0,180):'';
const reasonText=reason=>({stop:'Stop ochronny',trail:'Wyjście smyczą',trailing:'Wyjście smyczą','take-profit':'Realizacja celu',
  entry:'Wejście po sygnale',underwater:'Pozycja zbyt długo pod kreską',MA168:'Cena pod średnią 168h','72h':'Limit 72 godzin',
  'stage-trigger':'Przejście do kolejnego etapu',margin:'Limit ekspozycji'}[reason]||tidy(reason));

export function rememberPresentation(state,events,markets){
  const ui=state.presentation??{history:{},recentTrades:[],lastActions:{},marks:{}};
  const now=state.lastObservedAt;
  for(const [id,a] of Object.entries(state.accounts)){
    const points=ui.history[id]??[];
    if(!points.length)points.push({at:state.startedAt,equity:1000});
    const last=points.at(-1);
    if(last.at===now)last.equity=a.equity;
    else if(Math.floor(last.at/900000)===Math.floor(now/900000)&&points.length>1)points[points.length-1]={at:now,equity:a.equity};
    else points.push({at:now,equity:a.equity});
    ui.history[id]=points.slice(-193);
  }
  for(const e of events){
    if(e.player&&['fill','decision','blocked','expired','risk'].includes(e.kind))
      ui.lastActions[e.player]={at:e.at,text:reasonText(e.reason)||({decision:'Sprawdzenie sygnału',blocked:'Brak warunków do wykonania',risk:'Zabezpieczenie rachunku'}[e.kind]??e.kind)};
    if(e.kind==='fill')ui.recentTrades.push({id:`${state.seq}-${ui.recentTrades.length}-${e.player}`,at:e.at,playerId:e.player,
      symbol:e.symbol,side:e.delta>0?'BUY':'SELL',qty:e.amount,price:e.price,fee:e.fee,reason:reasonText(e.reason)});
  }
  ui.recentTrades=ui.recentTrades.slice(-60);
  ui.marks=Object.fromEntries(Object.entries(markets).map(([s,m])=>[s,m.mark]));
  state.presentation=ui;
}
export function summary(state,now,{eth55Path=ETH55_PUBLIC_PATH}={}){
  const ui=state.presentation??{history:{},recentTrades:[],lastActions:{},marks:{}};
  const base={schema:1,kind:'hajsomat-paper-arena',protocol:PROTOCOL.id,paper:true,ordersEnabled:false,updatedAt:now,
    status:'running',error:null,startedAt:state.startedAt,lastObservedAt:state.lastObservedAt,initial:1000,
    players:PLAYERS.map(def=>{
      const a=state.accounts[def.id],meta=META[def.id];
      const positions=Object.entries(a.positions).filter(([symbol])=>(a.qty[symbol]??0)>0).map(([symbol,p])=>({
        symbol,side:'LONG',qty:a.qty[symbol],entryPrice:p.averageEntry,mark:ui.marks[symbol]??p.averageEntry,
        notional:a.qty[symbol]*(ui.marks[symbol]??p.averageEntry),
        pnlUsd:a.qty[symbol]*((ui.marks[symbol]??p.averageEntry)-p.averageEntry),openedAt:p.openedAt,
        stage:def.id==='skoczekSOL'?state.policies.skoczek.state:'Pozycja otwarta'}));
      const group=def.id==='skoczekSOL'?'skoczek':def.id==='winnerBTC30'?'winner':'legacy';
      return {id:def.id,name:def.name,description:meta.description,color:meta.color,capital:a.equity,roi:a.equity/1000-1,
        drawdown:a.maxDD,fees:a.fees,funding:a.funding,closed:a.closed,wins:a.wins,fills:a.fills,
        status:a.status!=='running'?'blocked':positions.length?'holding':'waiting',nextDecision:state.nextSlots[group],
        positions,history:ui.history[def.id]??[],lastAction:ui.lastActions[def.id]?.text??'Czeka na pierwszy sygnał po starcie',
        signalSource:meta.source,decisionMinutes:meta.minutes,leverage:def.leverage,
        realized:n(a.realized),maxPositions:def.maxPositions,targetAllocation:def.allocation,
        pendingExecution:def.id==='winnerBTC30'&&state.pending.winner?state.pending.winner.slot+900000:null};
    }),recentTrades:[...ui.recentTrades].reverse(),quality:state.quality,
    costs:{feeBps:4.5,slipBps:5,funding:'rzeczywiste stawki HL; baza: ostatni oracle sprzed godziny. Po przerwie stara cena jest jawnym przybliżeniem.'},
    note:'Nowa liga papierowa: po 1000 USD, bez prawdziwych zleceń. Saldo i ROI po prowizji, poślizgu i fundingu; P&L otwartej pozycji przed kosztami. Warunki i dźwignie graczy są różne. Wykonanie: obserwowana księga + 5 pb poślizgu; wolumen godzinowy/4 to przybliżenie. Brak ścieżki intrabar i gwarancji realizacji. Wykres: ostatnie 48 godzin obserwacji. To test forward, nie dowód przyszłych zysków.'};
  let extra;
  if(state.quality.staleFundingEvents)base.note+=' UWAGA: '+state.quality.staleFundingEvents+
    ' rozliczeń fundingu po przerwie oparto na starej, wcześniej zaobserwowanej cenie oracle. Wynik dotkniętego rachunku jest przybliżony.';
  try{extra=safeRead(eth55Path,now);}catch(error){extra=error;}
  return mergeEth55(base,extra,now);
}
