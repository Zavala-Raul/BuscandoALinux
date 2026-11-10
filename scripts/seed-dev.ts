/**
 * Seed oficial del rally "Buscando a Linux" (ISC - ITNL):
 * - Evento "Buscando a Linux" (meta = 12 QRs, estado "running").
 * - 14 estaciones QR del campus ITNL con sus coordenadas GPS y la pista de 'gradas' (desde content/clues.yaml).
 * - Los 11 equipos registrados (TEC-001 a TEC-011: Lobos, LOS PROYECTADOS, Windows, etc.).
 * - 4 cuentas de encargados (1 organizador final + admin, 3 administradores).
 * - Genera hojas de activación (output/activation-codes-rally-dev.txt) y PDF de QR en output/.
 *
 * Uso:
 *   En local:      pnpm db:seed:dev
 *   En producción: npx tsx --env-file=.env.prod scripts/seed-dev.ts
 */
import { join } from 'node:path';
import pg from 'pg';
import { upsertStaff } from './create-staff.js';
import { importContentFromFile } from './import-content.js';
import { issueActivationCodes, writeActivationCodesSheet } from './issue-codes.js';
import { requireEnv } from './lib/env.js';
import { generatePrintableQrPdf } from './print-qr.js';

export const RALLY_TEAMS = [
  { public_id: 'TEC-001', name: 'Lobos' },
  { public_id: 'TEC-002', name: 'LOS PROYECTADOS' },
  { public_id: 'TEC-003', name: 'Windows' },
  { public_id: 'TEC-004', name: 'Los leones marinos y la foquita' },
  { public_id: 'TEC-005', name: 'SixSevensitos' },
  { public_id: 'TEC-006', name: 'Piolines Emos' },
  { public_id: 'TEC-007', name: 'Las inges' },
  { public_id: 'TEC-008', name: 'Cisco' },
  { public_id: 'TEC-009', name: 'Los Chilaquiles' },
  { public_id: 'TEC-010', name: 'CBTis137 y candy' },
  { public_id: 'TEC-011', name: 'Potaxies' },
];

const RALLY_STAFF: Array<{
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

async function main() {
  const client = new pg.Client({ connectionString: requireEnv('DATABASE_URL_OWNER') });
  await client.connect();
  try {
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

    for (const s of RALLY_STAFF) {
      await upsertStaff(client, {
        eventSlug,
        username: s.username,
        displayName: s.displayName,
        password: s.password,
        roles: s.roles,
      });
    }

    const issued = await issueActivationCodes(client, eventSlug);
    const codesFilePath = await writeActivationCodesSheet(eventSlug, issued);
    const appOrigin = process.env.APP_ORIGIN ?? 'http://localhost:5173';
    const qrOut = await generatePrintableQrPdf(client, eventSlug, appOrigin);

    console.log(`\n✓ Evento "${eventSlug}" listo (meta = 12 QRs, 14 estaciones ITNL).`);
    console.log(`✓ 4 cuentas de staff configuradas:`);
    for (const s of RALLY_STAFF) {
      console.log(
        `    - usuario: ${s.username} | contraseña: ${s.password} | roles: ${s.roles.join(',')}`,
      );
    }
    console.log(`\n✓ ${issued.length} equipos cargados con código de activación:`);
    for (const i of issued) {
      console.log(`    - ${i.public_id} (${i.name}):  ${i.code}`);
    }
    console.log(`\n✓ Hoja de códigos de activación: ${codesFilePath}`);
    console.log(`✓ PDF de QR: ${qrOut.pdfPath}`);
    console.log(`✓ Referencia de URLs QR: ${qrOut.refPath}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
