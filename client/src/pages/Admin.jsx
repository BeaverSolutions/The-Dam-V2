import React, { useState, useEffect, useCallback } from 'react';
import {
  Users, Building2, Activity, Key, Plus, RefreshCw,
  ChevronRight, ChevronLeft, Eye, EyeOff, Copy, Check,
  ShieldCheck, AlertTriangle, MoreVertical, Loader, Link,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';

// ─── helpers ──────────────────────────────────────────────────
const fmt = (n) => (n ?? 0).toLocaleString();
const ago = (ts) => {
  if (!ts) return 'Never';
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / 1440)}d ago`;
};

const PLAN_COLORS = {
  starter: 'var(--text-muted)',
  growth: 'var(--blue)',
  enterprise: 'var(--purple)',
};

// ─── Copy-to-clipboard button ─────────────────────────────────
function CopyBtn({ value }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button onClick={copy} style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied ? 'var(--lime)' : 'var(--text-muted)', padding: '0 4px' }}>
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

// ─── Credential row ───────────────────────────────────────────
function CredRow({ label, data }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{label}</span>
      <span style={{
        fontSize: '0.75rem',
        padding: '2px 8px',
        borderRadius: 4,
        background: data?.configured ? 'rgba(200,255,0,0.1)' : 'rgba(255,140,0,0.1)',
        color: data?.configured ? 'var(--lime)' : 'var(--orange)',
      }}>
        {data?.configured ? `✓ Set ${ago(data.updated_at)}` : '✗ Not configured'}
      </span>
    </div>
  );
}

// ─── Create Client Modal ──────────────────────────────────────
function CreateClientModal({ onClose, onCreated }) {
  const { request } = useApi();
  const [form, setForm] = useState({ name: '', email: '', plan: 'starter' });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await request('/admin/clients', { method: 'POST', body: JSON.stringify(form) });
      setResult(res.data);
      onCreated();
    } catch (err) {
      setError(err.message || 'Failed to create client');
    } finally {
      setLoading(false);
    }
  };

  if (result) {
    const { client, credentials } = result;
    return (
      <div style={modalOverlay}>
        <div style={modalBox}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.25rem' }}>
            <ShieldCheck size={18} color="var(--lime)" />
            <h3 style={{ margin: 0, color: 'var(--lime)' }}>Client Created!</h3>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1rem' }}>
            Share these credentials with <strong style={{ color: 'var(--text)' }}>{client.name}</strong>. The temp password works once — they should change it after first login.
          </p>
          <div style={credBox}>
            <CredLine label="Email" value={credentials.email} />
            <CredLine label="Temp Password" value={credentials.temp_password} secret />
            <CredLine label="Access Code" value={credentials.access_code} />
          </div>
          <button className="btn btn-primary" style={{ width: '100%', marginTop: '1.25rem' }} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={modalOverlay}>
      <div style={modalBox}>
        <h3 style={{ margin: '0 0 1.25rem', color: 'var(--text)' }}>New Client</h3>
        {error && <div style={errorBanner}>{error}</div>}
        <form onSubmit={submit}>
          <label style={labelStyle}>Company Name</label>
          <input className="input" style={inputStyle} placeholder="e.g. Mastercard" value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />

          <label style={labelStyle}>Admin Email</label>
          <input className="input" style={inputStyle} type="email" placeholder="admin@company.com" value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required />

          <label style={labelStyle}>Plan</label>
          <select className="input" style={inputStyle} value={form.plan} onChange={e => setForm(f => ({ ...f, plan: e.target.value }))}>
            <option value="starter">Starter</option>
            <option value="growth">Growth</option>
            <option value="enterprise">Enterprise</option>
          </select>

          <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.25rem' }}>
            <button type="button" className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" style={{ flex: 2 }} disabled={loading}>
              {loading ? <Loader size={14} className="spin" /> : 'Create Client'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CredLine({ label, value, secret }) {
  const [show, setShow] = useState(!secret);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', width: 110, flexShrink: 0 }}>{label}</span>
      <code style={{ flex: 1, fontSize: '0.8rem', color: 'var(--lime)', fontFamily: 'monospace', letterSpacing: secret && !show ? 2 : 0 }}>
        {secret && !show ? '••••••••••' : value}
      </code>
      {secret && (
        <button onClick={() => setShow(s => !s)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '0 2px' }}>
          {show ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
      )}
      <CopyBtn value={value} />
    </div>
  );
}

// ─── Add User Modal ───────────────────────────────────────────
function AddUserModal({ clientId, clientName, onClose, onCreated }) {
  const { request } = useApi();
  const [form, setForm] = useState({ email: '', role: 'user' });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await request(`/admin/clients/${clientId}/users`, { method: 'POST', body: JSON.stringify(form) });
      setResult(res.data);
      onCreated();
    } catch (err) {
      setError(err.message || 'Failed to create user');
    } finally {
      setLoading(false);
    }
  };

  if (result) {
    return (
      <div style={modalOverlay}>
        <div style={modalBox}>
          <h3 style={{ margin: '0 0 1rem', color: 'var(--lime)' }}>User Created</h3>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>Share these with the new team member for <strong style={{ color: 'var(--text)' }}>{clientName}</strong>:</p>
          <div style={credBox}>
            <CredLine label="Email" value={result.credentials.email} />
            <CredLine label="Temp Password" value={result.credentials.temp_password} secret />
            <CredLine label="Access Code" value={result.credentials.access_code} />
          </div>
          <button className="btn btn-primary" style={{ width: '100%', marginTop: '1.25rem' }} onClick={onClose}>Done</button>
        </div>
      </div>
    );
  }

  return (
    <div style={modalOverlay}>
      <div style={modalBox}>
        <h3 style={{ margin: '0 0 1.25rem' }}>Add User — {clientName}</h3>
        {error && <div style={errorBanner}>{error}</div>}
        <form onSubmit={submit}>
          <label style={labelStyle}>Email</label>
          <input className="input" style={inputStyle} type="email" placeholder="user@company.com" value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required />
          <label style={labelStyle}>Role</label>
          <select className="input" style={inputStyle} value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
          <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.25rem' }}>
            <button type="button" className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" style={{ flex: 2 }} disabled={loading}>
              {loading ? <Loader size={14} /> : 'Create User'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Client Detail Panel ──────────────────────────────────────
function ClientDetail({ clientId, onBack }) {
  const { request } = useApi();
  const [client, setClient] = useState(null);
  const [users, setUsers] = useState([]);
  const [logs, setLogs] = useState([]);
  const [creds, setCreds] = useState(null);
  const [tab, setTab] = useState('users');
  const [loading, setLoading] = useState(true);
  const [resettingId, setResettingId] = useState(null);
  const [resetResult, setResetResult] = useState(null);
  const [showAddUser, setShowAddUser] = useState(false);
  const [signupLink, setSignupLink] = useState(null);
  const [generatingLink, setGeneratingLink] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [clientRes, usersRes, logsRes, credsRes] = await Promise.allSettled([
        request(`/admin/clients/${clientId}`),
        request(`/admin/clients/${clientId}/users`),
        request(`/admin/clients/${clientId}/logs?limit=30`),
        request(`/admin/clients/${clientId}/credentials`),
      ]);
      if (clientRes.status === 'fulfilled') setClient(clientRes.value.data);
      if (usersRes.status === 'fulfilled') setUsers(usersRes.value.data || []);
      if (logsRes.status === 'fulfilled') setLogs(logsRes.value.data || []);
      if (credsRes.status === 'fulfilled') setCreds(credsRes.value.data);
    } finally { setLoading(false); }
  }, [clientId]);

  useEffect(() => { load(); }, [load]);

  const resetPassword = async (userId) => {
    setResettingId(userId);
    setResetResult(null);
    try {
      const res = await request(`/admin/users/${userId}/reset-password`, { method: 'POST' });
      setResetResult(res.data);
    } catch (err) {
      alert(err.message || 'Failed to reset password');
    } finally {
      setResettingId(null);
    }
  };

  const generateSignupLink = async () => {
    setGeneratingLink(true);
    setSignupLink(null);
    try {
      const res = await request(`/admin/clients/${clientId}/signup-link`, { method: 'POST' });
      setSignupLink(res.data.url);
    } catch (err) {
      alert(err.message || 'Failed to generate link');
    } finally {
      setGeneratingLink(false);
    }
  };

  const copyLink = () => {
    if (!signupLink) return;
    navigator.clipboard.writeText(signupLink).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    });
  };

  if (loading) return <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}><Loader size={20} className="spin" /></div>;
  if (!client) return null;

  const { stats } = client;

  return (
    <div>
      {/* Back + header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem' }}>
        <button className="btn btn-ghost" style={{ padding: '0.25rem 0.5rem' }} onClick={onBack}>
          <ChevronLeft size={16} />
        </button>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.1rem' }}>{client.name}</h2>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{client.email} · slug: {client.slug || '—'}</span>
        </div>
        <span style={{ marginLeft: 'auto', fontSize: '0.75rem', padding: '3px 10px', borderRadius: 100, background: 'rgba(255,255,255,0.05)', color: PLAN_COLORS[client.plan] || 'var(--text-muted)', border: `1px solid ${PLAN_COLORS[client.plan] || 'var(--border)'}` }}>
          {client.plan}
        </span>
      </div>

      {/* Stats bar */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' }}>
        {[
          { label: 'Total Leads', value: fmt(stats?.total_leads) },
          { label: 'Contacted', value: fmt(stats?.contacted) },
          { label: 'Replied', value: fmt(stats?.replied) },
          { label: 'Meetings', value: fmt(stats?.meetings), color: 'var(--lime)' },
          { label: 'Msgs Sent', value: fmt(stats?.sent_messages) },
          { label: 'Rejected', value: fmt(stats?.rejected_messages), color: stats?.rejected_messages > 0 ? 'var(--orange)' : undefined },
          { label: 'Pending ✓', value: fmt(stats?.pending_approvals), color: stats?.pending_approvals > 0 ? 'var(--blue)' : undefined },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.75rem', textAlign: 'center' }}>
            <div style={{ fontSize: '1.3rem', fontWeight: 700, color: color || 'var(--text)' }}>{value}</div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem' }}>
        {['users', 'activity', 'credentials'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            background: tab === t ? 'rgba(200,255,0,0.08)' : 'none',
            border: 'none',
            borderBottom: tab === t ? '2px solid var(--lime)' : '2px solid transparent',
            color: tab === t ? 'var(--lime)' : 'var(--text-muted)',
            padding: '0.4rem 0.75rem',
            cursor: 'pointer',
            fontSize: '0.85rem',
            fontWeight: tab === t ? 600 : 400,
            textTransform: 'capitalize',
            borderRadius: '4px 4px 0 0',
          }}>{t}</button>
        ))}
      </div>

      {/* Users tab */}
      {tab === 'users' && (
        <div>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginBottom: '0.75rem' }}>
            <button className="btn btn-ghost" style={{ fontSize: '0.8rem', padding: '0.4rem 0.9rem', border: '1px solid var(--border)' }}
              onClick={generateSignupLink} disabled={generatingLink}>
              {generatingLink ? <Loader size={14} className="spin" /> : <Link size={14} />}
              Invite Link
            </button>
            <button className="btn btn-primary" style={{ fontSize: '0.8rem', padding: '0.4rem 0.9rem' }}
              onClick={() => setShowAddUser(true)}>
              <Plus size={14} /> Add User
            </button>
          </div>
          {signupLink && (
            <div style={{ background: 'rgba(255,106,0,0.06)', border: '1px solid rgba(255,106,0,0.2)', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '0.75rem' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>One-time invite link (expires in 7 days)</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <code style={{ flex: 1, fontSize: '0.72rem', color: 'var(--brand)', background: 'rgba(0,0,0,0.3)', padding: '0.35rem 0.6rem', borderRadius: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                  {signupLink}
                </code>
                <button className="btn btn-ghost" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', flexShrink: 0 }} onClick={copyLink}>
                  {linkCopied ? <Check size={14} /> : <Copy size={14} />}
                  {linkCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <button onClick={() => setSignupLink(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.7rem', marginTop: '0.4rem', padding: 0 }}>Dismiss</button>
            </div>
          )}
          {resetResult && (
            <div style={{ background: 'rgba(200,255,0,0.08)', border: '1px solid rgba(200,255,0,0.2)', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '0.75rem' }}>
              <div style={{ fontSize: '0.8rem', color: 'var(--lime)', marginBottom: '0.5rem' }}>Password reset for {resetResult.user?.email}</div>
              <div style={credBox}><CredLine label="New Password" value={resetResult.new_password} secret /></div>
              <button onClick={() => setResetResult(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.75rem', marginTop: '0.5rem' }}>Dismiss</button>
            </div>
          )}
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            {users.length === 0 && <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>No users yet</div>}
            {users.map(u => (
              <div key={u.id} style={{ display: 'flex', alignItems: 'center', padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)', gap: '0.75rem' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '0.85rem', fontWeight: 500 }}>{u.email}</div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                    {u.role} · joined {ago(u.created_at)}
                  </div>
                </div>
                <span style={{ fontSize: '0.7rem', padding: '2px 8px', borderRadius: 100, background: u.role === 'admin' ? 'rgba(168,85,247,0.1)' : 'rgba(255,255,255,0.05)', color: u.role === 'admin' ? 'var(--purple)' : 'var(--text-muted)' }}>
                  {u.role}
                </span>
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem' }}
                  onClick={() => resetPassword(u.id)}
                  disabled={resettingId === u.id}
                >
                  {resettingId === u.id ? <Loader size={12} className="spin" /> : <RefreshCw size={12} />}
                  Reset PW
                </button>
              </div>
            ))}
          </div>
          {showAddUser && (
            <AddUserModal clientId={clientId} clientName={client.name}
              onClose={() => setShowAddUser(false)}
              onCreated={() => { load(); }} />
          )}
        </div>
      )}

      {/* Activity tab */}
      {tab === 'activity' && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          {logs.length === 0 && <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>No activity yet</div>}
          {logs.map(log => (
            <div key={log.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.6rem 1rem', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: '0.7rem', padding: '2px 7px', borderRadius: 4, background: 'rgba(255,255,255,0.04)', color: agentColor(log.agent), minWidth: 110, textAlign: 'center' }}>
                {log.agent}
              </span>
              <span style={{ flex: 1, fontSize: '0.8rem', color: 'var(--text)' }}>{log.action.replace(/_/g, ' ')}</span>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{ago(log.created_at)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Credentials tab */}
      {tab === 'credentials' && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '1rem' }}>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '0 0 1rem' }}>API integrations configured by the client via Settings. Values are encrypted — only status is shown here.</p>
          {creds && (
            <>
              <CredRow label="Apollo API Key" data={creds.apollo_api_key} />
              <CredRow label="Hunter API Key" data={creds.hunter_api_key} />
              <CredRow label="Gmail OAuth" data={creds.gmail_refresh_token} />
            </>
          )}
          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '1rem' }}>
            To configure keys, log in as the client and go to Settings → Integrations.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Main Admin Page ──────────────────────────────────────────
export default function Admin() {
  const { request } = useApi();
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState(null);

  const loadClients = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await request('/admin/clients');
      setClients(res.data || []);
    } catch (err) {
      setError(err.message || 'Failed to load clients');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadClients(); }, [loadClients]);

  if (selectedId) {
    return (
      <div>
        <ClientDetail clientId={selectedId} onBack={() => setSelectedId(null)} />
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <ShieldCheck size={20} color="var(--purple)" /> Super Admin
          </h1>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            Manage all clients, users, and integrations
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={14} /> New Client
        </button>
      </div>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' }}>
        {[
          { label: 'Total Clients', value: clients.length, icon: Building2, color: 'var(--blue)' },
          { label: 'Total Leads', value: fmt(clients.reduce((s, c) => s + (c.lead_count || 0), 0)), icon: Users, color: 'var(--lime)' },
          { label: 'Pending Approvals', value: fmt(clients.reduce((s, c) => s + (c.pending_approvals || 0), 0)), icon: Activity, color: 'var(--orange)' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <Icon size={16} color={color} />
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{label}</span>
            </div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Error */}
      {error && <div style={errorBanner}><AlertTriangle size={14} /> {error}</div>}

      {/* Clients table */}
      <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>All Clients</span>
          <button className="btn btn-ghost" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} onClick={loadClients}>
            <RefreshCw size={13} /> Refresh
          </button>
        </div>

        {loading && (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
            <Loader size={20} className="spin" />
          </div>
        )}

        {!loading && clients.length === 0 && (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            No clients yet. Create your first one.
          </div>
        )}

        {!loading && clients.map(client => (
          <div
            key={client.id}
            onClick={() => setSelectedId(client.id)}
            style={{ display: 'flex', alignItems: 'center', padding: '0.875rem 1rem', borderBottom: '1px solid var(--border)', cursor: 'pointer', transition: 'background 0.15s' }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            {/* Name + email */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                {client.name}
                <span style={{ fontSize: '0.7rem', color: PLAN_COLORS[client.plan] || 'var(--text-muted)', background: 'rgba(255,255,255,0.04)', padding: '1px 7px', borderRadius: 100, border: `1px solid ${PLAN_COLORS[client.plan] || 'var(--border)'}` }}>
                  {client.plan}
                </span>
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
                {client.email} · {client.user_count} user{client.user_count !== 1 ? 's' : ''}
              </div>
            </div>

            {/* Stats */}
            <div style={{ display: 'flex', gap: '1.25rem', marginRight: '1rem' }}>
              <Stat label="Leads" value={fmt(client.lead_count)} />
              <Stat label="Messages" value={fmt(client.message_count)} />
              <Stat label="Pending" value={fmt(client.pending_approvals)} color={client.pending_approvals > 0 ? 'var(--orange)' : undefined} />
              <Stat label="Last active" value={ago(client.last_activity)} />
            </div>

            <ChevronRight size={16} color="var(--text-muted)" />
          </div>
        ))}
      </div>

      {showCreate && (
        <CreateClientModal
          onClose={() => setShowCreate(false)}
          onCreated={loadClients}
        />
      )}
    </div>
  );
}

// ─── Small helpers ────────────────────────────────────────────
function Stat({ label, value, color }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: '0.875rem', fontWeight: 600, color: color || 'var(--text)' }}>{value}</div>
      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 1 }}>{label}</div>
    </div>
  );
}

function agentColor(agent) {
  const map = { research_beaver: 'var(--blue)', sales_beaver: 'var(--orange)', ranger: 'var(--police-blue)', director: 'var(--purple)' };
  return map[agent] || 'var(--text-muted)';
}

// ─── Shared styles ────────────────────────────────────────────
const modalOverlay = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
};
const modalBox = {
  background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 12,
  padding: '1.5rem', width: '100%', maxWidth: 440,
};
const credBox = {
  background: 'rgba(0,0,0,0.3)', borderRadius: 8, padding: '0.25rem 0.75rem',
  border: '1px solid var(--border)',
};
const errorBanner = {
  background: 'rgba(255,140,0,0.1)', border: '1px solid rgba(255,140,0,0.3)',
  borderRadius: 8, padding: '0.6rem 0.875rem', marginBottom: '1rem',
  color: 'var(--orange)', fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '0.5rem',
};
const labelStyle = { display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.35rem', marginTop: '0.875rem' };
const inputStyle = { width: '100%', boxSizing: 'border-box' };
