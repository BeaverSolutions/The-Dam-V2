'use strict';

const crypto = require('crypto');

const DEFAULT_MAX_RESEARCH_REPAIR_ATTEMPTS = 1;

function stableStringify(value) {
  if (value === null || value === undefined) return JSON.stringify(null);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashPayload(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}

function signalPackageHash(signalPackage) {
  if (!signalPackage || typeof signalPackage !== 'object') return null;
  return hashPayload(signalPackage);
}

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function researchRepairState(source = {}) {
  const meta = source && typeof source.metadata === 'object' && !Array.isArray(source.metadata)
    ? source.metadata
    : source;
  const repair = meta?.research_repair || meta?.researchRepair || {};
  const repairAttempt = positiveInt(
    source.repair_attempt ?? source.repairAttempt ?? repair.attempt ?? repair.repair_attempt,
    0
  );
  const maxRepairAttempts = Math.max(
    1,
    positiveInt(
      source.max_repair_attempts ?? source.maxRepairAttempts ?? repair.max_attempts ?? repair.max_repair_attempts,
      DEFAULT_MAX_RESEARCH_REPAIR_ATTEMPTS
    )
  );
  return { repairAttempt, maxRepairAttempts };
}

function researchRepairExhausted(source = {}) {
  const { repairAttempt, maxRepairAttempts } = researchRepairState(source);
  return repairAttempt >= maxRepairAttempts;
}

function buildResearchRepairPayload({
  leadId = null,
  messageId = null,
  kickoffId = null,
  channel = null,
  pipelinePath = 'unknown',
  failedRule = null,
  reason = null,
  missingFields = [],
  requiredRepair = null,
  repairAttempt = 0,
  maxRepairAttempts = DEFAULT_MAX_RESEARCH_REPAIR_ATTEMPTS,
  signalPackage = null,
  sourceUrl = null,
  sourceChannel = null,
  querySetHash = null,
  evidenceDecision = null,
} = {}) {
  const currentAttempt = positiveInt(repairAttempt, 0);
  const maxAttempts = Math.max(1, positiveInt(maxRepairAttempts, DEFAULT_MAX_RESEARCH_REPAIR_ATTEMPTS));
  const packageHash = signalPackageHash(signalPackage);

  return {
    lead_id: leadId,
    message_id: messageId,
    kickoff_id: kickoffId,
    channel,
    pipeline_path: pipelinePath,
    repair_route: 'needs_research_repair',
    failed_rule: failedRule,
    reason,
    missing_fields: Array.isArray(missingFields) ? missingFields.filter(Boolean) : [missingFields].filter(Boolean),
    required_repair: requiredRepair || reason || 'Research must repair the failed signal_package before Sales drafts again.',
    repair_attempt: currentAttempt + 1,
    max_repair_attempts: maxAttempts,
    original_signal_package_hash: packageHash,
    do_not_repeat: {
      signal_package_hash: packageHash,
      source_url: sourceUrl || signalPackage?.source_url || null,
      source_channel: sourceChannel || signalPackage?.source_channel || null,
      query_set_hash: querySetHash || null,
    },
    evidence_decision: evidenceDecision || null,
  };
}

module.exports = {
  DEFAULT_MAX_RESEARCH_REPAIR_ATTEMPTS,
  stableStringify,
  hashPayload,
  signalPackageHash,
  researchRepairState,
  researchRepairExhausted,
  buildResearchRepairPayload,
};
