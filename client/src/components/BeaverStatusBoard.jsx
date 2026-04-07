import React, { useState, useEffect, useRef } from 'react';

const BEAVERS = [
  {
    key: 'research',
    label: 'Research Beaver',
    color: 'var(--blue)',
    colorRaw: '#00B4FF',
    idleTask: 'Waiting for next campaign...',
    weekLabels: ['found', 'passed', 'rejected'],
    weekKeys: ['found', 'passed', 'rejected'],
    weekTitles: ['Found', 'Passed', 'Rejected'],
    lifetimeKeys: ['total', 'quality_rate', 'best_source'],
    lifetimeTitles: ['Total', 'Quality', 'Best Source'],
    lifetimeFormats: ['num', 'pct', 'str'],
  },
  {
    key: 'sales',
    label: 'Sales Beaver',
    color: 'var(--orange)',
    colorRaw: '#FF8C00',
    idleTask: 'Waiting for Research Beaver...',
    weekKeys: ['drafted', 'approved', 'failed'],
    weekTitles: ['Drafted', 'Approved', 'Failed'],
    lifetimeKeys: ['total', 'pass_rate', 'best_channel'],
    lifetimeTitles: ['Total', 'Pass Rate', 'Best Channel'],
    lifetimeFormats: ['num', 'pct', 'str'],
  },
  {
    key: 'enforcer',
    label: 'Enforcer Beaver',
    color: 'var(--police-blue)',
    colorRaw: '#2563EB',
    idleTask: 'All messages cleared...',
    weekKeys: ['reviewed', 'rejected', 'rewrite_rate'],
    weekTitles: ['Reviewed', 'Rejected', 'Rewrite %'],
    weekFormats: ['num', 'num', 'pct'],
    lifetimeKeys: ['total', 'avg_score', 'top_rejection'],
    lifetimeTitles: ['Total', 'Avg Score', 'Top Rejection'],
    lifetimeFormats: ['num', 'score', 'str'],
  },
  {
    key: 'captain',
    label: 'Captain Beaver',
    color: 'var(--purple)',
    colorRaw: '#A855F7',
    idleTask: 'Standing by...',
    weekKeys: ['sent', 'replies', 'reply_rate', 'meetings'],
    weekTitles: ['Sent', 'Replies', 'Reply %', 'Meetings'],
    weekFormats: ['num', 'num', 'pct', 'num'],
    lifetimeKeys: ['total_sent', 'total_meetings', 'best_hook'],
    lifetimeTitles: ['Total Sent', 'Meetings', 'Best Hook'],
    lifetimeFormats: ['num', 'num', 'str'],
  },
];

function formatVal(val, fmt) {
  if (val === undefined || val === null) return '—';
  if (fmt === 'pct') return `${val}%`;
  if (fmt === 'score') return `${val}/100`;
  if (fmt === 'str') return String(val);
  return String(val);
}

function SkeletonBar({ width = '60%', height = 12 }) {
  return (
    <div style={{
      width,
      height,
      borderRadius: 4,
      background: 'rgba(255,255,255,0.06)',
      animation: 'pulse 1.5s ease-in-out infinite',
    }} />
  );
}

function PulsingDot({ color }) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 10, height: 10 }}>
      <span style={{
        position: 'absolute',
        width: 10,
        height: 10,
        borderRadius: '50%',
        background: color,
        opacity: 0.4,
        animation: 'beaverPulseRing 1.4s ease-out infinite',
      }} />
      <span style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
      }} />
    </span>
  );
}

function BeaverCard({ beaver, beaverStatus, kpis, kpisLoading }) {
  const isWorking = beaverStatus?.status === 'working';
  const isDone = beaverStatus?.status === 'done';
  const task = beaverStatus?.task || beaver.idleTask;
  const data = kpis?.[beaver.key];
  const weekData = data?.week;
  const lifetimeData = data?.lifetime;

  const [taskVisible, setTaskVisible] = useState(true);
  const prevTaskRef = useRef(task);

  useEffect(() => {
    if (prevTaskRef.current !== task) {
      setTaskVisible(false);
      const t = setTimeout(() => {
        setTaskVisible(true);
        prevTaskRef.current = task;
      }, 200);
      return () => clearTimeout(t);
    }
  }, [task]);

  const borderColor = isWorking
    ? beaver.colorRaw
    : isDone
      ? `${beaver.colorRaw}55`
      : 'rgba(255,255,255,0.08)';

  const glowShadow = isWorking
    ? `0 0 0 1px ${beaver.colorRaw}44, 0 0 16px ${beaver.colorRaw}22`
    : 'none';

  return (
    <div style={{
      background: 'var(--panel)',
      border: `1px solid ${borderColor}`,
      borderRadius: 'var(--radius)',
      padding: '1rem',
      display: 'flex',
      flexDirection: 'column',
      gap: '0.625rem',
      boxShadow: glowShadow,
      transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
      minWidth: 0,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {isWorking && <PulsingDot color={beaver.colorRaw} />}
        {!isWorking && (
          <span style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: isDone ? beaver.colorRaw : 'rgba(255,255,255,0.2)',
            flexShrink: 0,
            transition: 'background 0.3s ease',
          }} />
        )}
        <span style={{
          fontSize: '0.8rem',
          fontWeight: 700,
          color: beaver.color,
          letterSpacing: '0.01em',
        }}>
          {beaver.label}
        </span>
      </div>

      {/* Current task */}
      <div style={{
        fontSize: '0.72rem',
        fontStyle: 'italic',
        color: isWorking ? 'var(--text)' : 'var(--text-muted)',
        opacity: taskVisible ? 1 : 0,
        transition: 'opacity 0.2s ease',
        lineHeight: 1.4,
        minHeight: '2.4em',
      }}>
        {task}
      </div>

      {/* Divider */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '0.5rem' }}>
        <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.375rem' }}>
          This Week
        </div>
        {kpisLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            <SkeletonBar width="80%" />
            <SkeletonBar width="55%" />
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            {beaver.weekKeys.map((k, i) => {
              const fmt = beaver.weekFormats?.[i] || 'num';
              return (
                <div key={k} style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '1rem', fontWeight: 700, color: beaver.color, lineHeight: 1 }}>
                    {formatVal(weekData?.[k], fmt)}
                  </div>
                  <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: 2 }}>
                    {beaver.weekTitles[i]}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Lifetime */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '0.5rem' }}>
        <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.375rem' }}>
          Lifetime
        </div>
        {kpisLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            <SkeletonBar width="70%" />
            <SkeletonBar width="45%" />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
            {beaver.lifetimeKeys.map((k, i) => {
              const fmt = beaver.lifetimeFormats[i];
              const val = lifetimeData?.[k];
              return (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.5rem' }}>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{beaver.lifetimeTitles[i]}</span>
                  <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text)', textAlign: 'right', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '55%' }}>
                    {formatVal(val, fmt)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function BeaverStatusBoard({ execStatus, kpis: kpisProp }) {
  const [kpis, setKpis] = useState(kpisProp || null);
  const [kpisLoading, setKpisLoading] = useState(!kpisProp);
  const intervalRef = useRef(null);

  const fetchKpis = async () => {
    try {
      const res = await fetch('/api/agents/kpis', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      if (data?.data) setKpis(data.data);
    } catch {
      // silently ignore — board still renders with skeleton
    } finally {
      setKpisLoading(false);
    }
  };

  useEffect(() => {
    fetchKpis();
    intervalRef.current = setInterval(fetchKpis, 60000);
    return () => clearInterval(intervalRef.current);
  }, []);

  // If kpisProp is provided externally and changes, sync it
  useEffect(() => {
    if (kpisProp) {
      setKpis(kpisProp);
      setKpisLoading(false);
    }
  }, [kpisProp]);

  const beavers = execStatus?.beavers || {};

  return (
    <>
      <style>{`
        @keyframes beaverPulseRing {
          0%   { transform: scale(1);   opacity: 0.5; }
          70%  { transform: scale(2.2); opacity: 0; }
          100% { transform: scale(2.2); opacity: 0; }
        }
        @keyframes pulse {
          0%, 100% { opacity: 0.4; }
          50%       { opacity: 0.8; }
        }
        .beaver-board-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 0.75rem;
        }
        @media (max-width: 768px) {
          .beaver-board-grid {
            grid-template-columns: repeat(2, 1fr);
          }
        }
        @media (max-width: 400px) {
          .beaver-board-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
      <div style={{ marginBottom: '1.5rem' }}>
        <div style={{
          fontSize: '0.65rem',
          fontWeight: 700,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          marginBottom: '0.5rem',
        }}>
          Crew Status
        </div>
        <div className="beaver-board-grid">
          {BEAVERS.map(beaver => (
            <BeaverCard
              key={beaver.key}
              beaver={beaver}
              beaverStatus={beavers[beaver.key] || null}
              kpis={kpis}
              kpisLoading={kpisLoading}
            />
          ))}
        </div>
      </div>
    </>
  );
}
