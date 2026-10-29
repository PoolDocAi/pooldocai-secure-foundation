import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const remediation=readFileSync(new URL('../security/staging-manual-duplicate-remediation.sql',import.meta.url),'utf8');
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const companyA=uuid(10),companyB=uuid(11),closedCompany=uuid(12);
const ownerA=uuid(21),ownerB=uuid(22),suspended=uuid(23),outsider=uuid(24);
const manualA=uuid(31),manualB=uuid(32),manualClosed=uuid(33);
const sha='a'.repeat(64);
const lookup='SELECT * FROM public.pooldocai_check_manual_duplicate($1::uuid,$2::text,$3::uuid)';

async function fixture() {
  const db=new PGlite();
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;');
  await db.exec("CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;");
  await db.exec('CREATE TABLE public.companies(id uuid PRIMARY KEY,status text NOT NULL);');
  await db.exec('CREATE TABLE public.company_members(id uuid PRIMARY KEY,company_id uuid NOT NULL,user_id uuid NOT NULL,status text NOT NULL);');
  await db.exec('CREATE TABLE public.company_manuals(id uuid PRIMARY KEY,company_id uuid NOT NULL,content_sha256 text,created_at timestamptz NOT NULL DEFAULT now());');
  await db.exec('GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;');
  for(const [id,status] of [[companyA,'active'],[companyB,'active'],[closedCompany,'inactive']])
    await db.query('INSERT INTO public.companies(id,status)VALUES($1,$2)',[id,status]);
  for(const [id,company,user,status] of [
    [uuid(100),companyA,ownerA,'active'],[uuid(101),companyB,ownerB,'active'],
    [uuid(102),companyA,suspended,'inactive'],[uuid(103),closedCompany,outsider,'active']
  ]) await db.query('INSERT INTO public.company_members VALUES($1,$2,$3,$4)',[id,company,user,status]);
  for(const [id,company] of [[manualA,companyA],[manualB,companyB],[manualClosed,closedCompany]])
    await db.query('INSERT INTO public.company_manuals(id,company_id,content_sha256)VALUES($1,$2,$3)',[id,company,sha]);
  await db.exec(remediation);
  return db;
}
async function as(db,role,user,company=companyA,hash=sha,excluded=null) {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[user||'']);
  await db.exec('SET ROLE '+role);
  try {return (await db.query(lookup,[company,hash,excluded])).rows[0];}
  finally {await db.exec('RESET ROLE');}
}

test('anon lacks function execution and absent auth identity never reaches metadata',async()=>{
 const db=await fixture();
 try {
  const grants=await db.query("SELECT has_function_privilege('anon','public.pooldocai_check_manual_duplicate(uuid,text,uuid)','EXECUTE') anon,has_function_privilege('authenticated','public.pooldocai_check_manual_duplicate(uuid,text,uuid)','EXECUTE') member_role");
  assert.equal(grants.rows[0].anon,false);
  assert.equal(grants.rows[0].member_role,true);
  await assert.rejects(as(db,'anon',null),/permission denied/i);
  await assert.rejects(as(db,'authenticated',null),/Tenant manual access denied/i);
 } finally {await db.close();}
});

test('same-company match works and cross-company fields are always withheld',async()=>{
 const db=await fixture();
 try {
  const a=await as(db,'authenticated',ownerA,companyA);
  assert.equal(a.is_same_company_duplicate,true);
  assert.equal(a.existing_manual_id,manualA);
  assert.equal(a.has_cross_company_match,false);
  assert.equal(a.cross_company_match_count,0);
  const b=await as(db,'authenticated',ownerB,companyB);
  assert.equal(b.existing_manual_id,manualB);
  assert.equal(b.has_cross_company_match,false);
  assert.equal(b.cross_company_match_count,0);
  const notThere=await as(db,'authenticated',ownerA,companyA,'c'.repeat(64));
  assert.deepEqual(notThere,{is_same_company_duplicate:false,existing_manual_id:null,has_cross_company_match:false,cross_company_match_count:0});
 } finally {await db.close();}
});

test('wrong company ID, inactive company/member, nonmember, service role without owner identity all deny',async()=>{
 const db=await fixture();
 try {
  for(const [who,company] of [[ownerA,companyB],[ownerB,companyA],[outsider,companyA],
   [suspended,companyA],[outsider,closedCompany],[ownerA,null]]) {
   await assert.rejects(as(db,'authenticated',who,company),/Tenant manual access denied/i);
  }
  await assert.rejects(as(db,'service_role',null,companyA),/Tenant manual access denied/i);
 } finally {await db.close();}
});

test('self-exclusion and invalid hashes preserve old interface, with zero data changes',async()=>{
 const db=await fixture();
 try {
  const excluded=await as(db,'authenticated',ownerA,companyA,sha,manualA);
  assert.equal(excluded.is_same_company_duplicate,false);
  assert.equal(excluded.existing_manual_id,null);
  const short=await as(db,'authenticated',ownerA,companyA,'abc');
  assert.equal(short.is_same_company_duplicate,false);
  const missing=await as(db,'authenticated',ownerA,companyA,null);
  assert.equal(missing.has_cross_company_match,false);
  const count=(await db.query('SELECT count(*)::integer n FROM public.company_manuals')).rows[0].n;
  assert.equal(count,3);
 } finally {await db.close();}
});
