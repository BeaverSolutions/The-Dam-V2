import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import BeaverAvatar from '../components/BeaverAvatar';

export default function AccessCode() {
  const [code, setCode] = useState('');
  const { request, loading, error } = useApi();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      await request('/auth/verify-access-code', {
        method: 'POST',
        body: JSON.stringify({ code: code.toUpperCase(), deviceFingerprint: navigator.userAgent }),
      });
      navigate('/');
    } catch {}
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: '1rem' }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <BeaverAvatar agent="director" size="sm" />
          <h1 style={{ marginTop: '1rem', fontSize: '1.5rem', fontWeight: 700 }}>Access Code</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Enter your BEAVER-XXXX-XXXX access code</p>
        </div>
        <div className="card">
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div className="form-group">
              <label className="form-label">Access Code</label>
              <input
                className="form-input"
                value={code}
                onChange={e => setCode(e.target.value.toUpperCase())}
                placeholder="BEAVER-XXXX-XXXX"
                style={{ fontFamily: 'monospace', fontSize: '1rem', letterSpacing: '0.05em' }}
              />
            </div>
            {error && <div style={{ color: 'var(--orange)', fontSize: '0.875rem' }}>{error}</div>}
            <button className="btn btn-primary" type="submit" disabled={loading} style={{ width: '100%', justifyContent: 'center' }}>
              {loading ? 'Verifying...' : 'Authorise Device'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
