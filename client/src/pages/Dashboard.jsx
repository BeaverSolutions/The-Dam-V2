import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  Users, MessageSquare, CheckCircle, Calendar,
  Zap, Coffee, Sun, Moon, Sunrise, X, FileText,
  Mail, Search, Send, AtSign, CornerDownRight, RefreshCw,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import BeaverAvatar, { BEAVER_COLORS, BEAVER_LABELS } from '../components/BeaverAvatar';
import { useApi } from '../hooks/useApi';
import { getUser } from '../utils/auth';

/* ─── Constants ─────────────────────────────────────────── */

const AGENTS = [
  { key: 'research_beaver' },
  { key: 'sales_beaver' },
  { key: 'ranger' },
  { key: 'director' },
];

const PIPELINE_STAGES = [
  { key: 'prospecting', label: 'Prospecting', color: 'var(--blue)' },
  { key: 'outreach',    label: 'Outreach',    color: 'var(--lime)' },
  { key: 'qualifying',  label: 'Qualifying',  color: 'var(--orange)' },
  { key: 'booked',      label: 'Booked',      color: 'var(--purple)' },
];

/* ─── Helpers ────────────────────────────────────────────── */

function greeting() {
  const h = new Date().getHours();
  if (h < 6)  return { text: 'Working late',  Icon: Moon };
  if (h < 12) return { text: 'Good morning',  Icon: Sunrise };
  if (h < 18) return { text: 'Good afternoon',Icon: Sun };
  return         { text: 'Good evening',       Icon: Coffee };
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function sinceSeconds(ts) {
  return (Date.now() - new Date(ts).getTime()) / 1000;
}

function agentState(lastLog) {
  if (!lastLog) return 'inactive';
  if (lastLog.action?.includes('error') || lastLog.action?.includes('failed')) return 'alert';
  const secs = sinceSeconds(lastLog.created_at);
  if (secs < 30) return 'working';
  if (secs < 300) return 'idle';
  return 'inactive';
}

function stateColor(s) {
  return { working: 'var(--lime)', idle: 'var(--blue)', inactive: 'var(--text-muted)', alert: 'var(--orange)' }[s] || 'var(--text-muted)';
}

function stateLabel(s) {
  return { working: 'Working', idle: 'Idle', inactive: 'Standby', alert: 'Alert' }[s] || 'Standby';
}

/* ─── Sub-components ─────────────────────────────────────── */

function GreetingHeader({ onBriefOpen, onRefresh, refreshing }) {
  const { text, Icon } = greeting();
  const user = getUser();
  const name = user?.name || user?.email?.split('@')[0] || 'there';
  const today = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div className="page-header" style={{ marginBottom: '1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <Icon size={24} style={{ color: 'var(--lime)' }} />
        <div>
          <h1 className="page-title">{text}, {name}!</h1>
          <p className="page-subtitle">{today} · The whole dam crew is working for you</p>
        </div>
      </div>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button className="btn btn-ghost" style={{ gap: '0.4rem', padding: '0.4rem 0.75rem' }} onClick={onRefresh} disabled={refreshing}>
          <RefreshCw size={14} style={{ animation: refreshing ? 'spin 1s linear infinite' : undefined }} /> Refresh
        </button>
        <button className="btn btn-secondary" style={{ gap: '0.5rem' }} onClick={onBriefOpen}>
          <FileText size={14} /> Morning Brief
        </button>
      </div>
    </div>
  );
}

function AgentCard({ agentKey, lastLog }) {
  const state = agentState(lastLog);
  const color = BEAVER_COLORS[agentKey] || 'var(--text-muted)';

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
      gap: '0.5rem', padding: '1rem 0.5rem', borderRight: '1px solid var(--border)',
    }}>
      <BeaverAvatar agent={agentKey} size="sm" animate state={state === 'working' ? 'working' : undefined} />
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '0.75rem', fontWeight: 600, color }}>{BEAVER_LABELS[agentKey]}</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem', marginTop: '0.2rem' }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: stateColor(state) }} />
          <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{stateLabel(state)}</span>
        </div>
        {lastLog && (
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '0.15rem', maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {lastLog.action.replace(/_/g, ' ')}
          </div>
        )}
      </div>
    </div>
  );
}

function LiveFeed({ logs }) {
  return (
    <div style={{ width: 260, flexShrink: 0, padding: '1rem', overflowY: 'auto' }}>
      <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <Zap size={10} style={{ color: 'var(--lime)' }} /> Live Feed
      </div>
      {logs.length === 0 ? (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>No activity yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {logs.map(log => (
            <div key={log.id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: BEAVER_COLORS[log.agent] || 'var(--text-muted)', marginTop: 5, flexShrink: 0 }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '0.72rem', lineHeight: 1.3, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{log.action.replace(/_/g, ' ')}</div>
                <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{BEAVER_LABELS[log.agent] || log.agent} · {formatTime(log.created_at)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentOfficeStrip({ agentLogs, liveLogs }) {
  return (
    <div className="card" style={{ padding: 0, marginBottom: '1.25rem', display: 'flex', overflow: 'hidden' }}>
      {AGENTS.map(({ key }) => (
        <AgentCard key={key} agentKey={key} lastLog={agentLogs[key]} />
      ))}
      <LiveFeed logs={liveLogs} />
    </div>
  );
}

function StatCard({ label, value, icon: Icon, color, loading, onClick, sub }) {
  return (
    <div
      className="card fade-in"
      onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: '1rem', cursor: onClick ? 'pointer' : 'default' }}
    >
      <div style={{ width: 44, height: 44, borderRadius: 'var(--radius)', background: `${color}20`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon size={20} style={{ color }} />
      </div>
      <div>
        {loading ? (
          <div className="skeleton" style={{ width: 40, height: 28, marginBottom: 4 }} />
        ) : (
          <div style={{ fontSize: '1.75rem', fontWeight: 700, lineHeight: 1 }}>{value}</div>
        )}
        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>{label}</div>
        {sub && !loading && <div style={{ fontSize: '0.7rem', color, marginTop: '0.1rem' }}>{sub}</div>}
      </div>
    </div>
  );
}

function IntegrationChips({ integrations, loading }) {
  if (loading) return null;
  const chips = [
    { key: 'gmail',      label: 'Gmail',      icon: Mail,   info: integrations?.gmail },
    { key: 'agentmail',  label: 'AgentMail',  icon: Send,   info: integrations?.agentmail },
    { key: 'apollo',     label: 'Apollo',     icon: Search, info: integrations?.apollo },
    { key: 'hunter',     label: 'Hunter',     icon: AtSign, info: integrations?.hunter },
  ];
  return (
    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
      {chips.map(({ key, label, icon: Icon, info }) => (
        <div key={key} style={{
          display: 'flex', alignItems: 'center', gap: '0.4rem',
          background: info?.connected ? 'rgba(200,255,0,0.08)' : 'var(--bg)',
          border: `1px solid ${info?.connected ? 'rgba(200,255,0,0.3)' : 'var(--border)'}`,
          borderRadius: 100, padding: '0.25rem 0.75rem',
        }}>
          <Icon size={12} style={{ color: info?.connected ? 'var(--lime)' : 'var(--text-muted)' }} />
          <span style={{ fontSize: '0.72rem', color: info?.connected ? 'var(--lime)' : 'var(--text-muted)', fontWeight: 600 }}>
            {label}
          </span>
          <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
            {info?.connected ? (info.email || 'connected') : 'not connected'}
          </span>
        </div>
      ))}
    </div>
  );
}

function PipelineFunnel({ byStage, total, loading }) {
  return (
    <div>
      <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.75rem' }}>
        Pipeline
      </div>
      {loading ? (
        Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 24, borderRadius: 4, marginBottom: 6 }} />)
      ) : (
        PIPELINE_STAGES.map(stage => {
          const count = parseInt(byStage?.[stage.key] || 0, 10);
          const pct = total > 0 ? Math.round((count / total) * 100) : 0;
          return (
            <div key={stage.key} style={{ marginBottom: '0.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', marginBottom: '0.2rem' }}>
                <span style={{ color: stage.color, fontWeight: 600 }}>{stage.label}</span>
                <span style={{ color: 'var(--text-muted)' }}>{count}</span>
              </div>
              <div style={{ height: 4, background: 'var(--bg)', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: stage.color, borderRadius: 2, transition: 'width 0.6s ease' }} />
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

function TodaySchedule({ events, loading }) {
  return (
    <div>
      <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <Calendar size={10} /> Today's Schedule
      </div>
      {loading ? (
        Array.from({ length: 2 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 48, borderRadius: 6, marginBottom: 8 }} />)
      ) : events.length === 0 ? (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', padding: '0.5rem 0' }}>No meetings today</div>
      ) : (
        events.map(ev => (
          <div key={ev.id} style={{ background: 'var(--bg)', borderRadius: 6, padding: '0.5rem 0.75rem', border: '1px solid var(--border)', marginBottom: '0.375rem' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.title}</div>
            <div style={{ fontSize: '0.65rem', color: 'var(--purple)', marginTop: '0.15rem' }}>{formatTime(ev.start_time)}</div>
          </div>
        ))
      )}
    </div>
  );
}

function MorningBriefModal({ open, onClose }) {
  const { request } = useApi();
  const [brief, setBrief] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setBrief(null);
    request('/agents/director/brief')
      .then(res => setBrief(res?.data || null))
      .catch(() => setBrief({ summary: 'Unable to load brief right now.', stats: {} }))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
      zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
    }}>
      <div className="card" style={{ width: '100%', maxWidth: 520, maxHeight: '80vh', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <BeaverAvatar agent="director" size="xs" animate />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>Morning Brief</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>from The Director</div>
          </div>
          <button className="btn btn-ghost" style={{ padding: '0.25rem' }} onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div className="skeleton" style={{ height: 16, width: '90%' }} />
              <div className="skeleton" style={{ height: 16, width: '75%' }} />
              <div className="skeleton" style={{ height: 16, width: '80%' }} />
            </div>
          ) : brief ? (
            <div>
              <div style={{ fontSize: '0.875rem', lineHeight: 1.7, color: 'var(--text)', marginBottom: '1rem', whiteSpace: 'pre-wrap' }}>{brief.summary}</div>
              {brief.stats && Object.keys(brief.stats).length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem' }}>
                  {Object.entries(brief.stats).map(([k, v]) => (
                    <div key={k} style={{ background: 'var(--bg)', borderRadius: 6, padding: '0.5rem 0.75rem', border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>{v}</div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'capitalize' }}>{k.replace(/_/g, ' ')}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>

        <button className="btn btn-secondary" style={{ alignSelf: 'flex-end' }} onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

/* ─── Main Page ──────────────────────────────────────────── */

export default function Dashboard() {
  const { request } = useApi();
  const navigate = useNavigate();

  const [stats, setStats] = useState({});
  const [statsLoading, setStatsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [agentLogs, setAgentLogs] = useState({});
  const [liveLogs, setLiveLogs] = useState([]);

  const [briefOpen, setBriefOpen] = useState(false);

  const loadLogs = useCallback(async () => {
    try {
      const res = await request('/logs?perPage=20');
      const rows = res?.data || [];
      const byAgent = {};
      rows.forEach(log => { if (!byAgent[log.agent]) byAgent[log.agent] = log; });
      setAgentLogs(byAgent);
      setLiveLogs(rows.slice(0, 8));
    } catch {}
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const res = await request('/dashboard/stats');
      setStats(res?.data || {});
    } catch {}
    setStatsLoading(false);
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadStats(), loadLogs()]);
    setRefreshing(false);
  };

  useEffect(() => {
    loadStats();
    loadLogs();
    const interval = setInterval(loadLogs, 10000);
    return () => clearInterval(interval);
  }, []);

  const byStage = stats.leads_by_stage || {};
  const totalLeads = stats.total_leads || 0;

  return (
    <div className="fade-in">
      <GreetingHeader onBriefOpen={() => setBriefOpen(true)} onRefresh={handleRefresh} refreshing={refreshing} />

      {/* Integration chips */}
      <IntegrationChips integrations={stats.integrations} loading={statsLoading} />

      {/* Agent Office Strip */}
      <AgentOfficeStrip agentLogs={agentLogs} liveLogs={liveLogs} />

      {/* Stats Row */}
      <div className="grid-4" style={{ marginBottom: '1.25rem' }}>
        <StatCard
          label="Total Leads"
          value={totalLeads}
          icon={Users}
          color="var(--blue)"
          loading={statsLoading}
          onClick={() => navigate('/pipeline')}
          sub={stats.leads_this_week > 0 ? `+${stats.leads_this_week} this week` : undefined}
        />
        <StatCard
          label="Messages Sent"
          value={stats.messages_sent || 0}
          icon={MessageSquare}
          color="var(--lime)"
          loading={statsLoading}
          onClick={() => navigate('/messages')}
          sub={stats.leads_replied > 0 ? `${stats.leads_replied} replied` : undefined}
        />
        <StatCard
          label="Pending Approvals"
          value={stats.pending_approvals || 0}
          icon={CheckCircle}
          color="var(--orange)"
          loading={statsLoading}
          onClick={() => navigate('/approvals')}
        />
        <StatCard
          label="Meetings Today"
          value={stats.meetings_today || 0}
          icon={Calendar}
          color="var(--purple)"
          loading={statsLoading}
          onClick={() => navigate('/calendar')}
        />
      </div>

      {/* Bottom Row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 240px', gap: '1rem' }} className="dashboard-bottom">
        {/* Pipeline funnel */}
        <div className="card">
          <PipelineFunnel byStage={byStage} total={totalLeads} loading={statsLoading} />
          {!statsLoading && stats.conversion_rate !== undefined && (
            <div style={{ marginTop: '0.875rem', paddingTop: '0.875rem', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <CornerDownRight size={12} style={{ color: 'var(--text-muted)' }} />
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Conversion rate</span>
              <span style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--lime)' }}>{stats.conversion_rate}%</span>
            </div>
          )}
        </div>

        {/* Today's Schedule */}
        <div className="card">
          <TodaySchedule events={stats.today_events || []} loading={statsLoading} />
        </div>
      </div>

      <MorningBriefModal open={briefOpen} onClose={() => setBriefOpen(false)} />
    </div>
  );
}
