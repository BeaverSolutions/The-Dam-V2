import React, { useEffect, useState } from 'react';
import './CrewLive.css';

/**
 * CrewLive — single rotating panel that cycles through the 4 beavers and,
 * within each beaver, sub-cycles through Today / Week / Lifetime stat blocks.
 *
 * Replaces 4 separate beaver cards with one unified component.
 *
 * data shape (all optional, falls back to "—"):
 *   sourced_today, sourced_this_week, total_in_pipeline, sent_all_time,
 *   sent_today, sent_this_week, in_flight, replies_this_week,
 *   reviewed_this_week, passed_this_week, enforcer_pass_rate, pending_approvals,
 *   meetings_today, meetings_this_week, meetings_booked,
 *   reply_rate_30d, reply_rate_lifetime, replies_all_time
 */

const CYCLE_BEAVER_MS = 8000;     // 8s per beaver
const CYCLE_STATE_MS = 4000;      // 4s per state within a beaver

function fmt(v, suffix = '') {
  if (v == null || v === '' || Number.isNaN(v)) return '—';
  if (typeof v === 'number') return `${v.toLocaleString()}${suffix}`;
  return `${v}${suffix}`;
}

export default function CrewLive({ data = {} }) {
  const [beaverIdx, setBeaverIdx] = useState(0);
  const [stateIdx, setStateIdx] = useState(0);

  const safePct = (num, den) =>
    den > 0 ? +(((num || 0) / den) * 100).toFixed(1) : null;

  const beavers = [
    {
      id: 'research',
      name: 'Research Beaver',
      role: 'sourcing intel',
      img: '/assets/beavers/research-beaver.png',
      color: '#00B4FF',
      states: [
        {
          label: 'Today',
          stats: [
            { k: 'Sourced', v: fmt(data.sourced_today) },
            { k: 'In pipeline', v: fmt(data.total_in_pipeline) },
            { k: 'Pool ready', v: fmt(data.pool_health) },
          ],
        },
        {
          label: 'This Week',
          stats: [
            { k: 'Sourced', v: fmt(data.sourced_this_week) },
            { k: 'In pipeline', v: fmt(data.total_in_pipeline) },
          ],
        },
        {
          label: 'Lifetime',
          stats: [
            { k: 'Total leads', v: fmt(data.total_in_pipeline) },
            { k: 'All-time replies', v: fmt(data.replies_all_time) },
          ],
        },
      ],
    },
    {
      id: 'sales',
      name: 'Sales Beaver',
      role: 'drafting outreach',
      img: '/assets/beavers/sales-beaver.png',
      color: '#FF8C00',
      states: [
        {
          label: 'Today',
          stats: [
            { k: 'Sent', v: fmt(data.sent_today) },
            { k: 'In flight', v: fmt(data.in_flight) },
            { k: 'Pending', v: fmt(data.pending_approvals) },
          ],
        },
        {
          label: 'This Week',
          stats: [
            { k: 'Sent', v: fmt(data.sent_this_week) },
            { k: 'Replies', v: fmt(data.replies_this_week) },
            {
              k: 'Reply rate',
              v: data.sent_this_week
                ? `${safePct(data.replies_this_week, data.sent_this_week) ?? 0}%`
                : '—',
            },
          ],
        },
        {
          label: 'Lifetime',
          stats: [
            { k: 'Total sent', v: fmt(data.sent_all_time ?? data.messages_sent) },
            { k: 'Total replies', v: fmt(data.replies_all_time) },
            {
              k: 'Reply rate',
              v: data.reply_rate_lifetime != null
                ? `${data.reply_rate_lifetime}%`
                : '—',
            },
          ],
        },
      ],
    },
    {
      id: 'enforcer',
      name: 'Enforcer Beaver',
      role: 'guarding quality',
      img: '/assets/beavers/ranger-beaver.png',
      color: '#2563EB',
      states: [
        {
          label: 'Today',
          stats: [
            { k: 'Pending', v: fmt(data.pending_approvals) },
            { k: 'Pass rate (7d)', v: data.enforcer_pass_rate != null ? `${data.enforcer_pass_rate}%` : '—' },
          ],
        },
        {
          label: 'This Week',
          stats: [
            { k: 'Reviewed', v: fmt(data.reviewed_this_week) },
            { k: 'Passed', v: fmt(data.passed_this_week) },
            {
              k: 'Pass rate',
              v: data.reviewed_this_week
                ? `${safePct(data.passed_this_week, data.reviewed_this_week) ?? 0}%`
                : '—',
            },
          ],
        },
        {
          label: 'Lifetime',
          stats: [
            { k: 'Pass rate (7d)', v: data.enforcer_pass_rate != null ? `${data.enforcer_pass_rate}%` : '—' },
            { k: 'Currently in queue', v: fmt(data.pending_approvals) },
          ],
        },
      ],
    },
    {
      id: 'captain',
      name: 'Captain Beaver',
      role: 'orchestrating crew',
      img: '/assets/beavers/director-beaver.png',
      color: '#A855F7',
      states: [
        {
          label: 'Today',
          stats: [
            { k: 'Booked', v: fmt(data.meetings_today) },
            { k: 'Sent', v: fmt(data.sent_today) },
          ],
        },
        {
          label: 'This Week',
          stats: [
            { k: 'Meetings', v: fmt(data.meetings_this_week) },
            { k: 'Replies', v: fmt(data.replies_this_week) },
            {
              k: 'Reply rate',
              v: data.sent_this_week
                ? `${safePct(data.replies_this_week, data.sent_this_week) ?? 0}%`
                : '—',
            },
          ],
        },
        {
          label: 'Lifetime',
          stats: [
            { k: 'Meetings booked', v: fmt(data.meetings_booked) },
            { k: 'Reply rate', v: data.reply_rate_lifetime != null ? `${data.reply_rate_lifetime}%` : '—' },
          ],
        },
      ],
    },
  ];

  const current = beavers[beaverIdx];
  const currentState = current.states[stateIdx % current.states.length];

  // Sub-cycle: state every 4s
  useEffect(() => {
    const t = setInterval(() => {
      setStateIdx(i => (i + 1) % 3);
    }, CYCLE_STATE_MS);
    return () => clearInterval(t);
  }, []);

  // Outer cycle: beaver every 8s
  useEffect(() => {
    const t = setInterval(() => {
      setBeaverIdx(i => (i + 1) % beavers.length);
      setStateIdx(0); // reset sub-cycle when beaver changes
    }, CYCLE_BEAVER_MS);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="crew-live" style={{ '--accent': current.color }}>
      <div className="crew-live-head">
        <span className="crew-live-pfx">{'//'}</span>
        <span className="crew-live-ttl">Crew Live</span>
        <span className="crew-live-pill">
          <span className="crew-live-dot"></span>{currentState.label}
        </span>
        <span className="crew-live-meta">{current.role}</span>
      </div>

      <div className="crew-live-body" key={`${current.id}-${stateIdx}`}>
        <div className="crew-live-portrait">
          <img src={current.img} alt={current.name} />
          <div className="crew-live-name" style={{ color: current.color }}>{current.name}</div>
        </div>

        <div className="crew-live-stats">
          {currentState.stats.map((s, i) => (
            <div key={`${s.k}-${i}`} className="crew-stat-row">
              <span className="crew-stat-k">{s.k}</span>
              <span className="crew-stat-v">{s.v}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="crew-live-rotor">
        {beavers.map((b, i) => (
          <button
            key={b.id}
            className={`crew-rotor-dot ${i === beaverIdx ? 'on' : ''}`}
            style={{ '--dot': b.color }}
            onClick={() => { setBeaverIdx(i); setStateIdx(0); }}
            aria-label={`Show ${b.name}`}
          />
        ))}
      </div>
    </div>
  );
}
