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

console.log(`[generate-config] Environment: ${vercelEnv} (isPreview: ${isPreview}, isProduction: ${isProduction})`);

// -----------------------------------------------------------------------------
// 1. Supabase Configuration Generation & Fail-Closed Guard
// -----------------------------------------------------------------------------
let supabaseUrl = '';
let publicAnonKey = '';

if (isPreview) {
  // Staging / Vercel Preview environment:
  // Must use dedicated staging credentials. NEVER fall back silently to production Supabase!
  supabaseUrl = process.env.STAGING_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
  publicAnonKey = process.env.STAGING_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

  // Strict check: if empty or missing, fail closed!
  if (!supabaseUrl || !publicAnonKey) {
    const errorMsg = '[generate-config] FATAL: Vercel preview / staging build requires STAGING_SUPABASE_URL and STAGING_SUPABASE_ANON_KEY. Build aborted to prevent silent fallback to production.';
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  // Strict check: if pointing to production project ref, fail closed!
  if (supabaseUrl.includes('owfeebydlyacssqpnmkq')) {
    const errorMsg = '[generate-config] FATAL SECURITY VIOLATION: Staging / preview build attempted to connect to production Supabase project (owfeebydlyacssqpnmkq). Build aborted.';
    console.error(errorMsg);
    throw new Error(errorMsg);
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

  window.POOLDOCAI_CONFIG = Object.freeze({
    supabaseUrl: ${JSON.stringify(supabaseUrl)},
    publicAnonKey: ${JSON.stringify(publicAnonKey)},
    environment: ${JSON.stringify(vercelEnv)},
    isProductionDomain: isProductionDomain,
    isPreviewHost: isPreviewHost
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
