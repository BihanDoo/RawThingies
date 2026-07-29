import { useCallback, useEffect, useState } from 'react';

const APP_TYPES = ['node'];
const POLL_INTERVAL_MS = 3000;
const TOKEN_KEY = 'raw_thingies_token';

function StatusBadge({ status }) {
  return <span className={`status status-${status || 'unknown'}`}>{status || 'unknown'}</span>;
}

function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      onLogin(data.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page login-page">
      <h1>Raw Thingies</h1>
      <form onSubmit={handleSubmit} className="login-form">
        <input
          type="email"
          placeholder="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button type="submit" disabled={submitting}>{submitting ? 'Signing in…' : 'Sign in'}</button>
        {error && <div className="error">{error}</div>}
      </form>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [apps, setApps] = useState([]);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ name: '', type: 'node', repo: '', branch: 'main', domain: '' });
  const [creating, setCreating] = useState(false);
  const [deployingName, setDeployingName] = useState(null);

  function handleLogin(newToken) {
    localStorage.setItem(TOKEN_KEY, newToken);
    setToken(newToken);
  }

  function handleLogout() {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
  }

  // Wraps fetch with the auth header and bounces back to the login screen
  // on a 401 (expired/invalid token) instead of surfacing a confusing error.
  const apiFetch = useCallback(async (url, opts = {}) => {
    const res = await fetch(url, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` }
    });
    if (res.status === 401) {
      handleLogout();
      throw new Error('Session expired, please sign in again');
    }
    return res;
  }, [token]);

  const loadApps = useCallback(async () => {
    try {
      const res = await apiFetch('/api/apps');
      if (!res.ok) throw new Error(`Failed to load apps (${res.status})`);
      setApps(await res.json());
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [apiFetch]);

  useEffect(() => {
    if (!token) return;
    loadApps();
    const interval = setInterval(loadApps, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [token, loadApps]);

  async function handleCreate(e) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await apiFetch('/api/apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create app');
      setForm({ name: '', type: 'node', repo: '', branch: 'main', domain: '' });
      await loadApps();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleDeploy(name) {
    setDeployingName(name);
    setError(null);
    try {
      const res = await apiFetch(`/api/apps/${encodeURIComponent(name)}/deploy`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start deploy');
      await loadApps();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeployingName(null);
    }
  }

  async function handleRollback(name) {
    if (!confirm(`Roll back ${name} to its previous successful release?`)) return;
    setDeployingName(name);
    setError(null);
    try {
      const res = await apiFetch(`/api/apps/${encodeURIComponent(name)}/rollback`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to roll back');
      await loadApps();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeployingName(null);
    }
  }

  if (!token) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <div className="page">
      <div className="header-row">
        <h1>Raw Thingies</h1>
        <button className="secondary" onClick={handleLogout}>Sign out</button>
      </div>
      {error && <div className="error">{error}</div>}

      <section>
        <h2>Apps</h2>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Domain</th>
              <th>Status</th>
              <th>Last deployed</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {apps.map((a) => (
              <>
                <tr key={a.name}>
                  <td>{a.name}</td>
                  <td>{a.type}</td>
                  <td>{a.domain}</td>
                  <td><StatusBadge status={a.status} /></td>
                  <td>{a.lastDeployedAt ? new Date(a.lastDeployedAt).toLocaleString() : '—'}</td>
                  <td className="actions">
                    <button
                      onClick={() => handleDeploy(a.name)}
                      disabled={deployingName === a.name || a.status === 'deploying'}
                    >
                      {a.status === 'deploying' || deployingName === a.name ? 'Deploying…' : 'Deploy'}
                    </button>
                    <button
                      className="secondary"
                      onClick={() => handleRollback(a.name)}
                      disabled={deployingName === a.name || a.status === 'deploying'}
                    >
                      Rollback
                    </button>
                  </td>
                </tr>
                {a.status === 'failed' && a.lastError && (
                  <tr key={`${a.name}-error`} className="error-row">
                    <td colSpan={6}>{a.lastError}</td>
                  </tr>
                )}
              </>
            ))}
            {apps.length === 0 && (
              <tr>
                <td colSpan={6}>No apps yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Add app</h2>
        <form onSubmit={handleCreate}>
          <input
            placeholder="name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            {APP_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <input
            placeholder="git repo URL"
            value={form.repo}
            onChange={(e) => setForm({ ...form, repo: e.target.value })}
          />
          <input
            placeholder="branch"
            value={form.branch}
            onChange={(e) => setForm({ ...form, branch: e.target.value })}
          />
          <input
            placeholder="domain"
            value={form.domain}
            onChange={(e) => setForm({ ...form, domain: e.target.value })}
            required
          />
          <button type="submit" disabled={creating}>{creating ? 'Creating…' : 'Create'}</button>
        </form>
      </section>
    </div>
  );
}
