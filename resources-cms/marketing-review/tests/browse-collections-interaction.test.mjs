import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {URL} from 'node:url';

const source=readFileSync(new URL('../resource-reading.js',import.meta.url),'utf8');
function simulate({pathname='/resources/',search='',hash='',hasLink=true,hasSection=true}){
  let scroll=0,focus=0,prevented=0,replaced=0;
  const section={id:'',setAttribute(name,val){this[name]=val},scrollIntoView(){scroll++},focus(){focus++}};
  const link={href:'',dataset:{},addEventListener(name,fn){if(name==='click')this.clickHandler=fn}};
  const nav={querySelector(){return hasLink?link:null},append(x){this.added=x;}};
  const url=new URL('https://preview.pooldocai.local'+pathname+search+hash);
  const location={href:url.href,pathname:url.pathname,hash:url.hash};
  const ctx={URL,location,history:{state:null,pushState(_,__,href){replaced++;location.hash=new URL(href,'https://preview.pooldocai.local').hash}},window:{},requestAnimationFrame:cb=>cb(),document:{querySelector(selector){if(selector==='.article-main'||selector==='.article-header')return null;if(selector==='.pd-collection-section')return hasSection?section:null;return nav;},querySelectorAll(selector){return selector==='a.pd-collections-link'&&hasLink?[link]:[]},createElement(){return {className:'',href:'',textContent:'',dataset:{}}}}};
  vm.runInNewContext(source,ctx);
  return {link,section,nav,location,invoke(){link.clickHandler?.({preventDefault(){prevented++}})},stats(){return{scroll,focus,prevented,replaced}}};
}
test('Browse collections from Resources points to visibly anchored Explore list',()=>{
 const x=simulate({});assert.equal(x.link.href,'/resources/?path=explore-resources#collections');x.invoke();assert.equal(x.stats().prevented,0);
});
test('anchor landing reveals, scrolls and focuses published cards',()=>{
 const x=simulate({search:'?path=explore-resources',hash:'#collections'});assert.equal(x.section.id,'collections');assert.equal(x.stats().scroll,1);assert.equal(x.stats().focus,1);
});
test('repeat click within Explore always reveals collections',()=>{
 const x=simulate({search:'?path=explore-resources'});x.invoke();assert.equal(x.stats().prevented,1);assert.equal(x.stats().scroll,1);assert.equal(x.stats().focus,1);assert.equal(x.location.hash,'#collections');x.invoke();assert.equal(x.stats().scroll,2);
});
test('missing collection section does not claim success',()=>{
 const x=simulate({search:'?path=explore-resources',hasSection:false});x.invoke();assert.equal(x.stats().prevented,0);assert.equal(x.stats().scroll,0);
});
