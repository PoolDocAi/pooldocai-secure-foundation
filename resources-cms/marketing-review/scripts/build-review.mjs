import {publicNavigation,addNavigationBreadcrumbs} from '../src/platform/navigation.mjs';
import {readFileSync,writeFileSync,mkdirSync,cpSync} from 'node:fs';
import {addLegalFooter} from './footer-navigation.mjs';
if(process.env.VERCEL_ENV&&process.env.VERCEL_ENV!=='preview')throw Error('This source is a protected Preview only; Production build refused');
const navState=JSON.parse(readFileSync('review-navigation.json','utf8')),catalog=JSON.parse(readFileSync('live-catalog.json','utf8'));
mkdirSync('public',{recursive:true});for(const f of ['index.html','style.css','app.js','consent.js','logo.svg','resource-analytics.js','resource-assistant.js','resource-platform-flags.js','resource-platform-loader.js','review-adapter.js','platform.css','resource-design.css','resource-reading.js','legal-footer.css','privacy.html','terms.html'])cpSync(f,'public/'+f);
writeFileSync('public/index.html',addLegalFooter(readFileSync('public/index.html','utf8')));
cpSync('assets','public/assets',{recursive:true});cpSync('resources','public/resources',{recursive:true});
for(const slug of ['pool-pump-wont-start','green-pool-first-checks']){const out='public/resources/'+slug;mkdirSync(out,{recursive:true});let html=readFileSync('review-pages/'+slug+'/index.html','utf8');html=addNavigationBreadcrumbs(html,publicNavigation(navState,catalog),catalog.find(r=>r.slug===slug));html=html.replace(/<head[^>]*>/i,head=>head+'<link rel="stylesheet" href="/resource-design.css"><script src="/resource-platform-flags.js" defer></script><script src="/review-adapter.js" defer></script><script src="/resource-platform-loader.js" defer></script>');html=html.replace('</body>','<script src="/resource-reading.js" defer></script></body>');writeFileSync(out+'/index.html',addLegalFooter(html));}
writeFileSync('public/robots.txt','User-agent: *\nDisallow: /\n');
