import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicCMSDeliveryTarget } from '../src/production/public-target.mjs';
const cms = 'rzkgmvyyeclrpomrlyft';
const core = 'owfeebydlyacssqpnmkq';
const base = {
  VERCEL_ENV:'production', CMS_PUBLISHED_DELIVERY_ENABLED:'1',
  PUBLIC_RESOURCES_PRODUCTION_PROJECT_REF:cms,
  PUBLIC_RESOURCES_STAGING_PROJECT_REF:cms,
  PUBLIC_RESOURCES_SUPABASE_URL:`https://${cms}.supabase.co`,
};
test('formerly staging CMS cannot be targeted publicly without exact separate promotion approval', () => {
  assert.throws(() => assertPublicCMSDeliveryTarget(base), /exact owner-approved/);
  assert.throws(() => assertPublicCMSDeliveryTarget({
    ...base, PUBLIC_RESOURCES_APPROVED_FREE_PROMOTION_REF:core,
  }), /exact owner-approved/);
});
test('only exact owner-approved Free-tier CMS project may be promoted', () => {
  assert.doesNotThrow(() => assertPublicCMSDeliveryTarget({
    ...base, PUBLIC_RESOURCES_APPROVED_FREE_PROMOTION_REF:cms,
  }));
});
test('promotion cannot bypass production origin or public delivery gate', () => {
  const ready = {...base, PUBLIC_RESOURCES_APPROVED_FREE_PROMOTION_REF:cms};
  assert.throws(() => assertPublicCMSDeliveryTarget({
    ...ready, PUBLIC_RESOURCES_SUPABASE_URL:`https://${core}.supabase.co`,
  }), /does not match/);
  assert.throws(() => assertPublicCMSDeliveryTarget({
    ...ready, CMS_PUBLISHED_DELIVERY_ENABLED:'0',
  }), /disabled/);
  assert.doesNotThrow(() => assertPublicCMSDeliveryTarget({VERCEL_ENV:'preview'}));
});
