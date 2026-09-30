/** Explicit, one-time journal migration. Old records are NEVER rewritten.
 * Accepted predecessor hashes are pinned to deployed PAPER releases, not an
 * arbitrary bypass of code freezes. Unknown/corrupt journals remain blocked.
 */
import fs from 'node:fs';
import path from 'node:path';
import {recover,commit,atomic,digest} from './arena-store.mjs';
export const OLD_MAIN='3aed400f10cd88d3e702011e660cd5dd5d12c24bd461cd73fa740bdfeb8c0800';
export const OLD_ETH='cc8f3ff83e1f3f28936b6a44010e25ad1adbba32294c4ced12522c19c0a9346f';
export function recoverMigrated(dir,hash,{predecessor,protocol,migrate,now}){
  try{return recover(dir,hash);}
  catch(error){if(!error.message.startsWith('Arena frozen code changed'))throw error;}
  const old=recover(dir,predecessor);if(!old)throw Error('Missing predecessor journal');
  const state=structuredClone(old.state);
  if(state.protocol!==protocol.id)throw Error('Migration protocol mismatch');
  const backup=path.join(dir,'migrations',predecessor+'-before.json');
  if(fs.existsSync(backup)){
    const saved=JSON.parse(fs.readFileSync(backup,'utf8'));
    if(saved.hash!==old.hash||saved.checksum!==digest(JSON.stringify(old.state)))throw Error('Migration backup conflict');
  }else atomic(backup,{hash:old.hash,checksum:digest(JSON.stringify(old.state)),state:old.state});
  migrate(state,now,hash);
  // Preserve the original observation timestamp: a migration is NOT a market tick.
  if(state.lastObservedAt!==old.state.lastObservedAt||state.startedAt!==old.state.startedAt)throw Error('Migration changed observation/start');
  state.freeze=typeof state.freeze==='string'?hash:{...state.freeze,hash};state.seq=old.state.seq+1;
  const event={kind:'migration',at:now,from:predecessor,to:hash,reason:'funding-gap-recovery-no-roster-change',
    preservesBalances:true,oldJournalHash:old.hash};
  state.migrations=[...(state.migrations??[]),event];
  const record=commit(dir,{state,events:[event]},{migration:true,ordersEnabled:false},old,protocol);
  return {state:record.payload.state,hash:record.hash};
}
