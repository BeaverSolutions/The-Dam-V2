import React, { useState, useRef } from 'react';
import { Upload, FileText, CheckCircle, AlertCircle, ChevronDown, ArrowRight, RotateCcw, Download } from 'lucide-react';
import { useApi } from '../hooks/useApi';

const LEAD_FIELDS = [
  { key: 'name',         label: 'Full Name',     required: true },
  { key: 'company',      label: 'Company',       required: true },
  { key: 'email',        label: 'Email' },
  { key: 'title',        label: 'Job Title' },
  { key: 'linkedin_url', label: 'LinkedIn URL' },
  { key: 'website',      label: 'Website' },
  { key: 'industry',     label: 'Industry' },
  { key: 'company_size', label: 'Company Size' },
  { key: 'signal',       label: 'Signal (specific buying trigger)' },
  { key: 'why_now',      label: 'Why Now (timing reason)' },
  { key: 'angle',        label: 'Angle (opening hook)' },
  { key: 'friction',     label: 'Friction (operational pain)' },
  { key: 'signal_tier',  label: 'Signal Tier (P1/P2/P3)' },
  { key: 'notes',        label: 'Notes' },
];

const IMPORT_SOURCES = [
  {
    key: 'vibe_csv',
    title: 'Vibe CSV',
    description: 'User-prompted Vibe export. Emails are trusted and skip MillionVerifier.',
  },
  {
    key: 'csv_import',
    title: 'Standard CSV',
    description: 'Generic lead list from Apollo, LinkedIn, WaveLeads, or another source.',
  },
];

// Try to auto-match CSV headers to lead fields
function autoMap(headers) {
  const mapping = {};
  const normalize = s => s.toLowerCase().replace(/[\s_\-\.]/g, '');
  const matchers = {
    name:         ['name', 'fullname', 'contactname', 'firstname', 'person'],
    company:      ['company', 'companyname', 'organisation', 'organization', 'account'],
    email:        ['email', 'emailaddress', 'mail', 'directemail'],
    title:        ['title', 'jobtitle', 'position', 'role', 'designation'],
    linkedin_url: ['linkedin', 'linkedinurl', 'linkedinprofile'],
    website:      ['website', 'url', 'domain', 'web', 'websiteurl'],
    industry:     ['industry', 'sector', 'vertical'],
    company_size: ['companysize', 'employees', 'headcount', 'size', 'numberofemployees'],
    signal:       ['signal', 'trigger', 'reason', 'buyingsignal'],
    why_now:      ['whynow', 'timing', 'urgency'],
    angle:        ['angle', 'hook', 'opener', 'pitch'],
    friction:     ['friction', 'pain', 'painpoint', 'problem', 'challenge'],
    signal_tier:  ['signaltier', 'tier', 'priority'],
    notes:        ['notes', 'comments', 'description', 'memo'],
  };
  for (const [field, patterns] of Object.entries(matchers)) {
    for (const header of headers) {
      if (patterns.includes(normalize(header))) {
        mapping[field] = header;
        break;
      }
    }
  }
  return mapping;
}

function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return { headers: [], rows: [] };

  const parseRow = (line) => {
    const result = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (c === ',' && !inQuote) {
        result.push(cur.trim());
        cur = '';
      } else {
        cur += c;
      }
    }
    result.push(cur.trim());
    return result;
  };

  const headers = parseRow(lines[0]);
  const rows = lines.slice(1)
    .filter(l => l.trim())
    .map(line => {
      const vals = parseRow(line);
      const obj = {};
      headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
      return obj;
    });

  return { headers, rows };
}

export default function Import() {
  const { request } = useApi();
  const fileRef = useRef();
  const [step, setStep] = useState('upload'); // upload | map | preview | done
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [mapping, setMapping] = useState({});
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState('');
  const [importSource, setImportSource] = useState('vibe_csv');
  const [error, setError] = useState(null); // A9-01: was used but never declared → crash on import failure

  const handleFile = (file) => {
    if (!file || !file.name.endsWith('.csv')) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const { headers, rows } = parseCSV(e.target.result);
      if (!headers.length) return;
      setHeaders(headers);
      setRows(rows);
      setMapping(autoMap(headers));
      setStep('map');
    };
    reader.readAsText(file);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    handleFile(e.dataTransfer.files[0]);
  };

  const handleImport = async () => {
    setError(null);
    if (rows.length > 500) {
      setError('Max 500 rows allowed per import');
      return;
    }
    setImporting(true);
    try {
      const res = await request('/import/leads', {
        method: 'POST',
        body: JSON.stringify({ rows, mapping, source: importSource }),
      });
      setResult(res?.data);
      setStep('done');
    } catch (err) { setError('Import failed: ' + (err.message || 'Unknown error')); }
    setImporting(false);
  };

  const reset = () => {
    setStep('upload');
    setHeaders([]);
    setRows([]);
    setMapping({});
    setResult(null);
    setFileName('');
    setImportSource('vibe_csv');
  };

  const previewRows = rows.slice(0, 5);
  const mappedFields = LEAD_FIELDS.filter(f => mapping[f.key]);

  return (
    <div className="fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Import Leads</h1>
          <p className="page-subtitle">Upload a CSV from WaveLeads, Apollo, LinkedIn, or any source</p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <a
            href="/beaver-lead-template.csv"
            download="beaver-lead-template.csv"
            className="btn btn-secondary"
            style={{ textDecoration: 'none' }}
          >
            <Download size={14} /> Download template
          </a>
          {step !== 'upload' && (
            <button className="btn btn-secondary" onClick={reset}>
              <RotateCcw size={14} /> Start over
            </button>
          )}
        </div>
      </div>

      {/* Step indicators */}
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '1.5rem' }}>
        {['Upload', 'Map columns', 'Import'].map((label, i) => {
          const stepKeys = ['upload', 'map', 'done'];
          const active = stepKeys[i] === step || (step === 'preview' && i === 1);
          const done = stepKeys.indexOf(step) > i;
          return (
            <React.Fragment key={label}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <div style={{
                  width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '0.7rem', fontWeight: 700,
                  background: done ? 'var(--lime)' : active ? 'rgba(200,255,0,0.15)' : 'var(--bg)',
                  color: done ? 'var(--bg)' : active ? 'var(--lime)' : 'var(--text-muted)',
                  border: `1px solid ${done ? 'var(--lime)' : active ? 'rgba(200,255,0,0.4)' : 'var(--border)'}`,
                }}>
                  {done ? '✓' : i + 1}
                </div>
                <span style={{ fontSize: '0.8rem', color: active ? 'var(--text)' : 'var(--text-muted)', fontWeight: active ? 500 : 400 }}>{label}</span>
              </div>
              {i < 2 && <div style={{ width: 24, height: 1, background: 'var(--border)' }} />}
            </React.Fragment>
          );
        })}
      </div>

      {/* Step 1: Upload */}
      {step === 'upload' && (
        <>
        <div className="card" style={{ marginBottom: '1rem' }}>
          <div style={{ fontWeight: 600, marginBottom: '0.75rem' }}>Import source</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.75rem' }}>
            {IMPORT_SOURCES.map(option => {
              const active = importSource === option.key;
              return (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => setImportSource(option.key)}
                  style={{
                    textAlign: 'left',
                    background: active ? 'rgba(200,255,0,0.08)' : 'var(--bg)',
                    border: `1px solid ${active ? 'rgba(200,255,0,0.35)' : 'var(--border)'}`,
                    borderRadius: 'var(--radius)',
                    padding: '0.85rem 1rem',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontWeight: 600, color: active ? 'var(--lime)' : 'var(--text)' }}>
                    {active && <CheckCircle size={14} />}
                    {option.title}
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.35rem', lineHeight: 1.45 }}>
                    {option.description}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileRef.current?.click()}
          style={{
            border: `2px dashed ${dragOver ? 'var(--lime)' : 'var(--border)'}`,
            borderRadius: 'var(--radius)',
            padding: '4rem 2rem',
            textAlign: 'center',
            cursor: 'pointer',
            background: dragOver ? 'rgba(200,255,0,0.04)' : 'var(--panel)',
            transition: 'all 0.2s',
          }}
        >
          <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={e => handleFile(e.target.files[0])} />
          <Upload size={36} style={{ color: 'var(--lime)', marginBottom: '1rem' }} />
          <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>Drop your CSV here or click to browse</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>WaveLeads · Apollo · LinkedIn Sales Nav · Any CSV · Max 500 rows</div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.75rem' }}>
            Using Excel? File → Save As → CSV UTF-8 before uploading. Click <strong>Download template</strong> above for the recommended format.
          </div>
        </div>
        </>
      )}

      {/* Step 2: Map columns */}
      {step === 'map' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
          {/* Mapping table */}
          <div className="card">
            <div style={{ fontWeight: 600, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <FileText size={16} style={{ color: 'var(--lime)' }} /> Column mapping
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 400, marginLeft: '0.25rem' }}>Auto-mapped from "{fileName}" as {IMPORT_SOURCES.find(s => s.key === importSource)?.title}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
              {LEAD_FIELDS.map(field => (
                <div key={field.key} style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: '0.5rem' }}>
                  <div style={{ fontSize: '0.8rem', color: field.required ? 'var(--text)' : 'var(--text-muted)', fontWeight: field.required ? 600 : 400 }}>
                    {field.label}{field.required && <span style={{ color: 'var(--orange)', marginLeft: 2 }}>*</span>}
                  </div>
                  <ArrowRight size={12} style={{ color: 'var(--border)' }} />
                  <select
                    className="form-input"
                    style={{ fontSize: '0.78rem', padding: '0.3rem 0.5rem' }}
                    value={mapping[field.key] || ''}
                    onChange={e => setMapping(m => ({ ...m, [field.key]: e.target.value || undefined }))}
                  >
                    <option value="">— skip —</option>
                    {headers.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </div>

          {/* Preview */}
          <div className="card">
            <div style={{ fontWeight: 600, marginBottom: '1rem' }}>Preview ({rows.length} rows)</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
                <thead>
                  <tr>
                    {mappedFields.map(f => (
                      <th key={f.key} style={{ textAlign: 'left', padding: '0.375rem 0.5rem', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                        {f.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                      {mappedFields.map(f => (
                        <td key={f.key} style={{ padding: '0.375rem 0.5rem', color: 'var(--text)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {row[mapping[f.key]] || <span style={{ color: 'var(--text-muted)' }}>—</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > 5 && (
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.5rem', textAlign: 'center' }}>
                  +{rows.length - 5} more rows
                </div>
              )}
            </div>

            <button
              className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center', marginTop: '1.25rem' }}
              onClick={handleImport}
              disabled={importing || (!mapping.name && !mapping.company)}
            >
              {importing ? 'Importing…' : `Import ${rows.length} leads`}
            </button>
            {!mapping.name && !mapping.company && (
              <div style={{ fontSize: '0.75rem', color: 'var(--orange)', marginTop: '0.5rem', textAlign: 'center' }}>
                Map at least Name or Company to continue
              </div>
            )}
            {error && (
              <div style={{ fontSize: '0.8rem', color: 'var(--red, #ff4444)', marginTop: '0.75rem', textAlign: 'center' }}>
                {error}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Step 3: Done */}
      {step === 'done' && result && (
        <div className="card" style={{ maxWidth: 480, margin: '0 auto', textAlign: 'center', padding: '2.5rem' }}>
          <CheckCircle size={48} style={{ color: 'var(--lime)', marginBottom: '1rem' }} />
          <h2 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: '0.5rem' }}>Import complete</h2>
          <div style={{ display: 'flex', justifyContent: 'center', gap: '1.5rem', margin: '1.5rem 0' }}>
            <div>
              <div style={{ fontSize: '2rem', fontWeight: 700, color: 'var(--lime)' }}>{result.imported}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Imported</div>
            </div>
            <div>
              <div style={{ fontSize: '2rem', fontWeight: 700, color: 'var(--text-muted)' }}>{result.skipped}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Skipped (duplicates)</div>
            </div>
            {result.failed > 0 && (
              <div>
                <div style={{ fontSize: '2rem', fontWeight: 700, color: 'var(--orange)' }}>{result.failed}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Failed</div>
              </div>
            )}
          </div>
          {result.errors?.length > 0 && (
            <div style={{ background: 'rgba(255,140,0,0.08)', border: '1px solid rgba(255,140,0,0.2)', borderRadius: 'var(--radius)', padding: '0.75rem', marginBottom: '1rem', textAlign: 'left' }}>
              {result.errors.map((e, i) => (
                <div key={i} style={{ fontSize: '0.75rem', color: 'var(--orange)', display: 'flex', gap: '0.4rem' }}>
                  <AlertCircle size={12} style={{ flexShrink: 0, marginTop: 2 }} /> {e}
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
            <button className="btn btn-secondary" onClick={reset}><RotateCcw size={14} /> Import more</button>
            <a href="/pipeline" className="btn btn-primary">View in Pipeline</a>
          </div>
        </div>
      )}
    </div>
  );
}
