import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  adminAddClue,
  adminAddScan,
  adminCreateTeam,
  adminDeleteClue,
  adminDeleteQrPoint,
  adminDeleteTeam,
  adminIssueActivation,
  adminResetEventData,
  adminSetEventStatus,
  adminSetTeamStatus,
  adminUpdateEvent,
  adminUpsertQrPoint,
  adminVoidFinish,
  adminVoidScan,
  ApiError,
  formatEventStatus,
  formatTimeShort,
  getAdminAudit,
  getAdminOverview,
  type IssueActivationResponse,
  normalizePublicId,
  staffLogout,
} from '../api.js';
import type { AdminQrPoint, EventStatus } from '../../../shared/contracts.js';

export function AdminPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const overviewQuery = useQuery({
    queryKey: ['admin-overview'],
    queryFn: getAdminOverview,
    refetchInterval: 10_000,
    retry: false,
  });

  const auditQuery = useQuery({
    queryKey: ['admin-audit'],
    queryFn: () => getAdminAudit(100),
    refetchInterval: 15_000,
    retry: false,
  });

  useEffect(() => {
    const err = overviewQuery.error;
    if (err instanceof ApiError && (err.code === 'session_invalid' || err.code === 'forbidden')) {
      navigate('/staff/login', { replace: true });
    }
  }, [overviewQuery.error, navigate]);

  function refreshAll() {
    queryClient.invalidateQueries({ queryKey: ['admin-overview'] });
    queryClient.invalidateQueries({ queryKey: ['admin-audit'] });
  }

  // 1) Control de estado y meta de QRs del evento
  const [nextEventStatus, setNextEventStatus] = useState<EventStatus>('running');
  const [eventReason, setEventReason] = useState('');
  const [eventNameInput, setEventNameInput] = useState('');
  const [eventTargetInput, setEventTargetInput] = useState('8');
  const [eventIsTestInput, setEventIsTestInput] = useState(false);
  const [eventConfigInitialized, setEventConfigInitialized] = useState(false);

  useEffect(() => {
    if (!eventConfigInitialized && overviewQuery.data?.event) {
      setNextEventStatus(overviewQuery.data.event.status);
      setEventNameInput(overviewQuery.data.event.name);
      setEventTargetInput(String(overviewQuery.data.event.target));
      setEventIsTestInput(overviewQuery.data.event.is_test);
      setEventConfigInitialized(true);
    }
  }, [overviewQuery.data, eventConfigInitialized]);

  const eventStatusMutation = useMutation({
    mutationFn: async () => {
      return adminSetEventStatus({
        status: nextEventStatus,
        reason: eventReason.trim() || undefined,
      });
    },
    onSuccess: () => {
      setEventReason('');
      refreshAll();
    },
  });

  const eventConfigMutation = useMutation({
    mutationFn: async () => {
      const target = Number(eventTargetInput);
      return adminUpdateEvent({
        name: eventNameInput.trim(),
        target_count: Number.isFinite(target) && target >= 1 ? Math.round(target) : 6,
        is_test: eventIsTestInput,
      });
    },
    onSuccess: () => {
      refreshAll();
    },
  });

  // 1b) Limpiar datos de prueba del evento
  const [wipeStationsToo, setWipeStationsToo] = useState(true);
  const [resetReason, setResetReason] = useState('Limpieza de datos de prueba para iniciar configuración real');

  const resetDataMutation = useMutation({
    mutationFn: async () => {
      return adminResetEventData({
        wipe_stations: wipeStationsToo,
        reason: resetReason.trim() || 'Limpieza administrativa',
      });
    },
    onSuccess: () => {
      setIssuedCodeResult(null);
      refreshAll();
    },
  });

  // 2) Crear / Editar Estación QR (con coordenadas opcionales para el radar de cercanía)
  const [qrSlug, setQrSlug] = useState('');
  const [qrPublicName, setQrPublicName] = useState('');
  const [qrSortOrder, setQrSortOrder] = useState('1');
  const [qrIsActive, setQrIsActive] = useState(true);
  const [qrLat, setQrLat] = useState('');
  const [qrLng, setQrLng] = useState('');
  const [qrRadius, setQrRadius] = useState('35');
  const [qrGpsStatus, setQrGpsStatus] = useState<string | null>(null);
  const [copiedQrSlug, setCopiedQrSlug] = useState<string | null>(null);

  // Agregar pista a estación
  const [clueTargetSlug, setClueTargetSlug] = useState('');
  const [clueBodyInput, setClueBodyInput] = useState('');

  useEffect(() => {
    const firstSlug = overviewQuery.data?.qr_points[0]?.slug;
    if (!clueTargetSlug && firstSlug) {
      setClueTargetSlug(firstSlug);
    }
  }, [overviewQuery.data, clueTargetSlug]);

  function loadStationIntoForm(pt: AdminQrPoint) {
    setQrSlug(pt.slug);
    setQrPublicName(pt.public_name);
    setQrSortOrder(String(pt.sort_order));
    setQrIsActive(pt.is_active);
    setQrLat(pt.lat != null ? String(pt.lat) : '');
    setQrLng(pt.lng != null ? String(pt.lng) : '');
    setQrRadius(String(pt.proximity_radius_m ?? 35));
    setClueTargetSlug(pt.slug);
  }

  function handleCaptureStationGps() {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setQrGpsStatus('Este navegador no soporta geolocalización.');
      return;
    }
    setQrGpsStatus('Obteniendo coordenadas GPS...');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setQrLat(pos.coords.latitude.toFixed(6));
        setQrLng(pos.coords.longitude.toFixed(6));
        setQrGpsStatus(
          `Coordenadas capturadas (precisión ±${Math.round(pos.coords.accuracy)} m).`,
        );
      },
      (err) => {
        setQrGpsStatus(
          err.code === err.PERMISSION_DENIED
            ? 'Permiso de ubicación denegado. Puedes escribir latitud y longitud manualmente.'
            : 'No se pudo obtener GPS. Ingresa las coordenadas manualmente.',
        );
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    );
  }

  const upsertQrMutation = useMutation({
    mutationFn: async () => {
      const latTrim = qrLat.trim();
      const lngTrim = qrLng.trim();
      const latVal = latTrim ? Number(latTrim) : null;
      const lngVal = lngTrim ? Number(lngTrim) : null;
      const radiusVal = Number(qrRadius) || 35;
      return adminUpsertQrPoint({
        slug: qrSlug.trim().toLowerCase(),
        public_name: qrPublicName.trim(),
        sort_order: Number(qrSortOrder) || 0,
        is_active: qrIsActive,
        lat: latVal,
        lng: lngVal,
        proximity_radius_m: radiusVal,
      });
    },
    onSuccess: (saved) => {
      setClueTargetSlug(saved.slug);
      setQrSlug('');
      setQrPublicName('');
      setQrLat('');
      setQrLng('');
      setQrGpsStatus(null);
      refreshAll();
    },
  });

  const deleteQrMutation = useMutation({
    mutationFn: async (slug: string) => {
      return adminDeleteQrPoint({
        slug,
        reason: 'Estación eliminada desde panel de administración',
      });
    },
    onSuccess: () => {
      refreshAll();
    },
  });

  const addClueMutation = useMutation({
    mutationFn: async () => {
      return adminAddClue({
        qr_slug: clueTargetSlug.trim(),
        body: clueBodyInput.trim(),
      });
    },
    onSuccess: () => {
      setClueBodyInput('');
      refreshAll();
    },
  });

  const deleteClueMutation = useMutation({
    mutationFn: async (clueId: string) => {
      return adminDeleteClue({ clue_id: clueId });
    },
    onSuccess: () => {
      refreshAll();
    },
  });

  // 3) Crear / Eliminar equipo
  const [newTeamId, setNewTeamId] = useState('');
  const [newTeamName, setNewTeamName] = useState('');
  const [newTeamMembers, setNewTeamMembers] = useState('');

  const createTeamMutation = useMutation({
    mutationFn: async () => {
      const members = newTeamMembers
        .split(',')
        .map((m) => m.trim())
        .filter((m) => m.length > 0)
        .slice(0, 8);
      return adminCreateTeam({
        public_id: normalizePublicId(newTeamId),
        name: newTeamName.trim(),
        members,
      });
    },
    onSuccess: (created) => {
      setNewTeamId('');
      setNewTeamName('');
      setNewTeamMembers('');
      setActTeamId(created.public_id);
      refreshAll();
    },
  });

  const deleteTeamMutation = useMutation({
    mutationFn: async (publicId: string) => {
      return adminDeleteTeam({
        public_id: publicId,
        reason: 'Equipo eliminado desde el panel de administración',
      });
    },
    onSuccess: () => {
      refreshAll();
    },
  });

  // 4) Emitir código de activación / transferencia de teléfono
  const [actTeamId, setActTeamId] = useState('');
  const [actTtlMinutes, setActTtlMinutes] = useState('720');
  const [actReason, setActReason] = useState('');
  const [issuedCodeResult, setIssuedCodeResult] = useState<IssueActivationResponse | null>(null);
  const [copiedNotice, setCopiedNotice] = useState(false);

  const issueActivationMutation = useMutation({
    mutationFn: async (params?: { publicId: string; reason: string }) => {
      const ttl = Number(actTtlMinutes) || 720;
      const pid = params?.publicId ?? actTeamId;
      const reason = params?.reason ?? actReason.trim();
      return adminIssueActivation({
        public_id: normalizePublicId(pid),
        ttl_minutes: ttl,
        reason: reason || 'Emisión de código desde panel admin',
      });
    },
    onSuccess: (res) => {
      setIssuedCodeResult(res);
      setCopiedNotice(false);
      setActReason('');
      refreshAll();
    },
  });

  async function handleCopyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedNotice(true);
    } catch {
      setCopiedNotice(false);
    }
  }

  async function handleCopyQrLink(slug: string, code: string) {
    try {
      const url = `${window.location.origin}/q/${code}`;
      await navigator.clipboard.writeText(url);
      setCopiedQrSlug(slug);
      setTimeout(() => setCopiedQrSlug(null), 2500);
    } catch {
      setCopiedQrSlug(null);
    }
  }

  // 5) Habilitar / Deshabilitar equipo
  const [statusTeamId, setStatusTeamId] = useState('');
  const [statusTarget, setStatusTarget] = useState<'active' | 'disabled'>('disabled');
  const [statusReason, setStatusReason] = useState('');

  const teamStatusMutation = useMutation({
    mutationFn: async () => {
      return adminSetTeamStatus({
        public_id: normalizePublicId(statusTeamId),
        status: statusTarget,
        reason: statusReason.trim(),
      });
    },
    onSuccess: () => {
      setStatusReason('');
      refreshAll();
    },
  });

  // 6) Corrección de progreso QR (agregar o anular)
  const [scanTeamId, setScanTeamId] = useState('');
  const [scanQrSlug, setScanQrSlug] = useState('');
  const [scanAction, setScanAction] = useState<'add' | 'void'>('add');
  const [scanReason, setScanReason] = useState('');

  useEffect(() => {
    const firstSlug = overviewQuery.data?.qr_points[0]?.slug;
    if (!scanQrSlug && firstSlug) {
      setScanQrSlug(firstSlug);
    }
  }, [overviewQuery.data, scanQrSlug]);

  const scanCorrectionMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        public_id: normalizePublicId(scanTeamId),
        qr_slug: scanQrSlug.trim(),
        reason: scanReason.trim(),
      };
      if (scanAction === 'add') {
        return adminAddScan(payload);
      }
      return adminVoidScan(payload);
    },
    onSuccess: () => {
      setScanReason('');
      refreshAll();
    },
  });

  // 7) Anular llegada final
  const [voidFinishTeamId, setVoidFinishTeamId] = useState('');
  const [voidFinishReason, setVoidFinishReason] = useState('');

  const voidFinishMutation = useMutation({
    mutationFn: async () => {
      return adminVoidFinish({
        public_id: normalizePublicId(voidFinishTeamId),
        reason: voidFinishReason.trim(),
      });
    },
    onSuccess: () => {
      setVoidFinishReason('');
      refreshAll();
    },
  });

  async function handleLogout() {
    try {
      await staffLogout();
    } finally {
      queryClient.clear();
      navigate('/staff/login', { replace: true });
    }
  }

  const data = overviewQuery.data;

  return (
    <main className="app-shell app-shell--wide">
      <header className="top-header">
        <div className="brand-block">
          <span className="brand-kicker">Panel Operativo de Administración</span>
          <h1 className="brand-title">
            {data ? `${data.event.name} (${data.event.slug})` : 'Administración del Rally'}
          </h1>
          {data && (
            <div style={{ marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span
                className={
                  data.event.status === 'running'
                    ? 'badge badge--running'
                    : data.event.status === 'paused' || data.event.status === 'open'
                      ? 'badge badge--paused'
                      : 'badge badge--closed'
                }
              >
                Estado: {formatEventStatus(data.event.status)}
              </span>
              <span className="badge badge--closed">
                Meta para desbloquear final: {data.event.target} QRs
              </span>
              <span className="badge badge--closed">
                Estaciones activas: {data.qr_points.filter((q) => q.is_active).length} /{' '}
                {data.qr_points.length}
              </span>
            </div>
          )}
        </div>
        <div className="stack-row">
          <Link to="/final-staff" className="btn btn--secondary btn--sm">
            Panel Meta Final
          </Link>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={refreshAll}
            disabled={overviewQuery.isFetching}
          >
            {overviewQuery.isFetching ? 'Actualizando...' : 'Actualizar'}
          </button>
          <button type="button" className="btn btn--secondary btn--sm" onClick={handleLogout}>
            Cerrar sesión
          </button>
        </div>
      </header>

      {overviewQuery.isLoading && !data && (
        <div className="card">
          <h2 className="card-title">Cargando resumen operativo...</h2>
        </div>
      )}

      {overviewQuery.error instanceof ApiError && (
        <div className="banner banner--error" role="alert">
          {overviewQuery.error.message}
        </div>
      )}

      {data && (
        <>
          {/* CONFIGURACIÓN GLOBAL DEL EVENTO Y LIMPIEZA DE PRUEBAS */}
          <div className="admin-grid-2">
            <section className="card card--highlight">
              <span className="brand-kicker">Control Global del Rally</span>
              <h2 className="card-title">Estado del evento</h2>
              <p className="card-subtitle">
                En <strong>open</strong> los equipos activan su código; en <strong>running</strong>{' '}
                se habilitan escaneos QR, radar de cercanía y llegadas.
              </p>

              {eventStatusMutation.error instanceof ApiError && (
                <div className="banner banner--error" role="alert">
                  {eventStatusMutation.error.message}
                </div>
              )}

              {eventStatusMutation.isSuccess && (
                <div className="banner banner--success" role="status">
                  Estado actualizado a <strong>{formatEventStatus(data.event.status)}</strong>.
                </div>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  eventStatusMutation.mutate();
                }}
              >
                <div className="form-group">
                  <label className="form-label" htmlFor="admin-event-status">
                    Estado operativo
                  </label>
                  <select
                    id="admin-event-status"
                    className="select"
                    value={nextEventStatus}
                    onChange={(e) => setNextEventStatus(e.target.value as EventStatus)}
                  >
                    <option value="draft">draft — En preparación</option>
                    <option value="open">open — Abierto (activación de equipos)</option>
                    <option value="running">running — En curso (escaneos activos)</option>
                    <option value="paused">paused — En pausa temporal</option>
                    <option value="closed">closed — Finalizado</option>
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="admin-event-reason">
                    Motivo del cambio
                  </label>
                  <input
                    id="admin-event-reason"
                    type="text"
                    className="input"
                    placeholder="Ej. Arranque oficial del rally"
                    value={eventReason}
                    onChange={(e) => setEventReason(e.target.value)}
                  />
                </div>

                <button
                  type="submit"
                  className="btn btn--primary btn--block"
                  disabled={eventStatusMutation.isPending}
                >
                  {eventStatusMutation.isPending
                    ? 'Guardando estado...'
                    : 'Aplicar estado del evento'}
                </button>
              </form>
            </section>

            <section className="card">
              <span className="brand-kicker">Parámetros y Limpieza</span>
              <h2 className="card-title">Nombre, cantidad de QRs requeridos y reinicio</h2>
              <p className="card-subtitle">
                Ajusta cuántos QRs necesita completar cada equipo para desbloquear a Linux (p. ej.
                8, 10 o 12 QRs para 12 equipos) o limpia los datos de prueba.
              </p>

              {eventConfigMutation.error instanceof ApiError && (
                <div className="banner banner--error" role="alert">
                  {eventConfigMutation.error.message}
                </div>
              )}

              {eventConfigMutation.isSuccess && (
                <div className="banner banner--success" role="status">
                  Configuración guardada (meta: <strong>{data.event.target} QRs</strong>).
                </div>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  eventConfigMutation.mutate();
                }}
                style={{ marginBottom: 18 }}
              >
                <div className="form-group">
                  <label className="form-label" htmlFor="cfg-event-name">
                    Nombre del evento
                  </label>
                  <input
                    id="cfg-event-name"
                    type="text"
                    className="input"
                    value={eventNameInput}
                    onChange={(e) => setEventNameInput(e.target.value)}
                    required
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="cfg-event-target">
                    QRs necesarios para desbloquear la ubicación final (meta)
                  </label>
                  <input
                    id="cfg-event-target"
                    type="number"
                    className="input"
                    min={1}
                    max={50}
                    value={eventTargetInput}
                    onChange={(e) => setEventTargetInput(e.target.value)}
                    required
                  />
                </div>

                <button
                  type="submit"
                  className="btn btn--secondary btn--block"
                  disabled={eventConfigMutation.isPending}
                >
                  {eventConfigMutation.isPending
                    ? 'Actualizando...'
                    : 'Guardar nombre y meta de QRs'}
                </button>
              </form>

              <hr style={{ borderColor: 'var(--border-subtle)', margin: '14px 0' }} />

              {resetDataMutation.isSuccess && (
                <div className="banner banner--success" role="status">
                  Datos del evento limpiados correctamente. Tu sesión de administrador sigue activa.
                </div>
              )}

              <div className="form-group" style={{ marginBottom: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={wipeStationsToo}
                    onChange={(e) => setWipeStationsToo(e.target.checked)}
                  />
                  <span style={{ fontSize: '0.88rem' }}>
                    Borrar también todas las estaciones QR y pistas actuales
                  </span>
                </label>
              </div>

              <button
                type="button"
                className="btn btn--danger btn--block"
                disabled={resetDataMutation.isPending}
                onClick={() => {
                  const msg = wipeStationsToo
                    ? '¿Seguro que deseas borrar TODOS los equipos, escaneos, estaciones QR y pistas para empezar desde cero?'
                    : '¿Seguro que deseas borrar todos los equipos y su progreso (conservando las estaciones QR y pistas)?';
                  if (window.confirm(msg)) {
                    resetDataMutation.mutate();
                  }
                }}
              >
                {resetDataMutation.isPending
                  ? 'Limpiando datos...'
                  : 'Eliminar datos de prueba / Reiniciar evento'}
              </button>
            </section>
          </div>

          {/* GESTIÓN DE ESTACIONES QR, COORDENADAS Y PISTAS */}
          <section className="card">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                flexWrap: 'wrap',
                gap: 12,
                marginBottom: 8,
              }}
            >
              <div>
                <span className="brand-kicker">Estaciones del Campus y Radar GPS</span>
                <h2 className="card-title">
                  Estaciones QR ({data.qr_points.length} registradas · meta actual:{' '}
                  {data.event.target})
                </h2>
              </div>
              <a
                href="/api/admin/qr-sheets.pdf"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn--primary btn--sm"
                style={{ textDecoration: 'none' }}
              >
                Descargar PDF de los {data.qr_points.length} QRs para imprimir
              </a>
            </div>
            <p className="card-subtitle">
              Crea tantas estaciones QR como necesites para tus ~12 equipos. Si agregas coordenadas
              a una estación, los equipos verán el aviso <strong>«¡Cerca de una pista!»</strong>{' '}
              cuando estén dentro del radio configurado (sin revelarles nunca las coordenadas).
            </p>

            <div className="admin-grid-2" style={{ marginBottom: 20 }}>
              {/* Formulario Crear / Editar Estación QR */}
              <div className="station-card">
                <h3 className="card-title" style={{ fontSize: '1.05rem' }}>
                  Crear o actualizar estación QR
                </h3>

                {upsertQrMutation.error instanceof ApiError && (
                  <div className="banner banner--error" role="alert">
                    {upsertQrMutation.error.message}
                  </div>
                )}

                {upsertQrMutation.isSuccess && (
                  <div className="banner banner--success" role="status">
                    Estación <strong>{upsertQrMutation.data.slug}</strong> guardada. Ahora puedes
                    agregarle pistas a la derecha.
                  </div>
                )}

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    upsertQrMutation.mutate();
                  }}
                >
                  <div className="form-group">
                    <label className="form-label" htmlFor="qr-slug">
                      Identificador corto (slug, ej. biblioteca, lab-redes)
                    </label>
                    <input
                      id="qr-slug"
                      type="text"
                      className="input"
                      placeholder="biblioteca"
                      value={qrSlug}
                      onChange={(e) =>
                        setQrSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))
                      }
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="qr-public-name">
                      Nombre visible al escanear el QR
                    </label>
                    <input
                      id="qr-public-name"
                      type="text"
                      className="input"
                      placeholder="Estación 1 — Biblioteca Central"
                      value={qrPublicName}
                      onChange={(e) => setQrPublicName(e.target.value)}
                      required
                    />
                  </div>

                  <div className="admin-grid-2">
                    <div className="form-group">
                      <label className="form-label" htmlFor="qr-order">
                        Orden (#)
                      </label>
                      <input
                        id="qr-order"
                        type="number"
                        className="input"
                        min={0}
                        max={500}
                        value={qrSortOrder}
                        onChange={(e) => setQrSortOrder(e.target.value)}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label" htmlFor="qr-radius">
                        Radio «Cerca de pista» (metros)
                      </label>
                      <input
                        id="qr-radius"
                        type="number"
                        className="input"
                        min={10}
                        max={500}
                        value={qrRadius}
                        onChange={(e) => setQrRadius(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="admin-grid-2">
                    <div className="form-group">
                      <label className="form-label" htmlFor="qr-lat">
                        Latitud (opcional, para radar)
                      </label>
                      <input
                        id="qr-lat"
                        type="text"
                        className="input"
                        placeholder="Ej. 27.476300"
                        value={qrLat}
                        onChange={(e) => setQrLat(e.target.value)}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label" htmlFor="qr-lng">
                        Longitud (opcional, para radar)
                      </label>
                      <input
                        id="qr-lng"
                        type="text"
                        className="input"
                        placeholder="Ej. -99.516400"
                        value={qrLng}
                        onChange={(e) => setQrLng(e.target.value)}
                      />
                    </div>
                  </div>

                  {qrGpsStatus && (
                    <div className="banner banner--info" style={{ marginBottom: 10 }}>
                      {qrGpsStatus}
                    </div>
                  )}

                  <div className="stack-row" style={{ marginBottom: 12 }}>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={handleCaptureStationGps}
                    >
                      Usar mi ubicación GPS actual
                    </button>
                    <label
                      style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                    >
                      <input
                        type="checkbox"
                        checked={qrIsActive}
                        onChange={(e) => setQrIsActive(e.target.checked)}
                      />
                      <span style={{ fontSize: '0.88rem' }}>Estación activa</span>
                    </label>
                  </div>

                  <button
                    type="submit"
                    className="btn btn--primary btn--block"
                    disabled={upsertQrMutation.isPending}
                  >
                    {upsertQrMutation.isPending
                      ? 'Guardando estación...'
                      : 'Guardar estación QR'}
                  </button>
                </form>
              </div>

              {/* Formulario Agregar Pista a una Estación */}
              <div className="station-card">
                <h3 className="card-title" style={{ fontSize: '1.05rem' }}>
                  Agregar pista que apunte a una estación
                </h3>
                <p className="card-subtitle">
                  Cada pista apunta a su estación destino. El servidor solo entrega esta pista a
                  equipos que <strong>todavía no han registrado</strong> esa estación.
                </p>

                {addClueMutation.error instanceof ApiError && (
                  <div className="banner banner--error" role="alert">
                    {addClueMutation.error.message}
                  </div>
                )}

                {addClueMutation.isSuccess && (
                  <div className="banner banner--success" role="status">
                    Pista agregada a <strong>{addClueMutation.data.qr_slug}</strong>.
                  </div>
                )}

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    addClueMutation.mutate();
                  }}
                >
                  <div className="form-group">
                    <label className="form-label" htmlFor="clue-target-slug">
                      Estación destino a la que apunta la pista
                    </label>
                    <select
                      id="clue-target-slug"
                      className="select"
                      value={clueTargetSlug}
                      onChange={(e) => setClueTargetSlug(e.target.value)}
                      required
                    >
                      <option value="" disabled>
                        Selecciona una estación...
                      </option>
                      {data.qr_points.map((pt) => (
                        <option key={pt.slug} value={pt.slug}>
                          {pt.slug} — {pt.public_name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="clue-body">
                      Texto de la pista para los equipos
                    </label>
                    <textarea
                      id="clue-body"
                      className="input"
                      rows={4}
                      placeholder="Escribe el acertijo o referencia para que encuentren esta estación..."
                      value={clueBodyInput}
                      onChange={(e) => setClueBodyInput(e.target.value)}
                      required
                    />
                  </div>

                  <button
                    type="submit"
                    className="btn btn--primary btn--block"
                    disabled={addClueMutation.isPending || data.qr_points.length === 0}
                  >
                    {addClueMutation.isPending ? 'Guardando pista...' : 'Agregar pista a estación'}
                  </button>
                </form>
              </div>
            </div>

            {data.qr_points.length === 0 ? (
              <div className="banner banner--info">
                No hay estaciones QR cargadas en este momento. Usa el formulario de arriba para
                crear tus estaciones y agregarles sus pistas.
              </div>
            ) : (
              <div className="station-grid">
                {data.qr_points.map((pt) => (
                  <div key={pt.slug} className="station-card">
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      <span className="brand-kicker">
                        #{pt.sort_order} · {pt.slug}
                      </span>
                      <span
                        className={pt.is_active ? 'badge badge--running' : 'badge badge--closed'}
                      >
                        {pt.is_active ? 'Activo' : 'Inactivo'}
                      </span>
                    </div>

                    <div style={{ fontWeight: 800, fontSize: '1.05rem', margin: '6px 0 8px' }}>
                      {pt.public_name}
                    </div>

                    <div
                      style={{
                        fontSize: '0.84rem',
                        color: 'var(--text-secondary)',
                        marginBottom: 10,
                      }}
                    >
                      <div>
                        Encontrada por: <strong>{pt.found_by} equipos</strong> · Apuntada ahora:{' '}
                        <strong>{pt.pointed_by} equipos</strong>
                      </div>
                      <div>
                        Radar GPS:{' '}
                        {pt.lat != null && pt.lng != null ? (
                          <strong>
                            {pt.lat.toFixed(5)}, {pt.lng.toFixed(5)} (radio {pt.proximity_radius_m}{' '}
                            m)
                          </strong>
                        ) : (
                          <span>Sin coordenadas</span>
                        )}
                      </div>
                    </div>

                    {/* Lista de pistas de esta estación */}
                    <div style={{ marginBottom: 10 }}>
                      <div
                        style={{
                          fontSize: '0.78rem',
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          color: 'var(--text-muted)',
                          marginBottom: 4,
                        }}
                      >
                        Pistas que apuntan aquí ({pt.clues_list?.length ?? pt.clues}):
                      </div>
                      {pt.clues_list && pt.clues_list.length > 0 ? (
                        <ul
                          style={{
                            listStyle: 'none',
                            padding: 0,
                            margin: 0,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 6,
                          }}
                        >
                          {pt.clues_list.map((c) => (
                            <li
                              key={c.id}
                              style={{
                                background: 'rgba(15, 23, 42, 0.55)',
                                border: '1px solid var(--border-subtle)',
                                borderRadius: 8,
                                padding: '6px 8px',
                                fontSize: '0.82rem',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'flex-start',
                                gap: 8,
                              }}
                            >
                              <span>{c.body}</span>
                              <button
                                type="button"
                                className="btn btn--danger btn--sm"
                                style={{ minHeight: 28, padding: '2px 8px', fontSize: '0.75rem' }}
                                onClick={() => deleteClueMutation.mutate(c.id)}
                                title="Eliminar esta pista"
                              >
                                ×
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div style={{ fontSize: '0.8rem', color: 'var(--warning)' }}>
                          ⚠ Agrega al menos 1 pista para que el apuntador pueda enviar equipos a
                          esta estación.
                        </div>
                      )}
                    </div>

                    <div className="stack-row" style={{ marginTop: 8 }}>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={() => handleCopyQrLink(pt.slug, pt.code)}
                      >
                        {copiedQrSlug === pt.slug ? '¡Enlace copiado!' : 'Copiar enlace QR'}
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={() => loadStationIntoForm(pt)}
                      >
                        Editar
                      </button>
                      <button
                        type="button"
                        className="btn btn--danger btn--sm"
                        onClick={() => {
                          if (
                            window.confirm(
                              `¿Eliminar la estación "${pt.public_name}" (${pt.slug}) y sus pistas?`,
                            )
                          ) {
                            deleteQrMutation.mutate(pt.slug);
                          }
                        }}
                      >
                        Eliminar
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* TABLA DE EQUIPOS EN VIVO */}
          <section className="card">
            <span className="brand-kicker">Seguimiento en Tiempo Real</span>
            <h2 className="card-title">Equipos registrados ({data.teams.length})</h2>

            {issuedCodeResult && (
              <div className="banner banner--success" role="status">
                <div>
                  Código de activación emitido para <strong>{issuedCodeResult.public_id}</strong>{' '}
                  (sesiones anteriores revocadas: <strong>{issuedCodeResult.sessions_revoked}</strong>
                  ):
                </div>
                <div className="code-box">{issuedCodeResult.code}</div>
                <div className="stack-row">
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => handleCopyCode(issuedCodeResult.code)}
                  >
                    {copiedNotice ? '¡Código copiado!' : 'Copiar código'}
                  </button>
                  <span style={{ fontSize: '0.8rem' }}>
                    Vence: {formatTimeShort(issuedCodeResult.expires_at)}
                  </span>
                </div>
              </div>
            )}

            {data.teams.length === 0 ? (
              <div className="banner banner--info">
                No hay equipos registrados todavía. Crea tus equipos abajo (por ejemplo{' '}
                <code>TEC-001</code> al <code>TEC-012</code>) y pulsa «Emitir código» para obtener
                su clave de activación.
              </div>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Equipo</th>
                      <th>Estado</th>
                      <th>Sesión</th>
                      <th>Progreso</th>
                      <th>Pista apunta a</th>
                      <th>Llegada</th>
                      <th>Acciones rápidas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.teams.map((t) => (
                      <tr key={t.public_id}>
                        <td>
                          <strong>{t.public_id}</strong>
                        </td>
                        <td>
                          <div>{t.name}</div>
                          {t.found.length > 0 && (
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                              QR: {t.found.map((f) => f.slug).join(', ')}
                            </div>
                          )}
                        </td>
                        <td>
                          <span
                            className={
                              t.status === 'active' ? 'badge badge--running' : 'badge badge--danger'
                            }
                          >
                            {t.status === 'active' ? 'Activo' : 'Deshabilitado'}
                          </span>
                        </td>
                        <td>
                          {t.session_active ? (
                            <span className="badge badge--running">Activa</span>
                          ) : (
                            <span className="badge badge--closed">Sin sesión</span>
                          )}
                        </td>
                        <td>
                          <strong>
                            {t.found_count} / {t.target}
                          </strong>
                        </td>
                        <td>{t.pointer_slug ?? '—'}</td>
                        <td>
                          {t.finish && !t.finish.voided ? (
                            <span className="badge badge--running">
                              #{t.finish.rank} ({formatTimeShort(t.finish.confirmed_at)})
                            </span>
                          ) : t.finish?.voided ? (
                            <span className="badge badge--danger">Anulada</span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>
                          <div className="stack-row">
                            <button
                              type="button"
                              className="btn btn--primary btn--sm"
                              onClick={() =>
                                issueActivationMutation.mutate({
                                  publicId: t.public_id,
                                  reason: 'Emisión directa desde tabla de equipos',
                                })
                              }
                            >
                              Emitir código
                            </button>
                            <button
                              type="button"
                              className="btn btn--secondary btn--sm"
                              onClick={() => {
                                setActTeamId(t.public_id);
                                setStatusTeamId(t.public_id);
                                setScanTeamId(t.public_id);
                                setVoidFinishTeamId(t.public_id);
                              }}
                            >
                              Seleccionar
                            </button>
                            <button
                              type="button"
                              className="btn btn--danger btn--sm"
                              onClick={() => {
                                if (window.confirm(`¿Eliminar el equipo ${t.public_id}?`)) {
                                  deleteTeamMutation.mutate(t.public_id);
                                }
                              }}
                            >
                              Eliminar
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ACCIONES OPERATIVAS SIN TOCAR TABLAS */}
          <div className="admin-grid-2">
            {/* Crear equipo */}
            <section className="card">
              <span className="brand-kicker">Registro en Mesa</span>
              <h3 className="card-title">Crear nuevo equipo</h3>
              <p className="card-subtitle">
                Da de alta a los equipos participantes (ej. <code>TEC-001</code> a{' '}
                <code>TEC-012</code>).
              </p>

              {createTeamMutation.error instanceof ApiError && (
                <div className="banner banner--error" role="alert">
                  {createTeamMutation.error.message}
                </div>
              )}

              {createTeamMutation.isSuccess && createTeamMutation.data && (
                <div className="banner banner--success" role="status">
                  Equipo <strong>{createTeamMutation.data.public_id}</strong> creado. Pulsa «Emitir
                  código» en la tabla superior para darle su clave de acceso.
                </div>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  createTeamMutation.mutate();
                }}
              >
                <div className="form-group">
                  <label className="form-label" htmlFor="new-team-id">
                    ID público (formato TEC-001 o solo 1)
                  </label>
                  <input
                    id="new-team-id"
                    type="text"
                    className="input"
                    placeholder="TEC-001"
                    value={newTeamId}
                    onChange={(e) => setNewTeamId(e.target.value.toUpperCase())}
                    required
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="new-team-name">
                    Nombre del equipo
                  </label>
                  <input
                    id="new-team-name"
                    type="text"
                    className="input"
                    placeholder="Ej. Kernel Panic"
                    value={newTeamName}
                    onChange={(e) => setNewTeamName(e.target.value)}
                    required
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="new-team-members">
                    Integrantes (opcional, separados por coma)
                  </label>
                  <input
                    id="new-team-members"
                    type="text"
                    className="input"
                    placeholder="Ana Pérez, Luis Garza"
                    value={newTeamMembers}
                    onChange={(e) => setNewTeamMembers(e.target.value)}
                  />
                </div>

                <button
                  type="submit"
                  className="btn btn--primary btn--block"
                  disabled={createTeamMutation.isPending}
                >
                  {createTeamMutation.isPending ? 'Creando equipo...' : 'Crear equipo'}
                </button>
              </form>
            </section>

            {/* Emitir código de activación / transferencia de teléfono */}
            <section className="card card--clue">
              <span className="brand-kicker">Cambio de Teléfono / Re-activación</span>
              <h3 className="card-title">Emitir credencial de activación</h3>
              <p className="card-subtitle">
                Genera un código de un solo uso y revoca cualquier sesión anterior del equipo. El
                progreso de QR se conserva intacto.
              </p>

              {issueActivationMutation.error instanceof ApiError && (
                <div className="banner banner--error" role="alert">
                  {issueActivationMutation.error.message}
                </div>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  issueActivationMutation.mutate(undefined);
                }}
              >
                <div className="form-group">
                  <label className="form-label" htmlFor="act-team-id">
                    ID público del equipo
                  </label>
                  <input
                    id="act-team-id"
                    type="text"
                    className="input"
                    placeholder="TEC-001"
                    value={actTeamId}
                    onChange={(e) => setActTeamId(e.target.value.toUpperCase())}
                    required
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="act-ttl">
                    Vigencia del código (minutos)
                  </label>
                  <input
                    id="act-ttl"
                    type="number"
                    className="input"
                    min={5}
                    max={10080}
                    value={actTtlMinutes}
                    onChange={(e) => setActTtlMinutes(e.target.value)}
                    required
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="act-reason">
                    Motivo obligatorio (mín. 3 caracteres)
                  </label>
                  <input
                    id="act-reason"
                    type="text"
                    className="input"
                    placeholder="Ej. Entrega inicial o cambio de teléfono"
                    value={actReason}
                    onChange={(e) => setActReason(e.target.value)}
                    required
                  />
                </div>

                <button
                  type="submit"
                  className="btn btn--primary btn--block"
                  disabled={issueActivationMutation.isPending}
                >
                  {issueActivationMutation.isPending
                    ? 'Generando código...'
                    : 'Emitir nuevo código de activación'}
                </button>
              </form>
            </section>

            {/* Corrección de progreso por incidencia: agregar o anular QR */}
            <section className="card">
              <span className="brand-kicker">Respaldo por Incidencia</span>
              <h3 className="card-title">Corregir progreso de QR</h3>
              <p className="card-subtitle">
                Agrega manualmente una estación QR dañada o anula un registro por error con motivo
                de auditoría obligatorio.
              </p>

              {scanCorrectionMutation.error instanceof ApiError && (
                <div className="banner banner--error" role="alert">
                  {scanCorrectionMutation.error.message}
                </div>
              )}

              {scanCorrectionMutation.isSuccess && (
                <div className="banner banner--success" role="status">
                  Corrección de QR aplicada y apuntador de pista sincronizado.
                </div>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  scanCorrectionMutation.mutate();
                }}
              >
                <div className="form-group">
                  <label className="form-label" htmlFor="scan-team-id">
                    ID público del equipo
                  </label>
                  <input
                    id="scan-team-id"
                    type="text"
                    className="input"
                    placeholder="TEC-001"
                    value={scanTeamId}
                    onChange={(e) => setScanTeamId(e.target.value.toUpperCase())}
                    required
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="scan-qr-slug">
                    Estación QR (slug)
                  </label>
                  <select
                    id="scan-qr-slug"
                    className="select"
                    value={scanQrSlug}
                    onChange={(e) => setScanQrSlug(e.target.value)}
                  >
                    {data.qr_points.map((pt) => (
                      <option key={pt.slug} value={pt.slug}>
                        {pt.slug} — {pt.public_name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="scan-action">
                    Acción
                  </label>
                  <select
                    id="scan-action"
                    className="select"
                    value={scanAction}
                    onChange={(e) => setScanAction(e.target.value as 'add' | 'void')}
                  >
                    <option value="add">Agregar QR manual (/api/admin/scans/add)</option>
                    <option value="void">Anular QR registrado (/api/admin/scans/void)</option>
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="scan-reason">
                    Motivo obligatorio
                  </label>
                  <input
                    id="scan-reason"
                    type="text"
                    className="input"
                    placeholder="Ej. Impresión física dañada verificada con foto"
                    value={scanReason}
                    onChange={(e) => setScanReason(e.target.value)}
                    required
                  />
                </div>

                <button
                  type="submit"
                  className="btn btn--secondary btn--block"
                  disabled={scanCorrectionMutation.isPending || data.qr_points.length === 0}
                >
                  {scanCorrectionMutation.isPending
                    ? 'Aplicando corrección...'
                    : scanAction === 'add'
                      ? 'Agregar QR manualmente'
                      : 'Anular QR del equipo'}
                </button>
              </form>
            </section>

            {/* Habilitar / deshabilitar equipo y Anular llegada */}
            <section className="card">
              <span className="brand-kicker">Control Disciplinario y Llegadas</span>
              <h3 className="card-title">Estado de equipo / Anular llegada</h3>

              {teamStatusMutation.error instanceof ApiError && (
                <div className="banner banner--error" role="alert">
                  {teamStatusMutation.error.message}
                </div>
              )}

              {teamStatusMutation.isSuccess && (
                <div className="banner banner--success" role="status">
                  Estado del equipo actualizado correctamente.
                </div>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  teamStatusMutation.mutate();
                }}
                style={{ marginBottom: 24 }}
              >
                <div className="form-group">
                  <label className="form-label" htmlFor="status-team-id">
                    ID público del equipo
                  </label>
                  <input
                    id="status-team-id"
                    type="text"
                    className="input"
                    placeholder="TEC-001"
                    value={statusTeamId}
                    onChange={(e) => setStatusTeamId(e.target.value.toUpperCase())}
                    required
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="status-target">
                    Nuevo estado
                  </label>
                  <select
                    id="status-target"
                    className="select"
                    value={statusTarget}
                    onChange={(e) => setStatusTarget(e.target.value as 'active' | 'disabled')}
                  >
                    <option value="active">active — Habilitado</option>
                    <option value="disabled">disabled — Deshabilitado</option>
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="status-reason">
                    Motivo obligatorio
                  </label>
                  <input
                    id="status-reason"
                    type="text"
                    className="input"
                    placeholder="Motivo del cambio de estado"
                    value={statusReason}
                    onChange={(e) => setStatusReason(e.target.value)}
                    required
                  />
                </div>

                <button
                  type="submit"
                  className="btn btn--secondary btn--block"
                  disabled={teamStatusMutation.isPending}
                >
                  {teamStatusMutation.isPending
                    ? 'Actualizando...'
                    : 'Cambiar estado del equipo'}
                </button>
              </form>

              <hr style={{ borderColor: 'var(--border-subtle)', margin: '18px 0' }} />

              <h4 className="card-title" style={{ fontSize: '1rem' }}>
                Anular llegada registrada (/api/admin/finishes/void)
              </h4>

              {voidFinishMutation.error instanceof ApiError && (
                <div className="banner banner--error" role="alert">
                  {voidFinishMutation.error.message}
                </div>
              )}

              {voidFinishMutation.isSuccess && (
                <div className="banner banner--success" role="status">
                  Llegada anulada y ranking recalculado.
                </div>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  voidFinishMutation.mutate();
                }}
              >
                <div className="form-group">
                  <label className="form-label" htmlFor="void-finish-team">
                    ID público del equipo
                  </label>
                  <input
                    id="void-finish-team"
                    type="text"
                    className="input"
                    placeholder="TEC-001"
                    value={voidFinishTeamId}
                    onChange={(e) => setVoidFinishTeamId(e.target.value.toUpperCase())}
                    required
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="void-finish-reason">
                    Motivo obligatorio de anulación
                  </label>
                  <input
                    id="void-finish-reason"
                    type="text"
                    className="input"
                    placeholder="Ej. Confirmación por error de lectura de ID"
                    value={voidFinishReason}
                    onChange={(e) => setVoidFinishReason(e.target.value)}
                    required
                  />
                </div>

                <button
                  type="submit"
                  className="btn btn--danger btn--block"
                  disabled={voidFinishMutation.isPending}
                >
                  {voidFinishMutation.isPending ? 'Anulando llegada...' : 'Anular llegada'}
                </button>
              </form>
            </section>
          </div>

          {/* BITÁCORA DE AUDITORÍA */}
          <section className="card">
            <span className="brand-kicker">Trazabilidad Completa</span>
            <h2 className="card-title">Bitácora de auditoría reciente</h2>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Hora</th>
                    <th>Actor</th>
                    <th>Acción</th>
                    <th>Equipo</th>
                    <th>Detalles</th>
                  </tr>
                </thead>
                <tbody>
                  {(auditQuery.data?.entries ?? []).map((entry, idx) => (
                    <tr key={`${entry.created_at}-${idx}`}>
                      <td>{formatTimeShort(entry.created_at)}</td>
                      <td>
                        <span className="badge badge--closed">{entry.actor_kind}</span>{' '}
                        {entry.actor ?? '—'}
                      </td>
                      <td>
                        <strong>{entry.action}</strong>
                      </td>
                      <td>{entry.team ?? '—'}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                        {JSON.stringify(entry.details)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
