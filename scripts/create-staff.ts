/**
 * Crea o actualiza una cuenta de staff individual (Argon2id) con sus roles.
 *
 * Uso:
 *   pnpm staff:create <username> "<Nombre visible>" <password> <rolesCsv> [publicTeamId]
 * Ejemplo:
 *   pnpm staff:create organizador1 "Encargado Final" "ClaveSegura2026!" final,admin
 */
import pg from 'pg';
import { hashPassword } from '../server/crypto.js';
import { requireEnv } from './lib/env.js';

export async function upsertStaff(
  client: pg.Client,
  params: {
    eventSlug: string;
    username: string;
    displayName: string;
    password: string;
    roles: Array<'admin' | 'final'>;
    teamPublicId?: string;
  },
): Promise<{ staffId: string }> {
  if (params.password.length < 8) {
    throw new Error('La contraseña debe tener al menos 8 caracteres');
  }
  const ev = await client.query<{ id: string }>('select id from game.events where slug = $1', [
    params.eventSlug,
  ]);
  const eventId = ev.rows[0]?.id;
  if (!eventId) {
    throw new Error(`No existe el evento con slug "${params.eventSlug}". Ejecuta pnpm content:import primero.`);
  }

  let teamId: string | null = null;
  if (params.teamPublicId) {
    const t = await client.query<{ id: string }>(
      'select id from game.teams where event_id = $1 and public_id = $2',
      [eventId, params.teamPublicId.toUpperCase()],
    );
    teamId = t.rows[0]?.id ?? null;
  }

  const pwdHash = await hashPassword(params.password);

  await client.query('begin');
  try {
    const st = await client.query<{ id: string }>(
      `insert into game.staff (event_id, username, display_name, password_hash, is_active, team_id)
       values ($1, $2, $3, $4, true, $5)
       on conflict (event_id, username) do update
         set display_name = excluded.display_name,
             password_hash = excluded.password_hash,
             is_active = true,
             team_id = excluded.team_id
       returning id`,
      [eventId, params.username.toLowerCase(), params.displayName, pwdHash, teamId],
    );
    const staffId = st.rows[0]!.id;

    await client.query('delete from game.staff_roles where staff_id = $1', [staffId]);
    for (const r of params.roles) {
      await client.query(
        'insert into game.staff_roles (event_id, staff_id, role) values ($1, $2, $3)',
        [eventId, staffId, r],
      );
    }
    await client.query('commit');
    return { staffId };
  } catch (err) {
    await client.query('rollback');
    throw err;
  }
}

async function main() {
  const [username, displayName, password, rolesRaw, teamPublicId] = process.argv.slice(2);
  if (!username || !displayName || !password || !rolesRaw) {
    console.error(
      'Uso: pnpm staff:create <username> "<Nombre>" <password> <roles: admin,final> [teamPublicId]',
    );
    process.exit(1);
  }
  const roles = rolesRaw
    .split(',')
    .map((r) => r.trim())
    .filter((r): r is 'admin' | 'final' => r === 'admin' || r === 'final');
  if (roles.length === 0) {
    throw new Error('Debes especificar al menos un rol válido: admin o final');
  }

  const eventSlug = process.env.EVENT_SLUG ?? 'rally-dev';
  const client = new pg.Client({ connectionString: requireEnv('DATABASE_URL_OWNER') });
  await client.connect();
  try {
    await upsertStaff(client, {
      eventSlug,
      username,
      displayName,
      password,
      roles,
      teamPublicId,
    });
    console.log(`✓ Staff "${username}" (${roles.join(', ')}) actualizado en "${eventSlug}".`);
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
