import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {transaction} from '../store.mjs';
const schema=JSON.parse(readFileSync(new URL('../../config/analytics-events.json',import.meta.url)));
export const eventNames=new Set(schema.events.filter(e=>!e.server_confirmed&&!e.name.startsWith('admin_')).map(e=>e.name));
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const allowed=new Set(['event_id','event_name','session_id','sequence_number','page_instance_id','occurred_at','route','surface','element_id','content_id','consent','device','source','payload']);
const numeric=new Set(['active_seconds','scroll_depth','result_count','rating']);
const fail=(s,m)=>{throw Object.assign(Error(m),{status:s});};
export function installAnalytics(db){db.exec(`CREATE TABLE IF NOT EXISTS resource_events(event_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,sequence_number INTEGER NOT NULL,page_instance_id TEXT NOT NULL,event_name TEXT NOT NULL,occurred_at TEXT NOT NULL,received_at TEXT NOT NULL,route TEXT NOT NULL,surface TEXT NOT NULL,element_id TEXT,content_id TEXT,revision_id TEXT,device TEXT NOT NULL,source TEXT NOT NULL,payload TEXT NOT NULL,tag_context TEXT NOT NULL,category_id TEXT,UNIQUE(session_id,sequence_number));CREATE INDEX IF NOT EXISTS resource_events_received ON resource_events(received_at);CREATE INDEX IF NOT EXISTS resource_events_session ON resource_events(session_id,sequence_number);CREATE TABLE IF NOT EXISTS analytics_budget(day TEXT PRIMARY KEY,count INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS analytics_conversion_receipts(receipt_id TEXT PRIMARY KEY,event_id TEXT NOT NULL);`);}
export function validateEvent(e,catalog,now=Date.now()){
 if(!e||typeof e!=='object'||Object.keys(e).some(k=>!allowed.has(k))||!eventNames.has(e.event_name)||e.event_name==='conversion_complete')fail(422,'Unsupported event');
 if(e.consent!==true)fail(403,'Optional analytics consent required');
 if(!UUID.test(e.event_id)||!UUID.test(e.session_id)||!UUID.test(e.page_instance_id)||!Number.isInteger(e.sequence_number)||e.sequence_number<1||e.sequence_number>10000)fail(422,'Invalid event identity or sequence');
 const at=Date.parse(e.occurred_at);if(!Number.isFinite(at)||at<now-86400000||at>now+300000)fail(422,'Event timestamp outside collection window');
 if(!['website','resources','widget'].includes(e.surface)||!['mobile','tablet','desktop','unknown'].includes(e.device)||!['direct','organic','social','referral','email','paid','unknown'].includes(e.source))fail(422,'Invalid aggregate dimensions');
 if(e.element_id&&!/^[a-z][a-z0-9_.-]{0,79}$/.test(e.element_id))fail(422,'Stable element identifier required');
 const article=catalog.find(r=>r.id===e.content_id);if(e.content_id&&!article)fail(422,'Published resource unavailable');
 const routes=new Set(['/','/resources/',...catalog.map(r=>new URL(r.url).pathname)]);if(!routes.has(e.route))fail(422,'Public canonical route required');
 const payload=e.payload||{};if(typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(k=>!numeric.has(k)&&k!=='intent_id')||Object.entries(payload).some(([k,v])=>k!=='intent_id'&&(typeof v!=='number'||!Number.isFinite(v)||v<0||v>10000)))fail(422,'Only bounded aggregate measurements permitted');
 if(payload.scroll_depth!==undefined&&![25,50,75,90].includes(payload.scroll_depth)||payload.active_seconds>30)fail(422,'Invalid engagement checkpoint');
 if(payload.intent_id&&!catalog.some(r=>r.tags.some(t=>t.id===payload.intent_id)))fail(422,'Published safe intent required');
 return {...e,content_id:article?.id||null,revision_id:article?.revisionId||null,payload,tag_context:article?.tags||[],category_id:article?.categoryId||null};
}
export function ingest(db,events,catalog,{gpc=false,bot=false,now=Date.now()}={}){
 if(gpc||bot)return {accepted:0,excluded:true};
 if(!Array.isArray(events)||events.length<1||events.length>20)fail(413,'Batch must contain 1–20 events');
 const valid=events.map(e=>validateEvent(e,catalog,now)),day=new Date(now).toISOString().slice(0,10);
 return transaction(db,()=>{
  db.prepare('INSERT OR IGNORE INTO analytics_budget VALUES(?,0)').run(day);const budget=db.prepare('SELECT count FROM analytics_budget WHERE day=?').get(day).count;
  if(budget+valid.length>10000)fail(429,'Daily collection budget reached');
  let accepted=0;for(const e of valid){if(db.prepare('SELECT count(*) n FROM resource_events WHERE session_id=?').get(e.session_id).n>=200)fail(429,'Session event budget reached');
   accepted+=Number(db.prepare('INSERT OR IGNORE INTO resource_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(e.event_id,e.session_id,e.sequence_number,e.page_instance_id,e.event_name,e.occurred_at,new Date(now).toISOString(),e.route,e.surface,e.element_id||null,e.content_id,e.revision_id,e.device,e.source,JSON.stringify(e.payload),JSON.stringify(e.tag_context),e.category_id).changes);
  }
  db.prepare('UPDATE analytics_budget SET count=count+? WHERE day=?').run(valid.length,day);
  db.prepare('DELETE FROM resource_events WHERE event_id IN (SELECT event_id FROM resource_events WHERE received_at<? LIMIT 500)').run(new Date(now-90*86400000).toISOString());
  db.prepare('DELETE FROM analytics_budget WHERE day<?').run(new Date(now-2*86400000).toISOString().slice(0,10));return {accepted,duplicates:valid.length-accepted};
 });
}
// Only a trusted backend integration may call this after verifying a provider receipt.
// No public collector input or browser event can invoke this function.
export function confirmedConversion(db,receiptId,proof){if(!proof?.providerConfirmed||typeof receiptId!=='string'||!/^[a-f0-9]{64}$/.test(receiptId))throw Error('Verified provider receipt required');db.prepare('INSERT OR IGNORE INTO analytics_conversion_receipts VALUES(?,?)').run(receiptId,randomUUID());}
export function report(db,{from,to,device,source,category,tag}={}){
 const end=to?Date.parse(to):Date.now(),start=from?Date.parse(from):end-30*86400000;if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||end-start>90*86400000)fail(422,'Choose a date range within 90 days');
 const rows=db.prepare('SELECT * FROM resource_events WHERE received_at>=? AND received_at<=? ORDER BY session_id,sequence_number').all(new Date(start).toISOString(),new Date(end).toISOString()).filter(r=>(!device||r.device===device)&&(!source||r.source===source)&&(!category||r.category_id===category)&&(!tag||JSON.parse(r.tag_context).some(t=>t.id===tag)));
 const counts={},resources={},elements={},sessions=new Map(),days={},depth={},segments={},intents={};for(const r of rows){counts[r.event_name]=(counts[r.event_name]||0)+1;elements[r.element_id||'unlabelled']=(elements[r.element_id||'unlabelled']||0)+1;days[r.received_at.slice(0,10)]=(days[r.received_at.slice(0,10)]||0)+1;if(!sessions.has(r.session_id))sessions.set(r.session_id,[]);sessions.get(r.session_id).push(r);const p=JSON.parse(r.payload);if(p.intent_id)intents[p.intent_id]=(intents[p.intent_id]||0)+1;for(const t of JSON.parse(r.tag_context)){const key=t.group+':'+t.slug;segments[key]=(segments[key]||0)+1;}if(p.scroll_depth)depth[p.scroll_depth]=(depth[p.scroll_depth]||0)+1;if(r.content_id){const x=resources[r.content_id]||={views:0,activeSeconds:{}};if(r.event_name==='resource_open')x.views++;if(p.active_seconds)x.activeSeconds[r.session_id]=(x.activeSeconds[r.session_id]||0)+p.active_seconds;}}
 const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0, median=a=>{const b=[...a].sort((x,y)=>x-y);return b.length?b.length%2?b[(b.length-1)/2]:(b[b.length/2-1]+b[b.length/2])/2:0;};
 const journeys=[...sessions.values()].map(s=>({steps:s.map(r=>({event:r.event_name,element:r.element_id,content:r.content_id,sequence:r.sequence_number})),complete:false,sequenceConfidence:s[0].sequence_number===1&&s.every((r,i)=>!i||r.sequence_number===s[i-1].sequence_number+1)?'ordered-observed':'gaps-present',exit:'unknown unless an exit event was received'}));
 const funnelNames=['page_view','search_submit','resource_open','cta_click'];const funnel=funnelNames.map((event,i)=>({event,sessions:[...sessions.values()].filter(s=>{let j=0;for(const r of s)if(r.event_name===funnelNames[j])j++;return j>i;}).length}));
 return {eventCount:rows.length,sessions:sessions.size,counts,resources:Object.entries(resources).map(([id,r])=>({id,views:r.views,meanActiveCheckpoint:mean(Object.values(r.activeSeconds)),medianActiveCheckpoint:median(Object.values(r.activeSeconds))})),elements,days,segments,searchIntents:intents,scrollDepth:depth,journeys:journeys.slice(0,100),funnel,conversionTrackingAvailable:false,confirmedConversions:null,coverage:'Consented observed events only; gaps, unreceived exits and blocked clients are unknown. Active-time totals cover received foreground checkpoints, not unobserved reading time.',retentionDays:90};
}
