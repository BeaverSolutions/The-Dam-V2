'use strict';

function safeStringify(data) {
  try {
    return JSON.stringify(data);
  } catch {
    return JSON.stringify({ level: data?.level || 'unknown', msg: data?.msg || 'log data contained circular reference' });
  }
}

const logger = {
  debug: (data) => console.debug(safeStringify({ level: 'debug', timestamp: new Date().toISOString(), ...data })),
  info: (data) => console.log(safeStringify({ level: 'info', timestamp: new Date().toISOString(), ...data })),
  error: (data) => console.error(safeStringify({ level: 'error', timestamp: new Date().toISOString(), ...data })),
  warn: (data) => console.warn(safeStringify({ level: 'warn', timestamp: new Date().toISOString(), ...data })),
};

module.exports = logger;
