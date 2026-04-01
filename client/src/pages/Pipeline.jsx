import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Search, Mail, ExternalLink, Zap, MessageSquare, Activity, X, CornerDownLeft } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import BeaverAvatar from '../components/BeaverAvatar';
import FilterTabs from '../components/FilterTabs';

/* ─── Constants ─────────────────────────────────────────── */

const STAGE_TABS = [
  { value: '',            label: 'All' },
  { value: 'prospecting', label: 'Prospecting' },
  { value: 'outreach',    label: 'Outreach' },
  { value: 'qualifying',  label: 'Qualifying' },
  { value: 'booked',      label: 'Booked' },
  { value: 'closed',      label: 'Closed' },
];

const STAGE_COLORS = {
  prospecting: 'var(--blue)',
  outreach:    'var(--lime)',
  qualifying:  'var(--orange)',
  booked:      'var(--purple)',
  closed:      '#64748b',
  closed_won:  '#10b981',
  closed_lost: '#64748b',
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
  return '#ef4444';
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
  const COLORS = { draft: 'var(--text-muted)', pending_ranger: 'var(--blue)', pending_approval: 'var(--orange)', approved: 'var(--lime)', sent: 'var(--lime)', ranger_rejected: 'var(--orange)', failed: '#ef4444' };
  const c = COLORS[status] || 'var(--text-muted)';
  return (
    <span style={{ fontSize: '0.6rem', fontWeight: 700, color: c, background: `${c}20`, padding: '0.1rem 0.4rem', borderRadius: 100 }}>
      {status?.replace(/_/g, ' ') || 'draft'}
    </span>
  );
}

/* ─── Lead Detail Panel ──────────────────────────────────── */

function LeadDetail({ lead, onUpdate }) {
  const { request } = useApi();
  const [notes, setNotes] = useState(lead.metadata?.notes || '');
  const [savingNotes, setSavingNotes] = useState(false);
  const [savingStage, setSavingStage] = useState(false);
  const [messages, setMessages] = useState([]);
  const [msgsLoading, setMsgsLoading] = useState(true);
  const [activity, setActivity] = useState([]);
  const [actLoading, setActLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
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
    setSavingStage(true);
    try {
      const res = await request(`/leads/${lead.id}`, { method: 'PUT', body: JSON.stringify({ pipeline_stage }) });
      if (res?.data) onUpdate(res.data);
    } catch {}
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
      {lead.last_reply_at && (
        <div style={{ padding: '0.625rem 1.5rem', background: 'rgba(200,255,0,0.08)', borderBottom: '1px solid rgba(200,255,0,0.2)', display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
          <CornerDownLeft size={13} style={{ color: 'var(--lime)', flexShrink: 0 }} />
          <span style={{ fontSize: '0.78rem', color: 'var(--lime)', fontWeight: 600 }}>Replied</span>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {new Date(lead.last_reply_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
          </span>
        </div>
      )}

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

        {/* 5. Messages */}
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

        {/* 6. Activity */}
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

export default function Pipeline() {
  const { request } = useApi();
  const [allLeads, setAllLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [stageFilter, setStageFilter] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    setLoading(true);
    request('/leads?perPage=200')
      .then(r => setAllLeads(r?.data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Client-side filter
  const filtered = allLeads.filter(l => {
    if (stageFilter && l.pipeline_stage !== stageFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        l.company?.toLowerCase().includes(q) ||
        l.name?.toLowerCase().includes(q) ||
        l.title?.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const handleUpdate = (updated) => {
    setAllLeads(ls => ls.map(l => l.id === updated.id ? updated : l));
    setSelected(updated);
  };

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 56px - 3rem)' }}>
      {/* Header */}
      <div className="page-header" style={{ flexShrink: 0 }}>
        <div>
          <h1 className="page-title">Pipeline</h1>
          <p className="page-subtitle">{filtered.length} of {allLeads.length} leads</p>
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
            filtered.map(lead => (
              <LeadListItem
                key={lead.id}
                lead={lead}
                selected={selected?.id === lead.id}
                onClick={() => setSelected(lead)}
              />
            ))
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
