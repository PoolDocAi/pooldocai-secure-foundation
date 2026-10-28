// Deliberately static: no CMS endpoint, credentials, drafts, or generated answers.
let publishedGuides;
async function searchPublishedGuides(params){
  if(!publishedGuides){
    const response=await fetch('/published-guides.json',{credentials:'same-origin'});
    if(!response.ok)throw Error('Published catalog unavailable');
    const data=await response.json();
    const allowed=['green-pool-first-checks','pool-pump-wont-start'];
    if(!Array.isArray(data)||data.length!==2||allowed.some(slug=>data.filter(r=>r.slug===slug&&r.url==='/resources/'+slug+'/').length!==1))throw Error('Invalid public catalog');
    publishedGuides=data;
  }
  const normalize=s=>String(s||'').toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9]+/g,' ').trim();
  const words=normalize(params.get('q')).split(' ').filter(Boolean);
  const tags=params.getAll('tag');
  const paths=[{id:'whats-wrong',name:"What's Wrong?"},{id:'equipment-and-guides',name:'Equipment & Guides'},{id:'explore-resources',name:'Explore Resources'}];
  const path=params.get('path');
  const filtered=publishedGuides.filter(r=>{
    const haystack=normalize([r.title,r.summary,r.slug,...r.tags.flatMap(t=>[t.name,t.slug,...t.aliases])].join(' '));
    return (!path||paths.some(p=>p.id===path))&&!params.get('folder')&&words.every(w=>haystack.includes(w))&&tags.every(id=>r.tags.some(t=>t.id===id));
  });
  const facets=[...new Map(publishedGuides.flatMap(r=>r.tags).map(t=>[t.id,t])).values()].map(t=>({...t,count:publishedGuides.filter(r=>r.tags.some(x=>x.id===t.id)).length}));
  return {items:filtered,total:filtered.length,nextOffset:null,paths,navigation:{folders:[]},facets};
}
