import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Search, Mail, ExternalLink, Zap, MessageSquare, Activity, X, CornerDownLeft, CheckCircle, Clock, Lock, XCircle, PauseCircle, Phone, Target, FileText, RefreshCw, ChevronDown, ChevronUp, Sparkles } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import BeaverAvatar from '../components/BeaverAvatar';
import FilterTabs from '../components/FilterTabs';

/* ─── Constants ─────────────────────────────────────────── */

// 2026-05-13: pipeline_stage vocabulary aligned with downstream queries.
// Dashboard counts pipeline_stage='meeting_booked' (routes/dashboard.js:46)
// and canonical meeting-date endpoint writes 'meeting_booked'
// (routes/agents.js:276). The legacy UI value 'booked' didn't match either,
// so meetings never showed in dashboard. Label kept "Booked" for brevity.
// 'contacted' added so the 87 contacted leads aren't invisible from filtered views.
const STAGE_TABS = [
  { value: '',               label: 'All' },
  { value: 'prospecting',    label: 'Prospecting' },
  { value: 'contacted',      label: 'Contacted' },
  { value: 'outreach',       label: 'Outreach' },
  { value: 'qualifying',     label: 'Qualifying' },
  { value: 'meeting_booked', label: 'Booked' },
  { value: 'closed',         label: 'Closed' },
];

const STAGE_COLORS = {
  prospecting:    'var(--blue)',
  contacted:      'var(--orange)',
  outreach:       'var(--lime)',
  qualifying:     'var(--orange)',
  meeting_booked: 'var(--purple)',
  booked:         'var(--purple)', // legacy value retained for any in-flight rows
  closed:         'var(--muted)',
  closed_won:     'var(--success)',
  closed_lost:    'var(--muted)',
};

const STAGE_OPTIONS = STAGE_TABS.filter(s => s.value !== '');

const TIER_COLORS = { P1: 'var(--lime)', P2: 'var(--blue)', P3: 'var(--text-muted)' };

/* ─── Helpers ────────────────────────────────────────────── */

function formatTs(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function scoreColor(score) {
  if (score >= 70) return 'var(--lime)';
  if (score >= 40) return 'var(--orange)';
  return 'var(--danger)';
}

/* ─── Lead List Item ─────────────────────────────────────── */

function LeadListItem({ lead, selected, onClick }) {
  const stageColor = STAGE_COLORS[lead.pipeline_stage] || 'var(--text-muted)';

  return (
    <button
      onClick={onClick}
      style={{
        width: '100%', textAlign: 'left',
        background: selected ? 'rgba(200,255,0,0.06)' : 'transparent',
        border: 'none', borderBottom: '1px solid var(--border)',
        borderLeft: selected ? '3px solid var(--lime)' : '3px solid transparent',
        padding: '0.75rem 1rem', cursor: 'pointer', transition: 'background 0.15s',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          {/* Company name — bold, primary */}
          <div style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {lead.company || '(no company)'}
          </div>
          {/* Contact name + title — muted */}
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '0.1rem' }}>
            {lead.name}{lead.title ? ` · ${lead.title}` : ''}
          </div>
          {/* Last activity */}
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
            {formatTs(lead.updated_at || lead.created_at)}
          </div>
        </div>

        {/* Badges — right side */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.25rem', flexShrink: 0 }}>
          {/* Stage badge */}
          <span style={{ fontSize: '0.6rem', fontWeight: 600, color: stageColor, background: `${stageColor}20`, padding: '0.1rem 0.4rem', borderRadius: 100 }}>
            {lead.pipeline_stage || 'prospecting'}
          </span>
          {/* Score badge */}
          {lead.score > 0 && (
            <span style={{ fontSize: '0.6rem', fontWeight: 700, color: scoreColor(lead.score) }}>
              {lead.score}
            </span>
          )}
          {/* Reply badge */}
          {lead.last_reply_at && (
            <span style={{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--lime)', background: 'rgba(200,255,0,0.12)', padding: '0.1rem 0.4rem', borderRadius: 100, display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
              <CornerDownLeft size={8} /> replied
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

/* ─── Section Header ─────────────────────────────────────── */

function SectionLabel({ icon: Icon, label }) {
  return (
    <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
      {Icon && <Icon size={10} />} {label}
    </div>
  );
}

/* ─── Message Status Badge ───────────────────────────────── */

function MsgStatusBadge({ status }) {
  const COLORS = { draft: 'var(--text-muted)', pending_ranger: 'var(--blue)', pending_approval: 'var(--orange)', approved: 'var(--lime)', sent: 'var(--lime)', ranger_rejected: 'var(--orange)', failed: 'var(--danger)' };
  const c = COLORS[status] || 'var(--text-muted)';
  return (
    <span style={{ fontSize: '0.6rem', fontWeight: 700, color: c, background: `${c}20`, padding: '0.1rem 0.4rem', borderRadius: 100 }}>
      {status?.replace(/_/g, ' ') || 'draft'}
    </span>
  );
}

/* ─── Smart Actions Panel ────────────────────────────────── */

const ACTION_ICONS = { account_research: Search, call_prep: Phone, competitive_brief: Target, post_meeting: FileText };
const ACTION_COLORS = { account_research: 'var(--blue)', call_prep: 'var(--lime)', competitive_brief: 'var(--orange)', post_meeting: 'var(--purple)' };

function BriefContent({ type, content }) {
  if (!content) return null;

  const Row = ({ label, value }) => value ? (
    <div style={{ marginBottom: '0.5rem' }}>
      <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.2rem' }}>{label}</div>
      <div style={{ fontSize: '0.8rem', color: 'var(--text)', lineHeight: 1.5 }}>{value}</div>
    </div>
  ) : null;

  const Pills = ({ label, items }) => items?.length ? (
    <div style={{ marginBottom: '0.5rem' }}>
      <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.3rem' }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
        {items.map((item, i) => <span key={i} style={{ fontSize: '0.72rem', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '0.2rem 0.5rem', color: 'var(--text)' }}>{item}</span>)}
      </div>
    </div>
  ) : null;

  if (type === 'account_research') return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <span style={{ fontSize: '1.1rem', fontWeight: 700, color: Number(content.icp_fit_score) >= 70 ? 'var(--lime)' : Number(content.icp_fit_score) >= 40 ? 'var(--orange)' : 'var(--danger)' }}>{content.icp_fit_score}</span>
        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>ICP fit score</span>
        {content.likely_size && <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>{content.likely_size}</span>}
      </div>
      <Row label="Company" value={content.company_summary} />
      <Row label="ICP Fit" value={content.icp_fit_reason} />
      <Row label="Best Angle" value={content.best_angle} />
      <Pills label="Likely Pain Points" items={content.likely_pain_points} />
      <Pills label="Research Before Contact" items={content.things_to_research} />
      {content.red_flags?.length > 0 && <Pills label="⚠ Red Flags" items={content.red_flags} />}
    </div>
  );

  if (type === 'call_prep') return (
    <div>
      <Row label="Call Objective" value={content.call_objective} />
      {content.suggested_agenda?.length > 0 && (
        <div style={{ marginBottom: '0.5rem' }}>
          <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.3rem' }}>Suggested Agenda</div>
          {content.suggested_agenda.map((a, i) => (
            <div key={i} style={{ display: 'flex', gap: '0.5rem', fontSize: '0.78rem', marginBottom: '0.2rem' }}>
              <span style={{ color: 'var(--lime)', fontWeight: 600, flexShrink: 0, minWidth: 80 }}>{a.time}</span>
              <span style={{ color: 'var(--text)' }}>{a.item}</span>
            </div>
          ))}
        </div>
      )}
      <Pills label="Key Questions" items={content.key_questions} />
      {content.likely_objections?.length > 0 && (
        <div style={{ marginBottom: '0.5rem' }}>
          <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.3rem' }}>Likely Objections</div>
          {content.likely_objections.map((o, i) => (
            <div key={i} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '0.4rem 0.6rem', marginBottom: '0.35rem' }}>
              <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--orange)', marginBottom: '0.15rem' }}>"{o.objection}"</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text)' }}>{o.response}</div>
            </div>
          ))}
        </div>
      )}
      <Pills label="Talking Points" items={content.talking_points} />
      <Pills label="Listen For" items={content.what_to_listen_for} />
      <Row label="Ideal Close" value={content.ideal_next_step} />
    </div>
  );

  if (type === 'competitive_brief') return (
    <div>
      <Row label="Positioning" value={content.positioning_statement} />
      {content.likely_alternatives?.length > 0 && (
        <div style={{ marginBottom: '0.5rem' }}>
          <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.3rem' }}>Alternatives They May Consider</div>
          {content.likely_alternatives.map((alt, i) => (
            <div key={i} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '0.4rem 0.6rem', marginBottom: '0.35rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.15rem' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text)' }}>{alt.name}</span>
                <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{alt.type}</span>
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.15rem' }}>Why they might: {alt.their_strength}</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--lime)' }}>Our edge: {alt.our_advantage}</div>
            </div>
          ))}
        </div>
      )}
      <Pills label="Key Differentiators" items={content.key_differentiators} />
      <Pills label="⚠ Landmines — Avoid These" items={content.landmines} />
      <Pills label="Proof Points" items={content.proof_points} />
    </div>
  );

  if (type === 'post_meeting') return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: content.lead_temperature === 'hot' ? 'var(--orange)' : content.lead_temperature === 'warm' ? 'var(--lime)' : 'var(--text-muted)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 100, padding: '0.15rem 0.6rem' }}>
          {content.lead_temperature ? `${content.lead_temperature.toUpperCase()} LEAD` : ''}
        </span>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{content.lead_temperature_reason}</span>
      </div>
      <Row label="Meeting Summary" value={content.meeting_summary} />
      {content.action_items?.length > 0 && (
        <div style={{ marginBottom: '0.5rem' }}>
          <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.3rem' }}>Action Items</div>
          {content.action_items.map((a, i) => (
            <div key={i} style={{ display: 'flex', gap: '0.4rem', fontSize: '0.78rem', marginBottom: '0.2rem', alignItems: 'flex-start' }}>
              <span style={{ color: a.owner === 'Us' ? 'var(--lime)' : 'var(--blue)', fontWeight: 600, flexShrink: 0 }}>{a.owner}</span>
              <span style={{ color: 'var(--text)' }}>{a.action}</span>
              {a.deadline && <span style={{ color: 'var(--text-muted)', marginLeft: 'auto', flexShrink: 0, fontSize: '0.7rem' }}>{a.deadline}</span>}
            </div>
          ))}
        </div>
      )}
      {content.follow_up_email && (
        <div style={{ marginBottom: '0.5rem' }}>
          <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.3rem' }}>Follow-up Email (added to approval queue)</div>
          <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '0.5rem 0.75rem' }}>
            <div style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.3rem' }}>Subject: {content.follow_up_email.subject}</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{content.follow_up_email.body}</div>
          </div>
        </div>
      )}
      {content.proposal_outline && (
        <div>
          <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.3rem' }}>Proposal Outline</div>
          <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '0.5rem 0.75rem', fontSize: '0.78rem', color: 'var(--text)', lineHeight: 1.6 }}>
            <div><strong>{content.proposal_outline.headline}</strong></div>
            {content.proposal_outline.pain_addressed && <div>Pain: {content.proposal_outline.pain_addressed}</div>}
            {content.proposal_outline.solution && <div>Solution: {content.proposal_outline.solution}</div>}
            {content.proposal_outline.expected_outcome && <div>Outcome: {content.proposal_outline.expected_outcome}</div>}
            {content.proposal_outline.next_step && <div style={{ color: 'var(--lime)', marginTop: '0.25rem' }}>Next step: {content.proposal_outline.next_step}</div>}
          </div>
        </div>
      )}
    </div>
  );

  return null;
}

function SmartActionsPanel({ lead }) {
  const { request } = useApi();
  const [actions, setActions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(null); // which type is generating
  const [expanded, setExpanded] = useState(null);     // which type is open
  const [briefs, setBriefs] = useState({});           // type → content
  const [meetingNotes, setMeetingNotes] = useState('');

  useEffect(() => {
    setLoading(true);
    setBriefs({});
    setExpanded(null);
    request(`/agents/smart-actions/${lead.id}`)
      .then(async r => {
        const acts = r?.data?.actions || [];
        setActions(acts);
        // Pre-load any already-generated briefs
        for (const act of acts) {
          if (act.generated) {
            try {
              const brief = await request(`/agents/smart-actions/${lead.id}/${act.type}`);
              if (brief?.data?.content) {
                setBriefs(prev => ({ ...prev, [act.type]: brief.data.content }));
              }
            } catch {}
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [lead.id]);

  const handleGenerate = async (type) => {
    if (type === 'post_meeting' && !meetingNotes.trim()) return;
    setGenerating(type);
    try {
      const body = type === 'post_meeting' ? JSON.stringify({ notes: meetingNotes }) : undefined;
      const result = await request(`/agents/smart-actions/${lead.id}/${type}`, { method: 'POST', body });
      setBriefs(prev => ({ ...prev, [type]: result?.data }));
      setExpanded(type);
      setActions(prev => prev.map(a => a.type === type ? { ...a, generated: true } : a));
    } catch (err) {
      // error handled silently
    }
    setGenerating(null);
  };

  if (loading) return <div className="skeleton" style={{ height: 64, borderRadius: 6 }} />;
  if (!actions.length) return null;

  return (
    <div>
      <SectionLabel icon={Sparkles} label="Smart Actions" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {actions.map(action => {
          const Icon = ACTION_ICONS[action.type] || Zap;
          const color = ACTION_COLORS[action.type];
          const isOpen = expanded === action.type;
          const briefContent = briefs[action.type];
          const isGenerating = generating === action.type;

          return (
            <div key={action.type} style={{ border: `1px solid ${isOpen ? color + '40' : 'var(--border)'}`, borderRadius: 6, overflow: 'hidden', transition: 'border-color 0.2s' }}>
              {/* Action header */}
              <div
                style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.6rem 0.75rem', cursor: action.generated ? 'pointer' : 'default', background: isOpen ? `${color}08` : 'transparent' }}
                onClick={() => action.generated && setExpanded(isOpen ? null : action.type)}
              >
                <div style={{ width: 28, height: 28, borderRadius: 6, background: `${color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Icon size={14} style={{ color }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text)' }}>{action.label}</div>
                  <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{action.description}</div>
                </div>
                {action.generated ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <button
                      onClick={e => { e.stopPropagation(); handleGenerate(action.type); }}
                      title="Regenerate"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '0.2rem', display: 'flex', alignItems: 'center' }}
                      disabled={!!generating}
                    >
                      <RefreshCw size={12} style={{ opacity: isGenerating ? 0.4 : 1 }} />
                    </button>
                    {isOpen ? <ChevronUp size={13} style={{ color: 'var(--text-muted)' }} /> : <ChevronDown size={13} style={{ color: 'var(--text-muted)' }} />}
                  </div>
                ) : (
                  <button
                    className="btn btn-primary"
                    style={{ fontSize: '0.7rem', padding: '0.3rem 0.7rem', background: color, borderColor: color, color: action.type === 'call_prep' ? 'var(--bg)' : 'var(--bg)', flexShrink: 0 }}
                    onClick={e => { e.stopPropagation(); if (action.type !== 'post_meeting') handleGenerate(action.type); else setExpanded(isOpen ? null : action.type); }}
                    disabled={!!generating}
                  >
                    {isGenerating ? <><RefreshCw size={10} style={{ marginRight: 4 }} />Generating…</> : 'Generate'}
                  </button>
                )}
              </div>

              {/* Post-meeting notes input */}
              {action.type === 'post_meeting' && isOpen && !briefContent && (
                <div style={{ padding: '0 0.75rem 0.75rem' }}>
                  <textarea
                    className="form-input"
                    rows={4}
                    placeholder="Paste your raw meeting notes here — what was discussed, what they said, any commitments made…"
                    value={meetingNotes}
                    onChange={e => setMeetingNotes(e.target.value)}
                    style={{ resize: 'vertical', fontSize: '0.8rem', marginBottom: '0.5rem' }}
                  />
                  <button
                    className="btn btn-primary"
                    style={{ fontSize: '0.75rem', background: color, borderColor: color, color: 'var(--bg)' }}
                    onClick={() => handleGenerate('post_meeting')}
                    disabled={!meetingNotes.trim() || !!generating}
                  >
                    {isGenerating ? 'Processing…' : 'Process Notes'}
                  </button>
                </div>
              )}

              {/* Brief content */}
              {isOpen && briefContent && (
                <div style={{ padding: '0.75rem', borderTop: `1px solid ${color}25`, background: `${color}04` }}>
                  <BriefContent type={action.type} content={briefContent} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Lead Detail Panel ──────────────────────────────────── */

/* ─── Sequence Timeline ──────────────────────────────────── */

const TOUCH_LABELS = {
  1: 'First outreach',
  2: 'Follow-up 1 — value add',
  3: 'Follow-up 2 — new angle',
  4: 'Break-up email',
};

function SequenceSection({ leadId, clientId }) {
  const { request } = useApi();
  const [seq, setSeq] = useState(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);

  const load = () => {
    setLoading(true);
    request(`/leads/${leadId}/sequence`)
      .then(r => setSeq(r?.data || null))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [leadId]);

  const handleMarkReplied = async () => {
    const replyText = window.prompt(
      'Optional: paste the reply text (helps Sales Beaver learn). Leave blank to just mark replied.',
      ''
    );
    if (replyText === null) return; // user cancelled
    setActing(true);
    try {
      await request(`/leads/${leadId}/mark-replied`, {
        method: 'POST',
        body: JSON.stringify({ reply_text: replyText || '' }),
      });
      await load();
    } catch (err) {
      window.alert('Mark replied failed: ' + (err?.message || 'unknown error'));
    } finally {
      setActing(false);
    }
  };

  const handleAction = async (action) => {
    setActing(true);
    try {
      await request(`/leads/${leadId}/sequence`, { method: 'PUT', body: JSON.stringify({ action }) });
      load();
    } catch {}
    setActing(false);
  };

  if (loading) return <div className="skeleton" style={{ height: 80, borderRadius: 6 }} />;
  if (!seq || seq.sequence_touch === 0) return (
    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>No sequence started yet. Sequence begins when first message is sent.</div>
  );

  const statusIcon = (t) => {
    const qs = t.queue_status;
    const ms = t.message_status;
    if (qs === 'cancelled') return <XCircle size={14} style={{ color: 'var(--danger)' }} />;
    if (ms === 'sent' || qs === 'sent') return <CheckCircle size={14} style={{ color: 'var(--lime)' }} />;
    const today = new Date().toISOString().split('T')[0];
    const due = t.scheduled_for ? String(t.scheduled_for).split('T')[0] : null;
    if (ms === 'pending_approval' || (due && due <= today)) return <Clock size={14} style={{ color: 'var(--orange)' }} />;
    return <Lock size={14} style={{ color: 'var(--text-muted)' }} />;
  };

  const statusLabel = (t) => {
    const qs = t.queue_status;
    const ms = t.message_status;
    if (qs === 'cancelled') return 'cancelled';
    if (ms === 'sent') return 'sent';
    if (ms === 'pending_approval') return 'awaiting approval';
    if (ms === 'ranger_rejected') return 'ranger rejected';
    if (qs === 'sent') return 'queued';
    return 'scheduled';
  };

  const formatDate = (d) => {
    if (!d) return '—';
    return new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  return (
    <div>
      {/* Timeline */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem', marginBottom: '0.75rem' }}>
        {[1, 2, 3, 4].map(num => {
          const touch = seq.touches?.find(t => t.touch_number === num);
          if (!touch && num === 1) return null;
          const placeholder = !touch;
          return (
            <div key={num} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', opacity: placeholder ? 0.4 : 1 }}>
              {placeholder ? <Lock size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} /> : statusIcon(touch)}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 500, color: 'var(--text)' }}>
                    Touch {num} — {TOUCH_LABELS[num]}
                  </span>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                    {touch ? formatDate(touch.scheduled_for) : '—'}
                  </span>
                </div>
                {touch && (
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{statusLabel(touch)}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Status + controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
          Status: <strong style={{ color: seq.sequence_status === 'active' ? 'var(--lime)' : seq.sequence_status === 'replied' ? 'var(--blue)' : 'var(--orange)' }}>
            {seq.sequence_status}
          </strong>
        </span>
        {/* ✓ Replied always available — every back-and-forth reply needs to fire reply intelligence */}
        <button className="btn btn-ghost" style={{ padding: '0.2rem 0.5rem', fontSize: '0.7rem', gap: '0.25rem', color: 'var(--blue)' }} onClick={handleMarkReplied} disabled={acting} title="Mark this lead as replied — fires reply intelligence (classify, stop sequence, draft response on same channel, log). Click again on each new reply in a back-and-forth.">
          ✓ Replied
        </button>
        {seq.sequence_status === 'active' && (
          <>
            <button className="btn btn-ghost" style={{ padding: '0.2rem 0.5rem', fontSize: '0.7rem', gap: '0.25rem' }} onClick={() => handleAction('pause')} disabled={acting}>
              <PauseCircle size={11} /> Pause
            </button>
            <button className="btn btn-ghost" style={{ padding: '0.2rem 0.5rem', fontSize: '0.7rem', color: 'var(--danger)' }} onClick={() => handleAction('stop')} disabled={acting}>
              Stop
            </button>
          </>
        )}
        {seq.sequence_status === 'paused' && (
          <button className="btn btn-ghost" style={{ padding: '0.2rem 0.5rem', fontSize: '0.7rem', gap: '0.25rem' }} onClick={() => handleAction('resume')} disabled={acting}>
            ▶ Resume
          </button>
        )}
      </div>
    </div>
  );
}

function LeadDetail({ lead, onUpdate }) {
  const { request } = useApi();
  const [notes, setNotes] = useState(lead.metadata?.notes || '');
  const [savingNotes, setSavingNotes] = useState(false);
  const [savingStage, setSavingStage] = useState(false);
  const [stageError, setStageError] = useState(null);
  const [messages, setMessages] = useState([]);
  const [msgsLoading, setMsgsLoading] = useState(true);
  const [activity, setActivity] = useState([]);
  const [actLoading, setActLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [proposal, setProposal] = useState(null);
  const [generatingProposal, setGeneratingProposal] = useState(false);
  const [proposalCopied, setProposalCopied] = useState(false);
  const notesRef = useRef(notes);

  useEffect(() => {
    setNotes(lead.metadata?.notes || '');
    notesRef.current = lead.metadata?.notes || '';

    // Load messages
    setMsgsLoading(true);
    request(`/messages?lead_id=${lead.id}&perPage=10`)
      .then(r => setMessages(r?.data || []))
      .catch(() => {})
      .finally(() => setMsgsLoading(false));

    // Load activity (filter by target_type=lead, filter client-side by id)
    setActLoading(true);
    request(`/logs?target_type=lead&perPage=50`)
      .then(r => {
        const rows = (r?.data || []).filter(l => l.target_id === lead.id);
        setActivity(rows.slice(0, 10));
      })
      .catch(() => {})
      .finally(() => setActLoading(false));
  }, [lead.id]);

  const handleStageChange = async (e) => {
    const pipeline_stage = e.target.value;
    const label = STAGE_OPTIONS.find(s => s.value === pipeline_stage)?.label || pipeline_stage;
    setSavingStage(true);
    setStageError(null);
    try {
      const res = await request(`/leads/${lead.id}`, {
        method: 'PUT',
        body: JSON.stringify({ pipeline_stage, next_action: `Stage set to ${label}` }),
      });
      if (res?.data) onUpdate(res.data);
    } catch (err) {
      setStageError('Stage update failed');
    }
    setSavingStage(false);
  };

  const handleNotesSave = async () => {
    if (notesRef.current === notes) return;
    setSavingNotes(true);
    try {
      const res = await request(`/leads/${lead.id}`, {
        method: 'PUT',
        body: JSON.stringify({ metadata: { ...(lead.metadata || {}), notes } }),
      });
      if (res?.data) onUpdate(res.data);
      notesRef.current = notes;
    } catch {}
    setSavingNotes(false);
  };

  const handleGenerateProposal = async () => {
    setGeneratingProposal(true);
    setProposal(null);
    try {
      const res = await request(`/agents/sales/proposal/${lead.id}`, { method: 'POST' });
      if (res?.data) setProposal(res.data);
    } catch {}
    setGeneratingProposal(false);
  };

  const handleCopyProposal = () => {
    if (!proposal) return;
    const text = `Subject: ${proposal.subject}\n\n${proposal.body}`;
    navigator.clipboard.writeText(text).then(() => {
      setProposalCopied(true);
      setTimeout(() => setProposalCopied(false), 2000);
    });
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const genRes = await request('/agents/sales/generate', {
        method: 'POST',
        body: JSON.stringify({
          lead_id: lead.id,
          channel: 'email',
          context: `Name: ${lead.name}, Company: ${lead.company}, Title: ${lead.title || 'N/A'}`,
        }),
      });
      const draft = genRes?.data;
      if (draft?.body) {
        await request('/messages', {
          method: 'POST',
          body: JSON.stringify({ lead_id: lead.id, channel: 'email', subject: draft.subject || '', body: draft.body }),
        });
        const r = await request(`/messages?lead_id=${lead.id}&perPage=10`);
        setMessages(r?.data || []);
      }
    } catch {}
    setGenerating(false);
  };

  const stageColor = STAGE_COLORS[lead.pipeline_stage] || 'var(--text-muted)';

  return (
    <div style={{ height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text)', marginBottom: '0.25rem' }}>
              {lead.company || lead.name}
            </h2>
            <div style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
              {lead.name}{lead.title ? ` · ${lead.title}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexShrink: 0 }}>
            {/* Inline stage dropdown */}
            <select
              className="form-input"
              value={lead.pipeline_stage || 'prospecting'}
              onChange={handleStageChange}
              disabled={savingStage}
              style={{ fontSize: '0.8rem', padding: '0.3rem 0.5rem', color: stageColor, borderColor: stageColor, background: `${stageColor}10` }}
            >
              {STAGE_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            {stageError && (
              <span style={{ fontSize: '0.7rem', color: 'var(--danger)' }}>{stageError}</span>
            )}
            {/* Score badge */}
            {lead.score > 0 && (
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: scoreColor(lead.score), background: `${scoreColor(lead.score)}20`, padding: '0.2rem 0.6rem', borderRadius: 100 }}>
                {lead.score}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Reply banner */}
      {lead.last_reply_at && (() => {
        const sentiment = lead.metadata?.last_reply_sentiment;
        const sentimentStyle = {
          positive:  { bg: 'rgba(200,255,0,0.08)',  border: 'rgba(200,255,0,0.2)',  color: 'var(--lime)',        label: 'Positive' },
          neutral:   { bg: 'rgba(0,180,255,0.08)',  border: 'rgba(0,180,255,0.2)',  color: 'var(--blue)',        label: 'Neutral' },
          objection: { bg: 'rgba(255,140,0,0.08)',  border: 'rgba(255,140,0,0.2)',  color: 'var(--orange)',      label: 'Objection' },
          no_fit:    { bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.2)', color: 'var(--text-muted)', label: 'No Fit' },
        };
        const s = sentimentStyle[sentiment] || sentimentStyle.positive;
        return (
          <div style={{ padding: '0.625rem 1.5rem', background: s.bg, borderBottom: `1px solid ${s.border}`, display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
            <CornerDownLeft size={13} style={{ color: s.color, flexShrink: 0 }} />
            <span style={{ fontSize: '0.78rem', color: s.color, fontWeight: 600 }}>Replied</span>
            {sentiment && (
              <span style={{ fontSize: '0.7rem', color: s.color, background: s.bg, border: `1px solid ${s.border}`, borderRadius: 100, padding: '0.1rem 0.45rem', fontWeight: 500 }}>
                {s.label}
              </span>
            )}
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginLeft: 'auto' }}>
              {new Date(lead.last_reply_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
            </span>
            {lead.metadata?.last_reply_reason && (
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '40%' }}>
                {lead.metadata.last_reply_reason}
              </span>
            )}
          </div>
        );
      })()}

      {/* Body */}
      <div style={{ flex: 1, padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

        {/* 1. Contact Info */}
        <div>
          <SectionLabel label="Contact Info" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.625rem' }}>
            {[
              { label: 'Name',    value: lead.name },
              { label: 'Title',   value: lead.title },
              { label: 'Email',   value: lead.email,        link: lead.email ? `mailto:${lead.email}` : null },
              { label: 'LinkedIn', value: lead.linkedin_url ? 'View Profile' : null, link: lead.linkedin_url },
            ].map(({ label, value, link }) => (
              <div key={label}>
                <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.15rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
                {value ? (
                  link ? (
                    <a href={link} target="_blank" rel="noreferrer" style={{ fontSize: '0.875rem', color: 'var(--blue)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      {label === 'Email' ? <Mail size={11} /> : <ExternalLink size={11} />} {value}
                    </a>
                  ) : (
                    <div style={{ fontSize: '0.875rem', color: 'var(--text)' }}>{value}</div>
                  )
                ) : (
                  <div style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>—</div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 2. Company Info */}
        <div>
          <SectionLabel label="Company Info" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.625rem' }}>
            {[
              { label: 'Company',       value: lead.company },
              { label: 'Source',        value: lead.source },
              { label: 'Tier',          value: lead.signal_tier, color: lead.signal_tier ? TIER_COLORS[lead.signal_tier] : undefined },
              { label: 'Industry',      value: lead.metadata?.industry },
              { label: 'Company Size',  value: lead.metadata?.company_size },
              { label: 'Website',       value: lead.metadata?.website, link: lead.metadata?.website },
            ].map(({ label, value, color, link }) => value ? (
              <div key={label}>
                <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.15rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
                {link ? (
                  <a href={link} target="_blank" rel="noreferrer" style={{ fontSize: '0.875rem', color: 'var(--blue)', textDecoration: 'none' }}>{value}</a>
                ) : (
                  <div style={{ fontSize: '0.875rem', color: color || 'var(--text)' }}>{value}</div>
                )}
              </div>
            ) : null)}
          </div>
        </div>

        {/* 3. Pipeline Notes */}
        <div>
          <SectionLabel label={`Pipeline Notes${savingNotes ? ' · saving…' : ''}`} />
          <textarea
            className="form-input"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            onBlur={handleNotesSave}
            placeholder="Add notes about this lead…"
            rows={3}
            style={{ width: '100%', resize: 'vertical', fontSize: '0.875rem', lineHeight: 1.5, fontFamily: 'inherit' }}
          />
        </div>

        {/* 4. Generate Outreach */}
        <button
          className="btn btn-primary"
          style={{ width: '100%', justifyContent: 'center', gap: '0.5rem' }}
          onClick={handleGenerate}
          disabled={generating}
        >
          <Zap size={14} />
          {generating ? 'Generating…' : 'Generate Outreach with Sales Beaver'}
        </button>

        {/* 4b. Generate Proposal — shown for leads past initial outreach */}
        {['meeting_requested', 'meeting_booked', 'proposal', 'negotiating'].includes(lead.pipeline_stage) && (
          <div>
            <button
              className="btn btn-secondary"
              style={{ width: '100%', justifyContent: 'center', gap: '0.5rem', borderColor: 'rgba(168,85,247,0.4)', color: 'var(--purple)' }}
              onClick={handleGenerateProposal}
              disabled={generatingProposal}
            >
              <FileText size={14} />
              {generatingProposal ? 'Writing proposal…' : 'Generate Proposal with Sales Beaver'}
            </button>

            {proposal && (
              <div className="fade-in" style={{ marginTop: '0.75rem', background: 'rgba(168,85,247,0.05)', border: '1px solid rgba(168,85,247,0.2)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
                <div style={{ padding: '0.625rem 0.875rem', borderBottom: '1px solid rgba(168,85,247,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--purple)' }}>{proposal.subject}</div>
                    {proposal.pain_summary && (
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>{proposal.pain_summary}</div>
                    )}
                  </div>
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: '0.75rem', gap: '0.3rem', color: proposalCopied ? 'var(--lime)' : 'var(--text-muted)', flexShrink: 0 }}
                    onClick={handleCopyProposal}
                  >
                    {proposalCopied ? <><CheckCircle size={12} /> Copied</> : 'Copy'}
                  </button>
                </div>
                <div style={{ padding: '0.875rem', fontSize: '0.8rem', color: 'var(--text)', lineHeight: 1.7, whiteSpace: 'pre-wrap', maxHeight: 320, overflowY: 'auto' }}>
                  {proposal.body}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 5. Outreach Sequence */}
        <div>
          <SectionLabel label="Outreach Sequence" />
          <SequenceSection leadId={lead.id} />
        </div>

        {/* 5b. Smart Actions */}
        <SmartActionsPanel lead={lead} />

        {/* 6. Messages */}
        <div>
          <SectionLabel icon={MessageSquare} label={`Messages (${messages.length})`} />
          {msgsLoading ? (
            <div className="skeleton" style={{ height: 56, borderRadius: 6 }} />
          ) : messages.length === 0 ? (
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>No messages yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {messages.map(msg => (
                <div key={msg.id} style={{ background: 'var(--bg)', borderRadius: 6, padding: '0.625rem 0.75rem', border: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                    <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, marginRight: '0.5rem' }}>
                      {msg.subject || '(no subject)'}
                    </div>
                    <MsgStatusBadge status={msg.status} />
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{formatTs(msg.created_at)}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 7. Activity */}
        <div>
          <SectionLabel icon={Activity} label="Activity" />
          {actLoading ? (
            <div className="skeleton" style={{ height: 48, borderRadius: 6 }} />
          ) : activity.length === 0 ? (
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>No activity logged yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
              {activity.map(log => (
                <div key={log.id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--text-muted)', marginTop: 6, flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text)' }}>{log.action.replace(/_/g, ' ')}</div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{formatTs(log.created_at)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

/* ─── Main Page ──────────────────────────────────────────── */

const PER_PAGE = 40;

export default function Pipeline() {
  const { request } = useApi();
  const [leads, setLeads] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [stageFilter, setStageFilter] = useState('');
  const [search, setSearch] = useState('');

  const buildUrl = useCallback((p, stage, q) => {
    const params = new URLSearchParams({ page: p, perPage: PER_PAGE });
    if (stage) params.set('pipeline_stage', stage);
    if (q.trim()) params.set('search', q.trim());
    return `/leads?${params}`;
  }, []);

  // Reload when filter/search changes
  useEffect(() => {
    setLoading(true);
    setPage(1);
    setLeads([]);
    request(buildUrl(1, stageFilter, search))
      .then(r => {
        setLeads(r?.data || []);
        const t = r?.meta?.total || 0;
        setTotal(t);
        setHasMore((r?.data?.length || 0) < t);
      })
      .catch(err => setError('Failed to load data'))
      .finally(() => setLoading(false));
  }, [stageFilter, search]);

  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    const nextPage = page + 1;
    setLoadingMore(true);
    try {
      const r = await request(buildUrl(nextPage, stageFilter, search));
      const newLeads = r?.data || [];
      setLeads(prev => [...prev, ...newLeads]);
      setPage(nextPage);
      setHasMore(leads.length + newLeads.length < (r?.meta?.total || 0));
    } catch {} finally {
      setLoadingMore(false);
    }
  };

  const handleUpdate = (updated) => {
    setLeads(ls => ls.map(l => l.id === updated.id ? updated : l));
    setSelected(updated);
  };

  const filtered = leads;

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 56px - 3rem)' }}>
      {error && (
        <div style={{ padding: '16px', background: 'rgba(239,68,68,0.1)', borderRadius: 'var(--radius)', color: 'var(--danger)', marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
          <span>{error}</span>
          <button onClick={() => { setError(null); setStageFilter(f => f); setLoading(true); request(buildUrl(1, stageFilter, search)).then(r => { setLeads(r?.data || []); setTotal(r?.meta?.total || 0); setHasMore((r?.data?.length || 0) < (r?.meta?.total || 0)); }).catch(err => setError('Failed to load data')).finally(() => setLoading(false)); }} style={{ background: 'var(--danger)', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 'var(--radius)', cursor: 'pointer' }}>Retry</button>
        </div>
      )}
      {/* Header */}
      <div className="page-header" style={{ flexShrink: 0 }}>
        <div>
          <h1 className="page-title">Pipeline</h1>
          <p className="page-subtitle">{leads.length} of {total} leads</p>
        </div>
        {/* Search */}
        <div style={{ position: 'relative', width: 220 }}>
          <Search size={14} style={{ position: 'absolute', left: '0.6rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            className="form-input"
            placeholder="Search leads…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ paddingLeft: '2rem', paddingRight: search ? '2rem' : undefined, fontSize: '0.875rem' }}
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              style={{ position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, display: 'flex' }}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Stage tabs */}
      <div style={{ flexShrink: 0 }}>
        <FilterTabs
          tabs={STAGE_TABS}
          active={stageFilter}
          onChange={setStageFilter}
        />
      </div>

      {/* Two-panel */}
      <div style={{ flex: 1, display: 'flex', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', background: 'var(--panel)', minHeight: 0, marginTop: '0.75rem' }}>

        {/* Left Panel — 35% */}
        <div style={{ width: '35%', minWidth: 240, maxWidth: 360, flexShrink: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
          {loading ? (
            Array.from({ length: 6 }).map((_, i) => (
              <div key={i} style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)' }}>
                <div className="skeleton" style={{ height: 13, width: '65%', marginBottom: 5 }} />
                <div className="skeleton" style={{ height: 11, width: '45%', marginBottom: 5 }} />
                <div className="skeleton" style={{ height: 10, width: '30%' }} />
              </div>
            ))
          ) : filtered.length === 0 ? (
            <div style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
              No leads match your filters.
            </div>
          ) : (
            <>
              {filtered.map(lead => (
                <LeadListItem
                  key={lead.id}
                  lead={lead}
                  selected={selected?.id === lead.id}
                  onClick={() => setSelected(lead)}
                />
              ))}
              {hasMore && (
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  style={{ width: '100%', padding: '0.6rem 1rem', background: 'none', border: 'none', borderTop: '1px solid var(--border)', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}
                >
                  {loadingMore ? 'Loading…' : `Load more (${total - leads.length} remaining)`}
                </button>
              )}
            </>
          )}
        </div>

        {/* Right Panel — 65% */}
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          {selected ? (
            <LeadDetail
              key={selected.id}
              lead={selected}
              onUpdate={handleUpdate}
            />
          ) : (
            <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem', color: 'var(--text-muted)' }}>
              <BeaverAvatar agent="research_beaver" size="md" animate />
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '0.9rem', fontWeight: 500, color: 'var(--text)', marginBottom: '0.3rem' }}>Select a lead to view details</div>
                <div style={{ fontSize: '0.8rem' }}>Click any lead from the list on the left.</div>
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
