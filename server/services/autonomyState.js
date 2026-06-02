'use strict';

const PAUSE_REASON = 'SCHEDULED_AUTONOMY_PAUSED default-on emergency spend brake';

const REARM_REQUIRES = [
  'MJ approval',
  'tenant',
  'spend cap',
  'allowed channels/providers',
  'rollback condition',
];

function envTrue(env, key) {
  return env[key] === 'true';
}

function envList(env, key) {
  return String(env[key] || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function getAutonomyState(env = process.env) {
  const scheduledPaused = env.SCHEDULED_AUTONOMY_PAUSED !== 'false';
  const enabledTenants = envList(env, 'AUTONOMOUS_ENABLED_CLIENTS');
  const dbBuilderTenants = envList(env, 'DB_BUILDER_ENABLED_CLIENTS');
  const dryRun = envTrue(env, 'AUTONOMY_DRY_RUN');

  const scheduledSpendWorkers = {
    db_builder: dbBuilderTenants.length > 0,
    daily_kickoff: envTrue(env, 'CAPTAIN_DAILY_KICKOFF_ENABLED') && enabledTenants.length > 0,
    kpi_gap_kickoff: envTrue(env, 'CAPTAIN_KPI_GAP_KICKOFF_ENABLED') && enabledTenants.length > 0,
    pool_email_enrichment: envTrue(env, 'POOL_EMAIL_ENRICHMENT_ENABLED'),
    market_sensing: envTrue(env, 'MARKET_SENSING_ENABLED'),
    signal_prefill: envTrue(env, 'DAILY_KICKOFF_SIGNAL_PREFILL_ENABLED'),
  };

  const anyScheduledSpendWorker = Object.values(scheduledSpendWorkers).some(Boolean);

  let mode = 'manual_only';
  let reason = 'scheduled autonomy not armed; manual-safe actions remain available';
  if (scheduledPaused) {
    mode = 'paused';
    reason = PAUSE_REASON;
  } else if (dryRun) {
    mode = 'dry_run';
    reason = 'AUTONOMY_DRY_RUN enabled';
  } else if (anyScheduledSpendWorker) {
    mode = 'production_active';
    reason = 'scheduled autonomy armed by env flags';
  } else if (enabledTenants.length > 0) {
    mode = 'armed';
    reason = 'tenant enabled but no spend-capable scheduled worker is active';
  }

  const scheduledActionsAllowed = !scheduledPaused && !dryRun;
  const spendAllowed = scheduledActionsAllowed && anyScheduledSpendWorker;
  const sendAllowed = scheduledActionsAllowed && scheduledSpendWorkers.daily_kickoff;

  return {
    mode,
    scheduled_paused: scheduledPaused,
    manual_actions_allowed: true,
    scheduled_actions_allowed: scheduledActionsAllowed,
    spend_allowed: spendAllowed,
    send_allowed: sendAllowed,
    reason,
    enabled_tenants: enabledTenants,
    scheduled_spend_workers: scheduledSpendWorkers,
    rearm_requires: REARM_REQUIRES,
  };
}

function isScheduledAutonomyPaused(env = process.env) {
  return getAutonomyState(env).scheduled_paused;
}

function markScheduledPause(jobHealth, jobName, env = process.env) {
  jobHealth.markSkipped(jobName, PAUSE_REASON, {
    paused: true,
    autonomy_state: getAutonomyState(env),
  });
}

module.exports = {
  PAUSE_REASON,
  REARM_REQUIRES,
  getAutonomyState,
  isScheduledAutonomyPaused,
  markScheduledPause,
};
