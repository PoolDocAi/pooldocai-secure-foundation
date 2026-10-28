// Public-only marketing build postprocessor, with release-blocking checks.
// Never sends mail, calls Supabase, or activates CMS publication.
import {readFileSync, writeFileSync, existsSync, mkdirSync, cpSync} from 'node:fs';
const stylesheet='public/style.css';
if(!existsSync(stylesheet))throw Error('No generated marketing stylesheet');
let css=readFileSync(stylesheet,'utf8');
const old='.scenery{position:fixed;inset:0;z-index:-1;background:#c7e8ed}';
if(!css.includes(old))throw Error('Scene source changed; requires fresh review');
css=css.replace(old,'.scenery{position:fixed;inset:0;z-index:0;pointer-events:none;background:#c7e8ed}');
const shell='.shell{max-width:1540px;';
if(!css.includes(shell))throw Error('Shell source changed; requires fresh review');
css=css.replace(shell,'.shell{position:relative;z-index:1;max-width:1540px;');
css+='\n.coming{font-size:clamp(14px,1.3vw,20px)}\n';
writeFileSync(stylesheet,css);
if(!existsSync('resourcesindex.html'))throw Error('Approved static Resources Hub unavailable');
mkdirSync('public/resources',{recursive:true});
cpSync('resourcesindex.html','public/resources/index.html');
for(const a of ['resources/resources.css','resources/resources.js']) {
  if(!existsSync(a))throw Error('Resources asset missing: '+a);
  cpSync(a,'public/'+a);
}
let home=readFileSync('public/index.html','utf8');
home=home.replaceAll('For the people behind better pools.','');
const checks=[
 [home.includes('class="scenery"'),'Day/night scenery container missing'],
 [/id=["']day["']/.test(home)&&/id=["']night["']/.test(home),'Day/night images missing'],
 [/<form\b/i.test(home),'Waitlist form missing'],
 [home.includes('/resources/'),'Resources landing link missing'],
 [home.includes('hello@pooldocai.com'),'Contact mailto missing'],
 [home.includes('/privacy.html'),'Privacy link missing'],
 [home.includes('/terms.html'),'Terms link missing'],
 [!/<meta\s+name=["']robots["']\s+content=["'][^"']*noindex/i.test(home),'Public release has noindex'],
 [!/(href|action)=["']\/(demo|pricing|plans|technician|app)(?:\/|["'?])/i.test(home),'Public landing links to forbidden SaaS features'],
 [!home.includes('rzkgmvyyeclrpomrlyft'),'Private Staging ref in marketing HTML'],
 [existsSync('public/assets/day-1536.webp')&&existsSync('public/assets/night-1536.webp'),'Background assets missing'],
 [existsSync('public/resources/index.html'),'Resources Hub missing'],
 [existsSync('public/resources/green-pool-first-checks/index.html'),'First published article missing'],
 [existsSync('public/resources/pool-pump-wont-start/index.html'),'Second published article missing'],
 [existsSync('public/sitemap.xml'),'Canonical sitemap missing']
];
for(const [pass,msg] of checks)if(!pass)throw Error('PUBLIC LAUNCH GATE: '+msg);
const links=(home.match(/<a\b[^>]*href=["']\/resources\/?["']/gi)||[]).length;
if(links!==1)throw Error('Resource link duplicate on homepage: '+links);
writeFileSync('public/index.html',home);
console.log('PASS: marketing-only release candidate, backed by existing public two-article Hub; no Production CMS dependency.');
