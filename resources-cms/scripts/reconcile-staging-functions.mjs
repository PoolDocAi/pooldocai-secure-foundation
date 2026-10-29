// Offline only: no network, credentials, hosted SQL, ledger repair, or release.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {ownerRecoveryProposal} from './owner-recovery-proposal.mjs';
const input=process.argv[2], output=process.argv[3];
if(!input || !output) throw Error('Usage: node scripts/reconcile-staging-functions.mjs snapshot.json report.json');
const live=JSON.parse(readFileSync(input,'utf8'));
const read=p=>readFileSync(p,'utf8').replace(/\r\n/g,'\n');
const localV2=s=>s.replace(/DO \$guard\$ BEGIN\n IF current_user<>'postgres'[\s\S]*?END \$guard\$;\n/,'').replace(/-- This is a second, grantor-specific row\.[\s\S]*?END \$guard\$;\n/,'').replace(/-- Remove only the temporary row granted by postgres\.[\s\S]*?END \$guard\$;\n/,'');
const localProposal=s=>s.replace(/DO \$preflight\$[\s\S]*?\$preflight\$;/,'').replace('GRANT resources_cms_command_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;','').replace('REVOKE resources_cms_command_owner FROM postgres GRANTED BY postgres RESTRICT;','').replace(/DO \$postflight\$[\s\S]*?\$postflight\$;/,'');
const db=new PGlite();
try {
 await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE ROLE authenticator;GRANT authenticated TO authenticator;');
 await db.exec(read('supabase/migrations/20261026035555_resources_cms_isolated_v1.sql'));
 await db.exec(localV2(read('supabase/migrations/20261026042156_resources_cms_commands_v2.sql')));
 await db.exec(localProposal(ownerRecoveryProposal()));
 await db.exec("CREATE SCHEMA auth;CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT null::uuid$$;CREATE SCHEMA storage;CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text,owner_id text);ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;");
 await db.exec(read('supabase/schema-proposals/private-owner-storage.sql'));
 await db.exec(read('supabase/schema-proposals/private-owner-storage-identity.sql'));
 await db.exec(read('supabase/schema-proposals/media-canonical-object-key.sql'));
 await db.exec('SET ROLE resources_cms_command_owner');
 await db.exec(read('supabase/schema-proposals/private-media-execute-grants.sql'));
 await db.exec('RESET ROLE');
 const expected=(await db.query("SELECT p.proname,pg_get_function_identity_arguments(p.oid) args,pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='resources_cms' ORDER BY p.proname,args")).rows;
 // Ignore only platform pretty-printing differences; function SQL stays intact.
 const normalize=s=>s.replace(/\r\n/g,'\n').trim();
 const hash=s=>createHash('sha256').update(normalize(s)).digest('hex');
 const key=f=>`${f.proname}(${f.args})`;
 const rows=expected.map(f=>{const actual=live.find(x=>key(x)===key(f));return {function:key(f),expectedSha256:hash(f.definition),liveSha256:actual?hash(actual.definition):null,status:!actual?'missing-live':normalize(actual.definition)===normalize(f.definition)?'match':'different'};});
 for(const f of live)if(!expected.some(x=>key(x)===key(f)))rows.push({function:key(f),status:'unexpected-live',liveSha256:hash(f.definition)});
 const report={scope:'Offline PGlite reconstruction; function definitions only, not complete schema/ACL reconciliation',hostedMutations:false,rows};
 writeFileSync(output,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({functions:rows.length,matched:rows.filter(x=>x.status==='match').length,differences:rows.filter(x=>x.status!=='match')}));
} catch(error) {console.error(error.message);process.exitCode=1;} finally {await db.close();}
