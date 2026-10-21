/* PoolDocAI shared UI helpers. Does not replace server-side authorization. */
(()=>{'use strict';
const rawPath=location.pathname.split('/').pop()||'';
const path=(rawPath.replace(/\.html$/i,'')||'index');
const appPages=new Set(['admin','learning-review','technician','app']);
if(appPages.has(path)){
 const nav=document.createElement('nav');nav.setAttribute('aria-label','PoolDocAI application navigation');
 nav.style.cssText='display:flex;flex-wrap:wrap;gap:.6rem;align-items:center;padding:10px 14px;background:#101827;border-bottom:1px solid #34445c;position:sticky;top:0;z-index:1000';
 const links=[['Back to Main Office','/admin'],['Troubleshooter','/app'],['Technician Field Notes','/technician'],['Learning Review','/learning-review']];
 for(const [label,href] of links){const a=document.createElement('a');a.href=href;a.textContent=label;a.style.cssText='display:inline-block;padding:9px 12px;border-radius:8px;background:#24364b;color:#f1f5fb;font-weight:650;text-decoration:none';if(href===location.pathname || href.replace(/^\//,'')===path)a.setAttribute('aria-current','page');nav.append(a)}
 document.body.prepend(nav);
}
if(['pricing.html','how-it-works.html'].includes(path)){const trust=document.createElement('section');trust.setAttribute('aria-label','Trust and data privacy');trust.style.cssText='margin:24px auto;padding:20px;max-width:1100px;border:1px solid #9fb4c6;border-radius:14px;background:#f1f7fb;color:#102a40';trust.innerHTML='<h2 style="font-size:1.35rem;font-weight:800;margin:0 0 8px">Trust, privacy &amp; human-reviewed knowledge</h2><p style="margin:0 0 12px">Company manuals remain private references for that company. Shared-learning contribution is a separate choice, and troubleshooting lessons require platform-owner approval before entering shared retrieval. Approved lessons do not automatically train or fine-tune a model.</p><p style="margin:0"><strong>Pro / Enterprise direction:</strong> team roles, private company manuals, technician case handoff, and controlled learning-review workflows. Availability and pricing must be confirmed before purchase.</p>';document.body.append(trust)}
window.PoolDocAIUI=Object.freeze({
 notify(message,kind='info'){let el=document.getElementById('pooldocai-global-notice');if(!el){el=document.createElement('div');el.id='pooldocai-global-notice';el.setAttribute('role','status');el.style.cssText='position:fixed;bottom:12px;left:12px;right:12px;z-index:2000;padding:12px;border-radius:10px;background:#14283a;color:#fff;border:2px solid #67d4c0';document.body.append(el)}el.textContent=String(message);el.dataset.kind=kind;el.hidden=false},
 escape(value){const d=document.createElement('div');d.textContent=String(value??'');return d.innerHTML}
});
})();
