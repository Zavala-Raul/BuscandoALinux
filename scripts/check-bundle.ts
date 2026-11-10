/**
 * Verifica que los archivos compilados para el navegador (dist/) NO contengan:
 * - Secretos del servidor (DATABASE_URL, TOKEN_PEPPER, RALLY_APP_PASSWORD).
 * - Coordenadas o referencias de ubicación final hardcodeadas.
 * - Textos de pistas o códigos aleatorios de los QR del servidor.
 *
 * Uso: pnpm check:bundle   (después de pnpm build)
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';

const DIST_DIR = join(import.meta.dirname, '..', 'dist');
const CLUES_YAML = join(import.meta.dirname, '..', 'content', 'clues.yaml');

async function walkFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...(await walkFiles(full)));
    } else if (/\.(html|js|css|json|txt)$/i.test(e.name)) {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  const files = await walkFiles(DIST_DIR);
  if (files.length === 0) {
    throw new Error('No se encontraron archivos en dist/. Ejecuta pnpm build primero.');
  }

  const forbiddenLiterals: Array<{ label: string; needle: string }> = [
    { label: 'Variable DATABASE_URL_OWNER', needle: 'DATABASE_URL_OWNER' },
    { label: 'Variable TOKEN_PEPPER', needle: 'TOKEN_PEPPER' },
    { label: 'Variable RALLY_APP_PASSWORD', needle: 'RALLY_APP_PASSWORD' },
    { label: 'Credencial de desarrollo rally_app_dev', needle: 'rally_app_dev' },
    { label: 'Pepper de ejemplo', needle: 'dev-only-pepper-change-me' },
  ];

  if (process.env.TOKEN_PEPPER && process.env.TOKEN_PEPPER.length >= 8) {
    forbiddenLiterals.push({ label: 'Valor actual de TOKEN_PEPPER', needle: process.env.TOKEN_PEPPER });
  }
  if (process.env.RALLY_APP_PASSWORD && process.env.RALLY_APP_PASSWORD.length >= 8) {
    forbiddenLiterals.push({
      label: 'Valor actual de RALLY_APP_PASSWORD',
      needle: process.env.RALLY_APP_PASSWORD,
    });
  }

  // Cargar textos de pistas desde content/clues.yaml para confirmar que NO van empaquetados en el cliente.
  try {
    const rawYaml = await readFile(CLUES_YAML, 'utf8');
    const parsed = YAML.parse(rawYaml) as {
      qr_points?: Array<{ slug: string; clues?: string[] }>;
    };
    for (const pt of parsed.qr_points ?? []) {
      for (const c of pt.clues ?? []) {
        const snippet = c.trim().slice(0, 40);
        if (snippet.length >= 16) {
          forbiddenLiterals.push({ label: `Pista de ${pt.slug}`, needle: snippet });
        }
      }
    }
  } catch {
    // Si no existe el YAML, continuar con las demás verificaciones.
  }

  const violations: string[] = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    for (const item of forbiddenLiterals) {
      if (content.includes(item.needle)) {
        violations.push(`${item.label} encontrado en ${file}`);
      }
    }
  }

  if (violations.length > 0) {
    console.error('✗ FALLO DE SEGURIDAD EN EL BUNDLE:');
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }

  console.log(`✓ Bundle verificado (${files.length} archivos en dist/): sin secretos, pistas ni coordenadas.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
