import React, { useEffect, useState } from 'react';
import { CheckCircle, XCircle, Edit2, Save, X, Shield, Send, AlertTriangle } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useNavigate } from 'react-router-dom';
import BeaverAvatar from '../components/BeaverAvatar';
import EmptyState from '../components/EmptyState';
import FilterTabs from '../components/FilterTabs';

const TABS = [
  { value: 'pending',  label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

function scoreColor(score) {
  if (score == null) return 'var(--text-muted)';
  if (score >= 80) return 'var(--lime)';
  if (score >= 60) return 'var(--blue)';
  return 'var(--orange)';
}

function ApprovalCard({ approval, onResolve, onSend, onEdit, onError, tab, gmailConnected }) {
  const [editing, setEditing]     = useState(false);
  const [editBody, setEditBody]   = useState(approval.body || '');
  const [saving, setSaving]       = useState(false);
  const [acting, setActing]       = useState(false);
  const resolved = tab !== 'pending';

  const handleApproveAndSend = async () => {
    if (acting) return; // prevent double-click
    // Block if Gmail connected but no email — send would fail silently after approval
    if (gmailConnected && (!approval.lead_email || approval.lead_email === 'unknown@example.com')) {
      onError('No email address for this lead. Add their email before approving.');
      return;
    }
    setActing(true);
    try {
      await onResolve(approval.id, 'approved');
      if (gmailConnected) await onSend(approval.message_id);
    } finally {
      setActing(false);
    }
  };

  const handleReject = async () => {
    if (acting) return; // prevent double-click
    setActing(true);
    try {
      await onResolve(approval.id, 'rejected');
    } finally {
      setActing(false);
    }
  };

  const handleSaveEdit = async () => {
    setSaving(true);
    await onEdit(approval.message_id, editBody);
    setSaving(false);
    setEditing(false);
  };

  const actionLabel = gmailConnected
    ? (acting ? 'Sending…' : 'Approve & Send')
    : (acting ? 'Queuing…' : 'Approve & Queue');

  return (
    <div className={`card approval-card fade-in${resolved ? ' approval-card--resolved' : ''}`}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.875rem' }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>{approval.lead_name || 'Unknown'}</div>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
            {(approval.lead_company && approval.lead_company !== 'Unknown') ? approval.lead_company : '—'}
            {approval.lead_title && <span style={{ marginLeft: '0.4rem' }}>· {approval.lead_title}</span>}
            {approval.lead_email && <span style={{ marginLeft: '0.4rem' }}>· {approval.lead_email}</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.35rem' }}>
            {approval.lead_linkedin ? (
              <a
                href={approval.lead_linkedin}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: '0.72rem', color: 'var(--blue)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
              >
                ↗ Verify on LinkedIn
              </a>
            ) : (
              <span style={{ fontSize: '0.72rem', color: 'var(--orange)' }}>⚠ No LinkedIn — verify manually</span>
            )}
            {approval.lead_source === 'ai_generated' && (
              <span style={{ fontSize: '0.72rem', color: 'var(--orange)', background: 'rgba(255,140,0,0.09)', padding: '0.1rem 0.4rem', borderRadius: 4 }}>
                AI generated — verify before approving
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {approval.ranger_score != null && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem', fontWeight: 700, color: scoreColor(approval.ranger_score), background: approval.ranger_score >= 80 ? 'rgba(200,255,0,0.09)' : approval.ranger_score >= 60 ? 'rgba(0,180,255,0.09)' : 'rgba(255,140,0,0.09)', padding: '0.2rem 0.5rem', borderRadius: 100 }}>
              <Shield size={11} /> {approval.ranger_score}
            </span>
          )}
          <span className={`badge badge-${tab === 'approved' ? 'lime' : tab === 'rejected' ? 'orange' : 'muted'}`} style={{ textTransform: 'capitalize' }}>
            {tab}
          </span>
        </div>
      </div>

      {/* Channel + subject */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', alignItems: 'center' }}>
        <span className="badge badge-muted" style={{ textTransform: 'capitalize', fontSize: '0.7rem' }}>{approval.channel}</span>
        {approval.subject && <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{approval.subject}</span>}
      </div>

      {/* Message body / edit textarea */}
      {editing ? (
        <div className="form-group" style={{ marginBottom: '0.75rem' }}>
          <textarea
            className="form-input approval-body"
            rows={6}
            value={editBody}
            onChange={e => setEditBody(e.target.value)}
            style={{ resize: 'vertical', fontFamily: 'inherit', fontSize: '0.875rem', lineHeight: 1.6 }}
          />
        </div>
      ) : (
        <div className="approval-body">
          {approval.body}
        </div>
      )}

      {/* Ranger notes */}
      {approval.ranger_notes && (
        <div className="approval-ranger-notes">
          <BeaverAvatar agent="ranger" size="xs" />
          <span>{approval.ranger_notes}</span>
        </div>
      )}

      {/* Actions */}
      {!resolved && (
        <div className="approval-actions">
          {editing ? (
            <>
              <button className="btn btn-primary btn-sm" onClick={handleSaveEdit} disabled={saving}>
                <Save size={13} /> {saving ? 'Saving…' : 'Save Edit'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => { setEditing(false); setEditBody(approval.body); }}>
                <X size={13} /> Cancel
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-success btn-sm" onClick={handleApproveAndSend} disabled={acting}>
                <Send size={13} /> {actionLabel}
              </button>
              <button className="btn btn-danger btn-sm" onClick={handleReject} disabled={acting}>
                <XCircle size={13} /> Reject
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
                <Edit2 size={13} /> Edit
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function Approvals() {
  const { request, loading } = useApi();
  const navigate = useNavigate();
  const [tab, setTab]           = useState('pending');
  const [approvals, setApprovals] = useState([]);
  const [counts, setCounts]     = useState({ pending: 0, approved: 0, rejected: 0 });
  const [gmailConnected, setGmailConnected] = useState(true); // optimistic
  const [actionError, setActionError] = useState(null);

  useEffect(() => {
    request('/integrations/status')
      .then(res => {
        const d = res?.data || {};
        setGmailConnected(d.gmail?.connected || d.agentmail?.connected || false);
      })
      .catch(() => setGmailConnected(false));
  }, []);

  const load = async (status) => {
    try {
      const res = await request(`/approvals?status=${status}`);
      setApprovals(res?.data || []);
      setCounts(prev => ({ ...prev, [status]: res?.meta?.total || 0 }));
    } catch {}
  };

  useEffect(() => { load(tab); }, [tab]);

  // Refresh pending count on mount
  useEffect(() => {
    request('/approvals?status=pending&perPage=1').then(res => {
      setCounts(prev => ({ ...prev, pending: res?.meta?.total || 0 }));
    }).catch(() => {});
  }, []);

  const handleResolve = async (id, status) => {
    setActionError(null);
    try {
      await request(`/approvals/${id}`, { method: 'PUT', body: JSON.stringify({ status }) });
      setApprovals(prev => prev.filter(a => a.id !== id));
      setCounts(prev => ({
        ...prev,
        [tab]: Math.max(0, prev[tab] - 1),
        [status]: (prev[status] || 0) + 1,
      }));
    } catch (err) {
      setActionError(err?.message || 'Action failed — please try again');
    }
  };

  const handleSend = async (message_id) => {
    setActionError(null);
    try {
      await request('/integrations/send', { method: 'POST', body: JSON.stringify({ message_id }) });
    } catch (err) {
      setActionError(err?.message || 'Send failed — check Gmail connection in Settings');
    }
  };

  const handleEdit = async (message_id, body) => {
    setActionError(null);
    try {
      await request(`/messages/${message_id}`, { method: 'PUT', body: JSON.stringify({ body }) });
      setApprovals(prev => prev.map(a => a.message_id === message_id ? { ...a, body } : a));
    } catch (err) {
      setActionError(err?.message || 'Failed to save edit');
    }
  };

  const tabs = TABS.map(t => ({ ...t, count: counts[t.value] }));
  const pending = counts.pending;

  return (
    <div className="fade-in">
      {actionError && (
        <div style={{ background: 'rgba(255,140,0,0.12)', border: '1px solid var(--orange)', borderRadius: 'var(--radius)', padding: '0.6rem 1rem', marginBottom: '1rem', fontSize: '0.85rem', color: 'var(--orange)', display: 'flex', justifyContent: 'space-between' }}>
          {actionError}
          <span style={{ cursor: 'pointer', opacity: 0.7 }} onClick={() => setActionError(null)}>✕</span>
        </div>
      )}
      <div className="page-header">
        <div>
          <h1 className="page-title">
            Approvals
            {pending > 0 && <span className="nav-badge" style={{ marginLeft: '0.6rem', fontSize: '0.75rem' }}>{pending}</span>}
          </h1>
          <p className="page-subtitle">
            {pending > 0
              ? <span style={{ color: 'var(--orange)' }}>{pending} message{pending !== 1 ? 's' : ''} waiting for your review</span>
              : 'All clear — nothing pending'}
          </p>
        </div>
      </div>

      {/* Gmail not connected warning */}
      {!gmailConnected && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '0.75rem',
          background: 'rgba(255,140,0,0.1)', border: '1px solid rgba(255,140,0,0.3)',
          borderRadius: 'var(--radius)', padding: '0.75rem 1rem', marginBottom: '1rem',
          fontSize: '0.875rem',
        }}>
          <AlertTriangle size={16} style={{ color: 'var(--orange)', flexShrink: 0 }} />
          <span style={{ color: 'var(--text)', flex: 1 }}>
            Gmail not connected. Approved messages will be <strong>queued</strong> but not sent.
          </span>
          <button
            className="btn btn-secondary"
            style={{ fontSize: '0.75rem', padding: '0.3rem 0.75rem', flexShrink: 0 }}
            onClick={() => navigate('/settings')}
          >
            Connect Gmail →
          </button>
        </div>
      )}

      <FilterTabs tabs={tabs} active={tab} onChange={v => setTab(v)} />

      {loading ? (
        Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="card" style={{ marginBottom: '1rem', height: 220 }}>
            <div className="skeleton" style={{ width: '40%', height: 16, marginBottom: 8 }} />
            <div className="skeleton" style={{ width: '60%', height: 12, marginBottom: 16 }} />
            <div className="skeleton" style={{ height: 80, marginBottom: 12 }} />
            <div className="skeleton" style={{ height: 36 }} />
          </div>
        ))
      ) : approvals.length === 0 ? (
        <EmptyState
          agent="ranger"
          title={tab === 'pending' ? 'All caught up!' : `No ${tab} messages`}
          description={
            tab === 'pending'
              ? "The Ranger hasn't queued any messages yet. Run a campaign from Director Chat."
              : `No messages have been ${tab} yet.`
          }
        />
      ) : (
        approvals.map(approval => (
          <ApprovalCard
            key={approval.id}
            approval={approval}
            tab={tab}
            gmailConnected={gmailConnected}
            onResolve={handleResolve}
            onSend={handleSend}
            onEdit={handleEdit}
            onError={setActionError}
          />
        ))
      )}
    </div>
  );
}
