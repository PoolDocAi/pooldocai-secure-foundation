import test from "node:test";
import assert from "node:assert/strict";
import {restoreHomepage} from "./restore-homepage.mjs";
const source=()=>'<html><head><script src="/resource-platform-loader.js" defer></script><script src="/app.js" defer></script></head><body><div class="scenery"><img id="day" src="/assets/day-1536.webp"><img id="night"></div><div class="shell"><header><nav class="site-resource-nav" aria-label="Main navigation"><a href="/resources/" data-analytics-id="site.nav.resources" data-analytics-event="nav_section_select">Resources</a></nav></header><aside class="preview-notice">Private website review <button data-preview-inspector>Inspect</button></aside><main><section class="intro">Original message</section><section class="resource-link-section" aria-labelledby="resource-link-title"><a href="/resources/" class="resource-link-card">Resources</a></section></main><footer><span>© 2026 PoolDocAI</span></footer></div></body></html>';
test("moves duplicated resources links to one lower-left footer entry, retains assistant",()=>{
 const v=restoreHomepage(source(),"body{color:#123442}");assert.equal((v.html.match(/href="\/resources\/"/g)||[]).length,1);
 assert.ok(v.html.includes('<footer><a class="footer-resource-link"'));
 assert.ok(!v.html.includes('site-resource-nav')&&!v.html.includes('resource-link-section')&&!v.html.includes('preview-notice'));
 assert.ok(v.html.includes('/resource-platform-loader.js'));
 assert.ok(v.html.includes('class="scenery"')&&v.html.includes('id="day"')&&v.html.includes('id="night"'));
 assert.ok(v.html.includes('<section class="intro">Original message</section>'));
 assert.ok(v.css.startsWith("body{color:#123442}"));assert.ok(v.css.includes(".footer-resource-link"));
});
test("fails closed if original scene or widget disappears",()=>{
 assert.throws(()=>restoreHomepage(source().replace('class="scenery"','class="missing"'),""),/rolling-background/);
 assert.throws(()=>restoreHomepage(source().replace('/resource-platform-loader.js','/missing.js'),""),/widget/);
});
test("fails closed if input baseline no longer matches expected homepage",()=>{
 assert.throws(()=>restoreHomepage(source().replace('site-resource-nav','other-nav'),""),/baseline/);
 assert.throws(()=>restoreHomepage(source().replace('resource-link-section','resource-box'),""),/baseline/);
});
