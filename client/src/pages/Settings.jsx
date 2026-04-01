import React, { useEffect, useState } from 'react';
import { Mail, CheckCircle, XCircle, Search, Save, Eye, EyeOff, Send, AtSign } from 'lucide-react';
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

export default function Settings() {
  const { request } = useApi();
  const user = getUser();

  const [integrations, setIntegrations] = useState({ gmail: { connected: false }, agentmail: { connected: false }, apollo: { connected: false }, hunter: { connected: false } });
  const [intLoading, setIntLoading] = useState(true);

  const [icp, setIcp] = useState({ industries: '', company_size: '', geographies: '', job_titles: '' });
  const [icpLoading, setIcpLoading] = useState(true);
  const [icpSaving, setIcpSaving] = useState(false);
  const [icpSaved, setIcpSaved] = useState(false);

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

  // Gmail disconnect
  const [gmailDisconnecting, setGmailDisconnecting] = useState(false);

  const loadIntegrations = () => {
    request('/integrations/status')
      .then(res => { if (res?.data) setIntegrations(res.data); })
      .catch(() => {})
      .finally(() => setIntLoading(false));
  };

  // Check for gmail=connected in URL params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('gmail') === 'connected') {
      window.history.replaceState({}, '', '/settings');
    }
  }, []);

  useEffect(() => {
    loadIntegrations();

    request('/agents/director/icp')
      .then(res => {
        if (res?.data && Object.keys(res.data).length > 0) {
          setIcp({ industries: '', company_size: '', geographies: '', job_titles: '', ...res.data });
        }
      })
      .catch(() => {})
      .finally(() => setIcpLoading(false));
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

  const handleSaveICP = async () => {
    setIcpSaving(true);
    try {
      await request('/agents/director/icp', { method: 'PUT', body: JSON.stringify(icp) });
      setIcpSaved(true);
      setTimeout(() => setIcpSaved(false), 2000);
    } catch {}
    setIcpSaving(false);
  };

  const gmailInfo = integrations.gmail;
  const agentmailInfo = integrations.agentmail;
  const apolloInfo = integrations.apollo;
  const hunterInfo = integrations.hunter;

  return (
    <div className="fade-in">
      <div className="page-header" style={{ marginBottom: '1.5rem' }}>
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Manage integrations, ideal customer profile, and account details</p>
        </div>
      </div>

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
                      : <><XCircle size={13} style={{ color: 'var(--text-muted)' }} /> <span style={{ color: 'var(--text-muted)' }}>Not configured</span></>
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
                      : <><XCircle size={13} style={{ color: 'var(--text-muted)' }} /> <span style={{ color: 'var(--text-muted)' }}>Not configured</span></>
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
