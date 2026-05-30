import React from 'react';

const sections = [
  {
    title: 'Data We Collect',
    body: [
      'Account details such as name, email address, company, role, plan, login state, and access-device records.',
      'Sales workflow data such as leads, messages, approvals, replies, meeting records, campaign settings, imports, and pipeline activity.',
      'Operational data such as usage logs, AI usage and spend records, diagnostics, integration status, and support/debug records.',
      'Connected-service data only when you configure an integration, such as Gmail, Google Calendar, Apollo, Hunter, Calendly, AgentMail, or Telegram.',
    ],
  },
  {
    title: 'Where Data Is Stored',
    body: [
      'Application data is stored in the BeavrDam production database. Tenant-scoped tables use client identifiers and row-level security policies as a defense-in-depth boundary.',
      'Integration secrets are stored server-side as encrypted records. Browser code does not receive provider API keys or raw connected-service secrets.',
      'The app uses an httpOnly authentication cookie for signed-in sessions. The browser may store non-secret interface state such as the current user profile and draft text.',
    ],
  },
  {
    title: 'How We Use Data',
    body: [
      'We use customer data to operate the BeavrDam sales workflow, route work through the beaver crew, generate drafts, track approvals, prepare reporting, and provide support.',
      'We use operational telemetry to protect uptime, investigate errors, enforce spend limits, detect abuse, and improve product reliability.',
      'We do not sell customer data.',
    ],
  },
  {
    title: 'Security Controls',
    body: [
      'Secrets are kept server-side, sensitive integrations are encrypted at rest, and production authentication uses httpOnly cookies.',
      'API routes are protected with authentication, authorization checks, validation, security headers, and rate limits.',
      'Manual invoice and billing-intent records are stored in the app until payment processing is connected.',
    ],
  },
  {
    title: 'Data Requests',
    body: [
      'Customers can request export, correction, or deletion of their account and workspace data by contacting Beaver Solutions.',
      'Some records may be retained where needed for security, billing, legal, or abuse-prevention purposes.',
    ],
  },
];

export default function Privacy() {
  return (
    <main style={{ minHeight: '100vh', background: 'var(--bg)', padding: '2rem 1rem' }}>
      <div style={{ width: '100%', maxWidth: 860, margin: '0 auto' }}>
        <a href="/login" style={{ color: 'var(--brand)', fontSize: '0.85rem', fontWeight: 700 }}>
          Beaver Solutions
        </a>
        <header style={{ margin: '1.5rem 0 2rem' }}>
          <h1 style={{ fontSize: '2rem', lineHeight: 1.2, marginBottom: '0.75rem' }}>Privacy Policy</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem', maxWidth: 720 }}>
            This policy explains what BeavrDam collects, where customer data is stored, and how Beaver Solutions uses it to run the service.
          </p>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '0.75rem' }}>
            Last updated: May 31, 2026
          </p>
        </header>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {sections.map(section => (
            <section key={section.title}>
              <h2 style={{ fontSize: '1rem', marginBottom: '0.625rem' }}>{section.title}</h2>
              <ul style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', paddingLeft: '1.2rem', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                {section.body.map(item => <li key={item}>{item}</li>)}
              </ul>
            </section>
          ))}
        </div>

        <footer style={{ marginTop: '2rem', paddingTop: '1rem', borderTop: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          Questions or requests: <a href="mailto:privacy@beaver.solutions" style={{ color: 'var(--brand)' }}>privacy@beaver.solutions</a>
        </footer>
      </div>
    </main>
  );
}
