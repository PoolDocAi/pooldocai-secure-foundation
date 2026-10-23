// PoolDocAI public browser configuration.
// Defense-in-depth: Prevents preview / staging domains from silently connecting to production,
// and enforces client-side noindex directives on preview/staging hosts.
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

  // Preview or staging hostnames:
  // Must distinguish from the production .vercel.app domain!
  const isPreviewOrStagingHost = !isProductionDomain && (
    (hostname.endsWith('.vercel.app') && hostname !== 'pooldocai-secure-foundation.vercel.app') ||
    hostname.startsWith('staging.') ||
    hostname.includes('-staging.') ||
    hostname.includes('.staging.')
  );

  let supabaseUrl = "https://owfeebydlyacssqpnmkq.supabase.co";
  let publicAnonKey = "sb_publishable_bdDNiZDoKWyhwqSp_ptj2Q_lkOd9w5-";

  if (isPreviewOrStagingHost) {
    // Defense-in-depth: If on a preview/staging host, dynamically ensure noindex meta tag is present on the document
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

    // Fail-closed guard: Staging/preview host MUST NOT connect to production Supabase
    if (supabaseUrl && supabaseUrl.includes('owfeebydlyacssqpnmkq')) {
      console.error('[SECURITY HALT] Preview environment detected without isolated staging credentials. Connection to production Supabase is strictly blocked.');
      supabaseUrl = null;
      publicAnonKey = null;
    }
  }

  window.POOLDOCAI_CONFIG = Object.freeze({
    supabaseUrl: supabaseUrl,
    publicAnonKey: publicAnonKey,
    environment: isPreviewOrStagingHost ? 'preview' : 'production',
    isProductionDomain: isProductionDomain,
    isPreviewHost: isPreviewOrStagingHost
  });
})();
