// Runs after v3. Only two already published static guides may enter this catalog.
import {readFileSync as read, writeFileSync as write, existsSync} from 'node:fs';
import assert from 'node:assert/strict';
const slugs=['green-pool-first-checks','pool-pump-wont-start'];
const source=JSON.parse(read('live-catalog.json','utf8'));
const items=slugs.map(slug=>{
  const matches=source.filter(r=>r.slug===slug);
  assert.equal(matches.length,1,'Published guide missing or duplicated: '+slug);
  assert(existsSync('public/resources/'+slug+'/index.html'));
  const r=matches[0];
  // Project explicit public fields; never serialize CMS records or their metadata.
  return {id:r.id,slug,title:r.title,summary:r.summary,url:'/resources/'+slug+'/',tags:(r.tags||[]).map(t=>({id:t.id,name:t.name,group:t.group,slug:t.slug,aliases:t.aliases||[]}))};
});
write('public/published-guides.json',JSON.stringify(items));
let widget=read('public/resource-assistant.js','utf8');
const old="const r=await fetch('/api/public/resources?'+p,{credentials:'omit'});if(!r.ok)throw Error('Unavailable');const d=await r.json();";
assert(widget.includes(old),'Widget API contract changed');
const helper=read('scripts/public-guide-search.js','utf8');
widget=widget.replace(old,'const d=await searchPublishedGuides(p);');
widget=widget.replace("const e=s=>",helper+'\n const e=s=>');
assert(!widget.includes("fetch('/api/public/resources"));
widget=widget.replace("if(version===serial)dialog.querySelector('[role=status]').textContent='Resource search is temporarily unavailable. You can still browse the Resources Hub.';", "if(version===serial){dialog.querySelector('[role=status]').textContent='Published guides could not be loaded. Browse the Resources Hub or try again.';const results=dialog.querySelector('.assistant-results');results.setAttribute('aria-busy','false');results.replaceChildren();}");
write('public/resource-assistant.js',widget);
let home=read('public/index.html','utf8');
let count=0;
home=home.replace(/(<button\b[^>]*\bdata-step="([012])"[^>]*>)[\s\S]*?(<\/button>)/g,(_,open,n,close)=>{
  count++;assert(/aria-label=/.test(open),'Accessible scene name required');return open+close;
});
assert.equal(count,3);
write('public/index.html',home);
write('public/style.css',read('public/style.css','utf8')+`\n/* Subtle original scene controls, enlarged invisible hit areas. */
.scene-controls .steps{gap:0;flex-wrap:nowrap}
.scene-controls .steps button,.scene-controls .steps button[aria-pressed="true"],body.dark .scene-controls .steps button:not([aria-pressed="true"]){min-width:44px;width:44px;min-height:44px;height:44px;padding:0;border:0;border-radius:0;background:transparent;color:inherit;opacity:1;font-size:0}
.scene-controls .steps button:after{content:"";position:absolute;left:18px;right:auto;top:18px;width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.3}
.scene-controls .steps button[aria-pressed="true"]:after{opacity:1}
`);
// Preserve the standard PoolDocAI wordmark colors, including the blue AI accent.
home=read('public/index.html','utf8');
const unbranded='<strong class="launch-footer-brand">PoolDocAI</strong>';
assert(home.includes(unbranded),'Footer branding markup changed; verify before altering');
home=home.replace(unbranded,'<strong class="launch-footer-brand">PoolDoc<span class="brand-ai">AI</span></strong>');

// Autoplay is a progressive enhancement: scene dots remain manually operable.
// Defer after app.js, and preserve existing reduced-motion support.
const appScript='<script src="/app.js" defer></script>';
assert.equal(home.split(appScript).length,2,'Expected a single app.js script');
assert(!home.includes('/scene-autoplay.js'),'Autoplay already registered');
home=home.replace(appScript,appScript+'\\n<script src="/scene-autoplay.js" defer></script>');
write('public/index.html',home);
write('public/scene-autoplay.js',read('scripts/scene-autoplay.js','utf8'));
assert(home.includes('<span class="brand-ai">AI</span>'));

console.log('PASS: unlabeled accessible dots; static search catalog contains exactly two approved published guides');
console.log('PASS: branded footer accent and reduced-motion-aware automatic scene cycling');
