import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicCMSDeliveryTarget } from '../src/production/public-target.mjs';

const production = 'owfeebydlyacssqpnmkq';
const staging = 'rzkgmvyyeclrpomrlyft';
const valid = {
  VERCEL_ENV: 'production',
  CMS_PUBLISHED_DELIVERY_ENABLED: '1',
  PUBLIC_RESOURCES_PRODUCTION_PROJECT_REF: production,
  PUBLIC_RESOURCES_STAGING_PROJECT_REF: staging,
  PUBLIC_RESOURCES_SUPABASE_URL: `https://${production}.supabase.co`,
};

test('an explicitly approved and distinct Production CMS target is valid', () => {
  assert.doesNotThrow(() => assertPublicCMSDeliveryTarget(valid));
});

test('Preview does not require Production target configuration', () => {
  assert.doesNotThrow(() => assertPublicCMSDeliveryTarget({ VERCEL_ENV: 'preview' }));
});

test('Production cannot silently point at Staging', () => {
  assert.throws(() => assertPublicCMSDeliveryTarget({
    ...valid, PUBLIC_RESOURCES_SUPABASE_URL: `https://${staging}.supabase.co`,
  }), /does not match/);
  assert.throws(() => assertPublicCMSDeliveryTarget({
    ...valid, PUBLIC_RESOURCES_PRODUCTION_PROJECT_REF: staging,
  }), /Separate approved/);
});

test('Production rejects a missing explicit environment gate or origin mismatch', () => {
  assert.throws(() => assertPublicCMSDeliveryTarget({
    ...valid, CMS_PUBLISHED_DELIVERY_ENABLED: '0',
  }), /disabled/);
  assert.throws(() => assertPublicCMSDeliveryTarget({
    ...valid, PUBLIC_RESOURCES_PRODUCTION_PROJECT_REF: undefined,
  }), /Separate approved/);
  assert.throws(() => assertPublicCMSDeliveryTarget({
    ...valid, PUBLIC_RESOURCES_SUPABASE_URL: 'http://example.com',
  }), /valid exact HTTPS/);
  assert.throws(() => assertPublicCMSDeliveryTarget({
    ...valid, PUBLIC_RESOURCES_SUPABASE_URL: `https://${production}.supabase.co/path`,
  }), /valid exact HTTPS/);
});
