import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import BeaverAvatar from '../components/BeaverAvatar';
import { useApi } from '../hooks/useApi';
import { setToken, setUser } from '../utils/auth';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { request, loading, error } = useApi();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const res = await request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      if (res?.data) {
        setToken(res.data.token);
        setUser(res.data.user);
        navigate('/');
      }
    } catch {}
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg)',
      padding: '1rem',
    }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1rem' }}>
            <BeaverAvatar agent="director" size="md" />
          </div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 700, marginBottom: '0.25rem' }}>
            The <span style={{ color: 'var(--lime)' }}>Dam</span>
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
            Always building. Always working. The whole dam crew.
          </p>
        </div>

        {/* Form card */}
        <div className="card">
          <h2 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1.5rem' }}>Sign in</h2>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div className="form-group">
              <label className="form-label">Email</label>
              <input
                className="form-input"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="admin@beaversolutions.com"
                required
              />
            </div>
            <div className="form-group">
              <label className="form-label">Password</label>
              <input
                className="form-input"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
            </div>
            {error && (
              <div style={{ color: 'var(--orange)', fontSize: '0.875rem', padding: '0.5rem', background: 'rgba(255,140,0,0.1)', borderRadius: 'var(--radius)' }}>
                {error}
              </div>
            )}
            <button className="btn btn-primary" type="submit" disabled={loading} style={{ width: '100%', justifyContent: 'center', padding: '0.75rem' }}>
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>

          {/* Demo credentials */}
          <div style={{ marginTop: '1.5rem', padding: '0.75rem', background: 'rgba(200,255,0,0.05)', border: '1px solid rgba(200,255,0,0.1)', borderRadius: 'var(--radius)' }}>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem', fontWeight: 600 }}>Demo credentials:</p>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>admin@beaversolutions.com</p>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>***REMOVED***</p>
          </div>
        </div>

        <p style={{ textAlign: 'center', marginTop: '1rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          Don't have an account?{' '}
          <button onClick={() => navigate('/verify-email')} style={{ background: 'none', border: 'none', color: 'var(--lime)', cursor: 'pointer', fontSize: '0.75rem' }}>
            Verify email
          </button>
        </p>
      </div>
    </div>
  );
}
