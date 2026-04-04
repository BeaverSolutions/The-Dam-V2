import React, { useState, useRef, useEffect } from 'react';
import { Send, Check, X, ChevronRight, Building2, User, ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import BeaverAvatar, { BEAVER_COLORS, BEAVER_LABELS } from '../components/BeaverAvatar';
import { useApi } from '../hooks/useApi';

function PlanSteps({ steps }) {
  return (
    <div style={{ marginTop: '0.75rem', background: 'var(--bg)', borderRadius: 'var(--radius)', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {steps.map(s => (
        <div key={s.step} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <BeaverAvatar agent={s.agent} size="xs" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: '0.7rem', fontWeight: 600, color: BEAVER_COLORS[s.agent] || 'var(--text-muted)' }}>
              {BEAVER_LABELS[s.agent] || s.agent.replace(/_/g, ' ')}
            </span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: '0.4rem' }}>{s.action}</span>
          </div>
          <ChevronRight size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        </div>
      ))}
    </div>
  );
}

function ExecutionResults({ results }) {
  const statusColors = { completed: 'var(--lime)', in_progress: 'var(--blue)', pending: 'var(--text-muted)', failed: 'var(--orange)' };
  return (
    <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      {results.map(r => (
        <div key={r.step} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.75rem' }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: statusColors[r.status] || 'var(--text-muted)', flexShrink: 0 }} />
          <BeaverAvatar agent={r.agent} size="xs" />
          <span style={{ color: statusColors[r.status] || 'var(--text-muted)', fontWeight: 500, textTransform: 'capitalize' }}>{r.status.replace(/_/g, ' ')}</span>
          {r.result && <span style={{ color: 'var(--text-muted)' }}>· {r.result}</span>}
        </div>
      ))}
    </div>
  );
}

function LeadsCard({ leads }) {
  if (!leads?.length) return null;
  return (
    <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.25rem' }}>
        {leads.length} lead{leads.length !== 1 ? 's' : ''} found
      </div>
      {leads.map((lead, i) => (
        <div key={i} style={{ background: 'var(--bg)', borderRadius: 6, padding: '0.5rem 0.75rem', border: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: lead.title || lead.short_description ? '0.2rem' : 0 }}>
            <Building2 size={11} style={{ color: 'var(--blue)', flexShrink: 0 }} />
            <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text)' }}>{lead.company || lead.name}</span>
            {lead.signal_tier && (
              <span style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--lime)', background: 'rgba(200,255,0,0.1)', padding: '0 0.3rem', borderRadius: 100 }}>{lead.signal_tier}</span>
            )}
          </div>
          {(lead.title || lead.name !== lead.company) && lead.company && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              <User size={10} style={{ flexShrink: 0 }} />
              {lead.name}{lead.title ? ` · ${lead.title}` : ''}
            </div>
          )}
          {lead.short_description && (
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.2rem', lineHeight: 1.4 }}>{lead.short_description}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function SummaryCard({ summary, onGoToApprovals }) {
  if (!summary) return null;
  const { leads_found = 0, messages_drafted = 0, approved = 0 } = summary;
  return (
    <div style={{ marginTop: '0.75rem', background: 'var(--bg)', borderRadius: 'var(--radius)', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Campaign Summary</div>
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--blue)', lineHeight: 1 }}>{leads_found}</div>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 2 }}>Leads found</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--lime)', lineHeight: 1 }}>{messages_drafted}</div>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 2 }}>Drafted</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--orange)', lineHeight: 1 }}>{approved}</div>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 2 }}>Ranger approved</div>
        </div>
      </div>
      {approved > 0 && (
        <button
          className="btn btn-primary"
          style={{ fontSize: '0.75rem', padding: '0.35rem 0.75rem', marginTop: '0.25rem', alignSelf: 'flex-start' }}
          onClick={onGoToApprovals}
        >
          Review {approved} message{approved !== 1 ? 's' : ''} in Approval Queue <ArrowRight size={12} />
        </button>
      )}
    </div>
  );
}

function Message({ msg }) {
  const navigate = useNavigate();
  const isUser = msg.role === 'user';
  return (
    <div style={{
      display: 'flex', gap: '0.75rem', alignItems: 'flex-start',
      justifyContent: isUser ? 'flex-end' : 'flex-start', marginBottom: '1rem',
    }}>
      {!isUser && <BeaverAvatar agent="director" size="xs" />}
      <div style={{
        maxWidth: '75%',
        background: isUser ? 'rgba(200,255,0,0.08)' : 'var(--panel)',
        border: `1px solid ${isUser ? 'rgba(200,255,0,0.2)' : 'var(--border)'}`,
        borderRadius: 'var(--radius)',
        padding: '0.75rem 1rem',
        fontSize: '0.875rem',
        lineHeight: 1.6,
      }}>
        <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>

        {/* Plan approval */}
        {msg.plan && !msg.plan.resolved && (
          <div style={{ marginTop: '0.75rem' }}>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Proposed plan</div>
            <PlanSteps steps={msg.plan.steps} />
            {msg.plan.estimated_leads && (
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                Estimated: <span style={{ color: 'var(--lime)' }}>~{msg.plan.estimated_leads} leads</span>
                {msg.plan.estimated_time && <span> · {msg.plan.estimated_time}</span>}
              </div>
            )}
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
              <button
                className="btn btn-primary"
                style={{ fontSize: '0.75rem', padding: '0.35rem 0.75rem' }}
                onClick={() => msg.plan.onApprove()}
              >
                <Check size={12} /> Approve & Execute
              </button>
              <button
                className="btn btn-danger"
                style={{ fontSize: '0.75rem', padding: '0.35rem 0.75rem' }}
                onClick={() => msg.plan.onReject()}
              >
                <X size={12} /> Reject
              </button>
            </div>
          </div>
        )}
        {msg.plan?.resolved === 'approved' && (
          <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--lime)' }}>
            <Check size={10} style={{ display: 'inline', marginRight: 4 }} />Plan approved — crew is executing
          </div>
        )}
        {msg.plan?.resolved === 'rejected' && (
          <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--orange)' }}>Plan rejected</div>
        )}
        {msg.plan?.resolved === 'expired' && (
          <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
            Session ended — this plan is no longer actionable
          </div>
        )}

        {/* Execution results */}
        {msg.results && <ExecutionResults results={msg.results} />}
        {msg.leads && <LeadsCard leads={msg.leads} />}
        {msg.summary && <SummaryCard summary={msg.summary} onGoToApprovals={() => navigate('/approvals')} />}
      </div>
    </div>
  );
}

const STORAGE_KEY = 'dam_director_chat';
const WELCOME_MSG = {
  id: 1,
  role: 'assistant',
  content: "Hi! I'm The Director. Tell me what you want to achieve — I'll create a plan and coordinate the crew.\n\nTry: \"Find 20 VP-level leads at Series B SaaS companies and start outreach\"",
};

// Strip non-serializable function refs before writing to storage.
// Plans that were pending approval are marked expired so stale buttons don't appear.
function serializeMessages(msgs) {
  return msgs.map(m => {
    if (!m.plan) return m;
    const { onApprove, onReject, ...planData } = m.plan;
    return {
      ...m,
      plan: {
        ...planData,
        resolved: planData.resolved === null ? 'expired' : planData.resolved,
      },
    };
  });
}

function loadMessages() {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Any plan that was still pending when the page unloaded is now expired
        return parsed.map(m =>
          m.plan && !m.plan.resolved
            ? { ...m, plan: { ...m.plan, resolved: 'expired' } }
            : m
        );
      }
    }
  } catch {}
  return [WELCOME_MSG];
}

export default function Chat() {
  const { request, loading } = useApi();
  const navigate = useNavigate();
  const [messages, setMessages] = useState(loadMessages);
  const [input, setInput] = useState('');
  const bottomRef = useRef(null);

  // Persist messages to sessionStorage whenever they change
  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(serializeMessages(messages)));
    } catch {}
  }, [messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async () => {
    if (!input.trim() || loading) return;
    const userMsg = { id: Date.now(), role: 'user', content: input };
    setMessages(prev => [...prev, userMsg]);
    const cmd = input;
    setInput('');

    try {
      const res = await request('/agents/director/plan', {
        method: 'POST',
        body: JSON.stringify({ command: cmd }),
      });

      if (res?.data) {
        const plan = res.data;

        // Director flagged this command as out of scope, or needs more info before planning
        if (plan.status === 'out_of_scope' || plan.status === 'clarification_needed') {
          setMessages(prev => [...prev, {
            id: Date.now() + 1,
            role: 'assistant',
            content: plan.message,
          }]);
          return;
        }

        const planMsgId = Date.now() + 1;

        const resolvePlan = (resolution) => {
          setMessages(prev => prev.map(m =>
            m.id === planMsgId && m.plan ? { ...m, plan: { ...m.plan, resolved: resolution } } : m
          ));

          if (resolution === 'approved') {
            request('/agents/director/execute', {
              method: 'POST',
              body: JSON.stringify({ plan_id: plan.plan_id, command: cmd }),
            }).then(execRes => {
              if (execRes?.data) {
                const { results, leads, summary } = execRes.data;
                const leadsFound = summary?.leads_found ?? leads?.length ?? 0;
                const approved = summary?.approved ?? 0;
                setMessages(prev => [...prev, {
                  id: Date.now(),
                  role: 'assistant',
                  content: leadsFound > 0
                    ? `Research Beaver found ${leadsFound} lead${leadsFound !== 1 ? 's' : ''}. The crew drafted and reviewed messages:`
                    : 'The crew executed the plan. Here\'s the status:',
                  results,
                  leads,
                  summary,
                }]);
              }
            }).catch(() => {});
          }
        };

        const interpretation = plan.interpretation && plan.interpretation !== cmd
          ? `I've interpreted your request as: "${plan.interpretation}"\n\nPlan ready — estimated ~${plan.estimated_leads} leads:`
          : `Plan ready for: "${cmd}" — estimated ~${plan.estimated_leads} leads:`;

        setMessages(prev => [...prev, {
          id: planMsgId,
          role: 'assistant',
          content: interpretation,
          plan: { ...plan, resolved: null, onApprove: () => resolvePlan('approved'), onReject: () => resolvePlan('rejected') },
        }]);
      }
    } catch (err) {
      setMessages(prev => [...prev, {
        id: Date.now(),
        role: 'assistant',
        content: `Sorry, something went wrong: ${err.message}`,
      }]);
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 56px - 3rem)' }}>
      <div className="page-header" style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <BeaverAvatar agent="director" size="md" animate />
          <div>
            <h1 className="page-title">Director Chat</h1>
            <p className="page-subtitle">Give commands — the crew executes</p>
          </div>
        </div>
        <button
          className="btn btn-ghost"
          style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}
          onClick={() => {
            sessionStorage.removeItem(STORAGE_KEY);
            setMessages([WELCOME_MSG]);
          }}
        >
          Clear chat
        </button>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: '1rem' }}>
        {messages.map(msg => <Message key={msg.id} msg={msg} />)}
        {loading && (
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', marginBottom: '1rem' }}>
            <BeaverAvatar agent="director" size="xs" animate />
            <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.75rem 1rem' }}>
              <div style={{ display: 'flex', gap: '4px' }}>
                {[0, 1, 2].map(i => (
                  <div key={i} className="skeleton" style={{ width: 6, height: 6, borderRadius: '50%', animationDelay: `${i * 0.15}s` }} />
                ))}
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{ display: 'flex', gap: '0.75rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
        <textarea
          className="form-input"
          rows={2}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Tell the Director what to do... (Enter to send, Shift+Enter for newline)"
          style={{ resize: 'none', flex: 1 }}
        />
        <button
          className="btn btn-primary"
          onClick={send}
          disabled={!input.trim() || loading}
          style={{ alignSelf: 'flex-end', padding: '0.625rem' }}
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}
