/**
 * Contratos compartidos entre el cliente React y el servidor Hono.
 * Todas las entradas se validan con Zod (.strict() para rechazar campos no declarados).
 */
import { z } from 'zod';

// ---------------------------------------------------------------------
// Reglas de formato
// ---------------------------------------------------------------------
export const PUBLIC_ID_REGEX = /^[A-Z]{2,5}-[0-9]{3}$/;
export const QR_CODE_REGEX = /^[A-Za-z0-9]{22,64}$/;
export const SLUG_REGEX = /^[a-z0-9-]{1,40}$/;

// ---------------------------------------------------------------------
// Entradas de equipo
// ---------------------------------------------------------------------
export const ActivateTeamInput = z
  .object({
    code: z.string().trim().min(6).max(64),
  })
  .strict();
export type ActivateTeamInput = z.infer<typeof ActivateTeamInput>;

export const ScanQrInput = z
  .object({
    code: z.string().trim().regex(QR_CODE_REGEX, 'Código QR inválido'),
  })
  .strict();
export type ScanQrInput = z.infer<typeof ScanQrInput>;

export const CheckProximityInput = z
  .object({
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
    accuracy_m: z.number().finite().min(0).max(100_000).nullable().optional(),
  })
  .strict();
export type CheckProximityInput = z.infer<typeof CheckProximityInput>;

// ---------------------------------------------------------------------
// Entradas de staff / organizador final
// ---------------------------------------------------------------------
export const StaffLoginInput = z
  .object({
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9_.-]{3,32}$/, 'Usuario inválido'),
    password: z.string().min(8).max(200),
  })
  .strict();
export type StaffLoginInput = z.infer<typeof StaffLoginInput>;

export const PublishFinalLocationInput = z
  .object({
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
    accuracy_m: z.number().finite().min(0).max(100_000).nullable().optional(),
    reference: z.string().trim().min(3).max(300),
  })
  .strict();
export type PublishFinalLocationInput = z.infer<typeof PublishFinalLocationInput>;

export const LookupTeamInput = z
  .object({
    public_id: z
      .string()
      .trim()
      .toUpperCase()
      .regex(PUBLIC_ID_REGEX, 'Usa el formato TEC-001'),
  })
  .strict();
export type LookupTeamInput = z.infer<typeof LookupTeamInput>;

export const ConfirmFinishInput = LookupTeamInput;
export type ConfirmFinishInput = z.infer<typeof ConfirmFinishInput>;

// ---------------------------------------------------------------------
// Entradas de administración
// ---------------------------------------------------------------------
export const EventStatusSchema = z.enum(['draft', 'open', 'running', 'paused', 'closed']);
export type EventStatus = z.infer<typeof EventStatusSchema>;

export const AdminSetEventStatusInput = z
  .object({
    status: EventStatusSchema,
    reason: z.string().trim().max(500).optional(),
  })
  .strict();
export type AdminSetEventStatusInput = z.infer<typeof AdminSetEventStatusInput>;

export const AdminUpdateEventInput = z
  .object({
    name: z.string().trim().min(2).max(120),
    target_count: z.number().int().min(1).max(50),
    is_test: z.boolean().default(false),
  })
  .strict();
export type AdminUpdateEventInput = z.infer<typeof AdminUpdateEventInput>;

export const AdminUpsertQrPointInput = z
  .object({
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(SLUG_REGEX, 'Usa minúsculas, números y guiones (ej. biblioteca)'),
    public_name: z.string().trim().min(2).max(80),
    sort_order: z.number().int().min(0).max(500).default(0),
    is_active: z.boolean().default(true),
    lat: z.number().finite().min(-90).max(90).nullable().optional(),
    lng: z.number().finite().min(-180).max(180).nullable().optional(),
    proximity_radius_m: z.number().int().min(10).max(500).default(35),
  })
  .strict()
  .refine((v) => (v.lat == null) === (v.lng == null), {
    message: 'Debes indicar latitud y longitud juntas o dejar ambas vacías.',
  });
export type AdminUpsertQrPointInput = z.infer<typeof AdminUpsertQrPointInput>;

export const AdminDeleteQrPointInput = z
  .object({
    slug: z.string().trim().regex(SLUG_REGEX),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type AdminDeleteQrPointInput = z.infer<typeof AdminDeleteQrPointInput>;

export const AdminAddClueInput = z
  .object({
    qr_slug: z.string().trim().regex(SLUG_REGEX),
    body: z.string().trim().min(3).max(1000),
  })
  .strict();
export type AdminAddClueInput = z.infer<typeof AdminAddClueInput>;

export const AdminDeleteClueInput = z
  .object({
    clue_id: z.string().uuid(),
  })
  .strict();
export type AdminDeleteClueInput = z.infer<typeof AdminDeleteClueInput>;

export const AdminCreateTeamInput = z
  .object({
    public_id: z.string().trim().toUpperCase().regex(PUBLIC_ID_REGEX, 'Usa el formato TEC-001'),
    name: z.string().trim().min(2).max(60),
    members: z.array(z.string().trim().min(1).max(60)).max(8).default([]),
  })
  .strict();
export type AdminCreateTeamInput = z.infer<typeof AdminCreateTeamInput>;

export const AdminDeleteTeamInput = z
  .object({
    public_id: z.string().trim().toUpperCase().regex(PUBLIC_ID_REGEX),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type AdminDeleteTeamInput = z.infer<typeof AdminDeleteTeamInput>;

export const AdminResetEventDataInput = z
  .object({
    wipe_stations: z.boolean().default(false),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type AdminResetEventDataInput = z.infer<typeof AdminResetEventDataInput>;

export const AdminSetTeamStatusInput = z
  .object({
    public_id: z.string().trim().toUpperCase().regex(PUBLIC_ID_REGEX),
    status: z.enum(['active', 'disabled']),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type AdminSetTeamStatusInput = z.infer<typeof AdminSetTeamStatusInput>;

export const AdminIssueActivationInput = z
  .object({
    public_id: z.string().trim().toUpperCase().regex(PUBLIC_ID_REGEX),
    ttl_minutes: z.number().int().min(5).max(10_080).default(720),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type AdminIssueActivationInput = z.infer<typeof AdminIssueActivationInput>;

export const AdminScanCorrectionInput = z
  .object({
    public_id: z.string().trim().toUpperCase().regex(PUBLIC_ID_REGEX),
    qr_slug: z.string().trim().regex(SLUG_REGEX),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type AdminScanCorrectionInput = z.infer<typeof AdminScanCorrectionInput>;

export const AdminVoidFinishInput = z
  .object({
    public_id: z.string().trim().toUpperCase().regex(PUBLIC_ID_REGEX),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type AdminVoidFinishInput = z.infer<typeof AdminVoidFinishInput>;

// ---------------------------------------------------------------------
// Tipos de respuesta del servidor
// ---------------------------------------------------------------------
export interface TeamState {
  team: { public_id: string; name: string };
  event: { name: string; status: EventStatus; target: number };
  found_count: number;
  found: Array<{ name: string; scanned_at: string }>;
  clue: { id: string; body: string; assigned_at: string } | null;
  proximity_enabled?: boolean;
  final: {
    unlocked: boolean;
    published: boolean;
    version: number | null;
    updated_at: string | null;
  } | null;
  finish: { rank: number; confirmed_at: string } | null;
  server_time: string;
}

export interface ProximityResponse {
  zone: 'near' | 'approaching' | 'far' | 'no_coords';
  near: boolean;
  is_target: boolean;
  checked_at: string;
}

export interface ScanQrResponse {
  result: 'registered' | 'already_registered';
  qr_name: string;
  state: TeamState;
}

export interface FinalLocation {
  lat: number;
  lng: number;
  accuracy_m: number | null;
  reference: string;
  version: number;
  updated_at: string;
}

export interface StaffState {
  staff: {
    username: string;
    display_name: string;
    roles: Array<'admin' | 'final'>;
  };
  event: {
    name: string;
    slug: string;
    status: EventStatus;
    target: number;
    is_test: boolean;
  };
}

export interface StaffTeamView {
  public_id: string;
  name: string;
  status: 'active' | 'disabled';
  found_count: number;
  target: number;
  eligible: boolean;
  finish: {
    rank: number;
    position: number;
    confirmed_at: string;
    voided: boolean;
  } | null;
}

export interface AdminQrPoint {
  slug: string;
  public_name: string;
  code: string;
  sort_order: number;
  is_active: boolean;
  lat: number | null;
  lng: number | null;
  proximity_radius_m: number;
  clues: number;
  clues_list: Array<{ id: string; body: string; is_active: boolean }>;
  pointed_by: number;
  found_by: number;
}

export interface AdminOverview {
  event: StaffState['event'];
  qr_points: AdminQrPoint[];
  teams: Array<
    StaffTeamView & {
      found: Array<{ slug: string; scanned_at: string; source: 'scan' | 'admin' }>;
      pointer_slug: string | null;
      session_active: boolean;
      last_scan_at: string | null;
    }
  >;
  final_location: FinalLocation | null;
  server_time: string;
}

export interface AuditEntry {
  created_at: string;
  actor_kind: 'team' | 'staff' | 'system';
  actor: string | null;
  action: string;
  team: string | null;
  details: Record<string, unknown>;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

// Mensajes claros en español para todos los códigos de error de negocio.
export const ERROR_MESSAGES: Record<string, { status: number; message: string }> = {
  bad_request: { status: 400, message: 'Solicitud inválida. Revisa los datos enviados.' },
  session_invalid: {
    status: 401,
    message: 'Tu sesión no está activa o fue transferida a otro dispositivo.',
  },
  invalid_credentials: { status: 401, message: 'Usuario o contraseña incorrectos.' },
  forbidden: { status: 403, message: 'No tienes permiso para realizar esta acción.' },
  csrf_rejected: { status: 403, message: 'Origen de solicitud no autorizado.' },
  activation_invalid: {
    status: 400,
    message: 'Código de activación inválido, vencido o ya utilizado.',
  },
  team_disabled: {
    status: 403,
    message: 'Este equipo está deshabilitado. Consulta a administración.',
  },
  event_not_open: {
    status: 409,
    message: 'El evento aún no está abierto para activar equipos.',
  },
  event_not_running: {
    status: 409,
    message: 'El evento está pausado o no se encuentra en curso.',
  },
  qr_invalid: { status: 404, message: 'Este código QR no corresponde a un punto activo del rally.' },
  final_locked: {
    status: 403,
    message: 'Aún no has completado todos los puntos QR requeridos.',
  },
  final_not_published: {
    status: 404,
    message: 'El organizador aún no ha publicado la ubicación final. Intenta de nuevo en unos segundos.',
  },
  team_not_found: { status: 404, message: 'No existe un equipo con ese ID en este evento.' },
  team_exists: { status: 409, message: 'Ya existe un equipo con ese ID público.' },
  not_eligible: {
    status: 409,
    message: 'El equipo aún no cumple los requisitos para registrar su llegada.',
  },
  own_team_forbidden: {
    status: 403,
    message: 'No puedes confirmar la llegada de tu propio equipo.',
  },
  finish_voided: {
    status: 409,
    message: 'La llegada de este equipo fue anulada por administración.',
  },
  already_registered: { status: 409, message: 'Este QR ya estaba registrado para el equipo.' },
  scan_not_found: { status: 404, message: 'El equipo no tiene registrado ese punto QR.' },
  finish_not_found: { status: 404, message: 'El equipo no tiene una llegada activa.' },
  reason_required: {
    status: 400,
    message: 'Debes indicar un motivo de al menos 3 caracteres.',
  },
  rate_limited: {
    status: 429,
    message: 'Demasiadas solicitudes. Espera unos segundos e intenta de nuevo.',
  },
};
