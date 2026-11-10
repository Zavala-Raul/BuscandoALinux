import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  activateTeam,
  ApiError,
  consumePendingQrCode,
  peekPendingQrCode,
} from '../api.js';

export function TeamActivatePage() {
  const [code, setCode] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pendingQr = peekPendingQrCode();

  const mutation = useMutation({
    mutationFn: async (rawCode: string) => {
      return activateTeam(rawCode);
    },
    onSuccess: (state) => {
      queryClient.setQueryData(['team-state'], state);
      const nextQr = consumePendingQrCode();
      if (nextQr) {
        navigate(`/q/${encodeURIComponent(nextQr)}`, { replace: true });
      } else {
        navigate('/', { replace: true });
      }
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    const trimmed = code.trim().toUpperCase();
    if (trimmed.length < 6) {
      setLocalError('Ingresa el código de activación entregado en la mesa de registro.');
      return;
    }
    mutation.mutate(trimmed);
  }

  const errorMessage =
    localError ??
    (mutation.error instanceof ApiError
      ? mutation.error.message
      : mutation.error
        ? 'No se pudo activar el equipo. Intenta nuevamente.'
        : null);

  return (
    <main className="app-shell">
      <header className="top-header">
        <div className="brand-block">
          <span className="brand-kicker">Rally Presencial ISC · ITNL</span>
          <h1 className="brand-title">Buscando a Linux</h1>
        </div>
        <span className="badge badge--open">Activación</span>
      </header>

      {pendingQr && (
        <div className="banner banner--info" role="status">
          Tienes un punto QR listo para registrar. Activa primero tu equipo en este dispositivo y te
          llevaremos automáticamente a confirmar el punto.
        </div>
      )}

      <section className="card card--highlight">
        <h2 className="card-title">Activar acceso del equipo</h2>
        <p className="card-subtitle">
          Ingresa tu código de un solo uso (ejemplo: <strong>XXXX-XXXX-XXXX</strong>). Solo un
          teléfono por equipo puede mantener la sesión activa a la vez.
        </p>

        {errorMessage && (
          <div className="banner banner--error" role="alert">
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <div className="form-group">
            <label className="form-label" htmlFor="activation-code">
              Código de activación
            </label>
            <input
              id="activation-code"
              type="text"
              className="input input--code"
              placeholder="XXXX-XXXX-XXXX"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              disabled={mutation.isPending}
              required
            />
            <span className="form-hint">
              Si tu equipo necesita cambiar de teléfono por batería, solicita un nuevo código en la
              mesa de administración.
            </span>
          </div>

          <button
            type="submit"
            className="btn btn--primary btn--block"
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'Activando equipo...' : 'Activar equipo en este teléfono'}
          </button>
        </form>
      </section>

      <section className="card">
        <h3 className="card-title">¿Ya tenías sesión en este navegador?</h3>
        <p className="card-subtitle">
          Si ya activaste tu equipo aquí, vuelve a la pantalla principal para ver tu pista actual.
        </p>
        <div className="stack-row">
          <Link to="/" className="btn btn--secondary btn--block">
            Ir a mi progreso del rally
          </Link>
        </div>
      </section>

      <footer style={{ textAlign: 'center', marginTop: 24, fontSize: '0.85rem' }}>
        <Link to="/staff/login">Acceso para organizadores y staff</Link>
      </footer>
    </main>
  );
}
