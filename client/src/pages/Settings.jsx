import React, { useEffect, useState } from 'react';
import { Mail, CheckCircle, XCircle, Search, Save, Eye, EyeOff, Send, AtSign, Calendar, MessageSquare, CreditCard } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { getUser } from '../utils/auth';

function Section({ title, children }) {
  return (
    <div className="card" style={{ marginBottom: '1.5rem' }}>
      <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1.25rem', paddingBottom: '0.75rem', borderBottom: '1px solid var(--border)' }}>{title}</h2>
      {children}
    </div>
  );
}

const fmt = (n) => (n ?? 0).toLocaleString();
const money = (n) => `RM ${fmt(n)}`;

export default function Settings() {
  const { request } = useApi();
  const user = getUser();

  const [integrations, setIntegrations] = useState({ gmail: { connected: false }, agentmail: { connected: false }, apollo: { connected: false }, hunter: { connected: false }, brave: { connected: false } });
  const [intLoading, setIntLoading] = useState(true);

  const [icp, setIcp] = useState({ industries: '', company_size: '', geographies: '', job_titles: '' });
  const [icpLoading, setIcpLoading] = useState(true);
  const [icpSaving, setIcpSaving] = useState(false);
  const [icpSaved, setIcpSaved] = useState(false);

  const [persona, setPersona] = useState({
    company_name: '', company_description: '', value_proposition: '',
    tone: '', differentiator: '', social_proof: '', banned_phrases: '', cta_preference: '',
    sender_name: '', sender_title: '',
  });
  const [personaLoading, setPersonaLoading] = useState(true);
  const [personaSaving, setPersonaSaving] = useState(false);
  const [personaSaved, setPersonaSaved] = useState(false);

  // AgentMail webhook state
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookRegistering, setWebhookRegistering] = useState(false);
  const [webhookRegistered, setWebhookRegistered] = useState(false);
  const [webhookError, setWebhookError] = useState('');

  // Apollo key state
  const [apolloKey, setApolloKey] = useState('');
  const [apolloKeyVisible, setApolloKeyVisible] = useState(false);
  const [apolloSaving, setApolloSaving] = useState(false);
  const [apolloSaved, setApolloSaved] = useState(false);
  const [apolloError, setApolloError] = useState('');

  // Hunter.io key state
  const [hunterKey, setHunterKey] = useState('');
  const [hunterKeyVisible, setHunterKeyVisible] = useState(false);
  const [hunterSaving, setHunterSaving] = useState(false);
  const [hunterSaved, setHunterSaved] = useState(false);
  const [hunterError, setHunterError] = useState('');

  // Brave Search key state
  const [braveKey, setBraveKey] = useState('');
  const [braveKeyVisible, setBraveKeyVisible] = useState(false);
  const [braveSaving, setBraveSaving] = useState(false);
  const [braveSaved, setBraveSaved] = useState(false);
  const [braveError, setBraveError] = useState('');

  // Gmail disconnect
  const [gmailDisconnecting, setGmailDisconnecting] = useState(false);

  // Google Calendar
  const [calendarInfo, setCalendarInfo] = useState({ connected: false, email: null });
  const [calendarConnecting, setCalendarConnecting] = useState(false);
  const [calendarDisconnecting, setCalendarDisconnecting] = useState(false);

  // Calendly
  const [calendlyUrl, setCalendlyUrl] = useState('');
  const [calendlyInfo, setCalendlyInfo] = useState({ connected: false, url: null });
  const [calendlySaving, setCalendlySaving] = useState(false);
  const [calendlySaved, setCalendlySaved] = useState(false);

  // WhatsApp
  const [whatsappNumber, setWhatsappNumber] = useState('');
  const [whatsappInfo, setWhatsappInfo] = useState({ connected: false, number: null });
  const [whatsappSaving, setWhatsappSaving] = useState(false);
  const [whatsappSaved, setWhatsappSaved] = useState(false);

  // Profile / display name
  const [displayName, setDisplayName] = useState(user?.name || '');
  const [nameSaving, setNameSaving] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);

  // Manual billing / upgrade intent
  const [billing, setBilling] = useState(null);
  const [billingLoading, setBillingLoading] = useState(true);
  const [billingPlan, setBillingPlan] = useState(user?.client?.plan || 'growth');
  const [billingTerm, setBillingTerm] = useState('monthly');
  const [billingConfirming, setBillingConfirming] = useState(false);
  const [billingConfirmed, setBillingConfirmed] = useState(false);
  const [billingError, setBillingError] = useState('');

  // Auto-approval threshold (Wave 1)
  const [autoApproveThreshold, setAutoApproveThreshold] = useState('');
  const [autoApproveLoading, setAutoApproveLoading] = useState(true);
  const [autoApproveSaving, setAutoApproveSaving] = useState(false);
  const [autoApproveSaved, setAutoApproveSaved] = useState(false);

  const handleSaveName = async () => {
    setNameSaving(true);
    setNameSaved(false);
    try {
      const res = await request('/auth/profile', { method: 'PUT', body: JSON.stringify({ display_name: displayName }) });
      if (res?.data) {
        const stored = JSON.parse(localStorage.getItem('dam_user') || '{}');
        localStorage.setItem('dam_user', JSON.stringify({ ...stored, name: res.data.display_name }));
        setNameSaved(true);
        setTimeout(() => setNameSaved(false), 2500);
      }
    } catch {}
    setNameSaving(false);
  };

  const loadBilling = () => {
    setBillingLoading(true);
    request('/billing/summary')
      .then(res => {
        if (res?.data) {
          setBilling(res.data);
          setBillingPlan(res.data.client?.plan || user?.client?.plan || 'growth');
        }
      })
      .catch(() => {})
      .finally(() => setBillingLoading(false));
  };

  const handleConfirmUpgrade = async () => {
    setBillingConfirming(true);
    setBillingConfirmed(false);
    setBillingError('');
    try {
      const res = await request('/billing/upgrade-intent', {
        method: 'POST',
        body: JSON.stringify({ plan: billingPlan, term: billingTerm }),
      });
      if (res?.data?.summary) setBilling(res.data.summary);
      setBillingConfirmed(true);
      setTimeout(() => setBillingConfirmed(false), 3500);
    } catch (err) {
      setBillingError(err.message || 'Failed to confirm upgrade');
    } finally {
      setBillingConfirming(false);
    }
  };

  // Load + save auto-approval threshold
  useEffect(() => {
    if (!user?.client_id) { setAutoApproveLoading(false); return; }
    request(`/admin/clients/${user.client_id}`)
      .then(res => {
        const t = res?.data?.auto_approve_threshold;
        setAutoApproveThreshold(t === null || t === undefined ? '' : String(t));
      })
      .catch(() => {})
      .finally(() => setAutoApproveLoading(false));
  }, []);

  const handleSaveAutoApprove = async (newValue) => {
    setAutoApproveThreshold(newValue);
    setAutoApproveSaving(true);
    setAutoApproveSaved(false);
    try {
      const body = {
        auto_approve_threshold: newValue === '' ? null : parseInt(newValue, 10),
      };
      await request(`/admin/clients/${user.client_id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      setAutoApproveSaved(true);
      setTimeout(() => setAutoApproveSaved(false), 2500);
    } catch (err) {
      console.error('Failed to save auto-approval threshold:', err);
    }
    setAutoApproveSaving(false);
  };

  const loadIntegrations = () => {
    request('/integrations/status')
      .then(res => {
        if (res?.data) {
          setIntegrations(res.data);
          if (res.data.calendly) setCalendlyInfo(res.data.calendly);
          if (res.data.google_calendar) setCalendarInfo(res.data.google_calendar);
          if (res.data.whatsapp) setWhatsappInfo(res.data.whatsapp);
        }
      })
      .catch(() => {})
      .finally(() => setIntLoading(false));
  };

  const handleConnectCalendar = async () => {
    setCalendarConnecting(true);
    try {
      const res = await request('/integrations/calendar/connect');
      const url = res?.data?.url;
      if (url) { window.location.href = url; }
      else { alert(res?.data?.message || 'Google Calendar OAuth not configured'); }
    } catch {}
    setCalendarConnecting(false);
  };

  const handleDisconnectCalendar = async () => {
    setCalendarDisconnecting(true);
    try {
      await request('/integrations/calendar', { method: 'DELETE' });
      setCalendarInfo({ connected: false, email: null });
    } catch {}
    setCalendarDisconnecting(false);
  };

  const handleSaveCalendly = async () => {
    if (!calendlyUrl.trim()) return;
    setCalendlySaving(true);
    try {
      const raw = calendlyUrl.trim().replace(/^@/, '');
      const url = raw.startsWith('https://') ? raw
        : raw.startsWith('calendly.com/') ? `https://${raw}`
        : `https://calendly.com/${raw}`;
      const res = await request('/integrations/calendly', { method: 'POST', body: JSON.stringify({ url }) });
      if (res?.data) {
        setCalendlyInfo(res.data);
        setCalendlyUrl('');
        setCalendlySaved(true);
        setTimeout(() => setCalendlySaved(false), 2500);
      }
    } catch {}
    setCalendlySaving(false);
  };

  const handleDisconnectCalendly = async () => {
    try {
      await request('/integrations/calendly', { method: 'DELETE' });
      setCalendlyInfo({ connected: false, url: null });
    } catch {}
  };

  const handleSaveWhatsapp = async () => {
    if (!whatsappNumber.trim()) return;
    setWhatsappSaving(true);
    try {
      const res = await request('/integrations/whatsapp', { method: 'POST', body: JSON.stringify({ number: whatsappNumber.trim() }) });
      if (res?.data) {
        setWhatsappInfo(res.data);
        setWhatsappNumber('');
        setWhatsappSaved(true);
        setTimeout(() => setWhatsappSaved(false), 2500);
      }
    } catch {}
    setWhatsappSaving(false);
  };

  const handleDisconnectWhatsapp = async () => {
    try {
      await request('/integrations/whatsapp', { method: 'DELETE' });
      setWhatsappInfo({ connected: false, number: null });
    } catch {}
  };

  // Check for OAuth callback params in URL (gmail=connected, calendar=connected)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gmailParam = params.get('gmail');
    const calendarParam = params.get('calendar');
    if (gmailParam || calendarParam) {
      window.history.replaceState({}, '', '/settings');
      if (gmailParam === 'connected' || calendarParam === 'connected') {
        loadIntegrations();
      }
    }
  }, []);

  useEffect(() => {
    loadIntegrations();
    loadBilling();

    request('/agents/director/icp')
      .then(res => {
        if (res?.data && Object.keys(res.data).length > 0) {
          setIcp({ industries: '', company_size: '', geographies: '', job_titles: '', ...res.data });
        }
      })
      .catch(() => {})
      .finally(() => setIcpLoading(false));

    request('/agents/persona')
      .then(res => {
        if (res?.data && Object.keys(res.data).length > 0) {
          const d = res.data;
          setPersona({
            company_name: d.company_name || '',
            company_description: d.company_description || '',
            value_proposition: d.value_proposition || '',
            tone: d.tone || '',
            differentiator: d.differentiator || '',
            social_proof: d.social_proof || '',
            banned_phrases: Array.isArray(d.banned_phrases) ? d.banned_phrases.join(', ') : (d.banned_phrases || ''),
            cta_preference: d.cta_preference || '',
            sender_name: d.sender_name || '',
            sender_title: d.sender_title || '',
          });
        }
      })
      .catch(() => {})
      .finally(() => setPersonaLoading(false));
  }, []);

  const handleConnectGmail = async () => {
    try {
      const res = await request('/integrations/gmail/connect');
      const url = res?.data?.url;
      if (url) {
        window.location.href = url;
      } else {
        alert('Gmail OAuth is not configured on the server. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET in server/.env');
      }
    } catch {}
  };

  const handleDisconnectGmail = async () => {
    setGmailDisconnecting(true);
    try {
      await request('/integrations/gmail/disconnect', { method: 'POST' });
      setIntegrations(prev => ({ ...prev, gmail: { connected: false, email: null, label: 'Not connected' } }));
    } catch {}
    setGmailDisconnecting(false);
  };

  const handleRegisterWebhook = async () => {
    if (!webhookUrl.trim()) return;
    setWebhookRegistering(true);
    setWebhookError('');
    try {
      await request('/integrations/agentmail/register-webhook', { method: 'POST', body: JSON.stringify({ webhook_url: webhookUrl.trim() }) });
      setWebhookRegistered(true);
      setTimeout(() => setWebhookRegistered(false), 3000);
    } catch (err) {
      setWebhookError(err?.message || 'Failed to register webhook');
    }
    setWebhookRegistering(false);
  };

  const handleSaveApolloKey = async () => {
    if (!apolloKey.trim()) return;
    setApolloSaving(true);
    setApolloError('');
    try {
      await request('/integrations/apollo/key', { method: 'POST', body: JSON.stringify({ api_key: apolloKey.trim() }) });
      setApolloSaved(true);
      setApolloKey('');
      setTimeout(() => setApolloSaved(false), 2500);
      loadIntegrations();
    } catch (err) {
      setApolloError(err?.message || 'Failed to save key');
    }
    setApolloSaving(false);
  };

  const handleDisconnectApollo = async () => {
    try {
      await request('/integrations/apollo/key', { method: 'DELETE' });
      setIntegrations(prev => ({ ...prev, apollo: { connected: false, label: 'Not configured' } }));
    } catch {}
  };

  const handleSaveHunterKey = async () => {
    if (!hunterKey.trim()) return;
    setHunterSaving(true);
    setHunterError('');
    try {
      await request('/integrations/hunter/key', { method: 'POST', body: JSON.stringify({ api_key: hunterKey.trim() }) });
      setHunterSaved(true);
      setHunterKey('');
      setTimeout(() => setHunterSaved(false), 2500);
      loadIntegrations();
    } catch (err) {
      setHunterError(err?.message || 'Failed to save key');
    }
    setHunterSaving(false);
  };

  const handleDisconnectHunter = async () => {
    try {
      await request('/integrations/hunter/key', { method: 'DELETE' });
      setIntegrations(prev => ({ ...prev, hunter: { connected: false, label: 'Not configured' } }));
    } catch {}
  };

  const handleSaveBraveKey = async () => {
    if (!braveKey.trim()) return;
    setBraveSaving(true);
    setBraveError('');
    try {
      await request('/integrations/brave/key', { method: 'POST', body: JSON.stringify({ api_key: braveKey.trim() }) });
      setBraveSaved(true);
      setBraveKey('');
      setTimeout(() => setBraveSaved(false), 2500);
      loadIntegrations();
    } catch (err) {
      setBraveError(err?.message || 'Failed to save key');
    }
    setBraveSaving(false);
  };

  const handleDisconnectBrave = async () => {
    try {
      await request('/integrations/brave/key', { method: 'DELETE' });
      setIntegrations(prev => ({ ...prev, brave: { connected: false, tenant_key: false, platform_fallback: false, label: 'Not configured' } }));
    } catch {}
  };

  const handleSaveICP = async () => {
    setIcpSaving(true);
    try {
      await request('/agents/director/icp', { method: 'PUT', body: JSON.stringify(icp) });
      setIcpSaved(true);
      setTimeout(() => setIcpSaved(false), 2000);
    } catch {}
    setIcpSaving(false);
  };

  const handleSavePersona = async () => {
    setPersonaSaving(true);
    try {
      // Convert banned_phrases from comma string to array
      const payload = {
        ...persona,
        banned_phrases: persona.banned_phrases
          ? persona.banned_phrases.split(',').map(s => s.trim()).filter(Boolean)
          : [],
      };
      await request('/agents/persona', { method: 'PUT', body: JSON.stringify(payload) });
      setPersonaSaved(true);
      setTimeout(() => setPersonaSaved(false), 2000);
    } catch {}
    setPersonaSaving(false);
  };

  const gmailInfo = integrations.gmail;
  const agentmailInfo = integrations.agentmail;
  const apolloInfo = integrations.apollo;
  const hunterInfo = integrations.hunter;
  const braveInfo = integrations.brave;
  const selectedBillingOption = billing?.plan_options?.find(option => option.term === billingTerm);

  return (
    <div className="fade-in">
      <div className="page-header" style={{ marginBottom: '1.5rem' }}>
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Manage integrations, ideal customer profile, and account details</p>
        </div>
      </div>

      {/* Profile */}
      <Section title="Profile">
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', maxWidth: 400 }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label className="form-label">Display name</label>
            <input
              className="form-input"
              type="text"
              placeholder={user?.email?.split('@')[0] || 'Your name'}
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
            />
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Used in dashboard greetings and the activity log</span>
          </div>
          <button
            className="btn btn-primary"
            onClick={handleSaveName}
            disabled={nameSaving}
            style={{ marginBottom: '1.5rem' }}
          >
            {nameSaved ? <><CheckCircle size={14} /> Saved</> : <><Save size={14} /> Save</>}
          </button>
        </div>
      </Section>

      {/* Billing */}
      <Section title="Billing">
        {billingLoading ? (
          <div className="skeleton" style={{ height: 140, borderRadius: 'var(--radius)' }} />
        ) : (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
              <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.875rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 6 }}>
                  <CreditCard size={14} /> Current status
                </div>
                <div style={{ fontSize: '1rem', fontWeight: 700 }}>{billing?.client?.billing_status || 'trial'}</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4 }}>
                  Trial ends {billing?.client?.trial_ends_at ? new Date(billing.client.trial_ends_at).toLocaleDateString() : '—'}
                </div>
              </div>
              <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.875rem' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 6 }}>Pending invoice</div>
                <div style={{ fontSize: '1rem', fontWeight: 700, color: billing?.pending_charges_rm > 0 ? 'var(--orange)' : 'var(--text)' }}>{money(billing?.pending_charges_rm || 0)}</div>
              </div>
              <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.875rem' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 6 }}>Accumulated charges</div>
                <div style={{ fontSize: '1rem', fontWeight: 700 }}>{money(billing?.accumulated_charges_rm || 0)}</div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', alignItems: 'end' }}>
              <div className="form-group">
                <label className="form-label">Plan</label>
                <select className="form-input" value={billingPlan} onChange={e => setBillingPlan(e.target.value)} disabled={billingConfirming}>
                  <option value="starter">Starter</option>
                  <option value="growth">Growth</option>
                  <option value="enterprise">Enterprise</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Term</label>
                <select className="form-input" value={billingTerm} onChange={e => setBillingTerm(e.target.value)} disabled={billingConfirming}>
                  {billing?.plan_options?.map(option => (
                    <option key={option.term} value={option.term}>
                      {option.label} — {money(option.total_amount_rm)}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ paddingBottom: '1rem' }}>
                <button className="btn btn-primary" onClick={handleConfirmUpgrade} disabled={billingConfirming || !selectedBillingOption}>
                  {billingConfirming ? 'Confirming…' : 'Confirm upgrade intent'}
                </button>
              </div>
            </div>

            {selectedBillingOption && (
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '-0.25rem' }}>
                Total: <strong style={{ color: 'var(--text)' }}>{money(selectedBillingOption.total_amount_rm)}</strong> · {selectedBillingOption.months} month{selectedBillingOption.months === 1 ? '' : 's'} at {money(selectedBillingOption.monthly_amount_rm)}/mo. No card charge here; Beaver Solutions will send an invoice with payment details.
              </div>
            )}
            {billingConfirmed && <div style={{ fontSize: '0.8rem', color: 'var(--lime)', marginTop: '0.75rem' }}><CheckCircle size={13} style={{ verticalAlign: 'middle' }} /> Upgrade intent recorded. Invoice will follow by email.</div>}
            {billingError && <div style={{ fontSize: '0.8rem', color: 'var(--orange)', marginTop: '0.75rem' }}>{billingError}</div>}
          </div>
        )}
      </Section>

      {/* Auto-approval threshold (Wave 1) */}
      <Section title="Auto-approval threshold">
        {autoApproveLoading ? (
          <div className="skeleton" style={{ height: 80, borderRadius: 'var(--radius)' }} />
        ) : (
          <div style={{ maxWidth: 560 }}>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
              Messages scoring at or above this threshold auto-send without human approval.
              Keeps the machine running when you're AFK. Brand-safety failures (wrong name,
              fabricated claims, prompt injection) are always blocked regardless of score.
            </p>
            <div className="form-group">
              <label className="form-label">Threshold</label>
              <select
                className="form-input"
                value={autoApproveThreshold}
                onChange={e => handleSaveAutoApprove(e.target.value)}
                disabled={autoApproveSaving}
                style={{ maxWidth: 320 }}
              >
                <option value="">Off — manual approval only</option>
                <option value="85">85 — conservative (near-perfect only)</option>
                <option value="75">75 — balanced (recommended)</option>
                <option value="65">65 — aggressive (most pass)</option>
              </select>
              {autoApproveSaved && (
                <span style={{ fontSize: '0.72rem', color: 'var(--lime)', marginTop: '0.5rem', display: 'block' }}>
                  <CheckCircle size={12} style={{ verticalAlign: 'middle' }} /> Saved
                </span>
              )}
            </div>
          </div>
        )}
      </Section>

      {/* Integrations */}
      <Section title="Integrations">
        {intLoading ? (
          <div className="skeleton" style={{ height: 120, borderRadius: 'var(--radius)' }} />
        ) : (
          <>
            {/* Gmail */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.875rem 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ width: 36, height: 36, borderRadius: 'var(--radius)', background: 'var(--bg)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Mail size={18} style={{ color: gmailInfo?.connected ? 'var(--lime)' : 'var(--text-muted)' }} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500, fontSize: '0.875rem' }}>Gmail</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
                  {gmailInfo?.connected
                    ? (gmailInfo.email ? `Connected as ${gmailInfo.email}` : 'Connected')
                    : 'Send approved messages directly via your Gmail account'}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem' }}>
                  {gmailInfo?.connected
                    ? <><CheckCircle size={13} style={{ color: 'var(--lime)' }} /> <span style={{ color: 'var(--lime)' }}>Connected</span></>
                    : <><XCircle size={13} style={{ color: 'var(--text-muted)' }} /> <span style={{ color: 'var(--text-muted)' }}>Not connected</span></>
                  }
                </div>
                {gmailInfo?.connected ? (
                  <button
                    className="btn btn-secondary"
                    style={{ fontSize: '0.75rem', padding: '0.35rem 0.75rem', color: 'var(--orange)', borderColor: 'var(--orange)' }}
                    onClick={handleDisconnectGmail}
                    disabled={gmailDisconnecting}
                  >
                    {gmailDisconnecting ? 'Disconnecting…' : 'Disconnect'}
                  </button>
                ) : (
                  <button className="btn btn-secondary" style={{ fontSize: '0.75rem', padding: '0.35rem 0.75rem' }} onClick={handleConnectGmail}>
                    Connect
                  </button>
                )}
              </div>
            </div>

            {/* AgentMail */}
            <div style={{ padding: '0.875rem 0', borderBottom: '1px solid var(--border)' }}>
              {/* Status row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <div style={{ width: 36, height: 36, borderRadius: 'var(--radius)', background: 'var(--bg)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Send size={18} style={{ color: agentmailInfo?.connected ? 'var(--lime)' : 'var(--text-muted)' }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, fontSize: '0.875rem' }}>AgentMail</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
                    {agentmailInfo?.connected
                      ? (agentmailInfo.email ? `Sales Beaver sends from ${agentmailInfo.email}` : 'Inbox ready')
                      : <>Add <code style={{ background: 'var(--bg)', padding: '0.1rem 0.3rem', borderRadius: 3, fontSize: '0.7rem' }}>AGENTMAIL_API_KEY</code> to server/.env to enable</>}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem' }}>
                  {agentmailInfo?.connected
                    ? <><CheckCircle size={13} style={{ color: 'var(--lime)' }} /> <span style={{ color: 'var(--lime)' }}>Connected</span></>
                    : <><XCircle size={13} style={{ color: 'var(--text-muted)' }} /> <span style={{ color: 'var(--text-muted)' }}>Not connected</span></>
                  }
                </div>
              </div>

              {/* Webhook registration — only shown when connected */}
              {agentmailInfo?.connected && (
                <div style={{ paddingLeft: 52, marginTop: '0.875rem' }}>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.4rem', fontWeight: 600 }}>
                    Reply Detection — Register ngrok webhook
                    <span style={{ fontWeight: 400, marginLeft: '0.4rem' }}>
                      (run <code style={{ background: 'var(--bg)', padding: '0.1rem 0.3rem', borderRadius: 3 }}>ngrok http 3001</code> then paste the HTTPS URL)
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <input
                      className="form-input"
                      placeholder="https://abc123.ngrok.io/api/webhooks/agentmail"
                      value={webhookUrl}
                      onChange={e => setWebhookUrl(e.target.value)}
                      style={{ fontSize: '0.8rem', flex: 1 }}
                    />
                    <button
                      className="btn btn-secondary"
                      style={{ fontSize: '0.75rem', padding: '0.45rem 0.875rem', whiteSpace: 'nowrap' }}
                      onClick={handleRegisterWebhook}
                      disabled={webhookRegistering || !webhookUrl.trim()}
                    >
                      {webhookRegistering ? 'Registering…' : webhookRegistered ? '✓ Registered' : 'Register'}
                    </button>
                  </div>
                  {webhookError && <div style={{ fontSize: '0.75rem', color: 'var(--orange)', marginTop: '0.35rem' }}>{webhookError}</div>}
                </div>
              )}
            </div>

            {/* Apollo.io */}
            <div style={{ padding: '0.875rem 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: apolloInfo?.connected ? '0' : '0.875rem' }}>
                <div style={{ width: 36, height: 36, borderRadius: 'var(--radius)', background: 'var(--bg)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Search size={18} style={{ color: apolloInfo?.connected ? 'var(--lime)' : 'var(--text-muted)' }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, fontSize: '0.875rem' }}>Apollo.io</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>Enrich leads with contact data and verified emails</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem' }}>
                    {apolloInfo?.connected
                      ? <><CheckCircle size={13} style={{ color: 'var(--lime)' }} /> <span style={{ color: 'var(--lime)' }}>Connected</span></>
                      : <><XCircle size={13} style={{ color: apolloInfo?.label?.includes('error') ? 'var(--orange)' : 'var(--text-muted)' }} /> <span style={{ color: apolloInfo?.label?.includes('error') ? 'var(--orange)' : 'var(--text-muted)' }}>{apolloInfo?.label || 'Not configured'}</span></>
                    }
                  </div>
                  {apolloInfo?.connected && (
                    <button
                      className="btn btn-secondary"
                      style={{ fontSize: '0.75rem', padding: '0.35rem 0.75rem', color: 'var(--orange)', borderColor: 'var(--orange)' }}
                      onClick={handleDisconnectApollo}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>

              {!apolloInfo?.connected && (
                <div style={{ paddingLeft: 52 }}>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <div style={{ position: 'relative', flex: 1 }}>
                      <input
                        className="form-input"
                        type={apolloKeyVisible ? 'text' : 'password'}
                        placeholder="Paste Apollo API key…"
                        value={apolloKey}
                        onChange={e => setApolloKey(e.target.value)}
                        style={{ paddingRight: '2.5rem', fontSize: '0.875rem' }}
                      />
                      <button
                        type="button"
                        onClick={() => setApolloKeyVisible(v => !v)}
                        style={{ position: 'absolute', right: '0.6rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, display: 'flex', alignItems: 'center' }}
                      >
                        {apolloKeyVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                    <button
                      className="btn btn-primary"
                      style={{ fontSize: '0.75rem', padding: '0.45rem 0.875rem', whiteSpace: 'nowrap' }}
                      onClick={handleSaveApolloKey}
                      disabled={apolloSaving || !apolloKey.trim()}
                    >
                      {apolloSaving ? 'Saving…' : apolloSaved ? '✓ Saved' : 'Save Key'}
                    </button>
                  </div>
                  {apolloError && <div style={{ fontSize: '0.75rem', color: 'var(--orange)', marginTop: '0.375rem' }}>{apolloError}</div>}
                </div>
              )}
            </div>

            {/* Hunter.io */}
            <div style={{ padding: '0.875rem 0', borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: hunterInfo?.connected ? '0' : '0.875rem' }}>
                <div style={{ width: 36, height: 36, borderRadius: 'var(--radius)', background: 'var(--bg)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <AtSign size={18} style={{ color: hunterInfo?.connected ? 'var(--lime)' : 'var(--text-muted)' }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, fontSize: '0.875rem' }}>
                    Hunter.io
                    <a
                      href="https://hunter.io/api-documentation/v2"
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: '0.7rem', color: 'var(--blue)', marginLeft: '0.5rem', textDecoration: 'none' }}
                    >
                      Get free API key →
                    </a>
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>Find verified email addresses for Research Beaver contacts</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem' }}>
                    {hunterInfo?.connected
                      ? <><CheckCircle size={13} style={{ color: 'var(--lime)' }} /> <span style={{ color: 'var(--lime)' }}>Connected</span></>
                      : <><XCircle size={13} style={{ color: hunterInfo?.label?.includes('error') ? 'var(--orange)' : 'var(--text-muted)' }} /> <span style={{ color: hunterInfo?.label?.includes('error') ? 'var(--orange)' : 'var(--text-muted)' }}>{hunterInfo?.label || 'Not configured'}</span></>
                    }
                  </div>
                  {hunterInfo?.connected && (
                    <button
                      className="btn btn-secondary"
                      style={{ fontSize: '0.75rem', padding: '0.35rem 0.75rem', color: 'var(--orange)', borderColor: 'var(--orange)' }}
                      onClick={handleDisconnectHunter}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>

              {!hunterInfo?.connected && (
                <div style={{ paddingLeft: 52 }}>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <div style={{ position: 'relative', flex: 1 }}>
                      <input
                        className="form-input"
                        type={hunterKeyVisible ? 'text' : 'password'}
                        placeholder="Paste Hunter.io API key…"
                        value={hunterKey}
                        onChange={e => setHunterKey(e.target.value)}
                        style={{ paddingRight: '2.5rem', fontSize: '0.875rem' }}
                      />
                      <button
                        type="button"
                        onClick={() => setHunterKeyVisible(v => !v)}
                        style={{ position: 'absolute', right: '0.6rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, display: 'flex', alignItems: 'center' }}
                      >
                        {hunterKeyVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                    <button
                      className="btn btn-primary"
                      style={{ fontSize: '0.75rem', padding: '0.45rem 0.875rem', whiteSpace: 'nowrap' }}
                      onClick={handleSaveHunterKey}
                      disabled={hunterSaving || !hunterKey.trim()}
                    >
                      {hunterSaving ? 'Saving…' : hunterSaved ? '✓ Saved' : 'Save Key'}
                    </button>
                  </div>
                  {hunterError && <div style={{ fontSize: '0.75rem', color: 'var(--orange)', marginTop: '0.375rem' }}>{hunterError}</div>}
                </div>
              )}
            </div>

            {/* Brave Search */}
            <div style={{ padding: '0.875rem 0', borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: braveInfo?.connected ? '0' : '0.875rem' }}>
                <div style={{ width: 36, height: 36, borderRadius: 'var(--radius)', background: 'var(--bg)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Search size={18} style={{ color: braveInfo?.connected ? 'var(--lime)' : 'var(--text-muted)' }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, fontSize: '0.875rem' }}>
                    Brave Search
                    <a
                      href="https://api-dashboard.search.brave.com/"
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: '0.7rem', color: 'var(--blue)', marginLeft: '0.5rem', textDecoration: 'none' }}
                    >
                      Get API key →
                    </a>
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
                    Web search for profile discovery and buying-signal research
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem' }}>
                    {braveInfo?.connected
                      ? <><CheckCircle size={13} style={{ color: 'var(--lime)' }} /> <span style={{ color: 'var(--lime)' }}>{braveInfo.label || 'Connected'}</span></>
                      : <><XCircle size={13} style={{ color: 'var(--orange)' }} /> <span style={{ color: 'var(--orange)' }}>{braveInfo?.label || 'Not configured'}</span></>
                    }
                  </div>
                  {braveInfo?.connected && braveInfo?.tenant_key && (
                    <button
                      className="btn btn-secondary"
                      style={{ fontSize: '0.75rem', padding: '0.35rem 0.75rem', color: 'var(--orange)', borderColor: 'var(--orange)' }}
                      onClick={handleDisconnectBrave}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>

              {!braveInfo?.connected && (
                <div style={{ paddingLeft: 52 }}>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <div style={{ position: 'relative', flex: 1 }}>
                      <input
                        className="form-input"
                        type={braveKeyVisible ? 'text' : 'password'}
                        placeholder="Paste Brave Search API key…"
                        value={braveKey}
                        onChange={e => setBraveKey(e.target.value)}
                        style={{ paddingRight: '2.5rem', fontSize: '0.875rem' }}
                      />
                      <button
                        type="button"
                        onClick={() => setBraveKeyVisible(v => !v)}
                        style={{ position: 'absolute', right: '0.6rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, display: 'flex', alignItems: 'center' }}
                      >
                        {braveKeyVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                    <button
                      className="btn btn-primary"
                      style={{ fontSize: '0.75rem', padding: '0.45rem 0.875rem', whiteSpace: 'nowrap' }}
                      onClick={handleSaveBraveKey}
                      disabled={braveSaving || !braveKey.trim()}
                    >
                      {braveSaving ? 'Saving…' : braveSaved ? '✓ Saved' : 'Save Key'}
                    </button>
                  </div>
                  {braveError && <div style={{ fontSize: '0.75rem', color: 'var(--orange)', marginTop: '0.375rem' }}>{braveError}</div>}
                </div>
              )}
            </div>

            {/* Google Calendar */}
            <div style={{ padding: '0.875rem 0', borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <div style={{ width: 36, height: 36, borderRadius: 'var(--radius)', background: 'var(--bg)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Calendar size={18} style={{ color: calendarInfo?.connected ? 'var(--lime)' : 'var(--text-muted)' }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, fontSize: '0.875rem' }}>
                    Google Calendar
                    <span style={{ marginLeft: '0.5rem', fontSize: '0.65rem', background: 'rgba(200,255,0,0.12)', color: 'var(--lime)', borderRadius: 4, padding: '0.1rem 0.4rem', fontWeight: 700 }}>REQUIRED</span>
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
                    {calendarInfo?.connected
                      ? `Connected as ${calendarInfo.email || 'Google account'} — agents check availability and detect booked meetings`
                      : 'Required to run campaigns — agents check your calendar for meeting slots and auto-detect booked meetings'}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem' }}>
                    {calendarInfo?.connected
                      ? <><CheckCircle size={13} style={{ color: 'var(--lime)' }} /> <span style={{ color: 'var(--lime)' }}>Connected</span></>
                      : <><XCircle size={13} style={{ color: 'var(--orange)' }} /> <span style={{ color: 'var(--orange)' }}>Not connected</span></>
                    }
                  </div>
                  {calendarInfo?.connected ? (
                    <button
                      className="btn btn-secondary"
                      style={{ fontSize: '0.75rem', padding: '0.35rem 0.75rem', color: 'var(--orange)', borderColor: 'var(--orange)' }}
                      onClick={handleDisconnectCalendar}
                      disabled={calendarDisconnecting}
                    >
                      {calendarDisconnecting ? 'Disconnecting…' : 'Disconnect'}
                    </button>
                  ) : (
                    <button
                      className="btn btn-secondary"
                      style={{ fontSize: '0.75rem', padding: '0.35rem 0.75rem' }}
                      onClick={handleConnectCalendar}
                      disabled={calendarConnecting}
                    >
                      {calendarConnecting ? 'Connecting…' : 'Connect'}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Calendly */}
            <div style={{ padding: '0.875rem 0', borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: calendlyInfo?.connected ? 0 : '0.875rem' }}>
                <div style={{ width: 36, height: 36, borderRadius: 'var(--radius)', background: 'var(--bg)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Calendar size={18} style={{ color: calendlyInfo?.connected ? 'var(--lime)' : 'var(--text-muted)' }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, fontSize: '0.875rem' }}>
                    Calendly
                    <span style={{ marginLeft: '0.5rem', fontSize: '0.65rem', background: 'rgba(148,163,184,0.12)', color: 'var(--text-muted)', borderRadius: 4, padding: '0.1rem 0.4rem', fontWeight: 700 }}>OPTIONAL ALTERNATIVE</span>
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
                    {calendlyInfo?.connected
                      ? `Agents include your Calendly link when suggesting meeting times`
                      : 'Use instead of Google Calendar — paste your Calendly link, agents include it in replies'}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem' }}>
                    {calendlyInfo?.connected
                      ? <><CheckCircle size={13} style={{ color: 'var(--lime)' }} /> <span style={{ color: 'var(--lime)' }}>Connected</span></>
                      : <><XCircle size={13} style={{ color: 'var(--text-muted)' }} /> <span style={{ color: 'var(--text-muted)' }}>Not connected</span></>
                    }
                  </div>
                  {calendlyInfo?.connected && (
                    <button
                      className="btn btn-secondary"
                      style={{ fontSize: '0.75rem', padding: '0.35rem 0.75rem', color: 'var(--orange)', borderColor: 'var(--orange)' }}
                      onClick={handleDisconnectCalendly}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>

              {!calendlyInfo?.connected && (
                <div style={{ paddingLeft: 52 }}>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <input
                      className="form-input"
                      placeholder="https://calendly.com/your-name or your-name"
                      value={calendlyUrl}
                      onChange={e => setCalendlyUrl(e.target.value)}
                      style={{ fontSize: '0.875rem', flex: 1 }}
                    />
                    <button
                      className="btn btn-primary"
                      style={{ fontSize: '0.75rem', padding: '0.45rem 0.875rem', whiteSpace: 'nowrap' }}
                      onClick={handleSaveCalendly}
                      disabled={calendlySaving || !calendlyUrl.trim()}
                    >
                      {calendlySaving ? 'Saving…' : calendlySaved ? '✓ Saved' : 'Connect'}
                    </button>
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.3rem' }}>
                    Paste your full Calendly URL or just your username. Agents will use this to suggest booking times.
                  </div>
                </div>
              )}
            </div>

            {/* WhatsApp */}
            <div style={{ padding: '0.875rem 0', borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: whatsappInfo?.connected ? 0 : '0.875rem' }}>
                <div style={{ width: 36, height: 36, borderRadius: 'var(--radius)', background: 'var(--bg)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <MessageSquare size={18} style={{ color: whatsappInfo?.connected ? 'var(--lime)' : 'var(--text-muted)' }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, fontSize: '0.875rem' }}>WhatsApp</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
                    {whatsappInfo?.connected
                      ? `Positive replies include wa.me/${(whatsappInfo.number || '').replace(/^\+/, '')} for easy handoff`
                      : 'Add your WhatsApp number — Sales Beaver includes a wa.me link in positive reply responses'}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem' }}>
                    {whatsappInfo?.connected
                      ? <><CheckCircle size={13} style={{ color: 'var(--lime)' }} /> <span style={{ color: 'var(--lime)' }}>Connected</span></>
                      : <><XCircle size={13} style={{ color: 'var(--text-muted)' }} /> <span style={{ color: 'var(--text-muted)' }}>Not connected</span></>
                    }
                  </div>
                  {whatsappInfo?.connected && (
                    <button
                      className="btn btn-secondary"
                      style={{ fontSize: '0.75rem', padding: '0.35rem 0.75rem', color: 'var(--orange)', borderColor: 'var(--orange)' }}
                      onClick={handleDisconnectWhatsapp}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>

              {!whatsappInfo?.connected && (
                <div style={{ paddingLeft: 52 }}>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <input
                      className="form-input"
                      placeholder="+601115081530"
                      value={whatsappNumber}
                      onChange={e => setWhatsappNumber(e.target.value)}
                      style={{ fontSize: '0.875rem', flex: 1 }}
                    />
                    <button
                      className="btn btn-primary"
                      style={{ fontSize: '0.75rem', padding: '0.45rem 0.875rem', whiteSpace: 'nowrap' }}
                      onClick={handleSaveWhatsapp}
                      disabled={whatsappSaving || !whatsappNumber.trim()}
                    >
                      {whatsappSaving ? 'Saving…' : whatsappSaved ? '✓ Saved' : 'Connect'}
                    </button>
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.3rem' }}>
                    Include country code (e.g. +601115081530). Sales Beaver adds a wa.me link when prospects reply positively.
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </Section>

      {/* ICP */}
      <Section title="Ideal Customer Profile">
        {icpLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {[1, 2, 3, 4].map(i => <div key={i} className="skeleton" style={{ height: 44 }} />)}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div className="form-group">
              <label className="form-label">Target Industries</label>
              <input
                className="form-input"
                placeholder="e.g. SaaS, FinTech, Healthcare"
                value={icp.industries}
                onChange={e => setIcp(p => ({ ...p, industries: e.target.value }))}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Company Size</label>
              <input
                className="form-input"
                placeholder="e.g. 50–500 employees, Series A–C"
                value={icp.company_size}
                onChange={e => setIcp(p => ({ ...p, company_size: e.target.value }))}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Geographies</label>
              <input
                className="form-input"
                placeholder="e.g. UK, US, Southeast Asia"
                value={icp.geographies}
                onChange={e => setIcp(p => ({ ...p, geographies: e.target.value }))}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Job Titles to Target</label>
              <input
                className="form-input"
                placeholder="e.g. VP of Sales, Head of Marketing, CTO"
                value={icp.job_titles}
                onChange={e => setIcp(p => ({ ...p, job_titles: e.target.value }))}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '0.25rem' }}>
              <button className="btn btn-primary" onClick={handleSaveICP} disabled={icpSaving}>
                <Save size={14} /> {icpSaving ? 'Saving…' : 'Save ICP'}
              </button>
              {icpSaved && <span style={{ fontSize: '0.8rem', color: 'var(--lime)' }}>✓ Saved!</span>}
            </div>
          </div>
        )}
      </Section>

      {/* Client Persona */}
      <Section title="Agent Config — Client Persona">
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '1.25rem', marginTop: '-0.5rem' }}>
          Sales Beaver writes outreach in this company's voice. Fill this in for every client — this is what makes messages sound human, not generic.
        </p>
        {personaLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {[1, 2, 3, 4].map(i => <div key={i} className="skeleton" style={{ height: 44 }} />)}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div className="form-group">
                <label className="form-label">Company Name</label>
                <input
                  className="form-input"
                  placeholder="e.g. TRL, Beaver Solutions"
                  value={persona.company_name}
                  onChange={e => setPersona(p => ({ ...p, company_name: e.target.value }))}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Tone</label>
                <input
                  className="form-input"
                  placeholder="e.g. Professional but warm, Malaysian English, Expert peer"
                  value={persona.tone}
                  onChange={e => setPersona(p => ({ ...p, tone: e.target.value }))}
                />
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div className="form-group">
                <label className="form-label">Sender Name <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(appears in email sign-off)</span></label>
                <input
                  className="form-input"
                  placeholder="e.g. MJ, Adrian, Matthew"
                  value={persona.sender_name || ''}
                  onChange={e => setPersona(p => ({ ...p, sender_name: e.target.value }))}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Sender Title <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
                <input
                  className="form-input"
                  placeholder="e.g. Founder, Head of Growth"
                  value={persona.sender_title || ''}
                  onChange={e => setPersona(p => ({ ...p, sender_title: e.target.value }))}
                />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Company Description <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(2 sentences max)</span></label>
              <textarea
                className="form-input"
                rows={2}
                placeholder="e.g. A B2B SaaS platform for retail analytics in Malaysia."
                value={persona.company_description}
                onChange={e => setPersona(p => ({ ...p, company_description: e.target.value }))}
                style={{ resize: 'vertical' }}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Value Proposition <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(outcome-focused, not feature-focused)</span></label>
              <textarea
                className="form-input"
                rows={2}
                placeholder="e.g. We help retail brands see exactly where they're losing revenue."
                value={persona.value_proposition}
                onChange={e => setPersona(p => ({ ...p, value_proposition: e.target.value }))}
                style={{ resize: 'vertical' }}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Key Differentiator</label>
              <input
                className="form-input"
                placeholder="e.g. Only platform built specifically for Malaysian retail data"
                value={persona.differentiator}
                onChange={e => setPersona(p => ({ ...p, differentiator: e.target.value }))}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Social Proof <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(clients, numbers, results)</span></label>
              <input
                className="form-input"
                placeholder="e.g. Used by 40+ brands including Aeon, Parkson, and Mr DIY"
                value={persona.social_proof}
                onChange={e => setPersona(p => ({ ...p, social_proof: e.target.value }))}
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div className="form-group">
                <label className="form-label">Banned Phrases <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(comma-separated)</span></label>
                <input
                  className="form-input"
                  placeholder="e.g. cutting-edge, paradigm shift, seamless"
                  value={persona.banned_phrases}
                  onChange={e => setPersona(p => ({ ...p, banned_phrases: e.target.value }))}
                />
              </div>
              <div className="form-group">
                <label className="form-label">CTA Preference</label>
                <input
                  className="form-input"
                  placeholder="e.g. Ask for a 20-min call, not a demo"
                  value={persona.cta_preference}
                  onChange={e => setPersona(p => ({ ...p, cta_preference: e.target.value }))}
                />
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '0.25rem' }}>
              <button className="btn btn-primary" onClick={handleSavePersona} disabled={personaSaving}>
                <Save size={14} /> {personaSaving ? 'Saving…' : 'Save Persona'}
              </button>
              {personaSaved && <span style={{ fontSize: '0.8rem', color: 'var(--lime)' }}>✓ Saved — agents will use this voice from now on</span>}
            </div>
          </div>
        )}
      </Section>

      {/* Account */}
      <Section title="Account">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0', borderBottom: '1px solid var(--border)', fontSize: '0.875rem' }}>
            <span style={{ color: 'var(--text-muted)' }}>Email</span>
            <span>{user?.email || '—'}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0', borderBottom: '1px solid var(--border)', fontSize: '0.875rem' }}>
            <span style={{ color: 'var(--text-muted)' }}>Role</span>
            <span style={{ textTransform: 'capitalize' }}>{user?.role || 'admin'}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0', fontSize: '0.875rem' }}>
            <span style={{ color: 'var(--text-muted)' }}>Organisation</span>
            <span>{user?.client?.name || '—'}</span>
          </div>
        </div>
      </Section>
    </div>
  );
}
