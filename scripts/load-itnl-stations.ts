/**
 * Inserta o actualiza las estaciones QR del campus ITNL (con coordenadas GPS)
 * SIN agregar pistas a las nuevas estaciones y conservando intactas las pistas
 * que ya existan (como la de 'gradas').
 *
 * Uso: pnpm tsx --env-file=.env scripts/load-itnl-stations.ts
 */
import pg from 'pg';
import { generateQrCode } from '../server/crypto.js';
import { requireEnv } from './lib/env.js';

const ITNL_STATIONS = [
  // Parte A: 7 ubicaciones con coordenadas exactas tomadas en campo
  {
    slug: 'gradas',
    public_name: 'Estación 1 - Gradas',
    sort_order: 1,
    lat: 27.453655,
    lng: -99.513525,
    radius: 25,
  },
  {
    slug: 'bancas-beis',
    public_name: 'Estación 2 - Bancas de Béisbol',
    sort_order: 2,
    lat: 27.45133,
    lng: -99.517096,
    radius: 25,
  },
  {
    slug: 'caseta-sistemas',
    public_name: 'Estación 3 - Caseta Estacionamiento de Sistemas',
    sort_order: 3,
    lat: 27.454349,
    lng: -99.513605,
    radius: 25,
  },
  {
    slug: 'el-chino',
    public_name: 'Estación 4 - El Chino',
    sort_order: 4,
    lat: 27.452395,
    lng: -99.51523,
    radius: 25,
  },
  {
    slug: 'biblioteca',
    public_name: 'Estación 5 - Biblioteca (frente al Muro de Placas)',
    sort_order: 5,
    lat: 27.454223,
    lng: -99.515777,
    radius: 25,
  },
  {
    slug: 'lab-civil',
    public_name: 'Estación 6 - Entrada Laboratorio de Civil',
    sort_order: 6,
    lat: 27.454412,
    lng: -99.514504,
    radius: 25,
  },
  {
    slug: 'gestion-vinculacion',
    public_name: 'Estación 7 - Gestión y Vinculación (Muro de Anuncios)',
    sort_order: 7,
    lat: 27.451741,
    lng: -99.51569,
    radius: 25,
  },

  // Parte B: 7 estaciones adicionales en el terreno del ITNL
  {
    slug: 'edificio-rojo',
    public_name: 'Estación 8 - El Edificio Rojo',
    sort_order: 8,
    lat: 27.45315,
    lng: -99.51445,
    radius: 30,
  },
  {
    slug: 'gimnasio',
    public_name: 'Estación 9 - Gimnasio Auditorio',
    sort_order: 9,
    lat: 27.45295,
    lng: -99.51385,
    radius: 30,
  },
  {
    slug: 'lab-sistemas',
    public_name: 'Estación 10 - Laboratorio de Ing. en Sistemas',
    sort_order: 10,
    lat: 27.45365,
    lng: -99.51415,
    radius: 25,
  },
  {
    slug: 'plaza-civica',
    public_name: 'Estación 11 - Plaza Cívica / Edificio Administrativo',
    sort_order: 11,
    lat: 27.45335,
    lng: -99.51605,
    radius: 30,
  },
  {
    slug: 'alberca',
    public_name: 'Estación 12 - Alberca Semiolímpica',
    sort_order: 12,
    lat: 27.45335,
    lng: -99.51365,
    radius: 25,
  },
  {
    slug: 'edificios-h',
    public_name: 'Estación 13 - Pasillo Edificios H / Ciencias Básicas',
    sort_order: 13,
    lat: 27.45225,
    lng: -99.51475,
    radius: 30,
  },
  {
    slug: 'cancha-futrap',
    public_name: 'Estación 14 - Cancha de Futrap (junto a pista)',
    sort_order: 14,
    lat: 27.45285,
    lng: -99.51295,
    radius: 30,
  },
];

async function main() {
  const eventSlug = process.env.EVENT_SLUG ?? 'rally-dev';
  const client = new pg.Client({ connectionString: requireEnv('DATABASE_URL_OWNER') });
  await client.connect();
  try {
    const ev = await client.query<{ id: string }>('select id from game.events where slug = $1', [
      eventSlug,
    ]);
    const eventId = ev.rows[0]?.id;
    if (!eventId) {
      throw new Error(`Evento "${eventSlug}" no encontrado`);
    }

    for (const s of ITNL_STATIONS) {
      await client.query(
        `insert into game.qr_points (
           event_id, code, slug, public_name, sort_order, is_active, lat, lng, proximity_radius_m
         )
         values ($1, $2, $3, $4, $5, true, $6, $7, $8)
         on conflict (event_id, slug) do update
           set public_name = excluded.public_name,
               sort_order = excluded.sort_order,
               lat = excluded.lat,
               lng = excluded.lng`,
        [eventId, generateQrCode(), s.slug, s.public_name, s.sort_order, s.lat, s.lng, s.radius],
      );
    }

    // Asegurar que 'gradas' conserve la pista que ya había escrito el usuario (y ninguna otra estación tenga pista).
    const gradasRow = await client.query<{ id: string }>(
      `select id from game.qr_points where event_id = $1 and slug = 'gradas'`,
      [eventId],
    );
    if (gradasRow.rows[0]) {
      const gradasId = gradasRow.rows[0].id;
      const existingClue = await client.query(
        `select 1 from game.clues where event_id = $1 and target_qr_id = $2`,
        [eventId, gradasId],
      );
      if (existingClue.rowCount === 0) {
        await client.query(
          `insert into game.clues (event_id, target_qr_id, body, is_active)
           values ($1, $2, $3, true)`,
          [
            eventId,
            gradasId,
            'Soy un lugar de descanso, y mi función también es presenciar eventos - Estoy en lo alto.',
          ],
        );
      }
    }

    const res = await client.query(
      `select sort_order as "#", slug, public_name, lat, lng, proximity_radius_m as "radio_m",
              (select count(*)::int from game.clues cl where cl.target_qr_id = q.id and cl.is_active) as "pistas"
         from game.qr_points q
        where event_id = $1
        order by sort_order`,
      [eventId],
    );
    console.table(res.rows);
    console.log(
      `✓ ${res.rowCount} estaciones cargadas en "${eventSlug}". Solo 'gradas' conserva su pista; las demás tienen 0 pistas listas para que las redactes en /admin.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
