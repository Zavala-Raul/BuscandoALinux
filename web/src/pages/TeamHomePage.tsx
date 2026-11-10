import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  ApiError,
  checkProximity,
  extractQrCode,
  formatEventStatus,
  formatTimeShort,
  getMyState,
  getTeamFinalLocation,
  loadCachedTeamState,
} from '../api.js';
import type { ProximityResponse, TeamState } from '../../../shared/contracts.js';

export function TeamHomePage() {
  const navigate = useNavigate();
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [manualInput, setManualInput] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);

  // Estado del radar de cercanía por GPS
  const [proxState, setProxState] = useState<ProximityResponse | null>(null);
  const [proxChecking, setProxChecking] = useState(false);
  const [proxError, setProxError] = useState<string | null>(null);
  const [autoRadar, setAutoRadar] = useState(false);

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const query = useQuery({
    queryKey: ['team-state'],
    queryFn: getMyState,
    refetchInterval: 15_000,
    retry: false,
  });

  const isSessionInvalid =
    query.error instanceof ApiError && query.error.code === 'session_invalid';

  useEffect(() => {
    if (isSessionInvalid) {
      navigate('/acceso', { replace: true });
    }
  }, [isSessionInvalid, navigate]);

  const isNetworkFailure =
    !isOnline || (query.error instanceof ApiError && query.error.isNetworkError);

  const cachedState: TeamState | null = loadCachedTeamState();
  const state: TeamState | null = query.data ?? (isNetworkFailure ? cachedState : null);

  const targetCount = state?.event.target ?? 6;
  const isUnlocked = Boolean(
    state && (state.found_count >= state.event.target || state.final?.unlocked),
  );

  // Consulta directa de la ubicación final cuando el equipo ya completó la meta de QRs
  const finalLocQuery = useQuery({
    queryKey: ['team-final-location'],
    queryFn: getTeamFinalLocation,
    enabled: Boolean(state && isUnlocked && !isNetworkFailure),
    refetchInterval: 10_000,
    retry: false,
  });

  const runProximityCheck = useCallback(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setProxError('Tu navegador no soporta geolocalización.');
      return;
    }
    setProxChecking(true);
    setProxError(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const res = await checkProximity({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy_m: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
          });
          setProxState(res);
        } catch (err) {
          if (err instanceof ApiError) {
            setProxError(err.message);
          } else {
            setProxError('No se pudo verificar la cercanía en este momento.');
          }
        } finally {
          setProxChecking(false);
        }
      },
      (geoErr) => {
        setProxChecking(false);
        setAutoRadar(false);
        if (geoErr.code === geoErr.PERMISSION_DENIED) {
          setProxError('Permiso de ubicación denegado. Actívalo en tu navegador para usar el radar.');
        } else if (geoErr.code === geoErr.TIMEOUT) {
          setProxError('Tiempo de espera de GPS agotado. Intenta al aire libre.');
        } else {
          setProxError('No fue posible obtener la ubicación GPS del teléfono.');
        }
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 5_000 },
    );
  }, []);

  useEffect(() => {
    if (!autoRadar || isUnlocked || isNetworkFailure || state?.event.status !== 'running') {
      return;
    }
    runProximityCheck();
    const timer = window.setInterval(runProximityCheck, 12_000);
    return () => window.clearInterval(timer);
  }, [autoRadar, isUnlocked, isNetworkFailure, state?.event.status, runProximityCheck]);

  function handleManualSubmit(e: React.FormEvent) {
    e.preventDefault();
    setManualError(null);
    const extracted = extractQrCode(manualInput);
    if (!extracted) {
      setManualError(
        'No se reconoció un enlace o código QR válido. Pega el enlace completo o el código del punto.',
      );
      return;
    }
    navigate(`/q/${encodeURIComponent(extracted)}`);
  }

  if (query.isLoading && !state) {
    return (
      <main className="app-shell">
        <div className="card">
          <h1 className="card-title">Cargando estado del equipo...</h1>
          <p className="card-subtitle">Conectando con el servidor oficial del rally.</p>
        </div>
      </main>
    );
  }

  if (!state) {
    const errMsg =
      query.error instanceof ApiError
        ? query.error.message
        : 'Necesitas activar tu equipo para participar en el rally.';
    return (
      <main className="app-shell">
        <header className="top-header">
          <div className="brand-block">
            <span className="brand-kicker">Rally Presencial ISC · ITNL</span>
            <h1 className="brand-title">Buscando a Linux</h1>
          </div>
        </header>
        <section className="card">
          <div className="banner banner--error" role="alert">
            {errMsg}
          </div>
          <div className="stack-row">
            <Link to="/acceso" className="btn btn--primary btn--block">
              Activar mi equipo
            </Link>
            <button
              type="button"
              className="btn btn--secondary btn--block"
              onClick={() => query.refetch()}
            >
              Reintentar conexión
            </button>
          </div>
        </section>
      </main>
    );
  }

  const slots = Array.from({ length: targetCount }, (_, idx) => {
    const item = state.found[idx];
    return {
      index: idx + 1,
      found: item ?? null,
    };
  });

  const statusBadgeClass =
    state.event.status === 'running'
      ? 'badge badge--running'
      : state.event.status === 'paused' || state.event.status === 'open'
        ? 'badge badge--paused'
        : 'badge badge--closed';

  return (
    <main className="app-shell">
      {isNetworkFailure && (
        <div className="banner banner--offline" role="status">
          Sin conexión — mostrando último estado conocido
        </div>
      )}

      <header className="top-header">
        <div className="brand-block">
          <span className="brand-kicker">{state.event.name}</span>
          <h1 className="brand-title">{state.team.name}</h1>
          <div style={{ marginTop: 4 }}>
            <span className={statusBadgeClass}>{formatEventStatus(state.event.status)}</span>
          </div>
        </div>
        <div className="team-pill" title="ID público de tu equipo">
          {state.team.public_id}
        </div>
      </header>

      {state.event.status === 'paused' && (
        <div className="banner banner--paused" role="alert">
          Evento en pausa — los escaneos están temporalmente detenidos
        </div>
      )}

      {state.finish && (
        <section className="card card--highlight finish-hero" aria-live="polite">
          <span className="brand-kicker">Llegada presencial confirmada</span>
          <h2 className="card-title" style={{ marginTop: 6 }}>
            ¡Encontraron a Linux!
          </h2>
          <div className="finish-rank">#{state.finish.rank}</div>
          <p className="card-subtitle" style={{ marginBottom: 4 }}>
            Posición oficial registrada por el organizador para{' '}
            <strong>{state.team.public_id}</strong> ({state.team.name}).
          </p>
          <p style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', margin: 0 }}>
            Hora oficial del servidor: <strong>{formatTimeShort(state.finish.confirmed_at)}</strong>
          </p>
        </section>
      )}

      {isUnlocked && (
        <section className="card card--highlight">
          <span className="brand-kicker">
            ¡{state.found_count} de {targetCount} completados!
          </span>
          <h2 className="card-title">Ubicación final desbloqueada</h2>
          <p className="card-subtitle">
            Tu equipo ha registrado todas las estaciones QR requeridas. Dirígete al punto donde se
            encuentra el organizador con Linux y muestra tu ID{' '}
            <strong>{state.team.public_id}</strong>.
          </p>

          {finalLocQuery.data ? (
            <div style={{ marginBottom: 14 }}>
              <div className="clue-body">{finalLocQuery.data.reference}</div>
              <div className="kv-list">
                <div className="kv-item">
                  <div className="kv-label">Coordenadas</div>
                  <div className="kv-value">
                    {finalLocQuery.data.lat.toFixed(6)}, {finalLocQuery.data.lng.toFixed(6)}
                  </div>
                </div>
                <div className="kv-item">
                  <div className="kv-label">Versión</div>
                  <div className="kv-value">v{finalLocQuery.data.version}</div>
                </div>
              </div>
              <div className="stack-row" style={{ marginTop: 12 }}>
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                    `${finalLocQuery.data.lat},${finalLocQuery.data.lng}`,
                  )}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn--primary btn--block"
                >
                  Abrir en Google Maps
                </a>
              </div>
            </div>
          ) : (
            <div className="banner banner--info" role="status">
              {state.final?.published
                ? 'Cargando coordenadas finales del organizador...'
                : 'Esperando a que el organizador publique la ubicación...'}
            </div>
          )}

          <Link to="/final" className="btn btn--secondary btn--block">
            Ver pantalla completa de ubicación final (/final)
          </Link>
        </section>
      )}

      <section className="card">
        <div className="progress-header">
          <div>
            <h2 className="card-title" style={{ marginBottom: 2 }}>
              Progreso de estaciones QR
            </h2>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Faltan {Math.max(0, targetCount - state.found_count)} por registrar
            </span>
          </div>
          <div className="progress-count">
            {state.found_count} / {targetCount}
          </div>
        </div>

        <div className="progress-grid">
          {slots.map((slot) => (
            <div
              key={slot.index}
              className={`progress-slot ${slot.found ? 'progress-slot--found' : ''}`}
            >
              <span className="progress-slot-num">
                Espacio #{slot.index} {slot.found ? '· Registrado' : '· Pendiente'}
              </span>
              <div className="progress-slot-name">
                {slot.found ? slot.found.name : 'Por encontrar'}
              </div>
              <span className="progress-slot-time">
                {slot.found ? `Hora: ${formatTimeShort(slot.found.scanned_at)}` : '—'}
              </span>
            </div>
          ))}
        </div>
      </section>

      {!isUnlocked && (
        <section className="card card--clue">
          <span className="brand-kicker">Siguiente objetivo</span>
          <h2 className="card-title">Pista actual</h2>
          {state.clue ? (
            <>
              <div className="clue-body">{state.clue.body}</div>
              <p className="card-subtitle" style={{ marginBottom: 0 }}>
                Busca el código QR físico en esa estación del campus y escanéalo con la cámara de
                este teléfono. Si encuentras otro QR válido en el camino, también puedes
                registrarlo.
              </p>
            </>
          ) : (
            <p className="card-subtitle">
              Aún no hay pista asignada o se están preparando las estaciones del evento.
            </p>
          )}

          {state.proximity_enabled && state.event.status === 'running' && (
            <div
              style={{
                marginTop: 16,
                paddingTop: 14,
                borderTop: '1px solid var(--border-subtle)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                <span className="brand-kicker">Radar de Cercanía GPS</span>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  {proxState ? `Revisado: ${formatTimeShort(proxState.checked_at)}` : 'Inactivo'}
                </span>
              </div>

              {proxError && (
                <div className="banner banner--error" role="alert">
                  {proxError}
                </div>
              )}

              {proxState && proxState.zone === 'near' && (
                <div className="banner banner--success" role="status">
                  <strong>¡Cerca de una pista!</strong> Estás dentro del área de un código QR
                  pendiente.{' '}
                  {proxState.is_target
                    ? 'Corresponde al lugar de tu pista actual: busca el QR a tu alrededor.'
                    : 'Hay una estación QR sin registrar muy cerca de ti.'}
                </div>
              )}

              {proxState && proxState.zone === 'approaching' && (
                <div className="banner banner--paused" role="status">
                  <strong>Te estás acercando</strong> — Estás a pocos metros de una zona con pista.
                </div>
              )}

              {proxState && proxState.zone === 'far' && (
                <div className="banner banner--info" role="status">
                  Aún no estás cerca de una estación pendiente. Sigue explorando con la pista.
                </div>
              )}

              <div className="stack-row">
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={runProximityCheck}
                  disabled={proxChecking}
                >
                  {proxChecking ? 'Consultando GPS...' : '¿Estoy cerca de una pista?'}
                </button>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => setAutoRadar((v) => !v)}
                >
                  {autoRadar ? 'Detener radar automático' : 'Activar radar mientras camino'}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      <section className="card">
        <h3 className="card-title">¿Tu cámara abrió otro navegador?</h3>
        <p className="card-subtitle">
          Si al escanear el código QR con la cámara nativa se abre otra aplicación sin tu sesión,
          copia el enlace del QR y pégalo aquí:
        </p>
        {manualError && (
          <div className="banner banner--error" role="alert">
            {manualError}
          </div>
        )}
        <form onSubmit={handleManualSubmit} noValidate>
          <div className="form-group">
            <label className="form-label" htmlFor="manual-qr-input">
              Enlace o código del punto QR
            </label>
            <input
              id="manual-qr-input"
              type="text"
              className="input"
              placeholder="Pega aquí https://.../q/... o el código"
              value={manualInput}
              onChange={(e) => setManualInput(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <button type="submit" className="btn btn--secondary btn--block">
            Ir a pantalla de registro del punto
          </button>
        </form>
      </section>

      <div className="stack-row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          onClick={() => query.refetch()}
          disabled={query.isFetching}
        >
          {query.isFetching ? 'Actualizando...' : 'Actualizar estado'}
        </button>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          Servidor: {formatTimeShort(state.server_time)}
        </span>
      </div>
    </main>
  );
}
