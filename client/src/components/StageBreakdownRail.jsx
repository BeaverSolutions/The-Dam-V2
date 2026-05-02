import React, { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import './StageBreakdownRail.css';

/**
 * StageBreakdownRail — right-side rail.
 *  - Stage Breakdown: pipeline progress bars (Prospecting → Booked)
 *  - Stage Health: Sourcing / In-flight / Replies / Meetings counts
 *  - Reply Breakdown: donut + sentiment legend (last 30d)
 *  - Captain's Weekly Strategy: hook of the week + reply rate trend +
 *    Director's notes — fetched from /dashboard/weekly-learnings
 */

const STAGES = [
  { key: 'prospecting', label: 'Prospecting', color: '#00B4FF' },
  { key: 'outreach',    label: 'Outreach',    color: '#FF8C00' },
  { key: 'qualifying',  label: 'Qualifying',  color: '#A855F7' },
  { key: 'booked',      label: 'Booked',      color: '#C8FF00' },
];

const SENTIMENT_META = [
  { key: 'positive',  label: 'Positive',  color: '#C8FF00' },
  { key: 'neutral',   label: 'Neutral',   color: '#00B4FF' },
  { key: 'objection', label: 'Objection', color: '#FF8C00' },
  { key: 'no_fit',    label: 'No Fit',    color: '#94A3B8' },
];

function ReplyDonut({ sentiments }) {
  const total = SENTIMENT_META.reduce((sum, s) => sum + (sentiments?.[s.key] || 0), 0);
  if (total === 0) {
    return (
      <div className="rail-donut-empty">
        <span>No replies classified yet</span>
      </div>
    );
  }
  const r = 44;
  const c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="rail-donut">
      <svg viewBox="0 0 110 110" className="rail-donut-svg">
        <circle cx="55" cy="55" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="14" />
        {SENTIMENT_META.map(s => {
          const v = sentiments?.[s.key] || 0;
          if (!v) return null;
          const frac = v / total;
          const len = c * frac;
          const offset = c * (acc / total);
          acc += v;
          return (
            <circle
              key={s.key}
              cx="55" cy="55" r={r}
              fill="none"
              stroke={s.color}
              strokeWidth="14"
              strokeDasharray={`${len} ${c - len}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 55 55)"
              strokeLinecap="butt"
            />
          );
        })}
      </svg>
      <div className="rail-donut-center">
        <div className="rail-donut-n">{total}</div>
        <div className="rail-donut-l">replies</div>
      </div>
    </div>
  );
}

function CaptainStrategy({ replyRate30d, trend }) {
  const { request } = useApi();
  const [learnings, setLearnings] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    request('/dashboard/weekly-learnings')
      .then(res => setLearnings(res?.data || null))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const hooks = Array.isArray(learnings?.best_hooks) ? learnings.best_hooks : [];
  const trendArrow = trend === 'up' ? '▲' : trend === 'down' ? '▼' : '→';
  const trendColor = trend === 'up' ? 'var(--lime)' : trend === 'down' ? 'var(--orange)' : 'var(--text-muted)';

  return (
    <div className="rail-block rail-captain">
      <div className="rail-block-head rail-captain-head">
        <span className="rail-captain-icon">★</span>
        <span>Captain's Weekly Strategy</span>
      </div>

      {/* Reply rate trend mini */}
      <div className="rail-captain-row">
        <span className="rail-captain-k">Reply rate (30d)</span>
        <span className="rail-captain-v" style={{ color: trendColor }}>
          {replyRate30d != null ? `${replyRate30d}%` : '—'} <span className="rail-trend-arrow">{trendArrow}</span>
        </span>
      </div>

      {/* Hook of the week */}
      <div className="rail-captain-section">
        <div className="rail-captain-label">Hook of the Week</div>
        {loading ? (
          <div className="skeleton" style={{ height: 32, borderRadius: 4 }} />
        ) : hooks.length > 0 ? (
          <div className="rail-captain-hook">"{hooks[0]}"</div>
        ) : (
          <div className="rail-captain-muted">No hook flagged yet — captain is gathering signal.</div>
        )}
        {hooks.length > 1 && (
          <div className="rail-captain-runner-up">runner-up: "{hooks[1]}"</div>
        )}
      </div>

      {/* Director notes */}
      {!loading && learnings?.director_notes && (
        <div className="rail-captain-section">
          <div className="rail-captain-label">Director's Notes</div>
          <div className="rail-captain-notes">{learnings.director_notes}</div>
        </div>
      )}
    </div>
  );
}

export default function StageBreakdownRail({ data = {} }) {
  const byStage = data.leads_by_stage || {};
  const total = data.total_in_pipeline || 0;
  const sentiments = data.reply_sentiments || {};

  return (
    <div className="rail">
      {/* Stage Breakdown */}
      <div className="rail-block">
        <div className="rail-block-head">
          <span className="rail-pfx">{'//'}</span>
          <span>Stage Breakdown</span>
          <span className="rail-pill">7D</span>
        </div>
        <div className="rail-stages">
          {STAGES.map(stage => {
            const count = parseInt(byStage[stage.key] || 0, 10);
            const pct = total > 0 ? Math.min(100, Math.round((count / total) * 100)) : 0;
            return (
              <div key={stage.key} className="rail-stage-row">
                <div className="rail-stage-top">
                  <span className="rail-stage-dot" style={{ background: stage.color }} />
                  <span className="rail-stage-label" style={{ color: stage.color }}>{stage.label}</span>
                  <span className="rail-stage-count">{count}</span>
                  <span className="rail-stage-pct">{pct}%</span>
                </div>
                <div className="rail-stage-bar">
                  <div className="rail-stage-fill" style={{ width: `${pct}%`, background: stage.color }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Stage Health */}
      <div className="rail-block">
        <div className="rail-block-head">
          <span className="rail-pfx">{'//'}</span>
          <span>Stage Health</span>
        </div>
        <div className="rail-health-grid">
          <div className="rail-health-cell">
            <div className="rail-health-v">{data.sourced_today ?? 0}</div>
            <div className="rail-health-l">sourced today</div>
          </div>
          <div className="rail-health-cell">
            <div className="rail-health-v">{data.in_flight ?? 0}</div>
            <div className="rail-health-l">in-flight</div>
          </div>
          <div className="rail-health-cell">
            <div className="rail-health-v">{data.replies_this_week ?? 0}</div>
            <div className="rail-health-l">replies / week</div>
          </div>
          <div className="rail-health-cell">
            <div className="rail-health-v">{data.meetings_this_week ?? 0}</div>
            <div className="rail-health-l">meetings / week</div>
          </div>
        </div>
      </div>

      {/* Reply Breakdown donut */}
      <div className="rail-block">
        <div className="rail-block-head">
          <span className="rail-pfx">{'//'}</span>
          <span>Reply Breakdown</span>
          <span className="rail-pill">30D</span>
        </div>
        <div className="rail-donut-wrap">
          <ReplyDonut sentiments={sentiments} />
          <div className="rail-donut-legend">
            {SENTIMENT_META.map(s => {
              const v = sentiments[s.key] || 0;
              const total = SENTIMENT_META.reduce((sum, m) => sum + (sentiments[m.key] || 0), 0);
              const pct = total > 0 ? Math.round((v / total) * 100) : 0;
              return (
                <div key={s.key} className="rail-legend-row">
                  <span className="rail-legend-dot" style={{ background: s.color }} />
                  <span className="rail-legend-label">{s.label}</span>
                  <span className="rail-legend-pct">{pct}%</span>
                  <span className="rail-legend-n">{v}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Captain's Weekly Strategy */}
      <CaptainStrategy replyRate30d={data.reply_rate_30d} trend={data.reply_rate_trend} />
    </div>
  );
}
