/**
 * Configura de principio a fin una base de datos PostgreSQL (p. ej. Neon en Vercel):
 * 1) Aplica todas las migraciones de db/migrations/.
 * 2) Crea/actualiza el rol restringido rally_app con RALLY_APP_PASSWORD.
 * 3) Carga el evento "Buscando a Linux" (meta = 12 QRs), las 14 estaciones del ITNL,
 *    las pistas de content/clues.yaml, los 11 equipos y las 4 cuentas de staff.
 * 4) Emite los códigos de activación y el PDF de QR en output/.
 * 5) Imprime las variables exactas listas para pegar en Vercel.
 *
 * Uso:
 *   pnpm db:setup-prod
 */
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { upsertStaff } from './create-staff.js';
import { importContentFromFile } from './import-content.js';
import { issueActivationCodes, writeActivationCodesSheet } from './issue-codes.js';
import { requireEnv } from './lib/env.js';
import { generatePrintableQrPdf } from './print-qr.js';
import { RALLY_TEAMS } from './seed-dev.js';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'db', 'migrations');

async function main() {
  const ownerUrl = requireEnv('DATABASE_URL_OWNER');
  const appPassword =
    process.env.RALLY_APP_PASSWORD ?? randomBytes(18).toString('base64url');
  const tokenPepper =
    process.env.TOKEN_PEPPER ?? randomBytes(32).toString('base64url');
  process.env.TOKEN_PEPPER = tokenPepper;

  const appOrigin = process.env.APP_ORIGIN ?? 'https://buscando-a-linux.vercel.app';

  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query('create schema if not exists game_meta');
    await client.query(`create table if not exists game_meta.schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`);
    await client.query('revoke all on schema game_meta from public');

    const applied = new Set(
      (await client.query<{ name: string }>('select name from game_meta.schema_migrations')).rows.map(
        (r) => r.name,
      ),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      process.stdout.write(`→ Migración ${file} ... `);
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

    const literal = `'${appPassword.replace(/'/g, "''")}'`;
    await client.query(`alter role rally_app with login password ${literal}`);
    console.log('✓ Rol restringido rally_app configurado');

    const yamlPath = join(import.meta.dirname, '..', 'content', 'clues.yaml');
    const { eventId, eventSlug } = await importContentFromFile(client, yamlPath, false);
    await client.query(`update game.events set status = 'running' where id = $1`, [eventId]);

    for (const t of RALLY_TEAMS) {
      await client.query(
        `insert into game.teams (event_id, public_id, name, status)
         values ($1, $2, $3, 'active')
         on conflict (event_id, public_id) do update set name = excluded.name, status = 'active'`,
        [eventId, t.public_id, t.name],
      );
    }

    const staffAccounts: Array<{
      username: string;
      displayName: string;
      password: string;
      roles: Array<'admin' | 'final'>;
    }> = [
      {
        username: 'organizador',
        displayName: 'Organizador Final (Linux)',
        password: process.env.STAFF_FINAL_PASSWORD ?? 'dev-final-password',
        roles: ['final', 'admin'],
      },
      {
        username: 'admin1',
        displayName: 'Encargado Admin 1',
        password: process.env.STAFF_ADMIN1_PASSWORD ?? 'dev-admin1-password',
        roles: ['admin'],
      },
      {
        username: 'admin2',
        displayName: 'Encargado Admin 2',
        password: process.env.STAFF_ADMIN2_PASSWORD ?? 'dev-admin2-password',
        roles: ['admin'],
      },
      {
        username: 'admin3',
        displayName: 'Encargado Admin 3',
        password: process.env.STAFF_ADMIN3_PASSWORD ?? 'dev-admin3-password',
        roles: ['admin'],
      },
    ];

    for (const s of staffAccounts) {
      await upsertStaff(client, {
        eventSlug,
        username: s.username,
        displayName: s.displayName,
        password: s.password,
        roles: s.roles,
      });
    }

    const issued = await issueActivationCodes(client, eventSlug);
    const codesPath = await writeActivationCodesSheet(eventSlug, issued);
    const qrOut = await generatePrintableQrPdf(client, eventSlug, appOrigin);

    // Construir automáticamente la URL de conexión para rally_app a partir de DATABASE_URL_OWNER
    const parsedUrl = new URL(ownerUrl);
    parsedUrl.username = 'rally_app';
    parsedUrl.password = appPassword;

    console.log('\n====================================================================');
    console.log('✓ BASE DE DATOS Y SEEDS CARGADOS (14 estaciones, 11 equipos, 4 staff)');
    console.log('====================================================================');
    console.log(`Hoja de códigos: ${codesPath}`);
    console.log(`PDF de QR:       ${qrOut.pdfPath}`);
    console.log('\nVariables para pegar en Vercel (Settings -> Environment Variables):');
    console.log(`DATABASE_URL=${parsedUrl.toString()}`);
    console.log(`TOKEN_PEPPER=${tokenPepper}`);
    console.log(`EVENT_SLUG=${eventSlug}`);
    console.log(`APP_ORIGIN=${appOrigin}`);
    console.log(`COOKIE_SECURE=true`);
    console.log('====================================================================\n');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
