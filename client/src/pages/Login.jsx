import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { setToken, setUser } from '../utils/auth';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState(null);
  const { request, loading, error } = useApi();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLocalError(null);
    try {
      const res = await request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      if (res?.data) {
        setToken(res.data.token);
        setUser(res.data.user);
        navigate('/');
      } else {
        setLocalError('Login failed. Please check your credentials.');
      }
    } catch (err) {
      setLocalError(err.message || 'Login failed. Please try again.');
    }
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
        <div style={{ textAlign: 'center', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '0.75rem' }}>
            <img src="/assets/logo-new.png" alt="Beaver Solutions" style={{ width: 288, height: 288, objectFit: 'contain' }} />
          </div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.25rem', fontFamily: "'Nunito', 'Poppins', sans-serif" }}>
            <span style={{ color: 'var(--brand)' }}>Beaver</span>{' '}
            <span style={{ color: 'var(--text)' }}>Solutions</span>
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
            We ARE the whole Dam Crew!
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
                placeholder="you@company.com"
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
            {(error || localError) && (
              <div style={{ color: 'var(--orange)', fontSize: '0.875rem', padding: '0.5rem', background: 'rgba(255,140,0,0.1)', borderRadius: 'var(--radius)' }}>
                {error || localError}
              </div>
            )}
            <button className="btn btn-primary" type="submit" disabled={loading} style={{ width: '100%', justifyContent: 'center', padding: '0.75rem' }}>
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>
        </div>

        <p style={{ textAlign: 'center', marginTop: '1rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          Need access?{' '}
          <a href="mailto:sales@beaver.solutions" style={{ color: 'var(--brand)', textDecoration: 'none' }}>
            sales@beaver.solutions
          </a>
        </p>
      </div>
    </div>
  );
}
