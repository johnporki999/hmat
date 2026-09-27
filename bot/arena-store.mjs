/** Private durable journal. All paths remain under logs/arena-v1. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const ensure = (ok,message) => {if(!ok)throw Error(message);};
export function atomic(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+'.tmp',fd=fs.openSync(tmp,'w',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(tmp,file);
}
function readRecord(file){
  const r=JSON.parse(fs.readFileSync(file,'utf8'));
  ensure(r.hash===digest(JSON.stringify(r.payload)),'Arena journal checksum mismatch');
  return r;
}
export function recover(dir,freeze){
  const folder=path.join(dir,'events');
  const files=fs.existsSync(folder)?fs.readdirSync(folder).filter(n=>/^\d{9}\.json$/.test(n)).sort():[];
  if(!files.length){
    ensure(!fs.existsSync(path.join(dir,'EXPERIMENT.json'))&&!fs.existsSync(path.join(dir,'checkpoint.json')),
      'Arena journal missing: refusing a balance reset');
    return null;
  }
  ensure(files.every((f,i)=>Number(f.slice(0,9))===i+1),'Arena journal sequence gap');
  const last=readRecord(path.join(folder,files.at(-1)));
  ensure(last.payload.state.seq===files.length,'Arena journal sequence mismatch');
  ensure((last.payload.state.freeze?.hash??last.payload.state.freeze)===freeze,'Arena frozen code changed; start a separately authorized experiment, never reset this one');
  if(files.length>1){
    const previous=readRecord(path.join(folder,files.at(-2)));
    ensure(last.payload.previous===previous.hash,'Arena journal chain mismatch');
  }else ensure(last.payload.previous===null,'Invalid first Arena journal record');
  return {state:last.payload.state,hash:last.hash};
}
export function commit(dir,result,input,previous,protocol){
  ensure(result.state.seq===(previous?.state.seq??0)+1,'Non-consecutive Arena commit');
  const file=path.join(dir,'events',`${String(result.state.seq).padStart(9,'0')}.json`);
  ensure(!fs.existsSync(file),'Duplicate Arena journal record');
  const payload={previous:previous?.hash??null,state:result.state,events:result.events,input};
  const record={payload,hash:digest(JSON.stringify(payload))};
  // The event is authoritative. A crash before the following two derived files is recoverable.
  atomic(file,record);
  if(!previous)atomic(path.join(dir,'EXPERIMENT.json'),{protocol,freeze:result.state.freeze,startedAt:result.state.startedAt});
  atomic(path.join(dir,'checkpoint.json'),{seq:result.state.seq,hash:record.hash,state:result.state});
  return record;
}
