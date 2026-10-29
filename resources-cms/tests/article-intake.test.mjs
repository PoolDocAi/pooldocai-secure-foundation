import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import { parseArticleFile, docxText, articleChecksum } from '../src/production/article-intake.mjs';
import { reviewArticle } from '../src/production/editorial-review.mjs';
import { compatibilityRoute } from '../src/production/compat-api.mjs';

const categoryId='00000000-0000-4000-8000-000000000003',id='00000000-0000-4000-8000-000000000002';
const input=(name,text)=>({name,base64:Buffer.from(text).toString('base64'),categoryId});
const article={title:'Synthetic guide',slug:'synthetic-guide',categoryId,body:'<p>Private synthetic article text.</p>',sources:[],seo:{}};
// Minimal synthetic ZIP, never a substitute for the private source collection.
export function syntheticDocx(xml,method=8) {
  let offset=0;const files=[],directory=[];
  for(const [name,text] of [['[Content_Types].xml','<Types/>'],['word/document.xml',xml]]) {
    const bytes=Buffer.from(text),packed=method===8?deflateRawSync(bytes):bytes,n=Buffer.from(name),local=Buffer.alloc(30),central=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(method,8);local.writeUInt32LE(crc32(bytes),14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(n.length,26);
    central.writeUInt32LE(0x02014b50);central.writeUInt16LE(method,10);central.writeUInt32LE(crc32(bytes),16);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(n.length,28);central.writeUInt32LE(offset,42);
    files.push(local,n,packed);directory.push(central,n);offset+=30+n.length+packed.length;
  }
  const end=Buffer.alloc(22),dir=Buffer.concat(directory);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(2,8);end.writeUInt16LE(2,10);end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...files,dir,end]);
}
const xml='<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>Synthetic title &amp; scope</w:t></w:r></w:p><w:p><w:r><w:t>Text only, no private sources.</w:t></w:r></w:p></w:body></w:document>';

test('TXT and Markdown create normalized sanitized article payloads without approval fields',()=>{
  const txt=parseArticleFile(input('test.txt','Synthetic title\n\n<script>alert(1)</script>'));
  assert.match(txt.article.body,/&lt;script&gt;/);assert.equal(txt.article.categoryId,categoryId);
  assert.equal(txt.article.summary,'');assert.equal(txt.source.sha256.length,64);assert.equal(txt.article.approved,undefined);
  const md=parseArticleFile(input('test.MD','# Synthetic title\n\n## Heading\n\n<script>secret()</script>\n\n[bad](javascript:alert(1))'));
  assert.match(md.article.body,/<h2>Heading/);assert.doesNotMatch(md.article.body,/<script|javascript:/);
  assert.notEqual(txt.article.slug,md.article.slug);
});
test('structured JSON uses only approved structure and normalizes away release/knowledge claims',()=>{
  const result=parseArticleFile(input('test.json',JSON.stringify({format:'pooldocai-resource-v1',article:{...article,state:'published',knowledge:{approved:true}}})));
  assert.equal(result.article.state,undefined);assert.equal(result.article.knowledge,undefined);
  for(const value of [{format:'pooldocai-owner-import-v1',article},{format:'pooldocai-resource-v1',article,approved:true},article])assert.throws(()=>parseArticleFile(input('test.json',JSON.stringify(value))),/approved.*structure/);
  assert.throws(()=>parseArticleFile(input('private.json','{"private-secret":')),e=>!e.message.includes('private-secret'));
});
test('DOCX extracts main text in stored and deflated archives; never follows external resources',()=>{
  for(const method of [0,8]){
    const bytes=syntheticDocx(xml,method);assert.match(docxText(bytes),/Synthetic title & scope\n\nText only/);
    const result=parseArticleFile(input('test.docx',bytes));assert.equal(result.source.type,'docx');assert.equal(result.notices.length,1);
  }
});
test('rejects PDFs, binary, invalid encoding/base64, empty files and limits before import',()=>{
  for(const name of ['test.pdf','test.docm','test.zip','test.exe']) assert.throws(()=>parseArticleFile(input(name,'content')),/Only DOCX/);
  for(const data of [input('test.txt',''),input('test.txt','\0binary'),input('test.txt',Buffer.from([255])),{...input('test.txt','abc'),base64:'!not-base64'},input('test.md','a'.repeat(1_048_577))])assert.throws(()=>parseArticleFile(data));
});
test('DOCX rejects malformed archives, unsafe XML fields, oversized expansion and bad directory bounds',()=>{
  for(const bytes of [Buffer.from('not zip'),syntheticDocx(xml.replace('<w:body>','<!DOCTYPE x><w:body>')),syntheticDocx(xml.replace('<w:body>','<w:body><w:instrText>external</w:instrText>')),syntheticDocx(xml.replace('Text only, no private sources.','a'.repeat(2_000_001)))])assert.throws(()=>docxText(bytes));
  const malformed=syntheticDocx(xml);malformed.writeUInt32LE(0xffffffff,malformed.length-6);assert.throws(()=>docxText(malformed));
});
test('review supplies evidence and fixes for all six areas with explicit unverified claims',()=>{
  const row={id,version:4,editable:{...article,body:'<p>TODO: Mix chlorine with acid. Bypass safety interlock. Repair at 20 psi.</p>',sources:[{label:'Manual',url:'https://example.test/manual'}]}};
  const report=reviewArticle(row,[{id:'peer',editable:row.editable}]);
  for(const area of ['editorial','technical','safety','sources','SEO','duplicate']) assert.ok(report.findings.some(f=>f.area===area),area);
  assert.ok(report.findings.every(f=>f.evidence&&f.suggestion));assert.equal(report.version,4);assert.equal(report.checksum,articleChecksum(row.editable));
  assert.equal(report.approvalGranted,false);assert.equal(report.publicationGranted,false);assert.equal(report.diagnosticKnowledgeGranted,false);
  assert.match(report.coverage.sources,/not externally verified/);
  assert.notEqual(reviewArticle({...row,editable:{...row.editable,title:'Changed'}}).checksum,report.checksum);
});

function fixture(role='owner') {
  const rows=new Map(),commands=[];
  const db={command:async(_user,id,version,action,payload)=>{commands.push(action);const row={id,version:1,state:'draft',editable:payload};rows.set(id,row);return row;},read:async(_u,id)=>rows.get(id),list:async()=>[...rows.values()]};
  const route=compatibilityRoute({db,identity:async()=>({id:'synthetic-user'}),memberRole:async()=>role,origin:'https://cms.test'});
  const request=(path,payload,headers={})=>route(new Request('https://cms.test'+path,{method:'POST',headers:{origin:'https://cms.test',cookie:'__Host-pooldocai-cms-csrf=synthetic-csrf','x-csrf-token':'synthetic-csrf','content-type':'application/json',...headers},body:typeof payload==='string'?payload:JSON.stringify(payload)}));
  return {rows,commands,request};
}
test('file upload creates exactly one draft command, returns review and never invokes approval/KB/publication',async()=>{
  const f=fixture('editor'),response=await f.request('/api/article-upload',input('article.md','# Synthetic upload\n\nPrivate only.'));
  assert.equal(response.status,201);const data=await response.json();assert.equal(data.article.status,'draft');assert.equal(data.review.version,1);assert.deepEqual(f.commands,['create']);
  const review=await f.request(`/api/content/${data.article.id}/automated-review`,{version:1});assert.equal(review.status,200);assert.equal(review.headers.get('cache-control'),'no-store');assert.deepEqual(f.commands,['create']);
  assert.equal((await f.request(`/api/content/${data.article.id}/automated-review`,{version:0})).status,409);
});
test('upload denies viewers/reviewers, wrong origin, missing CSRF; malformed JSON never echoes private input',async()=>{
  for(const role of ['viewer','reviewer']){const f=fixture(role);assert.equal((await f.request('/api/article-upload',input('test.txt','Private'))).status,403);assert.deepEqual(f.commands,[]);}
  const f=fixture();
  for(const headers of [{origin:'https://evil.test'},{'x-csrf-token':''}])assert.equal((await f.request('/api/article-upload',input('test.txt','Private'),headers)).status,403);
  const bad=await f.request('/api/article-upload','{"private-manuscript-secret":');assert.equal(bad.status,422);assert.doesNotMatch(await bad.text(),/manuscript-secret/);
  assert.equal((await f.request('/api/article-upload',input('test.pdf','private'))).status,422);assert.deepEqual(f.commands,[]);
});
test('review is private, version bound, not found fails closed, oversized request is rejected',async()=>{
  const f=fixture();assert.equal((await f.request(`/api/content/${id}/automated-review`,{version:1})).status,404);
  const response=await f.request('/api/article-upload',' '.repeat(1_450_001));assert.equal(response.status,413);assert.deepEqual(f.commands,[]);
});
