import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';

export default function AuthPage() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') await login(form.email, form.password);
      else await register(form);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const isRegister = mode === 'register';

  return (
    <div className="auth">
      <div className="auth__panel">
        <div className="auth__brand">
          <div className="sidebar__logo" aria-hidden="true">A</div>
          <div>
            <strong>AMB BOARD</strong>
            <small>LIFE MANAGEMENT</small>
          </div>
        </div>
        <h1>{isRegister ? 'Create your account' : 'Welcome back'}</h1>
        <p className="auth__lead">One life. One intelligent system. Everything connected.</p>

        <form onSubmit={submit} noValidate>
          {isRegister && (
            <div className="field">
              <label htmlFor="auth-name">Your name</label>
              <input id="auth-name" type="text" autoComplete="name" required value={form.name} onChange={set('name')} />
            </div>
          )}
          <div className="field">
            <label htmlFor="auth-email">Email</label>
            <input id="auth-email" type="email" autoComplete="email" required value={form.email} onChange={set('email')} />
          </div>
          <div className="field">
            <label htmlFor="auth-password">Password</label>
            <input id="auth-password" type="password" required minLength={10}
              autoComplete={isRegister ? 'new-password' : 'current-password'} value={form.password} onChange={set('password')}
              aria-describedby={isRegister ? 'auth-pw-hint' : undefined} />
            {isRegister && <small id="auth-pw-hint" className="hint">At least 10 characters.</small>}
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy && <Loader2 size={16} className="spin" aria-hidden="true" />}
            {isRegister ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <button type="button" className="auth__switch" onClick={() => { setMode(isRegister ? 'login' : 'register'); setError(''); }}>
          {isRegister ? 'Already have an account? Sign in' : 'New here? Create an account'}
        </button>
      </div>
    </div>
  );
}
