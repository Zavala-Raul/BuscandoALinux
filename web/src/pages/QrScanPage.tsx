import React from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  scanQr,
  setPendingQrCode,
} from '../api.js';
import { QR_CODE_REGEX } from '../../../shared/contracts.js';

export function QrScanPage() {
  const { code = '' } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const trimmedCode = code.trim();
  const isCodeFormatValid = QR_CODE_REGEX.test(trimmedCode);

  const scanMutation = useMutation({
    mutationFn: async () => {
      return scanQr(trimmedCode);
    },
    onSuccess: (res) => {
      queryClient.setQueryData(['team-state'], res.state);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'session_invalid') {
        setPendingQrCode(trimmedCode);
        navigate('/acceso', { replace: true });
      }
    },
  });

  function handleRegisterClick() {
    if (!isCodeFormatValid || scanMutation.isPending) return;
    scanMutation.mutate();
  }

  function handleGoToActivate() {
    if (trimmedCode) {
      setPendingQrCode(trimmedCode);
    }
    navigate('/acceso');
  }

  const scanResult = scanMutation.data;
  const error = scanMutation.error instanceof ApiError ? scanMutation.error : null;

  return (
    <main className="app-shell">
      <header className="top-header">
        <div className="brand-block">
          <span className="brand-kicker">Punto de Control QR</span>
          <h1 className="brand-title">Buscando a Linux</h1>
        </div>
        <Link to="/" className="btn btn--secondary btn--sm">
          Inicio
        </Link>
      </header>

      {!scanResult && (
        <section className="card card--highlight">
          <span className="brand-kicker">Código detectado</span>
          <h2 className="card-title">Confirmar registro de estación QR</h2>
          <p className="card-subtitle">
            Presiona el botón para registrar oficialmente este punto en el progreso de tu equipo.
          </p>

          <div className="code-box" aria-label="Código QR detectado">
            {trimmedCode || '—'}
          </div>

          {!isCodeFormatValid && (
            <div className="banner banner--error" role="alert">
              El formato de este código QR no es válido para el rally. Asegúrate de haber escaneado
              un código oficial del campus.
            </div>
          )}

          {error && (
            <div className="banner banner--error" role="alert">
              {error.message}
            </div>
          )}

          <div className="stack-row" style={{ marginTop: 14 }}>
            <button
              type="button"
              className="btn btn--primary btn--block"
              onClick={handleRegisterClick}
              disabled={!isCodeFormatValid || scanMutation.isPending}
            >
              {scanMutation.isPending ? 'Registrando punto...' : 'Registrar este punto'}
            </button>

            <button
              type="button"
              className="btn btn--secondary btn--block"
              onClick={handleGoToActivate}
            >
              ¿Aún no activas tu equipo? Ir a /acceso
            </button>

            <Link to="/" className="btn btn--secondary btn--block">
              Volver a mi pista actual
            </Link>
          </div>
        </section>
      )}

      {scanResult && scanResult.result === 'already_registered' && (
        <section className="card card--warning" role="status">
          <span className="brand-kicker">Punto duplicado</span>
          <h2 className="card-title">Este QR ya fue registrado</h2>
          <p className="card-subtitle">
            Tu equipo ya tenía registrada la estación <strong>{scanResult.qr_name}</strong>. No se
            duplicó el conteo.
          </p>

          <div className="kv-list">
            <div className="kv-item">
              <div className="kv-label">Estación</div>
              <div className="kv-value">{scanResult.qr_name}</div>
            </div>
            <div className="kv-item">
              <div className="kv-label">Progreso oficial</div>
              <div className="kv-value">
                {scanResult.state.found_count} / {scanResult.state.event.target}
              </div>
            </div>
          </div>

          <div className="stack-row" style={{ marginTop: 14 }}>
            <Link to="/" className="btn btn--primary btn--block">
              Volver a mi pista actual
            </Link>
          </div>
        </section>
      )}

      {scanResult && scanResult.result === 'registered' && (
        <section className="card card--highlight" role="status">
          <div className="banner banner--success">
            ¡Punto QR registrado oficialmente por el servidor!
          </div>

          <span className="brand-kicker">Estación confirmada</span>
          <h2 className="card-title">{scanResult.qr_name}</h2>

          <div className="kv-list">
            <div className="kv-item">
              <div className="kv-label">Equipo</div>
              <div className="kv-value">{scanResult.state.team.public_id}</div>
            </div>
            <div className="kv-item">
              <div className="kv-label">Nuevo progreso</div>
              <div className="kv-value">
                {scanResult.state.found_count} / {scanResult.state.event.target}
              </div>
            </div>
          </div>

          {scanResult.state.found_count >= scanResult.state.event.target ? (
            <div className="card card--highlight" style={{ marginTop: 14 }}>
              <span className="brand-kicker">¡Meta desbloqueada!</span>
              <h3 className="card-title">
                ¡Completaste los {scanResult.state.event.target} de {scanResult.state.event.target}{' '}
                puntos QR!
              </h3>
              <p className="card-subtitle">
                Has desbloqueado la ubicación final del organizador que tiene a Linux.
              </p>
              <Link to="/final" className="btn btn--primary btn--block">
                Ver ubicación final ahora
              </Link>
            </div>
          ) : (
            <div className="card card--clue" style={{ marginTop: 14 }}>
              <span className="brand-kicker">Siguiente pista asignada</span>
              <h3 className="card-title">Tu nueva pista</h3>
              {scanResult.state.clue ? (
                <div className="clue-body">{scanResult.state.clue.body}</div>
              ) : (
                <p className="card-subtitle">Consulta tu pantalla principal para continuar.</p>
              )}
            </div>
          )}

          <div className="stack-row" style={{ marginTop: 14 }}>
            <Link to="/" className="btn btn--secondary btn--block">
              Ir al tablero principal del equipo
            </Link>
          </div>
        </section>
      )}
    </main>
  );
}
