import React, { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import BeaverAvatar from '../components/BeaverAvatar';

export default function VerifyEmail() {
  const [email, setEmail] = useState('');
  const [digits, setDigits] = useState(['', '', '', '', '', '']);
  const [step, setStep] = useState('email'); // 'email' | 'code'
  const { request, loading, error } = useApi();
  const navigate = useNavigate();
  const inputRefs = useRef([]);

  const handleDigitChange = (index, value) => {
    if (!/^\d?$/.test(value)) return;
    const newDigits = [...digits];
    newDigits[index] = value;
    setDigits(newDigits);
    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index, e) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handleVerify = async (e) => {
    e.preventDefault();
    const code = digits.join('');
    if (code.length < 6) return;
    try {
      await request('/auth/verify-email', {
        method: 'POST',
        body: JSON.stringify({ email, code }),
      });
      navigate('/login');
    } catch {}
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: '1rem' }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <BeaverAvatar agent="director" size="sm" />
          <h1 style={{ marginTop: '1rem', fontSize: '1.5rem', fontWeight: 700 }}>Verify Email</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginTop: '0.25rem' }}>Enter your email and verification code</p>
        </div>
        <div className="card">
          {step === 'email' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="form-group">
                <label className="form-label">Email address</label>
                <input className="form-input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={() => setStep('code')} disabled={!email}>
                Continue
              </button>
            </div>
          ) : (
            <form onSubmit={handleVerify} style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              <div>
                <label className="form-label" style={{ marginBottom: '0.75rem', display: 'block' }}>6-digit code</label>
                <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
                  {digits.map((digit, i) => (
                    <input
                      key={i}
                      ref={el => inputRefs.current[i] = el}
                      type="text"
                      inputMode="numeric"
                      maxLength={1}
                      value={digit}
                      onChange={e => handleDigitChange(i, e.target.value)}
                      onKeyDown={e => handleKeyDown(i, e)}
                      style={{
                        width: 44, height: 52, textAlign: 'center', fontSize: '1.25rem',
                        background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                        color: 'var(--text)', outline: 'none', fontWeight: 600,
                        borderColor: digit ? 'var(--lime)' : 'var(--border)',
                      }}
                    />
                  ))}
                </div>
              </div>
              {error && <div style={{ color: 'var(--orange)', fontSize: '0.875rem' }}>{error}</div>}
              <button className="btn btn-primary" type="submit" disabled={loading || digits.join('').length < 6} style={{ width: '100%', justifyContent: 'center' }}>
                {loading ? 'Verifying...' : 'Verify Email'}
              </button>
            </form>
          )}
        </div>
        <p style={{ textAlign: 'center', marginTop: '1rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          <button onClick={() => navigate('/login')} style={{ background: 'none', border: 'none', color: 'var(--lime)', cursor: 'pointer' }}>Back to login</button>
        </p>
      </div>
    </div>
  );
}
