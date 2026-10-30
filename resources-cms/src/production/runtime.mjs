import { SupabaseDataCMS } from "./supabase-data.mjs";
let singleton;

export function readRuntimeConfig(env = process.env) {
  if(env.CMS_DATABASE_URL || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY) throw Error('Privileged CMS credentials are forbidden');
  const required = ["SUPABASE_URL","SUPABASE_PUBLISHABLE_KEY","CMS_ORIGIN"];
  for (const key of required) if (!env[key]) throw new Error(`Missing required environment variable: ${key}`);
  if(env.SUPABASE_PUBLISHABLE_KEY.startsWith('sb_secret_')) throw Error('Publishable key required');
  try {if(JSON.parse(Buffer.from(env.SUPABASE_PUBLISHABLE_KEY.split('.')[1]||'', 'base64url')).role==='service_role')throw Error('Publishable key required');}catch(error){if(error.message==='Publishable key required')throw error;}
  // Folder navigation needs the separately reviewed discovery/catalog RPCs.
  // Never enable folders while public catalog discovery is disabled.
  if (env.CMS_FOLDERS_ENABLED === '1' && env.CMS_DISCOVERY_V3 !== '1') {
    throw new Error('CMS_FOLDERS_ENABLED requires CMS_DISCOVERY_V3 and verified public catalog readiness');
  }
  const origin = new URL(env.CMS_ORIGIN).origin;
  if (origin !== env.CMS_ORIGIN || !origin.startsWith("https://")) throw new Error("CMS_ORIGIN must be an exact HTTPS origin");
  return {
    supabaseUrl: env.SUPABASE_URL,
    publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
    origin,
    features:{folders:env.CMS_FOLDERS_ENABLED==='1',taxonomy:env.CMS_TAXONOMY_V3==='1',discovery:env.CMS_DISCOVERY_V3==='1',analytics:env.CMS_ANALYTICS_ENABLED==='1',assistant:env.CMS_ASSISTANT_ENABLED==='1'},
    requireMfa: env.CMS_REQUIRE_TOTP_MFA === '1',
    mfaEnrollmentEnabled: env.CMS_MFA_ENROLLMENT_ENABLED === '1',
    ownerPublishing: env.CMS_OWNER_PUBLISHING === "1",
    approvedImportCatalogPath: env.CMS_APPROVED_IMPORT_CATALOG || null,
    recoveryOwnerId: env.CMS_RECOVERY_OWNER_ID,
    recoveryOwnerEmail: env.CMS_RECOVERY_OWNER_EMAIL,
  };
}

export function productionRuntime(env = process.env) {
  if (singleton) return singleton;
  const config = readRuntimeConfig(env);
  singleton = { config, db: new SupabaseDataCMS({ url: config.supabaseUrl, publishableKey: config.publishableKey }) };
  return singleton;
}

export function resetProductionRuntimeForTests() {
  singleton = undefined;
}
