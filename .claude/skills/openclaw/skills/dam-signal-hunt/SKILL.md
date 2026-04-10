---
name: dam-signal-hunt
description: Proactively hunt for buying signals (funding, hiring, expansion, leadership changes) every 6 hours. Traces signals back to companies, finds decision makers, enriches emails, and creates leads in The Dam. Use when MJ says "hunt signals", "find signals", or on the 6-hour schedule.
---

# dam-signal-hunt

## Purpose
Proactively hunt for buying signals in target markets. Instead of searching for people and hoping they're relevant, find signals first (funding, hiring, expansion, leadership changes), trace them back to companies, then find the decision maker. This is the core intelligence loop that makes The Dam's outreach timely and relevant.

## Trigger
- Schedule: Every 6 hours, 7 days a week (6:00 AM, 12:00 PM, 6:00 PM, 12:00 AM)
- Manual: Roy says "hunt signals", "find signals", "signal hunt for [industry]", "what's happening in [market]"

## Dependencies
- dam-authenticate must have run (DAM_TOKEN available)

## Shared Memory Contract
MyClaw and Claude share the same agent_memory table. Before every run, read memory to stay aligned.

### Memory Keys Used
| Key | Type | Read/Write | Purpose |
|-----|------|------------|---------|
| `signal_hunt_config` | config | Read | ICP industries, geographies, signal types to prioritise |
| `signal_hunt_log` | journal | Write | What was searched, what was found, when |
| `signal_patterns` | pattern | Read/Write | Which signal types produce best leads (learned over time) |
| `used_signal_queries` | key | Read/Write | Track used queries to avoid repetition |
| `icp` | icp | Read | Client ICP — industries, titles, geographies |
| `schema_facts` | key | Read | Verified DB column names and API facts |
| `myclaw_rejections` | pattern | Read | Enforcer rejection patterns to avoid |

## Steps

### Step 0 — Read shared memory
```
GET {DAM_URL}/api/myclaw/memory?client_id={CLIENT_ID}&key=icp
Authorization: Bearer {DAM_TOKEN}
```

Extract ICP: `industries`, `job_titles`, `geographies`, `company_size`.

```
GET {DAM_URL}/api/myclaw/memory?client_id={CLIENT_ID}&key=signal_hunt_config
Authorization: Bearer {DAM_TOKEN}
```

Extract config: `priority_signals`, `excluded_companies`, `min_signal_age_days` (default 30).

```
GET {DAM_URL}/api/myclaw/memory?client_id={CLIENT_ID}&key=used_signal_queries
Authorization: Bearer {DAM_TOKEN}
```

Extract previously used queries to avoid repetition.

If no ICP found → STOP. Send Telegram: "⚠️ No ICP defined for {CLIENT_NAME}. Cannot hunt signals without knowing who to look for. Define ICP first."

### Step 1 — Build signal queries
Generate search queries targeting SIGNALS, not people. Combine ICP industries with signal types.

**Signal types (in priority order):**
1. Funding — `"{industry}" Malaysia "raised" OR "funding" OR "Series A" OR "seed round" 2026`
2. Hiring — `"{industry}" Malaysia "hiring" OR "looking for" OR "we're growing" OR "job opening" 2026`
3. Expansion — `"{industry}" Malaysia "new office" OR "expanding" OR "launched in" OR "entered" 2026`
4. Leadership change — `"{industry}" Malaysia "new CEO" OR "appointed" OR "joins as" OR "promoted to" 2026`
5. Product launch — `"{industry}" Malaysia "launched" OR "introducing" OR "new product" OR "new service" 2026`
6. Pain signals — `"{industry}" Malaysia "struggling with" OR "looking for solutions" OR "challenges" 2026`

Also add news-specific queries:
- `site:e27.co "{industry}" Malaysia 2026`
- `site:techinasia.com "{industry}" Malaysia 2026`
- `site:thestar.com.my "{industry}" funding OR hiring OR expansion 2026`

Use up to 10 queries per run. Rotate through industries across runs. Skip queries already in `used_signal_queries`.

### Step 2 — Execute signal search
For each query:
```
POST {DAM_URL}/api/myclaw/signal-search
Authorization: Bearer {DAM_TOKEN}
Content-Type: application/json

{
  "client_id": "{CLIENT_ID}",
  "queries": [
    { "query": "{signal_query}", "signal_type": "funding|hiring|expansion|leadership|product_launch|pain" }
  ],
  "max_results_per_query": 5
}
```

Response:
```json
{
  "data": {
    "signals": [
      {
        "company": "Acme Sdn Bhd",
        "signal_type": "funding",
        "signal_summary": "Raised RM2M seed round led by 500 Global",
        "signal_date": "2026-03-15",
        "source_url": "https://e27.co/...",
        "raw_snippet": "...",
        "confidence": 0.85
      }
    ],
    "queries_used": 10,
    "signals_found": 4
  }
}
```

### Step 3 — Validate each signal
For each signal with confidence >= 0.6:

**3a — Check if company already exists as a lead:**
```
GET {DAM_URL}/api/myclaw/leads?client_id={CLIENT_ID}&limit=100
Authorization: Bearer {DAM_TOKEN}
```

Search response for matching company name. If company already in pipeline → skip (unless signal is newer than existing record and adds new context).

**3b — ICP fit check:**
Use AI (Haiku) to evaluate: "Given ICP {industries, company_size, geographies}, does {company} from {signal} fit? Return: fit (yes/no), reason, confidence."

If not a fit → discard.

### Step 4 — Find decision maker
For each validated signal, search for the decision maker:
```
POST {DAM_URL}/api/myclaw/signal-search
Authorization: Bearer {DAM_TOKEN}

{
  "client_id": "{CLIENT_ID}",
  "queries": [
    { "query": "site:linkedin.com/in \"{company_name}\" {icp_title}", "signal_type": "person_search" }
  ],
  "max_results_per_query": 3
}
```

Use Haiku to extract: name, title, LinkedIn URL from search results.

If no person found via LinkedIn search, try:
- `"{company_name}" CEO OR Founder OR "Managing Director"`
- Company website /about or /team page (if discoverable)

### Step 5 — Enrich with email
For each person found:
```
POST {DAM_URL}/api/agents/research/enrich
Authorization: Bearer {DAM_TOKEN}

{
  "name": "{name}",
  "company": "{company}",
  "domain": "{company_domain}"
}
```

Or use Hunter directly if endpoint not available.

### Step 6 — Create leads with signal context
For each enriched lead:
```
POST {DAM_URL}/api/myclaw/leads
Authorization: Bearer {DAM_TOKEN}
Content-Type: application/json

{
  "client_id": "{CLIENT_ID}",
  "name": "{person_name}",
  "company": "{company_name}",
  "email": "{email}",
  "title": "{title}",
  "linkedin_url": "{linkedin_url}",
  "signal_tier": "P1",
  "signal": "{signal_summary}",
  "angle": "{angle based on signal}",
  "friction": "{inferred friction from signal}",
  "why_now": "{signal_date}: {signal_type} — {signal_summary}",
  "notes": "Source: {source_url}",
  "myclaw_confidence": 0.85,
  "myclaw_notes": "Signal-hunted lead. Signal type: {signal_type}. Signal date: {signal_date}."
}
```

### Step 7 — Update shared memory
Write the signal hunt results to memory so Claude and MyClaw stay aligned:

```
POST {DAM_URL}/api/myclaw/memory
Authorization: Bearer {DAM_TOKEN}
Content-Type: application/json

{
  "client_id": "{CLIENT_ID}",
  "agent": "captain_beaver",
  "memory_type": "journal",
  "key": "signal_hunt_log",
  "content": {
    "last_run": "{timestamp}",
    "queries_used": 10,
    "signals_found": 4,
    "leads_created": 2,
    "signal_types_found": ["funding", "hiring"],
    "industries_searched": ["marketing agency", "SaaS"],
    "next_industries": ["fintech", "consulting"]
  }
}
```

Update used queries:
```
POST {DAM_URL}/api/myclaw/memory
Authorization: Bearer {DAM_TOKEN}

{
  "client_id": "{CLIENT_ID}",
  "agent": "research_beaver",
  "memory_type": "key",
  "key": "used_signal_queries",
  "content": { "queries": ["{all queries used this run + previous}"] }
}
```

### Step 8 — Report to Roy
If leads were created, send Telegram:
```
🔍 Signal Hunt Complete

📡 Signals detected: {signals_found}
🏢 Companies validated: {companies_validated}
👤 Leads created: {leads_created}

Top signals:
{for each lead created:}
• {company} — {signal_type}: {signal_summary} → {person_name} ({title})

{if leads_created > 0: "Ready for outreach. Run 'start campaign' or wait for next scheduled batch."}
{if leads_created == 0: "No new signals matched ICP this cycle. Next hunt in 6 hours."}
```

If no signals found at all: Stay silent (don't spam Roy with empty results).

### Step 9 — Learn and adapt
After every 5 runs, check which signal types produced leads that got replies:
```
GET {DAM_URL}/api/myclaw/memory?client_id={CLIENT_ID}&key=signal_patterns
Authorization: Bearer {DAM_TOKEN}
```

Update signal priority order based on what works:
- Signal type with highest reply rate → move to top of query generation
- Signal type with zero results after 3 runs → deprioritise

```
POST {DAM_URL}/api/myclaw/memory
Authorization: Bearer {DAM_TOKEN}

{
  "client_id": "{CLIENT_ID}",
  "agent": "captain_beaver",
  "memory_type": "pattern",
  "key": "signal_patterns",
  "content": {
    "priority_order": ["hiring", "funding", "expansion", "leadership", "product_launch"],
    "best_performing": "hiring",
    "worst_performing": "product_launch",
    "total_runs": 15,
    "total_leads_created": 23,
    "last_updated": "{timestamp}"
  }
}
```

## Multi-Client Support
This skill runs per client. On scheduled runs, iterate through all active clients:
1. Fetch client list from The Dam
2. For each client with a defined ICP, run Steps 0–9
3. Use each client's own ICP and memory — never mix data between clients

## Error Handling
- If Serper/CSE returns empty: Try next query, log. After 3 empty queries in a row → switch to backup search engine.
- If Hunter returns no email: Still create the lead with LinkedIn only. Mark `email` as null. Lead can be manually enriched later.
- If API returns 401: Run dam-authenticate, retry once.
- If signal-search endpoint returns 500: Log error, send Telegram "⚠️ Signal hunt failed: {error}. Check Railway logs.", skip to next client.
- If run exceeds 15 minutes: Abort remaining queries, report partial results, log timeout.

## Cost Control
- Max 10 Serper queries per run per client (60 queries/day across all clients)
- Max 5 Hunter lookups per run per client (30/day across all clients)
- Max 20 Haiku calls per run per client (validation + person extraction)
- Track costs in signal_hunt_log memory for monitoring

## Golden Rule
Signal-hunted leads follow the same pipeline as all other leads:
**Sales Beaver → Enforcer Beaver → Roy's Approval → Send**
NO message ever sends without passing through Enforcer AND Roy. Signal hunting accelerates research, not approval.
