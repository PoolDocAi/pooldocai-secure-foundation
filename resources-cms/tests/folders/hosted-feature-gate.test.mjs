import test from 'node:test';
import assert from 'node:assert/strict';
import { readRuntimeConfig } from '../../src/production/runtime.mjs';

const common = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test-only',
  CMS_ORIGIN: 'https://cms.example.test',
};

test('folder feature defaults off independently of catalog and source code', () => {
  const config = readRuntimeConfig(common);
  assert.equal(config.features.folders, false);
  assert.equal(config.features.discovery, false);
});

test('hosted folders fail closed if discovery/catalog feature is disabled', () => {
  assert.throws(
    () => readRuntimeConfig({ ...common, CMS_FOLDERS_ENABLED: '1' }),
    /requires CMS_DISCOVERY_V3/,
  );
});

test('catalog and folder feature flags must be separately and explicitly enabled', () => {
  const discoveryOnly = readRuntimeConfig({ ...common, CMS_DISCOVERY_V3: '1' });
  assert.equal(discoveryOnly.features.discovery, true);
  assert.equal(discoveryOnly.features.folders, false);
  const requested = readRuntimeConfig({
    ...common,
    CMS_DISCOVERY_V3: '1',
    CMS_FOLDERS_ENABLED: '1',
  });
  assert.equal(requested.features.folders, true);
  assert.equal(requested.features.discovery, true);
});
