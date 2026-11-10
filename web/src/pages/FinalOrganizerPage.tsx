import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  confirmTeamFinish,
  formatEventStatus,
  formatTimeShort,
  getFinalCurrentLocation,
  getStaffMe,
  lookupTeamForFinal,
  normalizePublicId,
  publishFinalLocation,
  staffLogout,
} from '../api.js';
import type { StaffTeamView } from '../../../shared/contracts.js';

export function FinalOrganizerPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const staffQuery = useQuery({
    queryKey: ['staff-me'],
    queryFn: getStaffMe,
    retry: false,
  });

  const currentLocQuery = useQuery({
    queryKey: ['final-current-location'],
    queryFn: getFinalCurrentLocation,
    retry: false,
  });

  useEffect(() => {
    if (staffQuery.error instanceof ApiError && staffQuery.error.code === 'session_invalid') {
      navigate('/staff/login', { replace: true });
    }
  }, [staffQuery.error, navigate]);

  // Estado del formulario de ubicación final
  const [latStr, setLatStr] = useState('');
  const [lngStr, setLngStr] = useState('');
  const [accuracyStr, setAccuracyStr] = useState('');
  const [reference, setReference] = useState('');
  const [gpsStatus, setGpsStatus] = useState<{
    kind: 'idle' | 'loading' | 'success' | 'error';
    message: string | null;
  }>({ kind: 'idle', message: null });
  const [locFormError, setLocFormError] = useState<string | null>(null);
  const [locInitialized, setLocInitialized] = useState(false);

  useEffect(() => {
    if (!locInitialized && currentLocQuery.data?.location) {
      const loc = currentLocQuery.data.location;
      setLatStr(String(loc.lat));
      setLngStr(String(loc.lng));
      setAccuracyStr(loc.accuracy_m !== null ? String(Math.round(loc.accuracy_m)) : '');
      setReference(loc.reference);
      setLocInitialized(true);
    }
  }, [currentLocQuery.data, locInitialized]);

  function handleGetGps() {
    setLocFormError(null);
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setGpsStatus({
        kind: 'error',
        message:
          'Este navegador o dispositivo no tiene geolocalización disponible. Captura latitud y longitud manualmente.',
      });
      return;
    }

    setGpsStatus({
      kind: 'loading',
      message: 'Solicitando coordenadas de alta precisión al GPS del teléfono...',
    });

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Number(pos.coords.latitude.toFixed(6));
        const lng = Number(pos.coords.longitude.toFixed(6));
        const acc = Number.isFinite(pos.coords.accuracy)
          ? Math.round(pos.coords.accuracy)
          : null;
        setLatStr(String(lat));
        setLngStr(String(lng));
        setAccuracyStr(acc !== null ? String(acc) : '');
        setGpsStatus({
          kind: 'success',
          message: `Ubicación obtenida por GPS${acc !== null ? ` (precisión ±${acc} m)` : ''}. Puedes ajustarla manualmente antes de publicar.`,
        });
      },
      (err) => {
        let msg =
          'No se pudo obtener el GPS. Captura o edita las coordenadas manualmente abajo.';
        if (err.code === 1) {
          msg =
            'Permiso de ubicación denegado en el navegador. Puedes activar el permiso o ingresar latitud y longitud manualmente.';
        } else if (err.code === 2) {
          msg =
            'Señal GPS no disponible en este momento. Ingresa o edita las coordenadas manualmente.';
        } else if (err.code === 3) {
          msg =
            'Tiempo de espera agotado (12s) buscando señal GPS. Intenta de nuevo al aire libre o captura las coordenadas manualmente.';
        }
        setGpsStatus({
          kind: 'error',
          message: msg,
        });
      },
      {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 0,
      },
    );
  }

  const publishMutation = useMutation({
    mutationFn: async () => {
      const lat = Number(latStr.trim());
      const lng = Number(lngStr.trim());
      const accTrimmed = accuracyStr.trim();
      const accuracy_m = accTrimmed === '' ? null : Number(accTrimmed);
      return publishFinalLocation({
        lat,
        lng,
        accuracy_m,
        reference: reference.trim(),
      });
    },
    onSuccess: (loc) => {
      queryClient.setQueryData(['final-current-location'], { location: loc });
    },
  });

  function handlePublishSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocFormError(null);
    const lat = Number(latStr.trim());
    const lng = Number(lngStr.trim());
    const accTrimmed = accuracyStr.trim();
    const acc = accTrimmed === '' ? null : Number(accTrimmed);

    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      setLocFormError('Ingresa una latitud válida entre -90 y 90 (ej. 25.726500).');
      return;
    }
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      setLocFormError('Ingresa una longitud válida entre -180 y 180 (ej. -100.186200).');
      return;
    }
    if (acc !== null && (!Number.isFinite(acc) || acc < 0 || acc > 100000)) {
      setLocFormError('La precisión estimada debe ser un número positivo en metros.');
      return;
    }
    if (reference.trim().length < 3) {
      setLocFormError(
        'Escribe una referencia clara en el campus (mínimo 3 caracteres, ej. "Banca frente al edificio de Sistemas").',
      );
      return;
    }
    publishMutation.mutate();
  }

  // Estado de búsqueda y confirmación presencial de equipos
  const [searchId, setSearchId] = useState('');
  const [lookedUpTeam, setLookedUpTeam] = useState<StaffTeamView | null>(null);
  const [lastConfirmedBanner, setLastConfirmedBanner] = useState<{
    result: 'confirmed' | 'already_confirmed';
    team: StaffTeamView;
  } | null>(null);
  const [recentFinishes, setRecentFinishes] = useState<StaffTeamView[]>([]);

  const lookupMutation = useMutation({
    mutationFn: async (rawId: string) => {
      return lookupTeamForFinal(rawId);
    },
    onSuccess: (team) => {
      setLookedUpTeam(team);
      setLastConfirmedBanner(null);
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async (publicId: string) => {
      return confirmTeamFinish(publicId);
    },
    onSuccess: (res) => {
      setLookedUpTeam(res.team);
      setLastConfirmedBanner(res);
      setRecentFinishes((prev) => {
        const filtered = prev.filter((t) => t.public_id !== res.team.public_id);
        return [res.team, ...filtered];
      });
    },
  });

  function handleLookupSubmit(e: React.FormEvent) {
    e.preventDefault();
    const normalized = normalizePublicId(searchId);
    setSearchId(normalized);
    lookupMutation.mutate(normalized);
  }

  async function handleLogout() {
    try {
      await staffLogout();
    } finally {
      queryClient.clear();
      navigate('/staff/login', { replace: true });
    }
  }

  const parsedLat = Number(latStr.trim());
  const parsedLng = Number(lngStr.trim());
  const hasValidPreviewCoords =
    latStr.trim() !== '' &&
    lngStr.trim() !== '' &&
    Number.isFinite(parsedLat) &&
    Number.isFinite(parsedLng) &&
    parsedLat >= -90 &&
    parsedLat <= 90 &&
    parsedLng >= -180 &&
    parsedLng <= 180;

  const previewMapsUrl = hasValidPreviewCoords
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        `${parsedLat},${parsedLng}`,
      )}`
    : null;

  const publishedLoc = currentLocQuery.data?.location ?? null;
  const staff = staffQuery.data?.staff;
  const eventInfo = staffQuery.data?.event;

  return (
    <main className="app-shell">
      <header className="top-header">
        <div className="brand-block">
          <span className="brand-kicker">
            Organizador Final {staff ? `· ${staff.display_name}` : ''}
          </span>
          <h1 className="brand-title">Meta Presencial (Linux)</h1>
          {eventInfo && (
            <div style={{ marginTop: 4 }}>
              <span
                className={
                  eventInfo.status === 'running' ? 'badge badge--running' : 'badge badge--paused'
                }
              >
                {formatEventStatus(eventInfo.status)}
              </span>
            </div>
          )}
        </div>
        <div className="stack-row">
          {staff?.roles.includes('admin') && (
            <Link to="/admin" className="btn btn--secondary btn--sm">
              Panel Admin
            </Link>
          )}
          <button type="button" className="btn btn--secondary btn--sm" onClick={handleLogout}>
            Salir
          </button>
        </div>
      </header>

      {/* SECCIÓN 2 PRIMERO O SECCIÓN 1 PRIMERO: Ambas claramente separadas */}
      <section className="card card--highlight">
        <span className="brand-kicker">Sección 1 · Coordenadas del Organizador</span>
        <h2 className="card-title">Publicar ubicación final</h2>
        <p className="card-subtitle">
          Solo los equipos que hayan completado los 6 de 6 códigos QR podrán ver esta ubicación. Si
          te mueves de lugar en el campus, publica una nueva versión.
        </p>

        {publishedLoc && (
          <div className="banner banner--info" role="status">
            <strong>Ubicación publicada actual (v{publishedLoc.version}):</strong>{' '}
            {publishedLoc.reference} ({publishedLoc.lat.toFixed(6)}, {publishedLoc.lng.toFixed(6)})
            · Actualizado: {formatTimeShort(publishedLoc.updated_at)}
          </div>
        )}

        <div className="form-group">
          <button
            type="button"
            className="btn btn--secondary btn--block"
            onClick={handleGetGps}
            disabled={gpsStatus.kind === 'loading'}
          >
            {gpsStatus.kind === 'loading'
              ? 'Obteniendo coordenadas GPS...'
              : 'Obtener mi ubicación actual (GPS)'}
          </button>
        </div>

        {gpsStatus.message && (
          <div
            className={`banner ${
              gpsStatus.kind === 'error'
                ? 'banner--error'
                : gpsStatus.kind === 'success'
                  ? 'banner--success'
                  : 'banner--info'
            }`}
            role="status"
          >
            {gpsStatus.message}
          </div>
        )}

        {locFormError && (
          <div className="banner banner--error" role="alert">
            {locFormError}
          </div>
        )}

        {publishMutation.error instanceof ApiError && (
          <div className="banner banner--error" role="alert">
            {publishMutation.error.message}
          </div>
        )}

        {publishMutation.isSuccess && publishMutation.data && (
          <div className="banner banner--success" role="status">
            Ubicación final publicada correctamente (versión v{publishMutation.data.version}).
          </div>
        )}

        <form onSubmit={handlePublishSubmit} noValidate>
          <div className="admin-grid-2">
            <div className="form-group">
              <label className="form-label" htmlFor="final-lat">
                Latitud (editable)
              </label>
              <input
                id="final-lat"
                type="number"
                step="any"
                className="input"
                placeholder="ej. 25.726540"
                value={latStr}
                onChange={(e) => setLatStr(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="final-lng">
                Longitud (editable)
              </label>
              <input
                id="final-lng"
                type="number"
                step="any"
                className="input"
                placeholder="ej. -100.186210"
                value={lngStr}
                onChange={(e) => setLngStr(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="final-acc">
              Precisión estimada en metros (opcional)
            </label>
            <input
              id="final-acc"
              type="number"
              step="any"
              className="input"
              placeholder="ej. 10"
              value={accuracyStr}
              onChange={(e) => setAccuracyStr(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="final-ref">
              Referencia visual en el campus
            </label>
            <textarea
              id="final-ref"
              rows={2}
              className="textarea"
              placeholder="Ej. Explanada frente al edificio de Ingeniería en Sistemas, junto a la jardinera central."
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              required
            />
          </div>

          {previewMapsUrl && (
            <div style={{ marginBottom: 14 }}>
              <a
                href={previewMapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn--secondary btn--block"
              >
                Revisar este punto en Google Maps antes de publicar
              </a>
            </div>
          )}

          <button
            type="submit"
            className="btn btn--primary btn--block"
            disabled={publishMutation.isPending}
          >
            {publishMutation.isPending
              ? 'Publicando ubicación...'
              : 'Publicar ubicación para equipos con 6/6'}
          </button>
        </form>
      </section>

      <section className="card card--clue">
        <span className="brand-kicker">Sección 2 · Validación en Persona</span>
        <h2 className="card-title">Confirmar llegada presencial</h2>
        <p className="card-subtitle">
          Cuando un equipo llegue físicamente contigo, pídele su ID público (ej.{' '}
          <strong>TEC-001</strong> o escribe solo <strong>001</strong>) para verificar su progreso y
          asignar su lugar de llegada.
        </p>

        <form onSubmit={handleLookupSubmit} noValidate>
          <div className="form-group">
            <label className="form-label" htmlFor="lookup-public-id">
              ID público del equipo
            </label>
            <input
              id="lookup-public-id"
              type="text"
              className="input input--code"
              placeholder="TEC-001 o 001"
              value={searchId}
              onChange={(e) => setSearchId(e.target.value.toUpperCase())}
              autoComplete="off"
              spellCheck={false}
              required
            />
          </div>
          <button
            type="submit"
            className="btn btn--secondary btn--block"
            disabled={lookupMutation.isPending}
          >
            {lookupMutation.isPending ? 'Buscando equipo...' : 'Buscar equipo'}
          </button>
        </form>

        {lookupMutation.error instanceof ApiError && (
          <div className="banner banner--error" role="alert" style={{ marginTop: 14 }}>
            {lookupMutation.error.message}
          </div>
        )}

        {confirmMutation.error instanceof ApiError && (
          <div className="banner banner--error" role="alert" style={{ marginTop: 14 }}>
            {confirmMutation.error.message}
          </div>
        )}

        {lastConfirmedBanner && lastConfirmedBanner.team.finish && (
          <div className="card card--highlight finish-hero" style={{ marginTop: 16 }}>
            <span className="brand-kicker">
              {lastConfirmedBanner.result === 'already_confirmed'
                ? 'Llegada ya registrada previamente'
                : '¡Llegada oficial registrada!'}
            </span>
            <h3 className="card-title" style={{ marginTop: 4 }}>
              {lastConfirmedBanner.team.public_id} · {lastConfirmedBanner.team.name}
            </h3>
            <div className="finish-rank">#{lastConfirmedBanner.team.finish.rank}</div>
            <p className="card-subtitle" style={{ marginBottom: 8 }}>
              Hora oficial: {formatTimeShort(lastConfirmedBanner.team.finish.confirmed_at)}
            </p>
            <p style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', margin: 0 }}>
              Puedes seguir buscando y confirmando a los siguientes equipos en llegar (#2, #3,
              etc.).
            </p>
          </div>
        )}

        {lookedUpTeam && (
          <div className="card" style={{ marginTop: 16, marginBottom: 0 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <div>
                <span className="brand-kicker">{lookedUpTeam.public_id}</span>
                <h3 className="card-title" style={{ marginBottom: 0 }}>
                  {lookedUpTeam.name}
                </h3>
              </div>
              <span
                className={
                  lookedUpTeam.status === 'active' ? 'badge badge--running' : 'badge badge--danger'
                }
              >
                {lookedUpTeam.status === 'active' ? 'Activo' : 'Deshabilitado'}
              </span>
            </div>

            <div className="kv-list">
              <div className="kv-item">
                <div className="kv-label">QR encontrados</div>
                <div className="kv-value">
                  {lookedUpTeam.found_count} / {lookedUpTeam.target}
                </div>
              </div>
              <div className="kv-item">
                <div className="kv-label">Habilitado para meta</div>
                <div className="kv-value">
                  {lookedUpTeam.eligible ? 'Sí (6/6 listos)' : 'No cumple aún'}
                </div>
              </div>
              <div className="kv-item">
                <div className="kv-label">Llegada actual</div>
                <div className="kv-value">
                  {lookedUpTeam.finish && !lookedUpTeam.finish.voided
                    ? `Lugar #${lookedUpTeam.finish.rank} (${formatTimeShort(
                        lookedUpTeam.finish.confirmed_at,
                      )})`
                    : lookedUpTeam.finish?.voided
                      ? 'Llegada anulada'
                      : 'Sin registrar'}
                </div>
              </div>
            </div>

            <button
              type="button"
              className="btn btn--primary btn--block"
              disabled={
                !lookedUpTeam.eligible ||
                confirmMutation.isPending ||
                Boolean(lookedUpTeam.finish && !lookedUpTeam.finish.voided)
              }
              onClick={() => confirmMutation.mutate(lookedUpTeam.public_id)}
            >
              {confirmMutation.isPending
                ? 'Confirmando llegada...'
                : lookedUpTeam.finish && !lookedUpTeam.finish.voided
                  ? `Llegada ya confirmada (#${lookedUpTeam.finish.rank})`
                  : 'Confirmar llegada presencial'}
            </button>
          </div>
        )}

        {recentFinishes.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <h3 className="card-title" style={{ fontSize: '1rem' }}>
              Llegadas confirmadas en esta sesión
            </h3>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Lugar</th>
                    <th>Equipo</th>
                    <th>Hora</th>
                  </tr>
                </thead>
                <tbody>
                  {recentFinishes.map((item) => (
                    <tr key={item.public_id}>
                      <td>
                        <strong>#{item.finish?.rank ?? '—'}</strong>
                      </td>
                      <td>
                        <strong>{item.public_id}</strong> · {item.name}
                      </td>
                      <td>{formatTimeShort(item.finish?.confirmed_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
