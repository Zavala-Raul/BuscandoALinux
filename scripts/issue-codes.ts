/**
 * Emite códigos de activación para todos los equipos activos (o uno específico)
 * y genera una hoja imprimible en output/activation-codes-<slug>.txt (gitignored).
 * En la base de datos se guarda ÚNICAMENTE el hash HMAC-SHA256.
 *
 * Uso: pnpm codes:issue [public_id]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { generateActivationCode, hashSecret } from '../server/crypto.js';
import { requireEnv } from './lib/env.js';

export interface IssuedActivation {
  public_id: string;
  name: string;
  code: string;
  expires_at: string;
}

export async function writeActivationCodesSheet(
  eventSlug: string,
  issued: IssuedActivation[],
): Promise<string> {
  const outDir = join(import.meta.dirname, '..', 'output');
  await mkdir(outDir, { recursive: true });
  const filePath = join(outDir, `activation-codes-${eventSlug}.txt`);

  const lines = [
    `====================================================================`,
    ` HOJA CONFIDENCIAL DE ACTIVACIÓN — Evento: ${eventSlug}`,
    ` Generado: ${new Date().toISOString()}`,
    ` (Entregar a cada equipo únicamente su recorte; no publicar este archivo)`,
    `====================================================================`,
    '',
    ...issued.map(
      (i) =>
        `Equipo: ${i.public_id} (${i.name})\n  Código de activación: ${i.code}\n  Vence: ${new Date(i.expires_at).toLocaleString('es-MX')}\n--------------------------------------------------------------------`,
    ),
  ];
  await writeFile(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

export async function issueActivationCodes(
  client: pg.Client,
  eventSlug: string,
  onlyPublicId?: string,
  ttlHours = 24,
): Promise<IssuedActivation[]> {
  const ev = await client.query<{ id: string }>('select id from game.events where slug = $1', [
    eventSlug,
  ]);
  const eventId = ev.rows[0]?.id;
  if (!eventId) {
    throw new Error(`Evento "${eventSlug}" no encontrado`);
  }

  const teamsRes = await client.query<{ id: string; public_id: string; name: string }>(
    `select id, public_id, name from game.teams
      where event_id = $1 and status = 'active'
        and ($2::text is null or public_id = upper($2))
      order by public_id`,
    [eventId, onlyPublicId ?? null],
  );

  const out: IssuedActivation[] = [];
  await client.query('begin');
  try {
    for (const t of teamsRes.rows) {
      const code = generateActivationCode();
      const codeHash = hashSecret('activation', code);

      await client.query(
        'update game.activation_tokens set revoked_at = now() where team_id = $1 and used_at is null and revoked_at is null',
        [t.id],
      );
      const ins = await client.query<{ expires_at: string }>(
        `insert into game.activation_tokens (event_id, team_id, token_hash, expires_at)
         values ($1, $2, $3, now() + make_interval(hours => $4))
         returning expires_at`,
        [eventId, t.id, codeHash, ttlHours],
      );
      out.push({
        public_id: t.public_id,
        name: t.name,
        code,
        expires_at: ins.rows[0]!.expires_at,
      });
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  }
  return out;
}

async function main() {
  const onlyPublicId = process.argv[2];
  const eventSlug = process.env.EVENT_SLUG ?? 'rally-dev';
  const client = new pg.Client({ connectionString: requireEnv('DATABASE_URL_OWNER') });
  await client.connect();
  try {
    const issued = await issueActivationCodes(client, eventSlug, onlyPublicId);
    const filePath = await writeActivationCodesSheet(eventSlug, issued);
    console.log(`✓ ${issued.length} códigos emitidos. Archivo guardado en: ${filePath}`);
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
