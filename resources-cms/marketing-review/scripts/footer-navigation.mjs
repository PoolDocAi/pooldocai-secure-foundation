/**
 * Protected marketing preview footer enhancement.
 * The original homepage and articles retain every existing element and link.
 * Public-facing legal pages have no draft labels; Production legal approval is a separate release gate.
 */
export const legalLinks = Object.freeze([
 {label:'Privacy Policy',href:'/privacy.html'},
 {label:'Terms of Service',href:'/terms.html'},
 {label:'Contact',href:'mailto:hello@pooldocai.com'}
]);
export const legalFooterNav=()=>'<nav class="pd-legal-footer-links" aria-label="Legal and contact">'+
 legalLinks.map(({label,href})=>'<a href="'+href+'">'+label+'</a>').join('')+'</nav>';
export function addLegalFooter(html) {
 if(typeof html!=='string'||!/<footer\b/i.test(html)||!/<\/head>/i.test(html))throw new Error('Marketing page missing HTML head or footer');
 let out=html;
 if(!out.includes('href="/legal-footer.css"'))out=out.replace(/<\/head>/i,'<link rel="stylesheet" href="/legal-footer.css"></head>');
 if(!out.includes('class="pd-legal-footer-links"'))out=out.replace(/<\/footer>/i,legalFooterNav()+'</footer>');
 return out;
}
