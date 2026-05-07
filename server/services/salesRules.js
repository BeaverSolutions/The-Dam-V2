'use strict';

// Runtime loader for the v1.0 cold-outreach rules + approved proof numbers.
// Read at module-init, cached for the life of the process. Server restart
// picks up rule edits. reloadRules() is exposed for dev workflows that want
// to repull without a restart.
//
// Source of truth: MJxClaude/sales-assets/. Files in this directory are
// deployed copies. Sync direction is MJxClaude → BeavrDam, manual on
// rule-version bumps. See file headers for the sync note.

const fs = require('fs');
const path = require('path');

const RULES_DIR = path.join(__dirname, '..', 'sales-rules');

let cachedRules = null;
let cachedNumbers = null;

function loadFile(filename) {
  const filePath = path.join(RULES_DIR, filename);
  return fs.readFileSync(filePath, 'utf8');
}

function getOutreachRules() {
  if (cachedRules === null) cachedRules = loadFile('BEAVER_LINKEDIN_OUTREACH_RULES.md');
  return cachedRules;
}

function getProofNumbers() {
  if (cachedNumbers === null) cachedNumbers = loadFile('BEAVER_PROOF_NUMBERS.md');
  return cachedNumbers;
}

function reloadRules() {
  cachedRules = null;
  cachedNumbers = null;
}

module.exports = { getOutreachRules, getProofNumbers, reloadRules };
