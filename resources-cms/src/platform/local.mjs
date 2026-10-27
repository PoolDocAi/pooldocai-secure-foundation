import {randomUUID} from 'node:crypto';
import {installTaxonomy,facetList,facetCommand,placement} from './taxonomy.mjs';
import {installCatalog,localPublishedRows} from './catalog.mjs';
import {installAnalytics,ingest,report} from './analytics.mjs';
import {audit} from '../store.mjs';
export function localPlatform(db,saveRevision){
 installTaxonomy(db);installCatalog(db);installAnalytics(db);
 return {
  facets:async()=>facetList(db),catalog:async()=>localPublishedRows(db),
  command:async(user,input)=>facetCommand(db,user,input,saveRevision),
  requestTag:async(user,input)=>{if(!['owner','editor'].includes(user.role))throw Object.assign(Error('Editorial permission required'),{status:403});if(!/^[a-z_]+$/.test(input.facet||'')||typeof input.label!=='string'||input.label.length<2||input.label.length>100)throw Object.assign(Error('Short tag proposal required'),{status:422});const id=randomUUID();db.prepare('INSERT INTO facet_requests VALUES(?,?,?,?,\'pending\',?)').run(id,user.id,input.facet,input.label,new Date().toISOString());audit(db,user.id,'tag_request',id);return {id,state:'pending'};},
  tagRequests:async()=>db.prepare('SELECT * FROM facet_requests ORDER BY created_at DESC LIMIT 100').all(),
  collect:async(events,context)=>ingest(db,events,localPublishedRows(db),context),
  report:async(user,filter)=>{audit(db,user.id,'analytics_report',null,{from:filter.from||null,to:filter.to||null});return report(db,filter);},
  purge:async(user,before)=>{const at=Date.parse(before);if(!Number.isFinite(at)||at>Date.now())throw Object.assign(Error('Past cutoff required'),{status:422});const count=Number(db.prepare('DELETE FROM resource_events WHERE received_at<?').run(new Date(at).toISOString()).changes);audit(db,user.id,'analytics_purge',null,{count,before:new Date(at).toISOString()});return {deleted:count};},
 };
}
