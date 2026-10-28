// Public marketing post-build verification and fixes. No CMS/Production DB actions.
import {readFileSync, writeFileSync, existsSync, mkdirSync, cpSync} from 'node:fs';
const requireFile = (path) => {if(!existsSync(path))throw Error('MISSING: '+path)};
for(const p of ['public/index.html','public/style.css','public/app.js','resourcesindex.html'])requireFile(p);
for(const name of ['day-1536.webp','day-768.webp','night-1536.webp','night-768.webp']){
  const p='public/assets/'+name;requireFile(p);
  let bytes=readFileSync(p);
  if(bytes.subarray(0,4).toString('ascii')!=='RIFF')bytes=Buffer.from(bytes.toString('ascii').trim(),'base64');
  if(bytes.subarray(0,4).toString('ascii')!=='RIFF'||bytes.subarray(8,12).toString('ascii')!=='WEBP')throw Error('Not WebP: '+name);
  writeFileSync(p,bytes);console.log('VALID WEBP '+name+' '+bytes.length+' bytes');
}
let css=readFileSync('public/style.css','utf8');
const old='.scenery{position:fixed;inset:0;z-index:-1;background:#c7e8ed}';
if(!css.includes(old))throw Error('Scenery CSS baseline changed');
css=css.replace(old,'.scenery{position:fixed;inset:0;z-index:0;pointer-events:none;background:#c7e8ed}');
const shell='.shell{max-width:1540px;';
if(!css.includes(shell))throw Error('Shell CSS baseline changed');
css=css.replace(shell,'.shell{position:relative;z-index:1;max-width:1540px;');
css+='\\n'+[
'/* Owner-approved: visibly selectable scene/tagline controls */',
'.coming{display:none!important}',
'.scene-controls{position:relative;z-index:3;pointer-events:auto}',
'.scene-controls .steps{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
'.scene-controls .steps button{appearance:none;position:relative;z-index:3;pointer-events:auto;box-sizing:border-box;min-width:88px;width:auto;min-height:44px;height:auto;padding:9px 12px;border:1px solid rgba(15,69,86,.4);border-radius:100px;background:rgba(255,255,255,.87);color:#143747;font:600 13px/1.25 Inter,Arial,sans-serif;text-align:center;opacity:1;cursor:pointer}',
'.scene-controls .steps button[aria-pressed="true"]{background:#075d79;color:white;border-color:#075d79}',
'.scene-controls .steps button:focus-visible{outline:3px solid #1e9aca;outline-offset:3px}',
'body.dark .scene-controls .steps button:not([aria-pressed="true"]){background:rgba(7,29,46,.87);color:white;border-color:#bde0e8}',
'.launch-footer{display:flex;flex-direction:column;justify-content:center;align-items:center;gap:12px;width:100%;padding:24px 12px 20px;opacity:1;text-align:center;font-size:14px}',
'.launch-footer-brand{display:block;font-size:clamp(20px,2.2vw,28px);font-weight:750;letter-spacing:-.035em;line-height:1.25}',
'.launch-footer-links{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;column-gap:clamp(16px,2.4vw,36px);row-gap:12px;width:100%;font-size:13px}',
'.launch-footer-links a,.launch-footer-links button{display:inline-flex;min-height:36px;align-items:center;justify-content:center;padding:5px 2px;margin:0;border:0;background:none;color:inherit;text-decoration:none;font:inherit;font-weight:550;line-height:1.4;cursor:pointer;opacity:1}',
'.launch-footer-links a:hover,.launch-footer-links button:hover{text-decoration:underline;text-underline-offset:3px}',
'.launch-footer-links a:focus-visible,.launch-footer-links button:focus-visible{outline:2px solid #1785a3;outline-offset:3px;border-radius:3px}',
'.launch-footer-copy{font-size:11px;opacity:.85}',
'@media(max-width:600px){.launch-footer{padding:20px 10px 24px;gap:9px}.launch-footer-links{column-gap:16px;row-gap:2px;font-size:12px}.scene-controls .steps button{min-width:80px;padding-inline:10px}}'
].join('\n');
writeFileSync('public/style.css',css);
mkdirSync('public/resources',{recursive:true});cpSync('resourcesindex.html','public/resources/index.html');
for(const p of ['resources/resources.css','resources/resources.js']){requireFile(p);cpSync(p,'public/'+p)}
let home=readFileSync('public/index.html','utf8');
let removedHeading=0;
home=home.replace(/<span\s+class="coming"[^>]*>[\s\S]*?<\/span>/i,()=>{removedHeading++;return ''});
if(removedHeading!==1||home.includes('Something smarter is on the horizon'))throw Error('Requested heading not removed');
home=home.replaceAll('For the people behind better pools.','');
const names=['Day','Pool care','Night'];
let manualCount=0;
home=home.replace(/(<button\b[^>]*\bdata-step="([012])"[^>]*>)(\s*)(<\/button>)/gi,(_all,open,n,_space,close)=>{manualCount++;return open+names[Number(n)]+close});
if(manualCount!==3)throw Error('Expected three scene-selection buttons');
const original=home.match(/<footer\b[^>]*>[\s\S]*?<\/footer>/i)?.[0];
if(!original)throw Error('Footer missing');
const privacyButton=original.match(/<button\b[^>]*\bid="privacy-button"[^>]*>[\s\S]*?<\/button>/i)?.[0];
if(!privacyButton)throw Error('Privacy choices button missing');
const adminHref='https://pooldocai-resources-cms-private-owner-review.vercel.app/admin/';
const footer=[
'<footer class="launch-footer" aria-label="Site footer">',
'<strong class="launch-footer-brand">PoolDocAI</strong>',
'<nav class="launch-footer-links" aria-label="Resources, privacy, contact and administration">',
'<a href="/resources/">Resources</a>',
'<a href="/privacy.html">Privacy Policy</a>',
'<a href="/terms.html">Terms of Service</a>',
'<a href="mailto:hello@pooldocai.com">Contact</a>',
privacyButton,
'<a href="'+adminHref+'" rel="noopener noreferrer" aria-label="Private Resources Studio admin login">Admin</a>',
'</nav>',
'<small class="launch-footer-copy">© <span id="year">2026</span> PoolDocAI</small>',
'</footer>'].join('\n');
home=home.replace(original,footer);
const links=(home.match(/<a\b[^>]*href=["']\/resources\/?["']/gi)||[]).length;
const choices=[...home.matchAll(/<button\b[^>]*\bdata-step="([012])"[^>]*>([^<]+)<\/button>/gi)];
const checks=[
  [links===1,'Exactly one Resources link required'],
  [choices.length===3,'Three readable manual scene selectors required'],
  [/<form\b/i.test(home),'Waitlist form missing'],
  [home.includes('/privacy.html')&&home.includes('/terms.html'),'Legal links missing'],
  [home.includes('mailto:hello@pooldocai.com'),'Contact link missing'],
  [home.includes(adminHref),'Private admin link missing'],
  [!/<meta\s+name=["']robots["']\s+content=["'][^"']*noindex/i.test(home),'Public build noindex'],
  [!/(href|action)=["']\/(?:demo|pricing|plans|technician|app)(?:\/|["'?])/i.test(home),'Forbidden SaaS link'],
  [existsSync('public/resources/index.html'),'Resources Hub missing'],
  [existsSync('public/resources/green-pool-first-checks/index.html'),'Green pool article missing'],
  [existsSync('public/resources/pool-pump-wont-start/index.html'),'Pump article missing'],
  [existsSync('public/sitemap.xml'),'Sitemap missing'],
  [!home.includes('rzkgmvyyeclrpomrlyft'),'Staging ID in public HTML'],
  [!home.includes('Something smarter is on the horizon'),'Removed heading found']
];
for(const [ok,msg] of checks)if(!ok)throw Error('PUBLIC LAUNCH GATE: '+msg);
writeFileSync('public/index.html',home);
console.log('PASS: playable binary scenes, manual scene buttons, centered footer, Admin link and two-guide Hub');
