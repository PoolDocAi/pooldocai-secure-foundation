// Protected marketing Preview: preserve the original landing page / rolling scenes.
// Apply only the explicitly requested Resources navigation adjustments.
// Source index.html, app.js, day/night images and original stylesheet remain untouched.
const resourceHeader=/<nav class="site-resource-nav" aria-label="Main navigation"><a href="\/resources\/"[^>]*>Resources<\/a><\/nav>/;
const resourceCard=/<section class="resource-link-section"[\s\S]*?<\/section>/;
const previewNotice=/<aside class="preview-notice">[\s\S]*?<\/aside>/;
const footerMarker="<footer><span>©";
const footerLink='<footer><a class="footer-resource-link" href="/resources/" data-analytics-id="site.footer.resources" data-analytics-event="nav_section_select">Resources <span aria-hidden="true">↗</span></a><span>©';
export const footerLinkCSS="\n/* One unobtrusive Resources link, lower-left; original scenery unchanged. */\n.footer-resource-link{display:inline-flex;align-items:center;gap:5px;min-height:44px;color:inherit;font-size:12px;font-weight:700;text-decoration:underline;text-underline-offset:3px}.footer-resource-link:hover{text-decoration-thickness:2px}.footer-resource-link:focus-visible{outline:3px solid #087fab;outline-offset:3px;border-radius:4px}\n";
export function restoreHomepage(html,css){
 if(typeof html!=="string"||typeof css!=="string")throw Error("Original marketing source required");
 for(const [name,pattern]of [["top Resources nav",resourceHeader],["duplicate Resources card",resourceCard],["review banner",previewNotice]]){
  if(!pattern.test(html))throw Error("Unexpected homepage baseline: "+name);
 }
 if(!html.includes(footerMarker)||!html.includes('class="scenery"')||!html.includes('id="day"')||!html.includes('id="night"')||!html.includes('/app.js'))throw Error("Original rolling-background homepage must be preserved");
 const out=html.replace(resourceHeader,"").replace(resourceCard,"").replace(previewNotice,"").replace(footerMarker,footerLink);
 if((out.match(/href="\/resources\/"/g)||[]).length!==1)throw Error("Expected exactly one text Resources link, plus the widget");
 if(out.includes("site-resource-nav")||out.includes("resource-link-section")||out.includes("preview-notice"))throw Error("Unwanted homepage additions remain");
 if(!out.includes('/resource-platform-loader.js')||!out.includes('/assets/day-1536.webp'))throw Error("Rolling backgrounds or widget were unexpectedly removed");
 return {html:out,css:css+footerLinkCSS};
}
