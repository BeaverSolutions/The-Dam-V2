import React, { useEffect, useState } from 'react';
import { Plus, Clock, MapPin } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import EmptyState from '../components/EmptyState';

function formatDate(ts) {
  return new Date(ts).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function Calendar() {
  const { request, loading } = useApi();
  const [events, setEvents] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: '', start_time: '', end_time: '', description: '', meeting_link: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    request('/calendar').then(res => setEvents(res?.data || [])).catch(() => {});
  }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await request('/calendar', { method: 'POST', body: JSON.stringify(form) });
      if (res?.data) {
        setEvents(prev => [...prev, res.data]);
        setShowForm(false);
        setForm({ title: '', start_time: '', end_time: '', description: '', meeting_link: '' });
      }
    } catch {}
    setSaving(false);
  };

  return (
    <div className="fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Calendar</h1>
          <p className="page-subtitle">{events.length} upcoming meetings</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
          <Plus size={16} /> Book Meeting
        </button>
      </div>

      {showForm && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <h3 style={{ fontWeight: 600, marginBottom: '1rem' }}>New Meeting</h3>
          <form onSubmit={handleCreate} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">Title</label>
              <input className="form-input" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} required placeholder="Meeting title" />
            </div>
            <div className="form-group">
              <label className="form-label">Start time</label>
              <input className="form-input" type="datetime-local" value={form.start_time} onChange={e => setForm({ ...form, start_time: e.target.value })} required />
            </div>
            <div className="form-group">
              <label className="form-label">End time</label>
              <input className="form-input" type="datetime-local" value={form.end_time} onChange={e => setForm({ ...form, end_time: e.target.value })} required />
            </div>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">Meeting link (optional)</label>
              <input className="form-input" value={form.meeting_link} onChange={e => setForm({ ...form, meeting_link: e.target.value })} placeholder="https://meet.google.com/..." />
            </div>
            <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving...' : 'Create'}</button>
            </div>
          </form>
        </div>
      )}

      {loading ? (
        Array.from({ length: 3 }).map((_, i) => <div key={i} className="card skeleton" style={{ height: 100, marginBottom: '0.75rem' }} />)
      ) : events.length === 0 ? (
        <EmptyState
          agent="director"
          title="No meetings booked"
          description="Meetings booked through the pipeline will appear here."
        />
      ) : (
        events.map(ev => (
          <div key={ev.id} className="card" style={{ marginBottom: '0.75rem', display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
            <div style={{ textAlign: 'center', minWidth: 48 }}>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{new Date(ev.start_time).toLocaleDateString([], { month: 'short' })}</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--purple)', lineHeight: 1 }}>{new Date(ev.start_time).getDate()}</div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>{ev.title}</div>
              {ev.lead_name && <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{ev.lead_name} · {ev.lead_company}</div>}
              <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                  <Clock size={12} /> {formatTime(ev.start_time)} – {formatTime(ev.end_time)}
                </span>
                {ev.meeting_link && (
                  <a href={ev.meeting_link} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.75rem', color: 'var(--blue)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                    <MapPin size={12} /> Join
                  </a>
                )}
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
