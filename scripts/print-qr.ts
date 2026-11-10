/**
 * Genera el PDF imprimible de códigos QR del evento en output/qr-sheets-<slug>.pdf
 * y una hoja de referencia para los encargados en output/qr-reference-<slug>.txt.
 *
 * Reglas de seguridad:
 * - El QR contiene ÚNICAMENTE la URL del punto: <APP_ORIGIN>/q/<code_aleatorio>
 * - No contiene respuestas, niveles, credenciales ni nombres de estaciones en la URL.
 * - La página impresa muestra un título neutro ("Punto oficial del rally") y una clave corta
 *   de control para colocar la hoja en su estación sin revelar pistas a simple vista.
 *
 * Uso: pnpm qr:print
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import QRCode from 'qrcode';
import { requireEnv } from './lib/env.js';

export async function generatePrintableQrPdf(
  client: pg.Client,
  eventSlug: string,
  appOrigin: string,
): Promise<{ pdfPath: string; refPath: string; count: number }> {
  const ev = await client.query<{ id: string; name: string }>(
    'select id, name from game.events where slug = $1',
    [eventSlug],
  );
  const event = ev.rows[0];
  if (!event) {
    throw new Error(`Evento "${eventSlug}" no encontrado`);
  }

  const pts = await client.query<{
    slug: string;
    public_name: string;
    code: string;
    sort_order: number;
  }>(
    `select slug, public_name, code, sort_order
       from game.qr_points
      where event_id = $1 and is_active = true
      order by sort_order, slug`,
    [event.id],
  );

  const origin = appOrigin.replace(/\/+$/, '');
  const pdf = await PDFDocument.create();
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await pdf.embedFont(StandardFonts.Helvetica);

  for (let idx = 0; idx < pts.rows.length; idx++) {
    const pt = pts.rows[idx]!;
    const url = `${origin}/q/${pt.code}`;
    const pngBuffer = await QRCode.toBuffer(url, {
      errorCorrectionLevel: 'H',
      margin: 2,
      width: 520,
    });
    const pngImage = await pdf.embedPng(pngBuffer);

    const page = pdf.addPage([612, 792]); // Carta (Letter)
    const { width, height } = page.getSize();

    page.drawText('INSTITUTO TECNOLOGICO DE NUEVO LAREDO — ISC', {
      x: 72,
      y: height - 70,
      size: 11,
      font: fontBold,
      color: rgb(0.25, 0.28, 0.35),
    });

    page.drawText('BUSCANDO A LINUX — PUNTO OFICIAL', {
      x: 72,
      y: height - 102,
      size: 20,
      font: fontBold,
      color: rgb(0.06, 0.09, 0.16),
    });

    const qrSize = 340;
    page.drawImage(pngImage, {
      x: (width - qrSize) / 2,
      y: height - 150 - qrSize,
      width: qrSize,
      height: qrSize,
    });

    page.drawText('1. Escanea este codigo con la camara de tu telefono.', {
      x: 96,
      y: height - 530,
      size: 13,
      font: fontRegular,
      color: rgb(0.1, 0.12, 0.18),
    });
    page.drawText('2. En la pagina del rally, toca "Registrar este punto".', {
      x: 96,
      y: height - 552,
      size: 13,
      font: fontRegular,
      color: rgb(0.1, 0.12, 0.18),
    });

    page.drawText('No retires ni danes esta hoja. Uso exclusivo para todos los equipos del rally.', {
      x: 96,
      y: 90,
      size: 10,
      font: fontRegular,
      color: rgb(0.4, 0.42, 0.48),
    });

    // Etiqueta discreta de control para que el staff coloque cada hoja en la estación correcta.
    page.drawText(`Control staff: #${idx + 1} (${pt.slug})`, {
      x: 96,
      y: 65,
      size: 9,
      font: fontRegular,
      color: rgb(0.55, 0.57, 0.62),
    });
  }

  const outDir = join(import.meta.dirname, '..', 'output');
  await mkdir(outDir, { recursive: true });
  const pdfPath = join(outDir, `qr-sheets-${eventSlug}.pdf`);
  const refPath = join(outDir, `qr-reference-${eventSlug}.txt`);

  await writeFile(pdfPath, await pdf.save());

  const refLines = [
    `HOJA DE CONTROL DE ESTACIONES QR — ${event.name}`,
    `Generado: ${new Date().toISOString()}`,
    '',
    ...pts.rows.map(
      (p, i) =>
        `Estación #${i + 1} [${p.slug}] — ${p.public_name}\n  URL en QR: ${origin}/q/${p.code}\n`,
    ),
  ];
  await writeFile(refPath, refLines.join('\n'), 'utf8');

  return { pdfPath, refPath, count: pts.rows.length };
}

async function main() {
  const eventSlug = process.env.EVENT_SLUG ?? 'rally-dev';
  const appOrigin = process.env.APP_ORIGIN ?? 'http://localhost:5173';
  const client = new pg.Client({ connectionString: requireEnv('DATABASE_URL_OWNER') });
  await client.connect();
  try {
    const res = await generatePrintableQrPdf(client, eventSlug, appOrigin);
    console.log(`✓ ${res.count} hojas QR generadas en: ${res.pdfPath}`);
    console.log(`✓ Hoja de referencia staff en: ${res.refPath}`);
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
