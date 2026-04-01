import React, { useEffect, useState } from 'react';
import { UserPlus, X, Check } from 'lucide-react';
import BeaverAvatar from '../components/BeaverAvatar';
import { useApi } from '../hooks/useApi';
import { getUser } from '../utils/auth';

/* ─── AI Crew ────────────────────────────────────────────── */

const CREW = [
  { key: 'research_beaver', label: 'Research Beaver', color: 'var(--blue)',   role: 'Lead sourcing, prospect intelligence, signal detection', hat: 'Hard hat' },
  { key: 'sales_beaver',    label: 'Sales Beaver',    color: 'var(--lime)',   role: 'Outreach, message generation, conversation management', hat: 'Baseball cap' },
  { key: 'ranger',          label: 'The Ranger',      color: 'var(--orange)', role: 'QA gate on all agent outputs, security, compliance',    hat: 'Ranger hat' },
  { key: 'director',        label: 'The Director',    color: 'var(--purple)', role: 'Orchestration, client comms, approval flow',            hat: 'Beret' },
];

/* ─── Avatar helpers ─────────────────────────────────────── */

const AVATAR_COLORS = ['var(--blue)', 'var(--lime)', 'var(--orange)', 'var(--purple)'];

function getInitials(email) {
  if (!email) return '?';
  const local = email.split('@')[0];
  const parts = local.split(/[._-]/).filter(Boolean);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function getAvatarColor(email) {
  if (!email) return AVATAR_COLORS[0];
  const hash = email.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function InitialsAvatar({ email, size = 36 }) {
  const color = getAvatarColor(email);
  const initials = getInitials(email);
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: `${color}25`, border: `1.5px solid ${color}60`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
    }}>
      <span style={{ fontSize: size * 0.38, fontWeight: 700, color, lineHeight: 1 }}>{initials}</span>
    </div>
  );
}

/* ─── Invite Modal ───────────────────────────────────────── */

function InviteModal({ onClose, onInvited }) {
  const { request } = useApi();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('user');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await request('/admin/invite', { method: 'POST', body: JSON.stringify({ email, role }) });
      setResult(res?.data);
      onInvited();
    } catch (err) {
      setError(err?.message || 'Failed to invite user');
    }
    setLoading(false);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
      <div className="card" style={{ width: '100%', maxWidth: 440 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
          <h3 style={{ fontWeight: 600 }}>Invite Team Member</h3>
          <button className="btn btn-ghost" style={{ padding: '0.25rem' }} onClick={onClose}><X size={18} /></button>
        </div>

        {result ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--lime)', marginBottom: '1rem', fontSize: '0.875rem', fontWeight: 600 }}>
              <Check size={16} /> Invitation created
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.25rem' }}>
              {[
                { label: 'Email',              value: result.user.email },
                { label: 'Temporary Password', value: result.temp_password },
                { label: 'Access Code',        value: result.access_code },
              ].map(({ label, value }) => (
                <div key={label} style={{ background: 'var(--bg)', borderRadius: 6, padding: '0.5rem 0.75rem' }}>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.15rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
                  <div style={{ fontSize: '0.875rem', fontFamily: 'monospace', color: 'var(--lime)' }}>{value}</div>
                </div>
              ))}
            </div>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>{result.message}</p>
            <button className="btn btn-secondary" style={{ width: '100%' }} onClick={onClose}>Done</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: '0.875rem' }}>
              <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.375rem' }}>Email address</label>
              <input
                className="form-input"
                type="email"
                placeholder="colleague@company.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />
            </div>
            <div style={{ marginBottom: '1.25rem' }}>
              <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.375rem' }}>Role</label>
              <select className="form-input" value={role} onChange={e => setRole(e.target.value)}>
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            {error && <div style={{ fontSize: '0.8rem', color: 'var(--orange)', marginBottom: '0.875rem' }}>{error}</div>}
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={loading || !email}>
                {loading ? 'Inviting…' : 'Send Invite'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/* ─── Main Page ──────────────────────────────────────────── */

export default function Team() {
  const { request } = useApi();
  const [actionCounts, setActionCounts] = useState({});
  const [members, setMembers] = useState([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const currentUser = getUser();

  useEffect(() => {
    const fetchCounts = async () => {
      const counts = {};
      for (const agent of CREW) {
        try {
          const res = await request(`/logs?agent=${agent.key}&perPage=1`);
          counts[agent.key] = res?.meta?.total || 0;
        } catch { counts[agent.key] = 0; }
      }
      setActionCounts(counts);
    };
    fetchCounts();
  }, []);

  const loadMembers = async () => {
    setMembersLoading(true);
    try {
      const res = await request('/admin/users');
      setMembers(res?.data || []);
    } catch {}
    setMembersLoading(false);
  };

  useEffect(() => { loadMembers(); }, []);

  const isAdmin = currentUser?.role === 'admin';

  return (
    <div className="fade-in">
      {/* The Beaver Crew */}
      <div className="page-header">
        <div>
          <h1 className="page-title">The Crew</h1>
          <p className="page-subtitle">Always building. Always working. The whole dam crew.</p>
        </div>
      </div>

      <div className="grid-2" style={{ marginBottom: '2.5rem' }}>
        {CREW.map(({ key, label, color, role, hat }) => (
          <div key={key} className="card" style={{ display: 'flex', gap: '1.25rem', alignItems: 'flex-start' }}>
            <div style={{ flexShrink: 0 }}>
              <BeaverAvatar agent={key} size="md" animate />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
                <h3 style={{ fontWeight: 600, color }}>{label}</h3>
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>{role}</div>
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                <div style={{ background: 'var(--bg)', borderRadius: 'var(--radius)', padding: '0.375rem 0.625rem' }}>
                  <div style={{ fontSize: '1rem', fontWeight: 700, color }}>{actionCounts[key] ?? '—'}</div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Total actions</div>
                </div>
                <div style={{ background: 'var(--bg)', borderRadius: 'var(--radius)', padding: '0.375rem 0.625rem' }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--text-muted)' }}>{hat}</div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Hat</div>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Your Team */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <div>
          <h2 style={{ fontWeight: 600, fontSize: '1.1rem' }}>Your Team</h2>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
            {membersLoading ? '…' : `${members.length} member${members.length !== 1 ? 's' : ''}`}
          </p>
        </div>
        {isAdmin && (
          <button className="btn btn-primary" style={{ gap: '0.5rem' }} onClick={() => setShowInvite(true)}>
            <UserPlus size={14} /> Invite Member
          </button>
        )}
      </div>

      <div className="card" style={{ padding: 0 }}>
        {membersLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} style={{ padding: '0.875rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
              <div className="skeleton" style={{ width: 36, height: 36, borderRadius: '50%' }} />
              <div style={{ flex: 1 }}>
                <div className="skeleton" style={{ width: 160, height: 13, marginBottom: 5 }} />
                <div className="skeleton" style={{ width: 90, height: 11 }} />
              </div>
            </div>
          ))
        ) : members.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
            No team members yet. Invite your team above.
          </div>
        ) : (
          members.map(member => (
            <div key={member.id} style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', padding: '0.875rem 1rem', borderBottom: '1px solid var(--border)' }}>
              <InitialsAvatar email={member.email} size={36} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {member.email}
                  {member.email === currentUser?.email && (
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginLeft: '0.5rem', fontWeight: 400 }}>(you)</span>
                  )}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
                  Joined {new Date(member.created_at).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}
                </div>
              </div>
              <span style={{
                fontSize: '0.65rem', fontWeight: 700, padding: '0.15rem 0.5rem', borderRadius: 100,
                color: member.role === 'admin' ? 'var(--purple)' : 'var(--text-muted)',
                background: member.role === 'admin' ? 'rgba(168,85,247,0.12)' : 'var(--bg)',
                border: '1px solid',
                borderColor: member.role === 'admin' ? 'rgba(168,85,247,0.3)' : 'var(--border)',
              }}>
                {member.role}
              </span>
            </div>
          ))
        )}
      </div>

      {showInvite && (
        <InviteModal
          onClose={() => setShowInvite(false)}
          onInvited={loadMembers}
        />
      )}
    </div>
  );
}
