import React, { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { Mail, Linkedin, Instagram, ChevronDown, ChevronUp, CornerDownLeft } from 'lucide-react';
import EmptyState from '../components/EmptyState';
import FilterTabs from '../components/FilterTabs';

const STATUS_MAP = {
  draft: { label: 'Draft', cls: 'badge-muted' },
  pending_ranger: { label: 'Ranger Review', cls: 'badge-orange' },
  ranger_rejected: { label: 'Rejected', cls: 'badge-orange' },
  pending_approval: { label: 'Needs Approval', cls: 'badge-blue' },
  approved: { label: 'Approved', cls: 'badge-lime' },
  sent: { label: 'Sent', cls: 'badge-lime' },
  failed: { label: 'Failed', cls: 'badge-orange' },
};

const CHANNEL_ICONS = { email: Mail, linkedin: Linkedin, instagram: Instagram };

function MessageRow({ msg }) {
  const [expanded, setExpanded] = useState(false);
  const StatusInfo = STATUS_MAP[msg.status] || { label: msg.status, cls: 'badge-muted' };
  const ChannelIcon = CHANNEL_ICONS[msg.channel] || Mail;

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div
        style={{ padding: '1rem', display: 'flex', alignItems: 'center', gap: '1rem', cursor: 'pointer' }}
        onClick={() => setExpanded(!expanded)}
      >
        <ChannelIcon size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '0.875rem', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {msg.subject || msg.body.substring(0, 60) + '...'}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
            {msg.lead_name} · {msg.lead_company}
          </div>
        </div>
        <span className={`badge ${StatusInfo.cls}`}>{StatusInfo.label}</span>
        {msg.reply_detected_at && (
          <span style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--lime)', background: 'rgba(200,255,0,0.12)', padding: '0.15rem 0.45rem', borderRadius: 100, display: 'flex', alignItems: 'center', gap: '0.2rem', flexShrink: 0 }}>
            <CornerDownLeft size={10} /> replied
          </span>
        )}
        {msg.ranger_score && <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Score: {msg.ranger_score}</span>}
        {expanded ? <ChevronUp size={16} style={{ color: 'var(--text-muted)' }} /> : <ChevronDown size={16} style={{ color: 'var(--text-muted)' }} />}
      </div>
      {expanded && (
        <div style={{ padding: '0 1rem 1rem', background: 'rgba(0,0,0,0.2)', margin: '0 -1px' }}>
          {msg.subject && <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>Subject: {msg.subject}</div>}
          <pre style={{ fontSize: '0.85rem', whiteSpace: 'pre-wrap', fontFamily: 'inherit', color: 'var(--text)' }}>{msg.body}</pre>
          {msg.ranger_notes && (
            <div style={{ marginTop: '0.75rem', padding: '0.5rem', background: 'rgba(255,140,0,0.1)', borderRadius: 'var(--radius)', fontSize: '0.8rem', color: 'var(--orange)' }}>
              Ranger notes: {msg.ranger_notes}
            </div>
          )}
          {msg.reply_snippet && (
            <div style={{ marginTop: '0.75rem', padding: '0.5rem 0.75rem', background: 'rgba(200,255,0,0.06)', border: '1px solid rgba(200,255,0,0.2)', borderRadius: 'var(--radius)', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              <span style={{ color: 'var(--lime)', fontWeight: 600 }}><CornerDownLeft size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />Reply snippet:</span> {msg.reply_snippet}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Messages() {
  const { request, loading } = useApi();
  const [messages, setMessages] = useState([]);
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => {
    const url = statusFilter ? `/messages?status=${statusFilter}` : '/messages';
    request(url).then(res => setMessages(res?.data || [])).catch(() => {});
  }, [statusFilter]);

  return (
    <div className="fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Messages</h1>
          <p className="page-subtitle">All outreach messages</p>
        </div>
      </div>

      <FilterTabs
        tabs={[
          { value: '', label: 'All' },
          { value: 'draft', label: 'Draft' },
          { value: 'pending_ranger', label: 'Ranger Review' },
          { value: 'pending_approval', label: 'Needs Approval' },
          { value: 'approved', label: 'Approved' },
          { value: 'sent', label: 'Sent' },
        ]}
        active={statusFilter}
        onChange={setStatusFilter}
      />

      <div className="card" style={{ padding: 0 }}>
        {loading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} style={{ padding: '1rem', borderBottom: '1px solid var(--border)' }}>
              <div className="skeleton" style={{ width: '60%', height: 14, marginBottom: 6 }} />
              <div className="skeleton" style={{ width: '30%', height: 12 }} />
            </div>
          ))
        ) : messages.length === 0 ? (
          <EmptyState
            agent="sales_beaver"
            title="No messages yet"
            description="Ask the Director to start a campaign to generate outreach messages."
          />
        ) : (
          messages.map(msg => <MessageRow key={msg.id} msg={msg} />)
        )}
      </div>
    </div>
  );
}
