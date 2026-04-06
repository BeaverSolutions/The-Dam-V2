import React, { useEffect, useState, useRef } from 'react';
import { useApi } from '../hooks/useApi';
import BeaverAvatar, { BEAVER_COLORS, BEAVER_LABELS } from '../components/BeaverAvatar';

const AGENTS = ['research_beaver', 'sales_beaver', 'ranger', 'director'];

// Workstation positions: [col, row] in 2x2 grid (0-indexed)
const WORKSTATION_POSITIONS = {
  research_beaver: [0, 0],
  sales_beaver: [1, 0],
  ranger: [0, 1],
  director: [1, 1],
};

// Pipeline flow: which agents hand off to which
const INTERACTIONS = [
  { from: 'research_beaver', to: 'sales_beaver' },
  { from: 'sales_beaver', to: 'ranger' },
  { from: 'ranger', to: 'director' },
];

function getAgentState(lastLog) {
  if (!lastLog) return 'inactive';
  const age = Date.now() - new Date(lastLog.created_at).getTime();
  if (lastLog.action?.includes('error')) return 'alert';
  if (age < 3 * 60 * 1000) return 'working';   // active in last 3 min = working
  if (age < 30 * 60 * 1000) return 'idle';      // active in last 30 min = idle
  return 'inactive';
}

function getAnimateState(agentState) {
  if (agentState === 'working') return 'working';
  if (agentState === 'idle') return '';
  return '';
}

function StatusDot({ state }) {
  const colors = {
    working: 'var(--lime)',
    idle: 'var(--blue)',
    alert: 'var(--orange)',
    inactive: 'var(--text-muted)',
  };
  return (
    <div style={{
      width: 8, height: 8, borderRadius: '50%',
      background: colors[state] || 'var(--text-muted)',
      boxShadow: state === 'working' ? `0 0 6px ${colors.working}` : 'none',
    }} />
  );
}

function ActivityBubble({ log }) {
  if (!log) return <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>No recent activity</div>;
  return (
    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
      {(log.action || '').replace(/_/g, ' ')}
    </div>
  );
}

function Workstation({ agent, lastLog }) {
  const agentState = getAgentState(lastLog);
  const animate = agentState === 'working' || agentState === 'idle';
  const animState = getAnimateState(agentState);
  const color = BEAVER_COLORS[agent];
  const label = BEAVER_LABELS[agent];
  const inactive = agentState === 'inactive';

  return (
    <div style={{
      background: 'var(--panel)',
      border: `1px solid ${agentState === 'working' ? color + '40' : 'var(--border)'}`,
      borderRadius: 'var(--radius)',
      padding: '1.25rem',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '0.75rem',
      opacity: inactive ? 0.5 : 1,
      transition: 'all 0.3s ease',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Subtle background glow when working */}
      {agentState === 'working' && (
        <div style={{
          position: 'absolute', inset: 0, borderRadius: 'var(--radius)',
          background: `radial-gradient(ellipse at center, ${color}08 0%, transparent 70%)`,
          pointerEvents: 'none',
        }} />
      )}

      {/* Monitor display */}
      <div style={{
        width: '100%', background: 'var(--bg)', borderRadius: 6,
        padding: '0.5rem 0.75rem', border: '1px solid var(--border)',
        minHeight: 40, display: 'flex', alignItems: 'center',
      }}>
        <ActivityBubble log={lastLog} />
      </div>

      {/* Beaver avatar */}
      <BeaverAvatar
        agent={agent}
        size="lg"
        animate={animate}
        state={agentState === 'alert' ? 'alert' : 'idle'}
      />

      {/* Nameplate */}
      <div style={{ textAlign: 'center', width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', marginBottom: '0.2rem' }}>
          <StatusDot state={agentState} />
          <span style={{ fontWeight: 600, fontSize: '0.875rem', color }}>{label}</span>
        </div>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'capitalize' }}>
          {agentState === 'working' ? (lastLog?.action?.replace(/_/g, ' ') || 'Working...') : agentState === 'alert' ? 'Needs attention' : agentState === 'idle' ? 'Idle' : 'Standby'}
        </div>
      </div>
    </div>
  );
}

function InteractionLines({ active }) {
  // SVG drawn over the 2x2 grid. Grid cell centers (relative coords, 0–1 each axis)
  // Cell centers at 25% and 75% of each axis
  const centers = {
    research_beaver: { cx: 0.25, cy: 0.25 },
    sales_beaver: { cx: 0.75, cy: 0.25 },
    ranger: { cx: 0.25, cy: 0.75 },
    director: { cx: 0.75, cy: 0.75 },
  };

  return (
    <svg
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      <defs>
        {INTERACTIONS.map(({ from, to }) => (
          <marker
            key={`arrow-${from}-${to}`}
            id={`arrow-${from}`}
            markerWidth="4" markerHeight="4"
            refX="2" refY="2"
            orient="auto"
          >
            <path d="M0,0 L0,4 L4,2 z" fill={BEAVER_COLORS[from]} opacity="0.6" />
          </marker>
        ))}
      </defs>

      {INTERACTIONS.map(({ from, to }) => {
        const f = centers[from];
        const t = centers[to];
        const color = BEAVER_COLORS[from];
        return (
          <line
            key={`${from}-${to}`}
            x1={f.cx * 100}
            y1={f.cy * 100}
            x2={t.cx * 100}
            y2={t.cy * 100}
            stroke={color}
            strokeWidth="0.4"
            strokeDasharray="2 2"
            opacity="0.35"
            markerEnd={`url(#arrow-${from})`}
          />
        );
      })}

      {/* Animated traveling dots */}
      {INTERACTIONS.map(({ from, to }) => {
        const f = centers[from];
        const t = centers[to];
        const color = BEAVER_COLORS[from];
        const dur = `${3 + AGENTS.indexOf(from)}s`;
        return (
          <circle key={`dot-${from}`} r="0.8" fill={color} opacity="0.7">
            <animateMotion dur={dur} repeatCount="indefinite" calcMode="linear">
              <mpath>
                <path d={`M${f.cx * 100},${f.cy * 100} L${t.cx * 100},${t.cy * 100}`} />
              </mpath>
            </animateMotion>
          </circle>
        );
      })}
    </svg>
  );
}

function formatFeedTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function Office() {
  const { request } = useApi();
  const [logs, setLogs] = useState([]);
  const feedRef = useRef(null);

  const fetchLogs = async () => {
    try {
      const res = await request('/logs?perPage=20');
      setLogs(res?.data || []);
    } catch {}
  };

  useEffect(() => {
    fetchLogs();
    let interval = setInterval(fetchLogs, 5000);

    // Pause polling when tab is backgrounded — saves battery and server load
    const handleVisibility = () => {
      clearInterval(interval);
      if (!document.hidden) {
        fetchLogs();
        interval = setInterval(fetchLogs, 5000);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  // Get most recent log per agent
  const lastLogByAgent = {};
  for (const agent of AGENTS) {
    lastLogByAgent[agent] = logs.find(l => l.agent === agent) || null;
  }

  return (
    <div className="fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">The Office</h1>
          <p className="page-subtitle">Live view of the whole dam crew</p>
        </div>
      </div>

      {/* 2×2 workstation grid with SVG overlay */}
      <div style={{ position: 'relative', marginBottom: '1.5rem' }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '1rem',
        }}>
          {AGENTS.map(agent => (
            <Workstation key={agent} agent={agent} lastLog={lastLogByAgent[agent]} />
          ))}
        </div>

        {/* Interaction lines overlay — sits inside grid container */}
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <InteractionLines />
        </div>
      </div>

      {/* Activity feed */}
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--lime)', boxShadow: '0 0 6px var(--lime)' }} />
          Live Activity Feed
          <span style={{ marginLeft: 'auto', fontSize: '0.7rem', color: 'var(--text-muted)' }}>Auto-refreshes every 10s</span>
        </div>
        <div ref={feedRef} style={{ maxHeight: 280, overflowY: 'auto' }}>
          {logs.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
              No activity yet. Start a campaign from Director Chat.
            </div>
          ) : (
            logs.map(log => (
              <div
                key={log.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.75rem',
                  padding: '0.625rem 1rem', borderBottom: '1px solid var(--border)',
                }}
              >
                <BeaverAvatar agent={log.agent} size="xs" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ color: BEAVER_COLORS[log.agent] || 'var(--text-muted)', fontSize: '0.8rem', fontWeight: 500 }}>
                    {BEAVER_LABELS[log.agent] || log.agent}
                  </span>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}> · {(log.action || '').replace(/_/g, ' ')}</span>
                  {log.target_type && <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}> · {log.target_type}</span>}
                </div>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', flexShrink: 0 }}>
                  {formatFeedTime(log.created_at)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <style>{`
        @media (max-width: 768px) {
          .office-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}
