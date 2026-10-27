import {readFileSync,writeFileSync} from 'node:fs';
export function ownerRecoveryProposal(){
 const publication=readFileSync(new URL('../supabase/schema-proposals/owner-publication.sql',import.meta.url),'utf8');
 const imports=readFileSync(new URL('../supabase/schema-proposals/owner-import.sql',import.meta.url),'utf8')
  .replace('CREATE TABLE resources_cms.owner_import_sources(', 'RESET ROLE;\nCREATE TABLE resources_cms.owner_import_sources(')
  .replace('CREATE FUNCTION resources_cms.owner_import(', 'SET ROLE resources_cms_command_owner;\nCREATE FUNCTION resources_cms.owner_import(');
 const rights=readFileSync(new URL('../supabase/schema-proposals/owner-media-rights.sql',import.meta.url),'utf8');
 const base=readFileSync(new URL('../supabase/migrations/20261026042156_resources_cms_commands_v2.sql',import.meta.url),'utf8');
 const patch=(name,next)=>{const start=base.indexOf('CREATE FUNCTION resources_cms.'+name+'('),end=base.indexOf('\nEND $$;',start)+'\nEND $$;'.length;return base.slice(start,end).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION').replace(/linked\.state='published'/g,"linked.published_revision_id IS NOT NULL AND linked.state NOT IN ('archived','deleted')").replace(name==='command'?/NEVER_MATCH/:/a\.state='published'/g,"a.published_revision_id IS NOT NULL AND a.state NOT IN ('archived','deleted')");};
 const livePointers=patch('command','dispatch')+patch('taxonomy_command','media_command')+patch('media_command','settings_command');
 return publication.replace('SET ROLE resources_cms_command_owner;',()=> rights+'\nSET ROLE resources_cms_command_owner;\n'+imports+'\n'+livePointers+'\n');
}
if(process.argv[1]&&new URL(import.meta.url).pathname===process.argv[1]){const output=process.argv[2];if(!output)throw Error('Output SQL path required');writeFileSync(output,ownerRecoveryProposal());}
