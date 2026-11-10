/**
 * Simulación de carga y ráfaga inicial (§17 del plan técnico):
 * - 10 equipos (TEC-001 .. TEC-010) activando su sesión simultáneamente al arranque.
 * - Ráfaga concurrente de escaneos y consultas /api/me para los 10 equipos hasta completar los 6 QR.
 * - Verificación de balanceo de apuntadores, latencias (p50, p95, máx), cero errores 5xx y serialización
 *   de las 10 confirmaciones presenciales finales.
 *
 * Uso: npx tsx --env-file=.env scripts/load-test.ts
 */
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { upsertStaff } from './create-staff.js';
import { importContentFromFile } from './import-content.js';
import { issueActivationCodes } from './issue-codes.js';
import { requireEnv } from './lib/env.js';
import { createApp } from '../server/app.js';
import { createDbCaller } from '../server/db.js';
import type { ScanQrResponse, StaffTeamView, TeamState } from '../shared/contracts.js';

class LoadClient {
  private cookies = new Map<string, string>();
  constructor(
    private readonly app: ReturnType<typeof createApp>,
    private readonly latencies: number[],
  ) {}

  private cookieHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  private captureCookies(res: Response) {
    const list =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : res.headers.get('set-cookie')
          ? [res.headers.get('set-cookie')!]
          : [];
    for (const raw of list) {
      const first = raw.split(';')[0];
      if (!first) continue;
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      this.cookies.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
  }

  async post<T>(path: string, body: unknown): Promise<{ status: number; data: T }> {
    const t0 = performance.now();
    const res = await this.app.request(`http://localhost:5173${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rally-request': '1',
        origin: 'http://localhost:5173',
        cookie: this.cookieHeader(),
      },
      body: JSON.stringify(body),
    });
    this.latencies.push(performance.now() - t0);
    this.captureCookies(res);
    return { status: res.status, data: (await res.json()) as T };
  }

  async get<T>(path: string): Promise<{ status: number; data: T }> {
    const t0 = performance.now();
    const res = await this.app.request(`http://localhost:5173${path}`, {
      method: 'GET',
      headers: { cookie: this.cookieHeader() },
    });
    this.latencies.push(performance.now() - t0);
    this.captureCookies(res);
    return { status: res.status, data: (await res.json()) as T };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

async function main() {
  const owner = new pg.Client({ connectionString: requireEnv('DATABASE_URL_OWNER') });
  await owner.connect();
  const appPool = new pg.Pool({ connectionString: requireEnv('DATABASE_URL'), max: 15 });
  const app = createApp({
    db: createDbCaller(appPool),
    eventSlug: 'rally-dev',
    appOrigin: 'http://localhost:5173',
    cookieSecure: false,
  });

  const latencies: number[] = [];

  try {
    await owner.query(`
      truncate table
        game.rate_limits, game.audit_log, game.finishes, game.final_locations,
        game.team_pointer, game.team_scans, game.sessions, game.activation_tokens,
        game.staff_roles, game.staff, game.team_members, game.teams, game.clues,
        game.qr_points, game.events
      restart identity cascade
    `);

    const yamlPath = join(import.meta.dirname, '..', 'tests', 'fixtures', 'clues.test.yaml');
    const { eventId } = await importContentFromFile(owner, yamlPath, false);
    await owner.query(`update game.events set status = 'running' where id = $1`, [eventId]);

    for (let i = 1; i <= 10; i++) {
      const pid = `TEC-${String(i).padStart(3, '0')}`;
      await owner.query(
        `insert into game.teams (event_id, public_id, name, status) values ($1, $2, $3, 'active')`,
        [eventId, pid, `Equipo ${pid}`],
      );
    }

    await upsertStaff(owner, {
      eventSlug: 'rally-dev',
      username: 'organizador',
      displayName: 'Organizador Final',
      password: 'LoadTestPassword123!',
      roles: ['final', 'admin'],
    });

    const issued = await issueActivationCodes(owner, 'rally-dev');
    const qrs = (
      await owner.query<{ code: string }>(
        'select code from game.qr_points where event_id = $1 order by sort_order',
        [eventId],
      )
    ).rows;

    // 1. Ráfaga de activación simultánea de los 10 equipos
    const teamClients = issued.map((item) => ({
      public_id: item.public_id,
      code: item.code,
      client: new LoadClient(app, latencies),
    }));

    const activations = await Promise.all(
      teamClients.map((tc) => tc.client.post<TeamState>('/api/team/activate', { code: tc.code })),
    );
    for (const a of activations) {
      if (a.status !== 200) throw new Error(`Fallo en activación: status ${a.status}`);
    }

    // 2. El organizador publica la ubicación final
    const staffClient = new LoadClient(app, latencies);
    await staffClient.post('/api/staff/login', {
      username: 'organizador',
      password: 'LoadTestPassword123!',
    });
    await staffClient.post('/api/final/location', {
      lat: 27.4763,
      lng: -99.5164,
      accuracy_m: 6,
      reference: 'Explanada central ITNL',
    });

    // 3. Ráfaga de escaneos y consultas concurrentes para los 10 equipos por los 6 QR
    await Promise.all(
      teamClients.map(async (tc, teamIdx) => {
        for (let step = 0; step < qrs.length; step++) {
          const qr = qrs[(step + teamIdx) % qrs.length]!;
          const scan = await tc.client.post<ScanQrResponse>('/api/team/scan', { code: qr.code });
          if (scan.status !== 200) {
            throw new Error(`Error en scan de ${tc.public_id}: ${scan.status}`);
          }
          const me = await tc.client.get<TeamState>('/api/me');
          if (me.status !== 200) {
            throw new Error(`Error en /me de ${tc.public_id}: ${me.status}`);
          }
        }
        const loc = await tc.client.get('/api/team/final-location');
        if (loc.status !== 200) {
          throw new Error(`No se desbloqueó ubicación final para ${tc.public_id}: ${loc.status}`);
        }
      }),
    );

    // 4. Confirmaciones presenciales concurrentes de los 10 equipos
    const finishes = await Promise.all(
      teamClients.map((tc) =>
        staffClient.post<{ result: string; team: StaffTeamView }>('/api/final/confirm', {
          public_id: tc.public_id,
        }),
      ),
    );
    const assignedRanks = finishes
      .map((f) => f.data.team.finish?.rank ?? 0)
      .sort((a, b) => a - b);

    if (JSON.stringify(assignedRanks) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])) {
      throw new Error(`Posiciones mal serializadas: ${assignedRanks.join(', ')}`);
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    console.log(`✓ Prueba de carga completada sin errores:`);
    console.log(`  - Operaciones totales: ${sorted.length}`);
    console.log(`  - Latencia p50: ${percentile(sorted, 50).toFixed(1)} ms`);
    console.log(`  - Latencia p95: ${percentile(sorted, 95).toFixed(1)} ms`);
    console.log(`  - Latencia máx: ${sorted[sorted.length - 1]!.toFixed(1)} ms`);
    console.log(`  - Posiciones asignadas en serie: 1..10 sin colisiones`);
  } finally {
    await appPool.end();
    await owner.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
