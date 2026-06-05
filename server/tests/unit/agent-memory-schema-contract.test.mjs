import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(__dirname, '../..');

function read(path) {
  return readFileSync(resolve(serverRoot, path), 'utf-8').replace(/\r\n/g, '\n');
}

function latestAgentMemoryTypeAllowlist() {
  const migrationsDir = resolve(serverRoot, 'db/migrations');
  const migrationFiles = readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    .sort();

  let allowed = null;
  for (const file of migrationFiles) {
    const source = readFileSync(join(migrationsDir, file), 'utf-8').replace(/\r\n/g, '\n');
    const match = source.match(/ADD CONSTRAINT agent_memory_memory_type_check\s+CHECK\s*\(\s*memory_type\s+IN\s*\(([\s\S]*?)\)\s*\)/i);
    if (match) {
      allowed = {
        file,
        values: new Set([...match[1].matchAll(/'([^']+)'/g)].map(m => m[1])),
      };
    }
  }

  if (!allowed) throw new Error('No agent_memory memory_type CHECK allowlist found');
  return allowed;
}

function jsFiles(dir) {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') return [];
      return jsFiles(path);
    }
    return entry.endsWith('.js') ? [path] : [];
  });
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

function splitSqlList(valueList) {
  return valueList.split(',').map(part => part.trim());
}

function agentMemoryTypeLiterals(source) {
  const rows = [];
  const insertPattern = /INSERT\s+INTO\s+agent_memory\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)/gi;

  for (const match of source.matchAll(insertPattern)) {
    const columns = splitSqlList(match[1]).map(column => column.replace(/["`]/g, '').trim().toLowerCase());
    const memoryTypeIndex = columns.indexOf('memory_type');
    if (memoryTypeIndex === -1) continue;

    const values = splitSqlList(match[2]);
    const memoryTypeValue = values[memoryTypeIndex] || '';
    const literal = memoryTypeValue.match(/^'([^']+)'/);
    if (!literal) continue;

    rows.push({
      type: literal[1],
      line: lineNumber(source, match.index),
    });
  }

  return rows;
}

describe('agent_memory schema contract', () => {
  it('uses only memory_type values allowed by the production CHECK constraint', () => {
    const allowlist = latestAgentMemoryTypeAllowlist();
    const files = [
      resolve(serverRoot, 'index.js'),
      ...jsFiles(resolve(serverRoot, 'routes')),
      ...jsFiles(resolve(serverRoot, 'services')),
    ];

    const invalid = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf-8').replace(/\r\n/g, '\n');
      for (const row of agentMemoryTypeLiterals(source)) {
        if (!allowlist.values.has(row.type)) {
          invalid.push(`${file.replace(serverRoot + '\\', '')}:${row.line} -> ${row.type}`);
        }
      }
    }

    expect(invalid, `Allowed memory_type values come from ${allowlist.file}`).toEqual([]);
  });
});
