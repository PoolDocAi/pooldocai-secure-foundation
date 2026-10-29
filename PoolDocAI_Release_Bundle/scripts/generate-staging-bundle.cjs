#!/usr/bin/env node
/**
 * scripts/generate-staging-bundle.cjs
 *
 * Consolidates all individual forward migrations in supabase/migrations/
 * into a single idempotent staging bundle: supabase/staging/00_apply_staging_migrations.sql
 *
 * Safe for execution in both:
 * 1. Supabase Dashboard Web SQL Editor (zero psql meta-commands)
 * 2. psql command-line client via connection pooler
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const migrationsDir = path.join(rootDir, 'supabase', 'migrations');
const stagingDir = path.join(rootDir, 'supabase', 'staging');
const outputFile = path.join(stagingDir, '00_apply_staging_migrations.sql');

if (!fs.existsSync(stagingDir)) {
  fs.mkdirSync(stagingDir, { recursive: true });
}

const files = fs.readdirSync(migrationsDir)
  .filter(f => f.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  console.error('Error: No migration files found in supabase/migrations/');
  process.exit(1);
}

const header = `-- ============================================================================
-- POOLDOCAI ISOLATED STAGING ENVIRONMENT MIGRATION BUNDLE
-- Target: Project rzkgmvyyeclrpomrlyft (PoolDocAI Staging)
-- Total Migrations: ${files.length} (001 through 0${files.length})
-- Generated: ${new Date().toISOString().split('T')[0]}
-- STRICT NOTICE: STAGING USE ONLY. DO NOT EXECUTE ON PRODUCTION owfeebydlyacssqpnmkq
--
-- COMPATIBILITY NOTE:
-- This bundle contains standard PostgreSQL statements and contains NO psql
-- meta-commands (such as psql ON_ERROR_STOP). It can be executed directly in:
-- 1. Supabase Dashboard Web SQL Editor (paste & Run)
-- 2. psql command line: psql "<connection-string>" --set ON_ERROR_STOP=1 -f 00_apply_staging_migrations.sql
-- ============================================================================

`;

let output = header;

files.forEach((file, idx) => {
  const filePath = path.join(migrationsDir, file);
  const content = fs.readFileSync(filePath, 'utf8');
  output += `-- ----------------------------------------------------------------------------\n`;
  output += `-- Migration ${idx + 1}/${files.length}: ${file}\n`;
  output += `-- ----------------------------------------------------------------------------\n\n`;
  output += content.trim();
  output += `\n\n`;
});

const isCheck = process.argv.includes('--check');

if (isCheck) {
  if (!fs.existsSync(outputFile)) {
    console.error(`Check failed: ${outputFile} does not exist.`);
    process.exit(1);
  }
  const existing = fs.readFileSync(outputFile, 'utf8');
  // Normalize line endings and date header for comparison
  const normalize = str => str.replace(/\r\n/g, '\n').replace(/^-- Generated: \d{4}-\d{2}-\d{2}$/m, '-- Generated: DATE');
  if (normalize(existing) !== normalize(output)) {
    console.error(`Check failed: ${outputFile} is out of sync with supabase/migrations/. Run 'node scripts/generate-staging-bundle.cjs' to update.`);
    process.exit(1);
  }
  console.log(`PASS: Staging bundle is in sync (${files.length} migrations).`);
  process.exit(0);
}

fs.writeFileSync(outputFile, output, 'utf8');
console.log(`Generated staging migration bundle: ${outputFile} (${files.length} migrations)`);
