import {
  type AdminAddClueInput,
  type AdminCreateTeamInput,
  type AdminDeleteClueInput,
  type AdminDeleteQrPointInput,
  type AdminDeleteTeamInput,
  type AdminIssueActivationInput,
  type AdminOverview,
  type AdminQrPoint,
  type AdminResetEventDataInput,
  type AdminScanCorrectionInput,
  type AdminSetEventStatusInput,
  type AdminSetTeamStatusInput,
  type AdminUpdateEventInput,
  type AdminUpsertQrPointInput,
  type AdminVoidFinishInput,
  type ApiErrorBody,
  type AuditEntry,
  type CheckProximityInput,
  ERROR_MESSAGES,
  type EventStatus,
  type FinalLocation,
  type ProximityResponse,
  type PublishFinalLocationInput,
  QR_CODE_REGEX,
  type ScanQrResponse,
  type StaffLoginInput,
  type StaffState,
  type StaffTeamView,
  type TeamState,
} from '../../shared/contracts.js';

const LAST_TEAM_STATE_KEY = 'rally_last_team_state_v1';
const PENDING_QR_CODE_KEY = 'rally_pending_qr_code_v1';
const LAST_FINAL_VERSION_KEY = 'rally_last_final_version_v1';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly isNetworkError: boolean;

  constructor(code: string, message: string, status: number, isNetworkError = false) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.isNetworkError = isNetworkError;
  }
}

export function saveCachedTeamState(state: TeamState): void {
  try {
    window.localStorage.setItem(LAST_TEAM_STATE_KEY, JSON.stringify(state));
  } catch {
    // Ignorar errores de almacenamiento privado o cuota llena
  }
}

export function loadCachedTeamState(): TeamState | null {
  try {
    const raw = window.localStorage.getItem(LAST_TEAM_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TeamState;
    if (!parsed || typeof parsed !== 'object' || !parsed.team?.public_id) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function setPendingQrCode(code: string): void {
  try {
    window.sessionStorage.setItem(PENDING_QR_CODE_KEY, code.trim());
  } catch {
    // Ignorar
  }
}

export function peekPendingQrCode(): string | null {
  try {
    const val = window.sessionStorage.getItem(PENDING_QR_CODE_KEY);
    return val ? val.trim() : null;
  } catch {
    return null;
  }
}

export function consumePendingQrCode(): string | null {
  try {
    const val = window.sessionStorage.getItem(PENDING_QR_CODE_KEY);
    if (val) {
      window.sessionStorage.removeItem(PENDING_QR_CODE_KEY);
      return val.trim();
    }
    return null;
  } catch {
    return null;
  }
}

export function getLastSeenFinalVersion(): number | null {
  try {
    const raw = window.sessionStorage.getItem(LAST_FINAL_VERSION_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function setLastSeenFinalVersion(version: number): void {
  try {
    window.sessionStorage.setItem(LAST_FINAL_VERSION_KEY, String(version));
  } catch {
    // Ignorar
  }
}

/**
 * Extrae el código QR a partir de un enlace completo (ej. https://.../q/AbCdEf...)
 * o de un código directo pegado por el equipo.
 */
export function extractQrCode(rawInput: string): string | null {
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  if (QR_CODE_REGEX.test(trimmed)) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed, window.location.origin);
    const match = url.pathname.match(/\/q\/([A-Za-z0-9]{22,64})\/?$/);
    if (match?.[1]) {
      return match[1];
    }
  } catch {
    const match = trimmed.match(/\/q\/([A-Za-z0-9]{22,64})/);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

/**
 * Normaliza un ID público ingresado por staff (ej. "001" o "1" -> "TEC-001").
 */
export function normalizePublicId(raw: string): string {
  const cleaned = raw.trim().toUpperCase();
  if (/^[0-9]{1,3}$/.test(cleaned)) {
    return `TEC-${cleaned.padStart(3, '0')}`;
  }
  const simpleMatch = cleaned.match(/^([A-Z]{2,5})-?([0-9]{1,3})$/);
  if (simpleMatch?.[1] && simpleMatch[2]) {
    return `${simpleMatch[1]}-${simpleMatch[2].padStart(3, '0')}`;
  }
  return cleaned;
}

export function formatEventStatus(status: EventStatus): string {
  switch (status) {
    case 'draft':
      return 'En preparación';
    case 'open':
      return 'Abierto (registro)';
    case 'running':
      return 'En curso';
    case 'paused':
      return 'En pausa';
    case 'closed':
      return 'Finalizado';
    default:
      return status;
  }
}

export function formatTimeShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('es-MX', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '—';
  }
}

async function requestJson<T>(
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (method === 'POST') {
    headers['X-Rally-Request'] = '1';
    headers['Content-Type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: method === 'POST' ? JSON.stringify(options.body ?? {}) : undefined,
    });
  } catch {
    throw new ApiError(
      'network_error',
      'Sin conexión con el servidor. Verifica tu señal de datos o Wi-Fi.',
      0,
      true,
    );
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const errBody = payload as Partial<ApiErrorBody> | null;
    const code = errBody?.error?.code ?? 'internal_error';
    const message =
      errBody?.error?.message ??
      ERROR_MESSAGES[code]?.message ??
      'Ocurrió un error al procesar la solicitud.';
    throw new ApiError(code, message, response.status, false);
  }

  return payload as T;
}

// ---------------------------------------------------------------------
// Endpoints de Equipos
// ---------------------------------------------------------------------

export async function activateTeam(code: string): Promise<TeamState> {
  const state = await requestJson<TeamState>('/api/team/activate', {
    method: 'POST',
    body: { code: code.trim() },
  });
  saveCachedTeamState(state);
  return state;
}

export async function getMyState(): Promise<TeamState> {
  const state = await requestJson<TeamState>('/api/me');
  saveCachedTeamState(state);
  return state;
}

export async function scanQr(code: string): Promise<ScanQrResponse> {
  const res = await requestJson<ScanQrResponse>('/api/team/scan', {
    method: 'POST',
    body: { code: code.trim() },
  });
  if (res?.state) {
    saveCachedTeamState(res.state);
  }
  return res;
}

export async function checkProximity(input: CheckProximityInput): Promise<ProximityResponse> {
  return requestJson<ProximityResponse>('/api/team/proximity', {
    method: 'POST',
    body: input,
  });
}

export async function getTeamFinalLocation(): Promise<FinalLocation> {
  return requestJson<FinalLocation>('/api/team/final-location');
}

// ---------------------------------------------------------------------
// Endpoints de Staff / Organizador Final
// ---------------------------------------------------------------------

export async function staffLogin(input: StaffLoginInput): Promise<StaffState> {
  return requestJson<StaffState>('/api/staff/login', {
    method: 'POST',
    body: input,
  });
}

export async function staffLogout(): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>('/api/staff/logout', {
    method: 'POST',
    body: {},
  });
}

export async function getStaffMe(): Promise<StaffState> {
  return requestJson<StaffState>('/api/staff/me');
}

export async function getFinalCurrentLocation(): Promise<{ location: FinalLocation | null }> {
  return requestJson<{ location: FinalLocation | null }>('/api/final/location');
}

export async function publishFinalLocation(
  input: PublishFinalLocationInput,
): Promise<FinalLocation> {
  return requestJson<FinalLocation>('/api/final/location', {
    method: 'POST',
    body: input,
  });
}

export async function lookupTeamForFinal(publicId: string): Promise<StaffTeamView> {
  return requestJson<StaffTeamView>('/api/final/lookup', {
    method: 'POST',
    body: { public_id: normalizePublicId(publicId) },
  });
}

export interface ConfirmFinishResponse {
  result: 'confirmed' | 'already_confirmed';
  team: StaffTeamView;
}

export async function confirmTeamFinish(publicId: string): Promise<ConfirmFinishResponse> {
  return requestJson<ConfirmFinishResponse>('/api/final/confirm', {
    method: 'POST',
    body: { public_id: normalizePublicId(publicId) },
  });
}

// ---------------------------------------------------------------------
// Endpoints de Administración
// ---------------------------------------------------------------------

export async function getAdminOverview(): Promise<AdminOverview> {
  return requestJson<AdminOverview>('/api/admin/overview');
}

export async function adminSetEventStatus(
  input: AdminSetEventStatusInput,
): Promise<{ status: EventStatus }> {
  return requestJson<{ status: EventStatus }>('/api/admin/event-status', {
    method: 'POST',
    body: input,
  });
}

export async function adminUpdateEvent(
  input: AdminUpdateEventInput,
): Promise<{ name: string; target: number; is_test: boolean }> {
  return requestJson<{ name: string; target: number; is_test: boolean }>('/api/admin/event-config', {
    method: 'POST',
    body: input,
  });
}

export async function adminUpsertQrPoint(input: AdminUpsertQrPointInput): Promise<AdminQrPoint> {
  return requestJson<AdminQrPoint>('/api/admin/qr-points', {
    method: 'POST',
    body: input,
  });
}

export async function adminDeleteQrPoint(
  input: AdminDeleteQrPointInput,
): Promise<{ deleted: string }> {
  return requestJson<{ deleted: string }>('/api/admin/qr-points/delete', {
    method: 'POST',
    body: input,
  });
}

export async function adminAddClue(
  input: AdminAddClueInput,
): Promise<{ id: string; body: string; qr_slug: string }> {
  return requestJson<{ id: string; body: string; qr_slug: string }>('/api/admin/clues', {
    method: 'POST',
    body: input,
  });
}

export async function adminDeleteClue(
  input: AdminDeleteClueInput,
): Promise<{ deleted: string }> {
  return requestJson<{ deleted: string }>('/api/admin/clues/delete', {
    method: 'POST',
    body: input,
  });
}

export async function adminCreateTeam(input: AdminCreateTeamInput): Promise<StaffTeamView> {
  return requestJson<StaffTeamView>('/api/admin/teams', {
    method: 'POST',
    body: {
      ...input,
      public_id: normalizePublicId(input.public_id),
    },
  });
}

export async function adminDeleteTeam(
  input: AdminDeleteTeamInput,
): Promise<{ deleted: string }> {
  return requestJson<{ deleted: string }>('/api/admin/teams/delete', {
    method: 'POST',
    body: {
      ...input,
      public_id: normalizePublicId(input.public_id),
    },
  });
}

export async function adminResetEventData(
  input: AdminResetEventDataInput,
): Promise<{ ok: boolean; wipe_stations: boolean }> {
  return requestJson<{ ok: boolean; wipe_stations: boolean }>('/api/admin/reset-data', {
    method: 'POST',
    body: input,
  });
}

export async function adminSetTeamStatus(input: AdminSetTeamStatusInput): Promise<StaffTeamView> {
  return requestJson<StaffTeamView>('/api/admin/team-status', {
    method: 'POST',
    body: {
      ...input,
      public_id: normalizePublicId(input.public_id),
    },
  });
}

export interface IssueActivationResponse {
  public_id: string;
  code: string;
  expires_at: string;
  sessions_revoked: number;
}

export async function adminIssueActivation(
  input: AdminIssueActivationInput,
): Promise<IssueActivationResponse> {
  return requestJson<IssueActivationResponse>('/api/admin/issue-activation', {
    method: 'POST',
    body: {
      ...input,
      public_id: normalizePublicId(input.public_id),
    },
  });
}

export async function adminAddScan(input: AdminScanCorrectionInput): Promise<StaffTeamView> {
  return requestJson<StaffTeamView>('/api/admin/scans/add', {
    method: 'POST',
    body: {
      ...input,
      public_id: normalizePublicId(input.public_id),
    },
  });
}

export async function adminVoidScan(input: AdminScanCorrectionInput): Promise<StaffTeamView> {
  return requestJson<StaffTeamView>('/api/admin/scans/void', {
    method: 'POST',
    body: {
      ...input,
      public_id: normalizePublicId(input.public_id),
    },
  });
}

export async function adminVoidFinish(input: AdminVoidFinishInput): Promise<StaffTeamView> {
  return requestJson<StaffTeamView>('/api/admin/finishes/void', {
    method: 'POST',
    body: {
      ...input,
      public_id: normalizePublicId(input.public_id),
    },
  });
}

export async function getAdminAudit(limit = 100): Promise<{ entries: AuditEntry[] }> {
  return requestJson<{ entries: AuditEntry[] }>(
    `/api/admin/audit?limit=${encodeURIComponent(String(limit))}`,
  );
}
