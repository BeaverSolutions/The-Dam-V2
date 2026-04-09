import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import BeaverAvatar from '../components/BeaverAvatar';

const steps = [
  { title: 'Connect LinkedIn', subtitle: 'LinkedIn automation available in Sprint 2' },
  { title: 'Define Your ICP', subtitle: 'Describe your ideal customer profile' },
  { title: 'Brand Voice', subtitle: 'How should we sound when we reach out?' },
  { title: 'Set Daily Limits', subtitle: 'How many outreach messages per day?' },
  { title: 'Review First Sequence', subtitle: 'Approve your first outreach sequence' },
];

export default function Onboarding() {
  const [step, setStep] = useState(0);
  const [icp, setIcp] = useState('');
  const [voice, setVoice] = useState('professional');
  const [dailyLimit, setDailyLimit] = useState(20);
  const navigate = useNavigate();

  const handleFinish = () => navigate('/');

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: '1rem' }}>
      <div style={{ width: '100%', maxWidth: 560 }}>
        {/* Progress */}
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '2rem' }}>
          {steps.map((_, i) => (
            <div key={i} style={{ flex: 1, height: 4, borderRadius: 2, background: i <= step ? 'var(--lime)' : 'var(--border)', transition: 'background var(--transition)' }} />
          ))}
        </div>

        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
            <BeaverAvatar agent="director" size="sm" animate />
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>Step {step + 1} of {steps.length}</div>
              <h2 style={{ fontSize: '1.25rem', fontWeight: 600 }}>{steps[step].title}</h2>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>{steps[step].subtitle}</p>
            </div>
          </div>

          <div style={{ minHeight: 160, marginBottom: '1.5rem' }}>
            {step === 0 && (
              <div style={{ textAlign: 'center', padding: '2rem', background: 'rgba(0,180,255,0.05)', borderRadius: 'var(--radius)', border: '1px dashed rgba(0,180,255,0.2)' }}>
                <BeaverAvatar agent="research_beaver" size="sm" />
                <p style={{ color: 'var(--text-muted)', marginTop: '0.75rem', fontSize: '0.875rem' }}>LinkedIn integration coming in Sprint 2. Research Beaver is ready to start finding leads manually.</p>
              </div>
            )}
            {step === 1 && (
              <div className="form-group">
                <label className="form-label">Describe your ideal customer</label>
                <textarea
                  className="form-input"
                  rows={5}
                  value={icp}
                  onChange={e => setIcp(e.target.value)}
                  placeholder="e.g. B2B SaaS companies with 50-500 employees, VP-level or above, focused on sales/marketing..."
                  style={{ resize: 'vertical' }}
                />
              </div>
            )}
            {step === 2 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {['professional', 'friendly', 'direct', 'consultative'].map(v => (
                  <button key={v} onClick={() => setVoice(v)} style={{
                    padding: '0.75rem 1rem',
                    background: voice === v ? 'rgba(200,255,0,0.1)' : 'transparent',
                    border: `1px solid ${voice === v ? 'var(--lime)' : 'var(--border)'}`,
                    borderRadius: 'var(--radius)', color: voice === v ? 'var(--lime)' : 'var(--text)',
                    textAlign: 'left', cursor: 'pointer', textTransform: 'capitalize',
                  }}>
                    {v}
                  </button>
                ))}
              </div>
            )}
            {step === 3 && (
              <div className="form-group">
                <label className="form-label">Messages per day: <strong style={{ color: 'var(--lime)' }}>{dailyLimit}</strong></label>
                <input type="range" min={5} max={100} value={dailyLimit} onChange={e => setDailyLimit(Number(e.target.value))}
                  style={{ width: '100%', accentColor: 'var(--lime)', marginTop: '0.5rem' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  <span>5</span><span>100</span>
                </div>
              </div>
            )}
            {step === 4 && (
              <div style={{ background: 'rgba(168,85,247,0.05)', border: '1px solid rgba(168,85,247,0.2)', borderRadius: 'var(--radius)', padding: '1rem' }}>
                <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>The Director has prepared your first sequence. Review and approve to activate:</p>
                <div style={{ background: 'var(--bg)', borderRadius: 'var(--radius)', padding: '0.75rem', fontSize: '0.875rem' }}>
                  <strong>Day 1:</strong> Cold email intro<br/>
                  <strong>Day 4:</strong> LinkedIn connection<br/>
                  <strong>Day 8:</strong> Follow-up email<br/>
                  <strong>Day 14:</strong> Final touch
                </div>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
            {step > 0 && (
              <button className="btn btn-secondary" onClick={() => setStep(s => s - 1)}>Back</button>
            )}
            {step < steps.length - 1 ? (
              <button className="btn btn-primary" onClick={() => setStep(s => s + 1)}>Continue</button>
            ) : (
              <button className="btn btn-primary" onClick={handleFinish}>Launch BeavrDam 🦫</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
