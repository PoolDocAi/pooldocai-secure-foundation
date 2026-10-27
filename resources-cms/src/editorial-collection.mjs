import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { marked } from 'marked';
import { validateContent } from './content.mjs';
import { transaction, revision, audit, uid, now } from './store.mjs';

export function collectionSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS editorial_holds(article_id TEXT PRIMARY KEY,resource_number TEXT NOT NULL,source_checksum TEXT NOT NULL,reason TEXT NOT NULL)`);
}
export function assertEditorialRelease(db, id) {
  const hold = db.prepare('SELECT reason FROM editorial_holds WHERE article_id=?').get(id);
  if (hold) throw Object.assign(new Error('Editorial release blocked: '+hold.reason), {status:422});
}
function parse(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw Error('Manuscript front matter required');
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^([a-z_]+):\s*(.*)$/);
    if (item) metadata[item[1]] = item[2].replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return {metadata, markdown:match[2]};
}
export function reconcileCollection(db, actor, directory) {
  if (!db.prepare("SELECT 1 FROM users WHERE id=? AND role='owner' AND active=1").get(actor)) throw Error('Active owner required');
  collectionSchema(db);
  const handoff = JSON.parse(readFileSync(join(directory,'PUBLICATION_HANDOFF.json'),'utf8'));
  const allowed = new Set(handoff.resource_ids);
  if(allowed.has('30')) throw Error('Resource 30 is permanently excluded');
  const report = [];
  transaction(db, () => {
    const checklist=db.prepare("SELECT * FROM articles WHERE slug='pool-equipment-pre-service-checklist'").get();
    if (!checklist) throw Error('Preserved Resource 13 companion revision required');
    const pdfChecksum=createHash('sha256').update(readFileSync(join(directory,'Resource_13_Pre_Service_Checklist_approved.pdf'))).digest('hex');
    if(pdfChecksum!=='b5daca819553adedcd087732d1a6fab42702add1d2cf52875d48f2f0750ab5d7') throw Error('Resource 13 PDF checksum mismatch');
    db.prepare('INSERT OR IGNORE INTO editorial_holds VALUES(?,?,?,?)').run(checklist.id,'13',pdfChecksum,'PDF delivery remains gated; publication authorization absent');
    report.push({number:'13',slug:checklist.slug,result:'existing-companion-preserved',checksum:pdfChecksum});
    for (const file of readdirSync(directory).filter(f=>/^Resource_\d+_.*_approved\.md$/.test(f)).sort()) {
      const number = file.match(/^Resource_(\d+)/)[1];
      if(number==='30') throw Error('Resource 30 is permanently excluded');
      if (!allowed.has(number)) throw Error('Resource absent from approval handoff: '+number);
      const raw = readFileSync(join(directory,file),'utf8');
      const checksum = createHash('sha256').update(raw).digest('hex');
      const {metadata:m,markdown} = parse(raw);
      const canonical = m.canonical_url || m.slug || handoff['resource_'+number]?.canonical_url;
      if (!canonical) throw Error('Missing approved canonical URL: '+file);
      const slug = canonical.replace(/^https:\/\/pooldocai.com/,'').replace(/^\/resources\//,'').replace(/\/$/,'');
      const existing = db.prepare("SELECT * FROM articles WHERE slug=? OR json_extract(data,'$.slug')=?").get(slug,slug);
      const priorHold = existing && db.prepare('SELECT source_checksum FROM editorial_holds WHERE article_id=?').get(existing.id);
      const latestImport=existing&&db.prepare("SELECT detail FROM audit WHERE resource_id=? AND action='approved_v29_protected_import' ORDER BY rowid DESC LIMIT 1").get(existing.id);
      if(latestImport&&JSON.parse(latestImport.detail).checksum===checksum){report.push({number,slug,result:'unchanged',checksum});continue;}
      if (priorHold?.source_checksum===checksum) { report.push({number,slug,result:'unchanged',checksum}); continue; }
      // Existing six-resource approval history remains untouched. A changed
      // manuscript is surfaced for review rather than silently replacing it.
      const revisedV31=directory.endsWith('approved-v31')&&['07','08'].includes(number)&&priorHold?.source_checksum===createHash('sha256').update(readFileSync(join(directory,'..','approved-v29',file))).digest('hex');
      if (existing && !existing.published && !revisedV31) {
        const previousFile=join(directory,'..','approved-resources-2026-10-26',file);
        if(createHash('sha256').update(readFileSync(previousFile)).digest('hex')!==checksum) throw Error('Existing approved manuscript changed; explicit reconciliation required: '+file);
        report.push({number,slug,result:'existing-preserved-source-parity-verified',checksum});
        db.prepare('INSERT OR IGNORE INTO editorial_holds VALUES(?,?,?,?)').run(existing.id,number,checksum,'v29 editorial approval does not authorize publication; asset/link review pending'); continue; }
      const categoryName = /troubleshoot/i.test(m.category||'') ? 'Troubleshooting Tips' : /professional/i.test(m.category||'') ? 'For Pool Professionals' : /checklist|download/i.test(m.category||'') ? 'Checklists & Downloads' : /how.to|equipment/i.test(m.category||'') ? 'How-To Guides' : 'Articles & Insights';
      const category = db.prepare("SELECT id FROM taxonomy WHERE name=? AND kind='category'").get(categoryName);
      const title = m.title || markdown.match(/^# (.+)$/m)?.[1];
      const summary = (m.meta_description || m.description || markdown.split(/\n\s*\n/).find(p=>!/^\s*[#|<!-]/.test(p)) || title).replace(/[*_`]/g,'').slice(0,500);
      const content = validateContent(db,{title,slug,summary,body:marked.parse(markdown.replace(/^# .+\n/,'')),categoryId:category.id,tagIds:[],audience:/technician|professional/i.test(m.audience||'')?'both':'homeowners',sources:[...new Set(raw.match(/https:\/\/[^\s)>"\]]+/g)||[])].map(url=>({url,label:'Approved manuscript reference'})),seo:{title:m.seo_title||title,description:m.meta_description||'',canonical:directory.endsWith('approved-v31')?(canonical.startsWith('https://')?canonical:'https://pooldocai.com'+canonical):'https://pooldocai.com/resources/'+slug+'/',noindex:true}});
      const id = existing?.id || uid(), timestamp=now();
      if (existing) db.prepare("UPDATE articles SET data=?,status='draft',scheduled_at=NULL,version=version+1,updated_at=? WHERE id=?").run(JSON.stringify(content),timestamp,id);
      else db.prepare("INSERT INTO articles(id,slug,status,data,published,version,created_at,updated_at) VALUES(?,?,'draft',?,NULL,1,?,?)").run(id,slug,JSON.stringify(content),timestamp,timestamp);
      revision(db,db.prepare('SELECT * FROM articles WHERE id=?').get(id),actor,'approved_v29_protected_import');
      audit(db,actor,'approved_v29_protected_import',id,{number,file,checksum,publicationApproval:false,knowledgeApproval:false});
      db.prepare('INSERT OR IGNORE INTO editorial_holds VALUES(?,?,?,?)').run(id,number,checksum,'Editorial approval does not authorize publication; asset/link review pending');
      report.push({number,slug,result:existing?'draft-revision-live-snapshot-preserved':'created',checksum});
    }
  });
  return {approvedResourceCount:allowed.size,manuscripts:report.length,resources:report,publicationAuthorized:false,knowledgeAuthorized:false};
}
