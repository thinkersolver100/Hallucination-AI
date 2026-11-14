import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ErrorMessage } from '../components/common';

export function LoginPage() {
  const { state, login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [organization, setOrganization] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const destination = (location.state as { from?: string } | null)?.from ?? '/';
  if (state.status === 'authenticated') return <Navigate to={destination} replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password, organization);
      navigate(destination, { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'registration_closed'
          ? new Error('Registration is closed on this server. Ask an administrator for an account.')
          : (err as Error),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="narrow">
      <h1>HaluDec</h1>
      <p className="muted">Measure how often a language model guesses instead of admitting uncertainty.</p>
      <form onSubmit={(e) => void submit(e)} aria-label={mode === 'login' ? 'Sign in' : 'Create account'}>
        <h2>{mode === 'login' ? 'Sign in' : 'Create an account'}</h2>
        <label>
          Email
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            minLength={mode === 'register' ? 12 : 1}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {mode === 'register' && (
          <>
            <p className="muted small">Use at least 12 characters.</p>
            <label>
              Organization name
              <input required maxLength={120} value={organization} onChange={(e) => setOrganization(e.target.value)} />
            </label>
          </>
        )}
        <ErrorMessage error={error} />
        <button type="submit" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
        <button
          type="button"
          className="link"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError(null);
          }}
        >
          {mode === 'login' ? 'Need an account? Register' : 'Have an account? Sign in'}
        </button>
      </form>
    </main>
  );
}
