import React, { useEffect, useState } from 'react';
import { Brain, BookOpen, Plus, Trash2, Settings, ChevronRight, Download, X, Copy, Check } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useNavigate } from 'react-router-dom';
import BeaverAvatar, { BEAVER_COLORS, BEAVER_LABELS } from '../components/BeaverAvatar';
import EmptyState from '../components/EmptyState';

const MEMORY_TYPE_LABELS = {
  icp:     { label: 'ICP Profile',    color: 'var(--blue)',   icon: '🎯' },
  journal: { label: 'Journal Entry',  color: 'var(--lime)',   icon: '📓' },
  context: { label: 'Context',        color: 'var(--purple)', icon: '🧠' },
  skill:   { label: 'Skill',          color: 'var(--orange)', icon: '⚡' },
};

function typeInfo(t) {
  return MEMORY_TYPE_LABELS[t] || { label: t, color: 'var(--text-muted)', icon: '📌' };
}

function formatDate(ts) {
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function MemoryCard({ entry, onDelete }) {
  const { label, color, icon } = typeInfo(entry.memory_type);
  const agentColor = BEAVER_COLORS[entry.agent] || 'var(--text-muted)';
  const agentLabel = BEAVER_LABELS[entry.agent] || entry.agent;

  let contentDisplay = '';
  try {
    const parsed = typeof entry.content === 'string' ? JSON.parse(entry.content) : entry.content;
    if (parsed?.text) contentDisplay = parsed.text;
    else if (parsed?.industries || parsed?.job_titles) {
      contentDisplay = Object.entries(parsed)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
        .join('\n');
    } else {
      contentDisplay = JSON.stringify(parsed, null, 2);
    }
  } catch {
    contentDisplay = String(entry.content || '');
  }

  return (
    <div className="card fade-in" style={{ marginBottom: '0.75rem', padding: '1rem' }}>
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
        <div style={{ width: 36, height: 36, borderRadius: 8, background: `${color}15`, border: `1px solid ${color}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1rem', flexShrink: 0 }}>
          {icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 600, color, background: `${color}10`, padding: '0.1rem 0.5rem', borderRadius: 100 }}>{label}</span>
            <span style={{ fontSize: '0.7rem', color: agentColor, fontWeight: 500 }}>{agentLabel}</span>
            {entry.key && <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>· {entry.key}</span>}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text)', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 120, overflow: 'hidden', maskImage: 'linear-gradient(to bottom, black 70%, transparent 100%)' }}>
            {contentDisplay}
          </div>
          <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
            Updated {formatDate(entry.updated_at)}
          </div>
        </div>
        <button
          className="btn btn-ghost"
          style={{ padding: '0.2rem', color: 'var(--text-muted)', flexShrink: 0 }}
          onClick={() => onDelete(entry.id)}
          title="Delete memory entry"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

export default function Memory() {
  const { request, loading } = useApi();
  const navigate = useNavigate();
  const [entries, setEntries] = useState([]);
  const [filter, setFilter] = useState('all');
  const [noteText, setNoteText] = useState('');
  const [saving, setSaving] = useState(false);
  const [showNoteForm, setShowNoteForm] = useState(false);
  const [error, setError] = useState(null);
  const [exportFiles, setExportFiles] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [copiedFile, setCopiedFile] = useState(null);

  useEffect(() => {
    request('/agents/memory')
      .then(res => setEntries(res?.data || []))
      .catch(err => setError('Failed to load data'));
  }, []);

  const handleDelete = async (id) => {
    try {
      await request(`/agents/memory/${id}`, { method: 'DELETE' });
      setEntries(prev => prev.filter(e => e.id !== id));
    } catch {}
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await request('/dashboard/obsidian-export');
      setExportFiles(res?.data?.files || []);
    } catch {}
    setExporting(false);
  };

  const handleCopy = (file) => {
    navigator.clipboard.writeText(file.content).then(() => {
      setCopiedFile(file.path);
      setTimeout(() => setCopiedFile(null), 2000);
    });
  };

  const handleAddNote = async () => {
    if (!noteText.trim()) return;
    setSaving(true);
    try {
      const res = await request('/agents/memory/journal', {
        method: 'POST',
        body: JSON.stringify({ text: noteText }),
      });
      if (res?.data) {
        setEntries(prev => [res.data, ...prev]);
        setNoteText('');
        setShowNoteForm(false);
      }
    } catch {}
    setSaving(false);
  };

  const types = ['all', ...new Set(entries.map(e => e.memory_type))];
  const filtered = filter === 'all' ? entries : entries.filter(e => e.memory_type === filter);

  const counts = entries.reduce((acc, e) => {
    acc[e.memory_type] = (acc[e.memory_type] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="fade-in">
      {error && (
        <div style={{ padding: '16px', background: 'rgba(239,68,68,0.1)', borderRadius: 'var(--radius)', color: 'var(--danger)', marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{error}</span>
          <button onClick={() => { setError(null); request('/agents/memory').then(res => setEntries(res?.data || [])).catch(err => setError('Failed to load data')); }} style={{ background: 'var(--danger)', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 'var(--radius)', cursor: 'pointer' }}>Retry</button>
        </div>
      )}
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Brain size={22} style={{ color: 'var(--purple)' }} />
          <div>
            <h1 className="page-title">Memory</h1>
            <p className="page-subtitle">{entries.length} stored {entries.length === 1 ? 'memory' : 'memories'} across all agents</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" style={{ fontSize: '0.8rem', gap: '0.4rem' }} onClick={() => navigate('/settings')}>
            <Settings size={14} /> Edit ICP <ChevronRight size={12} />
          </button>
          <button className="btn btn-secondary" style={{ fontSize: '0.8rem', gap: '0.4rem' }} onClick={handleExport} disabled={exporting}>
            <Download size={14} /> {exporting ? 'Generating…' : 'Export for Obsidian'}
          </button>
          <button className="btn btn-primary" onClick={() => setShowNoteForm(v => !v)}>
            <Plus size={15} /> Add note
          </button>
        </div>
      </div>

      {/* Obsidian Export Panel */}
      {exportFiles && (
        <div className="card fade-in" style={{ marginBottom: '1.25rem', border: '1px solid rgba(168,85,247,0.3)', background: 'rgba(168,85,247,0.05)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--purple)' }}>Obsidian Export</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>Copy each file into your Obsidian vault at the path shown</div>
            </div>
            <button className="btn btn-ghost" style={{ padding: '0.2rem' }} onClick={() => setExportFiles(null)}>
              <X size={16} />
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {exportFiles.map(file => (
              <div key={file.path} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem 0.75rem', borderBottom: '1px solid var(--border)' }}>
                  <code style={{ fontSize: '0.75rem', color: 'var(--purple)' }}>{file.path}</code>
                  <button
                    className="btn btn-ghost"
                    style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem', gap: '0.3rem', color: copiedFile === file.path ? 'var(--lime)' : 'var(--text-muted)' }}
                    onClick={() => handleCopy(file)}
                  >
                    {copiedFile === file.path ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
                  </button>
                </div>
                <pre style={{ padding: '0.75rem', fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.6, maxHeight: 160, overflowY: 'auto', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {file.content}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* What memory is */}
      <div style={{ background: 'rgba(168,85,247,0.06)', border: '1px solid rgba(168,85,247,0.15)', borderRadius: 'var(--radius)', padding: '0.875rem 1rem', marginBottom: '1.25rem', display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
        <BookOpen size={16} style={{ color: 'var(--purple)', marginTop: 2, flexShrink: 0 }} />
        <div style={{ fontSize: '0.82rem', lineHeight: 1.6, color: 'var(--text-muted)' }}>
          <span style={{ color: 'var(--text)', fontWeight: 500 }}>Memory is how the agents remember context across sessions.</span> ICP profiles are used by The Director when planning campaigns. Journal notes are your running log. You can add custom notes here — agents will reference them automatically.
        </div>
      </div>

      {/* Add note form */}
      {showNoteForm && (
        <div className="card" style={{ marginBottom: '1.25rem', padding: '1rem' }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.75rem' }}>Add journal note</div>
          <textarea
            className="form-input"
            rows={4}
            value={noteText}
            onChange={e => setNoteText(e.target.value)}
            placeholder="Write a note for your agents — context, instructions, things to remember..."
            style={{ resize: 'vertical', marginBottom: '0.75rem' }}
          />
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary" onClick={() => { setShowNoteForm(false); setNoteText(''); }}>Cancel</button>
            <button className="btn btn-primary" onClick={handleAddNote} disabled={!noteText.trim() || saving}>
              {saving ? 'Saving…' : 'Save note'}
            </button>
          </div>
        </div>
      )}

      {/* Stats row */}
      {entries.length > 0 && (
        <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
          {Object.entries(counts).map(([type, count]) => {
            const { label, color, icon } = typeInfo(type);
            return (
              <button
                key={type}
                onClick={() => setFilter(f => f === type ? 'all' : type)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.4rem',
                  background: filter === type ? `${color}15` : 'var(--bg)',
                  border: `1px solid ${filter === type ? color : 'var(--border)'}`,
                  borderRadius: 100, padding: '0.3rem 0.75rem',
                  cursor: 'pointer', fontSize: '0.75rem', color: filter === type ? color : 'var(--text-muted)',
                  fontWeight: filter === type ? 600 : 400, transition: 'all 0.15s',
                }}
              >
                {icon} {label} <span style={{ fontWeight: 700 }}>{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Entries */}
      {loading ? (
        Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="card skeleton" style={{ height: 100, marginBottom: '0.75rem' }} />
        ))
      ) : filtered.length === 0 ? (
        <EmptyState
          agent="director"
          title="No memories yet"
          description="The Director stores ICP profiles here. Add a journal note or configure your ICP in Settings."
        />
      ) : (
        filtered.map(entry => (
          <MemoryCard key={entry.id} entry={entry} onDelete={handleDelete} />
        ))
      )}
    </div>
  );
}
