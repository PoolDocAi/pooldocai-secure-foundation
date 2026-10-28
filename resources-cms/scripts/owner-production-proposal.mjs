import {readFileSync,writeFileSync} from 'node:fs';
export function ownerProductionProposal(){
 const publication=readFileSync(new URL('../supabase/schema-proposals/owner-publication-production.sql',import.meta.url),'utf8');
 // The reviewed import fragment already switches between postgres and the
 // NOLOGIN command-owner role at its table/function ownership boundaries.
 // Do not inject duplicate SET ROLE or RESET ROLE operations.
 const imports=readFileSync(new URL('../supabase/schema-proposals/owner-import.sql',import.meta.url),'utf8');
 const rights=readFileSync(new URL('../supabase/schema-proposals/owner-media-rights.sql',import.meta.url),'utf8');
 const base=readFileSync(new URL('../supabase/migrations/20261026042156_resources_cms_commands_v2.sql',import.meta.url),'utf8');
 const patch=(name,next)=>{const start=base.indexOf('CREATE FUNCTION resources_cms.'+name+'('),end=base.indexOf('\nEND $$;',start)+'\nEND $$;'.length;return base.slice(start,end).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION').replace(/linked\.state='published'/g,"linked.published_revision_id IS NOT NULL AND linked.state NOT IN ('archived','deleted')").replace(name==='command'?/NEVER_MATCH/:/a\.state='published'/g,"a.published_revision_id IS NOT NULL AND a.state NOT IN ('archived','deleted')");};
 const livePointers=patch('command','dispatch')+patch('taxonomy_command','media_command')+patch('media_command','settings_command');
 const output=publication.replace('SET ROLE resources_cms_command_owner;',()=> rights+'\nSET ROLE resources_cms_command_owner;\n'+imports+'\n'+livePointers+'\n');
 if (!output.includes("VALUES(true,'production',false)") || output.includes("VALUES(true,'staging',true)") || output.includes('4ab7d56e-57f4-4aed-9244-26ee801afab2') || output.includes('schema_migrations)<>46') || !output.includes('CREATE FUNCTION resources_cms.safe_public_html(') || !output.includes('CREATE FUNCTION resources_cms.media_release_ready(') || !output.includes('CREATE FUNCTION resources_cms.owner_import(')) throw Error('Production CMS assembly missing safety prerequisite or contains Staging state');
 if (/\bRESET ROLE;\s+RESET ROLE;/i.test(output) || /\bSET ROLE resources_cms_command_owner;\s+SET ROLE resources_cms_command_owner;/i.test(output)) throw Error('Redundant role switching detected');
 if (!/^-- PRODUCTION REVIEW CANDIDATE/.test(output) || !/COMMIT;\s*$/.test(output)) throw Error('Production migration transaction malformed');}
