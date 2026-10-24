const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const websiteDir = path.join(root, 'website');
const targetConfigPath = path.join(websiteDir, 'js', 'config.js');
const targetRobotsPath = path.join(websiteDir, 'robots.txt');
const targetSitemapPath = path.join(websiteDir, 'sitemap.xml');

const vercelEnv = process.env.VERCEL_ENV || process.env.NODE_ENV || 'development';
const isPreview = vercelEnv === 'preview' || vercelEnv === 'test' || Boolean(process.env.STAGING_MODE);
const isProduction = vercelEnv === 'production' && !process.env.STAGING_MODE;
let isUiOnlyPreview = false;

console.log(`[generate-config] Environment: ${vercelEnv} (isPreview: ${isPreview}, isProduction: ${isProduction})`);

// -----------------------------------------------------------------------------
// 1. Supabase Configuration Generation & Fail-Closed Guard
// -----------------------------------------------------------------------------
let supabaseUrl = '';
let publicAnonKey = '';

if (isPreview) {
  // Only dedicated staging credentials can enable a connected preview.
  // Generic SUPABASE_URL / NEXT_PUBLIC_... variables MUST NOT silently authorize
  // a preview to use an existing production project.
  const stagingUrl = String(process.env.STAGING_SUPABASE_URL || '').trim();
  const stagingKey = String(process.env.STAGING_SUPABASE_ANON_KEY || '').trim();
  if (!stagingUrl && !stagingKey) {
    // Safe UI-only preview, not a fake working backend. The build remains viewable
    // while API calls and form submission are denied by runtime + browser CSP.
    isUiOnlyPreview = true;
    supabaseUrl = 'https://pooldocai-preview-backend-disabled.invalid';
    publicAnonKey = 'preview-ui-only-no-backend';
    console.log('[generate-config] UI-only preview: no staging backend; all data requests/submissions disabled.');
  } else {
    // Partial staging configuration remains a HARD ERROR to prevent accidents.
    if (!stagingUrl || !stagingKey) {
      throw new Error('[generate-config] FATAL: Both STAGING_SUPABASE_URL and STAGING_SUPABASE_ANON_KEY are required for a connected preview.');
    }
    const prodUrl = String(process.env.PROD_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
    if (stagingUrl.includes('owfeebydlyacssqpnmkq') || (prodUrl && stagingUrl.replace(/[/]$/, '') === prodUrl.replace(/[/]$/, ''))) {
      throw new Error('[generate-config] FATAL SECURITY VIOLATION: Preview may not connect to the production Supabase project.');
    }
    supabaseUrl = stagingUrl;
    publicAnonKey = stagingKey;
  }
} else if (isProduction) {
  supabaseUrl = process.env.PROD_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://owfeebydlyacssqpnmkq.supabase.co';
  publicAnonKey = process.env.PROD_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || 'sb_publishable_bdDNiZDoKWyhwqSp_ptj2Q_lkOd9w5-';
} else {
  // Local development / testing default
  supabaseUrl = process.env.LOCAL_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
  publicAnonKey = process.env.LOCAL_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'sb_publishable_local_anon_key';
}

const configContent = `// PoolDocAI public browser configuration. Generated for environment: ${vercelEnv}
// Never place service-role, secret keys, or tokens here.
(function () {
  'use strict';
  const hostname = (typeof window !== 'undefined' && window.location && window.location.hostname) ? window.location.hostname.toLowerCase() : '';

  // Canonical production hostnames (including the project's default .vercel.app production domain)
  const isProductionDomain = 
    hostname === 'pooldocai-secure-foundation.vercel.app' ||
    hostname === 'pooldocai.com' ||
    hostname === 'www.pooldocai.com' ||
    hostname === 'pooldoc.ai' ||
    hostname === 'www.pooldoc.ai';

  const isPreviewHost = ${isPreview ? 'true' : 'false'};

  // Defense-in-depth: If on a preview/staging host, dynamically ensure noindex meta tag is present
  if (isPreviewHost || (!isProductionDomain && (hostname.endsWith('.vercel.app') || hostname.startsWith('staging.')))) {
    if (typeof document !== 'undefined' && document.head) {
      try {
        let metaRobots = document.querySelector('meta[name="robots"]');
        if (!metaRobots) {
          metaRobots = document.createElement('meta');
          metaRobots.setAttribute('name', 'robots');
          document.head.appendChild(metaRobots);
        }
        metaRobots.setAttribute('content', 'noindex,nofollow,noarchive');
      } catch (e) {
        // Non-blocking in headless / test environments
      }
    }
  }

  const isUiOnlyPreview = ${isUiOnlyPreview ? 'true' : 'false'};
  if (isUiOnlyPreview) {
    // Preview must not submit to live Supabase, Formspree, tracking endpoints,
    // or any other write-capable service. CSP also prevents native HTML forms.
    if (typeof document !== 'undefined' && document.head) {
      const csp = document.createElement('meta');
      csp.setAttribute('http-equiv', 'Content-Security-Policy');
      csp.setAttribute('content', "connect-src 'none'; form-action 'none';");
      document.head.appendChild(csp);
    }
    if (typeof window !== 'undefined') {
      window.fetch = function () {
        return Promise.reject(new Error('UI-only preview: sign-in, AI chat, and submissions are disabled until isolated staging is configured.'));
      };
      const showPreviewNotice = function () {
        if (!document.body || document.getElementById('pooldocai-ui-only-preview-notice')) return;
        const notice = document.createElement('aside');
        notice.id = 'pooldocai-ui-only-preview-notice';
        notice.setAttribute('role', 'status');
        notice.textContent = 'Interface preview only · Live sign-in, AI chat & forms disabled';
        notice.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:99999;max-width:310px;padding:8px 11px;border-radius:10px;background:#082a44;color:#e0f2fe;border:1px solid #38bdf8;box-shadow:0 5px 18px #0004;font:600 11px/1.45 system-ui,sans-serif;pointer-events:none';
        document.body.appendChild(notice);
      };
      if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showPreviewNotice, { once: true });
        else showPreviewNotice();
      }
    }
  }

  window.POOLDOCAI_CONFIG = Object.freeze({
    supabaseUrl: ${JSON.stringify(supabaseUrl)},
    publicAnonKey: ${JSON.stringify(publicAnonKey)},
    environment: ${JSON.stringify(vercelEnv)},
    isProductionDomain: isProductionDomain,
    isPreviewHost: isPreviewHost,
    previewUiOnly: isUiOnlyPreview
  });
})();
`;

fs.writeFileSync(targetConfigPath, configContent, 'utf8');
console.log(`[generate-config] Successfully generated ${targetConfigPath} pointing to ${supabaseUrl}`);

// -----------------------------------------------------------------------------
// 2. Environment-Specific robots.txt Generation
// -----------------------------------------------------------------------------
let robotsContent = '';

if (isPreview) {
  // Staging / Preview environments: strictly disallow all indexing
  robotsContent = `# PoolDocAI Staging & Preview Environment — All search crawlers disallowed
User-agent: *
Disallow: /
`;
} else {
  // Production environment: allow marketing pages, strictly disallow private/portal routes
  robotsContent = `# PoolDocAI Production Crawl Directives
User-agent: *
Allow: /
Allow: /demo
Allow: /pricing
Allow: /how-it-works
Allow: /faq
Allow: /privacy
Allow: /terms
Allow: /waitlist

# Disallow authenticated, administration, technician, and private portal routes
Disallow: /admin
Disallow: /admin.html
Disallow: /app
Disallow: /app.html
Disallow: /technician
Disallow: /technician.html
Disallow: /learning-review
Disallow: /learning-review.html
Disallow: /accept-invite
Disallow: /accept-invite.html

Sitemap: https://pooldocai-secure-foundation.vercel.app/sitemap.xml
`;
}

fs.writeFileSync(targetRobotsPath, robotsContent, 'utf8');
console.log(`[generate-config] Successfully generated ${targetRobotsPath} for ${isPreview ? 'preview' : 'production'}`);

// -----------------------------------------------------------------------------
// 3. Production sitemap.xml Generation
// -----------------------------------------------------------------------------
const sitemapContent = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://pooldocai-secure-foundation.vercel.app/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://pooldocai-secure-foundation.vercel.app/demo</loc>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>https://pooldocai-secure-foundation.vercel.app/pricing</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://pooldocai-secure-foundation.vercel.app/how-it-works</loc>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://pooldocai-secure-foundation.vercel.app/faq</loc>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://pooldocai-secure-foundation.vercel.app/waitlist</loc>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://pooldocai-secure-foundation.vercel.app/privacy</loc>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>https://pooldocai-secure-foundation.vercel.app/terms</loc>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
</urlset>
`;

fs.writeFileSync(targetSitemapPath, sitemapContent, 'utf8');
console.log(`[generate-config] Successfully generated ${targetSitemapPath}`);
