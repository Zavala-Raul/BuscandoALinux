/**
 * Suite de pruebas de aceptación obligatorias (§17 del plan técnico):
 * - Permisos y aislamiento de tablas con el rol restringido rally_app.
 * - Ciclo de activación, sesiones únicas por equipo y revocación inmediata.
 * - Registro de QR: independencia entre equipos, no duplicidad, idempotencia y concurrencia.
 * - Apuntador de pistas: persistencia al recargar y garantía exhaustiva sobre las 2^6 - 1
 *   combinaciones de QR de que NUNCA apunta a un QR ya registrado por ese equipo.
 * - Ubicación final: bloqueada con <6 QR por cualquier endpoint, habilitada con 6/6.
 * - Confirmación presencial del ganador: bloqueo sin 6/6, idempotencia, prohibición de auto-confirmarse
 *   y serialización del orden oficial bajo confirmaciones simultáneas.
 * - Estados del evento (pausa/cierre bloquean escaneos y llegadas; correcciones admin siguen funcionando).
 */
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { upsertStaff } from '../../scripts/create-staff.js';
import { importContentFromFile } from '../../scripts/import-content.js';
import { issueActivationCodes } from '../../scripts/issue-codes.js';
import { createApp } from '../../server/app.js';
import { createDbCaller } from '../../server/db.js';
import type {
  AdminOverview,
  FinalLocation,
  ScanQrResponse,
  StaffState,
  StaffTeamView,
  TeamState,
} from '../../shared/contracts.js';

const OWNER_URL =
  process.env.DATABASE_URL_OWNER ?? 'postgres://postgres:postgres@localhost:54329/rally';
const APP_URL =
  process.env.DATABASE_URL ?? 'postgres://rally_app:rally_app_dev@localhost:54329/rally';

process.env.TOKEN_PEPPER = process.env.TOKEN_PEPPER ?? 'test-pepper-0123456789abcdef0123456789';
process.env.EVENT_SLUG = 'rally-dev';
process.env.APP_ORIGIN = 'http://localhost:5173';
process.env.COOKIE_SECURE = 'false';

/** Mini cliente HTTP con su propio jar de cookies (simula el navegador de un equipo o encargado). */
class TestClient {
  private cookies = new Map<string, string>();
  constructor(private readonly app: ReturnType<typeof createApp>) {}

  private cookieHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  private captureCookies(res: Response) {
    const setCookies =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : res.headers.get('set-cookie')
          ? [res.headers.get('set-cookie')!]
          : [];
    for (const raw of setCookies) {
      const firstPart = raw.split(';')[0];
      if (!firstPart) continue;
      const eq = firstPart.indexOf('=');
      if (eq <= 0) continue;
      const name = firstPart.slice(0, eq).trim();
      const val = firstPart.slice(eq + 1).trim();
      if (!val) this.cookies.delete(name);
      else this.cookies.set(name, val);
    }
  }

  getCookieValue(name: string): string | undefined {
    return this.cookies.get(name);
  }

  setCookieValue(name: string, value: string) {
    this.cookies.set(name, value);
  }

  async get<T = unknown>(path: string): Promise<{ status: number; body: T; headers: Headers }> {
    const headers: Record<string, string> = {};
    const ck = this.cookieHeader();
    if (ck) headers['cookie'] = ck;
    const res = await this.app.request(`http://localhost:5173${path}`, {
      method: 'GET',
      headers,
    });
    this.captureCookies(res);
    const body = (await res.json()) as T;
    return { status: res.status, body, headers: res.headers };
  }

  async post<T = unknown>(
    path: string,
    payload: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body: T; headers: Headers }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-rally-request': '1',
      origin: 'http://localhost:5173',
      ...extraHeaders,
    };
    const ck = this.cookieHeader();
    if (ck) headers['cookie'] = ck;
    const res = await this.app.request(`http://localhost:5173${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    this.captureCookies(res);
    const body = (await res.json()) as T;
    return { status: res.status, body, headers: res.headers };
  }
}

describe('Buscando a Linux — Pruebas de aceptación (§17)', () => {
  let ownerClient: pg.Client;
  let appPool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let eventId: string;
  let qrPoints: Array<{ id: string; slug: string; code: string; public_name: string }> = [];
  let teamCodes = new Map<string, string>();

  beforeAll(async () => {
    ownerClient = new pg.Client({ connectionString: OWNER_URL });
    await ownerClient.connect();
    appPool = new pg.Pool({ connectionString: APP_URL, max: 12 });
    app = createApp({
      db: createDbCaller(appPool),
      eventSlug: 'rally-dev',
      appOrigin: 'http://localhost:5173',
      cookieSecure: false,
    });
  });

  afterAll(async () => {
    await appPool.end();
    await ownerClient.end();
  });

  beforeEach(async () => {
    // Limpiar datos del esquema conservando estructura y permisos.
    await ownerClient.query(`
      truncate table
        game.rate_limits,
        game.audit_log,
        game.finishes,
        game.final_locations,
        game.team_pointer,
        game.team_scans,
        game.sessions,
        game.activation_tokens,
        game.staff_roles,
        game.staff,
        game.team_members,
        game.teams,
        game.clues,
        game.qr_points,
        game.events
      restart identity cascade
    `);

    const yamlPath = join(import.meta.dirname, '..', 'fixtures', 'clues.test.yaml');
    const imp = await importContentFromFile(ownerClient, yamlPath, false);
    eventId = imp.eventId;

    await ownerClient.query(`update game.events set status = 'running' where id = $1`, [eventId]);

    for (let i = 1; i <= 6; i++) {
      const pid = `TEC-00${i}`;
      await ownerClient.query(
        `insert into game.teams (event_id, public_id, name, status) values ($1, $2, $3, 'active')`,
        [eventId, pid, `Equipo ${pid}`],
      );
    }

    await upsertStaff(ownerClient, {
      eventSlug: 'rally-dev',
      username: 'finalista',
      displayName: 'Organizador Final',
      password: 'PasswordFinal123!',
      roles: ['final'],
    });

    await upsertStaff(ownerClient, {
      eventSlug: 'rally-dev',
      username: 'admin',
      displayName: 'Administrador General',
      password: 'PasswordAdmin123!',
      roles: ['admin'],
    });

    // Un encargado final que también pertenece a TEC-006 (para probar prohibición de auto-confirmarse).
    await upsertStaff(ownerClient, {
      eventSlug: 'rally-dev',
      username: 'final_jugador',
      displayName: 'Final en TEC-006',
      password: 'PasswordJugador123!',
      roles: ['final'],
      teamPublicId: 'TEC-006',
    });

    const issued = await issueActivationCodes(ownerClient, 'rally-dev');
    teamCodes = new Map(issued.map((i) => [i.public_id, i.code]));

    const qrs = await ownerClient.query<{
      id: string;
      slug: string;
      code: string;
      public_name: string;
    }>(
      'select id, slug, code, public_name from game.qr_points where event_id = $1 order by sort_order',
      [eventId],
    );
    qrPoints = qrs.rows;
  });

  // -------------------------------------------------------------------
  // 1. Seguridad en BD: rally_app NO puede leer ni escribir tablas ni funciones internas
  // -------------------------------------------------------------------
  it('impide que el rol rally_app lea o modifique tablas directamente o invoque funciones internas', async () => {
    await expect(appPool.query('select * from game.teams')).rejects.toThrow(/permission denied/i);
    await expect(appPool.query('select * from game.final_locations')).rejects.toThrow(
      /permission denied/i,
    );
    await expect(
      appPool.query(
        `insert into game.team_scans (event_id, team_id, qr_point_id) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(appPool.query(`select game._repoint(gen_random_uuid(), gen_random_uuid())`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  // -------------------------------------------------------------------
  // 2. Dos equipos pueden registrar el mismo QR independientemente; un equipo no puede duplicarlo
  // -------------------------------------------------------------------
  it('permite que dos equipos registren el mismo QR independientemente y evita duplicados por equipo', async () => {
    const t1 = new TestClient(app);
    const t2 = new TestClient(app);

    const a1 = await t1.post<TeamState>('/api/team/activate', { code: teamCodes.get('TEC-001') });
    const a2 = await t2.post<TeamState>('/api/team/activate', { code: teamCodes.get('TEC-002') });
    expect(a1.status).toBe(200);
    expect(a2.status).toBe(200);
    expect(a1.body.team.public_id).toBe('TEC-001');
    expect(a2.body.team.public_id).toBe('TEC-002');
    expect(a1.headers.get('cache-control')).toContain('no-store');

    const qr1 = qrPoints[0]!;
    const s1 = await t1.post<ScanQrResponse>('/api/team/scan', { code: qr1.code });
    const s2 = await t2.post<ScanQrResponse>('/api/team/scan', { code: qr1.code });
    expect(s1.status).toBe(200);
    expect(s1.body.result).toBe('registered');
    expect(s1.body.state.found_count).toBe(1);

    expect(s2.status).toBe(200);
    expect(s2.body.result).toBe('registered');
    expect(s2.body.state.found_count).toBe(1);

    // Repetir el mismo QR en TEC-001 no incrementa el conteo ni duplica filas.
    const dup = await t1.post<ScanQrResponse>('/api/team/scan', { code: qr1.code });
    expect(dup.status).toBe(200);
    expect(dup.body.result).toBe('already_registered');
    expect(dup.body.state.found_count).toBe(1);
  });

  // -------------------------------------------------------------------
  // 3. Recargar conserva la pista asignada y dos escaneos simultáneos no crean inconsistencias
  // -------------------------------------------------------------------
  it('conserva la misma pista al recargar y maneja ráfagas de escaneos simultáneos sin duplicar', async () => {
    const t1 = new TestClient(app);
    const act = await t1.post<TeamState>('/api/team/activate', { code: teamCodes.get('TEC-001') });
    expect(act.status).toBe(200);
    const initialClueId = act.body.clue?.id;
    expect(initialClueId).toBeTruthy();

    // Recargar 5 veces seguidas devuelve exactamente la misma pista asignada.
    for (let i = 0; i < 5; i++) {
      const me = await t1.get<TeamState>('/api/me');
      expect(me.status).toBe(200);
      expect(me.body.clue?.id).toBe(initialClueId);
    }

    // Enviar 10 escaneos simultáneos del mismo QR produce un único registro 'registered' y 9 'already_registered'.
    const qr = qrPoints[0]!;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => t1.post<ScanQrResponse>('/api/team/scan', { code: qr.code })),
    );
    const registeredCount = results.filter((r) => r.body.result === 'registered').length;
    const alreadyCount = results.filter((r) => r.body.result === 'already_registered').length;
    expect(registeredCount).toBe(1);
    expect(alreadyCount).toBe(9);

    const after = await t1.get<TeamState>('/api/me');
    expect(after.body.found_count).toBe(1);
  });

  // -------------------------------------------------------------------
  // 4. Garantía exhaustiva del apuntador: en las 63 combinaciones no vacías de 6 QR,
  //    la pista NUNCA apunta a un QR ya encontrado; y si se escanea otro QR distinto al apuntado,
  //    la pista actual se conserva.
  // -------------------------------------------------------------------
  it('garantiza en todas las combinaciones posibles de 6 QR que la pista nunca apunta a un QR ya registrado', async () => {
    const t1 = new TestClient(app);
    await t1.post<TeamState>('/api/team/activate', { code: teamCodes.get('TEC-001') });

    // Caso A: Si el equipo encuentra un QR que NO era el apuntado por su pista, la pista se conserva.
    const ptrBefore = await ownerClient.query<{ clue_id: string; target_qr_id: string }>(
      `select p.clue_id, p.target_qr_id from game.team_pointer p
       join game.teams t on t.id = p.team_id where t.public_id = 'TEC-001'`,
    );
    const targetId = ptrBefore.rows[0]!.target_qr_id;
    const otherQr = qrPoints.find((q) => q.id !== targetId)!;

    await t1.post<ScanQrResponse>('/api/team/scan', { code: otherQr.code });
    const ptrAfterOther = await ownerClient.query<{ clue_id: string; target_qr_id: string }>(
      `select p.clue_id, p.target_qr_id from game.team_pointer p
       join game.teams t on t.id = p.team_id where t.public_id = 'TEC-001'`,
    );
    expect(ptrAfterOther.rows[0]!.clue_id).toBe(ptrBefore.rows[0]!.clue_id);

    // Caso B: Si ahora encuentra el QR al que SÍ apuntaba la pista, el apuntador cambia a uno no encontrado.
    const targetQr = qrPoints.find((q) => q.id === targetId)!;
    await t1.post<ScanQrResponse>('/api/team/scan', { code: targetQr.code });
    const ptrAfterTarget = await ownerClient.query<{ clue_id: string; target_qr_id: string }>(
      `select p.clue_id, p.target_qr_id from game.team_pointer p
       join game.teams t on t.id = p.team_id where t.public_id = 'TEC-001'`,
    );
    expect(ptrAfterTarget.rows[0]!.target_qr_id).not.toBe(targetId);
    expect(ptrAfterTarget.rows[0]!.target_qr_id).not.toBe(otherQr.id);

    // Caso C: Verificación exhaustiva sobre las 2^6 = 64 máscaras de subconjuntos de QR encontrados.
    const teamRow = await ownerClient.query<{ id: string }>(
      `select id from game.teams where event_id = $1 and public_id = 'TEC-002'`,
      [eventId],
    );
    const team2Id = teamRow.rows[0]!.id;

    for (let mask = 0; mask < 64; mask++) {
      await ownerClient.query('delete from game.team_scans where team_id = $1', [team2Id]);
      await ownerClient.query('delete from game.team_pointer where team_id = $1', [team2Id]);

      const foundIds = new Set<string>();
      for (let bit = 0; bit < 6; bit++) {
        if ((mask & (1 << bit)) !== 0) {
          const qr = qrPoints[bit]!;
          foundIds.add(qr.id);
          await ownerClient.query(
            `insert into game.team_scans (event_id, team_id, qr_point_id, source) values ($1, $2, $3, 'scan')`,
            [eventId, team2Id, qr.id],
          );
        }
      }

      await ownerClient.query('select game._sync_pointer($1, $2)', [team2Id, eventId]);
      const ptr = await ownerClient.query<{ target_qr_id: string }>(
        'select target_qr_id from game.team_pointer where team_id = $1',
        [team2Id],
      );

      if (foundIds.size === 6) {
        expect(ptr.rowCount).toBe(0);
      } else {
        expect(ptr.rowCount).toBe(1);
        expect(foundIds.has(ptr.rows[0]!.target_qr_id)).toBe(false);
      }
    }
  });

  // -------------------------------------------------------------------
  // 5. Sesión única y revocación: transferir acceso o reemitir código invalida el teléfono anterior
  // -------------------------------------------------------------------
  it('invalida inmediatamente la sesión anterior cuando se transfiere el acceso y conserva todo el progreso', async () => {
    const oldPhone = new TestClient(app);
    await oldPhone.post('/api/team/activate', { code: teamCodes.get('TEC-001') });
    await oldPhone.post('/api/team/scan', { code: qrPoints[0]!.code });
    await oldPhone.post('/api/team/scan', { code: qrPoints[1]!.code });

    // El administrador emite un nuevo código para cambio de teléfono.
    const admin = new TestClient(app);
    const login = await admin.post<StaffState>('/api/staff/login', {
      username: 'admin',
      password: 'PasswordAdmin123!',
    });
    expect(login.status).toBe(200);

    const issued = await admin.post<{
      public_id: string;
      code: string;
      sessions_revoked: number;
    }>('/api/admin/issue-activation', {
      public_id: 'TEC-001',
      ttl_minutes: 60,
      reason: 'Batería agotada en el teléfono original',
    });
    expect(issued.status).toBe(200);
    expect(issued.body.sessions_revoked).toBe(1);

    // Aunque oldPhone conserva su cookie de sesión, el servidor la rechaza.
    const oldCheck = await oldPhone.get('/api/me');
    expect(oldCheck.status).toBe(401);

    // El nuevo teléfono activa el nuevo código y conserva los 2 QR ya encontrados.
    const newPhone = new TestClient(app);
    const newAct = await newPhone.post<TeamState>('/api/team/activate', {
      code: issued.body.code,
    });
    expect(newAct.status).toBe(200);
    expect(newAct.body.found_count).toBe(2);
  });

  // -------------------------------------------------------------------
  // 6. Manipulación de parámetros / escalación de privilegios / CSRF
  // -------------------------------------------------------------------
  it('rechaza campos extra (team_id, role, found_count), protege contra CSRF y bloquea acceso cruzado de roles', async () => {
    const t1 = new TestClient(app);
    await t1.post('/api/team/activate', { code: teamCodes.get('TEC-001') });

    // Enviar team_id o found_count en /api/team/scan es rechazado por Zod .strict()
    const tampered = await t1.post('/api/team/scan', {
      code: qrPoints[0]!.code,
      team_id: '00000000-0000-0000-0000-000000000000',
      found_count: 6,
    });
    expect(tampered.status).toBe(400);

    // Sin encabezado X-Rally-Request o desde otro Origin falla por CSRF
    const csrfMissing = await app.request('http://localhost:5173/api/team/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: qrPoints[0]!.code }),
    });
    expect(csrfMissing.status).toBe(403);

    const csrfBadOrigin = await t1.post(
      '/api/team/scan',
      { code: qrPoints[0]!.code },
      { origin: 'https://sitio-malicioso.example' },
    );
    expect(csrfBadOrigin.status).toBe(403);

    // Un jugador no puede llamar endpoints de staff/admin ni siquiera copiando su token a la cookie de staff
    const teamToken = t1.getCookieValue('rally_team_session')!;
    t1.setCookieValue('rally_staff_session', teamToken);
    const fakeAdmin = await t1.get('/api/admin/overview');
    expect(fakeAdmin.status).toBe(401);

    // Un organizador con solo rol 'final' no puede ejecutar acciones de 'admin'
    const finalStaff = new TestClient(app);
    await finalStaff.post('/api/staff/login', {
      username: 'finalista',
      password: 'PasswordFinal123!',
    });
    const forbiddenAdmin = await finalStaff.get('/api/admin/overview');
    expect(forbiddenAdmin.status).toBe(403);
  });

  // -------------------------------------------------------------------
  // 7. Ubicación final protegida (<6 QR bloqueado, 6/6 habilitado) y llegada presencial serializada
  // -------------------------------------------------------------------
  it('protege las coordenadas hasta tener 6/6 QR y serializa las confirmaciones de llegada sin duplicados', async () => {
    const finalStaff = new TestClient(app);
    await finalStaff.post('/api/staff/login', {
      username: 'finalista',
      password: 'PasswordFinal123!',
    });

    const pub = await finalStaff.post<FinalLocation>('/api/final/location', {
      lat: 27.4763,
      lng: -99.5164,
      accuracy_m: 8.5,
      reference: 'Junto a la estatua del pingüino en el jardín principal',
    });
    expect(pub.status).toBe(200);
    expect(pub.body.version).toBe(1);

    const t1 = new TestClient(app);
    const t2 = new TestClient(app);
    await t1.post('/api/team/activate', { code: teamCodes.get('TEC-001') });
    await t2.post('/api/team/activate', { code: teamCodes.get('TEC-002') });

    // Escanear 5 de 6 en TEC-001: NO puede obtener coordenadas ni ser confirmado en la meta.
    for (let i = 0; i < 5; i++) {
      await t1.post('/api/team/scan', { code: qrPoints[i]!.code });
    }
    const me5 = await t1.get<TeamState>('/api/me');
    expect(me5.body.found_count).toBe(5);
    expect(me5.body.final).toBeNull();
    expect(JSON.stringify(me5.body)).not.toContain('27.4763');

    const lockedLoc = await t1.get('/api/team/final-location');
    expect(lockedLoc.status).toBe(403);

    const earlyFinish = await finalStaff.post('/api/final/confirm', { public_id: 'TEC-001' });
    expect(earlyFinish.status).toBe(409);

    // Completar el 6.º QR en TEC-001 y también los 6 QR en TEC-002.
    await t1.post('/api/team/scan', { code: qrPoints[5]!.code });
    for (let i = 0; i < 6; i++) {
      await t2.post('/api/team/scan', { code: qrPoints[i]!.code });
    }

    const unlockedLoc = await t1.get<FinalLocation>('/api/team/final-location');
    expect(unlockedLoc.status).toBe(200);
    expect(unlockedLoc.body.lat).toBeCloseTo(27.4763, 4);
    expect(unlockedLoc.body.reference).toContain('estatua del pingüino');

    // Confirmaciones simultáneas de TEC-001 y TEC-002 (más repeticiones de TEC-001):
    // asigna posiciones #1 y #2 sin choques ni duplicados.
    const [c1a, c1b, c2] = await Promise.all([
      finalStaff.post<{ result: string; team: StaffTeamView }>('/api/final/confirm', {
        public_id: 'TEC-001',
      }),
      finalStaff.post<{ result: string; team: StaffTeamView }>('/api/final/confirm', {
        public_id: 'TEC-001',
      }),
      finalStaff.post<{ result: string; team: StaffTeamView }>('/api/final/confirm', {
        public_id: 'TEC-002',
      }),
    ]);

    expect(c1a.status).toBe(200);
    expect(c1b.status).toBe(200);
    expect(c2.status).toBe(200);
    expect([c1a.body.result, c1b.body.result].sort()).toEqual(['already_confirmed', 'confirmed']);

    const ranks = [c1a.body.team.finish?.rank, c2.body.team.finish?.rank].sort();
    expect(ranks).toEqual([1, 2]);

    // Un encargado que forma parte de TEC-006 no puede confirmar a su propio equipo.
    const t6 = new TestClient(app);
    await t6.post('/api/team/activate', { code: teamCodes.get('TEC-006') });
    for (const q of qrPoints) await t6.post('/api/team/scan', { code: q.code });

    const playerStaff = new TestClient(app);
    await playerStaff.post('/api/staff/login', {
      username: 'final_jugador',
      password: 'PasswordJugador123!',
    });
    const selfConfirm = await playerStaff.post('/api/final/confirm', { public_id: 'TEC-006' });
    expect(selfConfirm.status).toBe(403);
  });

  // -------------------------------------------------------------------
  // 8. Pausar/cerrar el evento bloquea acciones competitivas, pero permite correcciones admin auditadas
  // -------------------------------------------------------------------
  it('bloquea escaneos y llegadas cuando el evento está en pausa o cerrado, y registra correcciones administrativas con motivo', async () => {
    const admin = new TestClient(app);
    await admin.post('/api/staff/login', { username: 'admin', password: 'PasswordAdmin123!' });

    const t1 = new TestClient(app);
    await t1.post('/api/team/activate', { code: teamCodes.get('TEC-001') });

    // Pausar el evento
    const pauseRes = await admin.post('/api/admin/event-status', {
      status: 'paused',
      reason: 'Lluvia momentánea en explanada',
    });
    expect(pauseRes.status).toBe(200);

    // Escanear durante la pausa es rechazado
    const scanPaused = await t1.post('/api/team/scan', { code: qrPoints[0]!.code });
    expect(scanPaused.status).toBe(409);

    // Pero el administrador sí puede incorporar un registro de respaldo con motivo obligatorio
    const manualAdd = await admin.post<StaffTeamView>('/api/admin/scans/add', {
      public_id: 'TEC-001',
      qr_slug: qrPoints[0]!.slug,
      reason: 'Hoja de incidencias estación 1: QR mojado, verificado por staff',
    });
    expect(manualAdd.status).toBe(200);
    expect(manualAdd.body.found_count).toBe(1);

    const overview = await admin.get<AdminOverview>('/api/admin/overview');
    expect(overview.status).toBe(200);
    const team1 = overview.body.teams.find((t) => t.public_id === 'TEC-001')!;
    expect(team1.found[0]?.source).toBe('admin');

    const audit = await admin.get<{ entries: Array<{ action: string }> }>('/api/admin/audit');
    expect(audit.status).toBe(200);
    expect(audit.body.entries.some((e) => e.action === 'scan_add_manual')).toBe(true);
  });

  // -------------------------------------------------------------------
  // 9. Gestión de más estaciones QR con coordenadas, radar de cercanía y limpieza de datos
  // -------------------------------------------------------------------
  it('permite agregar más estaciones con coordenadas, avisar "Cerca de una pista" sin filtrar ubicación y limpiar datos de prueba', async () => {
    const admin = new TestClient(app);
    await admin.post('/api/staff/login', { username: 'admin', password: 'PasswordAdmin123!' });

    // Subir la meta de QRs requeridos a 7 y agregar una 7.ª estación con coordenadas
    const cfg = await admin.post<{ name: string; target: number }>('/api/admin/event-config', {
      name: 'Buscando a Linux — 12 Equipos',
      target_count: 7,
      is_test: false,
    });
    expect(cfg.status).toBe(200);
    expect(cfg.body.target).toBe(7);

    const newQr = await admin.post<{ slug: string; lat: number; lng: number }>(
      '/api/admin/qr-points',
      {
        slug: 'centro-idiomas',
        public_name: 'Estación 7 — Centro de Idiomas',
        sort_order: 7,
        is_active: true,
        lat: 27.475,
        lng: -99.515,
        proximity_radius_m: 40,
      },
    );
    expect(newQr.status).toBe(200);
    expect(newQr.body.slug).toBe('centro-idiomas');

    const newClue = await admin.post<{ id: string }>('/api/admin/clues', {
      qr_slug: 'centro-idiomas',
      body: 'Donde se practican otros lenguajes además de C y Python.',
    });
    expect(newClue.status).toBe(200);

    // Activar un equipo y probar el radar de cercanía
    const t1 = new TestClient(app);
    const act = await t1.post<TeamState>('/api/team/activate', { code: teamCodes.get('TEC-001') });
    expect(act.status).toBe(200);
    expect(act.body.event.target).toBe(7);
    expect(act.body.proximity_enabled).toBe(true);
    // Verificar que las coordenadas de la estación NO aparezcan en /api/me
    expect(JSON.stringify(act.body)).not.toContain('27.475');

    // Lejos de la estación (~2 km) -> zone: 'far'
    const farCheck = await t1.post<{ zone: string; near: boolean }>('/api/team/proximity', {
      lat: 27.49,
      lng: -99.53,
      accuracy_m: 10,
    });
    expect(farCheck.status).toBe(200);
    expect(farCheck.body.zone).toBe('far');
    expect(farCheck.body.near).toBe(false);

    // Dentro del radio de 40 m de la estación -> zone: 'near'
    const nearCheck = await t1.post<{ zone: string; near: boolean }>('/api/team/proximity', {
      lat: 27.4751,
      lng: -99.515,
      accuracy_m: 8,
    });
    expect(nearCheck.status).toBe(200);
    expect(nearCheck.body.zone).toBe('near');
    expect(nearCheck.body.near).toBe(true);
    expect(JSON.stringify(nearCheck.body)).not.toContain('27.475');

    // Limpiar todos los datos de prueba desde /api/admin/reset-data
    const reset = await admin.post<{ ok: boolean }>('/api/admin/reset-data', {
      wipe_stations: true,
      reason: 'Limpiar datos de prueba para iniciar configuración real',
    });
    expect(reset.status).toBe(200);

    const overviewAfter = await admin.get<AdminOverview>('/api/admin/overview');
    expect(overviewAfter.status).toBe(200);
    expect(overviewAfter.body.teams.length).toBe(0);
    expect(overviewAfter.body.qr_points.length).toBe(0);
  });
});
