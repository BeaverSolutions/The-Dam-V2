import React, { useEffect, useRef, useState } from 'react';
import { Gauge, TrendingUp, Activity, Calendar } from 'lucide-react';
import './PipelineEngine.css';

/* ─── CountUp helper (eased rAF tween) ─────────────────────── */

function useCountUp(target, { duration = 1100, decimals = 0, start = 0 } = {}) {
  const [val, setVal] = useState(start);
  const raf = useRef(0);
  useEffect(() => {
    cancelAnimationFrame(raf.current);
    const t0 = performance.now();
    const from = start;
    const delta = (target ?? 0) - from;
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / duration);
      const v = from + delta * ease(t);
      setVal(v);
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, duration]);
  const factor = Math.pow(10, decimals);
  const rounded = Math.round(val * factor) / factor;
  return rounded.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function CountUp({ to, decimals = 0, duration = 1100, prefix = '', suffix = '' }) {
  const v = useCountUp(to, { duration, decimals });
  return <>{prefix}{v}{suffix}</>;
}

/* ─── Geometry ────────────────────────────────────────────── */

const ORANGE = '#FF6A00';
const W = 720, H = 720;
const cx = W / 2, cy = H / 2;
const beaverR = 380;  // v7 baseline (304) pushed 2cm outward

function polar(cX, cY, r, deg) {
  const rad = (deg - 90) * Math.PI / 180;
  return { x: cX + r * Math.cos(rad), y: cY + r * Math.sin(rad) };
}
function quarterArcPath(cX, cY, r, posDeg) {
  const a = polar(cX, cY, r, posDeg - 45);
  const b = polar(cX, cY, r, posDeg + 45);
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 0 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

/* ─── DataArc (the four colored quarter arcs with traveling dots) ─── */

function DataArc({ s, idx }) {
  const path = quarterArcPath(cx, cy, s.ringR, s.posDeg);
  return (
    <g>
      <circle cx={cx} cy={cy} r={s.ringR}
              fill="none" stroke="rgba(226,232,240,0.05)"
              strokeWidth="1" strokeDasharray="2 8"/>
      <path d={path} fill="none"
            stroke={s.color} strokeWidth="8" strokeLinecap="round"
            filter="url(#data-glow)"/>
      <path d={path} fill="none"
            stroke={`url(#shimmer-${idx})`} strokeWidth="8" strokeLinecap="round"
            className="arc-shimmer"
            style={{ animationDelay: `${idx * 2}s` }}/>
      {Array.from({ length: s.dotCount }).map((_, j) => {
        const stagger = j / s.dotCount;
        return (
          <g key={j}>
            {[0, 0.06, 0.12, 0.18].map((tail, k) => (
              <circle key={k}
                      r={s.dotSize - k * 0.5}
                      fill={s.color}
                      opacity={1 - k * 0.27}
                      filter={k === 0 ? 'url(#dot-glow)' : undefined}>
                <animateMotion
                  dur={`${s.dotSpeed}s`}
                  repeatCount="indefinite"
                  begin={`${-stagger * s.dotSpeed - tail * 0.05}s`}
                  keyPoints="0;1" keyTimes="0;1" calcMode="linear"
                  path={path}/>
                <animate attributeName="opacity"
                         values={`0;${1 - k * 0.27};${1 - k * 0.27};0`}
                         keyTimes="0;0.1;0.9;1"
                         dur={`${s.dotSpeed}s`} repeatCount="indefinite"
                         begin={`${-stagger * s.dotSpeed - tail * 0.05}s`}/>
              </circle>
            ))}
          </g>
        );
      })}
    </g>
  );
}

/* ─── Center rotating KPI display ─────────────────────────── */

function CenterRotator({ states }) {
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState('in');

  useEffect(() => {
    const cycle = () => {
      setPhase('out');
      setTimeout(() => {
        setIdx(i => (i + 1) % states.length);
        setPhase('in');
      }, 200);
    };
    const t = setInterval(cycle, 4000);
    return () => clearInterval(t);
  }, [states.length]);

  if (!states.length) return null;
  const s = states[idx];
  return (
    <div className="engine-center">
      <div className={`rotor ${phase === 'in' ? 'rotor-in' : 'rotor-out'}`} key={idx}>
        <div className="rotor-lbl">{s.label}</div>
        <div className="rotor-val">
          <CountUp to={s.value ?? 0} decimals={s.decimals || 0} duration={600} />
          {s.suffix || ''}
        </div>
        <div className="rotor-sub" style={{ color: s.subColor }}>{s.sub}</div>
      </div>
      <div className="rotor-dots">
        {states.map((_, i) => (
          <span key={i} className={`rd ${i === idx ? 'on' : ''}`}></span>
        ))}
      </div>
    </div>
  );
}

/* ─── Stat card (footer strip) ────────────────────────────── */

function StatCard({ Icon, accent, value, decimals, unit, prefix, label, name, delay = 0 }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), delay);
    return () => clearTimeout(t);
  }, [delay]);
  return (
    <div className="stat-card" style={{ '--accent': accent, animationDelay: `${delay}ms` }}>
      <div className="stat-card-head">
        <Icon size={12} style={{ color: accent }} />
        <span style={{ color: accent }}>{name}</span>
      </div>
      <div className="stat-card-v" style={{ color: accent }}>
        {mounted
          ? <CountUp to={value ?? 0} decimals={decimals} duration={900} prefix={prefix || ''} />
          : (prefix || '') + (decimals ? (0).toFixed(decimals) : '0')}
        {unit && <span className="stat-card-u">{unit}</span>}
      </div>
      <div className="stat-card-lbl">{label}</div>
    </div>
  );
}

/* ─── Main component ──────────────────────────────────────── */

/**
 * PipelineEngine — visual hero showing the 4 crew agents working the pipeline.
 *
 * data shape (all optional, falls back to "—" or 0):
 *   sourced_today, total_in_pipeline,
 *   sent_today, sent_target, in_flight,
 *   enforcer_pass_rate, pending_approvals,
 *   meetings_today, meetings_this_week,
 *   reply_rate_30d, reply_rate_trend,
 *   meetings_booked,
 *   conversion_rate, meetings_next_7d
 */
export default function PipelineEngine({ data = {}, rail = null }) {
  const fmt = (v) => {
    if (v == null || v === '' || Number.isNaN(v)) return '—';
    if (typeof v === 'number') return v.toLocaleString();
    return v;
  };
  const reviewed = data.reviewed_this_week ?? 0;
  const passed = data.passed_this_week ?? 0;
  const rejectedWk = Math.max(0, reviewed - passed);
  const rewritePct = reviewed > 0 ? Math.round((rejectedWk / reviewed) * 100) : null;

  const STAGES = [
    {
      id: 'prospecting', name: 'Research Beaver', pos: 'tl',
      color: '#00B4FF', img: '/assets/beavers/research-beaver.png',
      posDeg: 315, ringR: 204, dotCount: 5, dotSpeed: 8, dotSize: 4,
      role: 'sourcing intel',
      week: [
        { k: 'Found',    v: fmt(data.sourced_this_week) },
        { k: 'In pool',  v: fmt(data.pool_health) },
        { k: 'Pipeline', v: fmt(data.total_in_pipeline) },
      ],
      lifetime: [
        { k: 'Total leads', v: fmt(data.total_in_pipeline) },
        { k: 'Best source', v: '—' },
      ],
    },
    {
      id: 'outreach', name: 'Sales Beaver', pos: 'br',
      color: '#FF8C00', img: '/assets/beavers/sales-beaver.png',
      posDeg: 135, ringR: 174, dotCount: 4, dotSpeed: 6, dotSize: 4,
      role: 'drafting outreach',
      week: [
        { k: 'Sent',      v: fmt(data.sent_this_week) },
        { k: 'In flight', v: fmt(data.in_flight) },
        { k: 'Replies',   v: fmt(data.replies_this_week) },
      ],
      lifetime: [
        { k: 'Total sent', v: fmt(data.sent_all_time ?? data.messages_sent) },
        { k: 'Reply rate', v: data.reply_rate_lifetime != null ? `${data.reply_rate_lifetime}%` : '—' },
      ],
    },
    {
      id: 'qualifying', name: 'Enforcer Beaver', pos: 'tr',
      color: '#2563EB', img: '/assets/beavers/ranger-beaver.png',
      posDeg: 45, ringR: 145, dotCount: 3, dotSpeed: 5, dotSize: 3,
      role: 'guarding quality',
      week: [
        { k: 'Reviewed',  v: fmt(reviewed) },
        { k: 'Rejected',  v: fmt(rejectedWk) },
        { k: 'Rewrite %', v: rewritePct != null ? `${rewritePct}%` : '—' },
      ],
      lifetime: [
        { k: 'Pass rate (7d)', v: data.enforcer_pass_rate != null ? `${data.enforcer_pass_rate}%` : '—' },
        { k: 'Pending',         v: fmt(data.pending_approvals) },
      ],
    },
    {
      id: 'booked', name: 'Captain Beaver', pos: 'bl',
      color: '#A855F7', img: '/assets/beavers/director-beaver.png',
      posDeg: 225, ringR: 121, dotCount: 2, dotSpeed: 4, dotSize: 3,
      role: 'orchestrating crew',
      week: [
        { k: 'Sent',    v: fmt(data.sent_this_week) },
        { k: 'Replies', v: fmt(data.replies_this_week) },
        { k: 'Meets',   v: fmt(data.meetings_this_week) },
      ],
      lifetime: [
        { k: 'Meetings',  v: fmt(data.meetings_booked) },
        { k: 'Best hook', v: '—' },
      ],
    },
  ];

  const trendArrow = data.reply_rate_trend === 'up' ? '▲' : data.reply_rate_trend === 'down' ? '▼' : '';
  const trendColor = data.reply_rate_trend === 'up' ? '#C8FF00' : data.reply_rate_trend === 'down' ? '#FF8C00' : '#5A7A99';

  const CENTER_STATES = [
    {
      label: 'Sent Today',
      value: data.sent_today ?? 0,
      decimals: 0, suffix: '',
      sub: data.sent_target ? `vs ${data.sent_target} target` : 'today',
      subColor: '#5A7A99',
    },
    {
      label: 'Meetings Booked',
      value: data.meetings_booked ?? 0,
      decimals: 0, suffix: '',
      sub: `${data.meetings_this_week ?? 0} this week`,
      subColor: '#C8FF00',
    },
    {
      label: 'Reply Rate',
      value: data.reply_rate_30d ?? 0,
      decimals: 1, suffix: '%',
      sub: trendArrow ? `${trendArrow} 30d trend` : 'last 30d',
      subColor: trendColor,
    },
  ];

  return (
    <div className={`engine-panel ${rail ? 'engine-panel--with-rail' : ''}`}>
      <div className="engine-head">
        <span className="engine-pfx">{'//'}</span>
        <span className="engine-ttl">Pipeline Engine</span>
        <span className="engine-live-pill">
          <span className="engine-live-dot"></span>LIVE
        </span>
        <span className="engine-meta">{data.total_in_pipeline ?? 0} leads in motion</span>
      </div>

      <div className="engine-body">
      <div className="engine-stage">
        <div className="engine-stage-inner">
          <div className="engine-halo"></div>

          <svg className="engine-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
            <defs>
              <filter id="data-glow" x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur stdDeviation="2.5" result="b"/>
                <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
              </filter>
              <filter id="orange-glow" x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur stdDeviation="1.5" result="b"/>
                <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
              </filter>
              <filter id="dot-glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="2" result="b"/>
                <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
              </filter>
              {STAGES.map((_s, i) => (
                <linearGradient key={`sh${i}`} id={`shimmer-${i}`}>
                  <stop offset="0%"  stopColor="white" stopOpacity="0"/>
                  <stop offset="50%" stopColor="white" stopOpacity="0.7"/>
                  <stop offset="100%" stopColor="white" stopOpacity="0"/>
                </linearGradient>
              ))}
            </defs>

            {/* L1 outer solid ring + ticks */}
            <g className="r1-spin" style={{ transformOrigin: `${cx}px ${cy}px` }}>
              <circle cx={cx} cy={cy} r="252"
                      fill="none" stroke={ORANGE} strokeOpacity="0.5" strokeWidth="3"
                      filter="url(#orange-glow)"/>
              {[0, 90, 180, 270].map(deg => {
                const a = polar(cx, cy, 244, deg);
                const b = polar(cx, cy, 264, deg);
                return <line key={deg} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                             stroke={ORANGE} strokeOpacity="0.7" strokeWidth="2.5"/>;
              })}
              {[45, 135, 225, 315].map(deg => {
                const a = polar(cx, cy, 244, deg - 6);
                const b = polar(cx, cy, 244, deg + 6);
                return <path key={deg}
                  d={`M ${a.x} ${a.y} A 244 244 0 0 1 ${b.x} ${b.y}`}
                  fill="none" stroke={ORANGE} strokeOpacity="0.9" strokeWidth="4"
                  filter="url(#orange-glow)"/>;
              })}
            </g>

            {/* L2 — 96 ticks CCW */}
            <g className="r2-spin" style={{ transformOrigin: `${cx}px ${cy}px` }}>
              {Array.from({ length: 96 }).map((_, i) => {
                const deg = (i / 96) * 360;
                const a = polar(cx, cy, 232, deg);
                const b = polar(cx, cy, 238, deg);
                return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                             stroke={ORANGE} strokeOpacity="0.4" strokeWidth="1"/>;
              })}
            </g>

            {/* L3 — Research arc */}
            <DataArc s={STAGES[0]} idx={0} />

            {/* L4 — 80 bead dots */}
            <g className="r4-spin" style={{ transformOrigin: `${cx}px ${cy}px` }}>
              {Array.from({ length: 80 }).map((_, i) => {
                const deg = (i / 80) * 360;
                const p = polar(cx, cy, 189, deg);
                return <circle key={i} cx={p.x} cy={p.y} r="1.5"
                               fill={ORANGE} fillOpacity="0.4"/>;
              })}
            </g>

            {/* L5 — Sales arc */}
            <DataArc s={STAGES[1]} idx={1} />

            {/* L6 — segmented dashes */}
            <g className="r6-spin" style={{ transformOrigin: `${cx}px ${cy}px` }}>
              <circle cx={cx} cy={cy} r="160"
                      fill="none"
                      stroke={ORANGE} strokeOpacity="0.35" strokeWidth="2"
                      strokeDasharray={`${(2 * Math.PI * 160) / 48 * 0.65} ${(2 * Math.PI * 160) / 48 * 0.35}`}/>
            </g>

            {/* L7 — Enforcer arc */}
            <DataArc s={STAGES[2]} idx={2} />

            {/* L8 — 60 bead dots */}
            <g className="r4-spin" style={{ transformOrigin: `${cx}px ${cy}px`, animationDuration: '25s' }}>
              {Array.from({ length: 60 }).map((_, i) => {
                const deg = (i / 60) * 360;
                const p = polar(cx, cy, 131, deg);
                return <circle key={i} cx={p.x} cy={p.y} r="1.2"
                               fill={ORANGE} fillOpacity="0.35"/>;
              })}
            </g>

            {/* L9 — Captain arc */}
            <DataArc s={STAGES[3]} idx={3} />

            {/* CENTER VOID */}
            <circle cx={cx} cy={cy} r="102" fill="#080D14"/>
            <circle cx={cx} cy={cy} r="104"
                    fill="none" stroke={ORANGE} strokeOpacity="0.85" strokeWidth="2"
                    filter="url(#orange-glow)"/>
            <circle cx={cx} cy={cy} r="97"
                    fill="none" stroke={ORANGE} strokeOpacity="0.25" strokeWidth="1"/>

            {/* sonar pings */}
            {[0, 1, 2].map(i => (
              <circle key={`ping-${i}`} cx={cx} cy={cy} r="104"
                      fill="none" stroke={ORANGE} strokeOpacity="0.55" strokeWidth="1.5"
                      className="sonar-ping"
                      style={{ animationDelay: `${i}s` }}/>
            ))}
          </svg>

          <CenterRotator states={CENTER_STATES} />

          {/* Beavers — orbital portraits with outward expanded stat labels */}
          {STAGES.map((s, i) => {
            const p = polar(50, 50, (beaverR / W) * 100, s.posDeg);
            return (
              <div className={`beaver pos-${s.pos}`} key={s.id}
                   style={{
                     '--accent': s.color,
                     left: `${p.x}%`,
                     top: `${p.y}%`,
                     animationDelay: `${i * 120}ms`,
                   }}>
                <img className="beaver-img" src={s.img} alt={s.name} />
                <div className="beaver-label beaver-label--expanded">
                  <div className="bl-name" style={{ color: s.color }}>{s.name}</div>
                  <div className="bl-status">
                    <span className="bl-status-dot"></span>
                    <span>Standby</span>
                    <span className="bl-role">· {s.role}</span>
                  </div>
                  <div className="bl-section">
                    <div className="bl-eyebrow">This Week</div>
                    <div className="bl-row">
                      {s.week.map((stat, j) => (
                        <div key={j} className="bl-stat">
                          <div className="bl-stat-v">{stat.v}</div>
                          <div className="bl-stat-k">{stat.k}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="bl-section bl-section--lifetime">
                    <div className="bl-eyebrow">Lifetime</div>
                    {s.lifetime.map((stat, j) => (
                      <div key={j} className="bl-life-row">
                        <span className="bl-life-k">{stat.k}</span>
                        <span className="bl-life-v">{stat.v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

        {rail && <div className="engine-rail">{rail}</div>}
      </div>

      <div className="engine-stats-strip">
        <StatCard delay={0}   Icon={Gauge}      accent="#00B4FF"
                  value={data.reply_rate_30d ?? 0} decimals={1} unit="%"
                  label="last 30 days" name="Reply Rate" />
        <StatCard delay={100} Icon={TrendingUp} accent="#FF8C00"
                  value={data.conversion_rate ?? 0} decimals={1} unit="%"
                  label="lead → meeting" name="Conversion" />
        <StatCard delay={200} Icon={Activity}   accent="#C8FF00"
                  value={data.sourced_today ?? 0} decimals={0} unit="" prefix="+"
                  label="net new today" name="Throughput" />
        <StatCard delay={300} Icon={Calendar}   accent="#A855F7"
                  value={data.meetings_next_7d ?? 0} decimals={0} unit=""
                  label="meetings / 7d" name="Forecast" />
      </div>
    </div>
  );
}
