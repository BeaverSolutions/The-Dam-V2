'use strict';

/**
 * spendGuard — a hard, in-code brake on metered-API consumption.
 *
 * Why this exists (2026-05-16): Brave's quota was burned three times in one
 * month, and the Explorium/VP credit balance was drained — every single time
 * because the "check quota before spending" discipline lived in a doc
 * (corrections.md) and depended on a human or an agent *remembering* it. A
 * safeguard that depends on memory is not a safeguard.
 *
 * This moves the brake INTO THE CODE. Before any metered call, the caller asks
 * spendGuard. If today's spend on that provider is at or over the cap, the
 * guard refuses — loudly — and the caller skips the spend. The cap physically
 * cannot be exceeded, because nothing is allowed to spend past a refusal here.
 *
 * Daily spend is read from the existing `logs` table — no new table, no
 * migration. Each metered provider already logs its consumption. Caps are
 * env-overridable so they can be tuned without a code change.
 *
 * Fail-CLOSED: if the spend cannot be read, the guard assumes the cap is hit.
 * Pausing sourcing is always safer than burning an unknown amount of money.
 */

const pool = require('../db/pool');

// Per-provider daily caps. Env-overridable.
const CAPS = {
  vp: Number(process.env.VP_DAILY_CREDIT_CAP) || 60,        // Explorium credits / day (global account)
  brave: Number(process.env.BRAVE_DAILY_QUERY_CAP) || 300,  // Brave search queries / day
};

// ~credits charged per VP contact enrichment (1cr fetch + 2cr email).
const VP_CREDITS_PER_LEAD = Number(process.env.VP_CREDITS_PER_LEAD) || 3;

const klDateExpr = `(NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')::date`;

/**
 * Today's total VP/Explorium credit spend. VP credits are a GLOBAL account
 * (one balance shared across all tenants), so this sums across every client.
 * Source: logs.action = 'vp_sourcing_complete', metadata.credits_spent.
 */
async function vpSpentToday() {
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(NULLIF(metadata->>'credits_spent','')::int), 0) AS spent
         FROM logs
        WHERE action = 'vp_sourcing_complete'
          AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = ${klDateExpr}`
    );
    return parseInt(rows[0]?.spent || 0, 10);
  } catch (err) {
    console.warn('[spendGuard] vpSpentToday query failed — failing CLOSED:', err.message);
    return CAPS.vp; // fail-closed: treat as cap-reached
  }
}

/**
 * Pre-flight check before spending VP/Explorium credits.
 * @param {number} estimatedCredits credits the caller is about to spend (0 = just report)
 * @returns {Promise<{allowed:boolean, spentToday:number, cap:number, remaining:number, affordableLeads:number}>}
 */
async function checkVP(estimatedCredits = 0) {
  const cap = CAPS.vp;
  const spentToday = await vpSpentToday();
  const remaining = Math.max(0, cap - spentToday);
  const affordableLeads = Math.floor(remaining / VP_CREDITS_PER_LEAD);
  const allowed = spentToday + estimatedCredits <= cap;

  if (!allowed) {
    console.warn(
      `[spendGuard] VP BLOCKED — today's spend ${spentToday} + requested ${estimatedCredits} ` +
      `exceeds cap ${cap}. Enrichment skipped. Raise VP_DAILY_CREDIT_CAP or top up Explorium.`
    );
  } else if (remaining < cap * 0.2) {
    console.warn(`[spendGuard] VP WARN — only ${remaining}/${cap} credits left under today's cap.`);
  }
  return { allowed, spentToday, cap, remaining, affordableLeads };
}

module.exports = { checkVP, vpSpentToday, CAPS, VP_CREDITS_PER_LEAD };
