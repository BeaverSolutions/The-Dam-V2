const fs = require('fs');
const path = require('path');
const os = require('os');
const dotenv = require('dotenv');

function isReadableFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveBeavrdamEnvDir() {
  if (process.env.BEAVRDAM_ENV_DIR) return path.resolve(process.env.BEAVRDAM_ENV_DIR);
  return path.resolve(os.homedir(), 'MJxClaude', 'beavrdam-env');
}

function resolveCandidates(projectRoot) {
  const projectEnv = path.join(projectRoot, '.env');
  const centralEnvDir = resolveBeavrdamEnvDir();

  return [
    projectEnv,
    path.join(centralEnvDir, '.env'),
    path.join(centralEnvDir, 'clients', 'tin-city-impact', '.env'),
  ];
}

function loadEnvFile(filePath, override) {
  if (!filePath || !isReadableFile(filePath)) return false;
  dotenv.config({ path: filePath, override });
  return true;
}

function loadEnvironment({ projectRoot = process.cwd(), explicitPath, override = false } = {}) {
  if (process.env.BEAVRDAM_SKIP_DOTENV === 'true') return;

  const alreadyLoaded = new Set();
  const candidates = [];

  const root = path.resolve(projectRoot);
  if (explicitPath) candidates.push(path.resolve(explicitPath));
  candidates.push(...resolveCandidates(root));

  for (const filePath of candidates) {
    if (alreadyLoaded.has(filePath)) continue;
    alreadyLoaded.add(filePath);
    loadEnvFile(filePath, override);
  }
}

module.exports = { loadEnvironment };

