import React from 'react';
import './BeaverStatsCard.css';

/**
 * One beaver stat card. Renders portrait + name + status + role line,
 * a "THIS WEEK" stat row, and a "LIFETIME" stat row. Lives in the
 * grid around the Pipeline Engine.
 *
 * props:
 *   variant: 'research' | 'sales' | 'enforcer' | 'captain'
 *   data: { ...same shape as Dashboard passes to engine + crew }
 *   alignRight: boolean — if true, content right-aligns (for cards
 *   that sit on the right of the engine)
 */

const BEAVER_CONFIG = {
  research: {
    name: 'Research Beaver',
    role: 'sourcing intel',
    img: '/assets/beavers/research-beaver.png',
    color: '#00B4FF',
    weekStats: (d) => [
      { k: 'Found',  v: d.sourced_this_week },
      { k: 'In pool', v: d.pool_health },
      { k: 'Pipeline', v: d.total_in_pipeline },
    ],
    lifetimeStats: (d) => [
      { k: 'Total leads', v: d.total_in_pipeline },
      { k: 'Quality',     v: '—' },
      { k: 'Best source', v: '—' },
    ],
  },
  captain: {
    name: 'Captain Beaver',
    role: 'orchestrating crew',
    img: '/assets/beavers/director-beaver.png',
    color: '#A855F7',
    weekStats: (d) => [
      { k: 'Sent',    v: d.sent_this_week },
      { k: 'Replies', v: d.replies_this_week },
      { k: 'Meets',   v: d.meetings_this_week },
    ],
    lifetimeStats: (d) => [
      { k: 'Total sent', v: d.sent_all_time ?? d.messages_sent },
      { k: 'Meetings',   v: d.meetings_booked },
      { k: 'Best hook',  v: d.best_hook ? `"${truncate(d.best_hook, 16)}"` : '—' },
    ],
  },
  enforcer: {
    name: 'Enforcer Beaver',
    role: 'guarding quality',
    img: '/assets/beavers/ranger-beaver.png',
    color: '#2563EB',
    weekStats: (d) => {
      const reviewed = d.reviewed_this_week ?? 0;
      const passed = d.passed_this_week ?? 0;
      const rejected = Math.max(0, reviewed - passed);
      const rewritePct = reviewed > 0 ? Math.round((rejected / reviewed) * 100) : null;
      return [
        { k: 'Reviewed', v: reviewed },
        { k: 'Rejected', v: rejected },
        { k: 'Rewrite %', v: rewritePct != null ? `${rewritePct}%` : '—' },
      ];
    },
    lifetimeStats: (d) => [
      { k: 'Pass rate (7d)', v: d.enforcer_pass_rate != null ? `${d.enforcer_pass_rate}%` : '—' },
      { k: 'Pending',         v: d.pending_approvals },
      { k: 'Top rejection',   v: '—' },
    ],
  },
  sales: {
    name: 'Sales Beaver',
    role: 'drafting outreach',
    img: '/assets/beavers/sales-beaver.png',
    color: '#FF8C00',
    weekStats: (d) => [
      { k: 'Sent',     v: d.sent_this_week },
      { k: 'In flight', v: d.in_flight },
      { k: 'Replies',  v: d.replies_this_week },
    ],
    lifetimeStats: (d) => [
      { k: 'Total sent',  v: d.sent_all_time ?? d.messages_sent },
      { k: 'Reply rate',  v: d.reply_rate_lifetime != null ? `${d.reply_rate_lifetime}%` : '—' },
      { k: 'Best channel', v: '—' },
    ],
  },
};

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function fmt(v) {
  if (v == null || v === '' || Number.isNaN(v)) return '—';
  if (typeof v === 'number') return v.toLocaleString();
  return v;
}

export default function BeaverStatsCard({ variant, data = {}, alignRight = false }) {
  const cfg = BEAVER_CONFIG[variant];
  if (!cfg) return null;

  return (
    <div
      className={`beaver-stats-card ${alignRight ? 'align-right' : ''}`}
      style={{ '--accent': cfg.color }}
    >
      <div className="bsc-head">
        <img src={cfg.img} alt={cfg.name} className="bsc-img" />
        <div className="bsc-meta">
          <div className="bsc-name" style={{ color: cfg.color }}>{cfg.name}</div>
          <div className="bsc-status">
            <span className="bsc-dot"></span>Standby
          </div>
          <div className="bsc-role">{cfg.role}</div>
        </div>
      </div>

      <div className="bsc-section">
        <div className="bsc-section-label">This Week</div>
        <div className="bsc-stats-row">
          {cfg.weekStats(data).map((s, i) => (
            <div key={i} className="bsc-stat">
              <div className="bsc-stat-v">{fmt(s.v)}</div>
              <div className="bsc-stat-k">{s.k}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="bsc-section bsc-lifetime">
        <div className="bsc-section-label">Lifetime</div>
        <div className="bsc-lifetime-rows">
          {cfg.lifetimeStats(data).map((s, i) => (
            <div key={i} className="bsc-lifetime-row">
              <span className="bsc-lifetime-k">{s.k}</span>
              <span className="bsc-lifetime-v">{fmt(s.v)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
