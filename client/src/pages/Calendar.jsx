import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, ChevronLeft, ChevronRight, Clock, MapPin, X, Ban, ExternalLink } from 'lucide-react';
import { useApi } from '../hooks/useApi';

const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const BLOCKED_KEY = 'dam_blocked_dates';

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dateKey(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function loadBlocked() {
  try { return JSON.parse(localStorage.getItem(BLOCKED_KEY) || '{}'); } catch { return {}; }
}
function saveBlocked(obj) {
  try { localStorage.setItem(BLOCKED_KEY, JSON.stringify(obj)); } catch {}
}

function getCalendarDays(year, month) {
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  // Pad to fill last row
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function EventDot({ color }) {
  return <div style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />;
}

function DayCell({ day, year, month, events, blocked, today, selected, onSelect, onToggleBlock }) {
  if (!day) return <div style={{ background: 'transparent', minHeight: 90 }} />;

  const key = dateKey(year, month, day);
  const isToday = today.getFullYear() === year && today.getMonth() === month && today.getDate() === day;
  const isBlocked = blocked[key];
  const dayEvents = events.filter(ev => {
    const d = new Date(ev.start_time);
    return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day;
  });
  const isSelected = selected === key;
  const isPast = new Date(year, month, day) < new Date(today.getFullYear(), today.getMonth(), today.getDate());

  return (
    <div
      onClick={() => onSelect(key)}
      style={{
        minHeight: 90,
        background: isBlocked
          ? 'rgba(255,140,0,0.07)'
          : isSelected
            ? 'rgba(200,255,0,0.06)'
            : 'var(--bg)',
        border: `1px solid ${isSelected ? 'rgba(200,255,0,0.4)' : isToday ? 'rgba(200,255,0,0.25)' : 'var(--border)'}`,
        borderRadius: 6,
        padding: '0.4rem 0.5rem',
        cursor: 'pointer',
        opacity: isPast && !isToday ? 0.5 : 1,
        transition: 'all 0.15s ease',
        position: 'relative',
      }}
    >
      {/* Day number */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem' }}>
        <span style={{
          fontSize: '0.8rem',
          fontWeight: isToday ? 700 : 500,
          color: isToday ? 'var(--lime)' : isBlocked ? 'var(--orange)' : 'var(--text)',
          background: isToday ? 'rgba(200,255,0,0.15)' : 'transparent',
          width: 22, height: 22,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: '50%',
        }}>{day}</span>
        {isBlocked && <Ban size={10} style={{ color: 'var(--orange)', opacity: 0.7 }} />}
      </div>

      {/* Events */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {dayEvents.slice(0, 3).map((ev, i) => (
          <div key={ev.id || i} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <EventDot color="var(--purple)" />
            <span style={{ fontSize: '0.62rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {ev.title}
            </span>
          </div>
        ))}
        {dayEvents.length > 3 && (
          <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>+{dayEvents.length - 3} more</span>
        )}
      </div>

      {/* Block toggle button — shows on hover via JS state wouldn't work, so always subtle */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggleBlock(key); }}
        title={isBlocked ? 'Unblock this day' : 'Block this day (unavailable)'}
        style={{
          position: 'absolute', bottom: 3, right: 3,
          background: 'none', border: 'none', cursor: 'pointer',
          color: isBlocked ? 'var(--orange)' : 'var(--border)',
          padding: 2, borderRadius: 3,
          fontSize: '0.55rem',
          opacity: 0.6,
        }}
      >
        <Ban size={8} />
      </button>
    </div>
  );
}

function DayDetail({ dateStr, events, blocked, onToggleBlock, onBook }) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const label = new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const dayEvents = events.filter(ev => {
    const dd = new Date(ev.start_time);
    return dd.getFullYear() === y && dd.getMonth() === m - 1 && dd.getDate() === d;
  });
  const isBlocked = blocked[dateStr];

  return (
    <div className="card" style={{ marginTop: '1rem', padding: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{label}</div>
          {isBlocked && <div style={{ fontSize: '0.72rem', color: 'var(--orange)', marginTop: 2 }}>Blocked — unavailable</div>}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            className={`btn btn-sm ${isBlocked ? 'btn-danger' : 'btn-secondary'}`}
            style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem', gap: '0.3rem' }}
            onClick={() => onToggleBlock(dateStr)}
          >
            <Ban size={11} /> {isBlocked ? 'Unblock' : 'Block day'}
          </button>
          <button className="btn btn-primary btn-sm" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} onClick={onBook}>
            <Plus size={11} /> Book
          </button>
        </div>
      </div>

      {dayEvents.length === 0 ? (
        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', padding: '0.5rem 0' }}>No meetings</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {dayEvents.map(ev => (
            <div key={ev.id} style={{ background: 'var(--bg)', borderRadius: 6, padding: '0.5rem 0.75rem', border: '1px solid var(--border)', display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
              <div style={{ width: 3, borderRadius: 2, background: 'var(--purple)', alignSelf: 'stretch', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.title}</div>
                {ev.lead_name && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{ev.lead_name} · {ev.lead_company}</div>}
                <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.25rem', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.7rem', color: 'var(--purple)', display: 'flex', alignItems: 'center', gap: 3 }}>
                    <Clock size={10} /> {formatTime(ev.start_time)} – {formatTime(ev.end_time)}
                  </span>
                  {ev.meeting_link && (
                    <a href={ev.meeting_link} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.7rem', color: 'var(--blue)', display: 'flex', alignItems: 'center', gap: 3 }}>
                      <MapPin size={10} /> Join
                    </a>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BookingForm({ defaultDate, onSave, onCancel, saving }) {
  const [form, setForm] = useState({
    title: '',
    start_time: defaultDate ? `${defaultDate}T09:00` : '',
    end_time: defaultDate ? `${defaultDate}T10:00` : '',
    meeting_link: '',
    description: '',
  });

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h3 style={{ fontWeight: 600, fontSize: '0.95rem' }}>New Meeting</h3>
        <button className="btn btn-ghost" style={{ padding: '0.25rem' }} onClick={onCancel}><X size={16} /></button>
      </div>
      <form onSubmit={e => { e.preventDefault(); onSave(form); }} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
        <div className="form-group" style={{ gridColumn: '1 / -1' }}>
          <label className="form-label">Title</label>
          <input className="form-input" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} required placeholder="Meeting title" />
        </div>
        <div className="form-group">
          <label className="form-label">Start</label>
          <input className="form-input" type="datetime-local" value={form.start_time} onChange={e => setForm({ ...form, start_time: e.target.value })} required />
        </div>
        <div className="form-group">
          <label className="form-label">End</label>
          <input className="form-input" type="datetime-local" value={form.end_time} onChange={e => setForm({ ...form, end_time: e.target.value })} required />
        </div>
        <div className="form-group" style={{ gridColumn: '1 / -1' }}>
          <label className="form-label">Meeting link (optional)</label>
          <input className="form-input" value={form.meeting_link} onChange={e => setForm({ ...form, meeting_link: e.target.value })} placeholder="https://meet.google.com/..." />
        </div>
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Create'}</button>
        </div>
      </form>
    </div>
  );
}

function CalendlyWidget({ url, prefillDate }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!url || !ref.current) return;

    // Load Calendly embed script once
    if (!document.getElementById('calendly-script')) {
      const script = document.createElement('script');
      script.id = 'calendly-script';
      script.src = 'https://assets.calendly.com/assets/external/widget.js';
      script.async = true;
      document.head.appendChild(script);
    }

    const tryInit = () => {
      if (window.Calendly) {
        window.Calendly.initInlineWidget({
          url,
          parentElement: ref.current,
          prefill: prefillDate ? { date: new Date(prefillDate) } : {},
        });
      } else {
        setTimeout(tryInit, 300);
      }
    };
    tryInit();

    return () => {
      if (ref.current) ref.current.innerHTML = '';
    };
  }, [url, prefillDate]);

  return (
    <div
      ref={ref}
      style={{ minHeight: 650, width: '100%', borderRadius: 'var(--radius)', overflow: 'hidden' }}
    />
  );
}

export default function Calendar() {
  const { request, loading } = useApi();
  const navigate = useNavigate();
  const today = new Date();

  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  const [blocked, setBlocked] = useState(loadBlocked);
  const [selected, setSelected] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [calendly, setCalendly] = useState(null);
  const [showCalendly, setShowCalendly] = useState(false);

  useEffect(() => {
    request('/calendar').then(res => setEvents(res?.data || [])).catch(err => setError('Failed to load data'));
    request('/integrations/calendly').then(res => {
      if (res?.data?.connected) setCalendly(res.data);
    }).catch(() => {});
  }, []);

  const cells = getCalendarDays(year, month);

  const prevMonth = () => {
    if (month === 0) { setYear(y => y - 1); setMonth(11); }
    else setMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (month === 11) { setYear(y => y + 1); setMonth(0); }
    else setMonth(m => m + 1);
  };
  const goToday = () => { setYear(today.getFullYear()); setMonth(today.getMonth()); };

  const toggleBlock = useCallback((key) => {
    setBlocked(prev => {
      const next = { ...prev };
      if (next[key]) delete next[key]; else next[key] = true;
      saveBlocked(next);
      return next;
    });
  }, []);

  const handleSave = async (form) => {
    setSaving(true);
    try {
      const res = await request('/calendar', { method: 'POST', body: JSON.stringify(form) });
      if (res?.data) {
        setEvents(prev => [...prev, res.data]);
        setShowForm(false);
        setSelected(null);
      }
    } catch (err) { setError('Failed to load data'); }
    setSaving(false);
  };

  const blockedCount = Object.keys(blocked).length;
  const monthEvents = events.filter(ev => {
    const d = new Date(ev.start_time);
    return d.getFullYear() === year && d.getMonth() === month;
  });

  return (
    <div className="fade-in">
      {error && (
        <div style={{ padding: '16px', background: 'rgba(239,68,68,0.1)', borderRadius: 'var(--radius)', color: 'var(--danger)', marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{error}</span>
          <button onClick={() => { setError(null); request('/calendar').then(res => setEvents(res?.data || [])).catch(err => setError('Failed to load data')); }} style={{ background: 'var(--danger)', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 'var(--radius)', cursor: 'pointer' }}>Retry</button>
        </div>
      )}
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Calendar</h1>
          <p className="page-subtitle">
            {monthEvents.length} meeting{monthEvents.length !== 1 ? 's' : ''} in {MONTHS[month]}
            {blockedCount > 0 && <span style={{ color: 'var(--orange)', marginLeft: '0.75rem' }}>· {blockedCount} blocked day{blockedCount !== 1 ? 's' : ''}</span>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" style={{ fontSize: '0.8rem', padding: '0.35rem 0.75rem' }} onClick={goToday}>Today</button>
          {calendly?.connected && (
            <button
              className="btn btn-secondary"
              style={{ fontSize: '0.8rem', padding: '0.35rem 0.75rem', color: 'var(--lime)', borderColor: 'rgba(200,255,0,0.4)', gap: '0.4rem' }}
              onClick={() => setShowCalendly(v => !v)}
            >
              <ExternalLink size={13} /> {showCalendly ? 'Hide' : 'Open Calendly'}
            </button>
          )}
          <button className="btn btn-primary" onClick={() => { setShowForm(true); setSelected(null); }}>
            <Plus size={15} /> Book Meeting
          </button>
        </div>
      </div>

      {/* Booking form */}
      {showForm && (
        <BookingForm
          defaultDate={selected}
          onSave={handleSave}
          onCancel={() => setShowForm(false)}
          saving={saving}
        />
      )}

      {/* Calendar card */}
      <div className="card" style={{ padding: '1rem' }}>
        {/* Month nav */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
          <button className="btn btn-ghost" style={{ padding: '0.35rem' }} onClick={prevMonth}>
            <ChevronLeft size={18} />
          </button>
          <div style={{ fontWeight: 700, fontSize: '1.05rem' }}>
            {MONTHS[month]} <span style={{ color: 'var(--lime)' }}>{year}</span>
          </div>
          <button className="btn btn-ghost" style={{ padding: '0.35rem' }} onClick={nextMonth}>
            <ChevronRight size={18} />
          </button>
        </div>

        {/* Day headers */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 4 }}>
          {DAYS_SHORT.map(d => (
            <div key={d} style={{ textAlign: 'center', fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)', padding: '0.25rem 0', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {d}
            </div>
          ))}
        </div>

        {/* Calendar grid */}
        {loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
            {Array.from({ length: 35 }).map((_, i) => (
              <div key={i} className="skeleton" style={{ minHeight: 90, borderRadius: 6 }} />
            ))}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
            {cells.map((day, i) => (
              <DayCell
                key={i}
                day={day}
                year={year}
                month={month}
                events={events}
                blocked={blocked}
                today={today}
                selected={selected}
                onSelect={setSelected}
                onToggleBlock={toggleBlock}
              />
            ))}
          </div>
        )}

        {/* Legend */}
        <div style={{ display: 'flex', gap: '1.25rem', marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            <EventDot color="var(--purple)" /> Meeting
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            <Ban size={10} style={{ color: 'var(--orange)' }} /> Blocked / unavailable
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            <div style={{ width: 14, height: 14, borderRadius: '50%', background: 'rgba(200,255,0,0.15)', border: '1px solid rgba(200,255,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.55rem', fontWeight: 700, color: 'var(--lime)' }}>•</div> Today
          </div>
        </div>
      </div>

      {/* Selected day detail */}
      <DayDetail
        dateStr={selected}
        events={events}
        blocked={blocked}
        onToggleBlock={toggleBlock}
        onBook={() => setShowForm(true)}
      />

      {/* Calendly widget */}
      {showCalendly && calendly?.url && (
        <div className="card fade-in" style={{ marginTop: '1rem', padding: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Book via Calendly</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{calendly.url}</div>
            </div>
            <button className="btn btn-ghost" style={{ padding: '0.2rem' }} onClick={() => setShowCalendly(false)}><X size={16} /></button>
          </div>
          <CalendlyWidget url={calendly.url} prefillDate={selected} />
        </div>
      )}

      {!calendly?.connected && (
        <div style={{ marginTop: '1rem', background: 'rgba(37,99,235,0.06)', border: '1px solid rgba(37,99,235,0.2)', borderRadius: 'var(--radius)', padding: '0.875rem 1rem', display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.82rem' }}>
          <ExternalLink size={15} style={{ color: 'var(--police-blue)', flexShrink: 0 }} />
          <span style={{ color: 'var(--text-muted)', flex: 1 }}>Connect Calendly in Settings to embed your scheduling page here — agents will also use it when suggesting meeting times.</span>
          <button className="btn btn-secondary" style={{ fontSize: '0.75rem', padding: '0.3rem 0.75rem', flexShrink: 0 }} onClick={() => navigate('/settings')}>Connect →</button>
        </div>
      )}
    </div>
  );
}
