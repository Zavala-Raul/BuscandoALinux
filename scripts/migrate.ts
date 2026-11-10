/**
 * Aplica las migraciones SQL de db/migrations en orden, cada una en su propia
 * transacción, y registra las aplicadas en game_meta.schema_migrations.
 * Después asigna LOGIN + contraseña al rol rally_app (RALLY_APP_PASSWORD).
 *
 * Uso: pnpm db:migrate   (requiere DATABASE_URL_OWNER)
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { requireEnv } from './lib/env.js';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'db', 'migrations');

async function main() {
  const client = new pg.Client({ connectionString: requireEnv('DATABASE_URL_OWNER') });
  await client.connect();
  try {
    await client.query('create schema if not exists game_meta');
    await client.query(`create table if not exists game_meta.schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`);
    await client.query('revoke all on schema game_meta from public');

    const applied = new Set(
      (await client.query<{ name: string }>('select name from game_meta.schema_migrations')).rows.map((r) => r.name),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      process.stdout.write(`→ ${file} ... `);
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into game_meta.schema_migrations(name) values ($1)', [file]);
        await client.query('commit');
        console.log('ok');
      } catch (err) {
        await client.query('rollback');
        console.log('ERROR');
        throw err;
      }
    }

    const appPassword = process.env.RALLY_APP_PASSWORD;
    if (appPassword) {
      if (appPassword.length < 12) throw new Error('RALLY_APP_PASSWORD debe tener al menos 12 caracteres');
      // ALTER ROLE no admite parámetros: se escapa como literal.
      const literal = `'${appPassword.replace(/'/g, "''")}'`;
      await client.query(`alter role rally_app with login password ${literal}`);
      console.log('✓ rol rally_app con LOGIN');
    } else {
      console.log('! RALLY_APP_PASSWORD no definido: no se modificó el rol rally_app');
    }
    console.log('Migraciones al día.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
