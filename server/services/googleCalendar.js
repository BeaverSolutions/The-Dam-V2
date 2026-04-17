'use strict';

const secrets = require('./secrets');
const pool = require('../db/pool');

let google;
try {
  google = require('googleapis').google;
} catch {
  // googleapis not installed
}

/* ─── OAuth client ───────────────────────────────────────── */

function getOAuthClient() {
  if (!google) return null;
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    (process.env.GMAIL_REDIRECT_URI || '').replace('/gmail/', '/calendar/') || process.env.GOOGLE_CALENDAR_REDIRECT_URI || 'http://localhost:3001/api/integrations/calendar/callback'
  );
}

function getAuthUrl(clientId) {
  const client = getOAuthClient();
  if (!client) return null;
  const { signOAuthState } = require('../utils/crypto');
  const sig = signOAuthState(clientId);
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'select_account consent',
    state: Buffer.from(JSON.stringify({ clientId, sig })).toString('base64'),
    scope: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
  });
}

/* ─── Token storage ──────────────────────────────────────── */

async function storeTokens(clientId, tokens) {
  await secrets.setClientSecret(clientId, 'system', 'calendar_tokens', tokens);
}

async function getTokens(clientId) {
  return secrets.getClientSecret(clientId, 'system', 'calendar_tokens');
}

async function isConnected(clientId) {
  const tokens = await getTokens(clientId);
  return !!tokens;
}

async function getConnectedEmail(clientId) {
  if (!google) return null;
  const tokens = await getTokens(clientId);
  if (!tokens) return null;
  try {
    const client = getOAuthClient();
    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const info = await oauth2.userinfo.get();
    return info.data.email || null;
  } catch {
    return null;
  }
}

async function disconnect(clientId) {
  await secrets.deleteClientSecret(clientId, 'system', 'calendar_tokens');
}

/* ─── Exchange auth code ─────────────────────────────────── */

async function exchangeCode(clientId, code) {
  const client = getOAuthClient();
  if (!client) throw new Error('Google Calendar OAuth not configured');
  const { tokens } = await client.getToken(code);
  await storeTokens(clientId, tokens);
  return tokens;
}

/* ─── Authed calendar client ─────────────────────────────── */

async function getCalendarClient(clientId) {
  if (!google) return null;
  const tokens = await getTokens(clientId);
  if (!tokens) return null;
  const client = getOAuthClient();
  client.setCredentials(tokens);
  // Auto-refresh tokens
  client.on('tokens', async (newTokens) => {
    const latest = await getTokens(clientId);
    await storeTokens(clientId, { ...(latest || tokens), ...newTokens });
  });
  return google.calendar({ version: 'v3', auth: client });
}

/* ─── Free/busy query ────────────────────────────────────── */

async function getFreeBusy(clientId, timeMin, timeMax) {
  const cal = await getCalendarClient(clientId);
  if (!cal) return [];
  try {
    const res = await cal.freebusy.query({
      requestBody: {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        timeZone: 'Asia/Kuala_Lumpur',
        items: [{ id: 'primary' }],
      },
    });
    return res.data?.calendars?.primary?.busy || [];
  } catch (err) {
    console.warn('[googleCalendar] getFreeBusy failed:', err.message);
    return [];
  }
}

/* ─── Suggest 3 available 30-min slots ──────────────────── */

/**
 * Returns up to 3 available 30-min slots in the next 5 working days
 * between 9am and 6pm MYT (GMT+8).
 * Returns human-readable strings like "Thursday 24 Apr, 10:00am MYT"
 */
async function suggestSlots(clientId) {
  const MYT_OFFSET = 8 * 60; // minutes ahead of UTC

  // Build candidate slots: next 5 working days, 9am-6pm MYT, 30-min increments
  const now = new Date();
  const candidates = [];
  let daysChecked = 0;
  let d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);

  while (daysChecked < 5) {
    d.setDate(d.getDate() + 1);
    const dayOfWeek = d.getUTCDay();
    // Skip weekends (0=Sun, 6=Sat) — adjust for MYT offset
    const mytDate = new Date(d.getTime() + MYT_OFFSET * 60000);
    if (mytDate.getDay() === 0 || mytDate.getDay() === 6) continue;
    daysChecked++;

    // 9am to 5:30pm MYT in 30-min slots
    for (let hour = 9; hour < 18; hour++) {
      for (const min of [0, 30]) {
        if (hour === 17 && min === 30) continue; // skip 5:30pm start (ends at 6pm)
        const slotUtc = new Date(mytDate.getFullYear(), mytDate.getMonth(), mytDate.getDate(), hour - 8, min, 0, 0);
        // Only future slots
        if (slotUtc > now) {
          candidates.push(slotUtc);
        }
      }
    }
  }

  if (candidates.length === 0) return [];

  // Fetch busy periods for the whole window
  const busy = await getFreeBusy(clientId, candidates[0], new Date(candidates[candidates.length - 1].getTime() + 30 * 60000));

  // Filter out busy slots
  const available = candidates.filter(slot => {
    const slotEnd = new Date(slot.getTime() + 30 * 60000);
    return !busy.some(b => {
      const bStart = new Date(b.start);
      const bEnd = new Date(b.end);
      return slot < bEnd && slotEnd > bStart;
    });
  });

  // Return first 3 as human-readable strings
  return available.slice(0, 3).map(slot => {
    const myt = new Date(slot.getTime() + MYT_OFFSET * 60000);
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const h = myt.getUTCHours();
    const m = myt.getUTCMinutes();
    const ampm = h >= 12 ? 'pm' : 'am';
    const h12 = h % 12 || 12;
    const mStr = m === 0 ? '' : `:${String(m).padStart(2, '0')}`;
    return `${days[myt.getUTCDay()]} ${myt.getUTCDate()} ${months[myt.getUTCMonth()]}, ${h12}${mStr}${ampm} MYT`;
  });
}

/* ─── Upcoming events ────────────────────────────────────── */

async function getUpcomingEvents(clientId, days = 7) {
  const cal = await getCalendarClient(clientId);
  if (!cal) return [];
  try {
    const now = new Date();
    const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const res = await cal.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: future.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    });
    return res.data?.items || [];
  } catch (err) {
    console.warn('[googleCalendar] getUpcomingEvents failed:', err.message);
    return [];
  }
}

/* ─── Sync meetings → leads ──────────────────────────────── */

/**
 * Fetch calendar events from the last 7 days, match attendee emails to leads,
 * upsert into calendar_events table, and auto-advance matched leads to meeting_booked.
 */
async function syncMeetings(clientId) {
  const cal = await getCalendarClient(clientId);
  if (!cal) return 0;

  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const res = await cal.events.list({
      calendarId: 'primary',
      timeMin: weekAgo.toISOString(),
      timeMax: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(), // also look ahead 30d
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100,
    });

    const events = res.data?.items || [];
    let synced = 0;

    for (const event of events) {
      const googleEventId = event.id;
      if (!googleEventId) continue;

      // Collect all attendee emails
      const attendeeEmails = (event.attendees || [])
        .map(a => a.email?.toLowerCase())
        .filter(Boolean);

      if (attendeeEmails.length === 0) continue;

      const startTime = event.start?.dateTime || event.start?.date;
      const endTime = event.end?.dateTime || event.end?.date;
      if (!startTime) continue;

      // Find matching leads by email
      const { rows: matchedLeads } = await pool.query(
        `SELECT id FROM leads
         WHERE client_id = $1
           AND LOWER(email) = ANY($2)
           AND deleted_at IS NULL`,
        [clientId, attendeeEmails]
      );

      if (matchedLeads.length === 0) continue;

      // Upsert calendar event
      await pool.query(
        `INSERT INTO calendar_events (client_id, lead_id, title, description, start_time, end_time, meeting_link, google_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (client_id, google_event_id) DO UPDATE
           SET title = EXCLUDED.title, start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time, updated_at = NOW()`,
        [
          clientId,
          matchedLeads[0].id,
          event.summary || 'Meeting',
          event.description || null,
          startTime,
          endTime,
          event.hangoutLink || event.location || null,
          googleEventId,
        ]
      );

      // Advance lead to meeting_booked if not already there
      for (const lead of matchedLeads) {
        await pool.query(
          `UPDATE leads
           SET pipeline_stage = 'meeting_booked', updated_at = NOW()
           WHERE id = $1 AND client_id = $2
             AND pipeline_stage NOT IN ('meeting_booked', 'closed_won', 'closed_lost')`,
          [lead.id, clientId]
        );
      }

      synced++;
    }

    if (synced > 0) {
      console.log(`[googleCalendar] Synced ${synced} meeting(s) for client ${clientId}`);
    }
    return synced;
  } catch (err) {
    console.warn('[googleCalendar] syncMeetings failed:', err.message);
    return 0;
  }
}

/* ─── Helper: get Calendly URL ───────────────────────────── */

async function getCalendlyUrl(clientId) {
  const { rows } = await pool.query(
    `SELECT content FROM agent_memory WHERE client_id = $1 AND agent = 'system' AND key = 'calendly_url' LIMIT 1`,
    [clientId]
  );
  const content = rows[0]?.content;
  if (!content) return null;
  const parsed = typeof content === 'string' ? JSON.parse(content) : content;
  return parsed?.url || null;
}

/* ─── Check if any calendar is connected ────────────────── */

async function hasAnyCalendar(clientId) {
  const gcConnected = await isConnected(clientId);
  if (gcConnected) return true;
  const calendlyUrl = await getCalendlyUrl(clientId);
  return !!calendlyUrl;
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  getTokens,
  isConnected,
  getConnectedEmail,
  disconnect,
  getFreeBusy,
  suggestSlots,
  getUpcomingEvents,
  syncMeetings,
  getCalendlyUrl,
  hasAnyCalendar,
};
