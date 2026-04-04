# The Dam — Client Folder System

## Folder Structure

```
clients/
  _core/                  ← DO NOT EDIT — shared rules for all clients
    README.md             ← this file
    ranger-rules.md       ← hard Ranger gates, scoring, timing (enforced in code)
    agent-roles.md        ← pipeline overview, agent roles, memory system

  _template/              ← COPY THIS when onboarding a new client
    config.md             ← fill in ICP, persona, playbook, integrations

  beaver-solutions/       ← example: fully filled in
    config.md
  trl/
    config.md
  gamerexchange/
    config.md
```

---

## When to Edit What

| File | Who edits it | When |
|------|-------------|------|
| `_core/ranger-rules.md` | MJ only | When Ranger gates change globally (requires Railway deploy) |
| `_core/agent-roles.md` | MJ only | When the pipeline itself changes |
| `clients/[slug]/config.md` | MJ after discovery call | During onboarding, or when client updates their ICP |

---

## Adding a New Client

1. Run discovery call using `onboarding/discovery-questionnaire.md`
2. Create a new folder: `clients/[client-slug]/`
   - Slug must match the `slug` column in the `clients` DB table
   - Use lowercase, hyphens, no spaces (e.g. `trl`, `gamer-exchange`)
3. Copy `_template/config.md` → `clients/[client-slug]/config.md`
4. Fill in every section using answers from the discovery call
5. Add the client to the database (via admin panel or SQL)
6. Connect integrations: AgentMail inbox, Hunter.io, Apollo.io
7. Run test campaign: 3 leads → Ranger → Approval → Send
8. Confirm Ranger passing ≥ 80% first time
9. Get client to sign off on 3 sample messages
10. Activate autonomous kickoff

---

## Config.md Sections — What's Mandatory vs Optional

| Section | Mandatory? | Notes |
|---------|-----------|-------|
| Company Overview | ✅ Yes | Director reads this for context |
| One-Line ICP | ✅ Yes | Used in every kickoff brief |
| ICP 1 | ✅ Yes | Primary targeting segment |
| ICP 2 | Optional | Only if they have a clear secondary segment |
| Global ICP Rules | ✅ Yes | Signal priority, angle order |
| Agent Persona | ✅ Yes | Tone, value prop, CTA preference |
| Banned Phrases | ✅ Yes | Add client-specific words on top of global list |
| Outreach Playbook | ✅ Yes | Best angles, what to avoid, message structure |
| Integration Notes | ✅ Yes | Updated as integrations are connected |
| Onboarding Checklist | ✅ Yes | Track completion status |
