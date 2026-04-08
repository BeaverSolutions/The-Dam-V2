import React, { useState, useEffect, useRef } from 'react';
import BeaverAvatar, { BEAVER_COLORS, BEAVER_LABELS } from './BeaverAvatar';
import { Zap } from 'lucide-react';

/* ─── Beaver definitions ──────────────────────────────────── */

const BEAVERS = [
  {
    key: 'research',
    agentKey: 'research_beaver',
    label: 'Research Beaver',
    color: 'var(--blue)',
    colorRaw: '#00B4FF',
    idleTask: 'Waiting for next campaign...',
    weekKeys:     ['found', 'passed', 'rejected'],
    weekTitles:   ['Found', 'Passed', 'Rejected'],
    weekFormats:  ['num', 'num', 'num'],
    lifetimeKeys:    ['total', 'quality_rate', 'best_source'],
    lifetimeTitles:  ['Total', 'Quality', 'Best Source'],
    lifetimeFormats: ['num', 'pct', 'str'],
  },
  {
    key: 'sales',
    agentKey: 'sales_beaver',
    label: 'Sales Beaver',
    color: 'var(--orange)',
    colorRaw: '#FF8C00',
    idleTask: 'Waiting for Research Beaver...',
    weekKeys:     ['drafted', 'approved', 'failed'],
    weekTitles:   ['Drafted', 'Approved', 'Failed'],
    weekFormats:  ['num', 'num', 'num'],
    lifetimeKeys:    ['total', 'pass_rate', 'best_channel'],
    lifetimeTitles:  ['Total', 'Pass Rate', 'Best Channel'],
    lifetimeFormats: ['num', 'pct', 'str'],
  },
  {
    key: 'enforcer',
    agentKey: 'ranger',
    label: 'Enforcer Beaver',
    color: 'var(--police-blue)',
    colorRaw: '#2563EB',
    idleTask: 'All messages cleared...',
    weekKeys:     ['reviewed', 'rejected', 'rewrite_rate'],
    weekTitles:   ['Reviewed', 'Rejected', 'Rewrite %'],
    weekFormats:  ['num', 'num', 'pct'],
    lifetimeKeys:    ['total', 'avg_score', 'top_rejection'],
    lifetimeTitles:  ['Total', 'Avg Score', 'Top Rejection'],
    lifetimeFormats: ['num', 'score', 'str'],
  },
  {
    key: 'captain',
    agentKey: 'director',
    label: 'Captain Beaver',
    color: 'var(--purple)',
    colorRaw: '#A855F7',
    idleTask: 'Standing by...',
    weekKeys:     ['sent', 'replies', 'reply_rate', 'meetings'],
    weekTitles:   ['Sent', 'Replies', 'Reply %', 'Meets'],
    weekFormats:  ['num', 'num', 'pct', 'num'],
    lifetimeKeys:    ['total_sent', 'total_meetings', 'best_hook'],
    lifetimeTitles:  ['Total Sent', 'Meetings', 'Best Hook'],
    lifetimeFormats: ['num', 'num', 'str'],
  },
];

/* ─── Helpers ─────────────────────────────────────────────── */

function formatVal(val, fmt) {
  if (val === undefined || val === null) return '—';
  if (fmt === 'pct') return `${val}%`;
  if (fmt === 'score') return `${val}/100`;
  return String(val);
}

function sinceSeconds(ts) {
  return (Date.now() - new Date(ts).getTime()) / 1000;
}

function agentState(lastLog) {
  if (!lastLog) return 'standby';
  if (lastLog.action?.includes('error') || lastLog.action?.includes('failed')) return 'alert';
  const secs = sinceSeconds(lastLog.created_at);
  if (secs < 30)  return 'working';
  if (secs < 300) return 'idle';
  return 'standby';
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* ─── Sub-components ──────────────────────────────────────── */

function SkeletonBar({ width = '60%' }) {
  return (
    <div style={{
      width, height: 10, borderRadius: 4,
      background: 'rgba(255,255,255,0.06)',
      animation: 'bsbPulse 1.5s ease-in-out infinite',
    }} />
  );
}

function StatusDot({ state, colorRaw }) {
  const colors = {
    working: colorRaw,
    idle:    colorRaw,
    alert:   '#FF8C00',
    standby: 'rgba(255,255,255,0.2)',
  };
  const c = colors[state] || colors.standby;
  const isLive = state === 'working';

  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 10, height: 10, flexShrink: 0 }}>
      {isLive && (
        <span style={{
          position: 'absolute', width: 10, height: 10, borderRadius: '50%',
          background: c, opacity: 0.45,
          animation: 'bsbRing 1.4s ease-out infinite',
        }} />
      )}
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: c, transition: 'background 0.3s' }} />
    </span>
  );
}

function BeaverCard({ beaver, execBeaverStatus, lastLog, kpis, loading }) {
  // Determine state: exec pipeline status takes priority, then log-based
  const execState = execBeaverStatus?.status; // 'working' | 'done' | 'idle' | undefined
  const logState  = agentState(lastLog);
  const isWorking = execState === 'working' || (execState === undefined && logState === 'working');
  const state     = isWorking ? 'working' : (execState === 'done' ? 'idle' : logState);

  const execTask  = execBeaverStatus?.task;
  const logTask   = lastLog?.action?.replace(/_/g, ' ');
  const task      = execTask || logTask || beaver.idleTask;

  const data         = kpis?.[beaver.key];
  const weekData     = data?.week;
  const lifetimeData = data?.lifetime;

  // Fade task text on change
  const [taskVisible, setTaskVisible] = useState(true);
  const prevTask = useRef(task);
  useEffect(() => {
    if (prevTask.current !== task) {
      setTaskVisible(false);
      const t = setTimeout(() => { setTaskVisible(true); prevTask.current = task; }, 180);
      return () => clearTimeout(t);
    }
  }, [task]);

  const glowShadow = isWorking
    ? `0 0 0 1px ${beaver.colorRaw}55, 0 0 20px ${beaver.colorRaw}18`
    : 'none';

  return (
    <div style={{
      background: 'var(--panel)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderTop: `2px solid ${isWorking ? beaver.colorRaw : 'rgba(255,255,255,0.06)'}`,
      borderRadius: 'var(--radius)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      boxShadow: glowShadow,
      transition: 'box-shadow 0.3s ease, border-top-color 0.3s ease',
      minWidth: 0,
    }}>

      {/* ── Header: avatar + name + status ── */}
      <div style={{ padding: '0.875rem 0.875rem 0.625rem', display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
        <div style={{ flexShrink: 0 }}>
          <BeaverAvatar
            agent={beaver.agentKey}
            size="sm"
            animate
            state={isWorking ? 'working' : undefined}
          />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: '0.78rem', fontWeight: 700, color: beaver.color, lineHeight: 1.2 }}>
            {beaver.label}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', marginTop: '0.2rem' }}>
            <StatusDot state={state} colorRaw={beaver.colorRaw} />
            <span style={{ fontSize: '0.62rem', color: 'var(--text-muted)', textTransform: 'capitalize' }}>
              {state === 'standby' ? 'Standby' : state.charAt(0).toUpperCase() + state.slice(1)}
            </span>
          </div>
          <div style={{
            fontSize: '0.65rem',
            color: isWorking ? 'var(--text)' : 'var(--text-muted)',
            fontStyle: 'italic',
            marginTop: '0.2rem',
            opacity: taskVisible ? 1 : 0,
            transition: 'opacity 0.18s ease',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {task}
          </div>
        </div>
      </div>

      {/* ── This Week ── */}
      <div style={{ padding: '0.5rem 0.875rem', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
        <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.4rem' }}>
          This Week
        </div>
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}><SkeletonBar width="80%" /><SkeletonBar width="55%" /></div>
        ) : (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {beaver.weekKeys.map((k, i) => (
              <div key={k}>
                <div style={{ fontSize: '1.05rem', fontWeight: 700, color: beaver.color, lineHeight: 1 }}>
                  {formatVal(weekData?.[k], beaver.weekFormats[i])}
                </div>
                <div style={{ fontSize: '0.58rem', color: 'var(--text-muted)', marginTop: 1 }}>
                  {beaver.weekTitles[i]}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Lifetime ── */}
      <div style={{ padding: '0.5rem 0.875rem 0.875rem', borderTop: '1px solid rgba(255,255,255,0.05)', flex: 1 }}>
        <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.4rem' }}>
          Lifetime
        </div>
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}><SkeletonBar width="70%" /><SkeletonBar width="50%" /></div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.18rem' }}>
            {beaver.lifetimeKeys.map((k, i) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.4rem' }}>
                <span style={{ fontSize: '0.63rem', color: 'var(--text-muted)', flexShrink: 0 }}>{beaver.lifetimeTitles[i]}</span>
                <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text)', textAlign: 'right', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '55%' }}>
                  {formatVal(lifetimeData?.[k], beaver.lifetimeFormats[i])}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function LiveFeed({ logs }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{
        fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.08em',
        marginBottom: '0.5rem',
        display: 'flex', alignItems: 'center', gap: '0.35rem',
      }}>
        <Zap size={9} style={{ color: 'var(--lime)', flexShrink: 0 }} /> Live Feed
      </div>
      {logs.length === 0 ? (
        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>No activity yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', overflowY: 'auto', maxHeight: 220 }}>
          {logs.map(log => (
            <div key={log.id} style={{ display: 'flex', gap: '0.45rem', alignItems: 'flex-start' }}>
              <div style={{
                width: 6, height: 6, borderRadius: '50%', flexShrink: 0, marginTop: 4,
                background: BEAVER_COLORS[log.agent] || 'var(--text-muted)',
              }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '0.7rem', lineHeight: 1.3, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {log.action.replace(/_/g, ' ')}
                </div>
                <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>
                  {BEAVER_LABELS[log.agent] || log.agent} · {formatTime(log.created_at)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Main export ─────────────────────────────────────────── */

export default function BeaverStatusBoard({ execStatus, kpis: kpisProp, agentLogs = {}, liveLogs = [] }) {
  const [kpis, setKpis]           = useState(kpisProp || null);
  const [kpisLoading, setLoading] = useState(!kpisProp);
  const intervalRef = useRef(null);

  const fetchKpis = async () => {
    try {
      const res = await fetch('/api/agents/kpis', { credentials: 'include' });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) return;
      const data = await res.json();
      if (data?.data) setKpis(data.data);
    } catch { /* silent */ } finally { setLoading(false); }
  };

  useEffect(() => {
    fetchKpis();
    intervalRef.current = setInterval(fetchKpis, 60000);
    return () => clearInterval(intervalRef.current);
  }, []);

  useEffect(() => {
    if (kpisProp) { setKpis(kpisProp); setLoading(false); }
  }, [kpisProp]);

  const execBeavers = execStatus?.beavers || {};
  const hasLiveFeed = liveLogs.length > 0;

  return (
    <>
      <style>{`
        @keyframes bsbRing {
          0%   { transform: scale(1);   opacity: 0.5; }
          70%  { transform: scale(2.4); opacity: 0;   }
          100% { transform: scale(2.4); opacity: 0;   }
        }
        @keyframes bsbPulse {
          0%, 100% { opacity: 0.4; }
          50%       { opacity: 0.8; }
        }
        .bsb-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 0.75rem;
        }
        .bsb-wrap {
          display: grid;
          grid-template-columns: 1fr;
          gap: 0.75rem;
          margin-bottom: 1.25rem;
        }
        @media (min-width: 900px) {
          .bsb-wrap {
            grid-template-columns: 1fr 220px;
          }
        }
        @media (max-width: 768px) {
          .bsb-grid { grid-template-columns: repeat(2, 1fr); }
        }
        @media (max-width: 420px) {
          .bsb-grid { grid-template-columns: 1fr; }
        }
      `}</style>

      <div className="bsb-wrap">
        {/* 4 beaver cards */}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{
            fontSize: '0.6rem', fontWeight: 700, color: 'var(--text-muted)',
            textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.5rem',
            flexShrink: 0,
          }}>
            Crew Status
          </div>
          <div className="bsb-grid" style={{ flex: 1 }}>
            {BEAVERS.map(beaver => (
              <BeaverCard
                key={beaver.key}
                beaver={beaver}
                execBeaverStatus={execBeavers[beaver.key] || null}
                lastLog={agentLogs[beaver.agentKey] || null}
                kpis={kpis}
                loading={kpisLoading}
              />
            ))}
          </div>
        </div>

        {/* Live feed panel — invisible spacer matches label height so card aligns with cards */}
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{
            fontSize: '0.6rem', fontWeight: 700, marginBottom: '0.5rem',
            flexShrink: 0, visibility: 'hidden', userSelect: 'none',
          }}>
            Crew Status
          </div>
          <div className="card" style={{ padding: '0.875rem', display: 'flex', flexDirection: 'column', flex: 1 }}>
            <LiveFeed logs={liveLogs} />
          </div>
        </div>
      </div>
    </>
  );
}
