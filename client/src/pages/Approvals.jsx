import React, { useEffect, useState } from 'react';
import { CheckCircle, XCircle, Edit2, Save, X, Shield, Send, AlertTriangle, Copy, ExternalLink, Clock, UserCheck } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useNavigate, useSearchParams } from 'react-router-dom';
import BeaverAvatar from '../components/BeaverAvatar';
import EmptyState from '../components/EmptyState';
import FilterTabs from '../components/FilterTabs';

const TABS = [
  { value: 'pending',   label: 'Pending' },
  { value: 'followups', label: 'Follow-ups' },
  { value: 'awaiting',  label: 'Ready to Send' },
  { value: 'approved',  label: 'Approved' },
  { value: 'rejected',  label: 'Rejected' },
];

function scoreColor(score) {
  if (score == null) return 'var(--text-muted)';
  if (score >= 80) return 'var(--lime)';
  if (score >= 60) return 'var(--blue)';
  return 'var(--orange)';
}

function ApprovalCard({ approval, onResolve, onSend, onEdit, onError, onConnectionSent, onConnectionAccepted, onFounderNote, tab, gmailConnected }) {
  const [editing, setEditing]     = useState(false);
  const [editBody, setEditBody]   = useState(approval.body || '');
  const [saving, setSaving]       = useState(false);
  const [acting, setActing]       = useState(false);
  const [copied, setCopied]       = useState(false);
  const [confirmingSent, setConfirmingSent] = useState(false);
  const [sentBody, setSentBody]   = useState(approval.body || '');
  const [noteText, setNoteText]     = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteSaved, setNoteSaved]   = useState(false);
  // Follow-ups tab needs action buttons too — the DM Sent button for LinkedIn followups
  // is rendered from the !resolved branch below. Without followups here, the button never renders.
  const resolved = tab !== 'pending' && tab !== 'awaiting' && tab !== 'followups';

  // A message is "auto-sendable" only if the channel is email AND we have an email.
  // LinkedIn / Instagram / any other channel is MANUAL SEND — user copies the message
  // and delivers it themselves via the platform. This is expected behaviour, not an error.
  const isEmailChannel = approval.channel === 'email';
  const hasEmail = !!(approval.lead_email && approval.lead_email !== 'unknown@example.com');
  const isManualSend = !isEmailChannel; // LinkedIn / Instagram / etc.
  const emailMissing = isEmailChannel && !hasEmail;

  const handleCopyBody = async () => {
    try {
      await navigator.clipboard.writeText(approval.body || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      onError('Copy failed — select the message text manually.');
    }
  };

  const handleApproveAndSend = async () => {
    if (acting) return; // prevent double-click

    // ONLY block if this is an EMAIL-channel message and the lead has no email.
    // LinkedIn / other channels are expected to be manual-send and pass this gate.
    if (emailMissing) {
      onError('No email address for this lead. Add their email before approving, or reject and resend later.');
      return;
    }

    setActing(true);
    try {
      await onResolve(approval.id, 'approved');
      // Only auto-send when channel is email AND Gmail is wired. For manual-send
      // channels (LinkedIn, Instagram), approval moves it to the Approved tab
      // where you can copy the message and send it yourself.
      if (isEmailChannel && gmailConnected) {
        await onSend(approval.message_id);
      }
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

  const handleFounderNote = async () => {
    if (noteSaving || !noteText.trim()) return;
    setNoteSaving(true);
    try {
      await onFounderNote(approval.message_id, noteText.trim());
      setNoteSaved(true);
      setNoteText('');
      setTimeout(() => setNoteSaved(false), 2500);
    } catch {
      onError('Could not save your note — try again.');
    } finally {
      setNoteSaving(false);
    }
  };

  const handleConnectionSent = async () => {
    if (acting) return;
    setActing(true);
    try {
      await onConnectionSent(approval.id);
    } finally {
      setActing(false);
    }
  };

  const handleConnectionAccepted = async () => {
    if (acting) return;
    setActing(true);
    try {
      await onConnectionAccepted(approval.id, sentBody);
    } finally {
      setActing(false);
      setConfirmingSent(false);
    }
  };

  const isLinkedin = approval.channel === 'linkedin';
  const isAwaiting = tab === 'awaiting';

  const actionLabel = isManualSend
    ? (acting ? 'Approving…' : 'Approve (Manual Send)')
    : gmailConnected
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
          {approval.message_metadata?.borderline && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.7rem', fontWeight: 600, color: 'var(--blue)', background: 'rgba(0,180,255,0.12)', padding: '0.2rem 0.5rem', borderRadius: 100 }}>
              Two thoughts
            </span>
          )}
          {approval.ranger_score != null && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem', fontWeight: 700, color: scoreColor(approval.ranger_score), background: approval.ranger_score >= 80 ? 'rgba(200,255,0,0.09)' : approval.ranger_score >= 60 ? 'rgba(0,180,255,0.09)' : 'rgba(255,140,0,0.09)', padding: '0.2rem 0.5rem', borderRadius: 100 }}>
              <Shield size={11} /> {approval.ranger_score}
            </span>
          )}
          <span className={`badge badge-${tab === 'approved' ? 'lime' : tab === 'rejected' ? 'orange' : tab === 'awaiting' ? 'blue' : 'muted'}`} style={{ textTransform: 'capitalize' }}>
            {tab === 'awaiting' ? 'Ready to Send' : tab}
          </span>
        </div>
      </div>

      {/* Channel + follow-up badge + subject */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', alignItems: 'center' }}>
        <span className="badge badge-muted" style={{ textTransform: 'capitalize', fontSize: '0.7rem' }}>{approval.channel}</span>
        {approval.message_metadata?.is_followup && (
          <span style={{ fontSize: '0.68rem', fontWeight: 600, color: 'var(--purple)', background: 'rgba(168,85,247,0.12)', padding: '0.15rem 0.45rem', borderRadius: 100 }}>
            Follow-up{approval.follow_up_day ? ` Day ${approval.follow_up_day}` : ''}
            {approval.message_metadata?.touch_number ? ` · Touch ${approval.message_metadata.touch_number}` : ''}
          </span>
        )}
        {approval.subject && <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{approval.subject}</span>}
      </div>

      {/* Manual-send note — shown for LinkedIn / Instagram / any non-email channel.
          Tells the user this message won't auto-send; they need to copy it and
          deliver it themselves via the platform. Shown before AND after approval. */}
      {isManualSend && (
        <div style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '0.5rem',
          padding: '0.6rem 0.75rem',
          marginBottom: '0.75rem',
          background: 'rgba(0,180,255,0.08)',
          border: '1px solid rgba(0,180,255,0.25)',
          borderRadius: 'var(--radius)',
          fontSize: '0.78rem',
          color: 'var(--text)',
          lineHeight: 1.5,
        }}>
          <AlertTriangle size={14} style={{ color: 'var(--blue)', flexShrink: 0, marginTop: 2 }} />
          <div style={{ flex: 1 }}>
            <strong style={{ color: 'var(--blue)' }}>Manual send required.</strong>
            {' '}This is a <strong style={{ textTransform: 'capitalize' }}>{approval.channel}</strong> message — BeavrDam doesn't auto-deliver on this channel. After you approve it, copy the message below and send it yourself via the prospect's {approval.channel} profile.
            {approval.lead_linkedin && approval.channel === 'linkedin' && (
              <>
                {' '}
                <a
                  href={approval.lead_linkedin}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--blue)', textDecoration: 'underline', whiteSpace: 'nowrap' }}
                >
                  Open LinkedIn profile <ExternalLink size={11} style={{ verticalAlign: 'middle' }} />
                </a>
              </>
            )}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={handleCopyBody}
            style={{ flexShrink: 0, fontSize: '0.72rem', padding: '0.25rem 0.5rem' }}
          >
            <Copy size={12} /> {copied ? 'Copied!' : 'Copy message'}
          </button>
        </div>
      )}

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

      {/* Borderline "two thoughts" — Fix 5 hero film promise */}
      {approval.message_metadata?.borderline && (
        <div style={{
          padding: '0.65rem 0.85rem',
          marginBottom: '0.75rem',
          background: 'rgba(0,180,255,0.06)',
          border: '1px solid rgba(0,180,255,0.2)',
          borderRadius: 'var(--radius)',
          fontSize: '0.82rem',
          lineHeight: 1.55,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.5rem', fontWeight: 700, color: 'var(--blue)' }}>
            <BeaverAvatar agent="ranger" size="xs" />
            <span>Sales Beaver has two thoughts</span>
            <span style={{ fontSize: '0.7rem', fontWeight: 500, color: 'var(--text-muted)', marginLeft: 'auto' }}>
              Score {approval.ranger_score}/100
            </span>
          </div>
          {approval.message_metadata.enforcer_suggestions?.map((s, i) => (
            <div key={i} style={{
              padding: '0.45rem 0.65rem',
              marginBottom: i < (approval.message_metadata.enforcer_suggestions.length - 1) ? '0.4rem' : 0,
              background: 'rgba(255,255,255,0.04)',
              borderRadius: 4,
              borderLeft: '3px solid var(--blue)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                <div style={{ fontWeight: 600, fontSize: '0.78rem', marginBottom: '0.25rem', color: 'var(--text)', flex: 1 }}>
                  {s.thought}
                </div>
                {s.current_phrase && s.suggested_phrase && !resolved && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: '0.68rem', padding: '0.15rem 0.45rem', flexShrink: 0, color: 'var(--lime)', border: '1px solid rgba(200,255,0,0.25)' }}
                    onClick={() => {
                      const current = editing ? editBody : (approval.body || '');
                      const updated = current.replace(s.current_phrase, s.suggested_phrase);
                      setEditBody(updated);
                      setEditing(true);
                    }}
                  >
                    Apply
                  </button>
                )}
              </div>
              {s.current_phrase && s.suggested_phrase && (
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  <span style={{ textDecoration: 'line-through', opacity: 0.7 }}>{s.current_phrase}</span>
                  {' → '}
                  <span style={{ color: 'var(--lime)', fontWeight: 500 }}>{s.suggested_phrase}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Ranger notes (hidden when borderline suggestions are shown to avoid duplication) */}
      {approval.ranger_notes && !approval.message_metadata?.borderline && (
        <div className="approval-ranger-notes">
          <BeaverAvatar agent="ranger" size="xs" />
          <span>{approval.ranger_notes}</span>
        </div>
      )}

      {/* Awaiting acceptance info banner */}
      {isAwaiting && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '0.5rem',
          padding: '0.5rem 0.75rem', marginBottom: '0.75rem',
          background: 'rgba(168,85,247,0.08)', border: '1px solid rgba(168,85,247,0.25)',
          borderRadius: 'var(--radius)', fontSize: '0.78rem', color: 'var(--text)',
        }}>
          <Clock size={14} style={{ color: 'var(--purple)', flexShrink: 0 }} />
          <span>Approved. After sending the DM on LinkedIn, click <strong>DM Sent</strong> to start the follow-up sequence.</span>
        </div>
      )}

      {/* DM Sent confirm — capture the text the founder actually sent (F-02).
          Pre-filled with the draft: no edit = one extra click; edited = the
          diff feeds founder_feedback so Sales Beaver learns. */}
      {confirmingSent && (
        <div className="approval-actions" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            Paste the message you actually sent — edit here if you changed anything on LinkedIn. This teaches Sales Beaver.
          </span>
          <textarea
            className="form-input approval-body"
            rows={6}
            value={sentBody}
            onChange={e => setSentBody(e.target.value)}
            style={{ resize: 'vertical', fontFamily: 'inherit', fontSize: '0.875rem', lineHeight: 1.6 }}
          />
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn btn-success btn-sm" onClick={handleConnectionAccepted} disabled={acting}>
              <UserCheck size={13} /> {acting ? 'Confirming…' : 'Confirm Sent'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setConfirmingSent(false); setSentBody(approval.body || ''); }} disabled={acting}>
              <X size={13} /> Cancel
            </button>
          </div>
        </div>
      )}

      {/* Actions */}
      {isAwaiting && !confirmingSent && (
        <div className="approval-actions">
          <button className="btn btn-success btn-sm" onClick={() => setConfirmingSent(true)} disabled={acting}>
            <UserCheck size={13} /> DM Sent
          </button>
          <button className="btn btn-danger btn-sm" onClick={handleReject} disabled={acting}>
            <XCircle size={13} /> No Response
          </button>
        </div>
      )}
      {!resolved && !isAwaiting && !confirmingSent && (
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
              {/* Follow-up tab + LinkedIn: inline "DM Sent" combines approve + mark-sent + schedule-next-touch.
                  Avoids the "approve here, then navigate to Ready to Send, then click DM Sent" two-step.
                  Shipped 2026-05-12 per MJ request. */}
              {tab === 'followups' && isLinkedin ? (
                <button className="btn btn-success btn-sm" onClick={() => setConfirmingSent(true)} disabled={acting} title="Marks the follow-up as sent and schedules the next touch. Click only after you have manually sent the DM on LinkedIn.">
                  <UserCheck size={13} /> DM Sent
                </button>
              ) : isLinkedin ? (
                <button className="btn btn-primary btn-sm" onClick={handleConnectionSent} disabled={acting}>
                  <Send size={13} /> {acting ? 'Approving…' : 'Approve'}
                </button>
              ) : (
                <button className="btn btn-success btn-sm" onClick={handleApproveAndSend} disabled={acting}>
                  <Send size={13} /> {actionLabel}
                </button>
              )}
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

      {/* Teach the beaver — explicit founder feedback. Writes to founder_feedback
          (feedback_type='founder_note') so Sales Beaver learns the founder's
          preference on its next draft, without him having to edit or reject. */}
      {!resolved && !editing && !confirmingSent && (
        <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--lime)', marginBottom: '0.4rem' }}>
            Teach the beaver
            <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> — tell Sales Beaver what to change. It learns from this on the next draft.</span>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              type="text"
              className="form-input"
              placeholder="e.g. opener's too long — lead with the trigger"
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleFounderNote(); }}
              disabled={noteSaving}
              style={{ flex: 1, fontSize: '0.8rem' }}
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={handleFounderNote}
              disabled={noteSaving || !noteText.trim()}
              style={{ flexShrink: 0, color: 'var(--lime)', border: '1px solid rgba(200,255,0,0.25)' }}
            >
              {noteSaving ? 'Saving…' : noteSaved ? '✓ Noted' : 'Teach'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Approvals() {
  const { request, loading } = useApi();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get('tab') || 'pending';
  const [tab, setTab]           = useState(initialTab);
  const [approvals, setApprovals] = useState([]);
  const [counts, setCounts]     = useState({ pending: 0, followups: 0, awaiting: 0, approved: 0, rejected: 0 });
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

  // Split all pending approvals client-side into three buckets:
  // 1. Regular pending (Day 0 outreach needing review) — INCLUDES borderline drafts
  //    regardless of follow-up status. Borderline (score 60-79) is the higher-priority
  //    signal — MJ collaborates via Apply / Edit / Skip per TWO-THOUGHTS-SPEC.md.
  // 2. Follow-ups (is_followup=true AND NOT borderline) — routine follow-ups due today
  // 3. Awaiting Accept (LinkedIn connection requests sent, waiting for accept)
  //
  // 2026-05-14: previously the score-74 borderline follow-up landed in Follow-ups tab
  // and never surfaced for two-thoughts review. Borderline detection also falls back to
  // ranger_score band 60-79 to cover messages re-scored between Fix 5b and Fix 5c deploys
  // that lost the metadata.borderline flag.
  const isBorderline = (a) => a.message_metadata?.borderline === true
    || (typeof a.ranger_score === 'number' && a.ranger_score >= 60 && a.ranger_score < 80);
  const splitPending = (allPending) => {
    const awaiting = allPending.filter(a => a.notes === 'linkedin_requested');
    const followups = allPending.filter(a =>
      a.notes !== 'linkedin_requested'
      && a.message_metadata?.is_followup
      && !isBorderline(a)
    );
    const realPending = allPending.filter(a =>
      a.notes !== 'linkedin_requested'
      && (!a.message_metadata?.is_followup || isBorderline(a))
    );
    return { awaiting, followups, realPending };
  };

  const load = async (tabName) => {
    try {
      if (tabName === 'awaiting' || tabName === 'pending' || tabName === 'followups') {
        const res = await request('/approvals?status=pending&perPage=200');
        const { awaiting, followups, realPending } = splitPending(res?.data || []);
        const bucketMap = { awaiting, followups, pending: realPending };
        setApprovals(bucketMap[tabName] || []);
        setCounts(prev => ({ ...prev, awaiting: awaiting.length, followups: followups.length, pending: realPending.length }));
      } else {
        const res = await request(`/approvals?status=${tabName}`);
        setApprovals(res?.data || []);
        setCounts(prev => ({ ...prev, [tabName]: res?.meta?.total || 0 }));
      }
    } catch {}
  };

  useEffect(() => { load(tab); }, [tab]);

  // Refresh pending + followups + awaiting counts on mount
  useEffect(() => {
    request('/approvals?status=pending&perPage=200').then(res => {
      const { awaiting, followups, realPending } = splitPending(res?.data || []);
      setCounts(prev => ({ ...prev, pending: realPending.length, followups: followups.length, awaiting: awaiting.length }));
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

  const handleConnectionSent = async (id) => {
    setActionError(null);
    try {
      await request(`/approvals/${id}/connection-sent`, { method: 'POST' });
      setApprovals(prev => prev.filter(a => a.id !== id));
      setCounts(prev => ({
        ...prev,
        [tab]: Math.max(0, prev[tab] - 1),
        awaiting: (prev.awaiting || 0) + 1,
      }));
    } catch (err) {
      setActionError(err?.message || 'Failed to mark connection sent');
    }
  };

  const handleConnectionAccepted = async (id, finalBody) => {
    setActionError(null);
    try {
      await request(`/approvals/${id}/dm-sent`, {
        method: 'POST',
        body: JSON.stringify({ final_body: finalBody || null }),
      });
      setApprovals(prev => prev.filter(a => a.id !== id));
      // 2026-05-12: decrement the active tab's counter, not always 'awaiting'.
      // Follow-up tab uses this same button (added 2026-05-12) so we must
      // handle followups + awaiting + pending decrements correctly.
      setCounts(prev => ({
        ...prev,
        [tab]: Math.max(0, (prev[tab] || 0) - 1),
        approved: (prev.approved || 0) + 1,
      }));
    } catch (err) {
      setActionError(err?.message || 'Failed to mark connection accepted');
    }
  };

  const handleFounderNote = async (message_id, note) => {
    setActionError(null);
    await request(`/messages/${message_id}/founder-note`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    });
  };

  const tabs = TABS.map(t => ({ ...t, count: counts[t.value] || 0 }));
  const pending = counts.pending + (counts.followups || 0) + (counts.awaiting || 0);

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
          title={tab === 'pending' ? 'All caught up!' : tab === 'followups' ? 'No follow-ups due' : tab === 'awaiting' ? 'No pending connections' : `No ${tab} messages`}
          description={
            tab === 'pending'
              ? "The Ranger hasn't queued any messages yet. Run a campaign from Director Chat."
              : tab === 'followups'
              ? "No follow-up messages due today. Follow-ups appear here on their scheduled day."
              : tab === 'awaiting'
              ? "No LinkedIn messages ready to send."
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
            onConnectionSent={handleConnectionSent}
            onConnectionAccepted={handleConnectionAccepted}
            onFounderNote={handleFounderNote}
          />
        ))
      )}
    </div>
  );
}
