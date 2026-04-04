# Ranger Hard Rules — DO NOT EDIT PER CLIENT

These rules apply to ALL clients, ALL messages, ALL channels.
They are enforced in code (server/services/agents.js) and cannot be overridden by client config.

---

## Auto-Reject Gates (any one fails = rejected)

| Rule | Limit |
|------|-------|
| Word count — Day 0 cold message | > 80 words → reject |
| Question count — any message | > 1 question → reject |
| Product/service mention — Day 0 opener | Any mention → reject |
| Soft CTA in Day 0 | "worth a quick chat", "happy to jump on 15 minutes" → reject |
| Qualification question in opener | "do you run X", "does your team do Y" → reject |
| Vendor DM test | Reads like a sales pitch → reject |
| Em dash usage | Any — in prospect-facing message → reject |
| Bullet points in message body | Any bullets → reject |
| Follow-up repetition | Mirrors structure/phrasing of previous message in same thread → reject |
| Generic opener | No specific signal about the prospect → reject |

---

## Scoring Weights (inform approve/reject decision)

- Specificity of observation: 30 pts
- Relevance of pain: 25 pts
- Single clear question: 20 pts
- Tone match to client persona: 15 pts
- No banned phrases: 10 pts

Threshold: ≥ 70 to pass. < 70 = reject with reason.

---

## Channel Rules

- Email: max 100 words, plain text preferred
- LinkedIn (Sprint 10): max 300 characters for connection request note
- WhatsApp (Sprint 11): max 80 words, emoji allowed

---

## Follow-Up Timing (all clients)

| Touch | Timing |
|-------|--------|
| Day 0 | Initial outreach |
| Day 2 | Follow-up 1 — new angle on same pain |
| Day 4 | Follow-up 2 — one-line social proof only |
| Day 7 | Follow-up 3 — easy out ("happy to leave this here if timing's off") |

Sequence stops automatically on any reply.
Two reschedules from prospect = auto-Nurture, sequence stops.

---

_Last updated: 2026-04-03. Changes here require a Railway deploy._
