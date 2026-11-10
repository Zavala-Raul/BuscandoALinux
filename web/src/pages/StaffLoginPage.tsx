import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, staffLogin } from '../api.js';

export function StaffLoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const loginMutation = useMutation({
    mutationFn: async () => {
      return staffLogin({
        username: username.trim().toLowerCase(),
        password,
      });
    },
    onSuccess: (state) => {
      queryClient.setQueryData(['staff-me'], state);
      const roles = state.staff.roles;
      if (roles.includes('final') && !roles.includes('admin')) {
        navigate('/final-staff', { replace: true });
      } else if (roles.includes('admin')) {
        navigate('/admin', { replace: true });
      } else {
        navigate('/final-staff', { replace: true });
      }
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (username.trim().length < 3 || password.length < 8) {
      setLocalError('Ingresa tu usuario de staff y contraseña (mínimo 8 caracteres).');
      return;
    }
    loginMutation.mutate();
  }

  const errorMessage =
    localError ??
    (loginMutation.error instanceof ApiError
      ? loginMutation.error.message
      : loginMutation.error
        ? 'No se pudo iniciar sesión.'
        : null);

  return (
    <main className="app-shell">
      <header className="top-header">
        <div className="brand-block">
          <span className="brand-kicker">Personal Autorizado · ITNL</span>
          <h1 className="brand-title">Acceso de Staff</h1>
        </div>
        <Link to="/" className="btn btn--secondary btn--sm">
          Equipos
        </Link>
      </header>

      <section className="card card--highlight">
        <h2 className="card-title">Iniciar sesión</h2>
        <p className="card-subtitle">
          Acceso exclusivo para el organizador que tiene a Linux (meta final) y la mesa de
          administración del rally.
        </p>

        {errorMessage && (
          <div className="banner banner--error" role="alert">
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <div className="form-group">
            <label className="form-label" htmlFor="staff-username">
              Usuario
            </label>
            <input
              id="staff-username"
              type="text"
              className="input"
              placeholder="ej. admin o linux_final"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              disabled={loginMutation.isPending}
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="staff-password">
              Contraseña
            </label>
            <input
              id="staff-password"
              type="password"
              className="input"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={loginMutation.isPending}
              required
            />
          </div>

          <button
            type="submit"
            className="btn btn--primary btn--block"
            disabled={loginMutation.isPending}
          >
            {loginMutation.isPending ? 'Verificando credenciales...' : 'Entrar al panel de staff'}
          </button>
        </form>
      </section>
    </main>
  );
}
