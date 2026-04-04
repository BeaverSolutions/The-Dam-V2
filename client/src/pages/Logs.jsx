import React, { useEffect, useState, useCallback } from 'react';
import { Search, Download, X } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import BeaverAvatar from '../components/BeaverAvatar';
import FilterTabs from '../components/FilterTabs';
import EmptyState from '../components/EmptyState';

const AGENT_COLORS = {
  research_beaver: 'var(--blue)',
  sales_beaver:    'var(--orange)',
  ranger:          'var(--police-blue)',
  director:        'var(--purple)',
  system:          'var(--text-muted)',
};

const AGENT_LABELS = {
  research_beaver: 'Research Beaver',
  sales_beaver:    'Sales Beaver',
  ranger:          'Enforcer Beaver',
  director:        'Captain Beaver',
  system:          'System',
};

const FILTER_TABS = [
  { value: '',               label: 'All Agents' },
  { value: 'research_beaver',label: 'Research Beaver' },
  { value: 'sales_beaver',   label: 'Sales Beaver' },
  { value: 'ranger',         label: 'Enforcer' },
  { value: 'director',       label: 'Captain' },
  { value: 'system',         label: 'System' },
];

function formatTs(ts) {
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function isToday(ts) {
  const d = new Date(ts);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

function exportCSV(logs) {
  const headers = ['id', 'agent', 'action', 'target_type', 'target_id', 'created_at'];
  const rows = logs.map(l => headers.map(h => JSON.stringify(l[h] ?? '')).join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `activity_log_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Logs() {
  const { request, loading } = useApi();
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [agentFilter, setAgentFilter] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page, perPage: 50 });
    if (agentFilter) params.set('agent', agentFilter);
    try {
      const res = await request(`/logs?${params}`);
      setLogs(res?.data || []);
      setTotal(res?.meta?.total || 0);
    } catch {}
  }, [agentFilter, page]);

  useEffect(() => { load(); }, [load]);

  // Stats computed from loaded data (client-side, no extra API calls)
  const todayCount     = logs.filter(l => isToday(l.created_at)).length;
  const researchCount  = logs.filter(l => l.agent === 'research_beaver').length;
  const salesCount     = logs.filter(l => l.agent === 'sales_beaver').length;

  // Search filter on loaded data
  const filtered = search.trim()
    ? logs.filter(l =>
        l.action?.toLowerCase().includes(search.toLowerCase()) ||
        l.target_type?.toLowerCase().includes(search.toLowerCase()) ||
        AGENT_LABELS[l.agent]?.toLowerCase().includes(search.toLowerCase()) ||
        JSON.stringify(l.metadata || {}).toLowerCase().includes(search.toLowerCase())
      )
    : logs;

  const totalPages = Math.ceil(total / 50);

  return (
    <div className="fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Activity Log</h1>
          <p className="page-subtitle">{total} events recorded</p>
        </div>
        <button
          className="btn btn-secondary"
          style={{ gap: '0.5rem' }}
          onClick={() => exportCSV(filtered)}
          disabled={filtered.length === 0}
        >
          <Download size={14} /> Export CSV
        </button>
      </div>

      {/* Stats chips — computed from loaded data */}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        {[
          { label: 'Total Events', value: total,         color: 'var(--text-muted)' },
          { label: 'Today',        value: todayCount,    color: 'var(--text-muted)' },
          { label: 'Research Beaver', value: researchCount, color: 'var(--blue)' },
          { label: 'Sales Beaver',    value: salesCount,    color: 'var(--orange)' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', background: `${color}15`, border: `1px solid ${color}40`, borderRadius: 100, padding: '0.25rem 0.75rem' }}>
            <span style={{ fontSize: '0.72rem', color, fontWeight: 600 }}>{label}:</span>
            <span style={{ fontSize: '0.72rem', color, fontWeight: 700 }}>{value}</span>
          </div>
        ))}
      </div>

      {/* Search bar with X button */}
      <div style={{ position: 'relative', marginBottom: '0.875rem' }}>
        <Search size={14} style={{ position: 'absolute', left: '0.7rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
        <input
          className="form-input"
          placeholder="Search events…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ paddingLeft: '2.25rem', paddingRight: search ? '2.25rem' : undefined, fontSize: '0.875rem' }}
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            style={{ position: 'absolute', right: '0.6rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, display: 'flex', alignItems: 'center' }}
          >
            <X size={14} />
          </button>
        )}
      </div>

      <FilterTabs
        tabs={FILTER_TABS}
        active={agentFilter}
        onChange={(val) => { setAgentFilter(val); setPage(1); }}
      />

      <div className="card" style={{ padding: 0 }}>
        {loading ? (
          Array.from({ length: 8 }).map((_, i) => (
            <div key={i} style={{ padding: '0.875rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', gap: '0.75rem' }}>
              <div className="skeleton" style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, marginTop: 4 }} />
              <div style={{ flex: 1 }}>
                <div className="skeleton" style={{ width: '50%', height: 13, marginBottom: 4 }} />
                <div className="skeleton" style={{ width: '25%', height: 11 }} />
              </div>
            </div>
          ))
        ) : filtered.length === 0 ? (
          <EmptyState
            agent="director"
            title="No activity yet"
            description="The crew hasn't logged any actions yet. Start a campaign from Director Chat."
          />
        ) : (
          filtered.map(log => (
            <div key={log.id} style={{ display: 'flex', gap: '0.875rem', alignItems: 'center', padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)' }}>
              <BeaverAvatar agent={log.agent} size="xs" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.875rem', marginBottom: '0.15rem' }}>{log.action.replace(/_/g, ' ')}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  <span style={{ color: AGENT_COLORS[log.agent] }}>{AGENT_LABELS[log.agent]}</span>
                  {' · '}{formatTs(log.created_at)}
                  {log.target_type && ` · ${log.target_type}`}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: '0.5rem', marginTop: '1rem' }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>Prev</button>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', alignSelf: 'center' }}>Page {page} of {totalPages}</span>
          <button className="btn btn-secondary btn-sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>Next</button>
        </div>
      )}
    </div>
  );
}
