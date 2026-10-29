import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

test('private fixture installation verifies integrity and refuses unsafe replacement', () => {
  // Synthetic input tests only the installer in a disposable copy, never the broad harness.
  const root = mkdtempSync(join(tmpdir(), 'pooldoc-fixture-installer-'));
  try {
    mkdirSync(join(root, 'scripts'));
    const script = join(root, 'scripts/install-private-browser-fixture.mjs');
    copyFileSync(new URL('../scripts/install-private-browser-fixture.mjs', import.meta.url), script);
    const source = join(root, 'approved.json');
    const target = join(root, 'examples/existing-resources.json');
    const bytes = '[{"slug":"installer-only-disposable"}]\n';
    const hash = data => createHash('sha256').update(data).digest('hex');
    writeFileSync(source, bytes);
    const run = digest => spawnSync(process.execPath, [script, source, digest], { encoding: 'utf8' });
    assert.notEqual(run('0'.repeat(64)).status, 0);
    assert.equal(existsSync(target), false);
    writeFileSync(source, '[{"slug":"confidential-malformed-marker",}]');
    const malformed = run(hash(readFileSync(source)));
    assert.notEqual(malformed.status, 0);
    assert.equal(existsSync(target), false);
    assert.equal((malformed.stdout + malformed.stderr).includes('confidential-malformed-marker'), false);
    writeFileSync(source, '[{"slug":"duplicate"},{"slug":"duplicate"}]');
    assert.notEqual(run(hash(readFileSync(source))).status, 0);
    assert.equal(existsSync(target), false);
    writeFileSync(source, bytes);
    const installed = run(hash(bytes));
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(readFileSync(target, 'utf8'), bytes);
    assert.equal(installed.stdout.includes('installer-only-disposable'), false);
    assert.notEqual(run(hash(bytes)).status, 0);
    assert.equal(readFileSync(target, 'utf8'), bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
