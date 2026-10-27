// Reusable publication-review guard for the CMS and future Editorial Studio.
// It does not grant review authority or connect Storage; use only trusted records.
export function mediaReady(record,now=Date.now()){
 if(!record||record.reviewStatus!=='rights-and-relevance-verified'||!['authentic-photograph','official-diagram','brand-graphic'].includes(record.authenticity))return false;
 if(!['pooldocai-original','manufacturer','licensed-professional','licensed-library','permitted-contributor','brand-graphic'].includes(record.sourceType))return false;
 if(!record.reviewerId||!Number.isFinite(Date.parse(record.reviewedAt))||!record.alt?.trim()||record.alt.length>300||!record.license?.trim()||!record.permissionReference?.trim()||!record.attribution?.trim()||!record.copyright?.trim()||!/^https:\/\//.test(record.sourceUrl||'')||!/^[a-f0-9]{64}$/.test(record.checksum||'')||!Number.isInteger(record.width)||record.width<1||!Number.isInteger(record.height)||record.height<1)return false;
 if(record.expiresAt&&(!Number.isFinite(Date.parse(record.expiresAt))||Date.parse(record.expiresAt)<=now))return false;
 if(record.equipment?.representative&&!record.equipment.representativeLabel?.trim())return false;
 return true;
}
export const pendingMediaRights=()=>({reviewStatus:'pending',authenticity:'unverified',reviewerId:null,reviewedAt:null});
