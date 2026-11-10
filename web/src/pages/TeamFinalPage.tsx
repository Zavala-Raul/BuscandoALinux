import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  ApiError,
  formatTimeShort,
  getLastSeenFinalVersion,
  getMyState,
  getTeamFinalLocation,
  loadCachedTeamState,
  setLastSeenFinalVersion,
} from '../api.js';

export function TeamFinalPage() {
  const navigate = useNavigate();
  const [versionIncreasedNotice, setVersionIncreasedNotice] = useState<number | null>(null);

  const meQuery = useQuery({
    queryKey: ['team-state'],
    queryFn: getMyState,
    refetchInterval: 10_000,
    retry: false,
  });

  const locQuery = useQuery({
    queryKey: ['team-final-location'],
    queryFn: getTeamFinalLocation,
    refetchInterval: 10_000,
    retry: false,
  });

  const isSessionInvalid =
    (meQuery.error instanceof ApiError && meQuery.error.code === 'session_invalid') ||
    (locQuery.error instanceof ApiError && locQuery.error.code === 'session_invalid');

  useEffect(() => {
    if (isSessionInvalid) {
      navigate('/acceso', { replace: true });
    }
  }, [isSessionInvalid, navigate]);

  useEffect(() => {
    if (locQuery.data) {
      const currentVersion = locQuery.data.version;
      const prevVersion = getLastSeenFinalVersion();
      if (prevVersion !== null && currentVersion > prevVersion) {
        setVersionIncreasedNotice(currentVersion);
      }
      setLastSeenFinalVersion(currentVersion);
    }
  }, [locQuery.data]);

  const teamState = meQuery.data ?? loadCachedTeamState();
  const publicId = teamState?.team.public_id ?? 'TU-ID';

  const locError = locQuery.error instanceof ApiError ? locQuery.error : null;
  const isNotPublished = locError?.code === 'final_not_published';
  const isLocked = locError?.code === 'final_locked';

  const loc = locQuery.data;
  const mapsUrl = loc
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${loc.lat},${loc.lng}`)}`
    : '#';

  return (
    <main className="app-shell">
      <header className="top-header">
        <div className="brand-block">
          <span className="brand-kicker">
            Etapa Final · {teamState?.event.target ?? 6} de {teamState?.event.target ?? 6} QR
          </span>
          <h1 className="brand-title">Ubicación de Linux</h1>
        </div>
        <div className="team-pill">{publicId}</div>
      </header>

      {teamState?.finish && (
        <section className="card card--highlight finish-hero">
          <span className="brand-kicker">Llegada presencial confirmada</span>
          <h2 className="card-title">Posición oficial registrada</h2>
          <div className="finish-rank">#{teamState.finish.rank}</div>
          <p className="card-subtitle" style={{ marginBottom: 0 }}>
            Hora oficial del servidor: <strong>{formatTimeShort(teamState.finish.confirmed_at)}</strong>
          </p>
        </section>
      )}

      {isLocked && (
        <section className="card card--warning" role="alert">
          <h2 className="card-title">Ubicación final aún bloqueada</h2>
          <p className="card-subtitle">{locError.message}</p>
          <Link to="/" className="btn btn--primary btn--block">
            Volver a mis pistas ({teamState?.found_count ?? 0} / {teamState?.event.target ?? 6})
          </Link>
        </section>
      )}

      {isNotPublished && (
        <section className="card card--warning" role="status">
          <span className="brand-kicker">En espera del organizador</span>
          <h2 className="card-title">Esperando a que el organizador publique la ubicación...</h2>
          <p className="card-subtitle">
            Tu equipo ya desbloqueó la etapa final. En cuanto el organizador publique las
            coordenadas oficiales aparecerán aquí automáticamente (actualización cada 10 segundos).
          </p>
          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={() => locQuery.refetch()}
            disabled={locQuery.isFetching}
          >
            {locQuery.isFetching ? 'Consultando servidor...' : 'Actualizar ubicación ahora'}
          </button>
        </section>
      )}

      {locError && !isNotPublished && !isLocked && (
        <div className="banner banner--error" role="alert">
          {locError.message}
        </div>
      )}

      {loc && (
        <section className="card card--highlight">
          {versionIncreasedNotice !== null && (
            <div className="banner banner--info" role="status">
              ¡Atención! El organizador actualizó la ubicación final a la versión v
              {versionIncreasedNotice}. Revisa la nueva referencia y coordenadas.
            </div>
          )}

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 8,
              marginBottom: 8,
            }}
          >
            <span className="brand-kicker">Punto de encuentro oficial</span>
            <span className="badge badge--running">Versión v{loc.version}</span>
          </div>

          <h2 className="card-title">Referencia en el campus</h2>
          <div className="clue-body">{loc.reference}</div>

          <div className="kv-list">
            <div className="kv-item">
              <div className="kv-label">Coordenadas (lat, lng)</div>
              <div className="kv-value">
                {loc.lat.toFixed(6)}, {loc.lng.toFixed(6)}
              </div>
            </div>
            <div className="kv-item">
              <div className="kv-label">Precisión estimada</div>
              <div className="kv-value">
                {loc.accuracy_m !== null ? `±${Math.round(loc.accuracy_m)} m` : 'Manual / Fija'}
              </div>
            </div>
            <div className="kv-item">
              <div className="kv-label">Actualizado</div>
              <div className="kv-value">{formatTimeShort(loc.updated_at)}</div>
            </div>
          </div>

          <div className="stack-row" style={{ marginTop: 14, marginBottom: 16 }}>
            <a
              href={mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn--primary btn--block"
            >
              Abrir en Google Maps
            </a>
          </div>

          <div className="banner banner--info" style={{ marginBottom: 0 }}>
            Muestra tu ID ({publicId}) al organizador al llegar para registrar tu posición oficial
          </div>
        </section>
      )}

      <div className="stack-row" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="btn btn--secondary btn--block"
          onClick={() => {
            meQuery.refetch();
            locQuery.refetch();
          }}
          disabled={locQuery.isFetching || meQuery.isFetching}
        >
          {locQuery.isFetching ? 'Actualizando...' : 'Actualizar datos'}
        </button>
        <Link to="/" className="btn btn--secondary btn--block">
          Volver al resumen de mi equipo
        </Link>
      </div>
    </main>
  );
}
