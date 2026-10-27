/* Presentation enhancement only: existing article text and metadata are untouched. */
(()=>{'use strict';const article=document.querySelector('.article-main'),header=document.querySelector('.article-header');if(article&&header&&!header.querySelector('.article-actions')){const controls=document.createElement('div');controls.className='article-actions';controls.innerHTML='<button type="button" data-copy data-analytics-id="article.link.copy" data-analytics-event="ui_button_click">Copy article link ↗</button><span role="status" aria-live="polite"></span>';header.append(controls);controls.querySelector('button').onclick=async()=>{const canonical=document.querySelector('link[rel=canonical]')?.href;if(!canonical||!/^https:\/\/pooldocai\.com\/resources\/[a-z0-9-]+\/$/.test(canonical))return;try{await navigator.clipboard.writeText(canonical);controls.querySelector('[role=status]').textContent='Canonical article link copied.';}catch{controls.querySelector('[role=status]').textContent='Copy the canonical article URL from your address bar on the public site.';}};}
})();

/* Collection navigation must reveal actual cards, not merely reload the hero.
   No additional catalog fetch is needed, and only published folders are displayed. */
(()=>{'use strict';
 const browseHref='/resources/?path=explore-resources#collections';
 const getSection=()=>document.querySelector('.pd-collection-section');
 const reveal=()=>{const section=getSection();if(!section)return false;
   section.id='collections';section.setAttribute('tabindex','-1');
   section.scrollIntoView({block:'start',behavior:'auto'});
   section.focus({preventScroll:true});return true;};
 document.querySelectorAll('a.pd-collections-link').forEach(link=>{
   link.href=browseHref;
   link.addEventListener('click',event=>{
     const url=new URL(location.href);
     if(url.pathname.replace(/\/+$/,'/')==='/resources/' &&
        url.searchParams.get('path')==='explore-resources' && getSection()){
       event.preventDefault();
       if(location.hash!=='#collections')history.pushState(history.state,'',browseHref);
       reveal();
     }
   });
 });
 if(!window.PoolDocHeaderFolders){window.PoolDocHeaderFolders=true;
   const target=document.querySelector('.pd-site-header>nav,.resource-header>nav,.site-resource-nav');
   if(target&&!target.querySelector('.pd-collections-link')){
     const link=document.createElement('a');link.className='pd-collections-link';
     link.href=browseHref;link.textContent='Browse collections';
     link.dataset.analyticsId='header.collections.open';link.dataset.analyticsEvent='discovery_path_select';
     link.dataset.pathId='explore-resources';target.append(link);
   }
 }
 if(location.hash==='#collections')requestAnimationFrame(()=>reveal());
})();
