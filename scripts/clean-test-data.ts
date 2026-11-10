/**
 * Limpia todos los equipos, sesiones de equipos, códigos de activación, escaneos,
 * ubicaciones finales, estaciones QR y pistas de prueba, conservando únicamente
 * el evento y las 4 cuentas de staff (organizador, admin1..admin3) para que puedas
 * entrar a /admin y probar dando de alta tus propias estaciones, pistas y equipos.
 *
 * Uso: pnpm db:clean
 */
import pg from 'pg';
import { upsertStaff } from './create-staff.js';
import { requireEnv } from './lib/env.js';

async function main() {
  const eventSlug = process.env.EVENT_SLUG ?? 'rally-dev';
  const client = new pg.Client({ connectionString: requireEnv('DATABASE_URL_OWNER') });
  await client.connect();
  try {
    const ev = await client.query<{ id: string }>(
      `insert into game.events (slug, name, status, target_count, is_test)
       values ($1, 'Buscando a Linux — Rally ISC ITNL', 'running', 8, false)
       on conflict (slug) do update
         set name = 'Buscando a Linux — Rally ISC ITNL',
             status = 'running'
       returning id`,
      [eventSlug],
    );
    const eventId = ev.rows[0]!.id;

    await client.query('update game.staff set team_id = null where event_id = $1', [eventId]);
    await client.query('delete from game.finishes where event_id = $1', [eventId]);
    await client.query('delete from game.final_locations where event_id = $1', [eventId]);
    await client.query('delete from game.team_pointer where event_id = $1', [eventId]);
    await client.query('delete from game.team_scans where event_id = $1', [eventId]);
    await client.query(
      `delete from game.sessions where event_id = $1 and kind = 'team'`,
      [eventId],
    );
    await client.query('delete from game.activation_tokens where event_id = $1', [eventId]);
    await client.query('delete from game.teams where event_id = $1', [eventId]);
    await client.query('delete from game.clues where event_id = $1', [eventId]);
    await client.query('delete from game.qr_points where event_id = $1', [eventId]);

    // Garantizar que las 4 cuentas de staff estén activas para entrar a /admin y /final-staff.
    await upsertStaff(client, {
      eventSlug,
      username: 'organizador',
      displayName: 'Organizador Final (Linux)',
      password: 'dev-final-password',
      roles: ['final', 'admin'],
    });
    await upsertStaff(client, {
      eventSlug,
      username: 'admin1',
      displayName: 'Encargado Admin 1',
      password: 'dev-admin1-password',
      roles: ['admin'],
    });
    await upsertStaff(client, {
      eventSlug,
      username: 'admin2',
      displayName: 'Encargado Admin 2',
      password: 'dev-admin2-password',
      roles: ['admin'],
    });
    await upsertStaff(client, {
      eventSlug,
      username: 'admin3',
      displayName: 'Encargado Admin 3',
      password: 'dev-admin3-password',
      roles: ['admin'],
    });

    console.log(
      `✓ Datos de prueba eliminados en "${eventSlug}" (0 equipos, 0 estaciones QR, 0 pistas).`,
    );
    console.log(
      `✓ Cuentas de staff conservadas (ej. usuario "organizador" / contraseña "dev-final-password").`,
    );
    console.log(`✓ Ahora puedes crear estaciones QR, coordenadas, pistas y equipos desde /admin.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
