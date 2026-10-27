// Production public Resources must not be wired to a Staging CMS database.
// All project references are public identifiers, not credentials.
const REF = /^[a-z0-9]{20}$/;

export function assertPublicCMSDeliveryTarget(env) {
  if (env.VERCEL_ENV !== 'production') return;
  if (env.CMS_PUBLISHED_DELIVERY_ENABLED !== '1') {
    throw new Error('Production CMS public-delivery gate is disabled');
  }
  const expected = env.PUBLIC_RESOURCES_PRODUCTION_PROJECT_REF;
  const staging = env.PUBLIC_RESOURCES_STAGING_PROJECT_REF;
  if (!REF.test(expected || '') || !REF.test(staging || '') || expected === staging) {
    throw new Error('Separate approved Production and Staging CMS project references are required');
  }
  let actual;
  try {
    const uri = new URL(env.PUBLIC_RESOURCES_SUPABASE_URL);
    if (uri.protocol !== 'https:' || uri.origin !== env.PUBLIC_RESOURCES_SUPABASE_URL ||
        uri.username || uri.password || uri.port) throw Error('Invalid target');
    actual = uri.hostname;
  } catch {
    throw new Error('A valid exact HTTPS Production CMS Supabase URL is required');
  }
  if (actual !== `${expected}.supabase.co`) {
    throw new Error('Public Resources Production target does not match the owner-approved CMS project');
  }
}
