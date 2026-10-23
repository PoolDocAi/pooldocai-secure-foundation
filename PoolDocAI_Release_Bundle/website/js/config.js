// PoolDocAI public browser configuration.
// Defense-in-depth: Prevents preview / staging domains from silently connecting to production.
(function () {
  'use strict';
  const hostname = (typeof window !== 'undefined' && window.location && window.location.hostname) ? window.location.hostname : '';
  const isPreviewHost = hostname.endsWith('.vercel.app') || hostname.startsWith('staging.') || hostname === 'staging.pooldocai.com';

  let supabaseUrl = "https://owfeebydlyacssqpnmkq.supabase.co";
  let publicAnonKey = "sb_publishable_bdDNiZDoKWyhwqSp_ptj2Q_lkOd9w5-";

  if (isPreviewHost) {
    // If running on a preview or staging host, verify whether an explicit staging config has been injected.
    // If still pointing to production project (owfeebydlyacssqpnmkq), FAIL CLOSED immediately.
    if (supabaseUrl.includes('owfeebydlyacssqpnmkq')) {
      console.error('[SECURITY HALT] Preview environment detected without isolated staging credentials. Connection to production Supabase is strictly blocked.');
      supabaseUrl = null;
      publicAnonKey = null;
    }
  }

  window.POOLDOCAI_CONFIG = Object.freeze({
    supabaseUrl: supabaseUrl,
    publicAnonKey: publicAnonKey,
    environment: isPreviewHost ? 'preview' : 'production'
  });
})();
