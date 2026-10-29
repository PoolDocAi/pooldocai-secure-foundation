// Read-only release guard for a captured staging catalog/ACL snapshot.
// No network, no credentials, no database writes. Refresh evidence from live read-only SQL.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export const APPROVED_INITIAL_PUBLIC_SLUGS=Object.freeze([
  'green-pool-first-checks','pool-pump-wont-start'
]);
const REQUIRED_COUNTS=[
  'articles','drafts','published_state','held_drafts','held_published',
  'holds','historical_public_pointers','scheduled','knowledge_grants',
  'synthetic_draft','publicly_returned','synthetic_public',
  'table_count','rls_table_count','direct_anon_grants','direct_auth_grants'
];

export function inspectPrePublicationGate(snapshot) {
  const fail=[];
  if(!snapshot || snapshot.kind!=='pooldocai-staging-prepublication' || snapshot.version!==1)
    return {ok:false,failures:['Unsupported release-gate snapshot']};
  const count=snapshot.counts||{};
  for(const key of REQUIRED_COUNTS) {
    if(!Number.isSafeInteger(count[key])||count[key]<0)
      fail.push('Missing or invalid nonnegative count: '+key);
  }
  const compare=(key,expected)=>{if(count[key]!==expected)fail.push(`${key} must remain ${expected}; observed ${count[key]}`)};
  // These exact numbers describe the Oct 28 owner-review baseline, NOT future publication approval.
  for(const [k,v] of Object.entries({
    articles:33,drafts:32,published_state:1,held_drafts:31,held_published:1,
    holds:32,historical_public_pointers:2,scheduled:0,knowledge_grants:0,
    synthetic_draft:1,publicly_returned:2,synthetic_public:0,
    table_count:21,rls_table_count:21,direct_anon_grants:0,direct_auth_grants:0
  })) compare(k,v);
  if(!Array.isArray(snapshot.publicSlugs)||
    snapshot.publicSlugs.length!==APPROVED_INITIAL_PUBLIC_SLUGS.length ||
    !APPROVED_INITIAL_PUBLIC_SLUGS.every((slug,i)=>snapshot.publicSlugs[i]===slug))
    fail.push('Staging published-only RPC must return exactly the two approved historical guide slugs');
  if(snapshot.productionBackupVerified!==false)
    fail.push('This pre-production snapshot must not claim an authenticated Production backup');
  if(snapshot.productionCmsDeployed!==false)
    fail.push('This Staging snapshot must not claim Production CMS deployment');
  if(snapshot.cmsSchedulingEnabled!==false)
    fail.push('Scheduled CMS publication must remain disabled');
  return {ok:fail.length===0,failures:fail};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const file=process.argv[2];
  if(!file)throw Error('Usage: node scripts/verify-staging-release-gates.mjs evidence/staging-content-gate-YYYYMMDD.json');
  const snapshot=JSON.parse(readFileSync(file,'utf8'));
  const result=inspectPrePublicationGate(snapshot);
  if(!result.ok) {console.error('CMS PREPUBLICATION GATE FAILED:\n'+result.failures.join('\n'));process.exitCode=1;}
  else console.log('PASS: 31 held owner-review drafts; 2 historical public guides; 21 RLS-protected tables; zero scheduled/knowledge grants; no Production release');
}
