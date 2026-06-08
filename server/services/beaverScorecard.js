'use strict';

/**
 * Per-beaver KPI scorecard (Phase 3, 2026-05-29).
 *
 * Pure, dependency-free, deterministic so it is unit-testable without a DB or
 * the captainOrchestrator dependency tree. collectTeamKPIs already computes the
 * per-beaver metrics from source tables; this module adds the accountability
 * layer: compare each beaver's MYT-business-day metrics against a target and
 * emit hit / miss + a recommended corrective action.
 *
 * Research target is the tenant's configured daily_quality_lead_floor; the rest
 * derive from the 50/day operational contract.
 *
 * IMPORTANT: recommended_action only NAMES the fix. Executing it (enrichment,
 * kickoff, recalibration) stays gated behind the autonomy flags (Phase 4). The
 * scorecard decides + surfaces; it never spends.
 *
 * `hit === null` means "not enough activity to judge" (e.g. 0 drafts → Enforcer
 * coverage is n/a, not a miss). all_hit treats null as non-blocking.
 */

const BEAVER_TARGETS = {
  sales_drafts: 50,
  sales_first_pass_pct: 60,
  enforcer_approve_band: { min: 25, max: 90 }, // outside this band = quality drift
  captain_kickoffs: 1,
};

function scPct(n, d) {
  return d > 0 ? Math.round((n / d) * 100) : null;
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && String(value).trim() !== '') return value;
  }
  return null;
}

function signalIdForEvent(event = {}) {
  const meta = event.metadata || {};
  const pkg = meta.signal_package || event.signal_package || {};
  return firstNonEmpty(
    event.signal_id,
    event.signal,
    event.signal_type,
    pkg.signal_id,
    meta.signal_id,
    meta.signal,
    meta.signal_type
  ) || 'unknown_signal';
}

function signalFamilyForEvent(event = {}) {
  const meta = event.metadata || {};
  const pkg = meta.signal_package || event.signal_package || {};
  return firstNonEmpty(event.signal_family, pkg.signal_family, meta.signal_family) || null;
}

function sourceChannelForEvent(event = {}) {
  const meta = event.metadata || {};
  const pkg = meta.signal_package || event.signal_package || {};
  return firstNonEmpty(event.source_channel, event.sourceChannel, pkg.source_channel, meta.source_channel) || null;
}

function ensureSignalScore(out, event = {}) {
  const signalId = signalIdForEvent(event);
  if (!out[signalId]) {
    out[signalId] = {
      signal_id: signalId,
      signal_family: signalFamilyForEvent(event),
      attempted: 0,
      source_channels: [],
      raw_candidates: 0,
      icp_pass: 0,
      decision_maker_found: 0,
      contact_found: 0,
      saved_leads: 0,
      drafted: 0,
      approved: 0,
      sent: 0,
      cost_spend: 0,
      blocker_reasons: {},
    };
  }
  const score = out[signalId];
  if (!score.signal_family) score.signal_family = signalFamilyForEvent(event);
  const sourceChannel = sourceChannelForEvent(event);
  if (sourceChannel && !score.source_channels.includes(sourceChannel)) {
    score.source_channels.push(sourceChannel);
  }
  return score;
}

function addBlocker(score, reason, count = 1) {
  if (!reason) return;
  const key = String(reason).trim();
  if (!key) return;
  score.blocker_reasons[key] = (score.blocker_reasons[key] || 0) + Math.max(1, asNumber(count));
}

function addStageCount(score, stage, count) {
  if (!stage) return;
  if (stage === 'icp_passed') score.icp_pass += count;
  if (stage === 'decision_maker_found') score.decision_maker_found += count;
  if (stage === 'contact_found' || stage === 'readiness_passed') score.contact_found += count;
  if (stage === 'enrolled' || stage === 'saved' || stage === 'saved_lead') score.saved_leads += count;
  if (stage === 'drafted') score.drafted += count;
  if (stage === 'approved') score.approved += count;
  if (stage === 'sent') score.sent += count;
}

/**
 * Build Captain's per-signal scoreboard from already-collected trace/log rows.
 * Pure by design: tests and collectors can pass pipeline_traces, Research
 * blocker logs, or summarized rows without pulling in Captain dependencies.
 */
function buildSignalScorecard(events = []) {
  const out = {};
  for (const event of Array.isArray(events) ? events : []) {
    const score = ensureSignalScore(out, event || {});
    const count = Math.max(1, asNumber(event.cnt || event.count || 1));
    const explicitAttempted = event.attempted !== undefined && event.attempted !== null;

    score.attempted += explicitAttempted
      ? asNumber(event.attempted)
      : (firstNonEmpty(event.blocker_reason, event.blocker, event.reason) ? count : 0);
    score.raw_candidates += asNumber(firstNonEmpty(event.raw_candidates, event.raw_candidates_total, event.raw_results_total));
    score.icp_pass += asNumber(firstNonEmpty(event.icp_pass, event.icp_passed));
    score.decision_maker_found += asNumber(firstNonEmpty(event.decision_maker_found, event.decision_makers_found));
    score.contact_found += asNumber(firstNonEmpty(event.contact_found, event.contacts_found));
    score.saved_leads += asNumber(firstNonEmpty(event.saved_leads, event.saved));
    score.drafted += asNumber(event.drafted);
    score.approved += asNumber(event.approved);
    score.sent += asNumber(event.sent);
    score.cost_spend += asNumber(firstNonEmpty(event.cost_spend, event.spend, event.cost_usd));

    addStageCount(score, event.stage, count);
    addBlocker(score, firstNonEmpty(event.blocker_reason, event.blocker, event.reason, event.reject_reason), count);
  }
  return out;
}

/**
 * @param {object} sc  MYT-today counts: research_sourced_today,
 *   research_verified_email_today, sales_drafted_today, sales_first_pass_today,
 *   sales_first_attempt_today, enforcer_reviewed_today, enforcer_approved_today,
 *   captain_kickoffs_today
 * @param {object} ctx { researchFloor, poolSize }
 */
function buildBeaverScorecard(sc = {}, ctx = {}) {
  const researchFloor = Number(ctx.researchFloor) || 40;
  const poolSize = Number(ctx.poolSize) || 0;

  const researchSourced = Number(sc.research_sourced_today) || 0;
  const verifiedEmailToday = Number(sc.research_verified_email_today) || 0;
  const drafts = Number(sc.sales_drafted_today) || 0;
  const firstPass = Number(sc.sales_first_pass_today) || 0;
  const firstAttempt = Number(sc.sales_first_attempt_today) || 0;
  const reviewed = Number(sc.enforcer_reviewed_today) || 0;
  const approved = Number(sc.enforcer_approved_today) || 0;
  const kickoffs = Number(sc.captain_kickoffs_today) || 0;

  const firstPassPct = scPct(firstPass, firstAttempt);
  const approveRatePct = scPct(approved, reviewed);

  // Research hits if it met the floor OR the pool is already healthy (idle by design).
  const researchHit = researchSourced >= researchFloor || poolSize >= 100;
  const research = {
    sourced_today: researchSourced, verified_email_today: verifiedEmailToday,
    target: researchFloor, pool_size: poolSize, hit: researchHit,
    recommended_action: researchHit ? null : (poolSize > 0 ? 'run_pool_email_enrichment' : 'run_signal_hunt'),
  };

  const draftHit = drafts >= BEAVER_TARGETS.sales_drafts;
  const qualityHit = firstPassPct === null ? null : firstPassPct >= BEAVER_TARGETS.sales_first_pass_pct;
  const sales = {
    drafts_today: drafts, target: BEAVER_TARGETS.sales_drafts,
    first_pass_rate_pct: firstPassPct, first_pass_target_pct: BEAVER_TARGETS.sales_first_pass_pct,
    draft_hit: draftHit, quality_hit: qualityHit,
    hit: draftHit && qualityHit !== false,
    recommended_action: !draftHit ? 'fire_kickoff' : (qualityHit === false ? 'enforcer_teach' : null),
  };

  // Coverage: Enforcer should review at least as many as Sales drafted today.
  const coverageHit = drafts === 0 ? null : reviewed >= drafts;
  const bandOk = approveRatePct === null ? null
    : (approveRatePct >= BEAVER_TARGETS.enforcer_approve_band.min && approveRatePct <= BEAVER_TARGETS.enforcer_approve_band.max);
  const enforcer = {
    reviewed_today: reviewed, approved_today: approved, approve_rate_pct: approveRatePct,
    healthy_band: BEAVER_TARGETS.enforcer_approve_band,
    coverage_hit: coverageHit, band_ok: bandOk,
    hit: coverageHit !== false && bandOk !== false,
    recommended_action: bandOk === false ? 'enforcer_recalibrate' : (coverageHit === false ? 'enforcer_clear_backlog' : null),
  };

  const captainHit = kickoffs >= BEAVER_TARGETS.captain_kickoffs;
  const captain = {
    kickoffs_today: kickoffs, target: BEAVER_TARGETS.captain_kickoffs, hit: captainHit,
    recommended_action: captainHit ? null : 'verify_kickoff_armed',
  };

  const all_hit = [research.hit, sales.hit, enforcer.hit, captain.hit].every(h => h === true || h === null);
  return { research, sales, enforcer, captain, all_hit };
}

function pct(n, d) {
  return d > 0 ? Math.round((n / d) * 100) : 0;
}

function money(value) {
  return Number(asNumber(value)).toFixed(2);
}

function safeText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeIndustryRow(row = {}) {
  return {
    industry: String(row.industry || row.segment || 'unknown'),
    queries_run: asNumber(row.queries_run),
    raw_candidates: asNumber(row.raw_candidates),
    saved: asNumber(row.saved),
    sent: asNumber(row.sent),
    replies: asNumber(row.replies),
    meetings: asNumber(row.meetings),
  };
}

function mergeIndustryRows(activeIndustries = [], rows = []) {
  const byIndustry = new Map();
  for (const industry of activeIndustries || []) {
    if (!industry) continue;
    const key = String(industry);
    byIndustry.set(key, normalizeIndustryRow({ industry: key }));
  }
  for (const row of Array.isArray(rows) ? rows : []) {
    const normalized = normalizeIndustryRow(row);
    const existing = byIndustry.get(normalized.industry) || normalizeIndustryRow({ industry: normalized.industry });
    byIndustry.set(normalized.industry, {
      industry: normalized.industry,
      queries_run: existing.queries_run + normalized.queries_run,
      raw_candidates: existing.raw_candidates + normalized.raw_candidates,
      saved: existing.saved + normalized.saved,
      sent: existing.sent + normalized.sent,
      replies: existing.replies + normalized.replies,
      meetings: existing.meetings + normalized.meetings,
    });
  }
  return Array.from(byIndustry.values());
}

function normalizeChannelRows(rows = []) {
  const channels = {
    email: { sent: 0, replies: 0 },
    linkedin: { sent: 0, replies: 0 },
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    const channel = String(row.channel || 'unknown').toLowerCase();
    if (!channels[channel]) channels[channel] = { sent: 0, replies: 0 };
    channels[channel].sent += asNumber(row.sent);
    channels[channel].replies += asNumber(row.replies);
  }
  return channels;
}

function normalizePlatformYieldRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    platform: String(firstNonEmpty(row.platform, row.source_platform, 'unknown_platform')),
    signal_id: String(firstNonEmpty(row.signal_id, row.signal, 'unknown_signal')),
    signal_family: firstNonEmpty(row.signal_family, row.family),
    geo: firstNonEmpty(row.geo, row.market),
    paid_units: asNumber(row.paid_units),
    raw_results: asNumber(row.raw_results),
    raw_candidates: asNumber(row.raw_candidates),
    icp_passed: asNumber(row.icp_passed),
    saved_leads: asNumber(firstNonEmpty(row.saved_leads, row.saved)),
    approval_ready: asNumber(firstNonEmpty(row.approval_ready, row.approved)),
    replies: asNumber(row.replies),
    meetings: asNumber(row.meetings),
    blocker: firstNonEmpty(row.blocker, row.reason),
  }));
}

function topRows(rows = [], key = 'count', limit = 5) {
  return (Array.isArray(rows) ? rows : [])
    .map(row => ({ ...row, [key]: asNumber(row[key]) }))
    .sort((a, b) => asNumber(b[key]) - asNumber(a[key]))
    .slice(0, limit);
}

function strongestPlatformYield(rows = []) {
  return [...rows].sort((a, b) => {
    const savedDelta = asNumber(b.saved_leads) - asNumber(a.saved_leads);
    if (savedDelta !== 0) return savedDelta;
    const readyDelta = asNumber(b.approval_ready) - asNumber(a.approval_ready);
    if (readyDelta !== 0) return readyDelta;
    return asNumber(b.raw_candidates) - asNumber(a.raw_candidates);
  })[0] || null;
}

function defaultWeeklyLesson(platformYield = []) {
  const best = strongestPlatformYield(platformYield);
  if (!best) {
    return 'No platform yield data was captured this week, so Captain cannot recommend platform reweighting yet.';
  }
  return `This week campaign is based on ${best.signal_id} buying signals and leads generation was done via ${best.platform}. ${best.platform} produced ${best.saved_leads} saved leads and ${best.approval_ready} approval-ready leads.`;
}

function defaultWhatWentWrong(platformYield = [], blockers = []) {
  const platformBlockers = platformYield
    .filter(row => row.blocker && row.blocker !== 'none')
    .map(row => `${row.platform}: ${row.blocker}`);
  if (platformBlockers.length > 0) return platformBlockers.slice(0, 3).join('; ');

  const zeroSaveRows = platformYield
    .filter(row => asNumber(row.raw_candidates) > 0 && asNumber(row.saved_leads) === 0)
    .map(row => `${row.platform}: 0 saved leads from ${row.raw_candidates} raw candidates`);
  if (zeroSaveRows.length > 0) return zeroSaveRows.slice(0, 3).join('; ');

  if ((blockers || []).length > 0) {
    return topRows(blockers, 'count', 3).map(row => `${row.reason} (${row.count})`).join('; ');
  }
  return 'No major blocker captured this week.';
}

function normalizeNextWeekJudgement(rows = [], platformYield = []) {
  if (Array.isArray(rows) && rows.length > 0) {
    return rows.map(row => {
      if (typeof row === 'string') return { recommendation: row, requires_approval: true };
      return {
        recommendation: String(firstNonEmpty(row.recommendation, row.action, row.summary, 'Review next-week platform plan')),
        requires_approval: row.requires_approval !== false,
      };
    });
  }
  const best = strongestPlatformYield(platformYield);
  if (!best) {
    return [{
      recommendation: 'Keep next week in no-spend platform preview mode until a proof run records platform yield.',
      requires_approval: true,
    }];
  }
  return [{
    recommendation: `Use ${best.platform} first for ${best.signal_id} before expanding paid platform spend.`,
    requires_approval: true,
  }];
}

function buildMonthlyObservations(report) {
  if (report.period.type !== 'monthly') return [];
  const observations = [];
  for (const industry of report.industries) {
    if (industry.sent > 0 && industry.replies === 0) {
      observations.push(`${industry.industry}: 0 replies in period`);
    }
    if (industry.saved === 0) {
      observations.push(`${industry.industry}: 0 saved leads in period`);
    }
  }
  if (report.headline.sent === 0) observations.push('No autonomous sends in period');
  if (report.blockers.length > 0) {
    observations.push(`Top blocker: ${report.blockers[0].reason} (${report.blockers[0].count})`);
  }
  if (observations.length === 0) observations.push('No decision flags from captured data');
  return observations;
}

function buildCaptainPeriodReport(input = {}) {
  const period = input.period || {};
  const targets = input.targets || {};
  const totals = input.totals || {};
  const funnel = input.funnel || {};
  const spend = input.spend || {};
  const enforcer = input.enforcer || {};
  const platformYield = normalizePlatformYieldRows(input.platform_yield || input.platformYield || []);
  const target = asNumber(targets.outreach_sent || targets.sent || 0);
  const sent = asNumber(totals.outreach_sent || totals.sent);
  const replies = asNumber(totals.replies);
  const leads = asNumber(totals.leads_found || totals.saved || totals.leads);
  const meetings = asNumber(totals.meetings);
  const llmCost = asNumber(spend.llm_cost_usd);
  const providerCost = asNumber(spend.provider_cost_usd);
  const totalCost = asNumber(spend.total_cost_usd || (llmCost + providerCost));

  const report = {
    period: {
      type: period.type || 'weekly',
      label: period.label || `${period.start_date || ''} to ${period.end_date || ''}`.trim(),
      start_date: period.start_date || null,
      end_date: period.end_date || null,
      days: asNumber(period.days),
    },
    headline: {
      sent,
      target,
      target_pct: target > 0 ? pct(sent, target) : 0,
      replies,
      meetings,
    },
    funnel: {
      raw_candidates: asNumber(funnel.raw_candidates),
      saved: asNumber(funnel.saved || leads),
      drafted: asNumber(funnel.drafted),
      approved: asNumber(funnel.approved),
      sent,
      replies,
      meetings,
      survival: {
        saved_from_raw_pct: pct(asNumber(funnel.saved || leads), asNumber(funnel.raw_candidates)),
        sent_from_saved_pct: pct(sent, asNumber(funnel.saved || leads)),
        reply_from_sent_pct: pct(replies, sent),
        meeting_from_reply_pct: pct(meetings, replies),
      },
    },
    breakdown: {
      hot_leads: asNumber(firstNonEmpty(totals.hot_leads, totals.approval_ready, funnel.approved, funnel.approval_ready)),
      total_new_outreach: sent,
      total_follow_up: asNumber(firstNonEmpty(totals.followups_sent, totals.follow_up, totals.followups)),
      approval_ready_drafts: asNumber(firstNonEmpty(totals.approval_ready, funnel.approved, funnel.approval_ready)),
      replies,
      positive_replies: asNumber(firstNonEmpty(totals.positive_replies, totals.positive_reply, totals.positive_replies_count)),
      meetings_booked: meetings,
      pending_approval: asNumber(firstNonEmpty(totals.pending_approval, funnel.pending_approval, funnel.drafted)),
      blocked_rejected: asNumber(firstNonEmpty(totals.blocked_rejected, totals.rejected, funnel.rejected)),
    },
    industries: mergeIndustryRows(input.active_industries || [], input.industries || []),
    channels: normalizeChannelRows(input.channels || []),
    platform_yield: platformYield,
    spend: {
      providers: spend.providers || {},
      provider_units: spend.provider_units || {},
      provider_cost_usd: providerCost,
      llm_cost_usd: llmCost,
      total_cost_usd: totalCost,
      cost_per_lead_usd: leads > 0 ? totalCost / leads : null,
      cost_per_reply_usd: replies > 0 ? totalCost / replies : null,
      notes: spend.notes || [],
    },
    blockers: topRows(input.blockers || [], 'count'),
    enforcer: {
      reviewed: asNumber(enforcer.reviewed),
      approved: asNumber(enforcer.approved),
      rejected: asNumber(enforcer.rejected),
      approve_rate_pct: pct(asNumber(enforcer.approved), asNumber(enforcer.reviewed)),
      top_reject_reasons: topRows(enforcer.top_reject_reasons || [], 'count'),
    },
    weekly_lesson: firstNonEmpty(input.weekly_lesson, input.weeklyLesson) || defaultWeeklyLesson(platformYield),
    hook_of_week: firstNonEmpty(input.hook_of_week, input.hookOfWeek) || 'No hook of the week captured yet.',
    what_went_wrong: firstNonEmpty(input.what_went_wrong, input.whatWentWrong) || null,
    next_week_judgement: normalizeNextWeekJudgement(input.next_week_judgement || input.nextWeekJudgement, platformYield),
    observations: [],
  };
  report.what_went_wrong = report.what_went_wrong || defaultWhatWentWrong(platformYield, report.blockers);
  report.observations = buildMonthlyObservations(report);
  return report;
}

function formatCaptainPeriodReport(report = {}) {
  const headline = report.headline || {};
  const funnel = report.funnel || {};
  const survival = funnel.survival || {};
  const spend = report.spend || {};
  const channels = report.channels || {};
  const enforcer = report.enforcer || {};
  const breakdown = report.breakdown || {};
  const industryLines = (report.industries || []).length > 0
    ? report.industries.map(row => `${safeText(row.industry)}: queries ${row.queries_run}, raw ${row.raw_candidates}, saved ${row.saved}, sent ${row.sent}, replies ${row.replies}, meetings ${row.meetings}`)
    : ['no industry-attributed rows captured'];
  const platformYieldLines = (report.platform_yield || []).length > 0
    ? report.platform_yield.map(row => `${safeText(row.platform)} / ${safeText(row.signal_id)}: paid units ${row.paid_units}, raw ${row.raw_results}, candidates ${row.raw_candidates}, saved ${row.saved_leads}, approval-ready ${row.approval_ready}${row.blocker && row.blocker !== 'none' ? `, blocker ${safeText(row.blocker)}` : ''}`)
    : ['no platform yield rows captured'];
  const blockerLines = (report.blockers || []).length > 0
    ? report.blockers.map(row => `${safeText(row.reason)} (${row.count})`)
    : ['none captured'];
  const observationLines = (report.observations || []).length > 0
    ? report.observations.map(safeText)
    : ['none'];
  const providerLines = Object.entries(spend.provider_units || {})
    .map(([provider, units]) => `${safeText(provider)} ${units}`)
    .join(', ') || 'provider unit counts unavailable';

  const lines = [
    `<b>${safeText((report.period?.type || 'weekly').toUpperCase())} CAPTAIN REPORT</b>`,
    safeText(report.period?.label || ''),
  ];

  if (report.period?.type === 'weekly') {
    lines.push(
      '',
      `This week, the team executed a total outreach of ${headline.sent || 0}.`,
      '',
      '<b>BREAKDOWN</b>',
      `1. Hot leads: ${breakdown.hot_leads || 0}`,
      `2. Total New Outreach: ${breakdown.total_new_outreach || 0}`,
      `3. Total Follow Up: ${breakdown.total_follow_up || 0}`,
      `4. Approval-ready Drafts: ${breakdown.approval_ready_drafts || 0}`,
      `5. Replies: ${breakdown.replies || 0}`,
      `6. Positive Replies: ${breakdown.positive_replies || 0}`,
      `7. Meetings Booked: ${breakdown.meetings_booked || 0}`,
      `8. Pending Approval: ${breakdown.pending_approval || 0}`,
      `9. Blocked / Rejected: ${breakdown.blocked_rejected || 0}`,
      '',
      '<b>Weekly Lesson</b>',
      safeText(report.weekly_lesson || 'No weekly lesson captured yet.'),
      '',
      '<b>Hook Of The Week</b>',
      safeText(report.hook_of_week || 'No hook of the week captured yet.'),
      '',
      '<b>What Went Wrong</b>',
      safeText(report.what_went_wrong || 'No major blocker captured this week.'),
      '',
      '<b>Total Weekly Spend</b>',
      `$${money(spend.total_cost_usd)} captured. Providers $${money(spend.provider_cost_usd)}. LLM $${money(spend.llm_cost_usd)}.`,
      '',
      '<b>Captain Judgement For Next Week</b>',
      'Requires MJ approval:',
      ...(report.next_week_judgement || []).map(row => `- ${safeText(row.recommendation || row)}${row.requires_approval === false ? '' : ' (Requires MJ approval)'}`),
      'Captain judgement is advisory until MJ approves the next-week plan. No new platform spend was armed by this report.',
      '',
      '<b>PLATFORM YIELD</b>',
      ...platformYieldLines,
      ''
    );
  } else {
    lines.push('');
  }

  lines.push(
    '<b>HEADLINE VS TARGET</b>',
    `${headline.sent || 0}/${headline.target || 0} sent (${headline.target_pct || 0}%). Replies ${headline.replies || 0}. Meetings ${headline.meetings || 0}.`,
    '',
    '<b>FUNNEL SURVIVAL</b>',
    `raw ${funnel.raw_candidates || 0} -> saved ${funnel.saved || 0} (${survival.saved_from_raw_pct || 0}%) -> sent ${funnel.sent || 0} (${survival.sent_from_saved_pct || 0}%) -> replies ${funnel.replies || 0} (${survival.reply_from_sent_pct || 0}%) -> meetings ${funnel.meetings || 0} (${survival.meeting_from_reply_pct || 0}%)`,
    '',
    '<b>INDUSTRY BREAKDOWN</b>',
    ...industryLines,
    '',
    '<b>CHANNEL SPLIT</b>',
    `email sent ${channels.email?.sent || 0}, replies ${channels.email?.replies || 0}; linkedin sent ${channels.linkedin?.sent || 0}, replies ${channels.linkedin?.replies || 0}`,
    '',
    '<b>SPEND</b>',
    `providers: ${providerLines}. LLM $${money(spend.llm_cost_usd)}. Total captured $${money(spend.total_cost_usd)}. Cost/lead ${spend.cost_per_lead_usd === null ? 'n/a' : `$${money(spend.cost_per_lead_usd)}`}. Cost/reply ${spend.cost_per_reply_usd === null ? 'n/a' : `$${money(spend.cost_per_reply_usd)}`}.`,
    ...(spend.notes || []).map(note => `note: ${safeText(note)}`),
    '',
    '<b>TOP BLOCKERS</b>',
    ...blockerLines,
    '',
    '<b>ENFORCER QUALITY</b>',
    `reviewed ${enforcer.reviewed || 0}, approved ${enforcer.approved || 0}, rejected ${enforcer.rejected || 0}, approve rate ${enforcer.approve_rate_pct || 0}%`,
  );

  if (report.period?.type === 'monthly') {
    lines.push('', '<b>MONTHLY OBSERVATIONS</b>', ...observationLines);
    lines.push('Captain surfaces these for human decision only. No auto-reweighting was applied.');
  }

  return lines.filter(line => line !== null && line !== undefined).join('\n');
}

module.exports = {
  BEAVER_TARGETS,
  scPct,
  buildBeaverScorecard,
  buildSignalScorecard,
  buildCaptainPeriodReport,
  formatCaptainPeriodReport,
};
