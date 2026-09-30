/** Standalone pure StateGraph reducer. No legacy/Panika imports, no I/O. */
const H=3600000,finite=Number.isFinite;
const ensure=(ok,msg)=>{if(!ok)throw Error('Lowca graph: '+msg);};
export function makeGraph(){return {state:null,since:null,goal:null,start_q:null,first_price:null,
  entry_atr:null,entry_equity:null,peak_move:0,last_atr:null,last_equity:null,last_flat:null};}
function enter(g,name,x,p){
  const a=p.states[name].action;g.state=name;g.since=x.now;g.start_q=x.quantity;
  g.goal=a.kind==='allocate'?a.weight*x.equity/x.mark:a.kind==='trim'?x.quantity*a.keep:a.kind==='flat'?0:null;
}
const cmp={gt:(a,b)=>a>b,ge:(a,b)=>a>=b,lt:(a,b)=>a<b,le:(a,b)=>a<=b,eq:(a,b)=>a===b,ne:(a,b)=>a!==b};
function operand(v,x,m){
  if(typeof v==='number')return v;if('metric'in v)return m[v.metric];
  ensure(v.asset===2&&'feature'in v,'unsupported operand');return x.features[v.feature]*(v.scale??1);
}
function guard(r,x,m){
  if(r.all)return r.all.every(c=>guard(c,x,m));if(r.any)return r.any.some(c=>guard(c,x,m));
  const l=operand(r.left,x,m),v=operand(r.right,x,m);return finite(l)&&finite(v)&&cmp[r.op](l,v);
}
export function graphDecide(g,x,p){
  ensure(finite(x.equity)&&x.equity>0&&finite(x.quantity)&&x.quantity>=0&&x.mark>0,'invalid account');
  g.last_atr=finite(x.features.atr14)?x.features.atr14:null;g.last_equity=x.equity;
  if(g.state===null){g.last_flat=x.now;enter(g,p.initial,x,p);}
  const previous=g.state,a=p.states[g.state].action;
  let ready=g.goal!==null?Math.abs(x.quantity-g.goal)<=Math.max(1e-12,.05*Math.abs(g.goal-g.start_q)):x.quantity!==0;
  if(a.kind==='flat')ready=x.quantity===0;
  const move=g.first_price!==null&&g.entry_atr>0?(x.mark-g.first_price)/g.entry_atr:NaN;
  if(finite(move))g.peak_move=Math.max(g.peak_move,move);
  const metrics={state_h:(x.now-g.since)/H,age_h:x.ageHours??0,flat_h:g.last_flat!==null?(x.now-g.last_flat)/H:0,
    filled:Number(x.quantity!==0),ready:Number(ready),pnl_net:x.quantity?(x.cyclePnl??0):0,
    cycle_return:x.quantity&&g.entry_equity?(x.cyclePnl??0)/g.entry_equity:0,
    move_atr:move,giveback_atr:g.peak_move-move,peak_move_atr:finite(move)?g.peak_move:NaN};
  let trigger=null;const checked=[];
  if(x.features.valid!==true||!finite(x.features.atr14)||x.features.atr14<=0){
    if(g.state!==p.exit)enter(g,p.exit,x,p);trigger='invalid-data';
  }else if(a.kind!=='flat'||x.quantity===0){
    for(const e of p.states[g.state].next){const passed=guard(e.when,x,metrics);checked.push({label:e.label,passed});
      if(passed){trigger=e.label;enter(g,e.to,x,p);break;}}
  }
  const kind=p.states[g.state].action.kind;
  if(kind==='trim')g.goal=Math.min(Math.abs(g.goal),Math.abs(x.quantity));
  const want=g.goal===null?x.quantity:g.goal,wantWeight=want*x.mark/x.equity;
  return {weights:[0,0,Math.min(p.gross_cap,Math.max(-p.gross_cap,wantWeight))],
    trace:{previous,state:g.state,transition:trigger,action:kind,goal_quantity:g.goal,actual_quantity:x.quantity,
      cap_applied:Math.abs(wantWeight)>p.gross_cap,evaluated:checked,
      metrics_before:Object.fromEntries(Object.entries(metrics).map(([k,v])=>[k,finite(v)?v:null]))}};
}
export function graphFill(g,{quantityAfter,price,now}){
  if(Math.abs(quantityAfter)<1e-12){g.first_price=g.entry_atr=g.entry_equity=null;g.peak_move=0;g.last_flat=now;}
  else if(g.first_price===null){g.first_price=price;g.entry_atr=g.last_atr;g.entry_equity=g.last_equity;g.peak_move=0;}
}
