/**
 * Reporte de estado del evento (solo lectura) contra la base configurada en DATABASE_URL_OWNER.
 * Imprime JSON con estaciones, coordenadas, pistas, equipos, staff y ubicación final.
 *
 * Uso: tsx --env-file=.env.prod scripts/status-report.ts
 */
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { requireEnv } from './lib/env.js';

async function main() {
  const eventSlug = process.env.EVENT_SLUG ?? 'rally-dev';
  const client = new pg.Client({ connectionString: requireEnv('DATABASE_URL_OWNER') });
  await client.connect();
  try {
    const ev = await client.query(
      'select id, name, slug, status, target_count, is_test from game.events where slug = $1',
      [eventSlug],
    );
    const event = ev.rows[0];
    if (!event) throw new Error(`Evento "${eventSlug}" no encontrado`);

    const stations = await client.query(
      `select q.sort_order, q.slug, q.public_name, q.is_active, q.lat, q.lng, q.proximity_radius_m,
              coalesce(json_agg(c.body order by c.created_at) filter (where c.id is not null and c.is_active), '[]') as clues
         from game.qr_points q
         left join game.clues c on c.target_qr_id = q.id and c.event_id = q.event_id
        where q.event_id = $1
        group by q.id
        order by q.sort_order, q.slug`,
      [event.id],
    );

    const teams = await client.query(
      `select t.public_id, t.name, t.status,
              exists (select 1 from game.sessions s where s.team_id = t.id and s.kind = 'team' and s.revoked_at is null and s.expires_at > now()) as activated,
              exists (select 1 from game.activation_tokens a where a.team_id = t.id and a.used_at is null and a.revoked_at is null and a.expires_at > now()) as has_valid_code,
              (select count(*) from game.team_scans ts where ts.team_id = t.id and ts.voided_at is null)::int as scans,
              (select count(*) from game.team_members m where m.team_id = t.id)::int as members
         from game.teams t
        where t.event_id = $1
        order by t.public_id`,
      [event.id],
    );

    const staff = await client.query(
      `select s.username, s.is_active, array_agg(r.role order by r.role) as roles
         from game.staff s left join game.staff_roles r on r.staff_id = s.id
        where s.event_id = $1
        group by s.id order by s.username`,
      [event.id],
    );

    const finalLoc = await client.query(
      `select version, reference, created_at from game.final_locations
        where event_id = $1 order by version desc limit 1`,
      [event.id],
    );

    console.log(
      JSON.stringify(
        {
          event,
          stations: stations.rows,
          teams: teams.rows,
          staff: staff.rows,
          final_location: finalLoc.rows[0] ?? null,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
