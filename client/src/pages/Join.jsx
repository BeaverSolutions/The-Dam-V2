import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { setUser } from '../utils/auth';

export default function Join() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const navigate = useNavigate();
  const { request } = useApi();

  const [tokenInfo, setTokenInfo] = useState(null);
  const [tokenError, setTokenError] = useState(null);
  const [checking, setChecking] = useState(true);

  const [form, setForm] = useState({ email: '', password: '', display_name: '' });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  useEffect(() => {
    if (!token) {
      setTokenError('No invite token found in this link.');
      setChecking(false);
      return;
    }
    request(`/auth/join?token=${encodeURIComponent(token)}`)
      .then(res => {
        setTokenInfo(res.data);
        setChecking(false);
      })
      .catch(err => {
        setTokenError(err.message || 'This invite link is invalid or has expired.');
        setChecking(false);
      });
  }, [token]);

  const handleChange = (e) => setForm(f => ({ ...f, [e.target.name]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitError(null);
    if (form.password.length < 8) {
      setSubmitError('Password must be at least 8 characters.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await request('/auth/join', {
        method: 'POST',
        body: JSON.stringify({ token, ...form }),
      });
      if (res?.data) {
        setUser(res.data.user);
        navigate('/');
      }
    } catch (err) {
      setSubmitError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
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
      <div style={{ width: '100%', maxWidth: 420 }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1rem' }}>
            <img src="/assets/logo-new.png" alt="Beaver Solutions" style={{ width: 64, height: 64, objectFit: 'contain' }} />
          </div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.25rem', fontFamily: "'Nunito', 'Poppins', sans-serif" }}>
            <span style={{ color: 'var(--brand)' }}>Beaver</span>{' '}
            <span style={{ color: 'var(--text)' }}>Solutions</span>
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>BeavrDam — Client Portal</p>
        </div>

        <div className="card">
          {checking && (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
              Validating invite link...
            </div>
          )}

          {!checking && tokenError && (
            <div style={{ textAlign: 'center', padding: '1.5rem' }}>
              <div style={{ color: 'var(--orange)', fontSize: '0.9rem', marginBottom: '1rem' }}>{tokenError}</div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Contact <a href="mailto:hello@beaver.solutions" style={{ color: 'var(--brand)' }}>hello@beaver.solutions</a> for a new invite.
              </p>
            </div>
          )}

          {!checking && tokenInfo && (
            <>
              <div style={{ marginBottom: '1.5rem' }}>
                <h2 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.4rem' }}>You're invited</h2>
                <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                  Set up your account to join <strong style={{ color: 'var(--text)' }}>{tokenInfo.client_name}</strong> on BeavrDam.
                </p>
              </div>

              <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div className="form-group">
                  <label className="form-label">Your name</label>
                  <input
                    className="form-input"
                    type="text"
                    name="display_name"
                    value={form.display_name}
                    onChange={handleChange}
                    placeholder="e.g. Adrian"
                    maxLength={100}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Email</label>
                  <input
                    className="form-input"
                    type="email"
                    name="email"
                    value={form.email}
                    onChange={handleChange}
                    placeholder="you@company.com"
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Password</label>
                  <input
                    className="form-input"
                    type="password"
                    name="password"
                    value={form.password}
                    onChange={handleChange}
                    placeholder="Min. 8 characters"
                    required
                  />
                </div>

                {submitError && (
                  <div style={{ color: 'var(--orange)', fontSize: '0.875rem', padding: '0.5rem', background: 'rgba(255,140,0,0.1)', borderRadius: 'var(--radius)' }}>
                    {submitError}
                  </div>
                )}

                <button className="btn btn-primary" type="submit" disabled={submitting} style={{ width: '100%', justifyContent: 'center', padding: '0.75rem' }}>
                  {submitting ? 'Creating account...' : 'Create account'}
                </button>
              </form>
            </>
          )}
        </div>

        <p style={{ textAlign: 'center', marginTop: '1rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          Already have an account?{' '}
          <a href="/login" style={{ color: 'var(--brand)', textDecoration: 'none' }}>Sign in</a>
        </p>
      </div>
    </div>
  );
}
