/** Łowca inherited, pure strategy adapter. No orders, I/O or wall clock.
 * Original 15m native features and 6h router; observed HL execution is a NEW
 * forward variant, not a replay of Binance history. Target/cap scaled by 3.
 */
import source,{SOURCE_ID,SOURCE_SIGNATURE} from './lowca-source.mjs';
const H=3600000,Q=900000;
const ensure=(ok,msg)=>{if(!ok)throw Error('Lowca: '+msg);};
const finite=Number.isFinite;
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export const ORIGINAL=freeze(structuredClone(source));
ensure(SOURCE_ID==='child4736-momentum-slow-SOL-full-inherited'&&source.kind==='cycle_router'&&source.every_h===6,'wrong source');
const route=source.params.routes[0];
const impossible=r=>r.all?.some(c=>c.op==='eq'&&typeof c.left==='number'&&typeof c.right==='number'&&c.left!==c.right);
ensure(source.params.routes.length===3&&source.params.routes.slice(1).every(r=>impossible(r.when)),'inactive routes changed');
ensure(route.graph.asset===2&&route.graph.side===1&&source.params.switch_mode==='flat_only'&&
  source.params.cooldown_h===0&&source.params.max_route_h===720&&source.params.opportunities.max_prepare_h===336,'unsupported wrapper');
const graph=structuredClone(route.graph);graph.gross_cap*=3;
for(const state of Object.values(graph.states))if(state.action.kind==='allocate')state.action.weight*=3;
export const LOWCA_GRAPH=freeze(graph);
export const LOWCA_SOURCE=freeze({id:SOURCE_ID,signature:SOURCE_SIGNATURE,multiplier:3,
  featureMinutes:15,decisionHours:6,historyBars:512,execution:'HL IOC; hard admission cap 3; not historical execution'});
export function makeLowca(){return {child:null,selectedAt:null,hasOpened:false,closedAt:null,
  phase:'idle',observerStartedAt:null};}
export function lowcaIndicators(bars,slot){
  ensure(Array.isArray(bars)&&bars.length===512,'need 512 closed 15m bars');
  bars.forEach((b,i)=>ensure(b.t===slot-(512-i)*Q&&[b.o,b.h,b.l,b.c].every(v=>finite(v)&&v>0)&&
    b.h>=Math.max(b.o,b.c)&&b.l<=Math.min(b.o,b.c)&&b.h>=b.l&&finite(b.v)&&b.v>=0,'gap/duplicate/future/invalid OHLCV'));
  // Same Wilder seed as multiframe_data._wilder_mean: first TR is undefined.
  const tr=bars.slice(1).map((b,i)=>Math.max(b.h-b.l,Math.abs(b.h-bars[i].c),Math.abs(b.l-bars[i].c)));
  let atr=tr.slice(0,14).reduce((a,v)=>a+v,0)/14;
  for(const v of tr.slice(14))atr+=(v-atr)/14;
  const last=bars.length-1,c=bars[last].c;
  const distance=bars.slice(last-168+1).reduce((n,b,i)=>n+Math.abs(b.c-bars[last-168+i].c),0);
  const er=distance?Math.abs(c-bars[last-168].c)/distance:NaN;
  const prior= Math.max(...bars.slice(last-336,last).map(b=>b.h));
  return {valid:finite(atr)&&atr>0&&finite(er),atr14:atr,er,price:c,
    r168:c/bars[last-168].c-1,prior_high336:prior,barTs:bars[last].t};
}
export function lowcaDecide(r,x,decide,makeGraph){
  ensure(x.quantity>=0&&x.equity>0,'invalid account');
  const valid=x.features.valid===true;
  const idle=(reason)=>({weights:[0,0,0],trace:{state:r.phase,action:'flat',transition:reason,
    selectedAt:r.selectedAt,sourceSignature:SOURCE_SIGNATURE}});
  // A single eligible route. Its observer remains reset while it owns a cycle.
  if(!r.child){
    if(!valid)r.observerStartedAt=null;
    else if(r.observerStartedAt===null||x.now-r.observerStartedAt>=336*H)r.observerStartedAt=x.now;
  }else r.observerStartedAt=null;
  if(r.child&&r.closedAt!==null&&x.quantity===0){
    r.child=null;r.selectedAt=null;r.hasOpened=false;r.closedAt=null;r.phase='idle';
    // The closing owner's observer was reset BEFORE release, so no reentry here.
    return idle('cycle-complete');
  }
  if(r.phase==='draining')return idle('route-draining');
  if(r.child&&(!valid||x.now-r.selectedAt>=720*H)){
    if(x.quantity){r.phase='draining';return idle(valid?'route-timeout':'invalid-data');}
    r.child=null;r.selectedAt=null;r.phase='idle';return idle(valid?'route-timeout':'invalid-data');
  }
  if(!r.child){
    ensure(x.quantity===0,'position without owner');
    if(!valid||!(x.features.price>x.features.prior_high336&&x.features.r168>0))return idle('no-route');
    const g=makeGraph();g.state=graph.initial;g.since=r.observerStartedAt;g.last_flat=r.observerStartedAt;
    g.goal=0;g.start_q=0;r.child=g;r.selectedAt=x.now;r.phase='active';r.observerStartedAt=null;
  }
  const result=decide(r.child,x,LOWCA_GRAPH);
  result.trace.routerPhase=r.phase;result.trace.selectedAt=r.selectedAt;result.trace.sourceSignature=SOURCE_SIGNATURE;
  return result;
}
export function lowcaFill(r,fill,feedback){
  ensure(r.child&&r.closedAt===null,'fill without live cycle');
  if(!r.hasOpened){ensure(fill.quantityAfter>0,'first fill must open');r.hasOpened=true;}
  else if(fill.quantityAfter===0)r.closedAt=fill.now;
  feedback(r.child,fill);
}
