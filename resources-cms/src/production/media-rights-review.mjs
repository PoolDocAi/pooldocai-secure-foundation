import {randomUUID} from 'node:crypto';
import {mediaReady} from '../platform/media-rights.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const error=message=>Object.assign(new Error(message),{status:422});
export function normalizeMediaRightsCommand(action,input={}){
 if(!['submit','approve','revoke'].includes(action)||!uuid.test(input.mediaId||'')||!Number.isInteger(input.version)||input.version<0)throw error('Invalid media rights command');
 const details=input.details||{};
 if(!details||Array.isArray(details)||typeof details!=='object'||Buffer.byteLength(JSON.stringify(details))>20000)throw error('Invalid media rights details');
 if(action==='submit'){
  if(['status','reviewStatus','reviewerId','reviewedAt','ready'].some(k=>Object.hasOwn(details,k)))throw error('Client review claims rejected');
  if(!/^[a-f0-9]{64}$/.test(details.checksum||''))throw error('Registered image checksum required');
 }
 if(action==='approve'&&details.humanVerified!==true)throw error('Explicit human rights and relevance review required');
 if(action==='revoke'&&(!details.reason?.trim()||details.reason.length>1000))throw error('Revocation reason required');
 const commandId=input.commandId||randomUUID();if(!uuid.test(commandId))throw error('Invalid command UUID');
 return {p_command_id:commandId,p_media_id:input.mediaId,p_version:input.version,p_action:action,p_details:details};
}
function principal(user){if(!uuid.test(user?.id||'')||typeof user.accessToken!=='string'||!user.accessToken)throw Object.assign(new Error('Verified CMS session required'),{status:401});return user;}
export async function reviewMediaRights(db,user,action,input){const who=principal(user);return db.rpc('media_rights_command',normalizeMediaRightsCommand(action,input),who.accessToken);}
export async function readMediaRights(db,user,mediaId=null){const who=principal(user);if(mediaId!==null&&!uuid.test(mediaId))throw error('Invalid media UUID');return db.rpc('media_rights_read',{p_media_id:mediaId},who.accessToken);}
// This is a display-side consistency check only. SQL media_release_ready is
// the publication/delivery authority and rechecks expiry and registered checksum.
export const reviewedMediaDisplayReady=record=>record?.ready===true&&record.status==='approved'&&mediaReady(record);
