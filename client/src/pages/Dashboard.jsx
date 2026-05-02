import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  Users, Calendar, Clock,
  Zap, Coffee, Sun, Moon, Sunrise, X, FileText,
  Mail, Search, Send, AtSign, ExternalLink, RefreshCw,
  ArrowRight, MessageCircle, Target, BookOpen, BarChart2,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import BeaverAvatar, { BEAVER_COLORS, BEAVER_LABELS } from '../components/BeaverAvatar';
import BeaverStatusBoard from '../components/BeaverStatusBoard';
import PipelineEngine from '../components/PipelineEngine';
import BeaverStatsCard from '../components/BeaverStatsCard';
import StageBreakdownRail from '../components/StageBreakdownRail';
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
  const rawName = user?.name || user?.email?.split('@')[0] || 'there';
  const name = rawName.charAt(0).toUpperCase() + rawName.slice(1);
  const today = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div className="page-header" style={{ marginBottom: '1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <Icon size={24} style={{ color: 'var(--brand)' }} />
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
    <div className="card agent-office-strip" style={{ padding: 0, marginBottom: '1.25rem', display: 'flex', overflow: 'hidden' }}>
      {AGENTS.map(({ key }) => (
        <AgentCard key={key} agentKey={key} lastLog={agentLogs[key]} />
      ))}
      <LiveFeed logs={liveLogs} />
    </div>
  );
}

function LlmSpendCard() {
  const { request } = useApi();
  const [data, setData] = useState(null);

  useEffect(() => {
    request('/dashboard/llm-usage').then(r => setData(r?.data)).catch(() => {});
  }, []);

  if (!data) return null;

  const { today } = data;
  const pct = today.percentage;
  const barColor = pct >= 80 ? 'var(--orange)' : 'var(--lime)';

  return (
    <div className="card" style={{ marginBottom: '1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Zap size={14} style={{ color: 'var(--purple)' }} />
          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>AI Spend Today</span>
        </div>
        <span style={{ fontSize: '0.8rem', fontWeight: 600, color: barColor }}>
          ${today.spend_usd.toFixed(2)} / ${today.budget_usd.toFixed(2)}
        </span>
      </div>
      <div style={{ height: 6, background: 'var(--bg)', borderRadius: 3, overflow: 'hidden', marginBottom: '0.75rem' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: barColor, borderRadius: 3, transition: 'width 0.3s ease' }} />
      </div>
      {data.by_agent.length > 0 && (
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          {data.by_agent.map(a => (
            <div key={a.agent} style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
              <span style={{ color: 'var(--text)', fontWeight: 500 }}>{(a.agent || 'unknown').replace(/_/g, ' ')}</span>
              {' '}${a.cost_usd.toFixed(3)} ({a.calls} calls)
            </div>
          ))}
        </div>
      )}
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
          <div className="stat-value" style={{ fontSize: '1.75rem', fontWeight: 700, lineHeight: 1 }}>{value}</div>
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
    { key: 'gmail',           label: 'Gmail',          icon: Mail,         info: integrations?.gmail },
    { key: 'google_calendar', label: 'Google Calendar',icon: Calendar,     info: integrations?.google_calendar },
    { key: 'agentmail',       label: 'AgentMail',      icon: Send,         info: integrations?.agentmail },
    { key: 'apollo',          label: 'Apollo',         icon: Search,       info: integrations?.apollo },
    { key: 'hunter',          label: 'Hunter',         icon: AtSign,       info: integrations?.hunter },
    { key: 'calendly',        label: 'Calendly',       icon: ExternalLink, info: integrations?.calendly },
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
            {info?.connected ? (info.email || info.label || 'connected') : 'not connected'}
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

/* ─── Director Floating Bubble ───────────────────────────── */

const BUBBLE_STORAGE = 'dam_director_chat';

function DirectorBubble({ prefilledCommand, onCommandUsed }) {
  const { request, loading } = useApi();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');

  // Open + pre-fill when KPI button fires
  useEffect(() => {
    if (prefilledCommand) {
      setOpen(true);
      setInput(prefilledCommand);
      onCommandUsed && onCommandUsed();
    }
  }, [prefilledCommand]);
  const [messages, setMessages] = useState(() => {
    try {
      const s = sessionStorage.getItem(BUBBLE_STORAGE);
      if (s) {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed.slice(-4);
      }
    } catch {}
    return [{ role: 'assistant', content: 'Hi! Give me a goal and I\'ll coordinate the crew.' }];
  });
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open]);

  const send = async () => {
    if (!input.trim() || loading) return;
    const cmd = input.trim();
    const next = [...messages, { role: 'user', content: cmd }];
    setMessages(next);
    setInput('');
    try {
      const res = await request('/agents/director/plan', { method: 'POST', body: JSON.stringify({ command: cmd }) });
      const plan = res?.data;
      let reply;
      if (plan?.status === 'out_of_scope') {
        reply = plan.message;
      } else if (plan?.steps) {
        reply = `Plan ready: ${plan.steps.length} steps, ~${plan.estimated_leads} leads. Open Director Chat to approve & execute.`;
      } else {
        reply = 'Got it — open Director Chat to manage the full pipeline.';
      }
      const final = [...next, { role: 'assistant', content: reply }];
      setMessages(final);
      try { sessionStorage.setItem(BUBBLE_STORAGE, JSON.stringify(final)); } catch {}
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Something went wrong. Try from Director Chat.' }]);
    }
  };

  return (
    <>
      {/* Chat panel */}
      {open && (
        <div className="director-bubble-panel" style={{
          position: 'fixed', bottom: 90, right: 24,
          width: 320, maxHeight: 420,
          background: 'var(--panel)', border: '1px solid var(--border)',
          borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          display: 'flex', flexDirection: 'column',
          zIndex: 300,
        }}>
          {/* Header */}
          <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <BeaverAvatar agent="director" size="xs" animate />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>The Director</div>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Quick command</div>
            </div>
            <button
              className="btn btn-ghost"
              style={{ padding: '0.2rem', fontSize: '0.72rem', color: 'var(--purple)', gap: 3 }}
              onClick={() => navigate('/chat')}
            >
              Full chat <ArrowRight size={11} />
            </button>
            <button className="btn btn-ghost" style={{ padding: '0.2rem' }} onClick={() => setOpen(false)}>
              <X size={15} />
            </button>
          </div>

          {/* Messages */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {messages.map((m, i) => (
              <div key={i} style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '85%',
                background: m.role === 'user' ? 'rgba(200,255,0,0.1)' : 'var(--bg)',
                border: `1px solid ${m.role === 'user' ? 'rgba(200,255,0,0.2)' : 'var(--border)'}`,
                borderRadius: 8, padding: '0.4rem 0.6rem',
                fontSize: '0.78rem', lineHeight: 1.5,
              }}>
                {m.content}
              </div>
            ))}
            {loading && (
              <div style={{ display: 'flex', gap: 4, padding: '0.4rem 0.6rem' }}>
                {[0,1,2].map(i => <div key={i} className="skeleton" style={{ width: 6, height: 6, borderRadius: '50%', animationDelay: `${i * 0.15}s` }} />)}
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div style={{ padding: '0.5rem', borderTop: '1px solid var(--border)', display: 'flex', gap: '0.4rem' }}>
            <input
              className="form-input"
              style={{ flex: 1, fontSize: '0.8rem', padding: '0.4rem 0.6rem' }}
              placeholder="Give a command…"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') send(); }}
            />
            <button className="btn btn-primary" style={{ padding: '0.4rem 0.6rem' }} onClick={send} disabled={!input.trim() || loading}>
              <Send size={13} />
            </button>
          </div>
        </div>
      )}

      {/* Floating trigger button */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          position: 'fixed', bottom: 24, right: 24,
          width: 56, height: 56,
          borderRadius: '50%',
          background: 'var(--purple)',
          border: '2px solid rgba(168,85,247,0.4)',
          boxShadow: '0 4px 20px rgba(168,85,247,0.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer',
          zIndex: 301,
          transition: 'transform 0.2s ease, box-shadow 0.2s ease',
        }}
        onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.08)'; e.currentTarget.style.boxShadow = '0 6px 28px rgba(168,85,247,0.5)'; }}
        onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = '0 4px 20px rgba(168,85,247,0.35)'; }}
        title="Quick command to The Director"
      >
        {open ? <X size={22} color="var(--text)" /> : <MessageCircle size={22} color="var(--text)" />}
      </button>
    </>
  );
}

/* ─── KPI Progress Card ──────────────────────────────────── */

function KpiCard({ onDirectorCommand }) {
  const { request } = useApi();
  const [kpi, setKpi] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadKpi = useCallback(async () => {
    try {
      const res = await request('/dashboard/daily-progress');
      setKpi(res?.data || null);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    loadKpi();
    const iv = setInterval(loadKpi, 5 * 60 * 1000); // refresh every 5 min
    return () => clearInterval(iv);
  }, []);

  if (loading) return <div className="card"><div className="skeleton" style={{ height: 80 }} /></div>;
  if (!kpi) return null;

  const pct = kpi.percentage || 0;
  const met = kpi.kpi_met;
  const barColor = met ? 'var(--lime)' : 'var(--lime)';
  const today = new Date().toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="card fade-in" style={{ marginBottom: '1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Target size={14} style={{ color: 'var(--lime)' }} />
          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Today's KPI
          </span>
        </div>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{today}</span>
      </div>

      {/* Progress bar */}
      <div style={{ marginBottom: '0.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.3rem' }}>
          <span style={{ fontSize: '1.5rem', fontWeight: 700, color: met ? 'var(--lime)' : 'var(--text)' }}>
            {kpi.sent} <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)', fontWeight: 400 }}>/ {kpi.target}</span>
          </span>
          <span style={{ fontSize: '0.85rem', color: met ? 'var(--lime)' : 'var(--text-muted)', fontWeight: 600, alignSelf: 'flex-end', marginBottom: '0.15rem' }}>
            {met ? '✓ KPI met!' : `${pct}%`}
          </span>
        </div>
        <div style={{ height: 6, background: 'var(--bg)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: barColor, borderRadius: 3, transition: 'width 0.6s ease' }} />
        </div>
      </div>

      {/* Channel breakdown */}
      <div style={{ display: 'flex', gap: '1.5rem', marginBottom: met ? 0 : '0.75rem' }}>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>📧 Email: <strong style={{ color: 'var(--text)' }}>{kpi.email}</strong></span>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>💼 LinkedIn: <strong style={{ color: 'var(--text)' }}>{kpi.linkedin}</strong></span>
        {!met && <span style={{ fontSize: '0.72rem', color: 'var(--orange)' }}>Gap: <strong>{kpi.gap}</strong></span>}
      </div>

      {/* CTA button */}
      {!met && kpi.gap > 0 && (
        <button
          className="btn btn-secondary"
          style={{ width: '100%', justifyContent: 'center', gap: '0.5rem', fontSize: '0.8rem', marginTop: '0.25rem' }}
          onClick={() => onDirectorCommand && onDirectorCommand(
            `We need ${kpi.gap} more outreach today to hit our ${kpi.target} target. Find leads and send messages now.`
          )}
        >
          <Zap size={13} /> Ask Director to close the gap →
        </button>
      )}
    </div>
  );
}

/* ─── Weekly Learnings Card ──────────────────────────────── */

function WeeklyLearningsCard() {
  const { request } = useApi();
  const [learnings, setLearnings] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    request('/dashboard/weekly-learnings')
      .then(res => setLearnings(res?.data || null))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="card"><div className="skeleton" style={{ height: 80 }} /></div>;
  if (!learnings) return null;

  const hooks = Array.isArray(learnings.best_hooks) ? learnings.best_hooks : [];
  const weekLabel = learnings.week_start
    ? `${new Date(learnings.week_start).toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${new Date(learnings.week_end).toLocaleDateString([], { month: 'short', day: 'numeric' })}`
    : 'Last week';

  return (
    <div className="card fade-in" style={{ marginBottom: '1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <BookOpen size={14} style={{ color: 'var(--purple)' }} />
        <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Director's Weekly Brief
        </span>
        <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>{weekLabel}</span>
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '0.75rem', padding: '0.5rem 0.75rem', background: 'var(--bg)', borderRadius: 6 }}>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>📊 <strong style={{ color: 'var(--text)' }}>{learnings.total_outreach}</strong> outreach</span>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>↩ <strong style={{ color: 'var(--text)' }}>{learnings.total_replies}</strong> replies</span>
        <span style={{ fontSize: '0.72rem', color: learnings.reply_rate > 5 ? 'var(--lime)' : 'var(--text-muted)' }}>
          <strong>{learnings.reply_rate}%</strong> reply rate
        </span>
      </div>

      {/* Best hooks */}
      {hooks.length > 0 && (
        <div style={{ marginBottom: '0.625rem' }}>
          <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--lime)', marginBottom: '0.35rem' }}>🏆 Best hooks</div>
          {hooks.slice(0, 2).map((h, i) => (
            <div key={i} style={{ fontSize: '0.75rem', color: 'var(--text)', padding: '0.2rem 0', borderBottom: '1px solid var(--border)' }}>
              "{h}"
            </div>
          ))}
        </div>
      )}

      {/* Director notes */}
      {learnings.director_notes && (
        <div>
          <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--purple)', marginBottom: '0.25rem' }}>📝 Director's notes</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{learnings.director_notes}</div>
        </div>
      )}
    </div>
  );
}

/* ─── Analytics Card ─────────────────────────────────────── */

const SENTIMENT_COLORS = { positive: 'var(--lime)', neutral: 'var(--blue)', objection: 'var(--orange)', no_fit: 'var(--text-muted)' };
const SENTIMENT_LABELS = { positive: 'Positive', neutral: 'Neutral', objection: 'Objection', no_fit: 'No Fit' };

function AnalyticsCard() {
  const { request } = useApi();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    request('/dashboard/analytics')
      .then(res => setData(res?.data || null))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <div className="card fade-in" style={{ marginBottom: '1.25rem' }}>
      <div className="skeleton" style={{ height: 120 }} />
    </div>
  );
  if (!data) return null;

  const { funnel, reply_sentiments = {}, weekly_trend = [] } = data;
  const sentimentTotal = Object.values(reply_sentiments).reduce((a, b) => a + b, 0);

  return (
    <div className="card fade-in" style={{ marginBottom: '1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
        <BarChart2 size={14} style={{ color: 'var(--blue)' }} />
        <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Pipeline Analytics
        </span>
      </div>

      {/* Funnel metrics */}
      <div className="analytics-funnel" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem', marginBottom: '1rem' }}>
        {[
          { label: 'Sent', value: funnel.sent, color: 'var(--text)' },
          { label: 'Replies', value: funnel.replies, color: 'var(--blue)' },
          { label: 'Reply Rate', value: `${funnel.reply_rate}%`, color: funnel.reply_rate >= 5 ? 'var(--lime)' : funnel.reply_rate >= 2 ? 'var(--orange)' : 'var(--text-muted)' },
          { label: 'Meetings', value: funnel.meetings_booked, color: 'var(--purple)' },
        ].map(m => (
          <div key={m.label} style={{ background: 'var(--bg)', borderRadius: 6, padding: '0.5rem 0.75rem', textAlign: 'center' }}>
            <div style={{ fontSize: '1.4rem', fontWeight: 700, color: m.color, lineHeight: 1 }}>{m.value}</div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 4 }}>{m.label}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: sentimentTotal > 0 ? '1fr 1fr' : '1fr', gap: '1rem' }}>
        {/* Weekly trend bars */}
        {weekly_trend.length > 0 && (
          <div>
            <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '0.5rem' }}>Weekly Trend</div>
            <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'flex-end', height: 48 }}>
              {weekly_trend.slice(-8).map((w, i) => {
                const maxSent = Math.max(...weekly_trend.map(x => x.sent), 1);
                const h = Math.max(4, Math.round((w.sent / maxSent) * 48));
                const label = new Date(w.week).toLocaleDateString([], { month: 'short', day: 'numeric' });
                return (
                  <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }} title={`${label}: ${w.sent} sent, ${w.replies} replies (${w.reply_rate}%)`}>
                    <div style={{ width: '100%', height: h, background: w.reply_rate >= 5 ? 'var(--lime)' : 'var(--blue)', borderRadius: '2px 2px 0 0', opacity: 0.8 }} />
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: 4 }}>Last 8 weeks · green = 5%+ reply rate</div>
          </div>
        )}

        {/* Reply sentiments */}
        {sentimentTotal > 0 && (
          <div>
            <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '0.5rem' }}>Reply Sentiments</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              {Object.entries(reply_sentiments).map(([s, count]) => (
                <div key={s} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ fontSize: '0.7rem', color: SENTIMENT_COLORS[s] || 'var(--text-muted)', fontWeight: 600, width: 62 }}>{SENTIMENT_LABELS[s] || s}</span>
                  <div style={{ flex: 1, height: 6, background: 'var(--bg)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.round((count / sentimentTotal) * 100)}%`, background: SENTIMENT_COLORS[s] || 'var(--text-muted)', borderRadius: 3 }} />
                  </div>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', width: 20, textAlign: 'right' }}>{count}</span>
                </div>
              ))}
            </div>
          </div>
        )}
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
  const [sentToday, setSentToday] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const [agentLogs, setAgentLogs] = useState({});
  const [liveLogs, setLiveLogs] = useState([]);

  const [error, setError] = useState(null);
  const [briefOpen, setBriefOpen] = useState(false);
  const [directorCommand, setDirectorCommand] = useState(null);

  const loadLogs = useCallback(async () => {
    try {
      const res = await request('/logs?perPage=20');
      const rows = res?.data || [];
      const byAgent = {};
      rows.forEach(log => { if (!byAgent[log.agent]) byAgent[log.agent] = log; });
      setAgentLogs(byAgent);
      setLiveLogs(rows.slice(0, 8));
    } catch (err) { setError('Failed to load data'); }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const [statsRes, kpiRes] = await Promise.all([
        request('/dashboard/stats'),
        request('/dashboard/daily-progress').catch(() => null),
      ]);
      setStats(statsRes?.data || {});
      if (kpiRes?.data) setSentToday(kpiRes.data.sent ?? null);
    } catch (err) { setError('Failed to load data'); }
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
  const totalLeads = Object.values(byStage).reduce((a, b) => a + parseInt(b, 10), 0);
  const sentiments = stats.reply_sentiments || {};
  const sentimentTotal = Object.values(sentiments).reduce((a, b) => a + b, 0);

  // Reply rate (consumed by Pipeline Engine)
  const replyRate30d = stats.reply_rate_30d ?? null;
  const trend = stats.reply_rate_trend;

  // Calendar gate banner
  const calendarConnected = stats.integrations?.google_calendar?.connected || stats.integrations?.calendly?.connected;

  return (
    <div className="fade-in">
      {error && (
        <div style={{ padding: '16px', background: 'rgba(239,68,68,0.1)', borderRadius: 'var(--radius)', color: 'var(--danger)', marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{error}</span>
          <button onClick={() => { setError(null); loadStats(); loadLogs(); }} style={{ background: 'var(--danger)', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 'var(--radius)', cursor: 'pointer' }}>Retry</button>
        </div>
      )}

      <GreetingHeader onBriefOpen={() => setBriefOpen(true)} onRefresh={handleRefresh} refreshing={refreshing} />

      {/* Calendar gate banner */}
      {!statsLoading && !calendarConnected && (
        <div style={{ padding: '0.75rem 1rem', background: 'rgba(255,140,0,0.1)', border: '1px solid rgba(255,140,0,0.3)', borderRadius: 'var(--radius)', marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Calendar size={16} style={{ color: 'var(--orange)', flexShrink: 0 }} />
          <span style={{ fontSize: '0.82rem', color: 'var(--text)' }}>
            Connect <strong>Google Calendar</strong> or <strong>Calendly</strong> in Settings to enable campaign kickoffs.
          </span>
          <button className="btn btn-secondary" style={{ marginLeft: 'auto', fontSize: '0.75rem', padding: '0.3rem 0.75rem', flexShrink: 0 }} onClick={() => navigate('/settings')}>
            Go to Settings →
          </button>
        </div>
      )}

      {/* ── Hero: Crew + Engine + Rail unified composition ── */}
      {(() => {
        const beaverData = {
          sourced_today: stats.sourced_today,
          sourced_this_week: stats.sourced_this_week,
          total_in_pipeline: totalLeads,
          pool_health: stats.pool_health,
          sent_today: sentToday ?? 0,
          sent_this_week: stats.sent_this_week,
          sent_all_time: stats.messages_sent,
          in_flight: stats.in_flight,
          replies_this_week: stats.replies_this_week,
          replies_all_time: stats.leads_replied,
          reply_rate_30d: replyRate30d,
          reply_rate_lifetime: stats.reply_rate_lifetime,
          reviewed_this_week: stats.reviewed_this_week,
          passed_this_week: stats.passed_this_week,
          enforcer_pass_rate: stats.enforcer_pass_rate,
          pending_approvals: stats.pending_approvals,
          meetings_today: stats.meetings_today ?? 0,
          meetings_this_week: stats.meetings_this_week,
          meetings_booked: stats.meetings_booked,
          messages_sent: stats.messages_sent,
        };
        return (
          <div className="dashboard-hero" style={{ marginBottom: '1.25rem' }}>
            <div className="dashboard-hero-crew dashboard-hero-crew-left">
              <BeaverStatsCard variant="research" data={beaverData} />
              <BeaverStatsCard variant="captain" data={beaverData} />
            </div>

            <div className="dashboard-hero-engine">
              <PipelineEngine data={{
                sourced_today: stats.sourced_today,
                total_in_pipeline: totalLeads,
                sent_today: sentToday ?? 0,
                sent_target: 50,
                in_flight: stats.in_flight,
                enforcer_pass_rate: stats.enforcer_pass_rate,
                pending_approvals: stats.pending_approvals,
                meetings_today: stats.meetings_today ?? 0,
                meetings_this_week: stats.meetings_this_week,
                reply_rate_30d: replyRate30d,
                reply_rate_trend: trend,
                meetings_booked: stats.meetings_booked,
                conversion_rate: totalLeads > 0
                  ? +((parseInt(stats.meetings_booked || 0, 10) / totalLeads) * 100).toFixed(1)
                  : 0,
                meetings_next_7d: stats.meetings_next_7d,
              }} />
            </div>

            <div className="dashboard-hero-crew dashboard-hero-crew-right">
              <BeaverStatsCard variant="enforcer" data={beaverData} alignRight />
              <BeaverStatsCard variant="sales" data={beaverData} alignRight />
            </div>

            <div className="dashboard-hero-rail">
              <StageBreakdownRail data={{
                leads_by_stage: byStage,
                total_in_pipeline: totalLeads,
                reply_sentiments: sentiments,
                reply_rate_30d: replyRate30d,
                reply_rate_trend: trend,
                sourced_today: stats.sourced_today,
                in_flight: stats.in_flight,
                replies_this_week: stats.replies_this_week,
                meetings_this_week: stats.meetings_this_week,
              }} />
            </div>
          </div>
        );
      })()}

      {/* ── Action row + supporting cards below the hero ── */}
      <div style={{ display: 'grid', gridTemplateColumns: (stats.awaiting_linkedin > 0) ? 'repeat(2, 1fr)' : 'repeat(1, 1fr)', gap: '0.75rem', marginBottom: '1.25rem' }}>
        {(stats.awaiting_linkedin > 0) && (
          <StatCard
            label="Awaiting LinkedIn"
            value={stats.awaiting_linkedin}
            icon={Clock}
            color="var(--purple)"
            loading={statsLoading}
            onClick={() => navigate('/approvals?tab=awaiting')}
            sub="connection requests"
          />
        )}
        <StatCard
          label="Pool Health"
          value={stats.pool_health ?? 0}
          icon={Users}
          color="var(--blue)"
          loading={statsLoading}
          onClick={() => navigate('/pipeline')}
          sub="leads ready to contact"
        />
      </div>

      <KpiCard onDirectorCommand={(cmd) => setDirectorCommand(cmd)} />

      <div className="card" style={{ marginBottom: '1.25rem' }}>
        <TodaySchedule events={stats.today_events || []} loading={statsLoading} />
      </div>

      <div style={{ marginTop: '1.25rem' }}>
        <IntegrationChips integrations={stats.integrations} loading={statsLoading} />
      </div>

      <MorningBriefModal open={briefOpen} onClose={() => setBriefOpen(false)} />
      <DirectorBubble prefilledCommand={directorCommand} onCommandUsed={() => setDirectorCommand(null)} />
    </div>
  );
}
