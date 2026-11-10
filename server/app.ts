/**
 * API HTTP del rally (Hono).
 * - Todas las respuestas llevan Cache-Control: no-store.
 * - Sesiones en cookies HttpOnly + SameSite=Strict (y Secure en prod).
 * - Protección CSRF en mutaciones: requiere encabezado X-Rally-Request: 1 y valida Origin si está presente.
 * - Límites de solicitudes en Postgres por cuenta/sesión y por IP (umbral alto para red compartida del campus).
 * - Ninguna operación acepta team_id del cliente para decidir sobre qué equipo actuar.
 */
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { z } from 'zod';
import {
  ActivateTeamInput,
  AdminAddClueInput,
  AdminCreateTeamInput,
  AdminDeleteClueInput,
  AdminDeleteQrPointInput,
  AdminDeleteTeamInput,
  AdminIssueActivationInput,
  AdminResetEventDataInput,
  AdminScanCorrectionInput,
  AdminSetEventStatusInput,
  AdminSetTeamStatusInput,
  AdminUpdateEventInput,
  AdminUpsertQrPointInput,
  AdminVoidFinishInput,
  CheckProximityInput,
  ConfirmFinishInput,
  ERROR_MESSAGES,
  LookupTeamInput,
  PublishFinalLocationInput,
  ScanQrInput,
  StaffLoginInput,
} from '../shared/contracts.js';
import {
  generateActivationCode,
  generateQrCode,
  generateSessionToken,
  hashSecret,
  verifyPassword,
} from './crypto.js';
import { createDbCaller, GameError, type DbCaller } from './db.js';

export const TEAM_COOKIE = 'rally_team_session';
export const STAFF_COOKIE = 'rally_staff_session';
export const CLIENT_KEY_COOKIE = 'rally_client_key';

export interface AppOptions {
  db?: DbCaller;
  eventSlug?: string;
  appOrigin?: string;
  cookieSecure?: boolean;
}

function isCookieSecure(override?: boolean): boolean {
  if (typeof override === 'boolean') return override;
  if (process.env.COOKIE_SECURE === 'true') return true;
  if (process.env.COOKIE_SECURE === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

function respondError(c: Context, code: string) {
  const entry = ERROR_MESSAGES[code] ?? {
    status: 500,
    message: 'Ocurrió un error interno. Intenta de nuevo.',
  };
  return c.json({ error: { code, message: entry.message } }, entry.status as 400);
}

async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new GameError('bad_request');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new GameError('bad_request');
  }
  return parsed.data;
}

function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return c.req.header('x-real-ip')?.slice(0, 64) ?? 'local';
}

export function createApp(opts: AppOptions = {}) {
  const db = opts.db ?? createDbCaller();
  const getEventSlug = () => opts.eventSlug ?? process.env.EVENT_SLUG ?? 'rally-dev';
  const getAllowedOrigin = () => opts.appOrigin ?? process.env.APP_ORIGIN;
  const secure = isCookieSecure(opts.cookieSecure);

  const app = new Hono().basePath('/api');

  // Encabezados de seguridad y no-cache en todas las respuestas.
  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    c.header('Pragma', 'no-cache');
    c.header('Vary', 'Cookie');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
  });

  // Protección CSRF en mutaciones:
  // 1) Exige encabezado personalizado X-Rally-Request: 1 (no enviable por formularios cross-site simples).
  // 2) Si el navegador envía Origin, debe coincidir con APP_ORIGIN o el Host actual.
  app.use('*', async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      if (c.req.header('x-rally-request') !== '1') {
        return respondError(c, 'csrf_rejected');
      }
      const origin = c.req.header('origin');
      const allowed = getAllowedOrigin();
      if (origin && allowed) {
        try {
          const originHost = new URL(origin).host;
          const allowedHost = new URL(allowed).host;
          const reqHost = c.req.header('host');
          if (originHost !== allowedHost && originHost !== reqHost) {
            return respondError(c, 'csrf_rejected');
          }
        } catch {
          return respondError(c, 'csrf_rejected');
        }
      }
    }
    await next();
  });

  // Manejo centralizado de errores (nunca filtra consultas SQL, pilas ni secretos).
  app.onError((err, c) => {
    if (err instanceof GameError) {
      return respondError(c, err.code);
    }
    console.error('[api:error]', err instanceof Error ? err.message : 'unknown');
    return respondError(c, 'internal_error');
  });

  async function enforceRateLimit(key: string, windowSeconds: number, maxHits: number) {
    const allowed = await db.call<boolean>('rate_hit', [key, windowSeconds, maxHits]);
    if (!allowed) {
      throw new GameError('rate_limited');
    }
  }

  function requireTeamSessionHash(c: Context): string {
    const token = getCookie(c, TEAM_COOKIE);
    if (!token || token.length < 16 || token.length > 128) {
      throw new GameError('session_invalid');
    }
    return hashSecret('session', token);
  }

  function requireStaffSessionHash(c: Context): string {
    const token = getCookie(c, STAFF_COOKIE);
    if (!token || token.length < 16 || token.length > 128) {
      throw new GameError('session_invalid');
    }
    return hashSecret('session', token);
  }

  // -------------------------------------------------------------------
  // Salud
  // -------------------------------------------------------------------
  app.get('/health', (c) => c.json({ ok: true }));

  // -------------------------------------------------------------------
  // EQUIPOS
  // -------------------------------------------------------------------
  app.post('/team/activate', async (c) => {
    const ip = clientIp(c);
    // Umbral amplio por IP (varios equipos comparten el Wi-Fi del campus).
    await enforceRateLimit(`act:ip:${ip}`, 60, 40);

    const body = await parseBody(c, ActivateTeamInput);
    const codeHash = hashSecret('activation', body.code);
    await enforceRateLimit(`act:code:${codeHash.slice(0, 16)}`, 60, 8);

    let clientKey = getCookie(c, CLIENT_KEY_COOKIE);
    if (!clientKey || clientKey.length < 16) {
      clientKey = generateSessionToken();
      setCookie(c, CLIENT_KEY_COOKIE, clientKey, {
        httpOnly: true,
        secure,
        sameSite: 'Strict',
        path: '/api/team/activate',
        maxAge: 60 * 30,
      });
    }
    const clientKeyHash = hashSecret('client', clientKey);

    const sessionToken = generateSessionToken();
    const sessionHash = hashSecret('session', sessionToken);

    const state = await db.call('activate_team', [codeHash, sessionHash, clientKeyHash]);

    setCookie(c, TEAM_COOKIE, sessionToken, {
      httpOnly: true,
      secure,
      sameSite: 'Strict',
      path: '/',
      maxAge: 60 * 60 * 24,
    });

    return c.json(state);
  });

  app.get('/me', async (c) => {
    const sessionHash = requireTeamSessionHash(c);
    await enforceRateLimit(`me:${sessionHash.slice(0, 16)}`, 10, 30);
    const state = await db.call('get_my_state', [sessionHash]);
    return c.json(state);
  });

  app.post('/team/scan', async (c) => {
    const sessionHash = requireTeamSessionHash(c);
    const ip = clientIp(c);
    await enforceRateLimit(`scan:team:${sessionHash.slice(0, 16)}`, 10, 15);
    await enforceRateLimit(`scan:ip:${ip}`, 10, 120);

    const body = await parseBody(c, ScanQrInput);
    const result = await db.call('scan_qr', [sessionHash, body.code]);
    return c.json(result);
  });

  app.post('/team/proximity', async (c) => {
    const sessionHash = requireTeamSessionHash(c);
    await enforceRateLimit(`prox:${sessionHash.slice(0, 16)}`, 10, 12);
    const body = await parseBody(c, CheckProximityInput);
    const res = await db.call('check_proximity', [
      sessionHash,
      body.lat,
      body.lng,
      body.accuracy_m ?? null,
    ]);
    return c.json(res);
  });

  app.get('/team/final-location', async (c) => {
    const sessionHash = requireTeamSessionHash(c);
    await enforceRateLimit(`floc:${sessionHash.slice(0, 16)}`, 10, 20);
    const loc = await db.call('get_final_location', [sessionHash]);
    return c.json(loc);
  });

  // -------------------------------------------------------------------
  // STAFF: autenticación
  // -------------------------------------------------------------------
  app.post('/staff/login', async (c) => {
    const ip = clientIp(c);
    await enforceRateLimit(`slogin:ip:${ip}`, 60, 25);

    const body = await parseBody(c, StaffLoginInput);
    await enforceRateLimit(`slogin:user:${body.username}`, 60, 8);

    const lookup = await db.call<{ staff_id: string; password_hash: string } | null>(
      'staff_login_lookup',
      [getEventSlug(), body.username],
    );
    if (!lookup) {
      throw new GameError('invalid_credentials');
    }
    const valid = await verifyPassword(body.password, lookup.password_hash);
    if (!valid) {
      throw new GameError('invalid_credentials');
    }

    const sessionToken = generateSessionToken();
    const sessionHash = hashSecret('session', sessionToken);
    const state = await db.call('staff_login_create', [lookup.staff_id, sessionHash]);

    setCookie(c, STAFF_COOKIE, sessionToken, {
      httpOnly: true,
      secure,
      sameSite: 'Strict',
      path: '/',
      maxAge: 60 * 60 * 14,
    });
    return c.json(state);
  });

  app.post('/staff/logout', async (c) => {
    const token = getCookie(c, STAFF_COOKIE);
    if (token) {
      await db.call('staff_logout', [hashSecret('session', token)]);
    }
    deleteCookie(c, STAFF_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/staff/me', async (c) => {
    const sessionHash = requireStaffSessionHash(c);
    const state = await db.call('staff_state', [sessionHash]);
    return c.json(state);
  });

  // -------------------------------------------------------------------
  // ORGANIZADOR FINAL
  // -------------------------------------------------------------------
  app.get('/final/location', async (c) => {
    const sessionHash = requireStaffSessionHash(c);
    const loc = await db.call('final_current_location', [sessionHash]);
    return c.json({ location: loc });
  });

  app.post('/final/location', async (c) => {
    const sessionHash = requireStaffSessionHash(c);
    await enforceRateLimit(`fpub:${sessionHash.slice(0, 16)}`, 60, 20);
    const body = await parseBody(c, PublishFinalLocationInput);
    const loc = await db.call('final_publish_location', [
      sessionHash,
      body.lat,
      body.lng,
      body.accuracy_m ?? null,
      body.reference,
    ]);
    return c.json(loc);
  });

  app.post('/final/lookup', async (c) => {
    const sessionHash = requireStaffSessionHash(c);
    const body = await parseBody(c, LookupTeamInput);
    const team = await db.call('final_lookup', [sessionHash, body.public_id]);
    return c.json(team);
  });

  app.post('/final/confirm', async (c) => {
    const sessionHash = requireStaffSessionHash(c);
    const body = await parseBody(c, ConfirmFinishInput);
    const res = await db.call('final_confirm', [sessionHash, body.public_id]);
    return c.json(res);
  });

  // -------------------------------------------------------------------
  // ADMINISTRACIÓN
  // -------------------------------------------------------------------
  app.get('/admin/overview', async (c) => {
    const sessionHash = requireStaffSessionHash(c);
    const data = await db.call('admin_overview', [sessionHash]);
    return c.json(data);
  });

  app.post('/admin/event-status', async (c) => {
    const sessionHash = requireStaffSessionHash(c);
    const body = await parseBody(c, AdminSetEventStatusInput);
    const res = await db.call('admin_set_event_status', [
      sessionHash,
      body.status,
      body.reason ?? null,
    ]);
    return c.json(res);
  });

  app.post('/admin/event-config', async (c) => {
    const sessionHash = requireStaffSessionHash(c);
    const body = await parseBody(c, AdminUpdateEventInput);
    const res = await db.call('admin_update_event', [
      sessionHash,
      body.name,
      body.target_count,
      body.is_test,
    ]);
    return c.json(res);
  });

  app.post('/admin/qr-points', async (c) => {
    const sessionHash = requireStaffSessionHash(c);
    const body = await parseBody(c, AdminUpsertQrPointInput);
    const res = await db.call('admin_upsert_qr_point', [
      sessionHash,
      body.slug,
      body.public_name,
      generateQrCode(),
      body.sort_order,
      body.is_active,
      body.lat ?? null,
      body.lng ?? null,
      body.proximity_radius_m,
    ]);
    return c.json(res);
  });

  app.post('/admin/qr-points/delete', async (c) => {
    const sessionHash = requireStaffSessionHash(c);
    const body = await parseBody(c, AdminDeleteQrPointInput);
    const res = await db.call('admin_delete_qr_point', [sessionHash, body.slug, body.reason]);
    return c.json(res);
  });

  app.post('/admin/clues', async (c) => {
    const sessionHash = requireStaffSessionHash(c);
    const body = await parseBody(c, AdminAddClueInput);
    const res = await db.call('admin_add_clue', [sessionHash, body.qr_slug, body.body]);
    return c.json(res);
  });

  app.post('/admin/clues/delete', async (c) => {
    const sessionHash = requireStaffSessionHash(c);
    const body = await parseBody(c, AdminDeleteClueInput);
    const res = await db.call('admin_delete_clue', [sessionHash, body.clue_id]);
    return c.json(res);
  });

  app.post('/admin/teams', async (c) => {
    const sessionHash = requireStaffSessionHash(c);
    const body = await parseBody(c, AdminCreateTeamInput);
    const res = await db.call('admin_create_team', [
      sessionHash,
      body.public_id,
      body.name,
      body.members,
    ]);
    return c.json(res);
  });

  app.post('/admin/teams/delete', async (c) => {
    const sessionHash = requireStaffSessionHash(c);
    const body = await parseBody(c, AdminDeleteTeamInput);
    const res = await db.call('admin_delete_team', [sessionHash, body.public_id, body.reason]);
    return c.json(res);
  });

  app.post('/admin/reset-data', async (c) => {
    const sessionHash = requireStaffSessionHash(c);
    const body = await parseBody(c, AdminResetEventDataInput);
    const res = await db.call('admin_reset_event_data', [
      sessionHash,
      body.wipe_stations,
      body.reason,
    ]);
    return c.json(res);
  });

  app.post('/admin/team-status', async (c) => {
    const sessionHash = requireStaffSessionHash(c);
    const body = await parseBody(c, AdminSetTeamStatusInput);
    const res = await db.call('admin_set_team_status', [
      sessionHash,
      body.public_id,
      body.status,
      body.reason,
    ]);
    return c.json(res);
  });

  app.post('/admin/issue-activation', async (c) => {
    const sessionHash = requireStaffSessionHash(c);
    const body = await parseBody(c, AdminIssueActivationInput);
    const plainCode = generateActivationCode();
    const codeHash = hashSecret('activation', plainCode);
    const res = await db.call<{
      public_id: string;
      expires_at: string;
      sessions_revoked: number;
    }>('admin_issue_activation', [
      sessionHash,
      body.public_id,
      codeHash,
      body.ttl_minutes,
      body.reason,
    ]);
    // El código en claro se devuelve SOLO en esta respuesta al administrador; en la BD queda únicamente su hash.
    return c.json({ ...res, code: plainCode });
  });

  app.post('/admin/scans/add', async (c) => {
    const sessionHash = requireStaffSessionHash(c);
    const body = await parseBody(c, AdminScanCorrectionInput);
    const res = await db.call('admin_add_scan', [
      sessionHash,
      body.public_id,
      body.qr_slug,
      body.reason,
    ]);
    return c.json(res);
  });

  app.post('/admin/scans/void', async (c) => {
    const sessionHash = requireStaffSessionHash(c);
    const body = await parseBody(c, AdminScanCorrectionInput);
    const res = await db.call('admin_void_scan', [
      sessionHash,
      body.public_id,
      body.qr_slug,
      body.reason,
    ]);
    return c.json(res);
  });

  app.post('/admin/finishes/void', async (c) => {
    const sessionHash = requireStaffSessionHash(c);
    const body = await parseBody(c, AdminVoidFinishInput);
    const res = await db.call('admin_void_finish', [sessionHash, body.public_id, body.reason]);
    return c.json(res);
  });

  app.get('/admin/audit', async (c) => {
    const sessionHash = requireStaffSessionHash(c);
    const limit = Number(c.req.query('limit') ?? '100');
    const res = await db.call('admin_audit', [
      sessionHash,
      Number.isFinite(limit) ? limit : 100,
    ]);
    return c.json({ entries: res });
  });

  return app;
}
