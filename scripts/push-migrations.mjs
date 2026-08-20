// ============================================================================
// Apply migrations to a Supabase project via the Management API.
// Alternative to `supabase db push` that doesn't need the DB password —
// the PAT is sufficient, since /database/query runs as postgres.
//
// Usage:
//   SUPABASE_ACCESS_TOKEN=sbp_... PROJECT_REF=abc node scripts/push-migrations.mjs
// ============================================================================

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.PROJECT_REF;
const ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY;

if (!TOKEN || !REF) {
  console.error('Missing SUPABASE_ACCESS_TOKEN or PROJECT_REF env vars.');
  process.exit(2);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Migrations may contain placeholders we substitute at push time so the real
// secret never lands in git.
const PLACEHOLDERS = {
  __WHATSAPP_HUB_ENCRYPTION_KEY__: {
    value: ENCRYPTION_KEY,
    envVar: 'APP_ENCRYPTION_KEY',
  },
  __SUPABASE_URL__: {
    value: SUPABASE_URL,
    envVar: 'SUPABASE_URL',
  },
  __SUPABASE_SERVICE_ROLE_KEY__: {
    value: SUPABASE_SERVICE_ROLE_KEY,
    envVar: 'SUPABASE_SERVICE_ROLE_KEY',
  },
};

function substitute(sql) {
  let result = sql;
  for (const [placeholder, { value, envVar }] of Object.entries(PLACEHOLDERS)) {
    if (!result.includes(placeholder)) continue;
    if (!value) {
      throw new Error(
        `Migration uses ${placeholder} but ${envVar} env var is unset.`,
      );
    }
    result = result.replaceAll(placeholder, value);
  }
  return result;
}

const API = `https://api.supabase.com/v1/projects/${REF}/database/query`;

async function runSql(query) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

function parseFilename(file) {
  // 20260422120001_init.sql → { version: '20260422120001', name: 'init' }
  const base = file.replace(/\.sql$/, '');
  const idx = base.indexOf('_');
  if (idx === -1) return { version: base, name: '' };
  return { version: base.slice(0, idx), name: base.slice(idx + 1) };
}

// Supabase only creates supabase_migrations.schema_migrations on the first
// official `supabase db push`. Fresh projects don't have it, which means our
// homegrown push fails with "relation does not exist". Create it ourselves
// (idempotent) so the very first run works.
async function ensureMigrationsTable() {
  const ddl = `
    CREATE SCHEMA IF NOT EXISTS supabase_migrations;
    CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT,
      statements TEXT[]
    );
  `;
  const { ok, body } = await runSql(ddl);
  if (!ok) throw new Error(`Failed to ensure migrations table: ${body}`);
}

async function fetchAppliedVersions() {
  await ensureMigrationsTable();
  const { ok, body } = await runSql(
    'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;',
  );
  if (!ok) throw new Error(`Failed to read migrations table: ${body}`);
  const rows = JSON.parse(body);
  return new Set(rows.map((r) => r.version));
}

async function main() {
  const dir = 'supabase/migrations';
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  const applied = await fetchAppliedVersions();
  console.log(`Remote has ${applied.size} migrations already applied.`);

  let pushedCount = 0;
  for (const file of files) {
    const { version, name } = parseFilename(file);
    if (applied.has(version)) {
      console.log(`SKIP ${file} — already applied`);
      continue;
    }

    const raw = readFileSync(join(dir, file), 'utf8');
    const sql = substitute(raw);
    console.log(`APPLY ${file}`);
    const result = await runSql(sql);
    if (!result.ok) {
      console.error(`  ❌ FAILED (${result.status})`);
      console.error(`  ${result.body}`);
      process.exit(1);
    }

    // Mirror what `supabase db push` records so future pushes agree this ran.
    const trackSql = `
      INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
      VALUES ($$${version}$$, $$${name}$$, ARRAY[]::text[])
      ON CONFLICT (version) DO NOTHING;
    `;
    const track = await runSql(trackSql);
    if (!track.ok) {
      console.error(`  ❌ Applied SQL but failed to record migration: ${track.body}`);
      process.exit(1);
    }
    console.log(`  ✓ applied and recorded`);
    pushedCount++;
  }

  console.log(`\nDone. ${pushedCount} migrations pushed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
