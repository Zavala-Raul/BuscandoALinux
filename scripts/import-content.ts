/**
 * Importa o actualiza los puntos QR y sus pistas desde content/clues.yaml.
 * - Conserva el `code` aleatorio de cada QR existente para no invalidar QR ya impresos.
 * - Soporta coordenadas opcionales (lat, lng, proximity_radius_m) para el radar de cercanía.
 * - Soporta estaciones con 0 pistas inicialmente (listas para agregarse desde /admin).
 * - Si se pasa `--rotate-codes`, genera nuevos códigos aleatorios para todos los puntos.
 *
 * Uso: pnpm content:import [ruta-yaml] [--rotate-codes]
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import YAML from 'yaml';
import { z } from 'zod';
import { generateQrCode } from '../server/crypto.js';
import { requireEnv } from './lib/env.js';

const ContentFileSchema = z
  .object({
    event: z
      .object({
        slug: z.string().regex(/^[a-z0-9-]{1,40}$/),
        name: z.string().min(1).max(120),
        target_count: z.number().int().min(1).max(50).default(12),
        is_test: z.boolean().default(false),
      })
      .strict(),
    qr_points: z
      .array(
        z
          .object({
            slug: z.string().regex(/^[a-z0-9-]{1,40}$/),
            public_name: z.string().min(1).max(80),
            code: z
              .string()
              .regex(/^[A-Za-z0-9]{22,64}$/)
              .optional(),
            sort_order: z.number().int().default(0),
            is_active: z.boolean().default(true),
            lat: z.number().finite().min(-90).max(90).nullable().optional(),
            lng: z.number().finite().min(-180).max(180).nullable().optional(),
            proximity_radius_m: z.number().int().min(10).max(500).default(25),
            clues: z.array(z.string().min(1).max(1000)).default([]),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export async function importContentFromFile(
  client: pg.Client,
  yamlPath: string,
  rotateCodes = false,
): Promise<{ eventId: string; eventSlug: string }> {
  const raw = await readFile(yamlPath, 'utf8');
  const parsed = ContentFileSchema.parse(YAML.parse(raw));

  if (parsed.qr_points.length < parsed.event.target_count) {
    throw new Error(
      `El evento requiere target_count=${parsed.event.target_count}, pero solo hay ${parsed.qr_points.length} puntos QR definidos.`,
    );
  }

  await client.query('begin');
  try {
    const evRes = await client.query<{ id: string }>(
      `insert into game.events (slug, name, target_count, is_test)
       values ($1, $2, $3, $4)
       on conflict (slug) do update
         set name = excluded.name,
             target_count = excluded.target_count,
             is_test = excluded.is_test
       returning id`,
      [parsed.event.slug, parsed.event.name, parsed.event.target_count, parsed.event.is_test],
    );
    const eventId = evRes.rows[0]!.id;

    for (const pt of parsed.qr_points) {
      const existing = await client.query<{ id: string; code: string }>(
        'select id, code from game.qr_points where event_id = $1 and slug = $2',
        [eventId, pt.slug],
      );

      let qrId: string;
      if (existing.rowCount && existing.rows[0]) {
        qrId = existing.rows[0].id;
        const newCode = rotateCodes ? generateQrCode() : existing.rows[0].code;
        await client.query(
          `update game.qr_points
              set public_name = $1, sort_order = $2, is_active = $3, code = $4,
                  lat = coalesce($5, lat), lng = coalesce($6, lng), proximity_radius_m = $7
            where id = $8`,
          [
            pt.public_name,
            pt.sort_order,
            pt.is_active,
            newCode,
            pt.lat ?? null,
            pt.lng ?? null,
            pt.proximity_radius_m,
            qrId,
          ],
        );
      } else {
        const initialCode = !rotateCodes && pt.code ? pt.code : generateQrCode();
        const ins = await client.query<{ id: string }>(
          `insert into game.qr_points (event_id, code, slug, public_name, sort_order, is_active, lat, lng, proximity_radius_m)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           returning id`,
          [
            eventId,
            initialCode,
            pt.slug,
            pt.public_name,
            pt.sort_order,
            pt.is_active,
            pt.lat ?? null,
            pt.lng ?? null,
            pt.proximity_radius_m,
          ],
        );
        qrId = ins.rows[0]!.id;
      }

      if (pt.clues.length > 0) {
        const existingClues = await client.query<{ id: string; body: string }>(
          'select id, body from game.clues where event_id = $1 and target_qr_id = $2',
          [eventId, qrId],
        );
        const wantedBodies = new Set(pt.clues.map((b) => b.trim()));

        for (const row of existingClues.rows) {
          const keep = wantedBodies.has(row.body.trim());
          await client.query('update game.clues set is_active = $1 where id = $2', [keep, row.id]);
        }

        const existingSet = new Set(existingClues.rows.map((r) => r.body.trim()));
        for (const body of wantedBodies) {
          if (!existingSet.has(body)) {
            await client.query(
              'insert into game.clues (event_id, target_qr_id, body, is_active) values ($1, $2, $3, true)',
              [eventId, qrId, body],
            );
          }
        }
      }
    }

    await client.query('commit');
    return { eventId, eventSlug: parsed.event.slug };
  } catch (err) {
    await client.query('rollback');
    throw err;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const rotate = args.includes('--rotate-codes');
  const fileArg = args.find((a) => !a.startsWith('--'));
  const yamlPath = fileArg ? fileArg : join(import.meta.dirname, '..', 'content', 'clues.yaml');

  const client = new pg.Client({ connectionString: requireEnv('DATABASE_URL_OWNER') });
  await client.connect();
  try {
    const res = await importContentFromFile(client, yamlPath, rotate);
    console.log(`✓ Contenido importado para evento "${res.eventSlug}" (${res.eventId})`);
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
