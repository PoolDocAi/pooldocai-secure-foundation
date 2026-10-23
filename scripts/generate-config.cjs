const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const targetConfigPath = path.join(root, 'website', 'js', 'config.js');

const vercelEnv = process.env.VERCEL_ENV || process.env.NODE_ENV || 'development';
const isPreview = vercelEnv === 'preview' || vercelEnv === 'test' || Boolean(process.env.STAGING_MODE);
const isProduction = vercelEnv === 'production' && !process.env.STAGING_MODE;

console.log(`[generate-config] Environment: ${vercelEnv} (isPreview: ${isPreview}, isProduction: ${isProduction})`);

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
window.POOLDOCAI_CONFIG = Object.freeze({
  supabaseUrl: ${JSON.stringify(supabaseUrl)},
  publicAnonKey: ${JSON.stringify(publicAnonKey)},
  environment: ${JSON.stringify(vercelEnv)}
});
`;

fs.writeFileSync(targetConfigPath, configContent, 'utf8');
console.log(`[generate-config] Successfully generated ${targetConfigPath} pointing to ${supabaseUrl}`);
